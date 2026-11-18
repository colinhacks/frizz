import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import type { BoardSnapshot, ProjectCard, ThreadView } from "@frizz/shared"
import { ConsoleSidebar } from "./components/ConsoleSidebar.tsx"
import { Sidebar } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { setConsoleGroup } from "./lib/consoleBoard.ts"
import { setThemePreference } from "./lib/theme.ts"
import { threadKey } from "./lib/threadKey.ts"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for THE QUEUE DOT (Sidebar.tsx ThreadRow `queueDot`): the real <Sidebar/> over a board shaped
// like the one it was asked for on (maintainer 2026-11-17) — a Pinned shelf where two questions and a
// queued timer park are waiting on the human, beside a pinned done report, a pinned handoff and a
// pinned timer park that are not, over a Queue band and a Running row.
//
//   /queue-dot-fixture.html                              — a project's board
//   /queue-dot-fixture.html?surface=console&group=status — the Console's Pinned shelf (its own pins)
//   /queue-dot-fixture.html?surface=console&group=project — the Console's project blocks
//   &pane=<slug>                                          — the pane's marker on that row, beside its dot
//   &theme=light                                          — the light theme

const T0 = Date.now() - 6 * 3_600_000
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString()

function thread(id: string, title: string, restedMin: number, over: Partial<ThreadView> = {}): ThreadView {
  return {
    id,
    title,
    titleAuto: false,
    sessionId: `${id}-session`,
    kind: "session",
    state: "open",
    status: "active",
    statusText: "",
    backend: "claude",
    permissionMode: "default",
    humanBlocked: false,
    needsYou: true,
    pendingQuestion: false,
    crashed: false,
    archived: false,
    foreign: false,
    subAgents: [],
    bgShells: [],
    watches: [],
    runtime: "turn-idle",
    spawnedAt: at(0),
    lastUserAt: at(restedMin - 5),
    lastAssistantAt: at(restedMin),
    lastActivityAt: at(restedMin),
    ...over,
  } as unknown as ThreadView
}

const timer = { watches: [{ id: "tmr_1", kind: "timer", state: "armed", target: "tmr_1" }] } as unknown as Partial<ThreadView>
const question = { pendingQuestion: true } as Partial<ThreadView>
const doneReport = { plainReport: true, lastFence: { kind: "done" } } as unknown as Partial<ThreadView>
const handoff = { plainReport: true } as Partial<ThreadView>
const notQueued = { needsYou: false, waitStatus: "watching" } as Partial<ThreadView>

const params = new URL(window.location.href).searchParams
const surface = params.get("surface") ?? "project"
const group = params.get("group") === "status" ? "status" : "project"
setThemePreference(params.get("theme") === "light" ? "light" : "dark")

// [project, slug, title, rested minutes, overrides, pinned]
const ROWS: [string, string, string, number, Partial<ThreadView>, boolean][] = [
  ["alpha", "releaser", "Releaser", 359, { ...timer, ...notQueued }, true],
  ["alpha", "leak-watcher", "Leak watcher", 300, timer, true],
  ["beta", "hiring", "Hiring candidates", 338, doneReport, true],
  ["alpha", "issue-watcher", "Issue watcher", 343, handoff, true],
  ["beta", "new-user-watcher", "New-user watcher", 327, question, true],
  ["alpha", "pilot-books", "Pilot October books and company tax records", 326, question, true],
  ["alpha", "soc2", "SOC 2 Type I readiness and auditor quotes", 60, timer, false],
  ["beta", "oss-showcase", "Static, active-only /for-oss showcase", 323, doneReport, false],
  ["alpha", "offboarding", "Savannah Bosse offboarding", 326, handoff, false],
  ["beta", "org-defaults", "Org automation defaults inherited by repos (pullfrog/pullfrog#132)", 343, question, false],
  ["alpha", "smart-guidance", "Plain-text Smart guidance (pullfrog/app#1711)", 355, { needsYou: false, runtime: "running" }, false],
]

const PIN = at(10)
const threads = ROWS.map(([project, slug, title, rested, over, pinned]) => {
  const pin = pinned ? (surface === "console" ? { consolePinnedAt: PIN } : { pinnedAt: PIN }) : {}
  return thread(surface === "console" ? threadKey(project, slug) : slug, title, rested, { ...over, ...pin })
})

const PROJECTS = ["alpha", "beta"].map((slug) => ({ id: `id-${slug}`, slug, name: slug[0]!.toUpperCase() + slug.slice(1), path: `/fixture/${slug}`, stale: false, iconStatus: "none" }) as unknown as ProjectCard)

if (surface === "console") {
  history.replaceState(null, "", "/console")
  setConsoleGroup(group)
}
store.board = { projectDir: "/fixture/alpha", threads } as BoardSnapshot
store.drawers = []
const pane = params.get("pane")
if (pane) store.paneSlug = surface === "console" ? threadKey(pane === "smart-guidance" || pane === "pilot-books" ? "alpha" : "beta", pane) : pane

const json = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin)
  const rpc = /^\/_frizz\/(?:[\w-]+\/)?rpc\/(\w+)/.exec(url.pathname)?.[1]
  if (!rpc) return nativeFetch(input, init)
  if (rpc === "projectsList") return json(PROJECTS)
  if (rpc === "projectsRailCounts") return json(Object.fromEntries(PROJECTS.map((p) => [p.id, { queued: 0, running: 0, asks: 0 }])))
  if (rpc === "dispatchPreferencesGet") return json({ backend: "claude", claude: { permissionMode: "auto" }, codex: { permissionMode: "default" } })
  if (rpc === "codexModels" || rpc === "acpAgents") return json([])
  if (rpc === "settingsGet") return json({ permissionMode: "bypassPermissions", notifications: true })
  return json(null)
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })}>
    <TooltipProvider>
      <MemoryRouter>
        <div className="relative min-h-screen bg-bg text-fg text-sm">
          <div className="flex min-h-screen justify-center gap-[clamp(28px,3.4vw,52px)] px-5">
            {surface === "console" ? <ConsoleSidebar /> : <Sidebar />}
            <main id="workpane" className="w-[720px] max-w-[62vw] min-w-0 py-5" />
          </div>
        </div>
      </MemoryRouter>
    </TooltipProvider>
  </QueryClientProvider>,
)
