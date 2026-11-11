import assert from "node:assert/strict"
import test from "node:test"
import { readerPinIndex } from "./readerPin.ts"

// The two readings the hold rests on: WHEN the list changed in a way that can move the reader, and
// WHICH item the reader is in. The browser half — that putting the item back holds the page, with and
// without native anchoring — is pinned in queueRailSettle.e2e.test.ts.

test("the reader is in the card with the most of itself on screen", () => {
  // A 900px window. The first card's last 40px, then the second filling the rest.
  assert.equal(readerPinIndex([{ top: -1000, bottom: 40 }, { top: 120, bottom: 1300 }], 0, 900), 1)
  // Mostly the first card, the second just starting below it.
  assert.equal(readerPinIndex([{ top: -200, bottom: 700 }, { top: 780, bottom: 1900 }], 0, 900), 0)
  // One card taller than the window, read from its middle.
  assert.equal(readerPinIndex([{ top: -3000, bottom: 2000 }], 0, 900), 0)
})

test("among equal rows it is the first wholly under the header, and nothing on screen is no pin", () => {
  // 65px phone rows under a 101px fixed header: the row half behind the header loses to the next one.
  const rows = [36, 101, 166, 231].map((top) => ({ top, bottom: top + 65 }))
  assert.equal(readerPinIndex(rows, 101, 844), 1)
  assert.equal(readerPinIndex([{ top: -500, bottom: -10 }, { top: 950, bottom: 1500 }], 0, 900), -1)
  assert.equal(readerPinIndex([], 0, 900), -1)
})
