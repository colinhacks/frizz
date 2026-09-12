import { useState } from "react"
import { Check, Hourglass, Loader2 } from "lucide-react"
import type { CompletionHold, ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { threadLifecycleAvailability, completionArchivesImmediately, completionHoldSummary } from "../lib/threadLifecycle.ts"
import { markArchived, clearArchived } from "../lib/optimisticArchive.ts"
import { futureSnoozedUntil } from "../groups.ts"
import { formatAgo } from "../lib/durationLabels.ts"
import { formatSnoozeWake } from "../lib/snooze.ts"
import { CHILD_ARROW, CHILD_ARROW_CLASS } from "../lib/childOps.ts"
import { INK_TRIM_HOURGLASS, STRIP_INK_GAP } from "../lib/iconRhythm.ts"
import { SnoozeButton } from "./SnoozeButton.tsx"
import { ContextMeter } from "./ContextMeter.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { RecurringPromptControl } from "./RecurringPromptControl.tsx"
import { BLOCK_RADIUS_INNER_BOTTOM } from "./TranscriptCard.tsx"
import { Dialog } from "./ui/Dialog.tsx"

// The sole home for whole-thread lifecycle controls. Queue cards render it at their natural bottom;
// full thread surfaces make it sticky below every tab. Keeping this separate from HeaderActions and
// message/fence rendering prevents the completion action from jumping or duplicating after transcript hydration.
export function ThreadLifecycleFooter({
  thread,
  sticky = false,
  safeArea = false,
  onArchived,
  onDismissCancel,
  onSnoozed,
}: {
  thread: ThreadView
  sticky?: boolean
  // The full thread view places this footer at the physical bottom of a drawer. Keep the device
  // inset here, after the lifecycle controls, rather than padding the chat footer below the prompt.
  safeArea?: boolean
  onArchived?: () => void
  // Undo an OPTIMISTIC dismissal (see StateButton): the queue passes this so a card that faded on click
  // can be un-hidden the instant the server declines to complete (needs confirmation, or errors). Absent
  // ⇒ the button stays non-optimistic (the drawer footer, where there is no queue card to reinstate).
  onDismissCancel?: () => void
  onSnoozed?: () => void
}) {
  const available = threadLifecycleAvailability(thread)
  if (!available.footer) return null
  return (
    <footer
      aria-label="Thread lifecycle actions"
      data-thread-lifecycle-footer
      // `text-[12px]` is the footer's OWN scale, stated here rather than left to whatever the
      // surrounding card or drawer happens to set. The buttons pin their size themselves (see
      // StateButton), so this is inert for them; it exists so the em-sized readouts on the left
      // inherit a scale from the strip they sit in instead of choosing one — the sizing discipline
      // ChildOpRow's duration reading landed on.
      // Non-sticky ⇒ this strip IS the bottom of a queue card, laid flush inside the shell's 1px
      // border, so it takes the shell's INNER corner (BLOCK_RADIUS_INNER_BOTTOM) — anything squarer
      // paints out through the arc and erases the border there. The sticky variant sits at the bottom
      // of a drawer whose own chrome carries the corners, so it stays square.
      //
      // The gap is `STRIP_INK_GAP`, and it means 12px of INK — not 12px of box. Every child below
      // carries a negative margin that collapses its layout box onto its own painted mark, because a
      // bare 12px glyph in a 24px hover square and a bordered pill share no relationship between the
      // two (lib/iconRhythm.ts has the measurements, and the strip this replaced drew 5.78px between
      // its two pills against 20.5px between its two icons on one uniform `gap-1.5`).
      className={`${sticky ? "z-20" : BLOCK_RADIUS_INNER_BOTTOM} flex min-h-10 shrink-0 flex-wrap items-center justify-end ${STRIP_INK_GAP} border-t border-border/70 bg-panel/95 px-3 pt-2 text-[12px] ${safeArea ? "pb-[max(0.5rem,env(safe-area-inset-bottom))]" : "pb-2"} backdrop-blur-sm`}
    >
      {/* Bottom-LEFT cluster: the context reading, then the presence markers, held away from the
          lifecycle buttons by the one `mr-auto` on this group. The readings render nothing when they
          have nothing to say — an empty flex box is zero-width, which is what keeps the strip laid out
          as it was before any of this existed.
          THE CONTEXT PIE STAYS FAR LEFT (maintainer, 2026-08-11) and now LEADS the cluster outright:
          the two maintenance verbs that used to follow it — Reload plugins and Restart worker — moved
          up into the header's action strip on 2026-08-26 (maintainer: "the restart worker button should
          be at the top. I just realized it shouldn't be along the bottom"), taking their ink trims with
          them. Whichever mark leads, its ink — not its box — is what the footer's `px-3` should clear;
          every child here wears an `-mx` trim sized to its own dead space for exactly that reason
          (lib/iconRhythm.ts), and the meter needs none because its ring reaches its own svg edge. */}
      <span className={`mr-auto flex items-center ${STRIP_INK_GAP}`}>
        <ContextMeter thread={thread} />
        <PendingSnooze thread={thread} />
        <RecurringPromptControl thread={thread} />
      </span>
      {/* Done ⇒ the strip states the state; otherwise it offers the verbs. Never both, and never
          neither: the slot on the right always says something about where the thread stands. */}
      {available.done ? (
        <DoneReadout />
      ) : (
        <>
          {available.snooze && <SnoozeButton thread={thread} onSnoozed={onSnoozed} />}
          <StateButton thread={thread} onArchived={onArchived} onDismissCancel={onDismissCancel} />
        </>
      )}
    </footer>
  )
}

// What a completed thread says where its Mark-as-done button used to be. A STATEMENT, not a control:
// there is deliberately no Reopen verb anywhere in frizz — a bump un-archives the thread on its way
// through (server/src/resume.ts un-archives up front on any follow-up), so the composer directly above
// this readout already IS the reopen affordance and the tooltip points at it rather than adding a
// second one.
//
// Same Check + "Done" pairing the sidebar's rail indicator and the ```done fence card use, so one
// vocabulary covers all three surfaces.
//
// It wears StateButton's BOX — same `px-2.5 py-1`, plus a 1px TRANSPARENT border standing in for that
// button's real one — so completing a thread in place swaps the label without moving anything. With the
// bare box it was 2px shorter (exactly the border it was missing), and every pixel below it, composer
// included, settled by that much on the click. Now the ✓ lands where the ✓ it replaces was: measured
// 2026-07-29, footer top and composer bottom both move 0.00px through the swap.
//
// Deliberately NO optical nudge on the glyph. It sits at the footer's own 12px scale beside the same
// word at the same size as StateButton's label, and its ink measures IDENTICALLY to that button's under
// both type stacks (+0.46px under the shipping sans default, −1.14px under mono, against the label's cap
// band). Whatever the strip's residual is, the readout and the verb it replaces share it exactly, which
// is the property that matters in a slot where one becomes the other — a nudge on only this glyph would
// make the mark jump on the click.
function DoneReadout() {
  const label = "Marked done — send a message to reopen it"
  return (
    <Tooltip label={label} side="top">
      <span
        data-thread-done
        aria-label={label}
        className="flex items-center gap-1 rounded-md border border-transparent px-2.5 py-1 font-medium text-muted"
      >
        <Check size={12} />
        Done
      </span>
    </Tooltip>
  )
}

// The park is otherwise invisible from inside the thread, so without this you could open a thread with a
// bump armed for Friday and never learn it was going to resume itself. It also makes the un-park visible:
// a follow-up disables the snooze (router.followUp), and this glyph disappearing is how you see that
// happen. So it is a PRESENCE marker only — a glyph, deliberately not a sentence. The footer is a
// control strip, and spending a line of it restating a deadline the SnoozeButton beside it already edits
// is not worth the real estate. Details (wake time, and the follow-up text when one is armed) live
// entirely in the hover popover, exactly as the sidebar's hourglass does. The left-alignment is the
// enclosing cluster's `mr-auto`, not this element's.
function PendingSnooze({ thread }: { thread: ThreadView }) {
  const until = futureSnoozedUntil(thread)
  if (!until) return null
  const prompt = thread.snoozePrompt?.trim()
  // Two shapes, same as everywhere else: a plain park only re-surfaces the card, while an armed one
  // resumes the agent with that text — so naming the follow-up IS the detail worth hovering for.
  const detail = prompt
    ? `Bumps ${formatSnoozeWake(until)}\n${prompt}`
    : `Snoozed until ${formatSnoozeWake(until)}`
  return (
    <Tooltip label={detail} side="top" multiline={!!prompt}>
      {/* `INK_TRIM_HOURGLASS` because this glyph is the strip's most inset mark — lucide's `Hourglass`
          paints 8px of its 12px box, so with `px-0.5` it carries 4px of dead space a side and would
          otherwise sit 8px further from its neighbours than the strip's other marks do. */}
      <span data-pending-snooze aria-label={detail} className={`flex items-center px-0.5 text-muted-60 ${INK_TRIM_HOURGLASS}`}>
        <Hourglass size={12} />
      </span>
    </Tooltip>
  )
}

// THE ARMED-WATCHERS EYE USED TO SIT HERE, and it is gone on purpose (2026-08-14). It listed one line
// per armed watcher — `Shell: bzvtnt3ig`, `PR acme/app#391` — which described objects the row strip
// directly above this footer was ALREADY drawing, one row each, with their own liveness dots. Two
// surfaces for one fact, and the duplicate was the confusing one: it named a shell by the runtime handle
// (`bzvtnt3ig`) that appears nowhere else in the UI, so the same shell read as two unrelated things
// ("shells are not watchers… I don't see either of them as background shells underneath the prompt
// box… we do not need to redundantly list out background shells inside of the watcher icon menu").
//
// It is drift, not a design: the eye came first, and the maintainer then asked for the watchers to be
// shown "underneath the prompt box, similar to how subagents work" (2026-08-13, `githubWatchViews`).
// That strip SUPERSEDED this readout and nobody removed it. Every surface rendering this footer — the
// queue card (TodosView) and the thread drawer (ChatView.ThreadView) — renders BackgroundOpsStrip one
// line above it, so nothing lost a home.
//
// DO NOT REINTRODUCE A WATCHER LIST HERE. If a wait needs to be visible, it belongs in that strip, as a
// row, beside the sub-agents and shells it is a peer of. What a shell's row cannot say on its own — that
// a watcher is armed on it, so this thread will actually wake when it ends — is stated in that row's own
// tooltip (see BackgroundOpsStrip).

// Also rendered — deliberately redundant — as a white primary button at the bottom of the in-chat
// ```done card (see FenceCard). Same completion mutation and live-session confirmation flow; only the
// chrome differs, via `className`. There is deliberately NO Reopen state: reopening a thread is done by
// sending it another message, so the button is always "Mark as done".
export function StateButton({
  thread,
  onArchived,
  onDismissCancel,
  className = "rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] text-fg/80 hover:bg-panel-2 hover:text-fg",
  iconClassName = "",
}: {
  thread: ThreadView
  onArchived?: () => void
  // Undo an optimistic dismissal (queue only). Present ⇒ the click may dismiss the card BEFORE the RPC
  // returns and reinstate it if the server declines; absent ⇒ the button waits for the round-trip.
  onDismissCancel?: () => void
  // Carries the CORNER as well as the fill, because the two surfaces disagree about it: the footer is a
  // free-standing control at rounded-md, while the in-card copy takes the tighter card-action radius so
  // it relates to the card's own corner (TranscriptCard's CARD_ACTION_RADIUS). It cannot be hardcoded
  // below and overridden here — two same-specificity Tailwind utilities resolve by stylesheet order,
  // not by string order, so the winner would be arbitrary.
  className?: string
  // The optical nudge for the Check, which is font- AND size-dependent (lib/iconAlign.ts). The FOOTER
  // keeps its own 12px scale and needs none; the in-card copy runs at the shared 11px card-action
  // scale and passes ICON_LABEL_NUDGE. Neither surface should guess on the other's behalf.
  iconClassName?: string
}) {
  // Disables the instant it's clicked. On success we DON'T reset it: the card is dissolving, so the
  // button stays disabled (still reading "Mark as done", no spinner) for the whole fade-out rather
  // than flickering back to enabled under the animation. Only a live-session confirmation prompt
  // (re-enables under the dialog) or a failure (re-enables in place) clears it.
  const [pending, setPending] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  // The server's own evidence for declining, held for as long as the dialog is up. Never derived from
  // the board snapshot: the snapshot lags the RPC by up to a poll, and the whole point of this copy is
  // that it describes the exact state the server refused on.
  const [hold, setHold] = useState<CompletionHold | undefined>(undefined)
  // `optimistic`: fade the card NOW (before the RPC) rather than after the round-trip. Only when a
  // reinstate path exists AND the completion is predicted to archive immediately — so the common resting
  // "done" card feels instantaneous, while an executing turn still waits and shows the confirm dialog.
  const complete = (terminateLive: boolean, optimistic: boolean) => {
    setPending(true)
    if (optimistic) onArchived?.() // start the exit animation immediately
    // Move the SIDEBAR row to Done now, on the same prediction the queue card's fade already runs on —
    // and gated on the prediction rather than on `optimistic`, because the thread drawer's copy of this
    // button has no queue card to dismiss and its rail row was left waiting on the round-trip too.
    // `terminateLive` is the confirmed path: the operator has answered the dialog, so it archives.
    const expectsArchive = terminateLive || completionArchivesImmediately(thread)
    if (expectsArchive) markArchived(thread.id)
    rpc
      .completeThread({ slug: thread.id, sessionId: thread.sessionId ?? "", terminateLive })
      .then((result) => {
        if (result.needsConfirmation) {
          clearArchived(thread.id) // mispredicted: the server wants the dialog, so the row stays put
          // The server wants confirmation after all (an executing/ambiguous turn, or a rare mispredict).
          // Reinstate the optimistically-dismissed card (onDismissCancel cancels its pending unmount too),
          // then open the dialog over it. The server returns needsConfirmation from a cheap liveness/telemetry
          // check BEFORE any worker teardown, so this reply normally lands before the card's exit and the button is
          // still mounted → the dialog opens. If it arrives after the card already unmounted (a slow reply
          // under event-loop contention), the card still reinstates but this setConfirmOpen no-ops on the
          // gone instance — the user simply sees the card return and can click again. Safe either way.
          if (optimistic) onDismissCancel?.()
          setHold(result.hold)
          setConfirmOpen(true)
          setPending(false)
          return
        }
        setConfirmOpen(false)
        showToast("Done")
        if (!optimistic) onArchived?.() // non-optimistic path dismisses now; optimistic already did
      })
      .catch((error) => {
        clearArchived(thread.id) // …and the rail row back out of Done
        if (optimistic) onDismissCancel?.() // roll the card back into the queue on failure
        showToast(`Couldn’t finish: ${(error as Error).message.slice(0, 80)}`)
        setPending(false)
      })
  }
  const canOptimistic = !!onArchived && !!onDismissCancel && completionArchivesImmediately(thread)
  return (
    <>
      <button
        type="button"
        // The server owns the execution verdict. A live worker can be resting between turns, in
        // which case Done should immediately stop it and archive the thread.
        onClick={() => complete(false, canOptimistic)}
        disabled={pending}
        aria-label="Mark as done"
        title="Mark as done"
        onMouseDown={(event) => event.preventDefault()}
        className={`flex items-center gap-1 font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-45 ${className}`}
      >
        <Check size={12} className={iconClassName} />
        Mark as done
      </button>
      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          if (!pending) setConfirmOpen(open)
        }}
        // A cut-off worker has no session left to end; the question is whether an unfinished thread
        // should be filed as done at all (lib/threadLifecycle.ts completionHoldSummary).
        title={hold?.cutOff ? "Mark an unfinished thread done?" : "End this session?"}
        className="w-[390px] max-w-[92vw]"
        footer={
          <>
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirmOpen(false)}
              className="rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => complete(true, false)}
              className="flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 disabled:opacity-45"
            >
              {pending && <Loader2 size={12} className="animate-spin" />}
              {hold?.cutOff ? "Mark done anyway" : "End session & mark done"}
            </button>
          </>
        }
      >
        <CompletionHoldBody hold={hold} />
      </Dialog>
    </>
  )
}

