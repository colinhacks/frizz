import * as RadixMenu from "@radix-ui/react-dropdown-menu"
import { Check, ChevronDown, Loader2 } from "lucide-react"
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import {
  moveProfileGridSelection,
  PROFILE_GRID_CELL_CLASS,
  PROFILE_GRID_COMPACT_TYPOGRAPHY_CLASS,
  PROFILE_GRID_TYPOGRAPHY_CLASS,
  profileGridColumns,
  profileGridDisplayLabel,
  profileGridDisplayParts,
  profileGridEffortLabel,
  profileGridListedOptions,
  profileGridResolveSelection,
  profileGridShownModel,
  profileGridSelectionFromKey,
  profileGridSelectionKey,
  profileGridSelectionKnown,
  profileGridTemplateColumns,
  type ProfileGridGroup,
  type ProfileGridOption,
  type ProfileGridMoveKey,
  type ProfileGridDisplayParts,
  type ProfileGridSelection,
  profileGridSelections,
} from "../lib/profileGrid.ts"
import { dismissOpenSelect, registerOpenSelect } from "../lib/selectOverlay.ts"
import { OPAQUE_PORTAL_SURFACE_Z, OPAQUE_SURFACE_BASE } from "../lib/overlaySurface.ts"
import { AgentSettingsPopover } from "./AgentSettingsPopover.tsx"
import { PhoneProfileSelector } from "./MobileModelSheet.tsx"
import { PROMPT_CONTROL_CELL, usePromptControlCell } from "./ui/PromptControlGroup.tsx"
import { ExperimentalChip } from "./ui/ExperimentalChip.tsx"
import { useIsMobile } from "../lib/mobile.ts"

const effortLabel = profileGridEffortLabel

// The model column's label: the family word, then its version one step dimmer (maintainer 2026-09-24,
// picking candidate A of the version mockups: "a grade-out version after the model name in the left
// column of the selector"). A label that does not END in its edition renders whole — never a guess.
function ModelLabel({ label, edition }: { label: string; edition?: string }) {
  const suffix = edition ? ` ${edition}` : ""
  if (!suffix || !label.endsWith(suffix)) return <>{label}</>
  return <>{label.slice(0, -suffix.length)} <span className="profile-grid-edition text-edition">{edition}</span></>
}

// The trigger's readout: the model, its version in the same dim ink as the menu's model column, then the
// effort — "Opus 5.5 › high" with the 5.5 grayed, in the dispatch composer and a running thread's alike.
function TriggerLabel({ name, edition, effort }: ProfileGridDisplayParts) {
  return (
    <>
      {name}
      {edition && <> <span className="profile-grid-edition text-edition">{edition}</span></>}
      {effort && ` › ${effort}`}
    </>
  )
}

// "Opus 5.5" must never break between the family and its version when a sentence wraps.
function unbroken(label: string): string {
  return label.replace(/ /g, "\u00a0")
}

/** A running Claude thread on an older edition of its family than the pinned runtime now resolves. The
 *  edition it runs is the trigger's own readout (`runningModelLabel`), so the row names only the target. */
export interface ProfileGridUpgrade {
  /** "Opus 5.5" — what the family resolves to now. */
  latest: string
  /** No live worker holds the old edition: the next turn starts on `latest` with nothing to do. */
  staged: boolean
  /** Why the upgrade cannot run right now (a turn in flight, background work), or null. */
  blockedReason: string | null
  pending: boolean
  onUpgrade: () => void
}

type ProfileGridSelectorProps = {
  groups: readonly ProfileGridGroup[]
  value?: Partial<ProfileGridSelection>
  pending?: Partial<ProfileGridSelection>
  onValueChange: (selection: ProfileGridSelection) => void
  placeholder?: string
  ariaLabel: string
  menuAriaLabel?: string
  title?: string
  disabled?: boolean
  compact?: boolean
  side?: "top" | "bottom"
  // EXACTLY ONE z utility for the portaled menu (see lib/overlaySurface.ts — two z-* classes on one
  // element resolve by CSS source order, not class order). Override only to clear a higher surface
  // the trigger lives inside, e.g. OPAQUE_PORTAL_SURFACE_ABOVE_DIALOG_Z inside the z-[200] Overlay.
  menuZClass?: string
  className?: string
  // A gear on each runtime's band opening that runtime's settings for NEW workers in this project
  // (AgentSettingsPopover) — never a promise to retune a running thread. The dispatch surfaces set it;
  // a live thread's own picker does not.
  agentSettings?: boolean
  // A running thread's readout names the edition its worker RUNS (profileGridDisplayLabel), and its menu
  // offers the move to the family's current edition — both only on a live thread's own picker.
  runningModelLabel?: string
  upgrade?: ProfileGridUpgrade
}

