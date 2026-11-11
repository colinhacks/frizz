// The shared card chrome every transcript card wears — extracted from ChatView so it can be imported
// by any surface without importing the whole thread view (and without a module cycle). The comments
// below are the maintainer-settled rules for these shapes; they moved here verbatim.
import { useLayoutEffect, useMemo, useRef, type ComponentPropsWithoutRef, type ReactNode } from "react"
import type { LucideIcon } from "lucide-react"
import { mdToHtml } from "../lib/markdown.ts"

// A worker message carrying a long UNBREAKABLE token — a Windows path, a box-drawing error dump — wraps
// at the character level rather than bleeding past its card's edge (maintainer 2026-07-10, of the queue
// card: it "looks so bad"). `overflow-wrap:anywhere` breaks unbreakable PROSE runs to fit. The queue card
// applied it to every message it drew until the card went (2026-11-10); the awaiting card's prose and its
// steps wear it on every surface. Whether CODE wraps is a separate setting, one for every surface ("Wrap
// code", styles.css `.md-body pre`): on, a fence breaks at its spaces; off, it scrolls inside its own <pre>.
export const WRAP_ANYWHERE = "[overflow-wrap:anywhere]"

// ── The shared card chrome ────────────────────────────────────────────────────────────────────────
// Every card the transcript sets off from the prose — the ```done / ```awaiting signal fences, a
// ```question block, and the runtime banners (permission, provider fault, usage-limit pause, native
// input) — wears the SAME shell, body scale and action row, so they read as one family rather than a
// pile of one-off shapes
// (maintainer 2026-07-24: "I like the little checkmark with the Done label — we should have something
// similar for all the other kinds of cards").
//
// The ANATOMY came from shadcn/ui's Alert (maintainer 2026-07-29: "the default shadcn call-out or
// alert box looks way better than ours"), minus its gutter. Two rules carry the look:
//
//   1. The kind is a real TITLE: sentence case, body size, medium weight, full-strength in the tone's
//      own color, flush with the card's own left padding. It used to be a 10px UPPERCASE eyebrow,
//      which reads as a metadata tag stuck above the card rather than as the card's headline.
//   2. The glyph LEADS the title row, top-LEFT, beside the title — but it is not a gutter. shadcn
//      indents the description to clear its icon; frizz does not, because that indent spends ~24px of
//      every card's width on a decoration and leaves the body hanging off the one edge that should be
//      flush (maintainer 2026-07-29: "I don't like how much space there is left padding for the actual
//      content"). Only the TITLE steps right of the glyph; body and actions start on the card's own x.
//      (The glyph sat at the far right from 2026-07-29 until 2026-09-30, when the maintainer asked for
//      it "back to the left. Upper left instead of the upper right.")

// The card's MEANING, and the ONLY thing allowed to vary between kinds (maintainer 2026-07-24: the
// styling across kinds was "vastly different… almost no consistency"). Every card is otherwise the
// same shell — same fill, same border weight, same padding, same body scale, same action row — so a
// tone is a two-token swap on the border and the title, never a different card:
//   neutral   — a statement of fact (done, awaiting, a question)
//   attention — a FOREIGN session is blocked on you, answerable only in the terminal you run it in
//   caution   — frizz paused itself and will continue on its own (a usage limit)
//   risk      — the ACTION is irreversible, but nothing is wrong (a destructive gate awaiting a choice)
//   danger    — something is BROKEN (a sign-in fault)
//
// Only THREE border colors, though: `caution` and `risk` both keep the neutral border and say their
// piece in the title alone. Caution's amber and the accent gold sit ~15° apart on the wheel, so as two
// lit borders they were indistinguishable — and a self-resolving pause must never compete for the eye
// with "your agent is stuck waiting on you". Border = how loud; the title = what it is.
//
// `risk` SPLIT OFF FROM `danger` on 2026-08-26 (maintainer: danger questions "look way too scary"),
// applying that same law to the other end. A destructive gate and a dead sign-in were wearing one
// full-strength red border, and they are not the same event: one is a question waiting on a choice
// nobody has made wrongly yet, the other is a thing that has already failed. A question is a statement
// of fact with a consequence, so it keeps the neutral border and turns its TITLE red. Danger stays loud
// for what is actually broken.
//
// The tone color lands on the icon AND the title together, as shadcn's `[&>svg]:text-current` does:
// they are one object, and a mismatched color would read as an unrelated badge rather than as the
// title's own mark.

