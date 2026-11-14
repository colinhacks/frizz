import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import type { BoardSnapshot, CodexModel, DispatchPreferences, ProjectCard, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import { ConsoleSidebar } from "./components/ConsoleSidebar.tsx"
import { Sidebar } from "./components/Sidebar.tsx"
import { FirstTaskView } from "./components/FirstTaskView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { setConsoleGroup } from "./lib/consoleBoard.ts"
import { pickConsoleDispatchProject } from "./lib/consoleDispatchProject.ts"
import { threadKey } from "./lib/threadKey.ts"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for THE RAIL while the human dispatches: the real <Sidebar/> over three queued threads. It
// exists for what the rail did on every dispatch until 2026-10-13, recorded on a stack whose worker is
// the scripted Claude (scripts/scripted-claude.mjs) and pinned by queueRailSettle.e2e.test.ts: a
// dispatch from the prompt box put a "Starting thread…" card between the box and the rail for the length
// of the dispatch call, so every row moved down 73px and back up (lib/pendingDispatch). It drew the
// queue's cards beside the rail too, until the card went (2026-11-10).
//
// `?surface=` picks which prompt box the dispatch is made from (the default is a project's sidebar):
//
//   · `console` — the real <ConsoleSidebar/> over two projects' threads, at `/console` so the page keys
//     and routes as the Console does. `&group=status|project` picks the grouping, `&pick=<slug>` the
//     project the chip points at (`gamma` has nothing on the Console, so its block does not exist yet);
//   · `first-run` — a board with no thread at all: the centred prompt box (FirstTaskView), and no rail to
//     draw a row in.
//
// The server is modelled on what those recordings showed. A follow-up's board delta (the thread running,
// off the queue) lands tens of milliseconds after the click, well after the optimistic commit. A
// dispatch's board delta lands BEFORE the call's own answer, by 9-14ms.

const CARDS = [
  { id: "auth-refresh", title: "Silent token refresh on 401" },
  { id: "csv-export", title: "Streaming CSV export for large tables" },
  { id: "flaky-e2e", title: "Flaky checkout e2e in CI" },
]

const reply = (n: number) =>
  Array.from({ length: 4 }, (_, i) => `**Step ${i + 1}.** Card ${n}: agent output at a realistic triage-card length, so three cards overflow the window and the queue scrolls.`).join("\n\n")

const T0 = Date.now() - 600_000
function makeThread(id: string, title: string, n: number, over: Partial<ThreadViewModel> = {}): ThreadViewModel {
  // Oldest first, a minute apart: the queue's FIFO order is the order of CARDS.
  const rested = new Date(T0 + n * 60_000).toISOString()
  return {
    id,
    title,
    titleAuto: false,
    sessionId: `${id}-session`,
    kind: "session",
    state: "open",
    status: "active",
    statusText: "",
    mechanism: null,
    backend: "codex",
    permissionMode: "default",
    humanBlocked: false,
    needsYou: true,
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
    runtime: "turn-idle",
    spawnedAt: new Date(T0).toISOString(),
    lastUserAt: new Date(T0).toISOString(),
    lastAssistantAt: rested,
    lastActivityAt: rested,
    ...over,
  } as unknown as ThreadViewModel
}

// Read before the Console branch rewrites the address.
const params = new URL(window.location.href).searchParams
const surface = params.get("surface") ?? "project"

const PROJECTS = ["alpha", "beta", "gamma"].map((slug) => ({ id: `id-${slug}`, slug, name: slug[0].toUpperCase() + slug.slice(1), path: `/fixture/${slug}`, stale: false, iconStatus: "none" }) as unknown as ProjectCard)
// On the Console every thread is named by its project and its slug (lib/threadKey): the cards alternate
// between two projects, and each project has one thread running already.
const cardProject = (n: number) => (n % 2 === 0 ? "alpha" : "beta")
const consoleThreads = () => [
  ...CARDS.map((c, i) => makeThread(threadKey(cardProject(i), c.id), c.title, i)),
  ...["alpha", "beta"].map((project, i) => makeThread(threadKey(project, `long-job-${project}`), `Long job in ${project}`, i, { runtime: "running", needsYou: false, lastUserAt: new Date(T0 + (i + 5) * 60_000).toISOString() })),
]

if (surface === "console") {
  history.replaceState(null, "", "/console")
  setConsoleGroup(params.get("group") === "status" ? "status" : "project")
  pickConsoleDispatchProject(params.get("pick") ?? "beta")
}
store.board = {
  projectDir: "/fixture/frizz",
  threads: surface === "console" ? consoleThreads() : surface === "first-run" ? [] : CARDS.map((c, i) => makeThread(c.id, c.title, i)),
} as BoardSnapshot
store.drawers = []

const setThreads = (next: (threads: readonly ThreadViewModel[]) => ThreadViewModel[]) => {
  if (store.board) store.board = { ...store.board, threads: next(store.board.threads as ThreadViewModel[]) } as BoardSnapshot
}

function transcriptFor(slug: string) {
  const n = Math.max(0, CARDS.findIndex((c) => c.id === slug))
  const card = CARDS[n]
  const messages: TranscriptMessage[] = [
    { sourceId: `${slug}-u1`, role: "user", text: `Please handle: ${card.title}.`, tools: [], parts: [] },
    { sourceId: `${slug}-a1`, role: "assistant", text: reply(n + 1), tools: [], parts: [{ kind: "text", text: reply(n + 1) }] },
  ]
  return { messages, transcriptKey: `${slug}-key`, hasEarlier: false, historyLoaded: false }
}

const codexModels: CodexModel[] = [{ slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultEffort: "medium", efforts: ["low", "medium", "high"] }]
const preferences: DispatchPreferences = { backend: "codex", claude: { permissionMode: "auto" }, codex: { model: "gpt-5.6-sol", effort: "medium", permissionMode: "default" } }
// How long the dispatch call takes, and how far its answer trails the board delta that carries the row.
const dispatchMs = Number(params.get("dispatchMs") ?? 400)
const answerLagMs = Number(params.get("answerLagMs") ?? 12)
const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms))
const json = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })

