import { test } from "node:test"
import assert from "node:assert/strict"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { SendSplitButton } from "./SendSplitButton.tsx"
import { sendPlaceholder } from "../lib/sendMode.ts"

const base = { armed: true, mode: "steer" as const, running: true, right: 8, bottom: 7, onMode: () => {}, onSend: () => {} }

const face = (html: string) => /data-send-label="true">([^<]*)</.exec(html)?.[1]

test("a thread that can steer keeps the caret and says what its send does", () => {
  const html = renderToStaticMarkup(createElement(SendSplitButton, base))
  assert.match(html, /data-send-menu/)
  assert.match(html, /title="Send as steer \(Enter · ⌘⏎ sends now\)"/)
  assert.match(html, /width:71\.5px/)
})

// The maintainer, 2026-11-20: "The send button should switch between steer and [queue] depending on the
// current value. It shouldn't just say 'send' for both."
test("the button's face is the ticked way of sending, working or at rest", () => {
  for (const running of [true, false]) {
    const steer = renderToStaticMarkup(createElement(SendSplitButton, { ...base, running }))
    assert.equal(face(steer), "Steer")
    assert.match(steer, /aria-label="Send as steer"/)
    const queue = renderToStaticMarkup(createElement(SendSplitButton, { ...base, running, mode: "queue" }))
    assert.equal(face(queue), "Queue")
    assert.match(queue, /aria-label="Send to queue"/)
    // Each word in a pill of its own width, the word's half and the whole.
    assert.match(queue, /width:77\.5px/)
    assert.match(queue, /width:53\.5px/)
  }
})

test("a thread that can only queue draws the button alone, and promises neither a steer nor a send now", () => {
  const html = renderToStaticMarkup(createElement(SendSplitButton, { ...base, mode: "queue", steerable: false }))
  assert.doesNotMatch(html, /data-send-menu/)
  assert.doesNotMatch(html, /steer|sends now/i)
  // With no tick to show, the face is the plain verb.
  assert.equal(face(html), "Send")
  assert.match(html, /aria-label="Send"/)
  assert.match(html, /title="Send to queue: it waits for this turn to end \(Enter\)"/)
  assert.match(renderToStaticMarkup(createElement(SendSplitButton, { ...base, running: false, steerable: false })), /title="Send \(Enter\)"/)
})

test("the placeholder of a thread that can only queue names the end of the turn", () => {
  assert.equal(sendPlaceholder({ staged: 0, openQuestions: false, running: true, mode: "queue", steerable: false }), "Queue a message for when this turn ends…")
  assert.equal(sendPlaceholder({ staged: 0, openQuestions: false, running: true, mode: "queue" }), "Queue a message for when the agent rests…")
  assert.equal(sendPlaceholder({ staged: 0, openQuestions: false, running: false, mode: "queue", steerable: false }), "Reply to the agent…")
})
