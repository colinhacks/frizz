import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import { ThreadView } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for THE WAIT, DATED (lib/messageTime): the rest hairline above a reply that came 20m or
// more after the agent rested reads `Today · 10:51 AM`, the instant of the reply, in place of "Agent
// rested · 3h ago" — and every message carries its instant as a native hover. The excerpt is the one
// that prompted it: a question YESTERDAY, the reply this morning, then a quick reply a few minutes after
// the next rest, which keeps the plain "Agent rested" rule. Instants are relative to the real clock so
// "Today" and "Yesterday" read true whenever this is opened.
//
//   nubx vite --port 5478 --strictPort      (from packages/web)
//   http://localhost:5478/rest-gap-fixture.html

const SLUG = "rest-gap"
const PARAMS = new URLSearchParams(location.search)
document.documentElement.dataset.font = PARAMS.get("font") === "mono" ? "mono" : "sans"

const thread = {
  id: SLUG,
  title: "Encrypt the token file at rest",
  status: "needs-human",
  statusText: "Waiting on your call",
  mechanism: null,
  humanBlocked: true,
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
  subAgents: [],
  bgShells: [],
  lastActivityAt: "2026-07-18T10:00:00.000Z",
  spawnedAt: "2026-07-18T09:00:00.000Z",
  // The push-now click resolves this at CLICK time and refuses without it, so the control is only
  // driveable here if the fixture thread carries one — same as any live row.
  sessionId: "sid-rest-gap",
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot

const today = new Date()
const on = (daysAgo: number, h: number, m: number) => new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo, h, m).toISOString()
const user = (id: string, at: string, text: string) => ({ sourceId: id, role: "user", text, tools: [], parts: [], at })
const agent = (id: string, at: string, text: string) => ({ sourceId: id, role: "assistant", text, tools: [], parts: [{ kind: "text", text }], at })

const tool = (name: string, detail: string) => ({ name, status: "completed", detail })
const worked = (id: string, at: string, text: string, tools: ReturnType<typeof tool>[]) => ({ sourceId: id, role: "assistant", text, tools, parts: [{ kind: "tools", tools }, { kind: "text", text }], at })
const rested = (id: string, at: string) => ({ sourceId: id, role: "assistant", kind: "event", boundary: "rest", text: "Agent rested", tools: [], parts: [], at })

const messages = [
  user("u0", on(1, 15, 2), "Can you check whether the relay token file is encrypted at rest?"),
  agent("a0", on(1, 15, 3), "It is not — `~/.frizz/relay-token` is plain text at `0600`. Encrypting it means a keychain read on every boot."),
  rested("r0", on(1, 15, 3)),
  user("u1", on(0, 10, 51), "I don't want to give you my macOS password."),
  worked("a1", on(0, 10, 52), "That's fine — the keychain read needs it once per boot, so the fallback is to skip encryption at rest and keep the token file at `0600`.", [tool("Bash", "stat -f %Lp ~/.frizz/relay-token")]),
  rested("r1", on(0, 10, 52)),
  user("u2", on(0, 10, 56), "maybe its not worth encrypting"),
  agent("a2", on(0, 10, 57), "Agreed — leaving it at `0600` and noting why in the README."),
  rested("r2", on(0, 10, 57)),
] as unknown as TranscriptMessage[]

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : ((input as Request).url ?? input.toString()), location.origin)
  if (url.pathname === "/_frizz/rpc/threadTranscript" || url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    return new Response(
      JSON.stringify({ result: { messages, transcriptKey: `${SLUG}-key`, hasEarlier: false, historyLoaded: true } }),
      { headers: { "content-type": "application/json" } },
    )
  }
  // An answered-questions list is a list, and an empty object for it is a page error on every load.
  if (url.pathname === "/_frizz/rpc/threadSettledQuestions") {
    return new Response(JSON.stringify({ result: { questions: [] } }), { headers: { "content-type": "application/json" } })
  }
  // …and so is a path lookup, which the token file's `~/.frizz/relay-token` in the prose sets off.
  if (url.pathname === "/_frizz/rpc/resolveLocalPaths") {
    const { paths = [] } = JSON.parse(String(init?.body ?? "{}")) as { paths?: string[] }
    return new Response(JSON.stringify({ result: { resolved: paths.map((input) => ({ input, path: null })) } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <div className="relative h-screen bg-bg text-fg text-sm">
        <div className="mx-auto flex h-screen w-[760px] max-w-full flex-col border-x border-border">
          <ThreadView slug={SLUG} />
        </div>
      </div>
    </TooltipProvider>
  </QueryClientProvider>,
)
