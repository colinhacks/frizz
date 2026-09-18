import { createRoot } from "react-dom/client"
import type { ReactNode } from "react"
import { Check, ChevronRight, Ellipsis, Maximize2, Pin, PinOff } from "lucide-react"
import { BoxSpinner, STATUS_BOX } from "./components/BoxSpinner.tsx"
import "./styles.css"

// MOCKUP SHEET — PINNING a thread out of the rail system entirely.
//
// Not shipped UI and not a test: a design surface, in the shape awaiting-fence-mockups-fixture.tsx
// established. The ask (maintainer 2026-09-02): a pin takes a thread OUT of the whole rail system —
// no Rested/Active/Snoozed/Done membership, no queue ordering — into a PINNED area at the very top,
// above the queue; the verb is a hover-revealed row button next to the fullscreen icon.
//
// Two questions need a picture, so the sheet draws both:
//   1. What the pinned BAND looks like at the top of the rail — unlabeled with a per-row pin mark
//      (variant A, matching the label-less Rested/Active bands), vs a labeled PINNED header — which
//      drags a label onto the rest of the rail's top too: one ACTIVE band over queue + running,
//      short-ruled between the groups (variant B; one labeled band above bare ones would read as a
//      header for all of them).
//   2. The hover ACTIONS — [pin] sitting beside the existing fullscreen door, and [unpin] on a row
//      that is already pinned.
//
//   http://localhost:5991/pin-mockup-fixture.html?font=sans   — ?font=mono for the other
//
// Row markup is copied from ThreadRow (Sidebar.tsx) rather than imported: half the sheet is states
// that component cannot draw yet (the pin mark, a forced-visible hover strip with a button that does
// not exist).
document.documentElement.dataset.font = new URLSearchParams(location.search).get("font") === "sans" ? "sans" : "mono"

// ── copies of the rail's atoms (ThreadRow / StatusBox / SectionHeader, Sidebar.tsx) ───────────────

const ROW_ACTION_CLASS = "flex h-[19px] w-[19px] items-center justify-center rounded text-muted-70 outline-none transition-colors hover:bg-panel-2 hover:text-fg"

function StatusBox({ children }: { children?: ReactNode }) {
  return (
    <span className="inline-flex items-center justify-center rounded-[4px] border border-muted/45" style={{ width: STATUS_BOX, height: STATUS_BOX }}>
      {children}
    </span>
  )
}

const spinner = <BoxSpinner />
const atRest = <StatusBox><Ellipsis size={10} className="text-muted-70" /></StatusBox>
const done = <StatusBox><Check size={10} strokeWidth={3} className="text-muted-75" /></StatusBox>

// ThreadRow's skeleton: marker rail inset (pl-5), indicator column, 13px/19px title, and the two
// right-edge surfaces — an in-flow rest-time column and the absolute hover-action overlay. `hovered`
// freezes the hover state open (tint on, actions shown, rest time yielded) so a static shot can show it.
function Row({ indicator, title, restedAge, mark, actions, hovered }: {
  indicator: ReactNode
  title: string
  /** The cue's right-justified rest-time column. */
  restedAge?: string
  /** A pinned row's right-edge pin mark (variant A) — same column the rest time occupies. */
  mark?: ReactNode
  /** The hover-action strip; hidden until hover exactly like the real row's. */
  actions?: ReactNode
  hovered?: boolean
}) {
  return (
    <div className={`group relative flex min-w-0 items-start rounded-md ${hovered ? "bg-white/[0.04]" : "hover:bg-white/[0.04]"}`}>
      <div className="min-w-0 flex-1 flex items-start gap-2 pb-1 pl-5 pr-1.5 pt-1">
        <span className="w-4 h-[19px] shrink-0 flex items-center justify-center">{indicator}</span>
        <span className="min-w-0 flex-1 flex flex-col">
          <span className="flex min-w-0 items-baseline gap-3">
            <span className="min-w-0 flex-1 break-words text-[13px] leading-[19px] text-fg/90">{title}</span>
            {restedAge && (
              <span className={`shrink-0 tabular-nums text-[10.5px] leading-[19px] text-muted-55 ${hovered ? "opacity-0" : ""}`}>{restedAge}</span>
            )}
          </span>
        </span>
      </div>
      {mark && (
        <span aria-hidden className={`absolute right-1.5 top-1 flex h-[19px] items-center ${hovered ? "opacity-0" : ""}`}>{mark}</span>
      )}
      {actions && (
        <div className={`absolute right-1.5 top-1 items-center gap-0.5 rounded bg-panel ${hovered ? "flex" : "hidden group-hover:flex"}`}>{actions}</div>
      )}
    </div>
  )
}

