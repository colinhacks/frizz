import type { ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast, type ToastAction } from "../store.ts"
import { prefs } from "./prefs.ts"

// WHAT MARK AS DONE DOES TO A PIN IS THE OPERATOR'S CHOICE, remembered per browser (prefs.doneUnpins).
// The default KEEPS it: a pin outranks Done (router setThreadPinned), and the maintainer pins threads on
// purpose and marks them done, and wants them to stay on the shelf, visible and one click away
// (2026-10-26: "I often have a lot of things pinned intentionally, and I mark them as done. I want them
// to stay visible and obviously clickable"). Then the toast offers "Unpin", which the human can ignore.
// Another operator finishes a pinned thread to be rid of it (2026-11-12: a split button like Send's,
// whose ticked row is what the button does), and ticks "Mark as done & unpin" in the done card's caret
// menu once (ThreadLifecycle DonePinChoice); every completion in that browser then unpins.
//
// The unpin is the CLIENT's second write after the completion, not part of it: the server's verb stays
// one meaning for every caller, and the phone and an older tab keep the default without knowing a
// choice exists.

// Pinned on either shelf, the project board's or the Console's.
export function isPinned(thread: Pick<ThreadView, "pinnedAt" | "consolePinnedAt">): boolean {
  return typeof thread.pinnedAt === "string" || typeof thread.consolePinnedAt === "string"
}

// Mark as done will take this thread off the pinned list too.
export function completionUnpins(thread: Pick<ThreadView, "pinnedAt" | "consolePinnedAt">): boolean {
  return prefs.doneUnpins && isPinned(thread)
}

type PinnedThread = Pick<ThreadView, "id" | "sessionId" | "pinnedAt" | "consolePinnedAt">

// Lift the pin from every shelf the thread was on, so "unpin" means off the pinned list everywhere.
async function unpin(thread: PinnedThread): Promise<void> {
  const slug = thread.id
  const sessionId = thread.sessionId ?? ""
  if (typeof thread.pinnedAt === "string") await rpc.setThreadPinned({ slug, sessionId, pinned: false })
  if (typeof thread.consolePinnedAt === "string") await rpc.setThreadConsolePinned({ slug, sessionId, pinned: false })
}

// The completion toast's "Unpin" action, offered when the completion kept the pin.
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

// What every completion surface runs once the server has filed the thread under Done: unpin it when this
// browser says Done unpins, otherwise the plain confirmation, with "Unpin" on offer for a pinned thread.
export function settleCompletion(text: string, thread: PinnedThread): void {
  if (!isPinned(thread)) {
    showToast(text)
    return
  }
  if (!completionUnpins(thread)) {
    showToast(text, { action: unpinAction(thread) })
    return
  }
  unpin(thread)
    .then(() => showToast(`${text} · unpinned`))
    .catch((error) => showToast(`${text}, but couldn’t unpin: ${(error as Error).message.slice(0, 80)}`))
}
