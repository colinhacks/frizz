// WHAT A SIGN-OFF OWES THE QUESTIONS STILL OPEN — what scheduler SOURCE 18 reads off a rest.
//
// The human reads a thread from their own last message down, and the board folds the work between the
// sign-offs since then behind hairlines, keeping every sign-off in view (web lib/stretchFolds). So a question
// asked or named in any of them is ON SCREEN, live, until the human types to the thread. Typing past it ends
// that: the thread no longer queues on it (question-fences.ts standingQuestions), and the human, who has
// moved on, needs telling whether it still matters. A worker woken with nothing new writes no new sign-off
// at all: it rests on its signal fence alone, or on that sign-off's own fence again word for word (tailer
// restatesSignOff), and the sign-offs before stay the ones the human reads (sign-offs.ts).
//
// Two faults, each refused with a correction (the maintainer's call, 2026-11-11):
//
//  - MISSING: a new sign-off leaves out a question still open on the thread that has FADED — asked before
//    the human last typed, and named in no message since. Only answering, withdrawing or dismissing ends a
//    question, so the first sign-off after the human writes names each faded one again (a reference, which
//    puts it back in their queue) or the worker withdraws it: the eager withdrawal the maintainer asked for
//    (2026-11-16: "It should also eagerly revoke questions that were previously asked"), forced once per
//    message of theirs and never at a wake. Until 2026-11-16 every open question counted, standing ones
//    included, because the board kept only the newest sign-off in view, and each sign-off re-named every
//    question asked in the ones before it.
//  - RELISTED: the rested-on message names questions asked before it and says nothing else — no prose, no
//    new ask, no fence body. That is the re-listing itself; the cards are still where they were asked.
//
// Until 2026-11-11 a worker re-listed every open question at every rest, because the maintainer's own
// instructions asked it to (2026-11-05), and each re-listing drew its card again (maintainer 2026-11-11:
// "the thread will be reawakened by something or other, and it will repeat the questions it asked
// previously"). Measured over the six days after: 952 `id:`-only references, 634 of them naming a card
// already on screen since the human last typed.
//
// NOT A FAULT: a question named mid-turn in a turn that then rests on a quiet park. It belongs to no
// sign-off, but it was named since the human typed, so it stands, and the board keeps the message holding
// its home card in view (web ChatView's rows).
//
// What none of this can check is the PROSE: a sign-off that repeats the one before it word for word passes.
// The contract carries that half.

import { awaitingStatus, questionFenceBlocks, type AskedQuestion } from "@frizz/shared"
import type { QuestionSighting } from "./backend/types.ts"
import { handleIndex } from "./question-fences.ts"
import type { ThreadQuestionRow } from "./storage.ts"
import type { FenceView } from "./tailer.ts"

export interface SignOffFaults {
  /** Open questions a new sign-off leaves out: the worker's own id (or the minted one) and the question. */
  missing: { id: string; question: string }[]
  /** The names a message re-listed with nothing written around them, as the worker wrote them. */
  relisted: string[]
}

export interface SignOffRest {
  /** The rested-on message's instant (`lastAssistantAt`). */
  restAt: string
  /** The newest delivery before it (`lastUserAt`): the turn the rest closes started after it. */
  turnFrom?: string
  /** When the human last typed to the thread (`restFromAt`): a question asked or named since then stands,
   *  on screen in a sign-off the board keeps. Absent: the turn's start stands in, as standingQuestions reads it. */
  humanFrom?: string
  sightings: readonly QuestionSighting[]
  lastFence?: FenceView
  /** The rested-on message is its signal fence alone (tailer signalFenceAlone); undefined on an old fold. */
  fenceAlone?: boolean
  /** The rested-on message is question fences and nothing else (tailer questionFencesOnly). A sighting
   *  keeps only the fences, so the prose around them is read here, off the fold. */
  fencesOnly?: boolean
  rows: readonly ThreadQuestionRow[]
  /** The turn answers a correction asking for a fence repair (tailer carriesRepairCorrection): a fix-up,
   *  not a new handoff, so it is not held to naming every open question. */
  repair?: boolean
  /** The row's spec, parsed — the board's reader, injected so a malformed row costs nothing here. */
  spec: (row: ThreadQuestionRow) => AskedQuestion | undefined
}