// The corner EVERY block-level element wears — this card, a tool card, a code fence, a table, an
// image, a queue banner. It is the Tailwind half of `--block-radius` in styles.css (both 12px, and
// they must stay equal): JSX imports this, CSS uses the var. Cards used to be the only thing rounded
// this far, so a signal card sat directly above a 6px tool card and an 8px image and no two of them
// read as the same product (maintainer 2026-07-31: "we should make the rendering consistent across
// all of these block-level elements").
//
// It went out at 16px first and that was too round (maintainer, same day: "goes a little overboard
// sometimes… It starts to impinge in expanded view"). See the var in styles.css for why the fix is
// this number AND every block's inset together, not the radius alone.
//
// OUTER containers only. A row or button NESTED inside one keeps the 6px control corner
// (CARD_ACTION_RADIUS below).
export const BLOCK_RADIUS = "rounded-xl"
// The BOTTOM two corners of a child laid FLUSH against the inside of a BLOCK_RADIUS shell's 1px
// border — one pixel tighter, because the shell's PADDING box is what the child actually meets.
//
// A child that is squarer than that arc juts OUT through it, and since an in-flow child's background
// paints after its parent's border, it erases the border exactly where the corner turns. That is what
// the queue card's lifecycle footer did: it kept a literal `rounded-b-[7px]` from back when the shell
// was 8px, so at 12px the left border ran down, dissolved through the bottom-left arc and picked back
// up along the bottom edge — a notch on the corner of every cue card (maintainer 2026-08-01). The
// footer's `backdrop-blur` widened it, smearing the border it was already covering.
//
// Written as calc() off the var rather than a second literal so the pair CANNOT drift again: change
// `--block-radius` (and its `rounded-*` twin above) and the inner corner follows on its own.
// (The `_` are Tailwind's escape for the spaces CSS `calc` requires around its `-`; without them the
// declaration is a syntax error and the corner silently falls back to square.)
export const BLOCK_RADIUS_INNER_BOTTOM = "rounded-b-[calc(var(--block-radius)_-_1px)]"

export type CardTone = "neutral" | "attention" | "caution" | "risk" | "danger"
const CARD_TONES: Record<CardTone, { border: string; head: string }> = {
  neutral: { border: "border-border-strong", head: "text-fg" },
  attention: { border: "border-accent/45", head: "text-accent" },
  caution: { border: "border-border-strong", head: "text-attention" },
  risk: { border: "border-border-strong", head: "text-danger" },
  danger: { border: "border-danger-fill/45", head: "text-danger" },
}

// The 14px corner glyph is optically centred on the TITLE'S CAP BLOCK, not on its line box — same
// reasoning as ICON_LABEL_NUDGE (a short word inks from cap-top to baseline, so its mass rides high
// inside the font box while the glyph's ink is centred in its own), and it matters MORE across the
// row than it did beside the word: a glyph a pixel low at the far edge reads as a dropped corner.
// The amount is FONT-DEPENDENT, so like that nudge it is a CSS variable that flips with the type
// stack (styles.css): 2px under mono, 3px under system-ui.
const CARD_ICON_OFFSET = "card-icon-offset"

