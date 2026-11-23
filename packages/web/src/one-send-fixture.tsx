import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { AwaitingHint, BoardSnapshot, RegisteredQuestionView, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import { ThreadView } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import { fixtureSetHumanTodo, fixtureTodos } from "./human-todos-fixture-stub.ts"
import "./styles.css"

// Browser QA for THE ONE SEND (lib/sendScope): everything staged anywhere in a thread's transcript leaves
// through its prompt box — the button or Enter — as one turn, with whatever is typed there. The thread
// asked a question at an EARLIER rest, the human replied past it without answering, and the worker's
// newest rest asks another and hands the human steps. All three stay answerable, and one Enter in the
// prompt box must carry all three.
//
//   The thread view every surface draws (the board's pane, a drawer, the full page). It drew the queue
//   card too, under ?view=queue, until the card went (2026-11-10).
//   ?legacy=1      a thread dispatched before the free-form fence was retired: both asks are free-form
//                  ```question fences, answered through the fence controller, and one more question is a
//                  registered row of the `ask` tool's — so all three kinds of staged answer ride one send.
//                  Without it, both asks are ```question fences the server registered as rows.
//   ?transcriptDelay=MS  the transcript answers MS late, as a slow server's does: the board's questions
//                  draw at the bottom of the transcript until it lands, then move into the message that
//                  asked them, which replaces their cards (questionPickEnter.e2e.test.ts).

const SLUG = "one-send"
const params = new URLSearchParams(location.search)
const legacy = params.get("legacy") === "1"
const transcriptDelay = Number(params.get("transcriptDelay") ?? 0)
document.documentElement.dataset.font = "sans"
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

const STEPS_PROSE = "The preview is built. Its DNS record needs the account owner's approval."
const STEPS_HINTS: AwaitingHint[] = [
  { kind: "title", value: "Approve the preview's DNS record" },
  { kind: "step", value: "Approve the pending `preview.acme.dev` record in the DNS panel." },
]
const STEPS_FENCE = [
  "```awaiting",
  "title: Approve the preview's DNS record",
  "steps:",
  "  - Approve the pending `preview.acme.dev` record in the DNS panel.",
  "---",
  STEPS_PROSE,
  "```",
].join("\n")

// THE QUESTION FENCE: each ask is a fence whose `id:` the server registered as a row.
const DEPLOY: RegisteredQuestionView = {
  id: "qst_d3pl0y0001",
  handle: "deploy-target",
  askedAt: ago(30),
  standing: false,
  spec: {
    handle: "deploy-target",
    question: "Deploy the preview to staging or production?",
    kind: "question",
    options: [{ label: "Staging", recommended: true }, { label: "Production" }],
  },
}
const CHANGELOG: RegisteredQuestionView = {
  id: "qst_ch4ng3l0g1",
  handle: "changelog",
  askedAt: ago(2),
  spec: { handle: "changelog", question: "What should the changelog entry say?", kind: "question" },
}
const DEPLOY_ASK = ["```question", "id: deploy-target", "kind: choice", `question: ${DEPLOY.spec.question}`, "options:", "  - label: Staging", "    recommended: true", "  - label: Production", "```"].join("\n")
const CHANGELOG_ASK = ["```question", "id: changelog", "kind: text", `question: ${CHANGELOG.spec.question}`, "```"].join("\n")

// THE LEGACY GRAMMAR: free-form fences, and one row the `ask` tool registered.
const ORM_ASK = "```question\nWhich ORM should the docs examples use?\n- A. Drizzle\n- B. Prisma\n```"
const DB_ASK = "```question\nWhich database should the preview run on?\n- A. Postgres\n- B. SQLite\n```"
const THEME: RegisteredQuestionView = {
  id: "qst_th3m30001",
  askedAt: ago(2),
  spec: { question: "Which theme should the preview default to?", kind: "question", options: [{ label: "Light" }, { label: "Dark" }] },
}

const say = (sourceId: string, text: string, min: number) =>
  ({ sourceId, role: "assistant", text, tools: [], parts: [{ kind: "text", text }], at: ago(min) }) as unknown as TranscriptMessage
const human = (sourceId: string, text: string, min: number) =>
  ({ sourceId, role: "user", text, tools: [], parts: [{ kind: "text", text }], at: ago(min) }) as unknown as TranscriptMessage

const messages: TranscriptMessage[] = [
  human("u1", "Ship the docs site redesign.", 40),
  say("a1", `The layout is in. Before the examples, one call:\n\n${legacy ? ORM_ASK : DEPLOY_ASK}`, 30),
  human("u2", "Do the copy edits first, I'll get to that.", 20),
  say("a2", `The copy edits are in.\n\n${legacy ? DB_ASK : CHANGELOG_ASK}\n\n${STEPS_FENCE}`, 2),
]

const thread = {
  id: SLUG,
  title: "Ship the docs site redesign",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  needsYou: true,
  awaitingBackground: true,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "turn-idle",
  sessionId: "sid-one-send",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  backend: "claude",
  permissionMode: "default",
  subAgents: [],
  bgShells: [],
  watches: [],
  questions: legacy ? [THEME] : [DEPLOY, CHANGELOG],
  lastFence: { kind: "awaiting", body: STEPS_PROSE, hints: STEPS_HINTS },
  humanTodos: fixtureTodos(STEPS_HINTS.filter((h) => h.kind === "step").map((h) => h.value)),
  lastActivityAt: ago(2),
  // Before QUESTION_FENCE_RETIRED_AT the free-form fence is the worker's grammar; after it, the fence's id.
  spawnedAt: legacy ? "2026-09-01T09:00:00Z" : "2026-10-14T09:00:00Z",
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot

const json = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : ((input as Request).url ?? input.toString()), location.origin)
  if (url.pathname === "/_frizz/rpc/threadTranscript" || url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    if (transcriptDelay > 0) await new Promise((resolve) => setTimeout(resolve, transcriptDelay))
    return json({ messages, transcriptKey: `${SLUG}-${legacy ? "legacy" : "fence"}`, hasEarlier: false, historyLoaded: true })
  }
  if (url.pathname === "/_frizz/rpc/threadSettledQuestions") return json({ questions: [] })
  if (url.pathname === "/_frizz/rpc/setHumanTodo") {
    fixtureSetHumanTodo(JSON.parse(String(init?.body ?? "{}")))
    return json(null)
  }
  // Every write, echoed onto the window so the probe reads the exact payload the server would receive.
  if (url.pathname === "/_frizz/rpc/followUp" || url.pathname === "/_frizz/rpc/answerQuestions") {
    const body = JSON.parse(String(init?.body ?? "{}"))
    window.dispatchEvent(new CustomEvent("fixture-rpc", { detail: { rpc: url.pathname.split("/").pop(), body } }))
    return json({})
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) return json(null)
  return originalFetch(input, init)
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      {/* A <main>, as the pane's column is: the panels that open off the prompt box take it as their boundary. */}
      <main className="mx-auto flex h-screen w-[760px] max-w-full flex-col border-x border-border bg-bg text-sm text-fg">
        <ThreadView slug={SLUG} />
      </main>
    </TooltipProvider>
  </QueryClientProvider>,
)
