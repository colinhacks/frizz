import { Marked } from "marked"
import type { Token, Tokens, TokenizerAndRendererExtension } from "marked"
import { CODE_BLOCK_CLASS, renderHighlightedCode } from "./syntaxHighlight.ts"
import { isLocalMarkdownFile, localImageUrlForTarget, localMarkdownTarget, resolveRelativeLocalPath } from "./markdownTargets.ts"
import { prefixedAppRoute } from "./base-path.ts"
import { githubRefFromUrl, linkifyGithubRefs } from "./githubAutolink.ts"
import { restoreWindowsPathEscapes } from "./windowsPathEscapes.ts"
import { FRAMED_IMAGE, IMAGE_FRAME, IMAGE_FRAME_MAT } from "../components/ImageFrame.tsx"

// marked's GFM strikethrough opener is `~~?` — ONE tilde is enough. That misreads the tilde agents
// actually type: `~` is the approximation sign ("takes ~2.7s", "around ~line 897") and the home
// prefix (`~/.claude/settings.json`), so any line carrying two of them silently struck out
// everything in between ("finished in <del>2.7s; see </del>/.frizz/quota-cache"). Nobody writes
// single-tilde strikethrough deliberately, so require the unambiguous `~~…~~` — same rule marked
// ships, with the optional second tilde made mandatory.
const DOUBLE_TILDE_DEL = /^(~~)(?=[^\s~])((?:\\.|[^\\])*?(?:\\.|[^\s~\\]))\1(?=[^~]|$)/

const strikethroughTokenizer = {
  del(this: { lexer: { inlineTokens: (src: string) => Tokens.Del["tokens"] } }, src: string) {
    const cap = DOUBLE_TILDE_DEL.exec(src)
    // undefined, NOT false: marked reads a `false` return as "no opinion, fall through to the
    // built-in tokenizer" — which would hand the single-tilde rule right back.
    if (!cap) return undefined
    return { type: "del" as const, raw: cap[0], text: cap[2], tokens: this.lexer.inlineTokens(cap[2]) }
  },
}

// GFM only sees a table if a DELIMITER row (`|---|---|`) follows the first line. Agents constantly
// write the shape without one — a label/value breakdown where every line opens and closes with `|`
// and there is no header to spell — and marked handed the whole run to the paragraph tokenizer, so
// the reader got literal pipe soup instead of a table. Nothing about that block is ambiguous, so
// tokenize it: consecutive lines that all open AND close with `|` are a table the author simply
// didn't spell in full. Every row becomes a BODY row — promoting the first line to a header would
// relabel data as a heading, and a headerless block has no header by construction.
type HeaderlessCell = { tokens: Token[] }
type HeaderlessTableToken = { type: "headerlessTable"; raw: string; rows: HeaderlessCell[][] }

const DELIMITER_CELL = /^:?-+:?$/
const ROW_INDENT = /^ {0,3}$/
const ROW_TRAILING = /^[ \t]*$/

// The cells of one `| a | b |` line, or null if the line isn't that shape. Splitting drives the
// check rather than a regex so an ESCAPED pipe can't be mistaken for a delimiter: `\|` is consumed
// as one unit here and stays escaped in the cell text, where the inline lexer turns it into the
// literal the author meant. A row therefore needs both outer pipes intact (nothing but indent
// before the first, nothing but blanks after the last) and at least two cells — a one-column run of
// `| x |` lines is far likelier to be prose or ASCII art than a table.
function pipeRowCells(line: string): string[] | null {
  const segments: string[] = []
  let cell = ""
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === "\\" && i + 1 < line.length) {
      cell += ch + line[i + 1]
      i++
    } else if (ch === "|") {
      segments.push(cell)
      cell = ""
    } else {
      cell += ch
    }
  }
  segments.push(cell)
  // [before the first pipe, ...cells, after the last pipe] — so two cells means four segments.
  if (segments.length < 4) return null
  if (!ROW_INDENT.test(segments[0]) || !ROW_TRAILING.test(segments.at(-1)!)) return null
  return segments.slice(1, -1).map((text) => text.trim())
}

