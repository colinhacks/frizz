import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { MemoryRouter } from "react-router"
import type { BoardSnapshot } from "@frizz/shared"
import { StatusRow } from "./StatusRow.tsx"
import { store, type ConnectionState } from "../store.ts"

// The row's SHAPE is a spec, not an accident: home → settings → reload → quota, left to right and all
// of it left-justified, with the project — owner/repo, a link to the repo — pinned to the right edge.
// It has been three separate pieces of chrome in three places (identity top-left, settings/reload
// top-right, quota floating over the sidebar composer), then one fixed corner chip, then the same row
// running the other way — so a regression here is a silent return to one of those rather than a
// visible break.
//
// `githubRepo` defaults to the label whenever the label is an owner/repo, which is what a github.com
// origin produces; pass `null` for the other forge (a GitLab owner/repo, which the board carries WITHOUT
// githubRepo — see BoardSnapshot).
function render(
  label: string | null = "colinhacks/frizz",
  options: { connection?: ConnectionState; quota?: boolean; githubRepo?: string | null } = {},
): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // The quota chips and the gate in front of them read these two cache entries; seeding them is how a
  // static render reaches the shown state at all.
  if (options.quota !== false) {
    client.setQueryData(["quota"], {
      claude: { status: "ok", planType: "max", windows: [{ key: "5h", label: "5h", usedPercent: 17 }] },
      codex: { status: "ok", planType: "pro", windows: [{ key: "5h", label: "5h", usedPercent: 41 }] },
    })
    client.setQueryData(["authStatus"], { claude: "authed", codex: "authed", emails: {} })
  }
  const githubRepo =
    options.githubRepo === undefined ? (label?.includes("/") ? label : undefined) : (options.githubRepo ?? undefined)
  store.board = (label === null
    ? null
    : { projectLabel: label, ...(githubRepo ? { githubRepo } : {}), threads: [] }) as unknown as BoardSnapshot
  store.connection = options.connection ?? "open"
  store.socketBoardFallback = null
  // The home crumb is a router Link (it hard-loaded the document until 2026-09-04), and a Link outside a
  // router context throws on render — every case here failed at once when it changed. In the app the row
  // is always under RouterProvider; MemoryRouter is the same context without a DOM history.
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, null, createElement(StatusRow, null)),
    ),
  )
}

test("controls run along the left; the project anchors the right", () => {
  const html = render()

  const home = html.indexOf('aria-label="All projects"')
  const settings = html.indexOf('aria-label="Settings"')
  const quota = html.indexOf("data-quota-bar")
  const project = html.indexOf("data-project-identity-state")

  assert.ok(home >= 0 && settings >= 0 && quota >= 0 && project >= 0, "every segment renders")
  assert.ok(home < settings, "the way out of the project leads")
  assert.ok(settings < quota, "the buttons precede the readouts")
  assert.ok(quota < project, "the project is last, at the far edge")
  // `ml-auto` on the identity IS the split. Without it the name packs left with everything else.
  assert.match(html, /class="ml-auto flex min-w-0 items-center"/)
})

test("TWO dividers: home is a door OUT, settings and reload act on the app you are in", () => {
  const html = render()
  // One divider would group all three as "buttons". The first one is the whole distinction.
  assert.equal(html.split('class="h-3 w-px shrink-0 bg-border"').length - 1, 2)
})

test("the row is LOOSE on the page — no fill, no border, no shadow, nothing fixed", () => {
  const html = render()

  assert.match(html, /data-status-row/)
  // It was a fixed, opaque, shadowed chip in the page's top-left corner until 2026-08-19, because a
  // full sidebar or a scrolling narrow rail would paint through it. In the column there is nothing to
  // pass behind it, and a surface here would read as a second box stacked on the prompt box.
  assert.match(html, /class="mb-2\.5 flex min-w-0 items-center gap-3 text-\[12px\]"/)
  for (const gone of [/\bfixed\b/, /\bz-20\b/, /bg-panel/, /shadow-sm/, /rounded-lg border border-border/]) {
    assert.doesNotMatch(html, gone)
  }
})

