// WHICH ```done / ```awaiting FENCE A MESSAGE SIGNALS WITH — one rule, read by the server's fold (tailer
// parseSignalFence: does the thread park, finish, owe steps?) and the web's renderer (fenceBlocks: does the
// message draw a card?).
//
// They were two implementations until 2026-11-11, and they disagreed: the server took the last fence only
// when it closed the message, and the web drew the last fence wherever it sat. So a fence followed by prose,
// or by a ```question reference, or cut short by a code block inside it, drew a live card — tickable steps,
// a Mark as done — for a rest the server read as BARE: no steps on the to-do list, the thread queued as a
// bare rest, and the worker told "You rested without a fence" while the human looked at its fence (17 real
// rests on this Mac, one that day: a 12-step handoff whose email-to-paste code block closed the fence
// early). And the server read a fence the web knew to be QUOTED inside another code block.
//
// THE RULE
//
//   · A signal fence opens on a line that is a run of three or more backticks and the bare word `done` or
//     `awaiting`, and closes on a line that is a run at least as long and nothing else (CommonMark's rule,
//     so a fence whose steps carry code blocks opens with four).
//   · One sitting inside another code block is being QUOTED (a worker showing the human what a fence looks
//     like), and is not a fence at all (code-fences.ts insideFence).
//   · Only the LAST one signals, and only when it closes the message: nothing may follow it but whitespace
//     and ```question fences. Prose after a fence means it was explanatory, not a sign-off.
//
// WHY ```question FENCES MAY FOLLOW IT. The contract asks for questions above the signal fence, and a
// worker that puts its standing questions' `id:` references under it instead still plainly signed off:
// those were 11 of the 17 disagreements above, ten rests of one thread. Reading that rest as bare told the
// worker it had not fenced, which it had, and changed nothing about the questions, which register from
// wherever they are written.

import { insideFence } from "./code-fences.ts"
import { questionFenceBlocks } from "./question-fence.ts"

const SIGNAL_FENCE = /^(`{3,})(done|awaiting)[ \t]*\r?\n([\s\S]*?)\r?\n\1`*[ \t]*$/gm

export interface SignalFenceBlock {
  kind: "done" | "awaiting"
  /** The text between the opening and closing lines. */
  raw: string
  /** Offset of the opening line's first character. */
  start: number
  /** Offset just past the closing line (its newline not included). */
  end: number
}

/** Every signal fence a message writes, in order, leaving out one quoted inside another code block. */
export function signalFenceBlocks(text: string): SignalFenceBlock[] {
  const quoted = insideFence(text)
  const out: SignalFenceBlock[] = []
  const re = new RegExp(SIGNAL_FENCE.source, SIGNAL_FENCE.flags)
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (quoted(m.index)) {
      re.lastIndex = m.index + 1
      continue
    }
    out.push({ kind: m[2] as "done" | "awaiting", raw: m[3], start: m.index, end: m.index + m[0].length })
  }
  return out
}

/** Does nothing follow `end` but whitespace and ```question fences? */
function closesMessage(text: string, end: number): boolean {
  const rest = text.slice(end)
  if (!rest.trim()) return true
  let left = rest
  for (const block of questionFenceBlocks(rest).reverse()) left = left.slice(0, block.start) + left.slice(block.end)
  return !left.trim()
}

/** The fence the message signals with: its last signal fence, when that closes the message. */
export function signalFenceOf(text: string): SignalFenceBlock | undefined {
  const last = signalFenceBlocks(text).at(-1)
  return last && closesMessage(text, last.end) ? last : undefined
}
