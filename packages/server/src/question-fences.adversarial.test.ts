// ADVERSARIAL COVERAGE FOR THE QUESTION REGISTRAR'S SERVER PIPELINE (2026-10-13): transcript → fold →
// sighting → row → RPC. Each test here pins a way the pipeline was found to break, or a seam a reviewer
// attacked that held and is worth keeping held. The companion file (question-fences.test.ts) carries the
// feature's own happy paths.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AskedQuestionSchema, parseQuestionsCancelledWake, questionAnswerMessage, questionFencesIn, questionsCancelledWakeMessage, type BoardSnapshot, type QuestionAnswer, type Settings } from "@frizz/shared"
import { createAcpBackend } from "./backend/acp-transcript.ts"
import type { QuestionSighting } from "./backend/types.ts"
import { safeQuestionSpec, type BoardManager } from "./board.ts"
import type { AppContext } from "./context.ts"
import type { Project } from "./project.ts"
import { createQuestionRegistrar, QUESTION_FENCES_REGISTER_FROM, syncQuestionFences } from "./question-fences.ts"
import { createRouter } from "./router.ts"
import { clearSecrets } from "./secret-files.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import { applyEvent, applyRecord, newTailState, type Tailer } from "./tailer.ts"

const fence = (body: string) => `\`\`\`question\n${body}\n\`\`\``
const choice = (id: string, question = "SQLite or a JSON file?") =>
  fence(`id: ${id}\nkind: choice\nquestion: ${question}\noptions:\n  - label: SQLite\n    recommended: true\n  - label: JSON file`)
// Every fixture instant sits a week AHEAD of the real clock. The code compares a message's time with
// Date.now() (a Goal armed now refuses only questions written after it), and a fixed date stopped
// working the day the clock passed it: these were "2026-10-20T10:00Z", six days ahead when written.
const T0 = Date.now() + 7 * 86_400_000
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString()

