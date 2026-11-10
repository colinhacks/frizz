import assert from "node:assert/strict"
import test from "node:test"
import { createElement, type ComponentProps } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router"
import type { BoardSnapshot } from "@frizz/shared"
import { StatusRow } from "./StatusRow.tsx"
import { store, type ConnectionState } from "../store.ts"
import { PROJECTS_HREF, setHomeView } from "../lib/homeView.ts"

// The row's SHAPE is a spec, not an accident: a breadcrumb — home, a slash, this project as a dropdown —
// at the left, and the icons right-justified with settings in the corner (maintainer 2026-10-26). It has
// been three separate pieces of chrome in three places, then one fixed corner chip, then a run of
// controls with owner/repo pinned right — so a regression here is a silent return to one of those
// rather than a visible break.
//
// `githubRepo` defaults to the label whenever the label is an owner/repo, which is what a github.com
// origin produces; pass `null` for the other forge (a GitLab owner/repo, which the board carries WITHOUT
// githubRepo — see BoardSnapshot).
function render(
  label: string | null = "colinhacks/frizz",
  options: {
    connection?: ConnectionState
    githubRepo?: string | null
    projectName?: string
    onConsole?: boolean
  } = {},
): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const githubRepo =
    options.githubRepo === undefined ? (label?.includes("/") ? label : undefined) : (options.githubRepo ?? undefined)
  store.board = (label === null
    ? null
    : {
        projectLabel: label,
        ...(options.projectName ? { projectName: options.projectName } : {}),
        ...(githubRepo ? { githubRepo } : {}),
        threads: [],
      }) as unknown as BoardSnapshot
  store.connection = options.connection ?? "open"
  // The home crumb is a router Link (it hard-loaded the document until 2026-09-04), and a Link outside a
  // router context throws on render — every case here failed at once when it changed. In the app the row
  // is always under RouterProvider; MemoryRouter is the same context without a DOM history.
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, null, createElement<NonNullable<ComponentProps<typeof StatusRow>>>(StatusRow, options.onConsole ? { onConsole: true, projectChip: createElement("button", { "data-chip": "" }) } : null)),
    ),
  )
}

test("a breadcrumb leads; the icons are right-justified with settings in the corner", () => {
  const html = render("colinhacks/frizz", { projectName: "frizz" })

  const home = html.indexOf('aria-label="All projects"')
  const crumb = html.indexOf("data-project-crumb")
  const settings = html.indexOf('aria-label="Settings"')

  assert.ok(home >= 0 && crumb >= 0 && settings >= 0, "every segment renders")
  assert.ok(home < crumb, "the way out is the breadcrumb's root")
  assert.ok(crumb < settings, "settings is last, in the corner")
  assert.doesNotMatch(html.slice(settings), /<button|<a /, "no control follows settings")
  // The breadcrumb is a nav with the slash as its separator, and the icons' group is pushed right by
  // `ml-auto` — without it they pack left against the crumb.
  assert.match(html, /<nav aria-label="Breadcrumb" class="flex min-w-0 items-center gap-2\.5">/)
  // The crumb's hover pill is the house's hover square in shape — 24px tall, rounded-md, every icon
  // button's bg-hover-strong — so the two controls in the breadcrumb light up alike.
  assert.match(html, /data-project-crumb="[^"]*"[^>]*class="group -ml-1\.5 -mr-\[3px\] inline-flex h-6 [^"]*rounded-md [^"]*hover:bg-hover-strong/)
  assert.match(html, /<span aria-hidden="true" class="shrink-0 select-none text-muted-45">\/<\/span>/)
  assert.match(html, /class="ml-auto flex shrink-0 items-center gap-3"/)
})

test("the crumb names the project, not owner/repo — and no owner/repo is pinned to the right any more", () => {
  // Maintainer 2026-10-26: "drop the owner/repo to the top right of the sidebar promptbox. instead make it
  // <homeicon> / <breadcrumb dropdown>". The way to the repo moved into the crumb's menu.
  const html = render("colinhacks/frizz", { projectName: "frizz" })
  assert.match(html, /aria-label="frizz: switch project"/)
  assert.match(html, /<span class="min-w-0 truncate">frizz<\/span>/)
  assert.doesNotMatch(html, /colinhacks\/frizz/, "the owner/repo is not on the row itself")
  assert.doesNotMatch(html, /<a href="https:\/\/github\.com/, "the repo link lives in the crumb's menu")

  // A board from before `projectName` still names the project, by the repo half of its label.
  assert.match(render("colinhacks/frizz"), /<span class="min-w-0 truncate">frizz<\/span>/)
})

test("the row is LOOSE on the page — no fill, no border, no shadow, nothing fixed, no dividers", () => {
  const html = render()

  assert.match(html, /data-status-row/)
  // It was a fixed, opaque, shadowed chip in the page's top-left corner until 2026-08-19, because a
  // full sidebar or a scrolling narrow rail would paint through it. In the column there is nothing to
  // pass behind it, and a surface here would read as a second box stacked on the prompt box.
  assert.match(html, /class="mb-2\.5 flex min-w-0 items-center gap-3 text-\[12px\]"/)
  for (const gone of [/\bfixed\b/, /\bz-20\b/, /bg-panel/, /shadow-sm/, /rounded-lg border border-border/]) {
    assert.doesNotMatch(html, gone)
  }
  // The two hairlines went with the run of icons they divided: the slash separates the breadcrumb, the
  // space between the row's ends separates the rest.
  assert.doesNotMatch(html, /class="h-3 w-px shrink-0 bg-border"/)
})

test("the connection dot stays gone", () => {
  for (const connection of ["open", "connecting", "closed"] as const) {
    const state = render("colinhacks/frizz", { connection })
    assert.doesNotMatch(state, /role="img" aria-label="connected"/)
    assert.doesNotMatch(state, /aria-label="disconnected"|aria-label="connecting…"/)
    assert.doesNotMatch(state, /bg-live|bg-danger-fill|data-board-sync-fallback/)
  }
})

test("a repo with no git remote shows its directory name, not the loading skeleton", () => {
  // The bug this fixes: `projectLabel` falls back to the directory basename with no origin remote, the
  // client folded that into "unavailable", and unavailable draws the cold placeholder — forever,
  // because nothing was ever going to resolve (maintainer 2026-08-19: "it just shows a skeleton
  // forever").
  const html = render("scratch-pad")

  assert.match(html, /data-project-identity-state="local"/)
  assert.match(html, />scratch-pad</)
  assert.doesNotMatch(html, /identity-placeholder/)
  assert.doesNotMatch(html, /aria-busy/)
})

test("a cold board still reserves the crumb's measure, and says it is loading", () => {
  const html = render(null)

  assert.match(html, /data-project-identity-state="loading"/)
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /identity-placeholder/)
  // The controls do not wait on a board — they are reachable from the first paint.
  assert.match(html, /aria-label="Settings"/)
  assert.match(html, /aria-label="All projects"/)
})

