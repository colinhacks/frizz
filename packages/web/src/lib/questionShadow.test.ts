import assert from "node:assert/strict"
import test from "node:test"
import { fenceRestatesRegistered, fenceStandsFor, markerIdsIn, placedFrom, placementNamesIn, placeQuestions, questionHomes, questionNames, registeredStandingAt, resolveQuestionName } from "./questionShadow.ts"
import { questionClaims, questionsByAnchor } from "./questionAnchor.ts"
import { type MessageSegment, splitQuestionBlocks } from "./questionBlocks.ts"

// The pair from the 2026-08-28 report, verbatim: the registration (a plain string — the `ask` schema
// carries no markdown) and the fence the worker wrote sixteen seconds later, with `code`, a link and a
// trailing parenthetical the registration does not have.
const REGISTERED = {
  spec: {
    question: "Cut 4.5.0 now? The memoizer opt-in PR #6482 is still open, and the published announcement documents its API (z.config({ memoizer: z.memoizer() })) in the Zod Mini tab.",
    kind: "question" as const,
    options: [{ label: "Merge #6482, then cut 4.5.0", recommended: true }, { label: "Cut 4.5.0 without #6482" }, { label: "Hold the release" }],
  },
}
const FENCE = [
  "Cut 4.5.0 now? The memoizer opt-in PR [#6482](https://github.com/colinhacks/zod/pull/6482) is still open, and the published announcement documents its API (`z.config({ memoizer: z.memoizer() })`) in the Zod Mini tab. (also on the board as a card)",
  "",
  "- A. Merge #6482 first, then bump to 4.5.0 and push — the release includes the memoizer API the post documents (recommended)",
  "- B. Cut 4.5.0 without #6482 — the Zod Mini memoizer tab gets stripped from the announcement first; the API ships in a later 4.5.x",
  "- C. Hold the release — nothing is bumped until further instruction",
].join("\n")

test("the re-fenced release question restates its registration despite the markup and the trailing aside", () => {
  assert.equal(fenceRestatesRegistered(FENCE, [REGISTERED]), true)
})

test("the same question asked with different context around it still folds — the `?` head is the question", () => {
  const reworded = "Before anything is pushed: Cut 4.5.0 now? #6482 is still open.\n\n- A. Yes\n- B. No"
  assert.equal(fenceRestatesRegistered(reworded, [REGISTERED]), true)
})

test("a fence that only asks the registered question's opening is a prefix of it, and folds", () => {
  assert.equal(fenceRestatesRegistered("Cut 4.5.0 now? The memoizer opt-in PR #6482 is still open\n\n- A. Yes\n- B. No", [REGISTERED]), true)
})

test("a different question at the same rest is NOT folded — the fold never hides an unseen question", () => {
  const other = "Which npm dist-tag should 4.5.0 publish under?\n\n- A. `latest` (recommended)\n- B. `next`"
  assert.equal(fenceRestatesRegistered(other, [REGISTERED]), false)
})

test("nothing folds against no registration, and a head too short to mean anything never matches", () => {
  assert.equal(fenceRestatesRegistered(FENCE, []), false)
  const short = { spec: { question: "Proceed?", kind: "question" as const } }
  assert.equal(fenceRestatesRegistered("Proceed?\n\n- A. Yes\n- B. No", [short]), false)
})

// The transcript shape of the report: a fence, two watcher wakes (user turns frizz wrote), the
// registration, then the final message with the fence again. The registration belongs to the rest the
// final message ended, so every message of THAT rest sees it — and the first fence, one rest up, does not.
const at = (min: number) => new Date(Date.UTC(2026, 7, 28, 17, min)).toISOString()
const MESSAGES = [
  { role: "user", at: at(0) },
  { role: "assistant", at: at(5) }, // the first fence
  { role: "user", at: at(6) }, // the PR watcher's wake
  { role: "assistant", at: at(9) }, // tool calls
  { role: "assistant", at: at(11) }, // the final message, fence restated
]
const QUESTION = { ...REGISTERED, id: "qst_6b9bdbe563fa", askedAt: at(10) }

test("registeredStandingAt maps every message of the asking rest to the registration, and none above it", () => {
  const map = registeredStandingAt(MESSAGES, [QUESTION])
  assert.deepEqual([...map.keys()].sort(), [3, 4])
  assert.deepEqual(map.get(4), [QUESTION])
  assert.equal(map.get(1), undefined, "the first fence is one rest up; the wake closed that rest")
})

