import assert from "node:assert/strict"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { leaveRelocationLink, readRelocation, stampRelocation, sweepRelocationOnce, type RelocationDeps } from "./project-relocation.ts"
import { moveProjectDirectory, registerProject } from "./project-registry.ts"
import type { SessionRow } from "./storage.ts"
import type { SessionTelemetry } from "./tailer.ts"

// What a folder rename owes the workers that were running in the folder (project-relocation.ts): a
// link at the old path while any of them lives, each one retired at its next rest, and the link taken
// down once none is left. Real directories and real symlinks; only the daemons and the board are
// stand-ins, since the decision is all this module adds — the retire itself is the bridge's.

const MOVED_AT = "2026-11-04T12:00:00.000Z"
const BEFORE = "2026-11-04T11:00:00.000Z"
const AFTER = "2026-11-04T12:00:05.000Z"

function sandbox(): { root: string; stateDir: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-relocation-")))
  const stateDir = join(root, "state")
  mkdirSync(stateDir)
  return { root, stateDir }
}

function row(slug: string, sessionId: string): SessionRow {
  return { slug, session_id: sessionId, backend: "claude", claude_runtime: "broker", state: "open", archived: 0, exited: 0, delivery_ledger: null } as SessionRow
}

function tele(over: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return { turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastActivityAt: BEFORE, ...over } as SessionTelemetry
}

/** A board of daemons the sweep can see and retire. `retire` removes the daemon, as killBroker does. */
function board(daemons: { sessionId: string; createdAt: string; slug: string; telemetry?: SessionTelemetry }[]) {
  const live = [...daemons]
  const retired: { threadSlug: string; sessionId: string; reason: string }[] = []
  const deps = (stateDir: string, projectDir: string, over: Partial<RelocationDeps> = {}): RelocationDeps => ({
    stateDir,
    projectDir,
    liveDaemons: () => live.map(({ sessionId, createdAt }) => ({ sessionId, createdAt })),
    rows: () => daemons.map((d) => row(d.slug, d.sessionId)),
    telemetry: (slug) => daemons.find((d) => d.slug === slug)?.telemetry,
    pendingInteractions: () => 0,
    retire: (input) => {
      retired.push(input)
      const at = live.findIndex((d) => d.sessionId === input.sessionId)
      if (at < 0) return false
      live.splice(at, 1)
      return true
    },
    now: () => Date.parse(AFTER),
    ...over,
  })
  return { live, retired, deps }
}

