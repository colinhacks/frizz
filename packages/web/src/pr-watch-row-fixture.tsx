import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import { AwaitingWaitTable } from "./components/AwaitingBackgroundCard.tsx"
import { TodosView } from "./components/TodosView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the WATCHER ROW'S COUNTER in the ops strip under the prompt box (2026-09-04). The row
// said a ref and an age and nothing else, so a thread that was WORKING showed nothing about a PR it was
// watching — the card that renders the full check reading is only drawn at rest.
//
// THE APP RENDERS IN TWO FONTS and a fixture that does not set `data-font` silently gets the mono
// default, so every reading here is taken twice. `?font=sans` picks the other one.
document.documentElement.dataset.font = new URLSearchParams(location.search).get("font") === "sans" ? "sans" : "mono"

const SLUG = "pr-watch-row-demo"

const messages: TranscriptMessage[] = [
  { role: "user", text: "Open the two PRs and watch them.", tools: [], parts: [{ kind: "text", text: "Open the two PRs and watch them." }] },
  {
    role: "assistant",
    text: "Both are open and watched; I'm measuring the third variant while they build.",
    tools: [],
    parts: [{ kind: "text", text: "Both are open and watched; I'm measuring the third variant while they build." }],
  },
]

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const status = (over: Record<string, unknown>) => ({
  checks: "running", running: 0, passed: 0, failed: 0, skipped: 0, gated: 0, gating: [], failing: [],
  merge: "unknown", state: "open", polledAt: new Date().toISOString(), ...over,
})

const thread = {
  id: SLUG,
  title: "PR watcher row",
  status: "active",
  mechanism: null,
  humanBlocked: false,
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
  // One shell, so the counter column can be read against the reading it was matched to.
  bgShells: [{ id: "shell-a", label: "Build the baseline on the Linux box", startedAt: "2026-09-04T16:14:00.000Z", state: "running" }],
  // Every state the counter can take, top to bottom in its own severity order.
  watches: [
    { id: "w1", kind: "github", target: "nodejs/node#65796", state: "armed", createdAt: "2026-09-04T15:12:00.000Z",
      github: status({ checks: "failing", failed: 1, passed: 31, running: 2, failing: ["x86_64-darwin: with shared libraries / build"], merge: "blocked" }) },
    { id: "w2", kind: "github", target: "nodejs/node#65795", state: "armed", createdAt: "2026-09-04T15:12:00.000Z",
      github: status({ checks: "running", gated: 9, gating: ["Test Linux", "Test macOS"], passed: 3, skipped: 12, merge: "blocked" }) },
    { id: "w3", kind: "github", target: "colinhacks/zod#6559", state: "armed", createdAt: "2026-09-04T14:02:00.000Z",
      github: status({ checks: "running", running: 14, passed: 15 }) },
    { id: "w4", kind: "github", target: "nubjs/nub#874", state: "armed", createdAt: "2026-09-04T13:31:00.000Z",
      github: status({ checks: "passing", passed: 29, skipped: 1, merge: "mergeable" }) },
    // The reading is old (2026-11-06): polling failed or was deferred, so this verdict is 12m of nobody
    // checking, and a 3h one past that. Neither may be drawn as live.
    { id: "w6", kind: "github", target: "acme/app#393", state: "armed", createdAt: "2026-09-04T13:31:00.000Z",
      github: status({ checks: "failing", failed: 1, passed: 28, failing: ["lint"], merge: "blocked", head: "abc1234def5678", polledAt: ago(12) }) },
    { id: "w7", kind: "github", target: "acme/app#394", state: "armed", createdAt: "2026-09-04T13:31:00.000Z",
      github: status({ checks: "passing", passed: 29, merge: "mergeable", head: "abc1234def5678", polledAt: ago(180) }) },
    // The head just moved and CI has reported nothing on the new commit: not "No checks".
    { id: "w8", kind: "github", target: "acme/app#395", state: "armed", createdAt: "2026-09-04T13:31:00.000Z",
      github: status({ head: "def5678abc1234", newHeadSince: ago(1) }) },
    // Never polled: the row must say nothing rather than a fabricated zero.
    { id: "w5", kind: "github", target: "microsoft/TypeScript#64172", state: "armed", createdAt: "2026-09-04T16:43:00.000Z" },
  ],
  lastActivityAt: "2026-09-04T16:44:00.000Z",
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot

const transcriptPage = { messages, transcriptKey: "fixture-key", hasEarlier: false, historyLoaded: false }

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/_frizz/rpc/threadTranscript" || url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    return new Response(JSON.stringify({ result: transcriptPage }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

function Fixture() {
  return (
    <div className="mx-auto w-[min(680px,calc(100%-32px))] py-8">
      <TodosView />
      {/* The other way a row is drawn: the wait table the resting card and the focus rail share. */}
      <div data-fixture-wait-table className="mt-6 rounded-lg border border-border bg-surface p-2">
        <AwaitingWaitTable thread={thread} divider={false} />
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
