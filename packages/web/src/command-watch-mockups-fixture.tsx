// MOCKUP SHEET — where a COMMAND WATCH shows up in the chat (2026-10-13).
//
// The releaser registered the first command watch anyone has used for real (`frizzctl watch-command add`,
// a board check re-run every 2m), and the chat drew it nowhere. The registering Bash call folded into
// "Ran 7 tool calls"; the card under the rest said "Waiting for an external update." (6123317c rows the
// watch there now); nothing above the prompt box counts it; and when it settles, its wake falls through
// FrizzWake's parsers to the generic card. A background shell, by contrast, keeps its own card while it
// runs, counts as "1 shell" above the prompt box, and ends on a hairline.
//
// Not a test and not shipped UI: a design surface on the REAL stylesheet and components. Each option
// varies one surface and reuses the shipped chrome for the rest, so the sheet judges placement and
// wording, not drift.
//
//   nubx vite --port 5481 --strictPort      (from packages/web)
//   http://localhost:5481/command-watch-mockups-fixture.html
import { useState, type ReactNode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ChevronRight, Copy, RefreshCw, TerminalSquare, X } from "lucide-react"
import { commandWatchExpiredWakeMessage, commandWatchPassedWakeMessage, type BoardSnapshot, type ThreadView, type ThreadWatchView } from "@frizz/shared"
import { ThreadSlugContext, ToolCardRouter } from "./components/ChatView.tsx"
import { AwaitingBackgroundCard, BgShellRow, CommandWatchRow, commandWatchName } from "./components/AwaitingBackgroundCard.tsx"
import { FrizzWake } from "./components/FrizzWake.tsx"
import { QueueOpsSummary } from "./components/QueueOpsSummary.tsx"
import { ToolDisclosureHeader } from "./components/ToolDisclosureHeader.ts"
import { DividerHint, DividerQuotedTitle, WakeDivider } from "./components/WakeDivider.tsx"
import { TRANSCRIPT_META_LABEL_CLASS, transcriptMetaChevronClass } from "./lib/transcriptMetaLabels.ts"
import { OPAQUE_SURFACE_BASE } from "./lib/overlaySurface.ts"
import { BLOCK_RADIUS } from "./components/TranscriptCard.tsx"
import { mdToHtml } from "./lib/markdown.ts"
import { store } from "./store.ts"
import "./styles.css"

document.documentElement.dataset.font = "sans"

const agoIso = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString()
const aheadIso = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString()

// ---- the releaser's real watch -------------------------------------------------------------------
const COMMAND = "/Users/colin/.cache/nub/node/26.11.1/bin/node /Users/colin/Documents/frizz/.frizz/threads/a381aaca-1980-487c-b9d2-cb9ddd7040c0/others-idle.mjs"
const OUTPUT = [
  "active: Layout shift when a send ends a rest",
  "active: Assess registering questions from markdown",
  "active: Console grouping switch mockups",
  "active: Explain the Releaser's command-watch park",
  "active: I think it's weird…",
].join("\n")
const RUNS = 24

const watch: ThreadWatchView = {
  id: "command:releaser:cmw_12f995833a5b",
  kind: "command",
  target: "cmw_12f995833a5b",
  state: "armed",
  createdAt: agoIso(50),
  command: { command: COMMAND, every: "2m", expiresAt: aheadIso(11 * 60 + 10), runs: RUNS, lastRun: { at: agoIso(1), outcome: "exit", exitCode: 1, output: OUTPUT } },
}

const base = {
  status: "active", mechanism: null, humanBlocked: false, ready: false, dependsOn: [], externalDeps: [], agents: [], errors: [], warnings: [],
  unread: false, archived: false, hasPlan: false, pendingQuestion: false, kind: "session", foreign: false, state: "open", questions: [], links: [],
  subAgents: [], bgShells: [], watches: [],
}