// The title-row glyph, with its box collapsed onto its INK on both sides. Moving the glyph to the
// left edge (2026-09-30) made its dead space visible twice over: lucide draws each mark somewhere
// inside a 24-unit viewBox, so at 16px the Hourglass inks 3.33px in from its box, the Check 2.67px and
// the KeyRound 1.33px. On a shared `gap-2` that set the glyph 1.3–3.3px in from the body copy's left
// edge and drew 10.0–12.7px of ink between glyph and title, a different distance on every card kind.
//
// So the BROWSER measures each glyph, rather than a table of per-icon constants that the next icon
// swap silently invalidates: `getBBox()` is the path geometry in viewBox units (stroke excluded, so
// half the stroke width goes back on each side), and the difference to the viewBox edge is the dead
// space, cancelled with an equal negative margin before paint. The ink then starts on the card's own
// content edge like every other line in it, and `gap-2` means 8px of INK to the title on every kind.
//
// The kind line's glyph is trimmed the same way (KindLabel): every block type shares that line, each with
// a different glyph, and one gap cannot sit their different dead spaces at one ink distance from the word.
//
// `inkHeight` SIZES THE GLYPH BY ITS INK AS WELL (KindLabel's `evenInk`), for a card whose kinds must read
// as one family. Lucide draws a list glyph in a short band of its viewBox: at this line's 12px ListChecks
// paints 10.0 x 8.0px where CircleHelp and KeyRound paint 11.0 x 11.0 and AlertTriangle 11.0 x 10.0
// (getBBox plus the stroke; sans, 2026-10-13), so "Select multiple" read lighter and smaller than
// "Question" and "Secret" on cards stacked in one message. The glyph is drawn in the LARGEST EVEN BOX
// at which its ink still fits `inkHeight`, with its stroke held at the width it paints at the asked
// size:
//   - even, because an even box centres on the 16px line on whole pixels. The exact fit for ListChecks
//     is 17.14px, and there its three 1px rules fall between device pixels and draw soft at dsf 2 —
//     lighter, which was the complaint. At 16 they land on the grid.
//   - fits, never exceeds, so a glyph already at full height is left alone whatever its shape: 14px
//     would take CircleHelp to 12.7 and AlertTriangle to 11.5.
// ListChecks therefore draws in a 16px box and paints 13.0 x 10.3px at a 1px stroke, inside the
// 10.0–11.0 the other three already span. The box's extra height is given back as a negative block
// margin, so the kind line is the height it was and the head is the same on every card.
function useInkTrim(Icon: LucideIcon | undefined, inkHeight?: number) {
  const ref = useRef<SVGSVGElement>(null)
  useLayoutEffect(() => {
    const svg = ref.current
    if (!svg || typeof svg.getBBox !== "function") return
    const ink = svg.getBBox()
    const view = svg.viewBox.baseVal
    if (!view || view.width === 0 || ink.width === 0) return
    let stroke = Number(svg.getAttribute("stroke-width")) || 0
    if (inkHeight !== undefined && ink.height > 0) {
      // The size the caller asked for is the `width` ATTRIBUTE; the style set below never changes it.
      const asked = svg.width.baseVal.value
      const strokePx = (stroke * asked) / view.width
      const inkAt = (size: number) => (ink.height * size) / view.height + strokePx
      let size = asked
      while (inkAt(size + 2) <= inkHeight) size += 2
      const grown = size > asked
      svg.style.width = svg.style.height = grown ? `${size}px` : ""
      svg.style.marginBlock = grown ? `${(asked - size) / 2}px` : ""
      if (grown) stroke = (strokePx * view.width) / size
      svg.style.strokeWidth = grown ? String(stroke) : ""
    }
    const scale = svg.getBoundingClientRect().width / view.width
    const halfStroke = stroke / 2
    svg.style.marginLeft = `${-Math.max(0, ink.x - halfStroke - view.x) * scale}px`
    svg.style.marginRight = `${-Math.max(0, view.x + view.width - (ink.x + ink.width) - halfStroke) * scale}px`
  }, [Icon, inkHeight])
  return ref
}

function CardGlyph({ icon: Icon, className }: { icon: LucideIcon; className: string }) {
  const ref = useInkTrim(Icon)
  return <Icon ref={ref} aria-hidden="true" size={16} className={`shrink-0 ${CARD_ICON_OFFSET} ${className}`} />
}

// The ANATOMY itself, separate from the shell that usually carries it. Both pieces are exported
// because ONE card cannot use `TranscriptCard`: the answers card is the human's own artifact, so it
// keeps the user bubble's fill, radius and right-hand corner (ChatView's AnswersCard) while wearing
// exactly this anatomy inside. Composing it out of the same pieces is what keeps that promise honest —
// the alternative, hanging fill/radius props off TranscriptCard for a single caller, invites the next
// card to override the shell rather than join it.

