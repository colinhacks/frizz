import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { StateButton, ThreadLifecycleActions } from "./ThreadLifecycle.tsx"
import { prefs } from "../lib/prefs.ts"
import { ThreadHeaderFacts } from "./ThreadHeaderFacts.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// A COMPLETED thread used to render no lifecycle controls at all, which left its full view with nothing
// anywhere that said the thread was finished — just a title, an activity stamp and a composer
// (maintainer 2026-07-29, on a /full page: "why does this not have a footer with the mark as done
// button?"). The cluster now stays and STATES the state. These assertions pin both halves of that: the
// readout appears, and the verbs it replaces do not come back on a thread that cannot take them. The
// cluster was a footer strip under the prompt box until 2026-10-05; it closes the header's action
// strip now, as a bare alarm clock and a bare check.

const base = {
  kind: "session",
  backend: "claude",
  title: "A worker",
  status: "active",
  runtime: "turn-idle",
  subAgents: [],
  foreign: false,
} as unknown as ThreadView

function render(element: typeof ThreadLifecycleActions | typeof ThreadHeaderFacts, extra: Partial<ThreadView>): string {
  const thread = { ...base, id: "t", ...extra } as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(element as typeof ThreadHeaderFacts, { thread })),
    ),
  )
}
const actions = (extra: Partial<ThreadView>) => render(ThreadLifecycleActions, extra)
const facts = (extra: Partial<ThreadView>) => render(ThreadHeaderFacts, extra)

const CLUSTER = /data-thread-lifecycle(?!-)/
const DONE_READOUT = /data-thread-done/
const MARK_AS_DONE = /aria-label="Mark as done"/
const SNOOZE = /aria-label="Snooze"/

test("a done thread keeps its lifecycle cluster and reads Done where the verbs were", () => {
  for (const [name, extra] of [
    ["state column", { state: "archived", archived: true }],
    ["legacy flag only (rolling reload)", { archived: true }],
  ] as [string, Partial<ThreadView>][]) {
    const html = actions(extra)
    assert.match(html, CLUSTER, `a done thread (${name}) still renders the cluster`)
    assert.match(html, DONE_READOUT, `a done thread (${name}) states that it is done`)
    assert.doesNotMatch(html, MARK_AS_DONE, `a done thread (${name}) cannot be marked done again`)
    assert.doesNotMatch(html, SNOOZE, `a done thread (${name}) cannot be snoozed — the server rejects it`)
  }
})

test("an open thread keeps the verbs — bare icons, named for the screen reader — and says nothing about being done", () => {
  const html = actions({ state: "open", archived: false })
  assert.match(html, CLUSTER)
  assert.match(html, MARK_AS_DONE)
  assert.match(html, SNOOZE)
  assert.doesNotMatch(html, DONE_READOUT)
  // The names live in aria-label and the hover tooltip, not on the surface: the cluster draws no words.
  assert.doesNotMatch(html.replace(/<[^>]*>/g, ""), /Mark as done|Snooze/, "the verbs are icons, not labelled buttons")
})

// What Done does to a pin is a per-browser choice: the header check names it, and the done card's copy
// is a split button whose caret holds the choice — but only on a pinned thread, the one it can change.
test("the header check names the pin choice; the done card splits only on a pinned thread", () => {
  const pinned = { state: "open", pinnedAt: "2026-10-01T09:00:00.000Z" } as Partial<ThreadView>
  const card = (extra: Partial<ThreadView>) =>
    renderToStaticMarkup(createElement(TooltipProvider, null, createElement(StateButton, { thread: { ...base, id: "t", ...extra } as ThreadView, pinChoice: "bg-fg" })))
  assert.match(actions(pinned), MARK_AS_DONE, "the default keeps the pin, so the check reads plain")
  assert.match(card(pinned), /data-done-split-menu/, "a pinned thread's card offers the caret")
  assert.doesNotMatch(card({ state: "open" }), /data-done-split/, "an unpinned thread has nothing to choose")
  prefs.doneUnpins = true
  try {
    assert.match(actions(pinned), /aria-label="Mark as done &amp; unpin"/)
    assert.match(card(pinned), />Mark as done &amp; unpin<\/button>/, "the label names the ticked row")
    assert.match(actions({ state: "open" }), MARK_AS_DONE, "an unpinned thread's check is unchanged")
  } finally {
    prefs.doneUnpins = false
  }
})

// The readout asserts a completion frizz itself recorded. A foreign/legacy thread has no such record,
// so it gets no cluster at all rather than a "Done" frizz cannot vouch for.
test("an unowned thread gets no cluster, done-looking or not", () => {
  for (const extra of [
    { foreign: true },
    { foreign: true, state: "archived", archived: true },
    { kind: "legacy" },
    { kind: "legacy", state: "archived", archived: true },
  ] as Partial<ThreadView>[]) {
    assert.equal(actions(extra), "")
  }
})

// The context reading moved out of the lifecycle cluster into the header's line of facts, which renders
// for every thread — so a DONE thread still reads its context, as it did when the reading lived in the
// footer a done thread kept.
test("the header line reads the context beside Last active, done or not", () => {
  for (const extra of [{ state: "open" }, { state: "archived", archived: true }] as Partial<ThreadView>[]) {
    const html = facts({ ...extra, lastActivityAt: new Date(Date.now() - 120_000).toISOString(), context: { tokens: 348_950, window: 1_000_000 } })
    assert.match(html, /<time[^>]*>[^<]+<\/time>/, "Last active leads the line")
    assert.match(html, /data-context-percent="34"/)
    assert.match(html, />34% context</)
  }
})

test("the header line draws no separator and no reading when there is no context", () => {
  const html = facts({ lastActivityAt: new Date(Date.now() - 120_000).toISOString() })
  assert.doesNotMatch(html, /·/)
  assert.doesNotMatch(html, /data-context-meter/)
})
