import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { wakeDeliveryToken, type QuotaSnapshot } from "@frizz/shared"
import { createStorage, type Storage, type SessionRow } from "./storage.ts"
import { ANSWER_REOFFER_BACKOFF_MS, createScheduler, enqueueInterruptEndedWake, parsePrRef, ghPrViewArgs, evalRollup, parseGithubReviewActivities, isBotGithubActor, MID_TURN_HOLD_MAX_MS, type GithubReviewActivity, type PrRef, type PrStatus } from "./scheduler.ts"
import { createGithubReviewFetcher, type GithubReviewFetchResult } from "./github-review.ts"
import { createWakeDeliveryStore, WAKE_QUIET_WINDOW_MS } from "./wake-store.ts"
import { applyRecord, newTailState, type Tailer, type SessionTelemetry, type FenceView, type TurnState, type BgShellView } from "./tailer.ts"

// ---- pure helpers ----

test("parsePrRef: owner/repo#N, PR URLs, .git strip; garbage → undefined", () => {
  assert.deepEqual(parsePrRef("acme/app#391"), { owner: "acme", repo: "app", number: 391 })
  assert.deepEqual(parsePrRef("  acme/app#391  "), { owner: "acme", repo: "app", number: 391 })
  assert.deepEqual(parsePrRef("https://github.com/acme/app/pull/391"), { owner: "acme", repo: "app", number: 391 })
  assert.deepEqual(parsePrRef("acme/app.git#12"), { owner: "acme", repo: "app", number: 12 })
  assert.equal(parsePrRef("not a ref"), undefined)
  assert.equal(parsePrRef("acme/app#0"), undefined)
  // an actions-run URL carries no PR number → not a PR ref
  assert.equal(parsePrRef("https://github.com/acme/app/actions/runs/12345"), undefined)
})

test("ghPrViewArgs uses numeric selector + explicit normalized repo (never owner/repo#N)", () => {
  const ref = parsePrRef("acme/app.git#12")
  assert.ok(ref)
  assert.deepEqual(ghPrViewArgs(ref), [
    "pr",
    "view",
    "12",
    "--repo",
    "acme/app",
    "--json",
    // `mergeable,reviewDecision` joined on 2026-08-14: the same one fetch now also feeds the board's
    // watched-PR rows and the queue rule that keeps a thread out of the queue while CI runs.
    "state,mergedAt,statusCheckRollup,headRefOid,mergeable,reviewDecision",
  ])
})

test("GitHub review GraphQL normalization preserves actor type + review state", () => {
  const got = parseGithubReviewActivities({
    data: { repository: { pullRequest: {
      reviews: { nodes: [{ id: "R1", state: "APPROVED", submittedAt: "2026-07-09T12:01:00Z", author: { login: "alice", __typename: "User" } }] },
      comments: { nodes: [{ id: "C1", createdAt: "2026-07-09T12:02:00Z", author: { login: "dependabot[bot]", __typename: "Bot" } }] },
    } } },
  })
  assert.deepEqual(got.map((a) => [a.id, a.actor, a.actorType, a.kind, a.reviewState]), [
    ["review:R1", "alice", "User", "review", "APPROVED"],
    ["comment:C1", "dependabot[bot]", "Bot", "comment", undefined], // comments carry no review state
  ])
})

// The actor is presentation only — it picks the steer's 🤖/👤 icon and never gates a wake.
test("bot actors are recognized by __typename or a [bot] login suffix", () => {
  const mk = (over: Partial<GithubReviewActivity>): GithubReviewActivity => ({ id: "x", actor: "a", kind: "review", ...over })
  assert.equal(isBotGithubActor(mk({ actor: "pullfrog", actorType: "Bot" })), true)
  assert.equal(isBotGithubActor(mk({ actor: "dependabot[bot]" })), true)
  assert.equal(isBotGithubActor(mk({ actor: "alice", actorType: "User" })), false)
  assert.equal(isBotGithubActor(mk({ actor: "alice" })), false)
})

test("evalRollup: empty → pending; all-complete → done; in-progress → pending; failure → done+failed", () => {
  assert.deepEqual(evalRollup([]), { done: false, ok: false })
  assert.deepEqual(evalRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "SKIPPED" }]), { done: true, ok: true })
  // pending (not yet done): `ok` just means "no failure seen yet" — only consulted once done.
  assert.deepEqual(evalRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "IN_PROGRESS" }]), { done: false, ok: true })
  assert.deepEqual(evalRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "FAILURE" }]), { done: true, ok: false })
  // StatusContext shape (legacy): state PENDING → pending; state FAILURE → failed
  assert.deepEqual(evalRollup([{ state: "SUCCESS" }, { state: "PENDING" }]), { done: false, ok: true })
  assert.deepEqual(evalRollup([{ state: "SUCCESS" }, { state: "FAILURE" }]), { done: true, ok: false })
  // SHAPE SURPRISE: an entry we can't classify (no recognizable status/state) must read as PENDING,
  // never as done+green — else a `ci:` wait could false-fire "green" on a malformed rollup.
  assert.deepEqual(evalRollup([{}]), { done: false, ok: true })
  assert.deepEqual(evalRollup([{ status: "COMPLETED", conclusion: "SUCCESS" }, {}]), { done: false, ok: true })
})

// ---- scheduler harness ----

function tmpStorage(): Storage {
  return createStorage(join(mkdtempSync(join(tmpdir(), "frizz-sched-")), "ui.db"), "p")
}

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug,
    session_id: `sid-${slug}`,
    thread_name: `frizz-${slug}`,
    spawned_at: "2026-07-01T00:00:00.000Z",
    last_read_at: null,
    unread: 0,
    exited: 0,
    archived: 0,
    rested_at: null,
    title_auto: 0,
    title: slug,
    state: "open",
    meta: null,
    seen_at: null,
    transcript_id: null,
    ...over,
  }
}

function awaiting(hints: FenceView["hints"], body = ""): FenceView {
  return { kind: "awaiting", body, hints }
}
function tele(fence?: FenceView, turn: TurnState = "idle"): SessionTelemetry {
  return { turn, permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastFence: fence }
}

function fakeTailer(map: Map<string, SessionTelemetry>): Tailer {
  return {
    get: (slug: string) => map.get(slug),
    foreignIds: () => [],
    subAgent: () => undefined,
    forget: () => {},
    start: () => {},
    stop: () => {},
    tick: () => {},
  }
}

interface Harness {
  storage: Storage
  /** Register a PR watcher the way `mcp__frizz__watch_pr` does. A `pr-watch:` fence line DECLARES a wait
   *  and no longer arms anything (2026-08-14), so every test below that expects a wake registers first. */
  watch(slug: string, ref: string, kind?: "pull" | "issue"): void
  tele: Map<string, SessionTelemetry>
  resumes: { slug: string; message: string; deliveryId?: string }[]
  clock: { ms: number }
  pr: { result: PrStatus | undefined; calls: PrRef[] }
  review: { result: GithubReviewActivity[] | GithubReviewFetchResult | undefined; calls: (PrRef & { kind?: string })[] }
  make(over?: Partial<Parameters<typeof createScheduler>[0]>): ReturnType<typeof createScheduler>
}

function harness(): Harness {
  const storage = tmpStorage()
  const teleMap = new Map<string, SessionTelemetry>()
  const resumes: { slug: string; message: string; deliveryId?: string }[] = []
  const clock = { ms: Date.parse("2026-07-09T12:00:00.000Z") }
  const pr: { result: PrStatus | undefined; calls: PrRef[] } = { result: undefined, calls: [] }
  // `result` may be a full fetch result (with an `issue` or `pr` half) or the bare activity list the
  // older cases hand back — the scheduler normalizes either.
  const review: { result: GithubReviewActivity[] | GithubReviewFetchResult | undefined; calls: (PrRef & { kind?: string })[] } = { result: undefined, calls: [] }
  let watchSeq = 0
  return {
    storage,
    tele: teleMap,
    resumes,
    clock,
    pr,
    review,
    watch(slug, ref, kind = "pull") {
      const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(ref)
      if (!m) throw new Error(`bad ref ${ref}`)
      storage.armPrWatch({
        id: `${kind === "issue" ? "isw" : "prw"}_${++watchSeq}`, slug, kind, owner: m[1], repo: m[2], number: Number(m[3]), createdAtMs: clock.ms - 60_000,
        // Far out: these cases are about ACTIVITY, not the expiry sweep, which would otherwise settle
        // the watcher out from under them.
        expiresAtMs: clock.ms + 24 * 3600_000,
      })
    },
    make(over) {
      return createScheduler({
        storage,
        tailer: fakeTailer(teleMap),
        resume: (slug, message, deliveryId) => void resumes.push({ slug, message, deliveryId }),
        now: () => clock.ms,
        fetchPr: async (ref) => {
          pr.calls.push(ref)
          return pr.result
        },
        fetchGithubReview: async (ref) => {
          review.calls.push(ref)
          return review.result
        },
        log: () => {},
        // NO QUIET WINDOW BY DEFAULT: the cases below pin what each SOURCE does, and most of them hand two
        // or three wakes to one thread inside a few clock minutes. The window and the merge have their
        // own cases, which set this explicitly — and one of them pins that production takes the constant.
        wakeQuietWindowMs: 0,
        ...over,
      })
    },
  }
}

const iso = (ms: number) => new Date(ms).toISOString()

// ARM A REAL TIMER ROW. The `timer: <ISO instant>` fence these tests used to arm from is deleted
// (2026-08-15) — a worker computed that instant, and one wrote it 5h55m in the past, which parsed,
// armed nothing and stalled its thread for 5.5 hours. `mcp__frizz__timer` creates the row; the
// scheduler fires it (SOURCE: evalTimers) through the same outbox path the fence used to feed.
let timerSeq = 0
function armTimer(h: Harness, slug: string, fireAtMs: number, prompt = "Re-poll the rollout."): string {
  const id = `tmr_${slug}_${++timerSeq}`
  h.storage.armThreadTimer({ id, slug, prompt, fireAtMs, createdAtMs: h.clock.ms })
  return id
}

// ---- THE SAFETY GUARD: a fence DECLARES a wait, it never ARMS one ----
//
// Every wait the waker can fire is a REGISTRATION — a `thread_timer` row, a `pr_watch` row, a live
// background shell. A fence only NAMES one, so a thread writing the most fireable-looking lines in the
// grammar and registering nothing must be woken by none of them. The limb that polled those hints was
// hardwired off by the 2026-08-15 grammar cut and deleted on 2026-08-24; this is the test that fails if
// any of it comes back.
//
// It is also the boot no-mass-resume guard, which is why it is worth three threads and a GitHub
// assertion rather than one: the maintainer has ~14 real sessions and most of them are sitting on an
// old fence, so a waker that acted on fence text would resume all of them at once on the next start.
test("a fence arms NOTHING: an elapsed instant, a merged PR and a dead shell never wake a thread", async () => {
  const h = harness()
  for (const slug of ["past", "merged", "shell"]) h.storage.upsertSession(row(slug))
  h.tele.set("past", tele(awaiting([{ kind: "timer", value: iso(h.clock.ms - 6 * 3600_000) }])))
  h.tele.set("merged", tele(awaiting([{ kind: "pr", value: "acme/app#391" }])))
  h.tele.set("shell", tele(awaiting([{ kind: "shell", value: "a-shell-that-is-not-running" }])))
  h.pr.result = { state: "MERGED", mergedAt: "2026-07-01T00:00:00Z", rollup: [] }
  const s = h.make()
  await s.tick()
  h.clock.ms += 60_000
  await s.tick()
  await s.tick()
  assert.deepEqual(h.resumes, [], "a wait nobody registered must never resume, however it is worded")
  assert.deepEqual(h.pr.calls, [], "and no fence line is worth a GitHub poll")
})

// ---- REGISTERED WATCHES: the expiry sweep and the finish sweep (2026-08-26) ----
//
// `mcp__frizz__watch` turns a wait from a line the worker restates at every rest into a row it creates
// once (plans/rest-by-registration.md). Two settle conditions, and only ONE of them is news:
//
//   • EXPIRED → settled, and the worker TOLD. The expiry is the whole mechanism that stops a
//     registration outliving its own relevance: the worker chose a duration once and is put back in
//     front of that decision when it runs out. A wait that vanishes in silence is the same stall in a
//     new costume — the worker would rest believing it is covered.
//   • THE TARGET ENDED → settled SILENTLY. That is the wait completing, which is exactly what the
//     worker asked to be woken for, and evalShellCompletions already delivers that wake off the retired
//     shell itself. A second one here would be two notifications for one fact.

const liveShell = (over: Partial<BgShellView> = {}): BgShellView => ({
  label: "nub --test", startedAt: "2026-07-09T11:59:00.000Z", state: "running", id: "toolu_sh", taskId: "bzvtnt3ig", ...over,
})

function armWatch(h: Harness, slug: string, over: { id?: string; kind?: "shell" | "agent"; target?: string; expiresAtMs?: number } = {}) {
  const id = over.id ?? "wch_1"
  h.storage.armThreadWatch({
    id, slug, kind: over.kind ?? "shell", target: over.target ?? "bzvtnt3ig",
    createdAtMs: h.clock.ms, expiresAtMs: over.expiresAtMs ?? h.clock.ms + 2 * 3600_000,
  })
  return id
}

test("watch: an expired row is settled AND the worker is told, once", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  const id = armWatch(h, "t", { expiresAtMs: h.clock.ms + 30_000 })
  h.tele.set("t", { ...tele(), bgShells: [liveShell()] })
  const s = h.make()
  await s.tick() // not due yet
  assert.equal(h.resumes.length, 0)
  assert.equal(h.storage.getThreadWatch(id)?.state, "armed")
  h.clock.ms += 60_000
  await s.tick()
  await s.tick() // the row is settled → must not fire twice
  assert.equal(h.resumes.length, 1)
  assert.equal(h.storage.getThreadWatch(id)?.state, "expired")
  assert.match(h.resumes[0].message, /Your watch on the background shell `bzvtnt3ig` has expired/)
  // The re-registration instruction is the point of telling it at all: the worker re-decides rather
  // than silently losing a wait it still holds.
  assert.match(h.resumes[0].message, /register it again with `frizzctl watch` and a fresh `--for`/)
})

test("watch: a row whose shell has finished is settled SILENTLY", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  const id = armWatch(h, "t")
  h.tele.set("t", { ...tele(), bgShells: [liveShell()] })
  const s = h.make()
  await s.tick()
  assert.equal(h.storage.getThreadWatch(id)?.state, "armed", "a live shell keeps its row armed")
  // The shell ends. evalShellCompletions owns the wake for that fact; this pass only clears the row.
  h.tele.set("t", tele())
  await s.tick()
  assert.equal(h.storage.getThreadWatch(id)?.state, "settled")
  assert.deepEqual(h.resumes, [], "the finish is not this pass's news to deliver")
})

test("watch: NO TELEMETRY is not `not live` — a healthy row survives a thread frizz cannot read", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  const id = armWatch(h, "t")
  // No entry in the telemetry map at all. Settling on that reading would cancel a healthy wait, which
  // is the same rule probeShellAlive takes: an undefined verdict is never treated as dead.
  const s = h.make()
  await s.tick()
  assert.equal(h.storage.getThreadWatch(id)?.state, "armed")
})

test("watch: an archived thread's row still settles, and wakes nobody", async () => {
  const h = harness()
  h.storage.upsertSession(row("t", { state: "archived", archived: 1 }))
  const id = armWatch(h, "t", { expiresAtMs: h.clock.ms - 1 })
  h.tele.set("t", { ...tele(), bgShells: [liveShell()] })
  const s = h.make()
  await s.tick()
  assert.equal(h.storage.getThreadWatch(id)?.state, "expired")
  assert.deepEqual(h.resumes, [])
})

// ---- REGISTERED QUESTIONS: handing the human's answer over (2026-08-26) ----
//
// Answering and DELIVERING are separate acts. The human answers on the board; this pass is what puts it
// in front of the worker, and the gap between them is the whole reason the row exists — an answer given
// while the worker's process was down has to survive it, or it is lost in exactly the silence the fenced
// question used to lose the QUESTION in.
function askQ(h: Harness, slug: string, id: string, question: string) {
  h.storage.askThreadQuestion({ id, slug, spec: JSON.stringify({ question, kind: "question", options: [{ label: "A" }] }), askedAtMs: h.clock.ms })
  return id
}

test("question: an answer is handed over once, and the row is not re-delivered", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  askQ(h, "t", "qst_1", "SQLite or a JSON file?")
  h.tele.set("t", tele())
  const s = h.make()
  await s.tick()
  assert.equal(h.resumes.length, 0, "an UNANSWERED question wakes nobody — it is the human's move")

  h.storage.answerThreadQuestion("qst_1", JSON.stringify({ questionId: "qst_1", question: "SQLite or a JSON file?", chosen: ["SQLite"] }), h.clock.ms)
  await s.tick()
  await s.tick() // the row is delivered → must not go round again
  assert.equal(h.resumes.length, 1)
  // THE WIRE FORM IS THE ATTRIBUTION. This lands as a frizz WAKE, and a wake renders as frizz's own
  // notification card unless the text is in the form the chat reads as the human's Answers card — which
  // it checks first. Getting it wrong does not fail; the answer just stops being the human's words on
  // screen (the 2026-08-27 regression).
  assert.match(h.resumes[0].message, /^Answers to earlier questions:$/m)
  // IT RESTATES THE QUESTION, because the worker never saw the id — frizz minted it.
  assert.match(h.resumes[0].message, /^1\. “SQLite or a JSON file\?” → SQLite$/m)
  assert.equal(h.storage.getThreadQuestion("qst_1")?.delivered, 1)
})

test("question: a dismissal rides an answer's message and never wakes anybody on its own", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  askQ(h, "t", "qst_keep", "Which store?")
  askQ(h, "t", "qst_drop", "Name the flag?")
  h.tele.set("t", tele())
  const s = h.make()

  // The human dismisses one. No wake: they are almost always dismissing several in a row and are
  // sitting right there, so a wake per × would be a turn per click.
  h.storage.dismissThreadQuestion("qst_drop", h.clock.ms)
  await s.tick()
  assert.equal(h.resumes.length, 0)
  assert.equal(h.storage.getThreadQuestion("qst_drop")?.delivered, 0, "it stays queued for the next message")

  h.storage.answerThreadQuestion("qst_keep", JSON.stringify({ questionId: "qst_keep", question: "Which store?", chosen: ["SQLite"] }), h.clock.ms)
  await s.tick()
  assert.equal(h.resumes.length, 1)
  // A ROW like any other, not a trailing paragraph: the reader treats any non-row line after a row as a
  // continuation of THAT row's answer, so a tail would print inside the human's own answer chip.
  assert.match(h.resumes[0].message, /^2\. “Name the flag\?” → \(dismissed — decide it yourself; do not re-ask\)$/m)
  assert.equal(h.storage.getThreadQuestion("qst_drop")?.delivered, 1, "and rides along when one comes")
})

test("question: an archived thread keeps its answer rather than spending it", async () => {
  const h = harness()
  h.storage.upsertSession(row("t", { state: "archived", archived: 1 }))
  askQ(h, "t", "qst_1", "Which store?")
  h.storage.answerThreadQuestion("qst_1", JSON.stringify({ questionId: "qst_1", question: "Which store?", chosen: ["SQLite"] }), h.clock.ms)
  h.tele.set("t", tele())
  const s = h.make()
  await s.tick()
  assert.equal(h.resumes.length, 0)
  // Reopening should still hand the worker what the human said, not find it already spent on a thread
  // nobody was reading.
  assert.equal(h.storage.getThreadQuestion("qst_1")?.delivered, 0)
})

// ---- AN ANSWER IS DELIVERED WHEN THE WORKER HAS IT (2026-10-01) ----
//
// `delivered` used to flip at ENQUEUE, on the reasoning that the outbox is durable and owns retry. Its
// retry is capped: a wake that exhausted its attempts left the answers reading delivered, and nothing
// ever offered them again (2026-09-30: four answers flagged delivered that never reached their worker).
const answerQ = (h: Harness, id: string, question: string, chosen = "SQLite") =>
  h.storage.answerThreadQuestion(id, JSON.stringify({ questionId: id, question, chosen: [chosen] }), h.clock.ms)

function failingAnswerHarness(over: Partial<Parameters<typeof createScheduler>[0]> = {}) {
  const h = harness()
  h.storage.upsertSession(row("t"))
  askQ(h, "t", "qst_1", "SQLite or a JSON file?")
  h.tele.set("t", tele())
  const failing = { on: true }
  const logs: string[] = []
  const make = (more: Partial<Parameters<typeof createScheduler>[0]> = {}) => h.make({
    maxDeliveryAttempts: 2, retryBaseMs: 100, retryMaxMs: 100, deliveryLeaseMs: 1_000,
    log: (m) => logs.push(m),
    resume: (slug, message, deliveryId) => {
      h.resumes.push({ slug, message, deliveryId })
      if (failing.on) throw new Error("the daemon exited before it became ready")
    },
    ...over,
    ...more,
  })
  const store = createWakeDeliveryStore(h.storage.scope)
  const answerWakes = () => store.list().filter((d) => d.fenceId.startsWith("answers:"))
  // Spend every attempt: the first claim fails, the lease runs out, the second claim fails, the lease
  // runs out and the row is exhausted.
  async function exhaust(s: ReturnType<typeof createScheduler>) {
    for (let i = 0; i < 4; i++) { await s.tick(); h.clock.ms += 1_100 }
  }
  return { h, failing, logs, make, store, answerWakes, exhaust }
}

