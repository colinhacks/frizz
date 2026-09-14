import { createRoot } from "react-dom/client"
import type { ReactElement, ReactNode } from "react"
import { Check, CircleDashed, Hourglass, SquareTerminal, Terminal } from "lucide-react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { ThreadView } from "@frizz/shared"
import { BoxSpinner } from "./components/BoxSpinner.tsx"
import { ThreadRow } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import "./styles.css"

// MOCKUP SHEET — the rail mark for a thread PARKED ON ITS OWN BACKGROUND WORK.
//
// Not shipped UI and not a test: a design surface, in the shape awaiting-fence-mockups-fixture.tsx
// established. The shipped mark for that state is lucide's CircleDashed (Sidebar.tsx,
// sessionStateIndicatorFor → kind "snoozed", hint kind "shell"/"agent", and the shell-only
// event-snooze arm beside it), and the maintainer's note is that a park on a background SHELL should
// look like a shell — "a greater than sign and an underscore or something like that" — or, the other
// direction, that it should simply be the blue dot the ACTIVE background rows already wear.
//
// Both directions are drawn here, against the real family, because the question is not "does a
// terminal glyph exist" but whether it carries the same optical WEIGHT as the Check, the Hourglass and
// the box spinner sitting two rows above it. That is a pixel question; it needs a picture.
//
//   http://localhost:5479/rail-shell-mark-mockups-fixture.html?font=sans   — ?font=mono for the other
//
// THIS APP RENDERS IN TWO FONTS. Nothing here is a text glyph, so no mark should move between them —
// but the row titles do, and the marks are judged BESIDE those titles, so the switch stays wired.
document.documentElement.dataset.font = new URLSearchParams(location.search).get("font") === "sans" ? "sans" : "mono"

// The rail's box, copied rather than imported: this sheet draws candidates that do not exist in
// Sidebar.tsx yet, and half of them are variations ON the box (a dot needs no border at all).
const STATUS_BOX = 15

function StatusBox({ children }: { children?: ReactNode }) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-[4px] border border-muted/45"
      style={{ width: STATUS_BOX, height: STATUS_BOX }}
    >
      {children}
    </span>
  )
}

// A shell prompt drawn FOR THIS BOX rather than scaled down from a 24px grid. Lucide's Terminal keeps
// its caret and its underscore far apart (the caret ends at x=10 of 24, the rule starts at x=12) which
// is legible at 24px and turns into two unrelated specks at 10. These tighten the pair until it reads
// as one mark: caret, then the rule sitting under-and-right of it, the way a real prompt does.
function Prompt({ size = 10, weight = 1.5, gap = 1.5, drop = 1, className = "" }: { size?: number; weight?: number; gap?: number; drop?: number; className?: string }) {
  // 16-unit grid. The caret spans x 3→7; the rule starts `gap` units after it and ends at 13, so the
  // ink is symmetric about x=8. Vertically the caret sits 3.5→11.5 and the rule `drop` units below its
  // foot, which puts the pair's ink centre on the box centre.
  const x0 = 7 + gap
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={weight}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m3 11.5 4-4-4-4" />
      <path d={`M${x0} ${11.5 + drop}H13`} />
    </svg>
  )
}

// The shipped ACTIVE-background dot, and its parked variants. `.frizz-rail-dot` carries the pulse; a
// parked row is not moving, so the static arms drop the animation and only tone moves.
function Dot({ pulse = true, dim = 0, size = 0.31 }: { pulse?: boolean; dim?: number; size?: number }) {
  return (
    <span
      aria-hidden
      className={pulse ? "frizz-rail-dot" : undefined}
      style={{
        width: STATUS_BOX * size,
        height: STATUS_BOX * size,
        borderRadius: 9999,
        background: "var(--color-shell)",
        opacity: dim ? 1 - dim : undefined,
        ...(pulse ? {} : { display: "block" }),
      }}
    />
  )
}

// A hollow ring in the shell blue: the dot's colour, the CircleDashed's "parked, not running" reading.
function Ring({ dim = 0 }: { dim?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: STATUS_BOX * 0.42,
        height: STATUS_BOX * 0.42,
        borderRadius: 9999,
        border: "1.5px solid var(--color-shell)",
        opacity: dim ? 1 - dim : undefined,
      }}
    />
  )
}

type Candidate = { id: string; label: string; note: string; node: ReactElement }

