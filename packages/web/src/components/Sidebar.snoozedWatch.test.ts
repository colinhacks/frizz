import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { ThreadRow, sessionIndicatorFor } from "./Sidebar.tsx"
import { TooltipProvider } from "./Tooltip.tsx"

// The HELD row's glyph when a PR is what the thread is actually waiting on (`prs:` since the 2026-08-24
// YAML cutover; `pr:` before it, and `pr-watch:` when this file was written). The rail's
// park mark is the hourglass — "parked on the clock" — and for a watch the clock is only a backstop:
// the scheduler polls the PR and clears the park the moment new activity lands, so GitHub is the real
// wake. These pin that a watching row wears GitHub's mark and that every OTHER park keeps the
// hourglass, since one glyph leaking into the other is exactly the confusion this fixed.
//
// A PR wait never parks ITSELF (groups.ts parkedAwaitingHint excludes it so a watch stays a visible
// queue handoff), so the rows under test are the ones that get parked anyway: one the human snoozed off
// the "PR watcher armed" card, and ones whose worker co-declared a SECOND item beside the watch. That
// second item used to be a `human:` gate; the 2026-08-15 grammar deleted the kind, so the fences below
// name a real item instead and the rule they pin — GitHub's mark wins over the hourglass — is unchanged.

const base = {
  kind: "session",
  backend: "claude",
  title: "Ship the resolver fix",
  status: "active",
  runtime: "turn-idle",
  needsYou: false,
  subAgents: [],
} as unknown as ThreadView

function row(extra: Partial<ThreadView>) {
  const t = { ...base, id: "watching-thread", ...extra } as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(ThreadRow, { t })),
    ),
  )
}

// lucide stamps its icon name onto the rendered <svg>, which is the only thing that separates these two
// marks in the markup — they are otherwise the same 9px glyph in the same status box.
const GITHUB = /lucide-github/
const HOURGLASS = /lucide-hourglass/
// The shell's live-work dot is not a lucide icon — it is a styled span (Sidebar.tsx shellDot), so its
// class is the handle. Deliberately the same mark the Active band's `background` row wears.
const SHELL_DOT = /frizz-rail-dot/

const FAR_FUTURE = "2999-01-01T00:00:00.000Z"
const watch = (value: string) => ({ kind: "pr" as const, value })

test("a PR-watching thread the human snoozed off its card wears GitHub's mark, not the hourglass", () => {
  const html = row({
    snoozedUntil: FAR_FUTURE,
    lastFence: { kind: "awaiting", body: "PR is open and CI is green.", hints: [watch("acme/app#391")] },
  } as Partial<ThreadView>)
  assert.match(html, GITHUB, "the row says what it is waiting on: the PR")
  assert.doesNotMatch(html, HOURGLASS, "…and never both marks at once")
})

test("a PR fence with a co-declared second item also wears GitHub's mark", () => {
  // This was the `human:`-gate case: the contract of the day told a worker to pair `human:` with
  // `pr-watch:` when a GitHub PR existed, and it was the `human:` hint that parked the thread. Both
  // kinds are retired; what the case still pins is that a fence naming a PR AND something else reaches
  // Snoozed wearing GitHub's mark, with no snooze at all.
  const html = row({
    lastFence: {
      kind: "awaiting",
      body: "Waiting on the maintainer.",
      hints: [watch("acme/app#391"), { kind: "shell", value: "maintainer must approve fork CI" }],
    },
  } as Partial<ThreadView>)
  assert.match(html, GITHUB)
  assert.doesNotMatch(html, HOURGLASS)
})

test("a PR fence with a co-declared timer backstop also wears GitHub's mark", () => {
  const html = row({
    lastFence: { kind: "awaiting", body: "Watching.", hints: [watch("acme/app#391"), { kind: "timer", value: FAR_FUTURE }] },
  } as Partial<ThreadView>)
  assert.match(html, GITHUB)
  assert.doesNotMatch(html, HOURGLASS)
})

