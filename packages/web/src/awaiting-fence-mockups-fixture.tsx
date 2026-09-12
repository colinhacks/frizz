// MOCKUP SHEET, ROUND 3 — the awaiting FENCE card's wait readout, replacing "a timer   for 2h".
//
// Not a test and not shipped UI: a design surface. Round 2 (awaiting-mockups-fixture.tsx) settled the
// RESTING card's table of live work; this round is the OTHER surface — the ```awaiting fence card that
// renders when there is no resting card (a pure timer park, the screenshot of 2026-08-24). What that
// card prints today, under the worker's prose, is the fence's machinery read back at the human:
//
//     a timer   for 2h
//
// — two disconnected fragments that answer neither of the reader's actual questions: WHEN will
// something happen here, and WHAT will happen then. The server knows both answers and the card throws
// them away: a timer row carries its exact `fireAt` AND the worker's own prompt text
// (ThreadTimerView), and the `for:` park's expiry instant is the wake the scheduler itself arms. The
// variants below spend that data instead of printing "a timer".
//
//   nubx vite --port 5478 --strictPort      (from packages/web)
//   http://localhost:5478/awaiting-fence-mockups-fixture.html?font=sans   — ?font=mono for the other
//                                                            ?only=C3    — one variant, on its own
//
// Every variant keeps the settled card family (TranscriptCard: title left, glyph top-right, body at
// the card's own x) and renders in the REAL stylesheet, so a choice made here is a choice about the
// thing that ships. Left column: the screenshot's scenario (one hourly timer, `for: 2h`). Right: the
// same card with a watched PR beside the timer, because the aside slot is already spoken for there.
import { createRoot } from "react-dom/client"
import { useMemo, type ReactNode } from "react"
import { AlarmClock, Hourglass, Radar } from "lucide-react"
import { TranscriptCard, CARD_LINK } from "./components/TranscriptCard.tsx"
import { mdToHtml } from "./lib/markdown.ts"
import "./styles.css"

const params = new URLSearchParams(location.search)
// THIS APP RENDERS IN TWO FONTS and a fixture that sets neither silently takes the MONO default — which
// is how a glyph measured at a 0.00px residual once rode visibly high in the maintainer's sans window.
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"
const only = params.get("only")?.toUpperCase() ?? null

// ---- the two scenarios ---------------------------------------------------------------------------
// TIMES ARE FROZEN STRINGS, not Date arithmetic: the sheet must screenshot identically every run.
type Scenario = {
  prose: string
  timer: { label: string; prompt: string; firesIn: string; firesAt: string }
  parkFor: string
  parkUntil: string
  pr?: string
}

// The screenshot that started this, verbatim: a release hold parked on an hourly re-check timer.
const TIMER_ONLY: Scenario = {
  prose: [
    "Waiting for `main` to stabilize before cutting the 0.6.0 release that carries the [#22](https://github.com/acme/app/issues/22) fix.",
    "",
    "- an hourly timer re-checks: tip quiet, frozen-lockfile install green, typecheck green",
    "- once the release publishes, the approved comment goes on [#22](https://github.com/acme/app/issues/22) with the version number, then the issue is closed",
  ].join("\n"),
  timer: { label: "hourly stability re-check", prompt: "Re-check: tip quiet, frozen-lockfile install green, typecheck green", firesIn: "34m", firesAt: "1:23 PM" },
  parkFor: "2h",
  parkUntil: "2:49 PM",
}

// The same card with the aside slot already occupied by a watched PR — the case a title-riding wake
// time has to survive.
const TIMER_AND_PR: Scenario = {
  prose: "Both legs are pushed. Waiting on the release run, with an hourly poke in case the workflow stalls silently again.",
  timer: { label: "hourly stall check", prompt: "Poke the release workflow if no new run appeared", firesIn: "52m", firesAt: "1:41 PM" },
  parkFor: "6h",
  parkUntil: "6:49 PM",
  pr: "acme/app#391",
}

// ---- shared pieces -------------------------------------------------------------------------------
// `1cap` puts a symmetric 1em glyph's ink on the cap band in either font; needs `items-baseline` rows.
const ON_CAP = "shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]"

