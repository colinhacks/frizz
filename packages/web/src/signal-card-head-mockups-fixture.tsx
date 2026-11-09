// MOCKUP SHEET — the signal cards' HEAD, and where an awaiting card's watched PR goes.
//
// Not a test and not shipped UI: a design surface. On 2026-10-13 every done and awaiting card took the
// steps card's kind-chip head (d7d047ce), and the maintainer's reading of it: "It's like a giant header,
// but it just contains a single, pretty useless chip. Maybe we should support the agent providing a title
// for the [done] block … What's going on with that PR link in the upper-right corner? That's weird."
//
// Two sections. HEADS: one row per head shape, the same five cards in each (a titled done, a done the
// worker gave no title, a titled awaiting card over a sub-agent row, a steps card, a registered question) so a shape is judged on
// every kind at once — a head that only works when there is a title is visible as such. PR PLACEMENT: one
// head, six places for the one watched PR the wait table does not row.
//
//   nubx vite --port 5478 --strictPort      (from packages/web)
//   http://localhost:5478/signal-card-head-mockups-fixture.html          — ?only=C for one shape
//
// Everything renders in the REAL stylesheet, through the shipped pieces where they exist (the kind
// chip as it then shipped, CardHead, CardActions, the wait table, the steps list), so a choice made
// here is a choice about the thing that ships.
import { createRoot } from "react-dom/client"
import { Fragment, useMemo, type ReactNode } from "react"
import { Check, CircleHelp, GitPullRequest, Hourglass, ListTodo, X, type LucideIcon } from "lucide-react"
import type { ThreadView, ThreadWatchView } from "@frizz/shared"
import { CardActions, CardHead, CARD_LINK, CARD_PRIMARY_ACTION } from "./components/TranscriptCard.tsx"
import { AwaitingWaitTable, GithubWatchRow } from "./components/AwaitingBackgroundCard.tsx"
import { StepsList } from "./components/AwaitingSteps.tsx"
import { ICON_LABEL_NUDGE } from "./lib/iconAlign.ts"
import { mdToHtml } from "./lib/markdown.ts"
import "./styles.css"

const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = "sans"
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark"
const only = params.get("only")?.toUpperCase() ?? null

// ---- the four cards ------------------------------------------------------------------------------
type Kind = { icon: LucideIcon; label: string }
const DONE: Kind = { icon: Check, label: "Done" }
const AWAITING: Kind = { icon: Hourglass, label: "Awaiting" }
const HUMAN: Kind = { icon: ListTodo, label: "Awaiting human" }
const QUESTION: Kind = { icon: CircleHelp, label: "Question" }

const PR = "acme/app#391"
const PR_URL = "https://github.com/acme/app/pull/391"

type Scenario = {
  key: string
  caption: string
  kind: Kind
  title: string | null
  prose: string
  rows?: "agent" | "steps" | "options"
  surface?: "question"
  pr?: boolean
  action?: boolean
}

const DONE_TITLED: Scenario = {
  key: "done-titled",
  caption: "done · worker wrote a title",
  kind: DONE,
  title: "Silent token refresh on 401",
  prose: "The client now retries once with a fresh token when the API answers 401.\n\n- **Fixed the refresh race** in `src/auth/refresh.ts` — concurrent 401s share one refresh.\n- **Added a regression test**; `npm test` green.",
  action: true,
}
const DONE_UNTITLED: Scenario = { ...DONE_TITLED, key: "done-untitled", caption: "done · no title", title: null }
const AWAITING_PR: Scenario = {
  key: "awaiting",
  caption: "awaiting · title, a PR, a sub-agent",
  kind: AWAITING,
  title: "Real CI run on the perf fix",
  prose: "Waiting on the genuine CI run on head `85eca799`. Lint is green; the three TypeScript legs are still running.",
  rows: "agent",
  pr: true,
}
const STEPS: Scenario = {
  key: "steps",
  caption: "awaiting human · steps",
  kind: HUMAN,
  title: "Sign in to npm so the acme 4.2.0 release can publish",
  prose: "The 4.2.0 tag is cut and verified. The publish step runs as the acme-bot account.",
  rows: "steps",
}
// A REGISTERED QUESTION already carries a one-line `question` and its options apart, so its head has a
// title to hold without anything new in the contract: the ask is the title, the options the body.
const QUESTION_CARD: Scenario = {
  key: "question",
  caption: "question · the ask is the title",
  kind: QUESTION,
  title: "Should the settings store use SQLite or a JSON file?",
  prose: "",
  rows: "options",
  surface: "question",
}
const SCENARIOS = [DONE_TITLED, DONE_UNTITLED, AWAITING_PR, STEPS, QUESTION_CARD]

