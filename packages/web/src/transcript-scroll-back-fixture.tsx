import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import { ThreadView } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { mergeOptimistic, preserveMessageIdentity } from "./lib/transcript-sync.ts"
import { reconcileLiveMessages, type PaginatedTranscriptData } from "./lib/transcriptPagination.ts"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for SCROLLING BACK THROUGH A LONG THREAD: a running thread opens on its tail, holding the
// newest page of a history the server hands out one earlier page at a time, so a reader who wheels up
// reaches "Load earlier messages" again and again and a page lands under them while they are still moving.
// Rows vary from one line to several paragraphs, as a real thread's do, so every row above the reader
// mounts at an estimate and corrects.
//
// It does NOT boot a frizz server: the RPC calls the transcript makes are answered here, and
// `__scrollBack.append()` is the turn going on: one new message, pushed as the server's latest window
// through the same pipeline socket.ts runs a transcript push through. Until the first earlier page is in,
// a push replaces the window whole, so each append also slides one message off its head.
//   ?earlierDelay=400   how long an earlier page takes to arrive, in ms (default 0)
const params = new URLSearchParams(location.search)
const EARLIER_DELAY_MS = Number(params.get("earlierDelay") ?? 0)
const WINDOW = 60
const PAGE = 40
const HISTORY = WINDOW + 3 * PAGE
const SLUG = "scroll-back-demo"
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const T0 = Date.parse("2026-11-28T09:00:00.000Z")
const at = (i: number) => new Date(T0 + i * 1000).toISOString()
const prose = (n: number, label: string) =>
  Array.from({ length: n }, (_, i) =>
    `**${label} ¶${i + 1}.** Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.`,
  ).join("\n\n")
const message = (i: number): TranscriptMessage => {
  const role = i % 2 === 0 ? "user" : "assistant"
  const body = role === "user" ? `Ask ${i}: a short steer.` : prose(1 + (i % 5), `Reply ${i}`)
  return { sourceId: `m${i}`, role, text: body, at: at(i), tools: [], parts: [{ kind: "text", text: body }] } as unknown as TranscriptMessage
}
const all = Array.from({ length: HISTORY }, (_, i) => message(i))

// A cursor names the index the page it asks for ends before.
const page = (before: number) => {
  const from = Math.max(0, before - PAGE)
  return { messages: all.slice(from, before), transcriptKey: "fixture-key", beforeCursor: from > 0 ? `before:${from}` : null, hasEarlier: from > 0, reachedTurnBoundary: false }
}
const initialPage: PaginatedTranscriptData = {
  messages: all.slice(HISTORY - WINDOW),
  transcriptKey: "fixture-key",
  beforeCursor: `before:${HISTORY - WINDOW}`,
  hasEarlier: true,
  reachedTurnBoundary: false,
  historyLoaded: false,
}

// EXACTLY socket.ts `handle("transcript")`: the server's messages through reconcileLiveMessages, then the
// optimistic and identity-preserving pair, into the same query cache key.
function push(messages: TranscriptMessage[]) {
  queryClient.setQueryData(["transcript", SLUG], (prev: PaginatedTranscriptData | undefined) => {
    const reconciled = reconcileLiveMessages(prev, messages)
    return { ...reconciled, messages: preserveMessageIdentity(prev?.messages, mergeOptimistic(prev?.messages, reconciled.messages)) }
  })
}

let earlierPagesRequested = 0
let earlierPagesServed = 0
declare global {
  interface Window { __scrollBack: { earlierPagesRequested(): number; earlierPagesServed(): number; append(): void } }
}
window.__scrollBack = {
  earlierPagesRequested: () => earlierPagesRequested,
  earlierPagesServed: () => earlierPagesServed,
  append() {
    all.push(message(all.length))
    push(all.slice(-WINDOW))
  },
}

const json = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/_frizz/rpc/threadTranscript") return json(initialPage)
  if (url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    // A query carries its input in the URL, a mutation in the body (api/rpc.ts).
    const input = JSON.parse(url.searchParams.get("input") ?? (typeof init?.body === "string" ? init.body : "{}")) as { cursor?: string }
    const cursor = input.cursor ?? ""
    earlierPagesRequested++
    if (EARLIER_DELAY_MS > 0) await new Promise((resolve) => setTimeout(resolve, EARLIER_DELAY_MS))
    earlierPagesServed++
    return json(page(Number(cursor.replace("before:", "")) || 0))
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) return json(null)
  return originalFetch(input, init)
}

const thread = {
  id: SLUG,
  title: "Scroll-back demo",
  status: "running",
  statusText: "Working",
  mechanism: null,
  humanBlocked: false,
  needsYou: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "running",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  backend: "claude",
  permissionMode: "default",
  subAgents: [],
  bgShells: [],
  sessionId: "sess-scroll-back",
  lastUserAt: at(0),
  lastActivityAt: at(HISTORY),
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot
store.socketTranscripts = true

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <div className="mx-auto flex h-dvh w-full max-w-[900px] min-w-0 flex-col overflow-hidden border-x border-border bg-panel">
        <ThreadView slug={SLUG} showReturnToQueue />
      </div>
    </TooltipProvider>
  </QueryClientProvider>,
)