test("answers: a wake that never lands leaves the answer UNDELIVERED, and it is offered again once the worker runs", async () => {
  const { h, failing, logs, make, answerWakes, exhaust } = failingAnswerHarness()
  const s = make()
  answerQ(h, "qst_1", "SQLite or a JSON file?")
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.equal(h.storage.getThreadQuestion("qst_1")?.delivered, 0, "queued is not received")
  await exhaust(s)
  assert.equal(h.resumes.length, 2, "both attempts spent")
  assert.deepEqual(answerWakes().map((d) => d.state), ["exhausted"])
  // THE BUG: this read 1 — "delivered" — for an answer no worker ever saw.
  assert.equal(h.storage.getThreadQuestion("qst_1")?.delivered, 0, "an exhausted wake delivered nothing")
  assert.ok(logs.some((m) => /answers for t stay UNDELIVERED/.test(m)), "and that is said")

  // NOT A LOOP. With nothing to say the runtime has changed, the next ticks leave it alone rather than
  // burning another round of attempts every tick.
  for (let i = 0; i < 5; i++) { await s.tick(); h.clock.ms += 10_000 }
  assert.equal(h.resumes.length, 2, "no re-offer without a reason")

  // The worker runs a turn — a human steer reached it — so its runtime takes input again.
  failing.on = false
  h.tele.set("t", { ...tele(), lastAssistantAt: iso(h.clock.ms) })
  h.clock.ms += 1
  await s.tick()
  assert.equal(h.resumes.length, 3, "offered again")
  assert.match(h.resumes[2].message, /^1\. “SQLite or a JSON file\?” → SQLite$/m, "the same answer, in the same words")
  assert.notEqual(h.resumes[2].deliveryId, h.resumes[0].deliveryId, "under a new delivery id: the old one is spent")
  assert.equal(h.storage.getThreadQuestion("qst_1")?.delivered, 1, "and now it IS delivered")
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 3, "and never again")
})

test("answers: a failed batch is offered again after the backoff even if nothing else happens", async () => {
  const { h, failing, make, exhaust } = failingAnswerHarness()
  const s = make()
  answerQ(h, "qst_1", "SQLite or a JSON file?")
  await exhaust(s)
  assert.equal(h.resumes.length, 2)
  failing.on = false
  h.clock.ms += ANSWER_REOFFER_BACKOFF_MS - 10_000
  await s.tick()
  assert.equal(h.resumes.length, 2, "inside the backoff")
  h.clock.ms += 10_000
  await s.tick()
  assert.equal(h.resumes.length, 3, "offered again at the backoff")
  assert.equal(h.storage.getThreadQuestion("qst_1")?.delivered, 1)
})

test("answers: a failed batch is offered again at once by a restarted server", async () => {
  const { h, failing, make, exhaust } = failingAnswerHarness()
  answerQ(h, "qst_1", "SQLite or a JSON file?")
  await exhaust(make())
  assert.equal(h.resumes.length, 2)
  assert.equal(h.storage.getThreadQuestion("qst_1")?.delivered, 0)
  // A restart is where a broken binary or credential gets fixed — the real-subsystem run in
  // scripts/verify-answers-delivery.mjs is exactly this, against a real server.
  failing.on = false
  h.clock.ms += 1_000
  await make().tick()
  assert.equal(h.resumes.length, 3)
  assert.equal(h.storage.getThreadQuestion("qst_1")?.delivered, 1)
})

test("answers: a second answer while the first is in flight is its own wake, and never re-carries the first", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  askQ(h, "t", "qst_1", "First?")
  askQ(h, "t", "qst_2", "Second?")
  h.tele.set("t", tele())
  // A broker runtime: the wake is SENT and confirmed by the process surviving the grace, so it sits
  // leased — in flight — between the two answers.
  const s = h.make({ wakeRuntimeState: () => "alive", confirmGraceMs: 1_000 })
  answerQ(h, "qst_1", "First?", "A")
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.equal(h.storage.getThreadQuestion("qst_1")?.delivered, 0, "sent, not yet confirmed")
  answerQ(h, "qst_2", "Second?", "B")
  await s.tick()
  assert.equal(h.resumes.length, 2)
  assert.doesNotMatch(h.resumes[1].message, /First\?/, "the in-flight answer is not sent twice")
  assert.match(h.resumes[1].message, /“Second\?” → B/)
  h.clock.ms += 1_100
  await s.tick()
  assert.equal(h.storage.getThreadQuestion("qst_1")?.delivered, 1, "confirmed once the process outlived the grace")
  assert.equal(h.storage.getThreadQuestion("qst_2")?.delivered, 1)
  await s.tick()
  assert.equal(h.resumes.length, 2)
})

test("answers: the transcript token marks them delivered; a process that dies with them is not delivery", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  askQ(h, "t", "qst_1", "Which store?")
  h.tele.set("t", tele())
  let alive = false
  const s = h.make({ wakeRuntimeState: () => (alive ? "alive" : "dead"), confirmGraceMs: 1_000, retryBaseMs: 100, retryMaxMs: 100 })
  answerQ(h, "qst_1", "Which store?")
  await s.tick()
  h.clock.ms += 1_100
  await s.tick()
  assert.equal(h.storage.getThreadQuestion("qst_1")?.delivered, 0, "the process died before reading it")
  alive = true
  h.clock.ms += 200
  await s.tick()
  assert.equal(h.resumes.length, 2, "the outbox's own retry")
  h.tele.set("t", { ...tele(), lastUserText: `${h.resumes[1].message}\n\n${wakeDeliveryToken(h.resumes[1].deliveryId!)}` })
  await s.tick()
  assert.equal(h.storage.getThreadQuestion("qst_1")?.delivered, 1)
})

// THE REAL FOLD, not a telemetry object written by hand: the five tests that set `lastUserText`
// themselves all passed while no Claude thread had ever had a wake confirmed by its token, because the
// Claude fold never wrote that field. This one feeds the record a broker thread's transcript really
// gets through `applyRecord` and hands the scheduler what comes out.
test("answers: on a Claude thread the wake's token in the transcript confirms it at the next tick, not when the grace window closes", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  askQ(h, "t", "qst_1", "Which store?")
  h.tele.set("t", tele())
  const s = h.make({ wakeRuntimeState: () => "alive", confirmGraceMs: 60_000 })
  answerQ(h, "qst_1", "Which store?")
  await s.tick()
  assert.equal(h.resumes.length, 1)
  h.clock.ms += 2_000
  await s.tick()
  assert.equal(h.storage.getThreadQuestion("qst_1")?.delivered, 0, "sent, and nothing yet says the worker has it")

  const fold = newTailState("t", "sid-t", "/x")
  applyRecord(fold, {
    type: "user", timestamp: new Date(h.clock.ms).toISOString(),
    message: { role: "user", content: `${h.resumes[0].message}\n\n${wakeDeliveryToken(h.resumes[0].deliveryId!)}` },
  } as never)
  h.tele.set("t", { ...tele(), wakeTokens: fold.wakeTokens })
  h.clock.ms += 2_000
  await s.tick()
  assert.equal(h.storage.getThreadQuestion("qst_1")?.delivered, 1, "58 seconds before the window would have closed")
  await s.tick()
  assert.equal(h.resumes.length, 1, "and it is not sent again")
})

test("answers: an ABANDONED wake leaves them undelivered and is not retried on every tick", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  askQ(h, "t", "qst_1", "Which store?")
  h.tele.set("t", tele())
  const s = h.make({
    resume: (slug, message, deliveryId) => {
      h.resumes.push({ slug, message, deliveryId })
      throw Object.assign(new Error("a live worker owns this conversation"), { terminalDelivery: true })
    },
  })
  answerQ(h, "qst_1", "Which store?")
  for (let i = 0; i < 5; i++) { await s.tick(); h.clock.ms += 10_000 }
  assert.equal(h.resumes.length, 1)
  assert.equal(h.storage.getThreadQuestion("qst_1")?.delivered, 0)
})

test("answers: a wake superseded by a session change is offered to the new session at once", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  askQ(h, "t", "qst_1", "Which store?")
  h.tele.set("t", tele(undefined, "in-flight")) // held: an answer waits for the thread to rest
  const s = h.make()
  answerQ(h, "qst_1", "Which store?")
  await s.tick()
  assert.equal(h.resumes.length, 0)
  h.storage.upsertSession(row("t", { session_id: "sid-t-2" }))
  h.tele.set("t", tele())
  h.clock.ms += 31_000
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1, "the new session gets the answer")
  assert.match(h.resumes[0].message, /“Which store\?” → SQLite/)
  assert.equal(h.storage.getThreadQuestion("qst_1")?.delivered, 1)
})

// ---- single-fire on a witnessed transition ----

test("timer: fires exactly once on the witnessed crossing, with the prose in the steer", async () => {
  const h = harness()
  const target = h.clock.ms + 30_000
  h.storage.upsertSession(row("t"))
  armTimer(h, "t", target)
  h.tele.set("t", tele())
  const s = h.make()
  await s.tick() // not due yet
  assert.equal(h.resumes.length, 0)
  h.clock.ms = target + 1000
  await s.tick() // crosses → fire
  await s.tick() // the row is spent → must NOT re-fire (single-fire)
  assert.equal(h.resumes.length, 1)
  assert.equal(h.resumes[0].slug, "t")
  assert.match(h.resumes[0].message, /Re-poll the rollout\./)
})

// A shelved thread is skipped by every source, and the row that armed the wake is left ARMED rather
// than settled: an archived thread can be reopened, and the alarm is still the worker's outstanding
// intent. (The `only-at-rest` half of this pair now lives with the sources it actually governs — see
// "limit: a thread already MOVING again is left alone" and the snooze bump that is held until rest.)
test("archived thread is skipped entirely, and its alarm survives the archival", async () => {
  const h = harness()
  h.storage.upsertSession(row("t", { state: "archived", archived: 1 }))
  const id = armTimer(h, "t", h.clock.ms + 1000)
  h.tele.set("t", tele())
  const s = h.make()
  await s.tick()
  h.clock.ms += 10_000
  await s.tick()
  assert.equal(h.resumes.length, 0)
  assert.equal(h.storage.getThreadTimer(id)?.state, "armed", "the alarm is held, not spent")
})

// ---- a SECOND timer, set after the first has rung, fires on its own ----
//
// This used to read "a new awaiting rest arms fresh", because arming WAS the fence and a spent fence had
// to be cleared before a new one could arm. A timer is a ROW now, so there is nothing to clear: each row
// rings once and is spent, and the property worth pinning is that a worker which sets another after the
// first has fired is woken again rather than deduped against the delivery it already had.
test("a SECOND timer set after the first has rung fires on its own", async () => {
  const h = harness()
  const t1 = h.clock.ms + 10_000
  h.storage.upsertSession(row("t"))
  armTimer(h, "t", t1)
  h.tele.set("t", tele())
  const s = h.make()
  await s.tick() // not due yet
  h.clock.ms = t1 + 1000
  await s.tick() // fire #1
  assert.equal(h.resumes.length, 1)
  await s.tick() // the row is spent — no second wake from it
  assert.equal(h.resumes.length, 1)
  // Later the worker sets ANOTHER one.
  const t2 = h.clock.ms + 10_000
  armTimer(h, "t", t2)
  await s.tick()
  assert.equal(h.resumes.length, 1, "not due yet either")
  h.clock.ms = t2 + 1000
  await s.tick() // fire #2
  assert.equal(h.resumes.length, 2)
})

// ---- idempotency across a server restart ----

test("restart idempotency: a delivered outbox wake is not re-fired by a fresh scheduler on the same db", async () => {
  const h = harness()
  const target = h.clock.ms + 10_000
  h.storage.upsertSession(row("t"))
  armTimer(h, "t", target)
  h.tele.set("t", tele())
  const s1 = h.make()
  await s1.tick() // not due yet
  h.clock.ms = target + 1000
  await s1.tick() // fire (persists the terminal outbox row)
  assert.equal(h.resumes.length, 1)
  // Server restarts BEFORE the agent's next turn lands. The outbox row is what has to stop the
  // re-fire — the timer row settling is a second guard, and this pins the first.
  const s2 = h.make()
  await s2.tick()
  await s2.tick()
  assert.equal(h.resumes.length, 1, "the delivered outbox terminal state must prevent a re-fire after restart")
})

test("registered future timer crosses during server downtime and fires exactly once after restart", async () => {
  const h = harness()
  const target = h.clock.ms + 10_000
  h.storage.upsertSession(row("t"))
  armTimer(h, "t", target)
  h.tele.set("t", { ...tele(), lastActivityAt: iso(h.clock.ms) })
  await h.make().tick() // not due yet; the ROW is what survives the restart
  h.clock.ms = target + 60_000 // server was down across the crossing
  const restarted = h.make()
  await restarted.tick()
  await restarted.tick()
  assert.equal(h.resumes.length, 1)
})

// THE LEGACY `pr:` / `ci:` FENCE CONDITIONS ARE GONE, and the tests for them went with them
// (2026-08-15). A fence used to name a PR or a CI target as free text and the scheduler polled it; that
// is deleted, because a line frizz cannot check is a wait that can silently never resolve. A PR is now a
// REGISTERED watcher — `mcp__frizz__watch_pr`, scheduler SOURCE 11 — and its coverage lives under
// "THE REGISTERED PR WATCHERS" below, including CI waking on every terminal transition in both
// directions, which is strictly more than these ever pinned.

// ---- THE REGISTERED PR WATCHERS (scheduler SOURCE 11) ----
// A watcher exists because a worker called `mcp__frizz__watch_pr`, never because it wrote a fence line
// (2026-08-14). So every test here arms with `h.watch(slug, ref)`; the `pr-watch:` hint that sits beside
// it in the telemetry is the DECLARATION the thread rests on, and arms nothing. Both are written here
// because both are what a correct worker does — registering and then declaring what it waits on.
//
// THE FIRST POLL IS MEASURED AGAINST THE REGISTRATION INSTANT. A worker registers when it opens or
// pushes the PR, so activity already sitting there is its own news and reporting it would spend a turn;
// only what lands after `created_at` is a wake. `h.watch` registers 60s in the scheduler's past, so a
// test baselines silently by dating its prior activity before that and wakes by dating it after.
//
// EVERY DELIVERY CARRIES A TRAILER saying the watcher is STILL ARMED — a registration reports again and
// again (red CI, a fix, green CI, a reviewer's comment), so the message has to say so. The steer itself
// is byte-identical to the fence path's, which is why the pins below are on the steer as a PREFIX.
test("pr-watch: a bot review AGENT's review (Pullfrog/Copilot) wakes the watcher — a review is the signal whoever files it", async () => {
  const h = harness()
  h.watch("r", "nubjs/nub#544")
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr", value: "nubjs/nub#544" }])), lastActivityAt: fenceAt })
  h.review.result = [] // no prior activity to baseline
  await h.make().tick()
  assert.equal(h.resumes.length, 0)

  // Pullfrog (the maintainer's own review agent) submits its review as a GitHub App — __typename "Bot".
  // The old all-bots filter swallowed exactly this and left the watcher asleep (nubjs/nub#544).
  h.clock.ms += 10_000
  h.review.result = [{ id: "review:pf", actor: "pullfrog", actorType: "Bot", at: iso(h.clock.ms), kind: "review", reviewState: "COMMENTED" }]
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1, "the bot review agent's review woke the watcher")
  assert.match(h.resumes[0].message, /@pullfrog/)
  assert.doesNotMatch(h.resumes[0].message, /human/, "the steer no longer claims the reviewer is human")
})

// Review apps like CodeRabbit or Greptile file their findings as a CONVERSATION COMMENT, not a formal
// review. Gating comments on the actor left the watcher asleep through exactly those reviews, so there
// is no actor filter at all any more: a bot comment wakes like any other.
test("pr-watch: a bot COMMENT wakes the watcher, and the steer names it as a bot", async () => {
  const h = harness()
  h.watch("r", "nubjs/nub#544")
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr", value: "nubjs/nub#544" }])), lastActivityAt: fenceAt })
  h.review.result = []
  await h.make().tick()
  assert.equal(h.resumes.length, 0)

  h.clock.ms += 10_000
  h.review.result = [{ id: "comment:coderabbit", actor: "coderabbitai[bot]", actorType: "Bot", at: iso(h.clock.ms), kind: "comment" }]
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1, "a bot's conversation comment is review activity like any other")
  assert.match(h.resumes[0].message, /@coderabbitai\[bot\]/)
  assert.match(h.resumes[0].message, /🤖/, "the steer must not imply a person filed it")
  assert.doesNotMatch(h.resumes[0].message, /👤/)
})

// The exclusion list (`pr-watch-noise.ts`): a deploy table, a changeset notice, a "trial ended"
// banner is a poll result, never a wake. The muted id still lands in the cursor, so it is not
// re-evaluated forever, and a real item arriving later still wakes on its own.
test("pr-watch: muted bot noise does not wake — and does not block the human comment after it", async () => {
  const h = harness()
  h.watch("r", "acme/app#391")
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr", value: "acme/app#391" }])), lastActivityAt: fenceAt })
  h.review.result = []
  await h.make().tick()
  assert.equal(h.resumes.length, 0)

  // Vercel's deploy table: tier-1 actor, and the poll that finds ONLY it advances the cursor silently.
  h.clock.ms += 10_000
  const vercel: GithubReviewActivity = { id: "comment:vc", actor: "vercel", actorType: "Bot", at: iso(h.clock.ms), kind: "comment", body: "[vc]: #deploy-table" }
  h.review.result = [vercel]
  const s1 = h.make()
  await s1.tick()
  await s1.tick()
  assert.equal(h.resumes.length, 0, "a deploy-preview comment is not a wake")

  // A real comment lands next poll. The steer names it alone — the muted item is gone, not deferred.
  h.clock.ms += 10_000
  const at = iso(h.clock.ms)
  h.review.result = [vercel, { id: "comment:hu", actor: "colinhacks", actorType: "User", at, kind: "comment", body: "please rebase" }]
  const s2 = h.make()
  await s2.tick()
  await s2.tick()
  assert.equal(h.resumes.length, 1, "the human comment wakes")
  assert.match(h.resumes[0].message, /New GitHub comment on acme\/app#391 from @colinhacks/)
  assert.doesNotMatch(h.resumes[0].message, /vercel/)
})

test("pr-watch: a burst mixing noise and signal counts and names only the signal", async () => {
  const h = harness()
  h.watch("r", "acme/app#391")
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr", value: "acme/app#391" }])), lastActivityAt: fenceAt })
  h.review.result = []
  await h.make().tick()
  assert.equal(h.resumes.length, 0)

  h.clock.ms += 10_000
  const at = iso(h.clock.ms)
  h.review.result = [
    // CodeRabbit's FINDINGS review stays live even though its walkthrough comment (below) is muted.
    { id: "review:cr", actor: "coderabbitai", actorType: "Bot", at, kind: "review", reviewState: "COMMENTED", body: "**Actionable comments posted: 2**" },
    { id: "comment:walk", actor: "coderabbitai", actorType: "Bot", at: iso(h.clock.ms - 1000), kind: "comment", body: "<!-- This is an auto-generated comment: summarize by coderabbit.ai -->\n## Walkthrough" },
    { id: "comment:cs", actor: "changeset-bot", actorType: "Bot", at: iso(h.clock.ms - 2000), kind: "comment", body: "🦋 Changeset detected" },
  ]
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /New GitHub review comment on acme\/app#391 from @coderabbitai/, "one live item: the header is singular, not a 3-item burst")
  assert.doesNotMatch(h.resumes[0].message, /changeset|Walkthrough/)
})

// A worker tracking a SET of PRs registers one watcher per PR, and the waker must poll EVERY one of
// them — activity on any is the wake. Nothing pinned this, and in its absence a worker watching
// 11 adoption PRs concluded (in writing, to the operator) that a watch "can't fan out across repos"
// and fell back to a 7-day timer sweep; a real CHANGES_REQUESTED review then sat unreported for a day
// and a half (burned 2026-07-30). The shared harness returns ONE activity list for every ref, so this
// test supplies a per-ref fetcher — otherwise "the third ref woke it" proves nothing.
test("pr-watch fans out: every registered ref of a multi-PR thread is polled, and the LAST one's activity wakes", async () => {
  const h = harness()
  h.watch("multi", "acme/a#1")
  h.watch("multi", "acme/b#2")
  h.watch("multi", "acme/c#3")
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("multi"))
  h.tele.set("multi", {
    ...tele(awaiting([
      { kind: "pr", value: "acme/a#1" },
      { kind: "pr", value: "acme/b#2" },
      { kind: "pr", value: "acme/c#3" },
    ])),
    lastActivityAt: fenceAt,
  })
  const byRef = new Map<string, GithubReviewActivity[]>([["acme/a#1", []], ["acme/b#2", []], ["acme/c#3", []]])
  const polled: string[] = []
  const make = () => h.make({
    fetchGithubReview: async (ref: PrRef) => {
      const key = `${ref.owner}/${ref.repo}#${ref.number}`
      polled.push(key)
      return byRef.get(key) ?? []
    },
  })
  await make().tick() // baseline every ref
  assert.deepEqual([...new Set(polled)].sort(), ["acme/a#1", "acme/b#2", "acme/c#3"])
  assert.equal(h.resumes.length, 0)

  // Activity on the THIRD hint only — the one a first-hint-wins watcher would never see.
  h.clock.ms += 10_000
  byRef.set("acme/c#3", [{ id: "review:z", actor: "carol", actorType: "User", at: iso(h.clock.ms), kind: "review" }])
  const s = make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /@carol/)
  assert.match(h.resumes[0].message, /acme\/c#3/, "the steer names the PR that actually moved")
})

