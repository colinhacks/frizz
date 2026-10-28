// THE OPENERS THE READER TOOK ON 2026-10-13 — a ~~~question fence and a capitalised ```Question — through
// the three server seams they cross: the fold that notes a message's fences, the registrar that turns a
// sighting into a row, and the cache whose invalidation is what makes an old transcript read again.
//
// The grammar itself is pinned with the parser (shared question-fence.test.ts) and the page's agreement
// with it in the web (questionFenceAgreement.test.ts). This file is about what an UPGRADE does: a
// transcript written before the reader took these forms already holds some, and the refold that follows a
// parser change replays every message against rows the old reading made.

import { test } from "node:test"
import assert from "node:assert/strict"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { questionFenceBlocks, questionHandles, type AskedQuestion } from "@frizz/shared"
import type { QuestionSighting } from "./backend/types.ts"
import { QUESTION_FENCES_REGISTER_FROM, standingQuestions, syncQuestionFences } from "./question-fences.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import { applyRecord, hasQuestionBlock, newTailState, parseSignalFence } from "./tailer.ts"

const backtick = (body: string) => `\`\`\`question\n${body}\n\`\`\``
const tilde = (body: string) => `~~~question\n${body}\n~~~`
const capital = (body: string) => `\`\`\`Question\n${body}\n\`\`\``
const choiceBody = (id: string, question = "SQLite or a JSON file?") => `id: ${id}\nkind: choice\nquestion: ${question}\noptions:\n  - label: SQLite\n    recommended: true\n  - label: JSON file`
const textBody = (id: string, question = "Which scope?") => `id: ${id}\nkind: text\nquestion: ${question}`
// After QUESTION_FENCES_REGISTER_FROM, so every sighting here is one the registrar reads.
// Every fixture instant sits a week AHEAD of the real clock. The code compares a message's time with
// Date.now() (a Goal armed now refuses only questions written after it), and a fixed date stopped
// working the day the clock passed it: these were "2026-10-20T10:00Z", six days ahead when written.
const T0 = Date.now() + 7 * 86_400_000
const at = (minute: number) => new Date(T0 + minute * 60_000).toISOString()

function storageHarness() {
  const dir = mkdtempSync(join(tmpdir(), "frizz-question-openers-"))
  const storage = createStorage(join(dir, "ui.db"), "p")
  return { dir, storage, close: () => { storage.close(); rmSync(dir, { recursive: true, force: true }) } }
}

function row(slug: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug, session_id: `sid-${slug}`, thread_name: `frizz-${slug}`, spawned_at: "2026-10-01T00:00:00.000Z",
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: slug, state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}

const sync = (storage: ReturnType<typeof createStorage>, sightings: QuestionSighting[], over: { spawnedAt?: string; autonomousGoal?: string } = {}) =>
  syncQuestionFences(storage, { slug: "t", spawnedAt: over.spawnedAt ?? "2026-10-01T00:00:00.000Z", sightings, autonomousGoal: over.autonomousGoal })

