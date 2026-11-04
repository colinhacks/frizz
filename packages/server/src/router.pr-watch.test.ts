// THE PR WATCHER REGISTRY at the RPC boundary — the real router against real SQLite.
//
// `mcp__frizz__watch_pr` is proven callable over its real stdio transport in frizz-mcp.test.ts; that
// test stands a fake http server in for frizz, so it pins the tool's half of the wire and nothing about
// what the server does with it. This is the other half: given the exact body that tool sends, does a row
// appear, and do the refusals refuse?
//
// Every one of these is a way a worker could come to rest believing it is covered when it is not. That
// is the failure mode worth testing here — a watcher that cannot fire is worse than no watcher, because
// the worker stops looking.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BoardSnapshot, Settings } from "@frizz/shared"
import { PR_WATCH_DEFAULT_FOR_MS, PR_WATCH_FOR_MAX_MS, PR_WATCH_MAX_ARMED } from "@frizz/shared"
import type { BoardManager } from "./board.ts"
import type { PrRef, PrProbe } from "./scheduler.ts"
import { createRouter } from "./router.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import type { Tailer } from "./tailer.ts"

function harness(opts: { probe?: (ref: PrRef) => PrProbe; probeIssue?: (ref: PrRef) => PrProbe } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-pr-watch-rpc-"))
  const project: Project = { dir, id: "prw", name: "test", label: "test", stateDir: dir, cwdSlug: "test" }
  const storage = createStorage(join(dir, "ui.db"), "p")
  const snapshot: BoardSnapshot = { projectDir: dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  let refreshes = 0
  const board: BoardManager = {
    snapshot: async () => snapshot,
    currentSeq: () => 0, deltasSince: () => null, snapshotState: async () => ({ board: ({}) as never, seq: 0 }),
    rebuild: async () => snapshot,
    refresh: () => { refreshes++; return snapshot },
    start: async () => {},
    stop: async () => {},
  }
  const tailer: Tailer = {
    get: () => undefined, foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const ctx = {
    project, storage, board, tailer,
    getSettings: () => ({ permissionMode: "auto" }) as unknown as Settings,
    // The registration probe answers "readable" unless a test says otherwise — every ref below is
    // fictional, and the real probe would ask GitHub about it.
    probePr: async (ref: PrRef) => opts.probe?.(ref) ?? { ok: true as const },
    probeIssue: async (ref: PrRef) => opts.probeIssue?.(ref) ?? { ok: true as const },
  } as unknown as AppContext
  return {
    storage,
    router: createRouter(ctx),
    refreshes: () => refreshes,
    close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: "2026-08-14T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}

test("add registers the PR, normalizes the ref, and answers with the thread's armed set", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    // A PR URL, because that is what a worker pastes out of `gh pr create` — and it must normalize to
    // the same `owner/repo#N` the board's rows and the poller's status book are keyed by, or the same
    // PR registered two ways would be two watchers and two wakes.
    const added = await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "https://github.com/acme/app/pull/391", for: "2h" } })
    assert.equal(added.target, "acme/app#391")
    assert.equal(added.alreadyArmed, false)
    assert.deepEqual(added.watches.map((w) => w.target), ["acme/app#391"])
    const [stored] = h.storage.listPrWatches("t", { armedOnly: true })
    assert.deepEqual(
      { owner: stored.owner, repo: stored.repo, number: stored.number, state: stored.state, cursor: stored.cursor },
      { owner: "acme", repo: "app", number: 391, state: "armed", cursor: null },
    )
    assert.ok(h.refreshes() > 0, "the board is refreshed, so the strip shows the new watcher at once")
  } finally { h.close() }
})

// IDEMPOTENT PER PR, and this is the case that actually happens: a worker's context is compacted, it no
// longer remembers what it holds, and it re-registers to be careful. Minting a second row there would
// mean two wakes for every event, which reads to the operator as the watcher misfiring.
test("registering the same PR twice returns the SAME watcher rather than a duplicate", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const first = await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#391", for: "2h" } })
    const again = await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "https://github.com/acme/app/pull/391", for: "2h" } })
    assert.equal(again.id, first.id)
    assert.equal(again.alreadyArmed, true)
    assert.equal(h.storage.listPrWatches("t", { armedOnly: true }).length, 1)
  } finally { h.close() }
})

