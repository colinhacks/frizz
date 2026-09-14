import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { isBadgeRelease, PANEL_ARROW_GEOMETRY, RestartActionButton, RestartFailureNotice, UPDATE_RESTART_ICON_ROTATION, UpdateRestartPopover } from "./RestartFrizzButton.tsx"

test("Update Frizz presents one calm sentence whose highlight is that threads are untouched", () => {
  const html = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: true }))
  assert.match(html, /Update Frizz/)
  assert.equal((html.match(/<button/g) ?? []).length, 0)
  assert.match(html, /Install the latest version of Frizz\. Your running threads will not be affected\./)
  // A single body paragraph — no divider, no second "stays in place" line, no stray emphasis block.
  assert.equal((html.match(/<p /g) ?? []).length, 1)
  assert.doesNotMatch(html, /stay in place/)
  assert.match(html, /font-sans/)
})

// The registry launcher is the only one that can name versions, so the version line and the specific
// "newer version" sentence appear exactly when it does — frizz-dev and legacy supervisors render the
// same popover they always have (the versionless assertions above and below pin that).
test("a registry launcher's update popover names both versions and says a newer one exists", () => {
  const html = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: true, version: "0.4.2", updateVersion: "0.5.0" }))
  assert.match(html, /Update Frizz/)
  // Identifiers, not prose: the line stays mono whatever the board font is set to.
  assert.match(html, /font-mono[^"]*"[^>]*>0\.4\.2 → 0\.5\.0</)
  assert.match(html, /A newer version of Frizz is available\. Your running threads will not be affected\./)
  assert.doesNotMatch(html, /Install the latest version of Frizz/)
  // Still a single body paragraph — the version line rides in the header, not as a second <p>.
  assert.equal((html.match(/<p /g) ?? []).length, 1)
})

test("the popover shows only the application version, not launcher diagnostics", () => {
  const status = {
    version: "0.13.1",
    launcherVersion: "0.13.0",
    updateVersion: "0.13.2",
  }
  for (const update of [true, false]) {
    const html = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update, ...status }))
    assert.match(html, update ? />0\.13\.1 → 0\.13\.2</ : />0\.13\.1</)
    assert.doesNotMatch(html, /Server |Launcher |0\.13\.0/)
  }
})

test("an up-to-date registry install still shows what version it is running", () => {
  const html = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: false, version: "0.4.2" }))
  assert.match(html, /Restart Frizz\. Your running threads will not be affected\./)
  assert.match(html, />0\.4\.2</)
  assert.doesNotMatch(html, /→/)
})

test("a registry probe that has not answered keeps the generic update copy", () => {
  // The launcher starts update-optimistic but versionless; claiming a number here would be a lie.
  const html = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: true, version: "0.4.2" }))
  assert.match(html, /Install the latest version of Frizz\. Your running threads will not be affected\./)
  assert.match(html, />0\.4\.2</)
  assert.doesNotMatch(html, /→/)
})

test("Update and restart keeps its clockwise arrow treatment", () => {
  assert.equal(UPDATE_RESTART_ICON_ROTATION, "clockwise")
  const html = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: true }))
  assert.match(html, /lucide-refresh-cw/)
  assert.match(html, /role="tooltip"/)
})

test("Update and restart is one compact icon-only action with an accessible name", () => {
  const html = renderToStaticMarkup(createElement(RestartActionButton, { update: true, busy: false, onClick: () => undefined }))
  assert.match(html, /aria-label="Update Frizz"/)
  // Sized by STATUS_ROW_ACTION — it shares the prompt box's status row with the settings gear, and
  // the two must carry identical weight (this was a lone 32px corner button before the row existed).
  assert.match(html, /h-6 w-6/)
  assert.match(html, /lucide-refresh-cw/)
  assert.doesNotMatch(html, />\s*Update Frizz\s*</)
  assert.doesNotMatch(html, /cursor-wait/)
})

// Patch updates remain one click away, but the passive yellow interruption is reserved for a new
// release line. Before 1.0 that means the next minor, e.g. 0.4.x -> 0.5.0.
test("the button wears an update dot only for a new release line", () => {
  const badged = renderToStaticMarkup(createElement(RestartActionButton, { update: true, busy: false, version: "0.4.2", updateVersion: "0.5.0", onClick: () => undefined }))
  assert.match(badged, /bg-accent/)
  for (const [name, props] of [
    ["frizz-dev's version-less update mode", { update: true, busy: false }],
    ["an up-to-date registry install", { update: false, busy: false }],
    ["a routine patch update", { update: true, busy: false, version: "0.4.2", updateVersion: "0.4.3" }],
    ["an update already in flight", { update: true, busy: true, version: "0.4.2", updateVersion: "0.5.0" }],
  ] as [string, { update: boolean; busy: boolean; version?: string; updateVersion?: string }][]) {
    const html = renderToStaticMarkup(createElement(RestartActionButton, { ...props, onClick: () => undefined }))
    assert.doesNotMatch(html, /bg-accent/, name)
  }
})