/** What the fold notes for one assistant message — the registrar's whole view of it. */
function foldedSightings(text: string, timestamp = at(0)): QuestionSighting[] {
  const s = newTailState("t", "sid-t", "/dev/null")
  applyRecord(s, { type: "assistant", timestamp, message: { role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" } } as never)
  return s.questionSightings ?? []
}

/** The sighting the fold kept for a message BEFORE the reader took the new openers: only its three-backtick,
 *  lowercase fences, each one's source verbatim. Rebuilt here so a test can stand a row the way the old
 *  reading stood it. */
function sightingAsItWas(text: string, timestamp = at(0)): QuestionSighting[] {
  const kept = questionFenceBlocks(text).map((b) => text.slice(b.start, b.end).trimEnd()).filter((source) => source.startsWith("```question\n"))
  return kept.length ? [{ at: timestamp, text: kept.join("\n\n") }] : []
}

// ── The fold ───────────────────────────────────────────────────────────────────────────────────────────

test("the fold notes a tilde fence and a capitalised one, each fence's own source, and still nothing for a quoted one", () => {
  // The gate in front of the reader was a case-sensitive `includes("question")`: a QUESTION fence would
  // have been dropped here whatever the reader made of it.
  for (const [name, source] of [["tilde", tilde(textBody("npm-scope"))], ["capitalised", capital(textBody("npm-scope"))], ["capitals", capital(textBody("npm-scope")).replace("Question", "QUESTION")], ["tilde, capitalised", tilde(textBody("npm-scope")).replace("question", "Question")]] as const) {
    assert.deepEqual(foldedSightings(`The scope is undecided.\n\n${source}\n\nI will wait.`), [{ at: at(0), text: source }], name)
  }
  // Two fences of different characters in one message, the first holding a code block.
  const first = `~~~question\n${textBody("run-migration", "Run it?")}\n---\n\`\`\`sql\nALTER TABLE orders ADD COLUMN archived_at timestamptz;\n\`\`\`\n~~~`
  const second = backtick(textBody("backfill", "Backfill too?"))
  assert.deepEqual(foldedSightings(`Ready.\n\n${first}\n\n${second}\n\n\`\`\`awaiting\nstatus: blocked\n\`\`\``), [{ at: at(0), text: `${first}\n\n${second}` }])
  // QUOTED: nothing is noted, so nothing can register or be corrected.
  for (const quoted of [`\`\`\`\`md\n${tilde(textBody("x"))}\n\`\`\`\``, `\`\`\`md\n${tilde(textBody("x"))}\n\`\`\``, `~~~md\n${backtick(textBody("x"))}\n~~~`, tilde(textBody("x")).split("\n").map((l) => `> ${l}`).join("\n"), capital(textBody("x")).split("\n").map((l) => `    ${l}`).join("\n")]) {
    assert.deepEqual(foldedSightings(`Here is the grammar:\n\n${quoted}\n\nThat is all.`), [], quoted)
  }
})

test("the signal fence after a tilde question is still the message's signal fence, and the legacy flag does not see the new forms", () => {
  const nested = `~~~question\n${textBody("run-migration", "Run it?")}\n---\n\`\`\`sql\nSELECT 1\n\`\`\`\n~~~`
  assert.deepEqual(parseSignalFence(`${nested}\n\n\`\`\`done\nShipped.\n\`\`\``), { kind: "done", body: "Shipped.", hints: [] })
  assert.equal(parseSignalFence(`${nested}\n\n\`\`\`awaiting\nstatus: blocked\n\`\`\``)?.kind, "awaiting")
  // THE LEGACY PENDING-QUESTION FLAG (a thread dispatched before the cutover) knows one opener. A tilde or
  // capitalised block was a code block to it and still is.
  assert.equal(hasQuestionBlock("~~~question\nWhich store?\n- A. SQLite\n- B. JSON\n~~~"), false)
  assert.equal(hasQuestionBlock("```Question\nWhich store?\n- A. SQLite\n- B. JSON\n```"), false)
  assert.equal(hasQuestionBlock("``` question\nWhich store?\n```"), false)
  assert.equal(hasQuestionBlock("```question\nWhich store?\n- A. SQLite\n- B. JSON\n```"), true)
  // …and its own fence beside or after one of them reads as it did.
  assert.equal(hasQuestionBlock("~~~question\nnot an ask on this thread\n~~~\n\n```question\nWhich port?\n```"), true)
  assert.equal(hasQuestionBlock("~~~md\n```question\nWhich port?\n```\n~~~"), false, "quoted inside a tilde block")
})

// ── The registrar ──────────────────────────────────────────────────────────────────────────────────────

test("a tilde fence and a capitalised one each register ONE row at the message's instant, and a reference in either form names it", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const asked = foldedSightings(`${tilde(choiceBody("settings-store"))}\n\n${capital(textBody("npm-scope"))}`)
    const first = sync(h.storage, asked)
    assert.deepEqual(first.faults, [])
    assert.deepEqual(first.registered.map((q) => [q.handle, q.asked_at, q.state]), [["settings-store", Date.parse(at(0)), "open"], ["npm-scope", Date.parse(at(0)), "open"]])
    // What is stored is what the taught fence stores: the opener's spelling is no part of the question.
    const taught = sync(storageHarnessOnce(), foldedSightings(`${backtick(choiceBody("settings-store"))}\n\n${backtick(textBody("npm-scope"))}`))
    assert.deepEqual(first.registered.map((q) => JSON.parse(q.spec)), taught.registered.map((q) => JSON.parse(q.spec)))
    // A later rest references one in each form: no new row, and both stand again past the human's message.
    const later = [...asked, ...foldedSightings(`Still need both.\n\n${tilde("id: settings-store")}\n\n${capital("id: npm-scope")}`, at(9))]
    const again = sync(h.storage, later)
    assert.deepEqual([again.registered, again.faults], [[], []])
    assert.deepEqual(again.refs.filter((r) => r.at === at(9)).length, 2)
    assert.deepEqual(standingQuestions(h.storage.listThreadQuestions("t"), { lastUserAt: at(5), questionSightings: later }).map((q) => q.handle).sort(), ["npm-scope", "settings-store"])
    // …and the same question restated in the OTHER form is the same question, not a second use of its id.
    const restated = sync(h.storage, [...later, ...foldedSightings(backtick(choiceBody("settings-store")), at(12))])
    assert.deepEqual([restated.registered, restated.faults], [[], []])
    assert.equal(h.storage.listThreadQuestions("t").length, 2)
  } finally { h.close(); for (const close of closers.splice(0)) close() }
})

const closers: (() => void)[] = []
/** A second, empty store, for registering the same question another way and comparing what is kept. */
function storageHarnessOnce(): ReturnType<typeof createStorage> {
  const h = storageHarness()
  h.storage.upsertSession(row("t"))
  closers.push(h.close)
  return h.storage
}

test("a malformed tilde fence is refused by name, where it used to be nothing at all", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const out = sync(h.storage, foldedSightings(tilde("id: settings-store\nkind: pick\nquestion: Which store?")))
    assert.deepEqual(out.registered, [])
    assert.deepEqual(out.faults, [{ at: at(0), id: "settings-store", faults: ["`kind: pick` — the kinds are `choice`, `multi`, `text`, `secret`"] }])
  } finally { h.close() }
})

