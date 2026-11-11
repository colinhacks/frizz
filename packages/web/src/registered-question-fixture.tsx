import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, RegisteredQuestionView, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import { ThreadView } from "./components/ChatView.tsx"
import { RegisteredAnswerSheet } from "./components/RegisteredAnswerSheet.tsx"
import { RegisteredAnsweringProvider } from "./components/RegisteredQuestionCards.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for a REGISTERED question in a thread — a question a worker created with the `ask`
// tool, which is a row rather than a fence in a message. It renders through the shared QuestionBlockCard
// (RegisteredQuestionCards.tsx), so what is worth looking at here is what a registration adds: the ×,
// the rich option BODY (full markdown inside the chip, visible before anything is picked — one option
// below writes the new multi-line `description`, the other the retired `preview`, and they must render
// the same), and the FOLLOW-UP tree that appears as the root is answered.
//
//   ?tree=1     — a root whose "Yes" carries two follow-ups. Pick A and watch them appear indented.
//   ?danger=1   — the destructive gate: `risk` tone, and NO × (declining is an option INSIDE it).
//   ?many=1     — three open questions at once, which is what the ONE shared "Send answers" is for.
//   ?busy=1     — a question AND live background work, which is the case the memo calls out: the
//                 question expands and the waits must not compete with it for the one glance.
//   ?past=1     — the question was asked at an OLDER rest, the human replied past it without answering,
//                 and the worker's newest handoff still carries a LEGACY empty ```question qst_… marker
//                 (mid-prose placement is retired 2026-08-30). The window opens at the newest rest
//                 (hasEarlier), so the asking rest is above it. The marker must draw NOTHING, and the card
//                 must render ONCE.
//   ?table=1    — an option whose body carries a TABLE, a blockquote and a code fence: the blocks whose
//                 opaque panel fills clashed with a selected chip's accent tint (screenshot 2026-09-02).
//   ?wide=1     — a `multi` over THIRTY options: no count cap (2026-09-03), and lettering past Z into AA.
//   ?placed=1   — PER-QUESTION PLACEMENT (2026-09-11): two questions open at one rest; the handoff carries
//                 an empty ```question qst_… marker for ONE of them, mid-prose. That card must render in
//                 the marker's slot, its sibling at the tail, and ONE "Send answers" at the tail must send
//                 both — the marker's card carries no Send of its own.
//   ?font=sans  — the other of the two fonts this app renders in; mono is the default and the wider.
//
// THE QUESTION FENCE (2026-10-13) — a thread dispatched after QUESTION_FENCE_RETIRED_AT asks by writing a
// structured ```question fence whose `id:` the server registers as a row (shared question-fence.ts). The
// row carries the worker's id as its `handle`, and the fence's slot is where its card draws:
//   ?fence=placed   — the handoff asks with a fence (a table under `---`, and a `when:` follow-up fence),
//                     quotes the grammar in a ````md sample, and keeps a legacy qst_ marker for an older
//                     row. The fenced card draws ONCE, answerable, in its slot, context under the question;
//                     the follow-up fence draws nothing; the quoted sample stays a code block.
//   ?fence=pending  — the same handoff a beat before the server registered it: the card draws READ-ONLY
//                     from the fence. Add &land=<ms> and the row lands then, swapping in the live card.
//   ?fence=claimed  — asked at an older rest, replied past, then a later rest writes `id: settings-store`
//                     alone: the card leaves the asking prose and draws in the reference's slot.
//   ?fence=settled  — the same question answered: the settled card, greyed, in the fence's slot — and
//                     under it a `multi` asked by fence and answered, whose settled card keeps the
//                     kind its live card wore ("Select multiple").
//   ?fence=sheet    — the PHONE's answering sheet on the fenced question (open it at a phone width): the
//                     context draws under the question there too.
//
// It draws the thread view every surface draws (ChatView). It drew the queue card by default, and the
// thread view under ?view=thread, until the card went (2026-11-10).
const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = params.get("font") === "sans" ? "sans" : "mono"
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString()

