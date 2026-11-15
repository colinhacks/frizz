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

const slowUpdate = {
  kind: "update" as const,
  title: "Updating Frizz to 0.15.56",
  elapsedMs: 192_000,
  steps: [
    { key: "stop", label: "Stopped", version: "0.15.55", state: "done" as const, note: "900ms" },
    { key: "codex", label: "Downloading Codex", version: "0.169.0", state: "live" as const, note: "60%", fraction: 0.6, meta: "212 of 348 MB · 480 KB/s · about 5m left" },
    { key: "threads", label: "Load threads", state: "todo" as const },
  ],
  openNow: true,
  hint: "slow" as const,
  downloading: ["Codex"],
  callout: { lead: "This connection is slow.", text: "Frizz can open now and finish Codex in the background." },
}

test("with the launcher's progress the overlay is the restart screen's checklist, still a hard block", () => {
  const html = renderToStaticMarkup(createElement(RestartOverlay, { open: true, progress: slowUpdate }))
  assert.match(html, /role="alertdialog"/)
  assert.match(html, /fixed inset-0/)
  assert.match(html, /aria-label="Updating Frizz to 0.15.56"/)
  assert.match(html, /3m 12s/, "the elapsed clock")
  assert.match(html, /Running threads keep working\. The board opens when it is ready\./)
  assert.deepEqual([...html.matchAll(/data-step="([^"]+)" data-state="([^"]+)"/g)].map((m) => `${m[1]}:${m[2]}`), ["stop:done", "codex:live", "threads:todo"])
  assert.match(html, /212 of 348 MB · 480 KB\/s · about 5m left/)
  assert.match(html, /width:60\.0%/)
  assert.match(html, /<b class="font-semibold text-fg">This connection is slow\. <\/b>Frizz can open now/)
  assert.match(html, /data-open-now="true"[^>]*>Open Frizz now</)
  assert.doesNotMatch(html, /Updating and restarting Frizz/, "not the old spinner card")
})

test("a quick restart's checklist offers nothing, and a request on its way reads as opening", () => {
  const quick = renderToStaticMarkup(createElement(RestartOverlay, { open: true, progress: { ...slowUpdate, openNow: false, callout: undefined, hint: undefined } }))
  assert.doesNotMatch(quick, /data-boot-callout|Open Frizz now/)
  const opening = renderToStaticMarkup(createElement(RestartOverlay, {
    open: true,
    progress: { ...slowUpdate, openNow: false, opening: true, callout: { text: "Opening Frizz. Codex keeps downloading in the background." } },
  }))
  assert.match(opening, /Opening Frizz\. Codex keeps downloading in the background\./)
  assert.match(opening, /disabled=""[^>]*>Opening</)
})

test("past the deadline the stalled notice wins over a stale checklist", () => {
  const html = renderToStaticMarkup(createElement(RestartOverlay, { open: true, stalled: true, silentFor: "3m", progress: slowUpdate }))
  assert.match(html, new RegExp(STALLED_HEADING))
  assert.doesNotMatch(html, /data-boot-progress/)
})
