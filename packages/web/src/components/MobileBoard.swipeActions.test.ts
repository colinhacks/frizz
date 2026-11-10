import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { SwipeRow } from "./MobileBoard.tsx"

// A row's two swipe actions sit BEHIND its content until a swipe opens it. They were hidden from
// assistive tech with `aria-hidden` and still focusable: two Tab stops per row on buttons nobody could
// see, and a screen reader landing on a control it had been told was not there.
const row = (open: boolean) =>
  renderToStaticMarkup(
    createElement(SwipeRow, { open, onOpenChange() {}, onSnooze() {}, onDone() {}, snoozeLabel: "1h", children: "a thread" }),
  )
/** The opening tag of the element that holds the two action buttons. */
const actionsTag = (html: string) => /<div[^>]*>(?=<button[^>]*data-mobile-swipe-snooze)/.exec(html)?.[0] ?? ""

test("a closed row's swipe actions are inert, so neither a Tab nor a screen reader reaches them", () => {
  const tag = actionsTag(row(false))
  assert.match(tag, /\sinert=""/)
  assert.doesNotMatch(tag, /aria-hidden/, "aria-hidden over a focusable button is the defect, not the fix")
})

test("an open row's actions are reachable", () => {
  const html = row(true)
  const tag = actionsTag(html)
  assert.notEqual(tag, "", "the actions are drawn")
  assert.doesNotMatch(tag, /inert|aria-hidden/)
  assert.match(html, /data-mobile-swipe-done/)
})
