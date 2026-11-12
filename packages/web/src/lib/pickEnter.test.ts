import { test } from "node:test"
import assert from "node:assert/strict"
import { pickEnterStep } from "./pickEnter.ts"

// THE ENTER A PICK ARMS (lib/pickEnter): one keystroke long, and it sends only where nothing else answers
// Enter. Whether the focus survived the pick is the browser's half, pinned by questionPickEnter.e2e.test.ts.

const key = (overrides: Partial<Parameters<typeof pickEnterStep>[0]> = {}) => ({
  key: "Enter", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, ...overrides,
})
const lost = { keepsOwnEnter: false, surfaceGone: false }

test("Enter after a pick sends from where a replaced card's focus lands", () => {
  assert.equal(pickEnterStep(key(), lost), "send")
  assert.equal(pickEnterStep(key({ metaKey: true }), lost), "send", "⌘⏎ is the same send, as it is on the options themselves")
  assert.equal(pickEnterStep(key({ ctrlKey: true }), lost), "send")
})

test("an element with an Enter of its own keeps it, and the arm is spent", () => {
  assert.equal(pickEnterStep(key(), { keepsOwnEnter: true, surfaceGone: false }), "spend")
})

test("a pick in a thread no longer on screen sends nothing", () => {
  assert.equal(pickEnterStep(key(), { keepsOwnEnter: false, surfaceGone: true }), "spend")
})

test("any other key spends the arm; a bare modifier on its way to a chord does not", () => {
  for (const other of ["j", "ArrowDown", "Tab", "Escape", " "]) assert.equal(pickEnterStep(key({ key: other }), lost), "spend", other)
  for (const modifier of ["Shift", "Meta", "Control", "Alt"]) assert.equal(pickEnterStep(key({ key: modifier }), lost), "keep", modifier)
})

test("newline chords, IME confirmations, repeats and handled keys never send", () => {
  assert.equal(pickEnterStep(key({ shiftKey: true }), lost), "spend")
  assert.equal(pickEnterStep(key({ altKey: true }), lost), "spend")
  assert.equal(pickEnterStep(key({ isComposing: true }), lost), "spend")
  assert.equal(pickEnterStep(key({ keyCode: 229 }), lost), "spend")
  assert.equal(pickEnterStep(key({ repeat: true }), lost), "spend")
  assert.equal(pickEnterStep(key({ defaultPrevented: true }), lost), "spend")
})