function storageHarness() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-question-fences-adv-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  return { dir, storage, close: () => { clearSecrets(dir); storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: "2026-10-01T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}

const sync = (storage: ReturnType<typeof createStorage>, sightings: QuestionSighting[], over: { slug?: string; spawnedAt?: string | number | null; autonomousGoal?: string } = {}) =>
  syncQuestionFences(storage, { slug: over.slug ?? "t", spawnedAt: "spawnedAt" in over ? over.spawnedAt : "2026-10-01T00:00:00.000Z", sightings, autonomousGoal: over.autonomousGoal })

/** The real router over real storage, with the tailer's fold stood in by `sightings` (undefined = the
 *  tailer has not found this thread's transcript at all). */
function routerHarness(sightings: { current: QuestionSighting[] | undefined }) {
  const h = storageHarness()
  const project: Project = { dir: h.dir, id: "qf", name: "test", label: "test", stateDir: h.dir, cwdSlug: "test" }
  const snapshot: BoardSnapshot = { projectDir: h.dir, projectName: "test", projectLabel: "test", threads: [], errors: [], warnings: [] }
  const board: BoardManager = {
    snapshot: async () => snapshot, currentSeq: () => 0, deltasSince: () => null, snapshotState: async () => ({ board: ({}) as never, seq: 0 }), rebuild: async () => snapshot,
    refresh: () => snapshot, start: async () => {}, stop: async () => {},
  }
  const tailer: Tailer = {
    get: () => (sightings.current ? { questionSightings: sightings.current } : undefined) as never, foreignIds: () => [], subAgent: () => undefined,
    forget: () => {}, start: () => {}, stop: () => {}, tick: () => {},
  }
  const scheduler = { start: () => {}, stop: async () => {}, tick: async () => {}, kick: () => {} }
  const ctx = { project, storage: h.storage, board, tailer, scheduler, getSettings: () => ({ permissionMode: "auto" }) as unknown as Settings } as unknown as AppContext
  return { ...h, router: createRouter(ctx) }
}

// ── The ACP fold: a message arrives as streamed PIECES ─────────────────────────────────────────────────
//
// The ACP bridge flushes an agent message's text every second (acp-bridge.ts flushText), so one message
// reaches the transcript as several `assistant-text` records sharing a messageId. A piece is not a
// message: it can begin INSIDE a code block that quotes the grammar, or end halfway through a fence.

const acpLine = (rec: object) => JSON.stringify(rec)

test("ACP: a streamed piece that begins inside a quoting code block registers nothing", () => {
  const acp = createAcpBackend({ stateDir: "/dev/null" })
  const s = newTailState("a", "sid-a", "/dev/null")
  const sample = fence("id: quoted-sample\nkind: text\nquestion: Only an example of the grammar")
  const whole = `The grammar looks like this:\n\n\`\`\`\`md\n${sample}\n\`\`\`\`\n\nThat is all.`
  // The bridge's flush landed just after the outer opener: the second piece starts inside it.
  const cut = whole.indexOf("```question")
  acp.foldLine(s, acpLine({ kind: "turn-start", at: at(0) }))
  acp.foldLine(s, acpLine({ kind: "assistant-text", at: at(0), text: whole.slice(0, cut), final: false, messageId: "m1" }))
  acp.foldLine(s, acpLine({ kind: "assistant-text", at: at(1), text: whole.slice(cut), final: true, messageId: "m1" }))
  acp.foldLine(s, acpLine({ kind: "turn-end", at: at(1), finalText: whole, successful: true }))
  assert.deepEqual(s.questionSightings ?? [], [], "a quoted sample is prose, however the bridge cut the message")
})

test("ACP: a fence split across two streamed pieces mid-turn is sighted once, at the message's own instant", () => {
  const acp = createAcpBackend({ stateDir: "/dev/null" })
  const s = newTailState("a", "sid-a", "/dev/null")
  const whole = `Before I go on:\n\n${choice("settings-store")}\n\nRunning the build meanwhile.`
  const cut = whole.indexOf("options:")
  acp.foldLine(s, acpLine({ kind: "turn-start", at: at(0) }))
  acp.foldLine(s, acpLine({ kind: "assistant-text", at: at(0), text: whole.slice(0, cut), final: false, messageId: "m1" }))
  acp.foldLine(s, acpLine({ kind: "assistant-text", at: at(1), text: whole.slice(cut), final: false, messageId: "m1" }))
  // A tool call ends the message: the text after it is a new one, and nothing echoes the commentary.
  acp.foldLine(s, acpLine({ kind: "tool-call", at: at(2), id: "t1", name: "bash", input: {} }))
  acp.foldLine(s, acpLine({ kind: "assistant-text", at: at(3), text: "Build is green.", final: true, messageId: "m2" }))
  acp.foldLine(s, acpLine({ kind: "turn-end", at: at(3), finalText: "Build is green.", successful: true }))
  assert.deepEqual(s.questionSightings, [{ at: at(0), text: choice("settings-store") }])
})

test("ACP: the final message's pieces and the turn-end echo are ONE sighting", () => {
  const acp = createAcpBackend({ stateDir: "/dev/null" })
  const s = newTailState("a", "sid-a", "/dev/null")
  const whole = `Needs you:\n\n${choice("settings-store")}`
  const cut = whole.indexOf("kind:")
  acp.foldLine(s, acpLine({ kind: "assistant-text", at: at(0), text: whole.slice(0, cut), final: false, messageId: "m1" }))
  acp.foldLine(s, acpLine({ kind: "assistant-text", at: at(1), text: whole.slice(cut), final: true, messageId: "m1" }))
  acp.foldLine(s, acpLine({ kind: "turn-end", at: at(2), finalText: whole, successful: true }))
  assert.deepEqual(s.questionSightings, [{ at: at(0), text: choice("settings-store") }])
})

// ── The codex fold: the final answer is written twice ─────────────────────────────────────────────────

test("codex: the final answer echoed on task_complete a beat later is one sighting, not two", () => {
  const c = newTailState("c", "sid-c", "/dev/null")
  applyEvent(c, { kind: "turn-start", at: at(0) })
  applyEvent(c, { kind: "assistant-text", text: choice("end"), final: true, at: at(1) })
  // task_complete carries its own, later, timestamp (codex.ts) — the existing test used the same instant.
  applyEvent(c, { kind: "turn-end", finalText: choice("end"), at: at(2) })
  assert.deepEqual(c.questionSightings?.map((x) => x.at), [at(1)])
  // …and a turn-end whose final text no assistant-text carried is still noted, at its own instant.
  const d = newTailState("d", "sid-d", "/dev/null")
  applyEvent(d, { kind: "turn-start", at: at(0) })
  applyEvent(d, { kind: "turn-end", finalText: choice("only-on-bracket"), at: at(2) })
  assert.deepEqual(d.questionSightings?.map((x) => x.at), [at(2)])
})

// ── The Claude fold: one API message is several JSONL records ─────────────────────────────────────────

test("claude: only an assistant TEXT block with a timestamp is read — never thinking, a tool's input, an API error or a child", () => {
  const s = newTailState("t", "sid-t", "/dev/null")
  const rec = (timestamp: string | undefined, content: unknown[], extra: object = {}) => applyRecord(s, {
    type: "assistant", ...(timestamp ? { timestamp } : {}), uuid: `u-${Math.random()}`, ...extra,
    message: { id: "msg_1", role: "assistant", content, stop_reason: null },
  } as never)
  // Claude Code writes one record per content block, all sharing the API message's id.
  rec(at(0), [{ type: "thinking", thinking: choice("thought") }])
  rec(at(0), [{ type: "text", text: `Before I go on:\n\n${choice("settings-store")}` }])
  rec(at(1), [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: `cat <<'X'\n${choice("in-tool-input")}\nX` } }])
  // The tool's result is a USER record: a file the worker read (this spec, say) is not the worker asking.
  applyRecord(s, { type: "user", timestamp: at(2), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: choice("in-tool-result") }] } } as never)
  rec(at(3), [{ type: "text", text: choice("api-error") }], { isApiErrorMessage: true })
  rec(at(4), [{ type: "text", text: choice("child") }], { isSidechain: true })
  // The same record again (a replayed line) is the same sighting.
  rec(at(0), [{ type: "text", text: `Before I go on:\n\n${choice("settings-store")}` }])
  assert.deepEqual(s.questionSightings, [{ at: at(0), text: choice("settings-store") }, { at: at(0), text: choice("settings-store") }].slice(0, s.questionSightings?.length))
  assert.ok((s.questionSightings?.length ?? 0) <= 2)
  assert.deepEqual([...new Set(s.questionSightings?.map((x) => x.text))], [choice("settings-store")])
})

