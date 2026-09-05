import { createRoot } from "react-dom/client"
import { useSnapshot } from "valtio"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { SubAgentSheet } from "./components/SubAgentSheet.tsx"
import { pushSubAgentDrawer, store } from "./store.ts"
import "./styles.css"

// Browser QA for the SUB-AGENT DRAWER's controls and regular transcript-tail liveness —
// across every state the server can put them in. The live adhoc stack can produce exactly one of
// these (a steerable broker child), because the provider's task_* progress stream only exists behind
// a real broker daemon and a codex row needs a whole second runtime. So the states that differ
// only by what the SERVER answered are driven here, off the same mocked RPC shape the real drawer
// consumes, and the one state the stack CAN reach is verified against the stack itself.
//
// ?state=steerable | rich | note-codex | note-tmux | note-nested | settled | stale

const SLUG = "steer-fixture"
const STATE = new URLSearchParams(location.search).get("state") ?? "rich"

const nativeFetch = window.fetch.bind(window)
const rpcResult = (result: unknown) =>
  new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json", "x-frizz-boot": "subagent-steer-fixture" } })

const childMessages = [
  { sourceId: "c1", role: "user", agentInstruction: true, text: "Sweep every call site of the renamed board projection helper and report the stale imports.", tools: [], parts: [{ kind: "text", text: "Sweep every call site of the renamed board projection helper and report the stale imports." }] },
  { sourceId: "c2", role: "assistant", text: "Starting the sweep. I'll grep for the old helper name first, then read each hit.", tools: [], parts: [{ kind: "text", text: "Starting the sweep. I'll grep for the old helper name first, then read each hit." }] },
  // Native Codex records WHEN this arrived, but encrypts the payload before either transcript sees it.
  { sourceId: "c3", role: "user", agentInstruction: true, text: "Follow-up instructions received. Codex encrypted the message body, so Frizz can't display it.", tools: [], parts: [{ kind: "text", text: "Follow-up instructions received. Codex encrypted the message body, so Frizz can't display it." }] },
  { sourceId: "c4", role: "assistant", text: "I received the follow-up. Checking the queue divider semantics next.", tools: [], parts: [{ kind: "text", text: "I received the follow-up. Checking the queue divider semantics next." }] },
  // A steer sent from this drawer is Frizz-owned plaintext and survives as the exact user bubble.
  { sourceId: "subagent-steer:fixture", role: "user", agentInstruction: true, text: "Focus the second pass on the queue divider semantics.", tools: [], parts: [{ kind: "text", text: "Focus the second pass on the queue divider semantics." }] },
  // Claude preserves coordinator/peer steers in plaintext; the server strips only its provider wrapper.
  { sourceId: "c5", role: "user", agentInstruction: true, text: "Check the storage deletion path too, then rerun the focused tests.", tools: [], parts: [{ kind: "text", text: "Check the storage deletion path too, then rerun the focused tests." }] },
  { sourceId: "c6", role: "assistant", text: "", tools: [{ name: "Grep", detail: "projectThreadRow", status: "completed" }], parts: [{ kind: "tools", tools: [{ name: "Grep", detail: "projectThreadRow", status: "completed" }] }] },
  { sourceId: "c7", role: "assistant", text: "", tools: [{ name: "Read", detail: "packages/server/src/board.ts", status: "completed" }], parts: [{ kind: "tools", tools: [{ name: "Read", detail: "packages/server/src/board.ts", status: "completed" }] }] },
  { sourceId: "c8", role: "assistant", text: "Three call sites still import the old name. Checking whether the delta path re-exports it before I touch anything.", tools: [], parts: [{ kind: "text", text: "Three call sites still import the old name. Checking whether the delta path re-exports it before I touch anything." }] },
]

