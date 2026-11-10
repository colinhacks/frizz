import type { ReactNode } from "react"
import { pauseWhileOffscreen } from "../lib/offscreenPause.ts"

// THE shared rounded-rect checkbox geometry — the ONE outer shape every rail status glyph sits in, and
// the shape the in-progress spinner traces. Lives in its own module because BOTH the sidebar's
// top-level row indicator and the indented child-operation row (ChildOpRow, "rail" density) draw it;
// keeping it in Sidebar.tsx would make the child row import its own parent.
export const STATUS_BOX = 15

// [/] IN PROGRESS — the rounded-RECT spinner: a faint full outline with a bright segment travelling the
// perimeter (matches the checkbox shape instead of a circle — maintainer 2026-07-10). `size` lets the
// indented sub-agent rows use a smaller one so the two spinners stay the same SHAPE at different scales.
//
// SINCE 2026-09-20 THE SPINNER IS THE FRAME FOR EVERY "SOMETHING WILL WAKE THIS" ROW, and `children` is
// the mark inside it that says WHAT (maintainer 2026-09-19: "everything in the running rail should
// always have this spinner animation going"). Empty = this thread's own turn is running. The rail puts
// a solid blue dot inside for a rest on a live background shell, the ellipsis for a parent that has
// rested while its sub-agents are still out, and GitHub's octocat for a PR whose checks are running —
// the same glyphs the static StatusBox draws for the settled version of each state, so a row keeps its
// mark and only gains or loses the motion around it. The mark is centred over the SVG rather than drawn
// into it so it can be any element, including the CSS-sized `.frizz-rail-dot`.
export function BoxSpinner({ size = STATUS_BOX, children }: { size?: number; children?: ReactNode }) {
  // Geometry MUST match StatusBox exactly (maintainer 2026-07-10: the spinner read "slightly smaller
  // and bolder"). StatusBox is a 15px border-box with a 1px border and rounded-[4px] corners, so the
  // border's outer edge sits at 0/15. To replicate that with a center-drawn SVG stroke: strokeWidth 1,
  // inset the path by 0.5 (x=0.5, w=14) so the stroke's outer edge lands on the box edge, and rx=3.5
  // (4px outer radius minus the 0.5 half-stroke). Perimeter of that rounded rect ≈ 50, so the dash sum
  // stays 50. The faint base outline is toned to the checkbox's border-muted/45 weight.
  //
  // THE SEGMENT TRAVELS BY A CSS ANIMATION (`.frizz-box-spinner-lap`, styles.css), NOT SMIL. It was an
  // <animate> on stroke-dashoffset until 2026-11-09, the same motion (50 → 0, linear, 1.1s, forever), but
  // Chrome runs SMIL as a full style pass per frame and never stops it off screen: ten spinners cost an
  // idle page ~14% of a core on screen and ~12% scrolled away; the same ten as CSS cost ~9%, and 0 paused
  // off screen (pauseWhileOffscreen). `data-box-spinner` is the hook a test or script finds it by.
  const svg = (
    <svg ref={pauseWhileOffscreen} width={size} height={size} viewBox="0 0 15 15" aria-hidden className="block text-muted-85" data-box-spinner>
      <rect x="0.5" y="0.5" width="14" height="14" rx="3.5" fill="none" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1" />
      <rect x="0.5" y="0.5" width="14" height="14" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeDasharray="11 39" className="frizz-box-spinner-lap" />
    </svg>
  )
  if (children === undefined || children === null || children === false) return svg
  return (
    <span className="relative inline-block" style={{ width: size, height: size }}>
      {svg}
      {/* The same 13px content box StatusBox centres its glyph in: inset by the 1px stroke on every side,
          so a mark measured inside the static box lands on the identical pixels inside the spinning one. */}
      <span className="absolute inset-px flex items-center justify-center">{children}</span>
    </span>
  )
}