test("the same PR in a different letter case is the same watcher — GitHub names are case-blind", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const first = await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#391", for: "2h" } })
    const again = await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "Acme/App#391", for: "2h" } })
    assert.equal(again.id, first.id)
    assert.equal(again.alreadyArmed, true)
    assert.equal(h.storage.listPrWatches("t", { armedOnly: true }).length, 1)
  } finally { h.close() }
})

// REFUSED, NOT STORED. A ref frizz cannot parse names no PR, so the watcher could never fire — and the
// worker would rest believing it was covered. The refusal has to say what a good ref looks like, since
// the model's next move is to try again.
test("a ref that names no pull request is refused, and nothing is written", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await assert.rejects(
      () => h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "the auth PR", for: "2h" } }),
      /is not a pull request I can watch/,
    )
    assert.deepEqual(h.storage.listPrWatches("t"), [])
  } finally { h.close() }
})

test("an unregistered or archived thread cannot register a watcher", async () => {
  const h = harness()
  try {
    await assert.rejects(
      () => h.router.addOwnPrWatch.handler({ input: { slug: "ghost", target: "acme/app#391", for: "2h" } }),
      /is not registered/,
    )
    h.storage.upsertSession(row("shelved", { archived: 1, state: "archived" }))
    await assert.rejects(
      () => h.router.addOwnPrWatch.handler({ input: { slug: "shelved", target: "acme/app#391", for: "2h" } }),
      /Reopen this thread/,
    )
  } finally { h.close() }
})

// The cap is what makes "watch as many as you like" safe to offer: a tool call in a loop cannot fill the
// table, and the refusal NAMES the number so the worker drops one rather than retrying forever.
test("the armed cap refuses the next one and says what to do about it", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    for (let i = 1; i <= PR_WATCH_MAX_ARMED; i++) {
      await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: `acme/app#${i}`, for: "2h" } })
    }
    await assert.rejects(
      () => h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#999", for: "2h" } }),
      new RegExp(`the limit is ${PR_WATCH_MAX_ARMED}`),
    )
    assert.equal(h.storage.listPrWatches("t", { armedOnly: true }).length, PR_WATCH_MAX_ARMED)
  } finally { h.close() }
})

// DROP IS SCOPED TO THE CALLER'S OWN SLUG, in storage rather than in the handler, so an id belonging to
// another thread cannot be withdrawn even if a worker somehow learned it. And a drop that matched
// nothing is REPORTED rather than swallowed: a worker that believes it withdrew a wait it still holds
// will be woken by something it stopped caring about.
test("drop withdraws the caller's own watcher, and says so when it matched nothing", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("mine"))
    h.storage.upsertSession(row("theirs"))
    const mine = await h.router.addOwnPrWatch.handler({ input: { slug: "mine", target: "acme/app#391", for: "2h" } })

    const wrongThread = await h.router.dropOwnPrWatch.handler({ input: { slug: "theirs", id: mine.id } })
    assert.equal(wrongThread.dropped, false, "another thread's id is not droppable")
    assert.equal(h.storage.listPrWatches("mine", { armedOnly: true }).length, 1, "…and the row survives")

    const dropped = await h.router.dropOwnPrWatch.handler({ input: { slug: "mine", id: mine.id } })
    assert.equal(dropped.dropped, true)
    assert.deepEqual(dropped.watches, [], "the answer is the set it now holds — no second call needed")
    assert.equal(h.storage.getPrWatch(mine.id)?.state, "dropped")

    // Only an ARMED row moves: dropping one that already settled is a no-op, not a rewrite of history.
    const twice = await h.router.dropOwnPrWatch.handler({ input: { slug: "mine", id: mine.id } })
    assert.equal(twice.dropped, false)
  } finally { h.close() }
})

// The read-back carries each PR's CHECK STATE off the poller's status book, which is the reason a worker
// lists at all. It comes from the SAME book the board's rows read, so the tool and the card can never
// disagree about one PR — the drift that produced two cards saying different things about one wait.
test("list answers with each PR's latest checks, from the same book the board reads", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#391", for: "2h" } })
    h.storage.setSetting("waker.github.status.v1", {
      "acme/app#391": {
        checks: "failing", running: 1, passed: 9, failed: 2, failing: ["lint"],
        merge: "blocked", state: "open", polledAt: "2026-08-14T00:05:00.000Z",
      },
    })
    const listed = await h.router.listOwnPrWatches.handler({ input: { slug: "t" } })
    assert.equal(listed.watches[0].github?.checks, "failing")
    assert.deepEqual(listed.watches[0].github?.failing, ["lint"])

    // An UNPOLLED PR carries no status at all rather than an invented one — "frizz has not looked yet"
    // and "this PR has no CI" are different facts, and only the second means the wait is nearly over.
    await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#392", for: "2h" } })
    const both = await h.router.listOwnPrWatches.handler({ input: { slug: "t" } })
    assert.equal(both.watches.find((w) => w.target === "acme/app#392")?.github, undefined)
  } finally { h.close() }
})

