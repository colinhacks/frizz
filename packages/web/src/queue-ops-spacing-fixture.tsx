import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, GithubRefCard, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import { ThreadView } from "./components/ChatView.tsx"
import { GithubHovercards } from "./components/GithubHovercards.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the BOTTOM of a thread: the prompt box and the line of op counts above it
// (QueueOpsSummary), each of whose counts opens a hover panel of its own ⤷ rows — AGENT, SHELL, GITHUB,
// File or Link. Until 2026-10-05 the rows hung under the prompt box above a lifecycle footer, and this
// fixture measured that column's rhythm (the maintainer read the gap under the prompt box as too
// large); the rows keep that rhythm inside a panel, so it still measures them there. It drew the queue
// card until the card went (2026-11-10), and draws the thread view every surface draws since.

const SLUG = "queue-ops-spacing-demo"

const EXTRA_ISSUES = [
  { ref: "colinhacks/frizz#72", title: "The drawer's ops line drops a count after a restart" },
  { ref: "colinhacks/frizz#73", title: "A watched issue's row says nothing about the issue" },
  { ref: "colinhacks/frizz#74", title: "Timer rows tick a second behind the countdown on the card" },
  { ref: "colinhacks/frizz#75", title: "Shell output drawer loses its scroll position on new lines" },
  { ref: "colinhacks/frizz#76", title: "Link rows truncate the destination before the label" },
  { ref: "colinhacks/frizz#77", title: "Count line wraps under a narrow drawer" },
].slice(0, Math.max(0, Number(new URLSearchParams(location.search).get("issues") ?? 1) - 1))

const messages: TranscriptMessage[] = [
  { role: "user", text: "Poll the panes and report what you find.", tools: [], parts: [{ kind: "text", text: "Poll the panes and report what you find." }] },
  {
    role: "assistant",
    text: "Three watchers are live; I'll fold their output in as they land.",
    tools: [],
    parts: [{ kind: "text", text: "Three watchers are live; I'll fold their output in as they land." }],
  },
]

