import { useState } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { Composer } from "./components/Composer.tsx"
import { GithubTrigger } from "./components/GithubTrigger.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import "./styles.css"

// Browser QA for the GitHub door and the new-thread box's rail: the door sits in the line above the box,
// and the rail is the paperclip and send. Stubs githubStatus — `?unauthed` the signed-out answer, `?norepo`
// a project that is no GitHub repo.
// `?heals` is the OUTAGE replay: the first answer is the one a dead network to api.github.com produces
// (inRepo:false — `gh repo view` is a live API call), every answer after it is healthy. It exists to pin
// that the trigger comes back on its own, with no reload, because on 2026-08-11 it did not: a nine-minute
// outage flipped the answer, the tab kept it, and nothing ever re-asked.
const params = new URLSearchParams(location.search)
const authed = !params.has("unauthed")
const inRepo = !params.has("norepo")
const heals = params.has("heals")
let githubStatusCalls = 0
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/_frizz/rpc/githubStatus") {
    const outage = heals && githubStatusCalls++ === 0
    const result = outage ? { inRepo: false, authed: true } : { inRepo, authed }
    return new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  return originalFetch(input, init)
}

function Fixture() {
  const [value, setValue] = useState("A short task prompt to enable the send button.")
  return (
    <div className="min-h-screen bg-bg text-fg flex items-center justify-center p-10">
      <div className="w-[520px]">
        <div className="mb-2.5 flex min-h-6 items-center justify-end gap-3"><GithubTrigger /></div>
        <Composer
          surface="newComposer"
          value={value}
          onChange={setValue}
          onSubmit={() => {}}
          placeholder="Describe the task…"
          minHeight={96}
          maxHeight={340}
          footer={<span className="text-[11px] text-muted">gpt-5.6 · default</span>}
        />
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </QueryClientProvider>,
)
