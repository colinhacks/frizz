// THE MOBILE MOCKUP KIT — device chrome and the control vocabulary every screen in
// `mobile-mockup-fixture.tsx` is assembled from.
//
// Not shipped UI. This is a DESIGN SURFACE, in the shape `awaiting-mockups-fixture.tsx` established:
// everything renders in the app's REAL stylesheet, on the app's REAL tokens, so a decision made here
// is a decision about the thing that would ship.
//
// ── The one deliberate break with the desktop app ──────────────────────────────────────────────────
// The desktop board is a 13px/19px information surface read at monitor distance with a mouse. A phone
// is read at arm's length and driven with a thumb, so this mockup adopts iOS's type scale and touch
// floor instead of shrinking the desktop one:
//
//     17px  screen title / card title            (iOS body & headline)
//     15px  card title in a dense list, row label
//     13px  secondary line, gloss, activity
//     11.5px caption, rest time, chip
//     44px  minimum hit target, every control     (Apple HIG)
//
// Everything else is the app's own: the colour tokens, `--block-radius`, the Obsidian-style checkbox
// status family, the accent-means-"awaiting you" law, and the Rested/Active/Snoozed/Done band names.
import type { ReactNode } from "react"
import { Check, ChevronRight } from "lucide-react"

// ── optical spacing: the trims, with their readings ─────────────────────────────────────────────
//
// A `gap` spaces BOXES and a small glyph is mostly empty box, so one uniform gap draws several
// distances. MEASURED here with `scripts/ink-gaps.mjs --dsf=4 --pad=3` on this fixture at 390pt, every
// CSS gap 6px, on the home card's own status line:
//
//     live dot   → "2 active"    5.50px of ink      ← the same gap…
//     hourglass  → "1 held"      8.50px of ink      ← …drawn 55% wider
//
// Per-mark dead space, which is where the spread comes from and what these constants undo:
//
//     live dot (6px + 1px halo)   deadL/R  −1.25   the halo paints OUTSIDE the box, so its ink is wider
//     Hourglass @ 11px            deadL/R  +1.75   lucide paints 7.5 of its 11 box px
//     ChevronRight @ 12px         deadL/R  +2.50   a chevron is the emptiest box in the set
//     a text run                  deadL     0.75   left side bearing, and it is the same for every label
//
// So each GLYPH is collapsed onto its own ink and the text is left alone — a 0.75px bearing is what
// every label carries against every other label, and trimming prose is how a column stops lining up.
// With that done, `gap-1.5` means ~6.75px of ink for a dot and for an hourglass alike.
//
// Re-measure rather than re-guess if a size moves: these are readings, not taste.
export const INK = {
  /** The 6px liveness dot with its 1px halo — ink overflows the box, so the footprint GROWS. */
  dot: "mx-[1.25px]",
  /** lucide Hourglass at 11px. */
  hourglass: "-mx-[1.75px]",
  /** lucide ChevronRight at 12px, upright or rotated (the rotation does not change its ink width). */
  chevron12: "-mx-[2.5px]",
}

// ── vertical ink alignment ──────────────────────────────────────────────────────────────────────
//
// A mark beside text is aligned to the CAP BAND — baseline to cap height — because that is the band
// the eye reads as "the line of text". `1cap` is the resolved font's own cap height, so a correction
// written against it is right in BOTH of this app's fonts with nothing to re-measure when the setting
// flips.
//
// THE ARITHMETIC, once, because the obvious constant is wrong for most marks. `self-baseline` puts a
// non-text mark's BOTTOM MARGIN EDGE on the text baseline, so a mark whose box is S tall has its ink
// centre at `baseline − S/2` (a symmetric halo cancels). The cap band's centre is `baseline − cap/2`.
// So the lift is:
//
//     translateY( S/2 − 0.5cap )
//
// `0.5em − 0.5cap` — which is what this file used to hard-code for everything — is that formula with
// S pinned to 1em, and it is therefore only correct for a mark that is exactly 1em tall. Applied to a
// fixed 6px dot beside 12.5px text it is not a small error: MEASURED at +1.85px in the wrong
// direction, which is most of the "the dot indicators are all way too low" the maintainer read off the
// board (2026-08-17). It is a per-mark size, so it cannot be a shared class.
//
// One more trap, and it is what actually broke these dots: WRAPPING the mark in a `flex` span makes it
// a flex item of the WRAPPER, so `self-baseline` aligns it inside that box instead of against the
// row's shared baseline — and the row then takes its baseline from the wrapper's bottom edge. Measured
// −3.32px on the child-op rows. Never wrap an aligned mark; put the hook on the mark itself.
export const CAP_ALIGN = "shrink-0 self-baseline"
/** The lift for a mark whose box is `size` px tall, sitting on the baseline of a row's text. */
export function capAlign(size: number): { translate: string } {
  return { translate: `0 calc(${size / 2}px - 0.5cap)` }
}
/** The 1em case, kept as a class for marks that really are 1em (a text glyph in the prose flow). */
export const ON_CAP = "shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]"