const releaser = {
  ...base, id: "releaser", sessionId: "releaser", title: "Releaser", runtime: "turn-idle", awaitingBackground: true, waitStatus: "watching",
  watches: [watch],
  lastFence: { kind: "awaiting", body: "", hints: [{ kind: "command", value: "cmw_12f995833a5b" }, { kind: "status", value: "watching" }, { kind: "for", value: "12h" }] },
} as unknown as ThreadView

const asShellThread = {
  ...base, id: "as-shell", sessionId: "as-shell", title: "Releaser", runtime: "turn-idle", awaitingBackground: true,
  bgShells: [{ id: "cmw_12f995833a5b", label: "node others-idle.mjs", startedAt: agoIso(50), state: "running", lastActivityAt: agoIso(1) }],
} as unknown as ThreadView

const shellThread = {
  ...base, id: "suite", sessionId: "suite", title: "Run the suite", runtime: "turn-idle", awaitingBackground: true,
  bgShells: [{ id: "b4e5djkqq", label: "Running the full test suite", startedAt: agoIso(6), state: "running", lastActivityAt: agoIso(0) }],
} as unknown as ThreadView

store.board = { threads: [releaser, shellThread, asShellThread] } as BoardSnapshot

// ---- sheet chrome --------------------------------------------------------------------------------
function Section({ id, title, children, note }: { id: string; title: string; note?: ReactNode; children: ReactNode }) {
  return (
    <section data-mock={id} className="flex flex-col gap-3">
      <div>
        <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
        {note && <p className="mt-1 text-[13px] leading-5 text-muted">{note}</p>}
      </div>
      {children}
    </section>
  )
}

// One mock chat column: the transcript's own background and width, with a caption chip above it.
function Frame({ label, tone = "option", children }: { label: string; tone?: "today" | "option" | "avoid"; children: ReactNode }) {
  const chip = tone === "today" ? "text-muted-70 border-border" : tone === "avoid" ? "text-danger border-danger/40" : "text-accent border-accent/40"
  return (
    <div className="flex flex-col gap-2">
      <span className={`petite-caps self-start rounded border px-1.5 py-px text-[10.5px] ${chip}`}>{label}</span>
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-bg px-5 py-4">{children}</div>
    </div>
  )
}

function Prose({ children }: { children: ReactNode }) {
  return <p className="text-[14px] leading-6 text-fg/90">{children}</p>
}

// The settled tool-call digest, drawn as MinimalToolActivity draws it (that component is not exported).
function Digest({ n }: { n: number }) {
  return (
    <div className={`flex items-baseline gap-1.5 ${TRANSCRIPT_META_LABEL_CLASS}`}>
      <span className="text-muted">Ran {n} tool calls</span>
      <ChevronRight aria-hidden size={13} className={transcriptMetaChevronClass(false)} />
    </div>
  )
}

// A stand-in prompt box, so the ops line has the thing it sits on top of.
function PromptStub({ above }: { above?: ReactNode }) {
  return (
    <div className="mt-2">
      {above}
      <div className="rounded-xl border border-border-strong bg-panel px-3.5 py-3 text-[14px] text-muted-60">Reply to the agent…</div>
    </div>
  )
}

// ---- the proposed pieces -------------------------------------------------------------------------
// A check-by-check strip: one bar per run, newest last. A NON-ZERO EXIT IS NOT A FAILURE — it is the
// watch's ordinary "not yet", so it draws neutral. Green is the pass; red is reserved for a check that
// CANNOT pass as written (exit 126/127, a timeout, a command that never started), which is the one
// reading a human needs to catch early (router.ts: "armed, 14 checks, last one exited 127 is the
// difference between a wait that is healthy and one that never will pass").
function CheckStrip({ runs, passedLast = false, broken = false }: { runs: number; passedLast?: boolean; broken?: boolean }) {
  return (
    <span aria-label={`${runs} checks`} className="inline-flex items-end gap-[2px]">
      {Array.from({ length: runs }, (_, i) => {
        const pass = passedLast && i === runs - 1
        return <span key={i} className={`inline-block h-[9px] w-[3px] rounded-[1px] ${pass ? "bg-[#3fb950]" : broken ? "bg-danger/70" : "bg-muted/35"}`} />
      })}
    </span>
  )
}

