// THE shared rounded-rect checkbox geometry — the ONE outer shape every rail status glyph sits in, and
// the shape the in-progress spinner traces. Lives in its own module because BOTH the sidebar's
// top-level row indicator and the indented child-operation row (ChildOpRow, "rail" density) draw it;
// keeping it in Sidebar.tsx would make the child row import its own parent.
export const STATUS_BOX = 15

// [/] IN PROGRESS — the rounded-RECT spinner: a faint full outline with a bright segment travelling the
// perimeter (matches the checkbox shape instead of a circle — maintainer 2026-07-10). `size` lets the
// indented sub-agent rows use a smaller one so the two spinners stay the same SHAPE at different scales.
export function BoxSpinner({ size = STATUS_BOX }: { size?: number }) {
  // Geometry MUST match StatusBox exactly (maintainer 2026-07-10: the spinner read "slightly smaller
  // and bolder"). StatusBox is a 15px border-box with a 1px border and rounded-[4px] corners, so the
  // border's outer edge sits at 0/15. To replicate that with a center-drawn SVG stroke: strokeWidth 1,
  // inset the path by 0.5 (x=0.5, w=14) so the stroke's outer edge lands on the box edge, and rx=3.5
  // (4px outer radius minus the 0.5 half-stroke). Perimeter of that rounded rect ≈ 50, so the dash sum
  // stays 50. The faint base outline is toned to the checkbox's border-muted/45 weight.
  return (
    <svg width={size} height={size} viewBox="0 0 15 15" aria-hidden className="text-muted-85">
      <rect x="0.5" y="0.5" width="14" height="14" rx="3.5" fill="none" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1" />
      <rect x="0.5" y="0.5" width="14" height="14" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeDasharray="11 39">
        <animate attributeName="stroke-dashoffset" from="50" to="0" dur="1.1s" repeatCount="indefinite" />
      </rect>
    </svg>
  )
}
