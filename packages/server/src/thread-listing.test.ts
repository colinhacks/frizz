import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { sectionAt, inActiveBand, type BoardSnapshot, type ThreadView } from "@frizz/shared"
import type { BoardManager } from "./board.ts"
import { Bus, Emitter } from "./bus.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import { registerProject } from "./project-registry.ts"
import { createRouter } from "./router.ts"
import { createStorage } from "./storage.ts"
import type { Tailer } from "./tailer.ts"
import { listBoardThreads } from "./thread-listing.ts"

// `frizzctl threads` reads a board through `listThreads`. What is pinned: each thread lands in the band
// the SIDEBAR draws it in (the shared predicates, not a re-derivation), with the title the sidebar shows;
// a row the sidebar never draws is not listed; the Done band is counted but listed only when asked for;
// and another project's board is read from that project's own tenant.

const NOW = Date.parse("2026-11-03T12:00:00.000Z")
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()

function thread(id: string, over: Partial<ThreadView> = {}): ThreadView {
  return {
    id, title: id, status: "active", mechanism: null, humanBlocked: false, ready: false, dependsOn: [],
    externalDeps: [], agents: [], errors: [], warnings: [], runtime: "turn-idle", unread: false,
    archived: false, hasPlan: false, subAgents: [], bgShells: [], watches: [], questions: [],
    pendingQuestion: false, kind: "session", state: "open", spawnedAt: at(86400_000), ...over,
  } as ThreadView
}

const BOARD: ThreadView[] = [
  thread("finished-handoff", { needsYou: true, lastFence: { kind: "done", body: "", hints: [] }, lastActivityAt: at(3600_000), lastAssistantLine: "**Fixed** — landed." }),
  thread("asking", {
    needsYou: true, lastActivityAt: at(60_000),
    questions: [
      { standing: true } as ThreadView["questions"][number],
      { standing: false } as ThreadView["questions"][number],
    ],
  }),
  thread("mid-turn", {
    runtime: "running", lastActivityAt: at(5_000), liveTool: { name: "Bash", desc: "Running the focused tests" },
    subAgents: [
      { id: "a1", state: "running", depth: 1 } as ThreadView["subAgents"][number],
      { id: "a2", state: "running", depth: 2 } as ThreadView["subAgents"][number],
      { id: "a3", state: "rested", depth: 1 } as ThreadView["subAgents"][number],
    ],
  }),
  thread("watching-a-pr", {
    waitStatus: "watching", lastFence: { kind: "awaiting", body: "", hints: [] }, lastActivityAt: at(7200_000),
    watches: [
      { id: "w1", kind: "github", target: "acme/app#391", state: "armed", createdAt: at(7200_000) },
      { id: "w2", kind: "github", target: "acme/app#12", state: "fired", createdAt: at(7200_000) },
      { id: "w3", kind: "shell", target: "bz1", state: "armed", createdAt: at(7200_000) },
    ],
    pinnedAt: at(100),
  }),
  thread("old-archived", { state: "archived", archived: true, runtime: "exited", archivedAt: at(3 * 86400_000) }),
  thread("new-archived", { state: "archived", archived: true, runtime: "exited", archivedAt: at(86400_000) }),
  thread("named-by-worker", { title: "If we don't already…", titleAuto: true, aiTitle: "Frizz CLI thread listing command", runtime: "running", lastActivityAt: at(1_000) }),
  thread("named-by-human", { title: "The human's name", titleAuto: false, titleLocked: true, aiTitle: "a-worker-guess", needsYou: true, lastActivityAt: at(120_000) }),
  thread("someone-elses-terminal", { foreign: true, runtime: "running" }),
  thread("legacy-file-row", { kind: "legacy" }),
]

const PROJECT = { slug: "frizz", id: "proj-frizz", name: "frizz" }

test("every thread lands in the band the sidebar draws it in, newest first, Done counted but not listed", () => {
  const listed = listBoardThreads(BOARD, PROJECT, { nowMs: NOW })
  assert.deepEqual(listed.project, PROJECT)
  assert.deepEqual(listed.counts, { rested: 3, active: 2, snoozed: 1, done: 2 })
  assert.deepEqual(listed.threads.map((t) => [t.band, t.slug]), [
    ["rested", "asking"], ["rested", "named-by-human"], ["rested", "finished-handoff"],
    ["active", "named-by-worker"], ["active", "mid-turn"],
    ["snoozed", "watching-a-pr"],
  ])
  // The band is the sidebar's own: the same predicates, read the way groups.ts sectionThreads reads them.
  for (const row of listed.threads) {
    const view = BOARD.find((t) => t.id === row.slug)!
    const section = sectionAt(view, NOW)
    const sidebar = section === "snoozed" ? "snoozed" : section === "inactive" ? "done" : inActiveBand(view) ? "active" : "rested"
    assert.equal(row.band, sidebar, row.slug)
  }

  const all = listBoardThreads(BOARD, PROJECT, { nowMs: NOW, all: true })
  assert.deepEqual(all.counts, listed.counts)
  assert.deepEqual(all.threads.filter((t) => t.band === "done").map((t) => t.slug), ["new-archived", "old-archived"], "newest archived first")
})

