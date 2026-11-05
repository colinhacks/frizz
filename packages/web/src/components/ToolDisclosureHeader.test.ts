import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ToolDisclosureHeader, isToolDisclosureAction } from "./ToolDisclosureHeader.ts"

function disclosureBounds(html: string): { start: number; end: number } {
  const marker = html.indexOf("data-tool-disclosure")
  assert.notEqual(marker, -1, "disclosure marker must render")
  const start = html.lastIndexOf("<button", marker)
  const end = html.indexOf("</button>", marker) + "</button>".length
  assert.ok(start >= 0 && end > start, "disclosure button must be well formed")
  return { start, end }
}

test("renders file and expansion actions as siblings with a complete disclosure name", () => {
  const html = renderToStaticMarkup(
    createElement(ToolDisclosureHeader, {
      className: "frizz-diff-header",
      controls: "edit-body-1",
      expanded: false,
      label: "Expand Edit diff: /repo/src/app.ts",
      onToggle: () => {},
      children: createElement("a", { href: "cursor://file/repo/src/app.ts" }, "app.ts"),
    }),
  )

  const disclosure = disclosureBounds(html)
  const linkStart = html.indexOf("<a ")
  const linkEnd = html.indexOf("</a>") + "</a>".length
  assert.ok(linkStart >= 0 && linkEnd < disclosure.start, "file link must precede, not nest in, the disclosure button")
  assert.equal(html.slice(disclosure.start, disclosure.end).includes("<a "), false)
  assert.match(html.slice(disclosure.start, disclosure.end), /type="button"/)
  assert.match(html.slice(disclosure.start, disclosure.end), /aria-controls="edit-body-1"/)
  assert.match(html.slice(disclosure.start, disclosure.end), /aria-expanded="false"/)
  assert.match(html.slice(disclosure.start, disclosure.end), /aria-label="Expand Edit diff: \/repo\/src\/app\.ts"/)
  assert.match(html, /data-expanded="false"/)
  assert.doesNotMatch(html, /role="button"/)
})

test("keeps an Agent drill-in button separate from the expanded disclosure state", () => {
  const html = renderToStaticMarkup(
    createElement(ToolDisclosureHeader, {
      className: "frizz-bash-header",
      controls: "agent-prompt-1",
      expanded: true,
      label: "Collapse Agent prompt: Review permissions",
      onToggle: () => {},
      children: createElement("button", { type: "button", "aria-label": "Open sub-agent transcript: Review permissions" }, "Review permissions"),
    }),
  )

  const disclosure = disclosureBounds(html)
  const firstButton = html.indexOf("<button")
  const firstButtonEnd = html.indexOf("</button>", firstButton) + "</button>".length
  assert.ok(firstButton >= 0 && firstButtonEnd < disclosure.start, "drill-in and expansion must be separate native buttons")
  assert.equal((html.match(/<button\b/g) ?? []).length, 2)
  assert.match(html.slice(disclosure.start, disclosure.end), /aria-controls="agent-prompt-1"/)
  assert.match(html.slice(disclosure.start, disclosure.end), /aria-expanded="true"/)
  assert.match(html.slice(disclosure.start, disclosure.end), /aria-label="Collapse Agent prompt: Review permissions"/)
  assert.match(html.slice(disclosure.start, disclosure.end), /rotate-90/)
  assert.match(html, /data-expanded="true"/)
  assert.equal(html.slice(firstButton, firstButtonEnd).includes("aria-expanded"), false)
})

test("renders a running indicator only when the individual tool disclosure supplies one", () => {
  const running = renderToStaticMarkup(
    createElement(ToolDisclosureHeader, {
      className: "frizz-bash-header",
      controls: "bash-body-running",
      expanded: false,
      label: "Expand Bash: watch CI",
      onToggle: () => {},
      meta: createElement("span", { className: "frizz-live-dot", "data-running-indicator": "tool-disclosure", "aria-hidden": true }),
      children: "watch CI",
    }),
  )
  const terminal = renderToStaticMarkup(
    createElement(ToolDisclosureHeader, {
      className: "frizz-bash-header",
      controls: "bash-body-done",
      expanded: false,
      label: "Expand Bash: completed CI",
      onToggle: () => {},
      meta: createElement("span", null, "done"),
      children: "completed CI",
    }),
  )

  assert.match(running, /data-running-indicator="tool-disclosure"/)
  assert.match(running, /frizz-live-dot/)
  assert.match(running, /flex shrink-0 items-baseline gap-2/, "the status cluster and disclosure control share the row's baseline and rhythm")
  assert.match(running, /frizz-tool-chevron/, "the disclosure glyph places itself on the row's cap band")
  assert.doesNotMatch(terminal, /data-running-indicator/)
  assert.doesNotMatch(terminal, /frizz-live-dot/)
})

// The whole row toggles, so it must READ as clickable — its Bash/Todo siblings are one big <button>
// and pick the pointer cursor up from the global `button:not(:disabled)` rule in styles.css. This row
// is a div and has to ask for it. Still no role and no tab stop: the chevron remains the one control
// assistive tech sees, exactly as the sibling-structure tests above require.
test("the row itself reads as clickable without becoming a second control", () => {
  const html = renderToStaticMarkup(
    createElement(ToolDisclosureHeader, {
      className: "frizz-bash-header",
      controls: "read-body-1",
      expanded: false,
      label: "Expand Read: /repo/src/app.ts",
      onToggle: () => {},
      children: createElement("a", { href: "cursor://file/repo/src/app.ts" }, "app.ts"),
    }),
  )

  const row = html.slice(0, html.indexOf(">") + 1)
  assert.match(row, /class="frizz-bash-header w-full cursor-pointer text-left"/)
  assert.doesNotMatch(html, /role="button"/)
  assert.doesNotMatch(html, /tabindex/i)
})

// The "unless there's some kind of link within it" clause. A click is handed back to whatever owns it
// — a file deep-link, the sub-agent drill-in, the chevron (whose own handler already toggled, so
// standing down here is also what stops a double toggle) — and every other pixel falls through to the
// disclosure. `closest`, not identity: a click can land on a glyph or a truncating span inside one.
test("a header click defers to an action it landed inside, and to nothing else", () => {
  const inside = (selector: string) => ({ closest: (s: string) => (s.includes(selector) ? {} : null) })

  assert.equal(isToolDisclosureAction(inside("a,")), true, "a file path link owns its click")
  assert.equal(isToolDisclosureAction(inside("button")), true, "the sub-agent drill-in and the chevron own theirs")
  assert.equal(isToolDisclosureAction(inside('[role="button"]')), true, "so does an ARIA button")
  assert.equal(isToolDisclosureAction({ closest: () => null }), false, "a label, a path's dead space or the meta reading toggles")
  assert.equal(isToolDisclosureAction(null), false)
  assert.equal(isToolDisclosureAction(undefined), false)
  assert.equal(isToolDisclosureAction({}), false, "a target with no closest() is not an action")
})
