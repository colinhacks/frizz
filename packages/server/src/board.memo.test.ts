// THE GOLDEN TEST for the board's per-thread memo (board.ts ArchivedViewInputs) and everything it keys
// on: the storage's patched session snapshot and memoized registry reads (change-tracking.ts), the
// tailer's telemetry memo, the broker liveness snapshot, and the differ's identity skip.
//
// One WARM board lives through a sequence of real changes — the state a long-running server is in, its
// memos full. After every step it is compared with a COLD board: a fresh storage connection, a fresh
// tailer that primes from the same transcripts, and a fresh board with nothing memoized, i.e. exactly
// the derivation as it ran before any of the memos existed. They must be deep-equal, byte for byte, at
// every step — including the steps where only the clock moved, which is where a memo goes stale.
//
// The deltas the warm board publishes are checked the same way: a client that took the first keyframe
// and applied every delta since must hold the cold board.
import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyBoardDelta, type BoardSnapshot, type ClaudeModel, type InteractionRequest, type ServerEvent } from "@frizz/shared"
import { createBoard, type BoardManager, type ClaudeBrokerLivenessSnapshot } from "./board.ts"
import { GITHUB_STATUS_SETTING } from "./awaiting.ts"
import { Bus } from "./bus.ts"
import type { Project } from "./project.ts"
import type { QuestionFenceFault } from "./question-fences.ts"
import { createStorage, type SessionRow, type Storage } from "./storage.ts"
import { createTailer, type Tailer } from "./tailer.ts"

