import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ProviderMark } from "./ProviderMark.tsx"
import { PROVIDER_MARK_GEOMETRY, providerMarkFor, providerMarkForBackend } from "./providerMark.ts"

test("provider marks identify only known, backend-backed threads", () => {
  assert.deepEqual(providerMarkForBackend("codex"), { key: "codex", backend: "codex", label: "OpenAI Codex" })
  assert.deepEqual(providerMarkForBackend("claude"), { key: "claude", backend: "claude", label: "Claude Code" })
  assert.equal(providerMarkForBackend(undefined), undefined)
  assert.equal(providerMarkForBackend(null), undefined)
  assert.equal(providerMarkForBackend("future-provider"), undefined)
})

test("an ACP thread's mark is its agent's brand glyph, falling back to the generic plug", () => {
  assert.deepEqual(providerMarkFor("acp", "acp:opencode"), { key: "acp:opencode", backend: "acp", label: "OpenCode" })
  assert.equal(providerMarkFor("acp", "acp:gemini")?.key, "acp:gemini")
  // Agents without a CC0 glyph (Grok Build, pi, Kilo, goose) and an unknown/absent model wear the plug.
  assert.equal(providerMarkFor("acp", "acp:grok")?.key, "acp")
  assert.equal(providerMarkFor("acp", undefined)?.key, "acp")
  // A Claude/Codex thread's model never changes its mark.
  assert.equal(providerMarkFor("claude", "acp:opencode")?.key, "claude")
})

test("provider mark geometry keeps compact monochrome marks optically centered beside a title", () => {
  assert.equal(PROVIDER_MARK_GEOMETRY.codex, "size-[10px]")
  assert.equal(PROVIDER_MARK_GEOMETRY.claude, "size-[11px] translate-y-px")
  for (const [key, geometry] of Object.entries(PROVIDER_MARK_GEOMETRY)) assert.match(geometry, /size-\[|h-\[/, `${key} sizes its box explicitly`)
})

test("every ACP provider mark uses semantic ink while retaining its own geometry", () => {
  for (const agent of ["opencode", "cursor", "gemini", "copilot", "qwen", "kimi", "grok"]) {
    const provider = providerMarkFor("acp", `acp:${agent}`)!
    const html = renderToStaticMarkup(createElement(ProviderMark, { backend: "acp", model: `acp:${agent}` }))
    assert.ok(html.includes(PROVIDER_MARK_GEOMETRY[provider.key]))
    assert.match(html, /text-muted-65/)
    assert.doesNotMatch(html, /text-muted\/65/)
  }
})
