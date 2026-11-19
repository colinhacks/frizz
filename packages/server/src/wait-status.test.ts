// WHERE A REST OUT OF THE QUEUE SITS (maintainer 2026-10-05) — the fence's `status:` answer and the board's
// band verdict, ThreadView.waitStatus. `working` is Running and spins, `watching` is Snoozed and still,
// `needs_input` is the queue. The decision is NEEDS_INPUT_REQUIRED_AT's paragraph in @frizz/shared; the
// verdict is board.deriveWaitStatus; needs-input.test.ts pins the queue rule the older `needs_input:` line
// set, which the alias still drives.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { activeBandThread, awaitingNeedsInput, awaitingStatus, hasLiveOps, isSnoozed, NEEDS_INPUT_REQUIRED_AT, sectionOf, splitAwaitingFrontmatter, type AwaitingHint, type GithubWatchStatus, type ThreadView } from "@frizz/shared"
import { createBoard, deriveAwaitingBackground, deriveNeedsYou, deriveWaitStatus, type RegisteredWatch } from "./board.ts"
import { GITHUB_STATUS_SETTING, type GithubStatusBook } from "./awaiting.ts"
import { Bus } from "./bus.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { Project } from "./project.ts"
import type { SessionTelemetry, Tailer } from "./tailer.ts"

const CUT = Date.parse(NEEDS_INPUT_REQUIRED_AT)
const NEW_SPAWN = new Date(CUT + 60_000).toISOString()
const LEGACY_SPAWN = new Date(CUT - 86_400_000).toISOString()
const AT = new Date(CUT + 3_600_000).toISOString() // the rest
const NOW = Date.parse(AT) + 5 * 60_000

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "t", session_id: "s", thread_name: "frizz-t", spawned_at: NEW_SPAWN, last_read_at: null,
    unread: 0, exited: 0, archived: 0, rested_at: AT, title_auto: 0, title: null,
    state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}
const LIVE_AGENT = { id: "toolu_agent", taskId: "a01b2d20", label: "poll the release feed", startedAt: AT, state: "running" as const }
const LIVE_SHELL = { id: "toolu_shell", taskId: "bzvtnt3ig", label: "nub run bench", startedAt: AT, state: "running" as const }
const DEV_SERVER = { id: "toolu_dev", taskId: "bdevsrv01", label: "nub run dev", startedAt: AT, state: "running" as const }
function tele(over: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return { turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastAssistantAt: AT, ...over } as SessionTelemetry
}
const fence = (...hints: AwaitingHint[]) => ({ lastFence: { kind: "awaiting" as const, body: "", hints } })
const status = (value: string): AwaitingHint => ({ kind: "status", value })
const FOR_2H: AwaitingHint = { kind: "for", value: "2h" }
const PR = "acme/app#391"
const ci = (over: Partial<GithubWatchStatus> = {}): GithubWatchStatus => ({
  checks: "running", running: 3, passed: 9, failed: 0, skipped: 0, gated: 0, gating: [], failing: [],
  merge: "mergeable", state: "open", polledAt: AT, ...over,
})

// The board's own order — the queue rule first, then the card fact, then the band — with each input named.
function place(r: SessionRow, t: SessionTelemetry, extra: { github?: GithubStatusBook; prs?: string[]; timers?: string[]; watches?: RegisteredWatch[]; runtime?: "turn-idle" | "exited" | "running"; inFlight?: boolean; now?: number } = {}) {
  const runtime = extra.runtime ?? "turn-idle"
  const now = extra.now ?? NOW
  const prs = new Set(extra.prs ?? [])
  const timers = new Set(extra.timers ?? [])
  const github = extra.github ?? {}
  const watches = extra.watches ?? []
  const needsYou = deriveNeedsYou(r, t, runtime, false, now, undefined, true, false, github, prs, timers, watches, 0, extra.inFlight ?? false)
  const card = deriveAwaitingBackground(r, t, runtime, false, now, undefined, false, github, prs, timers, watches)
  return { needsYou, waitStatus: deriveWaitStatus(t, runtime, needsYou, card, extra.inFlight ?? false, now, github, prs, watches) }
}

// ---- THE GRAMMAR ---------------------------------------------------------------------------------

