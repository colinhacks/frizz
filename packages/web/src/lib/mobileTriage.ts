import { boardQueuedThread, type CompletionHold, type ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { closeDrawersById, openThread, showToast, store } from "../store.ts"
import { appPushedCurrentEntry } from "./router.ts"
import { displayTitle, needsAction, sectionThreads } from "../groups.ts"
import { prefs } from "./prefs.ts"
import { archivingAtNow, clearArchived, markArchived, optimisticallyArchived } from "./optimisticArchive.ts"
import { completionArchivesImmediately } from "./threadLifecycle.ts"

// THE PHONE'S TRIAGE LOOP: open the top row, read, answer or Done, repeat — without the board in
// between (the approved phone design, 2026-09-30). Done files the thread and opens the next one that
// needs you, in the order the phone's queue lists them; when nothing is left it goes back to the board.
// An Undo toast puts the thread back.
//
// One module, because two surfaces fire it: the thread's bottom bar (the Done button) and the thread's
// ⋯ sheet. Both must pick the same next thread and restore the same way, so neither owns a copy.

/**
 * The phone queue, top to bottom: pinned first, then the asks, then everything else in the queue's own
 * order. The SAME composition MobileBoard renders (its `queue` memo) — Done advancing to a row the board
 * would not have put next would make the loop feel random.
 */
export function phoneQueue(threads: readonly ThreadView[], direction = prefs.queueOrder): ThreadView[] {
  const sections = sectionThreads(threads, direction)
  const asks = sections.active.filter(needsAction)
  const rest = sections.active.filter((t) => !needsAction(t))
  return [...sections.pinned, ...asks, ...rest]
}

/**
 * The next thread that needs you after `fromSlug`: the first row of the phone queue holding a queue card
 * (an ask, or a rested handoff waiting to be read), other than the one being filed. A running row does
 * not need you, so the loop never lands on one, and neither is a pinned thread's plain report a turn in
 * it: it waits on the row, on the phone as on the desktop. A thread the operator marked done a
 * moment ago whose archive the board has not echoed yet is folded through the same optimistic overlay
 * the board uses, so the loop cannot bounce back onto it.
 */
export function nextThreadNeedingYou(
  threads: readonly ThreadView[],
  fromSlug: string,
  direction = prefs.queueOrder,
  archivingAt: Readonly<Record<string, number>> = archivingAtNow(),
): ThreadView | undefined {
  const overlaid = threads.map((t) => optimisticallyArchived(t, archivingAt[t.id]))
  return phoneQueue(overlaid, direction).find((t) => t.id !== fromSlug && boardQueuedThread(t))
}

// Leave the thread just filed: open the next one that needs you, or close back to the board.
//
// THROUGH HISTORY, NOT AROUND IT. When the app pushed the filed thread's entry (the usual case: it was
// opened from the board), that entry is POPPED first — exactly what the header's ← does — and the next
// thread then opens from the board's entry. Closing the drawer directly instead makes the router REPLACE
// the thread's entry with the board, leaving two board entries, so the next Back does nothing visible;
// and opening the next thread on top of the filed one would make Back return to a thread already done.
// Either way the history reads board → next, and Back from the next thread lands on the board. A cold
// deep link (nothing of ours to pop) keeps the direct path.
export function leaveFiledThread(slug: string): void {
  const threads = (store.board?.threads ?? []) as ThreadView[]
  const next = nextThreadNeedingYou(threads, slug)
  if (appPushedCurrentEntry()) {
    if (next) window.addEventListener("popstate", () => setTimeout(() => openThread(next.id), 0), { once: true })
    history.back()
    return
  }
  if (next) {
    openThread(next.id)
    return
  }
  const open = store.drawers.filter((drawer) => !drawer.closing).map((drawer) => drawer.id)
  if (open.length) closeDrawersById(open)
}

// A completion still on the wire, per thread. Undo waits on it: an un-archive that reached the server
// ahead of the archive it undoes would be overwritten by it, and the thread would stay done.
const inFlight = new Map<string, Promise<unknown>>()

export type MarkDoneOutcome =
  | { kind: "done" }
  // The server wants the operator's confirmation (a turn or background work is still going, or the
  // worker was cut off). Only returned when the caller is still on the thread to ask: the optimistic
  // path has already left it, and hands the decision back with a toast instead, as the board's swipe does.
  | { kind: "needs-confirmation"; hold?: CompletionHold }
  | { kind: "declined" }
  | { kind: "failed" }

/**
 * Mark `thread` done through the session-first completion (`rpc.completeThread` — never the legacy
 * `markComplete`, see MobileBoard's swipe), then advance.
 *
 * OPTIMISTIC exactly when the desktop header's check is: when `completionArchivesImmediately` predicts no
 * dialog, or the operator has already answered it (`terminateLive`). Then the row drops into Done, the
 * next thread opens and the Undo toast shows at once, ahead of the round trip; a server that declines
 * after all puts the row back and says so. Otherwise it waits, and a `needs-confirmation` reply goes
 * back to the caller, which is still on the thread and can ask.
 */
export async function markDoneAndAdvance(thread: ThreadView, opts: { terminateLive?: boolean } = {}): Promise<MarkDoneOutcome> {
  const slug = thread.id
  const terminateLive = opts.terminateLive === true
  const optimistic = terminateLive || completionArchivesImmediately(thread)
  const title = displayTitle(thread)
  const filed = () => {
    markArchived(slug)
    leaveFiledThread(slug)
    // No "Unpin" here, unlike every other completion toast (lib/completionPins.ts): a toast holds one
    // action, and on the triage loop's Done that slot is Undo, the loop's only way back to a thread it
    // has already moved past. Nothing is lost: Done keeps the pin, and lifting it stays a desktop act,
    // as pinning already is (the phone has no pin control; it only folds the pinned rows into its list).
    showToast(`“${title}” marked done`, { action: { label: "Undo", run: () => void undoMarkDone(slug) } })
  }
  if (optimistic) filed()
  const request = rpc.completeThread({ slug, sessionId: thread.sessionId ?? "", terminateLive })
  inFlight.set(slug, request)
  try {
    const result = await request
    if (result.needsConfirmation) {
      clearArchived(slug)
      if (!optimistic) return { kind: "needs-confirmation", hold: result.hold }
      // Already moved on from the thread: the swipe's hand-back, with a way back to it.
      showToast(result.hold?.cutOff
        ? "Cut off mid-turn — open the thread to retry it, or to mark it done anyway"
        : "Still running — open the thread to finish it", { link: { label: "Open", slug } })
      return { kind: "declined" }
    }
    if (!optimistic) filed()
    return { kind: "done" }
  } catch (error) {
    clearArchived(slug)
    const message = `Couldn’t finish: ${(error as Error).message.slice(0, 80)}`
    showToast(message, optimistic ? { link: { label: "Open", slug } } : undefined)
    return { kind: "failed" }
  } finally {
    if (inFlight.get(slug) === request) inFlight.delete(slug)
  }
}

/**
 * Put a thread marked done back where it was, and reopen it.
 *
 * Frizz has no Reopen verb in its UI — sending a thread a message is what reopens it — but the server has
 * the explicit lifecycle write that verb would use (`setThreadState`, the only writer of `state`), and
 * that is all this does: `state` goes back to `open`. What completion also did stays done. A worker that
 * was resting live was stopped, and the next message resumes the conversation from disk in a new one,
 * exactly as it does for any thread whose worker exited; a snooze it carried was cleared and is not
 * re-armed. Unread is left cleared — the operator has just read it.
 */
export async function undoMarkDone(slug: string): Promise<void> {
  // An Undo can beat the completion it undoes to the server. Let that land first; its failure has
  // already been reported and left the thread open, which is all an Undo would do.
  await inFlight.get(slug)?.catch(() => undefined)
  try {
    await rpc.setThreadState({ slug, state: "open" })
    clearArchived(slug)
    openThread(slug)
  } catch (error) {
    showToast(`Couldn’t undo: ${(error as Error).message.slice(0, 80)}`)
  }
}
