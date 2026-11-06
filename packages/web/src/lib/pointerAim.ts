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

// How far back "where the pointer just was" reaches, and how long a pointer sits before it counts as
// having stopped. Long enough to ride out a hand's small hesitation partway across and a single jittery
// event, short enough that a deliberate hover on a neighbouring count still wins at once.
export const TRAIL_MS = 150

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
  const from = trail[0]
  const to = trail[trail.length - 1]
  return from !== undefined && to !== undefined && from !== to && now - to.at <= TRAIL_MS && headingInto(from, to, panel)
}
