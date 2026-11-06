import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { MemoryRouter } from "react-router"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { Sidebar } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the BAND a declared park lands in, over the REAL <Sidebar/> and the real
// sectionThreads — which is what snoozed-rows-fixture cannot show, since that one hands SectionHeader and
// ThreadRow their rows already sorted. Every row here carries `awaitingBackground: true` the way
// board.ts sets it on a parked ```awaiting fence, because that flag is the whole bug: hasLiveOps read it
// as "its own dispatched work is still live", which stopped being what it means when a timer park
// started setting it (2026-08-24, f50f9e60). The timer row banded ACTIVE, which is the band for a thread
// with something in flight (maintainer 2026-08-26: "showing up in a separate rail that isn't held").
//
//   RESTED (the queue — one row per card)
//     D  QUEUED wait on a registered timer     → hourglass   (2026-09-07; wore the blue dot)
//   HELD (dimmed, labeled — the park band)
//     A  armed future timer, nothing else out   → hourglass   (THE CHANGE; was in Active)
//   ACTIVE (no queue card, something in flight)
//     B  live background shell behind the fence → blue dot    (unchanged — own work is never dimmed)
//     C  registered PR watcher, CI green        → octocat     (unchanged — a handoff must stay visible)
//
// A is the row that MOVED. B and C are the two OTHER parks the same flag describes, and they are the
// controls: the carve-out is `parkedOnArmedTimerAlone`, so anything else behind the fence keeps the row
// out of Snoozed exactly as before.
//
// D joined on 2026-09-07 and is the row the maintainer actually sees most: a timer park QUEUES
// (board.deriveNeedsYou keeps it a visible handoff), so it sits in the cue with a card behind it, and
// there it wore the pulsing dot — groups.restingOnLiveBackgroundWork counted an armed timer as motion
// ("an item in the queue that's awaiting a timer should show up with the hourglass icon in the sidebar,
// not with the flashing blue dot"). No fence on D, deliberately: `frizzctl timer` then a bare rest
// is the shape the worker contract steers toward, and the one with nothing but the registered row to read.

// The timer's own instant is computed at load so the wake always sits in the future.
const fireAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()

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
  subAgents: [],
  bgShells: [],
  needsYou: false,
  awaitingBackground: true,
  runtime: "turn-idle",
  spawnedAt: "2026-08-25T22:06:58.413Z",
} as const

// A — the reported row: an ```awaiting fence naming a timer that really is armed, and nothing else.
const timerPark = {
  ...base,
  id: "close-the-august-numbers",
  title: "Close the August numbers",
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000001",
  lastFence: {
    kind: "awaiting",
    body: "Seven commits on the branch, lint and typecheck clean. The timer fires next week for the closed-August report.",
    hints: [{ kind: "timer", value: "tmr_0028d7f6c28d" }, { kind: "for", value: "7d" }],
  },
  watches: [{
    id: "timer:close-the-august-numbers:tmr_0028d7f6c28d",
    kind: "timer", target: "tmr_0028d7f6c28d", state: "armed",
    createdAt: "2026-08-25T22:33:31.777Z",
    timer: { fireAt, prompt: "August is closed — generate the investor update and hand it over." },
  }],
  lastActivityAt: "2026-08-26T00:20:14.894Z",
  lastUserAt: "2026-08-26T00:19:45.772Z",
} as unknown as ThreadView

// B — CONTROL: the same fence shape parked on a background SHELL that is still running. Own live work
// is never dimmed (maintainer 2026-07-10), so this stays in Active wearing the pulsing dot.
const shellPark = {
  ...base,
  id: "port-the-v2-drivers",
  title: "Port the v2 drivers",
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000002",
  lastFence: {
    kind: "awaiting",
    body: "Waiting on the three-platform run before porting the drivers.",
    hints: [{ kind: "shell", value: "bzvtnt3ig" }, { kind: "for", value: "2h" }],
  },
  bgShells: [{ label: "nub run test --platforms", startedAt: "2026-08-26T00:10:00.000Z", state: "running" }],
  lastActivityAt: "2026-08-26T00:18:00.000Z",
  lastUserAt: "2026-08-26T00:05:00.000Z",
} as unknown as ThreadView

// C — CONTROL: a registered PR watcher whose CI has already gone green. Settled, so no dot — but a PR
// whose reviews may never arrive must not silently vanish into the dimmed band (maintainer 2026-07-22).
const prPark = {
  ...base,
  id: "fix-the-cache-collision",
  title: "Fix the cache collision",
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000003",
  lastFence: {
    kind: "awaiting",
    body: "Ten checks green, no conflicts. Waiting on your merge.",
    hints: [{ kind: "pr", value: "acme/app#391" }, { kind: "for", value: "6h" }],
  },
  watches: [{
    id: "github:fix-the-cache-collision:acme/app#391",
    kind: "github", target: "acme/app#391", state: "armed",
    createdAt: "2026-08-26T00:00:00.000Z",
    github: {
      checks: "passing", running: 0, passed: 10, failed: 0, failing: [],
      merge: "mergeable", state: "open", polledAt: new Date().toISOString(),
    },
  }],
  lastActivityAt: "2026-08-26T00:15:00.000Z",
  lastUserAt: "2026-08-26T00:01:00.000Z",
} as unknown as ThreadView

// D — THE REPORTED ROW: queued, at rest on a timer the worker registered and never fenced. The server
// states the wait (awaitingBackground) and queues the handoff (needsYou), so the row belongs in the cue.
const queuedTimer = {
  ...base,
  id: "re-check-the-deploy",
  title: "Re-check the deploy",
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000004",
  needsYou: true,
  watches: [{
    id: "timer:re-check-the-deploy:tmr_5d1e9c0a7b3f",
    kind: "timer", target: "tmr_5d1e9c0a7b3f", state: "armed",
    createdAt: "2026-09-07T09:00:00.000Z",
    timer: { fireAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), prompt: "Re-check the deploy and report." },
  }],
  lastActivityAt: "2026-09-07T09:05:00.000Z",
  lastUserAt: "2026-09-07T08:59:00.000Z",
} as unknown as ThreadView

store.board = {
  projectDir: "/fixture/frizz",
  threads: [timerPark, shellPark, prPark, queuedTimer],
} as unknown as BoardSnapshot
store.drawers = []

// The rail's composer and its pickers read the ordinary RPC surface; answer everything with the empty
// success envelope so nothing real is hit and no request can fail the render.
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
      {/* The rail's StatusRow reads the router (project-scoped links), and rendering it outside a router
          context throws on render — which blanked this page silently from the day StatusRow took a
          router hook until 2026-09-07. A MemoryRouter gives it the same context without an address bar. */}
      <MemoryRouter>
        <div className="flex min-h-screen bg-bg text-fg">
          <Sidebar />
        </div>
      </MemoryRouter>
    </TooltipProvider>
  </QueryClientProvider>,
)
