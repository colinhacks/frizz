import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { ThreadRow } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// A DONE thread is grayed wherever it rows (maintainer 2026-09-11: "a thread that's marked as done
// should always be grayed out, even if it's pinned"). The dim rides the ROW's own state, not the band:
// the pinned band lifts a row out of Done without changing what it is, so a pinned done row wears the
// same dim as one in the Done band — and the same dim a Snoozed row wears, so the rail has exactly one
// way of saying "nothing here is moving". A running-yet-archived thread keeps its full weight: it sits
// under Active with its spinner, and the dim must agree with the band.

const base = {
  kind: "session",
  backend: "claude",
  title: "A thread",
  status: "active",
  runtime: "turn-idle",
  subAgents: [],
} as unknown as ThreadView

function row(extra: Partial<ThreadView>) {
  const t = { ...base, id: "thread", ...extra } as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(ThreadRow, { t })),
    ),
  )
}

/** The row's own class list — the `data-sidebar-item` element. */
function rowClasses(html: string): string[] {
  const at = html.indexOf("data-sidebar-item=")
  assert.notEqual(at, -1, "the row renders")
  const start = html.indexOf('class="', at) + 'class="'.length
  return html.slice(start, html.indexOf('"', start)).split(" ").filter(Boolean)
}

/** The title span's class list — the one carrying the 13px type. */
function titleClasses(html: string): string[] {
  const at = html.indexOf("text-[13px]")
  assert.notEqual(at, -1, "the row renders its title")
  const start = html.lastIndexOf('class="', at) + 'class="'.length
  return html.slice(start, html.indexOf('"', start)).split(" ").filter(Boolean)
}

const ROW_DIM = "sidebar-row-dim"
const TITLE_DIM = "text-fg/75"
const PINNED = { pinnedAt: "2026-09-02T10:00:00.000Z" } as Partial<ThreadView>
const DONE = { state: "archived", archived: true } as Partial<ThreadView>

test("an open row at rest carries no dim", () => {
  const html = row({})
  assert.ok(!rowClasses(html).includes(ROW_DIM))
  assert.ok(titleClasses(html).includes("text-fg/90"))
})

test("a done row is dimmed — row and title alike", () => {
  const html = row(DONE)
  assert.ok(rowClasses(html).includes(ROW_DIM), "the row is grayed")
  const css = readFileSync(new URL('../styles.css', import.meta.url), 'utf8')
  assert.match(css, /\.sidebar-row-dim:hover, \.sidebar-row-dim:focus-within \{ opacity: var\(--row-dim-hover-opacity\); \}/)
  assert.ok(titleClasses(html).includes(TITLE_DIM), "the title is grayed")
})

test("a PINNED done row is dimmed exactly the same — the pin moves the row, not its state", () => {
  const html = row({ ...DONE, ...PINNED })
  assert.match(html, /data-rail-pin-mark/, "still wears the pin mark")
  assert.ok(rowClasses(html).includes(ROW_DIM), "the row is grayed")
  assert.ok(titleClasses(html).includes(TITLE_DIM), "the title is grayed")
})

test("a pinned OPEN row keeps its full weight", () => {
  const html = row(PINNED)
  assert.ok(!rowClasses(html).includes(ROW_DIM))
  assert.ok(titleClasses(html).includes("text-fg/90"))
})

test("a running-yet-archived row is NOT dimmed — it spins under Active, and the dim agrees", () => {
  const html = row({ ...DONE, runtime: "running" })
  assert.ok(!rowClasses(html).includes(ROW_DIM))
  assert.ok(titleClasses(html).includes("text-fg/90"))
})
