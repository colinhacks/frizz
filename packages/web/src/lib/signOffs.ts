// THE SIGN-OFF A SURFACE KEEPS IN VIEW: the newest message since the human last spoke that the agent rested
// on FOR THEM (`TranscriptMessage.signOff`, stamped by the server's projection — server sign-offs.ts).
//
// A thread keeps going after it signs off. A PR review or a CI result wakes the worker, it looks, and it
// parks again quietly (`status: watching`) with nothing new to say. The queue card kept the first round and
// the last, so after two or three of those the hand-off itself sat in the collapsed middle and the card
// ended on a bare quiet park (maintainer 2026-11-06: "Because we only ever show the most recent rest
// message …, the sign-off is hidden by default"). The card pins the round holding this message
// (lib/queueCollapse collapseMiddleRuns), and every surface still draws its ```awaiting card once a later
// round has made the fence stale (ThreadSurface useThreadMessages → ChatMessage.latestSignOff).
//
// Pure index logic over the structural minimum, like queueCollapse.

import { SIGNOFF_NUDGE_MARKER } from "@frizz/shared"

export interface SignOffMsgLike {
  role: string
  text: string
  signOff?: boolean
  wake?: boolean
  queued?: boolean
}

// The user turn that opened a run: anything delivered to the agent, not a send still waiting in its queue.
const delivered = (m: SignOffMsgLike) => m.role === "user" && !m.queued

// Frizz's own reminder to sign off (scheduler SOURCE 9), read by its opening marker as parseRecurringPrompt
// reads it.
const isSignOffNudge = (m: SignOffMsgLike) => m.wake === true && m.text.trimStart().startsWith(SIGNOFF_NUDGE_MARKER)

/** The indices to keep in view, oldest first: the newest sign-off after `from` (the human's last turn), and
 *  — when that sign-off ANSWERED FRIZZ'S REMINDER — the bare rest the reminder was about, and so on back.
 *  A worker that wrote its whole write-up and forgot the fence is reminded, and then often rests on the
 *  fence alone ("```done" over a one-line ledger): the write-up is the rest before it, and the server marks
 *  both (sign-offs.ts), so both stay. Empty when nothing after `from` signed off. */
export function latestSignOffs(messages: readonly SignOffMsgLike[], from: number): number[] {
  let at = messages.length - 1
  while (at > from && messages[at].signOff !== true) at--
  if (at <= from) return []
  const out = [at]
  for (;;) {
    let opened = at - 1
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
