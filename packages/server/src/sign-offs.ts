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
// A REST WITH NO FENCE IS A SIGN-OFF: the worker's reply, waiting on the human. In a transcript written
// while Frizz still reminded a bare rest to sign off (scheduler SOURCE 9, retired 2026-11-19, its wakes
// carrying SIGNOFF_NUDGE_MARKER), it is read by the answer to that reminder, since what the worker rested
// on next says who the bare one was for: a sign-off makes it part of that sign-off (the worker wrote its write-up, forgot the fence, and
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
//
// A SIGN-OFF SHORTER THAN THE WORDS BEFORE IT IS THEIR AFTERWORD, AND BOTH ARE MARKED (2026-11-16). A worker
// often writes its write-up, runs one more command (`frizzctl done`, a cleanup, a commit) and ends on a line
// about that command: "I've marked the thread done.", "The test stacks are all removed." Only the line was
// the message the turn rested on, so only the line was marked, and the board folded the write-up behind a
// hairline above it (maintainer 2026-11-16: "I keep seeing important messages getting collapsed"). So the
// last words before the rested-on message, in the same turn, are marked too when they say more than it does
// (wordsSaid): its prose, its questions, and its signal fence's body and steps, never the fence's keys.
// Measured over the five days before: 36 rests, 23 of them a write-up over 400 characters, the rest a status
// line above an even terser sign-off. The last words before a sign-off are otherwise narration (a median of
// 134 characters), which the rule leaves to the fold. Marking is additive: the afterword stays marked, so
// nothing that was in view leaves it.
//
// TWO MORE KINDS OF MESSAGE ARE KEPT IN VIEW, THOUGH NEITHER SIGNS ITS TURN OFF (2026-11-17). Both were
// found by running every Claude transcript on the maintainer's Mac (776 threads) through this pass and the
// web's fold, after a stretch of ~45 messages showed unfolded (maintainer: "this is not collapsing
// properly", then "Find any related/similar bugs. This is not acceptable"):
//   • A QUIET PARK THAT ANSWERS THE HUMAN, OR SAYS AS MUCH AS A WRITE-UP. The contract asks for the fence
//     alone, and 6,369 of 7,896 quiet parks are. Of the 1,527 that carry words, the ones that matter are the
//     worker's REPLY — the first rest after the human came in: a reply to "I feel like you've lost the plot"
//     parked `status: working` on a sub-agent and folded under "Spawning the Fable reviewer now." — and the
//     230 of 400 characters or more ("Yes, deploy 3 is ready…"), the line the afterword rule measured a
//     write-up by. The rest are the one-liners a wake with nothing new gets ("That review is my own reply
//     to Pullfrog.", "No findings. Waiting on CI."), and keeping each in view would line a babysitting
//     stretch with them again. A kept quiet park still signs nothing off: it does not queue, the afterword
//     rule does not reach past it (169 of the 173 lines it would have kept were status lines), and as the
//     answer to a reminder it still takes the bare rest back.
//   • A HANDOFF WRITTEN MID-TURN. The contract tells a worker to ask the moment it finds a question and keep
//     working, so a message that asks one — or ends on a ```done or a non-quiet ```awaiting — is often not
//     the message its turn rests on. Unmarked, it folded, and where the turn then parked quietly the stretch
//     had no sign-off at all and folded nothing: 143 messages on one thread, under four questions asked at
//     its 81st. Such a message is kept on the same terms as a rest's: a fence alone, or the standing fence
//     again, keeps nothing.
import { awaitingStatus, awaitingSteps, BURIED_ANSWERS_HEADER, carriesDoneRegistration, SIGNOFF_NUDGE_MARKER, signalFenceOf, type TranscriptMessage } from "@frizz/shared"
import { asksQuestion, parseSignalFence, restatesSignOff, signalFenceAlone, signalFenceText } from "./tailer.ts"

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
  if (asksQuestion(m.text)) return "signOff"
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

/** How much a message says to the human, in characters, whitespace folded: its prose outside every fence,
 *  each question it asks (the fence's text, as its card draws it), and its signal fence's body and steps (an
 *  ```awaiting fence's prose under `---` and its to-do list, a ```done fence's ledger). A signal fence's
 *  keys are furniture. A question counts because an ask IS what its message says: measured without it, a
 *  sign-off asking one question under a line of prose read as the afterword of the status line before it. */
export function wordsSaid(text: string): number {
  const norm = text.replace(/\r\n/g, "\n")
  const signal = signalFenceOf(norm)
  const fence = signal ? parseSignalFence(norm) : undefined
  const fold = (s: string) => s.replace(/\s+/g, " ").trim().length
  const outside = signal ? norm.slice(0, signal.start) + norm.slice(signal.end) : norm
  const steps = fence ? awaitingSteps(fence.hints).reduce((n, step) => n + fold(step), 0) : 0
  return fold(outside) + fold(fence?.body ?? "") + steps
}