// ── device ──────────────────────────────────────────────────────────────────────────────────────
/** iPhone 15 Pro logical points. Every screen is drawn at 1:1 in these. */
export const SCREEN_W = 390
export const SCREEN_H = 844
/** Status bar / home-indicator safe areas, in points, as iOS reports them on a Dynamic Island phone. */
export const SAFE_TOP = 59
export const SAFE_BOTTOM = 34

/** The OS status bar: 9:41 (Apple's own mockup time), the Dynamic Island, and the three right glyphs. */
function IOSStatusBar() {
  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-40 h-[59px]">
      {/* The Dynamic Island. A real cut-out, so it is drawn in the page background rather than any
          panel colour — content must never rely on being able to paint here. */}
      <div className="absolute left-1/2 top-[11px] h-[37px] w-[125px] -translate-x-1/2 rounded-full bg-black" />
      <div className="flex h-[54px] items-center justify-between px-[29px] pt-[6px] text-[15px] font-semibold tracking-[-0.01em] text-fg">
        <span className="tabular-nums">9:41</span>
        <span className="flex items-center gap-[7px]">
          {/* cellular */}
          <svg width="18" height="12" viewBox="0 0 18 12" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <rect key={i} x={i * 4.6} y={9 - i * 2.7} width="3" height={3 + i * 2.7} rx="1" fill="currentColor" />
            ))}
          </svg>
          {/* wifi */}
          <svg width="16" height="12" viewBox="0 0 16 12" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
            <path d="M1 4.2a10 10 0 0 1 14 0" />
            <path d="M3.7 7a6.2 6.2 0 0 1 8.6 0" />
            <path d="M6.4 9.7a2.4 2.4 0 0 1 3.2 0" />
          </svg>
          {/* battery */}
          <svg width="26" height="13" viewBox="0 0 26 13" aria-hidden>
            <rect x="0.6" y="0.6" width="21" height="11.8" rx="3.6" fill="none" stroke="currentColor" strokeOpacity="0.38" />
            <rect x="2.4" y="2.4" width="14" height="8.2" rx="2" fill="currentColor" />
            <path d="M23.4 4.6v3.8a2.1 2.1 0 0 0 0-3.8Z" fill="currentColor" fillOpacity="0.4" />
          </svg>
        </span>
      </div>
    </div>
  )
}

/** The home indicator. Drawn ABOVE everything so a sheet or a dock never buries the system affordance. */
function HomeIndicator({ tone = "bg-fg/40" }: { tone?: string }) {
  return <div className={`pointer-events-none absolute bottom-[8px] left-1/2 z-50 h-[5px] w-[139px] -translate-x-1/2 rounded-full ${tone}`} />
}

/**
 * One phone.
 *
 * `id` is what `?screen=<id>` selects, and what `scripts/shot.mjs --clip` targets. In the gallery the
 * frame wears a caption and a bezel; on its own it is exactly 390×844 so a shot is the screen and
 * nothing else.
 */
export function Phone({
  id,
  title,
  note,
  solo,
  children,
}: {
  id: string
  title: string
  note?: string
  solo?: boolean
  children: ReactNode
}) {
  return (
    <figure className="m-0 flex w-[390px] shrink-0 flex-col gap-3">
      {!solo && (
        <figcaption className="flex flex-col gap-1 px-1">
          <span className="text-[13px] font-semibold text-fg">{title}</span>
          {note ? <span className="text-[11.5px] leading-snug text-muted">{note}</span> : null}
        </figcaption>
      )}
      <div
        data-screen={id}
        className="relative isolate overflow-hidden rounded-[54px] bg-bg"
        style={{
          width: SCREEN_W,
          height: SCREEN_H,
          // The bezel: a hairline the frame paints itself, so the mockup reads as a device without a
          // second element having to line up with the corner radius.
          boxShadow: solo ? "none" : "0 0 0 1px #26282d, 0 40px 80px -20px rgba(0,0,0,0.8)",
        }}
      >
        <IOSStatusBar />
        {children}
        <HomeIndicator />
      </div>
    </figure>
  )
}

