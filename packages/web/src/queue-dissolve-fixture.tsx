import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import { TodosView } from "./components/TodosView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { sendEagerFollowUp } from "./lib/eagerComposerSubmission.ts"
import { store } from "./store.ts"
import "./styles.css"

const queryClient = new QueryClient()

// Browser QA for the DISSOLVE-in-place queue-card collapse + the dismissal auto-scroll: resolving a card
// (Mark as done, or answering its question chips) dissolves it with blur+scale (receding from centre);
// at the unmount, a USER-INITIATED dismissal auto-scrolls the next card (successor, else predecessor) to
// the viewport-top landing (maintainer 2026-07-21: "some card should be at the top of the screen after
// any action that dismisses a card"), while a pure board departure only holds a visible neighbour in place.
//   Four tall needs-human cards (each ending in a live ```question ask) so the page scrolls and both the
//   answer path and the mark-done path can be driven; the divider between cards collapses with the card.

const longReply = (n: number) =>
  Array.from({ length: 6 }, (_, i) =>
    `**Step ${i + 1}.** Card ${n}: agent output, realistic triage-card length. The page scrolls across the four cards so a mid-queue resolve has room above it. Lorem ipsum dolor sit amet.`,
  ).join("\n\n") +
  // A live trailing ask so each card carries answer chips — the answer path is a dismissal too and must
  // drive the same auto-scroll as Mark-as-done.
  "\n\n```question\nShip this now or wait for review?\n\n- A. Ship now (recommended: low risk)\n- B. Wait for review\n```"

const CARDS = [
  { id: "auth-refresh", title: "Silent token refresh on 401" },
  { id: "csv-export", title: "Streaming CSV export for large tables" },
  { id: "flaky-e2e", title: "Flaky checkout e2e in CI" },
  { id: "dark-mode", title: "Persist theme preference across devices" },
]

function makeThread(id: string, title: string): ThreadViewModel {
  return {
    id,
    title,
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
    runtime: "idle",
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
    lastActivityAt: new Date().toISOString(),
    spawnedAt: new Date().toISOString(),
  } as unknown as ThreadViewModel
}

const threads = CARDS.map((c) => makeThread(c.id, c.title))
store.board = { projectDir: "/fixture/frizz", threads } as BoardSnapshot

function transcriptFor(slug: string, title: string): { messages: TranscriptMessage[]; transcriptKey: string; hasEarlier: boolean; historyLoaded: boolean } {
  const n = CARDS.findIndex((c) => c.id === slug) + 1
  const messages: TranscriptMessage[] = [
    { sourceId: `${slug}-u1`, role: "user", text: `Please handle: ${title}.`, tools: [], parts: [] },
    { sourceId: `${slug}-a1`, role: "assistant", text: longReply(n), tools: [], parts: [{ kind: "text", text: longReply(n) }] },
  ]
  return { messages, transcriptKey: `${slug}-key`, hasEarlier: false, historyLoaded: false }
}

// Pull the slug out of an RPC request body so each card gets its own transcript.
function slugFromBody(init?: RequestInit): string | null {
  try {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null
    return body?.slug ?? body?.params?.slug ?? null
  } catch {
    return null
  }
}

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/_frizz/rpc/threadTranscript" || url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    const slug = slugFromBody(init) ?? CARDS[0].id
    const card = CARDS.find((c) => c.id === slug) ?? CARDS[0]
    return new Response(JSON.stringify({ result: transcriptFor(card.id, card.title) }), { headers: { "content-type": "application/json" } })
  }
  // Mark-as-done goes through completeThread; it must return a non-null object (needsConfirmation:false)
  // so the footer fires onArchived → onResolve → the card dissolves. FAITHFUL to production: the server's
  // handler calls ctx.board.refresh() SYNCHRONOUSLY (board.ts publish()), so the resolved thread is
  // dropped from the board at essentially the same instant the RPC returns. We model that here by pruning
  // the thread from store.board — the card must STILL dissolve fully even though the board drops it (the
  // exit is decoupled from the board push in TodosView). Without that decoupling the card unmounts
  // instantly and no animation plays.
  if (url.pathname === "/_frizz/rpc/completeThread") {
    const slug = slugFromBody(init)
    if (slug && store.board) {
      store.board = { ...store.board, threads: store.board.threads.filter((t) => t.id !== slug) } as BoardSnapshot
    }
    return new Response(JSON.stringify({ result: { needsConfirmation: false } }), { headers: { "content-type": "application/json" } })
  }
  // A reply (answering the card's question) clears the queue in production once the agent's turn
  // starts; model that by pruning the thread so the resolve() 8s guard never reappears the card.
  if (url.pathname === "/_frizz/rpc/followUp") {
    const slug = slugFromBody(init)
    if (slug && !lagBoard.has(slug) && store.board) {
      store.board = { ...store.board, threads: store.board.threads.filter((t) => t.id !== slug) } as BoardSnapshot
    }
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

// Slugs whose board is deliberately made to LAG behind the send (see __steerFromElsewhere). A card the
// operator steers from its own composer is dismissed optimistically and gone in 200ms; a send that does
// NOT dismiss leaves the card sitting in the queue until the server reports the turn, which is the
// seconds-long window the transcript writes used to reshape it in.
const lagBoard = new Set<string>()

// QA hook: a send that does NOT dismiss this card — Retry and Restart worker, both in the card's own
// header, plus the rail's hover Retry. All three go through sendEagerFollowUp in production, so this
// drives the real path rather than a stand-in for it; going through the function rather than a button
// keeps the fixture from pinning which header carries the verb.
;(window as unknown as { __steerFromElsewhere: (slug: string, text: string) => void }).__steerFromElsewhere = (slug, text) => {
  lagBoard.add(slug)
  sendEagerFollowUp(queryClient, slug, text)
}

// …and the write that actually re-cut the card's window: the worker's own echo of that message, arriving
// over /ws as a LANDED (un-`queued`) user record. api/transcript-live.ts publishes the push into this
// same ["transcript", slug] cache entry, so writing it here is what the socket does.
;(window as unknown as { __pushLandedTurn: (slug: string, text: string) => void }).__pushLandedTurn = (slug, text) => {
  queryClient.setQueryData<ReturnType<typeof transcriptFor>>(["transcript", slug], (prev) => {
    const card = CARDS.find((c) => c.id === slug) ?? CARDS[0]
    const base = prev ?? transcriptFor(card.id, card.title)
    return {
      ...base,
      messages: [
        ...base.messages.filter((m) => !(m as TranscriptMessage & { queued?: boolean }).queued),
        { sourceId: `${slug}-landed`, role: "user", text, tools: [], parts: [] } as TranscriptMessage,
      ],
    }
  })
}

// QA hook: prune a thread from the board WITHOUT any user action on the card — a pure board
// departure (an agent/another client resolved it), which must take the hold-in-place pin path,
// never the user-dismissal auto-scroll.
;(window as unknown as { __pruneThread: (slug: string) => void }).__pruneThread = (slug) => {
  if (store.board) store.board = { ...store.board, threads: store.board.threads.filter((t) => t.id !== slug) } as BoardSnapshot
}

// Mirror App's <main> so page-scroll + my-auto centering behave exactly as production.
function Fixture() {
  return (
    <div className="relative min-h-screen bg-bg text-fg text-sm">
      <div className="flex min-h-screen justify-center">
        <main className="w-[720px] max-w-[62vw] min-w-0 flex flex-col py-5 min-h-screen max-[800px]:w-full max-[800px]:max-w-none">
          <TodosView />
        </main>
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </QueryClientProvider>,
)