test("a question the human replied past still stands at every later message of the worker's — not at the human's turn", () => {
  const replied = [...MESSAGES, { role: "user", at: at(15) }, { role: "assistant", at: at(16) }]
  const map = registeredStandingAt(replied, [QUESTION])
  assert.deepEqual([...map.keys()].sort(), [3, 4, 6])
})

test("a registration whose rest is above the loaded window stands at every loaded message of the worker's", () => {
  const map = registeredStandingAt(MESSAGES.slice(2), [{ ...QUESTION, askedAt: at(1) }])
  assert.deepEqual([...map.keys()].sort(), [1, 2])
})

// ---- PLACEMENT ----
// The worker writes the ask into the middle of its handoff; the registered card renders in that slot.

const fenced = (body: string, info = "") => `\`\`\`question${info ? ` ${info}` : ""}\n${body}\n\`\`\``
const questionSeg = (text: string, info = "") => {
  const segs = splitQuestionBlocks(fenced(text, info)).filter((s) => s.kind === "question")
  assert.equal(segs.length, 1, "the fixture must produce exactly one question segment")
  return segs[0] as Extract<MessageSegment, { kind: "question" }>
}

test("fenceStandsFor matches by the info-string id, whatever the prose says", () => {
  const seg = questionSeg("Something else entirely?\n\n- A. Yes\n- B. No", QUESTION.id)
  assert.equal(fenceStandsFor(seg, [QUESTION]), QUESTION)
  assert.equal(fenceStandsFor(seg, [{ ...QUESTION, id: "qst_000000000000" }]), undefined, "a different id names a different row")
})

test("fenceStandsFor falls back to the prose when the worker wrote no id", () => {
  assert.equal(fenceStandsFor(questionSeg(FENCE), [QUESTION]), QUESTION)
  assert.equal(fenceStandsFor(questionSeg("Which npm dist-tag?\n\n- A. latest\n- B. next"), [QUESTION]), undefined)
})


// ---- PER-QUESTION PLACEMENT (2026-09-11) ----
// An EMPTY marker naming a registered id places THAT question in its slot. Nothing else places.

const MARKER = (id: string) => `**Fixed** — nothing further to do.\n\nThe one card still open is yours to decide:\n\n${fenced("", id)}\n\nAnswer it either way and this thread is finished.`
const SECOND = { ...QUESTION, id: "qst_2222bbbb2222", askedAt: at(10) }

test("markerIdsIn reads only the EMPTY id-bearing fences, lowercased, in order", () => {
  const text = `${fenced("", "QST_AAAA")}\n\n${fenced("A real body?\n\n- A. Yes", "qst_bbbb")}\n\n${fenced("", "qst_cccc")}`
  assert.deepEqual(markerIdsIn(text), ["qst_aaaa", "qst_cccc"])
  assert.deepEqual(markerIdsIn("no fence"), [])
  assert.deepEqual(markerIdsIn(fenced(FENCE)), [], "a legacy free-form fence is not a marker")
})

test("placeQuestions puts a question in the message whose marker names it, and only that question", () => {
  const messages = MESSAGES.map((m, i) => ({ ...m, text: i === 4 ? MARKER(QUESTION.id) : "prose" }))
  const { placed, placedIds } = placeQuestions(messages, [QUESTION, SECOND])
  assert.deepEqual([...placed.keys()], [4])
  assert.deepEqual(placed.get(4), [QUESTION])
  assert.deepEqual([...placedIds], [QUESTION.id], "the unnamed sibling stays at the anchor")
})

test("two markers in one message place two questions there, in registration order", () => {
  const both = `${MARKER(SECOND.id)}\n\n${fenced("", QUESTION.id)}`
  const messages = MESSAGES.map((m, i) => ({ ...m, text: i === 4 ? both : "prose" }))
  const { placed } = placeQuestions(messages, [QUESTION, SECOND])
  assert.deepEqual(placed.get(4), [QUESTION, SECOND])
})

test("a handoff that names none of its registrations places nothing — the anchor still draws them", () => {
  const messages = MESSAGES.map((m) => ({ ...m, text: "Landed it. Nothing else to say." }))
  const { placed, placedIds } = placeQuestions(messages, [QUESTION])
  assert.equal(placed.size, 0)
  assert.equal(placedIds.size, 0)
})

