// MOCKUP SHEET — per-message timestamps, revealed on HOVER.
//
// Not a test and not shipped UI: a design surface. Every variant renders the SAME four-message
// transcript excerpt in the REAL app stylesheet on the REAL bubble/divider chrome, so a choice made
// here is a choice about the thing that ships.
//
//   nubx vite --port 5477 --strictPort      (from packages/web)
//   http://localhost:5477/message-timestamp-mockups-fixture.html?font=sans   — ?font=mono for the other setting
//                                                                ?only=B     — one variant, on its own
//                                                                ?reveal=1   — force THAT row's reveal open (default: row 3)
//                                                                ?hover=all  — force every row's reveal open at once
//
// THE DATA ALREADY EXISTS. `TranscriptMessage.at` (shared/src/index.ts) is an optional ISO8601 the
// server sets on BOTH providers — Claude from `rec.timestamp`, Codex from `ev.at` — and the client
// already reads it (ChatView passes `at={m.at}` into the tool bands). Nothing here needs a schema
// change, a migration, or a server round-trip; every variant is a pure client render of a field that
// is already on the wire.
//
// THE CONSTRAINT THAT KILLS THE OBVIOUS ANSWER. The transcript is virtualized
// (@tanstack/react-virtual, `virtualizer.measureElement` on every row), so a reveal that changes a
// row's measured HEIGHT on hover would re-measure and shove the scroll position under the pointer.
// Every variant below is therefore zero-layout: a portal, an absolutely-positioned overlay, or space
// that is permanently reserved whether or not anything is in it. None of them reflow.
import { createRoot } from "react-dom/client"
import { useState, type ReactNode } from "react"
import { Bot } from "lucide-react"
import "./styles.css"

const params = new URLSearchParams(location.search)
// THIS APP RENDERS IN TWO FONTS and a fixture that sets neither silently takes the MONO default —
// which is how a glyph measured at a 0.00px residual once rode visibly high in the maintainer's sans
// window. Set it explicitly, and check both.
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"
const only = params.get("only")?.toUpperCase() ?? null
// SCREENSHOT MODE, and OFF by default — the sheet is meant to be HOVERED, and a row already lit
// when the page opens teaches the wrong thing twice over: it hides how invisible each variant is at
// rest (which is the whole point of the ask) and it implies the reading is permanent. Pass
// `?reveal=<row>` to pin one open for a camera; `?hover=all` opens every row at once, which is only
// for checking that no two reveals collide — in life exactly one is ever open.
const FORCE_ALL = params.get("hover") === "all"
const REVEAL_ROW = FORCE_ALL ? -1 : (params.has("reveal") ? Number(params.get("reveal")) : -1)

// ---- the excerpt every variant renders -----------------------------------------------------------
// Four messages spanning the kinds the transcript actually holds: a human send, an agent turn, a
// centred event divider, and a second agent turn. Deliberately from the screenshot that prompted this
// so the variants can be compared against the real thing.
type Msg =
  | { kind: "user"; at: Date; text: string }
  | { kind: "agent"; at: Date; text: string }
  | { kind: "divider"; at: Date; label: ReactNode }

const D = (h: number, m: number, s: number) => new Date(2026, 7, 21, h, m, s)

const EXCERPT: Msg[] = [
  { kind: "user", at: D(9, 14, 3), text: "Check whether auto-merge actually armed on #3778 — the queue said false again." },
  { kind: "agent", at: D(9, 14, 51), text: "CI green (85 checks) and mergeState=CLEAN, but auto-merge shows false again. Let me re-arm it." },
  { kind: "divider", at: D(9, 27, 12), label: <>Agent “re-arm auto-merge” finished — 12m</> },
  { kind: "agent", at: D(10, 31, 40), text: "Already queued — auto=false is just how the queue reports it once it takes the PR. CI is fully green and the state is CLEAN, so it's waiting its turn." },
]

// ---- how an instant reads ------------------------------------------------------------------------
// The SHORT form is what a reveal shows in place: a bare local wall clock, and the weekday in front of
// it once the message is not from today (the same rule limitResumeClock already uses in ChatView — a
// bare "5:50 PM" on a three-day-old message is a lie by omission). Tabular figures so a column of them
// does not shimmy.
function clock(at: Date): string {
  const sameDay = at.toDateString() === new Date().toDateString()
  const time = at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  return sameDay ? time : `${at.toLocaleDateString([], { weekday: "short" })} ${time}`
}
// The LONG form is what a tooltip shows, because a tooltip has room and is asked for deliberately:
// the full date, the seconds, and the relative age the header already speaks in — so the reveal
// answers both "when exactly" and "how long ago" in one read.
function longClock(at: Date): string {
  return `${at.toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit" })}`
}
const TABULAR = "[font-variant-numeric:tabular-nums]"
function gutterClock(at: Date): string {
  const sameDay = at.toDateString() === new Date().toDateString()
  return sameDay
    ? at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : at.toLocaleDateString([], { month: "short", day: "numeric" })
}

