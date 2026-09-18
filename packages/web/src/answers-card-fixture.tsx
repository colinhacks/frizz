import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { questionAnswerMessage, type TranscriptMessage } from "@frizz/shared"
import { Message } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import "./styles.css"

// Isolated view of the AnswersCard — the card the queue/thread renders when the last user message is
// a multi-answer reply to a ```question ("Answers:\n1. …\n2. …"). Used to tune its visual weight.
const paired = [
  { n: 1, answer: "Use the neutral chip treatment", question: "How should the answer chip read against the settled card?" },
  { n: 2, answer: "Keep it quiet — reserve yellow for awaiting-you", question: "Where does the yellow accent belong?" },
]

const m = {
  sourceId: "u1",
  role: "user",
  text: "Answers:\n1. Use the neutral chip treatment\n2. Keep it quiet — reserve yellow for awaiting-you",
  tools: [],
  parts: [],
} as unknown as TranscriptMessage

// The BURIED-ask wire form — composeAnswerWire's self-describing shape, which quotes each question inline
// because the ask is no longer the last turn. It reaches the card through parseBuriedAnswersMessage (no
// `paired` prop here — the fixture deliberately exercises Message's own parse), where it used to fall
// through to a raw run-on bubble. `paired={null}` on the second copy forces that old bubble path, so the
// two renderings sit side by side.
const buried = {
  sourceId: "u2",
  role: "user",
  text:
    "Answers to earlier questions:\n" +
    "1. “Should the settings store use SQLite or a JSON file?” → A. SQLite\n" +
    "2. “Ready to create CONTRIBUTING.md with the draft above?” → B. Approve with edits — drop the badge row",
  tools: [],
  parts: [],
} as unknown as TranscriptMessage

// A REGISTERED question's answer, as the SERVER composes it (questionAnswerMessage). Same wire form as
// the buried one above and the same reader — but its questions can be a static TREE, so it is the one
// shape that carries follow-up rows, and a dismissed question rides along as a row of its own. Built
// from the composer rather than hand-typed: the whole defect this fixture now guards was the two drifting
// apart, and a hand-written copy here would drift with them.
const registered = {
  sourceId: "u3",
  role: "user",
  text: questionAnswerMessage([
    {
      questionId: "qst_a", question: "Should the settings store use SQLite or a JSON file?", chosen: ["SQLite"],
      followUps: [{ questionId: "qst_b", question: "Migrate the existing rows at boot?", chosen: ["Yes, at boot"] }],
    },
  ], [{ question: "What should the new importer flag be called?" }]),
  tools: [],
  parts: [],
} as unknown as TranscriptMessage

function Fixture() {
  return (
    <div className="mx-auto my-8 flex w-[min(560px,calc(100%-32px))] flex-col gap-6">
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-70">Answers card (thread width)</div>
        <div className="flex flex-col rounded-lg border border-border bg-panel p-4">
          <Message m={m} paired={paired} />
        </div>
      </div>
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-70">Answers card (dense / queue width)</div>
        <div className="flex w-[380px] flex-col rounded-lg border border-border bg-panel p-4">
          <Message m={m} paired={paired} dense />
        </div>
      </div>
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-70">Buried-ask answers (thread width)</div>
        <div className="flex flex-col rounded-lg border border-border bg-panel p-4">
          <Message m={buried} />
        </div>
      </div>
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-70">Registered-question answers, with a follow-up and a dismissal</div>
        <div className="flex flex-col rounded-lg border border-border bg-panel p-4">
          <Message m={registered} />
        </div>
      </div>
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-70">…the same one IN FLIGHT (the seconds before the worker has it)</div>
        <div className="flex flex-col rounded-lg border border-border bg-panel p-4">
          <Message m={{ ...registered, queued: true } as unknown as TranscriptMessage} />
        </div>
      </div>
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-70">Buried-ask answers (dense / queue width)</div>
        <div className="flex w-[380px] flex-col rounded-lg border border-border bg-panel p-4">
          <Message m={buried} dense />
        </div>
      </div>
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-70">Before — the same text as a raw bubble</div>
        <div className="flex flex-col rounded-lg border border-border bg-panel p-4">
          <Message m={buried} paired={null} />
        </div>
      </div>
    </div>
  )
}

// `Message` reaches react-query today (a descendant runs a mutation), so the fixture needs a client or
// it throws "No QueryClient set" and renders NOTHING — which is what it had started doing. Nothing here
// hits the network; the provider only has to exist.
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </QueryClientProvider>,
)
