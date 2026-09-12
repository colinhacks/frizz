// MOCKUP SHEET, ROUND 4 — ONE card for a parked rest: the fence's prose, a divider, the awaited
// items, the snooze in a footer (maintainer 2026-08-24: "the card consist of the rendered message at
// the top of the card, followed by a horizontal divider, followed by all of the awaited items. Then we
// could put the snooze button in a footer").
//
// Not a test and not shipped UI: a design surface on the REAL stylesheet and card tokens. What ships
// today (the control below) is TWO stacked blocks: the fence's body renders as the worker's ordinary
// final message, and the resting card (AwaitingBackgroundCard) sits under it with its own "Awaiting
// background work" heading, the grouped wait table, and the queue's snooze. This round folds them into
// one object and varies only two treatments: whether the card keeps a TITLE ROW above the prose, and
// whether the divider/footer are INSET hairlines or FULL-BLEED bands.
//
//   nubx vite --port 5479 --strictPort      (from packages/web)
//   http://localhost:5479/awaiting-unified-card-fixture.html?font=sans   — ?font=mono for the other
//                                                           ?only=B4    — one variant, on its own
//
// Row anatomy, group headings, statuses and the snooze pair are copied VERBATIM from the shipped
// AwaitingBackgroundCard/TodosView so the sheet judges composition, not drift.
import { createRoot } from "react-dom/client"
import { useMemo, type ReactNode } from "react"
import { ChevronRight, CircleCheck, Clock, Hourglass, TerminalSquare } from "lucide-react"
import {
  BLOCK_RADIUS, BLOCK_RADIUS_INNER_BOTTOM, CARD_ACTION_EXPLAINER, CARD_PRIMARY_ACTION,
} from "./components/TranscriptCard.tsx"
import { mdToHtml } from "./lib/markdown.ts"
import "./styles.css"

const params = new URLSearchParams(location.search)
// THIS APP RENDERS IN TWO FONTS and a fixture that sets neither silently takes the MONO default.
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"
const only = params.get("only")?.toUpperCase() ?? null

// ---- the two scenarios ---------------------------------------------------------------------------
type Row = { kind: "agent" | "shell" | "github" | "timer"; name: string; status: string; open: boolean }
type Scenario = { prose: string; groups: Array<[string, Row[]]> }

// The timer park from the 2026-08-24 screenshot — the shape that started all of this.
const TIMER_PARK: Scenario = {
  prose: [
    "Waiting for `main` to stabilize before cutting the 0.6.0 release that carries the [#22](https://github.com/acme/app/issues/22) fix.",
    "",
    "- an hourly timer re-checks: tip quiet, frozen-lockfile install green, typecheck green",
    "- once the release publishes, the approved comment goes on [#22](https://github.com/acme/app/issues/22) with the version number, then the issue is closed",
  ].join("\n"),
  groups: [[
    "Timers",
    [
      { kind: "timer", name: "Re-check: tip quiet, frozen-lockfile install green, typecheck green", status: "fires in 33m", open: false },
      { kind: "timer", name: "Poke the release workflow if no new run appeared", status: "fires in 51m", open: false },
    ],
  ]],
}

// Every kind at once, because the divider and footer have to survive a tall table too.
const MIXED: Scenario = {
  prose: "Both halves are pushed. The port rides on the parser sub-agent; CI and an hourly stall check cover the rest.",
  groups: [
    ["Sub-agents", [{ kind: "agent", name: "Audit the parser for edge cases", status: "opus-high · 2m", open: true }]],
    ["Background shells", [{ kind: "shell", name: "gh run watch 1842", status: "running · 4m", open: true }]],
    ["Pull requests", [{ kind: "github", name: "acme/app#391", status: "3 in progress, 12 successful", open: true }]],
    ["Timers", [{ kind: "timer", name: "Poke the release workflow if no new run appeared", status: "fires in 51m", open: false }]],
  ],
}

// ---- the shipped row anatomy, verbatim -----------------------------------------------------------
const ON_CAP = "shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]"
const ROW = "group relative col-span-4 grid grid-cols-subgrid items-baseline rounded-sm text-[12px] leading-5"
const NAME = "ml-1.5 min-w-0 truncate font-medium text-fg/90"
const STATUS = "ml-3 min-w-0 truncate text-right text-muted-70"
const HEAD = "col-span-4 text-[10.5px] uppercase tracking-wide text-muted-45"