test("release-line comparison handles pre-1.0 minors, majors, and unknown versions", () => {
  assert.equal(isBadgeRelease("0.4.2", "0.5.0"), true)
  assert.equal(isBadgeRelease("0.4.2", "1.0.0"), true)
  assert.equal(isBadgeRelease("1.8.4", "2.0.0"), true)
  assert.equal(isBadgeRelease("0.4.2", "0.4.3"), false)
  assert.equal(isBadgeRelease("v0.4.2", "v0.5.0"), true)
  assert.equal(isBadgeRelease("checkout", "0.5.0"), false)
})

test("busy Update and restart keeps only the clockwise spinner inside the button", () => {
  const html = renderToStaticMarkup(createElement(RestartActionButton, { update: true, busy: true, onClick: () => undefined }))
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /animate-spin/)
  assert.equal((html.match(/<svg/g) ?? []).length, 1)
  assert.doesNotMatch(html, /Updating…|Restarting…/)
})

test("legacy supervisors present an ordinary restart action instead of hiding the control", () => {
  const html = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: false }))
  assert.match(html, /Restart Frizz/)
  assert.match(html, /Restart Frizz\. Your running threads will not be affected\./)
  assert.equal((html.match(/<p /g) ?? []).length, 1)
  assert.doesNotMatch(html, /latest version of Frizz/)
})

const supervisorLog =
  "Command failed: nub run typecheck from /Users/x/.frizz/builds/.source-snapshot-31038-bc7e214d\n" +
  "src/groups.ts(440,27): error TS2304: Cannot find name 'restedQueueHandoff'."

// The whole point of the panel: it hangs over the sidebar list and the composer, so anything
// see-through renders the one message the user needs illegible. Both panels ride the SAME opaque
// card, and neither may carry a tinted-transparent fill.
test("the failure panel is an opaque card, never a translucent tint over the board", () => {
  const html = renderToStaticMarkup(
    createElement(RestartFailureNotice, { update: true, message: supervisorLog, onDismiss: () => undefined }),
  )
  const surface = html.match(/role="alert" class="([^"]*)"/)?.[1] ?? ""
  assert.ok(surface.includes("bg-elevated"), `alert surface must be opaque, got: ${surface}`)
  assert.ok(!/\bbg-(?!elevated\b)/.test(surface), `alert surface carries a non-elevated fill: ${surface}`)
  // Same opaque treatment as the popover it replaces — one card, two states.
  const popover = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: true }))
  for (const shared of ["bg-elevated", "shadow-xl", "rounded-xl"]) assert.ok(popover.includes(shared) && html.includes(shared), shared)
})

test("the supervisor's build log is contained, not spilled down the board", () => {
  const html = renderToStaticMarkup(
    createElement(RestartFailureNotice, { update: true, message: supervisorLog, onDismiss: () => undefined }),
  )
  assert.match(html, /Update failed/)
  assert.match(html, /Frizz kept running the previous version, and your threads are unaffected\./)
  // Raw build output reads as a terminal excerpt in a height-capped, scrolling mono block, so a
  // several-hundred-character stderr dump can't stretch the card down over the thread list.
  const pre = html.match(/<pre class="([^"]*)"/)?.[1] ?? ""
  assert.ok(pre.includes("font-mono"), pre)
  assert.ok(pre.includes("max-h-64") && pre.includes("overflow-y-auto"), pre)
  assert.ok(pre.includes("whitespace-pre-wrap") && pre.includes("break-words"), pre)
  assert.match(html, /error TS2304/)
})

