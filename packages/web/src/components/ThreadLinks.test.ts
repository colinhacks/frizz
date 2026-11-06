import assert from "node:assert/strict"
import test from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { ThreadLinks } from "./ThreadLinks.tsx"
import { CHILD_ARROW, CHILD_KIND_TAG_CLASS, CHILD_MARK_SLOT_CLASS } from "../lib/childOps.ts"

test("registered destinations keep the selected row grammar without advertising live work", () => {
  const html = renderToStaticMarkup(createElement(ThreadLinks, { links: [
    { id: "lnk_url", kind: "link", label: "Open dev server", target: "http://localhost:5173/" },
    { id: "lnk_file", kind: "file", label: "Working <plan>", target: "/tmp/plan.md" },
  ] }))
  assert.equal(html.split(CHILD_ARROW).length - 1, 2)
  assert.match(html, /border-t/)
  assert.match(html, /lucide-external-link/)
  assert.match(html, /lucide-file-text/)
  assert.match(html, /href="http:\/\/localhost:5173\/" target="_blank" rel="noopener noreferrer"/)
  assert.match(html, /data-link-destination/)
  assert.match(html, /Working &lt;plan&gt;/)
  assert.match(html, />Link<\/span>/)
  assert.match(html, />File<\/span>/)
  assert.doesNotMatch(html, /data-running-indicator|frizz-live-dot|>Links</)
})

// The row's BOX is the child-op row's: its height is the label's inherited line box and nothing else,
// so a File/Link row sits on the same pitch as the ⤷ AGENT / ⤷ SHELL rows it continues. Pinned as a
// SHAPE — `py-0.5 leading-5` shipped once and made each of these rows 25px against 17.25px
// (maintainer 2026-09-11: "It should be the exact same spacing and padding").
test("a saved-reference row carries no vertical padding or line-height of its own", () => {
  const html = renderToStaticMarkup(createElement(ThreadLinks, { links: [
    { id: "lnk_url", kind: "link", label: "Open dev server", target: "http://localhost:5173/" },
    { id: "lnk_file", kind: "file", label: "Working plan", target: "/tmp/plan.md" },
  ] }))
  const rowClasses = [...html.matchAll(/data-thread-link="[^"]+"[^>]*class="([^"]*)"/g)].map((m) => m[1])
  assert.equal(rowClasses.length, 2)
  for (const cls of rowClasses) {
    assert.doesNotMatch(cls, /(^|\s)(py|pt|pb)-/, `row padding leaked in: ${cls}`)
    assert.doesNotMatch(cls, /(^|\s)leading-/, `row line-height leaked in: ${cls}`)
    assert.match(cls, /(^|\s)items-baseline(\s|$)/, "the icon's cap-band correction needs a baseline row")
  }
})

// The label starts where every other label on the strip starts: the mark slot and the kind tag are the
// child-op row's own (lib/childOps.ts), not a wider slot and a 33px column of this row's making
// (maintainer 2026-09-11: "The label is further to the right. Why? There's no reason for that at all").
test("a saved-reference row shares the child-op row's mark slot and tag column", () => {
  const html = renderToStaticMarkup(createElement(ThreadLinks, { links: [
    { id: "lnk_url", kind: "link", label: "Open dev server", target: "http://localhost:5173/" },
    { id: "lnk_file", kind: "file", label: "Working plan", target: "/tmp/plan.md" },
  ] }))
  const tagClasses = [...html.matchAll(/data-link-kind="[^"]*" class="([^"]*)"/g)].map((m) => m[1])
  assert.deepEqual(tagClasses, [CHILD_KIND_TAG_CLASS, CHILD_KIND_TAG_CLASS])
  assert.equal(html.split(`<span class="${CHILD_MARK_SLOT_CLASS} -mt-[1em] self-baseline"><svg `).length - 1, 2, "each icon sits in the 9px mark slot")
  assert.doesNotMatch(html, /w-\[33px\]|text-\[9px\]/)
})

test("in a panel a link or file is a menu's row, naming a file by its name", () => {
  const html = renderToStaticMarkup(createElement(ThreadLinks, {
    panel: true,
    links: [
      { id: "a", kind: "link", label: "Dev server", target: "http://localhost:5173/" },
      { id: "b", kind: "file", label: "Report", target: "/Users/someone/project/out/report.md" },
    ],
  } as never))
  assert.ok(!html.includes(CHILD_ARROW), "no arrow: it hangs off nothing")
  assert.doesNotMatch(html, /border-t|petite-caps|>Link<|>File</, "no rule above it, and the count already named the kind")
  assert.match(html, /px-2\.5 py-1\.5 text-left text-\[12px\]/)
  assert.match(html, />report\.md</)
  assert.match(html, /title="\/Users\/someone\/project\/out\/report\.md"/, "the tooltip keeps the whole path")
})

test("no registrations means no divider or empty heading", () => {
  assert.equal(renderToStaticMarkup(createElement(ThreadLinks, { links: [] })), "")
})
