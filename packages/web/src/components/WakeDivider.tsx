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
import { compactAge } from "../lib/activityTime.ts"
import { messageStamp } from "../lib/messageTime.ts"
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
// `trailing` — a control drawn AFTER the age, the one thing allowed past it: the disclosure chevron of a
// line whose title is a link, so the row cannot be the button (SessionMessageLine).
type WakeDividerProps = { icon?: LucideIcon; children: ReactNode; ariaLabel?: string; marker?: string; at?: string; trailing?: ReactNode } & (
  | { onClick: () => void; sourceId?: never; ariaExpanded?: boolean; ariaControls?: string }
  | { onClick?: never; sourceId?: string; ariaExpanded?: never; ariaControls?: never }
)

// `icon` is a prop rather than something each caller renders into `children`, so the glyph's size, its
// position at the head of the label, and the measured petite-caps nudge below are stated ONCE. Five
// dividers wear one now (maintainer 2026-07-31, on the GitHub one: "I like it so much that I think we
// should include a similar icon for the other hairline dividers"), and five hand-rolled copies of a
// sub-pixel optical correction is exactly how a family drifts apart.
export function WakeDivider({ icon, children, sourceId, ariaLabel, marker, at, trailing, onClick, ariaExpanded, ariaControls }: WakeDividerProps) {
  // The chrome itself, identical in both roots. The `group-hover/wake:` variants are inert on the inert
  // form unless a caller's wrapper names that group, and are what makes the clickable form respond as
  // ONE row — its hairlines brighten with its label, so the affordance is the whole rule rather than the
  // words.
  const chrome = (
    <>
      <span aria-hidden="true" className={WAKE_DIVIDER_RULE} />
      <WakeDividerLabel icon={icon} at={at} trailing={trailing}>{children}</WakeDividerLabel>
      <span aria-hidden="true" className={WAKE_DIVIDER_RULE} />
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
        className="group/wake @container/wake my-1 flex w-full items-center gap-3 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-focus-ink-60"
      >
        {chrome}
      </button>
    )
  }
  return (
    <div
      data-frizz-msg={sourceId}
      data-wake-divider={marker}
      className="@container/wake my-1 flex items-center gap-3"
      // A divider carrying an interactive title is not an ARIA `separator` (a separator may not own a
      // focus stop), so only the inert shell-wake form takes the role — via `ariaLabel`.
      role={ariaLabel ? "separator" : undefined}
      aria-label={ariaLabel}
    >
      {chrome}
    </div>
  )
}

/** The divider's LABEL without its rules — the glyph, the caller's words, the age and any trailing
 *  control. WakeDivider draws it between two hairlines; a line that opens into a frame draws the same
 *  label as the frame's `<legend>`, so it reads identically on the rule and on the box's top edge
 *  (SessionMessageLine). */
export function WakeDividerLabel({ icon: Icon, children, at, trailing }: { icon?: LucideIcon; children: ReactNode; at?: string; trailing?: ReactNode }) {
  return (
    // `overflow-x-clip` is the backstop behind the rule's floor, never the mechanism: a label whose
    // rigid parts outgrow the room is cut at its own edge rather than painted across the rule. `clip`
    // and not `hidden`, which would make the other axis scroll and shave the focus ring off a link.
    // A trailing control ends the label, so `pr-px` keeps its 1px focus ring inside that clip.
    <span className={`petite-caps flex min-w-0 items-center gap-1 overflow-x-clip break-words text-center text-[12px] text-muted-70 transition-colors group-hover/wake:text-fg${trailing ? " pr-px" : ""}`}>
      {Icon && <Icon aria-hidden="true" size={12} className={WAKE_DIVIDER_GLYPH} />}
      {children}
      <DividerAge at={at} />
      {trailing}
    </span>
  )
}

// ---- THE RULE IS NEVER SQUEEZED OUT (2026-10-11) ---------------------------------------------------
// A divider is a hairline with a label ON it, and it stops being one the moment the label takes the
// whole row. Nothing stopped it: the rules were `flex-1` with no floor, so a background shell's
// 61-character title ran a 700px column nearly edge to edge, and a label longer than a narrow row left
// no rule at all (maintainer: "you can barely even see the hairline anymore. There needs to be at least
// 50 pixels of hairline on each side").
//
// So the RULE has a floor and the LABEL is what gives. `min-w-[50px]` on both rules is the whole
// guarantee — they are the only flex items here that refuse to shrink, and the label between them is
// `min-w-0`. What that buys depends on every caller letting its text compress, which is three habits:
//
// - ONE part of a label is elastic (`min-w-0 truncate`) and it is the LONG one — a title, a job list.
//   The word that is the news (`finished`, `expired`, the verdict) sits before it or outside it, so the
//   ellipsis never lands on it. A quoted title goes through `DividerQuotedTitle`, which closes the quote.
// - Words the row can do without are `WAKE_DIVIDER_WIDE_ONLY`: a clause that explains the news ("— its
//   work finished"), a tally, a duration, a ref's `owner/repo`, and the noun the icon already says
//   ("Background task", "Sub-agent"). Below the width where they stop fitting they are GONE rather than
//   half-clipped — a row that ends "…ITS WOR…" beside a truncated title is two ellipses and no news.
// - Everything else is short and rigid: the icon, the outcome word, the age.
//
// So a divider has TWO readings, and the narrow one is written, not left to the ellipsis:
//
//   Background task «Running the update harness aga…» finished · 3h ago      «Running th…» finished · 3h ago
//   Wait over — its work finished · Click to expand · 3h ago                 Wait over · expand · 3h ago
//   CI passed on nubjs/nub#761 · 7 checks green · 2h ago                     CI passed #761 · 2h ago
//   New review comment from @pullfrog on nubjs/nub#587 · 9m ago              Review comment #587 · 9m ago
//
// The switch is a CONTAINER query on the divider itself, not a viewport breakpoint, because the same
// divider is drawn in a 760px thread column, a 420px drawer and a phone's queue card, sometimes all at
// once. 34rem is where the widest full label in the family stops fitting between two 50px rules — the
// collapsed-rounds line, 352px of rigid text, needs 476px — with room left for a title beside it. A
// 390px phone's column leaves the label about 230px, of which the icon and the age take 85: the narrow
// reading has some 20 characters to say it in, which is the budget each caller's wording was cut to.
export const WAKE_DIVIDER_RULE = "h-px min-w-[50px] flex-1 bg-border/70 transition-colors group-hover/wake:bg-border"
export const WAKE_DIVIDER_WIDE_ONLY = "@max-[34rem]/wake:hidden"
/** The other half, for the rare label whose narrow reading needs a word the wide one does not have (a
 *  bare arrow where the sentence stood). Prefer hiding to swapping: both halves are in the DOM. */
