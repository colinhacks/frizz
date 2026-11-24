import { test } from "node:test"
import assert from "node:assert/strict"
import { isDefaultEnter, ownsEnter } from "./dialogDefault.ts"

// ENTER PRESSES A DIALOG'S WHITE BUTTON wherever nothing else in it answers Enter (lib/dialogDefault). The
// wiring in ui/Dialog — the focus on open, the press — is the browser's half, pinned by
// dialogDefaultEnter.e2e.test.ts.

const key = (overrides: Partial<Parameters<typeof isDefaultEnter>[0]> = {}) => ({
  key: "Enter", altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, isComposing: false, ...overrides,
})

test("Enter and ⌘/Ctrl-Enter press the default; Shift, Option, an IME confirmation and a held key do not", () => {
  assert.equal(isDefaultEnter(key()), true)
  assert.equal(isDefaultEnter(key({ metaKey: true })), true)
  assert.equal(isDefaultEnter(key({ ctrlKey: true })), true)
  assert.equal(isDefaultEnter(key({ shiftKey: true })), false)
  assert.equal(isDefaultEnter(key({ altKey: true })), false)
  assert.equal(isDefaultEnter(key({ isComposing: true })), false)
  assert.equal(isDefaultEnter(key({ keyCode: 229 })), false, "WebKit's IME confirmation")
  assert.equal(isDefaultEnter(key({ repeat: true })), false)
  assert.equal(isDefaultEnter(key({ defaultPrevented: true })), false, "a text box that sent on it already")
  assert.equal(isDefaultEnter(key({ key: " " })), false)
})

test("what has an Enter of its own keeps it", () => {
  for (const tag of ["BUTTON", "A", "TEXTAREA", "SELECT", "SUMMARY"]) assert.equal(ownsEnter({ tag }), true, tag)
  assert.equal(ownsEnter({ tag: "INPUT", type: "text", inForm: true }), true, "a text field submits its form")
  assert.equal(ownsEnter({ tag: "INPUT", type: "datetime-local", inForm: true }), true)
  assert.equal(ownsEnter({ tag: "DIV", editable: true }), true)
  for (const role of ["button", "menuitem", "option", "combobox", "link"]) assert.equal(ownsEnter({ tag: "DIV", role }), true, role)
})

test("the dialog itself, its text, a checkbox and a field outside any form leave Enter to the default", () => {
  assert.equal(ownsEnter({ tag: "DIV", role: "dialog" }), false)
  assert.equal(ownsEnter({ tag: "P" }), false)
  assert.equal(ownsEnter({ tag: "INPUT", type: "checkbox", inForm: true }), false)
  assert.equal(ownsEnter({ tag: "INPUT", type: "radio", inForm: true }), false)
  assert.equal(ownsEnter({ tag: "INPUT", type: "text", inForm: false }), false)
})