// ---- the shipped chrome, unchanged ---------------------------------------------------------------
// Copied from ChatView/WakeDivider rather than imported, because importing ChatView drags the whole
// store in. These are the REAL classes — if one drifts from the app, this sheet is lying.
function Bubble({ children }: { children: ReactNode }) {
  return (
    <div className="relative rounded-xl rounded-br-sm bg-user-bubble px-3.5 py-3 text-[14px] whitespace-pre-wrap [overflow-wrap:anywhere] text-bg">
      {children}
    </div>
  )
}
function Prose({ children }: { children: ReactNode }) {
  return <div className="text-[13px] leading-6 text-fg">{children}</div>
}
function DividerChrome({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="my-1 flex items-center gap-3">
      <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
      <span className="petite-caps flex min-w-0 items-center gap-1 break-words text-center text-[12px] text-muted-70">
        <Bot aria-hidden="true" size={12} className="shrink-0 translate-y-[0.04em]" />
        {children}
      </span>
      {trailing}
      <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
    </div>
  )
}

// The reveal's own transition, shared by every variant so the sheet compares PLACEMENT and not easing.
// 120ms is under the threshold where a hover reveal reads as a delay; opacity only, never a transform,
// so nothing appears to slide into a position it does not occupy.
const REVEAL = "pointer-events-none transition-opacity duration-[120ms]"
const shown = (on: boolean, row: number) => (on || FORCE_ALL || row === REVEAL_ROW ? "opacity-100" : "opacity-0")

// =================================================================================================
// A — TOOLTIP ON THE MESSAGE BODY
// Zero pixels of chrome anywhere: the message is its own trigger, and the reading arrives in the same
// dark tooltip every icon-only affordance in the app already uses (components/Tooltip.tsx, Radix,
// delayDuration 0). Nothing is reserved, nothing is drawn, nothing can misalign.
// The cost is DISCOVERABILITY — a tooltip with no trigger mark is a thing you find by accident — and
// that a tooltip over a tall prose block pops wherever the pointer entered.
// =================================================================================================
function VariantA({ msgs }: { msgs: Msg[] }) {
  return (
    <Excerpt>
      {msgs.map((m, i) => (
        <FauxTooltip key={i} row={i} label={longClock(m.at)}>
          <Row m={m} />
        </FauxTooltip>
      ))}
    </Excerpt>
  )
}

// A stand-in for components/Tooltip.tsx — same visual contract (dark elevated surface, 11px, border,
// shadow), rendered inline so this sheet needs no provider. The shipped variant would use the real one.
function FauxTooltip({ children, label, row }: { children: ReactNode; label: string; row: number }) {
  const [on, setOn] = useState(false)
  return (
    <div className="relative" onMouseEnter={() => setOn(true)} onMouseLeave={() => setOn(false)}>
      {children}
      {/* ABOVE the message and centred — the shipped Tooltip's own default side, and the only placement
          that cannot run off the transcript's narrow column. Flipped to the side, the user bubble's tip
          clipped clean off the panel edge. */}
      <span
        className={`${REVEAL} ${shown(on, row)} absolute bottom-full left-1/2 z-10 mb-1.5 -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-elevated px-3 py-2 text-[11px] leading-relaxed text-fg shadow-md shadow-black/40`}
      >
        {label}
      </span>
    </div>
  )
}

// =================================================================================================
// B — RESERVED GUTTER
// A fixed 44px column left of every message, permanently empty, that paints a right-aligned wall clock
// when its row is hovered. Because the column is always there, nothing moves — and because every time
// lands on ONE x, hovering down the transcript reads as a column of times rather than four labels in
// four places.
// The cost is the 44px: the transcript's prose loses that width on every row for a reading that is
// blank ~99% of the time. It is also the only variant that scales to "hover nothing, see them all" —
// a modifier key could light the whole column at once.
// =================================================================================================
const GUTTER = "w-14 shrink-0 whitespace-nowrap"
function VariantB({ msgs }: { msgs: Msg[] }) {
  return (
    <Excerpt pad={false}>
      {msgs.map((m, i) => <GutterRow key={i} m={m} row={i} />)}
    </Excerpt>
  )
}
function GutterRow({ m, row }: { m: Msg; row: number }) {
  const [on, setOn] = useState(false)
  return (
    // `items-baseline`, NOT `items-start` + a hand-fitted `pt-1`. The gutter reading is 11px in a 20px
    // line box and the prose is 13px in a 24px one, so pushing the small label down by a guessed 4px
    // landed its baseline 1.00px BELOW the prose's (measured) — and any retune of either type scale
    // would move it again. Baseline alignment is the browser computing the same intent exactly, with
    // nothing to re-measure, which is what makes a gutter read as a column beside the text rather
    // than a label floating near it.
    // …except on a DIVIDER row, which is a centred rule and has no baseline worth aligning to: its
    // own label is petite-caps (inking from x-height, not cap-top), so flexbox's synthesized baseline
    // put the gutter reading 4.48px HIGH (measured). A rule is a horizontal object — centre against it.
    <div className={`group flex gap-2 ${m.kind === "divider" ? "items-center" : "items-baseline"}`} onMouseEnter={() => setOn(true)} onMouseLeave={() => setOn(false)}>
      <span className={`${GUTTER} ${REVEAL} ${shown(on, row)} ${TABULAR} text-right text-[11px] leading-5 text-muted-70`}>
        {gutterClock(m.at)}
      </span>
      <div className="min-w-0 flex-1"><Row m={m} /></div>
    </div>
  )
}

