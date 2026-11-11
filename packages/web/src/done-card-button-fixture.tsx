import { createRoot } from "react-dom/client"
import { useEffect, useState } from "react"
import type { AwaitingHint, BoardSnapshot, ThreadView } from "@frizz/shared"
import { FenceCard, ThreadSlugContext, Message } from "./components/ChatView.tsx"
import { setBoard } from "./store.ts"
import "./styles.css"

// Exercises the REAL FenceCard buttons against a seeded board + the ThreadSlugContext the transcript
// sets in production:
//   • the done card's white "Mark as done" button (completeThread; ?mode=executing → needsConfirmation
//     → the End-session dialog path)
//   • the awaiting card's "Snooze" park button, one per parkable kind — the kind picked the card TITLE
//     and the muted explainer beside the button (`timer:` → "Scheduled snooze" to the exact instant;
//     `pr-watch:` → "PR watcher armed"; `human:` → "Awaiting human"). Each applies a user snooze via
//     setThreadSnooze. Those three spellings are retired and no fence is parkable any more
//     (awaitingParkAction returns null), so this arm of the fixture now draws nothing.
// RPC is mocked like completion-lifecycle-fixture so nothing real is hit.
const mode = new URLSearchParams(window.location.search).get("mode") === "executing" ? "executing" : "resting"
const nativeFetch = window.fetch.bind(window)
const rpcResult = (result: unknown) => new Response(JSON.stringify({ result }), {
  headers: { "content-type": "application/json", "x-frizz-boot": "done-card-button-fixture" },
})

window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.toString(), window.location.origin)
  if (url.pathname === "/_frizz/rpc/completeThread") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { terminateLive?: boolean }
    window.dispatchEvent(new CustomEvent("fixture-rpc", { detail: { rpc: "completeThread", ...body } }))
    return rpcResult({ needsConfirmation: mode === "executing" && body.terminateLive !== true })
  }
  if (url.pathname === "/_frizz/rpc/setThreadSnooze") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { slug?: string; until?: string }
    window.dispatchEvent(new CustomEvent("fixture-rpc", { detail: { rpc: "setThreadSnooze", ...body } }))
    return rpcResult(null)
  }
  return nativeFetch(input, init)
}

const baseThread = (id: string, title: string, subAgents: ThreadView["subAgents"] = []): ThreadView => ({
  id,
  title,
  status: "active",
  mechanism: null,
  humanBlocked: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: mode === "executing" ? "running" : "turn-idle",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  subAgents,
  bgShells: [],
  watches: [], questions: [],
})

// A fixed future instant, kept so the timer card renders with a plausible value.
//
// IT NO LONGER RENDERS A "Confirm snooze" BUTTON, and neither does anything else. That control was armed
// by `isValidAwaitingTimer` — a symbol that has not existed since the 2026-08-15 grammar cut deleted the
// `timer: <instant>` kind — and the RPC behind it (`confirmAwaiting`) was deleted outright in `8e954d71`
// once it had spent nine days refusing every call it received. `awaitingParkAction` returns null for
// every fence, so this card draws prose and rows and no action at all. The fixture is kept because that
// IS the shape to look at; the sentence claiming a button was the only thing wrong with it.
const timerIso = new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString()

const cards: { slug: string; label: string; fence: "done" | "awaiting"; body: string; hints: AwaitingHint[] }[] = [
  { slug: "card-done", label: "done", fence: "done", body: "Shipped the change.", hints: [] },
  { slug: "card-timer", label: "timer snooze", fence: "awaiting", body: "Park until the checkpoint.", hints: [{ kind: "timer", value: timerIso }] },
  { slug: "card-review", label: "PR watch", fence: "awaiting", body: "The implementation is ready for review.", hints: [{ kind: "pr", value: "owner/repo#42" }] },
  { slug: "card-human", label: "human approval", fence: "awaiting", body: "The API shape needs approval.", hints: [{ kind: "shell", value: "Alice to approve the API shape" }] },
  { slug: "card-legacy", label: "legacy CI (no button)", fence: "awaiting", body: "The legacy build is still running.", hints: [{ kind: "shell", value: "owner/repo#7" }] },
]

