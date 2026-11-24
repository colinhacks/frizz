import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router"
import type { ProjectCard, ProjectRailCounts } from "@frizz/shared"
import { ProjectSquare, RailLink } from "./ProjectRail.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// THE RAIL'S BADGE IS THE QUEUE, AND ONLY THE QUEUE (maintainer 2026-10-11: "showing just the number of
// threads in the queue is probably more useful for what the average person needs"). From 2026-09-24 its
// number was the queue plus the threads in flight, with a spinner lapping it while any were; both are
// gone, so a project that is only working draws no badge at all.
const project = { id: "p", slug: "p", name: "zod", path: "/tmp/zod", lastOpenedAt: "2026-10-11T00:00:00.000Z", stale: false, iconStatus: "none" } as ProjectCard

const render = (counts: ProjectRailCounts | undefined) =>
  renderToStaticMarkup(
    createElement(MemoryRouter, null,
      createElement(TooltipProvider, null,
        createElement(RailLink, { project, current: false, counts, index: 0, drag: null, onPointerDown: () => {}, onKeyDown: () => {} }))),
  )
const badge = (html: string) => html.match(/<span[^>]*data-rail-queue-count[^>]*>.*?<\/span><\/span>/)?.[0] ?? ""

test("the badge shows the queue count and leaves running threads out of it", () => {
  const html = render({ queued: 2, running: 3, asks: 0 })
  assert.match(badge(html), /data-rail-queue-count="2"/)
  assert.match(badge(html), /aria-label="2 in the queue"/)
  assert.match(badge(html), />2<\/span><\/span>$/)
})

test("a project with running threads and an empty queue draws no badge", () => {
  assert.equal(badge(render({ queued: 0, running: 3, asks: 0 })), "")
  assert.equal(badge(render(undefined)), "")
})

// The whole square, not just the badge: the spinner was a sibling of the number, so only the full
// markup shows that nothing is drawn for a running thread any more.
test("running threads change nothing the square draws", () => {
  const still = render({ queued: 12, running: 0, asks: 0 })
  for (const running of [1, 12]) assert.equal(render({ queued: 12, running, asks: 0 }), still)
})

test("the built-in Home project renders its tilde glyph instead of a monogram, unless given a custom icon", () => {
  const home = { ...project, id: "home-id", slug: "home", name: "Home", path: "/Users/test", builtin: "home" as const, iconStatus: "none" as const }
  const html = renderToStaticMarkup(createElement(ProjectSquare, { project: home, size: 64 }))
  assert.match(html, /data-home-project-icon/)
  assert.match(html, /<svg/)
  assert.doesNotMatch(html, /<img/)
  assert.doesNotMatch(html, />HO</)

  const custom = { ...home, iconStatus: "icon" as const, iconIsCustom: true, iconVersion: "abc123" }
  const customHtml = renderToStaticMarkup(createElement(ProjectSquare, { project: custom, size: 64 }))
  assert.doesNotMatch(customHtml, /data-home-project-icon/)
  assert.match(customHtml, /<img/)
})
