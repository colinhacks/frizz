import * as RadixDialog from "@radix-ui/react-dialog"
import { useContext, useEffect, useRef, useState } from "react"
import { Check, ChevronDown, Loader2 } from "lucide-react"
import {
  profileGridDisplayParts,
  profileGridEffortLabel,
  profileGridSelectionKey,
  profileGridSelectionKnown,
  type ProfileGridGroup,
  type ProfileGridOption,
  type ProfileGridSelection,
} from "../lib/profileGrid.ts"
import type { ProfileGridUpgrade } from "./ProfileGridSelector.tsx"
import { PhoneBarHoldContext } from "./Composer.tsx"
import { ExperimentalChip } from "./ui/ExperimentalChip.tsx"
import { Z_POPOVER } from "../lib/layers.ts"

// THE PHONE'S MODEL AND EFFORT PICKER — a bottom sheet in place of the desktop's grid popover.
//
// The grid is a matrix: one row per model, one column per effort level, six columns wide once a
// provider offers its ceiling. At 390px it clipped its sixth column on every row that had one (section 0
// of the approved phone mockup, 2026-09-30). The sheet splits the two axes instead: a list of models,
// grouped by provider, then ONE row of effort chips for the model the list has checked. Every model's
// efforts are still the model's own — a chip row is rebuilt from the checked row, never shared.
//
// It WRITES WHAT THE GRID WRITES: one `{ provider, model, effort }` through the caller's
// `onValueChange`, the same callback the popover fires. The only difference is WHEN. Checking a model
// and then an effort would be two writes on the grid's rules, and on a live thread each write is a
// runtime handoff — so the sheet holds the checked pair locally and commits it ONCE, when it closes. An
// effort tap closes it; so do the scrim and Escape. A close that changed nothing writes nothing.
//
// Permissions and runtime options (the grid's per-provider gear) stay on the desktop. The phone picks
// the model and the effort only.

// When the checked model changes, keep the effort if the new model offers it; otherwise its own default,
// then "high", then its first level. A model with no effort axis (an ACP agent) carries "".
function effortFor(option: ProfileGridOption, current: string | undefined): string {
  if (option.efforts.length === 0) return ""
  if (current && option.efforts.includes(current)) return current
  if (option.defaultEffort && option.efforts.includes(option.defaultEffort)) return option.defaultEffort
  if (option.efforts.includes("high")) return "high"
  return option.efforts[0] ?? ""
}

function ModelName({ option }: { option: ProfileGridOption }) {
  const suffix = option.edition ? ` ${option.edition}` : ""
  if (!suffix || !option.label.endsWith(suffix)) return <>{option.label}</>
  return <>{option.label.slice(0, -suffix.length)} <span className="text-edition">{option.edition}</span></>
}

