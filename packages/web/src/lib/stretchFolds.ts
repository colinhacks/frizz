// THE WORK BETWEEN A HUMAN'S MESSAGE AND THE SIGN-OFF THAT ANSWERS IT, BEHIND ONE HAIRLINE (2026-11-11).
//
// A thread reads as a conversation: the human's message, the worker's first word on it, then the sign-off
// that answers it. Everything in between — narration between tool calls, wakes, sub-agent returns, quiet
// parks, earlier sign-offs the newest one replaced — is how the worker got there. The queue card drew it
// that way (`lib/queueCollapse`, an elision hairline per round), and the one-thread pane that replaced the
// card on 2026-11-09 drew the thread view, which never had a fold: a reylo thread on 0.15.51 showed ~25
// status lines, 6 park fences and 7 wakes above its one sign-off (maintainer 2026-11-11: "So many rounds
// that weren't collapsed"). The maintainer then chose the card's look over a first rewrite that folded the
// first message too (2026-11-12: "we always showed the very first text message that it gave after a user
// steer, and then the collapsed hairline, and then the sign-off").
//
// So every STRETCH — from a human turn (lib/messagePresentation isHumanTurn) to the next — that has a
// sign-off keeps its LEAD (the worker's first message with words in it) and its sign-offs, and folds the
// rest behind one hairline per run: each run between two of them, and at rest the run after the last (the
// wakes a quiet park came back to). The lead's own tool calls fold into the first hairline, as the card's
// did. The sign-offs are the server's reading (`signOff`, server sign-offs.ts), EVERY ONE of the stretch
// since 2026-11-16, less those whose questions were all withdrawn once a later one follows (lib/signOffs
// stretchSignOffs). The NEWEST stretch with no sign-off folds nothing: the worker is still going, or
// rested with nothing for the human yet, and either way its work is what there is to read. Neither does the
// run after the newest stretch's sign-off while the thread RUNS: that is the live work. An OLDER one the
// human typed past keeps its lead and folds the rest (2026-11-17): they interrupted it mid-turn, or came
// back to a quiet park, and its work is history like any other stretch's. Measured over the 776 Claude
// transcripts on the maintainer's Mac, after the server kept mid-turn questions and quiet-park replies
// (server sign-offs.ts): 152 such stretches, up to 63 status lines each, drew unfolded.
//
// Hiding the rest is safe because a sign-off is written for the human and the rest is not: narration
// between tool calls, wakes, sub-agent returns, quiet parks. From 2026-11-11 to 2026-11-16 the fold kept
// only the NEWEST sign-off, on a contract that made each sign-off the whole handoff, and it hid the
// write-ups a shorter, newer sign-off only added to (lib/signOffs has the measurement). Each sign-off now
// says what is new since the one before it, so the stretch reads as the human's message, the worker's first
// words, and each thing it came back to say. The transcript still never folds a message that holds a
// question's home card (ChatView's rows), as a net under a sign-off the server did not mark, nor one that
// shows the human a picture (lib/messagePictures), which a worker only ever does on purpose.
//
// Pure index logic: the transcript decides which of a range's rows fold (never a live card, and only
// where something is hidden), and draws the hairline.

import { splitFenceBlocks } from "./fenceBlocks.ts"
import { isHumanTurn, type HumanTurnLike } from "./messagePresentation.ts"
import { stretchSignOffs, type SignOffMsgLike } from "./signOffs.ts"

export type FoldMsg = HumanTurnLike & SignOffMsgLike & {
  wake?: boolean
  boundary?: string
  tools?: readonly unknown[]
}

/** The first and last message index a fold covers, inclusive, and the LEAD it follows: the message whose
 *  tool calls fold with it, drawn as its words alone while the fold is shut. */
export interface FoldRange {
  from: number
  to: number
  lead?: number
}

/** Says something to the human: an agent message with prose outside its signal fences (a bare park
 *  fence says nothing). */
function hasWords(m: FoldMsg): boolean {
  return m.role === "assistant" && !m.kind && m.text.trim() !== "" && splitFenceBlocks(m.text).some((s) => s.kind === "prose")
}

/** Every range to fold, oldest first. A page that opens mid-stretch folds that stretch too: its sign-offs
 *  still answer the human's message, which is only further up. `closedOnly(i)`: message `i` names
 *  questions and every one was withdrawn or dismissed (lib/signOffs stretchSignOffs). */
export function stretchFoldRanges(messages: readonly FoldMsg[], opts: { running: boolean; closedOnly?: (i: number) => boolean }): FoldRange[] {
  const starts: number[] = messages.length > 0 && !isHumanTurn(messages[0]) ? [-1] : []
  messages.forEach((m, i) => {
    if (isHumanTurn(m)) starts.push(i)
  })
  const out: FoldRange[] = []
  starts.forEach((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] - 1 : messages.length - 1
    const kept = stretchSignOffs(messages.slice(0, end + 1), start, opts.closedOnly)
    if (kept.length === 0) {
      // Typed past with no sign-off in it: the lead, then one hairline over the rest (see the header).
      if (k + 1 === starts.length) return
      let lead = -1
      if (start >= 0) {
        for (let i = start + 1; i <= end; i++) {
          if (hasWords(messages[i])) { lead = i; break }
        }
      }
      const from = lead >= 0 ? lead + 1 : start + 1
      if (from <= end) out.push({ from, to: end, ...(lead >= 0 ? { lead } : {}) })
      return
    }
    // The lead: the worker's first words after the human's turn, when they come before the sign-off. A page
    // that opens mid-stretch has no lead to show, since its first words are further up.
    let lead = -1
    if (start >= 0) {
      for (let i = start + 1; i < kept[0]; i++) {
        if (hasWords(messages[i])) { lead = i; break }
      }
    }
    let from = lead >= 0 ? lead + 1 : start + 1
    for (const [n, at] of kept.entries()) {
      if (at > from) out.push({ from, to: at - 1, ...(n === 0 && lead >= 0 ? { lead } : {}) })
      from = at + 1
    }
    const live = opts.running && k === starts.length - 1
    if (!live && from <= end) out.push({ from, to: end })
  })
  return out
}

/** What a hairline stands for: the rounds that began inside it (each Frizz wake, or a background task's
 *  return, re-invoked the worker) and the tool calls, the lead's included. */
export function foldCounts(messages: readonly FoldMsg[], range: FoldRange): { rounds: number; calls: number } {
  let rounds = 0
  let calls = range.lead !== undefined ? messages[range.lead].tools?.length ?? 0 : 0
  for (let i = range.from; i <= range.to; i++) {
    const m = messages[i]
    if ((m.role === "user" && m.wake) || m.boundary === "wake") rounds++
    calls += m.tools?.length ?? 0
  }
  return { rounds, calls }
}
