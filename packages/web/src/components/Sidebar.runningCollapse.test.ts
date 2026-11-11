import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { store } from "../store.ts"
import { Sidebar } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// THE RUNNING BAND FOLDS, AND STARTS FOLDED (maintainer 2026-11-11: "make the running rail collapsible
// … collapsed by default"). Collapsed, its header still counts the spinning threads, so the glance
// survives; the rows come back when the header is clicked. The queue above it never folds.

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
    spawnedAt: "2026-11-11T09:00:00.000Z",
    lastAssistantAt: "2026-11-11T10:00:00.000Z",
    ...over,
  }) as unknown as ThreadView

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
  return html.slice(html.indexOf("data-sidebar-rail"))
}

const board = [thread("waiting", { needsYou: true }), thread("busy-one", { runtime: "running" }), thread("busy-two", { runtime: "running" })]

test("the Running band starts collapsed: its count shows, its rows do not, and the queue stays open", () => {
  assert.equal(store.sidebarCollapsed.running, true)
  const html = rail(board)
  assert.match(html, /data-sidebar-item="waiting"/)
  // The label is a toggle now, with the count beside it.
  assert.match(html, /<button[^>]*>(?:(?!<\/button>)[\s\S])*Running(?:(?!<\/button>)[\s\S])*>2<\/span><\/button>/)
  assert.doesNotMatch(html, /data-sidebar-item="busy-one"/)
  assert.doesNotMatch(html, /data-sidebar-item="busy-two"/)
  // Queue keeps its static label.
  assert.doesNotMatch(html, /<button[^>]*>(?:(?!<\/button>)[\s\S])*Queue/)
})

test("opened, the Running band draws its rows", () => {
  store.sidebarCollapsed.running = false
  try {
    const html = rail(board)
    assert.match(html, /data-sidebar-item="busy-one"/)
    assert.match(html, /data-sidebar-item="busy-two"/)
  } finally {
    store.sidebarCollapsed.running = true
  }
})
