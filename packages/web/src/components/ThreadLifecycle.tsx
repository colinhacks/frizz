import { useState, type ReactNode } from "react"
import * as RadixMenu from "@radix-ui/react-dropdown-menu"
import { useSnapshot } from "valtio"
import { Check, ChevronDown, Loader2 } from "lucide-react"
import type { CompletionHold, ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { threadLifecycleAvailability, completionArchivesImmediately, completionHoldSummary } from "../lib/threadLifecycle.ts"
import { markArchived, clearArchived } from "../lib/optimisticArchive.ts"
import { isPinned, settleCompletion } from "../lib/completionPins.ts"
import { prefs } from "../lib/prefs.ts"
import { OPAQUE_PORTAL_SURFACE_CLASS } from "../lib/overlaySurface.ts"
import { CHILD_ARROW, CHILD_ARROW_CLASS } from "../lib/childOps.ts"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { SnoozeMenu } from "./SnoozeMenu.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { Dialog } from "./ui/Dialog.tsx"

// THE WHOLE-THREAD LIFECYCLE VERBS, at the far right of a thread header's action strip: an alarm clock
// that snoozes and a check that marks the thread done. Both headers render it — the queue card's and the
// thread view's (the drawer and /full) — so the two surfaces cannot drift.
//
// They lived in a footer strip under the prompt box until 2026-10-05, beside the context reading and
// the goal. The maintainer gave the thread's two edges one job each: the HEADER manages the thread as a
// whole (what it is, how full its context is, the views onto it, the verbs that park or finish it), and
// the BOTTOM steers the run (what is outstanding, the prompt box, the goal beside send). "Everything
// that's like chat management stuff … goes in the top, and then stuff that relates to the current
// running of the chat and ways to steer it go … in the prompt box at the bottom." So the context reading
// moved up beside "Last active" (ContextMeter), the goal moved into the prompt box's rail
// (RecurringPromptControl), and the footer went.
//
// BARE ICONS in the strip's own 28px squares, not the labelled buttons they replace — "those icons are
// both just incredibly clear what they are" — with their names one hover away like every other header
// icon. A hairline rule holds them apart from the view controls before them; `mx-2.5` puts 20px of ink
// before it and 19.5px after it on a real queue card, the strip's own icon-to-icon rhythm (20–21px;
// clock to check 18.25px), so the rule groups without crowding (scripts/ink-gaps.mjs, dsf 4,
// 2026-10-05). After the Retry PILL the left margin widens (styles.css, `[data-header-pill]`): a
// bordered pill has no dead space, and on `mx-2.5` it sat 12px off the rule against 19.5px on the other
// side. The check is LAST: it is the verb a resting card most often ends on.
//
// A DONE thread states the state instead of offering the verbs (DoneReadout), because there is no
// Reopen — a message reopens it. An unowned thread gets nothing at all: frizz recorded no lifecycle for
// it to vouch for.
export function ThreadLifecycleActions({
  thread,
  onArchived,
  onDismissCancel,
  onSnoozed,
}: {
  thread: ThreadView
  onArchived?: () => void
  // Undo an OPTIMISTIC dismissal (see StateButton): the queue passes this so a card that faded on click
  // can be un-hidden the instant the server declines to complete (needs confirmation, or errors). Absent
  // ⇒ the button stays non-optimistic (the drawer and /full, where there is no queue card to reinstate).
  onDismissCancel?: () => void
  onSnoozed?: () => void
}) {
  const available = threadLifecycleAvailability(thread)
  if (!available.lifecycle) return null
  return (
    // A named group, as the footer this replaced was a named landmark: "Thread lifecycle actions" is
    // how a screen reader finds the verbs at the end of a header full of other icons.
    <span data-thread-lifecycle role="group" aria-label="Thread lifecycle actions" className="flex shrink-0 items-center gap-0.5">
      <span aria-hidden data-lifecycle-rule className="mx-2.5 h-4 w-px shrink-0 bg-border" />
      {available.done ? (
        <DoneReadout />
      ) : (
        <>
          {available.snooze && <SnoozeMenu thread={thread} onSnoozed={onSnoozed} />}
          <StateButton thread={thread} onArchived={onArchived} onDismissCancel={onDismissCancel} iconOnly />
        </>
      )}
    </span>
  )
}

// What a completed thread says where its two verbs were. A STATEMENT, not a control: there is
// deliberately no Reopen verb anywhere in frizz — a bump un-archives the thread on its way through
// (server/src/resume.ts un-archives up front on any follow-up), so the prompt box already IS the reopen
// affordance and the tooltip points at it rather than adding a second one.
//
// Same Check + "Done" pairing the sidebar's rail indicator and the ```done fence card use, so one
// vocabulary covers all three surfaces. It takes the header icons' 28px height so completing a thread in
// place swaps the verbs for the readout without moving the header's line.
function DoneReadout() {
  return <LifecycleReadout data-thread-done="" check tooltip="Marked done — send a message to reopen it">Done</LifecycleReadout>
}

// The readout's chrome, shared with a settled sub-agent's (SubAgentSheet), which states how its run
// ended in the slot its stop check stood in, as a thread states Done where its verbs were.
export function LifecycleReadout({
  check = false,
  tooltip,
  children,
  ...data
}: {
  check?: boolean
  tooltip: string
  children: ReactNode
} & { [attribute: `data-${string}`]: string | undefined }) {
  return (
    <Tooltip label={tooltip}>
      <span
        {...data}
        aria-label={tooltip}
        className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] font-medium text-muted"
      >
        {check && <Check size={12} />}
        {children}
      </span>
    </Tooltip>
  )
}