function Prose({ md }: { md: string }) {
  const html = useMemo(() => ({ __html: mdToHtml(md) }), [md])
  return <div className="md-body" dangerouslySetInnerHTML={html} />
}

function PrRef({ scen }: { scen: Scenario }) {
  if (!scen.pr) return null
  return (
    <a href="#" className={`${CARD_LINK} text-[12px]`}>
      {scen.pr}
    </a>
  )
}

// The card's glyph, unchanged from what ships: radar for a PR watch, hourglass for a hold on the clock.
const icon = (scen: Scenario) => (scen.pr ? Radar : Hourglass)

// ---- the sheet's own chrome ----------------------------------------------------------------------
function Variant({ id, title, note, children }: { id: string; title: string; note: string; children: ReactNode }) {
  if (only && only !== id) return null
  return (
    <section data-variant={id} className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] font-semibold tracking-wider text-accent">{id}</span>
        <span className="text-[13px] font-medium text-fg">{title}</span>
      </div>
      <p className="max-w-[86ch] text-[11.5px] leading-4 text-muted-80">{note}</p>
      <div data-shot={id} className="flex flex-wrap items-start gap-6">
        {children}
      </div>
    </section>
  )
}

function Col({ children }: { children: ReactNode }) {
  return <div className="w-[640px]">{children}</div>
}

// ══ Z3 · WHAT SHIPS TODAY ═════════════════════════════════════════════════════════════════════════
/** The control: the exact card in the screenshot, so every option is judged against the thing it
 *  replaces rather than against memory. */
function Z3({ scen }: { scen: Scenario }) {
  return (
    <TranscriptCard icon={icon(scen)} label="Awaiting" aside={<PrRef scen={scen} />}>
      <Prose md={scen.prose} />
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-muted">
        <span>a timer</span>
        <span className="text-muted-70">for {scen.parkFor}</span>
      </div>
    </TranscriptCard>
  )
}

// ══ A3 · THE FOOTER BECOMES A SENTENCE ════════════════════════════════════════════════════════════
/** The cheapest real fix: the same slot, but a sentence a person would say — what wakes it and the
 *  latest it can sit. No new layout, no new data shape beyond the timer's fireAt. */
function A3({ scen }: { scen: Scenario }) {
  return (
    <TranscriptCard icon={icon(scen)} label="Awaiting" aside={<PrRef scen={scen} />}>
      <Prose md={scen.prose} />
      <p className="mt-2 text-[12px] leading-4 text-muted">
        Wakes in {scen.timer.firesIn} when its timer fires{scen.pr ? <>, or sooner on activity on {scen.pr}</> : null} — and re-checks everything by {scen.parkUntil} at the latest.
      </p>
    </TranscriptCard>
  )
}

// ══ B3 · THE WHEN RIDES THE TITLE ═════════════════════════════════════════════════════════════════
/** The one fact the reader scans for — when does something happen — promoted to the title row's aside,
 *  where the PR ref already rides. The footer disappears entirely; the prose carries the why. With a
 *  PR in play the aside holds both, ref first. */
function B3({ scen }: { scen: Scenario }) {
  return (
    <TranscriptCard
      icon={icon(scen)}
      label="Awaiting"
      aside={
        <span className="flex items-baseline gap-2">
          <PrRef scen={scen} />
          {scen.pr && <span className="text-[12px] text-muted-40">·</span>}
          <span className="text-[12px] tabular-nums text-muted">wakes in {scen.timer.firesIn}</span>
        </span>
      }
    >
      <Prose md={scen.prose} />
    </TranscriptCard>
  )
}

// ══ C3 · WAIT ROWS — THE ROUND-2 TABLE, ONE LEVEL UP ══════════════════════════════════════════════
/** The resting card's settled row idiom applied here: one line per thing that can wake the thread,
 *  glyph carrying the kind, the instant right-aligned. The park ceiling closes the list as a dim rule
 *  of its own — it is not a thing being waited on, it is the walls of the room. */
