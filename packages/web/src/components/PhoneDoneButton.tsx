import { useState } from "react"
import { Check, Loader2 } from "lucide-react"
import type { CompletionHold, ThreadView } from "@frizz/shared"
import { markDoneAndAdvance } from "../lib/mobileTriage.ts"
import { completionHoldSummary } from "../lib/threadLifecycle.ts"
import { Dialog } from "./ui/Dialog.tsx"

// The phone thread bar's Done: the verb a resting thread's empty bar offers (approved phone design,
// 2026-09-30). It files the thread through the desktop check's own completion path and opens the
// next thread that needs you (lib/mobileTriage.ts).
//
// The server can still decline — a resting thread whose sub-agents or background shells are running,
// or a worker cut off mid-turn — and then this asks, as the desktop header's check does, with the
// server's own list of what would stop. The dialog's wording is the desktop's (completionHoldSummary);
// only the layout is the phone's.
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

  const summary = completionHoldSummary(hold?.hold)
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
              className="button-outline h-[40px] rounded-md px-4 text-[14px] text-muted outline-none disabled:opacity-45"
            >
              Cancel
            </button>
            <button
              type="button"
              data-phone-done-confirm
              data-dialog-default
              disabled={pending}
              onClick={() => void complete(true)}
              className="button-outline flex h-[40px] items-center gap-1.5 rounded-md bg-fg px-4 text-[14px] font-medium text-bg outline-none disabled:opacity-45"
            >
              {pending && <Loader2 size={14} className="animate-spin" />}
              {hold?.hold?.cutOff ? "Mark done anyway" : "End session & mark done"}
            </button>
          </>
        }
      >
        <div data-completion-hold className="flex flex-col gap-2 p-4 text-[14px] leading-relaxed text-muted">
          <p>{summary.lead}</p>
          {summary.groups.map((group) => (
            <div key={group.kind} className="flex flex-col gap-0.5">
              <div className="text-[12px] font-medium text-fg/70">{group.heading}</div>
              <ul className="flex flex-col gap-0.5">
                {group.items.map((item, index) => (
                  <li key={`${item.label}-${index}`} className="min-w-0 truncate text-fg/80">
                    {item.label}
                    {item.stale && <span className="text-muted-60"> · no recent output</span>}
                  </li>
                ))}
                {group.overflow > 0 && <li className="text-muted-60">+{group.overflow} more</li>}
              </ul>
            </div>
          ))}
          <p>{summary.trailer}</p>
        </div>
      </Dialog>
    </>
  )
}