// EXACTLY the router's own answers, per state — copied from router.ts's subAgentSteerable so a drift
// in the server's wording shows up here as a stale fixture rather than as a silently wrong review.
const RESPONSES: Record<string, { state: string; steerable: boolean; steerNote: string | null; stoppable: boolean; stopNote: string | null }> = {
  steerable: { state: "running", steerable: true, steerNote: null, stoppable: true, stopNote: null },
  rich: { state: "running", steerable: true, steerNote: null, stoppable: true, stopNote: null },
  "note-codex": {
    state: "running",
    steerable: false,
    steerNote: "Codex runs its sub-agents inside its own process and exposes no way to address one, so this child can't be steered from here.",
    stoppable: false,
    stopNote: "Codex does not expose per-sub-agent interruption to Frizz, so this child can't be stopped from here.",
  },
  "note-tmux": {
    state: "running",
    steerable: false,
    steerNote: "Steering a sub-agent needs the Claude session broker; this thread predates it.",
    stoppable: false,
    stopNote: "Stopping a sub-agent needs the Claude session broker; this thread predates it.",
  },
  // Descendant steering is unsafe (the CLI misdelivers it to the root), but stopTask's registry is
  // session-wide: this state must show the honest explanation AND a working stop control.
  "note-nested": {
    state: "running",
    steerable: false,
    steerNote: "Only sub-agents this thread dispatched itself can be steered — this one belongs to another agent.",
    stoppable: true,
    stopNote: null,
  },
  // Settled and stale both get NO footer at all: the transcript already reads as finished, and a
  // banner on every drawer opened to review completed work would be pure noise.
  settled: { state: "done", steerable: false, steerNote: null, stoppable: false, stopNote: null },
  stale: { state: "stale", steerable: false, steerNote: null, stoppable: false, stopNote: null },
}

window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.toString(), window.location.origin)
  if (url.pathname === "/_frizz/rpc/subAgentTranscript") {
    return rpcResult({ messages: childMessages, ...(RESPONSES[STATE] ?? RESPONSES.rich) })
  }
  if (url.pathname === "/_frizz/rpc/subAgentSteer") return rpcResult({ delivered: true })
  if (url.pathname === "/_frizz/rpc/subAgentStop") return rpcResult({ stopped: true, descendantsStopped: 0, note: null })
  return nativeFetch(input, init)
}

// `rich` still carries the provider's live task-stream reading on the board row, but the drawer now
// deliberately uses the regular transcript treatment instead of inventing a second progress strip.
const CHILD_ID = "toolu_child_01"
const thread: ThreadView = {
  id: SLUG,
  title: "Sweep stale imports",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "in-flight",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  bgShells: [],
  subAgents: [{
    id: CHILD_ID,
    label: "Sweep the renamed projection helper's call sites",
    startedAt: new Date(Date.now() - 437_000).toISOString(),
    state: STATE === "stale" ? "stale" : "running",
    subagentType: "frizz:opus-high",
    lastActivityAt: new Date(Date.now() - 9_000).toISOString(),
    ...(STATE === "rich"
      ? { activity: "Grep", activityDetail: "Searching for every remaining reference to the old projection helper name across the workspace", toolUses: 148, tokens: 132_000 }
      : {}),
  }],
} as unknown as ThreadView

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot

function Drawers() {
  const snap = useSnapshot(store)
  const widthDepth = snap.drawers.length - 1
  return (
    <>
      {snap.drawers.map((d, i) => (
        <SubAgentSheet
          key={d.id}
          id={d.id}
          slug={d.slug}
          subId={d.subId ?? ""}
          label={d.label ?? d.slug}
          subagentType={d.subagentType}
          startedAt={d.startedAt}
          depth={i}
          widthDepth={widthDepth}
        />
      ))}
    </>
  )
}

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={qc}>
    <main className="min-h-screen bg-bg p-8 text-fg">
      <h1 className="text-[13px] font-medium">Sub-agent drawer — regular transcript tail + controls</h1>
      <p className="mt-1 text-[11.5px] text-muted/70">
        state=<code>{STATE}</code> · append <code>?state=</code>steerable | rich | note-codex | note-tmux | note-nested | settled | stale
      </p>
      <button
        type="button"
        data-open-drawer
        className="mt-4 rounded-md border border-border bg-panel px-3 py-1.5 text-[12px]"
        onClick={() => pushSubAgentDrawer(SLUG, CHILD_ID, { label: thread.subAgents![0].label, subagentType: "frizz:opus-high", startedAt: thread.subAgents![0].startedAt })}
      >
        Open the sub-agent drawer
      </button>
    </main>
    <Drawers />
  </QueryClientProvider>,
)
