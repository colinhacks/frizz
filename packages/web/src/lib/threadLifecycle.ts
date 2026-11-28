import type { CompletionHold, ThreadView } from "@frizz/shared"
import { isDirectSubAgent } from "@frizz/shared"

export interface ThreadLifecycleAvailability {
  // The header's lifecycle cluster renders (ThreadLifecycleActions). TRUE for any owned session thread,
  // done or not — see `done`.
  lifecycle: boolean
  // The thread is already complete, so the cluster STATES that instead of offering a verb.
  done: boolean
  snooze: boolean
  archive: boolean
}

// One ownership/lifecycle decision shared by queue cards and full thread surfaces. The controls are
// deliberately not message actions: a done fence, transcript hydration, or selected tab can never
// move or duplicate them.
export function threadLifecycleAvailability(
  // A PICK, not the whole view: the resting card asks this same question off its own narrow slice of a
  // thread (AwaitingBackgroundCard), and widening it there just to satisfy a parameter would have made
  // the card claim to read fields it never touches.
  thread: Pick<ThreadView, "kind" | "foreign" | "state" | "archived">,
): ThreadLifecycleAvailability {
  const owned = thread.kind === "session" && thread.foreign !== true
  // `archived` mirrors the pre-state-column protocol; honor it during a rolling server/client reload.
  const archived = owned && (thread.state === "archived" || thread.archived === true)
  // An archived thread has no lifecycle VERBS — there is no Reopen button (reopening is just sending
  // the thread another message), and Snooze rejects an archived thread server-side. It keeps the
  // CLUSTER regardless, reading "Done" where the buttons were, because dropping it left the completed
  // state with nowhere to appear: a thread's full view showed a title, an activity stamp and a composer,
  // and nothing anywhere said the thread was finished (maintainer 2026-07-29, on a /full page: "why does
  // this not have a footer with the mark as done button?" — the honest answer is a readout, not an
  // absence). The cluster was a footer under the prompt box until 2026-10-05; it closes the header's
  // action strip now.
  const lifecycle = owned
  const actionable = owned && !archived
  return {
    lifecycle,
    done: archived,
    snooze: actionable,
    archive: actionable,
  }
}

// Predict whether Mark-as-done will archive IMMEDIATELY — with no "End this session?" dialog — so the
// click can dismiss the card optimistically instead of waiting out the completeThread round-trip.
// Deliberately mirrors the server's completionNeedsConfirmation (server/src/router.ts): a resting,
// human-blocked, or exited shell completes in one action; an executing turn or live background work is
// asked about first. A wrong "immediate" guess is harmless — the server still owns the verdict, and the
// caller reinstates the card + opens the dialog on a needsConfirmation reply — so this only ever errs
// toward NON-optimistic (waiting), never toward skipping a dialog the server would have shown.
export function completionArchivesImmediately(thread: ThreadView): boolean {
  // A worker that was CUT OFF mid-turn — dead, its recorded turn never ended — is asked about too
  // (router.cutOffHold): it is not finished, and Done would say it was. `crashed` is the board's reading
  // of exactly that, and a slight superset of the server's (it also covers a dead daemon still tracking
  // a sub-agent), which only ever errs toward waiting. Checked FIRST: a pending ask on a dead thread is
  // still a dead thread.
  if (thread.runtime === "exited" && thread.crashed) return false
  // Paused-for-a-human states are explicitly safe to stop on the server, regardless of any background work.
  if (thread.runtime === "perm-prompt" || thread.pendingAsk) return true
  // An executing (or still-spawning) turn always prompts.
  if (thread.runtime === "running" || thread.runtime === "spawning") return false
  // A resting/exited shell prompts only if it still has live background sub-agents or shells.
  const busy = (op: { state: string }) => op.state === "running" || op.state === "stale"
  // Sub-agents: DIRECT children only, because that is what the server's completionConfirmationHold
  // counts. This guess only stays useful while it agrees with the verdict it is predicting.
  if (thread.subAgents?.some((op) => isDirectSubAgent(op) && busy(op)) || thread.bgShells?.some(busy)) return false
  return true
}

// One piece of work the confirmation is holding on, drawn as the same row the ops panel over the prompt
// box draws for it (ChildOpRow), so the dialog lists live work the way every other surface does.
export interface CompletionHoldRow {
  kind: "AGENT" | "SHELL"
  label: string
  // Carried through rather than flattened: stale is not proof the op stopped — which is why it holds the
  // completion — but claiming a silent child is actively running would overstate what the tailer knows.
  state: "running" | "stale"
  startedAt?: string
}

