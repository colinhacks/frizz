import { test } from "node:test"
import assert from "node:assert/strict"
import { Marked } from "marked"
import { stripFrontmatter, MARKDOWN_OPTIONS } from "./markdown.ts"

// mdToHtml's sanitizer needs a DOM, so the sanitizing half is exercised in the browser
// (markdownSanitizer.e2e.test.ts / markdownStrikethrough.e2e.test.ts). What runs here is the pure
// half — the app's real marked configuration, driven straight.
const marked = new Marked(MARKDOWN_OPTIONS)
const render = (md: string) => marked.parseInline(md, { async: false }) as string
const renderBlock = (md: string) => (marked.parse(md, { async: false }) as string).trim()

// The bug: marked's GFM opener is `~~?`, so a lone `~` opened a strikethrough. Agent prose is full of
// approximation and home-path tildes, and two on one line struck out everything between them.
test("strikethrough: an approximation tilde pair is prose, not a strikethrough", () => {
  assert.equal(render("up to ~35s + one 10s poll tick (~45s) before the client"),
    "up to ~35s + one 10s poll tick (~45s) before the client")
  assert.equal(render("bg-panel (val~21) barely differs from page bg (val~13)"),
    "bg-panel (val~21) barely differs from page bg (val~13)")
})

test("strikethrough: a pair of ~/ home paths survives intact", () => {
  assert.equal(render("SYSTEM ~/.claude/settings.json and hook (~/.orca/claude-hook.sh) on User"),
    "SYSTEM ~/.claude/settings.json and hook (~/.orca/claude-hook.sh) on User")
})

test("strikethrough: one tilde on each side is literal text", () => {
  assert.equal(render("~one tilde~"), "~one tilde~")
})

test("strikethrough: the ~~two-tilde~~ form still strikes, and still nests inline markup", () => {
  assert.equal(render("~~struck~~"), "<del>struck</del>")
  assert.equal(render("~~a **b** c~~"), "<del>a <strong>b</strong> c</del>")
  assert.equal(render("~~first~~ then ~single~ then ~~second~~"),
    "<del>first</del> then ~single~ then <del>second</del>")
})

// The bug (2026-09-18): CommonMark reads `\.` as an escaped dot, so a Windows path's `CloudIPMSjb\.frizz`
// rendered as `CloudIPMSjb.frizz` — in prose and in the destination the click opens. The pass itself is
// pinned in windowsPathEscapes.test.ts; this is the app's configuration doing it, alongside the autolinker.
test("a Windows path keeps the separator before a dot-directory, in prose and in a link", () => {
  const path = String.raw`D:\Development\CloudIPMSjb\.frizz\threads\8e51437e\build-gap.md`
  assert.equal(render(`see ${path} (#12 fixed)`), `see ${path} (#12 fixed)`)
  assert.equal(render(`[build-gap.md](${path})`),
    `<a href="D:%5CDevelopment%5CCloudIPMSjb%5C.frizz%5Cthreads%5C8e51437e%5Cbuild-gap.md">build-gap.md</a>`)
})

// The sanitizer half of these behaviours is pinned in markdownSanitizer.e2e.test.ts (it needs a DOM);
// what's checkable here is that marked EMITS the markup the sanitizer now has to preserve.
test("task-list items emit a state-carrying marker, not a bare bullet", () => {
  const html = renderBlock("- [x] shipped\n- [ ] pending")
  assert.match(html, /<span class="md-task md-task-checked" title="Done"><\/span> <span class="md-task-text">shipped<\/span>/)
  assert.match(html, /<span class="md-task" title="To do"><\/span> <span class="md-task-text">pending<\/span>/)
  assert.doesNotMatch(html, /<input/, "an interactive control has no place in a transcript")
})

