// MOCKUP SHEET, ROUND 2 — the resting card's wait as a TABLE, with every kind of live work in it.
//
// Not a test and not shipped UI: a design surface. Every variant renders in the REAL app stylesheet on
// the REAL card chrome, so a choice made here is a choice about the thing that ships.
//
//   nubx vite --port 5477 --strictPort      (from packages/web)
//   http://localhost:5477/awaiting-mockups-fixture.html?font=sans   — ?font=mono for the other setting
//                                                       ?only=B2    — one variant, on its own
//
// ROUND 1 (sixteen variants A–P, the whole space) is in this file's history at 1ae853b. It settled four
// things, and every variant here obeys them (maintainer 2026-08-14):
//
//   1. A's DENSITY WINS. One line per thing, the glyph carrying the verdict.
//   2. NO FAILING-JOB LIST. The names were a second line per red PR; the row now offers a way to GO look
//      at them on GitHub instead of reprinting them here.
//   3. RUNNING IS A SPINNER, in yellow. A static amber dot claimed "in progress" without showing it, and
//      the one state that is genuinely in motion is the one that should move.
//   4. THE WHOLE ROW IS THE TARGET, with a chevron at the right saying so. Clicking anywhere opens the
//      thing — the PR on GitHub, the shell's output drawer, the sub-agent.
//
// What round 1 never drew, and what this round is really about: SHELLS AND SUB-AGENTS ARE ROWS TOO. Today
// they are a COUNT in a sentence and nothing more — and a declared shell (`watch:` then, `shells:` since
// the 2026-08-24 YAML cutover) arms a `kind: "shell"`
// watch (ThreadWatchKind) that this card renders NOWHERE. Both belong in the same table as the PRs.
import { createRoot } from "react-dom/client"
import type { ReactNode } from "react"
import {
  ArrowUpRight, ChevronRight, CircleCheck, CircleDashed, CircleX, GitMerge, GitPullRequestClosed,
  Hourglass, TerminalSquare,
} from "lucide-react"
import { CardActions, CARD_PRIMARY_ACTION, TranscriptCard } from "./components/TranscriptCard.tsx"
import "./styles.css"

const params = new URLSearchParams(location.search)
// THIS APP RENDERS IN TWO FONTS and a fixture that sets neither silently takes the MONO default — which
// is how a glyph measured at a 0.00px residual once rode visibly high in the maintainer's sans window.
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"
const only = params.get("only")?.toUpperCase() ?? null

// ---- what a thread can be waiting on ------------------------------------------------------------
type Checks = "running" | "passing" | "failing" | "none"
type Merge = "mergeable" | "blocked" | "conflicting" | "unknown"
type Row =
  | { kind: "pr"; ref: string; checks: Checks; running: number; passed: number; failed: number; merge: Merge; state: "open" | "merged" | "closed"; polled: boolean; since: string }
  | { kind: "shell"; label: string; taskId: string; since: string; watched: boolean }
  | { kind: "agent"; label: string; profile: string; since: string }

// A MIXED thread — two PRs, a shell the worker explicitly parked on, an incidental shell, and a live
// sub-agent. This is the case the card has never drawn, and the one every variant here has to survive.
const MIXED: Row[] = [
  { kind: "pr", ref: "acme/app#391", checks: "running", running: 3, passed: 12, failed: 0, merge: "blocked", state: "open", polled: true, since: "6m" },
  { kind: "pr", ref: "acme/app#393", checks: "failing", running: 0, passed: 9, failed: 2, merge: "blocked", state: "open", polled: true, since: "21m" },
  { kind: "shell", label: "gh run watch 1842", taskId: "bzvtnt3ig", since: "4m", watched: true },
  { kind: "shell", label: "vite dev --host", taskId: "b7k2m1xq0", since: "18m", watched: false },
  { kind: "agent", label: "Audit the parser for edge cases", profile: "opus-high", since: "2m" },
]
// THE REAL BOARD'S COMMON CASE, and the shape in the screenshot that started this: one green mergeable
// PR. A variant that only reads well with five rows has solved the rare problem.
const ONE: Row[] = [
  { kind: "pr", ref: "colinhacks/zod#5928", checks: "passing", running: 0, passed: 7, failed: 0, merge: "mergeable", state: "open", polled: true, since: "12m" },
]

