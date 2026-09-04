// THE BACKGROUND-SHELL WAKE END TO END — real tailer folding a real transcript file, real scheduler,
// real SQLite, no fake telemetry anywhere.
//
// A SHELL IS WATCHED AUTOMATICALLY. Maintainer 2026-08-14: "the agent just uses the built-in tool from
// the harness to start a background shell. It should be watched automatically: every time a background
// shell completes, the agent should be woken up. That's how it should always work." So the wake owes
// nothing to the awaiting fence, and the FIRST test here is the one with no fence at all.
//
// This is the seam a unit test cannot reach, because the mechanism is a hand-off between two things that
// each look fine alone: the fold has to turn a background-shell launch into a live `bgShells` row and its
// `<task-notification>` into a RETIREMENT carrying a finish INSTANT, and the scheduler has to compare
// that instant against the agent's own last word. A mock at either joint proves nothing about the other
// — which is how a version of this shipped a watcher that could never fire (`bf14128`), and how the
// `watch:` hint shipped unparseable (`9b6322e`).
//
// The transcript records are shape-accurate against a real ~/.claude/projects session (2026-07-23):
// the launch is a `tool_result` whose text carries "Command running in background with ID: <taskId>"
// with `toolUseResult.backgroundTaskId`, and the retirement is a `queue-operation` record whose
// `content` is the `<task-notification>` XML.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage, type SessionRow } from "./storage.ts"
import { createTailer } from "./tailer.ts"
import { createScheduler } from "./scheduler.ts"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import { GITHUB_STATUS_SETTING, readGithubStatusBook } from "./awaiting.ts"
import { deriveNeedsYou, deriveAwaitingBackground, fenceWatchViews } from "./board.ts"

const SLUG = "watcher"
const SESSION = "aaaaaaaa-bbbb-cccc-dddd-000000000001"
const TASK_ID = "bzvtnt3ig"
const TOOL_USE = "toolu_01MkWatchProbe"

const line = (o: unknown) => JSON.stringify(o) + "\n"

function launchRecords(at: string): string {
  return (
    line({
      type: "assistant", timestamp: at, sessionId: SESSION, uuid: "u1",
      message: {
        role: "assistant",
        content: [{
          type: "tool_use", id: TOOL_USE, name: "Bash",
          input: { command: "nub run test", description: "Running the suite", run_in_background: true },
        }],
      },
    }) +
    line({
      type: "user", timestamp: at, sessionId: SESSION, uuid: "u2",
      message: {
        role: "user",
        content: [{
          tool_use_id: TOOL_USE, type: "tool_result", is_error: false,
          content: `Command running in background with ID: ${TASK_ID}. Output is being written to: /tmp/${TASK_ID}.output. You will be notified when it completes.`,
        }],
      },
      toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: TASK_ID },
    })
  )
}

/** The worker's final message. `target` undefined = a BARE rest with no fence at all, which is the case
 *  the wake must not depend on. With a target it is an awaiting fence naming the shell by the handle the
 *  runtime gave it — a declaration the board reads, and no part of the wake. */
function parkRecord(at: string, target?: string): string {
  const text = target
    ? [
      "Kicked the suite off in the background; I'll fold the result in when it lands.",
      "",
      "```awaiting",
      `shells: [${target}]`,
      "Waiting on the test run.",
      "```",
    ].join("\n")
    : "Kicked the suite off in the background; I'll fold the result in when it lands."
  return line({
    type: "assistant", timestamp: at, sessionId: SESSION, uuid: "u3",
    message: { role: "assistant", content: [{ type: "text", text }] },
  })
}

function retirementRecord(at: string): string {
  return line({
    type: "queue-operation", operation: "enqueue", timestamp: at, sessionId: SESSION,
    content: [
      "<task-notification>",
      `<task-id>${TASK_ID}</task-id>`,
      `<tool-use-id>${TOOL_USE}</tool-use-id>`,
      `<output-file>/tmp/${TASK_ID}.output</output-file>`,
      "<status>completed</status>",
      '<summary>Background command "nub run test" completed</summary>',
      "</task-notification>",
    ].join("\n"),
  })
}