// The MESSAGE path: a thread surface renders the fence through <Message> inside a ThreadSlugContext, so
// this reproduces how a done/awaiting card in a transcript reaches FenceCard (it was the queue card's
// path until the card went, 2026-11-10). Each renders a real assistant message whose text IS the fence block.
const queueCards: { slug: string; label: string; text: string }[] = [
  { slug: "queue-done", label: "done", text: "Shipped it.\n\n```done\nAll green.\n```" },
  { slug: "queue-timer", label: "timer snooze", text: "```awaiting\nPark until the checkpoint.\ntimer: " + timerIso + "\n```" },
]

// A thread with a LIVE sub-agent dispatch — proves that inside ThreadSlugContext an AgentBlock resolves
// its child and goes live (running header + drill-in).
const agentSlug = "queue-agent"
const agentId = "sub-live-1"
const agentThread = baseThread(agentSlug, "agent · live sub-agent", [
  { label: "Investigate the failing test", startedAt: new Date(Date.now() - 90_000).toISOString(), state: "running", subagentType: "frizz:opus-high", id: agentId },
])

const board: BoardSnapshot = {
  projectDir: "/tmp/fixture",
  projectName: "fixture",
  projectLabel: "fixture/fixture",
  threads: [...[...cards, ...queueCards].map((c) => baseThread(c.slug, c.label)), agentThread],
  errors: [],
  warnings: [],
}
setBoard(board)

function Fixture() {
  const [calls, setCalls] = useState<string[]>([])
  useEffect(() => {
    const onRpc = ((event: CustomEvent<{ rpc: string; until?: string; terminateLive?: boolean }>) => {
      const d = event.detail
      const detail = d.rpc === "setThreadSnooze" ? `setThreadSnooze(until=${d.until})` : `completeThread(terminateLive=${d.terminateLive})`
      setCalls((prior) => [...prior, detail])
    }) as EventListener
    window.addEventListener("fixture-rpc", onRpc)
    return () => window.removeEventListener("fixture-rpc", onRpc)
  }, [])
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-5 px-4 py-8">
      <p className="petite-caps text-[10px] text-accent">FenceCard buttons ({mode})</p>
      {cards.map((c) => (
        <div key={c.slug} className="flex flex-col gap-1.5">
          <p className="text-[11px] text-muted">{c.label}</p>
          <ThreadSlugContext.Provider value={c.slug}>
            <FenceCard fenceKind={c.fence} body={c.body} hints={c.hints} />
          </ThreadSlugContext.Provider>
        </div>
      ))}
      <p className="petite-caps mt-4 text-[10px] text-accent">Message path — Message inside ThreadSlugContext</p>
      {queueCards.map((c) => (
        <div key={c.slug} data-message-fixture={c.slug} className="flex flex-col gap-1.5 rounded-lg border border-border bg-panel p-3">
          <p className="text-[11px] text-muted">{c.label}</p>
          <ThreadSlugContext.Provider value={c.slug}>
            <Message m={{ role: "assistant", text: c.text, tools: [], parts: [{ kind: "text", text: c.text }] }} />
          </ThreadSlugContext.Provider>
        </div>
      ))}
      {/* B (maintainer 2026-07-15): sub-agent blocks go live via ThreadSlugContext. This proves an
          AgentBlock resolves its running child + offers drill-in. */}
      <div data-message-fixture={agentSlug} className="flex flex-col gap-1.5 rounded-lg border border-border bg-panel p-3">
        <p className="text-[11px] text-muted">agent · live sub-agent (drill-in)</p>
        <ThreadSlugContext.Provider value={agentSlug}>
          <Message
            m={{
              role: "assistant",
              text: "",
              tools: [],
              parts: [{ kind: "tools", tools: [{ name: "Agent", detail: "Investigate the failing test", prompt: "Go investigate the failing test and report back.", subagentType: "frizz:opus-high", agentId, status: "pending" }] }],
            }}
          />
        </ThreadSlugContext.Provider>
      </div>
      <p data-fixture-rpc-calls className="text-[11px] text-muted">RPC calls: {calls.join(" | ") || "none"}</p>
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