// ── The registrar against real storage ────────────────────────────────────────────────────────────────

test("every fence the parser accepts at its limits is a spec the stored schema reads back", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const options = (n: number, each = (i: number) => `opt ${i}`) => Array.from({ length: n }, (_, i) => `  - label: ${each(i)}`).join("\n")
    const fences = [
      fence(`id: q4000\nkind: text\nquestion: ${"x".repeat(4000)}`),
      fence(`id: ctx\nkind: text\nquestion: Q?\n---\n${"c".repeat(20000)}`),
      fence(`id: label400\nkind: choice\nquestion: Q?\noptions:\n${options(2, (i) => `${i}${"y".repeat(399)}`)}`),
      fence(`id: many\nkind: multi\nquestion: Q?\noptions:\n${options(300)}`),
      fence(`id: header\nkind: text\nquestion: Q?\nheader: ${"h".repeat(24)}`),
      fence(`id: ${"i".repeat(64)}\nkind: text\nquestion: Q?`),
      fence(`id: desc\nkind: choice\nquestion: Q?\noptions:\n  - label: A\n    description: ${"d".repeat(10000)}\n    detail: |\n      ${"e".repeat(9998)}\n  - label: B`),
    ]
    for (const [i, text] of fences.entries()) {
      const asks = questionFencesIn(text).asks
      assert.equal(asks.length, 1, `fence ${i} parses to one ask`)
      assert.equal(AskedQuestionSchema.safeParse(asks[0].spec).success, true, `fence ${i} passes the stored schema`)
    }
    const out = sync(h.storage, fences.map((text, i) => ({ at: at(i), text })))
    assert.deepEqual(out.faults, [])
    assert.equal(out.registered.length, fences.length)
    // The board and the router both drop a row whose spec fails the schema — none of these may.
    for (const q of h.storage.listThreadQuestions("t")) assert.ok(safeQuestionSpec(q.spec), `${q.handle} reads back`)
    // One past each limit is refused BY NAME, and its neighbours in the same message still register.
    const over = sync(h.storage, [{
      at: at(20),
      text: [
        fence(`id: too-long\nkind: text\nquestion: ${"x".repeat(4001)}`),
        choice("fine-beside-it"),
        fence(`id: ctx-too-long\nkind: text\nquestion: Q?\n---\n${"c".repeat(20001)}`),
      ].join("\n\n"),
    }])
    assert.deepEqual(over.registered.map((q) => q.handle), ["fine-beside-it"])
    assert.deepEqual(over.faults.map((f) => f.id), ["too-long", "ctx-too-long"])
  } finally { h.close() }
})

