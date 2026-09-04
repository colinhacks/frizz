import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import type { ChatMessage } from "./hooks.ts"
import { Message, ThreadSlugContext } from "./components/ChatView.tsx"
import { setBoard } from "./store.ts"
import "./styles.css"

// THE AWAITING CARD AT A REST THE THREAD HAS BEEN BUMPED PAST (maintainer 2026-08-28, three screenshots
// of one thread). The worker rested on a shell, a PR watcher and a timer — three rows on the card. The
// human replied, and the card lost its shell row; the worker rested again without a fence, the human
// replied again, and the rest had no card at all under it, only the "Agent rested" hairline.
//
// Both defects had one shape: the card was keyed on the last MESSAGE and read off the board's current
// rows, and the bump changes both. This page renders each rest exactly as ChatView hands it to Message
// while the thread is running past it (`restedAt` set on the message at the rest anchor — see
// lib/restAnchor), on threads shaped like the real bumped one: the shell running with NO watch row for
// it (the board only rows a declared shell while the fence is the worker's last word), the PR and the
// timer as registry rows, and a sub-agent the reply dispatched AFTER the rest, which must not appear.
//
// Nothing real is hit: rpc is stubbed the same way the gallery fixture does it.
const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.toString(), window.location.origin)
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  return nativeFetch(input, init)
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()
const restedAt = minutesAgo(3)

const shell: ThreadView["bgShells"][number] = { id: "toolu_shell1", taskId: "bq1w2e3r4", label: "Watching the 4.5.2 release workflow run to completion", startedAt: minutesAgo(8), state: "running" }
// Dispatched a minute AFTER the rest, by the reply to the bump: mid-turn work, listed under the prompt
// box, and not what the worker rested on. Neither card may row it.
const lateAgent: ThreadView["subAgents"][number] = { id: "toolu_late", taskId: "a01b2d20b32feab11", label: "Re-check whether 4.5.2 is on npm", subagentType: "frizz:low", startedAt: minutesAgo(2), state: "running" }
const watches: ThreadView["watches"] = [
  {
    id: "github:b:colinhacks/zod#6492",
    kind: "github",
    target: "colinhacks/zod#6492",
    state: "armed",
    createdAt: minutesAgo(95),
    github: { checks: "passing", running: 0, passed: 9, failed: 0, skipped: 0, gated: 0, gating: [], failing: [], merge: "mergeable", state: "open", polledAt: minutesAgo(1) },
  },
  {
    id: "timer:b:tmr_d168bd81099d",
    kind: "timer",
    target: "tmr_d168bd81099d",
    state: "armed",
    createdAt: minutesAgo(70),
    timer: { fireAt: new Date(Date.now() + (70 * 60 + 32) * 60_000).toISOString(), prompt: "Hold period over for PR #6492 (eager method layout under NODE_ENV=test, opened 2026-08-28 for issue #6486)" },
  },
]

const thread = (id: string, title: string): ThreadView => ({
  id,
  title,
  status: "active",
  mechanism: null,
  humanBlocked: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "running",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  subAgents: [lateAgent],
  bgShells: [shell],
  watches,
  questions: [],
})

const fencedText = [
  "The release workflow is on its publish step; nothing to do until it lands.",
  "",
  "```awaiting",
  "shells: [bq1w2e3r4]",
  "prs: [colinhacks/zod#6492]",
  "timers: [tmr_d168bd81099d]",
  "for: 2h",
  "title: Release run for 4.5.2",
  "---",
  "Waiting on release workflow run 33223698574 (`build_and_publish` for 4.5.2, commit `9a193aa2`). When it completes I verify the terminal state, confirm `zod@4.5.2` on npm and the `v4.5.2` GitHub release, and note the version on #6488 and #6486. #6492 stays on hold.",
  "```",
].join("\n")

const fencelessText = "Noted; the timer stays. The release run is still in progress (it is past \"Create release\" and on the JSR publish step); the watcher wakes me when it completes."

const board: BoardSnapshot = {
  projectDir: "/tmp/fixture",
  projectName: "fixture",
  projectLabel: "fixture/fixture",
  threads: [thread("b-fenced", "fenced rest, bumped"), thread("b-fenceless", "fenceless rest, bumped"), thread("b-control", "fenceless rest, not the anchor")],
  errors: [],
  warnings: [],
}
setBoard(board)

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

const assistant = (sourceId: string, text: string): ChatMessage => ({ sourceId, role: "assistant", text, tools: [], parts: [{ kind: "text", text }], at: minutesAgo(4) })
const rest = (sourceId: string): ChatMessage => ({ sourceId, role: "assistant", kind: "event", boundary: "rest", text: "Agent rested", tools: [], parts: [], at: restedAt })
const bump = (sourceId: string, text: string): ChatMessage => ({ sourceId, role: "user", text, tools: [], parts: [], at: minutesAgo(2.5) })

// One rest, rendered the way the thread view renders it after the bump: the worker's message (carrying
// `restedAt` when it is the rest anchor), the rest hairline, the human's reply.
function Rest({ slug, label, message, restedAt: at, reply }: { slug: string; label: string; message: ChatMessage; restedAt?: string; reply: string }) {
  const t = board.threads.find((x) => x.id === slug)!
  return (
    <section data-rest={slug} className="flex flex-col gap-1.5">
      <p className="text-[11px] text-muted">{label}</p>
      <div className="flex flex-col gap-3 border border-border bg-panel px-6 py-4">
        <ThreadSlugContext.Provider value={slug}>
          <Message m={message} thread={t} restedAt={at} />
          <Message m={rest(`${slug}-rest`)} />
          <Message m={bump(`${slug}-bump`, reply)} />
        </ThreadSlugContext.Provider>
      </div>
    </section>
  )
}

function Fixture() {
  return (
    <QueryClientProvider client={client}>
      <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col gap-6 px-4 py-8">
        <p className="petite-caps text-[10px] text-accent">The awaiting card at a bumped rest</p>
        <Rest
          slug="b-fenced"
          label="a fenced rest, bumped — the fence card keeps all three rows (the shell off its own hint); the late sub-agent is not rowed"
          message={assistant("fenced", fencedText)}
          restedAt={restedAt}
          reply="I'm not interested in merging 6492 yet."
        />
        <Rest
          slug="b-fenceless"
          label="a fenceless rest on registered rows, bumped — the resting card is drawn at the rest, above the hairline"
          message={assistant("fenceless", fencelessText)}
          restedAt={restedAt}
          reply="nice"
        />
        <Rest
          slug="b-control"
          label="control: the same fenceless message when it is NOT the rest anchor — nothing is drawn"
          message={assistant("control", fencelessText)}
          reply="nice"
        />
      </main>
    </QueryClientProvider>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