// The title row: the glyph top-LEFT, the kind beside it, any aside at the far right.
//
// The glyph used to sit in a left GUTTER with the body indented to clear it (shadcn's Alert grid).
// That cost every card ~24px of content width for a decoration, which is most of a word on a queue
// card, and it read as a hanging indent on the one thing that should have been flush (maintainer
// 2026-07-29: "I don't like how much space there is left padding for the actual content"). So the
// glyph rides the title ROW only: the title steps right of it, while the body copy and the action
// footer below still start on the card's own x. It spent 2026-07-29 → 2026-09-30 in the top-RIGHT
// corner instead; the maintainer moved it back ("Upper left instead of the upper right").
export function CardHead({
  icon: Icon,
  label,
  head = CARD_TONES.neutral.head,
  aside,
}: {
  /** Optional since 2026-08-31: the question card dropped its corner glyph, because a full-strength
   *  decorative mark parked beside the muted × read as the actionable thing while the actual control
   *  read as chrome (maintainer: "the actionable thing is gray and light, whereas the not actionable
   *  thing is a very bold white color"). A card with no icon just ends its title row at the aside. */
  icon?: LucideIcon
  label: ReactNode
  head?: string
  aside?: ReactNode
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      {Icon && <CardGlyph icon={Icon} className={head} />}
      {/* The title WRAPS rather than truncating: frizz's kinds are short sentences ("Waiting on your
          answer — in your external terminal"), and the half of one that survives a narrow queue card
          is not the half that carries the meaning. It takes the row's slack, which is what pushes the
          aside to the right edge — and a wrapped second line stays indented under the title's own
          first word, not under the glyph.

          16px SEMIBOLD — a real title scale, not the 13px body-size the family wore until 2026-08-24.
          The body-size title was the shadcn-anatomy call of 2026-07-29; the maintainer reversed it off
          the round-5 awaiting mockups ("why is it so small and non-title-like?", then choosing the
          16px cut "across all similar cards (Done etc)"), so the step up is a FAMILY rule, not one
          card's. The glyph grows with it, 14 → 16, and --card-icon-offset was re-measured for the
          new pair (styles.css). */}
      <span className={`min-w-0 flex-1 text-[16px] font-semibold leading-6 tracking-tight ${head}`}>{label}</span>
      {/* `leading-6` matches the title's line box so a smaller aside still reads as sitting ON the
          title's line rather than floating above it. */}
      {aside && <span className="shrink-0 leading-6">{aside}</span>}
    </div>
  )
}

// THE KIND HEAD — the second head shape. A card that names its KIND does it in a small line of its own: a
// 12px glyph and the kind's word, muted, with the title on its own line under it and a rule between that
// header and the body. It is what EVERY block type wears since 2026-10-13 — the done card, every awaiting
// shape and the question card — with the worker's own title under the kind, or the kind alone when the
// worker named none (maintainer, picking it off the second round of mockups: "a small icon followed by a
// small word over the title will look good"; and before that, "all block types should have a header").
//
// HOW IT GOT HERE, because each step is a thing not to undo. The steps card took a filled CHIP with the
// glyph inside it on 2026-10-05 (maintainer: "a little icon … then a label that says just says to do, like
// a chip basically. Then underneath that can be the title … another horizontal rule dividing the title and
// chip from the actual body"): the 16px glyph beside a 16px title had read as two headings side by side.
// On 2026-10-13 every done and awaiting card took that chip too, and with no title the result was "a giant
// header, but it just contains a single, pretty useless chip". So the kind stays small and says itself
// once, but as a LINE rather than an object: no fill to read as a control, no box to sit empty.
//
// Muted, not full-strength: the title says what THIS card is about and must be the loudest thing in the
// head; the kind is a label for it. A tone that has something to say (a destructive question) colours the
// kind line instead, which is where the eye now looks first.
const CARD_KIND = "flex min-w-0 items-center gap-[5px] text-[12px] font-medium leading-4"
// The kind line's glyph box, and the ink height a glyph that fills lucide's keyline paints in it
// (22 of the viewBox's 24 units: CircleHelp, KeyRound, Hourglass). It is what `evenInk` sizes to.
const KIND_GLYPH = 12
const KIND_GLYPH_INK = (KIND_GLYPH * 22) / 24

// `evenInk`: this card's kinds are read against each other (a question card's "Question", "Select
// multiple" and "Secret" stack in one message), so a glyph that paints short is drawn larger until its
// ink is as tall as the others' — see useInkTrim. THE ONE PLACE A KIND GLYPH IS SIZED. The done and
// awaiting cards do not ask for it: their glyphs (Check, ListTodo) were weighed as they are.
export function KindLabel({ icon: Icon, children, className = "text-muted", evenInk = false }: { icon?: LucideIcon; children: ReactNode; className?: string; evenInk?: boolean }) {
  const ref = useInkTrim(Icon, evenInk ? KIND_GLYPH_INK : undefined)
  return (
    <span data-card-kind className={`${CARD_KIND} ${className}`}>
      {Icon && <Icon ref={ref} aria-hidden="true" size={KIND_GLYPH} className="shrink-0" />}
      <span className="min-w-0">{children}</span>
    </span>
  )
}

