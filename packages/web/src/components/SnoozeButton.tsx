import { useId, useMemo, useState } from "react"
import { useSnapshot } from "valtio"
import { ChevronDown, Clock, Loader2 } from "lucide-react"
import { SNOOZE_PROMPT_MAX, type ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { futureSnoozedUntil } from "../groups.ts"
import {
  SNOOZE_PRESETS,
  formatSnoozeWake,
  localDateTimeInputValue,
  parseLocalSnooze,
  snoozePresetAction,
  snoozePresetInstant,
  snoozePresetLabel,
  type SnoozePreset,
} from "../lib/snooze.ts"
import { showToast } from "../store.ts"
import { prefs } from "../lib/prefs.ts"
import { shouldSubmitStagedEnter } from "../lib/composerKeyboard.ts"
import { Dialog } from "./ui/Dialog.tsx"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/Menu.tsx"

export function SnoozeButton({ thread, onSnoozed }: { thread: ThreadView; onSnoozed?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [customOpen, setCustomOpen] = useState(false)
  const [customValue, setCustomValue] = useState("")
  const [promptValue, setPromptValue] = useState("")
  const [customError, setCustomError] = useState("")
  const customInputId = useId()
  const promptInputId = useId()
  const customFormId = useId()
  const snoozedUntil = futureSnoozedUntil(thread)
  const selectedPreset = useSnapshot(prefs).snoozePreset
  const selectedLabel = snoozePresetLabel(selectedPreset)
  const selectedAction = snoozePresetAction(selectedPreset)
  const minCustom = useMemo(() => localDateTimeInputValue(new Date(Date.now() + 60_000)), [customOpen])

  // `prompt` is what upgrades a park into a scheduled BUMP: the server arms a durable wake that resumes
  // this thread with exactly that text at `until`. null keeps the historical reminder behavior.
  async function apply(until: string | null, prompt: string | null = null): Promise<void> {
    setBusy(true)
    try {
      await rpc.setThreadSnooze({ slug: thread.id, sessionId: thread.sessionId ?? "", until, prompt: until ? prompt : null })
      if (until) {
        showToast(`${prompt ? "Bump scheduled" : "Snoozed"} · ${formatSnoozeWake(until)}`)
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

  function applyPreset(preset: SnoozePreset) {
    prefs.snoozePreset = preset
    void apply(snoozePresetInstant(preset))
  }

  // Opens on the CURRENTLY SELECTED preset rather than a fixed 1-day default, so the dialog is the
  // "…and send this" continuation of the quick action beside it. An existing snooze re-opens as itself
  // so editing the follow-up never silently moves the deadline.
  function openCustom() {
    setCustomValue(localDateTimeInputValue(new Date(snoozedUntil ?? snoozePresetInstant(selectedPreset))))
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
    const prompt = promptValue.trim()
    if (prompt.length > SNOOZE_PROMPT_MAX) {
      setCustomError(`Prompt is too long (${prompt.length}/${SNOOZE_PROMPT_MAX})`)
      return
    }
    void apply(parsed.until, prompt || null)
  }

  return (
    <>
      <div className="inline-flex items-stretch rounded-md border border-border-strong bg-panel-2/60">
        <button
          type="button"
          disabled={busy}
          aria-label={snoozedUntil ? "Wake thread now" : selectedAction}
          title={snoozedUntil ? `Wake now · ${formatSnoozeWake(snoozedUntil)}` : selectedAction}
          onClick={() => void apply(snoozedUntil ? null : snoozePresetInstant(selectedPreset))}
          className="flex items-center gap-1.5 rounded-l-md px-2.5 py-1 text-[12px] font-medium text-fg/75 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:cursor-not-allowed disabled:opacity-45"
        >
          {busy && <Loader2 size={12} className="animate-spin" />}
          {snoozedUntil ? "Wake now" : selectedAction}
        </button>
        <span aria-hidden className="my-1 w-px bg-border" />
        <Menu>
          <MenuTrigger asChild>
            <button
              type="button"
              disabled={busy}
              aria-label="Snooze options"
              title={`Selected snooze: ${selectedLabel}`}
              className="flex min-w-0 items-center justify-center gap-1 rounded-r-md px-2 text-fg/75 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:cursor-not-allowed disabled:opacity-45"
            >
              <ChevronDown size={12} />
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            {SNOOZE_PRESETS.map((preset) => (
              <MenuItem key={preset.value} onSelect={() => applyPreset(preset.value)} icon={<Clock size={12} />}>
                <span className="flex min-w-0 flex-1 items-center justify-between gap-4">
                  <span>{preset.label}</span>
                  <span className="text-[10px] text-muted-55">{preset.detail}</span>
                </span>
              </MenuItem>
            ))}
            <MenuSeparator />
            <MenuItem onSelect={openCustom}>Custom time &amp; prompt…</MenuItem>
            {snoozedUntil && (
              <>
                <MenuSeparator />
                <MenuItem onSelect={() => void apply(null)}>Wake now</MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>
      </div>

      <Dialog
        open={customOpen}
        onOpenChange={(open) => {
          if (!busy) setCustomOpen(open)
        }}
        title="Snooze thread"
        className="w-[360px] max-w-[92vw]"
        footer={
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() => setCustomOpen(false)}
              className="rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
            >
              Cancel
            </button>
            <button
              type="submit"
              form={customFormId}
              disabled={busy}
              className="flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-opacity hover:opacity-90 disabled:opacity-45"
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