// Watchers die with the thread they belong to. A row on a hard-deleted thread has nothing to wake and
// would be polled on every tick forever.
test("forgetting a thread takes its watchers with it", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#391", for: "2h" } })
    h.storage.forgetSession("t")
    assert.deepEqual(h.storage.listPrWatches("t"), [])
    assert.deepEqual(h.storage.armedPrWatches(), [])
  } finally { h.close() }
})

// ---- A PR THE SERVER CANNOT READ IS REFUSED AT REGISTRATION (2026-08-25) ----
// The poll runs the server's own `gh`; a PR it cannot see failed every minute in silence while the
// worker rested believing it was covered. Same rule as an unparseable ref, and it is checked AFTER the
// idempotent short-circuit so a re-registration during a GitHub blip still answers.
test("addOwnPrWatch: a PR the server's gh cannot read is refused with the reason, and nothing is armed", async () => {
  const h = harness({ probe: () => ({ ok: false, reason: "Could not resolve to a Repository with the name 'acme/app'. (repository)" }) })
  try {
    h.storage.upsertSession(row("t"))
    await assert.rejects(
      () => h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#391", for: "2h" } }),
      (err: Error) => /`acme\/app#391` cannot be watched/.test(err.message) && /Could not resolve to a Repository/.test(err.message) && /Settings → GitHub/.test(err.message),
    )
    assert.equal(h.storage.listPrWatches("t", { armedOnly: true }).length, 0)
  } finally { h.close() }
})

// A YEAR IS REPRESENTABLE, and that is the whole point of the ceiling being its own constant. A pull
// request in a repo nobody here controls moves on its maintainers' clock: capped at a day, a watcher on
// one expired against an untouched PR every 24h — four wakes in four days on `vercel/ai#20002`, none of
// them carrying any news (maintainer 2026-09-02).
test("a months-long `for` on a PR watcher is honoured, not quietly cut back to a day", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const added = await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#391", for: "180d" } })
    assert.equal(added.clampedFrom, undefined, "180d is under the ceiling, so nothing was capped")
    const [stored] = h.storage.listPrWatches("t", { armedOnly: true })
    const heldMs = (stored.expires_at ?? 0) - stored.created_at
    assert.equal(heldMs, 180 * 24 * 60 * 60 * 1000)
    assert.equal(added.expiresAt, new Date(stored.expires_at ?? 0).toISOString(), "…and the worker reads back what it got")
  } finally { h.close() }
})

// CLAMPED, NOT REFUSED — a fat-fingered `9999d` should still watch the PR. But SAID: a worker handed a
// day when it asked for a decade, and told nothing, rests believing it is covered.
test("a `for` above the ceiling is capped, and the cap is reported rather than applied in silence", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const added = await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#391", for: "9999d" } })
    assert.equal(added.clampedFrom, "9999d")
    const [stored] = h.storage.listPrWatches("t", { armedOnly: true })
    assert.equal((stored.expires_at ?? 0) - stored.created_at, PR_WATCH_FOR_MAX_MS)
  } finally { h.close() }
})

// The legacy path: an MCP binary predating `for` cannot send one. It still gets a BOUND — an unrenewed
// watcher must stop polling eventually — but no longer one short enough to be its own source of wakes.
test("a worker that cannot send `for` gets the bounded default, and reads its expiry back", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const added = await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#391" } })
    assert.equal(added.clampedFrom, undefined, "a default is not a clamp — the worker asked for nothing")
    const [stored] = h.storage.listPrWatches("t", { armedOnly: true })
    assert.equal((stored.expires_at ?? 0) - stored.created_at, PR_WATCH_DEFAULT_FOR_MS)
    assert.equal(added.expiresAt, new Date(stored.expires_at ?? 0).toISOString())
  } finally { h.close() }
})

test("addOwnPrWatch: an already-armed PR answers idempotently even when the probe would now refuse it", async () => {
  let readable = true
  const h = harness({ probe: () => (readable ? { ok: true } : { ok: false, reason: "HTTP 502" }) })
  try {
    h.storage.upsertSession(row("t"))
    const first = await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#391", for: "2h" } })
    readable = false
    const again = await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#391", for: "2h" } })
    assert.equal(again.alreadyArmed, true)
    assert.equal(again.id, first.id)
  } finally { h.close() }
})