const VIOLET_DOT = <span aria-hidden className="frizz-tool-mark"><span className="frizz-live-dot frizz-live-dot--github" /></span>

// OPTION A: the registering call keeps a card of its own while its watch is armed — the background-shell
// rule (toolActivity.ts) applied to the one other call that launches something outliving it.
function WatchCard({ initiallyOpen = false, settled }: { initiallyOpen?: boolean; settled?: "passed" | "expired" }) {
  const [open, setOpen] = useState(initiallyOpen)
  const meta = settled === "passed"
    ? <span className="text-[11px] text-muted-60">passed on check 31</span>
    : settled === "expired"
      ? <span className="text-[11px] text-muted-60">expired after 360 checks</span>
      : <span className="flex items-center gap-2 text-[11px] text-muted-60"><CheckStrip runs={Math.min(RUNS, 12)} /><span>every 2m · {RUNS} checks</span></span>
  return (
    <div className="frizz-bash">
      <ToolDisclosureHeader
        className="frizz-bash-header"
        controls="watch-card-body"
        expanded={open}
        label={`${open ? "Collapse" : "Expand"} command watch`}
        onToggle={() => setOpen((v) => !v)}
        meta={meta}
      >
        {!settled && VIOLET_DOT}
        <span className="frizz-bash-label shrink-0">Watch</span>
        <span className="frizz-tool-detail">{commandWatchName(COMMAND)}</span>
      </ToolDisclosureHeader>
      {open && (
        <div id="watch-card-body" className="frizz-tool-body flex flex-col gap-3 px-3 py-3 [font-family:var(--font-sans)]">
          <div className="flex items-baseline justify-between gap-3 text-[11.5px] text-muted-70">
            <span>Re-runs every 2m until it exits 0 · armed 50m ago · gives up in 11h 10m</span>
          </div>
          <div className="flex items-center gap-2 text-[11.5px] text-muted-70">
            <CheckStrip runs={RUNS} />
            <span>{RUNS} checks, each exited 1: not yet</span>
          </div>
          <div>
            <div className="petite-caps mb-1 text-[10px] text-muted-65">Last check · 1m ago · exited 1</div>
            <pre className={`font-mono-keep whitespace-pre-wrap break-words ${BLOCK_RADIUS} border border-border bg-inset px-3 py-2 text-[11.5px] leading-relaxed text-fg/80`}>{OUTPUT}</pre>
          </div>
          <div className="flex justify-end">
            <button type="button" className="rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] text-fg/80 transition-colors hover:border-danger/40 hover:bg-danger/10 hover:text-danger-soft">Drop watch</button>
          </div>
        </div>
      )}
    </div>
  )
}

// OPTION B: one hairline where it was registered, in the transcript's event idiom.
function ArmedDivider() {
  return (
    <WakeDivider icon={RefreshCw} marker="event" ariaLabel="Command watch armed">
      <DividerQuotedTitle lead="Watching" title={commandWatchName(COMMAND)} tail="every 2m" />
    </WakeDivider>
  )
}

// The ops line over the prompt box, with a count for command watches beside the shipped kinds. The real
// QueueOpsSummary has no such kind yet, so this draws its markup by hand (same classes).
function ProposedOpsLine({ open }: { open?: boolean }) {
  return (
    <div className="relative">
      {open && (
        <div className={`${OPAQUE_SURFACE_BASE} absolute right-0 bottom-9 z-10 flex w-[440px] flex-col rounded-lg px-3 py-2`}>
          <CommandWatchRowRich />
        </div>
      )}
      <div className="-mt-3 flex h-8 min-w-0 items-baseline justify-end text-[11.5px]">
        <span aria-hidden className="h-[calc(16px_+_0.5cap)] w-0 shrink-0" />
        <OpsCount mark={<span className="frizz-live-dot frizz-live-dot--shell" />} n={1} word="shell" />
        <OpsCount mark={<span className="frizz-live-dot frizz-live-dot--github" />} n={2} word="watches" active={open} />
      </div>
    </div>
  )
}

