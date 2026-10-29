import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ProjectCard, ThreadView } from "@frizz/shared"
import { ThreadHeaderFacts } from "./ThreadHeaderFacts.tsx"
import { threadKey } from "../lib/threadKey.ts"

// On the Console a card's facts line opens on the project the thread belongs to, and that mark is a link
// to the project's board (maintainer 2026-10-29: "clicking one of the icons for any card in the queue
// should open up that project").

function render(id: string): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(["projectsList"], [{ id: "p-nub", slug: "nub", name: "nub", iconStatus: "none" } as unknown as ProjectCard])
  const thread = { id, kind: "session", title: "A worker", status: "active", subAgents: [] } as unknown as ThreadView
  // No router around it: the link navigates through lib/router, so the line renders in a bare tree.
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(ThreadHeaderFacts, { thread })))
}

test("a Console card's project mark is a link to that project's board", () => {
  const tag = render(threadKey("nub", "fix-the-thing")).match(/<a [^>]*data-thread-project="nub"[^>]*>/)?.[0]
  assert.ok(tag, "the project mark is an anchor")
  assert.match(tag, /href="\/project\/nub"/)
  assert.match(tag, /title="Open nub"/)
})

test("a project board's own card names no project", () => {
  assert.doesNotMatch(render("fix-the-thing"), /data-thread-project/)
})