test("`status:` is one structural line with three words, read case- and hyphen-blind", () => {
  for (const word of ["working", "watching", "needs_input"] as const) {
    const { hints, body } = splitAwaitingFrontmatter(`shells: [bzvtnt3ig]\nstatus: ${word}\nfor: 2h`)
    assert.deepEqual(hints.find((h) => h.kind === "status"), { kind: "status", value: word })
    assert.equal(body, "", "a quiet park is the fence alone")
    assert.equal(awaitingStatus(hints), word)
    assert.equal(awaitingNeedsInput(hints), word === "needs_input", "the queue reads the same answer")
  }
  assert.equal(awaitingStatus(splitAwaitingFrontmatter("shells: [x]\nstatus: Needs-Input\nfor: 2h").hints), "needs_input")
  assert.equal(awaitingStatus(splitAwaitingFrontmatter("shells: [x]\nstatus: WATCHING\nfor: 2h").hints), "watching")
})

test("a word frizz cannot read is no answer — kept as written so the correction can quote it", () => {
  const hints = splitAwaitingFrontmatter("shells: [x]\nstatus: busy\nfor: 2h").hints
  assert.deepEqual(hints.find((h) => h.kind === "status"), { kind: "status", value: "busy" })
  assert.equal(awaitingStatus(hints), null)
  assert.equal(awaitingNeedsInput(hints), null)
  // …unless the older line answers beside it.
  assert.equal(awaitingNeedsInput(splitAwaitingFrontmatter("shells: [x]\nstatus: busy\nneeds_input: false\nfor: 2h").hints), false)
})

test("the older `needs_input:` line is an alias: true is the queue, false leaves the place to frizz", () => {
  const yes = splitAwaitingFrontmatter("shells: [x]\nneeds_input: true\nfor: 2h").hints
  assert.equal(awaitingStatus(yes), "needs_input")
  const no = splitAwaitingFrontmatter("shells: [x]\nneeds_input: false\nfor: 2h").hints
  assert.equal(awaitingStatus(no), null, "no place was named — deriveWaitStatus reads the work")
  assert.equal(awaitingNeedsInput(no), false, "but it still answers the queue")
  // `status:` wins over the older line when both are written.
  assert.equal(awaitingStatus(splitAwaitingFrontmatter("shells: [x]\nneeds_input: true\nstatus: watching\nfor: 2h").hints), "watching")
})

test("steps and questions wait on the human, so they are `needs_input` whatever the line says", () => {
  const steps = splitAwaitingFrontmatter("steps:\n  - Run `npm login`\nstatus: watching").hints
  assert.equal(awaitingStatus(steps), "needs_input")
  assert.equal(awaitingNeedsInput(steps), true)
  const asked = splitAwaitingFrontmatter("questions: [qst_ab12cd34]\nstatus: working").hints
  assert.equal(awaitingStatus(asked), "needs_input")
})

test("the hint cap counts items only, so a full fence keeps its answer and its duration", () => {
  // Eight items is AWAITING_HINT_MAX. Until 2026-10-05 the cap counted every line, so the scalars after
  // the eighth item were dropped — a fence the correction could never satisfy, however it was re-sent.
  const shells = Array.from({ length: 9 }, (_, i) => `b${i}`).join(", ")
  const { hints } = splitAwaitingFrontmatter(`shells: [${shells}]\nstatus: working\nfor: 2h\ntitle: Nine shards`)
  assert.equal(hints.filter((h) => h.kind === "shell").length, 8, "the items are still capped")
  assert.equal(awaitingStatus(hints), "working")
  assert.deepEqual(hints.find((h) => h.kind === "for"), { kind: "for", value: "2h" })
  assert.deepEqual(hints.find((h) => h.kind === "title"), { kind: "title", value: "Nine shards" })
})

// ---- THE VERDICT ---------------------------------------------------------------------------------

test("`watching` on a named shell is out of the queue and Snoozed — the reported watcher", () => {
  assert.deepEqual(place(row(), tele({ bgShells: [LIVE_SHELL], ...fence({ kind: "shell", value: "bzvtnt3ig" }, FOR_2H, status("watching")) })), { needsYou: false, waitStatus: "watching" })
})

test("`working` spins only while something it names MOVES", () => {
  // A named shell moves.
  assert.deepEqual(place(row(), tele({ bgShells: [LIVE_SHELL], ...fence({ kind: "shell", value: "bzvtnt3ig" }, FOR_2H, status("working")) })), { needsYou: false, waitStatus: "working" })
  // A live sub-agent moves, named or not.
  assert.deepEqual(place(row(), tele({ subAgents: [LIVE_AGENT], ...fence({ kind: "agent", value: "a01b2d20" }, FOR_2H, status("working")) })), { needsYou: false, waitStatus: "working" })
  // A timer is the clock, not motion: the same `working` reads as the watch it is.
  assert.deepEqual(place(row(), tele(fence({ kind: "timer", value: "tmr_a1" }, FOR_2H, status("working"))), { timers: ["tmr_a1"] }), { needsYou: false, waitStatus: "watching" })
  // A shell nobody named — a dev server — is not the motion either, even beside a named timer.
  assert.deepEqual(place(row(), tele({ bgShells: [DEV_SERVER], ...fence({ kind: "timer", value: "tmr_a1" }, FOR_2H, status("working")) }), { timers: ["tmr_a1"] }).waitStatus, "watching")
})