// THE HOURGLASS IS NO LONGER THE GENERIC PARK MARK. It stood for every park that was not a watch, back
// when the fence's kinds were all "somebody will get to it eventually". The 2026-08-15 grammar names
// LIVE THINGS, so the glyph says which SHAPE is being waited on — a clock for a timer, the shell's blue
// dot for the thread's own background work — and the hourglass is left to the one park that really is
// just elapsed time: a user snooze. What they all still share is that none may borrow GitHub's mark,
// which is the confusion this file exists to prevent.
//
// The shell arm drew lucide's CircleDashed until 2026-08-31, when it became `shellDot` — the SAME mark
// the undimmed Active row wears while resting on that shell, because the running shell is one fact and
// the park is only how the row is presented (maintainer: "we use blue dots to represent background
// shells"). It is a class, not an svg, so it is matched on the class rather than a lucide icon name.
test("each park wears its own shape, and none of them borrows GitHub's mark", () => {
  const cases = [
    ["a bare user snooze, no fence", { snoozedUntil: FAR_FUTURE }, HOURGLASS],
    ["a snooze over a declared park", { snoozedUntil: FAR_FUTURE, lastFence: { kind: "awaiting", body: "", hints: [{ kind: "shell", value: "bzvtnt3ig" }] } }, HOURGLASS],
    ["a park on its own background work", { lastFence: { kind: "awaiting", body: "", hints: [{ kind: "shell", value: "bzvtnt3ig" }] } }, SHELL_DOT],
    ["a park on a timer", { lastFence: { kind: "awaiting", body: "", hints: [{ kind: "timer", value: "tmr_a1b2c3" }] } }, /lucide-clock/],
  ] as [string, Partial<ThreadView>, RegExp][]
  for (const [name, extra, mark] of cases) {
    const html = row(extra)
    assert.match(html, mark, `${name} wears its own mark`)
    assert.doesNotMatch(html, GITHUB, `…and ${name} must not claim a PR watch`)
  }
})

test("a usage-limit kill wears the YELLOW hourglass even when the fence carries a watch", () => {
  // The limit is what stopped this row — the fence's PR watch is a stale story from the rest BEFORE the
  // kill — so the mark names THAT: the "limit" kind's accent hourglass (2026-08-31; it was the muted
  // Snoozed hourglass before, which read as a calm park over a killed thread). The row is NOT dimmed
  // (isSnoozed refuses a limit kill) and carries the hover Retry beside the fullscreen door.
  const html = row({
    runtime: "exited",
    limitPause: { backend: "claude", window: "session", at: "2026-08-01T00:00:00.000Z", resumesAt: 32503680000, autoResume: true },
    lastFence: { kind: "awaiting", body: "PR is open.", hints: [watch("acme/app#391")] },
  } as unknown as Partial<ThreadView>)
  assert.match(html, HOURGLASS)
  assert.doesNotMatch(html, GITHUB)
  assert.match(html, /data-rail-glyph="limit"/, "the resolved kind is the limit mark, not snoozed")
  assert.match(html, /lucide-hourglass[^>]*text-accent/, "the hourglass wears the accent yellow")
  assert.doesNotMatch(html, /opacity-65/, "a limit kill is not dimmed like a snoozed row")
  assert.match(html, /data-sidebar-retry/, "the hover Retry rides the row")
})

// THE RESTING CARD'S EVENT-SNOOZE reaches Snoozed too (groups.ts isSnoozed, 2026-08-28), and it has no
// instant to name: the popover says what ends the park instead, in the words the card's own toast used.
// The tooltip body is not in static markup (Radix mounts it on hover), so the tip is read off
// sessionIndicatorFor, which is the same derivation the row renders.
test("a PR-watching thread event-snoozed off its resting card wears GitHub's mark and names its wake", () => {
  const t = {
    bgSnoozed: true,
    awaitingBackground: true,
    lastFence: { kind: "awaiting", body: "Approved, CI green.", hints: [watch("acme/app#391")] },
  } as Partial<ThreadView>
  const html = row(t)
  assert.match(html, GITHUB)
  assert.doesNotMatch(html, HOURGLASS)
  assert.equal(sessionIndicatorFor({ ...base, id: "watching-thread", ...t } as ThreadView).tip, "Snoozed until the background work returns — waiting on acme/app#391\n\nApproved, CI green.")
})