/** The scrolling content area of a screen: everything between the two safe areas. */
export function Canvas({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`absolute inset-0 flex flex-col overflow-hidden ${className}`}>
      {children}
    </div>
  )
}

// ── navigation ──────────────────────────────────────────────────────────────────────────────────
/**
 * The iOS navigation bar, in its two states.
 *
 * `large` is the at-rest state: a 34px title sitting in the content, which collapses into the compact
 * inline title as the list scrolls under it. Mocking both is the point — the collapse is most of what
 * makes a list screen feel native, and it is the first thing a web port drops.
 */
export function NavBar({
  back,
  title,
  subtitle,
  trailing,
  leading,
  translucent = true,
  border = true,
}: {
  back?: string
  title?: ReactNode
  subtitle?: ReactNode
  trailing?: ReactNode
  leading?: ReactNode
  translucent?: boolean
  border?: boolean
}) {
  return (
    <div
      className={`relative z-30 shrink-0 pt-[59px] ${border ? "border-b border-border/70" : ""} ${
        translucent ? "bg-bg/80 backdrop-blur-xl backdrop-saturate-150" : "bg-bg"
      }`}
    >
      <div className="flex h-[44px] items-center gap-1 px-2">
        <div className="flex min-w-0 flex-1 items-center">
          {back ? (
            <button className="-ml-1 flex h-[44px] items-center gap-0.5 pl-1 pr-2 text-[17px] text-fg/85">
              <svg width="12" height="20" viewBox="0 0 12 20" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M10 2 2.5 10 10 18" />
              </svg>
              <span className="truncate tracking-[-0.01em]">{back}</span>
            </button>
          ) : (
            leading
          )}
        </div>
        {title ? (
          <div className="pointer-events-none absolute inset-x-0 top-[59px] flex h-[44px] flex-col items-center justify-center px-[76px]">
            <span className="max-w-full truncate text-[16px] font-semibold tracking-[-0.01em] text-fg">{title}</span>
            {subtitle ? <span className="max-w-full truncate text-[11px] leading-tight text-muted">{subtitle}</span> : null}
          </div>
        ) : null}
        <div className="flex shrink-0 items-center justify-end gap-1">{trailing}</div>
      </div>
    </div>
  )
}

/** A 44×44 bare-glyph nav action. The box is the hit target; the glyph is what you see. */
export function NavAction({ children, tone = "text-fg/85", label }: { children: ReactNode; tone?: string; label?: string }) {
  return (
    <button aria-label={label} className={`flex h-[44px] w-[44px] items-center justify-center rounded-full ${tone} active:bg-white/[0.06]`}>
      {children}
    </button>
  )
}

/** The big title that sits in the scroll content and collapses into the nav bar. */
export function LargeTitle({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex items-end justify-between gap-3 px-5 pb-2 pt-1">
      <h1 className="text-[34px] font-bold leading-[41px] tracking-[-0.022em] text-fg">{children}</h1>
      {trailing}
    </div>
  )
}

// ── lists ───────────────────────────────────────────────────────────────────────────────────────
// FULL-WIDTH, NOT INSET-GROUPED (maintainer 2026-08-17: "Why do you even use cards here? Why not have
// it go full width to save us more real estate? The cards just kind of make it so that we have to have
// two sets of padding or padding and margin, and it's not necessary").
//
// This is iOS's PLAIN grouped table rather than its inset one, and on a 390pt viewport the difference
// is real: an inset card spends 32pt on side margins and then 32pt again on its own padding, so a
// thread title gets 326pt of measure instead of the 358pt it could have. The section header and the
// hairline carry the grouping; the card was only ever drawing a box around it.

/** A section header above a list: 13px, sentence case, in the muted tone. */
export function GroupHeader({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 px-4 pb-1.5 pt-4">
      <span className="text-[13px] font-medium text-muted">{children}</span>
      {trailing ? <span className="text-[13px] text-muted-70">{trailing}</span> : null}
    </div>
  )
}

