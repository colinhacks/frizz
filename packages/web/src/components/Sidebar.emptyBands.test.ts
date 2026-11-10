import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { store } from "../store.ts"
import { RailViewChips } from "./RailViewChips.tsx"
import { Sidebar } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// WHAT THE RAIL DRAWS WITH NOTHING OPEN (maintainer 2026-11-06, of a dim "No open threads" line sitting
// between a "Newest first" chip and a rule over Snoozed: "kind of looks out of place and sloppy"). An
// empty queue draws nothing where it would be: no stand-in line, no chip to order it, and no rule over
// the first band that is left, which would be a line under nothing.

const thread = (id: string, over: Partial<ThreadView>) =>
  ({
    id,
    title: id,
    kind: "session",
    backend: "claude",
    status: "active",
    state: "open",
    runtime: "turn-idle",
    needsYou: false,
    archived: false,
    foreign: false,
    subAgents: [],
    agents: [],
    bgShells: [],
    errors: [],
    warnings: [],
    spawnedAt: "2026-11-06T09:00:00.000Z",
    lastAssistantAt: "2026-11-06T10:00:00.000Z",
    ...over,
  }) as unknown as ThreadView

const LATER = new Date(Date.now() + 3_600_000).toISOString()
const snoozed = (id: string) => thread(id, { snoozedUntil: LATER })
const done = (id: string) => thread(id, { archived: true, state: "archived" })
const queued = (id: string) => thread(id, { needsYou: true })
const running = (id: string) => thread(id, { runtime: "running" })

function rail(threads: ThreadView[]) {
  store.board = { threads, errors: [], projectDir: "/tmp/p", homeDir: "/tmp" } as unknown as BoardSnapshot
  const html = renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(TooltipProvider, null, createElement(Sidebar)),
      ),
    ),
  )
  // Only the list under the prompt box: the box and its status row have chips and rules of their own.
  return html.slice(html.indexOf("data-sidebar-rail"))
}
const rules = (html: string) => html.match(/<hr/g)?.length ?? 0

test("with nothing open, the rail starts at the first band left: no line, no chip, no rule", () => {
  const html = rail([snoozed("parked")])
  assert.match(html, /Snoozed/)
  assert.doesNotMatch(html, /No open threads/)
  assert.doesNotMatch(html, /data-rail-view-chips/)
  assert.equal(rules(html), 0)
})

test("a rule still separates two bands, and only those two", () => {
  assert.equal(rules(rail([snoozed("parked"), done("finished")])), 1)
  assert.equal(rules(rail([done("finished")])), 0)
  assert.equal(rules(rail([thread("terminal", { foreign: true })])), 0)
  assert.equal(rules(rail([done("finished"), thread("terminal", { foreign: true })])), 1)
})

test("a pinned row counts as a band above Snoozed, and is not a queue for the chip to order", () => {
  const html = rail([thread("kept", { pinnedAt: "2026-11-06T08:00:00.000Z" }), snoozed("parked")])
  assert.doesNotMatch(html, /data-rail-view-chips/)
  assert.equal(rules(html), 1)
})

test("work that is running keeps the rule over Snoozed, and has no queue for the chip to order", () => {
  const html = rail([running("busy"), snoozed("parked")])
  assert.match(html, /Running/)
  assert.doesNotMatch(html, /data-rail-view-chips/)
  assert.equal(rules(html), 1)
})

test("a queue gets its order chip and its rules back", () => {
  const html = rail([queued("waiting"), snoozed("parked"), done("finished")])
  assert.match(html, /data-rail-view-chip="order"/)
  assert.equal(rules(html), 2)
})

test("the Console keeps its grouping chip with no queue, and loses only the order chip", () => {
  const chips = (queued: boolean) => renderToStaticMarkup(createElement(RailViewChips, { group: "status", queued }))
  assert.match(chips(false), /data-rail-view-chip="group"/)
  assert.doesNotMatch(chips(false), /data-rail-view-chip="order"/)
  assert.match(chips(true), /data-rail-view-chip="order"/)
})