// =================================================================================================
// C — TRAILING REVEAL, ABSOLUTELY POSITIONED
// The time appears at the message's own trailing edge — outside the user bubble's right shoulder,
// past the last line of an agent turn — laid over the page in an absolutely-positioned span, so it
// costs no width and no height. It reads as belonging to THAT message rather than to a column, which
// is the right answer to "when did this one come out".
// The cost is that it lands in a different place on every row, so scanning several is four saccades;
// and on a full-width agent paragraph it has to sit at the row's right edge, away from the text.
// =================================================================================================
function VariantC({ msgs }: { msgs: Msg[] }) {
  return (
    <Excerpt>
      {msgs.map((m, i) => <TrailRow key={i} m={m} row={i} />)}
    </Excerpt>
  )
}
function TrailRow({ m, row }: { m: Msg; row: number }) {
  const [on, setOn] = useState(false)
  return (
    <div className="relative" onMouseEnter={() => setOn(true)} onMouseLeave={() => setOn(false)}>
      <Row m={m} />
      <span className={`${REVEAL} ${shown(on, row)} ${TABULAR} absolute right-0 top-full z-10 -mt-0.5 text-[11px] leading-4 text-muted-70`}>
        {clock(m.at)}
      </span>
    </div>
  )
}

// =================================================================================================
// D — HAIRLINE REVEAL
// Hovering a message draws the transcript's OWN section-break chrome above it — the hairline the wake
// dividers already wear (components/WakeDivider.tsx) — carrying the time as a petite-caps label. It
// borrows a vocabulary the transcript has already taught the reader, so the reveal needs no learning,
// and it marks the message's whole top edge rather than one corner.
// The cost is weight: a rule spanning the column is the loudest of the four for the smallest fact, and
// it collides conceptually with the real dividers, which mean "something happened here".
// The divider row itself takes the time INLINE in its existing label instead of stacking two rules.
// =================================================================================================
function VariantD({ msgs }: { msgs: Msg[] }) {
  return (
    <Excerpt>
      {msgs.map((m, i) => <HairlineRow key={i} m={m} row={i} />)}
    </Excerpt>
  )
}
function HairlineRow({ m, row }: { m: Msg; row: number }) {
  const [on, setOn] = useState(false)
  if (m.kind === "divider") {
    return (
      <div onMouseEnter={() => setOn(true)} onMouseLeave={() => setOn(false)}>
        <DividerChrome trailing={<span className={`${REVEAL} ${shown(on, row)} ${TABULAR} petite-caps text-[12px] text-muted-70`}>· {clock(m.at)}</span>}>
          {m.label}
        </DividerChrome>
      </div>
    )
  }
  return (
    <div className="relative" onMouseEnter={() => setOn(true)} onMouseLeave={() => setOn(false)}>
      {/* Laid ON the gap the row already owns (-top-2.5), so the rule costs no height. */}
      <div className={`${REVEAL} ${shown(on, row)} absolute -top-2.5 left-0 right-0 flex items-center gap-3`}>
        <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
        <span className={`petite-caps ${TABULAR} shrink-0 text-[12px] leading-none text-muted-70`}>{clock(m.at)}</span>
        <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
      </div>
      <Row m={m} />
    </div>
  )
}

// ---- shared row rendering ------------------------------------------------------------------------
function Row({ m }: { m: Msg }) {
  if (m.kind === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%]"><Bubble>{m.text}</Bubble></div>
      </div>
    )
  }
  if (m.kind === "divider") return <DividerChrome>{m.label}</DividerChrome>
  return <Prose>{m.text}</Prose>
}