// ONE selector, two presentations. Below the phone breakpoint the grid popover gives way to a chip and
// a bottom sheet (MobileModelSheet): the grid's six effort columns do not fit a 390px screen. Both write
// the same selection through the same `onValueChange`, so no call site knows which one it rendered — and
// a separate component per branch keeps each one's hooks its own when a window crosses the breakpoint.
export function ProfileGridSelector(props: ProfileGridSelectorProps) {
  return useIsMobile() ? <PhoneProfileSelector {...props} /> : <DesktopProfileGridSelector {...props} />
}

function DesktopProfileGridSelector({
  groups,
  value,
  pending,
  onValueChange,
  placeholder,
  ariaLabel,
  menuAriaLabel = "Choose model and effort",
  title,
  disabled = false,
  compact = false,
  side = "bottom",
  menuZClass = OPAQUE_PORTAL_SURFACE_Z,
  className = "",
  agentSettings = false,
  runningModelLabel,
  upgrade,
}: ProfileGridSelectorProps) {
  const joined = usePromptControlCell()
  const [open, setOpen] = useState(false)
  const [settingsGroup, setSettingsGroup] = useState<string | null>(null)
  const settingsGroupRef = useRef(settingsGroup)
  settingsGroupRef.current = settingsGroup
  const openRef = useRef(open)
  const disabledRef = useRef(disabled)
  const unregisterOpenRef = useRef<(() => void) | undefined>(undefined)
  const cellRefs = useRef(new Map<string, HTMLElement>())
  const committedKeyRef = useRef<string | undefined>(undefined)
  const columns = useMemo(() => profileGridColumns(groups), [groups])
  const selections = useMemo(() => profileGridSelections(groups), [groups])
  const typography = compact ? PROFILE_GRID_COMPACT_TYPOGRAPHY_CLASS : PROFILE_GRID_TYPOGRAPHY_CLASS
  const triggerInteraction = disabled
    ? "cursor-not-allowed opacity-45"
    : "cursor-pointer transition-colors hover:bg-hover-strong hover:text-fg"
  const known = profileGridSelectionKnown(groups, value)
  // `known` has already checked the effort against the row, and a row with no effort axis (an ACP
  // agent) is keyed on `effort: ""` — so the key is built whenever the model is known, not only when
  // the effort is non-empty.
  const currentKey = known && value?.provider && value.model
    ? profileGridSelectionKey({ provider: value.provider, model: value.model, effort: value.effort ?? "" })
    : undefined
  const pendingLabel = pending?.model || pending?.effort
    ? profileGridDisplayLabel(groups, pending, "Pending profile")
    : undefined
  openRef.current = open
  disabledRef.current = disabled

  function closeFromRegistry() {
    setSettingsGroup(null)
    openRef.current = false
    unregisterOpenRef.current = undefined
    setOpen(false)
  }

  // Escape peels ONE layer: the agent-settings panel if it is open, else the menu. A Select open
  // INSIDE that panel registered itself after this menu did, so `dismissOpenSelect` closes it and
  // nothing else — the keydown handler below checks the registry before touching a layer of its own.
  function dismissTopLayer() {
    if (settingsGroupRef.current) {
      settingsGroupRef.current = null
      setSettingsGroup(null)
      unregisterOpenRef.current = registerOpenSelect(dismissTopLayer)
    } else closeFromRegistry()
  }

  useLayoutEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !openRef.current || disabledRef.current) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      // The registry holds whichever layer opened LAST — this menu's own entry (its dismiss is
      // dismissTopLayer) or a Select inside the settings panel. Either way one press, one layer.
      if (dismissOpenSelect()) return
      unregisterOpenRef.current?.()
      dismissTopLayer()
    }
    window.addEventListener("keydown", onKeyDown, { capture: true })
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true })
  }, [])

  useLayoutEffect(() => {
    if (!disabled || !open) return
    unregisterOpenRef.current?.()
    closeFromRegistry()
  }, [disabled, open])

  useLayoutEffect(() => () => unregisterOpenRef.current?.(), [])

  // A pointer selection also reaches RadioGroup's onValueChange. Clear the one-event guard once
  // its controlled value has caught up, so keyboard activation remains available while one click
  // can never enqueue two preference writes.
  useLayoutEffect(() => {
    if (currentKey === committedKeyRef.current) committedKeyRef.current = undefined
  }, [currentKey])

  function commitSelection(picked: ProfileGridSelection) {
    const selection = profileGridResolveSelection(groups, picked)
    const key = profileGridSelectionKey(selection)
    if (committedKeyRef.current === key) return
    committedKeyRef.current = key
    onValueChange(selection)
  }

  function handleCellKeyDown(event: KeyboardEvent<HTMLElement>, current: ProfileGridSelection) {
    if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return
    const next = moveProfileGridSelection(groups, current, event.key as ProfileGridMoveKey)
    if (!next) return
    event.preventDefault()
    event.stopPropagation()
    cellRefs.current.get(profileGridSelectionKey(next))?.focus()
  }

  return (
    <RadixMenu.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        unregisterOpenRef.current?.()
        unregisterOpenRef.current = undefined
        openRef.current = next
        setOpen(next)
        if (next) unregisterOpenRef.current = registerOpenSelect(dismissTopLayer)
        else setSettingsGroup(null)
      }}
    >
      <RadixMenu.Trigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={ariaLabel}
          aria-invalid={!known && Boolean(value?.model || value?.effort) ? true : undefined}
          aria-description={pendingLabel ? `Pending ${pendingLabel}` : undefined}
          title={title}
          data-profile-known={known ? "true" : "false"}
          data-profile-pending={pendingLabel ? "true" : undefined}
          className={`profile-grid-trigger group inline-flex min-w-0 max-w-full items-center gap-[3px] ${joined ? PROMPT_CONTROL_CELL : "rounded-md border border-border/50 px-2 py-1"} bg-transparent text-left text-muted outline-none data-[state=open]:bg-hover-strong ${triggerInteraction} ${className} ${typography}`}
        >
          {/* Lifted a pixel, as the permission picker's value is (`.select-trigger-readout`): petite caps sit on the
              baseline, so their ink rode 1.2px below the caret and the marks on this line. The cap band it was once
              measured against is 8.7px tall where these letters are 7.5px. Standalone, its 3px box gap paints 6.69px
              of ink to the chevron; in a PromptControlGroup there is no chevron, and the gap is the spinner's. */}
          <span className={`profile-grid-value relative -top-px min-w-0 flex-1 truncate text-left ${typography}`}>
            <TriggerLabel {...profileGridDisplayParts(groups, value, placeholder, runningModelLabel)} />
          </span>
          {pendingLabel && <Loader2 aria-hidden="true" size={compact ? 10 : 11} className="shrink-0 animate-spin text-muted-65" />}
          {!joined && <ChevronDown aria-hidden="true" size={compact ? 11 : 13} className="shrink-0 text-fg/65 transition-transform group-data-[state=open]:rotate-180" />}
        </button>
      </RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content
          aria-label={menuAriaLabel}
          align="start"
          side={side}
          sideOffset={5}
          collisionPadding={8}
          onEscapeKeyDown={(event) => event.stopPropagation()}
          // While the agent-settings panel is open it owns every outside interaction: it is modal, so
          // this menu's layer has its pointer events disabled anyway, and a focus wander into a Select
          // the panel opened must not read as leaving the menu.
          onInteractOutside={(event) => {
            if (settingsGroupRef.current) event.preventDefault()
            else if (event.target instanceof Element && event.target.closest("[data-agent-settings-menu]")) event.preventDefault()
          }}
          className={`profile-grid-menu ${menuZClass} ${OPAQUE_SURFACE_BASE} max-h-[min(360px,var(--radix-dropdown-menu-content-available-height))] max-w-[calc(100vw-1rem)] overflow-auto rounded-lg p-1.5 ${typography}`}
        >
          {groups.map((group) => (
            <RadixMenu.Group key={group.id}>
              {group.label && (
                <div className="profile-grid-header sticky left-0 flex items-baseline justify-between gap-4 px-1.5 pb-1 pt-1 first:pt-0.5">
                  <RadixMenu.Label className="flex items-baseline gap-1.5 text-left font-medium tracking-[0.07em] text-muted-55">
                    {group.label}
                    {group.experimental && <ExperimentalChip className="shrink-0" />}
                    {/* A signed-out provider's models were listed like any other's, and the first sign of
                        it was the sign-in at Send. In the heading's own line and its own small capitals,
                        at the regular weight, so the name stays the louder of the two. In ordinary case
                        the note stood taller than the name it annotates. */}
                    {group.signedOut && (
                      <span data-profile-grid-signed-out className="font-normal">
                        <span aria-hidden="true">· </span>Not signed in
                      </span>
                    )}
                  </RadixMenu.Label>
                  {agentSettings && (group.id === "claude" || group.id === "codex") && (
                    <AgentSettingsPopover
                      backend={group.id}
                      open={settingsGroup === group.id}
                      onOpenChange={(next) => setSettingsGroup(next ? group.id : null)}
                    />
                  )}
                </div>
              )}
              {group.layout === "dropdown" ? (
                <ProfileGridDropdownRow
                  group={group}
                  value={value}
                  typography={typography}
                  menuZClass={menuZClass}
                  onPick={(selection) => {
                    commitSelection(selection)
                    unregisterOpenRef.current?.()
                    closeFromRegistry()
                  }}
                />
              ) : (
              <RadixMenu.RadioGroup
                value={currentKey}
                // RadioGroup keeps keyboard selection semantic. Pointer activation also commits
                // from RadioItem's own select event below, before DropdownMenu tears this
                // controlled subtree down during dismissal.
                onValueChange={(key) => {
                  const selection = profileGridSelectionFromKey(groups, key)
                  if (selection) commitSelection(selection)
                }}
              >
                {group.options.map((option) => (
                  <div
                    key={option.model}
                    data-profile-grid-row={option.model}
                    // `w-max`, not `min-w-max`: a stretched row hands its leftover width to its own
                    // `auto` tracks, so a row shorter or narrower than the widest one slid every cell
                    // in it out of line with the rows above. Sized to its content, a row has no
                    // leftover to spread, and each column lands where its content puts it.
                    className="grid w-max items-center gap-1 py-0.5"
                    style={{ gridTemplateColumns: profileGridTemplateColumns(columns.length) }}
                  >
                    <span className={`profile-grid-model-label min-w-0 max-w-[9.5rem] truncate px-1.5 text-left text-muted ${typography}`} title={option.label}>
                      <ModelLabel label={option.label} edition={option.edition} />
                    </span>
                    {option.efforts.length === 0 && (() => {
                      // A row with NO effort axis — an ACP agent runs on whatever model and effort its
                      // own CLI is configured for — is one cell spanning every effort column, keyed
                      // on `effort: ""` (profileGridOptionEfforts). "Default" is the honest label:
                      // Frizz sets nothing, the agent's own defaults apply.
                      const selection = { provider: group.id, model: option.model, effort: "" }
                      const key = profileGridSelectionKey(selection)
                      return (
                        <RadixMenu.RadioItem
                          key="default"
                          value={key}
                          ref={(node) => {
                            if (node) cellRefs.current.set(key, node)
                            else cellRefs.current.delete(key)
                          }}
                          onKeyDown={(event) => handleCellKeyDown(event, selection)}
                          onSelect={(event) => {
                            event.preventDefault()
                            commitSelection(selection)
                            unregisterOpenRef.current?.()
                            closeFromRegistry()
                          }}
                          aria-label={`${option.label}, the agent's own defaults`}
                          title={`${option.label} › the agent's own model and effort`}
                          className={PROFILE_GRID_CELL_CLASS}
                          style={{ gridColumn: "2 / -1", justifySelf: "start" }}
                        >
                          <span className="grid">
                            <span aria-hidden="true" className="invisible col-start-1 row-start-1 font-medium">Default</span>
                            <span className="col-start-1 row-start-1">Default</span>
                          </span>
                        </RadixMenu.RadioItem>
                      )
                    })()}
                    {option.efforts.length > 0 && columns.map((column) => {
                      // A column can hold more than one effort name — "ultra" and "ultracode" share the
                      // ceiling — so take whichever name this model actually offers.
                      const effort = column.find((candidate) => option.efforts.includes(candidate))
                      // An unsupported cell still has to HOLD ITS COLUMN. Each row is its own grid, so a
                      // column that renders nothing here collapses and every cell to its right slides
                      // left, out of line with the rows above (already true of any codex row with fewer
                      // levels, and of Haiku, which cannot honour the ceiling). Ghosting the label keeps
                      // the column exactly as wide as it is everywhere else — and the widest name in it,
                      // since one column can hold two ("Ultra" beside "Ultracode").
                      const widest = column.reduce((a, b) => (effortLabel(b).length > effortLabel(a).length ? b : a))
                      if (!effort) {
                        return (
                          // Same box as a real cell (border + padding + type), just invisible — a
                          // ghost that is 2px narrower still drags the column out of true.
                          <span
                            key={widest}
                            aria-hidden="true"
                            className={`invisible cursor-default border border-transparent px-1 text-left font-medium ${typography}`}
                          >
                            {effortLabel(widest)}
                          </span>
                        )
                      }
                      const selection = { provider: group.id, model: option.model, effort }
                      const key = profileGridSelectionKey(selection)
                      return (
                        <RadixMenu.RadioItem
                          key={effort}
                          value={key}
                          ref={(node) => {
                            if (node) cellRefs.current.set(key, node)
                            else cellRefs.current.delete(key)
                          }}
                          onKeyDown={(event) => handleCellKeyDown(event, selection)}
                          onSelect={(event) => {
                            // Radix dismisses a DropdownMenu as part of selection. Commit this
                            // pointer path first and own the close, otherwise a controlled menu
                            // can close with its RadioGroup callback already unmounted.
                            event.preventDefault()
                            commitSelection(selection)
                            unregisterOpenRef.current?.()
                            closeFromRegistry()
                          }}
                          aria-label={`${option.label}, ${effortLabel(effort)} effort`}
                          title={`${option.label} › ${effortLabel(effort)}`}
                          className={PROFILE_GRID_CELL_CLASS}
                        >
                          <span className="grid">
                            {/* A checked cell sets its label in `font-medium`, which is 0.82px wider
                                here — enough to push every cell to its right along the moment the
                                selection moves, now that a cell is only as wide as its word. Stack an
                                invisible copy at the heavier weight in the same grid cell so the cell
                                always reserves its widest state and never resizes. */}
                            <span aria-hidden="true" className="invisible col-start-1 row-start-1 font-medium">{effortLabel(effort)}</span>
                            <span className="col-start-1 row-start-1">{effortLabel(effort)}</span>
                          </span>
                        </RadixMenu.RadioItem>
                      )
                    })}
                  </div>
                ))}
              </RadixMenu.RadioGroup>
              )}
              {group !== groups.at(-1) && <RadixMenu.Separator className="my-1 h-px bg-border" />}
            </RadixMenu.Group>
          ))}
          {selections.length === 0 && (
            <div className="px-2 py-1.5 text-muted-60">No profiles available</div>
          )}
          {upgrade && (
            <>
              <RadixMenu.Separator className="my-1 h-px bg-border" />
              {/* `w-0 min-w-full`: the effort grid sets the menu's width and this row fills it, wrapping its
                  sentence rather than widening the menu to fit it on one line. */}
              <div data-profile-grid-upgrade="" className="flex w-0 min-w-full items-center gap-2 px-1.5 py-0.5">
                {/* `text-balance`: the sentence wraps at the menu's width, and unbalanced it left one word
                    alone on its second line. */}
                <span className="min-w-0 flex-1 text-balance text-muted">
                  {upgrade.staged
                    ? `This thread will upgrade to ${unbroken(upgrade.latest)} on its next turn`
                    : `This thread will auto-upgrade to ${unbroken(upgrade.latest)} after its next compaction`}
                </span>
                {!upgrade.staged && (
                  <RadixMenu.Item
                    disabled={upgrade.blockedReason !== null || upgrade.pending}
                    onSelect={(event) => {
                      event.preventDefault()
                      upgrade.onUpgrade()
                      unregisterOpenRef.current?.()
                      closeFromRegistry()
                    }}
                    title={upgrade.blockedReason
                      ?? `Restart this thread's worker on ${upgrade.latest}. The conversation resumes from disk on the next turn; the prompt cache is re-read once.`}
                    className={`flex h-6 shrink-0 cursor-pointer select-none items-center rounded border border-border bg-transparent px-1.5 text-fg outline-none transition-colors data-[highlighted]:bg-panel-2 data-[highlighted]:outline data-[highlighted]:outline-1 data-[highlighted]:outline-offset-1 data-[highlighted]:outline-fg/55 data-[disabled]:cursor-not-allowed data-[disabled]:opacity-45 ${typography}`}
                  >
                    Upgrade now
                  </RadixMenu.Item>
                )}
              </div>
            </>
          )}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  )
}

