import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel } from "@frizz/shared"
import { BackgroundOpsStrip } from "./components/ChatView.tsx"
import { ThreadLifecycleFooter } from "./components/ThreadLifecycleFooter.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for HOW MANY PLACES ONE BACKGROUND SHELL IS DESCRIBED IN. It used to be two: a row under
// the prompt box, and a line in the footer eye's menu naming the same shell by a runtime handle that
// appears nowhere else — which read as two unrelated things ("shells are not watchers… I don't see
// either of them as background shells underneath the prompt box", then "we do not need to redundantly
// list out background shells inside of the watcher icon menu", maintainer 2026-08-14).
//
// It is now ONE: the shell's own row, blue dot and all. So this surface renders the strip AND the footer
// together, because the property under test is what the two say about the same shell at the same time.
//
// `?case=` picks the state. `?font=sans|mono` sets `data-font`, because this app renders in two type
// stacks and a line that fits on one can wrap on the other.

const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = params.get("font") === "sans" ? "sans" : "mono"

const SHELL = { id: "toolu_01MkxJgNuEsDomuqLTFqzzjU", taskId: "bzvtnt3ig", label: "Running a larger spot-check batch", startedAt: "2026-08-14T15:29:23.952Z", state: "running" as const, stoppable: true }
// Relative to the REAL clock, so the readout draws the same elapsed strings the maintainer's screenshot
// did (`since 34 min ago`) rather than an ever-growing distance from a frozen anchor.
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()

const CASES: Record<string, { watches: ThreadViewModel["watches"]; bgShells: ThreadViewModel["bgShells"] }> = {
  // THE SHIPPED SHAPE: a watched background shell. One row, one blue dot, and NO eye in the footer —
  // the watcher is a property of that row, stated in its tooltip, not a second listing.
  watched: {
    watches: [{ id: "wch_1", kind: "shell", target: "bzvtnt3ig", state: "armed", createdAt: ago(34) }],
    bgShells: [SHELL],
  },
  // THE CONTROL: the identical shell with no watcher armed. The row must be indistinguishable, so that
  // the marker above is genuinely the exception rather than a new reading every row carries.
  unwatched: { watches: [], bgShells: [SHELL] },
  // A PR watcher DOES keep its eye line: it has no row of its own in this footer, so this menu is the
  // only place it can be said.
  pr: {
    watches: [{ id: "github:t:colinhacks/zod#6382", kind: "github", target: "colinhacks/zod#6382", state: "armed", createdAt: ago(120) }],
    bgShells: [SHELL],
  },
}

const active = CASES[params.get("case") ?? "watched"] ?? CASES.watched

const SLUG = "watch-readout-demo"

const thread = {
  id: SLUG,
  title: "Watch readout",
  status: "active",
  kind: "session",
  foreign: false,
  backend: "claude",
  permissionMode: "default",
  runtime: "idle",
  archived: false,
  state: "open",
  subAgents: [],
  pendingQuestion: false,
  needsYou: true,
  context: { tokens: 348_950, window: 1_000_000 },
  lastActivityAt: "2026-08-14T16:04:00.000Z",
  ...active,
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

function Fixture() {
  return (
    <div className="mx-auto w-[min(680px,calc(100%-32px))] py-8">
      {/* The footer is normally the bottom edge of a card, so give it one: the tooltip opens upward and
          needs somewhere to land, and the strip's own corner radius only reads against a border. */}
      <div className="overflow-hidden rounded-lg border border-border bg-panel">
        <div className="h-32 p-4 text-[12px] text-muted">…transcript…</div>
        <div className="mx-3 rounded-md border border-border/70 px-3 py-2 text-[12px] text-muted-50">…prompt box…</div>
        <BackgroundOpsStrip slug={SLUG} />
        <ThreadLifecycleFooter thread={thread} />
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
