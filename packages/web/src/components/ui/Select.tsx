import * as RadixMenu from "@radix-ui/react-dropdown-menu"
import { Check, ChevronDown } from "lucide-react"
import { useLayoutEffect, useRef, useState } from "react"
import { selectDisplayValue, selectRowPadding } from "../../lib/selectLayout.ts"
import { registerOpenSelect } from "../../lib/selectOverlay.ts"
import { OPAQUE_PORTAL_SURFACE_CLASS } from "../../lib/overlaySurface.ts"
import { PROMPT_CONTROL_TYPOGRAPHY_CLASS } from "../../lib/promptControlTypography.ts"

export interface SelectOption {
  value: string
  label: string
  title?: string
}

// A titled band of options in the dropdown (Codex-support epic, Phase 3: the model picker's
// "Claude Code" / "Codex" sections). A group with an EMPTY label renders its items with no header —
// used for a leading ungrouped row (e.g. the settings "Default" model). Pass `groups` OR `options`.
export interface SelectGroup {
  label: string
  options: SelectOption[]
}

// A small, elegant select. Borderless until hover (Linear/Cursor-flavored), no focus ring; the
// popover has proper padding, rounding, and a soft shadow. Used for the quiet
// permission/model/effort rows and settings. The menu primitive stays non-modal so opening an
// inline picker never scroll-locks <body> and breaks the app shell's sticky sidebar.
// DropdownMenu RadioItem, like Radix Select, reserves the empty string internally. Map it to a
// private printable sentinel on the way in and back out.
const EMPTY = "__frizz_empty_select_value__"
const toRadix = (v: string) => (v === "" ? EMPTY : v)
const fromRadix = (v: string) => (v === EMPTY ? "" : v)

// `ghost` (default): borderless until hover — the quiet inline row under the new-thread composer.
// `bordered`: a full-width control with a resting border+bg, for stacked settings rows. In BOTH
// variants the border + bg + padding + hover-bg all live on the Trigger itself (one element), so the
// hover highlight covers the full hit area edge-to-edge — never an inset box painted inside a
// separate wrapper's border (the bug that came from wrapping this in a bordered <div> at the call
// site; call sites must NOT add their own border/bg wrapper).
const TRIGGER_VARIANT = {
  ghost:
    "border-transparent bg-transparent hover:border-border hover:bg-panel-2 data-[state=open]:border-border data-[state=open]:bg-panel-2",
  bordered:
    "w-full justify-between border-control-border bg-bg hover:bg-panel-2 data-[state=open]:bg-panel-2",
  // A plain VALUE READOUT that must still read as INTERACTIVE: quiet muted text carrying a resting
  // hairline pill (border-border/50) + a stronger caret, so it registers as a dropdown at a glance
  // rather than a static label. The pill fills + brightens on hover/open; the caret sits at ~fg/65 so
  // the chevron is legible, not a ghost.
  readout:
    "text-muted hover:text-fg border-border/50 bg-transparent hover:border-border hover:bg-panel-2 data-[state=open]:border-border data-[state=open]:bg-panel-2 [&_.select-caret]:text-fg/65 [&_.select-caret]:opacity-100",
} as const

// Disabled readouts must stay visually inert: preserve their resting treatment but deliberately
// omit hover utilities and transitions so a disabled model/permission control never advertises a
// click target through color or surface motion.
const DISABLED_TRIGGER_VARIANT = {
  ghost: "border-transparent bg-transparent",
  bordered: "w-full justify-between border-border bg-bg",
  readout: "text-muted border-border/50 bg-transparent [&_.select-caret]:text-fg/65 [&_.select-caret]:opacity-100",
} as const

// One dropdown row — factored out so the flat and grouped render paths stay identical.
function SelectItem({ o, indicatorPosition, typography }: { o: SelectOption; indicatorPosition: "left" | "right"; typography?: string }) {
  return (
    <RadixMenu.RadioItem
      value={toRadix(o.value)}
      title={o.title}
      className={`relative flex w-full min-w-0 cursor-pointer select-none items-center overflow-hidden rounded-md py-1.5 text-left text-[12px] text-muted outline-none data-[highlighted]:bg-panel-2 data-[highlighted]:text-fg data-[state=checked]:bg-panel-2 data-[state=checked]:font-medium data-[state=checked]:text-fg ${selectRowPadding(indicatorPosition)} ${typography ?? ""}`}
    >
      <RadixMenu.ItemIndicator className={`pointer-events-none absolute top-1/2 inline-flex -translate-y-1/2 items-center text-accent ${indicatorPosition === "right" ? "right-2" : "left-2"}`}>
        <Check size={13} />
      </RadixMenu.ItemIndicator>
      <span className="min-w-0 flex-1 truncate text-left">
        {o.label}
      </span>
    </RadixMenu.RadioItem>
  )
}