/**
 * A list section: edge to edge, hairline top and bottom, no radius and no margin.
 *
 * The separators BETWEEN its rows are inset to the text column (see RowRule) while the section's own
 * top and bottom rules run the full width — that contrast is what says "these rows are one group"
 * without a border drawn around them.
 */
export function Group({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`border-y border-border/70 bg-panel/60 ${className}`}>{children}</div>
}

export function Row({
  icon,
  iconTint,
  label,
  detail,
  value,
  chevron,
  trailing,
  tone = "text-fg",
  inset = true,
  active,
}: {
  icon?: ReactNode
  /** The rounded tinted square iOS puts a settings glyph in. */
  iconTint?: string
  label: ReactNode
  detail?: ReactNode
  value?: ReactNode
  chevron?: boolean
  trailing?: ReactNode
  tone?: string
  inset?: boolean
  active?: boolean
}) {
  return (
    <div className={`flex min-h-[48px] items-center gap-3 pl-4 pr-3.5 ${active ? "bg-white/[0.04]" : ""}`}>
      {icon ? (
        iconTint ? (
          <span className={`flex h-[29px] w-[29px] shrink-0 items-center justify-center rounded-[7px] ${iconTint}`}>{icon}</span>
        ) : (
          <span className="flex w-[22px] shrink-0 items-center justify-center text-muted">{icon}</span>
        )
      ) : null}
      <div className={`flex min-w-0 flex-1 flex-col gap-0.5 py-2 ${inset && icon ? "" : ""}`}>
        <span className={`truncate text-[16px] leading-[21px] tracking-[-0.01em] ${tone}`}>{label}</span>
        {detail ? <span className="truncate text-[12.5px] leading-[16px] text-muted">{detail}</span> : null}
      </div>
      {value ? <span className="shrink-0 text-[15px] text-muted">{value}</span> : null}
      {trailing}
      {chevron ? <ChevronRight size={17} className="shrink-0 text-muted-50" /> : null}
    </div>
  )
}

/** The hairline between two rows, inset past the icon column exactly as iOS draws it. */
export function RowRule({ inset = 16 }: { inset?: number }) {
  return <div className="h-px bg-border/70" style={{ marginLeft: inset }} />
}

// ── controls ────────────────────────────────────────────────────────────────────────────────────
/**
 * Buttons, in the four weights this app actually needs.
 *
 * `accent` is spent ONLY on the verb that answers Frizz — send, dispatch, answer. The accent means
 * "awaiting you" everywhere else in the product, so a second accent button on the same screen would
 * make the reader hunt for which one is the ask.
 */
export function Button({
  kind = "filled",
  size = "md",
  full,
  children,
  className = "",
}: {
  kind?: "filled" | "accent" | "tinted" | "plain" | "destructive"
  size?: "sm" | "md" | "lg"
  full?: boolean
  children: ReactNode
  className?: string
}) {
  const tone =
    kind === "accent"
      ? "bg-accent text-bg font-semibold active:brightness-90"
      : kind === "filled"
        ? "bg-fg text-bg font-semibold active:opacity-85"
        : kind === "tinted"
          ? "bg-elevated text-fg border border-border-strong active:bg-panel-2"
          : kind === "destructive"
            ? "bg-danger-fill/12 text-danger-soft border border-danger-fill/30 active:bg-danger-fill/20"
            : "text-fg/85 active:opacity-60"
  const box =
    size === "lg"
      ? "h-[50px] rounded-[14px] px-5 text-[17px]"
      : size === "sm"
        ? "h-[32px] rounded-[10px] px-3 text-[13px]"
        : "h-[44px] rounded-[12px] px-4 text-[15px]"
  return (
    <button className={`inline-flex items-center justify-center gap-1.5 tracking-[-0.01em] transition-[opacity,filter,background-color] ${box} ${tone} ${full ? "w-full" : ""} ${className}`}>
      {children}
    </button>
  )
}

/** The iOS segmented control: a track, a raised knob on the selected cell. */
export function Segmented({ options, value, className = "" }: { options: string[]; value: string; className?: string }) {
  return (
    <div className={`flex h-[32px] items-center gap-0.5 rounded-[9px] bg-elevated p-[2px] ${className}`}>
      {options.map((option) => (
        <span
          key={option}
          className={`flex h-full flex-1 items-center justify-center rounded-[7px] px-2 text-[13px] tracking-[-0.01em] ${
            option === value ? "bg-panel-2 font-medium text-fg shadow-sm shadow-black/40" : "text-muted"
          }`}
        >
          {option}
        </span>
      ))}
    </div>
  )
}

