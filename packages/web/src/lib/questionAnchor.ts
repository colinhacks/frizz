// WHERE A REGISTERED QUESTION SITS IN THE TRANSCRIPT: at the newest rest that CLAIMS it — the rest it
// was asked at, or a later rest that names it: a ```question fence carrying its `id:` (2026-10-13), or an
// ```awaiting fence listing it under `questions:` (the older form, still read). Never at a rest that says
// nothing about it.
//
// A ```question fence needs none of this — it IS a message, so it renders where it was written. A
// REGISTERED question is a row in `thread_question` with no message to live in, so its position is a
// decision, and it has been the wrong one three times:
//
// - Until 2026-08-27 the card was pinned above the composer. The moment the human replied past it, it
//   sat UNDER their own newest message and under everything the worker had done since, claiming to be
//   the current ask (maintainer 2026-08-27: "The questions should show up in the chat wherever the
//   session came to rest").
// - 2026-08-27 froze it at the rest that asked it — and then a worker that rested AGAIN with the
//   question open left the newest rest reading as a bare stop (maintainer 2026-08-31: "Why was this able
//   to come to rest without a proper handoff?").
// - 2026-08-31 therefore pulled every open question to the CURRENT rest. That took each card out of the
//   prose it was placed in and stacked them all under whatever the worker said last — a CI wake, an
//   unrelated reply — where they superseded the worker's own sign-off (maintainer 2026-10-01: "the
//   questions are taken out of the place where they were sort of embedded in the transcript and all
//   just show up in a bunch at the bottom of the chat"; 2026-10-05: "the pending questions that may or
//   may not be relevant kind of supersede how the agent actually signed off"). Measured over the 867
//   questions asked here since 2026-09-11, 38% outlived a later rest, and 72% of those resumes were
//   wakes, not the human.
//
// The fix for the 2026-08-31 report now lives in the CONTRACT, not here: a question is a sign-off only at
// the rest that asked it, and at every later rest the worker names each one it still needs under
// `questions:` or withdraws it (server scheduler.evalSignoffNudges / evalParkIntegrity). So the newest
// rest never reads as a bare stop with an ask hidden above it, and this file only has to honour what the
// worker said: a card stays where it was asked until a later rest claims it, and a claim moves it to the
// end of that rest — under the fence that named it.
//
// WHETHER A QUESTION IS STILL THE THREAD'S ASK IS NOT DECIDED HERE. The server decides it — an open
// question stands from when it was asked or last referenced until the human next TYPES to the thread
// (server question-fences.ts standingQuestions) — and sends the answer on each row as `standing`. This
// file only answers "which message does the card sit under", and the one thing it reads `standing` for is
// a surface that cannot draw that message: see `from` on questionsByAnchor.

import { type AskedQuestion, awaitingQuestions, questionHandles } from "@frizz/shared"
import { splitFenceBlocks } from "./fenceBlocks.ts"
import { questionFenceIdsIn } from "./questionBlocks.ts"

export interface AnchorMessage {
  role: string
  kind?: string
  at?: string
  /** The message's markdown, read only for an ```awaiting fence's `questions:` claim. */
  text?: string
  /** The ids of this message's question fences the server REFUSED (lib/questionFaults): they name no
   *  question, so they neither claim a card nor place one. */
  refusedFences?: ReadonlySet<string>
  /** For a name several rows carry (a settled id asked again), the row it meant in this message
   *  (lib/questionOwners): the claim is that row's alone. */
  questionOwners?: ReadonlyMap<string, string>
}

/** A real human turn — a typed reply or one of frizz's own deliveries, which land as user records and
 *  count deliberately (the thread moved on, whoever moved it). Punctuation with a nominal role (an event
 *  line, a reasoning summary) is not a turn. */
function isTurn(m: AnchorMessage): boolean {
  return m.role === "user" && m.kind !== "event" && m.kind !== "reasoning"
}

/** The last message of the rest message `i` belongs to: the one before the next human turn, or the tail
 *  when no turn follows. */
export function restEnd(messages: readonly AnchorMessage[], i: number): number {
  for (let j = i + 1; j < messages.length; j++) {
    if (isTurn(messages[j])) return j - 1
  }
  return messages.length - 1
}

/** The index of the message closing the rest this question was ASKED at — the card renders after it.
 *  `messages.length - 1` when nothing has happened since (the common case — the worker asked and rested,
 *  and the card is still the tail), and `-1` when the rest it belongs to is older than the loaded window,
 *  which puts it at the top of what is loaded rather than back at the bottom where it would lie about
 *  being current. */