test("a thread with a null, malformed or pre-cutover spawned_at registers nothing and throws nothing", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const sightings = [{ at: at(0), text: choice("settings-store") }, { at: at(1), text: fence("id: broken\nkind: choice") }]
    for (const spawnedAt of [null, undefined, "", "not a date", "2026-09-10T23:59:59.000Z", Number.NaN, 0]) {
      const out = sync(h.storage, sightings, { spawnedAt: spawnedAt as never })
      assert.deepEqual(out, { registered: [], cancelled: [], attached: [], faults: [], refs: [] }, `spawned_at ${String(spawnedAt)}`)
    }
    assert.equal(h.storage.listThreadQuestions("t").length, 0)
    // A sighting with no readable instant, or one from before the cutover, is skipped the same way.
    const stale = sync(h.storage, [{ at: "", text: choice("a") }, { at: "garbage", text: choice("b") }, { at: new Date(Date.parse(QUESTION_FENCES_REGISTER_FROM) - 1).toISOString(), text: choice("c") }])
    assert.deepEqual(stale, { registered: [], cancelled: [], attached: [], faults: [], refs: [] })
  } finally { h.close() }
})

test("a restart's refold of registered, answered, withdrawn and re-asked ids mints nothing and moves no asked_at", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const transcript: QuestionSighting[] = [
      { at: at(0), text: `${choice("answered")}\n\n${choice("withdrawn", "Withdraw me?")}\n\n${choice("still-open", "Still open?")}` },
    ]
    sync(h.storage, transcript)
    const byHandle = () => new Map(h.storage.listThreadQuestions("t").map((q) => [q.handle, q]))
    h.storage.answerThreadQuestion(byHandle().get("answered")!.id, JSON.stringify({ questionId: "x", question: "SQLite or a JSON file?", chosen: ["SQLite"] }), Date.parse(at(2)))
    h.storage.withdrawThreadQuestion("t", byHandle().get("withdrawn")!.id, Date.parse(at(2)))
    // After the answer the worker asks both settled ids again (each a new question under its freed id),
    // then references them and the open one.
    transcript.push(
      { at: at(3), text: `${choice("answered")}\n\n${choice("withdrawn", "Withdraw me, then ask me again?")}` },
      { at: at(4), text: `${fence("id: still-open")}\n\n${fence("id: answered")}\n\n${fence("id: withdrawn")}` },
    )
    const live = sync(h.storage, transcript)
    assert.deepEqual(live.registered.map((q) => [q.handle, q.asked_at]), [["answered", Date.parse(at(3))], ["withdrawn", Date.parse(at(3))]])
    const before = JSON.stringify(h.storage.listThreadQuestions("t"))
    // THE RESTART: a new process, an empty memo, the same file folded from byte 0 — twice over, as a
    // registrar sweep and as a scheduler tick both read it.
    for (let boot = 0; boot < 3; boot++) {
      const again = sync(h.storage, transcript)
      assert.deepEqual(again.registered, [], "nothing re-registers")
      assert.deepEqual(again.faults, live.faults, "and no fault the live run had not already raised")
      assert.equal(JSON.stringify(h.storage.listThreadQuestions("t")), before, "no row moved — asked_at, state and answer are as they were")
    }
    assert.deepEqual(live.faults, [])
    assert.equal(h.storage.listThreadQuestions("t").length, 5)
  } finally { h.close() }
})

