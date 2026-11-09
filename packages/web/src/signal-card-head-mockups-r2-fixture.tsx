// MOCKUP SHEET, ROUND 2 — the signal cards' HEAD, with the kind glyph in the upper RIGHT corner.
//
// Not a test and not shipped UI: a design surface. Round 1 (signal-card-head-mockups-fixture.tsx) drew
// eight shapes and none landed. The maintainer's direction for this round (2026-10-13):
//
//   - "the icon [is] at the upper right, but … the header text flow[s] around it" — a FLOAT, so the
//     title's later lines reclaim the full width under the glyph instead of a column narrowed for its
//     whole height;
//   - "If there's no title, you just have some placeholder that says the word 'done'";
//   - "The first sentence of the body should never become the title";
//   - every block type has a header, titled or not.
//
// So every variant here keeps those four rules and varies everything else: how the glyph is drawn, what
// separates the head from the body, what else the head carries. Round 1's cards were squeezed into five
// columns, which is how they came out phone-width on a laptop; these sit at a fixed card width, with a
// width switch at the top for the phone (the switch is CSS, so it works in the static export too).
//
//   nubx vite --port 5478 --strictPort      (from packages/web)
//   http://localhost:5478/signal-card-head-mockups-r2-fixture.html
import { createRoot } from "react-dom/client"
import { useMemo, type ReactNode } from "react"
import { Check, CircleHelp, GitPullRequest, Hourglass, ListTodo, X, type LucideIcon } from "lucide-react"
import type { ThreadView } from "@frizz/shared"
import { CardActions, CARD_LINK, CARD_PRIMARY_ACTION } from "./components/TranscriptCard.tsx"
import { AwaitingWaitTable } from "./components/AwaitingBackgroundCard.tsx"
import { StepsList } from "./components/AwaitingSteps.tsx"
import { ICON_LABEL_NUDGE } from "./lib/iconAlign.ts"
import { mdToHtml } from "./lib/markdown.ts"
import "./styles.css"

document.documentElement.dataset.font = "sans"
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark"

// ---- the five cards ------------------------------------------------------------------------------
type Kind = { icon: LucideIcon; label: string; meta: string }
const DONE: Kind = { icon: Check, label: "Done", meta: "Done" }
const AWAITING: Kind = { icon: Hourglass, label: "Awaiting", meta: "Awaiting" }
const HUMAN: Kind = { icon: ListTodo, label: "Awaiting human", meta: "Awaiting human" }
const QUESTION: Kind = { icon: CircleHelp, label: "Question", meta: "Question" }

const PR = "acme/app#391"
const PR_URL = "https://github.com/acme/app/pull/391"

type Scenario = {
  key: string
  caption: string
  kind: Kind
  title: string | null
  prose: string
  rows?: "agent" | "steps" | "options"
  pr?: boolean
  action?: boolean
  // What a meta line under the title would say, beside the kind (variant F).
  meta: ReactNode
}

const DONE_TITLED: Scenario = {
  key: "done-titled",
  caption: "done · a title long enough to wrap",
  kind: DONE,
  title: "Silent token refresh on 401: concurrent requests now share one refresh, and a regression test pins the race",
  prose: "The client now retries once with a fresh token when the API answers 401.\n\n- **Fixed the refresh race** in `src/auth/refresh.ts` — concurrent 401s share one refresh.\n- **Added a regression test**; `npm test` green.",
  action: true,
  meta: "4m ago",
}
const DONE_UNTITLED: Scenario = { ...DONE_TITLED, key: "done-untitled", caption: "done · no title, so the placeholder", title: null }
const AWAITING_PR: Scenario = {
  key: "awaiting",
  caption: "awaiting · title, a PR, a sub-agent",
  kind: AWAITING,
  title: "Real CI run on the perf fix",
  prose: "Waiting on the genuine CI run on head `85eca799`. Lint is green; the three TypeScript legs are still running.",
  rows: "agent",
  pr: true,
  meta: <>watching <a href={PR_URL} className={CARD_LINK}>{PR}</a></>,
}
const STEPS: Scenario = {
  key: "steps",
  caption: "awaiting human · steps",
  kind: HUMAN,
  title: "Sign in to npm so the acme 4.2.0 release can publish",
  prose: "The 4.2.0 tag is cut and verified. The publish step runs as the acme-bot account.",
  rows: "steps",
  meta: "2 steps for you",
}
const QUESTION_CARD: Scenario = {
  key: "question",
  caption: "question · the ask is the title, with its ×",
  kind: QUESTION,
  title: "Should the settings store use SQLite or a JSON file?",
  prose: "",
  rows: "options",
  meta: "pick one",
}
const SCENARIOS = [DONE_TITLED, DONE_UNTITLED, AWAITING_PR, STEPS, QUESTION_CARD]

