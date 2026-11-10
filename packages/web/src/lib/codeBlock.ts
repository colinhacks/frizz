// THE ONE BUILDER for a fenced code block's markup. Everything a fence can be drawn with is decided
// here, from its info string and its text alone:
//
//   a label            → a title bar, or a tab when its neighbours are labelled too (lib/codeTabs.ts)
//   `{2,4-5}`          → those lines marked (lib/codeLines.ts)
//   `diff`, `ts-diff`  → rows with a sign column and tinted lines (lib/codeDiff.ts)
//   over 40 lines      → the first 24, and a button for the rest (lib/expand-code.ts)
//
// A fence with none of those leaves this file as exactly the markup `renderHighlightedCode` has always
// produced — the features are additive, and the common block pays nothing for them.
//
// THE FRAME. A plain block's border belongs to its `<pre>`. A block with a row above or below the code
// (a title, tabs, the expand button) is one box around several children, so the WRAPPER takes the
// border and clips them to its arc: that is `md-code-frame`.
//
// SPANS and buttons only, and no whitespace between the children — for the reasons
// `renderHighlightedCode` gives. This HTML is re-parsed where a surface injects it; a non-phrasing
// wrapper would be restructured by the parser, and a `<pre>` prints the whitespace around it.

import type { TokenizerAndRendererExtension } from "marked"
import { parseDiffFence, renderDiffFence } from "./codeDiff.ts"
import { CODE_CLAMPED_CLASS, CODE_EXPAND_CLASS, CODE_LONG_CLASS, isLongBlockOpen, longBlockLabel } from "./codeClamp.ts"
// The long-block state and its class names live in lib/codeClamp.ts, which the delegated show-all handler
// (lib/expand-code.ts) reads without loading marked or the highlighter; re-exported for this module's importers.
export { CODE_CLAMPED_CLASS, CODE_EXPAND_CLASS, CODE_LONG_CLASS, forgetLongBlocks, longBlockLabel, rememberLongBlock } from "./codeClamp.ts"
import { isMarkedLine, parseLineMarks, renderLinedCode } from "./codeLines.ts"
import {
  CODE_PANEL_CLASS,
  CODE_TAB_ACTIVE_CLASS,
  CODE_TAB_CLASS,
  CODE_TABLIST_CLASS,
  CODE_TABS_CLASS,
  CODE_TITLE_CLASS,
  openTabIndex,
  parseFenceLabel,
  type CodeTabsToken,
} from "./codeTabs.ts"
import {
  CODE_BLOCK_CLASS,
  CODE_COPY_BUTTON,
  escapeHtml,
  highlightToHtml,
  renderCodeElement,
  renderHighlightedCode,
  resolveFenceLanguage,
  resolveFileLanguage,
  type FenceLanguage,
} from "./syntaxHighlight.ts"

export const CODE_FRAME_CLASS = "md-code-frame"
export const CODE_LINED_CLASS = "md-code-lined"
export const CODE_DIFF_CLASS = "md-diff"

// A block longer than OVER lines is drawn SHOWN lines tall until the reader opens it. The gap between
// the two is deliberate: a button that reveals two more lines is worse than the two lines. SHOWN is
// also in styles.css (`.md-code-long.is-clamped`), which is what actually clamps — keep them equal.
export const LONG_BLOCK_OVER = 40
export const LONG_BLOCK_SHOWN = 24

export interface CodePart {
  /** Drawn as the block's title, or as its tab when there are several parts. */
  label?: string
  /** The fence's info string as written. */
  info: string
  text: string
  /** False for a fence still being written — it is never collapsed under the reader. */
  closed: boolean
}

// The fences a surface replaces with something that is not code (components/Lightbox.tsx's islands).
// They keep the one markup those passes look for, whatever else their info string says.
const ISLAND_FENCE = /^(?:lightbox|mermaid)$/i