// ── The two directions the maintainer named, plus the baseline they replace ────────────────────────
const CANDIDATES: Candidate[] = [
  {
    id: "current",
    label: "current — CircleDashed",
    note: "What ships today. Reads as a generic wait; says nothing about a shell.",
    node: <StatusBox><CircleDashed size={10} className="text-muted-70" /></StatusBox>,
  },
  {
    id: "lucide-terminal",
    label: "lucide Terminal, 10px",
    note: "The off-the-shelf mark, unmodified. Caret and rule drift apart at this size.",
    node: <StatusBox><Terminal size={10} className="text-muted-70" /></StatusBox>,
  },
  {
    id: "lucide-terminal-heavy",
    label: "lucide Terminal, 10px, 2.4 weight",
    note: "Same mark, inked up to the family's weight band.",
    node: <StatusBox><Terminal size={10} strokeWidth={2.4} className="text-muted-70" /></StatusBox>,
  },
  {
    id: "prompt-tight",
    label: "drawn prompt — tight",
    note: "Caret and rule pulled together so the pair reads as one mark.",
    node: <StatusBox><Prompt size={10} weight={1.5} gap={1.2} drop={1} className="text-muted-70" /></StatusBox>,
  },
  {
    id: "prompt-open",
    label: "drawn prompt — open",
    note: "A touch more air between caret and rule; closer to a real shell prompt's rhythm.",
    node: <StatusBox><Prompt size={10} weight={1.5} gap={2} drop={1} className="text-muted-70" /></StatusBox>,
  },
  {
    id: "prompt-heavy",
    label: "drawn prompt — heavy",
    note: "The tight pair at a thicker pen, for weight-matching against the Check.",
    node: <StatusBox><Prompt size={10} weight={2} gap={1.2} drop={1} className="text-muted-70" /></StatusBox>,
  },
  {
    id: "prompt-large",
    label: "drawn prompt — 11px",
    note: "Filling more of the box: a sparse glyph reads lighter than a solid one at equal size.",
    node: <StatusBox><Prompt size={11} weight={1.6} gap={1.2} drop={1} className="text-muted-70" /></StatusBox>,
  },
  {
    id: "prompt-shell",
    label: "drawn prompt — shell blue",
    note: "Shape AND colour say shell. Spends the blue the active dot spends.",
    node: <StatusBox><Prompt size={10} weight={1.6} gap={1.2} drop={1} className="text-shell" /></StatusBox>,
  },
  {
    id: "square-terminal",
    label: "lucide SquareTerminal",
    note: "Its own box inside the rail's box. Shown to rule it out, not to pick it.",
    node: <StatusBox><SquareTerminal size={10} className="text-muted-70" /></StatusBox>,
  },
  {
    id: "dot-pulse",
    label: "blue dot — pulsing",
    note: "Identical to the ACTIVE background mark. Two states, one mark.",
    node: <StatusBox><Dot /></StatusBox>,
  },
  {
    id: "dot-static",
    label: "blue dot — static",
    note: "Same dot, no pulse: alive behind this, but parked rather than moving.",
    node: <StatusBox><Dot pulse={false} /></StatusBox>,
  },
  {
    id: "dot-dim",
    label: "blue dot — static, dimmed",
    note: "Static and 40% quieter, so the Snoozed band stays quieter than Active.",
    node: <StatusBox><Dot pulse={false} dim={0.4} /></StatusBox>,
  },
  {
    id: "ring",
    label: "blue ring",
    note: "The dot's colour with the CircleDashed's hollow reading.",
    node: <StatusBox><Ring /></StatusBox>,
  },
]

// The rest of the family, drawn the way Sidebar.tsx draws it, so every candidate can be judged for
// WEIGHT against the marks it will actually sit beside in one column.
const FAMILY: { id: string; node: ReactElement }[] = [
  { id: "working", node: <BoxSpinner /> },
  { id: "background", node: <StatusBox><Dot /></StatusBox> },
  { id: "needs-input", node: <StatusBox><span className="frizz-rail-glyph font-bold leading-none text-muted-70" style={{ fontSize: 10 }}>?</span></StatusBox> },
  { id: "snoozed-timer", node: <StatusBox><Hourglass size={9} className="text-muted-70" /></StatusBox> },
  { id: "done", node: <StatusBox><Check size={10} strokeWidth={3} className="text-muted-75" /></StatusBox> },
]

// A rail row, close enough to the real one that the mark is judged at the size and against the title
// it actually ships beside — that is the whole point of the sheet, and an isolated glyph strip cannot
// answer it (the maintainer's screenshot is a ROW, not a glyph).
// `opacity-65` is the real dim ThreadRow applies to a Snoozed row — the number matters, because the
// whole question about a coloured mark in that band is whether the band still quiets it.
function Row({ node, title, dim }: { node: ReactElement; title: string; dim?: boolean }) {
  return (
    <div className={`flex items-center gap-2 rounded-md px-2 py-1 ${dim ? "opacity-65" : ""}`} style={{ width: 248 }}>
      <span className="flex shrink-0 items-center justify-center">{node}</span>
      <span className="truncate text-[13px] leading-[19px] text-fg/75">{title}</span>
    </div>
  )
}

// The three finalists, in the two bands they actually have to work in.
const FINALISTS = CANDIDATES.filter((c) => ["current", "prompt-tight", "dot-pulse"].includes(c.id))