// ---- shared pieces --------------------------------------------------------------------------------
const isQ = (s: Scenario) => s.kind === QUESTION
const shell = (s: Scenario, extra = "") =>
  `mock-card min-w-0 rounded-xl border p-4 ${isQ(s) ? "border-question-border bg-question" : "border-border-strong bg-panel-2"} ${extra}`
const TITLE = "text-[16px] font-semibold leading-6 tracking-tight text-fg [overflow-wrap:anywhere]"
const RULE = "-mx-4 border-t border-border"
const titleOf = (s: Scenario) => s.title ?? s.kind.label

function Md({ md }: { md: string }) {
  const html = useMemo(() => ({ __html: mdToHtml(md) }), [md])
  return <div className="md-body" dangerouslySetInnerHTML={html} />
}

const agentThread = {
  id: "mock",
  subAgents: [{ id: "toolu_a", label: "Bisect the slow typecheck leg", subagentType: "frizz:opus-high", startedAt: new Date(Date.now() - 4 * 60_000).toISOString(), state: "running" }],
  bgShells: [],
  watches: [],
} as unknown as Pick<ThreadView, "id" | "subAgents" | "bgShells" | "watches">

function Dismiss() {
  return <X size={14} aria-hidden className="shrink-0 text-muted" />
}

function Options() {
  const options = [
    { label: "SQLite", description: "transactional, matches how sessions are already stored", recommended: true },
    { label: "JSON file", description: "zero deps, human-editable, racy under concurrent writes" },
  ]
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {options.map((o, i) => (
        <div key={o.label} className="relative flex items-baseline gap-2 rounded-md border border-border px-3 py-1.5 text-[12px] leading-snug text-fg/90">
          <span aria-hidden className="flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-b-2 border-border-strong bg-panel text-[10.5px] font-medium leading-none tabular-nums text-muted">{i + 1}</span>
          <div className="min-w-0 flex-1">
            <div>
              {o.recommended && <span className="float-right ml-2 mt-px rounded-full border border-border-strong px-1.5 py-px text-[9.5px] leading-none uppercase tracking-wide text-muted">Recommended</span>}
              {o.label}
            </div>
            <div className="mt-0.5 text-[11.5px] opacity-90">{o.description}</div>
          </div>
        </div>
      ))}
      <div className="rounded-md border border-border px-3 py-1.5 text-[12px] leading-snug text-muted">Something else…</div>
    </div>
  )
}

function StepsBox() {
  return (
    <div className="relative mt-3 flex items-center rounded-md border border-border px-3 py-2.5 text-[13px] leading-5 text-fg/90">
      <span aria-hidden className="relative size-[18px] shrink-0 rounded-[4px] border border-control-strong bg-panel" />
      <span className="ml-2 font-medium">I have completed this</span>
    </div>
  )
}

function MarkDone() {
  return (
    <CardActions>
      <button type="button" className={`${CARD_PRIMARY_ACTION} px-2.5 py-1`}>
        <Check size={12} className={ICON_LABEL_NUDGE} />
        Mark as done
      </button>
    </CardActions>
  )
}

// The body: prose, the PR on a line of its own under it (unless the head took it), the scenario's rows.
// The action band is drawn by the card, after this, because one variant puts the body in a well.
function Body({ s, top = "mt-3", prInHead = false, divider = true }: { s: Scenario; top?: string; prInHead?: boolean; divider?: boolean }) {
  return (
    <div className={`card-md ${top} min-w-0 text-fg/75`}>
      {s.prose && <Md md={s.prose} />}
      {s.pr && !prInHead && (
        <div className="mt-2 flex items-center gap-1.5 text-[12px] text-muted">
          <GitPullRequest size={12} aria-hidden className="shrink-0" />
          <a href={PR_URL} className={`${CARD_LINK} text-[12px]`}>{PR}</a>
        </div>
      )}
      {s.rows === "steps" && (
        <>
          <StepsList steps={[{ text: "Run `npm login --auth-type=web` in a terminal on this machine." }, { text: "Approve the browser prompt with the **acme-bot** account." }]} />
          <StepsBox />
        </>
      )}
      {s.rows === "agent" && <AwaitingWaitTable thread={agentThread} divider={divider} />}
      {s.rows === "options" && <Options />}
    </div>
  )
}