const SETTINGS: RegisteredQuestionView = {
  id: "qst_0001aaaa",
  askedAt: ago(6),
  spec: {
    question: "Where should the settings store live?",
    kind: "question",
    options: [
      {
        label: "SQLite",
        // The NEW shape: a multi-line description IS the option's body — full markdown, inside the
        // chip, visible before anything is picked.
        description: "Transactional, and it is where sessions already live.\n\n```sql\nCREATE TABLE setting (\n  key   TEXT PRIMARY KEY,\n  value TEXT NOT NULL\n);\n```\n\nMigrates with the rest of the schema; one more table in `ui.db`.",
        recommended: true,
      },
      {
        label: "A JSON file",
        description: "zero dependencies and hand-editable, but racy under concurrent writes",
        // The RETIRED shape, still carried by stored rows: folds into the same always-visible body
        // under the one-line trade-off, never behind a pick.
        preview: "```json\n{ \"theme\": \"dark\", \"font\": \"mono\" }\n```\nOne file at `~/.frizz/settings.json`. Two servers writing it at once is the failure mode.",
      },
    ],
  },
}

const TREE: RegisteredQuestionView = {
  id: "qst_0002bbbb",
  askedAt: ago(3),
  spec: {
    question: "The parser refactor is green on every gate. Land it on `main`?",
    kind: "question",
    options: [
      {
        label: "Land it",
        description: "the three CI legs are green and the diff is reviewed",
        recommended: true,
        followUps: [
          { question: "Tag a release at the same time?", kind: "question", options: [{ label: "Tag 0.9.0" }, { label: "Leave it unreleased" }] },
          { question: "Anything the release notes must say?", kind: "question" },
        ],
      },
      { label: "Hold it", description: "something about it still reads wrong", followUps: [{ question: "What is blocking it?", kind: "question" }] },
    ],
  },
}

const GATE: RegisteredQuestionView = {
  id: "qst_0003cccc",
  askedAt: ago(1),
  spec: {
    question: "`main` has three commits the remote does not. Force-push over them?",
    kind: "question",
    danger: true,
    options: [
      { label: "Force-push", description: "the three commits are the rebase of the same work — they are not lost" },
      { label: "Stop and leave the remote alone", recommended: true, description: "somebody else may have pulled them" },
    ],
  },
}

const GATES: RegisteredQuestionView = {
  id: "qst_0004dddd",
  askedAt: ago(9),
  spec: {
    question: "Which gates should run before every commit?",
    kind: "multi",
    // TWO recommended on a `multi`: the recommendation there is the set worth ticking, so each wears the badge.
    options: [{ label: "Typecheck", recommended: true }, { label: "Unit tests", recommended: true }, { label: "The browser e2e pass", description: "slow — about 90s" }],
  },
}

// A `multi` over a LONG list — thirty options, past the `.max(8)` the schema carried until 2026-09-03
// and past Z, so rows 27…30 are lettered AA…AD.
// What is worth looking at is that the run stays one even column and the free-text row still follows
// the last option.
const WIDE: RegisteredQuestionView = {
  id: "qst_0006ffff",
  askedAt: ago(4),
  spec: {
    question: "The audit turned up thirty findings. Which of them should be fixed on this thread?",
    kind: "multi",
    options: Array.from({ length: 30 }, (_, i) => ({
      label: `Finding ${i + 1}`,
      ...(i % 7 === 3 ? { description: "a one-line trade-off, so the row wraps the way a real one does" } : {}),
    })),
  },
}

