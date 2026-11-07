import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { HeaderActions } from "./HeaderActions.tsx"
import { TooltipProvider } from "./Tooltip.tsx"
import { store } from "../store.ts"
import { clearFullscreenOrigin, rememberFullscreenOrigin } from "../lib/fullscreenHandoff.ts"

// THE FULLSCREEN DOOR IS ONE SLOT, BOTH DIRECTIONS.
//
// The queue card's action strip carries the door OPENING (ExpandThreadLink, ⤢) and the /full page's
// header carries it CLOSING (CollapseThreadLink, ⤡) — and the whole point is that they stand in the
// SAME position in the same strip, so the icon that took the reader out of the queue is the icon that
// brings them back (maintainer 2026-09-02: "instead of a back arrow in the upper left, I think we
// should just have a collapse icon in the same place where the expand icon is in the cue card").
//
// Before that, /full's way out was an ArrowLeft sitting BEFORE THE TITLE, at the header's far left:
// a second, unrelated place to look for a whole-thread verb, and a "previous page" glyph on a control
// whose job is to change how this thread is SHOWN. So what is pinned here is the POSITION, not merely
// the presence of an icon — a future edit that keeps both halves but drifts one of them out of the
// slot loses the entire behaviour the request asked for.

// STALLED, so the strip's far-right verb (Retry) is on the other side of the door. Most of the strip
// gates itself away in a bare render — Restart worker wants a dev build and a live process, and simply
// returns null here — so a harness that does not deliberately put NEIGHBOURS on both sides of the door
// cannot tell a position apart from a presence. (It did not: moving the closing half to the head of
// the strip left every reading identical, and the first version of the slot test below passed the
// control that was meant to break it.)
const base = { kind: "session", backend: "claude", title: "A worker", status: "active", subAgents: [], runtime: "exited", crashed: true, needsYou: true } as unknown as ThreadView

// The strip's icons render eagerly and a couple of them read the query cache, so they need the client
// the app always provides — the same harness HeaderActions.retry.test.ts uses.
function strip(props: { expand?: boolean; collapse?: boolean }): string {
  const t = { ...base, id: "t" } as ThreadView
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) },
      createElement(TooltipProvider, null, createElement(HeaderActions, { thread: t, onDone: () => {}, onCollapse: () => {}, onDoc: () => {}, ...props })),
    ),
  )
}

/** The strip read left→right, as the reader sees it: one entry per control, named by its label. */
function controls(html: string): string[] {
  return [...html.matchAll(/aria-label="([^"]+)"/g)].map((m) => m[1])
}

test("the door's two halves occupy the SAME slot in the strip", () => {
  const opening = controls(strip({ expand: true }))
  const closing = controls(strip({ collapse: true }))

  assert.ok(opening.includes("Open fullscreen"), `the card's strip carries the door opening: ${opening.join(" · ")}`)
  assert.ok(closing.includes("Exit fullscreen"), `the /full strip carries the door closing: ${closing.join(" · ")}`)

  // The ONE assertion the maintainer's request lives in: with each half rewritten to the neutral name
  // of the affordance they share, the two strips are the same strip.
  const slot = (labels: string[]) => labels.map((l) => (l === "Open fullscreen" || l === "Exit fullscreen" ? "«the door»" : l))
  assert.deepEqual(slot(closing), slot(opening), "the collapse icon must stand exactly where the expand icon stands")
})

test("a surface offers ONE direction — never both, never neither by accident", () => {
  const both = controls(strip({ expand: true, collapse: true }))
  // Nothing stops a caller passing both, and if one ever does the strip would offer a reader on /full
  // a door back into /full. No surface does: the prop pair is documented as exclusive, and this pins
  // that the queue card and the /full page each pass exactly one.
  assert.equal(both.filter((l) => l === "Open fullscreen" || l === "Exit fullscreen").length, 2, "both props render both halves — so the surfaces, not the component, own the exclusivity")

  const neither = controls(strip({}))
  assert.ok(!neither.some((l) => l === "Open fullscreen" || l === "Exit fullscreen"), "the drawer header passes neither and mounts its own")
})

test("a COLD arrival at full screen leads back to THIS project's board", () => {
  const previous = store.board
  clearFullscreenOrigin()
  try {
    store.board = { projectSlug: "acme" } as typeof store.board
    assert.match(strip({ collapse: true }), /href="\/project\/acme"/, "a deep link, a bookmark or a reload has no surface to return to, so the queue is the destination")
  } finally {
    store.board = previous
    clearFullscreenOrigin()
  }
})

test("the collapse icon leads back to the surface the door was pressed in", () => {
  const previous = store.board
  try {
    store.board = { projectSlug: "acme" } as typeof store.board
    // A thread read through a DRAWER: the door was pressed at the drawer's own address, and that is
    // where leaving full screen has to land. The board ROOT mounts no drawer, so going there both strands the
    // reader and leaves the reverse view transition with nothing named `thread-chat` to shrink into —
    // measured as a hard cross-fade at every width from 767 to 2560 before this existed.
    rememberFullscreenOrigin("t", "/project/acme?thread=t")
    assert.match(strip({ collapse: true }), /href="\/project\/acme\?thread=t"/, "leaving full screen returns to the drawer it was opened from")

    // Keyed by slug, so a record left by another thread's door can never redirect this one.
    clearFullscreenOrigin()
    rememberFullscreenOrigin("someone-else", "/project/acme?thread=someone-else")
    assert.match(strip({ collapse: true }), /href="\/project\/acme"/, "another thread's origin is not this thread's way out")

    // A full-screen address is never remembered: the way out must not be a loop.
    for (const fullScreen of ["/project/acme/thread/t", "/project/acme/thread/t/full", "/thread/t?x=1"]) {
      clearFullscreenOrigin()
      rememberFullscreenOrigin("t", fullScreen)
      assert.match(strip({ collapse: true }), /href="\/project\/acme"/, `a full-screen origin (${fullScreen}) is refused, so the fallback stands`)
    }
  } finally {
    store.board = previous
    clearFullscreenOrigin()
  }
})

test("nothing is left standing before the title in the /full header", () => {
  const chatView = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
  // The arrow is gone from the header, and the file no longer imports the glyph at all — the surest
  // reading that no second exit crept back in beside the title. Matched on the JSX and the import
  // rather than the bare name, because the header's comment still tells the reader what used to stand
  // there and why it does not.
  assert.ok(!/<ArrowLeft\b/.test(chatView), "ThreadHeader must not render an ArrowLeft back button")
  assert.ok(!/^import .*\bArrowLeft\b.*from "lucide-react"/m.test(chatView), "and must not still import the glyph")
  assert.match(chatView, /collapse=\{showReturnToQueue\}/, "the /full page passes the closing half to HeaderActions instead")
})