// The kind line (with any aside at its far right), then the title when there is one, then the rule.
//
// An aside here is a 16px control (a question's ×) whose own `card-icon-offset` centres it on a 16px
// TITLE's cap block; on this 12px line that offset put it 4.63px low, so the head zeroes the variable the
// class reads (the class itself is unlayered CSS, which no utility can outrank) and the row's
// `items-center` places it instead.
//
// THE NUMBERS, measured 2026-10-13 (sans, dsf 2) across Check, Hourglass, TerminalSquare, ListTodo,
// CircleHelp and ListChecks: every glyph's ink centres within 0.23px of the word's cap band, so none takes
// a nudge; `gap-[5px]` puts 5.4–6.1px of ink between glyph and word, the 5.5px the steps chip was approved
// at. The title sits flush under the kind line (no margin): the word's baseline to the title's cap top
// reads 10.7px, close enough to read as one label and its subject, where the 4px first tried read 14.7px
// and floated. The rule then sits 18px under a bare kind's baseline and 20px under a title's, against
// 18.84px from the rule to the body's first cap top.
function KindHead({ icon, kind, kindClass, label, head, aside, ruled, evenInk }: {
  icon?: LucideIcon
  kind: ReactNode
  kindClass: string
  evenInk?: boolean
  label?: ReactNode
  head: string
  aside?: ReactNode
  ruled: boolean
}) {
  const titled = label != null && label !== false
  return (
    <>
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2">
          <KindLabel icon={icon} className={kindClass} evenInk={evenInk}>{kind}</KindLabel>
          {aside && <span className="ml-auto flex shrink-0 items-center [--card-icon-offset:0px]">{aside}</span>}
        </div>
        {titled && (
          <div data-card-title className={`min-w-0 text-[16px] font-semibold leading-6 tracking-tight ${head}`}>{label}</div>
        )}
      </div>
      {ruled && <div aria-hidden data-card-rule className="-mx-4 mt-3.5 border-t border-border" />}
    </>
  )
}

// The card's content. One wrapper so every card spells its top gap the same way, and `card-md` pulls
// any markdown rendered inside down to the card's own body scale (styles.css) — without it a ```done
// bullet list renders at the transcript's 14px prose scale and is visibly larger than the identical
// sentence in the card above it.
//
// UNDER A KIND HEAD the body opens past a full-bleed rule (KindHead draws it) — the same rule the wait
// table's divider and the action footer draw (`-mx-4 … border-t border-border`), so the card reads as
// three bands: what it is, what it says, what to do.
//
// A KIND-HEADED CARD WITH NOTHING BUT ITS ACTION BAND (a bare ```done) draws no rule, and the band's own
// border takes the rule's place at the rule's own distance, so the head reads the same height on every
// card whether a rule or a band closes it. The `band` gap is the whole gap: the band's `mt-3` collapses
// into it.
export function CardContent({ children, gap = "plain" }: { children: ReactNode; gap?: "plain" | "ruled" | "band" }) {
  return <div className={`card-md ${gap === "ruled" ? "mt-3" : gap === "band" ? "mt-3.5" : "mt-1"} min-w-0 text-fg/75`}>{children}</div>
}