// ---- shared pieces --------------------------------------------------------------------------------
// The kind CHIP as it shipped in d7d047ce, kept here because the shipped one became a kind LINE after this
// round (TranscriptCard's KindLabel) and this sheet is the record of what it was weighed against.
function KindChip({ icon: Icon, children }: { icon?: LucideIcon; children: ReactNode }) {
  return (
    <span data-card-chip className="inline-flex shrink-0 items-center gap-[5px] rounded-full bg-fg/[0.08] px-2 py-0.5 text-[11px] font-medium leading-4 text-fg/85">
      {Icon && <Icon aria-hidden="true" size={12} className="shrink-0" />}
      {children}
    </span>
  )
}
const SHELL_BASE = "min-w-0 rounded-xl border p-4"
const shell = (s: Scenario) => `${SHELL_BASE} ${s.surface === "question" ? "border-question-border bg-question" : "border-border-strong bg-panel-2"}`
const TITLE = "min-w-0 text-[16px] font-semibold leading-6 tracking-tight text-fg [overflow-wrap:anywhere]"
const RULE = "-mx-4 border-t border-border"

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

const prWatch: ThreadWatchView = {
  id: `github:mock:${PR}`,
  kind: "github",
  target: PR,
  state: "armed",
  createdAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  github: { checks: "running", running: 3, passed: 12, failed: 0, skipped: 0, gated: 0, gating: [], failing: [], merge: "unknown", state: "open", polledAt: new Date().toISOString() },
} as unknown as ThreadWatchView

function PrLink({ className = "" }: { className?: string }) {
  return <a href={PR_URL} target="_blank" rel="noreferrer" className={`${CARD_LINK} text-[12px] ${className}`}>{PR}</a>
}

