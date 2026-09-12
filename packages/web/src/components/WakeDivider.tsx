// The hairline+label+hairline chrome of a WAKE DIVIDER — extracted from ChatView so any surface can
// wear it without importing the whole thread view (and without a module cycle: ChatView imports the frizz
// wake renderer, so that renderer could not reach back into ChatView for this).
//
// It is the one rendering EVERY child-event now shares. A background shell coming to rest, a Monitor
// timing out, a sub-agent finishing, a sub-agent reporting up mid-flight, and a PR-watcher wake are the
// same class of event (something the worker is waiting on has reached a notable state, usually
// re-invoking the agent), and they read the same way: a centred section break that stands out from the
// tool cards around it, rather than one of them being a card indistinguishable from a hundred others
// (maintainer 2026-07-27). `children` is the whole line for a shell; the agent and GitHub dividers pass
// nodes so their titles can be links.
//
// It is no longer only for wakes. The queue card's collapsed intermediate run wears it too (maintainer
// 2026-07-31), and it is the same reading problem: an ELISION between two pieces of prose is a section
// break, so it wants a centred rule and not the bordered panel it used to be. That one is CLICKABLE —
// see `onClick` below.
import type { ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { compactAge, exactStamp } from "../lib/activityTime.ts"
import { useNowMs } from "../lib/liveClock.ts"

// An INTERACTIVE divider — one whose whole row is the affordance, like the queue card's collapsed
// intermediate run — renders its root as a `<button>` instead of a `<div>`, and it carries no
// `sourceId`: it stands in for a SPAN of messages, so there is no single one to identify. The union
// states that instead of leaving it to a comment.
// `ariaExpanded`/`ariaControls` ride the interactive form only, and only for a divider that TOGGLES a
// body — the fired-timer wake, which is the one member of the family that keeps prose to reveal. The two
// dividers that came before it expand ONE WAY and unmount, so a disclosure state would be a lie on them;
// leaving the props optional is what keeps them honest without a second component.
// `at` — the INSTANT of the event this line marks, and it puts a compact age on the line's tail
// (`· 21m ago`) with the exact localized reading on hover (see DividerAge). Every hairline that stands
// for a moment carries one (maintainer 2026-08-29, on the review-comment line that had it alone: "Most
// hairlines should include a duration like this"); the one that stands for a SPAN — the collapsed
// intermediate run — has no single instant and passes none.
type WakeDividerProps = { icon?: LucideIcon; children: ReactNode; ariaLabel?: string; marker?: string; at?: string } & (
  | { onClick: () => void; sourceId?: never; ariaExpanded?: boolean; ariaControls?: string }
  | { onClick?: never; sourceId?: string; ariaExpanded?: never; ariaControls?: never }
)

// `icon` is a prop rather than something each caller renders into `children`, so the glyph's size, its
// position at the head of the label, and the measured petite-caps nudge below are stated ONCE. Five
// dividers wear one now (maintainer 2026-07-31, on the GitHub one: "I like it so much that I think we
// should include a similar icon for the other hairline dividers"), and five hand-rolled copies of a
// sub-pixel optical correction is exactly how a family drifts apart.
export function WakeDivider({ icon: Icon, children, sourceId, ariaLabel, marker, at, onClick, ariaExpanded, ariaControls }: WakeDividerProps) {
  // The chrome itself, identical in both roots. The `group-hover/wake:` variants are inert on the inert
  // form (nothing names that group there) and are what makes the clickable form respond as ONE row —
  // its hairlines brighten with its label, so the affordance is the whole rule rather than the words.
  const chrome = (
    <>
      <span aria-hidden="true" className="h-px flex-1 bg-border/70 transition-colors group-hover/wake:bg-border" />
      <span className="petite-caps flex min-w-0 items-center gap-1 break-words text-center text-[12px] text-muted-70 transition-colors group-hover/wake:text-fg">
        {Icon && <Icon aria-hidden="true" size={12} className={WAKE_DIVIDER_ICON} />}
        {children}
        <DividerAge at={at} />
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-border/70 transition-colors group-hover/wake:bg-border" />
    </>
  )
  if (onClick) {
    return (
      <button
        type="button"
        data-wake-divider={marker}
        onClick={onClick}
        // Keep the reader's text selection where it was — the same side-channel courtesy every other
        // transcript affordance extends (see the sub-agent drill-in links).
        onMouseDown={(e) => e.preventDefault()}
        aria-label={ariaLabel}
        aria-expanded={ariaExpanded}
        aria-controls={ariaControls}
        className="group/wake my-1 flex w-full items-center gap-3 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-focus-ink-60"
      >
        {chrome}
      </button>
    )
  }
  return (
    <div
      data-frizz-msg={sourceId}
      data-wake-divider={marker}
      className="my-1 flex items-center gap-3"
      // A divider carrying an interactive title is not an ARIA `separator` (a separator may not own a
      // focus stop), so only the inert shell-wake form takes the role — via `ariaLabel`.
      role={ariaLabel ? "separator" : undefined}
      aria-label={ariaLabel}
    >
      {chrome}
    </div>
  )
}

// THE AGE ON THE TAIL — `· 21m ago`, ticking on the app's one shared clock, with GitHub's exact
// reading (`Aug 29, 2026, 10:44 AM PDT`) as its hover.
//
// It is rendered HERE, inside the label, and not by each caller, for the reason the icon is: nine
// dividers wear it now, and the one that drew its own (the timer's, with `title={wake.at}`) had already
// drifted from the GitHub line's (`· {age}` in one span, a word space where the others have the flex
// gap) — two rhythms for one mark. The dot and the age are two flex items on the label's own `gap-1`,
// so the dot sits the same 4px from the words before it as from the age after it, in every divider.
//
// LAST on the line, after any "Click to expand": the age is the one field that must survive the label's
// truncation at queue-rail width, and `shrink-0` outside the caller's truncating span is what keeps it —
// the review line established that, and the position is the family's now.
//
// The hover is a native `title`, not the app's Tooltip. Both age lines used `title` before this, GitHub's
// own `<relative-time>` uses one, and Tooltip needs a Provider that the transcript fixtures which render
// these dividers deliberately do not mount. What changed is the CONTENT: it was the raw ISO string.
//
// `aria-hidden` on the dot only. The age is real content a screen reader should get; the dot is
// punctuation between two flex items and would be read as "middle dot".
function DividerAge({ at }: { at?: string }) {
  const now = useNowMs()
  const age = compactAge(at, now)
  if (!age) return null
  return (
    <>
      <span aria-hidden="true" className="shrink-0 opacity-50">·</span>
      <span title={exactStamp(at) ?? undefined} className="shrink-0 tabular-nums">{age}</span>
    </>
  )
}

// Identifiers riding INSIDE a divider's petite-caps label keep ordinary case. A GitHub login and an
// `owner/repo#N` are tokens you match against GitHub by eye, and small-capping them makes them read as
// prose — the surrounding frame words are what the petite-caps treatment is for.
export const WAKE_DIVIDER_IDENT = "[font-variant-caps:normal]"

// The glyph treatment `WakeDivider` applies to its `icon`. Not exported for callers to re-apply — they
// pass the icon and this is what happens to it. It does NOT take ICON_LABEL_NUDGE, and the reason is the
// petite caps: that nudge is calibrated against a NORMAL-case label, which inks from cap-top to
// baseline, while this label inks from roughly x-height to baseline. The text's optical centre is
// therefore ~1.2px LOWER here, so a glyph centred by `items-center` reads HIGH rather than low — the
// opposite correction, and applying the ordinary nudge under mono (−1.7px) would push it ~2.1px high.
//
// Measured in the running app at 12px, with the ordinary nudge neutralized, against the label's own
// petite-caps ink (canvas `fontVariantCaps`, which the `font` shorthand CANNOT express — measuring a
// full cap band instead is what hid this in the first pass): +0.57px under system-ui, +0.45px under
// mono. Both stacks want the SAME sign and nearly the same amount, unlike ICON_LABEL_NUDGE, so this is
// one constant rather than a font-flipped variable. Residual after correcting: +0.09px / −0.03px.
//
// And it is GLYPH-INDEPENDENT, which is worth stating because it contradicts the usual rule that every
// glyph needs its own correction. Re-measured across all three icons the dividers wear — Github (10px
// ink), SquareTerminal (9px), Bot (8px) — every one lands on the SAME residual, +0.09px under system-ui
// and −0.03px under mono. Lucide centres a glyph's ink inside its 24-unit viewBox, so only the ink's
// EXTENT varies between them and its CENTRE does not; the amount to move that centre is therefore one
// number. A non-lucide mark (an octicon, an emoji, an <img>) has no such guarantee — measure it.
//
// CALIBRATED FOR THE SIZE THAT SHIPS — this divider's 12px label in an 18px line box — and NOT claimed
// scale-invariant. The label's leading is a fixed 18px, so doubling the type size does not double the
// line box the glyph is centred in, and the required correction grows ~4x rather than 2x. The `em`
// spelling is the safer default if the scale and the leading ever move together; if either moves
// alone, re-measure rather than trusting this number.
const WAKE_DIVIDER_ICON = "shrink-0 translate-y-[0.04em]"
