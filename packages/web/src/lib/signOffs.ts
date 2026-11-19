// THE SIGN-OFFS A SURFACE KEEPS IN VIEW: the messages since the human last spoke that the agent rested on
// FOR THEM (`TranscriptMessage.signOff`, stamped by the server's projection — server sign-offs.ts).
//
// A thread keeps going after it signs off. A PR review or a CI result wakes the worker, it looks, and it
// parks again quietly (`status: watching`) with nothing new to say. The queue card kept the first round and
// the last, so after two or three of those the hand-off itself sat in the collapsed middle and the card
// ended on a bare quiet park (maintainer 2026-11-06: "Because we only ever show the most recent rest
// message …, the sign-off is hidden by default"). The card pinned the round holding the newest sign-off
// until the one-thread pane replaced it (2026-11-09), and every surface still draws a kept sign-off's
// ```awaiting card once a later round has made the fence stale (ThreadSurface useThreadMessages →
// ChatMessage.keptSignOff).
//
// EVERY SIGN-OFF, NOT THE NEWEST (2026-11-16). From 2026-11-11 a sign-off was the whole handoff: it replaced
// the one before it, so the fold kept only the newest. Workers wrote what was new instead, as anyone would:
// over the five days before, 562 earlier sign-offs were folded behind a newer one in the same stretch, a
// median of 1,729 characters each, and 174 times the one left in view was under half as long ("The old page
// server on port 8792 stopped at its 24-hour limit" over the answer the human had asked for; maintainer
// 2026-11-16: "I keep seeing important messages getting collapsed"). So a sign-off says what is new since
// the one before it (the worker contract), and every sign-off of the stretch stays in view.
//
// …EXCEPT ONE WHOSE QUESTIONS WERE ALL WITHDRAWN, ONCE A LATER SIGN-OFF FOLLOWS IT (same date, the
// maintainer's proposal: "if a sign-off message contains all revoked questions, then we collapse it"). A
// sign-off that asked is about its asks, and a worker withdraws one when it has decided it itself or the
// question stopped mattering, which its next sign-off says. Withdrawn and dismissed alike: both close a
// question unanswered. Never the stretch's newest sign-off, which is what the thread rests on.
//
// Pure index logic over the structural minimum.

import { SIGNOFF_NUDGE_MARKER } from "@frizz/shared"
import { splitFenceBlocks } from "./fenceBlocks.ts"

export interface SignOffMsgLike {
  role: string
  text: string
  signOff?: boolean
  wake?: boolean
  queued?: boolean
  boundary?: string
}

// The user turn that opened a run: anything delivered to the agent, not a send still waiting in its queue.
const delivered = (m: SignOffMsgLike) => m.role === "user" && !m.queued

// Frizz's retired reminder to sign off (scheduler SOURCE 9, 2026-08-12 → 2026-11-19), still in older
// transcripts, read by its opening marker as parseRecurringPrompt reads it.
const isSignOffNudge = (m: SignOffMsgLike) => m.wake === true && m.text.trimStart().startsWith(SIGNOFF_NUDGE_MARKER)

/** The NEWEST sign-off after `from` (the human's last turn), oldest first, as the messages it spans: the
 *  newest marked message, the write-up it is an afterword to in its own turn (the server marks both, server
 *  sign-offs.ts writeUpBefore), and — when it ANSWERED FRIZZ'S REMINDER — the bare rest the reminder was
 *  about, and so on back. A worker that wrote its whole write-up and forgot the fence is reminded, and then
 *  often rests on the fence alone ("```done" over a one-line ledger): the write-up is the rest before it,
 *  and the server marks both. Empty when nothing after `from` signed off. */
export function latestSignOffs(messages: readonly SignOffMsgLike[], from: number): number[] {
  let at = messages.length - 1
  while (at > from && messages[at].signOff !== true) at--
  if (at <= from) return []
  const out = [at]
  for (;;) {
    let opened = at - 1
    while (opened > from && !delivered(messages[opened]) && messages[opened].boundary !== "rest" && messages[opened].signOff !== true) opened--
    if (opened > from && messages[opened].signOff === true) {
      out.push(opened)
      at = opened
      continue
    }
    while (opened > from && !delivered(messages[opened])) opened--
    if (opened <= from || !isSignOffNudge(messages[opened])) break
    let before = opened - 1
    while (before > from && messages[before].signOff !== true && !delivered(messages[before])) before--
    if (before <= from || messages[before].signOff !== true) break
    out.push(before)
    at = before
  }
  return out.reverse()
}

/** Every sign-off after `from` (the human's last turn), oldest first: the messages a surface keeps in view
 *  (see the header). `closedOnly(i)` says message `i` names questions and every one of them was withdrawn
 *  or dismissed; such a sign-off leaves the list unless it is part of the newest. */
export function stretchSignOffs(messages: readonly SignOffMsgLike[], from: number, closedOnly?: (i: number) => boolean): number[] {
  const newest = new Set(latestSignOffs(messages, from))
  const out: number[] = []
  for (let i = Math.max(from + 1, 0); i < messages.length; i++) {
    if (messages[i].signOff !== true) continue
    if (!newest.has(i) && closedOnly?.(i)) continue
    out.push(i)
  }
  return out
}

const carriesDone = (m: SignOffMsgLike) => splitFenceBlocks(m.text).some((s) => s.kind === "fence" && s.fenceKind === "done")

/** THE DONE CARD MARK AS DONE RIDES ON, on a thread at rest: the message `last` (the last thing the agent
 *  said) when it ends on a ```done fence, or -1 when it does not. Unless that rest only repeated the newest
 *  sign-off — the same done fence again, word for word, or an empty one — which the server reads as leaving
 *  the sign-off before it standing (server sign-offs.ts). Then it is THAT sign-off's done card: the one the
 *  fold keeps in view (lib/stretchFolds), with the repeat folded under it. A reylo thread ended on two such
 *  repeats, each woken by another thread's note, and the verb rode on the last one, folded, while the card
 *  in view drew none (maintainer 2026-11-16: "It's showing me a done card from earlier in the thread that
 *  doesn't even contain the Mark as done button"). */
export function restingDoneIndex(messages: readonly SignOffMsgLike[], last: number, from: number): number {
  if (last < 0 || !carriesDone(messages[last])) return -1
  const standing = latestSignOffs(messages, from).at(-1)
  return standing !== undefined && standing < last && carriesDone(messages[standing]) ? standing : last
}
