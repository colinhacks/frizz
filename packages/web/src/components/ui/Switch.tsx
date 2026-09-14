// THE APP'S PILL SWITCH — shadcn's shape (a track, a thumb, one slide) in frizz's tokens.
//
// It replaced a segmented `Off | On` pair wherever a single boolean is being set. That control was two
// buttons and a border, so an off state still drew a box the eye had to read before finding which half
// was lit; a switch says the same thing with position alone and needs no label to be scanned. Maintainer
// 2026-08-11: "use regular pill toggles, shadcn style."
//
// HAND-ROLLED rather than `@radix-ui/react-switch`, which is not a dependency here. A switch is a
// `role="switch"` button and a translated span — the package would buy keyboard handling the button
// element already gives us, and every Radix primitive this app does pull in earns it with a portal or a
// focus trap. There is nothing to trap here.
//
// SIZED IN PIXELS, not in the Tailwind scale, because the sizes must stay in exact arithmetic. Two of
// them, both derived rather than chosen:
//
//   travel = trackWidth − 2×inset − thumb          (round these independently and the thumb stops short
//                                                   of the track's right edge by a hair that reads as a
//                                                   rendering bug rather than a design)
//   onCap  = trackHeight/2 − inset − 0.5cap        (the vertical placement — see the class list below)
//
// `onCap`'s `− inset` is the part that is not obvious and was MEASURED: `align-self: baseline` on a flex
// box whose content has no baseline synthesizes one from the content edge, so the pill's bottom sits one
// PADDING above the text baseline, not on it. Without that term every switch read exactly 2.00px low —
// in both fonts, which is what identified it as a constant rather than a font effect.
const SIZES = {
  // The 11px-prose size, for a switch sharing a row with small copy (the recurring-prompt panel).
  sm: { track: "h-[16px] w-[28px]", thumb: "size-[12px]", travel: "translate-x-[12px]", onCap: "translate-y-[calc(6px_-_0.5cap)]" },
  // The form size, for a switch beside a normal label.
  md: { track: "h-[20px] w-[34px]", thumb: "size-[16px]", travel: "translate-x-[14px]", onCap: "translate-y-[calc(8px_-_0.5cap)]" },
} as const

// A NOTE ON `disabled`, because getting this wrong is what made the Goal panel flash. Do NOT wire it to
// an in-flight mutation. A switch is OPTIMISTIC — its `checked` moves the instant it is clicked — so
// disabling it during the write buys nothing and costs a visible dim: `disabled:opacity-45` is not
// transitioned, so a 40ms round-trip drops the control to 45% for ~3 frames and snaps it back. Measured
// exactly that, and reproduced it by hand as a control (maintainer 2026-08-12: "there is a terrible
// render flash everytimem you check one of these fucking toggles").
//
// Reserve `disabled` for a switch the operator genuinely may not move right now — a setting the current
// state forbids — where the dim IS the message and stays put long enough to read.
export function Switch({ checked, onChange, disabled, label, size = "sm", testId }: {
  checked: boolean
  onChange: (next: boolean) => void
  disabled?: boolean
  /** Accessible name. The visible text beside a switch is usually a `<span>`, not a `<label for>`, so
   *  this is what a screen reader actually reads — never omit it. */
  label: string
  size?: keyof typeof SIZES
  testId?: string
}) {
  const s = SIZES[size]
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-switch={testId}
      data-state={checked ? "checked" : "unchecked"}
      // `onMouseDown` preventDefault: a switch in a popover beside a textarea would otherwise steal
      // focus on press, blurring the operator's caret out of the text they are editing for a control
      // that never needs focus to be clicked. (It also used to fire the Goal panel's blur-persist and
      // double the round-trips; that panel batches until it is dismissed now, but the focus theft alone
      // keeps this here.)
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onChange(!checked)}
      // ON THE CAP BAND, not on the flex line's centre. A switch is a filled pill, so its ink IS its
      // box — and centring that box against a line of text puts it wherever the font's ascent/descent
      // happen to fall. THIS APP RENDERS IN TWO FONTS (html[data-font]), and the two disagree: at
      // `items-center` the pill measured 0.19px off the cap band in sans and 1.45px LOW in mono, so any
      // hand-fitted constant would have been right in exactly one of the maintainer's two settings.
      //
      // `self-baseline` puts the pill's bottom edge on the text baseline (a flex box whose content has
      // no baseline synthesizes one from its bottom margin edge), and the translate lifts it by half its
      // own height minus half a CAP — which the browser resolves per font, per size, with nothing to
      // re-measure when the setting flips. Needs the ROW to be `items-baseline`: with `items-center`
      // there is no shared baseline to align against and the correction silently lands ~1px off.
      className={`inline-flex shrink-0 cursor-pointer items-center self-baseline rounded-full p-[2px] outline-none transition-colors focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:cursor-default disabled:opacity-45 ${s.track} ${s.onCap} ${
        checked ? "bg-fg" : "bg-border hover:bg-border-strong"
      }`}
    >
      <span
        className={`pointer-events-none block rounded-full transition-transform duration-150 ease-out ${s.thumb} ${
          checked ? `bg-bg ${s.travel}` : "translate-x-0 bg-muted/70"
        }`}
      />
    </button>
  )
}
