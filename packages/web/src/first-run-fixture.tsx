import { createRoot } from "react-dom/client"
import { BrowserRouter } from "react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot } from "@frizz/shared"
import { FirstTaskView } from "./components/FirstTaskView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// FIRST-RUN FIXTURE — the ONE screen a brand-new project shows (FirstTaskView),
// where the prompt box IS the whole screen and App hides the sidebar in lockstep.
//
// It exists because that screen carries the StatusRow too (2026-08-19). The row rides the PROMPT BOX,
// and here the prompt box is not in the sidebar — without it a fresh install would have no project
// identity, no way to settings, no reload and no quota reading anywhere on screen. That is a surface
// with real chrome on it and no other fixture reaches it.
//
// `?font=mono` flips the type family; the app renders in two (html[data-font], applied before first
// paint) and a fixture that leaves it unset silently renders mono.

const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"

const nowSeconds = Math.floor(Date.now() / 1000)
const windows = (fiveHour: number, weekly: number) => [
  { key: "5h", label: "5h", usedPercent: fiveHour, resetsAt: nowSeconds + 2 * 3600 },
  { key: "weekly", label: "Weekly", usedPercent: weekly, resetsAt: nowSeconds + 3 * 86400 },
]

const nativeFetch = window.fetch.bind(window)
const json = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
window.fetch = async (input, init) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url
  const url = new URL(href, location.origin)
  // A restart-capable supervisor and real credentials are the two things no sandbox has, and without
  // them the reload button renders null and both quota chips sit on their placeholder forever.
  if (url.pathname === "/_frizz/control/status")
    return new Response(JSON.stringify({ protocol: 1, state: "ready", updateRestart: true }), { headers: { "content-type": "application/json" } })
  if (url.pathname === "/_frizz/rpc/quota")
    return json({
      claude: { status: "ok", planType: "max", windows: windows(17, 38) },
      codex: { status: "ok", planType: "pro", windows: windows(41, 29) },
    })
  if (url.pathname === "/_frizz/rpc/authStatus")
    return json({ claude: "authed", codex: "authed", emails: { claude: "colin@pullfrog.com", codex: "colinmcd94@gmail.com" } })
  if (url.pathname === "/_frizz/rpc/dispatchPreferencesGet")
    return json({ backend: "claude", claude: { model: "opus", effort: "high", permissionMode: "auto" }, codex: { model: "gpt-5.6-sol", effort: "medium", permissionMode: "default" } })
  if (url.pathname === "/_frizz/rpc/codexModels")
    return json([{ slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultEffort: "medium", efforts: ["low", "medium", "high"] }])
  if (url.pathname === "/_frizz/rpc/acpAgents") return json([])
  if (url.pathname.startsWith("/_frizz/rpc/")) return json(null)
  return nativeFetch(input, init)
}

// ZERO threads is exactly the `nothingAtAll` predicate. A board with only done threads
// is NOT a new user, so it must not be seeded here.
store.board = { projectDir: "/fixture/first-run", projectLabel: "colinhacks/frizz", threads: [] } as unknown as BoardSnapshot
store.drawers = []

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      {/* App's own wrapper for this branch: the workpane's readable measure, centered, with the sidebar
          absent. The inner element copies App's <main> — a min-h-screen FLEX COLUMN — because
          FirstTaskView centers itself vertically with `my-auto`, which only resolves against a flex
          parent. A plain block here top-aligned the prompt box, which the app never does. */}
      <div className="flex min-h-screen justify-center bg-bg px-5 text-fg text-sm">
        <main className="flex min-h-screen w-[720px] max-w-[62vw] min-w-0 flex-col py-5">
          <FirstTaskView />
        </main>
      </div>
    </TooltipProvider>
  </QueryClientProvider>
  </BrowserRouter>,
)
