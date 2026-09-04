import assert from "node:assert/strict"
import { test } from "node:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Frontmatter } from "./MarkdownDrawer.tsx"

const textOf = (html: string) =>
  html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")

test("frontmatter renders as indentation-preserving, syntax-highlighted YAML", () => {
  const source = [
    "title: Zod 4.5",
    "draft: false",
    "",
    "tags:",
    "  - zod",
    'summary: "a & b" # note',
  ].join("\n")
  const html = renderToStaticMarkup(createElement(Frontmatter, { source }))

  assert.match(html, /^<pre/)
  assert.match(html, /class="hljs [^"]*whitespace-pre-wrap/)
  assert.match(html, /<span class="hljs-attr">title:<\/span>/)
  assert.match(html, /<span class="hljs-literal">false<\/span>/)
  assert.match(html, /<span class="hljs-bullet">-<\/span>/)
  assert.match(html, /<span class="hljs-comment"># note<\/span>/)
  assert.equal(textOf(html), source)
})