test("a fence that RESTATES the question in prose folds but never places — placement is by id only", () => {
  const messages = MESSAGES.map((m, i) => ({ ...m, text: i === 4 ? `Prose.\n\n${fenced(FENCE)}` : "prose" }))
  assert.equal(placeQuestions(messages, [QUESTION]).placed.size, 0)
})

test("a marker one rest ABOVE the registration never places it", () => {
  const messages = MESSAGES.map((m, i) => ({ ...m, text: i === 1 ? MARKER(QUESTION.id) : "prose" }))
  assert.equal(placeQuestions(messages, [QUESTION]).placed.size, 0)
})

test("a marker in a LATER rest places the question there — the newest handoff is the one the human reads", () => {
  const later = [...MESSAGES, { role: "user", at: at(15) }, { role: "assistant", at: at(16), text: MARKER(QUESTION.id) }]
    .map((m, i) => ("text" in m ? m : { ...m, text: i === 4 ? MARKER(QUESTION.id) : "prose" }))
  const { placed } = placeQuestions(later, [QUESTION])
  assert.deepEqual([...placed.keys()], [6])
})

test("a registration whose rest is above the loaded window is placed by a marker inside the window", () => {
  const windowed = [{ role: "user", at: at(15), text: "Well done" }, { role: "assistant", at: at(16), text: MARKER(QUESTION.id) }]
  const { placed } = placeQuestions(windowed, [{ ...QUESTION, askedAt: at(10) }])
  assert.deepEqual([...placed.keys()], [1])
})

test("a marker in a HUMAN turn places nothing", () => {
  const messages = MESSAGES.map((m, i) => ({ ...m, text: i === 2 ? MARKER(QUESTION.id) : "prose" }))
  assert.equal(placeQuestions(messages, [QUESTION]).placed.size, 0)
})

// ---- THE STALE MARKER (2026-09-13, reversed 2026-10-05) ----
// The worker asked, wrote its marker into THAT handoff, the human replied past the question without
// answering, and the worker worked on and rested again with the question still open. From 2026-09-13
// the placement was scoped to the CURRENT rest whenever the thread was at rest, so the card left the
// prose it was couched in and fell to the tail — under a handoff that said nothing about it, where it
// superseded the worker's own sign-off (maintainer 2026-10-05). Now the card stays in its old prose
// until a later rest CLAIMS it by naming it under `questions:` in its ```awaiting fence; the server
// makes the worker either name it or withdraw it at that later rest (scheduler.evalSignoffNudges).

const STALE = [
  { role: "user", at: at(0), text: "Do the thing." },
  { role: "assistant", at: at(5), text: MARKER(QUESTION.id) }, // the asking rest, marker written
  { role: "user", at: at(20), text: "Here's my answer to the OTHER question." },
  { role: "assistant", at: at(25), text: "Done. The first question is still open." },
]
const CLAIM = (id: string, prose = "") => `${prose}\n\n\`\`\`awaiting\nquestions: [${id}]\nstatus: needs_input\n\`\`\``

test("a marker from an older rest keeps placing after the thread rests again — a rest that says nothing about the card leaves it", () => {
  const { placed } = placeQuestions(STALE, [QUESTION])
  assert.deepEqual([...placed.keys()], [1])
})

test("a later fence naming the question claims it out of the old prose — the card renders under that fence", () => {
  const claimed = STALE.map((m, i) => (i === 3 ? { ...m, text: CLAIM(QUESTION.id, "Done. The first question still decides the release.") } : m))
  const { placed, placedIds } = placeQuestions(claimed, [QUESTION])
  assert.equal(placed.size, 0, "the old marker no longer owns the card")
  assert.equal(placedIds.size, 0, "so the anchor path draws it, at the claiming rest")
})

// THE QUEUE CARD'S WINDOW is cut at the previous rest, so the stale marker above sits in a message the
// card never draws. Left placed there, the card vanished and its rest's Send flushed alone at the top of
// the window — a Send with nothing above it to answer (seen on a seeded stack, 2026-10-05).
test("a placement above a surface's window is dropped there, so the card rejoins its anchor group", () => {
  const full = placeQuestions(STALE, [QUESTION])
  const windowed = placedFrom(full, 2)
  assert.equal(windowed.placed.size, 0)
  assert.equal(windowed.placedIds.size, 0, "so the anchor path draws the card, at the top of the window")
  assert.deepEqual([...placedFrom(full, 1).placed.keys()], [1], "a placement inside the window stays")
  assert.equal(placedFrom(full, 0), full, "no window, nothing to drop")
})