// Finding 11 (audit 2026-09-11). After a successful handoff the SUCCESSOR's proxy answers the polls, so
// a "failed" from its child boot is the new version failing — and the previous one is already gone.
// The panel used to say it kept running regardless; now the sentence follows the outcome App/button
// judge from the failed answer's version against the version at click (api/restart.ts).
test("a successor that came up and then failed is named, not reported as the previous version kept", () => {
  const html = renderToStaticMarkup(
    createElement(RestartFailureNotice, { update: true, message: "control plane stopped (exit 1) before ready", outcome: { kind: "successor-failed", version: "0.5.0" }, onDismiss: () => undefined }),
  )
  assert.match(html, /Update failed/)
  assert.match(html, /Frizz 0\.5\.0 came up but could not start its board, and the previous version is gone\./)
  assert.match(html, /npx frizz/)
  assert.doesNotMatch(html, /kept running the previous version/)
  // The supervisor's own reason still rides in the log block underneath.
  assert.match(html, /control plane stopped \(exit 1\) before ready/)

  // Without an outcome the panel keeps its old sentence — the click-handler's own catch (a POST the
  // running server rejected) and the fixture both render it that way.
  const kept = renderToStaticMarkup(
    createElement(RestartFailureNotice, { update: true, message: "boom", outcome: { kind: "previous-kept" }, onDismiss: () => undefined }),
  )
  assert.match(kept, /Frizz kept running the previous version, and your threads are unaffected\./)
})

test("a failure can be dismissed, and a legacy restart names itself correctly", () => {
  const html = renderToStaticMarkup(
    createElement(RestartFailureNotice, { update: false, message: "boom", onDismiss: () => undefined }),
  )
  assert.match(html, /Restart failed/)
  assert.doesNotMatch(html, /Update failed/)
  assert.match(html, /aria-label="Dismiss"/)
})

/**
 * The arrow is the one piece of this control whose correctness is pure arithmetic, and it was wrong
 * for as long as it existed: `left-1.5` put the tent's left foot 4.51px from the card's edge, 7.5px
 * INSIDE its own 12px corner arc, so the leg grew out of the curve instead of off a flat border and
 * the corner read as bent. Pin the RELATIONSHIPS rather than the class literals — a future re-guess
 * that lands somewhere plausible-looking still has to satisfy these three.
 */
test("the panel arrow clears the card's corner arc, sits on its top border, and points at the mark", () => {
  const g = PANEL_ARROW_GEOMETRY
  const half = (g.square * Math.SQRT2) / 2
  // The apex is the square's own centre, measured from the panel's border-box left edge: an absolute
  // offset starts at the padding edge, so the border adds back in.
  const apex = g.border + g.left + g.square / 2

  // 1. The base sits on a FLAT run of border — both feet are `half` either side of the apex.
  //    Browser-measured at 14.51px against a 12px arc (scripts/shot.mjs, dsf 8, 2026-08-26).
  const foot = apex - half
  assert.ok(foot > g.radius, `arrow foot lands ${foot}px in, inside the ${g.radius}px corner arc`)

  // 2. The square's CENTRE is on the panel's border-box top, so its opaque fill covers the top border
  //    between the feet. One px lower and that border paints across the base as a spur at each foot.
  assert.equal(g.top + g.border + g.square / 2, 0)

  // 3. The apex is on the mark the card hangs off — the button's glyph centre. This is what the
  //    panel's own negative left offset is for; it aligns the card's edge with nothing.
  assert.equal(g.panelLeft + g.border + g.left + g.square / 2, g.markCentre)
})

test("both panels hang one identical arrow off one shared constant, differing only in tone", () => {
  const arrow = (html: string) => html.match(/<span aria-hidden="true" class="([^"]*)"/)?.[1] ?? ""
  const popover = arrow(renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: true })))
  const failure = arrow(
    renderToStaticMarkup(createElement(RestartFailureNotice, { update: true, message: "boom", onDismiss: () => undefined })),
  )
  assert.ok(popover.length > 0 && failure.length > 0)
  assert.equal(popover.replace(" border-border-strong", ""), failure.replace(" border-danger-fill/45", ""))

  // The utilities the numbers above claim to describe. Three chevrons in this app once drifted into
  // two offsets and two tones by being placed one call site at a time; this is the same guard.
  const g = PANEL_ARROW_GEOMETRY
  assert.ok(popover.includes(`-top-[${-g.top}px]`), popover)
  assert.ok(popover.includes(`left-${g.left / 4}`), popover)
  assert.ok(popover.includes(`h-${g.square / 4} w-${g.square / 4}`) && popover.includes("rotate-45"), popover)
})

test("the panel's left offset is the arrow's, not an edge alignment", () => {
  const g = PANEL_ARROW_GEOMETRY
  const panel = (html: string) => html.match(/<div id="update-restart-popover"[^>]*class="([^"]*)"/)?.[1] ?? ""
  const html = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: true }))
  assert.ok(panel(html).includes(`sm:-left-[${-g.panelLeft}px]`), panel(html))
  // rounded-xl IS the radius the arithmetic above clears; a smaller card corner would free the arrow.
  assert.ok(panel(html).includes("rounded-xl"), panel(html))
})