test("pr-watch: baselines, then bumps on a new human comment", async () => {
  const h = harness()
  h.watch("r", "acme/app#391")
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr", value: "acme/app#391" }])), lastActivityAt: fenceAt })
  // Already on the PR before the worker registered the watcher, so it is the worker's own news: the
  // first poll records it as seen and says nothing.
  h.review.result = [{ id: "comment:old", actor: "alice", actorType: "User", at: iso(h.clock.ms - 120_000), kind: "comment" }]
  await h.make().tick()
  assert.equal(h.resumes.length, 0, "activity that predates the registration is baselined, never reported")

  h.clock.ms += 10_000
  h.review.result = [
    { id: "comment:new", actor: "carol", actorType: "User", at: iso(h.clock.ms), kind: "comment" },
    { id: "comment:old", actor: "alice", actorType: "User", at: iso(h.clock.ms - 20_000), kind: "comment" },
  ]
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /@carol/)
  assert.match(h.resumes[0].message, /comment/)
  assert.match(h.resumes[0].message, /👤/, "a User actor still reads as a person")
})

// The steer used to name only the PR and the actor. A worker woken that way has no way to address the
// exact item, so its only move is a broad re-read of the thread — and on the real nubjs/nub#587 wake
// that handed back TWO comments from @colinhacks, one of them hours stale and already handled. The
// permalink addresses exactly one item; the ISO timestamp orders it against the worker's own last turn.
test("pr-watch: the bump steer carries the item's permalink and timestamp, not just the actor", async () => {
  const h = harness()
  h.watch("r", "nubjs/nub#587")
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr", value: "nubjs/nub#587" }])), lastActivityAt: fenceAt })
  // The stale comment predates the registration, so the first poll only baselines it — and from here it
  // must never be named again.
  h.review.result = [{ id: "comment:stale", actor: "colinhacks", actorType: "User", at: iso(h.clock.ms - 120_000), kind: "comment", url: "https://github.com/nubjs/nub/pull/587#issuecomment-1" }]
  await h.make().tick()
  assert.equal(h.resumes.length, 0)

  h.clock.ms += 20_000
  const at = iso(h.clock.ms)
  h.review.result = [
    { id: "comment:fresh", actor: "colinhacks", actorType: "User", at, kind: "comment", url: "https://github.com/nubjs/nub/pull/587#issuecomment-2" },
    { id: "comment:stale", actor: "colinhacks", actorType: "User", at: iso(h.clock.ms - 11_000), kind: "comment", url: "https://github.com/nubjs/nub/pull/587#issuecomment-1" },
  ]
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  const steer = `👤 New GitHub comment on nubjs/nub#587 from @colinhacks at ${at}. Read that exact comment — ignore older activity you have already handled — and continue: https://github.com/nubjs/nub/pull/587#issuecomment-2`
  // The steer is a PREFIX of the delivery: the still-armed trailer follows it, and the blank line
  // between them is also what pins that the URL ends the steer — no trailing period joins the href.
  assert.ok(h.resumes[0].message.startsWith(`${steer}\n\n(Registered PR watcher`))
  assert.doesNotMatch(h.resumes[0].message, /issuecomment-1\b/, "the stale comment the worker already handled is never named")
})

// Every id in the fresh set is marked seen the moment the cursor is persisted, so an activity this
// steer does not name is never mentioned to anyone again. Naming only `fresh[0]` dropped the rest.
test("pr-watch: a BURST between polls is enumerated in full, oldest first — none is silently dropped", async () => {
  const h = harness()
  h.watch("r", "acme/app#391")
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr", value: "acme/app#391" }])), lastActivityAt: fenceAt })
  h.review.result = []
  await h.make().tick()
  assert.equal(h.resumes.length, 0)

  h.clock.ms += 10_000
  const t1 = iso(h.clock.ms - 2000)
  const t2 = iso(h.clock.ms - 1000)
  const t3 = iso(h.clock.ms)
  h.review.result = [
    { id: "review:c", actor: "dana", actorType: "User", at: t3, kind: "review", reviewState: "APPROVED", url: "https://github.com/acme/app/pull/391#pullrequestreview-3" },
    { id: "comment:b", actor: "coderabbitai[bot]", actorType: "Bot", at: t2, kind: "comment", url: "https://github.com/acme/app/pull/391#issuecomment-2" },
    { id: "comment:a", actor: "carol", actorType: "User", at: t1, kind: "comment", url: "https://github.com/acme/app/pull/391#issuecomment-1" },
  ]
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  // The steer is pinned as a PREFIX because the still-armed trailer follows it in the delivery.
  assert.ok(h.resumes[0].message.startsWith(
    [
      "👤 3 new GitHub items on acme/app#391. Read exactly these — ignore older activity you have already handled — and continue:",
      "",
      `- 👤 comment from @carol at ${t1}: https://github.com/acme/app/pull/391#issuecomment-1`,
      `- 🤖 comment from @coderabbitai[bot] at ${t2}: https://github.com/acme/app/pull/391#issuecomment-2`,
      `- 👤 approval from @dana at ${t3}: https://github.com/acme/app/pull/391#pullrequestreview-3`,
      // Dana's approval is the only REVIEW in the burst, so the steer's derived tail names exactly one
      // read — the two issue comments carry their substance in their own bodies and need no help.
      "",
      "A review's body is often empty because its substance is inline comments. Read them, one call each:",
      "gh api --paginate repos/acme/app/pulls/391/reviews/3/comments",
    ].join("\n"),
  ))
})

