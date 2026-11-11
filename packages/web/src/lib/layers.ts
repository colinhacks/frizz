// THE STACKING ORDER — every layer that sits above the page, low → high, and the ONLY file in the app
// where a z-index above 20 is written. `layers.guard.test.ts` holds the rest of the app to four rules:
//
//   1. A z-index above 20 is a LAYER, and every layer is named here. Anywhere else a `z-*` utility or a
//      `zIndex` only orders things INSIDE one surface (a sticky card header over its own rows, a raised
//      row while it is dragged): 0 to 20, never more.
//   2. Anything that hangs off a trigger and can leave the trigger's box — a menu, a popover, a panel,
//      a typeahead — is PORTALED to <body>: Radix's own Portal, or ui/AnchoredLayer for a panel placed by
//      hand. Left in the tree, its z ranks only inside the nearest stacking context, and this app is full
//      of them: both sidebars are `position: sticky`, which is a stacking context with no z-index at all,
//      a card's footer is sticky z-10, a drawer is translated. The update popover hung off the sidebar at
//      z-50 and still went under the queue cards' z-10 headers that way (2026-10-30).
//   3. A layer's place is decided by what it must COVER, written next to it below, and the order test
//      pins every one of those relations, so moving a number that breaks one fails rather than ships.
//   4. A z-index orders PAINT, and only paint. Every thread drawer is a Radix dialog (a modal one on the
//      phone), and Radix keeps its own stack of layers that decides who gets Escape, the pointer and the
//      focus. So a full-screen layer is a member of that stack too — a Radix dialog, or ui/ModalSurface
//      for one the app draws itself — and nothing else portals to <body> by hand.
//
// The bugs each rule answers, all found on 2026-11-01: a toast fired from inside the sign-in modal (or a
// phone sheet, or the model sheet) was painted under it, so its Retry looked like it did nothing; the
// project rail sat at z-[60] and stayed lit and clickable through the Settings modal's z-50 scrim;
// Settings opened from ⌘K over a thread drawer slid in UNDER the drawer (Settings z-50, the drawer z-51);
// a drawer's z was `50 + 2 × depth` with no ceiling, so a sixth stacked drawer would outrank the ⌘K
// palette and an eleventh every toast; the composer's skills menu went under a drawer's "Jump to latest"
// pill; and, the rule-4 kind, Escape with ⌘K or Settings open over a drawer closed the DRAWER and left
// the overlay up, and on the phone ⌘K over a drawer took no tap and no keystroke. There were also five
// tiers nobody had written down (30, 40, 80, 210, 220).
//
// Tailwind only generates a class it finds spelled out in source, so each layer is a literal class
// string as well as a number; the order test checks the two agree.

export const LAYER = {
  /** Persistent fixed chrome: the project rail, the phone board's header and its
   *  new-thread button. Above the page's own sticky headers (≤ 20), under every drawer, modal and scrim
   *  — a modal's scrim has to cover it. The rail sat at 60 and punched through the Settings scrim. */
  chrome: 30,
  /** The drawer band's floor: thread, sub-agent and document sheets (DrawerStack). A layer takes
   *  `drawerZ(depth)`, two steps per layer (its scrim, then its panel), and the band is CLOSED: no depth
   *  climbs past `drawerCeiling`, into the modal layer above it. */
  drawer: 50,
  drawerCeiling: 99,
  /** App-level modal surfaces: Settings (the desktop sheet and the phone page), the new-thread modal, the
   *  phone's bottom sheets and answer sheet. Above every drawer, since each can open while drawers are
   *  up (Settings from ⌘K, a phone sheet from inside a thread drawer). */
  modal: 100,
  /** ⌘K, which opens over anything at or below `modal`. */
  palette: 105,
  /** Portaled selector surfaces: Select, the shared Menu, the project crumb's and chip's menus, the rail's
   *  and the grid's project menus, the send split's menu. Above every surface they open from up to here
   *  — a Select in Settings, a menu in a drawer. */
  select: 110,
  /** Centered dialogs: the shared Dialog, the lightbox, the GitHub picker, the add-project dialog. */
  dialog: 200,
  /** A dialog opened from INSIDE a dialog: sign-in, raised from the new-thread modal or the GitHub picker. */
  dialogOverDialog: 210,
  /** Anchored transients that pop off a trigger — popovers, tooltips, ui/AnchoredLayer panels — and a
   *  selector or sheet opened from inside a dialog (the phone's model sheet sits in a GitHub picker row).
   *  They clear every surface they can be opened from, dialogs included. */
  popover: 250,
  /** A selector opened from INSIDE an anchored popover (the agent-settings panel's Selects). */
  selectInPopover: 260,
  /** Toasts. A notification has to be readable whatever is open, so it outranks every modal, dialog and
   *  popover; a toast under the sign-in modal's scrim made Retry look dead. */
  toast: 280,
  /** The restart scrim, which alone must cover the whole app while Frizz restarts. */
  restart: 300,
} as const

export const Z_CHROME = "z-30"
export const Z_MODAL = "z-[100]"
export const Z_PALETTE = "z-[105]"
export const Z_SELECT = "z-[110]"
export const Z_DIALOG = "z-[200]"
export const Z_DIALOG_OVER_DIALOG = "z-[210]"
export const Z_POPOVER = "z-[250]"
export const Z_SELECT_IN_POPOVER = "z-[260]"
export const Z_TOAST = "z-[280]"
export const Z_RESTART = "z-[300]"

/** The deepest drawer that still gets a step of its own; deeper layers share the ceiling. */
export const DRAWER_DEPTH_CEILING = (LAYER.drawerCeiling - 1 - LAYER.drawer) / 2

/**
 * A drawer layer's two z-indexes: its scrim, then its panel one above it. Strictly increasing with
 * `depth` (the layer's index in the stack, closing layers included) up to DRAWER_DEPTH_CEILING, which is
 * 24 layers deeper than anyone has stacked; past it every layer shares the top step, so a runaway stack
 * can only mis-order its own drawers, never climb over Settings, ⌘K or a toast.
 */
export function drawerZ(depth: number): { scrim: number; panel: number } {
  const step = Math.min(Math.max(0, Math.floor(depth)), DRAWER_DEPTH_CEILING)
  const scrim = LAYER.drawer + step * 2
  return { scrim, panel: scrim + 1 }
}
