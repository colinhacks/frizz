import { useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { AgentBlock, BackgroundOpsStrip, ThreadSlugContext, ToolCardRouter, ToolStatusMeta } from "./components/ChatView.tsx"
import { QueueSubAgentLines } from "./components/QueueSubAgentLines.tsx"
import { ChildOpRow } from "./components/ChildOpRow.tsx"
import { ToolDisclosureHeader } from "./components/ToolDisclosureHeader.ts"
import { store } from "./store.ts"
import "./styles.css"

// Both the last-active reading AND the RUNTIME (`startedAt`, on every child row and on the dispatch
// card) are relative to NOW, so seed them that way rather than with a frozen date — a child dispatched
// 12 min ago should read "12m" whenever the fixture is opened. A hard-coded 2026-07-14 read "372h 53m"
// the moment the dispatch card started rendering a runtime, which is nobody's real reading. The SHELL
// rows kept that frozen date until 2026-08-31 and were reading "1169h 10m" by then; they are relative
// now too.
const agoIso = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()

// How long the "fresh" foreground shell row has been running, from the URL, so a test can pin BOTH sides
// of the elapsed threshold with no race against page-load time. A NEGATIVE age puts the call's start in
// the future — which is both the deterministic "definitely not marked yet" state and a real case (the
// worker's clock and the browser's are not the same clock). Default 0 = started exactly at load.
const freshAgeMs = Number(new URLSearchParams(location.search).get("freshAgeMs") ?? 0)
const freshStartedAt = new Date(Date.now() - freshAgeMs).toISOString()

const thread: ThreadView = {
  id: "operation-indicators",
  title: "Per-operation running indicators",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "turn-idle",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  // The `subagentType` spread is retained as DRILL-IN + tooltip data (the rail's type reading rides its
  // row tooltip). It is no longer rendered as a bracketed tag on any density — see ChildOpRow.
  // The `activityDetail` / `toolUses` / `tokens` spread is the LIVE-READING coverage: a child mid-step
  // with counters, a long step that has to truncate beside a long label, and — the case that must not
  // regress — a child reporting NOTHING (a codex dispatch, or an older CLI), which has to read exactly as the
  // row did before those fields existed rather than leaving a gap where the step would go.
  subAgents: [
    { id: "agent-a", label: "Inspect logs", startedAt: agoIso(4), state: "running", subagentType: "frizz:opus-xhigh", lastActivityAt: agoIso(0), activity: "Bash", activityDetail: "Running sleep for 20 seconds", toolUses: 12, tokens: 13_476 },
    { id: "agent-b", label: "Run regression suite", startedAt: agoIso(12), state: "running", subagentType: "worker gpt-5.6-terra/high", lastActivityAt: agoIso(6), activity: "Edit", activityDetail: "Editing packages/server/src/tailer.ts", toolUses: 1, tokens: 947 },
    { id: "agent-long", label: "Sweep every call site of the renamed board projection helper for stale imports", startedAt: agoIso(78), state: "running", subagentType: "frizz:sonnet-medium", lastActivityAt: agoIso(2), activity: "Grep", activityDetail: "Searching for every remaining reference to the old projection helper name across the workspace", toolUses: 148, tokens: 132_000 },
    // No task stream at all (a codex child / an older CLI): identity only, and no empty slot.
    { id: "agent-plain", label: "Explore the resume path", startedAt: agoIso(0.6), state: "running", subagentType: "general-purpose", lastActivityAt: agoIso(3) },
    { id: "agent-stale", label: "Prior investigation", startedAt: agoIso(51), state: "stale", subagentType: "frizz:haiku", lastActivityAt: agoIso(42), activityDetail: "Reading the orphan reaper", toolUses: 3, tokens: 2_400_000 },
    // RESTED: its own run ended while the fan-out it launched kept going — the hollow dot, on every
    // density and on the dispatch card that opens it.
    { id: "agent-rested", label: "Fan out the migration sweep", startedAt: agoIso(23), state: "rested", subagentType: "frizz:opus-high", lastActivityAt: agoIso(18) },
  ],
  bgShells: [
    { label: "Watch CI", startedAt: agoIso(34), state: "running", lastActivityAt: agoIso(1) },
    { label: "Tail build log", startedAt: agoIso(33), state: "running", lastActivityAt: agoIso(0) },
    // GONE: the OS confirmed nobody holds this shell's output open, and no completion ever arrived (tailer
    // `shellIsGone`) — the only way a shell reads "stale". A quiet live one (a dev server waiting, a
    // Monitor, which has no output file to probe) reads "running", so it pulses like any other.
    { label: "Dev server", startedAt: agoIso(94), state: "stale", lastActivityAt: agoIso(78) },
  ],
  watches: [],
  questions: [],
}

store.board = { threads: [thread] } as BoardSnapshot

function DisclosureFixture({ running }: { running: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const bodyId = `fixture-disclosure-${running ? "running" : "done"}`
  return (
    <div className="frizz-bash">
      <ToolDisclosureHeader
        className="frizz-bash-header"
        controls={bodyId}
        expanded={expanded}
        label={`${expanded ? "Collapse" : "Expand"} ${running ? "running" : "completed"} operation`}
        onToggle={() => setExpanded((value) => !value)}
        meta={<ToolStatusMeta status={running ? "pending" : "completed"} backgroundState={running ? "background" : undefined} />}
      >
        <span className="frizz-bash-label shrink-0">Bash</span>
        <span className="frizz-tool-detail">{running ? "Watch CI until checks finish" : "Completed CI checks"}</span>
      </ToolDisclosureHeader>
      <div id={bodyId} hidden={!expanded} className="frizz-tool-body px-2.5 py-2 text-[11.5px] text-muted">Operation details remain available without changing the header alignment.</div>
    </div>
  )
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
  <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-5 px-5 py-10">
    <header>
      <p className="petite-caps text-[11px] text-accent">Fixture</p>
      <h1 className="mt-1 text-lg font-semibold">Per-operation running indicators</h1>
      <p className="mt-2 text-sm text-muted">Each dot belongs to a named operation. There is intentionally no aggregate session “Running” pulse.</p>
    </header>
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-medium">Chat background operations</h2>
      <BackgroundOpsStrip slug={thread.id} className="pt-3" />
    </section>
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-medium">Queue sub-agents</h2>
      {/* The card now lists the STALE child too (it reads "42 min ago"), not just the two running ones. */}
      <QueueSubAgentLines slug={thread.id} subAgents={thread.subAgents} />
    </section>
    <section data-rail-rows className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-medium">Sidebar rail rows</h2>
      {/* The rail density of the same shared row — checkbox spinner + the light-gray last-active reading. */}
      <div className="mt-3 flex flex-col">
        {/* The rail's type reading lives in the row TOOLTIP; no density renders a profile tag any more
            (maintainer 2026-07-27 — ChildOpRow no longer takes `subagentType` at all). */}
        {thread.subAgents.map((s) => (
          <ChildOpRow key={s.id} kind="AGENT" label={s.label} state={s.state} density="rail" startedAt={s.startedAt} title={s.subagentType ? `[${s.subagentType}] ${s.label}` : s.label} onOpen={() => {}} />
        ))}
      </div>
    </section>
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-medium">Tool disclosures</h2>
      <div className="mt-3 flex flex-col gap-2 text-[12px]">
        <div className="flex items-center justify-between gap-3"><span>Watch CI (launch wrapper returned)</span><ToolStatusMeta status="completed" backgroundState="background" liveBackgroundState="running" /></div>
        <div className="flex items-center justify-between gap-3"><span>Completed build</span><ToolStatusMeta status="completed" durationMs={32_000} /></div>
        <div className="flex items-center justify-between gap-3"><span>Failed test</span><ToolStatusMeta status="failed" exitCode={1} durationMs={12_000} /></div>
        <div className="flex items-center justify-between gap-3"><span>Cancelled command</span><ToolStatusMeta status="cancelled" /></div>
      </div>
    </section>
    {/* Agent rows carry TWO independent status sources — their own state reading (with its mark) and
        the shared meta slot — so they are the one card family that can render a DOUBLE indicator. Each
        row below must show exactly one `data-running-indicator`, and the no-child rows must still
        surface their terminal status/duration through the meta slot.
        These rows are also the coverage for the 2026-07-29 header shape: mark → "Agent" → title →
        right-justified RUNTIME → chevron, mirroring the prompt-box child lines two sections up. Read
        the two sections together — the marks and the runtime readings must agree. */}
    <section data-agent-rows className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-medium">Agent rows</h2>
      <div className="mt-3 flex flex-col gap-2">
        <ThreadSlugContext.Provider value={thread.id}>
          {/* Live child, running: pulsing mark, bare live-ticking runtime, no state verb. */}
          <AgentBlock detail="Measure private repo placeholder prevalence" prompt="Measure how many repos use the placeholder." subagentType="frizz:opus-high" agentId="agent-a" status="pending" />
          {/* Live child gone quiet: the flat stale mark, and no "running" badge to contradict it. */}
          <AgentBlock detail="Prior investigation" prompt="Investigate the earlier failure." subagentType="frizz:sonnet-high" agentId="agent-stale" status="pending" />
          {/* Rested child: the hollow mark — it stopped, its own fan-out has not. */}
          <AgentBlock detail="Fan out the migration sweep" prompt="Fan out the sweep across every package." subagentType="frizz:opus-high" agentId="agent-rested" status="pending" />
          {/* Completed child: NO mark, only the ordinary node, and the bare runtime is what says it ran and
              stopped. A static "finished" dot filled the mark's place here for one commit and was removed
              (maintainer 2026-08-01: "remove the status indicator entirely for a sub-agent or background
              shell that has completed") — the mark means "something is alive behind this row", and a
              finished child is not. */}
          <AgentBlock detail="Diagnose remotion model routing anomaly" prompt="Diagnose the routing anomaly." subagentType="frizz:opus-high" agentId="agent-done" agentStatus="completed" agentElapsedMs={183_000} status="completed" durationMs={183_000} />
          {/* A NON-nominal outcome keeps its verb — no mark can say it — but the two are TONED APART, and
              this pair is the coverage for that. A STOPPED child is not an error (interrupted, or timed
              out), so it reads at the same quiet weight as the bare runtime above; only a real FAILURE
              takes the red. Read the two rows together — if the stop is as loud as the failure, the
              regression is back.
              READ ALL EIGHT ROWS AS A COLUMN. Every reading is ONE treatment (ChatView's ToolMetaReading,
              worded by lib/agentReading.ts): one size, one casing, one `·` separator, one duration
              formatter, and a palette of exactly two tones. The column shipped with two of each, so a
              second treatment appearing here is the regression. */}
          <AgentBlock detail="Interrupted long-running audit" prompt="Audit every call site." subagentType="frizz:sonnet-medium" agentId="agent-killed" agentStatus="killed" agentElapsedMs={2_460_000} status="completed" durationMs={2_460_000} />
          <AgentBlock detail="Crashed dependency sweep" prompt="Sweep every dependency." subagentType="frizz:sonnet-medium" agentId="agent-failed" agentStatus="failed" agentElapsedMs={738_000} status="failed" durationMs={738_000} />
          {/* No child record at all — the meta slot is the ONLY status surface, so a terminal status
              and its duration must still render here (this is what the suppression must never eat). */}
          <AgentBlock detail="Cancelled dispatch (no child record)" prompt="This dispatch was interrupted." status="cancelled" />
          <AgentBlock detail="Failed dispatch (no child record)" prompt="This dispatch failed." status="failed" durationMs={12_000} />
          {/* A dispatch still PENDING with no child record to point at — and therefore the one row that
              reports NOTHING at all, no mark and no reading. It used to spin here beside the word
              "running", which was the single reading in this matrix that could be flatly false: the
              server holds an Agent launch pending until a task-notification correlates, so a dispatch
              whose terminal signal never arrived spun forever over a long-dead child (maintainer
              2026-08-01: it "should not show up under any circumstances"). */}
          <AgentBlock detail="Untracked pending dispatch (no child record)" prompt="This dispatch has not been correlated yet." status="pending" />
        </ThreadSlugContext.Provider>
      </div>
    </section>
    {/* SHELL rows, read against the agent rows above: the SAME header shape, the same mark, in the
        shell's blue instead of the accent. The dot used to render in the RIGHT-hand reading, so a live
        background shell and a live sub-agent marked themselves at opposite edges of an otherwise
        identical card (maintainer 2026-07-30). `desc` is what correlates a card to a tracked op, so the
        first two rows name real entries in `bgShells` above — the fixture exercises the real derivation
        (liveBackgroundOperationState) rather than hand-passing the live state in. */}
    <section data-shell-rows className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-medium">Background shell rows</h2>
      <div className="mt-3 flex flex-col gap-2">
        <ThreadSlugContext.Provider value={thread.id}>
          {/* Live detached shell: pulsing BLUE mark leading the row, "running" in the reading. */}
          <ToolCardRouter t={{ name: "Bash", detail: "Watch CI", desc: "Watch CI", command: "gh run watch 12345", backgroundState: "background", status: "pending", count: 1 }} />
          {/* Tracked, but its process is GONE (the "Dev server" entry above): the flat stale dot beside
              the word "stale", although the call itself still reads pending. */}
          <ToolCardRouter t={{ name: "Bash", detail: "Dev server", desc: "Dev server", command: "nub run dev", backgroundState: "background", status: "pending", count: 1 }} />
          {/* Detached, but frizz tracks no live op behind it: the mark is the pending-background dot. */}
          <ToolCardRouter t={{ name: "Bash", detail: "Untracked background job", desc: "Untracked background job", command: "node worker.mjs", backgroundState: "background", status: "pending", count: 1 }} />
          {/* FOREGROUND pending, running a while: the SAME blue mark in the SAME slot. Detachment is not
              what the dot encodes any more — a shell that is running right now is one fact, and this row
              is the one the reader most needs to find (maintainer 2026-07-30). */}
          <ToolCardRouter t={{ name: "Bash", detail: "Build the workspace", desc: "Build the workspace", command: "npm run build", status: "pending", count: 1 }} startedAt={agoIso(0.7)} />
          {/* FOREGROUND pending, just issued: NO mark yet. The threshold keeps a batch of sub-second
              Reads and Greps from strobing a dot; this row arms a timer and marks ITSELF when it lands,
              with no data push behind it. */}
          <ToolCardRouter t={{ name: "Bash", detail: "List the changed files", desc: "List the changed files", command: "git status --short", status: "pending", count: 1 }} startedAt={freshStartedAt} />
          {/* Resolved FOREGROUND: no mark and no slot, so "Bash" sits flush at the header's left edge. A
              foreground command lived and died inside its own batch, and it folds back into the activity
              disclosure once settled — marking those would put a dot on every Read and Grep. */}
          <ToolCardRouter t={{ name: "Bash", detail: "Run the unit suite", desc: "Run the unit suite", command: "npm test", status: "completed", durationMs: 32_000, count: 1 }} />
          <ToolCardRouter t={{ name: "Bash", detail: "Typecheck", desc: "Typecheck", command: "npm run typecheck", status: "failed", exitCode: 1, durationMs: 12_000, count: 1 }} />
          {/* Resolved BACKGROUND: also no mark, and in a real transcript no card of its own either — a
              finished detached task folds back into the disclosure like any settled call
              (isToolActivityException, 2026-09-13), so this row is the shape it takes when the reader
              expands that disclosure. It states "done · 1 min 36 sec". Detachment does not earn a mark
              in this column; being ALIVE does. */}
          <ToolCardRouter t={{ name: "Bash", detail: "Warm the artifact cache", desc: "Warm the artifact cache", command: "nub scripts/warm-cache.mjs", backgroundState: "background", status: "completed", durationMs: 96_000, count: 1 }} />
        </ThreadSlugContext.Provider>
      </div>
    </section>
    <section className="rounded-lg border border-border bg-panel p-4">
      <h2 className="text-sm font-medium">Disclosure row alignment</h2>
      <div className="mt-3 flex flex-col gap-2">
        <DisclosureFixture running />
        <DisclosureFixture running={false} />
      </div>
    </section>
  </main>
  </QueryClientProvider>,
)