/** How much a message must say to be a write-up rather than narration: the line the afterword rule was
 *  measured against (see the header). */
const WRITE_UP_CHARS = 400

/** The write-up an afterword follows: the last agent prose before `at` in its own turn — never past a
 *  delivery, whose words answered something else — when it says more than the message at `at` does (see
 *  the header). -1 when there is none. */
function writeUpBefore(messages: readonly TranscriptMessage[], from: number, at: number): number {
  for (let i = at - 1; i >= from; i--) {
    const m = messages[i]
    if (m.role === "user") return -1
    if (m.kind || !m.text.trim()) continue
    return wordsSaid(m.text) > wordsSaid(messages[at].text) ? i : -1
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
  /** The write-up `at` is an afterword to, marked with it (writeUpBefore). -1: none. */
  writeUp: number
  reading: RestReading
  /** The next turn opened on frizz's sign-off reminder about this rest. */
  nudged: boolean
  /** A quiet park whose words are kept in view, though the rest signs nothing off (see the header). */
  says: boolean
  /** Handoffs written earlier in the turn, which the worker kept working past (see the header). */
  midTurn: number[]
}

/** Every rest in the projection, oldest first, with what it said. */
export function readRests(messages: readonly TranscriptMessage[]): Rest[] {
  const rests: Rest[] = []
  let turnStart = 0
  // The fence of the newest sign-off since the human last came in: what a rest repeating it leaves standing.
  let standing: string | undefined
  // The human came in since the last rest: the next one is the worker's reply to them.
  let answering = false
  for (let r = 0; r < messages.length; r++) {
    if (messages[r].boundary !== "rest") continue
    const at = restedOnIndex(messages, turnStart, r)
    // In order through the turn: the human coming in clears the standing fence, and a handoff written
    // before the message the turn rested on is kept on the same terms as a rest's (its fence alone, or the
    // standing one again, says nothing new), and becomes the fence a later one would repeat.
    const midTurn: number[] = []
    for (let i = turnStart; i < r; i++) {
      const m = messages[i]
      if (humanCameIn(m)) {
        standing = undefined
        answering = true
      }
      if (i === at || m.role !== "assistant" || m.kind || !m.text.trim() || readingOf(m) !== "signOff") continue
      if (signalFenceAlone(m.text) || restatesSignOff(m.text, standing)) continue
      midTurn.push(i)
      standing = fenceOf(m)
    }
    // A registration signs the turn off whatever prose follows it: workers append a pointer after
    // `frizzctl done` ("the write-up is above"), and that afterword is what the turn ends on.
    let registered = -1
    for (let i = turnStart; i < r; i++) if (messages[i].role === "assistant" && carriesDoneRegistration(messages[i])) registered = i
    const reading = registered >= 0 ? "signOff" : readingOf(messages[at]) ?? "bare"
    // The fence alone, or the standing sign-off's fence again, with nothing new: the sign-off before stands
    // (see the header).
    const stands = registered < 0 && reading === "signOff" && at >= 0 && (signalFenceAlone(messages[at].text) || restatesSignOff(messages[at].text, standing))
    if (reading === "signOff" && !stands) standing = at >= 0 ? fenceOf(messages[at]) : undefined
    const marked = stands ? -1 : at >= 0 ? at : registered
    const writeUp = marked >= 0 ? writeUpBefore(messages, turnStart, marked) : -1
    const said = reading === "quiet" && at >= 0 ? wordsSaid(messages[at].text) : 0
    const says = said > 0 && (answering || said >= WRITE_UP_CHARS)
    rests.push({ at: marked, writeUp, reading, nudged: nudgedAfter(messages, r), says, midTurn })
    answering = false
    turnStart = r + 1
  }
  return rests
}

/** The indices of every message a rest signed off on, oldest first (see the header for the rule). */
export function signOffIndices(messages: readonly TranscriptMessage[]): number[] {
  const rests = readRests(messages)
  const out = new Set<number>()
  // Newest first, so a bare rest can read the answer to the reminder about it, which comes after it. A
  // quiet park that says something keeps its words in view, but as an answer to the reminder it still
  // takes the bare rest back: it is not a sign-off.
  let next: boolean | undefined
  for (let k = rests.length - 1; k >= 0; k--) {
    const rest = rests[k]
    const signs = rest.reading === "bare" ? (rest.nudged && next !== undefined ? next : true) : rest.reading === "signOff"
    next = signs
    if ((signs || rest.says) && rest.at >= 0) out.add(rest.at)
    if (signs && rest.writeUp >= 0) out.add(rest.writeUp)
    for (const i of rest.midTurn) out.add(i)
  }
  return [...out].sort((a, b) => a - b)
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
