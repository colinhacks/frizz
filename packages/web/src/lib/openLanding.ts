// WHERE A THREAD AT REST OPENS (maintainer 2026-11-18: "you should not be auto-scrolled to the bottom. You
// should be auto-scrolled to a place where you can see the most recent user steer, and then it shows all
// of the stuff that was collapsed. Then it shows the start of the thread's sign-off messages").
//
// A thread at rest reads as the human's latest message, the worker's first words on it, one hairline over
// the work, and then each sign-off of the stretch (lib/stretchFolds). So it opens with that message at the
// top of the pane and the FIRST sign-off under it, on every surface: the pane, the drawer and a phone's
// page. Until this rule each surface had its own landing, and all of them aimed at the NEWEST sign-off or
// the tail: the pane's queue window landed the newest sign-off a quarter of the pane down, a thread out of
// the queue and a phone put its top at the top of the pane, and a desktop drawer opened on the tail. That
// was right while the fold kept one sign-off per stretch. Since 2026-11-16 it keeps every one, and the
// newest is usually the shortest and the last thing in the thread ("CI is green."), so all three clamped
// against the bottom with the write-up the human came for scrolled off above (measured on a stack: a queued
// thread opened 0px from the tail, its first sign-off starting 555px above the pane).
//
// A thread whose TURN IS IN FLIGHT still opens on its tail (`opensAtRest`): running or starting, that is
// where the live line is, and parked on a permission prompt or a question of the provider's own, that is
// where its card is (the transcript's last row). The pane's queue window opened a thread parked on one at
// its top, with the card as far below as the turn was long.
//
// Pure: the transcript finds the rows and measures them, and this says where the scroller goes.

import { isHumanTurn, lastHumanTurnIndex, type HumanTurnLike } from "./messagePresentation.ts"

// The human's message and the first sign-off read as a pair whenever the sign-off starts in the upper 60%
// of the pane: there is room to start reading it without scrolling. Past that the message is long (a pasted
// log, a page of notes), and the sign-off lands a quarter of the pane (at most 160px) below the top
// instead, with the end of what stands over it still showing.
export const SIGN_OFF_FITS = 0.6
export const SIGN_OFF_LEAD = 0.25
export const SIGN_OFF_LEAD_MAX_PX = 160

/** Whether a thread opens on the landing rather than on its tail: its turn is over and nothing at the
 *  tail is waiting on the human's answer (`actionableInteraction`, a typed request whose card is the
 *  transcript's last row). A thread the board has not loaded yet is read as at rest. */
export function opensAtRest(thread: { runtime?: string; actionableInteraction?: boolean } | null | undefined): boolean {
  if (!thread) return true
  if (thread.actionableInteraction === true) return false
  return thread.runtime !== "running" && thread.runtime !== "spawning" && thread.runtime !== "perm-prompt"
}

export interface LandingRowLike {
  kind: string
  messageIndex?: number
}

export type LandingMsgLike = HumanTurnLike & { signOff?: boolean }

/** The rows a landing reads, as indices into the transcript's rows (-1: none). */
export interface LandingRows {
  /** The human's latest message. */
  steer: number
  /** The first sign-off after it that draws a row, or the first on the page when the message is above it. */
  signOff: number
  /** With neither, the last thing the agent said: a rest older than every sign-off mark. */
  fallback: number
  /** Nothing but the list's own furniture stands above the steer (the queue's window, a thread's first
   *  message), so the list opens at its top and "Load earlier" stays in view over it. */
  steerLeads: boolean
}

/** Which rows a thread at rest opens on. `lastAgentIdx` is the last message the agent said (-1: none). */
export function landingRows(rows: readonly LandingRowLike[], messages: readonly LandingMsgLike[], lastAgentIdx: number): LandingRows {
  const at = lastHumanTurnIndex(messages)
  // lastHumanTurnIndex answers 0 for "none" too: a page that opens mid-stretch has its message further up.
  const steerAt = messages[at] !== undefined && isHumanTurn(messages[at]) ? at : -1
  const isMessage = (row: LandingRowLike): row is LandingRowLike & { messageIndex: number } => row.kind === "message" && row.messageIndex !== undefined
  const steer = steerAt < 0 ? -1 : rows.findIndex((row) => isMessage(row) && row.messageIndex === steerAt)
  const signOff = rows.findIndex((row) => isMessage(row) && row.messageIndex > steerAt && messages[row.messageIndex]?.signOff === true)
  let fallback = -1
  if (steer < 0 && signOff < 0 && lastAgentIdx >= 0) {
    rows.forEach((row, index) => {
      const m = isMessage(row) ? messages[row.messageIndex] : undefined
      if (m && isMessage(row) && row.messageIndex <= lastAgentIdx && m.role === "assistant" && m.kind !== "event") fallback = index
    })
  }
  const steerLeads = steer >= 0 && !rows.slice(0, steer).some((row) => row.kind === "message")
  return { steer, signOff, fallback, steerLeads }
}

/** Where the scroller goes, given where the landing's rows are now: `undefined` for a row the landing does
 *  not have, `null` for one that is not mounted, and otherwise its top as an offset into the content.
 *  Answers the offset, or the row to bring into reach first: a virtual row has no place to measure until
 *  the scroller is near it. */
export function landingOffset(input: {
  steer: number | null | undefined
  signOff: number | null | undefined
  fallback: number | null | undefined
  paneHeight: number
}): { top: number } | { reach: "steer" | "signOff" | "fallback" } {
  const { steer, signOff, fallback, paneHeight } = input
  const lead = Math.min(paneHeight * SIGN_OFF_LEAD, SIGN_OFF_LEAD_MAX_PX)
  if (signOff !== undefined && steer !== undefined) {
    if (signOff !== null && steer !== null) return { top: signOff - steer <= paneHeight * SIGN_OFF_FITS ? steer : Math.max(signOff - lead, steer) }
    // One of the pair is out of reach of the other, so they are more than a pane apart: the sign-off's
    // landing, from wherever the scroller is.
    if (signOff !== null) return { top: signOff - lead }
    return { reach: steer === null ? "steer" : "signOff" }
  }
  if (steer !== undefined) return steer === null ? { reach: "steer" } : { top: steer }
  if (signOff !== undefined) return signOff === null ? { reach: "signOff" } : { top: Math.max(signOff - lead, 0) }
  if (fallback !== undefined) return fallback === null ? { reach: "fallback" } : { top: fallback }
  return { top: 0 }
}
