import { createElement, type MouseEvent, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"

type ToolDisclosureHeaderProps = {
  children: ReactNode
  className: string
  controls: string
  expanded: boolean
  label: string
  meta?: ReactNode
  onToggle: () => void
  chevronSize?: number
}

// Anything in the header that owns its OWN click — a file deep-link, the sub-agent drill-in, the
// chevron itself, plus whatever a future header adds. `closest` rather than an identity check so a
// click that lands on a glyph or a truncating span INSIDE one of those still belongs to it.
const HEADER_ACTION_SELECTOR = 'a, button, input, select, textarea, summary, label, [role="button"], [role="link"]'

// True when a header click landed on one of those. Duck-typed on `closest` instead of `instanceof
// Element` so the predicate is exercisable under the workspace's Nub-backed node:test runner, which
// has no DOM. Exported for that reason.
export function isToolDisclosureAction(target: unknown): boolean {
  const element = target as { closest?: (selectors: string) => unknown } | null | undefined
  return typeof element?.closest === "function" && element.closest(HEADER_ACTION_SELECTOR) != null
}

// Tool headers sometimes contain an action of their own (open a file or drill into a sub-agent).
// Keep that action and the disclosure control as SIBLINGS: nesting either one inside the other makes
// the browser repair the markup inconsistently and gives keyboard/screen-reader users two actions
// with one ambiguous focus target. Kept JSX-free so the real rendered markup can be exercised by the
// workspace's Nub-backed node:test runner.
//
// THE WHOLE ROW TOGGLES (maintainer 2026-07-31). A 12px chevron at the far edge was the only way to
// open a Read / Agent / Edit card, while its Bash / Todo / Sent siblings — one big `<button>`, because
// they hold no link — opened anywhere. Same card family, two different targets. The row now carries a
// plain `onClick` that toggles, and the sibling structure above is exactly what makes that safe: the
// link and the drill-in are real elements this handler can recognise and stand down for, rather than
// nested-interactive markup the browser would have to guess at. The disclosure BUTTON stays the
// keyboard/AT control (it alone carries `aria-expanded`/`aria-controls`); the row click is a pointer
// affordance layered over it, so the div takes no role and no tab stop and AT still sees one action.
// Header only, never the body — an expanded body holds diffs, output and code the reader needs to
// select and scroll, and collapsing that out from under a stray click would be hostile.
export function ToolDisclosureHeader({
  children,
  className,
  controls,
  expanded,
  label,
  meta,
  onToggle,
  chevronSize = 12,
}: ToolDisclosureHeaderProps) {
  function onHeaderClick(event: MouseEvent<HTMLDivElement>) {
    // The link / drill-in / chevron each handle themselves. Standing down here also keeps the
    // chevron from toggling twice, since its click bubbles up through this same handler.
    if (isToolDisclosureAction(event.target)) return
    // A drag that selected header text — a path worth copying — ends in a click too. Toggling then
    // would wipe the selection the reader just made.
    const selection = typeof window === "undefined" ? null : window.getSelection()
    if (selection && !selection.isCollapsed && selection.toString().trim() !== "") return
    onToggle()
  }
  return createElement(
    "div",
    { className: `${className} w-full cursor-pointer text-left`, "data-expanded": expanded, onClick: onHeaderClick },
    createElement("span", { className: "flex min-w-0 items-center gap-2" }, children),
    createElement(
      "span",
      { className: "flex shrink-0 items-center gap-1.5" },
      meta,
      createElement(
        "button",
        {
          type: "button",
          "data-tool-disclosure": true,
          "aria-controls": controls,
          "aria-expanded": expanded,
          "aria-label": label,
          title: label,
          onClick: onToggle,
          className:
            "-m-1 inline-flex shrink-0 items-center justify-center rounded p-1 text-muted outline-none transition-colors hover:text-fg/80 focus-visible:ring-1 focus-visible:ring-focus-ink-60",
        },
        createElement(ChevronRight, {
          "aria-hidden": true,
          size: chevronSize,
          // Lucide's right-chevron sits a fraction low in its viewbox. A tiny optical lift makes
          // its visual center agree with the petite-caps running state beside it.
          className: `relative -top-px shrink-0 transition-transform ${expanded ? "rotate-90" : ""}`,
        }),
      ),
    ),
  )
}