function Excerpt({ children, pad = true }: { children: ReactNode; pad?: boolean }) {
  // The transcript's own column: `px-6` horizontal padding, a flex column, one 20px step between
  // messages (ChatView's STEP). `pad=false` for the gutter variant, which owns its own left column.
  return <div className={`flex flex-col gap-5 rounded-lg border border-border/60 bg-bg pt-10 pb-5 ${pad ? "px-6" : "pl-3 pr-6"}`}>{children}</div>
}

// ---- the sheet -----------------------------------------------------------------------------------
const VARIANTS: Array<{ id: string; title: string; note: ReactNode; render: () => ReactNode }> = [
  {
    id: "A",
    title: "Tooltip on the message",
    note: <>Zero chrome. The message body is the trigger and the reading arrives in the app's existing dark tooltip, with the full date, the seconds and the age. Cheapest to ship — <code className="text-muted-60">components/Tooltip.tsx</code> already exists — and the only variant that adds literally nothing to the layout. Its weakness is visible in the shot: the tip is drawn <em>over</em> the transcript, so reading one message's time hides the one above it — and an unmarked trigger is undiscoverable, so nobody finds this without being told.</>,
    render: () => <VariantA msgs={EXCERPT} />,
  },
  {
    id: "B",
    title: "Reserved gutter",
    note: <>A permanently-present 56px column, blank until you hover a row. Every time lands on one x, so running the pointer down the transcript reads as a <em>column</em> of times — and a modifier key could light the whole column at once, which no other variant supports. The cost is visible right here: the transcript loses 56px on every row forever for a reading that is blank almost always, and the user bubble below wraps to two lines where the other three variants fit it on one. A message not from today shows its date instead of its clock, which is all that fits.</>,
    render: () => <VariantB msgs={EXCERPT} />,
  },
  {
    id: "C",
    title: "Trailing reveal",
    note: <>The time fades in at the message's own trailing edge, absolutely positioned so it costs no width and no height. It reads as belonging to <em>that message</em>, which is exactly the question being asked. The cost is that it appears in a different place on every row, so comparing three of them is three separate looks.</>,
    render: () => <VariantC msgs={EXCERPT} />,
  },
  {
    id: "D",
    title: "Hairline reveal",
    note: <>Hovering draws the transcript's own section-break rule above the message, carrying the time as a petite-caps label — the vocabulary the wake dividers already taught the reader. Marks the whole top edge, needs no learning. It is also the loudest of the four for the smallest fact, and it borrows a chrome that elsewhere means <em>something happened here</em>.</>,
    render: () => <VariantD msgs={EXCERPT} />,
  },
]

function FontSwitch() {
  const [font, setFont] = useState(document.documentElement.dataset.font ?? "sans")
  const pick = (next: string) => { document.documentElement.dataset.font = next; setFont(next) }
  return (
    <div className="flex items-center gap-1.5 text-[12px] text-muted-80">
      <span>Font</span>
      {["sans", "mono"].map((f) => (
        <button
          key={f}
          type="button"
          onClick={() => pick(f)}
          className={`rounded px-2 py-0.5 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${font === f ? "bg-panel-2 text-fg" : "hover:text-fg"}`}
        >
          {f}
        </button>
      ))}
    </div>
  )
}

function Sheet() {
  const shownVariants = only ? VARIANTS.filter((v) => v.id === only) : VARIANTS
  return (
    <div className="mx-auto flex w-[min(1180px,calc(100%-48px))] flex-col gap-10 py-10">
      <header className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-4">
          <h1 className="text-[15px] font-semibold text-fg">Per-message timestamps, on hover</h1>
          <FontSwitch />
        </div>
        <p className="max-w-[92ch] text-[12px] leading-5 text-muted-80">
          Four placements for the same fact. The data already ships — <code className="text-muted-60">TranscriptMessage.at</code> is an
          ISO8601 the server sets on both providers and the client already reads — so each of these is a pure client render, no schema
          change and no server round-trip. All four are zero-layout by construction: the transcript is virtualized, so a reveal that
          changed a row's measured height would shove the scroll position under the pointer.
          <strong className="font-medium text-fg"> Hover the messages below</strong> — every panel is blank at rest, which is the
          point; each variant only shows its reading under the pointer.
          <code className="ml-1 text-muted-60">?only=B</code> for one variant alone,
          <code className="ml-1 text-muted-60">?reveal=3</code> to pin a row open,
          <code className="ml-1 text-muted-60">?hover=all</code> to open every row at once.
        </p>
      </header>
      {shownVariants.map((v) => (
        <section key={v.id} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-[13px] font-medium text-fg">
              <span className={`${TABULAR} mr-2 text-muted-60`}>{v.id}</span>{v.title}
            </h2>
            <p className="max-w-[92ch] text-[12px] leading-5 text-muted-80">{v.note}</p>
          </div>
          <div className="w-[760px]">{v.render()}</div>
        </section>
      ))}
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Sheet />)
