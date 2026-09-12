import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import { BackgroundOpsStrip } from "./components/ChatView.tsx"
import { ThreadActionBar } from "./components/ThreadActionBar.tsx"
import { TodosView } from "./components/TodosView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for THE STANDARD PROMPT BOX (components/ThreadComposerBox.tsx) — the block both the queue
// cue card and the thread drawer render. Two things are proven here, both of which used to differ
// between the surfaces:
//
//   D7 — `/login` and `/logout` are FRIZZ-OWNED aliases. They must open the sign-in / sign-out modal and
//        must NEVER be delivered to the worker's stdin. Before the box was shared this only worked in
//        the drawer; the queue card injected the literal "/login" string into the running agent.
//   D8 — an ordinary follow-up still reaches the worker from BOTH surfaces (and, on the queue card,
//        still dissolves the card optimistically).
//
// The REAL TodosView / QueueCard / ThreadActionBar / ThreadComposerBox render; only the network is
// stubbed. Every followUp the app attempts is recorded on window.__worker.sent — that array IS the
// worker's stdin as far as this fixture is concerned, so "the alias never reached the worker" is a
// direct assertion, not an inference.
//
//   ?surface=queue  (default)  — just the cue card
//   ?surface=drawer            — just the drawer footer (ThreadActionBar)
//   ?surface=both              — both, side by side (the comparison screenshot)
//   ?answerable=1              — the agent's last message carries a ```question block, so the card also
//                                shows its "Send answers" action above the box (layout check)

const SLUG = "alias-thread"
const params = new URLSearchParams(location.search)
const SURFACE = params.get("surface") ?? "queue"
const ANSWERABLE = params.get("answerable") === "1"

const thread = {
  id: SLUG,
  title: "Rotate the signing key without downtime",
  status: "needs-human",
  statusText: "Waiting on your call",
  mechanism: null,
  humanBlocked: true,
  needsYou: true,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "turn-idle",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  backend: "claude",
  permissionMode: "default",
  state: "open",
  sessionId: "sess-alias-1",
  subAgents: [],
  bgShells: [],
  lastFence: null,
  lastActivityAt: new Date().toISOString(),
  lastAssistantAt: new Date().toISOString(),
  spawnedAt: new Date().toISOString(),
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot

const ASK = [
  "I can rotate the key in place or stage a second key first.",
  "",
  "```question",
  "Which rollout do you want?",
  "- Rotate in place",
  "- Stage a second key",
  "```",
].join("\n")
const PLAIN = "Standing by — tell me which rollout you want and I'll start."
const body = ANSWERABLE ? ASK : PLAIN

const messages: TranscriptMessage[] = [
  { sourceId: `${SLUG}-u1`, role: "user", text: "Rotate the signing key without downtime.", tools: [], parts: [] },
  { sourceId: `${SLUG}-a1`, role: "assistant", text: body, tools: [], parts: [{ kind: "text", text: body }] },
]

// Every message the UI tried to deliver to the worker, in order. An alias that leaks past the composer
// intercept shows up here — which is exactly the D7 regression.
interface WorkerTelemetry { sent: string[]; rpc: string[] }
const worker: WorkerTelemetry = { sent: [], rpc: [] }
;(window as unknown as { __worker: WorkerTelemetry }).__worker = worker

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (!url.pathname.startsWith("/_frizz/rpc/")) return originalFetch(input, init)
  worker.rpc.push(url.pathname.slice("/_frizz/rpc/".length))
  if (url.pathname === "/_frizz/rpc/threadTranscript" || url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    return new Response(
      JSON.stringify({ result: { messages, transcriptKey: `${SLUG}-key`, hasEarlier: false, historyLoaded: false } }),
      { headers: { "content-type": "application/json" } },
    )
  }
  if (url.pathname === "/_frizz/rpc/followUp") {
    try {
      const parsed = typeof init?.body === "string" ? (JSON.parse(init.body) as { message?: string }) : null
      worker.sent.push(parsed?.message ?? "")
    } catch {
      worker.sent.push("<unparseable>")
    }
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
}

function QueueSurface() {
  return (
    <main data-fixture-queue className="w-[720px] max-w-full min-w-0 flex flex-col py-5">
      <TodosView />
    </main>
  )
}

// The drawer's real footer arrangement (ChatView renders exactly this pair): the chat footer frame,
// with ThreadActionBar inside it and the background-ops strip passed as its `ops`.
function DrawerSurface() {
  return (
    <div data-fixture-drawer className="my-5 flex h-[420px] w-[560px] max-w-full min-w-0 flex-col rounded-lg border border-border bg-panel">
      <div className="min-h-0 flex-1 overflow-y-auto p-4 text-[13px] leading-relaxed text-muted">
        {messages.map((m) => (
          <p key={m.sourceId} className="mb-3 whitespace-pre-wrap">
            <span className="petite-caps mr-2 text-[11px] text-muted-60">{m.role}</span>
            {m.text}
          </p>
        ))}
      </div>
      <div data-thread-chat-footer className="z-10 shrink-0 border-t border-border/60 bg-panel">
        <ThreadActionBar slug={SLUG} ops={<BackgroundOpsStrip slug={SLUG} className="px-1 pt-1.5" />} />
      </div>
    </div>
  )
}

function Fixture() {
  return (
    <div className="relative min-h-screen bg-bg text-fg text-sm">
      <div className="flex min-h-screen justify-center gap-6 px-4">
        {SURFACE !== "drawer" && <QueueSurface />}
        {SURFACE !== "queue" && <DrawerSurface />}
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
