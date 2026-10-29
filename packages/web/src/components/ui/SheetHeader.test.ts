import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { SheetHeader } from "./SheetHeader.tsx"

test("SheetHeader renders the title and a lucide close button (never a typographic ×)", () => {
  const html = renderToStaticMarkup(createElement(SheetHeader, {
    title: "Fix the flip-surface width",
    onClose: () => undefined,
  }))
  assert.match(html, /Fix the flip-surface width/)
  assert.match(html, /aria-label="Close"/)
  // The lucide <X> renders an <svg class="lucide lucide-x"> sized to 15; never a bare × glyph.
  assert.match(html, /lucide-x/)
  assert.match(html, /width="15"/)
  assert.doesNotMatch(html, /×/)
})

// Every sheet slides out to the right, so its X leads the bar, ruled off from the title, and the right
// end belongs to `actions`.
test("SheetHeader leads with the close button and ends with the actions", () => {
  const html = renderToStaticMarkup(createElement(SheetHeader, {
    title: "Settings",
    actions: createElement("span", { "data-testid": "actions" }, "● unsaved"),
    onClose: () => undefined,
  }))
  const close = html.indexOf('aria-label="Close"')
  const rule = html.indexOf("data-close-rule")
  const title = html.indexOf("Settings")
  const actions = html.indexOf('data-testid="actions"')
  assert.ok(close >= 0 && close < rule && rule < title, "the close button, then its rule, come before the title")
  assert.ok(title < actions, "the actions come after the title")
})

// A programmatically focused button matches :focus-visible, so a close button that took the sheet's
// initial focus drew a ring every time a drawer opened from the keyboard. The sheet takes it instead.
test("the close button never claims the sheet's initial focus and draws no edge of its own", () => {
  const html = renderToStaticMarkup(createElement(SheetHeader, { title: "Settings", onClose: () => undefined }))
  assert.doesNotMatch(html, /data-dialog-initial-focus/)
  assert.doesNotMatch(html, /icon-focus-outline/)
})

test("SheetHeader renders subtitle, icon, meta, and actions when provided", () => {
  const html = renderToStaticMarkup(createElement(SheetHeader, {
    title: "Background shell",
    subtitle: "plan-42.md",
    icon: createElement("span", { "data-testid": "icon" }, "IC"),
    meta: createElement("span", { "data-testid": "meta" }, "running 3m"),
    actions: createElement("span", { "data-testid": "actions" }, "● unsaved"),
    onClose: () => undefined,
  }))
  assert.match(html, /plan-42\.md/)
  assert.match(html, /data-testid="icon"/)
  assert.match(html, /data-testid="meta"/)
  assert.match(html, /running 3m/)
  assert.match(html, /data-testid="actions"/)
  assert.match(html, /● unsaved/)
})

test("SheetHeader omits subtitle/icon/meta/actions markers when not provided", () => {
  const html = renderToStaticMarkup(createElement(SheetHeader, {
    title: "Just a title",
    onClose: () => undefined,
  }))
  assert.doesNotMatch(html, /data-testid=/)
})
