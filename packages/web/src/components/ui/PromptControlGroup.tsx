import { createContext, useContext, type ReactNode } from "react"
import { useIsMobile } from "../../lib/mobile.ts"

// THE PROMPT BOX'S DROPDOWNS, DRAWN AS ONE PILL (maintainer 2026-11-06: "The joint pill is good, and I like
// the no chevrons"). The model and the permission mode stood as two bordered pills with a chevron each, 178px
// together on a line the sidebar floors at 272px. Joined they read 130px.
//
// The group owns the shape: the height, the hairline, the corners and the divider. A dropdown inside one (the
// model pill in ProfileGridSelector, a `readout` Select) sees this context and drops its own border, padding
// and chevron, so a call site places the group and passes its controls nothing. Each cell still lights up on
// its own, and `overflow-hidden` clips that fill to the group's corners. Their menus are portaled, so nothing
// they open is clipped.
//
// On a phone there is no group: the model chip there is its own 32px shape (MobileModelSheet.tsx), and a
// control the phone draws in its tool row keeps its own border and chevron.

const InPromptControlGroup = createContext(false)

/**
 * True inside a group. React context crosses a portal, so a control in a menu one of these cells opened reads
 * true as well: that is why Select reads it for `readout` alone, the agent-settings panel's being `bordered`.
 */
export function usePromptControlCell(): boolean {
  return useContext(InPromptControlGroup)
}

/**
 * A cell's box. `items-stretch` on the group gives it the height, 20px inside the hairlines of 22. The right
 * side is half a pixel short of the left because petite caps carry their 0.54px of tracking after the last letter.
 */
export const PROMPT_CONTROL_CELL = "pl-1.5 pr-[5.5px]"

export function PromptControlGroup({ children }: { children: ReactNode }) {
  const phone = useIsMobile()
  if (phone) return <>{children}</>
  return (
    <InPromptControlGroup.Provider value>
      <div
        data-prompt-control-group=""
        className="inline-flex h-[22px] min-w-0 max-w-full items-stretch overflow-hidden rounded-md border border-border/50 [&>button+button]:border-l [&>button+button]:border-border/50"
      >
        {children}
      </div>
    </InPromptControlGroup.Provider>
  )
}