export function questionAnchorIndex(messages: readonly AnchorMessage[], askedAt: string): number {
  const asked = Date.parse(askedAt)
  const tail = messages.length - 1
  if (!Number.isFinite(asked)) return tail
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (!isTurn(m)) continue
    const at = m.at ? Date.parse(m.at) : Number.NaN
    if (!Number.isFinite(at) || at <= asked) continue
    return i - 1
  }
  // NO STAMPED TURN AFTER THE ASK — but the tail may still be the human's OWN SEND, not yet stamped. The
  // surface appends an optimistic bubble with no instant (lib/transcript-sync mergeOptimistic) and the
  // server's copy replaces it a few frames later. It is a turn, made just now, so it ends the rest it
  // replies to exactly as its stamped copy will. Skipped with the unreadable instants above, it left the
  // anchor ON the bubble: every card of that rest drew UNDER the human's newest message until the stamp
  // landed, and a card a fence had placed fell out of its slot (placeQuestions scans from the anchor's
  // rest, which was then the empty one after the bubble). Held open for 2.5s on a real stack, 2026-10-13:
  // the answered card sat below the Answers bubble for the whole hold, then jumped back into the prose.
  // Only a TRAILING run counts — an unstamped turn with stamped history after it is not this tab's send.
  let end = tail
  while (end >= 0 && isTurn(messages[end]) && !(messages[end].at && Number.isFinite(Date.parse(messages[end].at!)))) end--
  // A transcript that is nothing but the bubble has no earlier rest: keep the tail, never the "above the
  // loaded window" reading (-1), which would hoist the card to the top.
  return end < 0 ? tail : end
}

/** The newest worker message that CLAIMS each question, keyed by the lowercased name it used: an
 *  ```awaiting fence naming it under `questions:` (a `qst_…` id — the key is still read for workers whose
 *  contract predates the question fence, though no longer taught), or a ```question fence carrying its
 *  `id:` — a reference, or the ask restated (2026-10-13: the `id:`-only fence replaced `questions:` as the
 *  way a worker says it still needs an answer at this rest). A name is a row id or a handle; questionsByAnchor
 *  matches both. A message with neither fence costs two substring tests. */
export function questionClaims(messages: readonly AnchorMessage[]): Map<string, number> {
  const claims = new Map<string, number>()
  messages.forEach((m, i) => {
    if (m.role !== "assistant" || !m.text) return
    // A name this message records as meaning one row of several is that row's claim alone (ownedClaim).
    const claim = (name: string) => {
      const owner = m.questionOwners?.get(name)
      claims.set(owner === undefined ? name : ownedClaim(name, owner), i)
    }
    if (m.text.includes("```awaiting")) {
      for (const seg of splitFenceBlocks(m.text)) {
        if (seg.kind !== "fence" || seg.fenceKind !== "awaiting") continue
        for (const id of awaitingQuestions(seg.hints)) claim(id.toLowerCase())
      }
    }
    for (const id of questionFenceIdsIn(m.text, m.refusedFences)) claim(id)
  })
  return claims
}

const ownedClaim = (name: string, rowId: string) => `${name}\u0000${rowId}`

/** The newest claim on this question under any of its names — its row id or a handle in its tree. */
function claimOf(claims: ReadonlyMap<string, number>, q: { id?: string; spec?: AskedQuestion }): number | undefined {
  let newest: number | undefined
  const take = (name: string) => {
    for (const key of q.id ? [name.toLowerCase(), ownedClaim(name.toLowerCase(), q.id)] : [name.toLowerCase()]) {
      const at = claims.get(key)
      if (at !== undefined && (newest === undefined || at > newest)) newest = at
    }
  }
  if (q.id) take(q.id)
  if (q.spec) for (const h of questionHandles(q.spec)) take(h)
  return newest
}

/** Every question grouped by the message index it renders after, so a call site walks the transcript once
 *  and drops each group in place. Questions asked in ONE `ask` call share an instant and therefore a
 *  group, which is what keeps a batch rendering as one stack — and a fence naming several questions
 *  gathers them into one group at its own rest the same way.
 *
 *  `claims: false` reads the ASKING rest alone, ignoring any later fence — the reading lib/questionShadow's
 *  fold needs, because a fence restating a question must fold from the rest that asked it onward.
 *
 *  `from` is the first message index the surface DRAWS (the queue card's window start; 0 for the drawer,
 *  whose only undrawn messages are the ones not loaded yet). A question anchored above it has no message
 *  to sit under, so the surface hoists its group to the top of what it shows — right for a question that
 *  still STANDS, which must stay reachable from the card, and wrong for one the human has typed past
 *  (`standing: false` from the server): that one headed the queue card above a newer handoff as though it
 *  were the current ask, on a row the rail no longer marked as one (reported 2026-10-13). With `from` set,
 *  a question that no longer stands is left out when its anchor is above the window, and is drawn only in
 *  place — where its message is on screen. A row with no `standing` (a snapshot from before the flag)
 *  reads as standing, as it does everywhere else (shared hasStandingQuestion). */
export function questionsByAnchor<Q extends { askedAt: string; id?: string; spec?: AskedQuestion; standing?: boolean }>(
  messages: readonly AnchorMessage[],
  questions: readonly Q[],
  opts: { claims?: boolean; from?: number } = {},
): Map<number, Q[]> {
  const byAnchor = new Map<number, Q[]>()
  const claims = opts.claims === false || questions.length === 0 ? undefined : questionClaims(messages)
  for (const q of questions) {
    let anchor = questionAnchorIndex(messages, q.askedAt)
    const claimedAt = claims ? claimOf(claims, q) : undefined
    if (claimedAt !== undefined && claimedAt > anchor) anchor = restEnd(messages, claimedAt)
    if (opts.from !== undefined && q.standing === false && anchor < opts.from) continue
    const group = byAnchor.get(anchor)
    if (group) group.push(q)
    else byAnchor.set(anchor, [q])
  }
  return byAnchor
}