export const WAKE_DIVIDER_NARROW_ONLY = "@min-[34rem]/wake:hidden"

/** `· Click to expand`, on a divider whose whole row toggles a body. It shortens to the verb on a narrow
 *  row rather than leaving: a touch screen has no hover to say the rule is a button, so the word is the
 *  only affordance there is.
 *
 *  Under 19.5rem it does leave. A label made of rigid parts alone has nothing to truncate — `Timer ·
 *  expand · just now` needs a 303px row to keep both rules — so on a row narrower than that the label's
 *  clip would cut the age mid-word instead. This is the floor for a split pane or a 320px screen, not a
 *  third reading: a 390px phone's column is wider than it. */
const HINT_LEAVES = "@max-[19.5rem]/wake:hidden"
export function DividerHint({ open }: { open?: boolean }) {
  return (
    <>
      <span aria-hidden="true" className={`shrink-0 opacity-50 ${HINT_LEAVES}`}>·</span>
      <span className={`shrink-0 ${HINT_LEAVES}`}>
        <span className={WAKE_DIVIDER_WIDE_ONLY}>Click to </span>
        {open ? "collapse" : "expand"}
      </span>
    </>
  )
}

/** `Lead «a long title» tail` with the TITLE as the one elastic part: `Background task «Running the
 *  update harn…» finished`. The guillemets sit outside the truncating element, in a gap-less nested
 *  flex, so a clipped title still closes its quote, and the tail — the outcome, which is the news —
 *  survives whole. The lead names the kind of thing, which the divider's icon already does, so it is the
 *  first part to go on a narrow row, with any `note` after the outcome ("(completion relayed)"). The
 *  full title is the hover, for when it was cut. */
export function DividerQuotedTitle({ lead, title, tail, note }: { lead?: string; title: string; tail?: string; note?: string }) {
  // The spaces INSIDE the lead, tail and note are for the text, not the layout: a flex item's edge
  // whitespace draws nothing (the label's gap is what spaces the parts), but without it the row's
  // `textContent` — what find-in-page, a copy and every test read — runs the words together.
  return (
    <>
      {lead && <span className={`shrink-0 ${WAKE_DIVIDER_WIDE_ONLY}`}>{lead} </span>}
      <span className="flex min-w-0 items-center" title={title}>
        <span className="shrink-0">«</span>
        <span className="min-w-0 truncate">{title}</span>
        <span className="shrink-0">»</span>
      </span>
      {tail && <span className="shrink-0"> {tail}</span>}
      {note && <span className={`shrink-0 ${WAKE_DIVIDER_WIDE_ONLY}`}> {note}</span>}
    </>
  )
}

// THE AGE ON THE TAIL — `· 21m ago`, ticking on the app's one shared clock, with the transcript's one
// hover reading (`Today at 10:44 AM`, lib/messageTime) as its title — the same words the rest of the
// divider's message shows on hover, so the line does not read one instant two ways.
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
// these dividers deliberately do not mount. It was the raw ISO string, then GitHub's exact reading
// (`Aug 29, 2026, 10:44 AM PDT`) until every message took a hover of its own (2026-10-19).
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
      <span title={messageStamp(at) ?? undefined} className="shrink-0 tabular-nums">{age}</span>
    </>
  )
}

// Identifiers riding INSIDE a divider's petite-caps label keep ordinary case. A GitHub login and an
// `owner/repo#N` are tokens you match against GitHub by eye, and small-capping them makes them read as
// prose — the surrounding frame words are what the petite-caps treatment is for.
export const WAKE_DIVIDER_IDENT = "[font-variant-caps:normal]"

// The glyph treatment `WakeDivider` applies to its `icon`. A caller passes the icon and this is what
// happens to it; the one other lucide glyph on a divider, SessionMessageLine's disclosure chevron, takes
// it by import rather than a copy, for the reason the next paragraphs give. It does NOT take ICON_LABEL_NUDGE, and the reason is the
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
export const WAKE_DIVIDER_GLYPH = "shrink-0 translate-y-[0.04em]"
