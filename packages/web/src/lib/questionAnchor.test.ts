import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { questionAnchorIndex, questionClaims, questionsByAnchor, type AnchorMessage } from "./questionAnchor.ts"

const at = (n: number) => new Date(Date.UTC(2026, 7, 27, 20, n)).toISOString()
const msg = (role: string, minute: number, kind?: string): AnchorMessage => ({ role, at: at(minute), ...(kind ? { kind } : {}) })
const said = (minute: number, text: string): AnchorMessage => ({ role: "assistant", at: at(minute), text })
const fence = (frontmatter: string) => `Still on it.\n\n\`\`\`awaiting\n${frontmatter}\n---\nThe answer decides the next step.\n\`\`\``

// THE ORDINARY CASE, and the one that must not move: the worker asked and rested, nothing has happened
// since, so the card is the tail exactly as it was before there was an anchor at all.
test("a question asked at the last rest anchors to the tail", () => {
  const messages = [msg("user", 0), msg("assistant", 1), msg("assistant", 2)]
  assert.equal(questionAnchorIndex(messages, at(2)), 2)
})

// THE REPORT. The human replied past the question without answering it — the composer is right there —
// and the worker has worked since. Pinned to the tail the card sat UNDER their own newest message and
// under everything after it, claiming to be the current ask.
test("a question the human replied past sits at ITS rest, above their reply", () => {
  const messages = [
    msg("user", 0),        // 0 the original task
    msg("assistant", 1),   // 1 the worker's turn…
    msg("assistant", 2),   // 2 …and the rest it asked at
    msg("user", 3),        // 3 the human replies without answering
    msg("assistant", 4),   // 4 the worker gets on with it
  ]
  assert.equal(questionAnchorIndex(messages, at(2)), 2)
})

// A wake is recorded as a USER turn, and it counts: the thread moved on, whoever moved it.
test("frizz's own delivery ends the rest just as a typed reply does", () => {
  const messages = [msg("assistant", 1), msg("user", 2), msg("assistant", 3)]
  assert.equal(questionAnchorIndex(messages, at(1)), 0)
})

test("punctuation is not a turn", () => {
  // An event line and a reasoning summary carry a nominal role; neither ends a rest.
  const messages = [msg("assistant", 1), msg("user", 2, "event"), msg("user", 2, "reasoning"), msg("assistant", 3)]
  assert.equal(questionAnchorIndex(messages, at(1)), 3)
})

test("a rest older than the loaded window goes above everything, never back to the tail", () => {
  // -1 rather than the tail: at the bottom the card would be lying about being the current ask, which is
  // the whole defect. At the top it is merely as high as this window can put it.
  const messages = [msg("user", 5), msg("assistant", 6)]
  assert.equal(questionAnchorIndex(messages, at(1)), -1)
})

test("an unreadable instant degrades to the tail rather than to the top", () => {
  const messages = [msg("user", 0), msg("assistant", 1)]
  assert.equal(questionAnchorIndex(messages, "not a date"), 1)
  assert.equal(questionAnchorIndex([], at(1)), -1)
})

test("a message with no instant cannot end a rest", () => {
  const messages: AnchorMessage[] = [{ role: "assistant", at: at(1) }, { role: "user" }, { role: "assistant", at: at(3) }]
  assert.equal(questionAnchorIndex(messages, at(1)), 2)
})

// THE HUMAN'S OWN SEND, BEFORE THE SERVER HAS STAMPED IT. An optimistic bubble is appended to the tail with
// no instant; skipped like the unreadable instant above, it left the anchor ON the bubble — so for the
// frames until the server's copy landed, every card of the rest it replied to drew UNDER the human's
// newest message (and a fence-placed card left its slot: lib/questionShadow). Driven on a real stack
// 2026-10-13 with the send held 2.5s: the card sat below the Answers bubble for the whole hold.
test("the human's own unstamped send at the tail ends the rest it replies to", () => {
  const sent: AnchorMessage[] = [msg("user", 0), msg("assistant", 1), msg("assistant", 2), { role: "user" }]
  assert.equal(questionAnchorIndex(sent, at(2)), 2, "the handoff, not the bubble")
  assert.equal(questionAnchorIndex([...sent, { role: "user" }], at(2)), 2, "two sends in a row are still one tail")
  // Negative control: stamped, the same bubble has always ended the rest.
  assert.equal(questionAnchorIndex([msg("user", 0), msg("assistant", 1), msg("assistant", 2), msg("user", 3)], at(2)), 2)
  // A transcript that is nothing but the bubble has no rest to go back to.
  assert.equal(questionAnchorIndex([{ role: "user" }], at(2)), 0)
})

