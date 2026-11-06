// IS THE POINTER ON ITS WAY INTO THIS PANEL? The question a hover panel has to ask before it lets
// anything the pointer crosses take it away — the classic menu-aim triangle, from where the pointer just
// was to the two corners of the panel's near edge. A pointer inside that triangle is still closing on
// the panel, however shallow the line it is taking; one that has left it, or stopped, is not.
//
// Pure geometry plus a short trail, so the reading can be pinned without a browser. The driven proof that
// it does the job is queueOpsPanels.e2e.test.ts.

export interface PointerSample {
  x: number
  y: number
  /** `performance.now()` when the pointer was there. */
  at: number
}

export interface PanelRect {
  left: number
  right: number
  top: number
  bottom: number
}

// How far back "where the pointer just was" reaches: long enough that one jittery event cannot decide
// the direction.
export const TRAIL_MS = 150

// The stretch of the trail that says which way it is going now, in px. The whole trail will not do: a
// pointer that came down onto a count and set off for the panel within TRAIL_MS has its oldest sample up
// where it came from, and read from there it was heading away (10 failed paths of 24, driven). Short
// stretches will not do either: a shallow line rises a pixel in a dozen, and events land on whole pixels.
const STRETCH_PX = 24

// How long a pointer sits before it counts as having stopped. A hand slows and hesitates as it closes on
// a small target, and reading that as a choice is the bug this file answers, so this is a hover-intent's
// length rather than a frame's. Only a rising move that then rests on a neighbour waits it out, since a
// slide along the counts never reads as heading anywhere.
export const REST_MS = 250

// Under this, in px over the trail, the pointer has stopped: a hand resting on a mouse still reports a
// pixel or so, and that is not an aim.
const STILL_PX = 2

function side(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax)
}

/** The two corners of the edge of `panel` that faces `from`. Null once `from` is level with it on both axes. */
function nearEdge(from: { x: number; y: number }, panel: PanelRect): [number, number, number, number] | null {
  if (from.y >= panel.bottom) return [panel.left, panel.bottom, panel.right, panel.bottom]
  if (from.y <= panel.top) return [panel.left, panel.top, panel.right, panel.top]
  if (from.x <= panel.left) return [panel.left, panel.top, panel.left, panel.bottom]
  if (from.x >= panel.right) return [panel.right, panel.top, panel.right, panel.bottom]
  return null
}

/** Has the move from `from` to `to` stayed inside the triangle from `from` to the panel's near edge? */
export function headingInto(from: { x: number; y: number }, to: { x: number; y: number }, panel: PanelRect): boolean {
  if (Math.hypot(to.x - from.x, to.y - from.y) < STILL_PX) return false
  // Already over the panel's own box, whatever is drawn on top of it there, is as heading as it gets.
  if (to.x >= panel.left && to.x <= panel.right && to.y >= panel.top && to.y <= panel.bottom) return true
  const edge = nearEdge(from, panel)
  if (!edge) return false
  const [ax, ay, bx, by] = edge
  const d1 = side(from.x, from.y, ax, ay, to.x, to.y)
  const d2 = side(ax, ay, bx, by, to.x, to.y)
  const d3 = side(bx, by, from.x, from.y, to.x, to.y)
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNegative && hasPositive)
}

/** The trail with `sample` added, oldest first. It always keeps the sample before the new one, whatever
 *  its age: a busy page hands over moves far apart, and a direction takes two points. */
export function extendTrail(trail: readonly PointerSample[], sample: PointerSample): PointerSample[] {
  const recent = trail.filter((earlier) => sample.at - earlier.at <= TRAIL_MS)
  const last = trail[trail.length - 1]
  return recent.length > 0 ? [...recent, sample] : last ? [last, sample] : [sample]
}

/** Is the pointer, by its trail, heading into `panel` as of `now`? One that has not moved lately has stopped. */
export function trailHeadingInto(trail: readonly PointerSample[], now: number, panel: PanelRect): boolean {
  const to = trail[trail.length - 1]
  if (!to || trail.length < 2 || now - to.at > REST_MS) return false
  let from = trail[0]!
  for (let i = trail.length - 2; i >= 0; i--) {
    const earlier = trail[i]!
    if (Math.hypot(to.x - earlier.x, to.y - earlier.y) >= STRETCH_PX) {
      from = earlier
      break
    }
  }
  return headingInto(from, to, panel)
}