test("Obsidian-flavoured task states render as inert status marks", () => {
  const html = renderBlock("- [/] active\n- [-] cancelled\n- [?] blocked")
  assert.match(html, /<span class="md-task md-task-in-progress" title="In progress"><\/span> <span class="md-task-text">active<\/span>/)
  assert.match(html, /<span class="md-task md-task-cancelled" title="Cancelled"><\/span> <span class="md-task-text">cancelled<\/span>/)
  assert.match(html, /<span class="md-task md-task-blocked" title="Blocked"><\/span> <span class="md-task-text">blocked<\/span>/)
  assert.doesNotMatch(html, /\[\/\]|\[-\]|\[\?\]/)
})

// The item's own inline run is wrapped so the row's finished/cancelled styling lands on IT, not on the
// `<li>`. `text-decoration` propagates with no way for a descendant to opt out, so styling the `<li>`
// struck through a live sub-task nested under a cancelled parent.
test("a task item's own text is wrapped, and a nested sub-list stays outside that wrapper", () => {
  const html = renderBlock("- [-] dropped\n  - [ ] still live")
  assert.match(html, /<span class="md-task md-task-cancelled" title="Cancelled"><\/span> <span class="md-task-text">dropped<\/span>/)
  // The sub-list is a SIBLING of the wrapper, never inside it.
  assert.doesNotMatch(html, /<span class="md-task-text">[^<]*<ul/)
  assert.match(html, /<span class="md-task-text">dropped<\/span>\s*<ul>/)
})

// GFM needs a space AFTER the bracket, so Marked reads a bare `- [ ]` as the literal text "[ ]" — and
// that is exactly the shape an agent leaves in a task list it has not filled in yet.
test("an empty task item is a checkbox, not the literal text", () => {
  const html = renderBlock("- [ ]\n- [x]\n- [/]")
  assert.match(html, /<span class="md-task" title="To do"><\/span>/)
  assert.match(html, /<span class="md-task md-task-checked" title="Done"><\/span>/)
  assert.match(html, /<span class="md-task md-task-in-progress" title="In progress"><\/span>/)
  assert.doesNotMatch(html, /\[ \]|\[x\]|\[\/\]/, "no marker may survive as literal text")
})

// An uppercase `[X]` is GFM-legal and reaches the same state as `[x]`.
test("an uppercase checked marker is the checked state", () => {
  assert.match(renderBlock("- [X] shipped"), /md-task md-task-checked/)
})

test("custom task markers are recognized only at the start of list items", () => {
  assert.equal(render("prose [/] stays literal"), "prose [/] stays literal")
  assert.equal(render("`[/]` stays code"), "<code>[/]</code> stays code")
  const fenced = renderBlock("```markdown\n- [/] stays code\n```")
  assert.match(fenced, /\[\/\] stays code/)
  assert.doesNotMatch(fenced, /md-task-in-progress/)
  assert.match(renderBlock("- ordinary text with [/] inside"), /\[\/\] inside/)
})

test("a list that does not start at 1 emits its own numbering", () => {
  assert.match(renderBlock("17. first\n18. second"), /^<ol start="17">/)
  assert.match(renderBlock("1. first\n2. second"), /^<ol>/)
})

test("strikethrough: non-strikethrough tilde shapes are unchanged", () => {
  assert.equal(render("`~~code~~` stays literal"), "<code>~~code~~</code> stays literal")
  assert.equal(render("~~unclosed"), "~~unclosed")
  assert.equal(render("~~ leading space ~~"), "~~ leading space ~~")
})

// The bug: GFM only recognises a table when a delimiter row (`|---|---|`) follows the first line, so
// the headerless label/value breakdowns agents write constantly fell through to the paragraph
// tokenizer and rendered as literal pipe soup.
const HEADERLESS = [
  "| packages doing observable work (the real denominator) | **186** |",
  "| identical delta under the jail | **161** |",
  "| genuine BREAK | **10 (5.4%)** |",
].join("\n")