test("a claiming rest that also writes the marker places the card in its own prose", () => {
  const claimed = STALE.map((m, i) => (i === 3 ? { ...m, text: `${MARKER(QUESTION.id)}${CLAIM(QUESTION.id)}` } : m))
  const { placed } = placeQuestions(claimed, [QUESTION])
  assert.deepEqual([...placed.keys()], [3])
})

// ---- THE QUESTION FENCE (2026-10-13) ----
// A ```question fence's `id:` names a row by the WORKER's id — its handle, on the root and on every
// follow-up — so it places and claims exactly as a legacy marker does by the minted one.

const FENCED_ROW = {
  id: "qst_f00dfeed0001",
  askedAt: at(5),
  spec: {
    handle: "settings-store",
    question: "Should the settings store use SQLite or a JSON file?",
    kind: "question" as const,
    options: [
      { label: "SQLite", followUps: [{ handle: "sqlite-path", question: "Where should the database live?", kind: "question" as const, options: [{ label: "Beside the sessions database" }, { label: "In .frizz/" }] }] },
      { label: "JSON file" },
    ],
  },
}
const ASK_FENCE = [
  "```question",
  "id: settings-store",
  "kind: choice",
  "question: Should the settings store use SQLite or a JSON file?",
  "options:",
  "  - SQLite",
  "  - JSON file",
  "```",
].join("\n")
const FOLLOW_FENCE = ["```question", "id: sqlite-path", "kind: choice", "when: settings-store = SQLite", "question: Where should the database live?", "options:", "  - Beside the sessions database", "  - In .frizz/", "```"].join("\n")
const REF_FENCE = (id: string) => `\`\`\`question\nid: ${id}\n\`\`\``
const ASKED = [
  { role: "user", at: at(0), text: "Add a settings store." },
  { role: "assistant", at: at(5), text: `The store is the one hard-to-reverse call:\n\n${ASK_FENCE}\n\n${FOLLOW_FENCE}\n\nEither way the rest is done.` },
]

test("a row answers to its minted id and to every handle in its tree; a follow-up's handle resolves to the ROOT", () => {
  assert.deepEqual(questionNames(FENCED_ROW), ["qst_f00dfeed0001", "settings-store", "sqlite-path"])
  assert.equal(resolveQuestionName("Settings-Store", [FENCED_ROW]), FENCED_ROW, "case-insensitive")
  assert.equal(resolveQuestionName("sqlite-path", [FENCED_ROW]), FENCED_ROW)
  assert.equal(resolveQuestionName("qst_f00dfeed0001", [FENCED_ROW]), FENCED_ROW, "an `id: qst_…` reference names the row id")
  assert.equal(resolveQuestionName("npm-scope", [FENCED_ROW]), undefined)
  assert.equal(resolveQuestionName("settings-store", [QUESTION]), undefined, "a row `ask` registered has no handle to match")
})

test("placementNamesIn reads legacy markers AND fence ids, but not a follow-up's", () => {
  assert.deepEqual(placementNamesIn(ASKED[1].text), ["settings-store"])
  assert.deepEqual(placementNamesIn(`${fenced("", "qst_aaaa")}\n\n${REF_FENCE("settings-store")}`), ["qst_aaaa", "settings-store"])
})

test("the fence that ASKED a question places its row in that slot — drawn once, in the asking message", () => {
  const { placed, placedIds } = placeQuestions(ASKED, [FENCED_ROW])
  assert.deepEqual([...placed.keys()], [1])
  assert.deepEqual([...placedIds], [FENCED_ROW.id])
})

// Until 2026-10-13 a follow-up had to be written with its parent, so a lone one placed nothing. It may now
// follow in a later message, and then its fence is what names the parent there (the last test in this file).
test("a follow-up written WITH its parent places nothing of its own — the parent's fence places the card, once", () => {
  assert.deepEqual(placementNamesIn(ASKED[1].text), ["settings-store"])
  assert.deepEqual([...placeQuestions(ASKED, [FENCED_ROW]).placed.values()].map((g) => g.length), [1])
  // A lone follow-up names its parent, so the parent's card draws in that slot rather than nowhere.
  const messages = [ASKED[0], { ...ASKED[1], text: `Only the branch:\n\n${FOLLOW_FENCE}` }]
  assert.deepEqual([...placeQuestions(messages, [FENCED_ROW]).placed.keys()], [1])
})