// An option body carrying every BLOCK the prose surface renders — a table above all, which is the case
// that broke inside a SELECTED chip (the accent tint behind opaque panel fills; screenshot 2026-09-02).
const TABLE: RegisteredQuestionView = {
  id: "qst_0005eeee",
  askedAt: ago(2),
  spec: {
    question: "The skip warning fires on packages that were already built. How should it resolve?",
    kind: "question",
    options: [
      {
        label: "Leave it — the warning is annoying but the gate stays strict",
        description: "Nothing changes; the warning keeps firing on every `nub add` until the lockfile is re-checked.",
      },
      {
        label: "Fix it — judge the wait per package",
        recommended: true,
        description: [
          "Kills the false warning, but a curated package would start building in a case where it is currently skipped — a real loosening of the supply-chain gate.",
          "",
          "Today a package qualifies for the curated build allowlist only if the graph as a whole came from an already-checked lockfile. Adding any new dependency makes that false for **every** package in the tree.",
          "",
          "Effect on `nub add esbuild`-style flows:",
          "",
          "| today | after |",
          "| --- | --- |",
          "| `WARN ignored build scripts for esbuild@0.24.0` | no warning; esbuild stays trusted |",
          "| already-built packages keep working | same |",
          "| a curated package is skipped after any add | a curated package may now build after an add |",
          "",
          "> The gate's criteria are unchanged; only the unit of judgment moves.",
          "",
          "```ts",
          "const trusted = lockfileChecked(pkg.version) // per package, not per graph",
          "```",
        ].join("\n"),
      },
    ],
  },
}

