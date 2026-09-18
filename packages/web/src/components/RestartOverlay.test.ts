import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { RestartOverlay, STALLED_HEADING, stalledRestartCopy } from "./RestartOverlay.tsx"

test("closed overlay renders nothing", () => {
  assert.equal(renderToStaticMarkup(createElement(RestartOverlay, { open: false })), "")
})

test("open overlay is a full-viewport modal block above every modal", () => {
  const html = renderToStaticMarkup(createElement(RestartOverlay, { open: true }))
  assert.match(html, /role="alertdialog"/)
  assert.match(html, /aria-modal="true"/)
  // Full-viewport scrim that intercepts pointer paths, sitting above the tallest surface — the
  // shared Radix Dialog is z-[200], so the overlay must clear it at z-[300].
  assert.match(html, /fixed inset-0/)
  assert.match(html, /z-\[300\]/)
  assert.doesNotMatch(html, /z-\[200\]/)
  assert.match(html, /Updating and restarting Frizz/)
  assert.match(html, /animate-spin/)
  // The focusable card is what we park focus on so Tab cannot reach a background control.
  assert.match(html, /tabindex="-1"/)
})

test("a supervisor message renders as a status sub-line, blank ones are dropped", () => {
  const withMessage = renderToStaticMarkup(createElement(RestartOverlay, { open: true, message: "Promoting build 42" }))
  assert.match(withMessage, /Promoting build 42/)
  const blank = renderToStaticMarkup(createElement(RestartOverlay, { open: true, message: "   " }))
  const paragraphs = (blank.match(/<p /g) ?? []).length
  assert.equal(paragraphs, 1)
})

// The second shape of the one overlay (finding 1, audit 2026-09-11): what the hold turns into after
// three minutes of unanswered polls. Its whole point is that it does NOT block — a dead board behind a
// modal that cannot be dismissed is the bug it replaces.
test("the blocking shape never leaks the stalled copy or a dismiss control", () => {
  const html = renderToStaticMarkup(createElement(RestartOverlay, { open: true, message: "installing frizz@0.5.0" }))
  assert.match(html, /bg-scrim-55/)
  assert.doesNotMatch(html, /Dismiss/)
  assert.doesNotMatch(html, /did not come back/)
})

test("past the deadline the overlay lifts its block and says what to do", () => {
  const html = renderToStaticMarkup(createElement(RestartOverlay, { open: true, stalled: true, silentFor: "3m" }))
  assert.match(html, /role="alert"/)
  assert.doesNotMatch(html, /alertdialog|aria-modal/)
  // No scrim, and the wrapper lets the pointer through — only the card itself is interactive.
  assert.doesNotMatch(html, /bg-scrim-55|backdrop-blur/)
  const wrapper = html.match(/^<div class="([^"]*)"/)?.[1] ?? ""
  assert.ok(wrapper.includes("pointer-events-none"), wrapper)
  assert.ok(wrapper.includes("z-[300]"), "still above every modal, so a dialog left open under the old block cannot cover the notice")
  const card = html.match(/role="alert" class="([^"]*)"/)?.[1] ?? ""
  assert.ok(card.includes("pointer-events-auto") && card.includes("bg-elevated"), card)
  assert.match(html, /aria-label="Dismiss"/)
  assert.match(html, new RegExp(STALLED_HEADING))
  // The copy names the remedy and reads the silence in the house duration grammar (`3m`).
  assert.match(html, /Nothing has answered for 3m\./)
  assert.match(html, /npx frizz/)
  assert.match(html, /reconnects on its own/)
  assert.doesNotMatch(html, /3 minutes/)
  // Sentence case, no shouting.
  assert.equal(STALLED_HEADING, "Frizz did not come back")
})

test("the stalled copy still reads when no silence has been measured yet", () => {
  assert.match(stalledRestartCopy(undefined), /^Nothing is answering\. Restart Frizz from the terminal/)
  assert.match(stalledRestartCopy("2m"), /^Nothing has answered for 2m\. Restart Frizz/)
})

test("closed is closed in the stalled shape too", () => {
  assert.equal(renderToStaticMarkup(createElement(RestartOverlay, { open: false, stalled: true })), "")
})