// Part one: the SHELL. One rounded panel-2 card at one padding for every kind. Cards used to disagree
// about all three of fill (panel-2 / elevated / an accent or red wash), border color, and whether they
// carried a shadow — which is what made nine sibling cards read as nine unrelated shapes.
//
// Radius and padding are ONE decision, not two, and which rule binds them depends on which is bigger.
// This card spent a day at the CONCENTRIC solve — two nested corners share an arc centre iff
// `cardRadius − buttonRadius == inset`, which at a 13px inset (p-3 + the 1px border) and the standard
// 6px control corner wanted ~19px, and 16px was the closest in-vocabulary token. The maintainer then
// asked for the opposite trade (2026-07-31): less radius, more inset, because 16px "goes a little
// overboard" and the tight inset let the arc crowd the content ("it starts to impinge in expanded
// view"). That inverts the geometry — at p-4 (a 17px inset) and a 12px corner the solve runs NEGATIVE,
// so there is no button radius that could be concentric with this card.
//
// That is not a compromise, it is a different regime, and it is the one to reason in from here: once
// the inset EXCEEDS the radius, the action sits entirely clear of the arc, the two corners never share
// a corner region, and the eye reads them as independent rather than as mismatched. So the button keeps
// the ordinary control corner (CARD_ACTION_RADIUS) and does NOT track this card's radius. Only go back
// to the concentric solve if the inset ever drops below the radius again.
//
// The wider inset is also what makes the corner safe for the card's CONTENT: an arc eats the top-left
// of its own box, so the same 12px/16px pairing is applied to every other block (styles.css
// `--block-radius`, the tool cards in lib/diff/diff.css) rather than to this card alone.
//
// The padding stays UNIFORM, so the bottom gap equals the sides. It reads a touch deeper than an equal
// metric gap under a text line would, because leading donates optical space that a solid filled button
// does not — but the answer to that is not an asymmetric inset, it is that the whole card is now roomy
// enough for the difference to stop registering.
export function TranscriptCard({
  tone = "neutral",
  icon,
  kind,
  label,
  ruled,
  aside,
  children,
  className = "",
  surface = "inset",
  ...rest
}: {
  tone?: CardTone
  /** Optional — see CardHead. A question card carries no corner glyph; every other kind still does. */
  icon?: LucideIcon
  /** The card's KIND as a small line over the title — the second head shape (KindLabel). The glyph leads
   *  that line, and the body opens past a rule. Absent, the card keeps the glyph-beside-title head. */
  kind?: ReactNode
  /** The title. Under a kind it may be absent: the kind alone heads the card. */
  label: ReactNode
  /** Whether a kind head rules its body off. Defaults to whether the card HAS a body; a card whose only
   *  content is its CardActions band passes false, or the rule and the band's own border draw two seams
   *  around nothing (a ```done fence with an empty body, under its Mark-as-done). The band's border then
   *  sits where the rule would have (CardContent's `band` gap). */
  ruled?: boolean
  // Optional trailing slot at the title row's far right: the one thing the card is ABOUT, when that is a short reference rather than
  // prose (the wake card's `owner/repo#N` link). It rides the title instead of taking a body line of
  // its own, which keeps the body for the card's actual content.
  aside?: ReactNode
  // Optional, because one card is legitimately its own headline: the GitHub wake card for a SINGLE
  // item says everything it has in the title row ("New comment from @pullfrog[bot]"), and an empty
  // CardContent would still spend its top gap on nothing. The padding then reads as a one-line card
  // rather than as a card missing its body.
  children?: ReactNode
  className?: string
  surface?: "inset" | "question"
} & Omit<ComponentPropsWithoutRef<"div">, "children" | "className">) {
  const { border, head } = CARD_TONES[tone]
  const rule = kind != null && (ruled ?? children != null)
  return (
    <div {...rest} className={`min-w-0 ${BLOCK_RADIUS} border ${surface === "question" ? "border-question-border bg-question" : `${border} bg-panel-2`} p-4 ${className}`}>
      {kind != null
        ? <KindHead icon={icon} kind={kind} kindClass={tone === "neutral" ? "text-muted" : head} label={label} head={tone === "neutral" ? head : CARD_TONES.neutral.head} aside={aside} ruled={rule} evenInk={surface === "question"} />
        : <CardHead icon={icon} label={label} head={head} aside={aside} />}
      {children != null && <CardContent gap={kind == null ? "plain" : rule ? "ruled" : "band"}>{children}</CardContent>}
    </div>
  )
}

// Part two: the body copy — shadcn's AlertDescription. One scale for every card's sentence, so a
// two-line explanation in one card is not visibly larger than the same sentence in the card above it,
// and one step down in strength from the title so the hierarchy inside the card is unmistakable.
export const CARD_BODY = "block min-w-0 text-[13px] leading-5 text-fg/75"