test("a thread dispatched before the cutover registers nothing from the new forms, and neither does a message from before registration began", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const sightings = foldedSightings(`${tilde(choiceBody("settings-store"))}\n\n${capital("id: x\nkind: pick\nquestion: Q?")}`)
    assert.equal(sightings.length, 1, "the fold notes them on any thread; who reads them is the registrar's call")
    // LEGACY: spawned before QUESTION_FENCE_RETIRED_AT. Its contract never taught this grammar.
    assert.deepEqual(sync(h.storage, sightings, { spawnedAt: "2026-09-01T00:00:00.000Z" }), { registered: [], cancelled: [], attached: [], faults: [], refs: [] })
    // Written before the registrar read fences at all: skipped, well-formed or not.
    const early = new Date(Date.parse(QUESTION_FENCES_REGISTER_FROM) - 60_000).toISOString()
    assert.deepEqual(sync(h.storage, foldedSightings(`${tilde(choiceBody("settings-store"))}\n\n${capital("id: x\nkind: pick\nquestion: Q?")}`, early)), { registered: [], cancelled: [], attached: [], faults: [], refs: [] })
    assert.deepEqual(h.storage.listThreadQuestions("t"), [])
  } finally { h.close() }
})

// ── The refold after the upgrade ───────────────────────────────────────────────────────────────────────
//
// A message written before the reader took the new forms held ONE fence the old reading registered and one
// it took for a code block. The parser change moves the fold-schema digest (below), every cached tail is
// refolded, and the same message now carries two fences — at the instant the first one's row was made.