test("the sighting ring keeps the newest 32 messages, and a registrar that sweeps on every change misses none of 100", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const s = newTailState("t", "sid-t", "/dev/null")
    const registrar = createQuestionRegistrar({ storage: h.storage, tailer: { get: () => ({ questionSightings: s.questionSightings }) } })
    for (let i = 0; i < 100; i++) {
      applyRecord(s, { type: "assistant", timestamp: at(i), uuid: `u${i}`, message: { id: `m${i}`, role: "assistant", content: [{ type: "text", text: choice(`q-${i}`, `Question ${i}?`) }], stop_reason: null } } as never)
      registrar.sweep()
    }
    assert.equal(s.questionSightings?.length, 32)
    assert.equal(h.storage.listThreadQuestions("t").length, 100)
    assert.equal(new Set(h.storage.listThreadQuestions("t").map((q) => q.handle)).size, 100, "one row per id")
  } finally { h.close() }
})

test("one thread's failing sweep neither stops the other threads' nor is retried on every tick", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("a-broken"))
    h.storage.upsertSession(row("b-fine"))
    const sightings: Record<string, QuestionSighting[]> = {
      "a-broken": [{ at: at(0), text: choice("boom") }],
      "b-fine": [{ at: at(0), text: choice("settings-store") }],
    }
    let asks = 0
    const logged: string[] = []
    const storage = {
      allSessions: () => h.storage.allSessions(),
      listThreadQuestions: (slug: string) => h.storage.listThreadQuestions(slug),
      clearThreadDone: (slug: string) => h.storage.clearThreadDone(slug),
      resetParkBumps: (slug: string) => h.storage.resetParkBumps(slug),
      growThreadQuestionSpec: (slug: string, id: string, spec: string) => h.storage.growThreadQuestionSpec(slug, id, spec),
      dismissThreadQuestion: (id: string, atMs: number) => h.storage.dismissThreadQuestion(id, atMs),
      askThreadQuestion: (q: Parameters<typeof h.storage.askThreadQuestion>[0]) => {
        asks++
        if (q.slug === "a-broken") throw new Error("database is locked")
        return h.storage.askThreadQuestion(q)
      },
    }
    const registrar = createQuestionRegistrar({ storage, tailer: { get: (slug) => ({ questionSightings: sightings[slug] }) }, log: (m) => logged.push(m) })
    assert.doesNotThrow(() => registrar.sweep())
    assert.equal(h.storage.listThreadQuestions("b-fine").length, 1, "the thread after the failing one still registered")
    const failures = () => logged.filter((m) => /a-broken/.test(m) && /failed/.test(m)).length
    assert.equal(failures(), 1, "the failure is logged, by thread")
    registrar.sweep()
    registrar.sweep()
    assert.equal(failures(), 1, "and not again on every tick while nothing changed")
    // …but it is not forgotten either: the next change to that thread's sightings tries again.
    sightings["a-broken"] = [...sightings["a-broken"], { at: at(1), text: choice("boom-2") }]
    const before = asks
    registrar.sweep()
    assert.ok(asks > before)
  } finally { h.close() }
})

test("two paths registering the same fence at once — the registrar's sweep and a done/unask catch-up — leave ONE row", async () => {
  const sightings = { current: [{ at: at(0), text: `${choice("settings-store")}\n\n${choice("second", "Another?")}` }] as QuestionSighting[] }
  const h = routerHarness(sightings)
  try {
    h.storage.upsertSession(row("t"))
    const registrar = createQuestionRegistrar({ storage: h.storage, tailer: { get: () => ({ questionSightings: sightings.current }) } })
    // Every caller in one turn of the event loop, the way a tailer tick and two worker RPCs can land.
    await Promise.all([
      h.router.markOwnDone.handler({ input: { slug: "t", body: "- Done." } }),
      Promise.resolve().then(() => registrar.sweep()),
      h.router.unask.handler({ input: { slug: "t", id: "no-such-id" } }),
      Promise.resolve().then(() => sync(h.storage, sightings.current)),
      h.router.markOwnDone.handler({ input: { slug: "t", body: "- Done." } }),
    ])
    assert.deepEqual(h.storage.listThreadQuestions("t").map((q) => q.handle).sort(), ["second", "settings-store"])
  } finally { h.close() }
})