// The snoozed twin of the Active band's `background` row: same live vite dev server, same blue dot, and
// the ONLY differences are the dimmed band and a tooltip that names the park. Nothing here is on a
// clock, so the hourglass would be a lie about the wake, and the dashed circle it drew until 2026-08-31
// said merely "waiting on something" about the one state the rail already had a specific mark for.
test("a shell-only rest event-snoozed off its resting card keeps the shell's blue dot, not the hourglass", () => {
  const t = {
    bgSnoozed: true,
    awaitingBackground: true,
    bgShells: [{ label: "vite dev", startedAt: "2026-08-28T00:00:00.000Z", state: "running", id: "s1" }],
  } as Partial<ThreadView>
  const html = row(t)
  assert.match(html, SHELL_DOT)
  assert.doesNotMatch(html, HOURGLASS)
  assert.equal(sessionIndicatorFor({ ...base, id: "watching-thread", ...t } as ThreadView).tip, "Snoozed until the background work returns")
})

// ── the 2026-09-04 widening: the octocat belongs to the WAIT, not to the Snoozed band ───────────────
//
// Everything above tests a PARKED row, because until now the Snoozed band was the only place GitHub's
// mark could appear at all. That was the bug the maintainer reported: "it's kind of weird that this only
// shows up on a snoozed card … the GitHub icon should show up anytime that an agent is awaiting a PR".
// These pin the two shapes that used to miss it.

const armedWatch = (target: string) => [{
  id: `github:t:${target}`, kind: "github" as const, target, state: "armed" as const, createdAt: "2026-09-04T00:00:00.000Z",
}]

test("a QUEUED thread awaiting a PR wears GitHub's mark — no snooze involved", () => {
  // The common case by far: parkedAwaitingHint deliberately refuses to park a PR wait so the watch stays
  // a visible queue handoff, so MOST PR waits live here. This row wore the bare-rest ellipsis (checks
  // settled) or the shell's blue dot (checks running) before — never anything that said GitHub.
  const html = row({
    needsYou: true,
    lastFence: { kind: "awaiting", body: "CI is green; waiting on review.", hints: [watch("acme/app#391")] },
  } as Partial<ThreadView>)
  assert.match(html, GITHUB)
  assert.match(html, /data-rail-glyph="pr"/, "and it resolves to the PR kind, not rest or background")
  assert.doesNotMatch(html, HOURGLASS, "it is not parked on a clock")
  assert.doesNotMatch(html, SHELL_DOT, "and a PR is not this machine's own background work")
})

test("a REGISTERED watch with no fence at all still wears GitHub's mark", () => {
  // The shape the worker contract now steers toward — `mcp__frizz__watch_pr` creates the row the
  // scheduler polls, and the `prs:` fence line only echoes it. Reading the fence alone (which every arm
  // did before) meant a worker that registered a watch and then rested without fencing got the ellipsis.
  const html = row({ needsYou: true, watches: armedWatch("acme/app#391") } as Partial<ThreadView>)
  assert.match(html, GITHUB)
  assert.match(html, /data-rail-glyph="pr"/)
  // …and the same is true once the human snoozes that row: the Snoozed arm reads the registry too now,
  // so it no longer falls back to the hourglass just because there was no fence to read.
  const snoozed = row({ snoozedUntil: FAR_FUTURE, watches: armedWatch("acme/app#391") } as Partial<ThreadView>)
  assert.match(snoozed, GITHUB)
  assert.doesNotMatch(snoozed, HOURGLASS)
})