// A rendered FILE is not collapsed: its author laid the document out, and the reader opened it to read
// it. marked's renderers take no per-call options, and a parse is synchronous, so the file reader's
// parse runs inside this and the builder reads the flag.
let collapseLongBlocks = true

export function withLongBlocksOpen<T>(render: () => T): T {
  const before = collapseLongBlocks
  collapseLongBlocks = false
  try {
    return render()
  } finally {
    collapseLongBlocks = before
  }
}

interface Panel {
  /** The `<code>` element. */
  code: string
  /** What its `<pre>` is classed with, beyond the tab classes. */
  classes: string[]
  lines: number
  long: boolean
  open: boolean
  /** A diff's own file and counts, for the title bar of a block standing alone. */
  diff?: { file: string | null; additions: number; deletions: number }
}

// A label names its block's language when the author declared none: ```` ```title="server.ts" ````.
// A DECLARED language always wins, plaintext included — `text title="out.json"` asked for no colour.
function languageOf(part: CodePart): FenceLanguage {
  if (part.label === undefined) return resolveFenceLanguage(part.info)
  const declared = parseFenceLabel(part.info)?.language
  return declared ? resolveFenceLanguage(declared) : resolveFileLanguage(part.label)
}

function buildPanel(part: CodePart): Panel {
  const body = `${part.text.replace(/\n$/, "")}\n`
  const lines = body.split("\n").length - 1
  const diffFence = parseDiffFence(part.info)
  const marks = diffFence ? null : parseLineMarks(part.info)
  const classes: string[] = []
  let code: string
  let diff: Panel["diff"]

  if (diffFence) {
    const rendered = renderDiffFence(part.text, { declared: diffFence.declared, label: part.label })
    code = `<code class="hljs language-diff">${rendered.html}</code>`
    classes.push(CODE_DIFF_CLASS)
    // The gutter is as wide as the longest number in it, which only this file knows.
    if (rendered.digits > 0) classes.push(`md-diff-n${Math.min(rendered.digits, 6)}`)
    diff = { file: rendered.file, additions: rendered.additions, deletions: rendered.deletions }
  } else if (marks) {
    const language = languageOf(part)
    code = `<code class="hljs language-${language}">${renderLinedCode(highlightToHtml(body, language), marks)}</code>`
    classes.push(CODE_LINED_CLASS)
  } else {
    code = renderCodeElement(part.text, languageOf(part))
  }

  // A line the author marked is one they want seen, so a block that marks one below the fold stays open.
  let markedBelow = false
  if (marks) for (let line = LONG_BLOCK_SHOWN + 1; line <= lines && !markedBelow; line++) markedBelow = isMarkedLine(marks, line)
  const long = collapseLongBlocks && part.closed && lines > LONG_BLOCK_OVER && !markedBelow
  const open = long && isLongBlockOpen(part.text)
  if (long) classes.push(open ? CODE_LONG_CLASS : `${CODE_LONG_CLASS} ${CODE_CLAMPED_CLASS}`)
  return { code, classes, lines, long, open, diff }
}

// A tab truncates past its max width (styles.css); only then does the full label need a tooltip, and a
// short one repeating itself on hover is noise.
const TOOLTIP_FROM = 28
const tooltip = (label: string) => (label.length >= TOOLTIP_FROM ? ` title="${escapeHtml(label)}"` : "")

// U+2212, the minus the Edit card's own counts use (components/DiffBlock.tsx) — a hyphen is narrower
// than the plus beside it.
function diffStat({ additions, deletions }: { additions: number; deletions: number }): string {
  if (additions === 0 && deletions === 0) return ""
  return `<span class="md-diff-stat">`
    + (additions > 0 ? `<span class="md-diff-adds">+${additions}</span>` : "")
    + (deletions > 0 ? `<span class="md-diff-dels">−${deletions}</span>` : "")
    + `</span>`
}

const expandButton = (panel: Panel) =>
  `<button type="button" class="${CODE_EXPAND_CLASS}" aria-expanded="${panel.open}">${longBlockLabel(panel.lines, panel.open)}</button>`