test("the project is a LINK to its GitHub repo — and the connection dot is gone", () => {
  // Maintainer 2026-08-28: "There should be a way to open up the GitHub repo for a given project if
  // one is detected … Perhaps it should actually be showing owner/repo if a repo is detected … then
  // maybe we should just drop the status indicator." The dot had been the connection's last remnant
  // since 2026-08-19.
  const html = render("colinhacks/frizz")

  // The whole owner/repo, not the bare repo the row used to show.
  assert.match(html, />colinhacks\/frizz</)
  // A real anchor to the repo — new tab, and a label that says where it goes. No scripted window.open.
  assert.match(html, /<a href="https:\/\/github\.com\/colinhacks\/frizz" target="_blank" rel="noopener"/)
  assert.match(html, /aria-label="Open colinhacks\/frizz on GitHub"/)
  // NO GITHUB MARK. The first cut wore one in the dot's old slot; the maintainer pulled it the same
  // day because the prompt box's GitHub picker icon sits a few px below and means something else
  // ("it kind of conflicts with the GitHub icon that shows up in the prompt box"). The link shows
  // itself the way the app's other text links do — full fg and an underline on hover — and keeps the
  // name's resting weight and tone, so a linked and an unlinked project read alike at rest.
  const identity = html.slice(html.indexOf("data-project-identity-state"))
  assert.doesNotMatch(identity, /<svg/)
  assert.match(html, /<a [^>]*class="block min-w-0 rounded-sm font-semibold text-fg\/90 underline-offset-2 [^"]*hover:text-fg hover:underline/)

  // The connection dot, in every state, is gone — nothing in the row says "connected" any more.
  for (const connection of ["open", "connecting", "closed"] as const) {
    const state = render("colinhacks/frizz", { connection })
    assert.doesNotMatch(state, /role="img" aria-label="connected"/)
    assert.doesNotMatch(state, /aria-label="disconnected"|aria-label="connecting…"/)
    assert.doesNotMatch(state, /bg-live|bg-danger-fill|data-board-sync-fallback/)
  }
})

test("an owner/repo from ANOTHER forge is plain text: no link", () => {
  // The board carries `githubRepo` only for a github.com origin. A GitLab origin still yields an
  // owner/repo display label, and pointing that at github.com would be a wrong destination rather
  // than a missing one — so the name renders as prose and nothing in it is a control.
  const html = render("colinhacks/frizz", { githubRepo: null })

  assert.match(html, /data-project-identity-state="verified"/)
  assert.match(html, />colinhacks\/frizz</)
  assert.doesNotMatch(html, /<a href="https:\/\/github\.com/)
  assert.doesNotMatch(html, /on GitHub/)
})

test("the name clips from the START, so the repo half survives a narrow column", () => {
  // "colinhacks/frizz" does not fit beside two quota chips at the sidebar's 272px floor. A plain
  // `truncate` would keep the owner and drop the repo — the one half worth keeping — so the clipping
  // box runs rtl (overflow and ellipsis at the LEFT edge) with the text re-isolated ltr inside it.
  const html = render("colinhacks/frizz")
  assert.match(
    html,
    /<span dir="rtl" class="block min-w-0 overflow-hidden text-ellipsis whitespace-nowrap [^"]*"><span dir="ltr" class="\[unicode-bidi:isolate\]">colinhacks\/frizz<\/span><\/span>/,
  )
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
  assert.match(html, /aria-label="Project: scratch-pad; local repository with no git remote"/)
})

test("a cold board still reserves the name's measure, and says it is loading", () => {
  const html = render(null)

  assert.match(html, /data-project-identity-state="loading"/)
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /identity-placeholder/)
  // The controls do not wait on a board — they are reachable from the first paint.
  assert.match(html, /aria-label="Settings"/)
  assert.match(html, /aria-label="All projects"/)
})

