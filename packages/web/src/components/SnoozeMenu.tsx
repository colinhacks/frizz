import { useId, useMemo, useState } from "react"
import { AlarmClock, AlarmClockOff, Loader2 } from "lucide-react"
import { SNOOZE_PROMPT_MAX, type ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { futureSnoozedUntil } from "../groups.ts"
import {
  DEFAULT_SNOOZE_PRESET,
  SNOOZE_PRESETS,
  activitySnoozeRow,
  activitySnoozed,
  formatSnoozeWake,
  localDateTimeInputValue,
  parseLocalSnooze,
  snoozePresetInstant,
} from "../lib/snooze.ts"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { showToast } from "../store.ts"
import { shouldSubmitStagedEnter } from "../lib/composerKeyboard.ts"
import { Dialog } from "./ui/Dialog.tsx"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/Menu.tsx"
import { Tooltip } from "./Tooltip.tsx"

// THE SNOOZE VERB: an alarm clock in the thread header's action strip whose click opens every preset.
//
// It was a split button in the lifecycle footer until 2026-10-05 — "Snooze 1d" plus a chevron — whose
// one-click half relabelled itself to whatever was picked last (`prefs.snoozePreset`), so the same
// click parked a thread for a different span depending on what you did on some other card yesterday
// (maintainer: "I don't really like the fact that the snooze duration right now is sticky and it just
// gets stuck to the most recently selected value"). The menu has no default to drift: every click
// lists every preset, each with the moment it would bring the thread back. The phone keeps its own
// "Snooze length" setting for its swipe, which this control no longer reads or writes.
//
// The clock is AMBER while a snooze is armed — the goal mark's "something is set" tone — so the verb is
// also the presence marker the footer's grey alarm glyph used to be: a thread opened with a bump armed
// for Friday says so in its header, and the menu then leads with when it wakes and Wake now.
//
// One row is not a clock: "Until activity" (2026-10-19), the resting card's event-snooze offered on any
// rested thread — back at its next rest. It sits under the clock times and is greyed out, with the reason
// on hover, where nothing but a person could end it (lib/snooze.ts activitySnoozeRow). Armed, it takes
// the same amber clock and the same Wake now, which clears either park.
export function SnoozeMenu({ thread, onSnoozed }: { thread: ThreadView; onSnoozed?: () => void }) {
  const [open, setOpen] = useState(false)
  // Closing the menu hands focus back to the clock, and the tooltip opens on focus — where it then takes
  // the next Escape for itself, so on /full one Escape closed the menu and the second only closed a
  // tooltip nobody asked for, instead of leaving fullscreen. It stays quiet until focus or the pointer
  // leaves the clock; focus itself still returns, which is the menu's keyboard contract.
  const [tooltipQuiet, setTooltipQuiet] = useState(false)
  const [busy, setBusy] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [customValue, setCustomValue] = useState("")
  const [promptValue, setPromptValue] = useState("")
  const [customError, setCustomError] = useState("")
  const customInputId = useId()
  const promptInputId = useId()
  const customFormId = useId()
  const snoozedUntil = futureSnoozedUntil(thread)
  const prompt = thread.snoozePrompt?.trim()
  const minCustom = useMemo(() => localDateTimeInputValue(new Date(Date.now() + 60_000)), [customOpen])
  // Recomputed when the menu opens, so each row's wake time is read off the clock at the moment it is
  // offered rather than when the header first rendered.
  const rows = useMemo(() => SNOOZE_PRESETS.map((preset) => {
    const wake = formatSnoozeWake(snoozePresetInstant(preset.value))
    return preset.value === "tomorrow"
      ? { value: preset.value, label: "Tomorrow", wake: wake.replace(/^Tomorrow at /, "") }
      : { value: preset.value, label: preset.label, wake }
  }), [open])
  // "Until activity": the park with no clock (lib/snooze.ts activitySnoozeRow). Read when the menu opens,
  // like the clock rows, so a shell that finished since the header rendered greys the row out.
  const activityRow = useMemo(() => activitySnoozeRow(thread), [open, thread.runtime, thread.wakesOnItsOwn])
  // The menu never sets both parks (each RPC clears the other), but a clock armed by another tab is the
  // one with a time to show, so it wins the state line.
  const byActivity = !snoozedUntil && activitySnoozed(thread)
  const armed = Boolean(snoozedUntil) || byActivity
  // Two shapes: a plain park only re-surfaces the card, while an armed one resumes the agent with that
  // text — so naming the follow-up IS the detail.
  const state = snoozedUntil
    ? (prompt ? `Bumps ${formatSnoozeWake(snoozedUntil)}` : `Snoozed until ${formatSnoozeWake(snoozedUntil)}`)
    : byActivity ? "Snoozed until activity" : null
  const label = state ? (prompt ? `${state}\n${prompt}` : state) : "Snooze"

  // The event-snooze the resting card's own button arms (rpc.snoozeAwaitingBackground): hidden until the
  // thread's next rest. The server refuses it where nothing can wake the thread, which the greyed row
  // already says, and it replaces a clock snooze rather than stacking on one.
  async function applyActivity(): Promise<void> {
    setBusy(true)
    try {
      await rpc.snoozeAwaitingBackground({ slug: thread.id, sessionId: thread.sessionId ?? "" })
      showToast("Snoozed until activity")
      onSnoozed?.()
    } catch (error) {
      showToast((error instanceof Error ? error.message : "Snooze failed").slice(0, 100))
    } finally {
      setBusy(false)
    }
  }

  // `bump` is what upgrades a park into a scheduled BUMP: the server arms a durable wake that resumes
  // this thread with exactly that text at `until`. null keeps the historical reminder behavior.
  async function apply(until: string | null, bump: string | null = null): Promise<void> {
    setBusy(true)
    try {
      await rpc.setThreadSnooze({ slug: thread.id, sessionId: thread.sessionId ?? "", until, prompt: until ? bump : null })
      if (until) {
        showToast(`${bump ? "Bump scheduled" : "Snoozed"} · ${formatSnoozeWake(until)}`)
        onSnoozed?.()
      } else {
        showToast("Snooze cleared")
      }
      setCustomOpen(false)
      setCustomError("")
    } catch (error) {
      const message = error instanceof Error ? error.message : "Snooze failed"
      showToast(message.slice(0, 100))
      setCustomError(message)
    } finally {
      setBusy(false)
    }
  }

  // An existing snooze re-opens as itself so editing the follow-up never silently moves the deadline;
  // otherwise the dialog starts a day out.
  function openCustom() {
    setCustomValue(localDateTimeInputValue(new Date(snoozedUntil ?? snoozePresetInstant(DEFAULT_SNOOZE_PRESET))))
    setPromptValue(thread.snoozePrompt ?? "")
    setCustomError("")
    setCustomOpen(true)
  }

  function submitCustom() {
    const parsed = parseLocalSnooze(customValue)
    if (!parsed.ok) {
      setCustomError(parsed.message)
      return
    }
    const bump = promptValue.trim()
    if (bump.length > SNOOZE_PROMPT_MAX) {
      setCustomError(`Prompt is too long (${bump.length}/${SNOOZE_PROMPT_MAX})`)
      return
    }
    void apply(parsed.until, bump || null)
  }

  return (
    <>
      <Menu
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setTooltipQuiet(true)
        }}
      >
        {/* The tooltip stands down while the menu is open: the menu's own first line already says it. */}
        <Tooltip label={label} multiline={Boolean(prompt)} disabled={open || tooltipQuiet}>
          <MenuTrigger asChild>
            <button
              type="button"
              disabled={busy}
              data-snooze-menu
              data-snoozed={armed ? "true" : "false"}
              aria-label={state ?? "Snooze"}
              // The armed follow-up is the tooltip's second line; a screen reader hears it here, since the
              // name stays the short state that the menu's own first line repeats.
              aria-description={snoozedUntil && prompt ? prompt : undefined}
              // Focus must not leave the composer: same discipline as every other header verb.
              onMouseDown={(event) => event.preventDefault()}
              onBlur={() => setTooltipQuiet(false)}
              onPointerLeave={() => setTooltipQuiet(false)}
              className={`${armed ? HEADER_ICON_CLASS.replace(/(^| )text-muted( |$)/, "$1text-attention-90$2") : HEADER_ICON_CLASS} ${open ? "bg-panel-2" : ""}`}
            >
              {busy ? <Loader2 size={14} strokeWidth={2} className="animate-spin" /> : <AlarmClock size={14} strokeWidth={2} />}
            </button>
          </MenuTrigger>
        </Tooltip>
        <MenuContent align="end">
          <div className="px-2.5 pb-1 pt-1.5 text-[11px] text-muted-60">{state ?? "Snooze"}</div>
          {armed && (
            <>
              <MenuItem onSelect={() => void apply(null)} icon={<AlarmClockOff size={12} />}>Wake now</MenuItem>
              <MenuSeparator />
            </>
          )}
          {rows.map((row) => (
            <MenuItem key={row.value} onSelect={() => void apply(snoozePresetInstant(row.value))} icon={<AlarmClock size={12} />}>
              <span data-snooze-preset={row.value} className="flex min-w-0 flex-1 items-center justify-between gap-6">
                <span>{row.label}</span>
                <span className="text-[10.5px] text-muted-55">{row.wake}</span>
              </span>
            </MenuItem>
          ))}
          {/* UNDER THE CLOCK TIMES, under the same alarm clock (maintainer 2026-10-19, picking it off the
              mockup sheet, then: "Keep the alarm clock icon"). Greyed out where nothing but a person could
              end it — a park nothing ends would hide the thread for good — with the reason on HOVER only.
              The icon is drawn inside the hover target, not in MenuItem's own slot, and the target takes
              back the item's padding, so the whole row answers the pointer rather than the words alone. */}
          <MenuItem onSelect={() => void applyActivity()} disabled={!activityRow.enabled}>
            <Tooltip label={activityRow.enabled ? "" : activityRow.reason} side="left" disabled={activityRow.enabled}>
              <span data-snooze-activity className="-mx-2.5 -my-1.5 flex min-w-0 flex-1 items-center gap-2 px-2.5 py-1.5">
                <span className="flex w-3.5 shrink-0 items-center justify-center"><AlarmClock size={12} /></span>
                <span>Until activity</span>
              </span>
            </Tooltip>
          </MenuItem>
          <MenuSeparator />
          <MenuItem onSelect={openCustom}>Custom time &amp; prompt…</MenuItem>
        </MenuContent>
      </Menu>

      <Dialog
        open={customOpen}
        onOpenChange={(next) => {
          if (!busy) setCustomOpen(next)
        }}
        title="Snooze thread"
        className="w-[360px] max-w-[92vw]"
        footer={
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => setCustomOpen(false)}
              className="button-outline rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
            >
              Cancel
            </button>
            <button
              type="submit"
              form={customFormId}
              data-dialog-default
              disabled={busy}
              className="button-outline flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 disabled:opacity-45"
            >
              {busy && <Loader2 size={12} className="animate-spin" />}
              {promptValue.trim() ? "Snooze & bump" : "Snooze"}
            </button>
          </>
        }
      >
        <form
          id={customFormId}
          className="flex flex-col gap-2.5 p-4"
          onSubmit={(event) => {
            event.preventDefault()
            submitCustom()
          }}
        >
          <label htmlFor={customInputId} className="text-[11px] font-medium text-muted">
            Wake at this local time
          </label>
          <input
            id={customInputId}
            type="datetime-local"
            required
            min={minCustom}
            value={customValue}
            onChange={(event) => {
              setCustomValue(event.target.value)
              setCustomError("")
            }}
            className="w-full rounded-md border border-border bg-bg px-2.5 py-2 text-[13px] text-fg outline-none focus:border-accent"
          />
          <p className="text-[10.5px] text-muted-65">
            Stored as an exact instant; shown here in your browser’s local time zone.
          </p>
          <label htmlFor={promptInputId} className="mt-1 text-[11px] font-medium text-muted">
            Then send this prompt <span className="font-normal text-muted-55">(optional)</span>
          </label>
          {/* The prompt is the difference between a reminder and a scheduled bump, so the field is
              focused: the dialog exists to write one, and the time above already carries a sane default. */}
          <textarea
            id={promptInputId}
            data-1p-ignore
            autoFocus
            rows={3}
            maxLength={SNOOZE_PROMPT_MAX}
            placeholder="e.g. Check whether CI went green and land it if so."
            value={promptValue}
            onChange={(event) => {
              setPromptValue(event.target.value)
              setCustomError("")
            }}
            onKeyDown={(event) => {
              // Enter (or ⌘/Ctrl-Enter) submits from inside the textarea; Shift/Option-Enter make the
              // newline — the three Enter keys every box shares (2026-08-26).
              if (shouldSubmitStagedEnter({
                key: event.key,
                altKey: event.altKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                shiftKey: event.shiftKey,
                isComposing: event.nativeEvent.isComposing,
                keyCode: event.nativeEvent.keyCode,
              })) {
                event.preventDefault()
                submitCustom()
              }
            }}
            className="w-full resize-y rounded-md border border-border bg-bg px-2.5 py-2 text-[13px] leading-5 text-fg outline-none placeholder:text-muted-40 focus:border-accent"
          />
          <p className="min-h-4 text-[10.5px] text-muted-65">
            {promptValue.trim()
              ? "frizz will resume this thread with the prompt at the wake time."
              : "Leave empty to just bring the card back to your queue."}
          </p>
          {customError && <p role="alert" className="text-[11px] text-danger">{customError}</p>}
        </form>
      </Dialog>
    </>
  )
}
