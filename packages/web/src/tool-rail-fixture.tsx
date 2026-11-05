import { useEffect, useMemo } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import type { ChatMessage } from "./hooks.ts"
import { Message, ThreadSlugContext, withMessageSpacers } from "./components/ChatView.tsx"
import { coalesceToolActivityMessages } from "./lib/toolActivity.ts"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the TIMELINE RAIL (lib/diff/diff.css). Every shape a tool row can take, drawn through the
// real Message path so ToolRailRows decides the seams. components/toolRail.e2e.test.ts measures it.
//   • `digest` — the settled run behind `Ran N tool calls`, opened on load, carrying each node state
//   • `exceptions` — rows that stay visible, with a live sub-agent and a live background shell in the node
//   • `lone` — a single row, which has no line at all
//   • `split` — two messages of tools, which keep two rails
//   • `mixed` — a steer divider inside an exception run, which ends the rail on both sides
//   • `open` — a run whose bodies are open (`?open=1`), which the line has to run through

const agoIso = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString()
const PROJECT_DIR = "/Users/fixture/Documents/projects/frizz"
const SLUG = "tool-rail"

const thread = {
  id: SLUG,
  title: "Tool rail",
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
  subAgents: [
    { id: "agent-running", label: "Audit the transcript", startedAt: agoIso(4), state: "running", subagentType: "frizz:opus-high", lastActivityAt: agoIso(0) },
    { id: "agent-stale", label: "Prior investigation", startedAt: agoIso(51), state: "stale", subagentType: "frizz:sonnet-high", lastActivityAt: agoIso(42) },
    { id: "agent-rested", label: "Fan out the sweep", startedAt: agoIso(23), state: "rested", subagentType: "frizz:opus-high", lastActivityAt: agoIso(18) },
  ],
  bgShells: [{ label: "Watch CI", startedAt: agoIso(3), state: "running", lastActivityAt: agoIso(1) }],
  watches: [],
  questions: [],
} as unknown as ThreadView

store.board = { threads: [thread], projectDir: PROJECT_DIR } as unknown as BoardSnapshot

function call(sourceId: string, tools: ChatMessage["tools"]): ChatMessage {
  return { sourceId, role: "assistant", text: "", tools, at: agoIso(1), parts: [{ kind: "tools", tools }] }
}

const LONG_PATH = `${PROJECT_DIR}/packages/web/src/components/some/deeply/nested/folder/that/runs/on/for/a/while/ChatView.tsx`
const LONG_COMMAND = Array.from({ length: 30 }, (_, i) => `echo "line ${i + 1}"`).join("\n")

const digest = call("digest", [
  { name: "Read", detail: `${PROJECT_DIR}/packages/web/src/lib/diff/diff.css`, read: ".frizz-bash {\n  position: relative;\n}", status: "completed", durationMs: 18 },
  { name: "Grep", detail: "frizz-bash-header", status: "completed", durationMs: 32 },
  { name: "Edit", detail: `${PROJECT_DIR}/packages/web/src/components/ChatView.tsx`, edit: { file: `${PROJECT_DIR}/packages/web/src/components/ChatView.tsx`, old: "const a = 1\nconst b = 2\n", new: "const a = 1\nconst b = 3\nconst c = 4\n" }, status: "completed", durationMs: 41 },
  { name: "Bash", detail: "git status", desc: "Showing the working tree status", command: "git status --short", status: "completed", durationMs: 1_200 },
  { name: "Bash", detail: "nub run test", desc: "Running the focused tests", command: "nub run test packages/web/src/lib/toolRow.test.ts", output: "✖ one failing test\nnot ok 1", status: "failed", exitCode: 1, durationMs: 12_400 },
  { name: "Bash", detail: "sleep 600", desc: "Waiting on the slow build", command: "sleep 600", status: "cancelled", durationMs: 95_000 },
  { name: "Bash", detail: "git log --oneline -3", command: "git log --oneline -3", status: "completed", durationMs: 90 },
  { name: "Read", detail: LONG_PATH, read: "export function Message() {}", status: "completed", durationMs: 7 },
  { name: "TaskList", detail: "tasks", status: "completed", durationMs: 11, todos: [
    { text: "Inspect the row", status: "completed" },
    { text: "Draw the rail through the transcript", status: "in_progress" },
    { text: "Land it", status: "pending" },
  ] },
  { name: "mcp__chrome-devtools__list_pages", status: "completed", durationMs: 44 },
])

const exceptions = call("exceptions", [
  { name: "Agent", detail: "Audit the transcript", prompt: "Audit every tool row in the transcript and report what still reads as a capsule.", subagentType: "frizz:opus-high", agentId: "agent-running", status: "pending" },
  { name: "Agent", detail: "Prior investigation", prompt: "Investigate the earlier failure.", subagentType: "frizz:sonnet-high", agentId: "agent-stale", status: "pending" },
  { name: "Agent", detail: "Fan out the sweep", prompt: "Fan out across every package.", subagentType: "frizz:opus-high", agentId: "agent-rested", status: "pending" },
  { name: "Bash", detail: "Watch CI", desc: "Watch CI", command: "gh run watch 12345", backgroundState: "background", status: "pending" },
  { name: "Agent", detail: "Review the diff", prompt: "Review the diff.", subagentType: "frizz:sonnet-medium", agentId: "agent-done", agentStatus: "completed", agentElapsedMs: 183_000, status: "completed", durationMs: 183_000 },
  { name: "Agent", detail: "Interrupted long-running audit", prompt: "Audit every call site.", subagentType: "frizz:sonnet-medium", agentId: "agent-killed", agentStatus: "killed", agentElapsedMs: 2_460_000, status: "completed", durationMs: 2_460_000 },
  { name: "Agent", detail: "Crashed dependency sweep", prompt: "Sweep every dependency.", subagentType: "frizz:sonnet-medium", agentId: "agent-failed", agentStatus: "failed", agentElapsedMs: 738_000, status: "failed", durationMs: 738_000 },
])

