import { Z_POPOVER, Z_SELECT, Z_SELECT_IN_POPOVER } from "./layers.ts"

// The opaque overlay surface WITHOUT a z-index. Portal menus/popovers must be an opaque layer from
// their first painted frame — the older `pop-in` animation starts at opacity: 0, which makes a
// just-opened menu look transparent over the sidebar/composer. This base owns everything BUT the
// stacking level, so a caller applies EXACTLY ONE z utility on top (never two conflicting z-* classes
// on one element — Tailwind resolves same-property collisions by CSS source order, not class order,
// so stacking z-[110] and z-[250] would be a coin-flip). Motion-free (no pop-in) by contract.
export const OPAQUE_SURFACE_BASE =
  "isolate bg-elevated opacity-100 border border-border shadow-2xl shadow-overlay-shadow"

// The z-indexes below are NAMES for layers of lib/layers.ts, the one stacking order, where each
// layer's reason lives; this file only says which surface takes which. Never re-elevate a persistent
// layer to "win" a collision — raise the specific overlay instead, in layers.ts.

// The selector-surface contract for Select, DropdownMenu, and the profile grid: the opaque base at the
// select layer. Portal content mounts at document.body, so it must clear the modal surfaces it can be
// opened from (a selector inside Settings or a drawer) rather than paint beneath them.
export const OPAQUE_PORTAL_SURFACE_Z = Z_SELECT
export const OPAQUE_PORTAL_SURFACE_CLASS = `${OPAQUE_PORTAL_SURFACE_Z} ${OPAQUE_SURFACE_BASE}`

// The stacking level a selector must take when it is opened from INSIDE a dialog (the GitHub picker's
// Overlay). Its portal still mounts at document.body, so the select layer would paint the menu BENEATH
// that overlay's frosted backdrop — the classic "hidden underneath" bug. It borrows the popover layer,
// which is defined to clear every dialog.
export const OPAQUE_PORTAL_SURFACE_ABOVE_DIALOG_Z = Z_POPOVER

// The stacking level a selector takes when it is opened from INSIDE an anchored popover (the model
// picker's agent-settings panel carries three Selects). At the popover's own layer it would resolve by
// source order against the panel it was opened from — a coin flip that lands the menu beneath its own
// trigger. One step above, and still below toasts and the restart scrim.
export const OPAQUE_PORTAL_SURFACE_ABOVE_POPOVER_Z = Z_SELECT_IN_POPOVER

// The z-index for ANCHORED transient overlays that pop off a trigger — tooltips and popovers. They
// must clear every surface they can be opened from, dialogs included. This is also the fix for the
// quota popover that used to render at z-50 and got clipped away "underneath the prompt box".
export const OVERLAY_Z_CLASS = Z_POPOVER