export function Select({
  value,
  onValueChange,
  options,
  groups,
  placeholder,
  ariaLabel,
  title,
  disabled = false,
  variant = "ghost",
  indicatorPosition = "left",
  side = "bottom",
  className = "",
}: {
  value: string
  onValueChange: (v: string) => void
  // Provide EITHER a flat `options` list OR sectioned `groups` (Codex-support Phase 3). `groups`
  // wins when both are passed.
  options?: SelectOption[]
  groups?: SelectGroup[]
  placeholder?: string
  ariaLabel?: string
  title?: string
  disabled?: boolean
  variant?: keyof typeof TRIGGER_VARIANT
  indicatorPosition?: "left" | "right"
  side?: "top" | "bottom"
  className?: string
}) {
  const display = selectDisplayValue(value, options, groups, placeholder)
  const triggerVariant = disabled ? DISABLED_TRIGGER_VARIANT[variant] : TRIGGER_VARIANT[variant]
  // Inline prompt readouts must stay on the same readable 12px/16px scale in both the trigger and
  // their portaled rows. Compact layouts only change density around this selector, never its type.
  const promptReadoutTypography = variant === "readout" ? PROMPT_CONTROL_TYPOGRAPHY_CLASS : ""
  const [open, setOpen] = useState(false)
  const openRef = useRef(open)
  const disabledRef = useRef(disabled)
  const unregisterOpenRef = useRef<(() => void) | undefined>(undefined)
  openRef.current = open
  disabledRef.current = disabled

  // Dialog and Select each install a document-capture Escape listener. stopPropagation inside the
  // Select callback is too late to keep an independently mounted parent dialog listener from seeing
  // the same key. While this Select is open, claim Escape one level earlier (window capture), close
  // the controlled Select, and leave the event unavailable to every parent overlay/global shortcut.
  useLayoutEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !openRef.current || disabledRef.current) return
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
      openRef.current = false
      unregisterOpenRef.current?.()
      unregisterOpenRef.current = undefined
      setOpen(false)
    }
    window.addEventListener("keydown", onKeyDown, { capture: true })
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true })
  }, [])

  useLayoutEffect(() => {
    if (!disabled || !open) return
    openRef.current = false
    unregisterOpenRef.current?.()
    unregisterOpenRef.current = undefined
    setOpen(false)
  }, [disabled, open])

  useLayoutEffect(() => () => unregisterOpenRef.current?.(), [])

  return (
    <RadixMenu.Root
      modal={false}
      open={open}
      onOpenChange={(next) => {
        unregisterOpenRef.current?.()
        unregisterOpenRef.current = undefined
        openRef.current = next
        setOpen(next)
        if (next) {
          unregisterOpenRef.current = registerOpenSelect(() => {
            openRef.current = false
            unregisterOpenRef.current = undefined
            setOpen(false)
          })
        }
      }}
    >
      <RadixMenu.Trigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label={ariaLabel}
          title={title}
          className={`group inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md border px-2 py-1 text-left text-[12px] text-fg outline-none data-[placeholder]:text-muted ${disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer transition-colors"} ${triggerVariant} ${variant === "readout" ? "select-trigger-readout" : ""} ${promptReadoutTypography} ${className}`}
        >
          <span className={`min-w-0 flex-1 truncate text-left ${display.placeholder ? "text-muted" : ""}`}>
            {display.text}
          </span>
          <ChevronDown className={`select-caret shrink-0 text-muted ${disabled ? "" : "transition-transform group-data-[state=open]:rotate-180"}`} size={13} />
        </button>
      </RadixMenu.Trigger>
      <RadixMenu.Portal>
        <RadixMenu.Content
          align="start"
          side={side}
          sideOffset={5}
          // Select is often nested in a drawer/dialog. Radix dismisses the highest layer after this
          // callback; stop the same native Escape from continuing to Frizz's window-level drawer
          // handler, which would otherwise close both layers in one keypress.
          onEscapeKeyDown={(event) => event.stopPropagation()}
          className={`${OPAQUE_PORTAL_SURFACE_CLASS} min-w-[var(--radix-dropdown-menu-trigger-width)] max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg p-1 ${promptReadoutTypography}`}
        >
          <RadixMenu.RadioGroup value={toRadix(value)} onValueChange={(v) => onValueChange(fromRadix(v))} className="max-h-[300px] min-w-0 overflow-y-auto">
            {groups
              ? groups.map((g, gi) => (
                  <RadixMenu.Group key={g.label || `g${gi}`}>
                    {g.label && (
                      <RadixMenu.Label className={`${selectRowPadding(indicatorPosition)} min-w-0 truncate pb-1 pt-2 text-left text-[10px] font-medium uppercase tracking-wide text-muted-60 first:pt-1`}>
                        {g.label}
                      </RadixMenu.Label>
                    )}
                    {g.options.map((o) => (
                      <SelectItem key={o.value} o={o} indicatorPosition={indicatorPosition} typography={promptReadoutTypography} />
                    ))}
                  </RadixMenu.Group>
                ))
              : (options ?? []).map((o) => <SelectItem key={o.value} o={o} indicatorPosition={indicatorPosition} typography={promptReadoutTypography} />)}
          </RadixMenu.RadioGroup>
        </RadixMenu.Content>
      </RadixMenu.Portal>
    </RadixMenu.Root>
  )
}