test("`working` on a PR spins while its checks run, and reads as a watch once they settle or gate", () => {
  const park = tele(fence({ kind: "pr", value: PR }, FOR_2H, status("working")))
  assert.equal(place(row(), park, { prs: [PR], github: { [PR]: ci() } }).waitStatus, "working")
  assert.equal(place(row(), park, { prs: [PR], github: { [PR]: ci({ checks: "passing", running: 0 }) } }).waitStatus, "watching")
  // Held at GitHub's "Approve and run" gate: nothing moves until a maintainer presses the button.
  assert.equal(place(row(), park, { prs: [PR], github: { [PR]: ci({ running: 0, gated: 2 }) } }).waitStatus, "watching")
  // Never polled: frizz does not know, and not-knowing is not motion.
  assert.equal(place(row(), park, { prs: [PR] }).waitStatus, "watching")
})

test("a registered shell watch is the worker naming the shell — until the row runs out", () => {
  const watch: RegisteredWatch = { id: "wch_1", kind: "shell", target: "bzvtnt3ig", createdAt: AT, expiresAt: new Date(NOW + 3_600_000).toISOString() }
  const park = tele({ bgShells: [LIVE_SHELL], ...fence({ kind: "timer", value: "tmr_a1" }, FOR_2H, status("working")) })
  assert.equal(place(row(), park, { timers: ["tmr_a1"], watches: [watch] }).waitStatus, "working")
  assert.equal(place(row(), park, { timers: ["tmr_a1"], watches: [{ ...watch, expiresAt: new Date(NOW - 1).toISOString() }] }).waitStatus, "watching")
})

test("`watching` beside a live sub-agent is honoured — the child is watching the world for its parent", () => {
  const t = tele({ subAgents: [LIVE_AGENT], ...fence({ kind: "agent", value: "a01b2d20" }, FOR_2H, status("watching")) })
  assert.deepEqual(place(row(), t), { needsYou: false, waitStatus: "watching" })
})

test("`needs_input` queues, and a queued rest never carries a band — event-snoozed or not", () => {
  const t = tele({ bgShells: [LIVE_SHELL], ...fence({ kind: "shell", value: "bzvtnt3ig" }, FOR_2H, status("needs_input")) })
  assert.deepEqual(place(row(), t), { needsYou: true, waitStatus: undefined })
  // The human's snooze off the resting card takes it out of the queue; the CLICK parks it, not this.
  assert.deepEqual(place(row({ bg_snooze_rested_at: AT }), t), { needsYou: false, waitStatus: undefined })
})

test("the older `needs_input: false`, and a legacy fence with neither line, get frizz's reading", () => {
  const legacy = row({ spawned_at: LEGACY_SPAWN })
  // A live sub-agent or moving CI is work; a shell alone cannot say what it is, so it is a watch.
  assert.equal(place(row(), tele({ subAgents: [LIVE_AGENT], ...fence({ kind: "agent", value: "a01b2d20" }, FOR_2H, { kind: "needs_input", value: "false" }) })).waitStatus, "working")
  assert.equal(place(row(), tele({ bgShells: [LIVE_SHELL], ...fence({ kind: "shell", value: "bzvtnt3ig" }, FOR_2H, { kind: "needs_input", value: "false" }) })).waitStatus, "watching")
  assert.equal(place(row(), tele(fence({ kind: "pr", value: PR }, FOR_2H, { kind: "needs_input", value: "false" })), { prs: [PR], github: { [PR]: ci() } }).waitStatus, "working")
  // THE REPORTED THREAD: dispatched before the cut, parked a day on a shell watcher with no answer line.
  assert.deepEqual(place(legacy, tele({ bgShells: [LIVE_SHELL], ...fence({ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "23h" }) })), { needsYou: false, waitStatus: "watching" })
  // A legacy rest on a live sub-agent with no fence at all is still excused, and still working.
  assert.deepEqual(place(legacy, tele({ subAgents: [LIVE_AGENT] })), { needsYou: false, waitStatus: "working" })
})