const ms = (at: string | undefined) => (at ? Date.parse(at) : Number.NaN)

/** The faults of one rest. Empty lists when the rest has none. */
export function readSignOffFaults(rest: SignOffRest): SignOffFaults {
  const none: SignOffFaults = { missing: [], relisted: [] }
  const restMs = ms(rest.restAt)
  if (!Number.isFinite(restMs)) return none
  const fromMs = Number.isFinite(ms(rest.turnFrom)) ? ms(rest.turnFrom) : Number.NEGATIVE_INFINITY
  const humanMs = Number.isFinite(ms(rest.humanFrom)) ? Math.min(ms(rest.humanFrom), fromMs) : fromMs
  const turn = rest.sightings.filter((s) => ms(s.at) > fromMs && ms(s.at) <= restMs)
  const rested = turn.filter((s) => ms(s.at) === restMs).at(-1)
  const cache = new Map<string, string[]>()

  // Every question fence of the turn, resolved as the registrar resolved it when it was written: a NEW ask
  // names the row it registered (asked at that very instant), a REPEAT names one asked before it.
  const named = new Set<string>()
  let restedNew = false
  let restedRepeats: string[] = []
  for (const s of turn) {
    const atMs = ms(s.at)
    const index = handleIndex(rest.rows, atMs, cache)
    for (const b of questionFenceBlocks(s.text)) {
      if (b.read.form === "invalid") continue
      const row = index.get(b.read.id.toLowerCase())
      if (!row) continue
      named.add(row.id)
      const repeat = b.read.form === "ref" || row.asked_at < atMs
      if (s !== rested) continue
      if (repeat) restedRepeats.push(b.read.id)
      else restedNew = true
    }
  }

  if (rested && !restedNew && restedRepeats.length > 0 && rest.fencesOnly === true) {
    restedRepeats = unique(restedRepeats)
    return { ...none, relisted: restedRepeats }
  }

  // A NEW sign-off: a question in its message, an ```awaiting fence that is not a quiet park with something
  // in or around it, or prose with no fence at all — which the board queues as the handoff it is, so it
  // replaces the sign-off before it as surely as a fenced one. A done fence is SOURCE 15's (an open
  // question blocks it outright), and a fence alone leaves the sign-off before it standing. An old fold
  // that cannot say (no `fenceAlone`) is left alone.
  const status = rest.lastFence?.kind === "awaiting" ? awaitingStatus(rest.lastFence.hints) : null
  const quiet = status === "working" || status === "watching"
  const prose = rest.fenceAlone === false
  const newSignOff = rested !== undefined || (prose && (rest.lastFence === undefined || (rest.lastFence.kind === "awaiting" && !quiet)))
  if (!newSignOff || rest.repair || rest.lastFence?.kind === "done") return none
  // Every question named since the human last typed stands (see the header): this turn's namings, and the
  // earlier sign-offs' since then, which the board keeps in view.
  for (const s of rest.sightings) {
    const atMs = ms(s.at)
    if (!(atMs > humanMs && atMs <= restMs)) continue
    const index = handleIndex(rest.rows, atMs, cache)
    for (const b of questionFenceBlocks(s.text)) {
      if (b.read.form === "invalid") continue
      const row = index.get(b.read.id.toLowerCase())
      if (row) named.add(row.id)
    }
  }
  const missing = rest.rows.flatMap((row) => {
    if (row.state !== "open" || row.asked_at > restMs || row.asked_at > humanMs || named.has(row.id)) return []
    const spec = rest.spec(row)
    return spec ? [{ id: row.handle ?? row.id, question: spec.question }] : []
  })
  return { ...none, missing }
}

function unique(names: string[]): string[] {
  const seen = new Set<string>()
  return names.filter((n) => {
    const k = n.toLowerCase()
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