// The leading run of pipe rows in `src`, or null if there isn't one worth tokenizing.
function matchHeaderlessTable(src: string): { raw: string; rows: string[][] } | null {
  const rows: string[][] = []
  let consumed = 0
  for (const line of src.split("\n")) {
    const cells = pipeRowCells(line)
    if (!cells) break
    // A delimiter row means this IS a GFM table (or an attempt at one): hands off, marked's own
    // table tokenizer owns it and carries the column alignment we'd throw away.
    if (cells.every((text) => DELIMITER_CELL.test(text))) return null
    rows.push(cells)
    consumed += line.length + 1
  }
  if (rows.length < 2) return null
  return { raw: src.slice(0, Math.min(consumed, src.length)), rows }
}

const headerlessTableExtension: TokenizerAndRendererExtension = {
  name: "headerlessTable",
  level: "block",
  // Lets the run end a paragraph it directly follows (no blank line between), the way a real GFM
  // table can. Validating the whole run before reporting an index matters: returning the offset of
  // any old pipe would chop ordinary prose into two paragraphs.
  start(src: string) {
    let offset = 0
    for (const line of src.split("\n")) {
      if (line.includes("|") && matchHeaderlessTable(src.slice(offset))) return offset
      offset += line.length + 1
    }
    return undefined
  },
  tokenizer(this: { lexer: { inline: (src: string) => Token[] } }, src: string) {
    const match = matchHeaderlessTable(src)
    if (!match) return undefined
    // Ragged rows are padded rather than rejected: a table missing one cell still reads as a table,
    // and falling back would put the whole block back on the pipe-soup path.
    const width = Math.max(...match.rows.map((row) => row.length))
    const rows = match.rows.map((row) =>
      Array.from({ length: width }, (_, i) => ({ tokens: this.lexer.inline(row[i] ?? "") })))
    return { type: "headerlessTable", raw: match.raw, rows } satisfies HeaderlessTableToken
  },
  renderer(this: { parser: { parseInline: (tokens: Token[]) => string } }, token) {
    const body = (token as HeaderlessTableToken).rows
      .map((row) => `<tr>${row.map((cell) => `<td>${this.parser.parseInline(cell.tokens)}</td>`).join("")}</tr>`)
      .join("\n")
    return `<table>\n<tbody>${body}</tbody></table>\n`
  },
}

// Obsidian-flavoured task states agents write in their own markdown. GFM only recognizes `[ ]` and `[x]`;
// Marked therefore tokenizes `[/]`, `[-]`, and `[?]` as ordinary list-item text. Promote ONLY a
// marker at the start of a list item — never the same bracket sequence in prose or code — into an
// inert status mark. Keeping this as a token transform rather than a raw-Markdown regex means fenced
// code, inline code, and non-list prose remain byte-for-byte literal.
//
// ALL FIVE states travel this one path, GFM's two included — `item.task` is cleared so Marked's own
// checkbox branch never runs. That is what lets the item's own text be wrapped (below): Marked's
// LOOSE-list branch injects the checkbox HTML into the first TEXT token at render time, so a wrapper
// placed there during the walk would have displaced the checkbox and silently dropped it. One path
// also means one status vocabulary and one set of tooltips instead of two.
type FrizzTaskStatus = " " | "x" | "/" | "-" | "?"
type FrizzTaskStatusToken = {
  type: "frizzTaskStatus"
  raw: string
  status: FrizzTaskStatus
}

// GFM requires a SPACE after the bracket, so a bare `- [ ]` with nothing after it is not a task item
// to Marked and rendered as the literal text "[ ]". That shape is not hypothetical: it is what the
// empty item an agent leaves in a task list it is still filling in. `[ ]` and `[x]`
// are therefore accepted here too, but ONLY at end-of-item — with trailing text they are still
// Marked's to tokenize, and `item.task` is already true by the time this runs.
const CUSTOM_TASK_STATUS = /^\[([ xX/\-?])\](?:[ \t]+|[ \t]*$)/
const TASK_STATUS_META: Record<FrizzTaskStatus, { className: string; label: string }> = {
  " ": { className: "", label: "To do" },
  x: { className: "md-task-checked", label: "Done" },
  "/": { className: "md-task-in-progress", label: "In progress" },
  "-": { className: "md-task-cancelled", label: "Cancelled" },
  "?": { className: "md-task-blocked", label: "Blocked" },
}

const customTaskStatusExtension: TokenizerAndRendererExtension = {
  name: "frizzTaskStatus",
  level: "inline",
  // Tokens are inserted by `promoteTaskItem`; this tokenizer deliberately never claims source text on
  // its own, because only the enclosing list-item walk can prove the marker's position.
  tokenizer() {
    return undefined
  },
  renderer(token) {
    const { status } = token as FrizzTaskStatusToken
    const meta = TASK_STATUS_META[status]
    return `<span class="md-task${meta.className ? ` ${meta.className}` : ""}" title="${meta.label}"></span> `
  },
}

