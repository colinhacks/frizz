import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ChildOpRow, type ChildOpDensity, type ChildOpKind } from "./ChildOpRow.tsx"
import { CHILD_ARROW, CHILD_ARROW_CLASS, CHILD_STALE_DOT_CLASS, CHILD_STALE_TITLE } from "../lib/childOps.ts"

// The whole point of this component is that four surfaces stopped drawing their own version of one row.
// So the tests that matter are the CROSS-DENSITY ones: the arrow markup, the stale dot and the id-less
// policy must be byte-identical everywhere, while the deliberate density differences stay put.

const DENSITIES: ChildOpDensity[] = ["rail", "card", "sheet"]
// 12m30s, not 12m00s — the extra half minute is what makes this fixture deterministic.
//
// The row reads its clock from lib/liveClock.ts, whose `nowMs` is captured when THAT module loads and,
// with no subscriber to tick it, never moves again. This module body runs later, so the row measures
// `nowMs - (thisModuleLoad - 12min)` — twelve minutes MINUS however long the imports took. Exactly on
// the boundary that floors to "11m" the moment the gap exceeds one millisecond, which is why the full
// Windows suite failed five of these while the file passed on its own. Measured on macOS with a
// staged gap: 0ms renders "12m", 5ms already renders "11m". Half a minute of headroom absorbs it.
const TWELVE_MIN_AGO = new Date(Date.now() - 12 * 60_000 - 30_000).toISOString()

function render(props: {
  kind?: ChildOpKind
  label?: string
  state?: "running" | "stale"
  density: ChildOpDensity
  depth?: number
  startedAt?: string
  counter?: string
  counterTitle?: string
  parentSlug?: string
  onOpen?: () => void
  onDismiss?: () => void
  title?: string
}): string {
  return renderToStaticMarkup(createElement(ChildOpRow, {
    kind: props.kind ?? "AGENT",
    label: props.label ?? "Audit the drawer ops strip",
    state: props.state ?? "running",
    startedAt: props.startedAt,
    ...props,
  }))
}

const ARROW_SPAN = `<span aria-hidden="true" class="${CHILD_ARROW_CLASS}">${CHILD_ARROW}</span>`

test("every density renders the identical arrow span — one glyph, one alpha, one size", () => {
  for (const density of DENSITIES) {
    for (const state of ["running", "stale"] as const) {
      const html = render({ density, state })
      assert.ok(html.includes(ARROW_SPAN), `${density}/${state} must render the shared arrow span verbatim`)
      assert.equal(html.split(CHILD_ARROW).length - 1, 1, `${density}/${state} must render exactly one arrow`)
    }
  }
})

test("every density renders the identical stale dot for a quiet sub-agent", () => {
  const dot = `<span class="${CHILD_STALE_DOT_CLASS}" title="${CHILD_STALE_TITLE}"></span>`
  for (const density of DENSITIES) {
    assert.ok(render({ density, state: "stale" }).includes(dot), `${density} must render the shared stale dot`)
  }
})

test("an id-less child is a NON-INTERACTIVE row on every density — never disabled, never dropped", () => {
  for (const density of DENSITIES) {
    const html = render({ density })
    assert.doesNotMatch(html, /<button/, `${density} without onOpen must not render a button`)
    assert.doesNotMatch(html, /disabled/, `${density} without onOpen must not render a disabled control`)
    assert.match(html, /Audit the drawer ops strip/, `${density} without onOpen must still render the row`)
  }
})

test("a child with a drill-in is a real button carrying the open title and label", () => {
  for (const density of DENSITIES) {
    const html = render({ density, onOpen: () => {} })
    assert.match(html, /<button/)
    assert.match(html, /aria-label="Open sub-agent transcript: Audit the drawer ops strip"/)
  }
  assert.match(render({ density: "sheet", kind: "SHELL", onOpen: () => {} }), /aria-label="Open background shell output: Audit the drawer ops strip"/)
})

test("the rail keeps its checkbox spinner, its indent and its tooltip override", () => {
  const running = render({ density: "rail", onOpen: () => {}, parentSlug: "parent-thread", title: "[frizz:opus-high] Audit the drawer ops strip" })
  assert.match(running, /<svg /, "a running rail row uses the BoxSpinner, never the pulsing dot")
  assert.match(running, /pl-\[26px\]/)
  assert.match(running, /title="\[frizz:opus-high\] Audit the drawer ops strip"/)
  assert.match(running, /data-subagent-parent="parent-thread"/)
  // The rail is not an operations surface: no kind tag, no drill-in arrow.
  assert.doesNotMatch(running, /petite-caps/)
})

