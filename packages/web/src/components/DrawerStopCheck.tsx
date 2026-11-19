import { Check, Loader2 } from "lucide-react"
import { HEADER_ICON_CLASS } from "../lib/headerIcon.ts"
import { Tooltip } from "./Tooltip.tsx"

// THE STOP VERB OF A CHILD'S DRAWER — a sub-agent's (SubAgentSheet) or a background shell's
// (BackgroundShellSheet) — as the check at the far right of its header: the thread header's Mark as
// done, same glyph, same square, same slot (ThreadLifecycle StateButton `iconOnly`), doing what Done
// does to a live thread's run. Both drawers carried it as a labelled "Stop …" button in a lifecycle
// footer of its own until 2026-10-14, the one agent panel whose verb was at the bottom (maintainer:
// "why is the Stop Subagent button at the bottom instead of there being another checkmark icon in the
// upper right, as with the other agent panels?"). No confirmation, like the × that stops a running
// child row in one click; a spinner holds the slot while the daemon confirms the stop.
export function DrawerStopCheck({
  label,
  stopping,
  onStop,
  ...data
}: {
  label: string
  stopping: boolean
  onStop: () => void
} & { [attribute: `data-${string}`]: string | undefined }) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        {...data}
        aria-label={label}
        disabled={stopping}
        onClick={onStop}
        onMouseDown={(event) => event.preventDefault()}
        // On a touch screen the 28px square keeps its place on the bar and takes a 44px hit area: the one
        // control on a phone's sheet that ends a run, it was the smallest target on it.
        className={`${HEADER_ICON_CLASS} relative pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:[&>svg]:size-[18px]`}
      >
        {stopping ? <Loader2 size={14} className="animate-spin" /> : <Check size={15} strokeWidth={2} />}
      </button>
    </Tooltip>
  )
}