async function harness(target?: string) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-watch-e2e-"))
  const transcript = join(dir, `${SESSION}.jsonl`)
  const at = new Date(Date.now() - 60_000).toISOString()
  writeFileSync(transcript, launchRecords(at) + parkRecord(at, target))
  const storage = createStorage(join(dir, "ui.db"), "p")
  // Frizz's own sign-off nudge fires on a FENCELESS rest; every rest here carries a fence, so it cannot
  // fire — but silence it anyway so a delivery count is unambiguous about what produced it.
  storage.setSetting("signoffNudge", "off")
  storage.upsertSession({
    slug: SLUG, session_id: SESSION, thread_name: `frizz-${SLUG}`, spawned_at: at,
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: at, title_auto: 1,
    title: SLUG, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage, bus: new Bus(), sessionLogDir: dir,
    onChange: () => {}, paneDead: () => false,
  })
  const delivered: string[] = []
  const logs: string[] = []
  const s = createScheduler({
    // No quiet window here: this file pins its SOURCE, and hands one thread several wakes within a few
    // clock minutes. The window and the merge are pinned in scheduler.test.ts.
    wakeQuietWindowMs: 0,
    storage,
    tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    log: (m) => { logs.push(m) },
  })
  const refold = () => { tailer.tick() }
  storage.setBackend(SLUG, "claude")
  storage.setClaudeRuntime(SLUG, "broker")
  refold()
  return {
    storage, tailer, s, delivered, logs, transcript, refold,
    tele: () => tailer.get(SLUG),
    finish: async () => { appendFileSync(transcript, retirementRecord(new Date().toISOString())); refold() },
    // The shell finishes and THEN the agent speaks again — i.e. it finished mid-turn, the runtime
    // delivered it, and the agent folded it into the turn it went on to end.
    finishThenSpeak: async () => {
      appendFileSync(transcript, retirementRecord(new Date().toISOString()))
      appendFileSync(transcript, parkRecord(new Date(Date.now() + 1000).toISOString()))
      refold()
    },
    close: () => { void s.stop(); tailer.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

// THE HEADLINE. No fence, no declaration, no registration — a worker that simply launched a shell and
// stopped is still told when it finishes, because that is the one case its runtime cannot cover.
test("a shell that finishes behind a RESTED agent wakes it, with no fence anywhere", async () => {
  const h = await harness()
  try {
    assert.equal(h.tele()?.lastFence, undefined, "precondition: a bare rest, nothing declared")
    await h.s.tick()
    assert.deepEqual(h.delivered, [], "still running — nothing to say")

    await h.finish()
    await h.s.tick()
    assert.equal(h.delivered.length, 1, "frizz tells it, because the runtime did not")
    assert.match(h.delivered[0], new RegExp(TASK_ID))
    assert.match(h.delivered[0], /after you came to rest/)

    // ONE wake per SHELL, ever: the delivery id is keyed on the shell's own launch id, so there is no
    // counter to reset and no way for this to repeat.
    await h.s.tick()
    assert.equal(h.delivered.length, 1)
  } finally { h.close() }
})

test("a park on a LIVE shell stays parked, then wakes on the shell's own retirement", async () => {
  const h = await harness(TASK_ID)
  try {
    // The fold saw all three things, off the real file.
    const parked = h.tele()
    assert.equal(parked?.bgShells.some((sh) => sh.taskId === TASK_ID && sh.state === "running"), true, "the shell folded as live")
    assert.equal(parked?.lastFence?.kind, "awaiting", "the fence folded")
    assert.deepEqual(parked?.lastFence?.hints, [{ kind: "shell", value: TASK_ID }], "…carrying the watch hint")

    await h.s.tick()
    assert.deepEqual(h.delivered, [], "the shell is still running — nothing to say")

    await h.finish()
    assert.equal(h.tele()?.bgShells.some((sh) => sh.taskId === TASK_ID), false, "the shell is gone from live")
    assert.equal(h.tele()?.retiredShells?.some((sh) => sh.taskId === TASK_ID), true, "…and onto the retirement ring")

    await h.s.tick()
    assert.equal(h.delivered.length, 1, "the retirement wakes the thread")
    assert.match(h.delivered[0], new RegExp(TASK_ID))
    assert.match(h.delivered[0], /finished/)

    // ONE wake per park, not one per tick. The outbox's delivery id is keyed on the fence identity, so
    // a thread that has not moved cannot be told twice.
    await h.s.tick()
    assert.equal(h.delivered.length, 1, "and only once")
  } finally { h.close() }
})

// A TYPO'D DECLARATION CHANGES NOTHING ABOUT THE WAKE, which is the clearest statement that the two are
// unrelated: the shell still finished, so the agent is still told. What the bad name costs is the PARK —
// the board refuses to believe a wait it cannot verify, and the thread queues (declared-park.test.ts).
test("a typo'd declaration does not suppress the wake — the fence is not the mechanism", async () => {
  const h = await harness("bzvtnt3ig-typo")
  try {
    await h.finish()
    await h.s.tick()
    assert.equal(h.delivered.length, 1, "the shell finished, so the agent hears about it either way")
  } finally { h.close() }
})

// A shell that finished BEFORE the agent's last word was reported to it by the runtime and folded into
// that turn. Waking again would tell it twice about something it already acted on — and this is the only
// thing separating the two cases, so it is the assertion that keeps the pass honest.
test("a shell that finished MID-TURN is never re-reported — the runtime already told it", async () => {
  const h = await harness()
  try {
    await h.finishThenSpeak()
    await h.s.tick()
    await h.s.tick()
    assert.deepEqual(h.delivered, [], "it finished before the agent's last word; the agent knew")
  } finally { h.close() }
})

// ---- THE pr-watch HALF, across the SAME seam --------------------------------------------------------
// The poller writes a reading into a setting and the board reads it back through a zod parse. That is a
// serialization boundary between two files that never call each other, and it fails SILENTLY by design
// (a malformed entry is dropped so one bad row cannot take a board's worth of status with it) — which
// is exactly the shape of seam that a pair of green unit tests on either side proves nothing about.
test("a poll publishes a reading the BOARD can actually read, and the queue rule acts on it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-prwatch-e2e-"))
  const at = new Date(Date.now() - 60_000).toISOString()
  const transcript = join(dir, `${SESSION}.jsonl`)
  writeFileSync(transcript, line({
    type: "assistant", timestamp: at, sessionId: SESSION, uuid: "p1",
    message: { role: "assistant", content: [{ type: "text", text: "PR is up.\n\n```awaiting\nprs: [acme/app#391]\nfor: 2h\n---\nWatching for review.\n```" }] },
  }))
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.setSetting("signoffNudge", "off")
  storage.upsertSession({
    slug: SLUG, session_id: SESSION, thread_name: `frizz-${SLUG}`, spawned_at: at,
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: at, title_auto: 1,
    title: SLUG, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage, bus: new Bus(), sessionLogDir: dir,
    onChange: () => {}, paneDead: () => false,
  })
  storage.setBackend(SLUG, "claude")
  storage.setClaudeRuntime(SLUG, "broker")
  // The WATCHER, registered the way a worker registers it — by tool call, through the same storage the
  // router writes. The fence's `pr-watch:` line declares the wait; this is what creates it.
  storage.armPrWatch({ id: "prw_1", slug: SLUG, owner: "acme", repo: "app", number: 391, createdAtMs: Date.parse(at), expiresAtMs: Date.parse(at) + 2 * 3600_000 })
  tailer.tick()
  const s = createScheduler({
    wakeQuietWindowMs: 0,
    storage,
    tailer,
    resume: async () => {},
    log: () => {},
    // The one thing stubbed, and only because it shells out to `gh`. Its RETURN is the real shape
    // `defaultFetchPr` builds from `gh pr view --json …`.
    fetchPr: async () => ({
      state: "OPEN",
      mergedAt: null,
      mergeable: "MERGEABLE",
      reviewDecision: "REVIEW_REQUIRED",
      rollup: [
        { status: "IN_PROGRESS", name: "test" },
        { status: "COMPLETED", conclusion: "SUCCESS", name: "build" },
      ],
      workflowRuns: [],
    }),
  })
  try {
    const tele = tailer.get(SLUG)
    assert.deepEqual(tele?.lastFence?.hints, [
      { kind: "pr", value: "acme/app#391" },
      { kind: "for", value: "2h" },
    ], "the fence folded off the real file")

    await s.tick()
    const book = readGithubStatusBook(storage.getSetting(GITHUB_STATUS_SETTING))
    const status = book["acme/app#391"]
    assert.ok(status, "the poll's reading survives the round trip through the setting")
    assert.equal(status.checks, "running")
    assert.deepEqual([status.running, status.passed, status.failed], [1, 1, 0])
    assert.equal(status.merge, "blocked", "MERGEABLE + REVIEW_REQUIRED is not a green light")

    const row = storage.getSession(SLUG)!
    // CI IS RUNNING → out of the queue, into the active rail. The card still states the wait.
    const registered = new Set(["acme/app#391"])
    assert.equal(deriveNeedsYou(row, tele, "turn-idle", false, Date.now(), undefined, true, false, book, registered), false)
    assert.equal(deriveAwaitingBackground(row, tele, "turn-idle", false, Date.now(), undefined, false, book, registered), true)
    // …and the row the card draws carries the same reading, off the same book.
    assert.deepEqual(fenceWatchViews(SLUG, tele, tele?.lastAssistantAt, book, [{ target: "acme/app#391", createdAt: at }])[0]?.github, status)

    // CHECKS DONE → straight back into the queue, with no new fence and no worker turn.
    const done = { "acme/app#391": { ...status, checks: "passing" as const, running: 0, passed: 2 } }
    assert.equal(deriveNeedsYou(row, tele, "turn-idle", false, Date.now(), undefined, true, false, done, registered), true)
    // AND AN UNREGISTERED DECLARATION IS NOT A WAIT. Same fence, same green-CI reading, no watcher: the
    // thread queues, because nothing will ever wake it.
    assert.equal(deriveNeedsYou(row, tele, "turn-idle", false, Date.now(), undefined, true, false, book, new Set()), true)
  } finally {
    void s.stop(); tailer.stop(); storage.close(); rmSync(dir, { recursive: true, force: true })
  }
})