const total = (r: Extract<Row, { kind: "pr" }>) => r.running + r.passed + r.failed
const label = (r: Row) => (r.kind === "pr" ? r.ref : r.label)

// ---- the marks -----------------------------------------------------------------------------------
// `1cap` is the resolved font's cap height, so a symmetric 1em glyph's ink lands on the cap band in
// EITHER font at any size. It needs a shared baseline, hence `items-baseline` on every row below.
const ON_CAP = "shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]"

/** RUNNING, AND IT MOVES (maintainer 2026-08-14: "the yellow should be a spinner if the checks are still
 *  running. A yellow spinner"). A RING rather than lucide's Loader2: the other three states are 12px
 *  circles, so a ring keeps one circular footprint down the column and the glyph gutter never jitters
 *  as a PR goes from running to green. Same idiom as ChatView's own inline ring. */
function Spinner({ tone = "border-attention" }: { tone?: string }) {
  return <span className={`inline-block size-3 rounded-full border ${tone} border-t-transparent motion-safe:animate-spin ${ON_CAP}`} />
}

function Mark({ r }: { r: Row }) {
  if (r.kind === "shell") return <TerminalSquare size={12} className={`${ON_CAP} text-shell`} />
  // A sub-agent RETURNS — it is always in motion while it is on this card, so it is always a spinner.
  // Accent-yellow rather than the checks' amber, matching the rail: a sub-agent pulses accent, a shell
  // pulses blue (groups.sessionIndicatorKind).
  if (r.kind === "agent") return <Spinner tone="border-accent" />
  if (!r.polled) return <CircleDashed size={12} className={`${ON_CAP} text-muted-60`} />
  if (r.state === "merged") return <GitMerge size={12} className={`${ON_CAP} text-permission-edit`} />
  if (r.state === "closed") return <GitPullRequestClosed size={12} className={`${ON_CAP} text-danger`} />
  if (r.checks === "failing") return <CircleX size={12} className={`${ON_CAP} text-danger`} />
  if (r.checks === "passing") return <CircleCheck size={12} className={`${ON_CAP} text-emerald-500`} />
  if (r.checks === "running") return <Spinner />
  return <CircleDashed size={12} className={`${ON_CAP} text-muted-60`} />
}

/** THE WHOLE ROW IS THE TARGET and the chevron says so. `-mr-1` pulls the glyph's dead box off the card's
 *  right edge — lucide's chevron paints ~4.7 of its 14 box px, so an untrimmed one floats visibly inside
 *  the padding. The real number wants measuring with scripts/ink-gaps.mjs before this ships. */
function Chevron({ external = false }: { external?: boolean }) {
  const Icon = external ? ArrowUpRight : ChevronRight
  return <Icon size={13} className={`${ON_CAP} -mr-1 text-muted-40 transition-colors group-hover:text-muted-80`} />
}

// The COUNTS, unchanged from what shipped: GitHub's own words, worst first, zeroes left out.
const counts = (r: Extract<Row, { kind: "pr" }>) =>
  [r.failed > 0 ? `${r.failed} failing` : null, r.running > 0 ? `${r.running} in progress` : null, r.passed > 0 ? `${r.passed} successful` : null]
    .filter(Boolean).join(", ")
const mergeWord = (r: Extract<Row, { kind: "pr" }>) =>
  r.state !== "open" ? null
  : r.merge === "blocked" && r.checks !== "passing" && r.checks !== "none" ? null
  : r.merge === "mergeable" ? "no conflicts" : r.merge === "blocked" ? "merge blocked" : r.merge === "conflicting" ? "has conflicts" : null

/** The state half of a row, for every kind. A shell and a sub-agent have no checks, so they say the one
 *  thing they have: how long they have been at it. */
const state = (r: Row): string => {
  if (r.kind === "shell") return r.watched ? `watching · ${r.since}` : `running · ${r.since}`
  if (r.kind === "agent") return `${r.profile} · ${r.since}`
  if (!r.polled) return "checking…"
  if (r.state === "merged") return "merged"
  if (r.state === "closed") return "closed"
  return [counts(r) || "no checks", mergeWord(r)].filter(Boolean).join(" · ")
}

/** THE FAILURES AFFORDANCE — the round-1 second line replaced (maintainer: "I don't think we should list
 *  out the failed checks. I think there should just be a button to view the failures, and it can just
 *  link out to the PR"). It goes to the PR's CHECKS tab, which is where the failures actually are. */