function Header({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex w-full items-center gap-1 px-1.5 py-1 text-[11px] uppercase tracking-wide text-muted-70">
      <ChevronRight size={11} />
      <span>{label}</span>
      <span className="ml-1.5 tabular-nums text-muted-60">{count}</span>
    </div>
  )
}

function Rule() {
  return <hr className="my-3 border-border/50" />
}

// A stand-in for the dispatch composer, so the panels show WHERE the pinned band lands: the very top
// of the rail, directly under the prompt box, above the cue.
function PromptBoxGhost() {
  return (
    <div className="mb-5 rounded-lg border border-border/60 bg-panel px-3 py-2.5 text-[13px] text-muted-40">
      Dispatch a new thread…
    </div>
  )
}

// ── the pin verb, drawn as it would ship ──────────────────────────────────────────────────────────

// ONE pin drawing everywhere (maintainer 2026-09-02: "use the solid pin icon to make sure that the
// icons are consistent everywhere", after a tilted variant read badly): lucide's Pin, UPRIGHT, FILLED —
// as the row mark, and as the hover verb. The unpin verb is PinOff with the same filled body; its slash
// keeps the stroke, since that is the ink that says "off".
const pinAction = (
  <span className={ROW_ACTION_CLASS}><Pin size={12} fill="currentColor" /></span>
)
const unpinAction = (
  <span className={ROW_ACTION_CLASS}><PinOff size={12} fill="currentColor" /></span>
)
const expandAction = (
  <span className={ROW_ACTION_CLASS}><Maximize2 size={12} /></span>
)

// Variant A's row mark: the same solid pin, small, in the rest-time column, toned to the column it
// replaces. Filled because the outline Pin at this size reads as a speck — but the STROKE stays on:
// lucide's needle is a stroke-only line (`M12 17v5`) with no fill area, so strokeWidth 0 erases it and
// leaves a headless blob.
const pinMark = <Pin size={11} fill="currentColor" className="text-muted-55" />

// ── the shared rail body below the pinned band (identical in both variants) ───────────────────────

// `labeled` is variant B's whole cost, drawn honestly (maintainer 2026-09-02: a labeled PINNED band
// means the bands above Snoozed need labels too — one labeled band above bare ones would read as a
// header for all of them). The label is ONE band, "Active" over queue + running together (maintainer:
// "merge queue and running into Active"), with a NON-FULLWIDTH rule between the two groups so the
// split survives without claiming band rank. Variant A keeps the bands bare, split by full rules, as
// the real rail is today.
function RailBelowPinned({ labeled }: { labeled?: boolean }) {
  return (
    <>
      {labeled && <Header label="Active" count={5} />}
      {/* THE CUE — queue-ordered, rest-time column. */}
      <Row indicator={atRest} title="Fix the cache collision in the resolver" restedAge="2h 10m" />
      <Row indicator={atRest} title="Sweep the stale tmux vocabulary out of the seed scripts" restedAge="5h" />
      <Row indicator={atRest} title="Triage the dependabot queue" restedAge="1d 3h" />
      {/* Inside a labeled Active band the queue/running split drops to a SHORT rule — inset to the
          title column, a third of the rail — so it reads as a sub-division, not a band boundary. */}
      {labeled ? <hr className="my-3 ml-5 w-1/3 border-border/50" /> : <Rule />}
      {/* ACTIVE — spinning rows. */}
      <Row indicator={spinner} title="Port the v2 drivers to the new broker socket" />
      <Row indicator={spinner} title="Verify the relay pin mechanics on staging" />
      <Rule />
      <Header label="Snoozed" count={3} />
      <Rule />
      <Header label="Done" count={12} />
    </>
  )
}