// ---- THE REGISTERED PR WATCHER, over the real scheduler ---------------------------------------------
// Maintainer 2026-08-14: "We should have a fucking tool for this. The agent should have a tool to
// register a PR watcher… it should get notified when CI either succeeds or failed and on follow-up
// reviews and comments."
//
// The property that makes this unlike every other source here is that it reports REPEATEDLY: CI goes
// red, the worker pushes a fix, CI goes green, a reviewer comments — four wakes from ONE registration.
// So the assertions are about the SEQUENCE, and about what must NOT fire: a poll that finds the same
// state says nothing, and the first poll never reports the backlog it was registered on top of.
async function prHarness() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-prwatch-e2e-"))
  const at = new Date(Date.now() - 60_000).toISOString()
  const transcript = join(dir, `${SESSION}.jsonl`)
  writeFileSync(transcript, line({
    type: "assistant", timestamp: at, sessionId: SESSION, uuid: "p1",
    message: { role: "assistant", content: [{ type: "text", text: "PR is up." }] },
  }))
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.setSetting("signoffNudge", "off")
  storage.upsertSession({
    slug: SLUG, session_id: SESSION, thread_name: `frizz-${SLUG}`, spawned_at: at,
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: at, title_auto: 1,
    title: SLUG, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage, bus: new Bus(), sessionLogDir: dir,
    onChange: () => {}, paneDead: () => false,
  })
  storage.setBackend(SLUG, "claude")
  storage.setClaudeRuntime(SLUG, "broker")
  storage.armPrWatch({ id: "prw_1", slug: SLUG, owner: "acme", repo: "app", number: 391, createdAtMs: Date.parse(at), expiresAtMs: Date.parse(at) + 2 * 3600_000 })
  tailer.tick()
  // What GitHub currently says. Mutated between ticks to play the PR's life forward; the poll interval
  // is stepped past with an explicit clock so the test never sleeps.
  let rollup: Record<string, unknown>[] = [{ status: "IN_PROGRESS", name: "test" }]
  let prState = "OPEN"
  // The head commit the rollup describes. A push moves it, which is what makes a repeat verdict news.
  let head = "sha-aaa"
  let activity: { id: string; actor: string; kind: "review" | "comment"; at: string }[] = []
  // The PR's own state, beside its CI. `undefined` for labels/reviewers is the "this poll never read
  // them" case the baseline rule turns on, and it is the shape the `gh` fallback really serves.
  let mergeable = "MERGEABLE"
  let labels: string[] | undefined
  let reviewRequests: string[] | undefined
  // The head's check suites, where a workflow held for a maintainer's approval lives. It never reaches
  // the rollup, so a gated PR is invisible without this.
  let checkSuites: Record<string, unknown>[] = []
  let clock = Date.now()
  const delivered: string[] = []
  const s = createScheduler({
    wakeQuietWindowMs: 0,
    storage,
    tailer,
    resume: async (_slug, message) => { delivered.push(message) },
    log: () => {},
    now: () => clock,
    fetchPr: async () => ({ state: prState, mergedAt: null, mergeable, rollup, head, workflowRuns: [], checkSuites, labels, reviewRequests } as never),
    fetchGithubReview: async () => activity as never,
  })
  return {
    delivered, storage,
    setChecks: (next: Record<string, unknown>[]) => { rollup = next },
    setPrState: (next: string) => { prState = next },
    push: (sha: string) => { head = sha },
    setActivity: (next: typeof activity) => { activity = next },
    setMergeable: (next: string) => { mergeable = next },
    setLabels: (next: string[] | undefined) => { labels = next },
    setReviewRequests: (next: string[] | undefined) => { reviewRequests = next },
    setGated: (names: string[]) => { checkSuites = names.map((workflowName) => ({ status: "COMPLETED", conclusion: "ACTION_REQUIRED", workflowName })) },
    // Each tick steps past the per-PR poll floor, so every call really re-reads GitHub.
    tick: async () => { clock += 90_000; await s.tick() },
    /** Run the clock past the watcher's own `expiresAtMs` without eighty ticks to get there. */
    jump: (ms: number) => { clock += ms },
    close: () => { void s.stop(); tailer.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

// RED AGAIN ON A NEW COMMIT IS NEWS, and for a while it was the one thing a watcher could not say.
//
// The cursor held the bare verdict word, so the transition red→red did not exist: CI fails (reported),
// the worker pushes a fix, CI runs and fails AGAIN, and the watcher — which had already spent its only
// transition — said nothing. The worker then waited on a watcher that could no longer speak, which is
// precisely the dead wait this grammar exists to make impossible. Reported by the maintainer 2026-08-17
// against `investigate-nubjs-nub-728`, whose cursor read `{"checks":"failing","report":4}`.
// MULTIPLE SEQUENTIAL FAILURES, which is the whole requirement and not only the new-commit slice of it.
// A worker iterating on a red build produces failures that do NOT move the head: it re-runs the failed
// job, or a slower job goes red minutes after the first. Keyed on the verdict word (or even on the
// commit), every one of those after the first is silent — the worker is told once and then left waiting
// on a watcher that has nothing more it can say.
test("every distinct failure speaks: a re-run on the same commit, and a second job going red later", async () => {
  const h = await prHarness()
  try {
    // FAILURE 1 — one job red.
    h.setChecks([{ status: "COMPLETED", conclusion: "FAILURE", name: "lint", detailsUrl: "https://gh/runs/1/job/1" }])
    await h.tick()
    assert.equal(h.delivered.length, 1, "the first failure")
    h.delivered.length = 0

    // FAILURE 2 — the SAME job re-run on the SAME commit. A re-run is a new job id, so the URL moves even
    // though the head and the verdict word do not.
    h.setChecks([{ status: "COMPLETED", conclusion: "FAILURE", name: "lint", detailsUrl: "https://gh/runs/2/job/2" }])
    await h.tick()
    assert.equal(h.delivered.length, 1, "a re-run that fails again is a second failure, not the same one")
    assert.match(h.delivered[0], /CI FAILED/)
    h.delivered.length = 0

    // FAILURE 3 — a SLOWER job goes red on the same commit, alongside the first. The failing SET grew.
    h.setChecks([
      { status: "COMPLETED", conclusion: "FAILURE", name: "lint", detailsUrl: "https://gh/runs/2/job/2" },
      { status: "COMPLETED", conclusion: "FAILURE", name: "e2e", detailsUrl: "https://gh/runs/2/job/3" },
    ])
    await h.tick()
    assert.equal(h.delivered.length, 1, "a second job going red is news the worker has not heard")
    assert.match(h.delivered[0], /e2e/, "…and it names the job that just went red")
    h.delivered.length = 0

    // NOTHING CHANGED — still the same two jobs, same runs. The nag-loop guard must hold through all of
    // the above, or this fix trades a silent watcher for one that talks on every tick.
    await h.tick()
    await h.tick()
    assert.deepEqual(h.delivered, [], "an unchanged reading stays quiet, however many times it is polled")
  } finally { h.close() }
})

test("a SECOND CI failure on a new commit is reported, and a re-poll of the same commit is not", async () => {
  const h = await prHarness()
  try {
    h.setChecks([{ status: "COMPLETED", conclusion: "FAILURE", name: "lint" }])
    await h.tick()
    assert.equal(h.delivered.length, 1, "the first failure is reported")
    assert.match(h.delivered[0], /CI FAILED/)
    h.delivered.length = 0

    // Same commit, same red: still not news. The nag-loop guard must survive this fix.
    await h.tick()
    assert.deepEqual(h.delivered, [], "the same verdict on the same commit stays quiet")

    // THE WORKER PUSHES A FIX and CI goes red again — a different commit, the same colour.
    h.push("sha-bbb")
    h.setChecks([{ status: "COMPLETED", conclusion: "FAILURE", name: "lint" }])
    await h.tick()
    assert.equal(h.delivered.length, 1, "red again on a NEW commit is the most actionable news there is")
    assert.match(h.delivered[0], /CI FAILED/)
    h.delivered.length = 0

    // …and the new commit's verdict is now the baseline, so it does not repeat either.
    await h.tick()
    assert.deepEqual(h.delivered, [], "the new commit's verdict settles as the baseline")
  } finally { h.close() }
})

// THE MIGRATION, which every live watcher goes through exactly once. A cursor written before the commit
// stamp holds the bare word, which can never equal a stamp — so the first poll after the upgrade
// re-announces the current verdict and is correctly keyed from then on. This is the path the maintainer's
// own failing watcher takes, so it is pinned rather than assumed.
test("a watcher carrying a pre-stamp cursor re-announces once, then settles", async () => {
  const h = await prHarness()
  try {
    // Exactly the shape observed in the wild: `{"checks":"failing","report":4}`, no commit.
    h.storage.setPrWatchCursor("prw_1", JSON.stringify({ seen: [], checks: "failing", report: 4 }))
    h.setChecks([{ status: "COMPLETED", conclusion: "FAILURE", name: "lint" }])
    await h.tick()
    assert.equal(h.delivered.length, 1, "the legacy cursor cannot match a stamp, so the verdict is said once")
    assert.match(h.delivered[0], /CI FAILED/)
    h.delivered.length = 0

    // …and it is now stamped, so it does not repeat.
    await h.tick()
    assert.deepEqual(h.delivered, [], "the re-announcement happens once, not on every tick")
  } finally { h.close() }
})

test("a registered watcher reports CI, then review, then says nothing while nothing changes", async () => {
  const h = await prHarness()
  try {
    // THE FIRST POLL DOES NOT REPORT THE BACKLOG. A worker registers when it opens or pushes the PR, so
    // whatever is already sitting there is its own news; telling it would spend a turn. The baseline is
    // the REGISTRATION INSTANT rather than "everything present", which is the sharper rule — see below.
    h.setActivity([{ id: "c1", actor: "reviewer", kind: "comment", at: new Date(Date.now() - 120_000).toISOString() }])
    await h.tick()
    assert.deepEqual(h.delivered, [], "CI still running and the backlog predates the watcher — nothing to say")

    // …AND THAT IS WHY THE BASELINE IS THE REGISTRATION INSTANT AND NOT THE FIRST POLL. A comment that
    // lands in the up-to-60s between registering and the first poll is real, unread news, and a blanket
    // "the first poll is silent" rule would swallow it forever.
    h.setActivity([
      { id: "c1", actor: "reviewer", kind: "comment", at: new Date(Date.now() - 120_000).toISOString() },
      { id: "c0", actor: "carol", kind: "comment", at: new Date().toISOString() },
    ])
    await h.tick()
    assert.equal(h.delivered.length, 1, "the comment that landed after registration is reported")
    assert.match(h.delivered[0], /@carol/)
    assert.doesNotMatch(h.delivered[0], /@reviewer/, "…and the backlog it was registered on top of is not")
    h.delivered.length = 0

    // CI GOES RED.
    h.setChecks([{ status: "COMPLETED", conclusion: "FAILURE", name: "lint" }])
    await h.tick()
    assert.equal(h.delivered.length, 1)
    assert.match(h.delivered[0], /CI FAILED/)
    assert.match(h.delivered[0], /lint/)
    assert.match(h.delivered[0], /STILL ARMED/, "the worker must not think this watcher is spent")

    // THE SAME RED CI ON THE NEXT POLL IS NOT NEWS. Without this the watcher is a nag loop with an API
    // bill — it would re-announce its own last message on every tick, forever.
    await h.tick()
    assert.equal(h.delivered.length, 1, "nothing changed, so nothing is said")

    // CI GOES GREEN — the same watcher, a second report, no re-registration in between.
    h.setChecks([{ status: "COMPLETED", conclusion: "SUCCESS", name: "lint" }])
    await h.tick()
    assert.equal(h.delivered.length, 2)
    assert.match(h.delivered[1], /CI PASSED/)

    // A FOLLOW-UP REVIEW — a third report from the same registration, and only the NEW item.
    h.setActivity([
      { id: "c1", actor: "reviewer", kind: "comment", at: new Date(Date.now() - 120_000).toISOString() },
      { id: "c0", actor: "carol", kind: "comment", at: new Date().toISOString() },
      { id: "c2", actor: "reviewer", kind: "review", at: new Date().toISOString() },
    ])
    await h.tick()
    assert.equal(h.delivered.length, 3)
    assert.match(h.delivered[2], /reviewer/)
    assert.doesNotMatch(h.delivered[2], /CI (PASSED|FAILED)/, "CI did not move; only the review did")
  } finally { h.close() }
})

// A MERGED PR ENDS THE WATCH. There is nothing further to report, and an armed row on a finished PR is a
// poll that can never produce another wake — so it reports once and settles itself.
test("a merged PR reports once and settles the watcher", async () => {
  const h = await prHarness()
  try {
    await h.tick()
    assert.equal(h.storage.getPrWatch("prw_1")?.state, "armed", "precondition: still watching")

    h.setPrState("MERGED")
    await h.tick()
    assert.equal(h.delivered.length, 1)
    assert.match(h.delivered[0], /was MERGED/)
    assert.match(h.delivered[0], /spent/, "and it says so, so the worker does not sit waiting for more")
    assert.equal(h.storage.getPrWatch("prw_1")?.state, "settled")

    // SETTLED IS TERMINAL. A settled row is not polled again, so a merged PR cannot keep costing GitHub
    // calls or produce a second announcement.
    await h.tick()
    assert.equal(h.delivered.length, 1)
  } finally { h.close() }
})

// A WATCHER'S EXPIRY HAS TO REACH THE WORKER, and it is the one report that cannot be retried: the row
// is settled on the way out, so a lost expiry leaves a thread parked forever on a wait nothing will
// ever answer — the exact unbounded stall this grammar was built to end.
//
// It was lost. The report is minted under its own `prwatch-expired:` prefix, and the predicate that
// routes a watcher delivery tested `startsWith("prwatch:")` — which that spelling does not satisfy. So
// it fell to the awaiting-fence tail of deliveryContext() and was superseded at zero attempts, 7 for 7
// on the maintainer's live board (2026-08-18). Same class as the park correction below it: a fallthrough
// that supersedes means a new prefix without a branch is silently undeliverable.
test("a watcher that runs out of time tells its worker so", async () => {
  const h = await prHarness()
  try {
    await h.tick()
    h.delivered.length = 0
    h.jump(3 * 3600_000) // past the two-hour registration
    await h.tick()
    assert.equal(h.delivered.length, 1, "an expiry nobody receives is a thread waiting on nothing")
    assert.match(h.delivered[0], /acme\/app#391 has expired/)
    assert.match(h.delivered[0], /mcp__frizz__watch_pr/, "…and how to re-register it")
    // Settled on the way out, so it cannot fire twice or be polled again.
    await h.tick()
    assert.equal(h.delivered.length, 1, "one expiry, one report")
  } finally { h.close() }
})

// ---- THE STALL THAT SURFACED BOTH BUGS, REPLAYED THROUGH THE REAL FOLD ---------------------------
// The maintainer's own thread, 2026-08-18: a worker signed off with `timer: none` — the WORD, not a
// registered row — plus `for: 15m`. Frizz refused the park (correctly: nothing named there can wake
// anything), queued the correction (correctly), and then dropped it on the floor. The thread sat in the
// queue for three hours with nothing able to reach it, and the maintainer asked why.
//
// Every other test for SOURCE 12 uses a stubbed tailer, so this one uses the real fold: the fence has to
// come off a real transcript file, in the shape a real worker writes, and the correction has to arrive.
function stalledParkRecord(at: string): string {
  return line({
    type: "assistant", timestamp: at, sessionId: SESSION, uuid: "s1",
    message: {
      role: "assistant",
      content: [{
        type: "text",
        text: [
          "The silent-fallback class is closed on all three platforms, and both VMs are stopped.",
          "",
          "```awaiting",
          "timers: [none]",
          "for: 15m",
          "---",
          "Nothing is running; I'm holding briefly before picking up the age-gate question.",
          "```",
        ].join("\n"),
      }],
    },
  })
}

test("a fence naming a timer that was never registered is corrected, off a real transcript", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-stall-e2e-"))
  const at = new Date(Date.now() - 60_000).toISOString()
  writeFileSync(join(dir, `${SESSION}.jsonl`), stalledParkRecord(at))
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.setSetting("signoffNudge", "off")
  storage.upsertSession({
    slug: SLUG, session_id: SESSION, thread_name: `frizz-${SLUG}`, spawned_at: at,
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: at, title_auto: 1,
    title: SLUG, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage, bus: new Bus(), sessionLogDir: dir,
    onChange: () => {}, paneDead: () => false,
  })
  const delivered: string[] = []
  const s = createScheduler({ wakeQuietWindowMs: 0, storage, tailer, resume: async (_slug, m) => { delivered.push(m) }, log: () => {} })
  storage.setBackend(SLUG, "claude")
  storage.setClaudeRuntime(SLUG, "broker")
  tailer.tick()
  try {
    // The fold first — the correction is worthless if the fence never parsed.
    assert.deepEqual(tailer.get(SLUG)?.lastFence?.hints, [
      { kind: "timer", value: "none" },
      { kind: "for", value: "15m" },
    ], "the real fold reads the fence the worker actually wrote")

    await s.tick()
    assert.equal(delivered.length, 1, "three hours of silence is the bug; one correction is the fix")
    assert.match(delivered[0], /`timers: \[none\]` — NOT RUNNING/, "and it says WHICH line is wrong, in the key the worker must write")
    assert.match(delivered[0], /nothing that could wake you/, "…and that a wait on nothing is not a wait")
  } finally { void s.stop(); tailer.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) }
})

// ---- THE PR ITSELF, not its CI (2026-09-04) -------------------------------------------------------
//
// The watcher reported reviews, comments and the check rollup, and was blind to everything else — so a
// PR that developed a merge conflict, gained a `blocked` label or had a reviewer requested said nothing
// until something else happened to it. `mergeable` was computed on every single poll and then never read
// as a trigger at all.
//
// THE BASELINE RULE IS THE HALF THAT MATTERS. A PR's existing labels are not news: the worker put most
// of them there, and announcing the state of the world on first sight would spend a turn re-telling it
// what it already did. So the first poll RECORDS and says nothing, exactly as the review baseline does.
test("a PR's existing state is recorded on the first poll, never announced", async () => {
  const h = await prHarness()
  try {
    h.setLabels(["c++", "needs-ci"])
    h.setReviewRequests(["richardlau"])
    h.setMergeable("CONFLICTING")
    await h.tick()
    assert.deepEqual(h.delivered, [], "everything already on the PR at registration is the worker's own news")

    // …and now it is a baseline, so the next MOVE speaks.
    h.setLabels(["c++", "needs-ci", "blocked"])
    await h.tick()
    assert.equal(h.delivered.length, 1)
    assert.match(h.delivered[0], /🔔 acme\/app#391: labels \+blocked\./)
  } finally { h.close() }
})

test("a conflict, a label moving and a reviewer requested each wake the worker, and together they are one line", async () => {
  const h = await prHarness()
  try {
    h.setLabels(["needs-ci"])
    h.setReviewRequests([])
    await h.tick() // baseline
    h.delivered.length = 0

    // A CONFLICT APPEARING is work the worker has to do, and it was silent until now.
    h.setMergeable("CONFLICTING")
    await h.tick()
    assert.equal(h.delivered.length, 1)
    assert.match(h.delivered[0], /now CONFLICTS with the base branch/)
    h.delivered.length = 0

    // …and it does not repeat. A conflict that is still there is not a second conflict. (Asserted on
    // LENGTH, not against a literal `[]`: node:assert/strict narrows the subject to the expected type,
    // and `never[]` would make every later read of this array a type error.)
    await h.tick()
    assert.equal(h.delivered.length, 0, "an unchanged reading stays quiet")

    // ONE POLL, THREE FACTS, ONE LINE. A label edit must not get the weight of a headline.
    h.setLabels(["blocked"])
    h.setReviewRequests(["richardlau"])
    await h.tick()
    assert.equal(h.delivered.length, 1)
    const stateLines = h.delivered[0].split("\n").filter((l: string) => l.startsWith("🔔"))
    assert.equal(stateLines.length, 1, "the clauses share one line")
    assert.match(stateLines[0], /labels \+blocked, −needs-ci; review requested from richardlau/)
    // The conflict is NOT restated: it was reported when it appeared and has not changed since.
    assert.ok(!stateLines[0].includes("CONFLICTS"))
  } finally { h.close() }
})

// A poll that cannot read a field must not overwrite what the last one knew. The `gh` fallback fetches
// no labels, so a fallback poll between two real ones would otherwise reset the baseline to "unknown"
// and make the poll after it announce every label on the PR as newly added.
test("a poll that never read the labels leaves the baseline alone", async () => {
  const h = await prHarness()
  try {
    h.setLabels(["needs-ci"])
    await h.tick() // baseline
    h.delivered.length = 0

    h.setLabels(undefined) // this poll did not ask
    await h.tick()
    assert.equal(h.delivered.length, 0)

    h.setLabels(["needs-ci"]) // …and the same labels are still not news
    await h.tick()
    assert.deepEqual(h.delivered, [], "an unread poll must not turn the next one into a false announcement")
  } finally { h.close() }
})

// ---- CI HELD FOR AN APPROVAL ----------------------------------------------------------------------
// The regression that started all of this, driven end to end: nodejs/node#65795's whole matrix sat at
// GitHub's fork-approval gate while the rollup carried nothing but label bots, and the watcher's first
// word was "✅ CI PASSED — 15 checks green".
test("workflows held for approval are reported as held, and never as a pass", async () => {
  const h = await prHarness()
  try {
    // The rollup as it really was: three real bot successes and a pile of skips. Nothing built anything.
    h.setChecks([
      { status: "COMPLETED", conclusion: "SUCCESS", name: "label" },
      { status: "COMPLETED", conclusion: "SUCCESS", name: "Resolve contributor status" },
      { status: "COMPLETED", conclusion: "SKIPPED", name: "notable-change" },
      { status: "COMPLETED", conclusion: "SKIPPED", name: "fast-track" },
    ])
    h.setGated(["Test Linux", "Test macOS", "Linters"])
    await h.tick()
    assert.equal(h.delivered.length, 1)
    assert.match(h.delivered[0], /⏸️ CI on acme\/app#391 is WAITING FOR APPROVAL — 3 workflows held: Test Linux, Test macOS, Linters\./)
    assert.ok(!h.delivered[0].includes("CI PASSED"), "nothing here is a pass")
    // It says what the worker must DO, because waiting is the one thing that cannot resolve this.
    assert.match(h.delivered[0], /ask for the approval rather than waiting on it/)
    h.delivered.length = 0

    // Still gated: not a second event.
    await h.tick()
    assert.equal(h.delivered.length, 0, "a gate that is still shut is not news again")

    // APPROVED, and the real matrix runs: no verdict yet, so still nothing to say.
    h.setGated([])
    h.setChecks([{ status: "IN_PROGRESS", name: "test-linux" }])
    await h.tick()
    assert.equal(h.delivered.length, 0, "CI merely starting is not a verdict")

    // …and now it genuinely passes, with the skips counted apart from the greens.
    h.setChecks([
      { status: "COMPLETED", conclusion: "SUCCESS", name: "test-linux" },
      { status: "COMPLETED", conclusion: "SKIPPED", name: "fast-track" },
    ])
    await h.tick()
    assert.equal(h.delivered.length, 1)
    assert.match(h.delivered[0], /✅ CI PASSED on acme\/app#391 — 1 check green, 1 skipped\./)
  } finally { h.close() }
})

// ---- THE POLL SPAWNS A BOUNDED NUMBER OF CHILDREN --------------------------------------------------
// Reported 2026-09-04 off a fork-rate alarm on the maintainer's machine: the sweep fans out over every
// armed watcher at once, and each ref then shelled out to `gh` twice (`gh pr view` + `gh run list`), so
// one poll launched 2N subprocesses in the same tick, every 60s, for as long as the watchers were armed.
//
// The fan-out itself is NOT the defect and must stay unbounded — the GraphQL half coalesces the whole
// tick into batches of 20, so capping the fan-out would only split one request into several. What has to
// be bounded is the `gh` FALLBACK, and the reason it matters is that the batch fails as a unit: an
// expired token or a network blip sends every ref down the fallback in the same tick at once.
async function fanoutHarness(prCount: number, review: () => Promise<unknown>) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-prwatch-fanout-"))
  const at = new Date(Date.now() - 60_000).toISOString()
  writeFileSync(join(dir, `${SESSION}.jsonl`), line({
    type: "assistant", timestamp: at, sessionId: SESSION, uuid: "p1",
    message: { role: "assistant", content: [{ type: "text", text: "PRs are up." }] },
  }))
  const storage = createStorage(join(dir, "ui.db"), "p")
  storage.setSetting("signoffNudge", "off")
  storage.upsertSession({
    slug: SLUG, session_id: SESSION, thread_name: `frizz-${SLUG}`, spawned_at: at,
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: at, title_auto: 1,
    title: SLUG, state: "open", meta: null, seen_at: null, transcript_id: null,
  } as SessionRow)
  const tailer = createTailer({
    project: { cwdSlug: "x" } as Project,
    storage, bus: new Bus(), sessionLogDir: dir,
    onChange: () => {}, paneDead: () => false,
  })
  storage.setBackend(SLUG, "claude")
  storage.setClaudeRuntime(SLUG, "broker")
  for (let i = 0; i < prCount; i++) {
    storage.armPrWatch({
      id: `prw_${i}`, slug: SLUG, owner: "acme", repo: "app", number: 400 + i,
      createdAtMs: Date.parse(at), expiresAtMs: Date.parse(at) + 2 * 3600_000,
    })
  }
  tailer.tick()
  let clock = Date.now()
  // What the `gh` fallback would cost, counted the way the alarm counted it: how many are in flight at
  // the same instant, not how many ran. Each call yields to the event loop, so real overlap is visible.
  let inFlight = 0
  let peak = 0
  let calls = 0
  const s = createScheduler({
    wakeQuietWindowMs: 0,
    storage,
    tailer,
    resume: async () => {},
    log: () => {},
    now: () => clock,
    fetchPr: async () => {
      calls++
      inFlight++
      peak = Math.max(peak, inFlight)
      try {
        await new Promise((r) => setTimeout(r, 1))
        return { state: "OPEN", mergedAt: null, rollup: [], head: "sha-aaa", workflowRuns: [] } as never
      } finally { inFlight-- }
    },
    fetchGithubReview: review as never,
  })
  return {
    stats: () => ({ calls, peak }),
    tick: async () => { clock += 90_000; await s.tick() },
    close: () => { void s.stop(); tailer.stop(); storage.close(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test("a GraphQL failure across the whole batch does not become 2N `gh` children in one tick", async () => {
  const h = await fanoutHarness(12, async () => ({
    status: "error", failure: { kind: "network", message: "GitHub GraphQL request failed" },
  }))
  try {
    await h.tick()
    const { calls, peak } = h.stats()
    assert.equal(calls, 12, "every armed PR still gets its status read — the bound is a queue, not a drop")
    assert.ok(peak <= 4, `at most 4 fallback fetches in flight at once, saw ${peak}`)
    assert.equal(peak, 4, "…and the bound is actually reached, so the assertion above is not vacuous")
  } finally { h.close() }
})

test("a poll the rate-limit guard deferred spends nothing — no HTTP, and no `gh` behind its back", async () => {
  const h = await fanoutHarness(12, async () => ({ status: "deferred" }))
  try {
    await h.tick()
    assert.equal(h.stats().calls, 0, "a defer means do not spend on GitHub this tick, by any transport")
  } finally { h.close() }
})

test("the ordinary poll shells out to nothing at all: the status rides the batched query", async () => {
  const h = await fanoutHarness(12, async () => ({
    status: "ok",
    activity: [],
    pr: { state: "OPEN", mergedAt: null, rollup: [], head: "sha-aaa", checkSuites: [], labels: [], reviewRequests: [] },
  }))
  try {
    await h.tick()
    assert.equal(h.stats().calls, 0, "the fallback is for a shape surprise, not for the happy path")
  } finally { h.close() }
})
