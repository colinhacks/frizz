import { test } from "node:test"
import assert from "node:assert/strict"
import { monitorEventsText } from "./monitorEventsText.ts"

// Local wall-clock instants, so the day boundary is the test machine's own midnight. `en-US` pins the
// clock's spelling ("8:40:36 PM"); production passes no locale.
const at = (d: number, h: number, m: number, s: number) => new Date(2026, 9, d, h, m, s).toISOString()
const now = new Date(2026, 9, 22, 23, 0)

test("each event leads with its time, and a batch's later lines hang under its first", () => {
  const text = monitorEventsText([
    { text: "==> gates-fts5.log <==\npass  prepare  0s", at: at(22, 20, 40, 36) },
    { text: "pass  lab-sqlite  1s", at: at(22, 20, 40, 37) },
    { text: "pass  engine-tests  454s", at: at(22, 10, 5, 9) },
  ].sort((a, b) => a.at.localeCompare(b.at)), 0, now, "en-US")
  assert.equal(text, [
    "10:05:09 AM  pass  engine-tests  454s",
    " 8:40:36 PM  ==> gates-fts5.log <==",
    "             pass  prepare  0s",
    " 8:40:37 PM  pass  lab-sqlite  1s",
  ].join("\n"))
})

test("events from before today are grouped under a day line; all-today events carry none", () => {
  const text = monitorEventsText([
    { text: "first", at: at(21, 23, 59, 0) },
    { text: "second", at: at(22, 0, 1, 0) },
  ], 0, now, "en-US")
  assert.equal(text, ["Yesterday", "11:59:00 PM  first", "", "Today", "12:01:00 AM  second"].join("\n"))
})

test("the events the server let go are said once, at the top", () => {
  assert.equal(monitorEventsText([{ text: "late", at: at(22, 20, 0, 0) }], 37, now, "en-US"), ["37 earlier events were not kept.", "", "8:00:00 PM  late"].join("\n"))
  assert.match(monitorEventsText([{ text: "late", at: null }], 1, now, "en-US"), /^1 earlier event was not kept\./)
})

test("an event with no instant renders without a time column; none at all renders nothing", () => {
  assert.equal(monitorEventsText([{ text: "a\nb", at: null }], 0, now, "en-US"), "a\nb")
  assert.equal(monitorEventsText([], 0, now, "en-US"), "")
})
