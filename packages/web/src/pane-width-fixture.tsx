import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import type { BoardSnapshot, CodexModel, DispatchPreferences, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import { Sidebar } from "./components/Sidebar.tsx"
import { PaneLayout } from "./components/ThreadPane.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { isThreadWidth, prefs } from "./lib/prefs.ts"
import { paneProto } from "./lib/threadPane.ts"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for THE THREAD WIDTH SETTING (lib/fullLayout.ts THREAD_WIDTH_PX): the real <PaneLayout/> with
// the real <Sidebar/> over four queued threads, the first open, with a background shell and edited files so
// its artifact rail stands beside it. Adapted from the fixture in colinhacks/frizz#77, which let the thread
// fill the row; the maintainer kept a cap instead and made it a setting (2026-11-18).
//
//   · `?width=standard|wide|widest` is the setting (Standard when absent);
//   · `?folded=1` is full screen, the sidebar put away;
//   · `?file=1` opens a file beside the thread, as a click in the rail's Edited files does.

const CARDS = [
  { id: "auth-refresh", title: "Silent token refresh on 401" },
  { id: "csv-export", title: "Streaming CSV export for large tables" },
  { id: "flaky-e2e", title: "Flaky checkout e2e in CI" },
  { id: "rate-limits", title: "Per-tenant rate limits on the public API" },
]

const reply = (n: number) =>
  Array.from({ length: 4 }, (_, i) => `**Step ${i + 1}.** Thread ${n}: agent output at a realistic length, long enough that a line wraps at the thread's narrowest measure and runs on at its widest, so the width the column takes is plain to see.`).join("\n\n")

const T0 = Date.now() - 600_000
function makeThread(id: string, title: string, n: number, over: Partial<ThreadViewModel> = {}): ThreadViewModel {
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

const params = new URL(window.location.href).searchParams
const width = params.get("width")
prefs.threadWidth = isThreadWidth(width) ? width : "standard"
paneProto.folded = params.get("folded") === "1"

const FILE = "src/auth/refresh.ts"
const shell = { id: "toolu_shell1", taskId: "b7w140a81", label: "Sampling request latency every minute for an hour", startedAt: new Date(T0).toISOString(), state: "running" }
store.board = {
  projectDir: "/fixture/acme",
  threads: CARDS.map((c, i) => makeThread(c.id, c.title, i, i === 0 ? ({ bgShells: [shell] } as unknown as Partial<ThreadViewModel>) : {})),
} as BoardSnapshot
store.drawers = []
store.paneSlug = CARDS[0].id
if (params.get("file") === "1") store.filePanels = [{ id: 1, path: `/fixture/acme/${FILE}` }]

function transcriptFor(slug: string) {
  const n = Math.max(0, CARDS.findIndex((c) => c.id === slug))
  const card = CARDS[n]
  const messages: TranscriptMessage[] = [
    { sourceId: `${slug}-u1`, role: "user", text: `Please handle: ${card.title}.`, tools: [], parts: [] },
    { sourceId: `${slug}-a1`, role: "assistant", text: reply(n + 1), tools: [], parts: [{ kind: "text", text: reply(n + 1) }] },
  ]
  const editedFiles = [FILE, "src/auth/refresh.test.ts", "src/http/client.ts"].map((path, i) => ({ path, edits: i + 1, added: 12 * (i + 1), removed: 3 * i }))
  return { messages, transcriptKey: `${slug}-key`, hasEarlier: false, historyLoaded: false, editedFiles }
}

const codexModels: CodexModel[] = [{ slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultEffort: "medium", efforts: ["low", "medium", "high"] }]
const preferences: DispatchPreferences = { backend: "codex", claude: { permissionMode: "auto" }, codex: { model: "gpt-5.6-sol", effort: "medium", permissionMode: "default" } }
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

const source = Array.from({ length: 40 }, (_, i) => `export const step${i} = await refreshTokenOnce({ attempt: ${i}, backoffMs: 2 ** ${i} * 100, reason: "401 from the API gateway" })`).join("\n")

const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.origin)
  const rpc = /^\/_frizz\/(?:[\w-]+\/)?rpc\/(\w+)/.exec(url.pathname)?.[1]
  if (!rpc) return nativeFetch(input, init)
  if (rpc === "projectsList") return json([])
  if (rpc === "dispatchPreferencesGet") return json(preferences)
  if (rpc === "codexModels") return json(codexModels)
  if (rpc === "acpAgents") return json([])
  if (rpc === "settingsGet") return json({ permissionMode: "bypassPermissions", notifications: true, autoCompactWindow: 500000, promptCacheTtl: "auto" })
  if (rpc === "threadTranscript" || rpc === "threadTranscriptEarlier") return json(transcriptFor(slugOf(url, init) ?? CARDS[0].id))
  if (rpc === "threadSettledQuestions") return json({ questions: [] })
  if (rpc === "localFile") return json({ path: `/fixture/acme/${FILE}`, text: source, truncated: false, binary: false, modifiedAt: T0 })
  return json(null)
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <MemoryRouter>
        <div className="relative min-h-screen bg-bg text-fg text-sm">
          <PaneLayout sidebar={<Sidebar />} />
        </div>
      </MemoryRouter>
    </TooltipProvider>
  </QueryClientProvider>,
)
