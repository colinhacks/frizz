import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { TooltipProvider } from "./Tooltip.tsx"

// CHILD THREADS ON THE RAIL, over the REAL <Sidebar/>: a child is no row of its own (shared
// drawnUnderParent), and is drawn as an indented child row under its parent, after the parent's
// sub-agents (SubAgentRows → ChildThreadRows). A child at a hard gate is the exception the human must
// answer: it rows in the queue AND stays listed under its parent.

const base = {
  kind: "session",
  state: "open",
  backend: "claude",
  status: "active",
  runtime: "turn-idle",
  needsYou: false,
  subAgents: [],
  bgShells: [],
  watches: [],
  questions: [],
  dependsOn: [],
  spawnedAt: "2026-11-04T10:00:00.000Z",
} as unknown as ThreadView

async function rail(threads: ThreadView[]): Promise<string> {
  const [{ MemoryRouter }, { Sidebar }, { store }] = await Promise.all([import("react-router"), import("./Sidebar.tsx"), import("../store.ts")])
  store.board = { projectDir: "/fixture", threads } as unknown as typeof store.board
  // The parents here spin, so they row in the Running band, which starts collapsed.
  store.sidebarCollapsed.running = false
  try {
    return renderToStaticMarkup(
      createElement(
        QueryClientProvider,
        { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
        createElement(TooltipProvider, null, createElement(MemoryRouter, null, createElement(Sidebar))),
      ),
    )
  } finally {
    store.board = null
    store.sidebarCollapsed.running = true
  }
}

const parent = { ...base, id: "ship-the-port", title: "Ship the port", runtime: "running" } as ThreadView
const working = { ...base, id: "fix-ci", title: "Fix the CI matrix", parentSlug: "ship-the-port", runtime: "running" } as ThreadView
const handedOff = { ...base, id: "write-docs", title: "Write the docs", parentSlug: "ship-the-port", handoffToParent: true } as ThreadView

test("a child is drawn under its parent and nowhere else on the rail", async () => {
  const html = await rail([parent, working, handedOff])
  assert.match(html, /data-sidebar-item="ship-the-port"/)
  assert.doesNotMatch(html, /data-sidebar-item="fix-ci"/, "no row of its own")
  assert.doesNotMatch(html, /data-sidebar-item="write-docs"/, "no row of its own")
  const under = html.slice(html.indexOf('data-sidebar-item="ship-the-port"'))
  assert.match(under, /aria-label="Open child thread: Fix the CI matrix"/)
  assert.match(under, /aria-label="Open child thread: Write the docs"/)
  // Marked as the parent's own row, so the parent's drawer stacks the child rather than dismissing.
  assert.match(under, /data-subagent-parent="ship-the-port"/)
  // The Running band counts the parent alone.
  assert.match(html, /Running[\s\S]*?>1</)
})

test("a child at a hard gate queues on its own row and stays listed under its parent", async () => {
  const gated = { ...base, id: "approve-push", title: "Approve the push", parentSlug: "ship-the-port", runtime: "perm-prompt", needsYou: true } as ThreadView
  const html = await rail([parent, gated])
  assert.match(html, /data-sidebar-item="approve-push"/, "it rows in the queue")
  assert.match(html, /aria-label="Open child thread: Approve the push"/, "and under its parent")
  assert.match(html, />needs you</)
})
