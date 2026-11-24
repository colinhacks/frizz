import { useState } from "react"
import { Check, Loader2 } from "lucide-react"
import type { CompletionHold, ThreadView } from "@frizz/shared"
import { markDoneAndAdvance } from "../lib/mobileTriage.ts"
import { CompletionHoldBody } from "./CompletionHoldBody.tsx"
import { Dialog } from "./ui/Dialog.tsx"

// The phone thread bar's Done: the verb a resting thread's empty bar offers (approved phone design,
// 2026-09-30). It files the thread through the desktop check's own completion path and opens the
// next thread that needs you (lib/mobileTriage.ts).
//
// The server can still decline — a resting thread whose sub-agents or background shells are running,
// or a worker cut off mid-turn — and then this asks, as the desktop header's check does, with the
// server's own list of what would stop. The dialog's body is the desktop's (CompletionHoldBody); only
// the type size and the buttons are the phone's.
//
// `data-phone-done`, and never a text match on "Done": every board row carries a hidden swipe button
// with that same label.
export function PhoneDoneButton({ thread, compact }: { thread: ThreadView; compact: boolean }) {
  const [pending, setPending] = useState(false)
  const [hold, setHold] = useState<{ hold?: CompletionHold } | null>(null)

  async function complete(terminateLive: boolean) {
    setPending(true)
    // Confirming files the thread at once (the optimistic path) and moves on, so the dialog goes now.
    if (terminateLive) setHold(null)
    const outcome = await markDoneAndAdvance(thread, { terminateLive })
    if (outcome.kind === "needs-confirmation") setHold({ hold: outcome.hold })
    // "done" leaves `pending` set: the thread is on its way out, and a button that re-enabled under
    // the transition would invite a second completion.
    if (outcome.kind !== "done") setPending(false)
  }

  return (
    <>
      <button
        type="button"
        data-phone-done
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => void complete(false)}
        disabled={pending}
        aria-label="Mark as done"
        className={`flex shrink-0 items-center justify-center gap-1 rounded-full bg-fg font-semibold text-bg disabled:opacity-45 ${
          compact ? "relative h-[36px] pl-[11px] pr-[14px] text-[14px] after:absolute after:inset-x-0 after:-inset-y-[4px] after:content-['']" : "h-[42px] pl-[13px] pr-[16px] text-[15px]"
        }`}
      >
        {/* The check's ink sits in the upper part of its box (its path spans y 6–17 of 24), so centred
            as a box it rode 1.6px above the cap band of "Done" in sans at 15px (measured at dsf 8,
            2026-09-30). 0.1em takes it down onto the band at either size. */}
        {pending && !hold
          ? <Loader2 aria-hidden size={compact ? 15 : 17} className="animate-spin" />
          : <Check aria-hidden size={compact ? 15 : 17} strokeWidth={2.6} className="translate-y-[0.1em]" />}
        Done
      </button>
      <Dialog
        open={hold !== null}
        onOpenChange={(open) => {
          if (!open && !pending) setHold(null)
        }}
        title={hold?.hold?.cutOff ? "Mark an unfinished thread done?" : "End this session?"}
        className="w-[390px] max-w-[92vw]"
        footer={
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => setHold(null)}
              // `pb-0.5` on both: the 14px label sat 0.81px below the 40px box's centre (ink-align, 2026-11-24).
              className="button-outline h-[40px] rounded-md px-4 pb-0.5 text-[14px] text-muted outline-none disabled:opacity-45"
            >
              Cancel
            </button>
            <button
              type="button"
              data-phone-done-confirm
              data-dialog-default
              disabled={pending}
              onClick={() => void complete(true)}
              className="button-outline flex h-[40px] items-center gap-1.5 rounded-md bg-fg px-4 pb-0.5 text-[14px] font-medium text-bg outline-none disabled:opacity-45"
            >
              {pending && <Loader2 size={14} className="animate-spin" />}
              Mark as done
            </button>
          </>
        }
      >
        <CompletionHoldBody hold={hold?.hold} phone />
      </Dialog>
    </>
  )
}