// ── The RPCs, by the names the worker knows ───────────────────────────────────────────────────────────

const followUpTree = `${choice("settings-store")}\n\n${fence("id: sqlite-path\nkind: text\nwhen: settings-store = SQLite\nquestion: Where should the file live?")}`

test("unask by a follow-up's id withdraws nothing, and names the root that would take it", async () => {
  const h = routerHarness({ current: [{ at: at(0), text: followUpTree }] })
  try {
    h.storage.upsertSession(row("t"))
    const out = await h.router.unask.handler({ input: { slug: "t", id: "sqlite-path" } })
    assert.equal(out.withdrawn, false, "the parent is a question the worker did not name")
    assert.equal(out.id, "settings-store", "…and it is told which id withdraws the pair")
    assert.equal(out.state, "open")
    assert.deepEqual(h.storage.listThreadQuestions("t", { openOnly: true }).map((q) => q.handle), ["settings-store"])
    // By its own id the root goes, follow-up and all.
    assert.equal((await h.router.unask.handler({ input: { slug: "t", id: "Settings-Store" } })).withdrawn, true)
    // Naming the root itself, or a legacy qst_ row, reports that same name back.
    const legacy = h.storage.askThreadQuestion({ id: "qst_aaaaaaaaaaaa", slug: "t", spec: JSON.stringify({ question: "Q?", kind: "question" }), askedAtMs: 1 })
    assert.equal((await h.router.unask.handler({ input: { slug: "t", id: legacy.id } })).id, legacy.id)
  } finally { h.close() }
})

test("unask of an id that is already settled withdraws nothing and says what became of it", async () => {
  const h = routerHarness({ current: [{ at: at(0), text: `${choice("answered")}\n\n${choice("dismissed", "Dismiss me?")}` }] })
  try {
    h.storage.upsertSession(row("t"))
    await h.router.unask.handler({ input: { slug: "t", id: "nothing-yet" } }) // catches the registrar up
    const [a, d] = h.storage.listThreadQuestions("t")
    await h.router.answerQuestions.handler({ input: { slug: "t", answers: [{ questionId: a.id, question: "SQLite or a JSON file?", chosen: ["SQLite"] }] } })
    await h.router.dismissQuestions.handler({ input: { slug: "t", ids: [d.id] } })
    const answered = await h.router.unask.handler({ input: { slug: "t", id: "answered" } })
    assert.deepEqual([answered.withdrawn, answered.id, answered.state], [false, "answered", "answered"])
    const dismissed = await h.router.unask.handler({ input: { slug: "t", id: "dismissed" } })
    assert.deepEqual([dismissed.withdrawn, dismissed.state], [false, "dismissed"])
    const unknown = await h.router.unask.handler({ input: { slug: "t", id: "never-asked" } })
    assert.deepEqual([unknown.withdrawn, unknown.id, unknown.state], [false, undefined, undefined])
    assert.equal(h.storage.getThreadQuestion(a.id)?.state, "answered", "the answer the human gave is untouched")
  } finally { h.close() }
})

