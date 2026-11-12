import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { AwaitingHint, BoardSnapshot, HumanTodo, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import { ThreadView } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import { fixtureSetHumanTodo, fixtureTodos } from "./human-todos-fixture-stub.ts"
import "./styles.css"

// Browser QA for A STEPS CARD THAT OUTLIVES ITS REST (2026-10-08, maintainer: "We need to continue showing
// the to do instructions even after they are complete & the thread has moved on"). The drawer, mounted as
// production mounts it (ThreadView), over a transcript whose ```awaiting fence handed the
// human steps — and then, per `?at=`, where the thread has got to since:
//
//   ?at=rest     the thread is still resting on the steps — the tail's resting card states them, with the box
//                the prompt box under it sends (or, `&drawer=1` at a phone width, the card's own Send)
//   ?at=running  the human sent the ticked box and the worker is mid-turn (the default)
//   ?at=moved    the worker finished and rested again on a later fence of its own
//   ?at=asked    the human replied in words instead of ticking a box, and the worker is mid-turn: both
//                steps are still owed on the list, so the settled card's boxes still tick it
//   ?at=partial  the human reported one step of the two done, and the worker is mid-turn: the second
//                is still owed
//   ?at=carried-rest  a box ticked at an EARLIER steps rest and never sent rides on the next rest's card
//                beside its own two steps (the nub thread of 2026-11-11)
//   ?at=carried  all three sent with one "Done", which the worker took in mid-turn: it had just woken on
//                a shell and made a tool call, so the reply is drawn under that call
//
// The transcript also carries an EARLIER settled fence with no steps — a plain shell wait — which must
// keep drawing nothing in every state: that is the negative control for the exception.

const SLUG = "settled-steps"
const PARAMS = new URLSearchParams(location.search)
const AT = PARAMS.get("at") ?? "running"
document.documentElement.dataset.font = PARAMS.get("font") === "mono" ? "mono" : "sans"

const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

const SHELL_FENCE = "```awaiting\nshells: [bzvtnt3ig]\nstatus: working\nfor: 30m\n---\nThe release build is running in the background.\n```"
const STEPS_PROSE = "The 4.2.0 tag is cut and verified. The publish step runs as the acme-bot account, and no token for it is available to this thread."
const STEPS_HINTS: AwaitingHint[] = [
  { kind: "title", value: "Sign in to npm so the acme 4.2.0 release can publish" },
  { kind: "step", value: "Run `npm login --auth-type=web` in a terminal on this machine." },
  { kind: "step", value: "Approve the browser prompt with the **acme-bot** account." },
]
const STEPS_FENCE = [
  "```awaiting",
  "title: Sign in to npm so the acme 4.2.0 release can publish",
  "steps:",
  "  - Run `npm login --auth-type=web` in a terminal on this machine.",
  "  - Approve the browser prompt with the **acme-bot** account.",
  "---",
  STEPS_PROSE,
  "```",
].join("\n")
const LATER_FENCE = "```awaiting\nprs: [acme/app#391]\nstatus: watching\nfor: 1d\n---\nPublished acme 4.2.0. Watching the follow-up PR for review.\n```"

const say = (sourceId: string, text: string, min: number) =>
  ({ sourceId, role: "assistant", text, tools: [], parts: [{ kind: "text", text }], at: ago(min) }) as unknown as TranscriptMessage
const human = (sourceId: string, text: string, min: number) =>
  ({ sourceId, role: "user", text, tools: [], parts: [], at: ago(min) }) as unknown as TranscriptMessage

// THE CARRIED CASE: two steps rests, the first box of the first ticked and never sent.
const CARRIED = AT === "carried" || AT === "carried-rest"
const FIRST_STEPS = ["Authorize the first Cloudflare sign-in.", "Verify the Gmail address once the email arrives."]
const SECOND_STEPS = ["Authorize the second Cloudflare sign-in.", "Verify the Gmail address within 50 minutes."]
const stepsFence = (title: string, steps: readonly string[], prose: string) =>
  ["```awaiting", `title: ${title}`, "steps:", ...steps.map((step) => `  - ${step}`), "---", prose, "```"].join("\n")
const SECOND_PROSE = "The forwarding rule gets created as soon as the Gmail address shows as verified."
const SECOND_HINTS: AwaitingHint[] = [{ kind: "title", value: "Authorize the second sign-in, then verify the Gmail address" }, ...SECOND_STEPS.map((value) => ({ kind: "step", value }) as AwaitingHint)]
const toolCall = (sourceId: string, min: number) =>
  ({ sourceId, role: "assistant", text: "", tools: [call], parts: [{ kind: "tools", tools: [call] }], at: ago(min) }) as unknown as TranscriptMessage
const call = { name: "Bash", detail: "cloudflare-oauth run", desc: "Starting the second sign-in" }
const event = (sourceId: string, text: string, min: number) =>
  ({ sourceId, role: "assistant", kind: "event", text, tools: [], parts: [], at: ago(min) }) as unknown as TranscriptMessage

const carriedMessages: TranscriptMessage[] = [
  human("u1", "Forward team@ to my Gmail.", 40),
  say("a1", `The route needs a sign-in.\n\n${stepsFence("Authorize the sign-in, then verify the Gmail address", FIRST_STEPS, "The rule is created once the address is verified.")}`, 30),
  say("a2", `The first sign-in went partway.\n\n${stepsFence("Authorize the second sign-in, then verify the Gmail address", SECOND_STEPS, SECOND_PROSE)}`, 10),
  ...(AT === "carried" ? [
    event("e1", "Background task «Starting the second sign-in» finished", 5.001),
    // Made 4s AFTER the human sent, and drawn above the reply: the worker took the reply in after it.
    toolCall("a3", 4.93),
    human("u2", "Done", 5),
  ] : []),
]

const messages: TranscriptMessage[] = CARRIED ? carriedMessages : [
  human("u1", "Cut the acme 4.2.0 release.", 40),
  say("a1", `Building the release artifacts.\n\n${SHELL_FENCE}`, 38),
  say("a2", `The build is green.\n\n${STEPS_FENCE}`, 20),
  ...(AT === "rest" ? [] : [human("u2", AT === "asked" ? "Which account should approve it — the bot or mine?" : AT === "partial" ? "Done 1 of 2:\n- [x] Run `npm login --auth-type=web` in a terminal on this machine.\n- [ ] Approve the browser prompt with the **acme-bot** account." : "Done", 5)]),
  ...(AT === "moved" ? [say("a3", LATER_FENCE, 1)] : []),
]

// THE LIST AS THE SERVER HOLDS IT in each state (human-todos.ts): both steps owed at rest and after a
// reply in words, both reported done after "Done", and the second still owed after "Done 1 of 2".
function todosAt(): HumanTodo[] {
  if (CARRIED) {
    // The first rest's second step was never ticked, so the second rest's list dropped it.
    const [first, ...second] = fixtureTodos([FIRST_STEPS[0], ...SECOND_STEPS])
    const sentAt = Date.now() - 5 * 60_000
    if (AT === "carried-rest") return [{ ...first, done: true, staged: true }, ...second]
    return [first, ...second].map((todo) => ({ ...todo, done: true, staged: false, reportedAt: sentAt }))
  }
  const todos = fixtureTodos(STEPS_HINTS.filter((h) => h.kind === "step").map((h) => h.value))
  const reported = AT === "running" || AT === "moved" ? 2 : AT === "partial" ? 1 : 0
  return todos.map((todo, i) => (i < reported ? { ...todo, done: true } : todo))
}

const thread = {
  id: SLUG,
  title: "Cut the acme 4.2.0 release",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  needsYou: AT === "rest" || AT === "moved" || AT === "carried-rest",
  awaitingBackground: AT === "rest" || AT === "moved" || AT === "carried-rest",
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: AT === "running" || AT === "asked" || AT === "partial" || AT === "carried" ? "running" : "turn-idle",
  sessionId: "sid-settled-steps",
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
  questions: [],
  ...(AT === "rest" ? { lastFence: { kind: "awaiting", body: STEPS_PROSE, hints: STEPS_HINTS } } : {}),
  ...(AT === "carried-rest" ? { lastFence: { kind: "awaiting", body: SECOND_PROSE, hints: SECOND_HINTS } } : {}),
  humanTodos: todosAt(),
  ...(AT === "moved" ? { lastFence: { kind: "awaiting", body: "Published acme 4.2.0. Watching the follow-up PR for review.", hints: [{ kind: "pr", value: "acme/app#391" }] }, waitStatus: "watching" } : {}),
  lastActivityAt: ago(1),
  spawnedAt: ago(41),
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : ((input as Request).url ?? input.toString()), location.origin)
  if (url.pathname === "/_frizz/rpc/threadTranscript" || url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    return new Response(
      JSON.stringify({ result: { messages, transcriptKey: `${SLUG}-${AT}`, hasEarlier: false, historyLoaded: true } }),
      { headers: { "content-type": "application/json" } },
    )
  }
  if (url.pathname === "/_frizz/rpc/threadSettledQuestions") {
    return new Response(JSON.stringify({ result: { questions: [] } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname === "/_frizz/rpc/setHumanTodo") {
    fixtureSetHumanTodo(JSON.parse(String(init?.body ?? "{}")))
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
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
          {/* `?drawer=1` hands it a close, which is what makes it a DRAWER — the one mount that takes the
              phone's chrome below the breakpoint, and with it the phone bar, which sends no answers. */}
          <ThreadView slug={SLUG} onClose={PARAMS.has("drawer") ? () => {} : undefined} />
        </div>
      </div>
    </TooltipProvider>
  </QueryClientProvider>,
)