test("a rename leaves a relative link at the old path, and records it", () => {
  const { root, stateDir } = sandbox()
  try {
    const from = join(root, "alpha"), to = join(root, "beta")
    mkdirSync(to)
    leaveRelocationLink({ stateDir, from, to, now: () => new Date(MOVED_AT) })
    assert.equal(lstatSync(from).isSymbolicLink(), true)
    assert.equal(readlinkSync(from), "beta", "relative, so the pair survives its parent moving")
    assert.equal(realpathSync(from), to)
    assert.deepEqual(readRelocation(stateDir), { links: [from], movedAt: MOVED_AT })
    stampRelocation(stateDir, () => new Date(AFTER))
    assert.equal(readRelocation(stateDir)?.movedAt, AFTER, "the stamp moves the clock to when the old tenant closed")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a second rename points the first link at the new name, and a rename back takes its link's place", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "frizz-relocation-home-")))
  try {
    const id = "029a30af-f126-40e3-b04c-d80e74e3e090"
    const stateDir = join(home, "state")
    mkdirSync(stateDir)
    const alpha = join(home, "work/alpha"), beta = join(home, "work/beta"), gamma = join(home, "work/gamma")
    mkdirSync(join(alpha, ".frizz"), { recursive: true })
    writeFileSync(join(alpha, ".frizz", ".id"), `${id}\n`)
    registerProject({ dir: alpha, id }, home)

    moveProjectDirectory(id, "beta", home)
    leaveRelocationLink({ stateDir, from: alpha, to: beta })
    moveProjectDirectory(id, "gamma", home)
    leaveRelocationLink({ stateDir, from: beta, to: gamma })
    assert.equal(realpathSync(alpha), gamma, "the first link follows the folder to its newest name")
    assert.equal(realpathSync(beta), gamma)
    assert.deepEqual(readRelocation(stateDir)?.links.sort(), [alpha, beta].sort())

    // Back to the first name: the link sitting there is Frizz's own, so it gives way to the folder.
    const back = moveProjectDirectory(id, "alpha", home)
    assert.equal(back.path, alpha)
    leaveRelocationLink({ stateDir, from: gamma, to: alpha })
    assert.equal(lstatSync(alpha).isDirectory(), true)
    assert.equal(existsSync(join(alpha, ".frizz", ".id")), true)
    assert.equal(realpathSync(beta), alpha)
    assert.equal(realpathSync(gamma), alpha)
    assert.deepEqual(readRelocation(stateDir)?.links.sort(), [beta, gamma].sort(), "a path that is the folder again is no longer a link to keep")

    // A link that leads somewhere else is still something else, and is refused like any occupant.
    mkdirSync(join(home, "elsewhere"))
    rmSync(beta)
    symlinkSync(join(home, "elsewhere"), beta)
    assert.throws(() => moveProjectDirectory(id, "beta", home), /already exists/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a resting daemon from before the move is retired; a busy one holds the link until it rests", () => {
  const { root, stateDir } = sandbox()
  try {
    const from = join(root, "alpha"), to = join(root, "beta")
    mkdirSync(to)
    leaveRelocationLink({ stateDir, from, to, now: () => new Date(MOVED_AT) })
    const caller = { sessionId: "s-caller", createdAt: BEFORE, slug: "rename-the-folder", telemetry: tele({ turn: "in-flight" }) }
    const resting = { sessionId: "s-resting", createdAt: BEFORE, slug: "resting", telemetry: tele() }
    const fresh = { sessionId: "s-fresh", createdAt: AFTER, slug: "started-after", telemetry: tele({ turn: "in-flight" }) }
    const b = board([caller, resting, fresh])

    const first = sweepRelocationOnce(b.deps(stateDir, to))
    assert.deepEqual(first.retired, ["resting"])
    assert.deepEqual(b.retired, [{ threadSlug: "resting", sessionId: "s-resting", reason: "relocate" }], "retired as a relocation, which is not reported as a crash")
    assert.deepEqual(first.waiting, [{ slug: "rename-the-folder", blockedBy: "turn-in-flight" }], "the worker that asked is mid-turn, and is never torn down")
    assert.equal(first.settled, false)
    assert.equal(lstatSync(from).isSymbolicLink(), true, "the link stays while it runs")

    // Sub-agents and background shells hold it just as hibernation's verdict does.
    caller.telemetry = tele({ bgShells: [{ id: "x" }] } as Partial<SessionTelemetry>)
    assert.deepEqual(sweepRelocationOnce(b.deps(stateDir, to)).waiting, [{ slug: "rename-the-folder", blockedBy: "background-shells" }])

    // At rest it goes, however recently it was active: the idle threshold is zero here.
    caller.telemetry = tele({ lastActivityAt: AFTER })
    const last = sweepRelocationOnce(b.deps(stateDir, to))
    assert.deepEqual(last.retired, ["rename-the-folder"])
    assert.equal(last.settled, true)
    assert.deepEqual(last.removedLinks, [from])
    assert.equal(existsSync(from) || lstatExists(from), false, "the link is gone")
    assert.equal(readRelocation(stateDir), null, "and so is the record")
    assert.equal(b.live.some((d) => d.sessionId === "s-fresh"), true, "a daemon started after the move was never touched")
    assert.equal(sweepRelocationOnce(b.deps(stateDir, to)).settled, true, "nothing pending is settled")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the link stays up for anything it cannot account for", () => {
  const { root, stateDir } = sandbox()
  try {
    const from = join(root, "alpha"), to = join(root, "beta")
    mkdirSync(to)
    leaveRelocationLink({ stateDir, from, to, now: () => new Date(MOVED_AT) })
    // No telemetry yet (the tailer of a just-reopened project has not primed) is a refusal, not a pass.
    const unprimed = board([{ sessionId: "s1", createdAt: BEFORE, slug: "one" }])
    assert.deepEqual(sweepRelocationOnce(unprimed.deps(stateDir, to)).waiting, [{ slug: "one", blockedBy: "no-telemetry" }])
    // A daemon with no row, an unreadable creation time, an ACP daemon from before, an enumeration that throws.
    const orphan = board([])
    const orphanDeps = orphan.deps(stateDir, to, { liveDaemons: () => [{ sessionId: "ghost", createdAt: "garbage" }] })
    assert.deepEqual(sweepRelocationOnce(orphanDeps).waiting, [{ slug: "ghost", blockedBy: "no-row" }])
    const acp = board([]).deps(stateDir, to, { otherLiveDaemons: () => [{ sessionId: "acp-1", createdAt: BEFORE }] })
    assert.deepEqual(sweepRelocationOnce(acp).waiting, [{ slug: "acp-1", blockedBy: "other-runtime" }])
    const blind = board([]).deps(stateDir, to, { liveDaemons: () => { throw new Error("EACCES") } })
    assert.equal(sweepRelocationOnce(blind).settled, false)
    assert.equal(lstatSync(from).isSymbolicLink(), true, "every one of those kept the link")
    // An ACP daemon started after the move is not the old folder's.
    const later = board([]).deps(stateDir, to, { otherLiveDaemons: () => [{ sessionId: "acp-2", createdAt: AFTER }] })
    assert.equal(sweepRelocationOnce(later).settled, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a link someone replaced is never removed", () => {
  const { root, stateDir } = sandbox()
  try {
    const from = join(root, "alpha"), to = join(root, "beta")
    mkdirSync(to)
    leaveRelocationLink({ stateDir, from, to, now: () => new Date(MOVED_AT) })
    rmSync(from)
    mkdirSync(from) // the operator made a real folder there
    writeFileSync(join(from, "mine.txt"), "keep")
    const swept = sweepRelocationOnce(board([]).deps(stateDir, to))
    assert.equal(swept.settled, true)
    assert.deepEqual(swept.removedLinks, [])
    assert.equal(existsSync(join(from, "mine.txt")), true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

function lstatExists(path: string): boolean {
  try { lstatSync(path); return true } catch { return false }
}