test("a fence question with a follow-up is answered as one tree, and the wake restates both questions", async () => {
  const h = routerHarness({ current: [{ at: at(0), text: followUpTree }] })
  try {
    h.storage.upsertSession(row("t"))
    await h.router.unask.handler({ input: { slug: "t", id: "nothing-yet" } })
    const [q] = h.storage.listThreadQuestions("t")
    const answer: QuestionAnswer = {
      questionId: q.id, question: "SQLite or a JSON file?", chosen: ["SQLite"],
      followUps: [{ questionId: q.id, question: "Where should the file live?", chosen: [], text: "beside the sessions db" }],
    }
    const out = await h.router.answerQuestions.handler({ input: { slug: "t", answers: [answer] } })
    assert.deepEqual(out.answered, [q.id])
    assert.deepEqual(JSON.parse(h.storage.getThreadQuestion(q.id)!.answer!), answer)
    assert.equal(questionAnswerMessage([answer]), "Answers to earlier questions:\n1. “SQLite or a JSON file?” → SQLite\n2. ⤷ “Where should the file live?” → beside the sessions db")
    // A second tab sending the same card answers nothing, and cannot overwrite the first.
    const replay = await h.router.answerQuestions.handler({ input: { slug: "t", answers: [{ ...answer, chosen: ["JSON file"], followUps: [] }] } })
    assert.deepEqual(replay.answered, [])
    assert.deepEqual(JSON.parse(h.storage.getThreadQuestion(q.id)!.answer!), answer)
  } finally { h.close() }
})

test("the human's × cannot dismiss a `danger: true` fence question, and arming a Goal does not either", async () => {
  const danger = fence("id: force-push\nkind: choice\ndanger: true\nquestion: Force-push over main?\noptions:\n  - label: Force-push\n  - label: Leave it")
  const h = routerHarness({ current: [{ at: at(0), text: `${danger}\n\n${choice("ordinary")}` }] })
  try {
    h.storage.upsertSession(row("t"))
    await h.router.unask.handler({ input: { slug: "t", id: "nothing-yet" } })
    const rows = h.storage.listThreadQuestions("t")
    const out = await h.router.dismissQuestions.handler({ input: { slug: "t", ids: rows.map((q) => q.id) } })
    assert.deepEqual(out.dismissed, [rows.find((q) => q.handle === "ordinary")!.id])
    assert.deepEqual(out.open.map((q) => q.handle), ["force-push"])
    assert.equal(out.open[0].spec.danger, true)
  } finally { h.close() }
})

test("a `kind: secret` fence registers a secret, names its pipe, and its value never reaches the database", async () => {
  const h = routerHarness({ current: [{ at: at(0), text: fence("id: npm-otp\nkind: secret\nquestion: The npm one-time code for the frizz-server publish") }] })
  try {
    h.storage.upsertSession(row("t"))
    const read = await h.router.unask.handler({ input: { slug: "t", id: "nothing-yet" } })
    const [view] = read.open
    assert.equal(view.handle, "npm-otp")
    assert.equal(view.spec.secret, true)
    assert.equal(view.secretPath, join(h.dir, "secrets", "t", view.id))
    const value = "otp-7f3a91-NEVER-STORED"
    const out = await h.router.answerQuestions.handler({ input: { slug: "t", answers: [{ questionId: view.id, question: view.spec.question, chosen: [], text: value }] } })
    assert.deepEqual(out.answered, [view.id])
    const stored = JSON.parse(h.storage.getThreadQuestion(view.id)!.answer!) as QuestionAnswer
    assert.match(stored.text ?? "", new RegExp(`secret ready at '${view.secretPath!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}'`))
    assert.equal(questionAnswerMessage([stored]).includes(value), false, "the wake carries the path")
    // Every byte SQLite wrote — the file, its WAL and its shm.
    h.storage.db.pragma("wal_checkpoint(TRUNCATE)")
    for (const name of readdirSync(h.dir)) {
      if (!name.startsWith("ui.db")) continue
      assert.equal(readFileSync(join(h.dir, name)).includes(Buffer.from(value)), false, `${name} holds the secret`)
    }
  } finally { h.close() }
})

