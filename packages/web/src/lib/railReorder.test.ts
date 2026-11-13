import assert from "node:assert/strict"
import { test } from "node:test"
import { cellShift, clampToSlots, dropIndex, edgeScrollVelocity, heldStep, moveItem, nearestCell, nearestSlot, RAIL_STEP_PX, rowNeighbour, shiftFor } from "./railReorder.ts"

test("moveItem moves in both directions, and `to` is read against the post-removal list", () => {
  const list = ["a", "b", "c", "d"]
  assert.deepEqual(moveItem(list, 0, 2), ["b", "c", "a", "d"])
  assert.deepEqual(moveItem(list, 3, 1), ["a", "d", "b", "c"])
  assert.deepEqual(moveItem(list, 0, 3), ["b", "c", "d", "a"])
  // Non-moves and out-of-range are the identity, never a throw: a drop can land where it started.
  assert.deepEqual(moveItem(list, 1, 1), list)
  assert.deepEqual(moveItem(list, -1, 2), list)
  assert.deepEqual(moveItem(list, 0, 9), list)
  assert.deepEqual(list, ["a", "b", "c", "d"], "the input is not mutated")
})

test("the drop swaps at the HALFWAY point, not when a square fully clears its neighbour", () => {
  // Just under half a step is still the original slot; just over it has taken the next one.
  assert.equal(dropIndex(2, RAIL_STEP_PX * 0.49, 6), 2)
  assert.equal(dropIndex(2, RAIL_STEP_PX * 0.51, 6), 3)
  assert.equal(dropIndex(2, -RAIL_STEP_PX * 0.51, 6), 1)
  assert.equal(dropIndex(2, RAIL_STEP_PX * 2, 6), 4)
})

test("a drag past either end lands at the end rather than off the list", () => {
  assert.equal(dropIndex(1, -RAIL_STEP_PX * 40, 6), 0)
  assert.equal(dropIndex(1, RAIL_STEP_PX * 40, 6), 5)
})

test("only the squares between the two slots move, and they move exactly one step", () => {
  // Dragging index 1 down to 3: 2 and 3 slide UP into the gap, 0 and 4 do not move at all.
  assert.equal(shiftFor(0, 1, 3), 0)
  assert.equal(shiftFor(1, 1, 3), 0, "the held square is positioned by its own delta, not shifted")
  assert.equal(shiftFor(2, 1, 3), -RAIL_STEP_PX)
  assert.equal(shiftFor(3, 1, 3), -RAIL_STEP_PX)
  assert.equal(shiftFor(4, 1, 3), 0)

  // Dragging 3 up to 1: 1 and 2 slide DOWN.
  assert.equal(shiftFor(0, 3, 1), 0)
  assert.equal(shiftFor(1, 3, 1), RAIL_STEP_PX)
  assert.equal(shiftFor(2, 3, 1), RAIL_STEP_PX)
  assert.equal(shiftFor(3, 3, 1), 0)

  // A drag that has not changed slots moves nothing.
  for (const i of [0, 1, 2, 3]) assert.equal(shiftFor(i, 2, 2), 0)
})

test("edge auto-scroll engages only inside the zone, ramps with depth, and is signed", () => {
  const bounds = { top: 100, bottom: 500 }
  assert.equal(edgeScrollVelocity(300, bounds), 0, "the middle of the band does not scroll")
  assert.equal(edgeScrollVelocity(150, bounds), 0, "just outside the zone does not scroll")
  assert.ok(edgeScrollVelocity(110, bounds) < 0, "near the top scrolls up")
  assert.ok(edgeScrollVelocity(490, bounds) > 0, "near the bottom scrolls down")
  // Deeper into the zone is faster, and it is capped.
  assert.ok(Math.abs(edgeScrollVelocity(102, bounds)) > Math.abs(edgeScrollVelocity(130, bounds)))
  assert.ok(Math.abs(edgeScrollVelocity(-500, bounds)) <= 14)
})

// THE PINNED BAND'S ROWS ARE NOT ONE HEIGHT: a two-line title, or a thread with live sub-agents under it.
// Three rows: a 40px one, then two of 20px, touching (the band's rows draw no gap between them).
const ROWS = [{ top: 100, height: 40 }, { top: 140, height: 20 }, { top: 160, height: 20 }]

test("nearestSlot is dropIndex when the rows are one height", () => {
  const uniform = Array.from({ length: 6 }, (_, i) => ({ top: i * RAIL_STEP_PX, height: RAIL_STEP_PX - 8 }))
  for (const delta of [-500, -60, -25, -23, 0, 23, 25, 60, 100, 500]) {
    assert.equal(nearestSlot(uniform, 2, delta), dropIndex(2, delta, 6), `delta ${delta}`)
  }
})