// The confirm dialog's body. Ending a session kills its whole process tree, so this names what is
// about to die: the executing turn and/or every live sub-agent and background shell, counted and
// listed by label. The human clicked Done believing the thread was finished — the specific "2
// background shells: `Watch CI`, `vite dev`" is the correction, and a bare "still running" was not.
function CompletionHoldBody({ hold }: { hold: CompletionHold | undefined }) {
  const summary = completionHoldSummary(hold)
  return (
    <div data-completion-hold className="flex flex-col gap-2 p-4 text-[12px] leading-relaxed text-muted">
      <p>{summary.lead}</p>
      {summary.groups.map((group) => (
        <div key={group.kind} className="flex flex-col gap-0.5">
          <div className="text-[11px] font-medium uppercase tracking-wide text-fg/70">{group.heading}</div>
          <ul className="flex flex-col gap-0.5">
            {group.items.map((item, index) => (
              <li key={`${item.label}-${index}`} className="flex min-w-0 items-baseline gap-1.5">
                {/* The same ⤷ token every child row uses (lib/childOps.ts). This list is prose inside a
                    dialog, not an operations surface, so it stops at the arrow: no liveness mark, no
                    drill-in, no dismiss — hence the tokens rather than ChildOpRow itself. */}
                <span aria-hidden className={CHILD_ARROW_CLASS}>{CHILD_ARROW}</span>
                <span className="min-w-0 truncate text-fg/80">{item.label}</span>
                {/* Stale is why we ask rather than proof of life: say so instead of implying either. */}
                {item.stale && <span className="shrink-0 text-[11px] text-muted-60">no recent output</span>}
              </li>
            ))}
            {group.overflow > 0 && <li className="pl-[15px] text-muted-60">+{group.overflow} more</li>}
          </ul>
        </div>
      ))}
      <p>{summary.trailer}</p>
    </div>
  )
}
