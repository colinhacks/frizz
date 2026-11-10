// WHERE THE FOCUS GOES WHEN A FULL-SCREEN SURFACE CLOSES (ui/ModalSurface: Settings, ⌘K, the phone's
// answer sheet).
//
// Until 2026-11-10 it went nowhere. Radix returns the focus to a dialog's `Trigger`, these surfaces
// have none (a store flag opens them), and the surface refused Radix's fallback, so closing one left
// `document.activeElement` on `<body>`. Measured: focus on the Settings button, ⌘K, Escape, and the
// next Tab started again from the first link in the rail, 45 stops before the first card.
//
// So the surface remembers what held the focus when it opened, and hands it back. Three cases keep that
// from being a plain `opener.focus()`:
//
//   · ONE SURFACE OPENS ANOTHER. ⌘K's "Settings" closes the palette as Settings opens, so what held the
//     focus when Settings opened is the palette's input, gone by the time Settings closes. Each surface
//     therefore carries the CHAIN: its own opener, then the opener of the surface that one sat in. The
//     first still on the page gets the focus back: the button the palette was opened from.
//   · THE CLOSE WAS NOT A DISMISSAL. ⌘K picks a thread and its drawer takes the focus: whatever holds
//     the focus when the surface has gone keeps it. And where nothing takes it (a thread opened in the
//     board's pane), the surface itself says so with `returnsFocus`, and the focus stays on the page.
//   · NOTHING HELD IT. Safari and Firefox on macOS do not focus a button on a click, so the opener can
//     be `<body>`, and then there is nothing to return to.

/** What a surface needs to know of an element it might hand the focus back to. */
export type FocusHolder = { readonly isConnected: boolean }

/**
 * The element to focus when a surface closes, or null to leave the focus alone. `chain` is the
 * surface's opener first, then each enclosing surface's; `active` is what holds the focus now.
 */
export function focusToRestore<T extends FocusHolder>(chain: readonly (T | null)[], active: unknown, body: unknown): T | null {
  if (active && active !== body) return null
  return chain.find((holder): holder is T => !!holder && holder !== body && holder.isConnected) ?? null
}

// Each open surface's chain, by its root element, so a surface opened from inside another can find the
// chain to extend. Weak: a closed surface's entry goes with its element.
const chains = new WeakMap<Element, readonly (Element | null)[]>()

/**
 * The chain for a surface opening now: what holds the focus, then the chain of the surface it is in
 * (a surface's root carries `data-modal-surface`).
 */
export function openerChain(): readonly (Element | null)[] {
  if (typeof document === "undefined") return []
  const opener = document.activeElement
  const host = opener?.closest("[data-modal-surface]")
  return [opener, ...((host && chains.get(host)) ?? [])]
}

/** Files an open surface's chain under its root element. */
export function rememberChain(surface: Element, chain: readonly (Element | null)[]): void {
  chains.set(surface, chain)
}