// A DROPDOWN group's band in the menu (lib/profileGrid.ts `layout`): its model and its level as two
// dropdowns under the heading, where a grid group has a row per model. OpenCode is the one such group,
// with every model of every provider the person's OpenCode holds keys for, and per-model levels the
// grid's columns cannot hold (lib/opencodeProfile.ts).
//
// RADIX SUBMENUS, not the app's Select. A Select is a menu of its own, and inside this one it closed the
// moment the pointer left its trigger for its list: Radix focuses the outer menu's content when the pointer
// leaves an item, which a second menu reads as focus moving outside it (AgentSettingsPopover hit the same,
// for a popover). A submenu is part of this menu: the pointer's path to it is allowed for, the arrow keys
// reach it, and a pick commits and closes the whole menu exactly as a grid cell does.
function ProfileGridDropdownRow({ group, value, typography, menuZClass, onPick }: {
  group: ProfileGridGroup
  value?: Partial<ProfileGridSelection>
  typography: string
  menuZClass: string
  onPick: (selection: ProfileGridSelection) => void
}) {
  const chosen = value?.provider === group.id
  // The bare configured model shows as its own model's row (profileGridListedOptions).
  const listed = profileGridListedOptions(group)
  const shownModel = profileGridShownModel(group, chosen ? value?.model : group.options[0]?.model)
  const option = group.options.find((candidate) => candidate.model === shownModel) ?? listed[0]
  if (!option) return null
  const effort = chosen && option.efforts.includes(value?.effort ?? "") ? value?.effort ?? "" : ""
  const levels = option.efforts.length > 1 || option.efforts.some(Boolean)
  // The chosen group's two dropdowns wear the checked cell's look, so the band says it is what runs. Through
  // a `data-chosen` variant, as the cell's is through `data-[state=checked]`: a plain `border-accent/70` loses
  // to the cell's own `border-transparent` and `text-muted`, and drew a dim olive box with grey text.
  const chosenAttr = chosen ? { "data-chosen": "" } : {}
  const sections: { label: string; options: ProfileGridOption[] }[] = []
  for (const candidate of listed) {
    const label = candidate.section ?? ""
    const section = sections.find((entry) => entry.label === label) ?? sections[sections.push({ label, options: [] }) - 1]!
    section.options.push(candidate)
  }
  // A provider heading only sorts a list of several: with one provider it would repeat the band's own.
  const providerHeadings = sections.filter((section) => section.label).length > 1
  const subContent = `profile-grid-submenu ${menuZClass} ${OPAQUE_SURFACE_BASE} max-h-[min(320px,var(--radix-dropdown-menu-content-available-height))] min-w-[11rem] max-w-[min(20rem,calc(100vw-1rem))] overflow-y-auto rounded-lg p-1 ${typography}`
  const item = `relative flex w-full min-w-0 cursor-pointer select-none items-center gap-1.5 overflow-hidden rounded-md py-1 pl-2 pr-7 text-left text-muted outline-none data-[highlighted]:bg-panel-2 data-[highlighted]:text-fg data-[state=checked]:font-medium data-[state=checked]:text-fg ${typography}`
  const trigger = `profile-grid-dropdown ${PROFILE_GRID_CELL_CLASS} gap-[3px] data-[state=open]:border-border data-[state=open]:bg-panel-2 data-[state=open]:text-fg data-[chosen]:border-accent/70 data-[chosen]:bg-accent/10 data-[chosen]:font-medium data-[chosen]:text-fg data-[chosen]:ring-1 data-[chosen]:ring-inset data-[chosen]:ring-accent/90`
  const indicator = (
    <RadixMenu.ItemIndicator className="pointer-events-none absolute right-2 top-1/2 inline-flex -translate-y-1/2 items-center text-accent">
      <Check size={13} />
    </RadixMenu.ItemIndicator>
  )
  return (
    <div data-profile-grid-dropdowns={group.id} className="flex w-max max-w-full items-center gap-1 py-0.5">
      <RadixMenu.Sub onOpenChange={(open) => { if (open) group.onRequestOptions?.() }}>
        <RadixMenu.SubTrigger
          aria-label={`${group.label} model`}
          {...chosenAttr}
          title={option.label}
          className={`${trigger} max-w-[15rem]`}
        >
          <span className="min-w-0 truncate">{option.label}</span>
          <ChevronDown aria-hidden="true" size={12} className="shrink-0 text-fg/65" />
        </RadixMenu.SubTrigger>
        <RadixMenu.Portal>
          <RadixMenu.SubContent sideOffset={6} alignOffset={-4} collisionPadding={8} aria-label={`${group.label} models`} className={subContent}>
            <RadixMenu.RadioGroup value={option.model}>
              {sections.map((section, index) => (
                <RadixMenu.Group key={section.label || `s${index}`}>
                  {index > 0 && !providerHeadings && <RadixMenu.Separator className="mx-1 my-1 h-px bg-border" />}
                  {section.label && providerHeadings && (
                    <RadixMenu.Label className="truncate px-2 pb-0.5 pt-2 text-left font-medium tracking-[0.07em] text-muted-55">{section.label}</RadixMenu.Label>
                  )}
                  {section.options.map((candidate) => (
                    <RadixMenu.RadioItem
                      key={candidate.model}
                      value={candidate.model}
                      textValue={candidate.label}
                      title={candidate.model}
                      // Keeps the level when the new model offers it, else the model's own default.
                      onSelect={(event) => {
                        event.preventDefault()
                        onPick({ provider: group.id, model: candidate.model, effort: candidate.efforts.includes(effort) ? effort : "" })
                      }}
                      className={item}
                    >
                      <span className="min-w-0 truncate">{candidate.label}</span>
                      {indicator}
                    </RadixMenu.RadioItem>
                  ))}
                </RadixMenu.Group>
              ))}
            </RadixMenu.RadioGroup>
            {group.loading && <div className="flex items-center gap-1.5 px-2 py-1 text-muted-60"><Loader2 aria-hidden="true" size={11} className="animate-spin" />Loading models…</div>}
            {group.notice && <div className="w-0 min-w-full px-2 py-1 text-muted-60 [font-variant-caps:normal]">{group.notice}</div>}
          </RadixMenu.SubContent>
        </RadixMenu.Portal>
      </RadixMenu.Sub>
      {levels && (
        <RadixMenu.Sub>
          <RadixMenu.SubTrigger aria-label={`${group.label} reasoning level`} title="This model's reasoning level, in its own words" className={trigger} {...chosenAttr}>
            <span className="min-w-0 truncate">{profileGridEffortLabel(effort)}</span>
            <ChevronDown aria-hidden="true" size={12} className="shrink-0 text-fg/65" />
          </RadixMenu.SubTrigger>
          <RadixMenu.Portal>
            <RadixMenu.SubContent sideOffset={6} alignOffset={-4} collisionPadding={8} aria-label={`${group.label} reasoning levels`} className={subContent}>
              <RadixMenu.RadioGroup value={effort || "__default__"}>
                {option.efforts.map((level) => (
                  <RadixMenu.RadioItem
                    key={level || "__default__"}
                    value={level || "__default__"}
                    onSelect={(event) => {
                      event.preventDefault()
                      onPick({ provider: group.id, model: option.model, effort: level })
                    }}
                    className={item}
                  >
                    <span className="min-w-0 truncate">{profileGridEffortLabel(level)}</span>
                    {indicator}
                  </RadixMenu.RadioItem>
                ))}
              </RadixMenu.RadioGroup>
            </RadixMenu.SubContent>
          </RadixMenu.Portal>
        </RadixMenu.Sub>
      )}
    </div>
  )
}
