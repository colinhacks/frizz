import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { SUPERVISOR_STATUS_KEY } from "../api/supervisorStatus.ts"
import { anchoredPanelPlacement, isBadgeRelease, PANEL_ARROW_GEOMETRY, showsUpdateBadge, RestartActionButton, RestartFailureNotice, RestartFrizzButton, UPDATE_RESTART_ICON_ROTATION, UpdateRestartPopover } from "./RestartFrizzButton.tsx"

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

// The phone board's gear (MobileBoard.tsx) is a passive mark on a control that is not the update, so it
// follows the desktop button's dot rule exactly: frizz-server ships patches most days.
test("a passive update mark lights only for a new release line the supervisor can install", () => {
  assert.equal(showsUpdateBadge({ updateRestart: true, updateAvailable: true, version: "0.13.8", updateVersion: "0.14.0" }), true)
  for (const [name, status] of [
    ["a routine patch", { updateRestart: true, updateAvailable: true, version: "0.13.8", updateVersion: "0.13.9" }],
    ["frizz-dev, which names no version", { updateRestart: true }],
    ["an up-to-date install", { updateRestart: true, updateAvailable: false, version: "0.14.0" }],
    ["a supervisor with no update verb", { updateAvailable: true, version: "0.13.8", updateVersion: "0.14.0" }],
    ["no supervisor", null],
  ] as [string, Parameters<typeof showsUpdateBadge>[0]][]) {
    assert.equal(showsUpdateBadge(status), false, name)
  }
})

test("the phone's failure card renders inline under its row, without the desktop anchor or arrow", () => {
  const html = renderToStaticMarkup(createElement(RestartFailureNotice, { mobile: true, update: true, message: "boom", onDismiss: () => undefined }))
  const surface = html.match(/role="alert" class="([^"]*)"/)?.[1] ?? ""
  // The phone Settings page's 18px gutter, in flow: nothing fixed, absolute or `sm:`-anchored.
  assert.match(surface, /\bmx-\[18px\]/)
  assert.doesNotMatch(surface, /\bfixed\b|\babsolute\b|sm:/)
  assert.doesNotMatch(html, /rotate-45/)
  assert.match(html, /Update failed/)
  assert.match(html, /aria-label="Dismiss"/)
})

test("busy Update and restart keeps only the clockwise spinner inside the button", () => {
  const html = renderToStaticMarkup(createElement(RestartActionButton, { update: true, busy: true, onClick: () => undefined }))
  assert.match(html, /aria-busy="true"/)
  assert.match(html, /animate-spin/)
  assert.equal((html.match(/<svg/g) ?? []).length, 1)
  assert.doesNotMatch(html, /Updating…|Restarting…/)
})

// Rendered over a seeded status query, the way StatusRow mounts it: the control is live only while
// there is something to install, and greyed otherwise (maintainer 2026-09-25). frizz-dev omits
// `updateAvailable` and can always rebuild from source, so it keeps a live button.
test("the restart control is live only when there is an update to install, and greyed otherwise", () => {
  const render = (status: Record<string, unknown> | null) => {
    const client = new QueryClient()
    client.setQueryData(SUPERVISOR_STATUS_KEY, status && { protocol: 1, state: "ready", requestedAt: Date.now(), ...status })
    return renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(RestartFrizzButton)))
  }
  const greyed = (html: string) => /aria-disabled="true"/.test(html) && /pointer-events-none opacity-40/.test(html)
  for (const live of [render({ updateRestart: true, updateAvailable: true, version: "0.4.2", updateVersion: "0.5.0" }), render({ updateRestart: true })]) {
    assert.match(live, /aria-label="Update Frizz"/)
    assert.equal(greyed(live), false)
  }
  for (const current of [render({ updateRestart: true, updateAvailable: false, version: "0.5.0" }), render({})]) {
    assert.match(current, /aria-label="Frizz is up to date"/)
    assert.equal(greyed(current), true)
    assert.doesNotMatch(current, /Restart Frizz/)
  }
  assert.equal(render(null), "", "nothing before a supervisor has answered")
})

test("the greyed control's popover says there is nothing to install, not a verb", () => {
  const html = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: false, current: true, version: "0.5.0" }))
  assert.match(html, /Frizz is up to date/)
  assert.match(html, /font-mono[^"]*"[^>]*>0\.5\.0</)
  assert.match(html, /There is no newer version of Frizz to install\./)
  assert.doesNotMatch(html, /Restart Frizz|Update Frizz/)
})

