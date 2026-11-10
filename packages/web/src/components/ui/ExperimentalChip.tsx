// The chip is copy, not part of whatever label it sits beside, so it resets to sentence case: `normal-case` for a
// Settings label's capitals, and font-variant-caps for the petite caps of the model menu and the prompt box's
// controls. Neutral on purpose: amber in this app means something needs you, and an experiment needs nothing.
// pb-px on a line 1px shorter lifts the word by a whole pixel, because a text baseline snaps to one: its capitals
// land 0.52px above the pill's centre, which the descender in "Experimental" balances, where 0.48px below read
// visibly low.
export function ExperimentalChip({ className = "" }: { className?: string }) {
  return (
    <span data-experimental-chip className={`rounded-full border border-border-strong px-1.5 pb-px text-[10px] font-medium normal-case leading-[13px] tracking-normal text-muted [font-variant-caps:normal] ${className}`}>
      Experimental
    </span>
  )
}