function OpsCount({ mark, n, word, active }: { mark: ReactNode; n: number; word: string; active?: boolean }) {
  return (
    <span className={`flex shrink-0 items-baseline gap-1.5 whitespace-nowrap rounded-md px-1.5 py-0.5 ${active ? "bg-panel-2 text-fg/85" : "text-muted-70"}`}>
      <span aria-hidden className="relative block h-[1em] w-[1em] shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]">
        <span className="absolute inset-0 flex items-center justify-center">{mark}</span>
      </span>
      <span><span className="tabular-nums text-fg/85">{n}</span> {word}</span>
    </span>
  )
}

// The panel's rows: the shipped CommandWatchRow plus the check strip — the one reading that says at a
// glance whether a watch is waiting normally or can never pass. The second watch is the broken case.
const brokenWatch: ThreadWatchView = {
  ...watch, id: "command:releaser:cmw_9a0b1c2d3e4f", target: "cmw_9a0b1c2d3e4f",
  command: { command: "gh run view 18305160897 --json conclusion -q .conclusion | grep -q success", every: "5m", expiresAt: aheadIso(300), runs: 6, lastRun: { at: agoIso(3), outcome: "exit", exitCode: 127, output: "sh: gh: command not found" } },
}
function CommandWatchRowRich() {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-col">
        <CommandWatchRow watch={watch} slug="fixture" now={Date.now()} />
        <div className="flex items-center gap-2 pl-[26px] pb-1 text-[11px] text-muted-60">
          <CheckStrip runs={RUNS} />
          <span>24 checks · last 1m ago, exited 1</span>
        </div>
      </div>
      <div className="flex flex-col">
        <CommandWatchRow watch={brokenWatch} slug="fixture" now={Date.now()} />
        <div className="flex items-center gap-2 pl-[26px] pb-1 text-[11px] text-danger-soft">
          <CheckStrip runs={6} broken />
          <span>can never pass: exit 127, gh: command not found</span>
        </div>
      </div>
    </div>
  )
}

// The drawer a row opens: the shell sheet's anatomy (Command / Output), plus the history a shell has no
// use for.
function WatchSheet() {
  return (
    <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-panel">
      <div className="flex items-center gap-2 border-b border-border/70 px-4 py-3">
        <RefreshCw aria-hidden size={14} className="shrink-0 text-muted-60" />
        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-fg">{commandWatchName(COMMAND)}</span>
        <span className="shrink-0 whitespace-nowrap text-[11.5px] text-muted-60">every 2m · gives up in 11h 10m</span>
        <X aria-hidden size={14} className="ml-2 shrink-0 text-muted-60" />
      </div>
      <div className="flex flex-col gap-5 px-5 py-5">
        <section>
          <div className="mb-2 flex items-center justify-between gap-3">
            <h3 className="petite-caps text-[10px] text-muted-65">Command</h3>
            <span className="button-outline flex items-center gap-1 rounded px-1.5 py-1 text-[10.5px] text-muted"><Copy aria-hidden size={11} /> Copy</span>
          </div>
          <pre className={`font-mono-keep whitespace-pre-wrap break-all ${BLOCK_RADIUS} border border-border bg-inset px-3 py-2 text-[12px] text-fg/85`}>{COMMAND}</pre>
        </section>
        <section>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="petite-caps text-[10px] text-muted-65">Checks</h3>
            <span className="text-[10.5px] text-muted-50">{RUNS} so far · registered by the worker at 11:25</span>
          </div>
          <CheckStrip runs={RUNS} />
        </section>
        <section>
          <div className="mb-2 flex items-center gap-2">
            <h3 className="petite-caps text-[10px] text-muted-65">Last check</h3>
            <span className="text-[10.5px] text-muted-50">1m ago · exited 1</span>
          </div>
          <pre className={`font-mono-keep min-h-24 whitespace-pre-wrap break-words ${BLOCK_RADIUS} border border-border bg-inset px-4 py-3 text-[12px] leading-relaxed text-fg/85`}>{OUTPUT}</pre>
        </section>
      </div>
      <div className="flex min-h-10 items-center justify-end gap-1.5 border-t border-border/70 bg-panel/95 px-3 py-2 text-[12px]">
        <button type="button" className="rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] text-fg/80">Check now</button>
        <button type="button" className="rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] text-fg/80 hover:border-danger/40 hover:bg-danger/10 hover:text-danger-soft">Drop watch</button>
      </div>
    </div>
  )
}