// ---- THE QUESTION FENCE ----
const fenceMode = params.get("fence")
const FENCED: RegisteredQuestionView = {
  id: "qst_f3nc3d0001",
  askedAt: ago(1),
  spec: {
    handle: "settings-store",
    question: "Should the settings store use SQLite or a JSON file?",
    kind: "question",
    options: [
      {
        label: "SQLite",
        description: "transactional, and one store to back up",
        recommended: true,
        followUps: [{ handle: "sqlite-path", question: "Where should the database file live?", kind: "question", options: [{ label: "Beside the sessions database" }, { label: "In the project's `.frizz/`" }] }],
      },
      { label: "JSON file", description: "no dependency, hand-editable" },
    ],
    context: [
      "Settings are read on every request and written by the server and by every worker's `frizzctl` calls.",
      "",
      "| Store | Survives a crash mid-write | Concurrent writers |",
      "|---|---|---|",
      "| SQLite | yes | safe |",
      "| JSON file | no | last write wins |",
      "",
      "> [!NOTE]",
      "> Either one migrates later; SQLite is the one that is hard to leave once there is data in it.",
    ].join("\n"),
  },
}
// ?fence=settled's second card: a `multi`, asked by fence in the same handoff and answered.
const FENCED_GATES: RegisteredQuestionView = { ...GATES, id: "qst_f3nc3d0002", askedAt: ago(1), spec: { ...GATES.spec, handle: "commit-gates" } }
const GATES_ASK = ["```question", "id: commit-gates", "kind: multi", `question: ${GATES.spec.question}`, "options:", "  - label: Typecheck", "    recommended: true", "  - label: Unit tests", "    recommended: true", "  - label: The browser e2e pass", "    description: slow — about 90s", "```"].join("\n")
const SETTLED_GATES = { ...FENCED_GATES, settledAt: ago(0.5), answer: { questionId: FENCED_GATES.id, question: GATES.spec.question, chosen: ["Typecheck", "Unit tests"] } }
const FENCE_ASK = [
  "```question",
  "id: settings-store",
  "kind: choice",
  "question: Should the settings store use SQLite or a JSON file?",
  "options:",
  "  - label: SQLite",
  "    description: transactional, and one store to back up",
  "    recommended: true",
  "  - label: JSON file",
  "    description: no dependency, hand-editable",
  "---",
  FENCED.spec.context,
  "```",
  "",
  "```question",
  "id: sqlite-path",
  "kind: choice",
  "when: settings-store = SQLite",
  "question: Where should the database file live?",
  "options:",
  "  - Beside the sessions database",
  "  - In the project's `.frizz/`",
  "```",
].join("\n")
const QUOTED_SAMPLE = "For the record, a reference is the id alone:\n\n````md\n```question\nid: settings-store\n```\n````"
const fenceHandoff = `**Done** — the store's interface is in and \`c6c292e8\` is on local \`main\`.\n\nOne call is yours, because it is the one thing here that is hard to reverse:\n\n${FENCE_ASK}\n\nEither way the rest of the work is the same.${fenceMode === "settled" ? `\n\nThe gates are a separate call:\n\n${GATES_ASK}` : ""}${fenceMode === "placed" ? `\n\n${QUOTED_SAMPLE}\n\nThe older gates card still stands:\n\n\`\`\`question ${GATES.id}\n\`\`\`` : ""}`
const fenceRef = "Docs are in, and the migration is written against both stores.\n\nThe store is still the one thing I need from you:\n\n```question\nid: settings-store\n```\n\nOnce it is picked the migration lands in one commit."
const SETTLED_FENCED = { ...FENCED, settledAt: ago(0.5), answer: { questionId: FENCED.id, question: FENCED.spec.question, chosen: ["SQLite"], followUps: [{ questionId: FENCED.id, question: "Where should the database file live?", chosen: ["Beside the sessions database"] }] } }
const landMs = Number(params.get("land") ?? "")

const placed = params.get("placed") === "1"
const questions = fenceMode === "placed" ? [{ ...GATES, askedAt: ago(1) }, FENCED]
  : fenceMode === "pending" || fenceMode === "settled" ? []
  : fenceMode === "claimed" ? [{ ...FENCED, askedAt: ago(10) }]
  : fenceMode === "sheet" ? [FENCED]
  : params.get("danger") === "1" ? [GATE]
  : placed ? [SETTINGS, GATES]
  : params.get("wide") === "1" ? [WIDE]
  : params.get("tree") === "1" ? [TREE]
  : params.get("many") === "1" ? [SETTINGS, TREE, GATES]
  : params.get("table") === "1" ? [TABLE]
  : [SETTINGS]

const tail = "Both stores work. The choice is yours because it is the one thing here that is hard to reverse once there is data in it."
const past = params.get("past") === "1"
const marker = `**Fixed** — nothing further to do on the store: \`c6c292e8\` is on local \`main\`.\n\nThe one card still on the board is yours to decide, and it is the reason this thread does not file itself away as done:\n\n\`\`\`question ${SETTINGS.id}\n\`\`\`\n\nAnswer it either way and this thread is finished.`
const placedHandoff = `**Fixed** — the store is in and \`c6c292e8\` is on local \`main\`.\n\nOne call is yours, because it is the one thing here that is hard to reverse once there is data in it:\n\n\`\`\`question ${SETTINGS.id}\n\`\`\`\n\nEither store passes every gate today. The gates themselves are the other open card, below.`
const say = (role: "user" | "assistant", at: string, text: string) => ({ role, at, text, tools: [], parts: [{ kind: "text" as const, text }] })
const messages: TranscriptMessage[] = fenceMode === "claimed"
  ? [
      say("user", ago(12), "Add a settings store."),
      say("assistant", ago(10), fenceHandoff),
      say("user", ago(8), "Do the docs first, I'll get to the store."),
      say("assistant", ago(1), fenceRef),
    ]
  : fenceMode
  ? [say("user", ago(12), "Add a settings store."), say("assistant", ago(1), fenceHandoff)]
  : placed
  ? [
      { role: "user", at: ago(12), text: "Add a settings store.", tools: [], parts: [{ kind: "text", text: "Add a settings store." }] },
      { role: "assistant", at: ago(1), text: placedHandoff, tools: [], parts: [{ kind: "text", text: placedHandoff }] },
    ]
  : past
  ? [
      // The window opens at the human's reply; the rest the question was asked at is above it.
      { role: "user", at: ago(2), text: "Well done, you did it.", tools: [], parts: [{ kind: "text", text: "Well done, you did it." }] },
      { role: "assistant", at: ago(1), text: marker, tools: [], parts: [{ kind: "text", text: marker }] },
    ]
  : [
      { role: "user", text: "Add a settings store.", tools: [], parts: [{ kind: "text", text: "Add a settings store." }] },
      { role: "assistant", text: tail, tools: [], parts: [{ kind: "text", text: tail }] },
    ]

