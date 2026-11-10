import assert from "node:assert/strict"
import test from "node:test"
import { focusToRestore } from "./restoreFocus.ts"

const body = { isConnected: true, name: "body" }
const on = (name: string) => ({ isConnected: true, name })
const gone = (name: string) => ({ isConnected: false, name })

test("a closed surface hands the focus back to what held it when it opened", () => {
  const settingsButton = on("settings button")
  assert.equal(focusToRestore([settingsButton], body, body), settingsButton)
  // A removed element leaves the document with no active element at all in some browsers.
  assert.equal(focusToRestore([settingsButton], null, body), settingsButton)
})

test("whatever took the focus while the surface closed keeps it", () => {
  // ⌘K picked a thread: its drawer holds the focus by the time the palette has gone.
  assert.equal(focusToRestore([on("prompt box")], on("the drawer"), body), null)
})

test("a surface opened from another returns to the first opener still on the page", () => {
  // ⌘K → "Settings": the palette's input opened Settings and left with the palette.
  const railButton = on("rail button")
  assert.equal(focusToRestore([gone("palette input"), railButton], body, body), railButton)
  // The whole chain gone (a row archived while Settings was open): the focus is left where it is.
  assert.equal(focusToRestore([gone("palette input"), gone("archived row")], body, body), null)
})

test("nothing held the focus when the surface opened, so nothing gets it back", () => {
  // Safari does not focus a button on a click: the opener is the body, or nothing.
  assert.equal(focusToRestore([body], body, body), null)
  assert.equal(focusToRestore([null], body, body), null)
  assert.equal(focusToRestore([], body, body), null)
  // And an enclosing surface's opener is still tried after an empty first link.
  const railButton = on("rail button")
  assert.equal(focusToRestore([body, railButton], body, body), railButton)
})