export function MobileModelSheet({
  groups,
  value,
  onValueChange,
  onClose,
  upgrade,
}: {
  groups: readonly ProfileGridGroup[]
  value?: Partial<ProfileGridSelection>
  onValueChange: (selection: ProfileGridSelection) => void
  onClose: () => void
  upgrade?: ProfileGridUpgrade
}) {
  const [draft, setDraft] = useState<Partial<ProfileGridSelection>>(() => ({ ...value }))
  // Slide up on the next frame, as the phone's other sheets do (MobileAnswerSheet, the board's ⋯).
  const [shown, setShown] = useState(false)
  useEffect(() => {
    const raf = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(raf)
  }, [])

  const draftRef = useRef(draft)
  draftRef.current = draft
  const closedRef = useRef(false)
  function close(selection: Partial<ProfileGridSelection> = draftRef.current) {
    if (closedRef.current) return
    closedRef.current = true
    const known = profileGridSelectionKnown(groups, selection)
    const changed = !value?.model || !known || profileGridSelectionKey({ provider: selection.provider ?? "", model: selection.model ?? "", effort: selection.effort ?? "" })
      !== profileGridSelectionKey({ provider: value.provider ?? "", model: value.model, effort: value.effort ?? "" })
    if (known && changed && selection.provider && selection.model) {
      onValueChange({ provider: selection.provider, model: selection.model, effort: selection.effort ?? "" })
    }
    onClose()
  }

  const checkedOption = groups
    .find((group) => group.id === draft.provider)
    ?.options.find((option) => option.model === draft.model)

  // A RADIX DIALOG, not a bare portal: the sheet opens from inside other modal layers — the thread
  // drawer and the new-thread page are both Radix dialogs, which make everything outside themselves
  // inert and dismiss on any press outside. A nested Radix dialog is the one layer they yield to, and it
  // brings Escape (this sheet only — the layer underneath does not also unwind) and the focus trap.
  // The popover layer (lib/layers.ts) clears every surface a model chip can sit in, the GitHub picker's
  // dialog included.
  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open) close() }}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay
          data-mobile-model-sheet-scrim
          className={`fixed inset-0 ${Z_POPOVER} bg-scrim-50 transition-opacity duration-200 ${shown ? "opacity-100" : "opacity-0"}`}
        />
        <RadixDialog.Content
          data-mobile-model-sheet
          aria-describedby={undefined}
          // Focus nothing on open (a focused row would draw a ring the tap did not ask for), and give it
          // back to nobody on close: returning it to the prompt would raise the keyboard again.
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className={`fixed inset-x-0 bottom-0 ${Z_POPOVER} flex max-h-[86%] flex-col overflow-hidden rounded-t-[16px] border-t border-border-strong bg-panel pb-[calc(14px+env(safe-area-inset-bottom))] shadow-[0_-20px_60px_-10px_var(--sheet-shadow)] outline-none transition-transform duration-200 ease-out motion-reduce:transition-none ${
            shown ? "translate-y-0" : "translate-y-full"
          }`}
        >
          <div className="mx-auto mt-[10px] h-[4px] w-[36px] shrink-0 rounded-full bg-muted/35" />
          <div className="min-h-0 overflow-y-auto pt-2 scrollbar-none">
            <RadixDialog.Title className="px-[18px] pb-2.5 pt-1 text-[16px] font-semibold text-fg">Model</RadixDialog.Title>
            {groups.map((group, gi) => (
              <div key={group.id} role="radiogroup" aria-label={group.label}>
                {group.options.map((option, oi) => {
                  const checked = draft.provider === group.id && draft.model === option.model
                  return (
                    <button
                      key={option.model}
                      type="button"
                      role="radio"
                      aria-checked={checked}
                      data-mobile-model-row={option.model}
                      onClick={() => setDraft({ provider: group.id, model: option.model, effort: effortFor(option, draft.effort) })}
                      className={`flex min-h-[48px] w-full items-center gap-3 px-[18px] text-left active:bg-hover ${
                        gi > 0 && oi === 0 ? "border-t border-border" : ""
                      }`}
                    >
                      {/* The provider names its group once, in a muted column the model names align past —
                        wide enough for "Claude Code" whole at this size. */}
                      <span className="w-[78px] shrink-0 truncate text-[12.5px] text-muted">{oi === 0 ? group.label : ""}</span>
                      <span className="min-w-0 flex-1 truncate text-[15.5px] text-fg">
                        <ModelName option={option} />
                      </span>
                      {group.experimental && oi === 0 && <ExperimentalChip className="shrink-0" />}
                      {checked && <Check aria-hidden size={18} strokeWidth={2.6} className="shrink-0 text-fg" />}
                    </button>
                  )
                })}
              </div>
            ))}
            {groups.every((group) => group.options.length === 0) && (
              <div className="px-[18px] py-3 text-[14px] text-muted">No models available</div>
            )}
            <div className="px-[18px] pb-1.5 pt-4 text-[16px] font-semibold text-fg">Effort</div>
            {checkedOption && checkedOption.efforts.length > 0 ? (
              // ONE row, as the design draws it. A provider with a ceiling offers six levels, which is wider
            // than the phone at a tappable size, so the row scrolls sideways rather than wrapping — the
            // clipped last chip is the cue that there is more.
            <div role="radiogroup" aria-label="Effort" className="flex gap-1.5 overflow-x-auto px-[18px] pb-1.5 pt-1.5 scrollbar-none">
                {checkedOption.efforts.map((effort) => {
                  const on = draft.effort === effort
                  return (
                    <button
                      key={effort}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      data-mobile-effort={effort}
                      // Picking an effort is the last choice the sheet holds, so it commits and closes.
                      onClick={() => close({ ...draft, effort })}
                      // 36px of chip, 44px of target: the hit area reaches 4px past each edge.
                      className={`relative inline-flex h-[36px] shrink-0 items-center rounded-full border px-[13px] text-[14px] after:absolute after:inset-x-0 after:-inset-y-[4px] after:content-[''] ${
                        on ? "border-fg bg-fg font-semibold text-bg" : "border-border-strong text-muted active:bg-hover"
                      }`}
                    >
                      {profileGridEffortLabel(effort)}
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="px-[18px] pb-1 pt-1 text-[14px] text-muted">
                {checkedOption ? "Set by the agent" : "Choose a model first"}
              </div>
            )}
            {upgrade && (
              <div data-mobile-model-upgrade className="mx-[18px] mt-4 flex items-center gap-3 border-t border-border pt-3">
                <span className="min-w-0 flex-1 text-[13px] leading-[18px] text-muted">
                  {upgrade.staged
                    ? `This thread will upgrade to ${upgrade.latest} on its next turn`
                    : `This thread will auto-upgrade to ${upgrade.latest} after its next compaction`}
                </span>
                {!upgrade.staged && (
                  <button
                    type="button"
                    disabled={upgrade.blockedReason !== null || upgrade.pending}
                    title={upgrade.blockedReason ?? undefined}
                    onClick={() => {
                      upgrade.onUpgrade()
                      close()
                    }}
                    className="flex h-[36px] shrink-0 items-center rounded-full border border-border-strong px-[13px] text-[14px] text-fg active:bg-hover disabled:opacity-45"
                  >
                    Upgrade now
                  </button>
                )}
              </div>
            )}
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

/**
 * The phone's model chip ("Opus 5.5 · high ⌄") and the sheet behind it. Takes the grid selector's own
 * props, so every surface that renders a ProfileGridSelector gets the phone picker from the same call.
 */
export function PhoneProfileSelector({
  groups,
  value,
  pending,
  onValueChange,
  placeholder,
  ariaLabel,
  title,
  disabled = false,
  runningModelLabel,
  upgrade,
}: {
  groups: readonly ProfileGridGroup[]
  value?: Partial<ProfileGridSelection>
  pending?: Partial<ProfileGridSelection>
  onValueChange: (selection: ProfileGridSelection) => void
  placeholder?: string
  ariaLabel: string
  title?: string
  disabled?: boolean
  runningModelLabel?: string
  upgrade?: ProfileGridUpgrade
}) {
  const [open, setOpenState] = useState(false)
  // Inside the thread bar's toolbar, keep the bar open while the sheet is up (PhoneBarHoldContext).
  const hold = useContext(PhoneBarHoldContext)
  const setOpen = (next: boolean) => {
    setOpenState(next)
    hold?.(next)
  }
  useEffect(() => {
    if (disabled && open) setOpen(false)
  }, [disabled])
  useEffect(() => () => hold?.(false), [hold])
  const { name, edition, effort } = profileGridDisplayParts(groups, value, placeholder, runningModelLabel)
  const isPending = Boolean(pending?.model || pending?.effort)
  return (
    <>
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        disabled={disabled}
        data-phone-profile-chip
        data-profile-known={profileGridSelectionKnown(groups, value) ? "true" : "false"}
        // Pressing the chip must not take focus from the prompt: in the thread's bar, a blur collapses
        // the row the chip sits in before the click lands. The click itself closes the keyboard (below).
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => {
          // A sheet opened with the keyboard up closes the keyboard first (the approved design).
          if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
          setOpen(true)
        }}
        // 32px of chip, 44px of target.
        className="relative inline-flex h-[32px] min-w-0 max-w-full shrink items-center gap-[5px] rounded-full border border-border-strong bg-bg px-[11px] text-[13.5px] font-medium text-fg after:absolute after:inset-x-0 after:-inset-y-[6px] after:content-[''] active:bg-hover disabled:opacity-45"
      >
        <span className="min-w-0 truncate">
          {name}
          {edition && <> <span className="text-edition">{edition}</span></>}
          {effort && ` · ${effort}`}
        </span>
        {isPending
          ? <Loader2 aria-hidden size={13} className="shrink-0 animate-spin text-muted" />
          : <ChevronDown aria-hidden size={13} strokeWidth={2.4} className="shrink-0 text-muted" />}
      </button>
      {open && (
        <MobileModelSheet
          groups={groups}
          value={value}
          onValueChange={onValueChange}
          onClose={() => setOpen(false)}
          upgrade={upgrade}
        />
      )}
    </>
  )
}
