import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { PermHint, type NotifPerm } from "./SettingsDrawer.tsx"

// The notifications setting ships On and a browser shows nothing until it has been asked. The line
// under the toggle said so and offered no way to be asked, short of clicking the On that was already
// selected. The not-yet-asked state is the one the page can act on, so it is the one with a button.
const hint = (perm: NotifPerm) => renderToStaticMarkup(createElement(PermHint, { perm, onAllow() {} }))

test("a browser that has not been asked gets the button that asks it", () => {
  const html = hint("default")
  assert.match(html, /<button[^>]*data-allow-notifications[^>]*>Allow notifications<\/button>/)
  assert.match(html, /Not yet allowed in this browser/)
})

test("no other permission state offers it: asking again does nothing there", () => {
  for (const perm of ["granted", "denied", "unsupported"] as const) {
    assert.doesNotMatch(hint(perm), /data-allow-notifications/, perm)
  }
  assert.match(hint("granted"), /Browser permission granted/)
  assert.match(hint("denied"), /Notifications are blocked for this site/)
})
