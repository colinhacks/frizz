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
// sign-off keeps its LEAD (the worker's first message with words in it) and the sign-off, and folds the
// rest behind one hairline per run: the run between the two, and at rest the run after the sign-off (the
// wakes a quiet park came back to). The lead's own tool calls fold into the first hairline, as the card's
// did. The sign-off is the server's reading (`signOff`, server sign-offs.ts): the newest one of the
// stretch, with the bare write-up a reminder's answer points back to (lib/signOffs latestSignOffs). A
// stretch with no sign-off folds nothing: the worker is still going, or rested with nothing for the human,
// and either way its work is what there is to read. Neither does the run after the newest stretch's
// sign-off while the thread RUNS: that is the live work.
//
// Hiding the rest is safe because a sign-off is the whole handoff now: it replaces the one before it and
// names every open question (server scheduler SOURCE 18). The transcript still never folds a message that
// holds a live question card (ChatView's rows), as a net under a worker that broke the rule.
//
// Pure index logic: the transcript decides which of a range's rows fold (never a live card, and only
// where something is hidden), and draws the hairline.

import { splitFenceBlocks } from "./fenceBlocks.ts"
import { isHumanTurn, type HumanTurnLike } from "./messagePresentation.ts"
import { latestSignOffs, type SignOffMsgLike } from "./signOffs.ts"

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

/** Every range to fold, oldest first. A page that opens mid-stretch folds that stretch too: its sign-off
 *  still answers the human's message, which is only further up. */
export function stretchFoldRanges(messages: readonly FoldMsg[], opts: { running: boolean }): FoldRange[] {
  const starts: number[] = messages.length > 0 && !isHumanTurn(messages[0]) ? [-1] : []
  messages.forEach((m, i) => {
    if (isHumanTurn(m)) starts.push(i)
  })
  const out: FoldRange[] = []
  starts.forEach((start, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] - 1 : messages.length - 1
    const kept = latestSignOffs(messages.slice(0, end + 1), start)
    if (kept.length === 0) return
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