// The glyph (and a question's ×) as one right-floated cluster, `h` tall so it centres on the first line.
function FloatGlyph({ s, h = "h-6", className = "", size = 16, stroke }: { s: Scenario; h?: string; className?: string; size?: number; stroke?: number }) {
  const Icon = s.kind.icon
  return (
    <span className={`float-right ml-3 flex ${h} items-center gap-2.5 ${className}`}>
      <Icon size={size} strokeWidth={stroke} aria-hidden className="shrink-0" />
      {isQ(s) && <Dismiss />}
    </span>
  )
}

// ---- the variants ---------------------------------------------------------------------------------
type Variant = { id: string; name: string; note: ReactNode; render: (s: Scenario) => ReactNode }

const VARIANTS: Variant[] = [
  {
    id: "A",
    name: "Plain float, ruled",
    note: <>The direction as stated and nothing more: a 16px title, the glyph floated into its first line's right end, a full-bleed rule under the head. The title's second line runs under the glyph.</>,
    render: (s) => (
      <div className={shell(s)}>
        <div className={`flow-root ${TITLE}`}>
          <FloatGlyph s={s} className="text-fg/60" />
          {titleOf(s)}
        </div>
        <div aria-hidden className={`${RULE} mt-3.5`} />
        <Body s={s} />
        {s.action && <MarkDone />}
      </div>
    ),
  },
  {
    id: "B",
    name: "Glyph on a tile",
    note: <>The glyph sits on a 32px rounded tile, like an app icon. The tile is taller than one line, so the title's first line AND the top of its second wrap around it. The head reads as a header without a band.</>,
    render: (s) => (
      <div className={shell(s)}>
        <div className={`flow-root ${TITLE}`}>
          <span className="float-right -mt-1 mb-1 ml-3 flex items-center gap-2.5">
            <span className="flex size-8 items-center justify-center rounded-lg bg-fg/[0.07] text-fg/80"><s.kind.icon size={16} aria-hidden /></span>
            {isQ(s) && <Dismiss />}
          </span>
          {titleOf(s)}
        </div>
        <div aria-hidden className={`${RULE} mt-3.5`} />
        <Body s={s} />
        {s.action && <MarkDone />}
      </div>
    ),
  },
  {
    id: "C",
    name: "Corner tab",
    note: <>The glyph lives in a filled tab cut into the card's top-right corner, sharing the card's own rounded corner. The title flows around the tab. The tab is the card's "kind" without a word.</>,
    render: (s) => (
      <div className={shell(s)}>
        <div className={`flow-root ${TITLE}`}>
          <span className="float-right -mr-4 -mt-4 mb-1 ml-3 flex h-11 items-center gap-2.5 rounded-bl-xl rounded-tr-[calc(var(--block-radius)_-_1px)] border-b border-l border-border bg-fg/[0.05] px-3.5 text-fg/75">
            <s.kind.icon size={16} aria-hidden />
            {isQ(s) && <Dismiss />}
          </span>
          {titleOf(s)}
        </div>
        <div aria-hidden className={`${RULE} mt-3.5`} />
        <Body s={s} />
        {s.action && <MarkDone />}
      </div>
    ),
  },
  {
    id: "D",
    name: "Watermark",
    note: <>An oversized glyph at 7% strength, bleeding off the top-right corner; the title flows around the part inside the card. The kind is felt rather than read, and the head carries no chrome at all beyond its rule.</>,
    render: (s) => (
      <div className={shell(s, "relative overflow-hidden")}>
        <s.kind.icon aria-hidden size={84} strokeWidth={1.5} className="pointer-events-none absolute -right-4 -top-5 text-fg/[0.07]" />
        <div className={`relative flow-root ${TITLE}`}>
          <span className="float-right ml-3 flex h-10 w-12 items-start justify-end">{isQ(s) && <span className="flex h-6 items-center"><Dismiss /></span>}</span>
          {titleOf(s)}
        </div>
        <div aria-hidden className={`relative ${RULE} mt-3.5`} />
        <div className="relative"><Body s={s} /></div>
        {s.action && <MarkDone />}
      </div>
    ),
  },
  {
    id: "E",
    name: "Kind as a small word over the title, tall glyph",
    note: <>A titled card says its kind once, small and muted, above the title; a 28px glyph floats beside both lines. Untitled, the placeholder IS the kind, so the small word drops and the head is one line.</>,
    render: (s) => (
      <div className={shell(s)}>
        <div className="flow-root">
          <span className="float-right ml-4 flex items-start gap-2.5 pt-0.5 text-fg/55">
            <s.kind.icon size={28} strokeWidth={1.6} aria-hidden />
            {isQ(s) && <span className="flex h-6 items-center"><Dismiss /></span>}
          </span>
          {s.title && <div className="text-[12px] font-medium leading-4 text-muted">{s.kind.label}</div>}
          <div className={`${s.title ? "mt-0.5" : "mt-0.5"} ${TITLE}`}>{titleOf(s)}</div>
        </div>
        <div aria-hidden className={`${RULE} mt-3.5`} />
        <Body s={s} />
        {s.action && <MarkDone />}
      </div>
    ),
  },
  {
    id: "F",
    name: "Title and a meta line — the PR moves into the head",
    note: <>Under the title, one muted line of facts about the card: its kind, when, and what it watches. The upper-right PR link becomes "Awaiting · watching acme/app#391", so the head says why the card names it. Untitled, the meta line drops its kind (the placeholder already says it).</>,
    render: (s) => (
      <div className={shell(s)}>
        <div className="flow-root">
          <span className="float-right ml-3 flex h-6 items-center gap-2.5 text-fg/60">
            <s.kind.icon size={16} aria-hidden />
            {isQ(s) && <Dismiss />}
          </span>
          <div className={TITLE}>{titleOf(s)}</div>
          <div className="mt-0.5 text-[12px] leading-4 text-muted">
            {s.title ? <>{s.kind.meta} · {s.meta}</> : s.meta}
          </div>
        </div>
        <div aria-hidden className={`${RULE} mt-3`} />
        <Body s={s} prInHead />
        {s.action && <MarkDone />}
      </div>
    ),
  },
  {
    id: "G",
    name: "Kind word leading the title, in the same run",
    note: <>The kind is the title's first word, muted — "Done Silent token refresh…" — so kind and title flow as one sentence around the glyph. Untitled, the kind word alone is the title, at full strength.</>,
    render: (s) => (
      <div className={shell(s)}>
        <div className={`flow-root ${TITLE}`}>
          <FloatGlyph s={s} className="text-fg/60" />
          {s.title ? <><span className="font-medium text-muted">{s.kind.label}</span><span className="mx-1.5 font-normal text-muted/60">/</span>{s.title}</> : s.kind.label}
        </div>
        <div aria-hidden className={`${RULE} mt-3.5`} />
        <Body s={s} />
        {s.action && <MarkDone />}
      </div>
    ),
  },
  {
    id: "H",
    name: "Header on the card, body in a well",
    note: <>No rule: the head sits on the card's own surface and the body drops into a recessed well inside it. The separation is a change of surface, so the head reads as the card's lid. The action band stays on the card.</>,
    render: (s) => (
      <div className={shell(s)}>
        <div className={`flow-root ${TITLE}`}>
          <FloatGlyph s={s} className="text-fg/60" />
          {titleOf(s)}
        </div>
        <div className="mt-3 rounded-lg border border-border bg-bg/40 px-3 pb-3">
          <Body s={s} divider={false} />
        </div>
        {s.action && <MarkDone />}
      </div>
    ),
  },
  {
    id: "I",
    name: "Lit header strip",
    note: <>The head is a filled strip flush with the card's top, the footer band's twin, holding the 16px title and the floated glyph. Round 1's E, but with the title at title size and no chip.</>,
    render: (s) => (
      <div className={shell(s, "pt-0")}>
        <div className={`-mx-4 flow-root rounded-t-[calc(var(--block-radius)_-_1px)] border-b border-border bg-fg/[0.04] px-4 pb-3 pt-3.5 ${TITLE}`}>
          <FloatGlyph s={s} className="text-fg/60" />
          {titleOf(s)}
        </div>
        <Body s={s} top="mt-3.5" />
        {s.action && <MarkDone />}
      </div>
    ),
  },
  {
    id: "J",
    name: "Display title, short underline",
    note: <>A larger title (18px) and, instead of a full-bleed rule, a short 24px bar under it at the card's left edge — a section heading's mark rather than a divider. The glyph is the larger title's size.</>,
    render: (s) => (
      <div className={shell(s)}>
        <div className="flow-root text-[18px] font-semibold leading-[26px] tracking-tight text-fg [overflow-wrap:anywhere]">
          <span className="float-right ml-3 flex h-[26px] items-center gap-2.5 text-fg/60">
            <s.kind.icon size={18} aria-hidden />
            {isQ(s) && <Dismiss />}
          </span>
          {titleOf(s)}
        </div>
        <div aria-hidden className="mt-3 h-0.5 w-6 rounded-full bg-fg/25" />
        <Body s={s} top="mt-3.5" />
        {s.action && <MarkDone />}
      </div>
    ),
  },
  {
    id: "K",
    name: "Corner seal",
    note: <>The glyph leaves the card: a small round seal straddling the top-right corner, like a badge pinned to it. The title gets the full width; nothing has to flow. A question's × stays inside the card.</>,
    render: (s) => (
      <div className={shell(s, "relative")}>
        <span className="absolute -right-2.5 -top-2.5 flex size-7 items-center justify-center rounded-full border border-border-strong bg-panel-2 text-fg/75 shadow-sm">
          <s.kind.icon size={14} aria-hidden />
        </span>
        <div className={`flow-root ${TITLE}`}>
          {isQ(s) && <span className="float-right ml-3 mr-3 flex h-6 items-center"><Dismiss /></span>}
          {titleOf(s)}
        </div>
        <div aria-hidden className={`${RULE} mt-3.5`} />
        <Body s={s} />
        {s.action && <MarkDone />}
      </div>
    ),
  },
]