test("nearestSlot swaps a tall row past a short one halfway between their centres", () => {
  // The 40px row's centre is 120 and the next row's is 150: the swap is at 135, a 15px drag.
  assert.equal(nearestSlot(ROWS, 0, 14), 0)
  assert.equal(nearestSlot(ROWS, 0, 16), 1)
  // ...and the short row going up passes it at the same midpoint, from the other side.
  assert.equal(nearestSlot(ROWS, 1, -14), 1)
  assert.equal(nearestSlot(ROWS, 1, -16), 0)
  assert.equal(nearestSlot(ROWS, 0, 900), 2, "past the end lands on the last slot")
})

test("the held row stays inside the band, and its neighbours shift by its height", () => {
  assert.equal(clampToSlots(ROWS, 0, -30), 0, "the top row cannot rise above the band")
  assert.equal(clampToSlots(ROWS, 0, 99), 40, "…nor sink past the last row's bottom")
  assert.equal(clampToSlots(ROWS, 2, -99), -60)
  assert.equal(clampToSlots(ROWS, 1, 7), 7, "inside the band the pointer is followed exactly")
  assert.equal(heldStep(ROWS, 0), 40)
  assert.equal(heldStep(ROWS, 2), 20)
  assert.equal(heldStep([{ top: 0, height: 20 }, { top: 24, height: 30 }], 1), 34, "a gap between rows is part of the step")
})

// THE HOME GRID'S TILES WRAP: three across, 112px tiles 8px apart, rows 124px apart — so the next slot
// after the end of a row is the start of the row below.
const CELLS = Array.from({ length: 7 }, (_, i) => ({ left: (i % 3) * 120, top: Math.floor(i / 3) * 124, width: 112, height: 100 }))

test("nearestCell follows the held tile in both directions, across rows", () => {
  assert.equal(nearestCell(CELLS, 0, 0, 0), 0, "a tile held still stays where it is")
  assert.equal(nearestCell(CELLS, 0, 55, 0), 0, "under half a cell sideways is still home")
  assert.equal(nearestCell(CELLS, 0, 65, 0), 1)
  assert.equal(nearestCell(CELLS, 0, 0, 124), 3, "straight down is the cell below, not the next one along")
  assert.equal(nearestCell(CELLS, 4, -120, -124), 0)
  assert.equal(nearestCell(CELLS, 0, 2000, 2000), 6, "out past the short last row lands last, not at the end of the row above")
  assert.equal(nearestCell(CELLS, 0, 2000, 0), 2, "past a row's end lands at that row's end")
  assert.equal(nearestCell(CELLS, 6, 0, -2000), 0, "above the grid lands in the first row")
})

test("cellShift slides the tiles between the two cells one place, wrapping at a row's end", () => {
  // Dragging 1 to 4: 2 moves left, 3 moves up to the end of the row above, 4 moves left.
  assert.deepEqual(cellShift(CELLS, 2, 1, 4), { x: -120, y: 0 })
  assert.deepEqual(cellShift(CELLS, 3, 1, 4), { x: 240, y: -124 })
  assert.deepEqual(cellShift(CELLS, 4, 1, 4), { x: -120, y: 0 })
  assert.deepEqual(cellShift(CELLS, 0, 1, 4), { x: 0, y: 0 }, "a tile outside the span does not move")
  assert.deepEqual(cellShift(CELLS, 5, 1, 4), { x: 0, y: 0 })
  assert.deepEqual(cellShift(CELLS, 1, 1, 4), { x: 0, y: 0 }, "the held tile is placed by its own delta")
  // Dragging 4 back to 1: 1 and 3 move along one, and 2 wraps down to the start of the next row.
  assert.deepEqual(cellShift(CELLS, 1, 4, 1), { x: 120, y: 0 })
  assert.deepEqual(cellShift(CELLS, 2, 4, 1), { x: -240, y: 124 })
  assert.deepEqual(cellShift(CELLS, 3, 4, 1), { x: 120, y: 0 })
  for (const i of [0, 1, 2, 3]) assert.deepEqual(cellShift(CELLS, i, 2, 2), { x: 0, y: 0 }, "a drag that has not changed cells moves nothing")
})

test("rowNeighbour is the cell straight above or below, and the edge rows stay put", () => {
  assert.equal(rowNeighbour(CELLS, 4, -1), 1)
  assert.equal(rowNeighbour(CELLS, 4, 1), 6, "a short row below gives its nearest cell")
  assert.equal(rowNeighbour(CELLS, 1, -1), 1, "nothing above the top row")
  assert.equal(rowNeighbour(CELLS, 6, 1), 6, "nothing below the bottom row")
  assert.equal(rowNeighbour(CELLS, 6, -1), 3)
})
