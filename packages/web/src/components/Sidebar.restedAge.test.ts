import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { ThreadRow } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// THE CUE'S REST-TIME COLUMN (maintainer 2026-08-08: "a right-justified label on each item in the cue
// indicating when the thread came to rest"). Three things are pinned here, and the middle one is the
// one a plausible-looking implementation gets wrong:
//
//   · it renders ONLY on the cue's rows — a spinning row has not handed anything back, so there is no
//     rest to date, and the column would be printing its live activity under a heading that says rest;
//   · the instant is the agent's OWN last output (`lastAssistantAt`), NOT the tailer's last record of
//     any kind — a background sub-agent completing bumps `lastActivityAt` and must not re-date a rest
//     the human is still holding. That is `lastActiveLabelAt`'s whole job, and the same key the band is
//     ordered by, so the column reads monotonically down the cue;
//   · the visible text carries no "ago" (the column position is the "ago"); the exact phrase stays in
//     the hover title, where there is room for it.

const base = {
  kind: "session",
  backend: "claude",
  title: "Fix queue focus after an archive",
  status: "active",
  runtime: "turn-idle",
  needsYou: true,
  subAgents: [],
} as unknown as ThreadView

// Padded off the exact unit boundary on purpose. `useNowMs` reads a MODULE-LEVEL clock that only
// re-samples once something subscribes to it, and a static render never subscribes — so the "now" this
// markup is built against is the instant liveClock.ts was imported, a second or two before the test
// body runs. Land each case mid-unit and that skew cannot flip a floor()ed reading down a unit.
const ago = (ms: number) => new Date(Date.now() - ms - 30_000).toISOString()

function row(extra: Partial<ThreadView>, restedAge = true) {
  const t = { ...base, id: "fix-queue-focus", ...extra } as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(ThreadRow, { t, restedAge })),
    ),
  )
}

test("a cue row dates its rest from the agent's own last output, without the word ago", () => {
  const html = row({ lastAssistantAt: ago(12 * 60_000), lastActivityAt: ago(0) })
  assert.match(html, /data-rail-rested-age/)
  // 12m, from lastAssistantAt — NOT "just now" off the later lastActivityAt a child bumped.
  assert.match(html, />12m</)
  assert.doesNotMatch(html, />12m ago</)
  // The full phrase survives on the hover title, which has the room the column does not.
  assert.match(html, /title="12m ago"/)
})

test("the column is the CUE's alone — a running row carries no rest time", () => {
  const html = row({ runtime: "running", needsYou: false, lastActivityAt: ago(60_000) }, false)
  assert.doesNotMatch(html, /data-rail-rested-age/)
})

test("a thread that has never produced output falls back rather than printing nothing", () => {
  // No lastAssistantAt at all (a dispatch that has not spoken yet): lastActiveLabelAt falls through to
  // the tailer's activity, then to spawn — the column stays populated instead of leaving a hole in it.
  const html = row({ lastAssistantAt: undefined, lastActivityAt: undefined, spawnedAt: ago(3 * 60 * 60_000) })
  assert.match(html, />3h</)
})

// THE SNOOZED BAND carries the column too (colinhacks/frizz#66: "It's hard for me to know how long
// some of these snoozes have been snoozed for"). Pinned over the REAL <Sidebar/>, because the bug was
// never in the row — the band simply did not ask for the column. The spinning row is the control that
// proves the wiring is per band rather than global.
test("the Snoozed band dates each row; a spinning row in Active does not", async (t) => {
  const [{ MemoryRouter }, { Sidebar }, { store }] = await Promise.all([
    import("react-router"),
    import("./Sidebar.tsx"),
    import("../store.ts"),
  ])
  const snoozed = {
    ...base,
    id: "watch-the-resolver-pr",
    title: "Watch the resolver pull request",
    needsYou: false,
    snoozedUntil: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
    lastAssistantAt: ago(5 * 24 * 60 * 60_000),
  }
  const running = { ...base, id: "port-the-drivers", title: "Port the drivers", needsYou: false, runtime: "running", lastActivityAt: ago(60_000) }
  store.board = { projectDir: "/fixture", threads: [snoozed, running] } as unknown as typeof store.board
  const { resetBandFolds, setBandFolded } = await import("../lib/sidebarBands.ts")
  setBandFolded("snoozed", false)
  t.after(() => resetBandFolds())
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(MemoryRouter, null, createElement(Sidebar))),
    ),
  )
  const snoozedBand = html.slice(html.indexOf('aria-label="Snoozed"'))
  assert.match(snoozedBand, /data-sidebar-item="watch-the-resolver-pr"/)
  assert.match(snoozedBand, /data-rail-rested-age[^>]*>5d</)
  const runningRow = html.slice(html.indexOf('data-sidebar-item="port-the-drivers"'), html.indexOf('aria-label="Snoozed"'))
  assert.match(runningRow, /data-rail-glyph="working"/)
  assert.doesNotMatch(runningRow, /data-rail-rested-age/)
})

// THE PINNED BAND carries the column as well (colinhacks/frizz#66: "show the updated times first and
// only show the pin/unpin on hover"). Its rows used to wear a solid pin there instead, which cost a
// pinned thread its age while the band's own label already said pinned. A pinned row that is SPINNING
// shows no age, as in the Running band: it has not come to rest.
test("the Pinned band dates its resting rows and leaves a spinning one undated", async () => {
  const [{ MemoryRouter }, { Sidebar }, { store }] = await Promise.all([
    import("react-router"),
    import("./Sidebar.tsx"),
    import("../store.ts"),
  ])
  // The band is ordered by pin instant, oldest first, so the resting row is pinned first.
  const resting = { ...base, id: "launch-checklist", title: "Launch checklist", pinnedAt: ago(10 * 24 * 60 * 60_000), lastAssistantAt: ago(3 * 60 * 60_000) }
  const spinning = { ...base, id: "draft-the-changelog", title: "Draft the changelog", pinnedAt: ago(9 * 24 * 60 * 60_000), needsYou: false, runtime: "running", lastActivityAt: ago(60_000) }
  // QUEUED with live work out (isActivelyRunning is true of it): it holds a card and wears the queue's
  // glyph, not a spinner, so it is dated as the cue would date it.
  const queuedBusy = { ...base, id: "answer-the-schema-question", title: "Answer the schema question", pinnedAt: ago(8 * 24 * 60 * 60_000), awaitingBackground: true, lastActivityAt: ago(40 * 60_000) }
  store.board = { projectDir: "/fixture", threads: [resting, spinning, queuedBusy] } as unknown as typeof store.board
  const html = renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(MemoryRouter, null, createElement(Sidebar))),
    ),
  )
  const restingRow = html.slice(html.indexOf('data-sidebar-item="launch-checklist"'), html.indexOf('data-sidebar-item="draft-the-changelog"'))
  assert.match(restingRow, /data-rail-rested-age[^>]*>3h</)
  const spinningRow = html.slice(html.indexOf('data-sidebar-item="draft-the-changelog"'), html.indexOf('data-sidebar-item="answer-the-schema-question"'))
  assert.match(spinningRow, /data-rail-glyph="working"/)
  assert.doesNotMatch(spinningRow, /data-rail-rested-age/)
  const queuedBusyRow = html.slice(html.indexOf('data-sidebar-item="answer-the-schema-question"'))
  assert.match(queuedBusyRow, /data-rail-rested-age[^>]*>40m</)
})