/**
 * One fenced block — or, given several labelled parts, one block with a tab for each.
 *
 * One part with a label is a TITLED block, not a tab: a `<span>`, with no tab roles to promise a choice
 * that is not there. A diff standing alone takes its title from its own `+++` header when it has no
 * label, and the header lines the title now repeats are hidden (they are still in the text Copy takes).
 */
export function renderCodeBlock(parts: readonly CodePart[]): string {
  const single = parts.length === 1
  const island = single && ISLAND_FENCE.test(parts[0].info.trim().split(/\s+/, 1)[0])
  // An island fence STILL BEING WRITTEN gives up its name, so it is a plain code block until its closing
  // line arrives: the pass that swaps a named block for a diagram or a gallery cannot tell half a fence
  // from a whole one in the HTML, and would draw (and fail to draw) a new one on every delta.
  if (island) return renderHighlightedCode(parts[0].text, parts[0].closed ? parts[0].info : "")

  const panels = parts.map(buildPanel)
  const title = single ? parts[0].label ?? panels[0].diff?.file ?? undefined : undefined
  const headed = !single || title !== undefined
  const framed = headed || panels.some((panel) => panel.long)

  if (!framed) {
    const [{ code, classes }] = panels
    // Nothing this file adds applies: the block is the one `renderHighlightedCode` has always drawn.
    if (classes.length === 0) return renderHighlightedCode(parts[0].text, parts[0].info)
    return `<span class="${CODE_BLOCK_CLASS}"><pre class="${classes.join(" ")}">${code}</pre>${CODE_COPY_BUTTON}</span>\n`
  }

  const open = single ? 0 : openTabIndex(parts.map((part) => part.label ?? ""))
  let header = ""
  if (single && title !== undefined) {
    // Titled from the diff itself: its file header says nothing the title does not.
    if (parts[0].label === undefined) panels[0].classes.push("md-diff-titled")
    header = `<span class="${CODE_TABLIST_CLASS}"><span class="${CODE_TITLE_CLASS}"${tooltip(title)}>${escapeHtml(title)}</span>`
      + `${panels[0].diff ? diffStat(panels[0].diff) : ""}</span>`
  } else if (!single) {
    header = `<span class="${CODE_TABLIST_CLASS}" role="tablist">` + parts.map((part, i) => {
      const active = i === open
      const label = part.label ?? ""
      return `<button type="button" class="${CODE_TAB_CLASS}${active ? ` ${CODE_TAB_ACTIVE_CLASS}` : ""}" role="tab"`
        + ` aria-selected="${active}"${tooltip(label)}>${escapeHtml(label)}</button>`
    }).join("") + `</span>`
  }

  const body = panels.map((panel, i) => {
    const classes = [
      ...(headed ? [i === open ? `${CODE_PANEL_CLASS} ${CODE_TAB_ACTIVE_CLASS}` : CODE_PANEL_CLASS] : []),
      ...panel.classes,
    ]
    return `<pre${classes.length > 0 ? ` class="${classes.join(" ")}"` : ""}${single ? "" : ` role="tabpanel"`}>${panel.code}</pre>`
      + (panel.long ? expandButton(panel) : "")
  }).join("")

  return `<span class="${CODE_BLOCK_CLASS} ${CODE_FRAME_CLASS}${headed ? ` ${CODE_TABS_CLASS}` : ""}">`
    + `${header}${body}${CODE_COPY_BUTTON}</span>\n`
}

// The token is only ever minted by `groupCodeTabs`, which needs a fence's SIBLINGS — something a
// tokenizer reading forward from one position cannot see. So this tokenizer claims nothing, exactly as
// the task-status extension in markdown.ts does, and the extension exists for its renderer.
export const codeTabsExtension: TokenizerAndRendererExtension = {
  name: "codeTabs",
  level: "block",
  tokenizer() {
    return undefined
  },
  renderer(token) {
    return renderCodeBlock((token as CodeTabsToken).tabs)
  },
}
