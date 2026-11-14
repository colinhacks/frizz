import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { store } from "../store.ts"
import { resetBandFolds, setBandFolded } from "../lib/sidebarBands.ts"
import { Sidebar } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// THE RUNNING BAND FOLDS (maintainer 2026-11-11: "make the running rail collapsible"), and OPENS by
// default (2026-11-14: "running should be default open"). Folded, its header still counts the spinning
// threads, so the glance survives. The queue above it never folds. Which bands are folded is remembered
// per project (lib/sidebarBands.ts).

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

test("the Running band starts open: its rows are drawn under a fold toggle, and the queue stays static", () => {
  const html = rail(board)
  assert.match(html, /data-sidebar-item="waiting"/)
  assert.match(html, /<button[^>]*aria-expanded="true"[^>]*data-band-header="running"/)
  assert.match(html, /data-sidebar-item="busy-one"/)
  assert.match(html, /data-sidebar-item="busy-two"/)
  // Queue keeps its static label.
  assert.doesNotMatch(html, /<button[^>]*>(?:(?!<\/button>)[\s\S])*Queue/)
})

test("folded, the Running band keeps its count and drops its rows", (t) => {
  setBandFolded("running", true)
  t.after(() => resetBandFolds())
  const html = rail(board)
  assert.match(html, /<button[^>]*>(?:(?!<\/button>)[\s\S])*Running(?:(?!<\/button>)[\s\S])*>2<\/span><\/button>/)
  assert.doesNotMatch(html, /data-sidebar-item="busy-one"/)
  assert.doesNotMatch(html, /data-sidebar-item="busy-two"/)
  assert.match(html, /data-sidebar-item="waiting"/)
})