/** The iOS switch, at its real 51×31. */
export function Toggle({ on }: { on?: boolean }) {
  return (
    <span className={`relative block h-[31px] w-[51px] shrink-0 rounded-full transition-colors ${on ? "bg-live" : "bg-[#3a3d44]"}`}>
      <span
        className={`absolute top-[2px] block h-[27px] w-[27px] rounded-full bg-white shadow-sm shadow-black/40 transition-[left] ${
          on ? "left-[22px]" : "left-[2px]"
        }`}
      />
    </span>
  )
}

/** A small capsule of metadata — a profile, a count, a runtime. */
export function Chip({ children, tone = "text-muted", className = "" }: { children: ReactNode; tone?: string; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-baseline gap-1 rounded-full border border-border/80 bg-panel-2 px-2 py-[3px] text-[11.5px] leading-[14px] ${tone} ${className}`}>
      {children}
    </span>
  )
}

// ── the status family, at touch size ────────────────────────────────────────────────────────────
// The app's rail draws every thread state as ONE rounded-rect checkbox with a glyph inside it
// (BoxSpinner.tsx / styles.css `.md-task`), 15px on the desktop. On a phone the same family is drawn
// at 18px: it is a READING mark rather than a target, so it grows with the type around it (15px title →
// 18px box) instead of to the 44px touch floor, which belongs to the row that contains it.
export const MOBILE_BOX = 18

export function StatusBox({ children, tone = "border-muted/45", size = MOBILE_BOX }: { children?: ReactNode; tone?: string; size?: number }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center justify-center border ${tone}`}
      // The radius is the rail's 4-in-15, kept as a ratio so the mark stays the same SHAPE at the tab
      // bar's larger size instead of reading as a rounder box.
      style={{ width: size, height: size, borderRadius: (size * 4) / 15 }}
    >
      {children}
    </span>
  )
}

/** [/] in progress — the rail's own rounded-rect spinner, at mobile size. */
export function BoxSpinnerM({ size = MOBILE_BOX, tone = "text-muted-85", frozen }: { size?: number; tone?: string; frozen?: boolean }) {
  // `frozen` stops the travelling segment at the phase where it READS BEST — wrapped around the
  // top-right CORNER rather than lying along the flat top edge, where a brighter run of the outline
  // just looks like the outline. A still of a running spinner is otherwise a coin flip between
  // "obviously spinning" and "identical to the empty at-rest box", and in a printed control gallery
  // that is not a coin worth tossing. (The shipped mark animates; only the still needs this.)
  return (
    <svg width={size} height={size} viewBox="0 0 15 15" aria-hidden className={`shrink-0 ${tone}`}>
      <rect x="0.5" y="0.5" width="14" height="14" rx="3.5" fill="none" stroke="currentColor" strokeOpacity="0.5" strokeWidth="1" />
      <rect
        x="0.5" y="0.5" width="14" height="14" rx="3.5" fill="none" stroke="currentColor" strokeWidth="1"
        strokeLinecap="round" strokeDasharray="11 39" strokeDashoffset={frozen ? 44 : undefined}
      >
        {frozen ? null : <animate attributeName="stroke-dashoffset" from="50" to="0" dur="1.1s" repeatCount="indefinite" />}
      </rect>
    </svg>
  )
}

/**
 * [▶] the QUEUE's mark — a static play triangle in the family's box.
 *
 * The tab bar used to draw the running spinner here and it was the wrong instrument for the job
 * (maintainer 2026-08-17: "We cannot have the tab icon for the active tab be continuously spinning.
 * That's awful… better yet, a play button. A play button makes the most sense"). A row's spinner
 * animates because THAT thread is moving right now; a tab is permanent chrome, and permanent motion in
 * the corner of the eye is noise. Play says "this is the band where work is in flight" without moving.
 */