// The item's OWN text, wrapped so the row's finished/cancelled styling (dimmed, struck) lands on it
// alone. Without the wrapper the only handle was the `<li>`, and `text-decoration` PROPAGATES with no
// way for a descendant to switch it off — so a live sub-task under a cancelled parent came out struck
// through. A nested list is a sibling of this span, so it is untouched by construction.
type FrizzTaskTextToken = { type: "frizzTaskText"; raw: string; tokens: Token[] }

const taskTextExtension: TokenizerAndRendererExtension = {
  name: "frizzTaskText",
  level: "inline",
  tokenizer() {
    return undefined
  },
  renderer(this: { parser: { parseInline: (tokens: Token[]) => string } }, token) {
    return `<span class="md-task-text">${this.parser.parseInline((token as FrizzTaskTextToken).tokens)}</span>`
  },
}

/** Turn one list item's task marker — GFM's or Obsidian's — into renderer-owned status + text tokens. */
function promoteTaskItem(item: Tokens.ListItem): void {
  const firstBlock = item.tokens[0]
  const inline = firstBlock && "tokens" in firstBlock ? firstBlock.tokens : undefined
  if (!Array.isArray(inline)) return
  if (inline[0]?.type === "frizzTaskStatus") return // already walked

  let status: FrizzTaskStatus
  let raw: string
  if (item.task) {
    status = item.checked ? "x" : " "
    raw = ""
    item.task = false
    item.checked = undefined
  } else {
    const match = CUSTOM_TASK_STATUS.exec(item.text)
    if (!match) return

    // Remove the marker from the already-tokenized inline run. Normally it is one leading Text token,
    // but consume across adjacent Text tokens too so a future Marked tokenizer split cannot duplicate
    // part of the raw marker.
    let remaining = match[0].length
    const cuts: Array<{ token: Tokens.Text; count: number }> = []
    for (let i = 0; i < inline.length && remaining > 0; i++) {
      const token = inline[i]
      if (token.type !== "text") return
      const cut = Math.min(remaining, token.raw.length)
      cuts.push({ token: token as Tokens.Text, count: cut })
      remaining -= cut
    }
    if (remaining > 0) return

    for (const { token, count } of cuts) {
      token.raw = token.raw.slice(count)
      token.text = token.text.slice(count)
    }
    for (let i = inline.length - 1; i >= 0; i--)
      if (inline[i].type === "text" && !inline[i].raw) inline.splice(i, 1)

    item.text = item.text.slice(match[0].length)
    status = (match[1] === "X" ? "x" : match[1]) as FrizzTaskStatus
    raw = match[0]
  }

  const rest = inline.splice(0, inline.length)
  inline.push({ type: "frizzTaskStatus", raw, status } as Token)
  if (rest.length) inline.push({ type: "frizzTaskText", raw: "", tokens: rest } as Token)
}

// Exported so markdown.test.ts can drive the EXACT configuration the app renders with: mdToHtml
// itself can't run under `node --test` (the sanitizer needs a DOM), but everything here is pure.
export const MARKDOWN_OPTIONS = {
  breaks: true,
  extensions: [headerlessTableExtension, customTaskStatusExtension, taskTextExtension],
  tokenizer: strikethroughTokenizer,
  // GitHub-style `#123` / commit-hash autolinking (githubAutolink.ts). A hook rather than an extension or
  // a walkTokens branch: it needs the ROOT token array, which is the whole document on the parseInline
  // path, and marked hands that to `processAllTokens` alone.
  hooks: {
    processAllTokens(tokens: Token[]) {
      // A Windows path's `\.` is a separator, not a CommonMark escape (windowsPathEscapes.ts). First,
      // so the autolinker splits the text tokens the way the reader will see them.
      restoreWindowsPathEscapes(tokens)
      linkifyGithubRefs(tokens)
      return tokens
    },
  },
  walkTokens(token: Token) {
    if (token.type === "list_item") promoteTaskItem(token as Tokens.ListItem)
  },
  renderer: {
    code: ({ text, lang }: Tokens.Code) => renderHighlightedCode(text, lang),
    // No `checkbox` override: marked's default is `<input type="checkbox" disabled>`, which the render
    // allowlist below drops — so `- [x] done` and `- [ ] todo` came out as identical plain bullets and
    // a checklist lost the only thing it was communicating. `promoteTaskItem` now takes GFM's two
    // states off that branch entirely and emits the same inert `.md-task` span the Obsidian three get,
    // so this hook has nothing left to render.
  },
}