// One `ask` call registers several questions at ONE instant, and they must stay one stack.
test("questions from one call group together; questions from two rests do not", () => {
  const messages = [msg("assistant", 1), msg("user", 2), msg("assistant", 3)]
  const grouped = questionsByAnchor(messages, [
    { id: "a", askedAt: at(1) },
    { id: "b", askedAt: at(1) },
    { id: "c", askedAt: at(3) },
  ])
  assert.deepEqual([...grouped.keys()].sort(), [0, 2])
  assert.deepEqual(grouped.get(0)?.map((q) => q.id), ["a", "b"])
  assert.deepEqual(grouped.get(2)?.map((q) => q.id), ["c"])
})

// THE ONE THING THE PURE FUNCTION CANNOT PIN: that both surfaces split the stack the same way. The
// in-flight ANSWER belongs to the TAIL wherever the questions sit — it is the human's newest turn, and
// the delivered copy of it lands at the tail a second later — so a mount placed at an older rest must
// not draw it. Two drawing it would render the answer twice, in two places, seconds apart.
//
// The prop is OPT-IN (`inFlight`, the rows the transcript is not already drawing — see
// unrenderedAnswers) rather than the opt-out `showInFlight` it was until 2026-09-01, so an anchored
// mount draws nothing by simply not passing it, and this reads the same guarantee off the new spelling.
test("a mount placed at an older rest never draws the in-flight answer", () => {
  for (const file of ["ChatView.tsx", "TodosView.tsx"]) {
    const source = readFileSync(new URL(`../components/${file}`, import.meta.url), "utf8")
    const mounts = [...source.matchAll(/<RegisteredQuestionStack[^>]*>/g)].map((m) => m[0])
    const tail = mounts.filter((m) => /questions=\{[^}]*[Tt]ail\}/.test(m))
    // An ANCHORED mount is one handed a group that is not the tail. The eager fallback passes no
    // `questions` at all — it only renders with an empty transcript, where every rest IS the tail.
    const anchored = mounts.filter((m) => /questions=\{/.test(m) && !/[Tt]ail\}/.test(m))
    assert.equal(tail.length, 1, `${file}: exactly one tail mount`)
    assert.ok(anchored.length >= 1, `${file}: at least one anchored mount`)
    assert.match(tail[0], /inFlight=\{/, `${file}: the tail mount draws the in-flight answer`)
    for (const m of anchored) assert.ok(!/inFlight=\{/.test(m), `${file}: an anchored mount must not`)
    // …and the mount with no `questions` at all (the empty-transcript fallback) is a tail too.
    for (const m of mounts.filter((x) => !/questions=\{/.test(x))) {
      assert.match(m, /inFlight=\{/, `${file}: the fallback mount is a tail mount`)
    }
  }
})

// ---- A CARD STAYS WHERE IT WAS ASKED UNTIL A LATER REST CLAIMS IT (2026-10-05) ------------------
//
// From 2026-08-31 every open question moved to the CURRENT rest whenever the thread was at rest, so a
// question the human had replied past, or one a wake had buried, was pulled out of the prose that set it
// up and stacked under whatever the worker said last — superseding its own sign-off (maintainer
// 2026-10-05). Now the worker says which old questions it still needs, by naming them under `questions:`
// in its ```awaiting fence, and a rest that says nothing about a question leaves its card alone.

test("a later rest that says nothing about a question leaves its card at the rest that asked it", () => {
  const messages = [
    msg("user", 0),        // 0 the original task
    msg("assistant", 1),   // 1 the worker's turn…
    msg("assistant", 2),   // 2 …and the rest it asked at
    msg("user", 3),        // 3 the human replies without answering (or a CI wake lands)
    msg("assistant", 4),   // 4 the worker answers and rests again
  ]
  assert.deepEqual([...questionsByAnchor(messages, [{ id: "qst_a", askedAt: at(2) }]).keys()], [2])
})

test("a later fence naming the question claims it: the card moves to the end of that rest", () => {
  const messages = [msg("user", 0), msg("assistant", 2), msg("user", 3), said(4, fence("questions: [qst_a]"))]
  assert.deepEqual([...questionsByAnchor(messages, [{ id: "qst_a", askedAt: at(2) }]).keys()], [3])
})

test("the claim lands at the END of its rest, even when the fence sits in an earlier message of it", () => {
  const messages = [msg("user", 0), msg("assistant", 2), msg("user", 3), said(4, fence("questions: [qst_a]")), msg("assistant", 5), msg("user", 6), msg("assistant", 7)]
  assert.deepEqual([...questionsByAnchor(messages, [{ id: "qst_a", askedAt: at(2) }]).keys()], [4])
})

test("only the questions a fence names move; the rest stay where they were asked", () => {
  const messages = [msg("assistant", 1), msg("user", 2), msg("assistant", 3), msg("user", 4), said(5, fence("questions: [qst_b]"))]
  const grouped = questionsByAnchor(messages, [{ id: "qst_a", askedAt: at(1) }, { id: "qst_b", askedAt: at(3) }])
  assert.deepEqual(grouped.get(0)?.map((q) => q.id), ["qst_a"])
  assert.deepEqual(grouped.get(4)?.map((q) => q.id), ["qst_b"])
})

test("a fence naming questions from several rests gathers them into one stack at its rest", () => {
  const messages = [msg("assistant", 1), msg("user", 2), msg("assistant", 3), msg("user", 4), said(5, fence("questions: [qst_a, qst_b]"))]
  const grouped = questionsByAnchor(messages, [{ id: "qst_a", askedAt: at(1) }, { id: "qst_b", askedAt: at(3) }])
  assert.deepEqual([...grouped.keys()], [4])
  assert.deepEqual(grouped.get(4)?.map((q) => q.id), ["qst_a", "qst_b"])
})

test("the newest claim wins, and a claim at the asking rest itself changes nothing", () => {
  const messages = [said(1, fence("questions: [qst_a]")), msg("user", 2), said(3, fence("questions: [qst_a]")), msg("user", 4), msg("assistant", 5)]
  assert.deepEqual([...questionsByAnchor(messages, [{ id: "qst_a", askedAt: at(1) }]).keys()], [2])
  assert.deepEqual([...questionsByAnchor(messages.slice(0, 1), [{ id: "qst_a", askedAt: at(1) }]).keys()], [0])
})

test("a claim brings a question asked above the loaded window into it", () => {
  const messages = [msg("user", 5), said(6, fence("questions: [qst_a]"))]
  assert.deepEqual([...questionsByAnchor(messages, [{ id: "qst_a", askedAt: at(1) }]).keys()], [1])
})

test("claims: false reads the asking rest alone — the fold's reading", () => {
  const messages = [msg("user", 0), msg("assistant", 2), msg("user", 3), said(4, fence("questions: [qst_a]"))]
  assert.deepEqual([...questionsByAnchor(messages, [{ id: "qst_a", askedAt: at(2) }], { claims: false }).keys()], [1])
})

test("a claim is read case-blind and down from a gloss, and only off a worker's own fence", () => {
  const claims = questionClaims([
    said(1, fence("questions:\n  - QST_A — the cache call")),
    { role: "user", at: at(2), text: fence("questions: [qst_b]") },
    said(3, "Quoting the grammar:\n\n````md\n" + fence("questions: [qst_c]") + "\n````"),
  ])
  assert.deepEqual([...claims.entries()], [["qst_a", 0]])
})

// No questions ⇒ no groups; the tail entry must not be minted for an empty set.
test("no open questions produces no groups", () => {
  const messages = [msg("user", 0), said(1, fence("questions: [qst_a]"))]
  assert.equal(questionsByAnchor(messages, []).size, 0)
})

// ---- THE QUESTION FENCE'S CLAIM (2026-10-13) ----
// A ```question fence carrying a question's `id:` — a reference, or the ask restated — claims its card to
// that rest, the way `questions:` does. The name is the worker's handle, matched on the root or any
// follow-up of the row's tree.

const ref = (id: string) => `Still need this one:\n\n\`\`\`question\nid: ${id}\n\`\`\``
const fenced = { id: "qst_f1", askedAt: at(2), spec: { handle: "settings-store", question: "Which store?", kind: "question" as const, options: [{ label: "SQLite", followUps: [{ handle: "sqlite-path", question: "Where?", kind: "question" as const }] }, { label: "JSON" }] } }

test("an `id:` reference fence in a later rest claims the card to that rest, by the worker's handle", () => {
  const messages = [msg("user", 0), msg("assistant", 2), msg("user", 3), said(4, ref("settings-store")), msg("assistant", 5)]
  assert.equal(questionClaims(messages).get("settings-store"), 3)
  assert.deepEqual([...questionsByAnchor(messages, [fenced]).keys()], [4], "the end of the referencing rest")
  assert.deepEqual([...questionsByAnchor(messages, [fenced], { claims: false }).keys()], [1], "the asking rest, unclaimed")
})

test("a reference to a FOLLOW-UP's handle claims the whole card", () => {
  const messages = [msg("user", 0), msg("assistant", 2), msg("user", 3), said(4, ref("sqlite-path"))]
  assert.deepEqual([...questionsByAnchor(messages, [fenced]).keys()], [3])
})

test("`questions:` keeps claiming beside the fence, and the newer of two claims wins", () => {
  const messages = [msg("user", 0), msg("assistant", 2), msg("user", 3), said(4, fence("questions: [qst_f1]")), msg("user", 5), said(6, ref("settings-store"))]
  assert.deepEqual([...questionsByAnchor(messages, [fenced]).keys()], [5])
  const older = [msg("user", 0), msg("assistant", 2), msg("user", 3), said(4, ref("settings-store")), msg("user", 5), said(6, fence("questions: [qst_f1]"))]
  assert.deepEqual([...questionsByAnchor(older, [fenced]).keys()], [5])
})

test("a quoted reference claims nothing", () => {
  const quoted = `The form:\n\n\`\`\`\`md\n${ref("settings-store")}\n\`\`\`\``
  const messages = [msg("user", 0), msg("assistant", 2), msg("user", 3), said(4, quoted)]
  assert.equal(questionClaims(messages).has("settings-store"), false)
  assert.deepEqual([...questionsByAnchor(messages, [fenced]).keys()], [1])
})

// ---- A QUESTION THE HUMAN TYPED PAST IS NOT HOISTED (2026-10-13) ----
// The server says which open questions still stand: asked or referenced since the human last TYPED to the
// thread (`standing` on each row). A surface that cannot draw the message a card sits under hoists the
// card to the top of what it shows. That keeps a STANDING question reachable from a queue card whose
// window was cut below it — a shell finishing is not the human moving on — and until this date it also
// headed the card with a question the human had replied past, above the newer handoff.
test("from: a question that no longer stands is left out when its anchor is above the window, and a standing one is not", () => {
  const messages = [
    msg("user", 0),        // 0 the task
    msg("assistant", 2),   // 1 the rest that asked
    msg("user", 3),        // 2 whatever moved the thread on
    msg("assistant", 4),   // 3 the newest rest
  ]
  const q = { id: "qst_a", askedAt: at(2) }
  const faded = { ...q, standing: false }
  const standing = { ...q, standing: true }
  // The queue card's window starts at the turn that moved the thread on, so the asking rest is above it.
  assert.equal(questionsByAnchor(messages, [faded], { from: 2 }).size, 0, "typed past, and its message is not drawn: no card")
  assert.deepEqual([...questionsByAnchor(messages, [standing], { from: 2 }).keys()], [1], "still the ask: hoisted, as before")
  assert.deepEqual([...questionsByAnchor(messages, [q], { from: 2 }).keys()], [1], "a row from before the flag reads as standing")
  // Its message on screen — the reader clicked "View more", or this is the drawer: drawn in place.
  assert.deepEqual([...questionsByAnchor(messages, [faded], { from: 1 }).keys()], [1])
  assert.deepEqual([...questionsByAnchor(messages, [faded], { from: 0 }).keys()], [1])
  assert.deepEqual([...questionsByAnchor(messages, [faded]).keys()], [1], "no window given: every question has an anchor")
  // Above the drawer's LOADED window the anchor is -1, and the same rule drops it there.
  const loaded = messages.slice(2)
  assert.equal(questionsByAnchor(loaded, [faded], { from: 0 }).size, 0)
  assert.deepEqual([...questionsByAnchor(loaded, [standing], { from: 0 }).keys()], [-1])
  // One of each asked together: only the faded one leaves the group.
  assert.deepEqual(questionsByAnchor(messages, [faded, { ...standing, id: "qst_b" }], { from: 2 }).get(1)?.map((x) => x.id), ["qst_b"])
})

// Both surfaces that hoist pass their window, so neither can head itself with a faded question again.
test("the queue card and the drawer both tell questionsByAnchor where their window starts", () => {
  const queue = readFileSync(new URL("../components/TodosView.tsx", import.meta.url), "utf8")
  const drawer = readFileSync(new URL("../components/ChatView.tsx", import.meta.url), "utf8")
  assert.ok(queue.includes("questionsByAnchor(messages, unplaced, { from: visibleStart })"))
  // The drawer's window starts at 0; the one-thread pane's at the steer a queued thread opens on.
  assert.ok(drawer.includes("questionsByAnchor(messages, unplaced, { from: windowStart })"))
  for (const source of [queue, drawer]) assert.doesNotMatch(source, /questionsByAnchor\(messages, unplaced\)/)
})