// Settling hairlines, in the shell-done divider's sentence shape.
function SettledDivider({ kind }: { kind: "passed" | "expired" | "cancelled" }) {
  const [open, setOpen] = useState(false)
  const tail = kind === "passed" ? "passed" : kind === "expired" ? "gave up" : "stopped by Frizz"
  const title = <DividerQuotedTitle lead="Watch" title={commandWatchName(COMMAND)} tail={tail} />
  if (kind === "cancelled") {
    return <WakeDivider icon={RefreshCw} marker="event" ariaLabel={`Command watch ${tail}`} at={agoIso(0)}>{title}</WakeDivider>
  }
  return (
    <div className="flex flex-col">
      <WakeDivider icon={RefreshCw} marker="event" ariaLabel={`Command watch ${tail}`} at={agoIso(0)} onClick={() => setOpen((v) => !v)} ariaExpanded={open}>
        {title}
        <DividerHint open={open} />
      </WakeDivider>
      {open && (
        <pre className="mt-1.5 whitespace-pre-wrap border-l border-border/70 pl-3 text-[12px] text-muted [overflow-wrap:anywhere]">
          {kind === "passed" ? "Exited 0 on check 31, after 1h 2m. It printed nothing." : `Ran 360 checks over 12h; the last exited 1:\n${OUTPUT}`}
        </pre>
      )}
    </div>
  )
}