test("the card keeps the pulsing queue indicator and stays free of ops chrome", () => {
  const html = render({ density: "card", onOpen: () => {}, parentSlug: "parent-thread", startedAt: TWELVE_MIN_AGO })
  assert.match(html, /data-running-indicator="queue-subagent"/)
  assert.match(html, /frizz-live-dot--agent/)
  assert.match(html, /data-subagent-parent="parent-thread"/)
  assert.doesNotMatch(html, /petite-caps/, "a queue card names the work, it is not a second ops toolbar")
  assert.doesNotMatch(html, /<svg /, "the card must not borrow the rail's checkbox spinner")
})

test("the sheet is the operations row: kind tag, and NO second drill-in glyph beside the title", () => {
  const html = render({ density: "sheet", onOpen: () => {}, startedAt: TWELVE_MIN_AGO })
  assert.match(html, /data-running-indicator="operation"/)
  assert.match(html, /petite-caps[^"]*">AGENT</)
  // The ↗ hover glyph was deleted (maintainer 2026-07-27): the drill-in affordance is the TITLE, which
  // underlines on hover and IS the button, so the only icon a clickable ops row may draw is the ×.
  assert.doesNotMatch(html, /<svg /, "a clickable ops row draws no icon of its own")
  assert.match(render({ density: "sheet", onOpen: () => {}, onDismiss: () => {} }), /<svg /, "…the × is the one exception")
})

test("no density renders a model+effort tag — the profile lives on the prompt box's own control", () => {
  // Deleted 2026-07-27 (maintainer). ChildOpRow no longer even accepts `subagentType`; this pins that
  // no bracketed profile reading crept back in through the label or a tooltip.
  for (const density of DENSITIES) {
    const html = render({ density, onOpen: () => {}, onDismiss: density === "sheet" ? () => {} : undefined })
    assert.doesNotMatch(html, /data-agent-profile/, density)
    assert.doesNotMatch(html, /›/, `${density} must not render the model › effort separator`)
  }
})

// The readings group — everything right-justified at the end of the line. `ml-auto` is what pushes it
// there, and its `text-muted-40` is the one tone every reading inside it inherits.
function readings(html: string): string {
  const at = html.indexOf('class="ml-auto')
  assert.ok(at >= 0, "the row must render a right-justified readings group")
  return html.slice(at)
}

test("the working-duration reading is right-justified on every density", () => {
  for (const density of DENSITIES) {
    const html = render({ density, onOpen: () => {}, startedAt: TWELVE_MIN_AGO })
    assert.match(readings(html), /^class="ml-auto[^"]*">(?:<[^>]*>)*12m</, `${density} pushes the reading to the right edge`)
  }
})

test("the light-gray working-duration reading renders on every density, and only when reported", () => {
  for (const density of DENSITIES) {
    const withReading = render({ density, startedAt: TWELVE_MIN_AGO })
    // "12m" — how long the child has been WORKING, not how recently it was active: anything still
    // listed here is running or tracked-stale, so recency was near-zero information (maintainer 2026-07-28).
    assert.match(withReading, /\b12m\b/, `${density} must render the working-duration reading`)
    assert.match(readings(withReading), /^class="[^"]*text-muted-40/, `${density} reading must be the light-gray tone`)
    assert.match(withReading, /title="Working for 12m"/, `${density} reading carries the explicit tooltip`)
    // A child with no dispatch instant gets NO reading — never a fabricated "0s".
    // Assert the READING, not a bare duration shape: the spinner SVG carries dur="1.1s", so a loose
    // /\d+s/ matches the animation and the test passes for the wrong reason.
    assert.doesNotMatch(render({ density }), /title="Working for/, `${density} must omit the reading when absent`)
  }
})

// ── THE LIVE COUNTER — a second reading inside the right-hand group ──────────────────────────────

test("the counter sits LEFT of the duration, so the duration keeps the right edge it established", () => {
  const html = render({ density: "sheet", kind: "SHELL", counter: "142 lines", counterTitle: "Lines of output so far", startedAt: TWELVE_MIN_AGO })
  const group = readings(html)
  assert.ok(group.indexOf("142 lines") < group.indexOf("12m"), "counter → duration, never the other way round")
  assert.match(group, /·/, "the two readings are separated by the same middot the progress label uses")
  assert.match(html, /data-child-op-counter[^>]*title="Lines of output so far"/)
  // ONE tone for the whole group: the counter must not arrive as a second, louder gray.
  assert.equal(group.split("text-muted-40").length - 1, 1, "the tone lives once, on the group")
})

test("the counter stands alone when the row has no duration, and leaves no gap when absent", () => {
  const noDuration = render({ density: "sheet", kind: "SHELL", counter: "0 lines" })
  assert.match(readings(noDuration), /^class="ml-auto[^"]*">(?:<[^>]*>)*0 lines</, "a counter alone is still right-justified")
  assert.doesNotMatch(noDuration, /·/, "no duration ⇒ no separator dangling after the counter")
  // Every surface that does not poll for a counter renders exactly the row it always did.
  for (const density of DENSITIES) {
    assert.doesNotMatch(render({ density, startedAt: TWELVE_MIN_AGO }), /data-child-op-counter/, `${density} without a counter must not render the slot`)
  }
})

test("a quiet SHELL breathes instead of going flat, on the ops row", () => {
  const html = render({ density: "sheet", kind: "SHELL", state: "stale" })
  assert.match(html, /data-running-indicator="operation-quiet"/)
  assert.match(html, /title="running — no recent output"/)
  assert.doesNotMatch(html, new RegExp(CHILD_STALE_TITLE))
  assert.match(render({ density: "sheet", kind: "SHELL", state: "running" }), /frizz-live-dot--shell/)
})

test("the dismiss × exists only when onDismiss is supplied, and sits directly after the title", () => {
  const withX = render({ density: "sheet", onOpen: () => {}, onDismiss: () => {}, startedAt: TWELVE_MIN_AGO })
  assert.match(withX, /data-op-row/)
  assert.match(withX, /aria-label="Stop sub-agent: Audit the drawer ops strip"/)
  assert.match(withX, /title="Stop — end this operation and everything it spawned, then clear the row"/)
  // A SETTLED row's × says CLEAR, not stop — there is nothing running to stop, and it retires a
  // finished op from tracking. The word tracks the row's STATE, not its kind: a running row is only
  // ever given a × when the server said it is stoppable, so "stop" there always means it.
  const settled = render({ density: "sheet", state: "stale", onDismiss: () => {} })
  assert.match(settled, /aria-label="Clear sub-agent: Audit the drawer ops strip"/)
  assert.match(settled, /title="Clear — stop tracking this finished operation"/)
  const shell = render({ density: "sheet", kind: "SHELL", state: "stale", onDismiss: () => {} })
  assert.match(shell, /aria-label="Clear background shell: Audit the drawer ops strip"/)
  // ORDER is the point of the 2026-07-27 move: title → × → reading. At the far right, past the
  // reading, the × read as too subtle to find.
  const order = ["Audit the drawer ops strip", "Stop sub-agent", "Working for 12m"].map((needle) => withX.indexOf(needle))
  assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], `title → × → reading, got ${order}`)
  // …and it is visible at rest, not revealed by a hover the reader has to guess at.
  assert.doesNotMatch(withX, /opacity-0/)
  for (const density of DENSITIES) {
    assert.doesNotMatch(render({ density, onOpen: () => {} }), /data-op-row/, `${density} without onDismiss must not carry the × marker`)
  }
})