// ---- the page ---------------------------------------------------------------------------------
// The width switch is CSS alone (a radio and `:has()`), so it still works once the page is exported
// without its scripts. 640px is the queue card's inner width on a laptop; 358px is a phone's.
const WIDTH_CSS = `
.mock-card { width: 640px; }
body:has(#w-phone:checked) .mock-card { width: 358px; }
.width-switch label { cursor: pointer; }
.width-switch input:checked + span { background: color-mix(in oklab, currentColor 14%, transparent); color: var(--color-fg); }
`

function Sheet() {
  return (
    <main className="mx-auto flex w-full max-w-[2100px] flex-col gap-12 px-8 pb-16 text-fg">
      <style>{WIDTH_CSS}</style>
      <header className="sticky top-0 z-10 -mx-8 flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-border bg-bg/95 px-8 py-3 backdrop-blur">
        <h1 className="text-[17px] font-semibold tracking-tight">Signal card heads · round 2</h1>
        <div className="width-switch flex items-center gap-1 rounded-full border border-border p-0.5 text-[12px] text-muted">
          <label><input type="radio" name="w" id="w-desk" defaultChecked className="sr-only" /><span className="block rounded-full px-3 py-1">Laptop · 640px</span></label>
          <label><input type="radio" name="w" id="w-phone" className="sr-only" /><span className="block rounded-full px-3 py-1">Phone · 358px</span></label>
        </div>
        <nav className="flex flex-wrap gap-x-3 text-[12px]">
          {VARIANTS.map((v) => <a key={v.id} href={`#${v.id}`} className="text-muted hover:text-fg">{v.id} · {v.name.split(" — ")[0].split(",")[0]}</a>)}
        </nav>
      </header>
      <p className="-mt-6 max-w-[900px] text-[13px] leading-5 text-fg/75">
        Every variant keeps the glyph in the upper right with the title wrapping around it, the kind's word as the title when the worker gave none,
        and a head on every card. The same five cards in each: a done card with a title long enough to wrap, a done card with none, an awaiting
        card with a PR and a sub-agent, an "Awaiting human" card, and a question with its ×.
      </p>
      {VARIANTS.map((v) => (
        <section key={v.id} id={v.id} data-variant={v.id} className="flex scroll-mt-20 flex-col gap-3">
          <div className="flex max-w-[1000px] flex-col gap-1">
            <h2 className="text-[15px] font-semibold"><span className="mr-2 text-accent">{v.id}</span>{v.name}</h2>
            <p className="text-[12.5px] leading-5 text-fg/70">{v.note}</p>
          </div>
          <div className="flex flex-wrap items-start gap-x-5 gap-y-6">
            {SCENARIOS.map((s) => (
              <div key={s.key} className="flex flex-col gap-1.5">
                <p className="text-[11px] text-muted">{s.caption}</p>
                {v.render(s)}
              </div>
            ))}
          </div>
        </section>
      ))}
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Sheet />)
