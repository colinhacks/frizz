import hljs from "highlight.js/lib/core"
import bash from "highlight.js/lib/languages/bash"
import css from "highlight.js/lib/languages/css"
import diff from "highlight.js/lib/languages/diff"
import javascript from "highlight.js/lib/languages/javascript"
import json from "highlight.js/lib/languages/json"
import markdown from "highlight.js/lib/languages/markdown"
import python from "highlight.js/lib/languages/python"
import rust from "highlight.js/lib/languages/rust"
import sql from "highlight.js/lib/languages/sql"
import typescript from "highlight.js/lib/languages/typescript"
import xml from "highlight.js/lib/languages/xml"
import yaml from "highlight.js/lib/languages/yaml"
import { renderAnsi } from "./ansi.ts"
import { CODE_BLOCK_CLASS, CODE_COPY_CLASS, COPY_CODE_LABEL, escapeHtml, resolveFenceLanguage, type FenceLanguage } from "./codeLanguage.ts"

export * from "./codeLanguage.ts"

// First-cut fenced-language set. Keep this explicit: importing highlight.js/lib/core plus only these
// grammars avoids shipping the package's ~190-language default bundle. Aliases are normalized here
// rather than guessed by highlightAuto, so unknown/user-controlled info strings always stay plaintext.
const GRAMMARS = {
  bash,
  css,
  diff,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
} as const

for (const [name, grammar] of Object.entries(GRAMMARS)) hljs.registerLanguage(name, grammar)

// Escaped, `hljs-*`-classed markup for one code body — WITHOUT any block chrome. The fenced-block
// renderer below wraps it in its own <pre>/<code>/copy-button; the transcript's non-markdown code
// surfaces (a Bash card's command, a Read card's excerpt — components/CodeBody.tsx) drop it straight
// into the <pre> they already own, so their layout, clamping and wrapping rules stay untouched.
//
// The output is safe to inject as-is: the input is PLAIN TEXT, so every character either comes back
// escaped by hljs or by escapeHtml, and the only markup in the result is hljs's own token spans (or,
// for `ansi`, lib/ansi.ts's styled spans, whose only attributes are fixed classes and a hex colour).
// That is why this needs no sanitizer pass, unlike the markdown pipeline (which has other HTML
// sources and therefore sanitizes everything).
export function highlightToHtml(text: string, language: FenceLanguage): string {
  if (language === "plaintext") return escapeHtml(text)
  if (language === "ansi") return renderAnsi(text)
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value
  } catch {
    // A malformed grammar input must never take down transcript rendering. The raw text remains
    // visible, escaped, and selectable; there is deliberately no automatic language guessing.
    return escapeHtml(text)
  }
}

// One fenced body as its `<code>` element: the plain block below and a tab panel (lib/codeTabs.ts) are
// the same code inside different chrome, so they mint it in one place. Match Marked's stock code
// renderer: exactly one trailing LF is present in the resulting <code>, preserving selection/copy
// behavior for both complete and still-streaming (unclosed) fences.
export function renderCodeElement(text: string, language: FenceLanguage, name: string = language): string {
  const code = `${text.replace(/\n$/, "")}\n`
  return `<code class="hljs language-${name}">${highlightToHtml(code, language)}</code>`
}

// `title` is the accessible name — `aria-label` is not in the render allowlist.
export const CODE_COPY_BUTTON = `<button type="button" class="${CODE_COPY_CLASS}" title="${COPY_CODE_LABEL}"></button>`

export function renderHighlightedCode(text: string, infoString?: string): string {
  const language = resolveFenceLanguage(infoString)
  // A ```lightbox fence is a list of picture paths (lib/lightbox.ts), not code. It is escaped as plain
  // text like any unknown language, but keeps its NAME on the block: that class is how a surface that
  // injects a whole body as one block of HTML — a signal card, a question card, the file readers — finds
  // the fence and draws a gallery in its place (components/Lightbox.tsx useLightboxIslands). Anywhere
  // that pass does not run, it stays a readable code block.
  // A ```mermaid fence keeps its name the same way, for the diagram (useMermaidIslands).
  const name = /^\s*(lightbox|mermaid)\s*$/i.exec(infoString ?? "")?.[1].toLowerCase() ?? language
  // No whitespace anywhere inside the <pre>: it preserves it, so a newline before the <code> would print
  // as a blank first line. The button follows the block in DOM order so a keyboard walk reaches the code
  // before its affordance.
  return `<span class="${CODE_BLOCK_CLASS}"><pre>${renderCodeElement(text, language, name)}</pre>${CODE_COPY_BUTTON}</span>\n`
}