// ── THE × IS THE SAME CONTROL ON EVERY SURFACE (maintainer 2026-07-30) ──────────────────────────
//
// It used to render only at "sheet" density, so the rail and the queue card listed a phantom child
// with no way to retire it — you had to go find the one surface that had the control. Whether a row
// carries the × is now a property of the ROW (its caller decides, per lib/dismissChildOp.ts), never of
// the density. These pin that, and pin the structural constraint the rail's old shape violated.

test("every density renders the identical dismiss ×, in the same place on the line", () => {
  for (const density of DENSITIES) {
    const html = render({ density, onOpen: () => {}, onDismiss: () => {}, startedAt: TWELVE_MIN_AGO })
    assert.match(html, /data-op-row/, `${density} must mark itself as a row carrying the ×`)
    assert.match(html, /aria-label="Stop sub-agent: Audit the drawer ops strip"/, `${density} must render the × with the shared label`)
    assert.match(html, /title="Stop — end this operation and everything it spawned, then clear the row"/, `${density} × carries the shared tooltip`)
    assert.doesNotMatch(html, /opacity-0/, `${density} × is visible at rest, never hover-revealed`)
    // title → × → reading on every surface, the rail included: its duration used to ride INSIDE the
    // label button, which would have put the × on the far side of the reading.
    const order = ["Audit the drawer ops strip", "Stop sub-agent", "Working for 12m"].map((needle) => html.indexOf(needle))
    assert.ok(order.every((i) => i >= 0) && order[0] < order[1] && order[1] < order[2], `${density}: title → × → reading, got ${order}`)
  }
})