const lone = call("lone", [{ name: "Agent", detail: "Review the diff", prompt: "Review the diff.", subagentType: "frizz:sonnet-medium", agentId: "agent-lone", agentStatus: "completed", agentElapsedMs: 61_000, status: "completed", durationMs: 61_000 }])

const split = [
  call("split-1", [{ name: "Agent", detail: "First child", prompt: "One.", agentId: "agent-split-1", agentStatus: "completed", agentElapsedMs: 5_000, status: "completed", durationMs: 5_000 }]),
  call("split-2", [{ name: "Agent", detail: "Second child", prompt: "Two.", agentId: "agent-split-2", agentStatus: "completed", agentElapsedMs: 8_000, status: "completed", durationMs: 8_000 }]),
]

const mixed = call("mixed", [
  { name: "Agent", detail: "Before the steer", prompt: "One.", agentId: "agent-mixed-1", agentStatus: "completed", agentElapsedMs: 5_000, status: "completed", durationMs: 5_000 },
  { name: "SendMessage", sendTo: "agent-mixed-1", sendSummary: "Change of plan", sendBody: "Stop and re-read the spec.", status: "completed" },
  { name: "Agent", detail: "After the steer", prompt: "Two.", agentId: "agent-mixed-2", agentStatus: "completed", agentElapsedMs: 8_000, status: "completed", durationMs: 8_000 },
])

const open = call("open", [
  { name: "Bash", detail: "print lines", desc: "Printing a long command", command: LONG_COMMAND, output: "line 1\nline 2", status: "completed", durationMs: 300 },
  { name: "Read", detail: `${PROJECT_DIR}/src/app.ts`, read: "export const app = 1\n", status: "completed", durationMs: 4 },
  { name: "Edit", detail: `${PROJECT_DIR}/src/app.ts`, edit: { file: `${PROJECT_DIR}/src/app.ts`, old: "export const app = 1\n", new: "export const app = 2\n" }, status: "completed", durationMs: 9 },
  { name: "mcp__fixture__do_thing", detail: "argument", input: "{\"a\": 1}", output: "{\"b\": 2}", status: "completed", durationMs: 40 },
  { name: "Agent", detail: "Review the diff", prompt: "Review the diff, and say what still reads as a capsule.\n\nThen stop.", agentId: "agent-open", agentStatus: "completed", agentElapsedMs: 61_000, status: "completed", durationMs: 61_000 },
])

function Transcript({ messages }: { messages: ChatMessage[] }) {
  const display = useMemo(() => coalesceToolActivityMessages(messages), [messages])
  return (
    <div data-transcript-column className="flex flex-col">
      {withMessageSpacers(display.map((entry) => entry.message), (message, index) => <Message key={index} m={message} />)}
    </div>
  )
}

function Case({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <section data-case={name}>
      <h2 className="mb-2 text-[12px] font-medium text-muted">{name}</h2>
      {children}
    </section>
  )
}

const OPEN_BODIES = new URLSearchParams(location.search).get("open") === "1"

function Fixture() {
  useEffect(() => {
    // Every digest opens on load: the rows are what this page is about.
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-tool-activity] > button[aria-expanded="false"]')) button.click()
    if (!OPEN_BODIES) return
    const timer = setTimeout(() => {
      for (const header of document.querySelectorAll<HTMLElement>('[data-case="open"] :is(.frizz-bash-header, .frizz-diff-header)')) header.click()
      for (const header of document.querySelectorAll<HTMLElement>('[data-case="digest"] :is(.frizz-bash-header, .frizz-diff-header)')) if (header.textContent?.includes("Running the focused tests") || header.textContent?.startsWith("Todos")) header.click()
    }, 100)
    return () => clearTimeout(timer)
  }, [])
  return (
    <ThreadSlugContext.Provider value={SLUG}>
      <main className="min-h-screen bg-panel p-4 text-fg sm:p-8">
        <div className="mx-auto flex max-w-[760px] flex-col gap-8">
          <Case name="digest"><Transcript messages={[digest]} /></Case>
          <Case name="exceptions"><Transcript messages={[exceptions]} /></Case>
          <Case name="lone"><Transcript messages={[lone]} /></Case>
          <Case name="split"><Transcript messages={split} /></Case>
          <Case name="mixed"><Transcript messages={[mixed]} /></Case>
          <Case name="open"><Transcript messages={[open]} /></Case>
        </div>
      </main>
    </ThreadSlugContext.Provider>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <Fixture />
  </QueryClientProvider>,
)