export function PlayBox({ size = MOBILE_BOX }: { size?: number }) {
  return (
    <StatusBox size={size} tone="border-muted/45">
      {/* Optically centred, not geometrically: a triangle's visual centre sits behind its centroid, so
          a play glyph centred on its bounding box always reads as leaning left. The 8% nudge is the
          convention every media player uses. */}
      <svg width={Math.round(size * 0.52)} height={Math.round(size * 0.52)} viewBox="0 0 10 10" aria-hidden className="translate-x-[8%] text-muted-85">
        <path d="M2.5 1.4 8.2 5 2.5 8.6Z" fill="currentColor" />
      </svg>
    </StatusBox>
  )
}

/** [?] awaiting you — the one mark that spends the accent, because the accent IS the ask. */
export function AskBox({ size = MOBILE_BOX }: { size?: number }) {
  return (
    <StatusBox size={size} tone="border-accent/90">
      <span className="font-sans font-bold leading-none text-accent" style={{ fontSize: (size * 10) / 15 }}>?</span>
    </StatusBox>
  )
}

/** [x] done. */
export function DoneBox({ size = MOBILE_BOX }: { size?: number }) {
  return (
    <StatusBox size={size} tone="border-muted/40">
      <Check size={Math.round((size * 10) / 15)} strokeWidth={3} className="text-muted-85" />
    </StatusBox>
  )
}

/** The liveness dot, in the app's three runtime hues: agent (accent), shell (blue), PR watch (violet). */
export function LiveDot({ kind = "agent", quiet, ink }: { kind?: "agent" | "shell" | "github"; quiet?: boolean; ink?: string }) {
  // The quiet variant carries its OWN hue modifier (`.frizz-live-dot-quiet--shell`), not the bright
  // dot's — composing `frizz-live-dot-quiet` with `frizz-live-dot--shell` silently leaves the quiet dot
  // on its accent default, which is how a background shell came out yellow.
  //
  // The dot aligns ITSELF and carries its own `data-ink` hook, so no caller ever needs to wrap it — see
  // the flex-item trap in the CAP_ALIGN note above, which is exactly what a measurement wrapper caused.
  const base = quiet ? "frizz-live-dot-quiet" : "frizz-live-dot"
  return <span data-ink={ink} className={`${base} ${base}--${kind} ${CAP_ALIGN} ${INK.dot}`} style={capAlign(6)} />
}

// ── sheets ──────────────────────────────────────────────────────────────────────────────────────
/**
 * A bottom sheet at a detent, over a dimmed and slightly receded parent.
 *
 * THE PARENT SCALES BACK. iOS's sheet presentation pushes the presenting screen to ~93% with its own
 * top corners rounded, which is the cue that says "this is a layer, and there is something behind it".
 * A flat scrim alone reads as a modal dialog — the wrong promise for something you dismiss by
 * flicking down.
 */
export function SheetOver({
  children,
  detent = 0.58,
  grabber = true,
  behind,
  scrim = "bg-black/45",
}: {
  children: ReactNode
  /** Fraction of the screen the sheet covers. iOS's stock detents are ~0.5 (medium) and ~0.93 (large). */
  detent?: number
  grabber?: boolean
  behind: ReactNode
  scrim?: string
}) {
  return (
    <>
      {/* The receded parent. `origin-top` + scale is what UIKit does to the presenting view — plus a
          small downward shift, because at the LARGE detent the sheet covers everything the scale alone
          left visible, and a stack you cannot see the back of reads as one flat screen. The hairline is
          what makes the surviving 20-odd points read as the top edge of a card rather than as padding. */}
      <div className="absolute inset-0 origin-top translate-y-[10px] scale-[0.925] overflow-hidden rounded-[38px] border-t border-border/60">
        {behind}
      </div>
      <div className={`absolute inset-0 ${scrim}`} />
      <div
        className="absolute inset-x-0 bottom-0 z-40 flex flex-col overflow-hidden rounded-t-[14px] border-t border-border-strong bg-panel shadow-[0_-20px_60px_-10px_rgba(0,0,0,0.8)]"
        style={{ height: `${Math.round(detent * SCREEN_H)}px` }}
      >
        {grabber ? <div className="mx-auto mt-[6px] h-[5px] w-[36px] shrink-0 rounded-full bg-muted/35" /> : null}
        {children}
      </div>
    </>
  )
}