// The cap keeps the NEWEST items (they matter most) and the header still counts the whole burst, so a
// worker is never told "3 new items" when 30 landed.
test("pr-watch: a burst past the enumeration cap counts everything and says how many it did not name", async () => {
  const h = harness()
  h.watch("r", "acme/app#391")
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr", value: "acme/app#391" }])), lastActivityAt: fenceAt })
  h.review.result = []
  await h.make().tick()

  h.clock.ms += 10_000
  h.review.result = Array.from({ length: 13 }, (_, i) => ({
    id: `comment:${i}`,
    actor: "carol",
    actorType: "User",
    at: iso(h.clock.ms - (12 - i) * 100),
    kind: "comment" as const,
    url: `https://github.com/acme/app/pull/391#issuecomment-${i}`,
  }))
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  const msg = h.resumes[0].message
  assert.match(msg, /^👤 13 new GitHub items on acme\/app#391\./, "the header counts the whole burst, not just the named ones")
  assert.equal(msg.split("\n").filter((l) => l.startsWith("- ")).length, 11, "10 named items plus the overflow line")
  // The overflow line ends the STEER — what follows it is the still-armed trailer, nothing else.
  assert.match(msg, /- …and 3 more not listed — check acme\/app#391 for the rest\n\n\(Registered PR watcher/)
  assert.match(msg, /issuecomment-12/, "the newest item survives the cap")
  assert.doesNotMatch(msg, /issuecomment-2:/, "the oldest three are the ones dropped")
})

test("pr-watch: an APPROVAL is named specifically in the bump steer", async () => {
  const h = harness()
  h.watch("r", "acme/app#391")
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr", value: "acme/app#391" }])), lastActivityAt: fenceAt })
  h.review.result = [] // no prior activity to baseline
  await h.make().tick()
  assert.equal(h.resumes.length, 0)

  h.clock.ms += 10_000
  h.review.result = [{ id: "review:appr", actor: "dana", actorType: "User", at: iso(h.clock.ms), kind: "review", reviewState: "APPROVED" }]
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /approval/)
  assert.match(h.resumes[0].message, /@dana/)
})

// The label fills a noun slot, so GitHub's verb-phrase wording ("requested changes") would read as
// "New GitHub requested changes on acme/app#391 from @erin".
test("pr-watch: CHANGES_REQUESTED is named as a noun, so the steer stays a grammatical sentence", async () => {
  const h = harness()
  h.watch("r", "acme/app#391")
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr", value: "acme/app#391" }])), lastActivityAt: fenceAt })
  h.review.result = []
  await h.make().tick()

  h.clock.ms += 10_000
  const at = iso(h.clock.ms)
  h.review.result = [{ id: "review:cr", actor: "erin", actorType: "User", at, kind: "review", reviewState: "CHANGES_REQUESTED" }]
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  // A PREFIX, because the still-armed trailer follows the steer in the delivered message.
  assert.ok(h.resumes[0].message.startsWith(
    `👤 New GitHub change request on acme/app#391 from @erin at ${at}. Read that exact change request — ignore older activity you have already handled — and continue.`,
  ))
})

// The steer is a NOTIFICATION that activity landed, never an instruction to change the PR's state.
// "Re-open the PR and continue" meant "go read it", but a woken worker reads `gh pr reopen`: the real
// wake on nubjs/nub#551 (a @vercel comment) burned a turn on the ambiguity, and the failure mode one
// step past that is reopening a PR the maintainer closed deliberately. (That @vercel comment could not
// fire at all today — `pr-watch-noise.ts` mutes the actor — so the fixture is a review bot that stays
// live; the wording rule it pins is the same for every steer.)
test("pr-watch: the bump steer never reads as an instruction to mutate the PR", async () => {
  const h = harness()
  h.watch("r", "nubjs/nub#551")
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr", value: "nubjs/nub#551" }])), lastActivityAt: fenceAt })
  h.review.result = []
  await h.make().tick()
  assert.equal(h.resumes.length, 0)

  h.clock.ms += 10_000
  h.review.result = [{ id: "comment:greptile", actor: "greptile-apps", actorType: "Bot", at: iso(h.clock.ms), kind: "comment", body: "Found 2 issues in the diff." }]
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  const message = h.resumes[0].message
  assert.match(message, /nubjs\/nub#551/)
  assert.match(message, /@greptile-apps/)
  assert.doesNotMatch(message, /re-?open/i, "the steer must not order the worker to reopen the PR")
  assert.doesNotMatch(message, /\b(close|merge|approve)\b/i, "nor any other PR state change")
})

// The clear is ported into the registry pass: a watcher that fires while the card is snoozed clears the
// snooze itself, because the news on the PR is exactly the thing the human was hiding the card UNTIL.
test("pr-watch: 'Arm watcher' — a new-activity bump CLEARS the user snooze so the card re-surfaces", async () => {
  const h = harness()
  h.watch("r", "acme/app#391")
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr", value: "acme/app#391" }])), lastActivityAt: fenceAt })
  h.review.result = [] // baseline empty
  await h.make().tick()

  // The human parked the card via "Arm watcher" — a user snooze with a far-future safety timeout.
  const safety = iso(h.clock.ms + 24 * 3600_000)
  h.storage.setSnoozedUntil("r", safety)
  assert.equal(h.storage.getSession("r")?.snoozed_until, safety)

  // A real human review lands well before the safety instant. The scheduler keeps polling the snoozed
  // thread, fires, and CLEARS the snooze so the card returns to the queue immediately.
  h.clock.ms += 10_000
  h.review.result = [{ id: "review:new", actor: "erin", actorType: "User", at: iso(h.clock.ms), kind: "review", reviewState: "COMMENTED" }]
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1, "the bump resumed the worker")
  assert.equal(h.storage.getSession("r")?.snoozed_until, null, "the user snooze was cleared by the activity bump")
})

// Three registered watchers over two distinct PRs: two threads watching one PR is the ordinary shape of
// a review round, and paying GitHub twice for the same answer is how a rate limit arrives.
test("pr-watch: one scheduler tick batches distinct refs and deduplicates duplicate refs", async () => {
  const h = harness()
  const fenceAt = iso(h.clock.ms)
  for (const [slug, pr] of [["first", 544], ["second", 549], ["duplicate", 544]] as const) {
    h.storage.upsertSession(row(slug))
    h.watch(slug, `nubjs/nub#${pr}`)
    h.tele.set(slug, { ...tele(awaiting([{ kind: "pr", value: `nubjs/nub#${pr}` }])), lastActivityAt: fenceAt })
  }
  let tokenCalls = 0
  const requests: any[] = []
  const fetchGithubReview = createGithubReviewFetcher({
    getToken: async () => {
      tokenCalls++
      return "token"
    },
    request: async (_input, init) => {
      const request = JSON.parse(String(init?.body))
      requests.push(request)
      return new Response(JSON.stringify({
        data: {
          ref0: { pullRequest: { reviews: { nodes: [] }, comments: { nodes: [] } } },
          ref1: { pullRequest: { reviews: { nodes: [] }, comments: { nodes: [] } } },
          rateLimit: { cost: 2, remaining: 4_000, resetAt: iso(h.clock.ms + 60 * 60_000), limit: 5_000 },
        },
      }), { status: 200, headers: { "content-type": "application/json" } })
    },
    now: () => h.clock.ms,
  })

  await h.make({ fetchGithubReview }).tick()
  assert.equal(tokenCalls, 1)
  assert.equal(requests.length, 1)
  assert.deepEqual(Object.values(requests[0].variables).filter((value) => typeof value === "number").sort(), [544, 549])
})

test("pr-watch: precise failures are coalesced in logs and recovery is explicit", async () => {
  const h = harness()
  h.watch("r", "nubjs/nub#544")
  const fenceAt = iso(h.clock.ms)
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr", value: "nubjs/nub#544" }])), lastActivityAt: fenceAt })
  const logs: string[] = []
  let recovered = false
  const scheduler = h.make({
    log: (message) => logs.push(message),
    fetchGithubReview: async () => recovered
      ? { status: "ok", activity: [] }
      : { status: "error", failure: { kind: "timeout", message: "GitHub GraphQL request timed out after 15s" } },
  })

  // One fetch serves EVERY thread watching the PR, so the failure belongs to the ref rather than to any
  // one slug — the parenthetical names the pass, not a thread. The 60s steps are the registry's own poll
  // floor: a shorter step would simply skip the fetch and log nothing.
  await scheduler.tick()
  h.clock.ms += 60_000
  await scheduler.tick()
  assert.deepEqual(logs, [
    "waker: GitHub review check failed for nubjs/nub#544 (pr-watch registry) [timeout] — GitHub GraphQL request timed out after 15s",
  ])

  recovered = true
  h.clock.ms += 60_000
  await scheduler.tick()
  assert.deepEqual(logs, [
    "waker: GitHub review check failed for nubjs/nub#544 (pr-watch registry) [timeout] — GitHub GraphQL request timed out after 15s",
    "waker: GitHub review check recovered for nubjs/nub#544 (pr-watch registry); 1 identical repeats were suppressed",
  ])
})

// ---- durable delivery outbox: crash boundaries, recovery, retries, and concurrency ----

// THE OUTBOX'S VEHICLE IS A REAL TIMER ROW, not an awaiting fence.
//
// These tests are about the DELIVERY MACHINERY — crash boundaries, leases, retry windows, supersession
// — and they only ever needed some source that fires at a known instant. That used to be a
// `timer: <ISO instant>` fence, which is deleted (2026-08-15): a worker computed that instant and one
// wrote it 5h55m in the past. The timer is now a ROW the worker creates through `mcp__frizz__timer`,
// so that is what arms these. Same enqueue → lease → deliver → ack path; only the source differs.
let dueTimerSeq = 0
function dueTimer(h: Harness, slug: string, delayMs = 1_000): { target: number; id: string } {
  const target = h.clock.ms + delayMs
  const id = `tmr_${slug}_${++dueTimerSeq}`
  h.storage.upsertSession(row(slug))
  h.storage.armThreadTimer({ id, slug, prompt: `Wake ${slug}.`, fireAtMs: target, createdAtMs: h.clock.ms })
  h.tele.set(slug, { ...tele(), lastActivityAt: iso(h.clock.ms) })
  return { target, id }
}

test("hard crash after enqueue recovers the pending wake on restart", async () => {
  const h = harness()
  const { target } = dueTimer(h, "enqueue-crash")
  let crash = true
  const scheduler = h.make({
    crashPoint: (point) => {
      if (crash && point === "after-enqueue") throw new Error("SIGKILL after enqueue")
    },
  })
  await scheduler.tick() // register the future timer
  h.clock.ms = target + 1
  await assert.rejects(scheduler.tick(), /simulated scheduler hard crash/)

  const store = createWakeDeliveryStore(h.storage.scope)
  assert.equal(store.list().length, 1)
  assert.equal(store.list()[0].state, "pending")
  assert.equal(store.list()[0].attempts, 0)
  assert.equal(h.resumes.length, 0)

  const dbPath = h.storage.db.name
  h.storage.close()
  const reopened = createStorage(dbPath, "p")
  crash = false
  const restarted = h.make({ storage: reopened })
  await restarted.tick()
  await restarted.tick()
  assert.equal(h.resumes.length, 1)
  assert.equal(createWakeDeliveryStore(reopened.scope).list()[0].state, "delivered")
  reopened.close()
})

test("hard crash after atomic claim leaves a lease; restart retries only after it expires", async () => {
  const h = harness()
  const { target } = dueTimer(h, "claim-crash")
  let crash = true
  const scheduler = h.make({
    deliveryLeaseMs: 100,
    retryBaseMs: 10,
    crashPoint: (point) => {
      if (crash && point === "after-claim") throw new Error("SIGKILL after claim")
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await assert.rejects(scheduler.tick(), /simulated scheduler hard crash/)

  const store = createWakeDeliveryStore(h.storage.scope)
  assert.equal(store.list()[0].state, "leased")
  assert.equal(store.list()[0].attempts, 1)
  assert.equal(h.resumes.length, 0)

  const dbPath = h.storage.db.name
  h.storage.close()
  const reopened = createStorage(dbPath, "p")
  crash = false
  const restarted = h.make({ storage: reopened, deliveryLeaseMs: 100, retryBaseMs: 10 })
  await restarted.tick()
  assert.equal(h.resumes.length, 0, "an unexpired claim cannot be stolen by the new scheduler")
  h.clock.ms += 101
  await restarted.tick()
  assert.equal(h.resumes.length, 1)
  const recovered = createWakeDeliveryStore(reopened.scope).list()[0]
  assert.equal(recovered.state, "delivered")
  assert.equal(recovered.attempts, 2)
  reopened.close()
})

test("hard crash after successful delivery but before ack is confirmed by the stable token, never replayed", async () => {
  const h = harness()
  const { target } = dueTimer(h, "delivery-crash")
  let deliveredId = ""
  const scheduler = h.make({
    deliveryLeaseMs: 100,
    resume: (_slug, _message, deliveryId) => {
      deliveredId = deliveryId
      h.resumes.push({ slug: "delivery-crash", message: "delivered", deliveryId })
    },
    crashPoint: (point) => {
      if (point === "after-delivery") throw new Error("SIGKILL after the worker accepted input")
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await assert.rejects(scheduler.tick(), /simulated scheduler hard crash/)
  assert.equal(h.resumes.length, 1)

  const store = createWakeDeliveryStore(h.storage.scope)
  assert.equal(store.list()[0].state, "leased")
  assert.equal(store.list()[0].attempts, 1)
  // The backend transcript consumed the exact idempotency token before the control plane restarted.
  h.tele.set("delivery-crash", {
    ...tele(),
    lastActivityAt: iso(target - 1_000),
    lastUserText: `wake input ${wakeDeliveryToken(deliveredId)}`,
  })
  h.clock.ms += 101
  const dbPath = h.storage.db.name
  h.storage.close()
  const reopened = createStorage(dbPath, "p")
  const restarted = h.make({ storage: reopened, deliveryLeaseMs: 100 })
  await restarted.tick()
  await restarted.tick()
  assert.equal(h.resumes.length, 1, "confirmed external delivery must not be duplicated")
  const confirmed = createWakeDeliveryStore(reopened.scope).list()[0]
  assert.equal(confirmed.state, "delivered")
  assert.equal(confirmed.deliveredAt, h.clock.ms)
  reopened.close()
})

test("an ambiguous delivery error is not replayed when the transcript already confirms its token", async () => {
  const h = harness()
  const { target } = dueTimer(h, "ambiguous")
  let calls = 0
  const scheduler = h.make({
    deliveryLeaseMs: 100,
    resume: (_slug, _message, deliveryId) => {
      calls++
      h.tele.set("ambiguous", {
        ...tele(),
        lastActivityAt: iso(target - 1_000),
        lastUserText: `accepted ${wakeDeliveryToken(deliveryId)}`,
      })
      throw new Error("connection dropped after terminal accepted the input")
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await scheduler.tick()
  assert.equal(calls, 1)
  assert.equal(createWakeDeliveryStore(h.storage.scope).list()[0].state, "leased")

  await h.make({ deliveryLeaseMs: 100 }).tick()
  assert.equal(calls, 1)
  assert.equal(createWakeDeliveryStore(h.storage.scope).list()[0].state, "delivered")
})

test("hard crash after ack leaves an exact delivered terminal state and never replays", async () => {
  const h = harness()
  const { target } = dueTimer(h, "ack-crash")
  const scheduler = h.make({
    crashPoint: (point) => {
      if (point === "after-ack") throw new Error("SIGKILL after ack")
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await assert.rejects(scheduler.tick(), /simulated scheduler hard crash/)
  assert.equal(h.resumes.length, 1)

  const store = createWakeDeliveryStore(h.storage.scope)
  assert.equal(store.list()[0].state, "delivered")
  const dbPath = h.storage.db.name
  h.storage.close()
  const reopened = createStorage(dbPath, "p")
  await h.make({ storage: reopened }).tick()
  assert.equal(h.resumes.length, 1)
  reopened.close()
})

// SUPERSESSION, rebuilt on what actually supersedes a timer now.
//
// This used to clear the awaiting FENCE between enqueue and delivery — that was how a wake stopped being
// wanted when the fence WAS the registration. A timer is a row, so the equivalent is the worker
// CANCELLING it, and the rule is the same one and the same line of code: a delivery is bound to its row
// still being armed (`getThreadTimer(...)?.state !== "armed"` → superseded). It matters for the same
// reason it always did — withdrawing a wait is the whole point of being able to hold one — and it is
// exercised across the crash boundary, where a durable row is already enqueued and waiting to go out.
test("a pending wake whose timer is cancelled becomes superseded without delivery", async () => {
  const h = harness()
  const { target, id } = dueTimer(h, "human-won")
  const scheduler = h.make({
    crashPoint: (point) => {
      if (point === "after-enqueue") throw new Error("stop after durable enqueue")
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await assert.rejects(scheduler.tick(), /simulated scheduler hard crash/)
  // The worker withdrew it (`mcp__frizz__timer` action "cancel") before the enqueued wake went out.
  h.storage.cancelThreadTimer("human-won", id, h.clock.ms)

  await h.make().tick()
  const item = createWakeDeliveryStore(h.storage.scope).list()[0]
  assert.equal(item.state, "superseded")
  assert.equal(h.resumes.length, 0)
})

test("delivery failures use bounded exponential retry windows and terminate exhausted", async () => {
  const h = harness()
  const { target } = dueTimer(h, "exhaust")
  let attempts = 0
  const scheduler = h.make({
    deliveryLeaseMs: 10,
    retryBaseMs: 10,
    retryMaxMs: 40,
    maxDeliveryAttempts: 3,
    resume: () => {
      attempts++
      throw new Error(`terminal unavailable ${attempts}`)
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await scheduler.tick() // attempt 1, retry window 10ms
  assert.equal(attempts, 1)
  h.clock.ms += 9
  await scheduler.tick()
  assert.equal(attempts, 1)
  h.clock.ms += 1
  await scheduler.tick() // attempt 2, retry window 20ms
  assert.equal(attempts, 2)
  h.clock.ms += 20
  await scheduler.tick() // attempt 3, retry window 40ms
  assert.equal(attempts, 3)
  h.clock.ms += 40
  await scheduler.tick() // terminal exhaustion, never a fourth callback
  await scheduler.tick()

  const item = createWakeDeliveryStore(h.storage.scope).list()[0]
  assert.equal(item.state, "exhausted")
  assert.equal(item.attempts, 3)
  assert.equal(item.lastError, "terminal unavailable 3")
  assert.equal(attempts, 3)
})

// An ordinary wake takes exactly one attempt, so a pre-flight "delivering … (attempt 1)" spent its
// whole life telling the human about a retry counter that had never retried anything — it read as if
// something had already gone wrong. The default line is now a CONFIRMATION of a delivery that landed.
test("the happy path logs one delivery CONFIRMATION, with no attempt counter", async () => {
  const h = harness()
  const { target } = dueTimer(h, "quiet")
  const logs: string[] = []
  const scheduler = h.make({ log: (message) => logs.push(message) })
  await scheduler.tick() // armed (unmet)
  h.clock.ms = target + 1
  await scheduler.tick() // crosses → queue + deliver
  assert.equal(h.resumes.length, 1)
  assert.deepEqual(logs, [
    `waker: queued quiet — one-off timer elapsed (${iso(target)})`,
    `waker: delivered quiet — one-off timer elapsed (${iso(target)})`,
  ])
})

test("attempt counts surface only where they inform: the failure, then the delivery that recovered", async () => {
  const h = harness()
  const { target } = dueTimer(h, "flaky")
  const logs: string[] = []
  let failing = true
  const scheduler = h.make({
    log: (message) => logs.push(message),
    deliveryLeaseMs: 10,
    retryBaseMs: 10,
    retryMaxMs: 40,
    maxDeliveryAttempts: 3,
    resume: (slug, message, deliveryId) => {
      if (failing) throw new Error("worker busy")
      h.resumes.push({ slug, message, deliveryId })
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await scheduler.tick() // attempt 1 throws
  failing = false
  h.clock.ms += 10 // the retry window elapses
  await scheduler.tick() // attempt 2 lands
  assert.equal(h.resumes.length, 1)
  assert.deepEqual(logs, [
    `waker: queued flaky — one-off timer elapsed (${iso(target)})`,
    "waker: delivery FAILED for flaky (attempt 1 of 3): worker busy",
    `waker: delivered flaky — one-off timer elapsed (${iso(target)}) (on attempt 2)`,
  ])
})

test("two scheduler instances on separate SQLite connections atomically claim one wake", async () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-sched-concurrent-"))
  const path = join(dir, "ui.db")
  const firstStorage = createStorage(path, "p")
  const secondStorage = createStorage(path, "p")
  const telemetry = new Map<string, SessionTelemetry>()
  const clock = { ms: Date.parse("2026-07-09T12:00:00.000Z") }
  const target = clock.ms + 1_000
  firstStorage.upsertSession(row("concurrent"))
  // A real timer ROW, for the reason recorded above `dueTimer` — this case arms its own storage rather
  // than the harness's, since the whole point is two connections onto one db file.
  firstStorage.armThreadTimer({
    id: "tmr_concurrent", slug: "concurrent", prompt: "Wake concurrent.", fireAtMs: target, createdAtMs: clock.ms,
  })
  telemetry.set("concurrent", { ...tele(), lastActivityAt: iso(clock.ms) })

  const deliveries: string[] = []
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const began = new Promise<void>((resolve) => { started = resolve })
  const resume = async (_slug: string, _message: string, deliveryId: string) => {
    deliveries.push(deliveryId)
    started()
    await gate
  }
  const make = (storage: Storage) => createScheduler({
    storage,
    tailer: fakeTailer(telemetry),
    resume,
    now: () => clock.ms,
    fetchPr: async () => undefined,
    fetchGithubReview: async () => undefined,
    log: () => {},
  })
  const first = make(firstStorage)
  const second = make(secondStorage)
  await Promise.all([first.tick(), second.tick()]) // the timer is not due yet: neither enqueues
  clock.ms = target + 1

  const firstTick = first.tick()
  const secondTick = second.tick()
  await began
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(deliveries.length, 1, "the second scheduler observes the lease instead of delivering")
  release()
  await Promise.all([firstTick, secondTick])

  assert.equal(new Set(deliveries).size, 1)
  const items = createWakeDeliveryStore(secondStorage.scope).list()
  assert.equal(items.length, 1)
  assert.equal(items[0].state, "delivered")
  assert.equal(items[0].attempts, 1)
  secondStorage.close()
  firstStorage.close()
})

test("a slow condition pass cannot create an already-expired delivery lease", async () => {
  const h = harness()
  const { target } = dueTimer(h, "fresh-lease")
  let claimedLease = 0
  let advanced = false
  const scheduler = h.make({
    deliveryLeaseMs: 100,
    crashPoint: (point, item) => {
      if (point === "after-enqueue" && !advanced) {
        advanced = true
        h.clock.ms += 60_000 // stand in for a slow condition/API pass before outbox delivery
      }
      if (point === "after-claim") claimedLease = item.leaseUntil ?? 0
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  await scheduler.tick()

  assert.equal(h.resumes.length, 1)
  assert.ok(claimedLease > h.clock.ms, "claim time is sampled at delivery, not inherited from tick start")
})

test("scheduler stop rejects new ticks and drains an in-flight delivery before storage may close", async () => {
  const h = harness()
  const { target } = dueTimer(h, "shutdown-delivery")
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const delivering = new Promise<void>((resolve) => { started = resolve })
  const scheduler = h.make({
    resume: async (slug, message, deliveryId) => {
      h.resumes.push({ slug, message, deliveryId })
      started()
      await gate
    },
  })
  await scheduler.tick()
  h.clock.ms = target + 1
  const tick = scheduler.tick()
  await delivering

  let stopped = false
  const stopping = scheduler.stop().then(() => { stopped = true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(stopped, false, "stop waits at the external delivery boundary")
  await assert.rejects(scheduler.tick(), /shutting down/)

  release()
  await Promise.all([tick, stopping])
  assert.equal(stopped, true)
  assert.equal(createWakeDeliveryStore(h.storage.scope).list()[0].state, "delivered")
  h.storage.close()
})

// ---- SOURCE 2: subscription-limit auto-resume ------------------------------------------------------
// The recorded phrasings/timestamps below are verbatim from real ~/.claude transcripts.

const LA = "America/Los_Angeles"
// A 15:26-PDT session stop whose window rolls at 17:50 PDT — the 2026-07-21 record.
const SESSION_FAULT_AT = "2026-07-21T22:26:23.160Z"
const SESSION_RESET_MS = Date.parse("2026-07-22T00:50:00.000Z")

function limitTele(fault: SessionTelemetry["limitFault"], turn: TurnState = "idle"): SessionTelemetry {
  return { turn, permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, limitFault: fault }
}
const sessionFault = () => ({ window: "session" as const, at: SESSION_FAULT_AT, resetClock: { hour: 17, minute: 50, timeZone: LA } })

function limitHarness(): Harness {
  const h = harness()
  h.clock.ms = Date.parse(SESSION_FAULT_AT) + 1000
  return h
}

function codexQuota(h: Harness, creditsAvailable = false): QuotaSnapshot {
  return {
    claude: { status: "unavailable", windows: [] },
    codex: {
      status: "ok", windows: [{ key: "5h", label: "5h", usedPercent: 5, resetsAt: h.clock.ms / 1000 + 3600 }],
      codexRecovery: { observedAt: h.clock.ms, accountKey: "account-one", creditsAvailable },
    },
  }
}

test("Codex limits: credits stay blocked despite headroom, then recover once without changing the profile", async () => {
  const h = limitHarness()
  const at = iso(h.clock.ms)
  h.storage.upsertSession(row("codex", { backend: "codex", model: "gpt-6.1-sol", effort: "high" }))
  h.storage.setBackend("codex", "codex")
  h.storage.setProfile("codex", "gpt-6.1-sol", "high")
  h.tele.set("codex", { ...limitTele({ window: "unknown", at, codex: "credits" }), apiFault: true })
  let credits = false
  const s = h.make({ readQuota: async () => codexQuota(h, credits) })
  await s.tick()
  h.clock.ms += 180_000
  await s.tick()
  assert.equal(h.resumes.length, 0)
  credits = true
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /Capacity is available again/)
  assert.equal(h.storage.getSession("codex")?.model, "gpt-6.1-sol")
  assert.equal(h.storage.getSession("codex")?.effort, "high")
  const restarted = h.make({ readQuota: async () => codexQuota(h, true) })
  await restarted.tick()
  assert.equal(h.resumes.length, 1, "the durable outbox deduplicates the interruption after restart")
  h.storage.close()
})

test("Codex limits: fresh headroom recovers a usage window; stale, unknown, busy and archived states cannot wake", async () => {
  for (const kind of ["fresh", "weekly-later", "stale", "offline", "full-weekly", "unavailable", "busy", "archived", "manual", "aged", "throw"] as const) {
    const h = limitHarness()
    const at = iso(h.clock.ms)
    h.storage.upsertSession(row("codex", { backend: "codex", state: kind === "archived" ? "archived" : "open", archived: kind === "archived" ? 1 : 0 }))
    h.storage.setBackend("codex", "codex")
    h.tele.set("codex", limitTele({ window: "unknown", at, codex: "usage" }, kind === "busy" ? "in-flight" : "idle"))
    // A weekly cap can reset days after the fault; only a fault older than the weekly span plus grace is written off.
    h.clock.ms += kind === "weekly-later" ? 5 * 24 * 3600_000 : kind === "aged" ? 9 * 24 * 3600_000 : 180_000
    const q = codexQuota(h)
    if (kind === "stale") q.codex.codexRecovery!.observedAt = Date.parse(at)
    if (kind === "offline") delete q.codex.codexRecovery
    if (kind === "full-weekly") q.codex.windows.push({ key: "weekly", label: "Weekly", usedPercent: 100 })
    if (kind === "unavailable") q.codex.status = "unavailable"
    if (kind === "manual") h.tele.set("codex", tele())
    const s = h.make({ readQuota: async () => { if (kind === "throw") throw new Error("offline"); return q } })
    await s.tick()
    assert.equal(h.resumes.length, kind === "fresh" || kind === "weekly-later" ? 1 : 0, kind)
    h.storage.close()
  }
})

// The send re-reads the quota, and a read that fails says nothing about whether delivery works. Each
// such pass used to keep the attempt its claim had counted: six of them (a few minutes offline at the
// moment the window came back) exhausted the row, and the exhausted row then read as "this interruption
// already has its one wake", for good.
test("Codex limits: quota reads that fail at the send spend no delivery attempt, and the resume goes out once capacity can be confirmed", async () => {
  const h = limitHarness()
  h.storage.upsertSession(row("codex", { backend: "codex" }))
  h.storage.setBackend("codex", "codex")
  h.tele.set("codex", limitTele({ window: "unknown", at: iso(h.clock.ms), codex: "usage" }))
  h.clock.ms += 180_000
  // The first read is evalLimits', on the tick that sees capacity back. Every read for the next seven
  // minutes fails; after that the account is healthy.
  let reads = 0
  let outageUntil = 0
  const logs: string[] = []
  const s = h.make({
    log: (line: string) => void logs.push(line),
    readQuota: async () => {
      if (++reads === 1) { outageUntil = h.clock.ms + 7 * 60_000; return codexQuota(h) }
      if (h.clock.ms < outageUntil) throw new Error("offline")
      return codexQuota(h)
    },
  })
  const outbox = createWakeDeliveryStore(h.storage.scope, { quietWindowMs: 0 })
  const mine = () => outbox.list().filter((d) => d.slug === "codex")
  for (let i = 0; i < 6 * 7; i++) { // the seven minutes, in 10s ticks
    await s.tick()
    h.clock.ms += 10_000
  }
  assert.equal(h.resumes.length, 0, "nothing is sent on an unconfirmed reading")
  assert.deepEqual(mine().map((d) => [d.state, d.attempts]), [["pending", 0]], "held, with no attempt spent")
  assert.equal(logs.filter((l) => /could not be confirmed/.test(l)).length, 1, "and said once, not once per pass")
  for (let i = 0; i < 6 * 3; i++) {
    await s.tick()
    h.clock.ms += 10_000
  }
  assert.equal(h.resumes.length, 1, "resumed once capacity is confirmed")
  assert.match(h.resumes[0].message, /Capacity is available again/)
  h.storage.close()
})

test("Codex limits: an unchanged healthy reading cannot create a retry storm after a bounced wake", async () => {
  const h = limitHarness()
  const firstAt = h.clock.ms
  h.storage.upsertSession(row("codex", { backend: "codex" }))
  h.storage.setBackend("codex", "codex")
  h.tele.set("codex", limitTele({ window: "unknown", at: iso(firstAt), codex: "usage" }))
  h.clock.ms += 180_000
  const q = codexQuota(h)
  const s = h.make({ readQuota: async () => { q.codex.codexRecovery!.observedAt = h.clock.ms; return q } })
  await s.tick()
  assert.equal(h.resumes.length, 1)
  for (let i = 0; i < 3; i++) {
    h.clock.ms += 180_000
    h.tele.set("codex", limitTele({ window: "unknown", at: iso(h.clock.ms - 120_001), codex: "usage" }))
    q.codex.windows[0]!.usedPercent += 1
    q.codex.windows[0]!.resetsAt! += 60
    await s.tick()
  }
  assert.equal(h.resumes.length, 1, "new fault timestamps and quota jitter do not mint recovery attempts")
  q.codex.windows[0]!.usedPercent = 100
  await s.tick()
  q.codex.windows[0]!.usedPercent = 10
  await s.tick()
  assert.equal(h.resumes.length, 2, "a verified blocked → available transition is a new recovery")
  h.clock.ms += 1000
  h.tele.set("codex", { ...tele({ kind: "done", body: "Completed", hints: [] }), lastAssistantAt: iso(h.clock.ms) })
  await s.tick()
  h.tele.set("codex", limitTele({ window: "unknown", at: iso(h.clock.ms + 1), codex: "usage" }))
  h.clock.ms += 180_000
  await s.tick()
  assert.equal(h.resumes.length, 3, "a real successful turn ends the previous recovery episode")
  h.storage.close()
})

test("Codex limits: a native-only failure recovers, but never over a live turn or newer transcript activity", async () => {
  for (const kind of ["native", "busy", "newer"] as const) {
    const h = limitHarness()
    const at = iso(h.clock.ms)
    h.storage.upsertSession(row("codex", { backend: "codex" }))
    h.storage.setBackend("codex", "codex")
    if (kind === "newer") h.tele.set("codex", { ...tele(), lastActivityAt: iso(h.clock.ms + 1) })
    h.clock.ms += 180_000
    const s = h.make({
      codexTurnLiveness: () => ({ bridgeTurn: kind === "busy", providerError: { code: "usage_limit_exceeded", message: "Limit reached", at } }),
      readQuota: async () => codexQuota(h),
    })
    await s.tick()
    assert.equal(h.resumes.length, kind === "native" ? 1 : 0, kind)
    h.storage.close()
  }
})

test("Codex limits: capacity is rechecked before delivering a queued wake", async () => {
  const h = limitHarness()
  h.storage.upsertSession(row("codex", { backend: "codex" }))
  h.storage.setBackend("codex", "codex")
  h.tele.set("codex", limitTele({ window: "unknown", at: iso(h.clock.ms), codex: "credits" }))
  h.clock.ms += 180_000
  let reads = 0
  let available = false
  const s = h.make({ readQuota: async () => codexQuota(h, ++reads === 1 || available) })
  await s.tick()
  assert.equal(h.resumes.length, 0, "capacity disappeared after enqueue")
  available = true
  h.clock.ms += 180_000
  await s.tick()
  assert.equal(h.resumes.length, 1, "the held delivery can recover later")
  h.storage.close()
})

test("Codex limits: a live quota read acquired after tick start is not mistaken for future data", async () => {
  const h = limitHarness()
  h.storage.upsertSession(row("codex"))
  h.storage.setBackend("codex", "codex")
  h.tele.set("codex", limitTele({ window: "unknown", at: iso(h.clock.ms), codex: "usage" }))
  h.clock.ms += 180_000
  const s = h.make({ readQuota: async () => {
    h.clock.ms += 1000
    return codexQuota(h)
  } })
  await s.tick()
  assert.equal(h.resumes.length, 1)
  h.storage.close()
})

test("Codex limits: a manual reply during the live quota check supersedes the queued recovery", async () => {
  const h = limitHarness()
  h.storage.upsertSession(row("codex"))
  h.storage.setBackend("codex", "codex")
  h.tele.set("codex", limitTele({ window: "unknown", at: iso(h.clock.ms), codex: "credits" }))
  h.clock.ms += 180_000
  let reads = 0
  const s = h.make({ readQuota: async () => {
    if (++reads === 2) h.tele.set("codex", { ...tele(), lastUserAt: iso(h.clock.ms) })
    return codexQuota(h, true)
  } })
  await s.tick()
  assert.equal(h.resumes.length, 0)
  await s.tick()
  assert.equal(createWakeDeliveryStore(h.storage.scope).list()[0]?.state, "superseded")
  h.storage.close()
})

test("limit: a paused thread is NOT resumed while the window is still closed", async () => {
  const h = limitHarness()
  h.storage.upsertSession(row("a"))
  h.tele.set("a", limitTele(sessionFault()))
  const s = h.make()
  await s.tick()
  h.clock.ms = SESSION_RESET_MS - 60_000 // one minute short of the stated reset
  await s.tick()
  assert.deepEqual(h.resumes, [], "resuming before the provider's own reset just re-hits the wall")
  h.storage.close()
})

test("limit: EVERY thread the window cut off is resumed once, with a continue", async () => {
  const h = limitHarness()
  for (const slug of ["a", "b", "c"]) {
    h.storage.upsertSession(row(slug))
    h.tele.set(slug, limitTele(sessionFault()))
  }
  const s = h.make()
  await s.tick()
  h.clock.ms = SESSION_RESET_MS + 61_000 // past the reset + the grace
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.slug).sort(), ["a", "b", "c"], "the whole interrupted fleet picks itself back up")
  for (const r of h.resumes) assert.match(r.message, /session usage limit that interrupted you has reset\. Continue/)
  // Idempotence: the fold clears the fault the moment our continue lands, which is what retires it.
  h.tele.set("a", limitTele(undefined))
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 3, "one wake per interruption, never a second")
  h.storage.close()
})

test("limit: a thread already MOVING again is left alone", async () => {
  const h = limitHarness()
  h.storage.upsertSession(row("a"))
  h.tele.set("a", limitTele(sessionFault(), "in-flight"))
  const s = h.make()
  await s.tick()
  h.clock.ms = SESSION_RESET_MS + 61_000
  await s.tick()
  assert.deepEqual(h.resumes, [], "something else already resumed it; never step on a live turn")
  h.storage.close()
})

test("limit: an ARCHIVED thread is never woken", async () => {
  const h = limitHarness()
  h.storage.upsertSession(row("a", { state: "archived", archived: 1 }))
  h.tele.set("a", limitTele(sessionFault()))
  const s = h.make()
  await s.tick()
  h.clock.ms = SESSION_RESET_MS + 61_000
  await s.tick()
  assert.deepEqual(h.resumes, [])
  h.storage.close()
})

test("limit: BOOT SAFETY — a stale pause from long ago never mass-fires", async () => {
  // A server starting days later replays every transcript from byte zero and sees the old faults. That
  // must not wake a whole fleet at once, long after the operator moved on. The budget runs from when
  // the window came BACK (5h for a session limit) plus the 36h grace, so three days is well past it.
  const h = limitHarness()
  for (const slug of ["a", "b", "c"]) {
    h.storage.upsertSession(row(slug))
    h.tele.set(slug, limitTele(sessionFault()))
  }
  h.clock.ms = Date.parse(SESSION_FAULT_AT) + 3 * 24 * 60 * 60_000
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.deepEqual(h.resumes, [], "an aged-out pause is a human handoff, not an auto-resume")
  h.storage.close()
})

test("limit: a pause from LAST NIGHT is still picked up (the grace is deliberate, not accidental)", async () => {
  // The mirror of the boot guard, and the reason the feature exists: hitting the wall at 3pm and
  // finding the whole fleet still parked next morning is the failure being removed. Asserted so a
  // future tightening of the age constant cannot quietly reintroduce it.
  const h = limitHarness()
  h.storage.upsertSession(row("a"))
  h.tele.set("a", limitTele(sessionFault()))
  const s = h.make()
  await s.tick()
  h.clock.ms = Date.parse(SESSION_FAULT_AT) + 18 * 60 * 60_000
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.slug), ["a"])
  h.storage.close()
})

test("limit: a WEEKLY pause waits for the usage endpoint, and never guesses from its dateless clock", async () => {
  const h = limitHarness()
  const day = 24 * 3_600_000
  const faultAt = "2026-06-24T23:27:13.000Z" // the real weekly stop: 16:27 PDT, reading "resets 4pm"
  const faultMs = Date.parse(faultAt)
  h.clock.ms = faultMs + 1000
  h.storage.upsertSession(row("w"))
  h.tele.set("w", limitTele({ window: "weekly", at: faultAt, resetClock: { hour: 16, minute: 0, timeZone: LA } }))

  // Still inside the fault's own week: the reported window ends 3 days out, so it began 4 days BEFORE
  // the fault. Reading that dateless "4pm" as today's would have fired here — into a dry account.
  let resetsAt = (faultMs + 3 * day) / 1000
  const s = h.make({ readQuota: async () => ({
    claude: { status: "ok" as const, windows: [{ key: "weekly", label: "Weekly", usedPercent: 100, resetsAt }] },
    codex: { status: "unavailable" as const, windows: [] },
  }) })
  await s.tick()
  h.clock.ms = faultMs + day
  await s.tick()
  assert.equal(h.resumes.length, 0, "a dateless weekly clock must never be read as same-day")

  // The week rolls: the reported window now begins an hour AFTER the fault.
  resetsAt = (faultMs + 7 * day + 3_600_000) / 1000
  h.clock.ms = faultMs + 7 * day
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.slug), ["w"])
  assert.match(h.resumes[0].message, /weekly usage limit that interrupted you has reset/)
  h.storage.close()
})

test("limit: a MODEL-scoped pause resolves against the endpoint's scoped weekly window", async () => {
  // The real 2026-08-31 incident shape: "You've reached your Fable 5 limit…" carries no clock and no
  // named window; its live percent and reset instant exist only on the endpoint's `weekly-fable`
  // scoped entry (note the spelling gap — message "Fable 5", key "weekly-fable").
  const h = limitHarness()
  const day = 24 * 3_600_000
  const faultAt = "2026-08-31T17:31:18.427Z"
  const faultMs = Date.parse(faultAt)
  h.clock.ms = faultMs + 1000
  h.storage.upsertSession(row("m"))
  h.tele.set("m", limitTele({ window: "model", at: faultAt, model: "Fable 5" }))

  // Scoped window still near-full inside the same week: no wake in either trigger.
  let scoped = { key: "weekly-fable", label: "Fable wk", usedPercent: 100, resetsAt: (faultMs + 3 * day) / 1000 }
  const s = h.make({ readQuota: async () => ({
    claude: { status: "ok" as const, windows: [
      { key: "5h", label: "5h", usedPercent: 12, resetsAt: (h.clock.ms + 3_600_000) / 1000 },
      { key: "weekly", label: "Weekly", usedPercent: 57, resetsAt: (faultMs + 3 * day) / 1000 },
      scoped,
    ] },
    codex: { status: "unavailable" as const, windows: [] },
  }) })
  await s.tick()
  h.clock.ms = faultMs + 60 * 60_000
  await s.tick()
  assert.equal(h.resumes.length, 0, "a near-full scoped window inside its own week must hold the fleet")

  // The cap FREES (credits bought, cap raised — observed live: 62% within the hour): the headroom
  // trigger reads the SCOPED window's percent, not the global weekly's, and fires once.
  scoped.usedPercent = 62
  h.clock.ms = faultMs + 90 * 60_000
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.slug), ["m"])
  assert.match(h.resumes[0].message, /model usage limit that interrupted you has reset/)
  h.storage.close()
})

// ---- The MODEL-SCOPED cap's OTHER answer: step down a rung rather than wait out the week ----------
// Every case below runs with NO usage endpoint at all, which is the point: a thread that can simply
// change models needs no recovery signal, so none of these may depend on a quota read.

function cappedRow(h: Harness, slug: string, over: Partial<SessionRow>): void {
  h.storage.upsertSession(row(slug, over))
  h.storage.setClaudeRuntime(slug, "broker")
}

test("limit: a MODEL-scoped cap steps the thread down a rung and restarts it immediately", async () => {
  const h = limitHarness()
  const faultAt = "2026-08-31T17:31:18.427Z"
  h.clock.ms = Date.parse(faultAt) + 1000
  cappedRow(h, "m", { model: "fable", effort: "high" })
  h.tele.set("m", limitTele({ window: "model", at: faultAt, model: "Fable 5" }))
  const s = h.make()
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.slug), ["m"], "the account still has capacity — only Fable ran out")
  assert.match(h.resumes[0].message, /The Fable 5 limit that interrupted you is still closed — frizz restarted this thread on Opus\. Continue/)
  const after = h.storage.getSession("m")
  assert.equal(after?.model, "opus", "the cold resume forks from the row, so the new model has to be persisted")
  assert.equal(after?.effort, "high", "the thread's own effort rides across when the target offers it")
  h.storage.close()
})

test("limit: the fallback ladder ENDS — a capped bottom rung waits for its window like any other limit", async () => {
  const h = limitHarness()
  const faultAt = "2026-08-31T17:31:18.427Z"
  h.clock.ms = Date.parse(faultAt) + 1000
  cappedRow(h, "m", { model: "haiku", effort: "medium" })
  h.tele.set("m", limitTele({ window: "model", at: faultAt, model: "Haiku 4.5" }))
  const s = h.make()
  await s.tick()
  h.clock.ms += 2 * 60 * 60_000
  await s.tick()
  assert.deepEqual(h.resumes, [], "nothing left to fall to")
  assert.equal(h.storage.getSession("m")?.model, "haiku")
  h.storage.close()
})

test("limit: a cap on a model this thread is NOT running leaves its profile alone", async () => {
  // A sibling thread — or a sub-agent dispatched onto a model of its own — can exhaust a model this
  // thread never touched. Stepping it down would be a downgrade that buys nothing.
  const h = limitHarness()
  const faultAt = "2026-08-31T17:31:18.427Z"
  h.clock.ms = Date.parse(faultAt) + 1000
  cappedRow(h, "m", { model: "opus", effort: "medium" })
  h.tele.set("m", limitTele({ window: "model", at: faultAt, model: "Fable 5" }))
  const s = h.make()
  await s.tick()
  h.clock.ms += 2 * 60 * 60_000
  await s.tick()
  assert.deepEqual(h.resumes, [])
  assert.equal(h.storage.getSession("m")?.model, "opus")
  h.storage.close()
})

test("limit: a thread with LIVE background work is never restarted onto another model", async () => {
  // The switch only takes effect through a cold fork, and frizz does not kill a live child to restart
  // a thread on its own initiative. Same fail-closed predicate the resume's freshProcess decision uses.
  const h = limitHarness()
  const faultAt = "2026-08-31T17:31:18.427Z"
  h.clock.ms = Date.parse(faultAt) + 1000
  cappedRow(h, "m", { model: "fable", effort: "high" })
  const tele = limitTele({ window: "model", at: faultAt, model: "Fable 5" })
  h.tele.set("m", { ...tele, subAgents: [{ id: "a1", state: "running" } as never] })
  const s = h.make()
  await s.tick()
  assert.deepEqual(h.resumes, [])
  assert.equal(h.storage.getSession("m")?.model, "fable")
  h.storage.close()
})

test("limit: capping the rung below steps down AGAIN, and the walk is what makes it terminate", async () => {
  const h = limitHarness()
  const first = "2026-08-31T17:31:18.427Z"
  h.clock.ms = Date.parse(first) + 1000
  cappedRow(h, "m", { model: "fable", effort: "medium" })
  h.tele.set("m", limitTele({ window: "model", at: first, model: "Fable 5" }))
  const s = h.make()
  await s.tick()
  assert.equal(h.storage.getSession("m")?.model, "opus")

  // The resumed thread caps again on the rung below: a NEW fault, naming a DIFFERENT model, so it is a
  // new interruption rather than the same wall bounced off twice.
  const second = "2026-08-31T18:02:00.000Z"
  h.clock.ms = Date.parse(second) + 1000
  h.tele.set("m", limitTele({ window: "model", at: second, model: "Opus 5" }))
  await s.tick()
  assert.equal(h.storage.getSession("m")?.model, "sonnet")
  assert.deepEqual(h.resumes.map((r) => r.slug), ["m", "m"])
  assert.match(h.resumes[1].message, /The Opus 5 limit .* frizz restarted this thread on Sonnet\./)

  // …and a fault that names a model the thread is no longer on (the switch never took) cannot walk it
  // any further: the guard declines and the thread falls back to waiting.
  const stale = "2026-08-31T18:30:00.000Z"
  h.clock.ms = Date.parse(stale) + 1000
  h.tele.set("m", limitTele({ window: "model", at: stale, model: "Fable 5" }))
  await s.tick()
  assert.equal(h.storage.getSession("m")?.model, "sonnet")
  assert.equal(h.resumes.length, 2)
  h.storage.close()
})

test("limit: a MODEL-scoped pause with NO scoped window on the snapshot holds rather than guessing", async () => {
  // An account whose endpoint reports only 5h + weekly (no scoped entry): both triggers are
  // indeterminate for a model fault, and indeterminate must never resolve to "go".
  const h = limitHarness()
  const faultAt = "2026-08-31T17:31:18.427Z"
  const faultMs = Date.parse(faultAt)
  h.clock.ms = faultMs + 1000
  h.storage.upsertSession(row("m"))
  h.tele.set("m", limitTele({ window: "model", at: faultAt, model: "Fable 5" }))
  const s = h.make({ readQuota: async () => ({
    claude: { status: "ok" as const, windows: [
      { key: "5h", label: "5h", usedPercent: 12, resetsAt: (faultMs + 3_600_000) / 1000 },
      { key: "weekly", label: "Weekly", usedPercent: 20, resetsAt: (faultMs + 3 * 24 * 3_600_000) / 1000 },
    ] },
    codex: { status: "unavailable" as const, windows: [] },
  }) })
  await s.tick()
  h.clock.ms = faultMs + 2 * 60 * 60_000
  await s.tick()
  assert.deepEqual(h.resumes, [], "no scoped window → indeterminate, and the global weekly's headroom must not stand in")
  h.storage.close()
})

test("limit: an unreadable usage endpoint holds the wake rather than guessing", async () => {
  const h = limitHarness()
  const faultAt = "2026-06-24T23:27:13.000Z"
  h.clock.ms = Date.parse(faultAt) + 1000
  h.storage.upsertSession(row("w"))
  h.tele.set("w", limitTele({ window: "weekly", at: faultAt }))
  const s = h.make({ readQuota: async () => { throw new Error("usage endpoint unreachable") } })
  await s.tick()
  h.clock.ms = Date.parse(faultAt) + 8 * 24 * 3_600_000
  await s.tick()
  assert.deepEqual(h.resumes, [], "indeterminate must never resolve to 'go'")
  h.storage.close()
})

test("limit: a session pause with no account headroom still resumes from its own clock", async () => {
  // The account-availability trigger consults the (cheap, cached) snapshot for a session limit too, but
  // an uninformative/unavailable reading must never BLOCK the reliable text-clock resume.
  const h = limitHarness()
  h.storage.upsertSession(row("a"))
  h.tele.set("a", limitTele(sessionFault()))
  const s = h.make({ readQuota: async () =>
    ({ claude: { status: "unavailable" as const, windows: [] }, codex: { status: "unavailable" as const, windows: [] } }) })
  await s.tick()
  h.clock.ms = SESSION_RESET_MS + 61_000
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.slug), ["a"], "the message's own clock still answers when quota can't")
  h.storage.close()
})

test("limit: account headroom on the blown window resumes a session pause BEFORE its own clock", async () => {
  // The account-switch / raised-cap case: quota freed up on the signed-in account while the original
  // 17:50 reset is still hours away. The paused thread should pick itself back up without waiting.
  const h = limitHarness()
  h.storage.upsertSession(row("a"))
  h.tele.set("a", limitTele(sessionFault()))
  const s = h.make({ readQuota: async () => ({
    claude: { status: "ok" as const, windows: [{ key: "5h", label: "5h", usedPercent: 20, resetsAt: (Date.parse(SESSION_FAULT_AT) + 3_600_000) / 1000 }] },
    codex: { status: "unavailable" as const, windows: [] },
  }) })
  await s.tick() // fault ~1s old: younger than the min-age, so a reading that could predate the fault is NOT trusted
  assert.equal(h.resumes.length, 0, "a reading that might predate the fault must not resume into the wall it came from")
  h.clock.ms = Date.parse(SESSION_FAULT_AT) + 3 * 60_000 // past the 2-min min-age, still hours before 17:50
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.slug), ["a"], "freed-up quota resumes without waiting for the original clock")
  h.storage.close()
})

test("limit: a still-near-full window does NOT trigger the account-availability resume", async () => {
  // Jitter near 100% must never fire the headroom trigger — that would resume the fleet straight back
  // into the wall. Only a drop below the floor counts.
  const h = limitHarness()
  h.storage.upsertSession(row("a"))
  h.tele.set("a", limitTele(sessionFault()))
  const s = h.make({ readQuota: async () => ({
    claude: { status: "ok" as const, windows: [{ key: "5h", label: "5h", usedPercent: 90, resetsAt: (Date.parse(SESSION_FAULT_AT) + 3_600_000) / 1000 }] },
    codex: { status: "unavailable" as const, windows: [] },
  }) })
  await s.tick()
  h.clock.ms = Date.parse(SESSION_FAULT_AT) + 5 * 60_000 // well past the min-age, still before the 17:50 clock
  await s.tick()
  assert.deepEqual(h.resumes, [], "90% used is not headroom — no early resume; it waits for the real reset")
  h.storage.close()
})

test("limit: the early resume is spent ONCE per wall — bouncing off it does not re-fire forever", async () => {
  // The 2026-07-30 incident, reproduced. An early (headroom) resume lands in a process that is still
  // latched on its own 429, so it bounces: a NEW fault, a later `at`, the SAME 17:50 wall. The account
  // still reads healthy, so nothing in the headroom trigger's own premise has changed — which is how
  // this ran every 2 minutes for half an hour and wrote 184 limit records into one transcript.
  const h = limitHarness()
  h.storage.upsertSession(row("a"))
  h.tele.set("a", limitTele(sessionFault()))
  const healthyAccount = async () => ({
    claude: { status: "ok" as const, windows: [{ key: "5h", label: "5h", usedPercent: 1, resetsAt: (Date.parse(SESSION_FAULT_AT) + 3_600_000) / 1000 }] },
    codex: { status: "unavailable" as const, windows: [] },
  })
  const s = h.make({ readQuota: healthyAccount })
  h.clock.ms = Date.parse(SESSION_FAULT_AT) + 3 * 60_000
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.slug), ["a"], "the one early attempt still happens")

  // It bounced. Same wall, new fault record — exactly what the tailer folds when the latched process
  // answers the wake with another synthetic 429.
  for (let bounce = 1; bounce <= 5; bounce++) {
    const at = new Date(Date.parse(SESSION_FAULT_AT) + bounce * 2 * 60_000 + 3 * 60_000).toISOString()
    h.tele.set("a", limitTele({ window: "session", at, resetClock: { hour: 17, minute: 50, timeZone: LA } }))
    h.clock.ms = Date.parse(at) + 3 * 60_000
    await s.tick()
  }
  assert.equal(h.resumes.length, 1, "every later bounce off the SAME wall must be ignored, not re-woken")

  // The wall itself is what clears it: once the provider's own reset passes, trigger (1) fires and the
  // thread resumes normally. The guard must never turn into a permanent block.
  h.clock.ms = SESSION_RESET_MS + 2 * 60_000
  await s.tick()
  assert.equal(h.resumes.length, 2, "past its stated reset the thread resumes on its own clock")
  h.storage.close()
})

test("limit: a limit wake and a timer wake for the same session get distinct deliveries", async () => {
  // Both sources share one outbox. If their identities could collide, arming one would silently
  // swallow the other's wake for that session.
  //
  // BOTH SOURCES MUST ACTUALLY FIRE or the uniqueness check below is vacuous — a set of one id is
  // always "distinct". This armed off an `awaiting timer:` fence hint until 2026-08-16, which had been
  // inert since the 2026-08-15 grammar cut hardwired fence hints off, AND whose target sat 5min past a
  // clock that only ever reached +61s. So it asserted uniqueness over the limit wake alone, under a name
  // promising a collision it could not exercise. A real timer row, due INSIDE the window the clock
  // crosses, is what makes the two sources collide — the same vehicle its snooze sibling uses.
  const h = limitHarness()
  h.storage.upsertSession(row("a"))
  const target = SESSION_RESET_MS + 30_000
  armTimer(h, "a", target, "re-check")
  h.tele.set("a", limitTele(sessionFault()))
  const s = h.make()
  await s.tick() // neither is due: the limit is still closed and the timer has not been crossed
  h.clock.ms = SESSION_RESET_MS + 61_000
  await s.tick() // the limit resets and the timer comes due in the same pass
  // ONE TURN for both (2026-09-03): the two sources still mint two rows, and the merge folds the second
  // into the first's delivery — see "coalesce" below. The uniqueness check is over the ROWS.
  assert.deepEqual(h.resumes.map((r) => r.slug), ["a"], "one thread, both sources, one delivery")
  assert.match(h.resumes[0].message, /usage limit/)
  assert.match(h.resumes[0].message, /re-check/, "the timer's text rides in the same delivery")
  const rows = createWakeDeliveryStore(h.storage.scope).list()
  const ids = rows.map((d) => d.id)
  assert.equal(ids.length, 2, "both sources armed their own wake for this session")
  assert.equal(new Set(ids).size, ids.length, "no delivery-id collision between the two wake sources")
  assert.deepEqual(rows.map((d) => d.state), ["delivered", "delivered"], "both rows reach their own terminal state")
  h.storage.close()
})

// ---- SOURCE 3: the user snooze --------------------------------------------------------------------

// A snooze that carries a prompt is the human's own `awaiting timer:` — park until an instant, then
// resume with a message. These lock down that it rides the SAME outbox, delivers the prompt verbatim,
// and settles the row that armed it.

function snoozeRow(slug: string, until: string, prompt: string | null): SessionRow {
  return row(slug, { snoozed_until: until, snooze_prompt: prompt })
}

test("snooze: a due prompt-carrying snooze bumps the thread with the prompt VERBATIM, exactly once", async () => {
  const h = harness()
  const until = iso(h.clock.ms + 60_000)
  h.storage.upsertSession(snoozeRow("s", until, "Check whether CI went green and land it if so."))
  h.tele.set("s", tele())
  const s = h.make()
  await s.tick()
  assert.equal(h.resumes.length, 0, "a snooze still in the future must not fire")

  h.clock.ms = Date.parse(until)
  await s.tick()
  await s.tick() // must not double-bump
  assert.deepEqual(h.resumes.map((r) => r.slug), ["s"])
  // No "⏰ your snooze fired" preamble: the human scheduled a turn, so the worker receives that turn.
  assert.equal(h.resumes[0].message, "Check whether CI went green and land it if so.")
  // The row that armed the bump is settled by the delivery, so nothing re-arms on the next tick.
  assert.equal(h.storage.getSession("s")?.snoozed_until, null)
  assert.equal(h.storage.getSession("s")?.snooze_prompt, null)
  h.storage.close()
})

test("snooze: a snooze WITHOUT a prompt never wakes the agent (it is a reminder the board owns)", async () => {
  const h = harness()
  const until = iso(h.clock.ms + 60_000)
  h.storage.upsertSession(snoozeRow("s", until, null))
  h.tele.set("s", tele())
  const s = h.make()
  h.clock.ms = Date.parse(until) + 60_000
  await s.tick()
  assert.deepEqual(h.resumes, [], "the historical snooze only re-surfaces the card")
  h.storage.close()
})

test("snooze: an OVERDUE snooze found at boot does fire — unlike an unregistered timer fence", async () => {
  // The deliberate divergence from the boot-mass-fire guard. A fence hint is only a claim in a
  // transcript, so an already-past one is untrustworthy; a snooze row is an explicit durable promise
  // the human made, so a deadline that crossed while frizz was down is exactly what it is FOR.
  const h = harness()
  h.storage.upsertSession(snoozeRow("s", iso(h.clock.ms - 3 * 3_600_000), "Pick this back up."))
  h.tele.set("s", tele())
  const s = h.make()
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.message), ["Pick this back up."])
  h.storage.close()
})

test("snooze: waking now before delivery supersedes the queued bump", async () => {
  const h = harness()
  const until = iso(h.clock.ms + 60_000)
  h.storage.upsertSession(snoozeRow("s", until, "stale follow-up"))
  h.tele.set("s", tele(undefined, "in-flight")) // busy → enqueued, but delivery defers
  const s = h.make()
  h.clock.ms = Date.parse(until)
  await s.tick()
  assert.deepEqual(h.resumes, [], "a mid-turn thread is not stepped on")

  h.storage.setSnoozedUntil("s", null) // the human hit "Wake now" (or sent a follow-up)
  h.tele.set("s", tele())
  await s.tick()
  assert.deepEqual(h.resumes, [], "the human already said something newer than the message we held")
  assert.equal(createWakeDeliveryStore(h.storage.scope).list()[0]?.state, "superseded")
  h.storage.close()
})

test("snooze: re-snoozing before delivery keeps the NEW deadline and mints its own bump", async () => {
  const h = harness()
  const first = iso(h.clock.ms + 60_000)
  h.storage.upsertSession(snoozeRow("s", first, "old prompt"))
  h.tele.set("s", tele(undefined, "in-flight"))
  const s = h.make()
  h.clock.ms = Date.parse(first)
  await s.tick() // enqueued, undeliverable (busy)

  const second = iso(h.clock.ms + 3_600_000)
  h.storage.setSnoozedUntil("s", second, "new prompt")
  h.tele.set("s", tele())
  await s.tick()
  assert.equal(h.resumes.length, 0, "the superseded bump must not deliver")
  assert.equal(h.storage.getSession("s")?.snoozed_until, second, "settling the stale wake must not erase the fresh snooze")

  h.clock.ms = Date.parse(second)
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.message), ["new prompt"])
  h.storage.close()
})

test("snooze: a bump that comes due mid-turn is HELD, then delivered once the thread rests", async () => {
  const h = harness()
  const until = iso(h.clock.ms + 60_000)
  h.storage.upsertSession(snoozeRow("s", until, "resume the audit"))
  h.tele.set("s", tele(undefined, "in-flight"))
  const s = h.make()
  h.clock.ms = Date.parse(until)
  await s.tick()
  assert.equal(h.resumes.length, 0)

  h.tele.set("s", tele()) // comes to rest
  h.clock.ms += 60_000
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.message), ["resume the audit"], "a deadline crossed mid-turn is owed, not dropped")
  h.storage.close()
})

test("snooze: an archived thread never bumps", async () => {
  const h = harness()
  const until = iso(h.clock.ms - 60_000)
  h.storage.upsertSession(row("s", { snoozed_until: until, snooze_prompt: "nope", state: "archived", archived: 1 }))
  h.tele.set("s", tele())
  const s = h.make()
  await s.tick()
  assert.deepEqual(h.resumes, [])
  h.storage.close()
})

test("snooze: a snooze wake and a timer wake for the same session get distinct deliveries", async () => {
  const h = harness()
  const target = h.clock.ms + 30_000
  h.storage.upsertSession(snoozeRow("s", iso(target), "snooze prompt"))
  armTimer(h, "s", target, "re-check")
  h.tele.set("s", tele())
  const s = h.make()
  await s.tick() // neither source is due yet
  h.clock.ms = target + 1000
  await s.tick()
  const ids = createWakeDeliveryStore(h.storage.scope).list().map((d) => d.id)
  assert.equal(new Set(ids).size, ids.length, "no delivery-id collision between the snooze and timer sources")
  assert.equal(ids.length, 2, "both sources armed their own wake for this session")
  h.storage.close()
})

// A resume that fails ASYNCHRONOUSLY must retry exactly like one that throws synchronously.
//
// This is the codex-wake shape. context.ts delivers a codex wake over the app-server bridge, which is
// inherently async, and it used to run that work in a DETACHED IIFE (`void (async () => …)().catch(…)`)
// and return undefined immediately. The scheduler awaits `resume`, so it saw an instant success and
// ACKED the delivery; the real bridge failure landed seconds later into a bare `.catch` and vanished —
// no log, no retry, the wake lost forever. Claude's synchronous `resumeThread` throws straight into the
// scheduler's catch and retries, so the bug was CODEX-ONLY and silent: a timer or limit-auto-resume
// codex thread could simply never wake.
//
// Returning the promise is the whole fix, and this test is what keeps it returned: revert to
// fire-and-forget and the rejection never reaches the scheduler, so no retry happens and this fails.
test("a resume that REJECTS asynchronously is retried, exactly like a synchronous throw", async () => {
  const h = harness()
  const { target } = dueTimer(h, "async-wake")
  h.clock.ms = target + 1_000

  let attempts = 0
  const failing = h.make({
    resume: () => {
      attempts++
      // No `throw` — an already-rejected promise, which is what an async bridge delivery produces.
      return Promise.reject(new Error("codex app-server bridge unavailable"))
    },
  })
  await failing.tick()
  assert.equal(attempts, 1, "the due wake was attempted")
  assert.equal(h.resumes.length, 0, "and it did not count as delivered")

  // The lease expires, and a later generation redelivers it — proving the failure was never ACKed.
  h.clock.ms += 30_001
  const restarted = h.make({
    resume: (slug, message) => {
      attempts++
      h.resumes.push({ slug, message })
    },
  })
  await restarted.tick()
  await restarted.tick()
  assert.equal(attempts, 2, "the async rejection was retried, not swallowed")
  assert.equal(h.resumes.length, 1, "and the retry delivered exactly once")
})

// CI TRANSITIONS WAKE EVERY TIME, IN BOTH DIRECTIONS — maintainer 2026-08-15, asked as "every time".
//
// One registration covers the whole life of the PR: red, a fix, green, a break, green again. Each of
// those is news the worker acts on, and a watcher that reported only the first would be worse than
// useless — the agent that pushed a fix would never learn whether it worked. The cursor holds the last
// TERMINAL verdict, so what fires is the CHANGE, never the repetition: polling green twice is silence.
test("pr-watch: CI wakes on every terminal transition, both directions, and never on a repeat", async () => {
  const h = harness()
  h.watch("r", "acme/app#7")
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr", value: "acme/app#7" }])), lastActivityAt: iso(h.clock.ms) })
  h.review.result = []

  const poll = async (checks: "passing" | "failing") => {
    h.clock.ms += 10 * 60_000
    h.pr.result = {
      state: "OPEN",
      mergedAt: null,
      rollup: checks === "passing"
        ? [{ __typename: "CheckRun", name: "ci", conclusion: "SUCCESS", status: "COMPLETED" }]
        : [{ __typename: "CheckRun", name: "ci", conclusion: "FAILURE", status: "COMPLETED" }],
    } as unknown as PrStatus
    const s = h.make()
    await s.tick()
    await s.tick()
  }

  await poll("failing")
  assert.equal(h.resumes.length, 1, "red is news")
  await poll("failing")
  assert.equal(h.resumes.length, 1, "…still red is not")
  await poll("passing")
  assert.equal(h.resumes.length, 2, "the fix landing is news — this is the one a worker is waiting for")
  await poll("passing")
  assert.equal(h.resumes.length, 2, "…still green is not")
  await poll("failing")
  assert.equal(h.resumes.length, 3, "and breaking again is news, from the SAME registration")
})

// ---- SENT IS NOT DELIVERED (2026-08-25) ----
// A broker wake is a socket frame with no reply. Reproduced against a real daemon in
// scripts/verify-prwatch-wake-cold-resume.mjs: a thread parked on a PR watcher, its idle daemon long
// since hibernated, the wake cold-resumes a `claude` that dies at startup — and the outbox filed the
// wake as delivered the instant `resume` returned, while the PR-watch cursor had already moved past
// the event. The worker sat 12h+ on a watcher that had "fired". These pin the scheduler half: with a
// runtime probe wired, a wake is SENT, and only the transcript token, the runtime's survival past the
// grace, or a dead runtime's retry can move it on.
function sentHarness(runtime: () => "alive" | "dead" | "unknown", over: Partial<Parameters<typeof createScheduler>[0]> = {}) {
  const h = harness()
  const { target } = dueTimer(h, "sent")
  const s = h.make({ wakeRuntimeState: runtime, confirmGraceMs: 1_000, retryBaseMs: 100, retryMaxMs: 100, ...over })
  const store = createWakeDeliveryStore(h.storage.scope)
  return { h, s, target, store, row: () => store.list()[0] }
}

test("sent-not-delivered: a wake whose process is still alive after the grace is delivered — and not before", async () => {
  const { h, s, target, row } = sentHarness(() => "alive")
  await s.tick()
  h.clock.ms = target + 1
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.equal(row().state, "leased", "the socket write is SENT, not delivered")
  assert.ok(row().sentAt !== null)
  h.clock.ms += 500
  await s.tick()
  assert.equal(row().state, "leased", "still inside the confirmation window")
  h.clock.ms += 600
  await s.tick()
  assert.equal(row().state, "delivered")
  assert.equal(h.resumes.length, 1, "a confirmed wake is never re-sent")
})

test("sent-not-delivered: the transcript token confirms a wake before the grace, even if the process then died", async () => {
  const { h, s, target, row } = sentHarness(() => "dead")
  await s.tick()
  h.clock.ms = target + 1
  await s.tick()
  assert.equal(row().state, "leased")
  // The worker read it: its transcript carries the token the delivery appended.
  h.tele.set("sent", { ...tele(), lastActivityAt: iso(h.clock.ms), lastUserText: `Wake sent.\n\n${wakeDeliveryToken(row().id)}` })
  h.clock.ms += 100
  await s.tick()
  assert.equal(row().state, "delivered")
  assert.equal(h.resumes.length, 1)
})

test("sent-not-delivered: a wake whose process died with no token goes round again, and lands once the process lives", async () => {
  let alive = false
  const logs: string[] = []
  const { h, s, target, row } = sentHarness(() => (alive ? "alive" : "dead"), { log: (m) => logs.push(m) })
  await s.tick()
  h.clock.ms = target + 1
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.equal(row().state, "leased")
  // The grace closes on a corpse: the frame died with it.
  h.clock.ms += 1_100
  await s.tick()
  assert.equal(row().state, "pending", "a lost wake is re-opened, not filed")
  assert.equal(row().attempts, 1)
  assert.match(row().lastError ?? "", /process died before it read this wake/)
  assert.ok(logs.some((m) => /wake LOST for sent/.test(m)), "the loss is SAID")
  // The retry: a second send, on a process that this time survives.
  alive = true
  h.clock.ms += 200
  await s.tick()
  assert.equal(h.resumes.length, 2, "sent again")
  assert.equal(row().attempts, 2)
  h.clock.ms += 1_100
  await s.tick()
  assert.equal(row().state, "delivered")
  assert.equal(row().attempts, 2)
  assert.ok(logs.some((m) => /delivered sent — .*on attempt 2/.test(m)))
})

test("sent-not-delivered: a process that never survives exhausts the attempt cap out loud", async () => {
  const logs: string[] = []
  const { h, s, target, row } = sentHarness(() => "dead", { maxDeliveryAttempts: 2, log: (m) => logs.push(m) })
  await s.tick()
  h.clock.ms = target + 1
  for (let i = 0; i < 6; i++) { await s.tick(); h.clock.ms += 1_200 }
  assert.equal(row().state, "exhausted")
  assert.equal(row().attempts, 2)
  assert.equal(h.resumes.length, 2)
  assert.ok(logs.some((m) => /delivery EXHAUSTED for sent after 2 attempts/.test(m)))
})

test("sent-not-delivered: a busy thread holds a lost wake rather than re-sending into a running turn", async () => {
  const { h, s, target, row } = sentHarness(() => "dead")
  await s.tick()
  h.clock.ms = target + 1
  await s.tick()
  h.tele.set("sent", { ...tele(undefined, "in-flight"), lastActivityAt: iso(h.clock.ms) })
  h.clock.ms += 1_100
  await s.tick()
  assert.equal(row().state, "leased", "held while the thread is busy")
  assert.equal(h.resumes.length, 1)
  h.tele.set("sent", { ...tele(), lastActivityAt: iso(h.clock.ms) })
  await s.tick()
  assert.equal(row().state, "pending", "released for retry once the thread is idle")
})

test("sent-not-delivered: without a runtime probe a wake is delivered on return, exactly as before", async () => {
  const { h, s, target, row } = sentHarness(() => "unknown")
  await s.tick()
  h.clock.ms = target + 1
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.equal(row().state, "delivered")
  assert.equal(row().sentAt, null)
})

// ---- A STATUS POLL THAT CANNOT READ THE PR IS SAID (2026-08-25) ----
// `defaultFetchPr` returned undefined for every `gh` failure until this date, so a PR the server could
// not read (signed out, SSO, no such repo, no `gh` on the PATH) was indistinguishable from a quiet one.
// It now throws gh's own reason, and the poll logs it once per distinct failure, counts the repeats,
// and says when it recovers — the review check's rule, applied to its twin.
test("pr-watch: a failing status fetch is logged once with its reason, repeats are counted, recovery is said", async () => {
  const h = harness()
  const logs: string[] = []
  h.watch("s", "acme/app#7")
  h.storage.upsertSession(row("s"))
  h.tele.set("s", { ...tele(), lastActivityAt: iso(h.clock.ms) })
  h.review.result = []
  let fail = true
  const s = h.make({
    log: (m) => logs.push(m),
    fetchPr: async () => { if (fail) throw new Error("Could not resolve to a Repository with the name 'acme/app'. (repository)"); return { state: "OPEN", mergedAt: null, rollup: [], head: "abc" } },
  })
  const failures = () => logs.filter((m) => m.includes("PR status check failed for acme/app#7"))
  await s.tick()
  assert.equal(failures().length, 1)
  assert.match(failures()[0], /Could not resolve to a Repository/)
  assert.match(failures()[0], /CI and merge wakes cannot fire/)
  for (let i = 0; i < 3; i++) { h.clock.ms += 61_000; await s.tick() }
  assert.equal(failures().length, 1, "identical repeats are suppressed")
  fail = false
  h.clock.ms += 61_000
  await s.tick()
  const recovered = logs.find((m) => m.includes("PR status check recovered for acme/app#7"))
  assert.ok(recovered, "recovery is said")
  assert.match(recovered!, /3 identical repeats were suppressed/)
  assert.equal(h.resumes.length, 0, "a PR with nothing to report still wakes nobody")
})

test("question: on an AUTONOMOUS thread a cancellation wakes on its own — nothing else will carry it", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  askQ(h, "t", "qst_gone", "Which store?")
  // The Goal is autonomous mode; there is no separate switch (see router.ask.test.ts). Its arming is
  // what cancelled the question in the first place — this is the other half of that flip.
  h.storage.setRecurringPromptBySlug("t", {
    prompt: "Keep going. Make decisions autonomously.", stopHook: true, heartbeat: false,
    postCompaction: false, intervalMs: null, armedAt: new Date(h.clock.ms).toISOString(),
  })
  h.tele.set("t", tele())
  const s = h.make()

  h.storage.dismissThreadQuestion("qst_gone", h.clock.ms)
  await s.tick()
  // "It rides the next steer" is a promise nothing keeps on a thread whose whole premise is that nobody
  // is about to send it anything — so without this the worker would simply never learn that a question
  // it is still waiting on has been taken away from it.
  assert.equal(h.resumes.length, 1)
  // And it is NOT worded as an answer: nobody replied, and telling an autonomous worker the human did
  // would be the one thing worse than silence.
  assert.match(h.resumes[0].message, /1 question you registered was CANCELLED without an answer/)
  assert.doesNotMatch(h.resumes[0].message, /Answers to the questions you registered/)
  assert.equal(h.storage.getThreadQuestion("qst_gone")?.delivered, 1)
})

test("question: an armed Goal with NO TEXT does not make a dismissal wake — there is no instruction", async () => {
  const h = harness()
  h.storage.upsertSession(row("t"))
  askQ(h, "t", "qst_gone", "Which store?")
  h.storage.setRecurringPromptBySlug("t", {
    prompt: null, stopHook: true, heartbeat: false, postCompaction: false, intervalMs: null,
    armedAt: new Date(h.clock.ms).toISOString(),
  })
  h.tele.set("t", tele())
  const s = h.make()
  h.storage.dismissThreadQuestion("qst_gone", h.clock.ms)
  await s.tick()
  assert.equal(h.resumes.length, 0, "an empty Goal is not autonomy, so the ordinary rule holds")
})

// ---- ONE UNDELIVERED REPORT PER WATCHER (2026-08-28) ----
//
// A PR report is not deliverable mid-turn, so a watcher whose PR kept moving while its thread worked
// minted one per poll and the outbox held them all — eleven were handed to one thread within two
// seconds the moment it rested (`yeah-we-definitely-don-t-do-enough`, 2026-08-27 00:53), three of them
// "CI FAILED" with job lists the later ones had already replaced. The same stale-second-wake shape as
// the Goal after the sign-off nudge. Now a poll that finds a report still waiting mints nothing and
// holds the cursor, so the report after delivery carries everything since.
const reportsOf = (h: Harness, slug: string) => h.storage.db
  .prepare("SELECT fence_id, state, sent_at FROM wake_delivery WHERE thread_slug = ? AND fence_id LIKE 'prwatch:%' ORDER BY created_at")
  .all(slug) as { fence_id: string; state: string; sent_at: number | null }[]

test("pr-watch: reports do not pile up behind a busy thread — the waiting report is RE-MINTED with everything since the last one read, and goes out once", async () => {
  const h = harness()
  h.watch("r", "acme/app#7")
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(undefined, "in-flight"), lastAssistantAt: iso(h.clock.ms) })
  h.review.result = []
  const s = h.make()
  await s.tick() // the baseline poll
  assert.equal(h.resumes.length, 0)

  // alice comments while the thread is mid-turn: report #1 is minted and held.
  h.clock.ms += 60_000
  const c1: GithubReviewActivity = { id: "comment:c1", actor: "alice", at: iso(h.clock.ms), kind: "comment" }
  h.review.result = [c1]
  await s.tick()
  assert.equal(h.resumes.length, 0, "not deliverable mid-turn")
  assert.equal(reportsOf(h, "r").length, 1)

  // bob comments while #1 still waits: #1 is superseded and #2 says alice AND bob — one undelivered
  // report per watcher, saying everything since the last one the worker read. (Until 2026-09-03 the
  // poll held the cursor instead, and bob followed as his own report, a second turn.)
  h.clock.ms += 60_000
  const c2: GithubReviewActivity = { id: "comment:c2", actor: "bob", at: iso(h.clock.ms), kind: "comment" }
  h.review.result = [c1, c2]
  await s.tick()
  assert.deepEqual(reportsOf(h, "r").map((r) => r.state), ["superseded", "leased"], "the waiting report is replaced, not joined")
  const open = createWakeDeliveryStore(h.storage.scope).listOpen()
  assert.equal(open.length, 1, "one undelivered report per watcher")
  assert.match(open[0].message, /alice/)
  assert.match(open[0].message, /bob/)
  assert.ok(open[0].message.indexOf("alice") < open[0].message.indexOf("bob"), "in the order the conversation was written")
  assert.equal(h.resumes.length, 0)

  // The thread rests, parked on the PR as a PR-watching worker does: the ONE report goes out.
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr", value: "acme/app#7" }])), lastAssistantAt: iso(h.clock.ms) })
  h.clock.ms += 60_000
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /alice/)
  assert.match(h.resumes[0].message, /bob/)

  // The next poll has nothing new: no report, nothing said twice.
  h.clock.ms += 60_000
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.equal(reportsOf(h, "r").length, 2)

  // And carol, after delivery, is her own report measured from what was sent — alice and bob are not
  // repeated.
  h.clock.ms += 60_000
  const c3: GithubReviewActivity = { id: "comment:c3", actor: "carol", at: iso(h.clock.ms), kind: "comment" }
  h.review.result = [c1, c2, c3]
  await s.tick()
  assert.equal(h.resumes.length, 2)
  assert.match(h.resumes[1].message, /carol/)
  assert.doesNotMatch(h.resumes[1].message, /alice|bob/)
})