test("a fence QUOTED in an outer fence places nothing — the worker is showing the grammar", () => {
  const messages = [ASKED[0], { ...ASKED[1], text: `The form:\n\n\`\`\`\`md\n${ASK_FENCE}\n\`\`\`\`` }]
  assert.equal(placeQuestions(messages, [FENCED_ROW]).placed.size, 0)
})

test("a LATER rest's `id:` reference claims the card: it leaves the asking prose and renders in the reference's slot", () => {
  const later = [
    ...ASKED,
    { role: "user", at: at(8), text: "Do the docs first." },
    { role: "assistant", at: at(12), text: `Docs are in. The store still decides the migration:\n\n${REF_FENCE("settings-store")}` },
  ]
  const { placed } = placeQuestions(later, [FENCED_ROW])
  assert.deepEqual([...placed.keys()], [3])
  // A follow-up's handle is a name for the whole card.
  const byBranch = later.map((m, i) => (i === 3 ? { ...m, text: `Still need it:\n\n${REF_FENCE("sqlite-path")}` } : m))
  assert.deepEqual([...placeQuestions(byBranch, [FENCED_ROW]).placed.keys()], [3])
})

test("a later rest that says nothing about a fenced question leaves its card in the asking prose", () => {
  const later = [...ASKED, { role: "user", at: at(8), text: "Do the docs first." }, { role: "assistant", at: at(12), text: "Docs are in." }]
  assert.deepEqual([...placeQuestions(later, [FENCED_ROW]).placed.keys()], [1])
})

// The human replies PAST the open card (the composer is right there). Their bubble is optimistic for a
// few frames — no instant yet — and in those frames the card must stay in the fence's slot, not drop out
// of the prose to the tail under the bubble and come back when the server stamps it.
test("an unstamped send at the tail leaves a fenced card in its slot", () => {
  const optimistic = [...ASKED, { role: "user", text: "Do the docs first." }]
  assert.deepEqual([...placeQuestions(optimistic, [FENCED_ROW]).placed.keys()], [1])
  // Negative control: the stamped copy of the same send always did.
  assert.deepEqual([...placeQuestions([...ASKED, { role: "user", at: at(8), text: "Do the docs first." }], [FENCED_ROW]).placed.keys()], [1])
})

// A follow-up written in a LATER message than its parent names the parent there (lib/questionBlocks
// followUpParentsIn), so the parent's card moves into that message exactly as an `id:` reference moves it.
test("a later rest's `when:` follow-up claims its parent's card into that message", () => {
  const later = [
    ...ASKED.slice(0, 1),
    { role: "assistant", at: at(5), text: `The store is the one hard-to-reverse call:\n\n${ASK_FENCE}` },
    { role: "user", at: at(8), text: "Do the docs first." },
    { role: "assistant", at: at(12), text: `Docs are in. One more thing hangs on SQLite:\n\n${FOLLOW_FENCE}\n\nEither way.` },
  ]
  // Before the row carries the branch and after: the parent's handle is what the fence names.
  const bare = { ...FENCED_ROW, spec: { ...FENCED_ROW.spec, options: [{ label: "SQLite" }, { label: "JSON file" }] } }
  // (Whether the question still STANDS at that rest is the server's answer now — the row's `standing`,
  // pinned in server question-rest.test.ts — so placement is all there is to check here.)
  for (const row of [bare, FENCED_ROW]) assert.deepEqual([...placeQuestions(later, [row]).placed.keys()], [3])
  // Negative control: the same later message without the follow-up leaves the card where it was asked.
  const silent = later.map((m, i) => (i === 3 ? { ...m, text: "Docs are in." } : m))
  assert.deepEqual([...placeQuestions(silent, [FENCED_ROW]).placed.keys()], [1])
})

test("a row known only by its handle — a question that closed without an answer — still resolves by that name", () => {
  const closed = { id: "qst_closed00001", handle: "Retry-Policy", closed: "dismissed" as const }
  assert.deepEqual(questionNames(closed), ["qst_closed00001", "retry-policy"])
  assert.equal(resolveQuestionName("retry-policy", [closed]), closed)
  assert.equal(resolveQuestionName("QST_closed00001", [closed]), closed)
  assert.equal(resolveQuestionName("other", [closed]), undefined)
})