/** A sheet's own title bar — the one place a sheet may carry a Cancel/Done pair. */
export function SheetHeader({ title, leading, trailing }: { title: ReactNode; leading?: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border/70 px-3">
      <div className="flex min-w-0 flex-1 items-center">{leading}</div>
      <span className="shrink-0 text-[16px] font-semibold tracking-[-0.01em] text-fg">{title}</span>
      <div className="flex min-w-0 flex-1 items-center justify-end">{trailing}</div>
    </div>
  )
}

// ── the tab bar ─────────────────────────────────────────────────────────────────────────────────
/**
 * THE BOARD'S BANDS, AS TABS (maintainer 2026-08-17: "having this rested versus active versus held
 * stuff kind of feels like that should just be some kind of tab switcher, essentially like a view
 * controller tab view controller along the bottom").
 *
 * It buys the thing a phone is shortest of. Four stacked bands with headers spend ~150pt of a 844pt
 * screen on labels and rules for sections that are mostly not the one you are reading; four tabs spend
 * 49pt once, and the band you ARE reading gets the whole screen.
 *
 * THE ICONS ARE THE STATUS FAMILY ITSELF — the same rounded-rect checkbox the rail draws beside every
 * thread, with the same glyph inside it. The tab for Snoozed is the mark a snoozed row wears. So the tab bar
 * doubles as the legend for the list above it, and there is no second visual language to learn.
 *
 * THE BADGE IS TWO DIFFERENT NUMBERS, and the colour is what says which. Muted = how many threads are
 * in that band, which is information. Accent = how many of them are WAITING ON YOU, which is the only
 * thing the accent ever means anywhere in this product. So a grey 6 on Done reads "six finished" and a
 * yellow 3 on Rested reads "three want you", with the band's own length left to the list itself. One
 * number in two roles is a compromise, but a second numeral per tab in a 97pt cell is not a design.
 */
