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
import { awaitingStatus, carriesDoneRegistration, SIGNOFF_NUDGE_MARKER, type TranscriptMessage } from "@frizz/shared"
import { hasQuestionBlock, parseSignalFence } from "./tailer.ts"

/** What one rest said about the human: written for them, a quiet park, or no fence at all. */
export type RestReading = "signOff" | "quiet" | "bare"

// ONE READING PER MESSAGE, NOT PER READ. This pass runs on every transcript read — each /ws push of a
// subscribed thread — and reading a message's fences is what it costs: 27ms of the 35ms on a 68 MB
// transcript with 954 rests (measured 2026-11-06). The Claude projection hands back its retained fold's
// own message objects on every read, so a reading keyed on the object is paid once; the text rides along
// because the newest message can still grow in place.
const readings = new WeakMap<object, { text: string; reading: RestReading | undefined }>()
function readingOf(m: TranscriptMessage | undefined): RestReading | undefined {
  if (!m) return undefined
  const hit = readings.get(m)
  if (hit && hit.text === m.text) return hit.reading
  const reading = readRestMessage(m)
  readings.set(m, { text: m.text, reading })
  return reading
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
  for (let r = 0; r < messages.length; r++) {
    if (messages[r].boundary !== "rest") continue
    const at = restedOnIndex(messages, turnStart, r)
    // A registration signs the turn off whatever prose follows it: workers append a pointer after
    // `frizzctl done` ("the write-up is above"), and that afterword is what the turn ends on.
    let registered = -1
    for (let i = turnStart; i < r; i++) if (messages[i].role === "assistant" && carriesDoneRegistration(messages[i])) registered = i
    const reading = registered >= 0 ? "signOff" : readingOf(messages[at]) ?? "bare"
    rests.push({ at: at >= 0 ? at : registered, reading, nudged: nudgedAfter(messages, r) })
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
