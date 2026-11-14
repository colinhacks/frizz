import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { Sidebar } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// The app pins sans on <html> (index.html); a fixture that does not renders the mono default nobody sees.
document.documentElement.dataset.font = "sans"

// Browser QA for the RUNNING-WITH-AN-OPEN-QUESTION mark (2026-10-08): a worker that registers a question
// keeps working, so its thread stays in the Running band — and until this change it wore the plain
// spinner there, so nothing on the rail said an answer was wanted. Renders the REAL <Sidebar/> over an
// invented board (no real thread titles):
//
//   RUNNING BAND
//     own turn running, no question              → [/] empty spinner     (unchanged)
//     own turn running, OPEN registered question → [/] with "?" inside   (THE CHANGE)
//     at rest, live sub-agent, not queued        → [/] with "…" inside   (unchanged)
//   RESTED BAND
//     at rest, open registered question          → [?] static            (unchanged)
//     bare rest                                  → […] static            (unchanged)
//
// `?mode=play` walks ONE thread through the lifecycle the change is about instead — running, asks and
// keeps working, rests, is answered — so a recording shows the mark appear, move bands, and clear.

const base = {
  kind: "session",
  state: "open",
  status: "active",
  mechanism: null,
  backend: "claude",
  permissionMode: "default",
  humanBlocked: false,
  pendingQuestion: false,
  crashed: false,
  archived: false,
  foreign: false,
  ready: false,
  unread: false,
  hasPlan: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  bgShells: [],
  subAgents: [],
  spawnedAt: "2026-10-08T09:00:00.000Z",
} as const

// Times relative to load, so the rail's ages read as a live board would ("4m"), not as a fixed date.
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

const question = [{ id: "qst_ab12cd34", spec: { question: "Should the export include archived rows?", kind: "question" as const }, askedAt: ago(3) }]
const row = (id: string, title: string, n: number, over: Record<string, unknown>) =>
  ({ ...base, id, title, sessionId: `aaaaaaaa-bbbb-cccc-dddd-00000000000${n}`, lastActivityAt: ago(1), lastUserAt: ago(12), ...over }) as unknown as ThreadView

const running = row("migrate-settings-tabs", "Migrate the settings page to tabs", 1, { runtime: "running", needsYou: false })
const subAgents = row("audit-retry-policy", "Audit the retry policy", 3, {
  runtime: "turn-idle",
  needsYou: false,
  subAgents: [{ id: "c1", label: "Trace every retry path", subagentType: "frizz:high", startedAt: ago(6), state: "running" }],
})
const restedAsk = row("rename-webhook-handler", "Rename the billing webhook handler", 4, { runtime: "turn-idle", needsYou: true, questions: question, lastActivityAt: ago(18) })
const bareRest = row("fix-flaky-login-test", "Fix the flaky login test", 5, { runtime: "turn-idle", needsYou: true, lastActivityAt: ago(41) })

// The subject: one thread, four moments. Captions name the thread's STATE and never the mark, so one
// fixture captions a build with the change and one without it truthfully.
const STEPS: { caption: string; t: Record<string, unknown> }[] = [
  { caption: "1 · Working, no question yet", t: { runtime: "running", needsYou: false } },
  { caption: "2 · Asked a question, still working", t: { runtime: "running", needsYou: false, questions: question } },
  { caption: "3 · At rest, question still open", t: { runtime: "turn-idle", needsYou: true, questions: question, lastActivityAt: ago(0) } },
  { caption: "4 · Answered, working again", t: { runtime: "running", needsYou: false } },
]
const subject = (i: number) => row("add-csv-export", "Add CSV export to the reports view", 2, STEPS[i].t)

const params = new URLSearchParams(location.search)
const mode = params.get("mode") ?? "states"
// `?label=Before` prefixes every caption, for recordings shown side by side.
const label = params.get("label")
const caption = document.createElement("div")

function show(threads: ThreadView[]) {
  store.board = { projectDir: "/fixture/app", threads } as unknown as BoardSnapshot
}

store.drawers = []
if (mode === "play") {
  let i = 0
  let timer: ReturnType<typeof setInterval> | undefined
  const tick = () => {
    show([running, subject(i), subAgents, bareRest])
    caption.textContent = label ? `${label} — ${STEPS[i].caption}` : STEPS[i].caption
    i = (i + 1) % STEPS.length
  }
  // `window.play()` restarts the cycle at step 1, so two recordings can start in phase.
  ;(window as unknown as { play: () => void }).play = () => {
    clearInterval(timer)
    i = 0
    tick()
    timer = setInterval(tick, 2600)
  }
  ;(window as unknown as { play: () => void }).play()
} else {
  show([running, subject(1), subAgents, restedAsk, bareRest])
}

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : ((input as Request).url ?? input.toString()), location.origin)
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>
      <MemoryRouter>
        <div className="flex min-h-screen bg-bg text-fg">
          <Sidebar />
          <div
            className="p-6 text-[13px] text-muted"
            ref={(el) => {
              if (el && mode === "play" && !el.contains(caption)) el.appendChild(caption)
            }}
          />
        </div>
      </MemoryRouter>
    </TooltipProvider>
  </QueryClientProvider>,
)