test("pr-watch: a red report waiting is replaced by the green one on the new head — the worker hears the LATEST verdict, not red then green", async () => {
  const h = harness()
  h.watch("r", "acme/app#7")
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(undefined, "in-flight"), lastAssistantAt: iso(h.clock.ms) })
  h.review.result = []
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }], head: "abc" }
  const s = h.make()
  await s.tick() // baseline: CI green — which a fresh watcher announces, so report #1 (passing) waits
  assert.equal(reportsOf(h, "r").length, 1)

  // CI goes red on abc mid-turn: #1 is replaced by #2 (failing).
  h.clock.ms += 60_000
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [{ name: "unit", status: "COMPLETED", conclusion: "FAILURE" }], head: "abc" }
  await s.tick()
  assert.deepEqual(reportsOf(h, "r").map((r) => r.state), ["superseded", "leased"])
  assert.match(createWakeDeliveryStore(h.storage.scope).listOpen()[0].message, /CI FAILED/)

  // A push, and CI goes green on the new head while #2 still waits, with a review alongside: #3 says
  // green AND the review; the red verdict it replaces is not news any more.
  h.clock.ms += 60_000
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }], head: "def" }
  h.review.result = [{ id: "review:r1", actor: "alice", at: iso(h.clock.ms), kind: "review", reviewState: "APPROVED" }]
  await s.tick()
  assert.deepEqual(reportsOf(h, "r").map((r) => r.state), ["superseded", "superseded", "leased"])

  h.tele.set("r", { ...tele(awaiting([{ kind: "pr", value: "acme/app#7" }])), lastAssistantAt: iso(h.clock.ms) })
  h.clock.ms += 60_000
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /CI PASSED/)
  assert.doesNotMatch(h.resumes[0].message, /CI FAILED/)
  assert.match(h.resumes[0].message, /approval/)
})

