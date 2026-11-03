import { awaitingFenceTitle, futureSnoozedUntil, type ThreadView } from "@frizz/shared"
import type { SessionIndicatorKind } from "../groups.ts"
import { awaitingProse, awaitingWaitClause, hintGloss } from "./awaitingPresentation.ts"
import { toolActivityLabel } from "./toolActivity.ts"

// THE PHONE BOARD ROW'S SECOND LINE — what the thread wants, in one line.
//
// The approved phone design (2026-09-30) gives every row one line under its title, and the line answers
// a different question per state: the QUESTION for an ask, the live ACTIVITY for a running thread, the
// start of the HANDOFF for a rested one. Pure functions over a ThreadView, so the rules are testable
// without a browser and the component stays a layout.
//
// WHAT THE ROW HAS TO WORK WITH. The ThreadView carries the registered questions whole (`questions`),
// the native ask's questions (`pendingAsk`), the newest tool call still awaiting its result (`liveTool`,
// Claude session threads — tailer.ts trackLiveTools), the worker's gerund (`activity`, legacy thread
// files only), and two readings of the newest assistant text: `lastAssistantLine`, its real first line
// with the markdown intact, and `lastAssistant`, a whitespace-collapsed ~200-char preview. The handoff
// line reads the first; the preview is only the fallback for a view without it, and there `handoffLine`
// approximates the line by stopping where the next block (a bullet, a fence, a heading) would have
// begun, because the preview's newlines are already spaces.

/** One line of text, with an optional leading verdict the row draws in the foreground weight. */
export type RowLine = { lead?: string; text: string }

