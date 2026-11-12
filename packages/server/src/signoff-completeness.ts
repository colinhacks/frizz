// A SIGN-OFF IS THE WHOLE HANDOFF (2026-11-11) — what scheduler SOURCE 18 reads off a rest.
//
// The human reads a thread from their own last message down, and the board folds everything between it and
// the newest sign-off behind one row (web lib/stretchFolds). So the newest sign-off has to stand alone: it
// replaces the one before it, and every question still open on the thread is named in it, under the
// paragraph it belongs to. A worker woken with nothing new writes no new sign-off at all: it rests on its
// signal fence alone, and the sign-off before stays the one the human reads (sign-offs.ts).
//
// Until then a worker re-listed every open question at every rest, because the maintainer's own
// instructions asked it to (2026-11-05), and each re-listing drew its card again (maintainer 2026-11-11:
// "the thread will be reawakened by something or other, and it will repeat the questions it asked
// previously"). Measured over the six days after: 952 `id:`-only references, 634 of them naming a card
// already on screen since the human last typed.
//
// Two faults, each refused with a correction (the maintainer's call, 2026-11-11):
//
//  - MISSING: a new sign-off leaves out a question still open on the thread — one the human has typed past
//    included, since only answering, withdrawing or dismissing it ends it. A question asked anywhere in the
//    sign-off's own turn counts as named.
//  - RELISTED: the rested-on message names questions asked before it and says nothing else — no prose, no
//    new ask, no fence body. That is the re-listing itself; the cards are still where they were asked.
//
// NOT A FAULT: a question named mid-turn in a turn that then rests on a quiet park. It belongs to no
// sign-off, but telling it apart needs the turn's start, and the fold knows only the newest delivery
// (`lastUserAt`), which a sub-agent's return does not move — so a sign-off two rests back would read as
// this turn's. The board draws the live card in the newest SIGN-OFF naming it (web lib/questionShadow), so
// a stray naming moves nothing.
//
// What none of this can check is the PROSE: a sign-off that names every open question under one line of
// text passes. The contract carries that half.

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
  const missing = rest.rows.flatMap((row) => {
    if (row.state !== "open" || row.asked_at > restMs || named.has(row.id)) return []
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
