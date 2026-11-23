// THE `/` TOKEN the skills menu completes (components/SlashTypeahead.tsx), found from the caret the way
// Notion's `/` menu and Claude Code's own are: a `/` that starts the draft or follows whitespace opens
// it, anywhere in the text, and the menu filters on what has been typed between the `/` and the caret.
//
// Mid-text matters as much as the start. Measured against claude 2.1.328 (2026-11-23, a throwaway skill
// that only answers a codeword): `/banana-test` as the whole message is expanded by the harness, and
// "Before anything else, run /banana-test and tell me what it says" has the model call its Skill tool
// for it. Codex receives either as text and reads the name as a mention of the skill.
//
// What does NOT open it: a `/` inside a word (`src/foo`, `and/or`), and a second `/` before the caret
// (`/Users/colin`), both of which are paths or prose rather than a skill being named.

export type SlashToken = {
  /** Offset of the `/`. */
  start: number
  /** Offset just past the token: the next whitespace, or the end of the text. */
  end: number
  /** What is typed between the `/` and the caret, which the menu filters on. */
  query: string
}

export function slashTokenAt(text: string, caret: number): SlashToken | null {
  if (caret < 1 || caret > text.length) return null
  let start = caret - 1
  while (start >= 0 && !/\s/.test(text[start]!)) start--
  start++
  if (text[start] !== "/" || start >= caret) return null
  const query = text.slice(start + 1, caret)
  if (query.includes("/")) return null
  let end = caret
  while (end < text.length && !/\s/.test(text[end]!)) end++
  return { start, end, query }
}

/**
 * The text with `token` replaced by `/name`, and where the caret goes: past one space after the name,
 * reusing a space that already follows the token and typing one otherwise (a newline stays where it is,
 * on the far side of the caret).
 */
export function acceptSlashToken(text: string, token: SlashToken, name: string): { text: string; caret: number } {
  const after = text.slice(token.end)
  const inserted = after.startsWith(" ") ? `/${name}` : `/${name} `
  const caret = token.start + `/${name}`.length + 1
  return { text: `${text.slice(0, token.start)}${inserted}${after}`, caret }
}
