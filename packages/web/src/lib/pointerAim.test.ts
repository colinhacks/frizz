import assert from "node:assert/strict"
import test from "node:test"
import { extendTrail, headingInto, REST_MS, trailHeadingInto, TRAIL_MS } from "./pointerAim.ts"

// The panel the line of op counts opens: 440px wide, 35px tall, standing 4px over the counts.
const PANEL = { left: 429, right: 869, top: 223, bottom: 258 }

test("a shallow line from a count to the far end of its panel is still heading into it", () => {
  // From the middle of "1 link" toward the row's label, 300px left and only 32px up: the line that
  // crosses two other counts on its way, which is where the panel used to be taken away.
  const from = { x: 839, y: 272 }
  const label = { x: 530, y: 240 }
  const step = (t: number) => ({ x: from.x + (label.x - from.x) * t, y: from.y + (label.y - from.y) * t })
  assert.equal(headingInto(from, step(0.1), PANEL), true)
  assert.equal(headingInto(step(0.1), step(0.2), PANEL), true)
  assert.equal(headingInto(step(0.2), step(0.3), PANEL), true)
})

test("a pointer that has already reached the panel's box is heading into it", () => {
  assert.equal(headingInto({ x: 700, y: 259 }, { x: 680, y: 257 }, PANEL), true)
})

test("straight up from a count is heading into its panel", () => {
  assert.equal(headingInto({ x: 600, y: 272 }, { x: 600, y: 262 }, PANEL), true)
})

test("sliding along the line of counts is not: that is the operator choosing a different one", () => {
  assert.equal(headingInto({ x: 839, y: 272 }, { x: 760, y: 272 }, PANEL), false)
  assert.equal(headingInto({ x: 500, y: 272 }, { x: 600, y: 272 }, PANEL), false)
})

test("moving away from the panel is not", () => {
  assert.equal(headingInto({ x: 600, y: 272 }, { x: 600, y: 290 }, PANEL), false)
  assert.equal(headingInto({ x: 600, y: 272 }, { x: 560, y: 285 }, PANEL), false)
})

test("a pointer past the panel's end, rising past it, is not", () => {
  assert.equal(headingInto({ x: 880, y: 272 }, { x: 900, y: 262 }, PANEL), false)
})

test("a resting hand is not an aim", () => {
  assert.equal(headingInto({ x: 600, y: 272 }, { x: 601, y: 271 }, PANEL), false)
})

test("a panel the collision logic flipped under its count reads the same way, upside down", () => {
  const below = { left: 429, right: 869, top: 290, bottom: 325 }
  assert.equal(headingInto({ x: 839, y: 272 }, { x: 800, y: 280 }, below), true)
  assert.equal(headingInto({ x: 839, y: 272 }, { x: 800, y: 260 }, below), false)
})

test("the trail reads the recent move, and a pointer that stopped reads as stopped", () => {
  let trail = extendTrail([], { x: 839, y: 272, at: 1000 })
  assert.equal(trailHeadingInto(trail, 1000, PANEL), false, "one sample is no direction")
  trail = extendTrail(trail, { x: 800, y: 268, at: 1020 })
  trail = extendTrail(trail, { x: 760, y: 264, at: 1040 })
  assert.equal(trailHeadingInto(trail, 1050, PANEL), true)
  assert.equal(trailHeadingInto(trail, 1040 + REST_MS - 1, PANEL), true, "a hesitation is not a stop")
  assert.equal(trailHeadingInto(trail, 1040 + REST_MS + 1, PANEL), false, "nothing recent: it has stopped")
  assert.equal(trailHeadingInto([], 1040, PANEL), false)
})

test("a trail that turned reads the way it is going now, not where it came from", () => {
  // Down from over the panel onto a count, then straight off along a shallow line for the panel's far end.
  const panel = { left: 233, right: 709, top: 314, bottom: 399 }
  const trail = [
    { x: 454, y: 277, at: 1000 },
    { x: 680, y: 415, at: 1008 },
    { x: 667, y: 413, at: 1130 },
    { x: 655, y: 411, at: 1150 },
  ]
  assert.equal(trailHeadingInto(trail, 1150, panel), true)
})

test("the trail ages out, but moves a busy page hands over far apart still read as a direction", () => {
  let trail = extendTrail([], { x: 839, y: 272, at: 1000 })
  trail = extendTrail(trail, { x: 800, y: 268, at: 1000 + TRAIL_MS * 3 })
  assert.equal(trail.length, 2, "the sample before the new one stays, however old")
  assert.equal(trailHeadingInto(trail, 1000 + TRAIL_MS * 3, PANEL), true)
  trail = extendTrail(trail, { x: 790, y: 267, at: 1000 + TRAIL_MS * 3 + 20 })
  assert.equal(trail[0]?.x, 800, "with a recent one to go on, the old one drops")
})