function Spinner({ tone }: { tone: string }) {
  return <span aria-hidden className={`inline-block size-3 rounded-full border ${tone} border-t-transparent motion-safe:animate-spin ${ON_CAP}`} />
}
function Mark({ kind }: { kind: Row["kind"] }) {
  if (kind === "agent") return <Spinner tone="border-accent" />
  if (kind === "shell") return <TerminalSquare size={12} className={`${ON_CAP} text-shell`} />
  if (kind === "timer") return <Clock size={12} className={`${ON_CAP} text-muted-60`} />
  return <CircleCheck size={12} className={`${ON_CAP} text-emerald-500`} />
}
function WaitTable({ groups }: { groups: Scenario["groups"] }) {
  return (
    <div className="grid grid-cols-[auto_1fr_auto_auto] gap-y-px">
      {groups.map(([head, rows], i) => (
        <div key={head} className="contents">
          <div className={`${HEAD} ${i > 0 ? "mt-2.5" : ""}`}>{head}</div>
          {rows.map((r) => (
            <div key={r.name} className={`${ROW} ${r.open ? "cursor-pointer transition-colors hover:bg-fg/[0.045]" : ""}`}>
              <span className="flex shrink-0"><Mark kind={r.kind} /></span>
              <span className={NAME}>{r.name}</span>
              <span className={STATUS}>{r.status}</span>
              {r.open ? <ChevronRight size={13} aria-hidden className={`${ON_CAP} ml-[3px] -mr-[4px] text-muted-35 transition-colors group-hover:text-muted-70`} /> : <span />}
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}

function Prose({ md }: { md: string }) {
  const html = useMemo(() => ({ __html: mdToHtml(md) }), [md])
  return <div className="md-body card-md text-fg/75" dangerouslySetInnerHTML={html} />
}

// The queue's snooze pair, verbatim (TodosView.AwaitingBackgroundBanner).
function Snooze() {
  return (
    <>
      <button type="button" className={CARD_PRIMARY_ACTION}>
        <Hourglass size={12} className="translate-y-[calc(0.5em_-_0.5cap)]" />
        Snooze
      </button>
      <span className={CARD_ACTION_EXPLAINER}>Hides card until new activity is detected</span>
    </>
  )
}

const SHELL = `min-w-0 ${BLOCK_RADIUS} border border-border-strong bg-panel-2`

// ══ ROUND 5 · THE TITLE — "Awaiting", AT A REAL TITLE SCALE ═══════════════════════════════════════
// Round 4 settled the composition (prose → full-bleed divider → items → recessed snooze footer) and
// drew its title in the card family's shared style — 13px medium, deliberately BODY-size (the shadcn
// anatomy of 2026-07-29). The maintainer's answer (2026-08-24): the title is "Awaiting", and that
// style reads "small and non-title-like" here. So this round holds the composition fixed and walks
// ONLY the title row: one word, at increasing scale. The glyph rides the title's own size.
function Unified({ scen, titleClass, glyph }: { scen: Scenario; titleClass: string; glyph: number }) {
  return (
    <div className={`${SHELL} p-4 pb-0`}>
      <div className="flex min-w-0 items-start gap-2">
        <span className={`min-w-0 flex-1 ${titleClass}`}>Awaiting</span>
        <Hourglass aria-hidden size={glyph} className="card-icon-offset shrink-0 text-fg" />
      </div>
      <div className="mt-1"><Prose md={scen.prose} /></div>
      <div className="-mx-4 my-3 border-t border-border" />
      <WaitTable groups={scen.groups} />
      <div className={`-mx-4 mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-2 border-t border-border bg-fg/[0.03] px-4 py-2.5 ${BLOCK_RADIUS_INNER_BOTTOM}`}>
        <Snooze />
      </div>
    </div>
  )
}

// ---- the sheet's own chrome ----------------------------------------------------------------------
const VARIANTS: Array<{ id: string; title: string; note: string; render: (s: Scenario) => ReactNode }> = [
  { id: "A5", title: "13px medium — the family style (control)", note: "What every transcript card's title wears today: sentence case, body size, medium weight. Kept as the baseline to judge the others against.", render: (s) => <Unified scen={s} titleClass="text-[13px] font-medium leading-5 tracking-tight text-fg" glyph={14} /> },
  { id: "B5", title: "14px semibold", note: "One step up in both size and weight. Still inside the card's own type rhythm; the title reads as a heading without shouting.", render: (s) => <Unified scen={s} titleClass="text-[14px] font-semibold leading-5 tracking-tight text-fg" glyph={14} /> },
  { id: "C5", title: "15px semibold", note: "The sheet-heading scale. A clear step above the 13px prose beneath it; the glyph grows to 15 to keep the pair matched.", render: (s) => <Unified scen={s} titleClass="text-[15px] font-semibold leading-6 tracking-tight text-fg" glyph={15} /> },
  { id: "D5", title: "16px semibold", note: "A real headline. The strongest hierarchy over the prose — and the furthest from the rest of the card family, which stays at 13px.", render: (s) => <Unified scen={s} titleClass="text-[16px] font-semibold leading-6 tracking-tight text-fg" glyph={16} /> },
]

function Sheet() {
  return (
    <div className="mx-auto flex w-[min(1360px,calc(100%-48px))] flex-col gap-10 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-[15px] font-semibold text-fg">Awaiting card, round 5 — the title: “Awaiting”, at a real title scale</h1>
        <p className="max-w-[92ch] text-[12px] leading-5 text-muted-80">
          The composition is round 4's: prose, full-bleed divider, awaited items, recessed snooze footer
          (queue only). This round walks the TITLE alone — one word, four scales; the family's shared 13px
          style is the control. Left: the timer park. Right: every wait kind at once.
          <code className="ml-1 text-muted-60">?font=mono</code>,
          <code className="ml-1 text-muted-60">?only=C5</code>.
        </p>
      </header>
      {VARIANTS.map((v) => (
        <section key={v.id} data-variant={v.id} className={only && only !== v.id ? "hidden" : "flex flex-col gap-2"}>
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] font-semibold tracking-wider text-accent">{v.id}</span>
            <span className="text-[13px] font-medium text-fg">{v.title}</span>
          </div>
          <p className="max-w-[86ch] text-[11.5px] leading-4 text-muted-80">{v.note}</p>
          <div data-shot={v.id} className="flex flex-wrap items-start gap-6">
            <div className="w-[640px]">{v.render(TIMER_PARK)}</div>
            <div className="w-[640px]">{v.render(MIXED)}</div>
          </div>
        </section>
      ))}
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Sheet />)