function C3({ scen }: { scen: Scenario }) {
  return (
    <TranscriptCard icon={icon(scen)} label="Awaiting">
      <Prose md={scen.prose} />
      <div className="mt-2.5 grid grid-cols-[auto_1fr_auto] text-[12px] leading-5">
        <div className="col-span-3 grid grid-cols-subgrid items-baseline gap-x-2">
          <AlarmClock size={12} className={`${ON_CAP} text-muted-70`} />
          <span className="min-w-0 truncate text-fg/85">{scen.timer.label}</span>
          <span className="tabular-nums text-muted-70">in {scen.timer.firesIn}</span>
        </div>
        {scen.pr && (
          <div className="col-span-3 grid grid-cols-subgrid items-baseline gap-x-2">
            <Radar size={12} className={`${ON_CAP} text-muted-70`} />
            <span className="min-w-0 truncate">
              <a href="#" className={CARD_LINK}>{scen.pr}</a>
            </span>
            <span className="text-muted-70">on any activity</span>
          </div>
        )}
      </div>
      <p className="mt-1.5 text-[11.5px] leading-4 text-muted-60">Full re-check by {scen.parkUntil} either way.</p>
    </TranscriptCard>
  )
}

// ══ D3 · SAY WHAT HAPPENS NEXT ════════════════════════════════════════════════════════════════════
/** The timer's own prompt — text the worker already wrote when it armed the timer — is the honest
 *  answer to "what happens next", so the readout leads with the EFFECT rather than the mechanism.
 *  Strongest card of the set when the prompt is good; hostage to a lazy prompt when it is not. */
function D3({ scen }: { scen: Scenario }) {
  return (
    <TranscriptCard icon={icon(scen)} label="Awaiting" aside={<PrRef scen={scen} />}>
      <Prose md={scen.prose} />
      <div className="mt-2.5 flex items-baseline gap-2 text-[12px] leading-5">
        <AlarmClock size={12} className={`${ON_CAP} text-muted-70`} />
        <span className="min-w-0 text-fg/85">
          <span className="font-medium tabular-nums">In {scen.timer.firesIn}</span>
          <span className="text-muted-80"> — {scen.timer.prompt}</span>
        </span>
      </div>
      <p className="mt-1 text-[11.5px] leading-4 text-muted-60">Parked {scen.parkFor} at most — a full re-check runs by {scen.parkUntil}.</p>
    </TranscriptCard>
  )
}

// ══ E3 · NO CHROME AT ALL ═════════════════════════════════════════════════════════════════════════
/** The resting-card branch's move, taken here too: the queue row already says the thread is resting,
 *  so the "Awaiting" heading and the card border are chrome restating the obvious. The worker's prose
 *  renders as the ordinary final message it is, with one dim meta line stating the wait. */
function E3({ scen }: { scen: Scenario }) {
  return (
    <div className="flex flex-col">
      <Prose md={scen.prose} />
      <p className="mt-2 flex items-baseline gap-1.5 text-[12px] leading-4 text-muted">
        <Hourglass size={11} className={`${ON_CAP} text-muted-60`} />
        <span>
          Parked — wakes in {scen.timer.firesIn}{scen.pr ? <>, or on activity on <a href="#" className={CARD_LINK}>{scen.pr}</a></> : null}; re-checks everything by {scen.parkUntil}.
        </span>
      </p>
    </div>
  )
}

// ══ F3 · THE TITLE IS THE PARK ════════════════════════════════════════════════════════════════════
/** The heading stops being the generic family name and states the wait itself, the way the card
 *  family's titles were designed to ("the heading names the WAIT"). Nothing else on the card but the
 *  prose. "By" keeps it honest: the timer usually wakes it sooner. */
function F3({ scen }: { scen: Scenario }) {
  return (
    <TranscriptCard icon={icon(scen)} label={`Awaiting — back by ${scen.parkUntil}`} aside={<PrRef scen={scen} />}>
      <Prose md={scen.prose} />
    </TranscriptCard>
  )
}

// ══ G3 · KEY–VALUE META ═══════════════════════════════════════════════════════════════════════════
/** The wait as two labelled facts, the shape a build readout takes: next wake, park ends. Scans in one
 *  fixation and grows a row per wait kind without redesign; the labels cost a little formality. */