test("refolded, a message that held one real fence and one near-miss registers the near-miss at the message's own instant and leaves the first row alone", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const message = `Two things.\n\n${backtick(choiceBody("settings-store"))}\n\nAnd:\n\n${tilde(textBody("npm-scope"))}\n\nI will wait.`
    // BEFORE: only the three-backtick fence was a fence.
    const before = sightingAsItWas(message)
    assert.equal(before[0].text, backtick(choiceBody("settings-store")))
    assert.deepEqual(sync(h.storage, before).registered.map((q) => q.handle), ["settings-store"])
    const [first] = h.storage.listThreadQuestions("t")
    // The human answered it, and the worker went on.
    h.storage.answerThreadQuestion(first.id, JSON.stringify({ questionId: first.id, question: "SQLite or a JSON file?", chosen: ["SQLite"] }), Date.parse(at(4)))
    const answered = JSON.stringify(h.storage.listThreadQuestions("t")[0])

    // AFTER: the same message, folded by the new reader.
    const after = foldedSightings(message)
    assert.equal(after[0].text, `${backtick(choiceBody("settings-store"))}\n\n${tilde(textBody("npm-scope"))}`)
    const refold = sync(h.storage, after)
    assert.deepEqual(refold.faults, [], "the row this message made is not judged against it again, answered or not")
    assert.deepEqual(refold.registered.map((q) => [q.handle, q.asked_at, q.state]), [["npm-scope", Date.parse(at(0)), "open"]])
    assert.equal(JSON.stringify(h.storage.listThreadQuestions("t").find((q) => q.handle === "settings-store")), answered, "asked_at, state and answer of the first are as they were")
    // The new row stands or not by the same rule as any other: asked at at(0), the human typed at at(3).
    assert.deepEqual(standingQuestions(h.storage.listThreadQuestions("t"), { lastUserAt: at(3), questionSightings: after }), [])
    assert.deepEqual(standingQuestions(h.storage.listThreadQuestions("t"), { questionSightings: after }).map((q) => q.handle), ["npm-scope"])
    // REPLAYED again — the next tick, the next restart: nothing.
    const again = sync(h.storage, after)
    assert.deepEqual([again.registered, again.faults], [[], []])
    assert.equal(h.storage.listThreadQuestions("t").length, 2)
  } finally { h.close() }
})

test("refolded, a near-miss that reused the real fence's id for a different question is the collision it always was; restating it is nothing", () => {
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    const clash = `${backtick(choiceBody("settings-store"))}\n\n${tilde(choiceBody("settings-store", "Postgres or SQLite?"))}`
    sync(h.storage, sightingAsItWas(clash))
    const before = JSON.stringify(h.storage.listThreadQuestions("t"))
    const refold = sync(h.storage, foldedSightings(clash))
    assert.deepEqual(refold.registered, [])
    assert.deepEqual(refold.faults, [{ at: at(0), id: "settings-store", faults: ["two different questions in this message use `id: settings-store`"] }])
    assert.equal(JSON.stringify(h.storage.listThreadQuestions("t")), before, "the row the first fence made is untouched")
  } finally { h.close() }
  const g = storageHarness()
  try {
    g.storage.upsertSession(row("t"))
    const twice = `${backtick(choiceBody("settings-store"))}\n\n${tilde(choiceBody("settings-store"))}`
    sync(g.storage, sightingAsItWas(twice))
    const before = JSON.stringify(g.storage.listThreadQuestions("t"))
    const refold = sync(g.storage, foldedSightings(twice))
    assert.deepEqual([refold.registered, refold.faults], [[], []])
    assert.equal(JSON.stringify(g.storage.listThreadQuestions("t")), before)
  } finally { g.close() }
})

