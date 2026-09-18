import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { ThreadTitle } from "./ThreadTitle.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// ThreadTitle is the ONE title element both the drawer header and the queue card render, so this is
// where the manual-rename affordance is pinned. The queue card used to render its own plain div with
// only the AI refresh mark beside it (maintainer 2026-09-13: "It only lets me rename. I should be able
// to click on it to retitle it.").

const base = { kind: "session", backend: "claude", title: "A worker", status: "active", runtime: "running", subAgents: [] } as unknown as ThreadView

function render(extra: Partial<ThreadView>): string {
  const t = { ...base, id: "t", ...extra } as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(ThreadTitle, { thread: t })),
    ),
  )
}

test("an owned session thread's name is a click-to-edit button, with the Claude refresh mark beside it", () => {
  const html = render({})
  assert.match(html, /<button[^>]*aria-label="Edit thread title: A worker"/)
  assert.match(html, /data-ai-rename/)
  assert.match(html, /focus-visible:ring-focus-ink-60/)
  assert.doesNotMatch(html, /focus-visible:ring-fg\/60/)
})

test("a Codex thread keeps the manual editor and gets no Claude refresh mark", () => {
  const html = render({ backend: "codex" })
  assert.match(html, /aria-label="Edit thread title: A worker"/)
  assert.doesNotMatch(html, /data-ai-rename/)
})

test("a foreign row has no registry row to rename, so its name is plain text", () => {
  const html = render({ foreign: true })
  assert.doesNotMatch(html, /<button/)
  assert.match(html, /title="A worker"/)
})