const markdown = new Marked(MARKDOWN_OPTIONS)

// The same renderer with CommonMark's soft-break rule restored, for prose that is a FILE rather than a
// chat message. A document on disk is routinely hard-wrapped at some column — the whole README ecosystem
// is — and `breaks: true` turns every one of those wraps into a visible ragged line break. Chat prose
// keeps the hard-break convention it was written under; a rendered `.md` file gets the one its author
// used. Nothing else differs, so a document and a message still parse identically in every other way.
const documentMarkdown = new Marked({ ...MARKDOWN_OPTIONS, breaks: false })

// Agent-written markdown → sanitized HTML. Shared by the chat view, the To-dos pager, and the
// thread-details drawer. marked output goes through a small allowlist sanitizer (content is only
// semi-trusted): script-like tags dropped, event handlers and javascript: URLs stripped, links
// forced to new tabs. Parsing happens in a detached template so nothing executes.
//
// `baseDir` is the directory a relative link resolves against — the document's own directory from the
// built-in file reader, the project root from every other surface (see lib/localPathBase.ts). `homeDir`
// expands a `~`-anchored one. `document` is the file reader's alone: soft wraps stay soft.
export function mdToHtml(md: string, opts?: { baseDir?: string; homeDir?: string; document?: boolean }): string {
  if (!md.trim()) return ""
  // breaks: single newlines are HARD breaks (chat convention — Slack/GitHub-comment style);
  // CommonMark default silently glued "item ✅\nitem ✅" lists onto one line.
  const parser = opts?.document ? documentMarkdown : markdown
  return sanitize(parser.parse(md, { async: false }) as string, { block: true, baseDir: opts?.baseDir, homeDir: opts?.homeDir })
}

// INLINE-only render: emphasis/strong/code/del/links but NO block wrapping (`<p>`, headings, lists).
// For places that render a single short line inside their own element and must stay inline — answer
// chips, the recommendation caption — where a worker's `code`/**bold**/_em_ must be honored rather than
// shown as raw markdown, but a `<p>` wrapper would break the layout. Same allowlist sanitizer as the
// block path (content is only semi-trusted), and the SAME augmentations: a link, a `#123` reference,
// a bare URL and a local-file path all come out live here too. An answer chip used to ask for them
// flattened (`inertInteractive`), because the chip was a `<button>` around its text and an anchor
// inside one is invalid HTML; the chip now lays its hit area BESIDE the text instead
// (components/QuestionBlockCard.tsx), so a file named in an option opens like one named in a paragraph.
export function mdInlineToHtml(md: string, opts?: { baseDir?: string; homeDir?: string }): string {
  if (!md.trim()) return ""
  const { baseDir, homeDir } = opts ?? {}
  return sanitize(markdown.parseInline(md, { async: false }) as string, { baseDir, homeDir })
}