test("no band off rest, and none while a message is on its way to the worker", () => {
  const t = tele({ bgShells: [LIVE_SHELL], ...fence({ kind: "shell", value: "bzvtnt3ig" }, FOR_2H, status("watching")) })
  assert.equal(place(row(), t, { runtime: "running" }).waitStatus, undefined)
  assert.equal(place(row(), t, { runtime: "exited" }).waitStatus, undefined)
  // An answer the human sent: the row keeps its Running placement until the turn starts, never Snoozed.
  assert.equal(place(row(), t, { inFlight: true }).waitStatus, undefined)
  // A rest with nothing out has nothing to place.
  assert.equal(deriveWaitStatus(tele(), "turn-idle", false, false, false, NOW), undefined)
})

// ---- THE BOARD, END TO END -----------------------------------------------------------------------
// The view the client bands from: deriveWaitStatus has to reach ThreadView through the real assembly, and
// the shared predicates — the sidebar's bands and the rail's running count — have to read it.

test("the board carries the verdict, and the bands and the running count follow it", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-wait-status-"))
  const project: Project = { dir, id: "p", name: "fixture", label: "fixture", stateDir: dir, cwdSlug: "fixture" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const fences: Record<string, Partial<SessionTelemetry>> = {
    // The reported shape: a pre-cut worker parked on a shell watcher with no answer line.
    "legacy-watcher": { bgShells: [LIVE_SHELL], ...fence({ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "23h" }) },
    "bench": { bgShells: [LIVE_SHELL], ...fence({ kind: "shell", value: "bzvtnt3ig" }, FOR_2H, status("working")) },
    "poller": { subAgents: [LIVE_AGENT], ...fence({ kind: "agent", value: "a01b2d20" }, FOR_2H, status("watching")) },
    "ready": { bgShells: [LIVE_SHELL], ...fence({ kind: "shell", value: "bzvtnt3ig" }, FOR_2H, status("needs_input")) },
    "ci": fence({ kind: "pr", value: PR }, FOR_2H, status("working")),
  }
  for (const slug of Object.keys(fences)) {
    storage.upsertSession(row({ slug, session_id: `sess-${slug}`, thread_name: `frizz-${slug}`, spawned_at: slug === "legacy-watcher" ? LEGACY_SPAWN : NEW_SPAWN }))
    storage.setBackend(slug, "claude")
    storage.setClaudeRuntime(slug, "broker")
  }
  storage.armPrWatch({ id: "prw_1", slug: "ci", owner: "acme", repo: "app", number: 391, createdAtMs: Date.parse(AT), expiresAtMs: Date.parse(AT) + 86_400_000 })
  storage.setSetting(GITHUB_STATUS_SETTING, { [PR]: ci() })
  const tailer = {
    // The shells and children report their own instants; the rest is the fence the worker left.
    get: (slug: string) => tele({ turn: "idle", lastActivityAt: AT, ...fences[slug] }),
    foreignIds: () => [], subAgent: () => undefined, forget: () => {},
    start: () => {}, stop: () => {}, tick: () => {},
  } satisfies Tailer
  // The board's own clock, pinned: every park here runs out against it (`for:`, the legacy day cap).
  const board = createBoard(project, storage, new Bus(), tailer, "wait-status", { claudeBrokerDaemonAlive: () => true, now: () => NOW })
  try {
    const views = new Map(board.refresh().threads.map((t) => [t.id, t] as const))
    const view = (slug: string): ThreadView => views.get(slug)!
    const bandOf = (slug: string) => ({ waitStatus: view(slug).waitStatus, section: sectionOf(view(slug)), running: activeBandThread(view(slug)) })
    for (const slug of Object.keys(fences)) assert.equal(view(slug).runtime, "turn-idle", slug)

    assert.deepEqual(bandOf("legacy-watcher"), { waitStatus: "watching", section: "snoozed", running: false })
    assert.deepEqual(bandOf("bench"), { waitStatus: "working", section: "active", running: true })
    assert.deepEqual(bandOf("poller"), { waitStatus: "watching", section: "snoozed", running: false })
    assert.equal(hasLiveOps(view("poller")), false, "a watching parent is not motion; its child spins on its own row")
    assert.deepEqual(bandOf("ci"), { waitStatus: "working", section: "active", running: true })
    // The queued rest: in the cue, never counted as running, never banded.
    assert.equal(view("ready").needsYou, true)
    assert.deepEqual(bandOf("ready"), { waitStatus: undefined, section: "active", running: false })
    assert.equal(isSnoozed(view("ready")), false)
  } finally {
    board.stop()
    storage.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
