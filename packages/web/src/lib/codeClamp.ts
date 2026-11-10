// A LONG CODE BLOCK'S CLAMP: its class names and which blocks the reader has opened.
//
// Split out of lib/codeBlock.ts (2026-11-10) so the delegated show-all handler that main.tsx installs on
// every page (lib/expand-code.ts) can read and write it without loading marked and the highlighter,
// which codeBlock.ts needs and the board's first paint does not.

export const CODE_LONG_CLASS = "md-code-long"
export const CODE_CLAMPED_CLASS = "is-clamped"
export const CODE_EXPAND_CLASS = "md-code-expand"

// WHICH LONG BLOCKS ARE OPEN is remembered for the life of the page, for the reason lib/codeTabs.ts
// remembers the chosen tab: a streaming message re-renders its blocks on every delta and the transcript
// unmounts rows as it virtualizes, and either would shut a block the reader had just opened. A block's
// only identity in an HTML string is its text, so that is the key — its length and its head, which is
// as unique as two blocks on one page need.
const openLongBlocks = new Set<string>()
const longBlockKey = (text: string) => {
  const body = text.replace(/\n$/, "")
  return `${body.length}:${body.slice(0, 256)}`
}

/** Record that the long block with this text was opened or shut (lib/expand-code.ts, on the click). */
export function rememberLongBlock(text: string, open: boolean): void {
  if (open) openLongBlocks.add(longBlockKey(text))
  else openLongBlocks.delete(longBlockKey(text))
}

export function forgetLongBlocks(): void {
  openLongBlocks.clear()
}

export const longBlockLabel = (lines: number, open: boolean) => (open ? "Show less" : `Show all ${lines} lines`)

/** Whether the reader opened the long block with this text. */
export function isLongBlockOpen(text: string): boolean {
  return openLongBlocks.has(longBlockKey(text))
}
