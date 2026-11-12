import assert from "node:assert/strict"
import test from "node:test"
import { parseStoredPrefs } from "./prefs.ts"

test("client preferences persist a validated snooze preset across reloads", () => {
  assert.equal(parseStoredPrefs(JSON.stringify({ snoozePreset: "3d" })).snoozePreset, "3d")
  assert.equal(parseStoredPrefs(JSON.stringify({ snoozePreset: "tomorrow" })).snoozePreset, "tomorrow")
})

test("missing, malformed, and stale snooze preferences fall back to one day", () => {
  assert.equal(parseStoredPrefs(null).snoozePreset, "1d")
  assert.equal(parseStoredPrefs("not-json").snoozePreset, "1d")
  assert.equal(parseStoredPrefs(JSON.stringify({ snoozePreset: "custom" })).snoozePreset, "1d")
})

test("queue order defaults to FIFO and only accepts fifo/lifo", () => {
  // Default (nothing stored / malformed) → fifo.
  assert.equal(parseStoredPrefs(null).queueOrder, "fifo")
  assert.equal(parseStoredPrefs("not-json").queueOrder, "fifo")
  // Both valid values round-trip; anything else falls back to fifo.
  assert.equal(parseStoredPrefs(JSON.stringify({ queueOrder: "lifo" })).queueOrder, "lifo")
  assert.equal(parseStoredPrefs(JSON.stringify({ queueOrder: "fifo" })).queueOrder, "fifo")
  assert.equal(parseStoredPrefs(JSON.stringify({ queueOrder: "sideways" })).queueOrder, "fifo")
})

test("dictation is on by default and only a stored boolean turns it off", () => {
  assert.equal(parseStoredPrefs(null).dictation, true)
  assert.equal(parseStoredPrefs("not-json").dictation, true)
  assert.equal(parseStoredPrefs(JSON.stringify({ dictation: false })).dictation, false)
  assert.equal(parseStoredPrefs(JSON.stringify({ dictation: "off" })).dictation, true)
})

test("code wraps by default and only a stored boolean turns it off", () => {
  assert.equal(parseStoredPrefs(null).wrapCode, true)
  assert.equal(parseStoredPrefs("not-json").wrapCode, true)
  // A blob stored before the setting existed carries no key, and reads as the default.
  assert.equal(parseStoredPrefs(JSON.stringify({ queueOrder: "lifo" })).wrapCode, true)
  assert.equal(parseStoredPrefs(JSON.stringify({ wrapCode: false })).wrapCode, false)
  assert.equal(parseStoredPrefs(JSON.stringify({ wrapCode: "off" })).wrapCode, true)
})

test("the rail's edited-files fold is open by default and only a boolean folds it", () => {
  assert.equal(parseStoredPrefs(null).railFilesCollapsed, false)
  assert.equal(parseStoredPrefs("not-json").railFilesCollapsed, false)
  assert.equal(parseStoredPrefs(JSON.stringify({ railFilesCollapsed: true })).railFilesCollapsed, true)
  assert.equal(parseStoredPrefs(JSON.stringify({ railFilesCollapsed: "yes" })).railFilesCollapsed, false)
})

// The Density switch is gone. A browser that stored it keeps every other choice, and the dead keys do
// not ride the spread back into the proxy (and so into localStorage on the next write).
test("a blob from before the Density switch was retired drops its keys and keeps the rest", () => {
  const prefs = parseStoredPrefs(JSON.stringify({ compactDiffs: false, diffsRedefaulted: true, queueOrder: "lifo", wrapCode: false }))
  assert.equal(prefs.queueOrder, "lifo")
  assert.equal(prefs.wrapCode, false)
  assert.ok(!("compactDiffs" in prefs))
  assert.ok(!("diffsRedefaulted" in prefs))
  assert.ok(!("compactDiffs" in parseStoredPrefs(null)))
})

test("Mark as done keeps a pin by default and only a stored boolean makes it unpin", () => {
  assert.equal(parseStoredPrefs(null).doneUnpins, false)
  assert.equal(parseStoredPrefs(JSON.stringify({ queueOrder: "lifo" })).doneUnpins, false)
  assert.equal(parseStoredPrefs(JSON.stringify({ doneUnpins: true })).doneUnpins, true)
  assert.equal(parseStoredPrefs(JSON.stringify({ doneUnpins: "yes" })).doneUnpins, false)
})