/** Inline markdown removed, so a preview reads as prose: `**x**` → x, `` `x` `` → x, `[x](url)` → x. */
function plain(text: string): string {
  return text
    .replace(/```[\w-]*/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|\s)[*_](\S[^*_]*?\S|\S)[*_](?=\s|$|[.,;:!?])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim()
}

/** Block markers at the head of a message: a fence opener, a heading's `#`, a quote's `>`, a bullet. */
const HEAD_MARKERS = /^(?:```[\w-]*\s*|#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/

/** Where the first line ended, in a preview whose newlines are gone: the next block that could only
 *  have started a new line — a fence, a bullet, a numbered item, a heading, a quote. A real newline, if
 *  the text still has one, wins. */
const NEXT_BLOCK = /\n|\s(?:```|[-*+]\s|\d+[.)]\s|#{1,6}\s|>\s)/

/** A message's first line as the row draws it: block markers at its head go, and a bold phrase that leads
 *  it becomes the line's verdict. `exact` says the text already IS one line (`lastAssistantLine`); without
 *  it the text is the collapsed preview, and the line is cut where the next block would have begun. */
export function handoffLine(text: string | undefined, exact = false): RowLine | null {
  let s = (text ?? "").trim().replace(HEAD_MARKERS, "")
  const cut = exact ? null : NEXT_BLOCK.exec(s)
  if (cut) s = s.slice(0, cut.index)
  if (!s.trim()) return null
  const bold = /^(\*\*|__)(.{1,60}?)\1\s*/.exec(s)
  if (bold) {
    const lead = plain(bold[2]!)
    const rest = plain(s.slice(bold[0].length))
    if (lead) return rest ? { lead, text: rest } : { text: lead }
  }
  const flat = plain(s)
  return flat ? { text: flat } : null
}

/** The first non-empty line of a question, as prose. */
function questionText(question: string): string | null {
  const first = question.split("\n").map((l) => l.trim()).find(Boolean)
  return first ? plain(first) || null : null
}

/** "2 questions", or the one question's own text when there is exactly one. */
function questionsLine(texts: readonly string[]): string | null {
  if (texts.length > 1) return `${texts.length} questions`
  return texts.length === 1 ? questionText(texts[0]!) : null
}

/** A thread parked on an armed timer: its earliest future fire instant. */
function armedTimerFireAt(t: Pick<ThreadView, "watches">, nowMs: number): string | undefined {
  let best: { at: string; ms: number } | undefined
  for (const w of t.watches ?? []) {
    if (w.kind !== "timer" || w.state !== "armed" || !w.timer) continue
    const ms = Date.parse(w.timer.fireAt)
    if (!Number.isFinite(ms) || ms <= nowMs) continue
    if (!best || ms < best.ms) best = { at: w.timer.fireAt, ms }
  }
  return best?.at
}

/** The worker's description of the thread's first armed monitor that has one. */
function armedMonitorName(t: Pick<ThreadView, "watches">): string | undefined {
  return (t.watches ?? []).find((w) => w.kind === "command" && w.state === "armed" && w.command?.monitor?.description)?.command?.monitor?.description
}

/**
 * When a parked thread comes back, if anything says so: the human's own snooze instant, else the
 * earliest armed timer. Undefined for a park with no clock behind it (a PR watch, the resting card's
 * event-snooze) — those wake on an event, and inventing a time for them would be a promise nobody made.
 */
export function wakeAt(t: Pick<ThreadView, "snoozedUntil" | "watches">, nowMs = Date.now()): string | undefined {
  return futureSnoozedUntil(t, nowMs) ?? armedTimerFireAt(t, nowMs)
}

/** How many sub-agents are running under the thread right now, at any depth — the count that replaced
 *  the ⤷ lines the row used to draw beneath itself. Rested and stale children do not count. */
export function liveAgentCount(t: Pick<ThreadView, "subAgents">): number {
  return (t.subAgents ?? []).filter((s) => s.state === "running").length
}

/** " · 1 agent" / " · 3 agents", appended to the second line; empty when nothing is running. */
export function agentSuffix(count: number): string {
  return count > 0 ? `${count} ${count === 1 ? "agent" : "agents"}` : ""
}

/**
 * The row's second line.
 *
 * `inMotion` is the row's own reading of "still going" (the same one that suppresses its rest age), so
 * a row that shows no age shows its activity and a row that shows an age shows its handoff.
 */
export function rowSecondLine(
  t: ThreadView,
  kind: SessionIndicatorKind,
  inMotion: boolean,
  nowMs = Date.now(),
  projectDir?: string,
): RowLine | null {
  // The real first line when the server sent one; a line that is only a fence opener or a bare heading
  // mark strips to nothing, and then the preview's approximation is still better than no line.
  //
  // EXCEPT A QUIET PARK, which is the ```awaiting fence alone — the shape a `status: working` or
  // `watching` rest takes (2026-10-05). Its preview is the fence's YAML, which must never reach the reader
  // (awaitingPresentation's FENCE_SYNTAX_KEYS), so the line is the fence's own prose when it has any, and
  // otherwise the wait it names.
  const parked = t.lastFence?.kind === "awaiting" && /^`{3,}awaiting\b/.test((t.lastAssistant ?? "").trimStart()) ? t.lastFence : undefined
  // A ```done FENCE ALONE is the same trap since 2026-10-13, when a done fence learned to open on
  // `title: …` and `---`: the preview would hand the row "title: Fixed the cache ---". The fence was
  // already split server-side, so the line is the worker's own heading for what landed, else the
  // ledger's first line — which is what the preview gave for a done fence with no title.
  const signedOff = t.lastFence?.kind === "done" && /^`{3,}done\b/.test((t.lastAssistant ?? "").trimStart()) ? t.lastFence : undefined
  const handoff = (): RowLine | null => {
    if (parked) {
      const prose = awaitingProse(parked)
      if (prose) return handoffLine(prose)
      const wait = awaitingWaitClause(parked.hints, t.watches)
      if (wait) return { text: `${wait.charAt(0).toUpperCase()}${wait.slice(1)}` }
    }
    if (signedOff) {
      const title = awaitingFenceTitle(signedOff.hints)
      const line = title ? handoffLine(title, true) : handoffLine(signedOff.body)
      if (line) return line
    }
    return handoffLine(t.lastAssistantLine, true) ?? handoffLine(t.lastAssistant)
  }
  if (kind === "needs-input") {
    // The questions standing at this rest — the ones the row's mark is about. An older open one the
    // worker has rested past keeps its card where it was asked and is not this row's line.
    const registered = questionsLine((t.questions ?? []).filter((q) => q.standing !== false).map((q) => q.spec.question))
    if (registered) return { text: registered }
    const native = questionsLine((t.pendingAsk?.questions ?? []).map((q) => q.question))
    if (native) return { text: native }
    if (t.runtime === "perm-prompt") return { text: "Waiting on a permission prompt" }
    const gloss = t.lastFence?.kind === "awaiting" ? hintGloss(t.lastFence.hints, t.watches) : null
    return gloss ? { text: gloss } : handoff()
  }
  // The live line is the call the agent is waiting on, labelled exactly as the chat's working indicator
  // labels it (toolActivityLabel: the Bash call's own description, else "Reading <path>", "Searching for
  // <pattern>", …), paths made project-relative the same way. Between calls there is none, and the line
  // is the newest thing the agent said. `activity` is the legacy `.frizz` thread file's gerund (frizz.ts);
  // no session thread's view carries it.
  if (inMotion) {
    if (t.liveTool) return { text: toolActivityLabel(t.liveTool, projectDir) }
    return t.activity ? { text: t.activity } : handoff()
  }
  if (kind === "snoozed" && futureSnoozedUntil(t, nowMs) !== undefined) return { text: "Snoozed by you" }
  const gloss = t.lastFence?.kind === "awaiting" ? hintGloss(t.lastFence.hints, t.watches) : null
  if (gloss) return { text: gloss }
  // A monitor the worker registered and rested on without naming it in a fence: its name is still the
  // one thing on this row a reader recognises, as the fenced one's is (hintGloss).
  const monitor = kind === "monitor" ? armedMonitorName(t) : undefined
  if (monitor) return { text: `Monitor: ${monitor}` }
  if ((kind === "snoozed" || kind === "timer") && armedTimerFireAt(t, nowMs)) return { text: "Waiting on a timer" }
  return handoff() ?? (t.activity ? { text: t.activity } : null)
}