export function stripFrontmatter(md: string): string {
  const m = md.match(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return m ? md.slice(m[0].length) : md
}

const ALLOWED_TAGS = new Set([
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "strong", "em", "del", "code", "pre",
  "blockquote", "ul", "ol", "li", "a", "img", "button", "table", "thead", "tbody", "tr", "th", "td", "span",
])
const ALLOWED_ATTRS = new Set(["href", "src", "alt", "title", "type", "class", "data-local-path", "data-local-image"])
// `class` is allowlisted outright on every other tag; on `code` and `span` it is filtered to this set,
// because those two are the tags the renderers below mint with meaning attached. Built from the constant
// so the fenced-code wrapper's class cannot drift out of the pattern that has to admit it — a stripped
// class silently costs the block its `position: relative` and drops the copy button somewhere else.
const ALLOWED_CLASS = new RegExp(
  `^(?:hljs(?:-[a-z0-9_-]+)?|language-[a-z0-9-]+|md-task(?:-(?:checked|in-progress|cancelled|blocked|text))?|${CODE_BLOCK_CLASS})$`)

// Attributes admitted only on the tag that gives them meaning, and only with a well-formed value.
// Both carry information the author wrote and the flat allowlist above was silently discarding:
// `start` is how a list that doesn't begin at 1 keeps its numbers (stripping it renumbered a worker's
// "17." back to "1."), `align` is GFM's table column alignment.
const ALLOWED_ATTRS_BY_TAG: Record<string, Record<string, RegExp>> = {
  ol: { start: /^\d{1,9}$/ },
  th: { align: /^(?:left|center|right)$/ },
  td: { align: /^(?:left|center|right)$/ },
}

// Disallowed tags are UNWRAPPED (see walk) — but for these the content IS the payload, so element and
// subtree go together. Raw-text elements (`script`, `style`, `textarea`, `title`, `xmp`) would spill
// their unparsed text into the document, and the embedding elements have nothing worth salvaging.
const DROP_WITH_CONTENT = new Set([
  "script", "style", "textarea", "title", "xmp", "iframe", "frame", "frameset",
  "object", "embed", "applet", "noscript", "template", "svg", "math",
])

// `block` — this prose owns its own vertical space (mdToHtml), so a local image may be framed the way
// every other rendered picture in the app is. FALSE on the inline path: that result is dropped into a
// host that is one line tall (an answer chip, a caption), where a block frame would burst the row. The
// picture still renders there, bare and inline, exactly as it did before frames existed.
// `baseDir` — the directory a relative destination resolves against: the FILE's own directory in the
// built-in reader, and the PROJECT ROOT everywhere else, which is the base the server already uses for
// a bare path in inline code. `homeDir` — the expansion of a leading `~`. Both come from the caller;
// see lib/localPathBase.ts for where the non-reader surfaces get them.
type WalkContext = { block: boolean; baseDir?: string; homeDir?: string }

function sanitize(dirty: string, { block = false, baseDir, homeDir }: Partial<WalkContext> = {}): string {
  const tpl = document.createElement("template")
  tpl.innerHTML = dirty
  walk(tpl.content, { block, baseDir, homeDir })
  return tpl.innerHTML
}

function walk(node: ParentNode, ctx: WalkContext) {
  const { block } = ctx
  for (const el of Array.from(node.children)) {
    const tag = el.tagName.toLowerCase()
    if (!ALLOWED_TAGS.has(tag)) {
      // Unwrap rather than delete. marked passes raw HTML through, and the parser turns an ordinary
      // piece of prose — `Promise<void>`, a `<sessionId>` placeholder — into an ELEMENT that swallows
      // the rest of the block, so `el.remove()` silently deleted everything after it. Keeping the
      // children (what DOMPurify does) costs only the bracketed token itself.
      if (DROP_WITH_CONTENT.has(tag)) el.remove()
      else unwrap(el, ctx)
      continue
    }
    if (tag === "a" || tag === "img") rebaseRelative(el, tag === "a" ? "href" : "src", ctx)
    if (tag === "a") {
      const inApp = prefixedAppRoute(el.getAttribute("href"))
      if (inApp) el.setAttribute("href", inApp)
      const target = localMarkdownTarget(el.getAttribute("href"))
      if (target) {
        const imageUrl = localImageUrlForTarget(target)
        if (imageUrl) {
          // The server resolves the path and admits only supported images behind its origin gate.
          // Keep the author's link label and normal Markdown link treatment; only the destination is
          // rewritten so an absolute filesystem path cannot become a bogus same-origin web URL.
          el.setAttribute("href", imageUrl)
          el.setAttribute("title", target.display)
          el.setAttribute("data-local-path", target.filePath!)
          el.setAttribute("data-local-image", "true")
        } else {
          // Don't turn a filesystem path into a bogus localhost URL or inert code. The app-wide
          // same-origin click handler sends this explicit action to the server, which realpath-gates
          // it before invoking the selected desktop opener — EXCEPT for a `.md` file, which that same
          // handler opens in Frizz's own reader drawer instead. The markup is identical either way (one
          // `data-local-path` button); only the title says which of the two the click will do, because
          // the routing decision belongs to the click handler and not to every producer of a path.
          const readable = target.filePath && isLocalMarkdownFile(target.filePath)
          const button = document.createElement("button")
          button.type = "button"
          button.className = "local-file-action"
          button.title = readable ? `Read ${target.display}` : target.display
          if (target.filePath) button.setAttribute("data-local-path", target.filePath)
          while (el.firstChild) button.append(el.firstChild)
          el.replaceWith(button)
          continue
        }
      }
    }
    if (tag === "img") {
      const target = localMarkdownTarget(el.getAttribute("src"))
      const imageUrl = target && localImageUrlForTarget(target)
      if (!imageUrl) {
        // Only local files use the server's image proxy. Remote/data/file-host images stay disallowed.
        el.remove()
        continue
      }
      el.setAttribute("src", imageUrl)
      el.setAttribute("title", target.display)
      el.setAttribute("data-local-path", target.filePath!)
      el.setAttribute("data-local-image", "true")
      if (!el.getAttribute("alt")) el.setAttribute("alt", target.display)
      // Block prose only — see sanitize's `block`. The attribute loop below still runs on `el`, which
      // is the image itself; the frame around it is ours and is deliberately never re-walked.
      if (block) frameImage(el)
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      if (name === "class" && (tag === "code" || tag === "span")) {
        const classes = attr.value.split(/\s+/).filter((value) => ALLOWED_CLASS.test(value))
        if (classes.length > 0) el.setAttribute("class", classes.join(" "))
        else el.removeAttribute(attr.name)
        continue
      }
      const byTag = ALLOWED_ATTRS_BY_TAG[tag]?.[name]
      if (byTag) {
        if (!byTag.test(attr.value)) el.removeAttribute(attr.name)
        continue
      }
      if (!ALLOWED_ATTRS.has(name)) {
        el.removeAttribute(attr.name)
        continue
      }
      if (name === "href" && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name)
    }
    if (tag === "a") {
      el.setAttribute("target", "_blank")
      el.setAttribute("rel", "noopener noreferrer")
      // The hovercard handle (components/GithubHovercards.tsx reads it off a delegated pointerover).
      // Set from the DESTINATION and set LAST — after the allowlist loop above, which is what strips
      // any `data-gh-ref` an author hand-wrote in raw HTML. So the attribute always describes the URL
      // the anchor actually points at, and is never a value the prose chose.
      el.removeAttribute("data-gh-ref")
      const ghRef = githubRefFromUrl(el.getAttribute("href"))
      if (ghRef) el.setAttribute("data-gh-ref", ghRef)
    }
    walk(el, ctx)
  }
}

// Rewrite a relative or `~`-anchored destination into the absolute path it names on disk, so the
// branches below see the same thing they would have seen had the author written the path out in full.
// A no-op when the caller supplied no base at all, and for anything already absolute or schemed.
function rebaseRelative(el: Element, attr: "href" | "src", { baseDir, homeDir }: WalkContext): void {
  if (!baseDir && !homeDir) return
  const resolved = resolveRelativeLocalPath(el.getAttribute(attr), baseDir ?? "", homeDir)
  if (resolved) el.setAttribute(attr, resolved)
}

// Wrap a local Markdown image in the SAME frame every other rendered picture in the app sits in —
// components/ImageFrame, whose two boxes arrive here as class strings because this path builds HTML,
// not React. `![shot](/tmp/a.png)` used to render as a naked `<img>` while the identical screenshot
// written as a bare path (BlockImage) got a border, a mat and a height cap; one picture, two treatments,
// decided by which syntax the worker happened to use.
//
// SPANS, not the component's `<figure>`/`<div>`. marked renders an image as `<p><img></p>`, and this
// HTML is re-parsed by the browser when a surface injects it — where `<figure>`, not being phrasing
// content, makes the parser CLOSE the paragraph and split the prose around the picture. A span is
// phrasing content and survives that round trip intact; `md-image-frame` supplies the `display: block`
// the frame's own class does not carry.
//
// This runs AFTER the walk's allowlist decisions and mints its own elements, which is what keeps it
// safe: `figure`/`div`/`span`-with-arbitrary-class cannot be hand-written into a frame by an author,
// since those tags are not in ALLOWED_TAGS and this is the only code that builds one. Setting `class`
// outright (rather than merging) also drops any class a raw-HTML `<img>` smuggled past ALLOWED_ATTRS.
function frameImage(img: Element) {
  const doc = img.ownerDocument
  const frame = doc.createElement("span")
  frame.className = `${IMAGE_FRAME} md-image-frame`
  const mat = doc.createElement("span")
  mat.className = IMAGE_FRAME_MAT
  img.replaceWith(frame)
  frame.append(mat)
  mat.append(img)
  img.setAttribute("class", FRAMED_IMAGE)
}

// Splice an element's children in where the element stood. They are sanitized BEFORE the splice: the
// caller is iterating a snapshot of the parent's children and would never revisit them otherwise.
function unwrap(el: Element, ctx: WalkContext) {
  const frag = el.ownerDocument.createDocumentFragment()
  while (el.firstChild) frag.append(el.firstChild)
  walk(frag, ctx)
  el.replaceWith(frag)
}
