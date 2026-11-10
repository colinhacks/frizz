// THE LANGUAGE TABLE AND THE CODE BLOCK'S CLASS NAMES, with no highlighter behind them.
//
// The delegated click handlers main.tsx installs on every page (lib/copy-code.ts, lib/expand-code.ts)
// and the file readers' language lookup need only these names. They lived in lib/syntaxHighlight.ts,
// whose module body loads highlight.js and registers its grammars, so every page paid for the
// highlighter in its entry chunk before it had drawn one code block. Split out 2026-11-10; the
// highlighter itself (syntaxHighlight.ts) re-exports all of this, so its importers are unchanged.

export const SUPPORTED_FENCE_LANGUAGES = Object.freeze({
  bash: ["bash", "sh", "shell", "zsh"],
  css: ["css"],
  diff: ["diff", "patch"],
  javascript: ["javascript", "js", "jsx", "mjs", "cjs"],
  json: ["json", "jsonc"],
  markdown: ["markdown", "md", "mdx"],
  python: ["python", "py"],
  rust: ["rust", "rs"],
  sql: ["sql"],
  typescript: ["typescript", "ts", "tsx", "mts", "cts"],
  xml: ["xml", "html", "svg"],
  yaml: ["yaml", "yml"],
} as const)

export type SupportedFenceLanguage = keyof typeof SUPPORTED_FENCE_LANGUAGES
// `ansi` is a fence language without an hljs grammar: terminal output whose escape sequences are drawn
// as colour (lib/ansi.ts). Fence-only — no file extension resolves to it.
export type FenceLanguage = SupportedFenceLanguage | "ansi" | "plaintext"

const ALIAS_TO_LANGUAGE = new Map<string, SupportedFenceLanguage>()
for (const [language, aliases] of Object.entries(SUPPORTED_FENCE_LANGUAGES)) {
  for (const alias of aliases) ALIAS_TO_LANGUAGE.set(alias, language as SupportedFenceLanguage)
}

const PLAINTEXT_ALIASES = new Set(["", "text", "txt", "plain", "plaintext"])

// Filename → grammar, for the surfaces that highlight a FILE rather than a declared fence: a Read
// card's excerpt, a Write body. Deliberately derived from SUPPORTED_FENCE_LANGUAGES' own aliases —
// most extensions already ARE the fence alias (`ts`, `py`, `rs`, `yml`) — with only the handful that
// differ listed explicitly below. That way a grammar added to the set above reaches both surfaces at
// once and the two can never drift into disagreeing about what `.ts` is.
const EXTRA_EXTENSIONS: Readonly<Record<string, SupportedFenceLanguage>> = Object.freeze({
  htm: "xml",
  scss: "css",
  less: "css",
})

// Extensionless files whose NAME is the type. Kept short and certain: a wrong guess here paints a
// whole file in the wrong grammar, which reads worse than no colour at all.
const FILENAME_LANGUAGES: Readonly<Record<string, SupportedFenceLanguage>> = Object.freeze({
  dockerfile: "bash",
  makefile: "bash",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".profile": "bash",
  ".gitignore": "bash",
  ".env": "bash",
})

// Resolve an absolute or repo-relative path to a grammar; anything unrecognized stays plaintext, for
// the same reason fences never guess. A dotfile with no other dot (`.gitignore`) has no extension —
// `lastIndexOf(".") > 0` is what keeps its leading dot from being read as one.
export function resolveFileLanguage(path?: string): FenceLanguage {
  const name = (path ?? "").split(/[/\\]/).pop()?.trim().toLowerCase() ?? ""
  if (!name) return "plaintext"
  if (FILENAME_LANGUAGES[name]) return FILENAME_LANGUAGES[name]
  const dot = name.lastIndexOf(".")
  if (dot <= 0) return "plaintext"
  const ext = name.slice(dot + 1)
  return EXTRA_EXTENSIONS[ext] ?? ALIAS_TO_LANGUAGE.get(ext) ?? "plaintext"
}

// Marked passes the whole fence info string as `lang`; highlighting uses its first whitespace-delimited
// word just as Marked's stock renderer does. The remaining metadata is intentionally left untouched for
// the upstream signal/question fence parsers, which remove their special blocks before markdown render.
export function resolveFenceLanguage(infoString?: string): FenceLanguage {
  const declared = (infoString ?? "").trim().split(/\s+/, 1)[0].toLowerCase()
  if (PLAINTEXT_ALIASES.has(declared)) return "plaintext"
  if (declared === "ansi") return "ansi"
  return ALIAS_TO_LANGUAGE.get(declared) ?? "plaintext"
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => {
    if (char === "&") return "&amp;"
    if (char === "<") return "&lt;"
    if (char === ">") return "&gt;"
    if (char === '"') return "&quot;"
    return "&#39;"
  })
}

// The copy affordance is minted HERE, in the HTML string, rather than rendered as a component: a fenced
// block leaves this pipeline as markup that every surface injects with innerHTML, so there is no React
// element to hang a button on. That is the same constraint the sanitizer's local-file link already lives
// under (markdown.ts), and the click is likewise handled by one delegated listener — lib/copy-code.ts.
//
// The WRAPPER exists because `<pre>` is the scroller (`overflow-x: auto`, and with the Wrap code setting
// off a long line really does scroll): a button positioned inside it rides the content and slides out of
// view the moment a long line is scrolled, so the anchor has to be an element that does not scroll. A
// SPAN rather than a div for the reason markdown.ts's frameImage gives —
// this HTML is re-parsed by the browser when a surface injects it, and a non-phrasing wrapper makes the
// parser restructure the block around it; `.md-code` supplies the display/position it needs.
//
// The button carries no inline `<svg>`: the sanitizer drops svg WITH its subtree, so both glyphs (copy,
// and the check the delegated handler swaps to) are lucide paths carried as mask-image data URIs in
// styles.css, exactly as the markdown task marks are.
export const CODE_BLOCK_CLASS = "md-code"
export const CODE_COPY_CLASS = "md-code-copy"
export const CODE_COPIED_CLASS = "is-copied"
export const COPY_CODE_LABEL = "Copy code"