export interface CompletionHoldSummary {
  lead: string // the sentence that names WHY Done stopped to ask, and how much is running
  rows: CompletionHoldRow[] // sub-agents first, then shells, as the server named them (already capped)
  overflow: number // ops the server counted but withheld; >0 draws a "+N more" line
  trailer: string // what "Mark as done" will actually do
}

// The confirm dialog's copy. "This thread is still running" answers nothing the human can act on —
// they clicked Done precisely because they thought it was finished — so the reason gets spelled out:
// an executing turn, a specific count of live sub-agents/background shells with their labels, or an
// unreadable transcript. `hold` absent (an older server, or a mispredicted needsConfirmation with no
// evidence attached) degrades to the original generic sentence rather than asserting something false.
//
// THE COUNT LIVES IN THE SENTENCE, the labels in the rows under it (maintainer 2026-11-24, of a
// "1 BACKGROUND SHELL" heading over a ⤷ line: "the rendering looks kind of weird … we have better ways of
// rendering these kinds of running tasks"). The rows are the ops panel's, whose dot already carries the
// kind's hue, so a heading per kind had nothing left to say that the sentence could not.
export function completionHoldSummary(hold: CompletionHold | undefined): CompletionHoldSummary {
  const generic = {
    lead: "This thread is still running.",
    rows: [],
    overflow: 0,
    trailer: "Marking it done stops its agent session.",
  }
  if (!hold) return generic
  // Nothing is running and nothing will be stopped: the worker is already gone, mid-turn. The correction
  // the human needs is that the thread is NOT finished — and that Retry, not Done, is the verb that
  // picks it back up. No rows: a dead worker's children cannot be live, and the server names none.
  if (hold.cutOff) {
    return {
      lead: "This session was cut off mid-turn — its worker ended before the turn finished, so the thread isn’t done.",
      rows: [],
      overflow: 0,
      trailer: "Marking it done files it under Done as it is. Retry resumes it where it left off.",
    }
  }
  // The counts are authoritative — the server caps the named list and can send fewer labels.
  const agents = Math.max(hold.subAgentCount, hold.subAgents.length)
  const shells = Math.max(hold.bgShellCount, hold.bgShells.length)
  const rows: CompletionHoldRow[] = [
    ...hold.subAgents.map((op) => holdRow("AGENT", op)),
    ...hold.bgShells.map((op) => holdRow("SHELL", op)),
  ]
  const overflow = Math.max(0, agents + shells - rows.length)
  const work = [counted(agents, "sub-agent"), counted(shells, "background shell")].filter(Boolean).join(" and ")
  const verb = agents + shells === 1 ? "is" : "are"
  if (hold.unobservable) {
    return {
      lead: "This session is live, but its transcript can’t be read right now — it may still be working.",
      rows,
      overflow,
      trailer: "Marking it done stops the session anyway.",
    }
  }
  if (!hold.turnInFlight && !work) return generic // defensive: a hold with no evidence
  if (hold.turnInFlight && !work) {
    return { lead: "The agent is mid-turn — it’s executing right now.", rows, overflow, trailer: "Marking it done stops the session mid-turn." }
  }
  return {
    lead: hold.turnInFlight
      ? `The agent is mid-turn, and ${work} ${verb} running under it:`
      : `The agent is resting, but ${work} ${verb} still running:`,
    rows,
    overflow,
    trailer: "Marking it done stops all of it.",
  }
}

// True for the "The agent is resting, but … still running:" branch of completionHoldSummary: the parent
// turn is at rest (`!hold.turnInFlight`) and its own sub-agents or background shells are live, so the
// server's `snoozeAwaitingBackground` can take the thread out of the queue while that background work
// keeps running. False while the parent turn itself is executing, cut off, unobservable, or already
// event-snoozed.
export function completionHoldCanKeepRunning(
  hold: CompletionHold | undefined,
  thread?: Pick<ThreadView, "bgSnoozed">,
): boolean {
  if (!hold || hold.cutOff || hold.unobservable || hold.turnInFlight) return false
  if (thread?.bgSnoozed === true) return false
  const agents = Math.max(hold.subAgentCount, hold.subAgents.length)
  const shells = Math.max(hold.bgShellCount, hold.bgShells.length)
  return agents + shells > 0
}

function holdRow(kind: CompletionHoldRow["kind"], op: CompletionHold["subAgents"][number]): CompletionHoldRow {
  return { kind, label: op.label, state: op.state, ...(op.startedAt ? { startedAt: op.startedAt } : {}) }
}

function counted(count: number, noun: string): string {
  return count === 0 ? "" : `${count === 1 ? "a" : count} ${noun}${count === 1 ? "" : "s"}`
}