test("the row's gap is 12px of INK: one flex gap, and every icon square trimmed onto its glyph", () => {
  const html = render()

  // The pair is the whole point and neither half works alone. `gap-3` without the trims puts 20px of
  // ink between two icon squares and 8px beside the quota chips (measured 2026-08-14 with
  // scripts/ink-gaps.mjs); the trims without a matching gap pull the icons on top of each other. Every
  // button takes its trim from STATUS_ROW_ACTION, so a new row action inherits the rhythm instead of
  // re-deriving it — and a glyph that paints something other than 12px needs a fresh measurement.
  assert.match(html, /class="-mx-1\.5 inline-flex h-6 w-6/)
  // The home square gets ONE more pixel back: its own `-mx-1.5` leaves the house glyph's ink a pixel
  // outside the composer's border, and the row's left edge is where that overhang shows.
  assert.match(html, /class="-mx-1\.5 inline-flex h-6 w-6[^"]*-ml-px"/)
  // The quota chips are IN this row, so they keep the row's distance rather than one of their own.
  assert.match(html, /data-quota-bar="true" class="flex shrink-0 items-center gap-3/)
})

test("the quota READING is small, but its provider mark is a full-sized, full-brightness icon", () => {
  const html = render()

  // "logos should be the same brightness and size as the other icons. The text should just be small"
  // (maintainer 2026-08-19). The size is per-mark because the two do not fill their viewBoxes alike.
  assert.match(html, /data-quota-bar="true" class="[^"]*text-\[9px\]/)
  assert.match(html, /text-fg\/75! size-\[14px\]!/)
  assert.match(html, /text-fg\/75! size-\[12\.75px\]!/)
  // ProviderMark's own `text-muted-65 size-[11px]` is still in the class list and MUST be — the `!`
  // is what outranks it, because Tailwind resolves a same-property collision by CSS source order and
  // not by class order. Asserting the default is absent would be asserting the wrong mechanism; the
  // browser-side check that these resolve to 14px/12.75px is in the handoff's measurements.
  assert.match(html, /text-muted-65 size-\[11px\][^"]*size-\[14px\]!/)
})

test("the home crumb is a ROUTER link, not a raw anchor that reloads the document", () => {
  // It was `<a href="/">` from 2026-08-19 to 2026-09-04: a full document load measured at 116-411ms with
  // a 0.15 CLS, throwing away the app socket and the whole query cache on the way out. The rail's
  // identical door had been a `<Link>` since the router refactor a fortnight earlier, so this was an
  // oversight — and an easy one to make again, because in STATIC MARKUP the two are the same string.
  // `<Link to="/">` renders exactly `<a href="/">`, so no assertion on the HTML can tell them apart.
  //
  // What differs is the CONTEXT they need: a Link reads the router off React context and throws without
  // one, a plain anchor does not care. So rendering the row with no router is the discriminator, and it
  // is the same property that makes this a client-side navigation at all.
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
  assert.match(render(), /href="\/"[^>]*aria-label="All projects"|aria-label="All projects"[^>]*href="\/"/)
})

test("a provider with NO DATA renders nothing at all — and takes the divider with it", () => {
  // "if there's no data available for a given agent, then it should just be entirely hidden instead of
  // showing an em dash" (maintainer 2026-08-19). An em dash spent a readout's worth of space saying a
  // readout was missing.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(["quota"], {
    claude: { status: "ok", planType: "max", windows: [{ key: "5h", label: "5h", usedPercent: 17 }] },
    codex: { status: "unavailable", windows: [] },
  })
  client.setQueryData(["authStatus"], { claude: "authed", codex: "signed-out", emails: {} })
  store.board = { projectLabel: "colinhacks/frizz", threads: [] } as unknown as BoardSnapshot
  store.connection = "open"
  // Seeds its own client rather than going through `render`, so it needs the router context too.
  const one = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client },
      createElement(MemoryRouter, null, createElement(StatusRow, null)),
    ),
  )
  assert.doesNotMatch(one, /—/, "no em dash anywhere")
  assert.equal(one.split("Claude Code").length - 1, 1, "the Claude chip is still there")
  assert.equal(one.split("OpenAI Codex").length - 1, 0, "the Codex chip is gone entirely")
  // One provider still reporting keeps the group, and therefore its divider.
  assert.equal(one.split('class="h-3 w-px shrink-0 bg-border"').length - 1, 2)

  // NEITHER reporting drops the whole group, and the divider that introduced it goes too — otherwise
  // the row ends on a hairline with nothing after it.
  const none = render("colinhacks/frizz", { quota: false })
  assert.doesNotMatch(none, /data-quota-bar/)
  assert.equal(none.split('class="h-3 w-px shrink-0 bg-border"').length - 1, 1)
})