// ---- A RECAP AFTER A WAKE LEAVES THE CARDS IN THE WRITE-UP, AND IS LIVE TOO (2026-11-09, 2026-11-10) ----
// The worker wrote a write-up with its questions interleaved in the prose, each under the paragraph it
// decides. Before the human read it, another thread's steer woke the worker, Frizz corrected the park it
// rested on, and the worker rested again on a short note listing every open question as an `id:` reference
// — the maintainer's own instructions tell it to re-place every open question at every rest. The card went
// to the NEWEST message naming it, so all six left the write-up for the note, stacked at its foot with no
// lead-in, and the write-up drew read-only copies where they had been (maintainer 2026-11-09: "I had a
// perfect write-up with a bunch of nicely interleaved questions … then it just kind of tacked all those
// same questions on at the end"). The first fix kept the card in the write-up and greyed every later naming,
// and the next day a triage thread re-listing one open question in each of a dozen reports showed it greyed
// in the report the maintainer was reading, twelve hours below its card (2026-11-10: "That question is
// grayed out. But I haven't sent any messages in the meantime"). So every message naming an open question
// since the human's last turn draws it live, sharing one answer; only a naming from before that turn draws
// the read-only copy.

const STEER = { role: "user", at: at(8), text: "<thread-message from-thread=\"docs\" from-title=\"Docs\">\nThe page moved.\n</thread-message>", sessionPeer: { name: "Docs", thread: { slug: "docs", title: "Docs" } } }
const CORRECTION = { role: "user", at: at(9), text: "⚠️ Your ```awaiting fence names only pull requests that wait on this side.", wake: true as const }
const REPORT = { role: "user", at: at(9), text: "The audit is done.", peerFrom: "auditor" }
const RECAP = { role: "assistant", at: at(10), text: `Nothing has changed. This is what's open:\n\n${REF_FENCE("settings-store")}` }
const WOKEN = [...ASKED, STEER, CORRECTION, REPORT, RECAP]

test("a recap written after a wake, before the human's next turn, draws the card live beside the write-up's", () => {
  assert.deepEqual([...placeQuestions(WOKEN, [FENCED_ROW]).placed.keys()], [1, 5])
  assert.equal(questionClaims(WOKEN).get("settings-store"), 1, "the write-up keeps the claim")
  assert.deepEqual([...questionsByAnchor(WOKEN, [FENCED_ROW]).keys()], [1])
  // Negative control: the same recap after the human TYPED takes the card, as it always has.
  const typed = [...ASKED, { role: "user", at: at(8), text: "Do the docs first." }, RECAP]
  assert.deepEqual([...placeQuestions(typed, [FENCED_ROW]).placed.keys()], [3])
  // Every naming of the same stretch is live: a triage thread's dozen reports each re-listing the question.
  const reports = [...WOKEN, CORRECTION, { ...RECAP, at: at(11) }, CORRECTION, { ...RECAP, at: at(12) }]
  assert.deepEqual([...placeQuestions(reports, [FENCED_ROW]).placed.keys()], [1, 5, 7, 9])
})

test("the human's next turn ends the hold: a reference after it takes the card", () => {
  const later = [...WOKEN, { role: "user", at: at(12), text: "Go with the docs." }, { role: "assistant", at: at(14), text: `Docs are in:\n\n${REF_FENCE("settings-store")}` }]
  assert.deepEqual([...placeQuestions(later, [FENCED_ROW]).placed.keys()], [7], "the write-up and the recap draw copies now")
  assert.equal(questionClaims(later).get("settings-store"), 7)
})

test("an answer to another question counts as the human's turn, as the queue card's window does", () => {
  // The answer rides in as a wake (the human may answer while the worker is down), but the human wrote it,
  // and the queue card opens on it — so the card a later rest names moves inside that window.
  const answered = { role: "user", at: at(8), wake: true as const, text: "Answers to earlier questions:\n1. “Ship the docs first?” → Yes" }
  assert.deepEqual([...placeQuestions([...ASKED, answered, RECAP], [FENCED_ROW]).placed.keys()], [3])
})

test("a copy points at the NEWEST live card, which is below every copy", () => {
  const placement = placeQuestions(WOKEN, [FENCED_ROW])
  assert.equal(questionHomes(WOKEN, [FENCED_ROW], placement).get(FENCED_ROW.id), 5)
  const typed = [...WOKEN, { role: "user", at: at(12), text: "Go with the docs." }, { role: "assistant", at: at(14), text: REF_FENCE("settings-store") }]
  assert.equal(questionHomes(typed, [FENCED_ROW], placeQuestions(typed, [FENCED_ROW])).get(FENCED_ROW.id), 7, "the write-up at 1 points down at it")
})