test("a headerless pipe block renders as a table, with every row a body row", () => {
  const html = renderBlock(HEADERLESS)
  assert.match(html, /^<table>/)
  assert.doesNotMatch(html, /<thead>|<th[ >]/, "there is no header to promote — the first line is data")
  assert.match(html, /<tr><td>packages doing observable work \(the real denominator\)<\/td><td><strong>186<\/strong><\/td><\/tr>/)
  assert.match(html, /<tr><td>genuine BREAK<\/td><td><strong>10 \(5\.4%\)<\/strong><\/td><\/tr>/)
  assert.doesNotMatch(html, /\|/, "no pipe should survive as literal text")
})

test("the headerless run ends the paragraph it follows, with or without a blank line", () => {
  for (const md of [`Breakdown:\n${HEADERLESS}`, `Breakdown:\n\n${HEADERLESS}`]) {
    const html = renderBlock(md)
    assert.match(html, /^<p>Breakdown:<\/p>\n<table>/)
    assert.doesNotMatch(html, /<p>[^<]*\|/)
  }
})

test("a real GFM table keeps its header and column alignment", () => {
  const html = renderBlock("| a | b |\n| :-- | --: |\n| 1 | 2 |")
  assert.match(html, /<thead>[\s\S]*<th align="left">a<\/th>\n<th align="right">b<\/th>/)
  assert.match(html, /<td align="left">1<\/td>\n<td align="right">2<\/td>/)
})

test("shapes that are not obviously a table stay prose", () => {
  // One row is as likely a sentence as a table; a single column is likelier ASCII art than data.
  assert.match(renderBlock("| just one line | 3 |"), /^<p>/)
  assert.match(renderBlock("| alpha |\n| beta |"), /^<p>/)
  // The closing pipe is escaped, so the row never closes.
  assert.match(renderBlock("| a | b \\|\n| c | d \\|"), /^<p>/)
  // Four-space indent is an indented code block, not a table.
  assert.match(renderBlock("    | a | b |\n    | c | d |"), /^<span class="md-code"><pre>/)
})

test("pipe rows inside a fence stay code", () => {
  const html = renderBlock("```\n| a | b |\n| c | d |\n```")
  assert.match(html, /^<span class="md-code"><pre>/)
  assert.doesNotMatch(html, /<table>/)
})

test("a headerless table escapes pipes and pads ragged rows", () => {
  const html = renderBlock("| a \\| b | c |\n| d | e | f |")
  assert.match(html, /<tr><td>a \| b<\/td><td>c<\/td><td><\/td><\/tr>/)
  assert.match(html, /<tr><td>d<\/td><td>e<\/td><td>f<\/td><\/tr>/)
})

// stripFrontmatter underpins the thread header's "Frizz document" gate (ChatView.ThreadHeader): the
// button shows iff `stripFrontmatter(threadBody).trim()` is non-empty. These lock the two invariants
// that gate relies on — a missing/frontmatter-only doc must reduce to empty (button HIDDEN, no
// dead-end "No thread file found"), a doc with real body must survive (button SHOWN).
test("stripFrontmatter: empty input stays empty (missing .frizz/<slug>.md → doc button hidden)", () => {
  assert.equal(stripFrontmatter("").trim(), "")
})

test("stripFrontmatter: a frontmatter-only doc reduces to empty (no body → button hidden)", () => {
  const md = "---\ntitle: \"x\"\nstatus: active\n---\n"
  assert.equal(stripFrontmatter(md).trim(), "")
})

test("stripFrontmatter: real body survives frontmatter removal (button shown)", () => {
  const md = "---\ntitle: \"x\"\n---\n\n## Goal\nShip it.\n"
  assert.equal(stripFrontmatter(md).trim(), "## Goal\nShip it.")
})

test("stripFrontmatter: body without frontmatter is returned untouched", () => {
  assert.equal(stripFrontmatter("## Goal\nbody").trim(), "## Goal\nbody")
})

test("stripFrontmatter: CRLF frontmatter delimiters are handled", () => {
  const md = "---\r\ntitle: x\r\n---\r\n\r\nbody\r\n"
  assert.equal(stripFrontmatter(md).trim(), "body")
})