// Part three: the action FOOTER — a recessed full-width band flush with the card's bottom corners, the
// same shape on every card that has a verb. It was a bare button row sitting in the body on every card
// but one: the awaiting card alone drew its Snooze in a band like this (2026-08-31), so a done card's
// "Mark as done" and an awaiting card's "Snooze" sat in two different shapes one card apart (maintainer
// 2026-09-30: "the footer actually looks a lot better… these cards just need to have visual
// consistency"). The band is now this component, and the awaiting card renders through it too.
//
// It must be the card's LAST child. The negative margins pull it out through the shell's `p-4` on
// three sides — `-mb-4` cancels the shell's bottom padding, so no card has to know whether it ended in
// a band — and it takes the shell's INNER corner (BLOCK_RADIUS_INNER_BOTTOM) so its fill cannot paint
// out through the arc and erase the border there.
//
// Contents stay LEFT-justified (maintainer 2026-07-29): every card's action starts at the same x as its
// title and its body copy, so the eye finds the verb on the one vertical line the whole card is built
// on — rather than tracking to a right edge whose position moves with the card's width.
//
// Explanatory copy for the action (the awaiting card's "Hides card until new activity is detected") goes IMMEDIATELY TO THE RIGHT
// of its button and is centered against it, so the pair reads as one control with its caption rather
// than as a sentence the button happens to sit near. `items-center` is what holds that alignment; the
// explainer takes the leftover width and wraps its own lines there (`flex-1 min-w-0`) instead of
// pushing the button onto a line of its own on a narrow queue card.
export function CardActions({ children, className = "", ...rest }: { children: ReactNode; className?: string } & Omit<ComponentPropsWithoutRef<"div">, "children" | "className">) {
  return (
    <div
      {...rest}
      data-card-actions
      className={`-mx-4 -mb-4 mt-3 flex flex-wrap items-center justify-start gap-x-2.5 gap-y-2 border-t border-border bg-fg/[0.03] px-4 py-2.5 ${BLOCK_RADIUS_INNER_BOTTOM} ${className}`}
    >
      {children}
    </div>
  )
}

// The explainer that sits beside a card's action. Exported so every card spells its caption the same
// way instead of re-deriving the muted scale and the flex behavior at each call site.
export const CARD_ACTION_EXPLAINER = "min-w-0 flex-1 text-[11px] leading-snug text-muted-70"

// A LINK inside a card — the app's link language, straight off `.md-body a` in styles.css: accent,
// underlined, 2px offset. A link has to LOOK like one at rest; `text-fg` with a hover-only underline
// reads as a plain label, and nobody hovers a label to find out. Shared by every card that carries a
// GitHub reference (the wake card's title-row ref, the awaiting card's watched PRs) so a ref renders
// identically wherever the human meets it.
export const CARD_LINK = "text-accent underline underline-offset-2 decoration-accent/40 hover:decoration-accent"

// The primary (light-on-dark) verb EVERY card's main action wears — the done card's white
// "Mark as done" chrome. Exported because this is a rule, not a per-card choice (maintainer 2026-07-24:
// the buttons inside these cards should ALWAYS be white): a card is a request for one action, and the
// recessed outlined chrome some of them wore read as a secondary — or worse, disabled — affordance.
// The ONLY departure is a genuinely secondary sibling standing beside the primary (the provider-fault
// card's "Retry" next to "Sign in"), which stays outlined so the pair keeps a hierarchy.
export const CARD_PRIMARY_BUTTON = "bg-fg px-2.5 py-1 text-bg hover:opacity-90"
// The corner a card's action wears — the ordinary control radius, and now an INDEPENDENT one. It used
// to be the dependent term of `cardRadius − buttonRadius == inset`; at the current p-4 inset and 12px
// card corner that solve runs negative, so the button no longer has a concentric target to hit and the
// card's arc no longer reaches it (see the shell above). Squaring it off was tried under the old
// geometry and rejected as "a little too pointy" (maintainer 2026-07-31), which is the other reason it
// stays here. Do not re-derive it from the card's radius unless the inset drops back below it.
export const CARD_ACTION_RADIUS = "rounded-md"
// The same verb with the icon+label layout every card action uses. Cards differ only in what they pass
// beyond this (shrink-0, a disabled treatment), never in the fill.
export const CARD_PRIMARY_ACTION = `flex shrink-0 items-center gap-1 ${CARD_ACTION_RADIUS} text-[11px] font-medium outline-none transition-colors focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${CARD_PRIMARY_BUTTON}`
