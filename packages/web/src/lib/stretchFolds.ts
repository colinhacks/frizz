// THE WORK BETWEEN A HUMAN'S MESSAGE AND THE SIGN-OFF THAT ANSWERS IT, FOLDED (2026-11-11).
//
// A thread reads as a conversation: the human's message, then the sign-off that answers it. Everything in
// between — narration between tool calls, wakes, sub-agent returns, quiet parks, earlier sign-offs the
// newest one replaced — is how the worker got there, and it was drawn in full: a reylo thread opened from
// the queue showed ~25 one-line status messages, 6 park fences and 7 wakes above its one sign-off
// (maintainer 2026-11-11: "There is so much shit being rendered … above the sign-off message. So many
// rounds that weren't collapsed"). Tool calls already folded into `Ran N tool calls`; each line of prose
// between them broke the fold.
//
// So every STRETCH — from a human turn (lib/messagePresentation isHumanTurn) to the next — that has a
// sign-off folds the rest of itself, behind one row per run: the run before the sign-off, and the run after
// it (the wakes a quiet park came back to). The sign-off is the server's reading (`signOff`, server
// sign-offs.ts): the newest one of the stretch, with the bare write-up a reminder's answer points back to
// (lib/signOffs latestSignOffs). A stretch with no sign-off folds nothing: the worker is still going, or it
// rested with nothing for the human, and either way its work is what there is to read. Neither does the
// run of the newest stretch after its sign-off while the thread RUNS: that is the live work.
//
// Hiding the rest is safe because a sign-off is the whole handoff now: it replaces the one before it and
// names every open question (server scheduler SOURCE 18). The transcript still never folds a message that
// holds a live question card (ChatView's rows), as a net under a worker that broke the rule.
//
// Pure index logic: the transcript decides which of a range's rows fold (a run of at least two, never a
// live card), and draws the row.

import { formatRuntimeElapsed } from "./durationLabels.ts"
import { splitFenceBlocks } from "./fenceBlocks.ts"
import { isHumanTurn, type HumanTurnLike } from "./messagePresentation.ts"
import { latestSignOffs, type SignOffMsgLike } from "./signOffs.ts"

export type FoldMsg = HumanTurnLike & SignOffMsgLike & {
  at?: string
  wake?: boolean
  tools?: readonly unknown[]
}

/** The first and last message index a fold covers, inclusive. */
export interface FoldRange {
  from: number
  to: number
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
    let from = start + 1
    for (const at of kept) {
      if (at > from) out.push({ from, to: at - 1 })
      from = at + 1
    }
    const live = opts.running && k === starts.length - 1
    if (!live && from <= end) out.push({ from, to: end })
  })
  return out
}

/** The fold row's words: how long the folded run took, and what is in it. A message is one with words of
 *  its own (a bare park fence says nothing); a wake is anything Frizz delivered. */
export function foldSummary(messages: readonly FoldMsg[], range: FoldRange): string {
  let said = 0
  let calls = 0
  let wakes = 0
  for (let i = range.from; i <= range.to; i++) {
    const m = messages[i]
    if (m.role === "assistant" && !m.kind && m.text.trim() && splitFenceBlocks(m.text).some((s) => s.kind === "prose")) said++
    if (m.role === "user" && m.wake) wakes++
    calls += m.tools?.length ?? 0
  }
  const startMs = Date.parse(messages[range.from - 1]?.at ?? messages[range.from]?.at ?? "")
  const endMs = Date.parse(messages[range.to]?.at ?? "")
  const took = Number.isFinite(startMs) && Number.isFinite(endMs) && endMs - startMs >= 60_000 ? formatRuntimeElapsed(endMs - startMs) : ""
  const count = (n: number, one: string) => (n > 0 ? `${n} ${one}${n === 1 ? "" : "s"}` : "")
  const what = [count(said, "message"), count(calls, "tool call"), count(wakes, "wake")].filter(Boolean).join(" · ")
  if (took) return what ? `Worked ${took} · ${what}` : `Worked ${took}`
  return what || "Earlier activity"
}
