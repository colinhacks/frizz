import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { nameQuestionAnswer, questionAnswerMessage, type AskedQuestion, type QuestionAnswer, type TranscriptMessage } from "@frizz/shared"
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
// shape that carries follow-up rows, and a dismissed question rides along as a row of its own — on the
// wire only; the card must NOT draw it (answersForDisplay). Built
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

// THE SAME ANSWER TO A QUESTION ASKED BY FENCE, whose rows carry the worker's own id on the wire
// (``N. `settings-store` “…” → …``, shared answerRowId). The id is the worker's vocabulary and the card
// does not draw it, so this card must be the one above it, pixel for pixel — which is what the fixture is
// for: `?ids=1` prints both wires under their cards so the difference is on the page and only there.
const fenceSpec: AskedQuestion = {
  handle: "settings-store", question: "Should the settings store use SQLite or a JSON file?", kind: "question",
  options: [
    { label: "SQLite", followUps: [{ handle: "migrate-at-boot", question: "Migrate the existing rows at boot?", kind: "question", options: [{ label: "Yes, at boot" }, { label: "No" }] }] },
    { label: "JSON file" },
  ],
}
const fenceAnswer: QuestionAnswer = {
  questionId: "qst_a", question: "Should the settings store use SQLite or a JSON file?", chosen: ["SQLite"],
  followUps: [{ questionId: "qst_b", question: "Migrate the existing rows at boot?", chosen: ["Yes, at boot"] }],
}
const fenceAsked = {
  sourceId: "u6",
  role: "user",
  text: questionAnswerMessage(
    [nameQuestionAnswer(fenceAnswer, fenceSpec, "settings-store")],
    [{ question: "What should the new importer flag be called?", handle: "importer-flag" }],
  ),
  tools: [],
  parts: [],
} as unknown as TranscriptMessage
const showWires = new URLSearchParams(location.search).has("ids")
const Wire = ({ text }: { text: string }) => showWires ? <pre data-wire className="mt-2 whitespace-pre-wrap text-[11px] leading-snug text-muted">{text}</pre> : null

// A registered question that SPANS LINES — a procedure ending in a public key on its own line, restated
// verbatim on the wire (2026-09-23). The row runs five lines; it has to reach this card, not the raw
// bubble the single-line row pattern used to drop it into.
const multiline = {
  sourceId: "u4",
  role: "user",
  text: questionAnswerMessage([{
    questionId: "qst_c",
    question: "Keyward now holds its own key in this Mac's Secure Enclave. Add it to GitHub: open https://github.com/settings/keys, click New SSH key, paste this line, click Add SSH key:\n\n`ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTYAAAAIbmlzdHAyNTYAAABBBH/idBwmDYVRkXSw6FEJUI9fXiSQ3/v/aWLfBuRPf2giAdnyxd4AEtQxhpkLgY+Nsgj5wTI0FcBFGsPTmUXVLm4= colinhacks@keyward`\n\nIs the key added?",
    chosen: ["Yes, added"],
  }]),
  tools: [],
  parts: [],
} as unknown as TranscriptMessage

// A MULTI-SELECT with a note — five long picks and a typed paragraph, the 2026-10-08 report verbatim.
// One comma-joined chip used to carry all of it; each pick is its own checked chip now, the note under them.
const multiSelect = {
  sourceId: "u5",
  role: "user",
  text: questionAnswerMessage([{
    questionId: "qst_d",
    question: "Which agent actions should run now? (The ready ones need nothing from the maintainer; the sign-in ones need one browser approval on this Mac first, and that new login is revoked again when the job is done.)",
    chosen: ["A9 Neon DB password (ready)", "A10–A13 + A16 key rotations (ready)", "Google Cloud jobs (needs gcloud sign-in)", "GitHub jobs (needs gh sign-in)", "Cloudflare jobs (needs wrangler sign-in)"],
    text: "Alright, sounds good. Let's uh do it all but let's be very deliberate about it and go through piece by piece. Obviously do everything possible to minimize downtime.",
  }]),
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
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-70">Answers card (narrow)</div>
        <div className="flex w-[380px] flex-col rounded-lg border border-border bg-panel p-4">
          <Message m={m} paired={paired} />
        </div>
      </div>
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-70">Buried-ask answers (thread width)</div>
        <div className="flex flex-col rounded-lg border border-border bg-panel p-4">
          <Message m={buried} />
        </div>
      </div>
      <div data-fixture="registered">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-70">Registered-question answers, with a follow-up and a dismissal</div>
        <div className="flex flex-col rounded-lg border border-border bg-panel p-4">
          <Message m={registered} />
        </div>
        <Wire text={registered.text} />
      </div>
      <div data-fixture="fence-asked">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-70">…the same answers to questions asked by fence (ids on the wire)</div>
        <div className="flex flex-col rounded-lg border border-border bg-panel p-4">
          <Message m={fenceAsked} />
        </div>
        <Wire text={fenceAsked.text} />
      </div>
      <div data-fixture="fence-asked-in-flight">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-70">…and that one IN FLIGHT</div>
        <div className="flex flex-col rounded-lg border border-border bg-panel p-4">
          <Message m={{ ...fenceAsked, queued: true } as unknown as TranscriptMessage} />
        </div>
      </div>
      <div data-fixture="multi-select">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-70">Multi-select answer with a note</div>
        <div className="flex flex-col rounded-lg border border-border bg-panel p-4">
          <Message m={multiSelect} />
        </div>
      </div>
      <div data-fixture="multi-select-narrow">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-70">Multi-select answer (narrow)</div>
        <div className="flex w-[380px] flex-col rounded-lg border border-border bg-panel p-4">
          <Message m={multiSelect} />
        </div>
      </div>
      <div data-fixture="multiline">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-70">Registered-question answer whose question spans lines</div>
        <div className="flex flex-col rounded-lg border border-border bg-panel p-4">
          <Message m={multiline} />
        </div>
      </div>
      <div data-fixture="registered-in-flight">
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-70">…the same one IN FLIGHT (the seconds before the worker has it)</div>
        <div className="flex flex-col rounded-lg border border-border bg-panel p-4">
          <Message m={{ ...registered, queued: true } as unknown as TranscriptMessage} />
        </div>
      </div>
      <div>
        <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-70">Buried-ask answers (narrow)</div>
        <div className="flex w-[380px] flex-col rounded-lg border border-border bg-panel p-4">
          <Message m={buried} />
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
