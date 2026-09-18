import { Lexer } from "marked"
import type { Token, Tokens } from "marked"
import { childArrays } from "./githubAutolink.ts"

// A Windows path is written with backslashes, and CommonMark reads a backslash before punctuation as
// an ESCAPE. `D:\Development\CloudIPMSjb\.frizz\threads\x.md` therefore renders as
// `D:\Development\CloudIPMSjb.frizz\threads\x.md`: `\D`, `\t` and `\x` survive because a letter is
// not punctuation, while `\.` collapses to `.` — one directory silently fused with the next. marked
// applies the rule in prose (an `escape` token) and in a link or image DESTINATION (the tokenizer
// unescapes `href`), so both the label the reader sees and the path the click opens were wrong, and
// the opener was handed a file that does not exist. Every scratch directory is `.frizz`, every
// settings directory is `.claude`, so on Windows the mangled shape was the common case, not an edge.
//
// Inside a Windows path a backslash is a separator, never an escape, so this pass puts the byte back.
// It runs on TOKENS rather than the source for the same reason the GitHub autolinker does: a fenced
// block and a code span are literal by construction and never see it, and nothing here can change
// what marked chose to tokenize — only the text an escape renders as and the href a link carries.

// Keep one-letter URL schemes such as x://host/p out; only the BACKSLASH separator can carry an escape.
const WINDOWS_ABSOLUTE_PATH = /^[a-zA-Z]:\\(?!\\)/

// The run of non-blank text immediately before an escape, ending inside a drive path: the drive letter
// sits at a word boundary and nothing but non-blank characters follows its `X:\`. A path with spaces
// cannot be told from prose in a text token, so the run stops at whitespace — the same convention the
// bare-URL autolinker relies on, and the shape agents actually write.
const WINDOWS_PATH_RUN = /(?<![A-Za-z0-9])[A-Za-z]:\\\S*$/

// marked's own link grammar, re-applied to a link token's `raw` to read the destination back BEFORE
// the tokenizer's unescape. The token carries only the unescaped href; the raw source still has the
// author's bytes.
const LINK_RULE = Lexer.rules.inline.normal.link

function trailingRun(text: string): string {
  return /\S*$/.exec(text)?.[0] ?? ""
}

// A link or image whose destination is a Windows drive path: restore the destination as written.
function restoreDestination(token: Tokens.Link | Tokens.Image): void {
  if (!WINDOWS_ABSOLUTE_PATH.test(token.href)) return
  const cap = LINK_RULE.exec(token.raw)
  if (!cap) return
  let dest = cap[2].trim()
  if (dest.startsWith("<") && dest.endsWith(">")) dest = dest.slice(1, -1)
  if (WINDOWS_ABSOLUTE_PATH.test(dest)) token.href = dest
}

/**
 * Put the separator back into every Windows path marked read an escape out of. Mutates in place.
 *
 * Prose: an `escape` token whose preceding siblings end in an unbroken `X:\…` run becomes the two
 * literal characters it was written as. `\\` is left alone — an author who doubles every backslash is
 * writing Markdown deliberately, and that form already renders correctly. Destinations: a link or
 * image whose href is a drive path takes the destination exactly as written in its raw source.
 */
export function restoreWindowsPathEscapes(tokens: Token[]): void {
  // The raw text since the last whitespace, across consecutive text/escape siblings.
  let run = ""
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (token.type === "link" || token.type === "image") restoreDestination(token as Tokens.Link)
    const children = childArrays(token)
    for (const array of children) restoreWindowsPathEscapes(array)
    if (token.type === "text" && children.length === 0) {
      run = trailingRun(run + token.raw)
      continue
    }
    if (token.type === "escape") {
      const punct = token.raw.slice(1)
      if (punct !== "\\" && WINDOWS_PATH_RUN.test(run)) {
        tokens[i] = { type: "text", raw: token.raw, text: token.raw } satisfies Tokens.Text
      }
      run = trailingRun(run + token.raw)
      continue
    }
    run = ""
  }
}
