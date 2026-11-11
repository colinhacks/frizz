import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const chat = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
const shell = readFileSync(new URL("./ThreadSurface.tsx", import.meta.url), "utf8")
const threadMessage = () => {
  const component = chat.match(/export function ThreadMessage\([\s\S]*?\n}\n/)?.[0]
  assert.ok(component, "ThreadMessage must exist")
  return component
}

// A ```question fence restating or naming a question REGISTERED at that rest or an earlier one is folded
// into the registered card (lib/questionShadow) — the 2026-08-28 "same question showing up twice in a row".
// The fold is a prop on Message, so it works only where the transcript hands it over.
//
// These used to pin that EVERY surface did: four Message call sites in two files, each grepped for the
// same line, and three copies of the map behind them. There is one of each now. The thread surface
// derives what a message means (ThreadSurface.tsx ThreadTranscript), ThreadMessage hands it to Message,
// and every surface draws a transcript message through ThreadMessage — so what is left to pin is that one
// hand-over, and that no surface has gone back to deriving or passing any of it for itself
// (ThreadSurface.guard.test.ts pins the second half for the whole source tree).

test("the one Message hand-over gives it the registered questions at its rest", () => {
  assert.match(threadMessage(), /shadowedBy=\{t\.shadowedByMessage\.get\(index\)\}/)
  assert.equal((chat.match(/shadowedBy=\{/g) ?? []).length, 1, "ThreadMessage is the only site that passes it")
})

test("the map is built once, off the messages and questions the anchors use", () => {
  // `openQuestions` is the board's open list minus the ids already drawn settled (openQuestionsOf) — the
  // same list the placement and the anchors read on each surface.
  const build = /registeredStandingAt\(messages, openQuestions\), \[messages, openQuestions\]\)/g
  assert.equal((shell.match(build) ?? []).length, 1, "the thread surface builds it")
  assert.doesNotMatch(chat, /registeredStandingAt\(/)
})

test("a folded fence leaves no Send button behind it", () => {
  // Message's own bottom button needs a block that actually rendered…
  // (…and, since 2026-10-11, a surface with no prompt box to send them: where one is mounted its Send
  // button carries every staged answer, and neither of these two is drawn — lib/sendScope.)
  assert.match(chat, /else if \(showSendButton && answering && askBlocks\.length > 0 && !promptBoxSends\)/)
})

// ---- PER-QUESTION PLACEMENT (2026-09-11) ----

test("the hand-over gives the message its placed questions, and the stack at each placed card's rest carries its Send", () => {
  assert.match(threadMessage(), /placed=\{t\.placement\.placed\.get\(index\)\}/)
  assert.match(threadMessage(), /settledPlaced=\{t\.settledPlacement\.placed\.get\(index\)\}/)
  assert.equal((chat.match(/\bplaced=\{/g) ?? []).length, 1, "ThreadMessage is the only site that passes it")
  // The placement is the surface's, over the whole list. The pane draws a window of it, so it narrows
  // the same placement for its anchors (placedFrom) rather than computing one of its own.
  assert.equal((shell.match(/placeQuestions\(messages, openQuestions\), \[messages, openQuestions\]\)/g) ?? []).length, 1)
  // The Send rides the rest a placed card sits in (placedRestEnds), never "any card placed anywhere": a
  // card placed at an older rest with a Send at the tail and nothing above it is the 2026-09-13 report.
  assert.equal((chat.match(/placedRestEnds\(messages, placement\)/g) ?? []).length, 1, "the thread page groups its Sends by rest")
  assert.equal((chat.match(/showSend=\{questionGroups\.tailSend\}/g) ?? []).length, 1, "the thread page's tail stack")
  assert.equal((chat.match(/showSend=\{row\.send\}/g) ?? []).length, 1, "the thread page's anchored stacks")
})

test("a placed question leaves its anchor group, and each surface mounts ONE answering provider", () => {
  assert.match(chat, /filter\(\(q\) => !placement\.placedIds\.has\(q\.id\)\)/)
  // The provider is the thread surface's (ThreadSurface), which the thread view mounts exactly once —
  // ThreadSurface.guard.test.ts pins that, and that nothing mounts a provider of its own.
  assert.equal((shell.match(/<RegisteredAnsweringProvider thread=\{surface\.transcript\.thread\}>/g) ?? []).length, 1)
  assert.equal((chat.match(/<ThreadSurface surface=\{surface\} /g) ?? []).length, 1)
})

test("a free-form fence in a post-retirement thread gets no answering controller, on any surface", () => {
  assert.match(threadMessage(), /answering=\{t\.fencesLive \? t\.answeringForMessage\(m\) : undefined\}/)
  assert.equal((chat.match(/answeringForMessage\(/g) ?? []).length, 1, "ThreadMessage is the only caller")
})