// ---- ISSUES (2026-09-14): the same RPC with `kind: "issue"`, which is what `mcp__frizz__watch_issue` sends ----

test("issue add: an issue URL normalizes to the ref, stores kind issue under an isw_ id, and probes with gh issue view", async () => {
  const probed: { pr: PrRef[]; issue: PrRef[] } = { pr: [], issue: [] }
  const h = harness({
    probe: (ref) => { probed.pr.push(ref); return { ok: true } },
    probeIssue: (ref) => { probed.issue.push(ref); return { ok: true } },
  })
  try {
    h.storage.upsertSession(row("t"))
    const added = await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "https://github.com/acme/app/issues/7", for: "30d", kind: "issue" } })
    assert.equal(added.target, "acme/app#7")
    assert.match(added.id, /^isw_/)
    assert.deepEqual(added.watches.map((w) => [w.target, w.kind]), [["acme/app#7", "issue"]])
    assert.deepEqual(probed, { pr: [], issue: [{ owner: "acme", repo: "app", number: 7 }] }, "an issue is probed as an issue, never as a PR")
    const [stored] = h.storage.listPrWatches("t", { armedOnly: true })
    assert.equal(stored.kind, "issue")
    // Idempotent per (kind, ref): the same issue again is the same watcher.
    const again = await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#7", for: "1d", kind: "issue" } })
    assert.equal(again.alreadyArmed, true)
    assert.equal(again.id, added.id)
  } finally {
    h.close()
  }
})

test("issue add: a PR URL is refused for kind issue, and an issue URL is refused for a PR — each names its own grammar", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await assert.rejects(
      h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "https://github.com/acme/app/pull/391", for: "1d", kind: "issue" } }),
      /is not an issue I can watch/,
    )
    await assert.rejects(
      h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "https://github.com/acme/app/issues/7", for: "1d" } }),
      /is not a pull request I can watch/,
    )
  } finally {
    h.close()
  }
})

test("issue add: a probe failure refuses the watcher and says it was read as an issue", async () => {
  const h = harness({ probeIssue: () => ({ ok: false, reason: "GraphQL: Could not resolve to an Issue with the number of 7. (repository.issue)" }) })
  try {
    h.storage.upsertSession(row("t"))
    await assert.rejects(
      h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#7", for: "1d", kind: "issue" } }),
      /cannot be watched as an issue — Frizz could not read it: GraphQL: Could not resolve/,
    )
    assert.equal(h.storage.listPrWatches("t").length, 0)
  } finally {
    h.close()
  }
})

test("issue watchers read back through activity and block done under their own noun", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#7", for: "30d", kind: "issue" } })
    await h.router.addOwnPrWatch.handler({ input: { slug: "t", target: "acme/app#391", for: "2h" } })
    const activity = await h.router.listOwnThreadActivity.handler({ input: { slug: "t" } })
    assert.deepEqual(activity.activity.map((a) => [a.kind, a.id]).sort(), [["issue", "acme/app#7"], ["pr", "acme/app#391"]])
    const done = await h.router.markOwnDone.handler({ input: { slug: "t", body: "- did it" } })
    assert.equal(done.done, false)
    assert.deepEqual(done.blockingWatches.map((b) => b.what).sort(), ["issue: acme/app#7", "pull request: acme/app#391"])
  } finally {
    h.close()
  }
})

// A TIMER REFRESHES THE BOARD like a PR watcher does, so the rail shows it the moment it is set and drops
// it the moment it is cancelled — not at the next tailer change or the 15s reconcile.
test("setting and cancelling a timer each refresh the board; a cancel that matched nothing does not", async () => {
  const h = harness()
  try {
    h.storage.upsertSession(row("t"))
    const before = h.refreshes()
    const set = await h.router.setOwnThreadTimer.handler({ input: { slug: "t", prompt: "check the deploy", fireAt: new Date(Date.now() + 3_600_000).toISOString() } })
    assert.equal(h.refreshes(), before + 1)
    const cancelled = await h.router.cancelOwnThreadTimer.handler({ input: { slug: "t", id: set.id } })
    assert.equal(cancelled.cancelled, true)
    assert.equal(h.refreshes(), before + 2)
    await h.router.cancelOwnThreadTimer.handler({ input: { slug: "t", id: set.id } })
    assert.equal(h.refreshes(), before + 2)
  } finally { h.close() }
})
