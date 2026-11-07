import { test } from "node:test"
import assert from "node:assert/strict"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { SendSplitButton } from "./SendSplitButton.tsx"
import { sendPlaceholder } from "../lib/sendMode.ts"

const base = { armed: true, mode: "steer" as const, running: true, right: 8, onMode: () => {}, onSend: () => {} }

test("a thread that can steer keeps the caret and says what its send does", () => {
  const html = renderToStaticMarkup(createElement(SendSplitButton, base))
  assert.match(html, /data-send-menu/)
  assert.match(html, /title="Send as steer \(Enter · ⌘⏎ sends now\)"/)
  assert.match(html, /width:69\.5px/)
})

test("a thread that can only queue draws the button alone, and promises neither a steer nor a send now", () => {
  const html = renderToStaticMarkup(createElement(SendSplitButton, { ...base, mode: "queue", steerable: false }))
  assert.doesNotMatch(html, /data-send-menu/)
  assert.doesNotMatch(html, /steer|sends now/i)
  assert.match(html, /title="Send to queue: it waits for this turn to end \(Enter\)"/)
  assert.match(renderToStaticMarkup(createElement(SendSplitButton, { ...base, running: false, steerable: false })), /title="Send \(Enter\)"/)
})

test("the placeholder of a thread that can only queue names the end of the turn", () => {
  assert.equal(sendPlaceholder({ staged: 0, openQuestions: false, running: true, mode: "queue", steerable: false }), "Queue a message for when this turn ends…")
  assert.equal(sendPlaceholder({ staged: 0, openQuestions: false, running: true, mode: "queue" }), "Queue a message for when the agent rests…")
  assert.equal(sendPlaceholder({ staged: 0, openQuestions: false, running: false, mode: "queue", steerable: false }), "Reply to the agent…")
})