test("pr-watch: a report minted BEFORE the re-mint existed is held the old way until it is sent", async () => {
  const h = harness()
  h.watch("r", "acme/app#7")
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(undefined, "in-flight"), lastAssistantAt: iso(h.clock.ms) })
  h.review.result = []
  const s = h.make()
  await s.tick()
  h.clock.ms += 60_000
  const c1: GithubReviewActivity = { id: "comment:c1", actor: "alice", at: iso(h.clock.ms), kind: "comment" }
  h.review.result = [c1]
  await s.tick()
  assert.equal(reportsOf(h, "r").length, 1)
  // A pre-upgrade cursor: what it says is not carried structurally, so it cannot be folded forward.
  const watch = h.storage.listPrWatches("r")[0]
  const cursor = JSON.parse(watch.cursor ?? "{}")
  delete cursor.held
  h.storage.setPrWatchCursor(watch.id, JSON.stringify(cursor))

  h.clock.ms += 60_000
  h.review.result = [c1, { id: "comment:c2", actor: "bob", at: iso(h.clock.ms), kind: "comment" }]
  await s.tick()
  assert.equal(reportsOf(h, "r").length, 1, "held: no second report, no supersession")
  assert.equal(h.storage.listPrWatches("r")[0].cursor, JSON.stringify(cursor), "and no cursor write, so bob is measured after delivery")

  h.tele.set("r", { ...tele(awaiting([{ kind: "pr", value: "acme/app#7" }])), lastAssistantAt: iso(h.clock.ms) })
  h.clock.ms += 60_000
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /alice/)
  assert.doesNotMatch(h.resumes[0].message, /bob/)
  h.clock.ms += 60_000
  await s.tick()
  assert.equal(h.resumes.length, 2, "the held delta follows, as its own report")
  assert.match(h.resumes[1].message, /bob/)
})

