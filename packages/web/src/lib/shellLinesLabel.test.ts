import assert from "node:assert/strict"
import test from "node:test"
import { monitorEventsLabel, shellLinesLabel } from "./childOps.ts"

// The live counter on a background shell row. Its one real design decision is that ZERO is a reading
// and not an absence — see the note above shellLinesLabel — so that is what most of this pins.

test("zero is a real reading, not a missing one", () => {
  assert.equal(shellLinesLabel(0), "0 lines", "a silent watcher is exactly what this counter exists to expose")
})

test("one line is singular", () => {
  assert.equal(shellLinesLabel(1), "1 line")
})

test("a busy shell reads by magnitude, not by digits", () => {
  assert.equal(shellLinesLabel(947), "947 lines")
  assert.equal(shellLinesLabel(13_476), "13.5k lines")
  assert.equal(shellLinesLabel(132_000), "132k lines")
  assert.equal(shellLinesLabel(2_400_000), "2.4M lines")
})

test("no number ⇒ no reading — a shell whose output frizz cannot read shows nothing", () => {
  assert.equal(shellLinesLabel(undefined), undefined)
  assert.equal(shellLinesLabel(Number.NaN), undefined)
  assert.equal(shellLinesLabel(-1), undefined)
})

// A Claude Code Monitor's row counts the events it delivered, on the same terms: zero is a reading.
test("a Monitor's counter reads in events", () => {
  assert.equal(monitorEventsLabel(0), "0 events")
  assert.equal(monitorEventsLabel(1), "1 event")
  assert.equal(monitorEventsLabel(10), "10 events")
  assert.equal(monitorEventsLabel(undefined), undefined)
})