const thread = {
  id: SLUG,
  title: "Ops-strip spacing",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  needsYou: true,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "idle",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  backend: "claude",
  permissionMode: "default",
  // ?agents=1 puts the live ⤷ sub-agent lines directly above the ⤷ shell rows — the adjacency the
  // strip's pt-1.5 is matched to, and the only state where the two lists' rhythm can be compared.
  subAgents: new URLSearchParams(location.search).get("agents") === "1"
    ? [{ id: "agent-a", label: "Diff the queue card against the drawer footer", startedAt: "2026-07-18T09:05:00.000Z", state: "running" }]
    : [],
  // ?shells=0 is the CONTROL case: with no live ops the counts line unmounts, so the prompt box must
  // still sit correctly on the dock's own 12px.
  // Every row carries an `id` so it renders the dismiss × — the shipped row has had one on all three
  // densities since 2026-07-30, and the × is the tallest thing on the line, so a fixture without it
  // measures a row height the app never draws.
  bgShells: new URLSearchParams(location.search).get("shells") === "0" ? [] : [
    { id: "shell-a", label: "Poll panes for perm-prompt false positives", startedAt: "2026-07-18T09:06:00.000Z", state: "stale" },
    { id: "shell-b", label: "Poll panes for near-miss perm markers", startedAt: "2026-07-18T09:07:00.000Z", state: "running" },
    { id: "shell-c", label: "Record 5min of frizz board SSE", startedAt: "2026-07-18T09:09:00.000Z", state: "running" },
  ],
  // ?links=1 appends the saved-reference rows (ThreadLinks) under the live ones — the one adjacency
  // in which a File/Link row's box can be read against an AGENT/SHELL row's. Their rows shipped
  // with `py-0.5 leading-5` on top of the ops rows' bare inherited line box, 24px against 17.25px
  // (maintainer 2026-09-11: "It should be the exact same spacing and padding"); this is where that
  // is measured.
  links: new URLSearchParams(location.search).get("links") === "1" ? [
    { id: "lnk_file_a", kind: "file", label: "Structured restriction report", target: "/tmp/reports/structured-restriction.md" },
    { id: "lnk_file_b", kind: "file", label: "HKS pair-merge report", target: "/tmp/reports/hks-pair-merge.md" },
    { id: "lnk_url", kind: "link", label: "Dev server", target: "http://127.0.0.1:5173/" },
  ] : [],
  // ?watches=1 adds two watched pull requests and a watched issue, so with ?agents=1&links=1 the line
  // carries all six counts — each opens a panel of its own kind of row and no other (2026-10-11).
  watches: new URLSearchParams(location.search).get("watches") === "1" ? [
    { id: "w_pr_a", kind: "github", target: "colinhacks/zod#6559", state: "armed", createdAt: "2026-07-18T08:40:00.000Z",
      github: { checks: "running", running: 14, passed: 15, failed: 0, skipped: 0, gated: 0, gating: [], failing: [], merge: "unknown", state: "open", polledAt: new Date().toISOString() } },
    { id: "w_pr_b", kind: "github", target: "nubjs/nub#874", state: "armed", createdAt: "2026-07-18T08:12:00.000Z",
      github: { checks: "passing", running: 0, passed: 29, failed: 0, skipped: 1, gated: 0, gating: [], failing: [], merge: "mergeable", state: "open", polledAt: new Date().toISOString() } },
    { id: "w_issue", kind: "github", subject: "issue", target: "colinhacks/frizz#61", state: "armed", createdAt: "2026-07-18T07:55:00.000Z",
      issue: { state: "open", title: "Ops panel lists every row", comments: 4, polledAt: "2026-07-18T09:10:00.000Z" } },
    // ?issues=7 makes the issue count seven, the panel of watched issues the maintainer read as too spread out.
    ...EXTRA_ISSUES.map((issue, i) => ({ id: `w_issue_${i}`, kind: "github", subject: "issue", target: issue.ref, state: "armed", createdAt: new Date(Date.now() - (49 - i * 6) * 60_000).toISOString(),
      issue: { state: "open", title: issue.title, comments: i % 3 === 0 ? 1 : 0, polledAt: "2026-07-18T09:10:00.000Z" } })),
  ] : [],
  lastActivityAt: "2026-07-18T09:11:00.000Z",
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot

const transcriptPage = { messages, transcriptKey: "fixture-key", hasEarlier: false, historyLoaded: false }

// THE HOVERCARD BATCH, answered locally, for the watched PRs and issue: their rows open the same GitHub
// card a `#123` in prose does (2026-11-19). Only the answer is stubbed; the rows' refs are still harvested,
// batched and parsed by lib/githubHovercards.ts, and the card is drawn by the app's own layer.
const HOVER_CARDS: GithubRefCard[] = [
  { ref: "colinhacks/zod#6559", kind: "pr", repo: "colinhacks/zod", url: "https://github.com/colinhacks/zod/pull/6559",
    title: "Recursive object schemas keep their inferred keys", body: "Fixes the inference collapse on a self-referencing object.",
    state: "OPEN", at: "2026-07-18T08:40:00.000Z", authorLogin: "colinhacks", labels: [], comments: 3, additions: 41, deletions: 9, fetchedAt: 0 },
  { ref: "nubjs/nub#874", kind: "pr", repo: "nubjs/nub", url: "https://github.com/nubjs/nub/pull/874",
    title: "Run a package script from a nested workspace", body: "", state: "OPEN", at: "2026-07-18T08:12:00.000Z",
    authorLogin: "colinhacks", labels: [], comments: 0, additions: 12, deletions: 3, fetchedAt: 0 },
  { ref: "colinhacks/frizz#61", kind: "issue", repo: "colinhacks/frizz", url: "https://github.com/colinhacks/frizz/issues/61",
    title: "Ops panel lists every row", body: "Hovering a count opens one panel that lists every kind of row at once.",
    state: "OPEN", at: "2026-07-17T16:02:00.000Z", authorLogin: "colinhacks", labels: [{ name: "bug", color: "d73a4a" }], comments: 4, fetchedAt: 0 },
  ...EXTRA_ISSUES.map((issue): GithubRefCard => ({ ref: issue.ref, kind: "issue", repo: "colinhacks/frizz", url: `https://github.com/${issue.ref.replace("#", "/issues/")}`,
    title: issue.title, body: "Seen on the board after a restart; the steps are in the thread linked below.", state: "OPEN", at: "2026-11-18T21:40:00.000Z",
    authorLogin: "colinhacks", labels: [], comments: 1, fetchedAt: 0 })),
]

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/_frizz/rpc/githubRefPreview") {
    const refs: string[] = JSON.parse(url.searchParams.get("input") ?? "{}").refs ?? []
    const cards = HOVER_CARDS.filter((card) => refs.includes(card.ref)).map((card) => ({ ...card, fetchedAt: Date.now() }))
    return new Response(JSON.stringify({ result: { cards, missing: refs.filter((ref) => !cards.some((card) => card.ref === ref)) } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname === "/_frizz/rpc/threadTranscript" || url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    return new Response(JSON.stringify({ result: transcriptPage }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

function Fixture() {
  // A <main>, as the pane's column is: the panels that open off the prompt box take it as their boundary.
  return (
    <main className="mx-auto flex h-screen w-[760px] max-w-full flex-col border-x border-border bg-bg text-sm text-fg">
      <ThreadView slug={SLUG} />
    </main>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <Fixture />
      <GithubHovercards />
    </TooltipProvider>
  </QueryClientProvider>,
)
