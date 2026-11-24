import type { ThreadView } from "@frizz/shared"
import { setPinned } from "./optimisticPin.ts"
import { showToast, type ToastAction } from "../store.ts"

// WHAT MARK AS DONE DOES TO A PIN IS ASKED, EVERY TIME (maintainer 2026-11-24: "When you mark a pinned
// thread as done, it should show you a pop-up asking you if you want to unpin it"). The desktop's Done
// asks before it files the thread (ThreadLifecycle StateButton, UnpinAsk) and hands the answer here. A
// pin outranks Done (router setThreadPinned), so keeping it leaves the thread on the shelf, visible and
// one click away (2026-10-26: "I often have a lot of things pinned intentionally, and I mark them as
// done"). The phone's swipe asks nothing, since the phone has no pin control; its toast offers "Unpin".
// A per-browser choice ticked in a split button's caret (colinhacks/frizz#72) came before the question
// and went with it.
//
// The unpin is the CLIENT's second write after the completion, not part of it: the server's verb stays
// one meaning for every caller.

// Pinned on either shelf, the project board's or the Console's.
export function isPinned(thread: Pick<ThreadView, "pinnedAt" | "consolePinnedAt">): boolean {
  return typeof thread.pinnedAt === "string" || typeof thread.consolePinnedAt === "string"
}

type PinnedThread = Pick<ThreadView, "id" | "sessionId" | "pinnedAt" | "consolePinnedAt">

// Lift the pin from every shelf the thread was on, so "unpin" means off the pinned list everywhere. The
// row leaves the shelf on the click (lib/optimisticPin), and the toast waits for the server.
async function unpin(thread: PinnedThread): Promise<void> {
  await Promise.all([
    typeof thread.pinnedAt === "string" ? setPinned(thread, "board", false) : undefined,
    typeof thread.consolePinnedAt === "string" ? setPinned(thread, "console", false) : undefined,
  ])
}

// The completion toast's "Unpin" action, offered when the completion kept the pin without asking.
export function unpinAction(thread: PinnedThread): ToastAction {
  return {
    label: "Unpin",
    run: () => {
      unpin(thread)
        .then(() => showToast("Unpinned"))
        .catch((error) => showToast(`Couldn’t unpin: ${(error as Error).message.slice(0, 80)}`))
    },
  }
}

// What every completion surface runs once the server has filed the thread under Done. `unpinIt` is the
// operator's answer to the pin question: true lifts the pin, false keeps it with nothing more to offer,
// and undefined (a surface that did not ask) keeps it with "Unpin" on offer in the toast.
export function settleCompletion(text: string, thread: PinnedThread, unpinIt?: boolean): void {
  if (!isPinned(thread) || unpinIt === false) {
    showToast(text)
    return
  }
  if (unpinIt === undefined) {
    showToast(text, { action: unpinAction(thread) })
    return
  }
  unpin(thread)
    .then(() => showToast(`${text} · unpinned`))
    .catch((error) => showToast(`${text}, but couldn’t unpin: ${(error as Error).message.slice(0, 80)}`))
}
