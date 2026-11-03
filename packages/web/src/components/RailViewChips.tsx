import * as RadixDropdown from "@radix-ui/react-dropdown-menu"
import type { ReactNode } from "react"
import { useSnapshot } from "valtio"
import { ArrowDownNarrowWide, ArrowDownWideNarrow, Check, ChevronDown, Folders, Rows3 } from "lucide-react"
import type { QueueDirection } from "../groups.ts"
import { prefs } from "../lib/prefs.ts"
import { setConsoleGroup, type ConsoleGroup } from "../lib/consoleBoard.ts"
import { OPAQUE_PORTAL_SURFACE_CLASS } from "../lib/overlaySurface.ts"

// THE SIDEBAR'S VIEW CHIPS — how the list under the prompt box is arranged, as one short row of chips at
// the top of the rail, above every band: the queue's order on every board, and on the Console the
// grouping in front of it. Each chip names its current choice and opens a menu of the others.
//
// Both used to live elsewhere. The order was a Settings field (maintainer 2026-11-03: "I don't care
// about this, so we should just move the queue ordering to be an icon"), and the Console's grouping a
// full-width "By status" | "By project" segmented control. Of six mockups that joined the two
// (queue-controls-mockup-fixture.tsx) the maintainer chose these chips, with one change: "it's weird to
// me that the chips are so far to the left. They're aligned with the prompt box, but not the rails". So
// the bar starts at the rows' own left edge — `pl-5`, past the 20px scroll-marker column, where every
// row's first mark and every project header's square begin — and not at the prompt box's.
//
// The bar is the rail's first item, so it scrolls away with the rows, as the segmented control did
// (maintainer 2026-10-20: "the tab switcher in the sidebar should scroll with the rest of the sidebar").

/**
 * The prompt box's chip (ConsoleProjectChip.tsx DESKTOP_CHIP) — same 26px height, border, type and hover —
 * with a lucide glyph where that chip has its project square. A square fills its box and these glyphs
 * paint ~1.6px inside theirs, so the glyph takes `pl-[3.5px]` and a `-mr-[1.5px]` (ViewChip) to read as
 * the square does. MEASURED 2026-11-03 (sans, both chips side by side on the Console), ink distances:
 *
 *                       border → mark   mark → word   word → chevron   glyph centre vs cap band
 *   project chip            5.00            7.08            8.68                 —
 *   these chips             5.13         7.20 / 6.88    8.38 / 8.33        0.23px low (as the chevron)
 *
 * RE-MEASURE rather than re-guess if the glyphs, the type size or the padding move.
 *
 * No focus ring, like the project chip: Radix hands focus back to the trigger when its menu closes, so a
 * `focus-visible` ring stood round the chip after every pick made with the mouse.
 */
const CHIP =
  "group inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-border/50 bg-transparent py-1 pl-[3.5px] pr-2 text-left text-[12px] leading-4 text-fg/90 outline-none transition-colors hover:bg-hover-strong data-[state=open]:bg-hover-strong"

interface Choice<V extends string> {
  value: V
  label: string
  icon: ReactNode
}

const ORDER_CHOICES: Choice<QueueDirection>[] = [
  { value: "fifo", label: "Oldest first", icon: <ArrowDownNarrowWide size={13} aria-hidden /> },
  { value: "lifo", label: "Newest first", icon: <ArrowDownWideNarrow size={13} aria-hidden /> },
]
const GROUP_CHOICES: Choice<ConsoleGroup>[] = [
  { value: "status", label: "By status", icon: <Rows3 size={13} aria-hidden /> },
  { value: "project", label: "By project", icon: <Folders size={13} aria-hidden /> },
]

/** `group` is the Console's grouping; a project's board passes none, having nothing to group. */
export function RailViewChips({ group }: { group?: ConsoleGroup }) {
  const order = useSnapshot(prefs).queueOrder
  return (
    <div role="group" aria-label="Arrange the list" data-rail-view-chips className="mb-3 flex min-w-0 shrink-0 items-center gap-1.5 pl-5">
      {group ? <ViewChip kind="group" name="Group" value={group} choices={GROUP_CHOICES} onPick={setConsoleGroup} /> : null}
      <ViewChip kind="order" name="Queue order" value={order} choices={ORDER_CHOICES} onPick={(v) => (prefs.queueOrder = v)} />
    </div>
  )
}

function ViewChip<V extends string>({
  kind,
  name,
  value,
  choices,
  onPick,
}: {
  kind: "group" | "order"
  name: string
  value: V
  choices: Choice<V>[]
  onPick: (value: V) => void
}) {
  const current = choices.find((c) => c.value === value) ?? choices[0]!
  return (
    <RadixDropdown.Root modal={false}>
      <RadixDropdown.Trigger asChild>
        <button type="button" aria-label={`${name}: ${current.label}`} data-rail-view-chip={kind} className={CHIP}>
          <span className="-mr-[1.5px] flex shrink-0 items-center text-muted-70">{current.icon}</span>
          <span className="min-w-0 truncate">{current.label}</span>
          {/* The prompt box chip's chevron, and its `-ml-[1.5px]` trim (ConsoleProjectChip.tsx). */}
          <ChevronDown aria-hidden size={13} className="-ml-[1.5px] shrink-0 text-fg/65 transition-transform group-data-[state=open]:rotate-180" />
        </button>
      </RadixDropdown.Trigger>
      <RadixDropdown.Portal>
        <RadixDropdown.Content
          align="start"
          side="bottom"
          sideOffset={5}
          collisionPadding={8}
          className={`${OPAQUE_PORTAL_SURFACE_CLASS} min-w-[168px] overflow-hidden rounded-lg p-1.5`}
        >
          {choices.map((c) => (
            <RadixDropdown.Item
              key={c.value}
              onSelect={() => onPick(c.value)}
              data-rail-view-option={c.value}
              className={`flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-[12.5px] outline-none data-[highlighted]:bg-panel-2 data-[highlighted]:text-fg ${
                c.value === value ? "text-fg" : "text-fg/80"
              }`}
            >
              <span className="flex w-4 shrink-0 items-center justify-center text-muted-70">{c.icon}</span>
              <span className="min-w-0 flex-1 truncate">{c.label}</span>
              <Check aria-hidden size={13} className={c.value === value ? "shrink-0 text-fg/70" : "invisible shrink-0"} />
            </RadixDropdown.Item>
          ))}
        </RadixDropdown.Content>
      </RadixDropdown.Portal>
    </RadixDropdown.Root>
  )
}