// The header's check (ThreadLifecycleActions, `iconOnly`), and also rendered — deliberately redundant —
// as a white primary button at the bottom of the in-chat ```done card (see FenceCard) and as a row in
// the phone's ⋯ sheet. Same completion mutation and live-session confirmation flow; only the chrome
// differs, via `className` or `iconOnly`. There is deliberately NO Reopen state: reopening a thread is done by
// sending it another message, so the button is always "Mark as done".
export function StateButton({
  thread,
  onArchived,
  onDismissCancel,
  className = "rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] text-fg/80 hover:bg-panel-2 hover:text-fg",
  iconClassName = "",
  iconSize = 12,
  iconOnly = false,
  pinChoice,
}: {
  thread: ThreadView
  onArchived?: () => void
  // Undo an optimistic dismissal (queue only). Present ⇒ the click may dismiss the card BEFORE the RPC
  // returns and reinstate it if the server declines; absent ⇒ the button waits for the round-trip.
  onDismissCancel?: () => void
  // Carries the CORNER as well as the fill, because the surfaces disagree about it: the phone's sheet row
  // is a list row, while the in-card copy takes the tighter card-action radius so it relates to the
  // card's own corner (TranscriptCard's CARD_ACTION_RADIUS). It cannot be hardcoded
  // below and overridden here — two same-specificity Tailwind utilities resolve by stylesheet order,
  // not by string order, so the winner would be arbitrary.
  className?: string
  // The optical nudge for the Check, which is font- AND size-dependent (lib/iconAlign.ts). The in-card
  // copy runs at the shared 11px card-action scale and passes ICON_LABEL_NUDGE. Neither surface should
  // guess on the other's behalf.
  iconClassName?: string
  // The Check's size. 12 in the done card; the phone's ⋯ sheet draws it as a list row, where every row's
  // icon is 19px.
  iconSize?: number
  // THE HEADER'S CHECK: a bare glyph in the action strip's own square (lib/headerIcon.ts), its name in an
  // immediate tooltip like every other header icon. 15px, one size up from the strip's 14: lucide's
  // Check paints only 16 of its 24 units across, so at 14 it read lighter than the clock beside it.
  iconOnly?: boolean
  // THE DONE CARD'S SPLIT BUTTON: on a pinned thread a caret beside the label opens what Done does to the
  // pin (DonePinChoice), and the label names the ticked choice. The value is the PILL's chrome — its
  // corner, type size and fill, with no padding and no hover, since each half pads and tints itself. An
  // unpinned thread has nothing to choose, so it draws the plain button in `className`.
  pinChoice?: string
}) {
  const { doneUnpins } = useSnapshot(prefs)
  // What this click will do, named where the verb is named: the header check's tooltip and the label.
  const label = doneUnpins && isPinned(thread) ? "Mark as done & unpin" : "Mark as done"
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
        // A pinned thread keeps or loses its pin as this browser chose (lib/completionPins.ts).
        settleCompletion("Done", thread)
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
      {iconOnly ? (
        <Tooltip label={label}>
          <button
            type="button"
            onClick={() => complete(false, canOptimistic)}
            disabled={pending}
            aria-label={label}
            onMouseDown={(event) => event.preventDefault()}
            className={HEADER_ICON_CLASS}
          >
            <Check size={15} strokeWidth={2} />
          </button>
        </Tooltip>
      ) : pinChoice && isPinned(thread) ? (
        <DonePinChoice className={pinChoice} pending={pending}>
          <button
            type="button"
            data-done-split-label
            onClick={() => complete(false, canOptimistic)}
            disabled={pending}
            aria-label={label}
            title={label}
            onMouseDown={(event) => event.preventDefault()}
            className={`flex items-center gap-1 rounded-l-[inherit] py-1 pl-2.5 pr-2 font-medium outline-none transition-colors hover:bg-bg/10 focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-45`}
          >
            <Check size={iconSize} className={iconClassName} />
            {label}
          </button>
        </DonePinChoice>
      ) : (
        <button
          type="button"
          // The server owns the execution verdict. A live worker can be resting between turns, in
          // which case Done should immediately stop it and archive the thread.
          onClick={() => complete(false, canOptimistic)}
          disabled={pending}
          aria-label={label}
          title={label}
          onMouseDown={(event) => event.preventDefault()}
          className={`flex items-center gap-1 font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-45 ${className}`}
        >
          <Check size={iconSize} className={iconClassName} />
          {label}
        </button>
      )}
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
              className="button-outline rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => complete(true, false)}
              className="button-outline flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 disabled:opacity-45"
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

const PIN_CHOICES: readonly { unpins: boolean; name: string; says: string }[] = [
  { unpins: false, name: "Mark as done", says: "It stays pinned at the top of the sidebar." },
  { unpins: true, name: "Mark as done & unpin", says: "It leaves the pinned list and files under Done." },
]

// THE CARET HALF OF THE DONE CARD'S SPLIT BUTTON, after the prompt box's Send (SendSplitButton): the
// pill paints the fill once, each half paints only its hover tint, and the 1px seam wears that same tint
// so a lit half swallows it. The menu's ticked row is what the label does, and picking a row only ticks
// it — it marks nothing done — because the choice is remembered for every later Done in this browser
// (prefs.doneUnpins), as Send's ticked row is for every later send.
//
// Its ink gaps are Send's, read from pixels in sans at 11px (2026-11-12): last letter → seam 8px,
// seam → chevron 7px, chevron → right edge 8px. The label half keeps the plain button's left inset, so
// a pinned and an unpinned card start their check at the same x. Re-measure if the size or glyph moves.
function DonePinChoice({ className, pending, children }: { className: string; pending: boolean; children: ReactNode }) {
  const { doneUnpins } = useSnapshot(prefs)
  return (
    <span data-done-split className={`flex items-stretch font-medium ${className}`}>
      {children}
      <span aria-hidden className="w-px shrink-0 bg-bg/10" />
      <RadixMenu.Root modal={false}>
        <RadixMenu.Trigger asChild>
          <button
            type="button"
            data-done-split-menu
            disabled={pending}
            aria-label="Choose what Mark as done does to the pin"
            onMouseDown={(event) => event.preventDefault()}
            className="flex items-center rounded-r-[inherit] pl-1 pr-[5px] outline-none transition-colors hover:bg-bg/10 focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-45"
          >
            <ChevronDown size={12} strokeWidth={2.5} />
          </button>
        </RadixMenu.Trigger>
        <RadixMenu.Portal>
          <RadixMenu.Content
            data-done-pin-choices
            side="bottom"
            align="start"
            sideOffset={6}
            className={`${OPAQUE_PORTAL_SURFACE_CLASS} w-[300px] rounded-lg p-1`}
          >
            <RadixMenu.RadioGroup value={doneUnpins ? "unpin" : "keep"} onValueChange={(next) => { prefs.doneUnpins = next === "unpin" }}>
              {PIN_CHOICES.map((row) => {
                const on = row.unpins === doneUnpins
                return (
                  <RadixMenu.RadioItem
                    key={row.name}
                    value={row.unpins ? "unpin" : "keep"}
                    data-done-pin-choice={row.unpins ? "unpin" : "keep"}
                    className="flex cursor-pointer select-none items-start gap-2 rounded-md px-2 py-1.5 text-left outline-none transition-colors data-[highlighted]:bg-panel-2"
                  >
                    <span className="flex h-[18px] w-3.5 shrink-0 items-center justify-center text-fg">{on && <Check size={13} strokeWidth={2.5} />}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[12px] font-medium leading-[18px] text-fg">{row.name}</span>
                      <span className="block text-[11.5px] leading-[16px] text-muted">{row.says}</span>
                    </span>
                  </RadixMenu.RadioItem>
                )
              })}
            </RadixMenu.RadioGroup>
            <div className="px-2 pb-1 pt-1.5 text-[11px] leading-[15px] text-muted-70">Remembered for every Done in this browser.</div>
          </RadixMenu.Content>
        </RadixMenu.Portal>
      </RadixMenu.Root>
    </span>
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