function ViewFailures({ bare = false }: { bare?: boolean }) {
  if (bare) return <span className="shrink-0 text-danger-80 underline decoration-danger/30 underline-offset-2 hover:decoration-danger">view failures</span>
  return (
    <span className={`shrink-0 rounded border border-danger/35 px-1.5 text-[10.5px] leading-4 text-danger-90 hover:border-danger/70 ${ON_CAP}`}>
      view failures
    </span>
  )
}
const isRed = (r: Row) => r.kind === "pr" && r.polled && r.checks === "failing"

/** The state cell for a variant with ONE right-hand column: the counts still speak, and the link follows
 *  them. Replacing the counts with the link loses the "2 failing" that says HOW red the PR is. */
function StateCell({ r }: { r: Row }) {
  return (
    <>
      {state(r)}
      {isRed(r) && <> · <ViewFailures bare /></>}
    </>
  )
}

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
      <div data-shot={id}>{children}</div>
    </section>
  )
}

function Snooze() {
  return (
    <CardActions>
      <button type="button" className={CARD_PRIMARY_ACTION}>
        <Hourglass size={12} className="translate-y-[calc(0.5em_-_0.5cap)]" />
        Snooze
      </button>
      <span className="min-w-0 flex-1 text-[11px] leading-snug text-muted-70">Hides card until new activity is detected</span>
    </CardActions>
  )
}

const REF = "font-medium text-fg/90"
const HIT = "group -mx-2 flex items-baseline rounded px-2 py-0.5 transition-colors hover:bg-fg/[0.045]"

// ══ A2 · THE SHIPPED ROW, PLUS THE THREE FIXES ════════════════════════════════════════════════════
/** Same gap-based rows as main, with the spinner, the failures button, the chevron, and — new — shells
 *  and sub-agents as siblings. The smallest possible diff from what is already on `main`. */