export function TabBar({
  tabs,
  active,
}: {
  tabs: { id: string; label: string; icon: ReactNode; count: number; asks?: boolean }[]
  active: string
}) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-30 border-t border-border/70 bg-bg/85 pb-[34px] backdrop-blur-xl backdrop-saturate-150">
      <div className="flex h-[49px] items-stretch">
        {tabs.map((tab) => {
          const on = tab.id === active
          return (
            <button key={tab.id} className="flex flex-1 flex-col items-center justify-center gap-[3px] pt-[3px]">
              <span className={`relative ${on ? "opacity-100" : "opacity-55"}`}>
                {tab.icon}
                {tab.count > 0 ? (
                  <span
                    className={`absolute -right-[11px] -top-[7px] flex h-[16px] min-w-[16px] items-center justify-center rounded-full border-[1.5px] border-bg px-[3.5px] text-[10px] font-semibold tabular-nums ${
                      tab.asks ? "bg-accent text-bg" : "bg-elevated text-muted"
                    }`}
                  >
                    {tab.count}
                  </span>
                ) : null}
              </span>
              <span className={`text-[10px] leading-[12px] tracking-[-0.005em] ${on ? "text-fg" : "text-muted-70"}`}>
                {tab.label}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The floating compose button (maintainer 2026-08-17: "For creating a new thread, there can just be a
 * floating arrow or feather icon in the bottom right… maybe a plus sign, actually, which is kind of the
 * classic mobile idiom for that").
 *
 * NOT ACCENT, deliberately. A FAB is the loudest mark on the screen it sits on, and yellow here means "a
 * worker is waiting for you" — an always-present yellow circle would out-shout every ask in the list
 * below it. It takes the app's own primary-button fill instead (`bg-fg text-bg`, the same one
 * TranscriptCard's CARD_PRIMARY_BUTTON uses), which reads as the primary action without spending the
 * one colour that carries meaning.
 */
export function Fab({ bottom = 99 }: { bottom?: number }) {
  return (
    <button
      aria-label="New thread"
      className="absolute right-4 z-30 flex size-[56px] items-center justify-center rounded-full bg-fg text-bg shadow-lg shadow-black/50 active:opacity-85"
      style={{ bottom }}
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
        <path d="M12 5v14" />
        <path d="M5 12h14" />
      </svg>
    </button>
  )
}

// ── the keyboard ────────────────────────────────────────────────────────────────────────────────
/**
 * The system keyboard, drawn because a composer screen is a LIE without it.
 *
 * A dispatch form that photographs beautifully in 844 points has 553 to work with once the keyboard is
 * up, and every control below that line is one the writer cannot see while writing. Mocking the
 * keyboard is what makes that constraint visible while there is still time to design around it.
 */
export function Keyboard({ accessory }: { accessory?: ReactNode }) {
  const rows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"]
  return (
    <div className="absolute inset-x-0 bottom-0 z-30">
      {accessory}
      <div className="bg-[#1c1d21] pb-[34px] pt-[9px]">
        {rows.map((row, index) => (
          <div key={row} className={`mb-[11px] flex justify-center gap-[6px] ${index === 1 ? "px-[21px]" : "px-[3px]"}`}>
            {index === 2 ? <KeyWide glyph="⇧" /> : null}
            {[...row].map((letter) => (
              <span
                key={letter}
                className="flex h-[42px] w-[31px] items-center justify-center rounded-[5px] bg-[#4b4c50] text-[21px] font-normal text-white shadow-[0_1px_0_rgba(0,0,0,0.45)]"
              >
                {letter}
              </span>
            ))}
            {index === 2 ? <KeyWide glyph="⌫" /> : null}
          </div>
        ))}
        <div className="mb-[6px] flex justify-center gap-[6px] px-[3px]">
          <span className="flex h-[42px] w-[86px] items-center justify-center rounded-[5px] bg-[#2f3034] text-[15px] text-white">
            123
          </span>
          <span className="flex h-[42px] flex-1 items-center justify-center rounded-[5px] bg-[#4b4c50] text-[15px] text-white">
            space
          </span>
          {/* `return`, not a tinted `send`. The composer is MULTILINE — a task description runs to a
              paragraph — so the key inserts a newline, and iOS only tints (and relabels) it where the
              field submits on return. Tinting it here would also put a second accent verb on a screen
              whose Dispatch button is already the one. */}
          <span className="flex h-[42px] w-[86px] items-center justify-center rounded-[5px] bg-[#2f3034] text-[15px] text-white">
            return
          </span>
        </div>
      </div>
    </div>
  )
}

function KeyWide({ glyph }: { glyph: string }) {
  return (
    <span className="flex h-[42px] w-[42px] items-center justify-center rounded-[5px] bg-[#2f3034] text-[17px] text-white">
      {glyph}
    </span>
  )
}

// ── the docked composer ─────────────────────────────────────────────────────────────────────────
/**
 * THE REPLY BOX, docked — and it belongs to ONE THREAD, never to the board.
 *
 * It used to dock on the board as a new-thread prompt, with the desktop composer's ⤷ running-ops column
 * above it. That was wrong twice over (maintainer 2026-08-17): a liveness indicator "is the kind of
 * thing that we would show attached to a currently running thread. It doesn't make sense to have an
 * indicator like that above just the equivalent of the sidebar prompt box, which is used to trigger a
 * totally new action." Starting a thread is now the floating + button; live work is drawn where it
 * lives, on the running thread's own row (the ⤷ child-op lines under an Active row).
 *
 * So this control only ever appears where there IS a conversation to add to, and it carries no ops
 * column at all.
 */
export function ComposerDock({
  placeholder = "Reply or steer…",
  value,
  profile = "opus · high",
  armed,
}: {
  placeholder?: string
  value?: string
  profile?: string
  armed?: boolean
}) {
  return (
    <div className="absolute inset-x-0 bottom-0 z-30 border-t border-border/70 bg-bg/85 px-3 pb-[30px] pt-2.5 backdrop-blur-xl backdrop-saturate-150">
      <div className="flex items-end gap-2">
        <div className="flex min-h-[44px] min-w-0 flex-1 flex-col gap-2 rounded-[22px] border border-border-strong bg-panel px-3.5 py-[11px]">
          <span className={`min-w-0 text-[16px] leading-[21px] ${value ? "text-fg" : "text-muted-70"}`}>{value ?? placeholder}</span>
          {value ? (
            <div className="flex items-center gap-1.5">
              <Chip>{profile}</Chip>
              <Chip>ask</Chip>
            </div>
          ) : null}
        </div>
        <button
          aria-label="Send"
          className={`flex h-[44px] w-[44px] shrink-0 items-center justify-center rounded-full transition-colors ${
            armed ? "bg-accent text-bg" : "bg-elevated text-muted-60"
          }`}
        >
          <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 19V5" />
            <path d="m5 12 7-7 7 7" />
          </svg>
        </button>
      </div>
    </div>
  )
}
