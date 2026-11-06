import { HelpCircle } from "lucide-react"
import type { ReactNode } from "react"
import { Tooltip } from "./Tooltip.tsx"

// A settings label with an instant tooltip on a small HelpCircle — keeps explanatory prose OUT of the
// form body (one control per line reads clean when the "why" lives in the tooltip). Shared by the
// Settings drawer and the in-context settings popovers, so a field looks the same in either.
export function LabelWithHelp({ label, help, experimental = false }: { label: string; help: string; experimental?: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted">
      {label}
      <Tooltip label={help} side="right" clickable>
        <button type="button" aria-label={`About ${label}`} className="inline-flex size-4 items-center justify-center text-muted-60 hover:text-fg transition-colors">
          <HelpCircle size={12} />
        </button>
      </Tooltip>
      {experimental ? <ExperimentalChip /> : null}
    </span>
  )
}

// The chip is copy, not part of the label's small-caps treatment, so it resets to sentence case. Neutral
// on purpose: amber in this app means something needs you, and an experiment that is off needs nothing.
// It follows the help glyph, because in the Settings sheet a help glyph further right than this runs into the
// tooltip's clamp at the viewport's edge, and the tooltip opens over the glyph it explains. pb-px on a line 1px
// shorter lifts the word by a whole pixel, because a text baseline snaps to one: its capitals land 0.52px above
// the pill's centre, which the descender in "Experimental" balances, where 0.48px below read visibly low.
function ExperimentalChip() {
  return (
    <span data-experimental-chip className="rounded-full border border-border-strong px-1.5 pb-px text-[10px] font-medium normal-case leading-[13px] tracking-normal text-muted">
      Experimental
    </span>
  )
}

export function SettingsField({ label, help, experimental, children }: { label: string; help: string; experimental?: boolean; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <LabelWithHelp label={label} help={help} experimental={experimental} />
      {children}
    </div>
  )
}