// ---- A VERDICT BELONGS TO ONE COMMIT (2026-11-06) ----
//
// The maintainer asked for "freshness checking on the CI watcher cards": a report waits up to
// MID_TURN_HOLD_MAX_MS behind a busy thread, and in those minutes the worker is usually pushing the fix
// for the very failure the report names. These drive the path a worker walks: red on one head, a push, and
// a rest. Each asserts on what the worker is finally handed, because that is what used to be wrong.
const RED = (head: string) => ({ state: "OPEN", mergedAt: null, rollup: [{ name: "lint", status: "COMPLETED", conclusion: "FAILURE" }], head })
const GREEN = (head: string) => ({ state: "OPEN", mergedAt: null, rollup: [{ name: "lint", status: "COMPLETED", conclusion: "SUCCESS" }], head })
const RUNNING = (head: string) => ({ state: "OPEN", mergedAt: null, rollup: [{ name: "lint", status: "IN_PROGRESS" }], head })
const OLD_HEAD = "aaaaaaa1111111"
const NEW_HEAD = "bbbbbbb2222222"
const busy = (h: Harness, slug: string) => h.tele.set(slug, { ...tele(undefined, "in-flight"), lastAssistantAt: iso(h.clock.ms) })
const rest = (h: Harness, slug: string) => h.tele.set(slug, { ...tele(awaiting([{ kind: "pr", value: "acme/app#7" }])), lastAssistantAt: iso(h.clock.ms) })
const openReports = (h: Harness) => createWakeDeliveryStore(h.storage.scope).listOpen().filter((d) => d.fenceId.startsWith("prwatch:"))

test("pr-watch: a red report still waiting is RETRACTED once a poll sees a newer head — the worker is not told its old commit failed", async () => {
  const h = harness()
  h.watch("r", "acme/app#7")
  h.storage.upsertSession(row("r"))
  busy(h, "r")
  h.review.result = []
  h.pr.result = RED(OLD_HEAD)
  const s = h.make()
  await s.tick()
  assert.match(openReports(h)[0].message, /CI FAILED on acme\/app#7 at aaaaaaa: lint\./, "the verdict names its commit")

  // The worker pushes the fix. The new head's checks are only running, so nothing is news.
  h.clock.ms += 60_000
  h.pr.result = RUNNING(NEW_HEAD)
  await s.tick()
  assert.equal(openReports(h).length, 0, "nothing is left to deliver")
  assert.deepEqual(reportsOf(h, "r").map((r) => r.state), ["superseded"], "retracted, and nothing minted in its place")

  rest(h, "r")
  h.clock.ms += 15 * 60_000
  await s.tick()
  assert.equal(h.resumes.filter((r) => /CI FAILED/.test(r.message)).length, 0, "the old verdict never goes out")

  // The new commit's verdict is reported when it settles, as ever.
  h.pr.result = GREEN(NEW_HEAD)
  h.clock.ms += 60_000
  await s.tick()
  h.clock.ms += 15 * 60_000
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /CI PASSED on acme\/app#7 at bbbbbbb — 1 check green\./)
})

test("pr-watch: a report that also carries a review is RE-MINTED without the old verdict, and says the review once", async () => {
  const h = harness()
  h.watch("r", "acme/app#7")
  h.storage.upsertSession(row("r"))
  busy(h, "r")
  h.review.result = []
  h.pr.result = GREEN(OLD_HEAD)
  const s = h.make()
  await s.tick()
  h.clock.ms += 60_000
  h.pr.result = RED(OLD_HEAD)
  h.review.result = [{ id: "c1", actor: "alice", at: iso(h.clock.ms), kind: "comment" }]
  await s.tick()
  assert.match(openReports(h)[0].message, /CI FAILED/)
  assert.match(openReports(h)[0].message, /alice/)

  // The push, with nothing else new: the review the waiting report carries is still owed.
  h.clock.ms += 60_000
  h.pr.result = RUNNING(NEW_HEAD)
  await s.tick()
  const open = openReports(h)
  assert.equal(open.length, 1, "one report still waits")
  assert.doesNotMatch(open[0].message, /CI FAILED/, "without the verdict about the replaced commit")
  assert.match(open[0].message, /alice/, "and with the review")

  // A comment arriving next folds forward what is left, and must not bring the verdict back with it.
  h.clock.ms += 60_000
  h.review.result = [
    { id: "c1", actor: "alice", at: iso(h.clock.ms - 120_000), kind: "comment" },
    { id: "c2", actor: "bob", at: iso(h.clock.ms), kind: "comment" },
  ]
  await s.tick()
  assert.doesNotMatch(openReports(h)[0].message, /CI FAILED/)
  assert.match(openReports(h)[0].message, /alice/)
  assert.match(openReports(h)[0].message, /bob/)
})

test("pr-watch: a comment landing in the SAME poll as the push does not fold the old verdict forward", async () => {
  const h = harness()
  h.watch("r", "acme/app#7")
  h.storage.upsertSession(row("r"))
  busy(h, "r")
  h.review.result = []
  h.pr.result = RED(OLD_HEAD)
  const s = h.make()
  await s.tick()
  h.clock.ms += 60_000
  h.pr.result = RUNNING(NEW_HEAD)
  h.review.result = [{ id: "c1", actor: "alice", at: iso(h.clock.ms), kind: "comment" }]
  await s.tick()
  const open = openReports(h)
  assert.equal(open.length, 1)
  assert.doesNotMatch(open[0].message, /CI FAILED/)
  assert.match(open[0].message, /alice/)
})

test("pr-watch: a verdict retracted and never read speaks again if the head comes back to that commit", async () => {
  const h = harness()
  h.watch("r", "acme/app#7")
  h.storage.upsertSession(row("r"))
  busy(h, "r")
  h.review.result = []
  h.pr.result = RED(OLD_HEAD)
  const s = h.make()
  await s.tick()
  h.clock.ms += 60_000
  h.pr.result = RUNNING(NEW_HEAD)
  await s.tick()
  assert.equal(openReports(h).length, 0)
  // A force-push back. The worker never read the red report, so the stamp must not count it as said.
  h.clock.ms += 60_000
  h.pr.result = RED(OLD_HEAD)
  await s.tick()
  assert.match(openReports(h)[0]?.message ?? "", /CI FAILED on acme\/app#7 at aaaaaaa/)
})

test("pr-watch: a GATED report survives the head moving — a gate is the same on any commit", async () => {
  const h = harness()
  h.watch("r", "acme/app#7")
  h.storage.upsertSession(row("r"))
  busy(h, "r")
  h.review.result = []
  const gated = (head: string) => ({ state: "OPEN", mergedAt: null, rollup: [], head, workflowRuns: [{ workflowName: "Test Linux", conclusion: "ACTION_REQUIRED" }] })
  h.pr.result = gated(OLD_HEAD)
  const s = h.make()
  await s.tick()
  assert.match(openReports(h)[0].message, /WAITING FOR APPROVAL/)
  assert.doesNotMatch(openReports(h)[0].message, /aaaaaaa/, "a gate names no commit: it would be false after a force-push")
  h.clock.ms += 60_000
  h.pr.result = gated(NEW_HEAD)
  await s.tick()
  assert.equal(openReports(h).length, 1)
  assert.match(openReports(h)[0].message, /WAITING FOR APPROVAL/, "still owed")
  h.clock.ms += 60_000
  h.pr.result = RUNNING(NEW_HEAD)
  await s.tick()
  assert.match(openReports(h)[0].message, /WAITING FOR APPROVAL/, "and a reading with no gate does not retract it either")
})

test("pr-watch: a report held across the upgrade, with no head in its stored form, still goes out", async () => {
  const h = harness()
  h.watch("r", "acme/app#7")
  h.storage.upsertSession(row("r"))
  busy(h, "r")
  h.review.result = []
  h.pr.result = RED(OLD_HEAD)
  const s = h.make()
  await s.tick()
  // What the row looks like when an older Frizz wrote the cursor: same verdict, no head beside it.
  const stored = h.storage.armedPrWatches()[0]
  const cursor = JSON.parse(stored.cursor!)
  delete cursor.held.checks.head
  h.storage.setPrWatchCursor(stored.id, JSON.stringify(cursor))

  h.clock.ms += 60_000
  h.pr.result = RUNNING(NEW_HEAD)
  await s.tick()
  assert.equal(openReports(h).length, 1, "nothing to compare, so it is left alone")
  rest(h, "r")
  h.clock.ms += 15 * 60_000
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /CI FAILED/)
})

test("pr-watch: a new commit is not a wake — a worker's own push never wakes it", async () => {
  const h = harness()
  h.watch("r", "acme/app#7")
  h.storage.upsertSession(row("r"))
  rest(h, "r")
  h.review.result = []
  h.pr.result = RED(OLD_HEAD)
  const s = h.make()
  await s.tick()
  h.clock.ms += 15 * 60_000
  await s.tick()
  assert.equal(h.resumes.length, 1, "the red report went out")
  h.clock.ms += 60_000
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [], head: NEW_HEAD }
  await s.tick()
  h.clock.ms += 15 * 60_000
  await s.tick()
  assert.equal(h.resumes.length, 1, "the push alone says nothing")
  assert.equal(openReports(h).length, 0)
})

test("pr-watch: a merge supersedes the report still waiting — the worker hears 'merged', not 'CI failed' then 'merged'", async () => {
  const h = harness()
  h.watch("r", "acme/app#7")
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(undefined, "in-flight"), lastAssistantAt: iso(h.clock.ms) })
  h.review.result = []
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }], head: "abc" }
  const s = h.make()
  await s.tick() // baseline: CI green — which a fresh watcher announces, so report #1 (passing) waits

  // CI goes red mid-turn: report #2 (failing) replaces #1 and is held. (Until the 2026-09-03 re-mint the
  // red verdict was never minted behind the waiting green one, so the "not 'CI failed'" half of this
  // case's name was vacuous; now the red report exists and the merge has to beat it.)
  h.clock.ms += 60_000
  h.pr.result = { state: "OPEN", mergedAt: null, rollup: [{ name: "unit", status: "COMPLETED", conclusion: "FAILURE" }], head: "abc" }
  await s.tick()
  assert.deepEqual(reportsOf(h, "r").map((r) => r.state), ["superseded", "leased"])
  assert.match(createWakeDeliveryStore(h.storage.scope).listOpen()[0].message, /CI FAILED/, "deferred behind the busy thread")

  // The PR merges (someone else fixed and landed it). The red report is dead news.
  h.clock.ms += 60_000
  h.pr.result = { state: "MERGED", mergedAt: iso(h.clock.ms), rollup: [], head: "abc" }
  await s.tick()
  const states = reportsOf(h, "r").map((r) => r.state)
  assert.deepEqual(states, ["superseded", "superseded", "leased"], "the waiting CI report is superseded by the merge report")

  // At rest the thread hears ONE thing.
  h.tele.set("r", { ...tele(awaiting([{ kind: "pr", value: "acme/app#7" }])), lastAssistantAt: iso(h.clock.ms) })
  h.clock.ms += 60_000
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /MERGED/)
  assert.doesNotMatch(h.resumes[0].message, /CI FAILED/)
})

// ---- SOURCE 10 DOES NOT WAKE A THREAD THAT SAID DONE (2026-08-28) ----
//
// The contract lets a worker sign off with a background process still running, naming it in the body.
// Waking that thread when the process exits hands it news it declared it did not need, and it answers
// the only way it can — by saying done again: a second Done card, and a registered done un-done by the
// wake's own user record until it does. SOURCES 4 and 5 already decline a done thread.
const retiredShell = (finishedAt: string) => ({
  id: "toolu_sh", taskId: "bzvtnt3ig", label: "dev server", status: "completed" as const, finishedAt,
})

test("shell: every thread whose shell finished is woken in the same pass, not one thread a tick", async () => {
  const h = harness()
  for (const slug of ["a", "b", "c"]) h.storage.upsertSession(row(slug))
  const rested = iso(h.clock.ms)
  const retired = retiredShell(iso(h.clock.ms + 5_000))
  h.clock.ms += 10_000
  const s = h.make()
  for (const slug of ["a", "b", "c"]) h.tele.set(slug, { ...tele(), lastAssistantAt: rested, retiredShells: [retired] })
  await s.tick()
  const woken = (h.storage.db.prepare("SELECT thread_slug FROM wake_delivery WHERE fence_id LIKE 'shell:%' ORDER BY thread_slug").all() as { thread_slug: string }[]).map((r) => r.thread_slug)
  assert.deepEqual(woken, ["a", "b", "c"], "the pass used to stop at the first thread it woke")
})

test("shell: a thread that signed off done is not woken when a shell it walked away from exits — fenced or registered", async () => {
  const h = harness()
  h.storage.upsertSession(row("d"))
  const rested = iso(h.clock.ms)
  const retired = retiredShell(iso(h.clock.ms + 5_000))
  h.clock.ms += 10_000
  const s = h.make()

  // Fenced done.
  h.tele.set("d", { ...tele({ kind: "done", body: "shipped", hints: [] }), lastAssistantAt: rested, retiredShells: [retired] })
  await s.tick()
  assert.deepEqual(h.resumes, [], "a fenced done is done")

  // Registered done (`mcp__frizz__done`), the rest itself bare.
  h.storage.markThreadDone("d", "shipped", Date.parse(rested) + 1)
  h.tele.set("d", { ...tele(), lastAssistantAt: rested, retiredShells: [retired] })
  await s.tick()
  assert.deepEqual(h.resumes, [], "a registered done is done")

  // CONTROL: the same rest with no sign-off at all is woken — the guard is the sign-off, not the shape.
  // (A bare rest draws the sign-off nudge as well, its own news; since 2026-09-03 the two ride in ONE
  // delivery, so the shell's wake is counted by its text being there at all.)
  h.storage.clearThreadDone("d")
  await s.tick()
  const shellWakes = (h.resumes as { message: string }[]).filter((r) => /dev server|bzvtnt3ig/.test(r.message))
  assert.equal(shellWakes.length, 1)
})

test("shell: …unless the worker REGISTERED a wait on that shell — a registration trumps a done here as on the board", async () => {
  const h = harness()
  h.storage.upsertSession(row("d"))
  const rested = iso(h.clock.ms)
  armWatch(h, "d") // kind shell, target bzvtnt3ig — the retired shell's runtime handle
  const retired = retiredShell(iso(h.clock.ms + 5_000))
  h.clock.ms += 10_000
  h.tele.set("d", { ...tele({ kind: "done", body: "shipped, the build is still running", hints: [] }), lastAssistantAt: rested, retiredShells: [retired] })
  // evalOwnWatches settles the row silently this same tick (its target ended); the wake is still owed.
  await h.make().tick()
  assert.equal(h.resumes.length, 1, "the wake is the thing it registered for")
  assert.match(h.resumes[0].message, /dev server|bzvtnt3ig/)
  assert.notEqual(h.storage.getThreadWatch("wch_1")?.state, "armed", "and the row was settled first, as ever")
})

// ---- COALESCING: the quiet window and the merge ------------------------------------------------------
//
// A wake is a turn, and a turn re-reads a 150k–450k context on each of its 10–40 calls — $2–3 before
// the worker does anything. Wake-triggered turns were 32% of a day's spend (2026-09-03), and the outbox
// showed one thread woken six times in 40 minutes by one PR's review comments. So (wake-store.ts,
// WAKE_QUIET_WINDOW_MS) a thread handed a wake inside the window holds its next ones, and
// (scheduler.deliverDue) everything waiting for a thread goes out in ONE delivery when the window opens.
// Timers are the vehicle below because they are the simplest source to arm on a clock; the merge does not
// care which source a row came from.

function coalesceHarness(): Harness {
  const h = harness()
  h.storage.setSetting("signoffNudge", "off") // a bare rest would otherwise draw the nudge into every frame
  return h
}