const thread = {
  id: "registered-question-demo",
  title: "Add a settings store",
  status: "active",
  mechanism: null,
  humanBlocked: false,
  // A registered question is a hard queue member — deriveNeedsYou returns true on any open row.
  needsYou: true,
  awaitingBackground: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "turn-idle",
  sessionId: "aaaaaaaa-bbbb-cccc-dddd-000000000009",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  questions,
  kind: "session",
  foreign: false,
  backend: "claude",
  permissionMode: "default",
  subAgents: params.get("busy") === "1"
    ? [{ id: "agent-a", label: "Audit the parser for edge cases", subagentType: "frizz:high", startedAt: ago(4), state: "running" }]
    : [],
  bgShells: params.get("busy") === "1"
    ? [{ id: "toolu_ci", taskId: "bzvtnt3ig", label: "gh run watch 1842", startedAt: ago(6), state: "running" }]
    : [],
  watches: params.get("busy") === "1"
    ? [{ id: "wch_aaa", kind: "shell", target: "bzvtnt3ig", state: "armed", createdAt: ago(6) }]
    : [],
  lastActivityAt: ago(1),
  // A fence thread is one dispatched after the free-form fence was retired (QUESTION_FENCE_RETIRED_AT).
  ...(fenceMode ? { spawnedAt: "2026-10-13T09:00:00Z", pendingQuestion: false } : {}),
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot
// ?fence=pending&land=<ms>: the server registers the fence's row a beat after the transcript has it.
if (fenceMode === "pending" && Number.isFinite(landMs) && landMs > 0) {
  setTimeout(() => {
    store.board = { projectDir: "/fixture/frizz", threads: [{ ...thread, questions: [FENCED] }] } as BoardSnapshot
  }, landMs)
}

const transcriptPage = { messages, transcriptKey: "fixture-key", hasEarlier: past, historyLoaded: false }
const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/_frizz/rpc/threadTranscript" || url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    return new Response(JSON.stringify({ result: transcriptPage }), { headers: { "content-type": "application/json" } })
  }
  // The writes the card makes, echoed onto the window so a probe can assert the exact payload the
  // worker would receive — above all that an answer RESTATES the question and carries the option's own
  // label rather than the lettered chip text. Since 2026-10-11 the answers leave through the prompt
  // box's Send, on `followUp` (with whatever was typed there); `answerQuestions` is the send of a
  // surface with no prompt box, and stays stubbed for it.
  if (url.pathname === "/_frizz/rpc/followUp") {
    const body = JSON.parse(String(init?.body ?? "{}"))
    window.dispatchEvent(new CustomEvent("fixture-rpc", { detail: { rpc: "followUp", body } }))
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname === "/_frizz/rpc/answerQuestions" || url.pathname === "/_frizz/rpc/dismissQuestions") {
    const body = JSON.parse(String(init?.body ?? "{}"))
    window.dispatchEvent(new CustomEvent("fixture-rpc", { detail: { rpc: url.pathname.split("/").pop(), body } }))
    const ids: string[] = body.ids ?? (body.answers ?? []).map((a: { questionId: string }) => a.questionId)
    return new Response(JSON.stringify({ result: { answered: ids, dismissed: ids, open: [] } }), { headers: { "content-type": "application/json" } })
  }
  // ?fence=settled: the thread's answered questions, read beside its transcript.
  if (url.pathname === "/_frizz/rpc/threadSettledQuestions") {
    return new Response(JSON.stringify({ result: { questions: fenceMode === "settled" ? [SETTLED_FENCED, SETTLED_GATES] : [] } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      {fenceMode === "sheet" ? (
        <RegisteredAnsweringProvider thread={thread}>
          <RegisteredAnswerSheet questions={[FENCED]} onClose={() => {}} />
        </RegisteredAnsweringProvider>
      ) : (
        // A <main>, as the pane's column is: the panels that open off the prompt box take it as their boundary.
        <main className="mx-auto h-screen w-[min(760px,100%)]">
          <ThreadView slug={thread.id} />
        </main>
      )}
    </TooltipProvider>
  </QueryClientProvider>,
)
