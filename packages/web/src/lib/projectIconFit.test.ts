import assert from "node:assert/strict"
import test from "node:test"
import { iconFillsTile } from "./projectIconFit.ts"

const PLATE = [255, 255, 255, 255]
const CLEAR = [0, 0, 0, 0]

test("a near-square picture that is its own plate fills the tile", () => {
  assert.equal(iconFillsTile(372, 368, PLATE), true)
  // A rounded plate's corner samples come back a little under opaque.
  assert.equal(iconFillsTile(512, 512, [239, 247, 247, 253]), true)
})

test("a letterboxed logo is contained, whatever its corners", () => {
  assert.equal(iconFillsTile(300, 331, PLATE), false)
})

// open-knowledge's favicon.svg: a 78x80 speech bubble on a transparent canvas whose outline reaches
// the canvas's top and left. Filled, the tile cut that outline flat.
test("a near-square free-standing mark is contained, not cropped", () => {
  assert.equal(iconFillsTile(78, 80, CLEAR), false)
  assert.equal(iconFillsTile(512, 512, [0, 122, 0, 0]), false)
})

test("unreadable pixels fall back to squareness alone", () => {
  assert.equal(iconFillsTile(78, 80, undefined), true)
  assert.equal(iconFillsTile(300, 331, undefined), false)
})

test("a picture with no size never fills", () => {
  assert.equal(iconFillsTile(0, 0, PLATE), false)
})
