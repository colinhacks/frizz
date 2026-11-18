import { test } from "node:test"
import assert from "node:assert/strict"
import type { ChatMessage } from "../hooks.ts"
import { withDispatchedPrompt } from "./dispatchedPrompt.ts"

const prompt = { text: "Fix the resolver cache", at: "2026-11-17T12:00:00.000Z" }
const later = "2026-11-17T12:00:03.000Z"
const user = (text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ role: "user", text, tools: [], parts: [], ...extra })
const agent = (text: string): ChatMessage => ({ role: "assistant", text, tools: [], parts: [] })

test("a starting thread with an empty transcript opens on the words that started it", () => {
  assert.deepEqual(withDispatchedPrompt([], prompt, true), [user(prompt.text, { at: prompt.at })])
})

test("the prompt goes first, above anything the session wrote before it, and is drawn as sent", () => {
  const before = [agent("")]
  const drawn = withDispatchedPrompt(before, prompt, true)
  assert.deepEqual(drawn.map((m) => m.text), [prompt.text, ""])
  assert.equal(drawn[0].queued, undefined)
  assert.equal(drawn[1], before[0])
})

test("a thread that is no longer starting does not draw words its session never wrote", () => {
  const empty: ChatMessage[] = []
  assert.equal(withDispatchedPrompt(empty, prompt, false), empty)
})

test("a follow-up queued while the session starts is not the first message landing", () => {
  const drawn = withDispatchedPrompt([user("also check the tests", { queued: true })], prompt, true)
  assert.deepEqual(drawn.map((m) => m.text), [prompt.text, "also check the tests"])
})

test("the session's copy takes the prompt's place, keeping the instant it was sent", () => {
  const landed = [user(prompt.text, { sourceId: "rec-1", at: later }), agent("On it.")]
  const drawn = withDispatchedPrompt(landed, prompt, true)
  assert.equal(drawn.length, 2)
  assert.deepEqual(drawn[0], { ...landed[0], at: prompt.at })
  assert.equal(drawn[1], landed[1])
  // …whatever the thread is doing by then.
  assert.equal(withDispatchedPrompt(landed, prompt, false)[0].at, prompt.at)
})

test("the copy is matched by the words its bubble draws, not the composed prompt under them", () => {
  const composed = user(`Your scratch directory is …\n\n=== YOUR TASK ===\n${prompt.text}`, { displayText: prompt.text, at: later })
  assert.equal(withDispatchedPrompt([composed], prompt, true)[0].at, prompt.at)
})

test("a first message with other words, or no later instant, is left as it is, by identity", () => {
  const other = [user("Something else entirely", { at: later })]
  assert.equal(withDispatchedPrompt(other, prompt, true), other)
  const earlier = [user(prompt.text, { at: "2026-11-17T11:59:59.000Z" })]
  assert.equal(withDispatchedPrompt(earlier, prompt, true), earlier)
})

test("nothing remembered draws nothing, by identity", () => {
  const empty: ChatMessage[] = []
  assert.equal(withDispatchedPrompt(empty, undefined, true), empty)
})