function A2({ rows }: { rows: Row[] }) {
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 flex flex-col gap-0.5 text-[12px] leading-5">
        {rows.map((r) => (
          <div key={label(r)} className={`${HIT} gap-1.5`}>
            <Mark r={r} />
            <span className={REF}>{label(r)}</span>
            <span className="min-w-0 truncate text-muted-80">{state(r)}</span>
            {isRed(r) && <ViewFailures />}
            <span className="flex-1" />
            <Chevron external={r.kind === "pr"} />
          </div>
        ))}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

// ══ B2 · TABULAR — FIXED COLUMNS ══════════════════════════════════════════════════════════════════
/** A real grid: mark, name, state, action, chevron. The name column sizes to the longest name and every
 *  state starts on ONE x, so the eye reads a column instead of scanning to wherever each name ended. */
function B2({ rows }: { rows: Row[] }) {
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 grid grid-cols-[auto_auto_1fr_auto_auto] text-[12px] leading-5">
        {rows.map((r) => (
          <div key={label(r)} className={`${HIT} col-span-5 grid grid-cols-subgrid gap-x-2.5`}>
            <Mark r={r} />
            <span className={REF}>{label(r)}</span>
            <span className="min-w-0 truncate text-muted-75">{state(r)}</span>
            {isRed(r) ? <ViewFailures /> : <span />}
            <Chevron external={r.kind === "pr"} />
          </div>
        ))}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

// ══ C2 · TABULAR — RULED ══════════════════════════════════════════════════════════════════════════
/** The same grid with a hairline between rows and the hit area bled to the card's full width. The most
 *  table-like, and the closest to a list you operate rather than a paragraph you read. */
function C2({ rows }: { rows: Row[] }) {
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="-mx-4 mt-3 grid grid-cols-[auto_auto_1fr_auto_auto] border-y border-border text-[12px] leading-5">
        {rows.map((r, i) => (
          <div
            key={label(r)}
            className={`group col-span-5 grid grid-cols-subgrid items-baseline gap-x-2.5 px-4 py-1.5 transition-colors hover:bg-fg/[0.045] ${i > 0 ? "border-t border-border/70" : ""}`}
          >
            <Mark r={r} />
            <span className={REF}>{label(r)}</span>
            <span className="min-w-0 truncate text-muted-75">{state(r)}</span>
            {isRed(r) ? <ViewFailures /> : <span />}
            <Chevron external={r.kind === "pr"} />
          </div>
        ))}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

// ══ D2 · TABULAR — RIGHT-ALIGNED STATE COLUMN ═════════════════════════════════════════════════════
/** Names left, state right-justified against the card edge just inside the chevron. The states stack
 *  into a column read in one pass; the ragged middle is the price. */
function D2({ rows }: { rows: Row[] }) {
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 grid grid-cols-[auto_1fr_auto_auto] text-[12px] leading-5">
        {rows.map((r) => (
          <div key={label(r)} className={`${HIT} col-span-4 grid grid-cols-subgrid gap-x-2.5`}>
            <Mark r={r} />
            <span className={`min-w-0 truncate ${REF}`}>{label(r)}</span>
            <span className="shrink-0 text-muted-70">{<StateCell r={r} />}</span>
            <Chevron external={r.kind === "pr"} />
          </div>
        ))}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

// ══ E2 · TABULAR — A KIND COLUMN ══════════════════════════════════════════════════════════════════
/** A leading TYPE column instead of a per-kind glyph, so what each row IS reads as data rather than as
 *  something you decode from an icon. Costs a column; pays for it the first time a shell and a PR are
 *  adjacent and you cannot tell which is which at a glance. */
function E2({ rows }: { rows: Row[] }) {
  const kindWord = (r: Row) => (r.kind === "pr" ? "pr" : r.kind === "shell" ? "shell" : "agent")
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 grid grid-cols-[auto_auto_auto_1fr_auto] text-[12px] leading-5">
        {rows.map((r) => (
          <div key={label(r)} className={`${HIT} col-span-5 grid grid-cols-subgrid gap-x-2.5`}>
            <Mark r={r} />
            <span className="w-9 shrink-0 text-[10.5px] uppercase tracking-wide text-muted-45">{kindWord(r)}</span>
            <span className={REF}>{label(r)}</span>
            <span className="min-w-0 truncate text-muted-75">{<StateCell r={r} />}</span>
            <Chevron external={r.kind === "pr"} />
          </div>
        ))}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

// ══ F2 · GROUPED BY KIND ══════════════════════════════════════════════════════════════════════════
/** Subheads instead of a kind column. Says outright that these are three different things the thread is
 *  waiting on, and gives each group a place to grow; costs a line per group on a card that is fighting
 *  for lines. */
function F2({ rows }: { rows: Row[] }) {
  const groups: Array<[string, Row[]]> = [
    ["Pull requests", rows.filter((r) => r.kind === "pr")],
    ["Background shells", rows.filter((r) => r.kind === "shell")],
    ["Sub-agents", rows.filter((r) => r.kind === "agent")],
  ]
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 flex flex-col gap-2.5 text-[12px] leading-5">
        {groups.filter(([, rs]) => rs.length > 0).map(([head, rs]) => (
          <div key={head} className="flex flex-col">
            <span className="text-[10.5px] uppercase tracking-wide text-muted-45">{head}</span>
            {rs.map((r) => (
              <div key={label(r)} className={`${HIT} gap-1.5`}>
                <Mark r={r} />
                <span className={REF}>{label(r)}</span>
                <span className="min-w-0 truncate text-muted-75">{<StateCell r={r} />}</span>
                <span className="flex-1" />
                <Chevron external={r.kind === "pr"} />
              </div>
            ))}
          </div>
        ))}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

// ══ G2 · DECLARED WAITS FIRST ═════════════════════════════════════════════════════════════════════
/** The card's one real hierarchy, drawn: a thing the worker PARKED on (a `pr-watch:` or a `watch:` line
 *  when this was drawn; `prs:` or `shells:` since the 2026-08-24 YAML cutover) is what the thread is
 *  waiting FOR; a dev server it happens to have left running is not. The
 *  declared waits are full rows; the incidental work collapses to a tail. */
function G2({ rows }: { rows: Row[] }) {
  // A SUB-AGENT IS ALWAYS A DECLARED WAIT: it returns and re-invokes the parent, so the thread is
  // genuinely waiting FOR it. Only an unwatched shell — a dev server left running — is incidental.
  const declared = rows.filter((r) => r.kind !== "shell" || r.watched)
  const incidental = rows.filter((r) => !declared.includes(r))
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 grid grid-cols-[auto_auto_1fr_auto] text-[12px] leading-5">
        {declared.map((r) => (
          <div key={label(r)} className={`${HIT} col-span-4 grid grid-cols-subgrid gap-x-2.5`}>
            <Mark r={r} />
            <span className={REF}>{label(r)}</span>
            <span className="min-w-0 truncate text-muted-75">{<StateCell r={r} />}</span>
            <Chevron external={r.kind === "pr"} />
          </div>
        ))}
      </div>
      {incidental.length > 0 && (
        <p className="mt-2 text-[11.5px] leading-4 text-muted-55">
          Also running: {incidental.map((r) => label(r)).join(", ")}
        </p>
      )}
      <Snooze />
    </TranscriptCard>
  )
}

// ══ H2 · TABULAR — TWO-LINE CELL ══════════════════════════════════════════════════════════════════
/** One row, two lines: the thing on top, its detail beneath in the same column. Buys back the room a
 *  long shell command or a sub-agent's task sentence needs, at exactly the cost round 1 removed. */
function H2({ rows }: { rows: Row[] }) {
  const detail = (r: Row) => (r.kind === "pr" ? `${r.since} ago · ${mergeWord(r) ?? "waiting on CI"}` : r.kind === "shell" ? `${r.taskId} · started ${r.since} ago` : `${r.profile} · started ${r.since} ago`)
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 grid grid-cols-[auto_1fr_auto_auto] gap-y-1.5 text-[12px] leading-5">
        {rows.map((r) => (
          <div key={label(r)} className={`${HIT} col-span-4 grid grid-cols-subgrid items-start gap-x-2.5`}>
            <span className="pt-[3px]"><Mark r={r} /></span>
            <span className="flex min-w-0 flex-col">
              <span className={`truncate ${REF}`}>{label(r)}</span>
              <span className="truncate text-[11px] leading-4 text-muted-55">{detail(r)}</span>
            </span>
            <span className="pt-[1px] text-muted-70">{isRed(r) ? <ViewFailures bare /> : r.kind === "pr" ? counts(r) : ""}</span>
            <span className="pt-[3px]"><Chevron external={r.kind === "pr"} /></span>
          </div>
        ))}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

// ══ I2 · TABULAR — WITH A HEADER ══════════════════════════════════════════════════════════════════
/** The most literal table: a dim header naming the columns. Justifies itself only if the card routinely
 *  holds enough rows to need one — it is a whole line spent on labels rather than on content. */
function I2({ rows }: { rows: Row[] }) {
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 grid grid-cols-[auto_1fr_auto_auto] text-[12px] leading-5">
        <div className="col-span-4 grid grid-cols-subgrid border-b border-border pb-1 text-[10px] uppercase tracking-wider text-muted-40">
          <span /><span>waiting on</span><span>state</span><span />
        </div>
        {rows.map((r) => (
          <div key={label(r)} className={`${HIT} col-span-4 mt-1 grid grid-cols-subgrid gap-x-2.5`}>
            <Mark r={r} />
            <span className={`min-w-0 truncate ${REF}`}>{label(r)}</span>
            <span className="shrink-0 text-muted-75">{<StateCell r={r} />}</span>
            <Chevron external={r.kind === "pr"} />
          </div>
        ))}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

// ══ J2 · TABULAR — MONO STATE COLUMN ══════════════════════════════════════════════════════════════
/** The state column set in tabular figures at one width, so the numbers line up digit under digit down
 *  the card the way a build log does. The densest the table gets while staying readable. */
function J2({ rows }: { rows: Row[] }) {
  const short = (r: Row) =>
    r.kind === "shell" ? (r.watched ? "watching" : "running")
    : r.kind === "agent" ? "working"
    : !r.polled ? "checking…"
    : r.checks === "failing" ? `${r.failed}✕ ${r.passed}✓`
    : r.checks === "running" ? `${r.running}◍ ${r.passed}✓`
    : r.checks === "passing" ? `${r.passed}✓` : "no checks"
  return (
    <TranscriptCard icon={Hourglass} label="Awaiting background work">
      <div className="mt-3 grid grid-cols-[auto_1fr_auto_auto_auto_auto] text-[12px] leading-5">
        {rows.map((r) => (
          <div key={label(r)} className={`${HIT} col-span-6 grid grid-cols-subgrid gap-x-2.5`}>
            <Mark r={r} />
            <span className={`min-w-0 truncate ${REF}`}>{label(r)}</span>
            <span className="shrink-0 tabular-nums text-muted-70">{short(r)}</span>
            <span className="shrink-0">{isRed(r) ? <ViewFailures bare /> : null}</span>
            <span className="w-10 shrink-0 text-right tabular-nums text-muted-45">{r.since}</span>
            <Chevron external={r.kind === "pr"} />
          </div>
        ))}
      </div>
      <Snooze />
    </TranscriptCard>
  )
}

// ---- the sheet -----------------------------------------------------------------------------------
const VARIANTS: Array<{ id: string; title: string; note: string; render: (rows: Row[]) => ReactNode }> = [
  { id: "A2", title: "Shipped rows + the three fixes", note: "The smallest diff from `main`: spinner for running, a `view failures` button instead of the job list, a chevron, and shells + sub-agents as sibling rows. Still gap-positioned, so each state starts wherever its name ended.", render: (r) => <A2 rows={r} /> },
  { id: "B2", title: "Tabular — fixed columns", note: "A real subgrid: mark, name, state, action, chevron. The name column sizes to the longest name so every state starts on ONE x. This is A2's density with the column discipline it lacks.", render: (r) => <B2 rows={r} /> },
  { id: "C2", title: "Tabular — ruled, full-bleed hit area", note: "The same grid with a hairline between rows and the hover fill bled to the card's edges. Reads as a list you operate rather than a paragraph you read; the rules add visual weight the card was trying to lose.", render: (r) => <C2 rows={r} /> },
  { id: "D2", title: "Tabular — state right-aligned", note: "Names left, state right-justified just inside the chevron. The states stack into a column you read in one pass; the ragged middle is the cost, and a long shell command truncates rather than pushing the state.", render: (r) => <D2 rows={r} /> },
  { id: "E2", title: "Tabular — a kind column", note: "A dim PR / SHELL / AGENT column instead of relying on the glyph alone. Costs a column; pays for it the first time a shell and a PR sit adjacent and you cannot tell which is which at a glance.", render: (r) => <E2 rows={r} /> },
  { id: "F2", title: "Grouped by kind", note: "Subheads rather than a column. Says outright that these are three different things the thread waits on, and gives each group room to grow — at a line per group on a card fighting for lines.", render: (r) => <F2 rows={r} /> },
  { id: "G2", title: "Declared waits first, the rest as a tail", note: "The card's one real hierarchy, drawn: a thing the worker PARKED on is what it waits FOR; a dev server it happens to have left running is not. Incidental work collapses to one dim line.", render: (r) => <G2 rows={r} /> },
  { id: "H2", title: "Tabular — two-line cell", note: "Name on top, its detail beneath: the shell's task id, the agent's profile, the PR's age. Buys back room for a long command, at exactly the vertical cost round 1 just removed.", render: (r) => <H2 rows={r} /> },
  { id: "I2", title: "Tabular — with a header row", note: "The most literal table. Justifies itself only if the card routinely holds enough rows to need one; otherwise it is a whole line spent on labels instead of content.", render: (r) => <I2 rows={r} /> },
  { id: "J2", title: "Tabular — mono state + elapsed", note: "State compressed to counted marks in tabular figures, with an elapsed column right-aligned. Digits line up down the card the way a build log does; the marks need one look to learn.", render: (r) => <J2 rows={r} /> },
]

function Sheet() {
  return (
    <div className="mx-auto flex w-[min(1320px,calc(100%-48px))] flex-col gap-10 py-10">
      <header className="flex flex-col gap-1">
        <h1 className="text-[15px] font-semibold text-fg">Resting card, round 2 — tabular, and with every kind of live work in it</h1>
        <p className="max-w-[92ch] text-[12px] leading-5 text-muted-80">
          Every variant keeps A's density and takes the four settled decisions: a yellow SPINNER for running checks,
          a <em>view failures</em> button instead of the job list, a chevron with the whole row as the target, and —
          new — background shells and sub-agents as rows beside the PRs. Left: a mixed thread (2 PRs, 2 shells, 1
          sub-agent). Right: one green mergeable PR.
          <code className="ml-1 text-muted-60">?font=mono</code>,
          <code className="ml-1 text-muted-60">?only=B2</code>.
        </p>
      </header>
      {VARIANTS.map((v) => (
        <Variant key={v.id} id={v.id} title={v.title} note={v.note}>
          <div className="flex flex-wrap items-start gap-6">
            <div className="w-[560px]">{v.render(MIXED)}</div>
            <div className="w-[560px]">{v.render(ONE)}</div>
          </div>
        </Variant>
      ))}
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Sheet />)