test("each row carries the shown title and the facts behind its band", () => {
  const rows = new Map(listBoardThreads(BOARD, PROJECT, { nowMs: NOW }).threads.map((t) => [t.slug, t]))
  assert.equal(rows.get("named-by-worker")?.title, "Frizz CLI thread listing command", "the worker's own name beats the prompt chop")
  assert.equal(rows.get("named-by-human")?.title, "The human's name", "a human's name beats the worker's")

  const midTurn = rows.get("mid-turn")!
  assert.equal(midTurn.doing, "Running the focused tests")
  assert.equal(midTurn.subAgents, 1, "direct children that are still running, and nothing else")

  assert.equal(rows.get("asking")?.questions, 1, "only a question standing at this rest")
  assert.equal(rows.get("asking")?.doing, undefined, "nothing is in flight at rest")

  const finished = rows.get("finished-handoff")!
  assert.equal(finished.fence, "done")
  assert.equal(finished.lastLine, "**Fixed** — landed.")

  const watching = rows.get("watching-a-pr")!
  assert.deepEqual(watching.watches, ["acme/app#391"], "armed watches only, and a shell is counted rather than named")
  assert.equal(watching.pinned, true)
})

// ── the procedure, over two real routers ───────────────────────────────────────────────────────────

function homeSandbox(t: { after: (fn: () => void) => void }): string {
  const home = mkdtempSync(join(tmpdir(), "frizz-list-threads-"))
  const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  process.env.HOME = home
  process.env.USERPROFILE = home
  t.after(() => {
    process.env.HOME = previous.HOME
    process.env.USERPROFILE = previous.USERPROFILE
    rmSync(home, { recursive: true, force: true })
  })
  return home
}

const idleTailer = {
  get: () => ({ turn: "idle" }), foreignIds: () => [], subAgent: () => undefined,
  forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
} as unknown as Tailer

function tenant(home: string, id: string, name: string, threads: ThreadView[]) {
  const dir = join(home, "code", name)
  mkdirSync(dir, { recursive: true })
  registerProject({ dir, id }, home)
  const project: Project = { dir, id, name, label: name, stateDir: dir, cwdSlug: name }
  const storage = createStorage(join(dir, "ui.db"), id)
  const snapshot = { threads } as unknown as BoardSnapshot
  const board = { refresh: () => snapshot, snapshot: async () => snapshot } as unknown as BoardManager
  const tenants: Array<ReturnType<NonNullable<AppContext["activeTenants"]>>[number]> = []
  const ctx = {
    project, storage, board, tailer: idleTailer, transcriptChange: new Emitter<string[]>(), bus: new Bus(),
    activeTenants: () => tenants,
  } as unknown as AppContext
  return { project, storage, board, tenants, router: createRouter(ctx) }
}

test("`listThreads` reads this board, or another project's from that project's own tenant", async (t) => {
  const home = homeSandbox(t)
  const frizz = tenant(home, "5d6e7f80-1a2b-4c3d-8e9f-0a1b2c3d4e5f", "frizz", [thread("here", { runtime: "running" })])
  const nub = tenant(home, "0b1f3a52-58c4-4c6e-9d0e-7f8a2b3c4d5e", "nub", [thread("there", { needsYou: true }), thread("gone", { state: "archived", archived: true, runtime: "exited" })])
  for (const a of [frizz, nub]) a.tenants.push(...[frizz, nub].map((o) => ({ project: o.project, board: o.board, storage: o.storage })))
  t.after(() => { frizz.storage.close(); nub.storage.close() })

  const own = await frizz.router.listThreads.handler({ input: {} })
  assert.deepEqual(own.project, { slug: "frizz", id: frizz.project.id, name: "frizz" })
  assert.deepEqual(own.threads.map((r) => [r.slug, r.band]), [["here", "active"]])

  const other = await frizz.router.listThreads.handler({ input: { project: "nub" } })
  assert.equal(other.project.slug, "nub")
  assert.deepEqual(other.threads.map((r) => [r.slug, r.band]), [["there", "rested"]])
  assert.equal(other.counts.done, 1)
  const everything = await frizz.router.listThreads.handler({ input: { project: "nub", all: true } })
  assert.deepEqual(everything.threads.map((r) => r.slug), ["there", "gone"])

  // Naming your own project is your own board, not a lookup that fails.
  assert.equal((await frizz.router.listThreads.handler({ input: { project: "frizz" } })).project.id, frizz.project.id)
  // An unknown project is refused with every project this machine has, so the caller can pick the right one.
  await assert.rejects(frizz.router.listThreads.handler({ input: { project: "zod" } }), (err: Error) => {
    assert.match(err.message, /^no project `zod` on this machine\. .*the projects are /)
    assert.match(err.message, /`frizz`/)
    assert.match(err.message, /`nub`/)
    return true
  })
})
