import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { AgentMarks, NewThreadAgentMarks } from "./AgentMarks.tsx"

// The marks beside a prompt box's model chip. Their cache entries (the quota, the credential and the box's
// selection) are seeded, which is how a static render reaches the shown state at all.
function client(options: { quota?: boolean; backend?: "claude" | "codex" | "acp" } = {}): QueryClient {
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (options.quota !== false) {
    queries.setQueryData(["quota"], {
      claude: { status: "ok", planType: "max", windows: [{ key: "5h", label: "5h", usedPercent: 17 }, { key: "weekly-fable", label: "Fable wk", usedPercent: 90 }] },
      codex: { status: "ok", planType: "pro", windows: [{ key: "5h", label: "5h", usedPercent: 41 }] },
    })
    queries.setQueryData(["authStatus"], { claude: "authed", codex: "authed", emails: {} })
  }
  queries.setQueryData(["dispatchPreferencesGet"], {
    backend: options.backend ?? "claude",
    claude: { model: "opus", effort: "high" },
    codex: { model: "gpt-5.5-codex", effort: "high" },
  })
  return queries
}

const render = (element: Parameters<typeof createElement>[0], props: object, queries = client()) =>
  renderToStaticMarkup(createElement(QueryClientProvider, { client: queries }, createElement(element, props)))

test("a new-thread box's gauge follows the model its chip has selected", () => {
  const claude = render(NewThreadAgentMarks, {}, client({ backend: "claude" }))
  assert.match(claude, /data-quota-gauge="claude"/)
  assert.match(claude, /data-remaining="83"/)
  assert.match(claude, /aria-label="Claude quota for Opus: 83% remaining in the 5h window"/)

  const codex = render(NewThreadAgentMarks, {}, client({ backend: "codex" }))
  assert.match(codex, /data-quota-gauge="codex"/)
  assert.match(codex, /data-remaining="59"/)

  // An ACP agent reports no quota, so there is nothing to gauge.
  assert.doesNotMatch(render(NewThreadAgentMarks, {}, client({ backend: "acp" })), /data-quota-gauge/)
})

test("a thread's gauge reads the thread's own model, whatever the new-thread chip has selected", () => {
  const html = render(AgentMarks, { gauge: { backend: "claude", model: "claude-fable-5-1" }, side: "top" }, client({ backend: "codex" }))
  assert.match(html, /data-quota-gauge="claude"/)
  assert.match(html, /data-quota-window="weekly-fable"/, "Fable's own weekly cap is nearly spent, so it is the reading")
  assert.match(html, /data-remaining="10"/)
})

test("the gauge is a dial whose needle and lit arc stand at the reading", () => {
  const html = render(NewThreadAgentMarks, {})
  const gauge = html.slice(html.indexOf("data-fuel-gauge"))
  assert.match(gauge, /data-gauge-track=""/)
  assert.match(gauge, /data-gauge-level=""/)
  assert.match(gauge, /data-gauge-needle=""/)
  assert.match(gauge, /data-gauge-hub=""/)
})

test("a provider with NO DATA renders no gauge at all", () => {
  // "if there's no data available for a given agent, then it should just be entirely hidden instead of
  // showing an em dash" (maintainer 2026-08-19). An em dash spent a readout's worth of space saying a
  // readout was missing.
  const none = render(NewThreadAgentMarks, {}, client({ quota: false }))
  assert.doesNotMatch(none, /data-quota-gauge/)
  assert.doesNotMatch(none, /—/, "no em dash anywhere")
})

test("the marks' wrapper draws nothing when neither mark has anything to show", () => {
  // It carries a margin, so an empty one would still push whatever follows it.
  const html = render(AgentMarks, { side: "top" })
  assert.match(html, /<div data-agent-marks="" class="[^"]*empty:hidden[^"]*"><\/div>/)
})
