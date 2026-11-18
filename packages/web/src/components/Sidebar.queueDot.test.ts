import assert from "node:assert/strict"
import test from "node:test"
import { createElement, createRef } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { PinnedBand, ThreadRow } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"
import { queuedOnShelf } from "../lib/consoleBoard.ts"
import { unreadRest } from "../groups.ts"

// THE QUEUE DOT (maintainer 2026-11-17: "we need an indicator when a thread that's in the queue is awaiting
// human attention. Probably just a yellow dot"). A queued row in the Queue band needs none, the band being
// its label; a queued row on a Pinned shelf, which mixes queued threads with ones that are not, wears it.
// A pinned plain report is not queued (2026-11-06) and stays unmarked (2026-11-09). Opening the thread
// clears it, and the open row never draws it: "you should never see the dot and the sort of left yellow
// border at the same time".

const base = {
  kind: "session",
  backend: "claude",
  title: "A thread",
  status: "active",
  state: "open",
  runtime: "turn-idle",
  subAgents: [],
} as unknown as ThreadView

const PIN = "2026-11-17T10:00:00.000Z"
const RESTED = "2026-11-17T11:00:00.000Z"
const ask = { ...base, id: "ask", needsYou: true, pendingQuestion: true, pinnedAt: PIN, lastAssistantAt: RESTED } as ThreadView
const report = { ...base, id: "report", needsYou: true, plainReport: true, pinnedAt: PIN } as ThreadView
const parked = { ...base, id: "parked", needsYou: false, waitStatus: "watching", pinnedAt: PIN } as ThreadView

function render(node: ReturnType<typeof createElement>): string {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, node),
    ),
  )
}

/** The ids of the rows in `html` that wear the dot. */
function dotted(html: string): string[] {
  return html.split("data-sidebar-item=").slice(1).filter((row) => row.includes("data-sidebar-queue-dot")).map((row) => row.slice(1, row.indexOf('"', 1)))
}

test("a row draws the dot, and names it for a screen reader, only when asked to", () => {
  const on = render(createElement(ThreadRow, { t: ask, queueDot: true }))
  assert.match(on, /data-sidebar-queue-dot/)
  assert.match(on, /class="absolute left-\[8px\] top-\[10\.5px\] size-1\.5 rounded-full bg-accent"/, "the accent, in the gutter beside the status box")
  assert.match(on, /<span class="sr-only">Unread, in the queue\. <\/span>/)
  const off = render(createElement(ThreadRow, { t: ask }))
  assert.doesNotMatch(off, /data-sidebar-queue-dot|in the queue/)
})

test("the open row never draws the dot beside the pane's marker", () => {
  const open = render(createElement(ThreadRow, { t: ask, queueDot: true, active: true }))
  assert.match(open, /data-sidebar-scroll-marker/)
  assert.doesNotMatch(open, /data-sidebar-queue-dot|in the queue/)
})

test("opening the rest clears the dot, and the next rest brings it back", () => {
  const read = { ...ask, seenAt: "2026-11-17T11:00:05.000Z" } as ThreadView
  assert.doesNotMatch(render(createElement(ThreadRow, { t: read, queueDot: true })), /data-sidebar-queue-dot/, "read since it rested")
  const restedAgain = { ...read, lastAssistantAt: "2026-11-17T11:30:00.000Z" } as ThreadView
  assert.match(render(createElement(ThreadRow, { t: restedAgain, queueDot: true })), /data-sidebar-queue-dot/, "a newer rest is unread")
})

test("a rest is unread until the human opens it, against the instant the row's rest time reads", () => {
  assert.equal(unreadRest({ runtime: "turn-idle", lastAssistantAt: RESTED }), true, "never opened")
  assert.equal(unreadRest({ runtime: "turn-idle", lastAssistantAt: RESTED, seenAt: "2026-11-17T10:59:00.000Z" }), true, "opened before it rested")
  assert.equal(unreadRest({ runtime: "turn-idle", lastAssistantAt: RESTED, seenAt: RESTED }), false, "opened as it rested")
  // A record after the rest that is not the agent's own output (a sub-agent's return) does not re-mark it:
  // at rest the instant is the agent's last output, as the rest time reads it.
  assert.equal(unreadRest({ runtime: "turn-idle", lastAssistantAt: RESTED, lastActivityAt: "2026-11-17T12:00:00.000Z", seenAt: "2026-11-17T11:00:05.000Z" }), false)
})

test("a board's Pinned shelf dots its asks, and neither its reports nor its parks", () => {
  const html = render(createElement(PinnedBand, { threads: [ask, report, parked], railRef: createRef<HTMLDivElement>(), activeId: null }))
  assert.deepEqual(dotted(html), ["ask"])
})

test("each shelf asks its own view's queue", () => {
  // A project board's shelf: the board's pin lifts a plain report out of the queue.
  assert.equal(queuedOnShelf(ask, "board"), true)
  assert.equal(queuedOnShelf(report, "board"), false)
  assert.equal(queuedOnShelf(parked, "board"), false)
  // The Console's shelf ("By status"): only the Console's own pin lifts a report. A board pin plays no part.
  const consolePinnedReport = { ...report, pinnedAt: undefined, consolePinnedAt: PIN } as ThreadView
  assert.equal(queuedOnShelf(consolePinnedReport, "console"), false)
  assert.equal(queuedOnShelf({ ...ask, pinnedAt: undefined, consolePinnedAt: PIN } as ThreadView, "console"), true)
  assert.equal(queuedOnShelf(report, "console"), true, "a board-pinned report still queues on the Console")
})