// ── AND THE SAME PAIR THROUGH THE SHIPPED COMPONENT ────────────────────────────────────────────────
// Everything above is a reconstruction, which is exactly what cannot settle "is this what the app
// draws". These two rows are the real <ThreadRow/> on real ThreadView data — the same two shapes
// Sidebar.snoozedWatch.test.ts asserts on — so the mark, the band's dim and the row metrics are the
// shipped ones rather than a copy that can drift from them.
const shell = { label: "nub run dev", startedAt: "2026-08-31T09:02:00.000Z", state: "running" as const, id: "s1" }
const shipped = {
  kind: "session",
  backend: "claude",
  status: "active",
  runtime: "turn-idle",
  needsYou: false,
  subAgents: [],
  awaitingBackground: true,
  bgShells: [shell],
} as unknown as ThreadView

// ACTIVE: resting on the live shell, undimmed. SNOOZED: the very same thread after the human clicked
// Snooze on its resting card (`bgSnoozed` — the server's own bg_snooze_rested_at verdict).
const SHIPPED_ROWS: { id: string; band: string; t: ThreadView }[] = [
  { id: "active", band: "Active", t: { ...shipped, id: "shipped-active", title: "Typebox validator bench" } as ThreadView },
  { id: "snoozed", band: "Snoozed", t: { ...shipped, id: "shipped-snoozed", title: "Schemabenchmarks", bgSnoozed: true } as unknown as ThreadView },
]

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
  <TooltipProvider>
  <div className="min-h-screen bg-bg p-8 text-fg">
    <h1 className="mb-1 text-[15px] font-semibold">Rail mark — parked on background work</h1>
    <p className="mb-6 max-w-[720px] text-[12px] text-muted">
      The mark a thread wears when it has stopped and only its own background shell or sub-agent is still running.
      Every candidate is drawn twice: in the family strip, where its weight is judged against the marks it sits under,
      and on a rail row, where its size is judged against a title.
    </p>

    {/* ONE flat row of nothing but marks — the surface a dsf-8 clip can actually resolve. The family
        comes first at full strength (a dimmed reference cannot answer a weight question), then a rule,
        then every candidate in the order the list declares them. */}
    <section className="mb-8">
      <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-muted">Marks, side by side</h2>
      <div data-mark-strip className="inline-flex items-center gap-4 bg-bg px-4 py-3">
        {FAMILY.map((f) => (
          <span key={f.id} className="flex items-center justify-center">{f.node}</span>
        ))}
        <span className="mx-2 h-5 w-px bg-muted/40" />
        {CANDIDATES.map((c) => (
          <span key={c.id} className="flex items-center justify-center" data-candidate={c.id}>{c.node}</span>
        ))}
      </div>
      {/* The same order, spelled out, because the strip above carries no labels by design. */}
      <ol className="mt-3 grid max-w-[900px] grid-cols-2 gap-x-8 text-[11px] text-muted">
        {CANDIDATES.map((c, i) => (
          <li key={c.id}><span className="text-fg/70">{i + 1}. {c.label}</span> — {c.note}</li>
        ))}
      </ol>
    </section>

    {/* THE DECIDING PICTURE. The state under discussion is the SNOOZED twin of a row that is already
        in the Active band above it, wearing the blue dot, resting on the very same live shell. Drawn as
        the two bands so the pair can be read the way the sidebar presents them: whatever mark the
        parked row takes, it sits nine pixels under the dot that means exactly what it means. */}
    <section data-bands>
      <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-muted">In both bands, one live shell</h2>
      <div className="flex gap-8">
        {FINALISTS.map((c) => (
          <div key={c.id} data-band-column={c.id} className="rounded-lg bg-panel/50 p-3">
            <div className="mb-1 px-2 text-[10px] uppercase tracking-wide text-muted-70">Active</div>
            <Row node={<StatusBox><Dot /></StatusBox>} title="Typebox validator bench" />
            <div className="mb-1 mt-3 px-2 text-[10px] uppercase tracking-wide text-muted-70">Snoozed</div>
            <Row node={c.node} title="Schemabenchmarks" dim />
            <div className="mt-3 px-2 text-[11px] text-fg/70">{c.label}</div>
          </div>
        ))}
      </div>
    </section>

    <section className="mt-8" data-shipped>
      <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-muted">The shipped component</h2>
      <div className="w-[280px] rounded-lg bg-panel/50 p-3">
        {SHIPPED_ROWS.map((r) => (
          <div key={r.id} data-shipped-row={r.id}>
            <div className="mb-1 mt-2 px-2 text-[10px] uppercase tracking-wide text-muted-70">{r.band}</div>
            <ThreadRow t={r.t} />
          </div>
        ))}
      </div>
    </section>
  </div>
  </TooltipProvider>
  </QueryClientProvider>,
)