function slugOf(url: URL, init?: RequestInit): string | null {
  try {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null
    if (body?.slug) return body.slug
    const input = url.searchParams.get("input")
    return input ? (JSON.parse(input)?.slug ?? null) : null
  } catch {
    return null
  }
}

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin)
  // `/_frizz/rpc/<name>`, or `/_frizz/<project>/rpc/<name>` for a call the Console addressed to a project.
  const route = /^\/_frizz\/(?:([\w-]+)\/)?rpc\/(\w+)/.exec(url.pathname)
  const rpc = route?.[2]
  const project = route?.[1]
  if (!rpc) return nativeFetch(input, init)
  if (rpc === "projectsList") return json(PROJECTS)
  if (rpc === "projectsRailCounts") return json(Object.fromEntries(PROJECTS.map((p) => [p.id, { queued: 0, running: 0, asks: 0 }])))
  if (rpc === "dispatchPreferencesGet") return json(preferences)
  if (rpc === "codexModels") return json(codexModels)
  if (rpc === "acpAgents") return json([])
  if (rpc === "settingsGet") return json({ permissionMode: "bypassPermissions", notifications: true, autoCompactWindow: 500000, promptCacheTtl: "auto" })
  if (rpc === "threadTranscript" || rpc === "threadTranscriptEarlier") return json(transcriptFor(slugOf(url, init) ?? CARDS[0].id))
  if (rpc === "threadSettledQuestions") return json({ questions: [] })
  if (rpc === "followUp") {
    const slug = slugOf(url, init)
    // The turn starts: the thread is running and off the queue, as the server's own delta reports it.
    await wait(60)
    const now = new Date().toISOString()
    const id = project && slug ? threadKey(project, slug) : slug
    setThreads((threads) => threads.map((t) => (t.id === id ? ({ ...t, runtime: "running", needsYou: false, lastUserAt: now, lastActivityAt: now } as ThreadViewModel) : t)))
    return json({})
  }
  if (rpc === "dispatch") {
    await wait(dispatchMs)
    const now = new Date().toISOString()
    // A fresh thread's own row: running, its title still the machine's guess (displayTitle draws the
    // "Spinning up a thread…" placeholder for it).
    // On the Console the row is the project's own thread, named by its key; the call still answers with
    // the bare slug, as the server does (api/rpc.ts keys it on the way back).
    setThreads((threads) => [...threads, makeThread(project ? threadKey(project, "started-thread") : "started-thread", "started-thread", 0, { titleAuto: true, runtime: "running", needsYou: false, spawnedAt: now, lastUserAt: now, lastAssistantAt: undefined, lastActivityAt: now } as Partial<ThreadViewModel>)])
    await wait(answerLagMs)
    return json({ slug: "started-thread", sessionId: "started-session" })
  }
  return json(null)
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })

// App's own row before the pane: the sticky rail beside the workpane, which only the first-run view fills.
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <MemoryRouter>
        <div className="relative min-h-screen bg-bg text-fg text-sm">
          <div className="flex min-h-screen justify-center gap-[clamp(28px,3.4vw,52px)] px-5 max-[800px]:flex-col max-[800px]:justify-start max-[800px]:gap-0 max-[800px]:px-3">
            {surface === "console" ? <ConsoleSidebar /> : surface === "first-run" ? null : <Sidebar />}
            <main id="workpane" className="w-[720px] max-w-[62vw] min-w-0 flex flex-col py-5 min-h-screen max-[800px]:w-full max-[800px]:max-w-none">
              {surface === "first-run" && <FirstTaskView />}
            </main>
          </div>
        </div>
      </MemoryRouter>
    </TooltipProvider>
  </QueryClientProvider>,
)