function G3({ scen }: { scen: Scenario }) {
  return (
    <TranscriptCard icon={icon(scen)} label="Awaiting" aside={<PrRef scen={scen} />}>
      <Prose md={scen.prose} />
      <div className="mt-2.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[12px] leading-5">
        <span className="text-[10.5px] uppercase leading-5 tracking-wide text-muted-45">next wake</span>
        <span className="text-muted">
          in {scen.timer.firesIn} — {scen.timer.label}
          {scen.pr ? <>, or any activity on <a href="#" className={CARD_LINK}>{scen.pr}</a></> : null}
        </span>
        <span className="text-[10.5px] uppercase leading-5 tracking-wide text-muted-45">park ends</span>
        <span className="text-muted">{scen.parkUntil} — Frizz re-checks everything</span>
      </div>
    </TranscriptCard>
  )
}

// ---- the sheet -----------------------------------------------------------------------------------
const VARIANTS: Array<{ id: string; title: string; note: string; render: (s: Scenario) => ReactNode }> = [
  { id: "Z3", title: "What ships today (the control)", note: "The screenshot: generic heading, the worker's prose, then the fence's machinery read back — \"a timer   for 2h\". Neither fragment answers when anything happens or what happens then.", render: (s) => <Z3 scen={s} /> },
  { id: "A3", title: "The footer becomes a sentence", note: "Same slot, but a sentence a person would say: what wakes it, and the latest it can sit. Cheapest real fix — needs only the timer's fireAt shipped to the board (it already exists server-side).", render: (s) => <A3 scen={s} /> },
  { id: "B3", title: "The when rides the title", note: "\"wakes in 34m\" in the aside slot, where the PR ref already rides; the footer disappears. Quietest card of the set. The park ceiling goes unstated — arguably fine, since the ceiling is frizz's own safety net rather than information.", render: (s) => <B3 scen={s} /> },
  { id: "C3", title: "Wait rows — the round-2 table, one level up", note: "The resting card's settled row idiom: one line per thing that can wake the thread, glyph for the kind, instant right-aligned. The ceiling closes the list as a dim sentence. Grows naturally if a fence names several timers or PRs.", render: (s) => <C3 scen={s} /> },
  { id: "D3", title: "Say what happens next", note: "Leads with the EFFECT: the timer's own prompt — text the worker already wrote when arming it — after a bold \"In 34m\". The strongest answer to \"what happens next\"; hostage to a lazy prompt. Needs the timer's prompt shipped to the board alongside fireAt.", render: (s) => <D3 scen={s} /> },
  { id: "E3", title: "No chrome at all", note: "The move the resting-card branch already made: kill the heading and the border, render the prose as the ordinary final message it is, one dim meta line stating the wait. The queue row already says the thread rests; the card was restating it.", render: (s) => <E3 scen={s} /> },
  { id: "F3", title: "The title is the park", note: "The heading states the wait itself — \"Awaiting — back by 2:49 PM\" — the way this card family's titles were designed to. Nothing else but the prose. \"By\" keeps it honest; the cost is losing the timer's earlier wake entirely.", render: (s) => <F3 scen={s} /> },
  { id: "G3", title: "Key–value meta", note: "Two labelled facts in a dim grid: NEXT WAKE and PARK ENDS. Scans in one fixation, grows a row per wait kind, reads a touch formal for a card whose body is conversational prose.", render: (s) => <G3 scen={s} /> },
]

function Sheet() {
  return (
    <div className="mx-auto flex w-[min(1360px,calc(100%-48px))] flex-col gap-10 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-[15px] font-semibold text-fg">Awaiting fence card, round 3 — replacing “a timer&nbsp;&nbsp;for 2h”</h1>
        <p className="max-w-[92ch] text-[12px] leading-5 text-muted-80">
          The card the transcript draws for a pure timer park. Left: the 2026-08-24 screenshot’s scenario (one
          hourly timer, <code>for: 2h</code>). Right: the same card with a watched PR beside the timer, because the
          aside slot is already spoken for there. Times are frozen so the sheet screenshots identically.
          <code className="ml-1 text-muted-60">?font=mono</code>,
          <code className="ml-1 text-muted-60">?only=C3</code>.
        </p>
      </header>
      {VARIANTS.map((v) => (
        <Variant key={v.id} id={v.id} title={v.title} note={v.note}>
          <Col>{v.render(TIMER_ONLY)}</Col>
          <Col>{v.render(TIMER_AND_PR)}</Col>
        </Variant>
      ))}
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Sheet />)
