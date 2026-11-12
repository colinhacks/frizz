// WHICH MESSAGES THE AGENT SIGNED OFF ON — `TranscriptMessage.signOff`, stamped once over the whole
// projection so every page and every push carries the same answer.
//
// A thread's transcript mixes two kinds of agent prose that read alike: what the agent says while it
// works (narration, a status line between calls) and what it RESTS on for the human. The `rest` divider
// already marks where each turn ended; this marks whether the message that turn ended on was written for
// the reader. It is not, when the worker parked quietly: an ```awaiting fence answering `status: working`
// or `status: watching` is the contract's way of saying nobody needs to read this rest (worker contract §
// A QUIET PARK NEEDS NO WRITE-UP). Everything else a turn can end on is a sign-off: a ```done, a
// `frizzctl done`, a ```question, an ```awaiting the human is needed for (`needs_input`, `steps:`, or no
// answer at all), and a rest with no fence, which the board queues as the handoff it is.
//
// Without the mark a surface could only tell a rest by position, and the queue card kept the FIRST and the
// LAST rounds: two PR-review wakes the worker quietly parked on pushed the hand-off they followed into the
// collapsed middle, behind "7 more rounds" (maintainer 2026-11-06: "the sign-off is hidden by default").
//
// A REST WITH NO FENCE IS READ BY THE ANSWER TO FRIZZ'S REMINDER ABOUT IT. Frizz nudges a bare rest
// (scheduler SOURCE 9, SIGNOFF_NUDGE_MARKER), and what the worker rests on next says who the bare one was
// for: a sign-off makes it part of that sign-off (the worker wrote its write-up, forgot the fence, and
// added the fence on its own), and a quiet park takes it back (it was a status line). A bare rest nobody
// has answered yet stays a sign-off, because that is what the board queued it as.
//
// A REST ON THE FENCE ALONE LEAVES THE SIGN-OFF BEFORE IT STANDING (2026-11-11). A sign-off is the whole
// handoff, written to stand alone, and the board folds everything else since the human last typed behind
// one row (web lib/stretchFolds). So a worker woken with nothing new rests without writing a new one: a
// quiet park, or a needs_input or done fence with nothing around it and nothing in it (tailer
// signalFenceAlone). That rest still reads as a sign-off, since what the board queued it as is unchanged
// and a bare rest's reminder reads it so, but it marks no message: the sign-off it rested on is the one
// before. Measured before the rule: of every rest since 2026-11-04 on a needs_input or done fence with
// nothing around it, none had a write-up earlier in its turn (3 rests), so nothing a worker wrote is left
// unmarked by it.
//
// …AND SO DOES A REST ON THE SAME FENCE AGAIN, WORD FOR WORD (2026-11-12). A worker woken by something that
// changes nothing often pastes its last fence back, steps and all, rather than resting on an empty one: on
// a pullfrog-app thread a message from another thread brought back the identical to-do fence its write-up
// had ended on. Read as a new sign-off, that bare fence took the write-up's place and the write-up survived
// only as the stretch's first words, so a worker that had narrated anything first would have had its whole
// handoff folded away. The copy says nothing the sign-off before did not, so that one stands (tailer
// restatesSignOff), until the human comes in: a fence repeated after they typed or answered is a reply.
// Of the to-do fences that followed another in one stretch over the 12 days before, 39 of 231 were
// verbatim; 118 kept the steps and reworded the rest, which is something new and stays a sign-off.
import { awaitingStatus, BURIED_ANSWERS_HEADER, carriesDoneRegistration, SIGNOFF_NUDGE_MARKER, type TranscriptMessage } from "@frizz/shared"
import { hasQuestionBlock, parseSignalFence, restatesSignOff, signalFenceAlone, signalFenceText } from "./tailer.ts"

/** What one rest said about the human: written for them, a quiet park, or no fence at all. */
export type RestReading = "signOff" | "quiet" | "bare"

// ONE READING PER MESSAGE, NOT PER READ. This pass runs on every transcript read — each /ws push of a
// subscribed thread — and reading a message's fences is what it costs: 27ms of the 35ms on a 68 MB
// transcript with 954 rests (measured 2026-11-06). The Claude projection hands back its retained fold's
// own message objects on every read, so a reading keyed on the object is paid once; the text rides along
// because the newest message can still grow in place.
const readings = new WeakMap<object, { text: string; reading: RestReading | undefined; fence?: { text: string | undefined } }>()
function readingOf(m: TranscriptMessage | undefined): RestReading | undefined {
  if (!m) return undefined
  const hit = readings.get(m)
  if (hit && hit.text === m.text) return hit.reading
  const reading = readRestMessage(m)
  readings.set(m, { text: m.text, reading })
  return reading
}
// The signal fence a sign-off ends on (tailer signalFenceText), on the same terms: read once per message.
function fenceOf(m: TranscriptMessage): string | undefined {
  readingOf(m)
  const hit = readings.get(m)!
  hit.fence ??= { text: signalFenceText(m.text) }
  return hit.fence.text
}