// The data-model half of the sheet, from a read of the code on 2026-10-13 (main at a6c67684).
const DATA_MODEL = `
#### What exists

- **One \`command_watch\` row per watch, keyed only by thread:** the command, cadence, expiry, a run counter, and the *last* check (outcome, exit code, 4 KB of output). Each check overwrites the one before.
- **It is already a full wait.** \`commands:\` in a fence is checked against it, an armed watch parks the thread even with no fence, \`frizzctl done\` refuses while one is armed, and a thread resting on one hibernates. A background shell would block that hibernation.
- **The gaps are all about showing it:**
  - nothing ties a watch to the call that registered it;
  - no history is kept;
  - a settled watch drops off the board;
  - its wakes are never parsed (\`parseCommandWatchWake\` has no caller), so they render as the generic card, worker instructions included;
  - a watch registered by a sub-agent is filed under the parent thread, with nothing saying which child made it.

#### Option 1: its own kind, plus provenance and history (recommended)

- **Provenance:** stamp \`origin_tool_use_id\` on the row, plus \`origin_agent_id\` when a sub-agent made the call.
  - **Source:** the PreToolUse Bash hook Frizz already installs (\`cc-worker/hooks/bash-background.mjs\`). It sees both ids and can leave a record for the registration to pick up, the way \`agent-bind.mjs\` binds sub-agents today.
  - **Fallback with no new plumbing:** join on the \`Watching as cmw_…\` line frizzctl prints (pinned by \`frizzctl.test.ts\`). This works for the main thread only.
- **History:** a \`command_watch_run\` table.
  - One row per check (time, outcome, exit code). Store output only when it differs from the previous check's. Keep the first check, the last 60, and every check whose outcome changed.
  - A 2m watch held for 12h writes 360 rows.
  - The board carries a summary only: checks run, last outcome, when the next check is due, and whether one is running now. The drawer fetches the history on demand, the way it fetches a shell's output.
- **Settled watches:** keep projecting a watch for a while after it passes, gives up, is dropped or is stopped, so its transcript card can show how it ended before folding away.
- **Surfaces:** sections 1A, 2, 3 and 4 above, all reading this one row.

#### Option 2: put it in the shell list (section 5)

Every shell surface would draw it for free, but each of them would be wrong about it:

- A shell is "running" because the OS says its process is alive; a watch has no process between checks.
- The shell drawer reads an output file; a watch keeps 4 KB of one check.
- Stopping a shell goes through the provider; a watch is dropped with \`watch-command drop\`.
- Any shell blocks hibernation, which is the reason command watches exist.
- About ten places key on the shell list (queue and park rules) and would change behaviour.

#### Option 3: one list of everything a thread has out

Sub-agents, shells, command watches, timers, and PR and issue watchers as one projection: kind, the call that started it, label, state, started and settled times, last event.

- **Why:** the count line, the waiting card, the /full rail and the drawers each rebuild this set by hand today. That is how command watches were left out everywhere, and timers are still missing from the count line.
- **Cost:** it is the right end state, but a refactor across every surface. Option 1's columns are a subset of it, so doing Option 1 first wastes nothing.

#### Also found

- **\`status: working\` on a command park is read as \`watching\`,** so the thread always lands in Snoozed and never shows as running, even while a check is running.
- **No sidebar mark of its own:** a command park gets the generic Snoozed hourglass.
`

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <ThreadSlugContext.Provider value={releaser.id}>
      <main className="mx-auto flex min-h-screen w-full max-w-[760px] flex-col gap-12 px-6 py-10">
        <header className="flex flex-col gap-2">
          <p className="petite-caps text-[11px] text-accent">Mockups · 2026-10-13</p>
          <h1 className="text-[22px] font-semibold text-fg">Command watches in the chat</h1>
          <p className="text-[14px] leading-6 text-muted">
            The Releaser's board check is the first command watch anyone has used for real, and the chat drew it nowhere.
            Each section below is one place a watch could appear. Every piece is the shipped component or its exact markup,
            on the real stylesheet; only the arrangement is new. Data-model options are at the end.
          </p>
        </header>

        <Section id="today" title="Today" note={<>What the Releaser's thread shows now (with 6123317c's row). Beside it, a background shell, which the chat draws in three places: its own card, a count above the prompt box, and a hairline when it ends.</>}>
          <Frame label="Today · command watch" tone="today">
            <Digest n={7} />
            <Prose>I'll cut the release once the two frizz threads still working (the ghost-bubble send fix and the split-Send animation fix) stop; a check on the board wakes me when they do.</Prose>
            <AwaitingBackgroundCard thread={releaser} />
            <PromptStub above={<div className="h-5 text-right text-[11.5px] text-muted-45">(nothing above the prompt box)</div>} />
          </Frame>
          <Frame label="Today · background shell, for comparison" tone="today">
            <Digest n={3} />
            <ThreadSlugContext.Provider value={shellThread.id}>
              <ToolCardRouter t={{ name: "Bash", detail: "Running the full test suite", desc: "Running the full test suite", command: "nub run test", backgroundState: "background", status: "pending", count: 1 }} />
            </ThreadSlugContext.Provider>
            <Prose>The suite is running in the background; I'll pick this up when it finishes.</Prose>
            <PromptStub above={<QueueOpsSummary thread={shellThread} />} />
            <WakeDivider icon={TerminalSquare} marker="event" ariaLabel="Background task completed">
              <DividerQuotedTitle lead="Background task" title="Running the full test suite" tail="completed" />
            </WakeDivider>
          </Frame>
          <Frame label="Today · when the watch passes" tone="today">
            <FrizzWake text={commandWatchPassedWakeMessage({ id: "cmw_12f995833a5b", command: COMMAND, output: "", runs: 31, armedMs: 62 * 60_000 })} at={agoIso(0)} />
          </Frame>
        </Section>

        <Section id="transcript" title="1 · In the transcript, where the worker registered it" note="The registering call is the one record the chat has of the watch, and it folds into the digest because it finished in under a second.">
          <Frame label="A · Keep its card while the watch is armed (recommended)">
            <Digest n={6} />
            <WatchCard />
            <Prose>I'll cut the release once the two frizz threads still working stop; a check on the board wakes me when they do.</Prose>
          </Frame>
          <Frame label="A · expanded">
            <WatchCard initiallyOpen />
          </Frame>
          <Frame label="A · after it settles, the card folds back into the digest">
            <Digest n={7} />
            <Prose>I'll cut the release once the two frizz threads still working stop; a check on the board wakes me when they do.</Prose>
            <SettledDivider kind="passed" />
          </Frame>
          <Frame label="B · A hairline instead of a card">
            <Digest n={7} />
            <ArmedDivider />
            <Prose>I'll cut the release once the two frizz threads still working stop; a check on the board wakes me when they do.</Prose>
          </Frame>
        </Section>

        <Section id="ops" title="2 · Above the prompt box, beside shells and sub-agents" note="The count line is where a thread's live work is listed while you read it. A watch is live work, so it gets a count; hovering it opens its rows.">
          <Frame label="Proposed · count line, panel open">
            <div className="h-28" />
            <ProposedOpsLine open />
            <PromptStub />
          </Frame>
        </Section>

        <Section id="drawer" title="3 · The drawer a watch row opens" note="Shaped like the background-shell drawer (Command, Output) plus a check history. “Check now” would run it once on demand; “Drop watch” is frizzctl watch-command drop.">
          <WatchSheet />
        </Section>

        <Section id="settle" title="4 · When it settles" note="Today the passed, expired and cancelled wakes all fall through to the generic card shown above. Proposed: hairlines, like a finished shell; the passed and expired ones expand to the output that decided it.">
          <Frame label="Proposed · hairlines">
            <SettledDivider kind="passed" />
            <SettledDivider kind="expired" />
            <SettledDivider kind="cancelled" />
          </Frame>
        </Section>

        <Section id="as-shell" title="5 · Drawn as a background shell instead" note="The cheapest unification: put the watch in the thread's shell list and let every shell surface draw it. It reads wrong. Nothing is running between checks, “running for 50m” is false, and the shell drawer would show one run's output with no history.">
          <Frame label="Not recommended · as a shell" tone="avoid">
            <ThreadSlugContext.Provider value={asShellThread.id}>
              <ToolCardRouter t={{ name: "Bash", detail: "node others-idle.mjs", desc: "node others-idle.mjs", command: COMMAND, backgroundState: "background", status: "pending", count: 1 }} />
            </ThreadSlugContext.Provider>
            <PromptStub above={<QueueOpsSummary thread={asShellThread} />} />
            <div className="-mx-2">
              <BgShellRow shell={asShellThread.bgShells[0]} slug={asShellThread.id} now={Date.now()} />
            </div>
          </Frame>
        </Section>

        <Section id="data" title="Data model options">
          <div id="data-model" className="md-body text-[14px] leading-6" dangerouslySetInnerHTML={{ __html: mdToHtml(DATA_MODEL) }} />
        </Section>
      </main>
    </ThreadSlugContext.Provider>
  </QueryClientProvider>,
)