test("coalesce: a burst of three wakes inside the quiet window is ONE delivery carrying all three, oldest first", async () => {
  const h = coalesceHarness()
  h.storage.upsertSession(row("b"))
  h.tele.set("b", tele())
  const s = h.make({ wakeQuietWindowMs: WAKE_QUIET_WINDOW_MS })
  const t0 = h.clock.ms
  armTimer(h, "b", t0, "first")
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.message.split("\n")[0]), ["first"], "nothing was handed to the thread before, so the first wake goes out at once")

  // Three more inside the window, a minute apart: each is minted, none is delivered.
  for (const [i, prompt] of ["second", "third", "fourth"].entries()) {
    h.clock.ms = t0 + (i + 1) * 60_000
    armTimer(h, "b", h.clock.ms, prompt)
    await s.tick()
    assert.equal(h.resumes.length, 1, `${prompt}: held by the window`)
  }
  h.clock.ms = t0 + WAKE_QUIET_WINDOW_MS - 1_000
  await s.tick()
  assert.equal(h.resumes.length, 1, "still held one second before the window ends")

  h.clock.ms = t0 + WAKE_QUIET_WINDOW_MS
  await s.tick()
  assert.equal(h.resumes.length, 2, "the window opens: one delivery for the three")
  const merged = h.resumes[1].message
  assert.match(merged, /held 3 wakes/)
  const at = (needle: string) => { const i = merged.indexOf(needle); assert.ok(i >= 0, `${needle} is in the body`); return i }
  assert.ok(at("### 1. one-off timer") < at("second") && at("second") < at("### 2.") && at("### 2.") < at("third") && at("third") < at("fourth"), "oldest first, each under its own heading")
  assert.equal((merged.match(/⏱/g) ?? []).length, 1, "one clock at the foot, not one per part")
  assert.match(merged, /⏱ [^\n]+\.$/, "and it is the last line")
  // The rows stay separate, and every one reaches its own terminal state — which is what keeps
  // evalTimers from re-minting any of them (their alarms are marked fired) and the per-fence dedupe true.
  const rows = createWakeDeliveryStore(h.storage.scope).list()
  assert.deepEqual(rows.map((d) => d.state), ["delivered", "delivered", "delivered", "delivered"])
  assert.deepEqual(h.storage.listThreadTimers("b", { armedOnly: true }), [])
  await s.tick()
  assert.equal(h.resumes.length, 2, "nothing goes round again")
  h.storage.close()
})

test("coalesce: identical events fold into one section that counts them", async () => {
  const h = coalesceHarness()
  h.storage.upsertSession(row("b"))
  h.tele.set("b", tele())
  const s = h.make({ wakeQuietWindowMs: WAKE_QUIET_WINDOW_MS })
  const t0 = h.clock.ms
  armTimer(h, "b", t0, "first")
  await s.tick()
  // Two alarms with the same prompt for the same instant: the same reason and the same body.
  h.clock.ms = t0 + 60_000
  armTimer(h, "b", h.clock.ms, "same thing")
  armTimer(h, "b", h.clock.ms, "same thing")
  armTimer(h, "b", h.clock.ms, "other thing")
  await s.tick()
  h.clock.ms = t0 + WAKE_QUIET_WINDOW_MS
  await s.tick()
  assert.equal(h.resumes.length, 2)
  const merged = h.resumes[1].message
  assert.match(merged, /held 3 wakes/)
  // The three rows share one enqueue instant, so their order falls to the delivery id — which carries the
  // file-wide timer counter, and so moves with whichever tests ran first. Pin the sections, not their order.
  assert.match(merged, /### [12]\. one-off timer elapsed \([^)]+\) — 2 identical events\n\nsame thing/)
  assert.equal((merged.match(/same thing/g) ?? []).length, 1, "said once, counted twice")
  assert.match(merged, /### [12]\. [^\n]+\n\nother thing/)
  assert.equal((merged.match(/^### /gm) ?? []).length, 2, "two sections for three events")
  h.storage.close()
})

test("coalesce: an answer from the human is not held by the window, and goes out ALONE", async () => {
  const h = coalesceHarness()
  h.storage.upsertSession(row("q"))
  h.tele.set("q", tele())
  const s = h.make({ wakeQuietWindowMs: WAKE_QUIET_WINDOW_MS })
  const t0 = h.clock.ms
  armTimer(h, "q", t0, "first")
  await s.tick()
  h.clock.ms = t0 + 30_000
  armTimer(h, "q", h.clock.ms, "second")
  await s.tick()
  assert.equal(h.resumes.length, 1, "the timer is held")

  askQ(h, "q", "qst_1", "SQLite or a JSON file?")
  h.clock.ms = t0 + 60_000
  h.storage.answerThreadQuestion("qst_1", JSON.stringify({ questionId: "qst_1", question: "SQLite or a JSON file?", chosen: ["SQLite"] }), h.clock.ms)
  await s.tick()
  assert.equal(h.resumes.length, 2, "the answer is not held")
  // ALONE: the chat reads this message by position (its first line must be the answers header, and every
  // trailing line is the last answer's continuation), so the held timer does not ride on it.
  assert.match(h.resumes[1].message, /^Answers to earlier questions:$/m)
  assert.doesNotMatch(h.resumes[1].message, /second|held \d+ wakes/)
  assert.equal(createWakeDeliveryStore(h.storage.scope).listOpen().length, 1, "the timer is still waiting")

  h.clock.ms = t0 + WAKE_QUIET_WINDOW_MS
  await s.tick()
  assert.equal(h.resumes.length, 3)
  assert.match(h.resumes[2].message, /^second/, "and goes out on the window it was given, on its own")
  h.storage.close()
})

test("coalesce: a wake older than the window is delivered at once", async () => {
  const h = coalesceHarness()
  h.storage.upsertSession(row("b"))
  h.tele.set("b", tele())
  const s = h.make({ wakeQuietWindowMs: WAKE_QUIET_WINDOW_MS })
  const t0 = h.clock.ms
  armTimer(h, "b", t0, "first")
  await s.tick()
  h.clock.ms = t0 + WAKE_QUIET_WINDOW_MS + 60_000
  armTimer(h, "b", h.clock.ms, "later")
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.message.split("\n")[0]), ["first", "later"], "the window had already elapsed, so nothing waits")
  h.storage.close()
})

// THE NUDGE ANSWERS THE WORKER'S OWN REST, which is the card on the board right now — so the window that
// rations news must not hold it. The shape of the thread that surfaced it (2026-09-25): a wake goes out,
// the worker rests bare seconds later, and the nudge sat for the rest of the window while the maintainer
// opened a card that said nothing about where it stood.
test("coalesce: the sign-off nudge for a bare rest right after a wake is not held by the window", async () => {
  const h = harness() // the nudge ON — coalesceHarness turns it off
  h.storage.upsertSession(row("n"))
  h.tele.set("n", tele())
  const s = h.make({ wakeQuietWindowMs: WAKE_QUIET_WINDOW_MS })
  const t0 = h.clock.ms
  armTimer(h, "n", t0, "first")
  await s.tick()
  assert.equal(h.resumes.length, 1, "the wake that starts the window")

  h.clock.ms = t0 + 9_000
  h.tele.set("n", { ...tele(), lastUserAt: iso(t0), lastAssistantAt: iso(h.clock.ms) })
  h.clock.ms += 2_000
  await s.tick()
  assert.equal(h.resumes.length, 2, "delivered on the tick that minted it, not when the window ends")
  assert.match(h.resumes[1].message, /You rested without a fence/)
  assert.match(h.resumes[1].message, /you last spoke 2s ago\.$/)
  h.storage.close()
})

// A LONE HELD WAKE READS ITS CLOCK AT SEND. The stamp is taken at enqueue, and the window can hold the row
// across a turn the worker finished meanwhile — observed 2026-09-25 as "you last spoke 14m ago" on a
// wake that reached a worker 39 seconds after it last spoke.
test("coalesce: a lone wake held by the window carries the clock of its send, not its enqueue", async () => {
  const h = coalesceHarness()
  h.storage.upsertSession(row("c"))
  h.watch("c", "acme/app#1")
  const t0 = h.clock.ms
  h.tele.set("c", { ...tele(), lastAssistantAt: iso(t0 - 14 * 60_000) })
  h.review.result = []
  const s = h.make({ wakeQuietWindowMs: WAKE_QUIET_WINDOW_MS })
  armTimer(h, "c", t0, "first")
  await s.tick()
  assert.equal(h.resumes.length, 1, "the wake that starts the window")

  h.clock.ms = t0 + 60_000
  h.review.result = [{ id: "comment:c1", actor: "alice", at: iso(h.clock.ms), kind: "comment" }]
  await s.tick()
  assert.equal(h.resumes.length, 1, "the review is held")
  const held = createWakeDeliveryStore(h.storage.scope).listOpen()
  assert.equal(held.length, 1)
  assert.match(held[0].message, /you last spoke 15m ago\.$/, "stamped at enqueue")

  // The worker takes a turn of its own inside the window and rests.
  h.tele.set("c", { ...tele(), lastAssistantAt: iso(t0 + WAKE_QUIET_WINDOW_MS - 39_000) })
  h.clock.ms = t0 + WAKE_QUIET_WINDOW_MS
  await s.tick()
  assert.equal(h.resumes.length, 2)
  const sent = h.resumes[1].message
  assert.doesNotMatch(sent, /held \d+ wakes/, "a lone wake, not a merge")
  assert.equal((sent.match(/⏱/g) ?? []).length, 1, "the old clock is replaced, not joined")
  assert.match(sent, /you last spoke 39s ago\.$/)
  h.storage.close()
})

test("coalesce: production takes the constant — the harness's 0 is the test's choice, not the default", async () => {
  const h = coalesceHarness()
  h.storage.upsertSession(row("b"))
  h.tele.set("b", tele())
  const s = h.make({ wakeQuietWindowMs: undefined })
  const t0 = h.clock.ms
  armTimer(h, "b", t0, "first")
  await s.tick()
  h.clock.ms = t0 + 60_000
  armTimer(h, "b", h.clock.ms, "second")
  await s.tick()
  assert.equal(h.resumes.length, 1, "held by the default window")
  h.clock.ms = t0 + WAKE_QUIET_WINDOW_MS
  await s.tick()
  assert.equal(h.resumes.length, 2)
  h.storage.close()
})

test("coalesce: a mid-turn thread receives everything that piled up as ONE wake once its turn ends", async () => {
  const h = coalesceHarness()
  h.storage.upsertSession(row("m"))
  h.watch("m", "acme/app#1")
  h.watch("m", "acme/app#2")
  armWatch(h, "m", { expiresAtMs: h.clock.ms + 60_000 })
  // The shell is LIVE, so the watch runs to its expiry rather than settling silently as "target ended".
  h.tele.set("m", { ...tele(undefined, "in-flight"), lastAssistantAt: iso(h.clock.ms), bgShells: [liveShell()] })
  h.review.result = []
  const s = h.make({ wakeQuietWindowMs: WAKE_QUIET_WINDOW_MS })
  await s.tick() // baseline polls; nothing due
  // A review lands on both PRs and the registered shell watch expires, all while the thread is working:
  // three rows from two sources, none deliverable mid-turn (none is clock-driven).
  h.clock.ms += 60_000
  h.review.result = [{ id: "comment:c1", actor: "alice", at: iso(h.clock.ms), kind: "comment" }]
  await s.tick()
  h.clock.ms += 60_000
  await s.tick()
  assert.equal(h.resumes.length, 0, "not stepped on mid-turn")
  const open = createWakeDeliveryStore(h.storage.scope).listOpen()
  assert.equal(open.length, 3, JSON.stringify(open.map((d) => [d.reason, d.state])))

  h.tele.set("m", { ...tele(), lastAssistantAt: iso(h.clock.ms) }) // the turn ends
  h.clock.ms += 60_000
  await s.tick()
  assert.equal(h.resumes.length, 1, "one delivery for the three")
  const merged = h.resumes[0].message
  assert.match(merged, /held 3 wakes/)
  assert.match(merged, /Your watch on the background shell `bzvtnt3ig` has expired/)
  assert.match(merged, /acme\/app#1/)
  assert.match(merged, /acme\/app#2/)
  assert.ok(merged.indexOf("bzvtnt3ig") < merged.indexOf("acme/app#1"), "oldest first: the expiry was minted before the reports")
  assert.deepEqual(createWakeDeliveryStore(h.storage.scope).list().map((d) => d.state), ["delivered", "delivered", "delivered"])
  await s.tick()
  assert.equal(h.resumes.length, 1, "nothing goes round again")
  h.storage.close()
})

test("coalesce: the mid-turn hold has a ceiling — a wake held longer than MID_TURN_HOLD_MAX_MS goes out anyway", async () => {
  const h = coalesceHarness()
  const t0 = h.clock.ms
  h.storage.upsertSession(snoozeRow("m", iso(t0), "resume the audit"))
  h.tele.set("m", tele(undefined, "in-flight"))
  const s = h.make()
  await s.tick() // due now, held: the thread is busy
  assert.equal(h.resumes.length, 0)
  h.clock.ms = t0 + MID_TURN_HOLD_MAX_MS - 1_000
  await s.tick()
  assert.equal(h.resumes.length, 0, "still busy, still inside the ceiling")
  h.clock.ms = t0 + MID_TURN_HOLD_MAX_MS
  await s.tick()
  assert.deepEqual(h.resumes.map((r) => r.message), ["resume the audit"], "released into the running turn's queue rather than starved")
  assert.equal(createWakeDeliveryStore(h.storage.scope).list()[0]?.state, "delivered")
  h.storage.close()
})

// ---- ISSUE WATCHERS (2026-09-14) ------------------------------------------------------------------------
// `mcp__frizz__watch_issue` arms a `pr_watch` row with `kind: "issue"`. The poll asks GitHub for the ISSUE,
// never falls back to `gh pr view`, baselines what predates the registration exactly as a PR watcher
// does, and reports comments, label and assignee movement, and the close — with the issue's own trailer.
const issueSnap = (over: Partial<NonNullable<Extract<GithubReviewFetchResult, { status: "ok" }>["issue"]>> = {}) =>
  ({ state: "OPEN", title: "Crash on start", labels: ["bug"], assignees: [], comments: 1, ...over })

test("issue-watch: polls the ISSUE kind with no gh fallback, baselines, then wakes on a new comment with the issue trailer", async () => {
  const h = harness()
  h.watch("r", "acme/app#7", "issue")
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "issue", value: "acme/app#7" }])), lastActivityAt: iso(h.clock.ms) })
  h.review.result = { status: "ok", issue: issueSnap(), activity: [
    { id: "comment:old", actor: "alice", actorType: "User", at: iso(h.clock.ms - 120_000), kind: "comment" },
  ] }
  await h.make().tick()
  assert.equal(h.resumes.length, 0, "a comment that predates the registration is the worker's own news")
  assert.equal(h.review.calls[0]?.kind, "issue", "the fetcher is asked for the issue, not the pull request")
  assert.equal(h.pr.calls.length, 0, "an issue never falls back to `gh pr view`")

  h.clock.ms += 61_000
  const at = iso(h.clock.ms)
  h.review.result = { status: "ok", issue: issueSnap({ comments: 2 }), activity: [
    { id: "comment:new", actor: "carol", actorType: "User", at, kind: "comment", url: "https://github.com/acme/app/issues/7#issuecomment-2" },
    { id: "comment:old", actor: "alice", actorType: "User", at: iso(h.clock.ms - 181_000), kind: "comment" },
  ] }
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.ok(h.resumes[0].message.startsWith(`👤 New GitHub comment on acme/app#7 from @carol at ${at}. Read that exact comment`))
  assert.match(h.resumes[0].message, /\(Registered issue watcher — STILL ARMED/)
  assert.doesNotMatch(h.resumes[0].message, /CI|Registered PR watcher/, "an issue wake never speaks the PR vocabulary")
})

test("issue-watch: a label moving and a new assignee are one state line; the close settles the row with GitHub's reason", async () => {
  const h = harness()
  h.watch("r", "acme/app#7", "issue")
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "issue", value: "acme/app#7" }])), lastActivityAt: iso(h.clock.ms) })
  h.review.result = { status: "ok", issue: issueSnap(), activity: [] }
  await h.make().tick()
  assert.equal(h.resumes.length, 0, "the first poll records labels and assignees and says nothing")

  h.clock.ms += 61_000
  h.review.result = { status: "ok", issue: issueSnap({ labels: ["bug", "confirmed"], assignees: ["alice"] }), activity: [] }
  let s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /^🔔 acme\/app#7: labels \+confirmed; assigned to @alice\.$/m)

  h.clock.ms += 61_000
  h.review.result = { status: "ok", issue: issueSnap({ state: "CLOSED", stateReason: "NOT_PLANNED", labels: ["bug", "confirmed"], assignees: ["alice"] }), activity: [] }
  s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 2)
  assert.match(h.resumes[1].message, /^⏰ acme\/app#7 was CLOSED\.$/m)
  assert.match(h.resumes[1].message, /GitHub's reason: not planned\./)
  assert.match(h.resumes[1].message, /closed issue/)
  assert.equal(h.storage.listPrWatches("r", { armedOnly: true }).length, 0, "a closed issue settles its watcher")

  h.clock.ms += 61_000
  h.review.calls.length = 0
  await h.make().tick()
  assert.equal(h.review.calls.length, 0, "a settled watcher is never polled again")
})

test("issue-watch: the expiry wake names the issue tool, not watch_pr", async () => {
  const h = harness()
  h.storage.upsertSession(row("r"))
  h.storage.armPrWatch({ id: "isw_x", slug: "r", kind: "issue", owner: "acme", repo: "app", number: 7, createdAtMs: h.clock.ms - 3600_000, expiresAtMs: h.clock.ms - 1 })
  h.tele.set("r", { ...tele(), lastActivityAt: iso(h.clock.ms) })
  const s = h.make()
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /Your watcher on acme\/app#7 has expired/)
  assert.match(h.resumes[0].message, /nothing on that issue will wake/)
  assert.match(h.resumes[0].message, /`frizzctl watch-issue add`/)
})

test("issue-watch: an issue GitHub stops resolving settles its watcher after the grace period, naming the issue tool", async () => {
  const h = harness()
  h.watch("r", "acme/app#7", "issue")
  h.storage.upsertSession(row("r"))
  h.tele.set("r", { ...tele(awaiting([{ kind: "issue", value: "acme/app#7" }])), lastActivityAt: iso(h.clock.ms) })
  h.review.result = { status: "ok", issue: issueSnap(), activity: [] }
  const s = h.make()
  await s.tick()
  h.review.result = { status: "error", failure: { kind: "not-found", message: "GitHub: Could not resolve to an Issue with the number of 7." } }
  for (let i = 0; i < 30; i++) {
    h.clock.ms += 61_000
    await s.tick()
  }
  assert.equal(h.resumes.length, 0, "under 30m of NOT_FOUND is not an ending")
  assert.equal(h.storage.listPrWatches("r", { armedOnly: true }).length, 1)
  h.clock.ms += 61_000
  await s.tick()
  await s.tick()
  assert.equal(h.resumes.length, 1)
  assert.match(h.resumes[0].message, /^⏰ acme\/app#7 can no longer be read/)
  assert.match(h.resumes[0].message, /nothing on that issue will wake you now/)
  assert.match(h.resumes[0].message, /`frizzctl watch-issue add`/)
  assert.equal(h.storage.listPrWatches("r", { armedOnly: true }).length, 0, "the watcher settles with it")
})

// ---- SOURCE 10: THE INTERRUPT NOTE (interrupt-ended.ts) ----
// The router queues it once the tailer confirms the children ended; the scheduler's only job is to hand
// it over WITHOUT the mid-turn hold — the worker is busy precisely because the interrupt just opened a
// turn on the human's follow-up, and that is the turn in which it would park on the dead id.
test("interrupt note: delivered into the busy turn on the next tick, never held", async () => {
  const h = harness()
  h.storage.upsertSession(row("i"))
  h.tele.set("i", tele(undefined, "in-flight"))
  enqueueInterruptEndedWake(h.storage, {
    slug: "i", sessionId: "sid-i", interruptedAtMs: h.clock.ms,
    agents: [{ taskId: "abc9b9b5f0da4c677", label: "Implementing four Keyward daemon changes" }], nowMs: h.clock.ms,
  })
  const s = h.make()
  await s.tick()
  assert.equal(h.resumes.length, 1, "handed over while the thread is mid-turn")
  assert.match(h.resumes[0].message, /sent with INTERRUPT/)
  assert.match(h.resumes[0].message, /`abc9b9b5f0da4c677` — Implementing four Keyward daemon changes/)
  // Bound to a fact: a later fence, rest or edit cannot supersede it.
  h.tele.set("i", { ...tele(awaiting([{ kind: "pr", value: "acme/app#1" }])), lastUserText: h.resumes[0].message })
  await s.tick()
  assert.equal(h.resumes.length, 1, "and exactly once")
  assert.equal(createWakeDeliveryStore(h.storage.scope).list()[0]?.state, "delivered")
  h.storage.close()
})