test("`done` before the tailer has found the transcript at all is undone by the fence once it is read", async () => {
  const sightings: { current: QuestionSighting[] | undefined } = { current: undefined }
  const h = routerHarness(sightings)
  try {
    h.storage.upsertSession(row("t"))
    // Nothing folded yet: the gate has nothing to refuse on.
    const early = await h.router.markOwnDone.handler({ input: { slug: "t", body: "- Shipped." } })
    assert.equal(early.done, true)
    assert.ok(h.storage.getThreadDone("t"))
    // The transcript is discovered; the registrar reads the fence the same message carried.
    sightings.current = [{ at: at(0), text: choice("settings-store") }]
    createQuestionRegistrar({ storage: h.storage, tailer: { get: () => ({ questionSightings: sightings.current }) } }).sweep()
    assert.equal(h.storage.getThreadDone("t"), undefined, "a question trumps the done that raced it")
    assert.equal(h.storage.listThreadQuestions("t", { openOnly: true }).length, 1)
  } finally { h.close() }
})

// ── The wakes, by the names the worker knows ──────────────────────────────────────────────────────────

test("the cancellation wake names each cancelled question by the worker's own id, under a lead the chat still parses", () => {
  const bare = questionsCancelledWakeMessage(2)
  const named = questionsCancelledWakeMessage(2, [{ handle: "settings-store", question: "SQLite or a JSON file?" }, { question: "Asked through the old tool?" }])
  assert.ok(named.startsWith(bare), "the lead is unchanged")
  assert.deepEqual(parseQuestionsCancelledWake(named), { count: 2 }, "the chat's hairline still reads the count")
  assert.match(named, /- `settings-store` — “SQLite or a JSON file\?”/)
  assert.match(named, /- “Asked through the old tool\?”/)
  // With nothing to name it is the message it always was.
  assert.equal(questionsCancelledWakeMessage(1, []), questionsCancelledWakeMessage(1))
})

test("an autonomous thread's cancellation wake reaches the worker naming the fence ids that were cancelled", async () => {
  const { createScheduler } = await import("./scheduler.ts")
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const danger = fence("id: force-push\nkind: choice\ndanger: true\nquestion: Force-push over main?\noptions:\n  - label: Force-push\n  - label: Leave it")
    sync(h.storage, [{ at: at(0), text: `${choice("settings-store")}\n\n${danger}` }])
    // The Goal is armed: every ordinary question is cancelled, the danger-tagged one survives.
    h.storage.db.prepare("UPDATE session SET recurring_on_rest = 1, recurring_prompt = 'Keep going.' WHERE slug = 't'").run()
    const ordinary = h.storage.listThreadQuestions("t").find((q) => q.handle === "settings-store")!
    h.storage.dismissThreadQuestion(ordinary.id, Date.parse(at(1)))
    const s = createScheduler({
      wakeQuietWindowMs: 0, storage: h.storage, fetchPr: async () => undefined, fetchGithubReview: async () => [],
      tailer: { get: () => ({ turn: "idle", lastAssistantAt: at(0), lastActivityAt: at(0), subAgents: [], bgShells: [], pendingQuestion: false, permPrompt: false }) } as never,
      resume: async () => {}, log: () => {},
    })
    await s.tick()
    const wakes = (h.storage.db.prepare("SELECT message FROM wake_delivery WHERE thread_slug = 't'").all() as { message: string }[]).map((w) => w.message)
    const cancelled = wakes.find((m) => /CANCELLED without an answer/.test(m))
    assert.ok(cancelled, `a cancellation wake was queued (got: ${JSON.stringify(wakes)})`)
    assert.match(cancelled, /- `settings-store` — “SQLite or a JSON file\?”/)
    assert.doesNotMatch(cancelled, /force-push/, "the surviving danger question is not named as cancelled")
  } finally { h.close() }
})

// Reported by this file as a design concern (the refusal was a fault that left no trace), then fixed: the
// refusal is a row, cancelled the moment it is written.
test("a fence refused on an autonomous thread stays refused when the Goal is disarmed", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const sightings = [{ at: at(0), text: choice("settings-store") }]
    const refused = sync(h.storage, sightings, { autonomousGoal: "Keep going until the suite is green." })
    assert.deepEqual(refused.cancelled.map((q) => q.handle), ["settings-store"])
    // The worker was told to decide it itself, and did. Then the human disarms the Goal.
    const after = sync(h.storage, sightings)
    assert.deepEqual(after.registered, [], "the question the worker was told was NOT asked is now an open card, and blocks `done`")
  } finally { h.close() }
})
