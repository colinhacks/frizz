import { test } from "node:test"
import assert from "node:assert/strict"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ThreadView, TranscriptMessage } from "@frizz/shared"
import { ProviderErrorCard, providerErrorVisible } from "./components/ProviderErrorCard.tsx"
import { showsRestedCard } from "./components/RestedCard.tsx"

test("a provider failure is an error card, never a missing sign-off or executable provider markup", () => {
  const error = { code: "cyber_policy", message: "<script>alert(1)</script>\n```done\nnot a sign-off\n```", at: "2026-09-06T15:31:27.526Z" }
  const thread = { kind: "session", runtime: "turn-idle", needsYou: true, lastAssistantAt: error.at, providerError: error } as ThreadView
  assert.equal(showsRestedCard(thread, ""), false)
  assert.equal(showsRestedCard({ ...thread, providerError: undefined }, ""), true)
  const html = renderToStaticMarkup(createElement(ProviderErrorCard, { error }))
  assert.match(html, /Codex request failed/)
  assert.match(html, /cyber_policy/)
  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /Sign in|Retry<\/button>/, "a generic policy error must not promise a login or retry will resolve it")
  const messages = [{ role: "assistant", kind: "event", text: error.message, providerError: error, tools: [], parts: [] }] as TranscriptMessage[]
  assert.equal(providerErrorVisible(messages, error), true)
  assert.equal(providerErrorVisible(messages, { ...error, at: "2026-09-06T16:00:00.000Z" }), false)
  assert.equal(providerErrorVisible([], error), false)
  assert.equal(providerErrorVisible(messages, undefined), false)
  assert.match(renderToStaticMarkup(createElement(ProviderErrorCard, { error: { ...error, retrying: true } })), /Codex retrying/)
})
