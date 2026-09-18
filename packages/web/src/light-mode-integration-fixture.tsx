import { useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadWatchView } from "@frizz/shared"
import { AcpModelSelect } from "./components/AcpModelSelect.tsx"
import { GithubWatchRow, WaitGrid } from "./components/AwaitingBackgroundCard.tsx"
import { ProviderMark } from "./components/ProviderMark.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import "./styles.css"

// Actual components, cached provider data: this verifies palette integration, not a live ACP probe.
const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = params.get("font") === "sans" ? "sans" : "mono"
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark"
const client = new QueryClient()
client.setQueryData(["acpAgentModels", "opencode"], {
  models: [{ id: "model-a", name: "Model A" }, { id: "model-b", name: "Model B" }],
})
const agents = ["opencode", "cursor", "gemini", "copilot", "qwen", "kimi", "grok"]
const originalFetch = window.fetch.bind(window)
window.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.origin)
  if (url.pathname === '/_frizz/rpc/githubRefPreview') {
    const { refs } = JSON.parse(url.searchParams.get('input') ?? '{}')
    return Promise.resolve(new Response(JSON.stringify({ result: { cards: [], missing: refs } }), { headers: { 'content-type': 'application/json' } }))
  }
  return originalFetch(input, init)
}
const issues: ThreadWatchView["issue"][] = [undefined,
  { state: "open", comments: 2, polledAt: "2026-09-16T12:00:00Z" },
  { state: "closed", stateReason: "completed", comments: 3, polledAt: "2026-09-16T12:00:00Z" },
  { state: "closed", stateReason: "not_planned", comments: 0, polledAt: "2026-09-16T12:00:00Z" },
]

function Fixture() {
  const [model, setModel] = useState<string>()
  return <main className="min-h-screen bg-bg p-4">
    <section className="max-w-xl space-y-4 rounded-lg border border-border bg-panel p-4">
      <div data-provider-marks className="space-y-2 text-[13px] leading-[19px] text-fg/90">
        {agents.map(agent => <div key={agent}>{agent}<ProviderMark backend="acp" model={`acp:${agent}`} className="ml-1" /></div>)}
      </div>
      <AcpModelSelect agentId="opencode" agentLabel="OpenCode" modelId={model} onValueChange={setModel} />
      <div data-issue-watches>
        <WaitGrid divider={false} groups={[{ head: "Issues", rows: issues.map((issue, index) => <GithubWatchRow key={index} watch={{
          id: `issue-${index}`, kind: "github", subject: "issue", target: `acme/app#${index + 1}`,
          state: "armed", createdAt: "2026-09-16T12:00:00Z", issue,
        }} />) }]} />
      </div>
    </section>
  </main>
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}><TooltipProvider><Fixture /></TooltipProvider></QueryClientProvider>,
)