const T0 = Date.now() - 60 * 60_000
const iso = (ms: number) => new Date(ms).toISOString()
const at = (second: number) => iso(T0 + second * 1000)
const prompt = (second: number, text = "go") => JSON.stringify({ type: "user", timestamp: at(second), message: { role: "user", content: text } })
const reply = (second: number, text: string) => JSON.stringify({ type: "assistant", timestamp: at(second), message: { stop_reason: "end_turn", content: [{ type: "text", text }] } })
const fenced = (second: number, fence: string) => JSON.stringify({ type: "assistant", timestamp: at(second), message: { stop_reason: "end_turn", content: [{ type: "text", text: `Work.\n\n\`\`\`${fence}\n\`\`\`` }] } })
const toolUse = (second: number, id: string, name: string, input: object) => JSON.stringify({ type: "assistant", timestamp: at(second), message: { stop_reason: "tool_use", content: [{ type: "tool_use", name, id, input }] } })
const toolResult = (second: number, id: string, text: string) => JSON.stringify({ type: "user", timestamp: at(second), message: { content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "text", text }] }] } })
const modelReply = (second: number, text: string, model: string) => JSON.stringify({ type: "assistant", timestamp: at(second), message: { model, stop_reason: "end_turn", content: [{ type: "text", text }] } })
const limitHit = (second: number) => JSON.stringify({ type: "assistant", isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429, timestamp: at(second), message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your session limit" }] } })

function sessionRow(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return { slug, session_id: `${slug}-sid`, thread_name: `frizz-${slug}`, spawned_at: at(0), last_read_at: null, unread: 0, exited: 1, archived: 0, rested_at: null, title_auto: 1, title: `Thread ${slug}`, state: "archived", meta: null, seen_at: null, transcript_id: null, ...over }
}

const FOREIGN = "f0f0f0f0-1111-4222-8333-444444444444"

// Priming is bounded per tick (archived rows yield), so tick until every row has telemetry.
function primeAll(tailer: Tailer, storage: Storage): void {
  for (let i = 0; i < 200; i++) {
    tailer.tick()
    if (storage.allSessions().every((row) => tailer.get(row.slug))) return
  }
  throw new Error("the tailer never primed every row")
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "frizz-board-golden-"))
  const dir = join(root, "project")
  mkdirSync(join(dir, ".frizz"), { recursive: true })
  const logDir = join(root, "-a-project")
  mkdirSync(logDir)
  const dbPath = join(root, "ui.db")
  const project: Project = { dir, id: "p", name: "fixture", label: "fixture", stateDir: root, cwdSlug: "fixture" }
  const clock = { ms: T0 + 120_000 }
  const mtimes = new Map<string, number>()
  // Broker daemons that are running, by session id. Replaced (never edited) on a change, so the
  // listing a snapshot hands out keeps the same identity rule the real one has.
  let alive = new Set<string>()
  let catalogue: readonly ClaudeModel[] | undefined = undefined
  const faults = new Map<string, readonly QuestionFenceFault[]>()
  const liveness = (): ClaudeBrokerLivenessSnapshot => {
    const listing = alive
    return Object.assign((sessionId: string) => listing.has(sessionId), { listing, listed: (sessionId: string) => listing.has(sessionId) })
  }
  const makeTailer = (storage: Storage): Tailer => createTailer({
    project,
    storage,
    bus: new Bus(),
    onChange: () => {},
    sessionLogDir: logDir,
    now: () => clock.ms,
    brokerDaemonAlive: (sessionId) => alive.has(sessionId),
    shellAlive: () => true,
    mtimeMs: (path) => mtimes.get(path),
  })
  const makeBoard = (storage: Storage, tailer: Tailer, bus = new Bus()): BoardManager => createBoard(project, storage, bus, tailer, "golden-boot", {
    now: () => clock.ms,
    claudeBrokerDaemonAlive: (sessionId) => alive.has(sessionId),
    claudeBrokerLiveness: liveness,
    claudeModels: () => catalogue,
    questionFaults: (slug) => faults.get(slug),
    subscribe: (async () => ({ unsubscribe: async () => {} })) as never,
  })

  const storage = createStorage(dbPath, "p")
  const tailer = makeTailer(storage)
  const f_root = root
  let colds = 0
  const bus = new Bus()
  const events: ServerEvent[] = []
  bus.subscribe((event) => { events.push(event) })
  const board = makeBoard(storage, tailer, bus)

  return {
    root, dir, logDir, storage, tailer, board, events, clock, mtimes,
    setAlive(next: Iterable<string>) { alive = new Set(next) },
    setCatalogue(next: readonly ClaudeModel[] | undefined) { catalogue = next },
    setFaults(slug: string, next: readonly QuestionFenceFault[] | undefined) { if (next) faults.set(slug, next); else faults.delete(slug) },
    thread(slug: string, lines: string[], over: Partial<SessionRow> = {}) {
      const row = sessionRow(slug, over)
      storage.upsertSession(row)
      storage.setBackend(slug, "claude")
      storage.setClaudeRuntime(slug, "broker")
      if (over.snoozed_until) storage.setSnoozedUntil(slug, over.snoozed_until)
      writeFileSync(join(logDir, `${row.session_id}.jsonl`), lines.map((line) => line + "\n").join(""))
    },
    append(slug: string, line: string) {
      appendFileSync(join(logDir, `${slug}-sid.jsonl`), line + "\n")
    },
    /** The derivation as it ran before any memo existed: new connection, new tailer, new board. Always
     *  a full rebuild, because only a rebuild reads the legacy thread files — the warm board's legacy
     *  cache is as of its own last rebuild, and the fixture only moves a legacy file before one. */
    async cold(): Promise<BoardSnapshot> {
      // On a COPY of the database: the cold side's own writes (its tail cache, the snooze sweep) must
      // not reach the warm connection, or every comparison would force the warm storage into a full
      // re-read and the memos under test would never be exercised past the first step.
      const copy = join(f_root, `cold-${++colds}.db`)
      storage.db.exec(`VACUUM INTO '${copy}'`)
      const coldStorage = createStorage(copy, "p")
      const coldTailer = makeTailer(coldStorage)
      try {
        primeAll(coldTailer, coldStorage)
        const coldBoard = makeBoard(coldStorage, coldTailer)
        try {
          return await coldBoard.rebuild()
        } finally { await coldBoard.stop() }
      } finally {
        coldTailer.stop()
        coldStorage.close()
      }
    },
    close() {
      tailer.stop()
      storage.close()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

type Fixture = ReturnType<typeof fixture>

// What a client holds after the keyframe and every delta the warm board has published since.
function clientView(f: Fixture, keyframe: BoardSnapshot): BoardSnapshot {
  const board: BoardSnapshot = JSON.parse(JSON.stringify(keyframe))
  for (const event of f.events) if (event.type === "board-delta") applyBoardDelta(board, event)
  return board
}

const approval = (slug: string): InteractionRequest => ({
  protocolVersion: 1,
  contentFormat: "plain-text",
  provider: { kind: "frizz" },
  source: { kind: "frizz", id: "golden" },
  owner: { projectId: "p", threadSlug: slug, sessionId: `${slug}-sid`, turnId: "turn", itemId: "req", sessionEpoch: 1, capabilityRevision: 1 },
  providerRequestId: "req",
  allowedDecisions: [{ id: "accept", semantic: "approve", label: "Allow" }],
  payload: { kind: "command-approval", title: "Command", command: { summary: "Test", preview: "pnpm test", redacted: true } },
  expiresAt: null,
})

const byId = (b: BoardSnapshot) => Object.fromEntries(b.threads.map((t) => [t.id, t]))

async function assertGolden(f: Fixture, step: string, warm: BoardSnapshot, opts: { rebuild?: boolean; keyframe?: BoardSnapshot } = {}) {
  const cold = await f.cold()
  // The whole snapshot, order included: the warm board must be what the cold one is, not merely the
  // same set of threads.
  assert.deepEqual(JSON.parse(JSON.stringify(warm)), JSON.parse(JSON.stringify(cold)), `${step}: the warm board is the cold board`)
  if (opts.keyframe) {
    assert.deepEqual(JSON.parse(JSON.stringify(byId(clientView(f, opts.keyframe)))), JSON.parse(JSON.stringify(byId(cold))), `${step}: keyframe + every delta is the cold board`)
  }
}

test("golden: a warm, memoized board is the cold derivation at every step — data, registries, liveness and the clock", async () => {
  const f = fixture()
  try {
    // ---- the board: history, a handful open, and one of every clock-sensitive shape ---------------
    for (let i = 0; i < 24; i++) {
      const slug = `old-${String(i).padStart(2, "0")}`
      const ending = i % 3 === 0 ? fenced(3, "done") : i % 3 === 1 ? reply(3, `answer ${i}`) : fenced(3, "awaiting")
      f.thread(slug, [prompt(1, `task ${i}`), ending], { rested_at: at(3) })
      if (i % 2 === 0) f.storage.markThreadDone(slug, `Finished ${i}.\n\n- did it`, T0 + 10_000)
      if (i % 4 === 1) {
        f.storage.askThreadQuestion({ id: `qst_${i}`, slug, spec: JSON.stringify({ question: "Ship it?", kind: "question", options: [{ label: "Yes" }, { label: "No" }] }), askedAtMs: T0 + 5_000, handle: `q-${i}` })
        f.storage.withdrawThreadQuestion(slug, `qst_${i}`, T0 + 6_000)
      }
      if (i % 5 === 0) f.storage.upsertThreadLink({ id: `lnk_${i}`, slug, kind: "link", label: `Report ${i}`, target: `https://example.com/${i}`, createdAtMs: T0 + 7_000 })
    }
    // An archived thread whose transcript ends on a session-limit fault: its auto-resume promise goes
    // stale with the clock, nothing else.
    f.thread("limited", [prompt(1), limitHit(4)], { rested_at: at(4) })
    // An archived thread holding a snooze instant (the storage permits it): visible until the instant.
    f.thread("parked-archived", [prompt(1), reply(3, "parked")], { rested_at: at(3), snoozed_until: iso(T0 + 10 * 60_000) })
    // The same with a wake prompt riding the snooze: the expiry sweep leaves a prompted snooze to the
    // scheduler, so its row does NOT change at the instant — only the clock says the snooze has passed.
    f.thread("prompted-archived", [prompt(1), reply(3, "parked")], { rested_at: at(3) })
    f.storage.setSnoozedUntil("prompted-archived", iso(T0 + 10 * 60_000), "time to look again")
    // An archived thread with a background sub-agent, live by its transcript's mtime until the clock
    // runs past its quiet window.
    f.thread("helper", [
      prompt(1),
      toolUse(2, "toolu_ag", "Agent", { description: "Auditing", run_in_background: true, subagent_type: "frizz:high" }),
      toolResult(3, "toolu_ag", "Async agent launched successfully.\nagentId: abc123\noutput_file: /tmp/tasks/abc123.output\nDo not read this file."),
      reply(4, "waiting on the audit"),
    ], { rested_at: at(4) })
    f.mtimes.set("/tmp/tasks/abc123.output", T0 + 4_000)
    // An archived thread on an older edition of its family: once the catalogue knows a newer one, its
    // view carries the upgrade, and whether it is `staged` is the broker daemon's liveness — the one
    // external fact an archived view reads.
    f.thread("behind", [prompt(1), modelReply(3, "on the old edition", "claude-opus-5")], { rested_at: at(3), model: "opus" })
    // An archived thread with an armed PR watch: its watch row carries the GitHub book's reading.
    f.storage.armPrWatch({ id: "pw_1", slug: "old-12", kind: "pull", owner: "o", repo: "r", number: 1, createdAtMs: T0 + 8_000, expiresAtMs: T0 + 30 * 24 * 60 * 60_000 })
    // A pre-session-first row: no explicit state, archived only through its legacy thread file.
    f.thread("legacy", [prompt(1), reply(3, "old style")], { state: null as never, title_auto: 0, rested_at: at(3) })
    writeFileSync(join(f.dir, ".frizz", "legacy.md"), "---\nstatus: done\n---\n\nold\n")
    // Open threads: one resting, one mid-turn, one snoozed.
    f.thread("open-rested", [prompt(1), reply(3, "over to you")], { state: "open", exited: 0, rested_at: at(3) })
    f.thread("open-working", [prompt(1)], { state: "open", exited: 0 })
    f.thread("open-snoozed", [prompt(1), reply(3, "later")], { state: "open", exited: 0, rested_at: at(3), snoozed_until: iso(T0 + 8 * 60_000) })
    f.setAlive(["open-rested-sid", "open-working-sid", "open-snoozed-sid"])
    // A terminal session nobody dispatched.
    writeFileSync(join(f.logDir, `${FOREIGN}.jsonl`), [prompt(1, "hello from a terminal"), reply(2, "hi")].map((l) => l + "\n").join(""))

    primeAll(f.tailer, f.storage)
    f.tailer.tick()
    const keyframe = await f.board.rebuild()
    await assertGolden(f, "first build", keyframe, { rebuild: true })
    assert.ok(keyframe.threads.some((t) => t.id === FOREIGN), "the fixture really has a foreign thread")
    assert.ok(keyframe.threads.find((t) => t.id === "legacy")?.archived, "the legacy row really is archived through its file")
    assert.ok(keyframe.threads.find((t) => t.id === "limited")?.limitPause?.autoResume, "the limit pause really is promised")
    f.events.length = 0
    const snapshot = JSON.parse(JSON.stringify(keyframe)) as BoardSnapshot

    const step = async (name: string, change: () => void | Promise<void>, opts: { rebuild?: boolean } = {}) => {
      await change()
      const warm = opts.rebuild ? await f.board.rebuild() : f.board.refresh()
      await assertGolden(f, name, warm, { ...opts, keyframe: snapshot })
      return warm
    }

    // ---- nothing changed: every archived view is served from the memo --------------------------------
    const quiet = await step("a refresh with nothing changed", () => {})
    assert.equal(quiet.threads.find((t) => t.id === "old-00"), keyframe.threads.find((t) => t.id === "old-00"), "the memo really is serving an untouched archived view")
    const reopened = await step("an archived thread reopened", () => f.storage.setState("old-03", "open"))
    assert.equal(reopened.threads.find((t) => t.id === "old-00"), keyframe.threads.find((t) => t.id === "old-00"), "…and still serving it after another thread's write")

    // ---- lifecycle -----------------------------------------------------------------------------------
    await step("…and archived again", () => f.storage.setState("old-03", "archived"))
    await step("an open thread archived", () => f.storage.setState("open-rested", "archived"))
    await step("a title written", () => f.storage.setTitle("old-07", "Renamed by hand"))

    // ---- the transcript moves under an archived thread ----------------------------------------------
    await step("a terminal resumed an archived thread", () => {
      f.append("old-04", prompt(20, "one more thing"))
      f.append("old-04", reply(22, "done that too"))
      f.tailer.tick()
    })

    // ---- registries ------------------------------------------------------------------------------------
    await step("a completion registered", () => f.storage.markThreadDone("old-05", "Late completion", T0 + 30_000))
    await step("a completion cleared", () => { f.storage.clearThreadDone("old-00") })
    await step("a question asked and withdrawn", () => {
      f.storage.askThreadQuestion({ id: "qst_new", slug: "old-06", spec: JSON.stringify({ question: "Now?", kind: "question", options: [{ label: "A" }, { label: "B" }] }), askedAtMs: T0 + 31_000, handle: "q-new" })
      f.storage.withdrawThreadQuestion("old-06", "qst_new", T0 + 32_000)
    })
    await step("a link saved", () => { f.storage.upsertThreadLink({ id: "lnk_new", slug: "old-08", kind: "link", label: "New", target: "https://example.com/new", createdAtMs: T0 + 33_000 }) })

    // ---- external facts -------------------------------------------------------------------------------
    await step("an archived thread's daemon came back", () => f.setAlive(["open-working-sid", "open-snoozed-sid", "old-09-sid"]))
    await step("…and died again", () => f.setAlive(["open-working-sid", "open-snoozed-sid"]))
    const book = await step("the GitHub book moved", () => f.storage.setSetting(GITHUB_STATUS_SETTING, { "o/r#1": { checks: "running", running: 2, passed: 1, failed: 0, merge: "mergeable", state: "open", polledAt: iso(T0 + 40_000) } }))
    assert.ok(book.threads.find((t) => t.id === "old-12")?.watches.some((w) => w.github), "the archived watch really reads the book")
    const resolved = await step("the Claude catalogue resolved", () => f.setCatalogue([{ alias: "opus", label: "Opus 5.5", resolvedModel: "claude-opus-5-5", edition: "5.5" } as unknown as ClaudeModel]))
    assert.deepEqual(resolved.threads.find((t) => t.id === "behind")?.modelUpgrade, { label: "Opus 5.5", staged: true }, "the archived thread really is behind")
    const revived = await step("the behind thread's daemon came back", () => f.setAlive(["open-working-sid", "open-snoozed-sid", "behind-sid"]))
    assert.equal(revived.threads.find((t) => t.id === "behind")?.modelUpgrade?.staged, false, "liveness really moves an archived view")
    await step("…and died again", () => f.setAlive(["open-working-sid", "open-snoozed-sid"]))
    await step("a question fence refused", () => f.setFaults("old-10", [{ at: at(3), faults: ["no options"] } as unknown as QuestionFenceFault]))
    const asked = await step("an approval asked of an archived thread", () => {
      f.storage.interactions.create(approval("old-11"))
      f.board.interactionChanged?.({ projectId: "p", threadSlug: "old-11", sessionId: "old-11-sid" } as never)
    })
    assert.equal(asked.threads.find((t) => t.id === "old-11")?.pendingInteraction, true, "the interaction really reaches the archived view")

    // ---- the clock alone -------------------------------------------------------------------------------
    await step("time passes, nothing due", () => { f.clock.ms += 60_000 })
    await step("the open snooze expires", () => { f.clock.ms = T0 + 8 * 60_000 + 1 })
    const beforeExpiry = f.board.refresh().threads.find((t) => t.id === "prompted-archived")
    assert.ok(beforeExpiry?.snoozedUntil, "the prompted archived snooze really is visible before its instant")
    const expired = await step("the archived snooze expires", () => { f.clock.ms = T0 + 10 * 60_000 + 1 })
    assert.equal(expired.threads.find((t) => t.id === "prompted-archived")?.snoozedUntil, undefined, "…and the clock alone ends it")
    await step("the sub-agent goes quiet past its window", () => { f.clock.ms = T0 + 4_000 + 16 * 60_000 })
    const late = await step("the limit pause goes stale", () => {
      f.clock.ms = T0 + 7 * 24 * 60 * 60_000
      // A foreign transcript's freshness window (tailer FOREIGN_FRESH_MS, a day) is re-judged by the
      // tailer's own scan on its next tick, not by a board build — so a warm board keeps a foreign thread
      // until that tick, before this change as after. Keep the terminal session live on the new clock so
      // this step stays a pure clock step for the board; foreign aging is not what is under test.
      const seconds = f.clock.ms / 1000
      utimesSync(join(f.logDir, `${FOREIGN}.jsonl`), seconds, seconds)
    })
    assert.equal(late.threads.find((t) => t.id === "limited")?.limitPause?.autoResume, false, "the fixture really crossed the staleness line")

    // ---- a full rebuild re-reads the legacy files -----------------------------------------------------
    await step("the legacy file reopened, then a rebuild", () => writeFileSync(join(f.dir, ".frizz", "legacy.md"), "---\nstatus: active\n---\n\nreopened\n"), { rebuild: true })
    await step("a thread forgotten", () => { f.storage.forgetSession("old-12") })
  } finally { f.close() }
})

// AN OPEN THREAD IS RE-DERIVED ON EVERY BUILD (the clock is one of its inputs), and on a busy board nearly
// every one comes out as it was. The board hands back the view it last shipped when the new one is the
// same (board.ts shippedViewOr), so the differ skips it on identity and publishes nothing for it — and the
// question views it carries are reused while the thread's question rows, telemetry and faults hold
// (questionViewsOf). Each step is still the cold derivation.
test("golden: an open thread that did not change ships the same view object, and one that did ships a new one", async () => {
  const f = fixture()
  try {
    const spec = (question: string) => JSON.stringify({ question, kind: "question", options: [{ label: "Yes" }, { label: "No" }] })
    f.thread("asking", [prompt(1), reply(3, "one question for you")], { state: "open", exited: 0, rested_at: at(3) })
    f.storage.askThreadQuestion({ id: "qst_a", slug: "asking", spec: spec("Ship it?"), askedAtMs: T0 + 3_500, handle: "ship-it" })
    f.thread("quiet", [prompt(1), reply(3, "resting")], { state: "open", exited: 0, rested_at: at(3) })
    f.thread("busy", [prompt(1)], { state: "open", exited: 0 })
    f.setAlive(["asking-sid", "quiet-sid", "busy-sid"])
    primeAll(f.tailer, f.storage)
    const first = await f.board.rebuild()
    await assertGolden(f, "first build", first)
    const view = (b: BoardSnapshot, id: string) => b.threads.find((t) => t.id === id)!
    f.events.length = 0

    f.clock.ms += 1_000
    const again = f.board.refresh()
    for (const id of ["asking", "quiet", "busy"]) assert.equal(view(again, id), view(first, id), `${id}: unchanged, so the same object`)
    assert.equal(f.events.filter((e) => e.type === "board-delta").length, 0, "and no delta at all")
    await assertGolden(f, "a build where nothing moved", again)

    f.append("busy", reply(5, "made progress"))
    f.tailer.tick()
    const moved = f.board.refresh()
    assert.notEqual(view(moved, "busy"), view(again, "busy"), "the thread that moved ships a new view")
    assert.equal(view(moved, "busy").lastAssistant, "made progress")
    assert.equal(view(moved, "quiet"), view(first, "quiet"), "the others keep theirs")
    const delta = f.events.filter((e) => e.type === "board-delta").at(-1) as Extract<ServerEvent, { type: "board-delta" }>
    assert.deepEqual(delta.upserts.map((t) => t.id), ["busy"], "the delta carries the one that moved")
    await assertGolden(f, "one open thread moved", moved)

    // THE FENCE SYNC GROWS A QUESTION ON THE ROW OBJECT THE STORAGE HANDED OUT (question-fences.ts
    // syncQuestionFences: `entry.row.spec = …` after the write), and the storage then keeps that object,
    // and its bucket, as unchanged. The view must carry the grown spec anyway.
    const bucket = f.storage.threadQuestionsBySlug().get("asking")!
    const grown = spec("Ship it today?")
    assert.equal(f.storage.growThreadQuestionSpec("asking", "qst_a", grown), true)
    ;(bucket[0] as { spec: string }).spec = grown
    assert.equal(f.storage.threadQuestionsBySlug().get("asking"), bucket, "precondition: the storage kept the bucket object")
    const regrown = f.board.refresh()
    assert.equal(view(regrown, "asking").questions[0]?.spec.question, "Ship it today?", "the grown spec reached the view")
    await assertGolden(f, "a question grown in place", regrown)

    // The human types past the question: same rows, new telemetry, and the question no longer stands.
    assert.equal(view(regrown, "asking").questions[0]?.standing, true, "precondition: it stands")
    f.append("asking", prompt(9, "never mind, carry on"))
    f.tailer.tick()
    const typedPast = f.board.refresh()
    assert.equal(view(typedPast, "asking").questions[0]?.standing, false, "typed past, it fades")
    await assertGolden(f, "the human typed past the question", typedPast)
  } finally {
    f.close()
  }
})