// ── the sheet ─────────────────────────────────────────────────────────────────────────────────────

function Panel({ title, note, children }: { title: string; note: string; children: ReactNode }) {
  return (
    <section className="w-[340px] shrink-0">
      <h2 className="mb-1 text-[13px] font-semibold text-fg/90">{title}</h2>
      <p className="mb-4 min-h-[45px] text-[11px] leading-[15px] text-muted-60">{note}</p>
      <div className="rounded-xl border border-border/40 p-3">{children}</div>
    </section>
  )
}

createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-bg px-10 py-10 text-fg">
    <h1 className="mb-1 text-[15px] font-semibold">Pin — a thread out of the rail system, at the very top</h1>
    <p className="mb-8 max-w-[720px] text-[11.5px] leading-[16px] text-muted-60">
      A pinned thread leaves Rested/Active/Snoozed/Done entirely and holds the top of the rail, above the queue, in the order it was pinned. Its indicator stays live (a pinned thread can still spin, rest, or finish); only its PLACE is frozen. The verb is a hover action on every row, beside the fullscreen door.
    </p>
    <div className="flex items-start gap-10">
      <Panel title="A — unlabeled band, pin-marked rows" note="Matches the rail's top bands, which carry no labels: the pinned rows simply come first, wearing a small pin where the cue's rest time would sit, with the usual rule below them. The mark yields to the hover actions like the rest time does.">
        <PromptBoxGhost />
        <Row indicator={spinner} title="Frizz v2 launch checklist" mark={pinMark} />
        <Row indicator={atRest} title="Redesign the queue card actions" mark={pinMark} />
        <Rule />
        <RailBelowPinned />
      </Panel>
      <Panel title="B — labeled bands: PINNED, ACTIVE" note="A PINNED header with a count, no per-row mark — and one ACTIVE header over the queue and the running rows together, with a short inset rule between the two groups instead of a band-rank divider.">
        <PromptBoxGhost />
        <Header label="Pinned" count={2} />
        <Row indicator={spinner} title="Frizz v2 launch checklist" />
        <Row indicator={atRest} title="Redesign the queue card actions" />
        <Rule />
        <RailBelowPinned labeled />
      </Panel>
      <Panel title="The hover verb, beside the fullscreen door" note="Every row: [pin] then [expand], in the existing action strip (the cue's rest time yields on hover, as it already does for Retry). A pinned row swaps in [unpin].">
        <div className="flex flex-col gap-6">
          <div>
            <p className="mb-1 px-1.5 text-[10.5px] text-muted-50">an ordinary cue row, hovered</p>
            <Row indicator={atRest} title="Fix the cache collision in the resolver" restedAge="2h 10m" hovered actions={<>{pinAction}{expandAction}</>} />
          </div>
          <div>
            <p className="mb-1 px-1.5 text-[10.5px] text-muted-50">a pinned row, hovered</p>
            <Row indicator={spinner} title="Frizz v2 launch checklist" mark={pinMark} hovered actions={<>{unpinAction}{expandAction}</>} />
          </div>
          <div>
            <p className="mb-1 px-1.5 text-[10.5px] text-muted-50">the same rows, at rest (marks visible, actions hidden)</p>
            <Row indicator={atRest} title="Fix the cache collision in the resolver" restedAge="2h 10m" actions={<>{pinAction}{expandAction}</>} />
            <Row indicator={spinner} title="Frizz v2 launch checklist" mark={pinMark} actions={<>{unpinAction}{expandAction}</>} />
          </div>
          <div>
            <p className="mb-1 px-1.5 text-[10.5px] text-muted-50">a done thread stays pinned until unpinned — the pin outranks Done</p>
            <Row indicator={done} title="Redesign the queue card actions" mark={pinMark} />
          </div>
        </div>
      </Panel>
    </div>
  </main>,
)
