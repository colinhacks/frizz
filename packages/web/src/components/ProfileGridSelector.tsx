import * as RadixMenu from "@radix-ui/react-dropdown-menu"
import { ChevronDown, Loader2 } from "lucide-react"
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import {
  moveProfileGridSelection,
  PROFILE_GRID_CELL_CLASS,
  PROFILE_GRID_COMPACT_TYPOGRAPHY_CLASS,
  PROFILE_GRID_TYPOGRAPHY_CLASS,
  profileGridColumns,
  profileGridDisplayLabel,
  profileGridSelectionFromKey,
  profileGridSelectionKey,
  profileGridSelectionKnown,
  profileGridTemplateColumns,
  type ProfileGridGroup,
  type ProfileGridMoveKey,
  type ProfileGridSelection,
  profileGridSelections,
} from "../lib/profileGrid.ts"
import { registerOpenSelect } from "../lib/selectOverlay.ts"
import { OPAQUE_PORTAL_SURFACE_Z, OPAQUE_SURFACE_BASE } from "../lib/overlaySurface.ts"
import { ContextWindowControl } from "./ContextWindowControl.tsx"

function effortLabel(effort: string): string {
  if (effort === "xhigh") return "X-high"
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

export function ProfileGridSelector({
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
  contextWindows = false,
}: {
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
  // Project defaults for NEW workers, never a promise to resize a running thread's context.
  contextWindows?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [contextGroup, setContextGroup] = useState<string | null>(null)
  const contextGroupRef = useRef(contextGroup)
  contextGroupRef.current = contextGroup
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
    : "cursor-pointer transition-colors hover:border-border hover:bg-panel-2 hover:text-fg"
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
    setContextGroup(null)
    openRef.current = false
    unregisterOpenRef.current = undefined
    setOpen(false)
  }

  function dismissTopLayer() {
    if (contextGroupRef.current) {
      contextGroupRef.current = null
      setContextGroup(null)
      unregisterOpenRef.current = registerOpenSelect(dismissTopLayer)
    } else closeFromRegistry()
  }

  useLayoutEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || !openRef.current || disabledRef.current) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
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

  function commitSelection(selection: ProfileGridSelection) {
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
        else setContextGroup(null)
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
          className={`profile-grid-trigger group inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border border-border/50 bg-transparent px-2 py-1 text-left text-muted outline-none data-[state=open]:border-border data-[state=open]:bg-panel-2 ${triggerInteraction} ${className} ${typography}`}
        >
          <span className={`profile-grid-value relative -top-px min-w-0 flex-1 truncate text-left ${typography}`}>
            {profileGridDisplayLabel(groups, value, placeholder)}
          </span>
          {pendingLabel && <Loader2 aria-hidden="true" size={compact ? 10 : 11} className="shrink-0 animate-spin text-muted-65" />}
          <ChevronDown aria-hidden="true" size={compact ? 11 : 13} className="shrink-0 text-fg/65 transition-transform group-data-[state=open]:rotate-180" />
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
          onInteractOutside={(event) => {
            if (event.target instanceof Element && event.target.closest("[data-context-window-menu]")) event.preventDefault()
          }}
          className={`profile-grid-menu ${menuZClass} ${OPAQUE_SURFACE_BASE} max-h-[min(360px,var(--radix-dropdown-menu-content-available-height))] max-w-[calc(100vw-1rem)] overflow-auto rounded-lg p-1.5 ${typography}`}
        >
          {groups.map((group) => (
            <RadixMenu.Group key={group.id}>
              {group.label && (
                <div className="profile-grid-header sticky left-0 flex items-baseline justify-between gap-4 px-1.5 pb-1 pt-1 first:pt-0.5">
                  <RadixMenu.Label className="text-left font-medium tracking-[0.07em] text-muted-55">
                    {group.label}
                  </RadixMenu.Label>
                  {contextWindows && (group.id === "claude" || group.id === "codex") && (
                    <ContextWindowControl
                      backend={group.id}
                      open={contextGroup === group.id}
                      onOpenChange={(next) => setContextGroup(next ? group.id : null)}
                    />
                  )}
                </div>
              )}
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
                      {option.label}
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
              {group !== groups.at(-1) && <RadixMenu.Separator className="my-1 h-px bg-border" />}
            </RadixMenu.Group>
          ))}
          {selections.length === 0 && (
            <div className="px-2 py-1.5 text-muted-60">No profiles available</div>
          )}
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  )
}