test("refolded, a near-miss follow-up of the real fence grows the open row; under a settled one it attaches to nothing and corrects nobody", () => {
  const followUp = tilde("id: sqlite-path\nkind: text\nwhen: settings-store = SQLite\nquestion: Where should the file live?")
  const message = `${backtick(choiceBody("settings-store"))}\n\n${followUp}`
  // The parent is still open: the follow-up arrives late, into the tree it was written for.
  const h = storageHarness()
  try {
    h.storage.upsertSession(row("t"))
    sync(h.storage, sightingAsItWas(message))
    const refold = sync(h.storage, foldedSightings(message))
    assert.deepEqual([refold.registered, refold.faults], [[], []])
    const [q] = h.storage.listThreadQuestions("t")
    assert.deepEqual(refold.attached, [{ at: at(0), rowId: q.id, handles: ["sqlite-path"] }])
    assert.deepEqual(questionHandles(JSON.parse(q.spec) as AskedQuestion), ["settings-store", "sqlite-path"])
    assert.equal(q.asked_at, Date.parse(at(0)))
  } finally { h.close() }
  // The parent was answered meanwhile: the registering message is never judged against its row again, so
  // the branch is neither attached nor faulted — the human has finished with that question.
  const g = storageHarness()
  try {
    g.storage.upsertSession(row("t"))
    sync(g.storage, sightingAsItWas(message))
    const [q] = g.storage.listThreadQuestions("t")
    g.storage.answerThreadQuestion(q.id, JSON.stringify({ questionId: q.id, question: "SQLite or a JSON file?", chosen: ["SQLite"] }), Date.parse(at(4)))
    const before = JSON.stringify(g.storage.listThreadQuestions("t"))
    const refold = sync(g.storage, foldedSightings(message))
    assert.deepEqual([refold.registered, refold.attached, refold.faults], [[], [], []])
    assert.equal(JSON.stringify(g.storage.listThreadQuestions("t")), before)
  } finally { g.close() }
})

// ── The cache that decides whether an old transcript is read again ─────────────────────────────────────

test("the fold-schema digest moves when the question reader or the scanner under it changes — where the sources are on disk", async () => {
  // The digest is a hash of the modules that decide what a folded state holds, memoised per module
  // instance: each reading below is a fresh instance pointed at a copy of the sources.
  const dir = mkdtempSync(join(tmpdir(), "frizz-fold-schema-"))
  try {
    const here = import.meta.dirname
    const copy = join(dir, "server", "src")
    for (const name of ["transcript.ts", "tailer.ts", "backend/claude.ts", "backend/codex.ts", "backend/acp-transcript.ts", "../../shared/src/index.ts", "../../shared/src/question-fence.ts", "../../shared/src/code-fences.ts"]) {
      mkdirSync(dirname(join(copy, name)), { recursive: true })
      cpSync(join(here, name), join(copy, name))
    }
    let n = 0
    const digest = async (): Promise<string> => {
      const fresh = (await import(`./tail-cache.ts?fold-schema-${n++}`)) as typeof import("./tail-cache.ts")
      return fresh.foldSchemaDigest(copy)
    }
    const base = await digest()
    assert.equal(base, await digest(), "the same sources, the same digest")
    assert.match(base, /^[0-9a-f]{32}$/)
    for (const name of ["../../shared/src/code-fences.ts", "../../shared/src/question-fence.ts"]) {
      const path = join(copy, name)
      const source = readFileSync(path, "utf8")
      writeFileSync(path, `${source}\n// a reader change\n`)
      assert.notEqual(await digest(), base, `${name}: every cached tail was folded by a different reader`)
      writeFileSync(path, source)
      assert.equal(await digest(), base, `${name}: restored`)
    }
    // THE OTHER HALF, which this file cannot make true: a build that ships no sources has nothing to hash.
    // Its digest is one constant shared by every build, so there a reader change invalidates nothing.
    assert.equal(await (async () => ((await import(`./tail-cache.ts?fold-schema-${n++}`)) as typeof import("./tail-cache.ts")).foldSchemaDigest(join(dir, "empty")))(), "frizz-tail-state-v2-unreadable")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