function StepsBox() {
  return (
    <div className="relative mt-3 flex items-center rounded-md border border-border px-3 py-2.5 text-[13px] leading-5 text-fg/90">
      <span aria-hidden className="relative size-[18px] shrink-0 rounded-[4px] border border-control-strong bg-panel" />
      <span className="ml-2 font-medium">I have completed this</span>
    </div>
  )
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

// Where the PR goes, when a head does not put it somewhere of its own.
type PrPlace = "corner" | "chip" | "meta" | "row" | "under" | "none"

// The card's body: prose, then the scenario's rows, then its action band. `prUnder` puts the PR on a
// line of its own under the prose (the shape several PRs already take).
function Body({ s, ruled, pr }: { s: Scenario; ruled: boolean; pr: PrPlace }) {
  return (
    <div className={`card-md ${ruled ? "mt-3" : "mt-1"} min-w-0 text-fg/75`}>
      {s.prose && <Md md={s.prose} />}
      {s.pr && pr === "under" && (
        <div className="mt-2 flex items-center gap-1.5 text-[12px] text-muted">
          <GitPullRequest size={12} aria-hidden className="shrink-0" />
          <PrLink />
        </div>
      )}
      {s.rows === "steps" && (
        <>
          <StepsList steps={[{ text: "Run `npm login --auth-type=web` in a terminal on this machine." }, { text: "Approve the browser prompt with the **acme-bot** account." }]} />
          <StepsBox />
        </>
      )}
      {s.rows === "agent" && <AwaitingWaitTable thread={agentThread} divider />}
      {s.rows === "options" && <Options />}
      {s.pr && pr === "row" && (
        <div className="-mx-2 mt-1 flex flex-col">
          <GithubWatchRow watch={prWatch} />
        </div>
      )}
      {s.action && <MarkDone />}
    </div>
  )
}

// ---- the HEAD shapes ------------------------------------------------------------------------------
type Variant = { id: string; name: string; note: ReactNode; render: (s: Scenario, pr?: PrPlace) => ReactNode }

// A: what is on `main` (d7d047ce) — chip, the title under it when there is one, a rule.
function ChipOverTitle({ s, pr = "corner" }: { s: Scenario; pr?: PrPlace }) {
  return (
    <div className={shell(s)}>
      <div className="flex min-w-0 items-center gap-2">
        <KindChip icon={s.kind.icon}>{s.kind.label}</KindChip>
        {s.pr && pr === "chip" && <PrChip />}
        {s.pr && pr === "corner" && <span className="ml-auto shrink-0"><PrLink /></span>}
        {s.kind === QUESTION && <span className="ml-auto flex shrink-0"><Dismiss /></span>}
      </div>
      {s.title && <div className={`mt-1.5 ${TITLE}`}>{s.title}</div>}
      {s.title && s.pr && pr === "meta" && <PrMeta />}
      <div aria-hidden className={`${RULE} ${s.title ? "mt-3.5" : "mt-[17px]"}`} />
      <Body s={s} ruled pr={pr} />
    </div>
  )
}

function Dismiss() {
  return <X size={14} aria-hidden className="shrink-0 text-muted" />
}

function PrChip() {
  return (
    <a href={PR_URL} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-[5px] rounded-full bg-fg/[0.08] px-2 py-0.5 text-[11px] font-medium leading-4 text-fg/85 hover:bg-fg/[0.12]">
      <GitPullRequest size={12} aria-hidden className="shrink-0" />
      {PR}
    </a>
  )
}

function PrMeta() {
  return (
    <div className="mt-1 flex items-center gap-1.5 text-[12px] leading-4 text-muted">
      <GitPullRequest size={12} aria-hidden className="shrink-0" />
      <span>Watching</span>
      <PrLink />
    </div>
  )
}

const VARIANTS: Variant[] = [
  {
    id: "A",
    name: "Today — chip over the title, then a rule",
    note: <>What <code>main</code> draws. With no title the band is a 20px chip in 54px of header: the "giant header with one chip". The PR floats at the far right of the chip row.</>,
    render: (s) => <ChipOverTitle s={s} />,
  },
  {
    id: "B",
    name: "Chip over the title — and the kind's word as the title when there is none",
    note: <>A titled card is A. An untitled one never shows a lone chip: its head is the glyph and the kind's word at title size, still ruled off. Done takes a <code>title:</code> as awaiting does. Two head shapes, each one full.</>,
    render: (s) =>
      s.title ? <ChipOverTitle s={s} pr="under" /> : (
        <div className={shell(s)}>
          <CardHead icon={s.kind.icon} label={s.kind.label} />
          <div aria-hidden className={`${RULE} mt-3.5`} />
          <Body s={s} ruled pr="under" />
        </div>
      ),
  },
  {
    id: "C",
    name: "One row — the chip leads the title",
    note: <>The chip is a prefix on the title's own line, so the head is one line tall either way. Untitled, the chip sits alone on that line — smaller, but still a chip with nothing beside it.</>,
    render: (s) => (
      <div className={shell(s)}>
        <div className="flex min-w-0 items-start gap-2">
          <span className="flex h-6 shrink-0 items-center"><KindChip icon={s.kind.icon}>{s.kind.label}</KindChip></span>
          {s.title && <div className={`flex-1 ${TITLE}`}>{s.title}</div>}
          {s.kind === QUESTION && <span className="flex h-6 shrink-0 items-center"><Dismiss /></span>}
        </div>
        <div aria-hidden className={`${RULE} mt-3.5`} />
        <Body s={s} ruled pr="under" />
      </div>
    ),
  },
  {
    id: "D",
    name: "Title-led — the glyph alone names the kind",
    note: <>No chip: the glyph and a 16px title (the worker's, or the kind's word when it gave none), then a rule. The steps card loses its "Awaiting human" words to its title — the glyph is all that says it.</>,
    render: (s) => (
      <div className={shell(s)}>
        <CardHead icon={s.kind.icon} label={<span className="[overflow-wrap:anywhere]">{s.title ?? s.kind.label}</span>} aside={s.kind === QUESTION ? <span className="flex h-6 items-center"><Dismiss /></span> : undefined} />
        <div aria-hidden className={`${RULE} mt-3.5`} />
        <Body s={s} ruled pr="under" />
      </div>
    ),
  },
  {
    id: "E",
    name: "Header band — a recessed strip, the footer's twin",
    note: <>The head is a filled strip flush with the top corners, the same fill and rule as the action footer, so the card reads header / body / footer. Slim (one 14px line) whether or not there is a title.</>,
    render: (s) => (
      <div className={`${shell(s)} pt-0`}>
        <div className="-mx-4 flex min-w-0 items-start gap-2 rounded-t-[calc(var(--block-radius)_-_1px)] border-b border-border bg-fg/[0.03] px-4 py-2.5">
          <span className="flex h-5 shrink-0 items-center"><KindChip icon={s.kind.icon}>{s.kind.label}</KindChip></span>
          {s.title && <div className="min-w-0 flex-1 text-[14px] font-semibold leading-5 text-fg [overflow-wrap:anywhere]">{s.title}</div>}
          {s.kind === QUESTION && <span className="ml-auto flex h-5 shrink-0 items-center"><Dismiss /></span>}
        </div>
        <div className="pt-1"><Body s={s} ruled pr="under" /></div>
      </div>
    ),
  },
  {
    id: "F",
    name: "Eyebrow — the kind as a small label, no pill",
    note: <>The kind is a muted 12px label with its glyph above the title. With no title the eyebrow alone is the head, still ruled off — the shortest head here.</>,
    render: (s) => (
      <div className={shell(s)}>
        <div className="flex items-center gap-1.5 text-[12px] font-medium leading-4 text-muted">
          <s.kind.icon size={12} aria-hidden className="shrink-0" />
          {s.kind.label}
          {s.kind === QUESTION && <span className="ml-auto flex"><Dismiss /></span>}
        </div>
        {s.title && <div className={`mt-1 ${TITLE}`}>{s.title}</div>}
        <div aria-hidden className={`${RULE} ${s.title ? "mt-3.5" : "mt-3"}`} />
        <Body s={s} ruled pr="under" />
      </div>
    ),
  },
  {
    id: "G",
    name: "The lede becomes the title",
    note: <>A done card the worker did not title is headed by the first sentence of its body — the contract already asks for one to three sentences before the bullets. Every card then has a title; the body loses the line it gave up.</>,
    render: (s) => {
      if (s.title || s.kind !== DONE) return <ChipOverTitle s={s} pr="under" />
      const [lede, ...rest] = s.prose.split("\n\n")
      return <ChipOverTitle s={{ ...s, title: lede.replace(/\.$/, ""), prose: rest.join("\n\n") }} pr="under" />
    },
  },
  {
    id: "H",
    name: "Title first, the kind chip at its right end",
    note: <>The title leads in the card's corner, as a document title would, and the chip rides the far right of that line. Untitled, the kind's word is the title and the chip drops.</>,
    render: (s) => (
      <div className={shell(s)}>
        <div className="flex min-w-0 items-start gap-3">
          {s.title ? <div className={`flex-1 ${TITLE}`}>{s.title}</div> : <div className="flex-1"><CardHead icon={s.kind.icon} label={s.kind.label} /></div>}
          {s.title && <span className="flex h-6 shrink-0 items-center"><KindChip icon={s.kind.icon}>{s.kind.label}</KindChip></span>}
          {s.kind === QUESTION && <span className="flex h-6 shrink-0 items-center"><Dismiss /></span>}
        </div>
        <div aria-hidden className={`${RULE} mt-3.5`} />
        <Body s={s} ruled pr="under" />
      </div>
    ),
  },
]

// ---- PR placement -------------------------------------------------------------------------------
const AWAITING_UNTITLED: Scenario = { ...AWAITING_PR, key: "awaiting-untitled", caption: "awaiting · no title", title: null }
const PLACES: { id: string; pr: PrPlace; name: string; note: ReactNode }[] = [
  { id: "P1", pr: "corner", name: "Today — the far right of the chip row", note: <>Detached from everything: it reads as a stray link, and nothing says why the card names it.</> },
  { id: "P2", pr: "chip", name: "A second chip beside the kind", note: <>The PR is part of what the card IS. Same filled pill as the kind chip, with the PR mark; clickable.</> },
  { id: "P3", pr: "meta", name: "A meta line under the title", note: <>"Watching acme/app#391" says what the link is. Needs a title to hang from; untitled cards fall back to the line under the prose.</> },
  { id: "P4", pr: "under", name: "A line under the prose", note: <>Where SEVERAL PRs already go (a wrapped row of refs), so one PR and three take one shape.</> },
  { id: "P5", pr: "row", name: "A row in the wait table", note: <>Drawn here as the row a REGISTERED PR already gets, CI counts and all. The corner link only appears when the fence names a PR frizz has no watch on, so this means rowing that one too — reading "not watched" where these counts are.</> },
  { id: "P6", pr: "none", name: "Not drawn", note: <>A PR frizz is not watching is the worker's prose to mention. The card states only waits frizz holds.</> },
]

// ---- the page ---------------------------------------------------------------------------------
function Grid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-[repeat(5,minmax(0,1fr))] items-start gap-4">{children}</div>
}

function Cell({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="text-[11px] text-muted">{caption}</p>
      {children}
    </div>
  )
}

function Sheet() {
  const variants = only ? VARIANTS.filter((v) => v.id === only) : VARIANTS
  return (
    <main className="mx-auto flex w-full max-w-[2200px] flex-col gap-10 px-8 py-8 text-fg">
      <header className="flex flex-col gap-2">
        <h1 className="text-[20px] font-semibold tracking-tight">Signal card heads</h1>
        <p className="max-w-[880px] text-[13px] leading-5 text-fg/75">
          Each row is one head shape, drawn on the same five cards — every block type gets a head, titled or not. The card widths match a queue card. A done
          title means a <code className="font-mono-keep text-[12px]">title:</code> line on a <code className="font-mono-keep text-[12px]">```done</code> fence (and a{" "}
          <code className="font-mono-keep text-[12px]">--title</code> on <code className="font-mono-keep text-[12px]">frizzctl done</code>), parsed the way the awaiting fence's already is.
        </p>
      </header>
      {variants.map((v) => (
        <section key={v.id} data-variant={v.id} className="flex flex-col gap-3">
          <div className="flex max-w-[1100px] flex-col gap-1">
            <h2 className="text-[15px] font-semibold"><span className="mr-2 text-accent">{v.id}</span>{v.name}</h2>
            <p className="text-[12.5px] leading-5 text-fg/70">{v.note}</p>
          </div>
          <Grid>
            {SCENARIOS.map((s) => (
              <Cell key={s.key} caption={s.caption}>{v.render(s)}</Cell>
            ))}
          </Grid>
        </section>
      ))}
      {!only && (
        <section data-variant="PR" className="flex flex-col gap-6 border-t border-border pt-8">
          <div className="flex max-w-[1100px] flex-col gap-1">
            <h1 className="text-[20px] font-semibold tracking-tight">The PR link</h1>
            <p className="text-[13px] leading-5 text-fg/75">
              A registered PR already gets its own row in the wait table, and the card draws no link for it. The upper-right link
              is a <code className="font-mono-keep text-[12px]">prs:</code> entry with no live watch behind it — registered never, or its watch already ended.
              Six places for it, on the chip-over-title head (A/B), titled and untitled.
            </p>
          </div>
          <div className="grid grid-cols-[repeat(3,minmax(0,1fr))] items-start gap-x-4 gap-y-8">
            {PLACES.map((p) => (
              <div key={p.id} data-place={p.id} className="flex min-w-0 flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <h2 className="text-[15px] font-semibold"><span className="mr-2 text-accent">{p.id}</span>{p.name}</h2>
                  <p className="text-[12.5px] leading-5 text-fg/70">{p.note}</p>
                </div>
                {[AWAITING_PR, AWAITING_UNTITLED].map((s) => (
                  <Fragment key={s.key}>
                    <Cell caption={s.caption}>
                      <ChipOverTitle s={s} pr={p.pr === "meta" && !s.title ? "under" : p.pr} />
                    </Cell>
                  </Fragment>
                ))}
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Sheet />)