test("the Console's row leads with the project chip, and draws no house and no crumb", () => {
  // "The project chip should show up to the upper left in the console … we drop the home icon from
  // console" (maintainer 2026-11-06). The switcher above the row is the way to the grid.
  const html = render("colinhacks/frizz", { onConsole: true })
  assert.doesNotMatch(html, /aria-label="All projects"/)
  assert.doesNotMatch(html, /aria-label="Breadcrumb"/)
  assert.doesNotMatch(html, /data-project-crumb/)
  assert.doesNotMatch(html, />\/<\/span>/, "no slash: the chip stands alone")
  assert.ok(html.indexOf("data-chip") >= 0 && html.indexOf("data-chip") < html.indexOf('aria-label="Settings"'), "the chip leads, the icons follow")
  assert.match(html, /ml-auto/, "the icons keep the right end")
})

test("the row's gap is 12px of INK: one flex gap, and every icon square trimmed onto its glyph", () => {
  const html = render()

  // The pair is the whole point and neither half works alone. `gap-3` without the trims puts 20px of
  // ink between two icon squares (measured 2026-08-14 with scripts/ink-gaps.mjs); the trims without a
  // matching gap pull the icons on top of each other. Every square takes its trim from
  // STATUS_ROW_ACTION, so a new row action inherits the rhythm instead of re-deriving it. Measured
  // 2026-10-26: reload → settings 12px.
  assert.equal(html.match(/class="-mx-1\.5 inline-flex h-6 w-6/g)?.length, 2, "home and settings")
  // The home square takes STATUS_ROW_ACTION's trim and NOTHING more. An extra `-ml-px` once REPLACED the
  // trim (`margin-left` outranks `margin-inline`) and left the house 5px inside the composer's border.
  assert.doesNotMatch(html, /-ml-px/)
})

test("usage and MCP are not on the row: they answer to the model chip, and stand beside it", () => {
  // Maintainer 2026-11-06: "put the agent-specific icons to the right of the chip". AgentMarks.test.ts has
  // where they went.
  for (const onConsole of [false, true]) {
    const html = render("colinhacks/frizz", { onConsole })
    assert.doesNotMatch(html, /data-quota-gauge|data-fuel-gauge/)
    assert.doesNotMatch(html, /data-mcp-plug/)
  }
})

test("the home crumb is a ROUTER link, not a raw anchor that reloads the document", () => {
  // It was `<a href="/">` from 2026-08-19 to 2026-09-04: a full document load measured at 116-411ms with
  // a 0.15 CLS, throwing away the app socket and the whole query cache on the way out. In STATIC MARKUP
  // `<Link to="/">` renders exactly `<a href="/">`, so no assertion on the HTML can tell them apart.
  //
  // What differs is the CONTEXT they need: a Link reads the router off React context and throws without
  // one, a plain anchor does not care. So rendering the row with no router is the discriminator.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(["authStatus"], { claude: "authed", codex: "authed", emails: {} })
  store.board = { projectLabel: "colinhacks/frizz", threads: [] } as unknown as BoardSnapshot
  store.connection = "open"
  assert.throws(
    () => renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(StatusRow, null))),
    /basename|Router/,
    "a raw <a href=\"/\"> would render happily here; a router Link cannot",
  )
  // …and inside a router it renders, still pointing at the project grid.
  assert.match(houseOf(render()), /href="\/\?home=projects"/)
})

/** The house's own `<a …>` tag: the first link in the row, before the slash. */
function houseOf(html: string): string {
  const tag = html.match(/<a [^>]*aria-label="All projects"[^>]*>/)?.[0]
  assert.ok(tag, "the row leads with an \"All projects\" house")
  return tag
}

test("the house goes to the grid even while the Console is the kept home", () => {
  // "Clicking the home button … should always bring you to the root / not /console" (maintainer
  // 2026-10-27). It followed the kept home until then. A bare `/` would forward to the kept Console
  // (routes.tsx GridRoute), so the house names the grid's own address, which never forwards.
  setHomeView("console")
  try {
    const html = render(null)
    const house = houseOf(html)
    assert.ok(house.includes(`href="${PROJECTS_HREF}"`), house)
    assert.match(house, /title="All projects"/)
    assert.doesNotMatch(html, /href="\/console"/)
  } finally {
    setHomeView("projects")
  }
})