// The launcher went back from 0.5.1 and no longer offers it, so the control is greyed exactly as when
// up to date. Its popover must not say there is nothing newer: there is, and it did not stay up.
test("the greyed control's popover says an update was undone, and which, once the launcher went back from one", () => {
  const html = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: false, current: true, version: "0.5.0", rejected: "0.5.1" }))
  assert.match(html, /aria-label="Update undone"/)
  assert.match(html, /font-mono[^"]*"[^>]*>0\.5\.0</)
  assert.match(html, /Frizz 0\.5\.1 kept stopping after it was installed, so 0\.5\.0 is running again\. The next version will be offered here\./)
  assert.doesNotMatch(html, /up to date|no newer version|Restart Frizz|Update Frizz/)
  assert.equal((html.match(/<p /g) ?? []).length, 1)
  const button = renderToStaticMarkup(createElement(RestartActionButton, { update: false, busy: false, current: true, rejected: "0.5.1", onClick: () => undefined }))
  assert.match(button, /aria-label="Update undone"/)
  assert.match(button, /aria-disabled="true"/)
  // Once something newer still is offered, the popover is the ordinary offer again.
  const offered = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: true, version: "0.5.0", updateVersion: "0.5.2", rejected: "0.5.1" }))
  assert.match(offered, /Update Frizz/)
  assert.doesNotMatch(offered, /undone|kept stopping/)
})

// The launcher is the one part of Frizz the Update button cannot replace, and nothing told a running
// board that a newer one existed. The popover says how to get it, under whatever else it says.
test("the popover says a newer launcher exists, and how to get it, in every state", () => {
  const sentence = /The npx frizz command has a newer version, 0\.13\.2\. Stop Frizz and run npx frizz again to get it\./
  for (const state of [{ update: true, version: "0.5.0", updateVersion: "0.5.1" }, { update: false, current: true, version: "0.5.0" }, { update: false, current: true, version: "0.5.0", rejected: "0.5.1" }]) {
    const html = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, ...state, launcherUpdate: "0.13.2" }))
    assert.match(html, sentence)
    assert.equal((html.match(/<p /g) ?? []).length, 2, "its own paragraph, under the state's sentence")
    const without = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, ...state }))
    assert.doesNotMatch(without, /npx frizz/)
    assert.equal((without.match(/<p /g) ?? []).length, 1)
  }
})

// The greyed button offers no verb; this plain-restart spelling survives only for a failure card that
// stays on screen after an answer flips `updateAvailable` off.
test("the plain restart popover names itself as a restart, not an update", () => {
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
  // The arrow follows the anchor's shift back onto the mark (anchoredPanelPlacement).
  assert.ok(popover.includes("translate-x-[var(--panel-shift,0px)]"), popover)
})

test("the panel's left offset is the arrow's, not an edge alignment", () => {
  const g = PANEL_ARROW_GEOMETRY
  const panel = (html: string) => html.match(/<div id="update-restart-popover"[^>]*class="([^"]*)"/)?.[1] ?? ""
  const html = renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: true }))
  assert.deepEqual(anchoredPanelPlacement({ left: 542.5, bottom: 76 }, 368, 1440), { left: 542.5 + g.panelLeft, top: "calc(76px + 0.65rem)", shift: 0 })
  // The stacked layout's full-width sidebar puts the button near the right edge (710px of 760, measured):
  // the card slides left to fit with a 12px margin, and the arrow slides back so its apex stays on the mark.
  const shifted = anchoredPanelPlacement({ left: 710, bottom: 60 }, 368, 760)
  assert.equal(shifted.left + 368, 760 - 12)
  assert.equal(shifted.left + g.border + g.left + g.square / 2 + shifted.shift, 710 + g.markCentre)
  // …and the shifted apex still lands on flat border, clear of the card's right-hand corner arc.
  assert.ok(368 - (g.border + g.left + g.square / 2 + shifted.shift) - (g.square * Math.SQRT2) / 2 > g.radius)
  // Never past the left margin, however narrow the window.
  assert.equal(anchoredPanelPlacement({ left: 100, bottom: 60 }, 544, 300).left, 12)
  // rounded-xl IS the radius the arithmetic above clears; a smaller card corner would free the arrow.
  assert.ok(panel(html).includes("rounded-xl"), panel(html))
  // The arrow measures from the PANEL's padding edge, so the panel has to be its containing block.
  assert.match(panel(html), /(^| )relative( |$)/)
})

// The sidebar column is sticky, and a sticky box is a stacking context whatever its z-index: a panel that
// stacked itself inside the status row ranked only against the sidebar, and spilled out UNDER the queue
// cards' sticky headers (maintainer 2026-10-30). Stacking is AnchoredPanel's job, done from <body>, so
// neither panel may carry a position-and-z of its own that would read as having solved it.
test("neither desktop panel stacks itself; both are lifted out of the sidebar by the anchor", () => {
  const surfaces = [
    renderToStaticMarkup(createElement(UpdateRestartPopover, { open: true, update: true })).match(/<div id="update-restart-popover"[^>]*class="([^"]*)"/)?.[1],
    renderToStaticMarkup(createElement(RestartFailureNotice, { update: true, message: "boom", onDismiss: () => undefined })).match(/role="alert" class="([^"]*)"/)?.[1],
  ]
  for (const surface of surfaces) {
    assert.ok(surface, "surface rendered")
    assert.doesNotMatch(surface, /(^| )(sm:)?(fixed|absolute)( |$)|(^| )(sm:)?z-/, surface)
  }
})