test("the × is a SIBLING of the drill-in button on every density — never a button inside a button", () => {
  // The rail used to BE the button (full-width, reading inside it). Nesting the × there would emit
  // invalid HTML that React hydrates into a broken tree, so the row grew a wrapper instead. Assert the
  // structure, not the styling: exactly two buttons, and the first one closed before the second opened.
  for (const density of DENSITIES) {
    const html = render({ density, onOpen: () => {}, onDismiss: () => {}, startedAt: TWELVE_MIN_AGO })
    assert.equal(html.split("<button").length - 1, 2, `${density} renders exactly the identity button and the ×`)
    const secondOpen = html.indexOf("<button", html.indexOf("<button") + 1)
    assert.ok(html.indexOf("</button>") < secondOpen, `${density} must close the identity button before opening the ×`)
  }
})

test("the rail's hover highlight moved to the wrapper; its 26px indent stayed on the drill-in", () => {
  // The highlight has to span the WHOLE row — including the × and the duration, which now sit outside
  // the button — so it moved to the wrapper. The indent did NOT: it is the gutter that clears the
  // parent row's indicator column and it has always been part of the click target, so it stays on the
  // identity element, still as padding (a margin would carve the highlight back on every nested row).
  const html = render({ density: "rail", onOpen: () => {}, onDismiss: () => {}, depth: 2, startedAt: TWELVE_MIN_AGO })
  const wrapper = html.slice(0, html.indexOf("<button"))
  assert.match(wrapper, /hover:bg-hover/, "the highlight is on the wrapper, so it spans the whole rail row")
  assert.doesNotMatch(wrapper, /pl-\[26px\]/, "the indent is not the wrapper's")
  assert.doesNotMatch(wrapper, /margin-left/)
  const identity = html.slice(html.indexOf("<button"))
  assert.match(identity, /pl-\[26px\]/, "the drill-in button carries the rail's indent")
  assert.match(identity, /style="padding-left:39px"/, "…and a nested row steps that padding, not a margin")
})

// ── NESTING: a sub-agent's own sub-agents ────────────────────────────────────────────────────────
//
// `depth` is the only thing that distinguishes a grandchild's row from a child's, so what it does to
// the row's box is the whole feature. It must step the row on every density and change nothing else.

test("depth steps the row right — the rail inside its padding, the prompt-box densities as a whole", () => {
  // Absent depth (and depth 1) render exactly as they did before nesting existed: no inline style.
  for (const density of DENSITIES) {
    assert.doesNotMatch(render({ density, onOpen: () => {} }), /style="/, `${density} at depth 1 must carry no indent style`)
    assert.doesNotMatch(render({ density, depth: 1, onOpen: () => {} }), /style="/, `${density} passed depth:1 explicitly is the same row`)
  }
  // The rail pads INSIDE the row so the full-width hover highlight still spans the rail; 26px is its
  // established indent, and each level adds one step.
  assert.match(render({ density: "rail", depth: 2, onOpen: () => {} }), /style="padding-left:39px"/)
  assert.match(render({ density: "rail", depth: 3, onOpen: () => {} }), /style="padding-left:52px"/)
  // The prompt-box densities shift the whole line, so the × and the duration reading travel with it.
  assert.match(render({ density: "sheet", depth: 2, onOpen: () => {} }), /style="margin-left:13px"/)
  assert.match(render({ density: "card", depth: 3, onOpen: () => {} }), /style="margin-left:26px"/)
  // A row that reports its nesting says so in the DOM, which is what a QA pass reads it back by.
  assert.match(render({ density: "rail", depth: 2, onOpen: () => {} }), /data-subagent-depth="2"/)
  assert.doesNotMatch(render({ density: "rail", onOpen: () => {} }), /data-subagent-depth/)
})

test("a runaway depth still renders a row — the indent clamps, the label never leaves the rail", () => {
  // `spawnDepth` comes off an unvalidated sidecar, so the row must degrade rather than push its label
  // off a narrow rail. Four steps is the cap, and depth 40 renders identically to depth 5.
  const clamped = render({ density: "rail", depth: 5, onOpen: () => {} })
  assert.match(clamped, /style="padding-left:78px"/)
  assert.equal(render({ density: "rail", depth: 40, onOpen: () => {} }), clamped.replace('data-subagent-depth="5"', 'data-subagent-depth="40"'))
})