// The human came in: typed a message, or answered a question, which Frizz delivers as a wake (the same
// test as web lib/messagePresentation isHumanTurn). A fence repeated after this is a reply to them.
function humanCameIn(m: TranscriptMessage): boolean {
  if (m.role !== "user" || m.kind || m.queued || m.peerFrom || m.agentInstruction || m.sessionPeer) return false
  return !m.wake || m.text.trimStart().startsWith(BURIED_ANSWERS_HEADER)
}

/** What the message a turn ended on says, read off its own text. Undefined when it is not prose. */
export function readRestMessage(m: Pick<TranscriptMessage, "text"> | undefined): RestReading | undefined {
  if (!m || !m.text.trim()) return undefined
  if (hasQuestionBlock(m.text)) return "signOff"
  const fence = parseSignalFence(m.text)
  if (!fence) return "bare"
  if (fence.kind === "done") return "signOff"
  const status = awaitingStatus(fence.hints)
  return status === "working" || status === "watching" ? "quiet" : "signOff"
}

// The message a turn RESTED ON: the newest agent prose before its `rest` divider, stepping over dividers,
// reasoning and tool-only messages, and never past a user turn — a turn whose agent wrote nothing after
// the last thing delivered to it rested on nothing it said. The same walk markFenceRefused takes.
function restedOnIndex(messages: readonly TranscriptMessage[], from: number, rest: number): number {
  for (let i = rest - 1; i >= from; i--) {
    const m = messages[i]
    if (m.role === "user") return -1
    if (m.kind || !m.text.trim()) continue
    return i
  }
  return -1
}

/** The first thing delivered after a rest: a WAKE frizz composed, or the human. Frizz's own sign-off
 *  reminder is the one that matters here. */
function nudgedAfter(messages: readonly TranscriptMessage[], rest: number): boolean {
  for (let i = rest + 1; i < messages.length; i++) {
    const m = messages[i]
    if (m.role !== "user" || m.queued) continue
    // The marker alone, as parseRecurringPrompt reads it: that parser goes on to scan the whole text for
    // a Goal's trailer, once per rest, which a long PR-review wake makes the costliest thing in this pass.
    return m.wake === true && m.text.trimStart().startsWith(SIGNOFF_NUDGE_MARKER)
  }
  return false
}

interface Rest {
  /** The message to mark: the prose the turn ended on, or the one carrying its `frizzctl done`. -1: none. */
  at: number
  reading: RestReading
  /** The next turn opened on frizz's sign-off reminder about this rest. */
  nudged: boolean
}

/** Every rest in the projection, oldest first, with what it said. */
export function readRests(messages: readonly TranscriptMessage[]): Rest[] {
  const rests: Rest[] = []
  let turnStart = 0
  // The fence of the newest sign-off since the human last came in: what a rest repeating it leaves standing.
  let standing: string | undefined
  for (let r = 0; r < messages.length; r++) {
    if (messages[r].boundary !== "rest") continue
    for (let i = turnStart; i < r; i++) if (humanCameIn(messages[i])) standing = undefined
    const at = restedOnIndex(messages, turnStart, r)
    // A registration signs the turn off whatever prose follows it: workers append a pointer after
    // `frizzctl done` ("the write-up is above"), and that afterword is what the turn ends on.
    let registered = -1
    for (let i = turnStart; i < r; i++) if (messages[i].role === "assistant" && carriesDoneRegistration(messages[i])) registered = i
    const reading = registered >= 0 ? "signOff" : readingOf(messages[at]) ?? "bare"
    // The fence alone, or the standing sign-off's fence again, with nothing new: the sign-off before stands
    // (see the header).
    const stands = registered < 0 && reading === "signOff" && at >= 0 && (signalFenceAlone(messages[at].text) || restatesSignOff(messages[at].text, standing))
    if (reading === "signOff" && !stands) standing = at >= 0 ? fenceOf(messages[at]) : undefined
    rests.push({ at: stands ? -1 : at >= 0 ? at : registered, reading, nudged: nudgedAfter(messages, r) })
    turnStart = r + 1
  }
  return rests
}

/** The indices of every message a rest signed off on, oldest first (see the header for the rule). */
export function signOffIndices(messages: readonly TranscriptMessage[]): number[] {
  const rests = readRests(messages)
  const out: number[] = []
  // Newest first, so a bare rest can read the answer to the reminder about it, which comes after it.
  let next: boolean | undefined
  for (let k = rests.length - 1; k >= 0; k--) {
    const rest = rests[k]
    const signs = rest.reading === "bare" ? (rest.nudged && next !== undefined ? next : true) : rest.reading === "signOff"
    next = signs
    if (signs && rest.at >= 0) out.push(rest.at)
  }
  return out.reverse()
}

/** Stamp `signOff` on each message a rest signed off on, and clear it from any other. COPY-ON-WRITE: the
 *  Claude projection's messages belong to its retained fold, which outlives this read, so a message whose
 *  answer changes is replaced in the array rather than edited. The array itself is the caller's own. */
export function projectSignOffs(messages: TranscriptMessage[]): TranscriptMessage[] {
  const marked = new Set(signOffIndices(messages))
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    const signs = marked.has(i)
    if (signs === (m.signOff === true)) continue
    if (signs) messages[i] = { ...m, signOff: true }
    else {
      const { signOff: _, ...rest } = m
      messages[i] = rest
    }
  }
  return messages
}
