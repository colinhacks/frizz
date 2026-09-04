import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { formatGithubWakeSteer, limitModelSwitchSteer, limitResumeSteer, parkExpiredWakeMessage, parkFinishedWakeMessage, PR_WATCH_ARMED_TRAILER, prWatchExpiredWakeMessage, prWatchWakeMessage, questionsCancelledWakeMessage, shellDoneMessage, timerPromptMessage } from "@frizz/shared"
import type { ChatMessage } from "./hooks.ts"
import { Message } from "./components/ChatView.tsx"
import "./styles.css"

// EVERY WAKE FRIZZ DELIVERS, in one transcript, so the family can be judged as a family — which is the
// only way the defect this page was built for is visible at all. Review activity had rendered as a
// hairline since the notification card died; a PR reaching a terminal state, CI reaching a verdict, and a
// background shell finishing behind a resting worker had not, and arrived as full-width bordered cards
// stacked under those hairlines (maintainer 2026-08-18: "these callouts should obviously be hairlines",
// and 2026-08-19 on extending it to the rest).
//
// Every text here is composed by the REAL formatter the scheduler calls — never a hand-written string —
// so this page cannot pass while the shipped wording drifts out from under the parsers.
//
// `?font=sans|mono` sets `data-font`. The prose font is a user setting applied before first paint, and a
// fixture that does not set it silently renders the mono default — which is how a glyph fitted here once
// rode visibly high in the maintainer's sans window.
const font = new URLSearchParams(location.search).get("font")
if (font === "sans" || font === "mono") document.documentElement.dataset.font = font

// No `wakeSteer` is served on any of these. That is the real wire state for a status wake (the server's
// steer parser reads line 0, so a status line above one means no served field) and it exercises the
// client's own fallback parse, which is the only parser the combined case has.
// Every wake carries a DELIVERY instant, spread down the page so the ages on the tails read as a
// sequence (`3h ago` … `2m ago`) rather than one repeated value — the real transcript's shape, and the
// only way to see that the family's ages line up with one another and with the two that keep an instant
// of their own (a review item dates by GitHub's clock, a timer by its own fire time).
let deliveries = 0
const wake = (sourceId: string, text: string): ChatMessage => ({ sourceId, role: "user", wake: true, text, tools: [], parts: [], at: new Date(Date.now() - (200 - deliveries++ * 9) * 60_000).toISOString() })

const review = formatGithubWakeSteer({
  ref: "nubjs/nub#756",
  omitted: 0,
  items: [{ label: "comment", actor: "colinhacks", bot: false, at: new Date(Date.now() - 26 * 3_600_000).toISOString(), url: "https://github.com/nubjs/nub/pull/756#issuecomment-5120099362" }],
})

const messages: ChatMessage[] = [
  wake("w1", review),
  wake("w2", prWatchWakeMessage({ target: "nubjs/nub#760", closed: true })),
  wake("w3", prWatchWakeMessage({ target: "nubjs/nub#756", merged: true })),
  wake("w4", prWatchWakeMessage({ target: "nubjs/nub#761", checks: { verdict: "passing", passed: 7, failed: 0, failing: [] } })),
  wake("w5", prWatchWakeMessage({ target: "nubjs/nub#761", checks: { verdict: "passing", passed: 1, failed: 0, failing: [] } })),
  wake("w6", prWatchWakeMessage({ target: "nubjs/nub#761", checks: { verdict: "failing", passed: 4, failed: 2, failing: ["build (windows-latest)", "test (macos-14)"] } })),
  wake("w7", prWatchWakeMessage({ target: "nubjs/nub#761", checks: { verdict: "failing", passed: 0, failed: 1, failing: [] } })),
  // Both parts in one delivery — one poll that saw CI flip AND a comment land. Two hairlines, not one.
  wake("w8", prWatchWakeMessage({
    target: "nubjs/nub#587",
    checks: { verdict: "failing", passed: 1, failed: 1, failing: ["typecheck"] },
    review: formatGithubWakeSteer({
      ref: "nubjs/nub#587",
      omitted: 0,
      items: [{ label: "review comment", actor: "pullfrog", bot: true, at: new Date(Date.now() - 9 * 60_000).toISOString(), url: "https://github.com/nubjs/nub/pull/587#pullrequestreview-4810252801" }],
    }),
  })),
  // A BACKGROUND SHELL that finished while nobody was awake to be told. It must be indistinguishable
  // from the divider the runtime-reported completion draws — same glyph, same words — because it is the
  // same event; the reporter differs, and that is not a thing the transcript should show.
  // THE CONTROL, and the whole reason this pair sits adjacent: the SAME shell completion as the line
  // below it, reported by the RUNTIME instead of by frizz — a `boundary: "wake"` event, drawn by
  // ChatView's own EventLine from the server's `backgroundWakeLabel`. The two must be pixel-identical.
  // Asserting that in a comment is how it silently stops being true; rendering them adjacent is how a
  // reader catches it.
  { sourceId: "ctl", role: "assistant", kind: "event", boundary: "wake", text: "Background task «the churn suite» finished", tools: [], parts: [], at: new Date(Date.now() - 119 * 60_000).toISOString() },
  wake("w9", shellDoneMessage({ taskId: "bzvtnt3ig", label: "the churn suite", status: "completed" })),
  wake("w10", shellDoneMessage({ taskId: "b52kqwc13", label: "vite --port 5199 --strictPort", status: "failed" })),
  wake("w11", shellDoneMessage({ label: "Running the focused tests", status: "killed" })),
  // QUESTIONS TAKEN AWAY RATHER THAN ANSWERED — the thread went autonomous while registrations were
  // still open, so they were cancelled wholesale and nobody is coming. It is the ONE wake on the
  // registered-question path frizz writes in its own voice, which is why it is here at all: its sibling,
  // the human's ANSWER, is written in the answers wire form and never reaches this component (it draws
  // as the human's own Answers card — see answers-card-fixture).
  wake("wq1", questionsCancelledWakeMessage(1)),
  wake("wq2", questionsCancelledWakeMessage(3)),
  // A USAGE WINDOW rolling over. The amber pause card it answers is the notable state and keeps its
  // card; this is one line saying the thread is going again.
  wake("w12", limitResumeSteer("weekly")),
  // …and the MODEL-SCOPED cap, which is answered the other way: nothing reset, so the line names the
  // model that ran out AND the one the thread now runs, because that second word is what the composer
  // selector beside it reads and this hairline is the only place the transcript says why it changed.
  wake("w12b", limitModelSwitchSteer("Fable 5", "Opus")),
  // THE ONE WAKE THAT KEEPS A BODY — click it. Its text is the worker's own, and a fired one-off's
  // registration is gone the instant it delivers, so this disclosure is the only rendering that text
  // ever gets. Two of them, because the second is the case a bare hairline would have destroyed.
  wake("w13", timerPromptMessage("Re-check the promoted artifact once the release job finishes.", new Date(Date.now() - 4 * 60_000).toISOString())),
  wake("w14", timerPromptMessage(
    "Re-read `.frizz/threads/cfcb00d9/plan.md` before continuing — it is the authoritative account of this effort.\n\nIf the churn suite is still red, bisect rather than re-run it.",
    new Date(Date.now() - 3 * 3_600_000).toISOString(),
  )),
  // THE PARK-INTEGRITY WAKES (scheduler SOURCE 12), which arrived as full bordered cards of agent
  // instructions until 2026-08-24 — "THE ONLY LINE KINDS NOW SUPPORTED", which tool to call, which fence
  // to write. Measured across every transcript on the maintainer's machine, they were 32 of the 73
  // deliveries still drawing that card. The expired one keeps a disclosure because WHICH items are still
  // outstanding is the reader's half of the news; the instruction paragraph under it is not.
  wake("w16", parkExpiredWakeMessage(["- `shell: bkjf8exat` — still running", "- `pr: nubjs/nub#777` — CI running"])),
  wake("w17", parkFinishedWakeMessage(["- `agent: azf10ktb2` — finished"], false)),
  // NOTHING TO DISCLOSE is its own shape: a bare hairline, because a control that opens onto an empty
  // aside is worse than no control.
  wake("w18", parkExpiredWakeMessage([])),
  // A REGISTERED WATCHER whose own `for:` ran out. The ref is the only thing on the line a reader can
  // act on, so it is the link.
  wake("w19", prWatchExpiredWakeMessage("nubjs/nub#777")),
  // THE PR ITSELF MOVING — a conflict, a label, a reviewer requested. Same watcher and the same class of
  // event as the two hairlines above, and the clauses of one poll stay on ONE line: a label edit must
  // not be given the weight of a red build.
  wake("w20", prWatchWakeMessage({ target: "nubjs/nub#879", changes: ["now CONFLICTS with the base branch"] })),
  wake("w21", prWatchWakeMessage({ target: "nodejs/node#65796", changes: ["labels +blocked, −needs-ci", "review requested from richardlau"] })),
  // The FALLBACK still has to work: a wake this build cannot read keeps its first-party card and loses
  // no text. Nothing frizz composes lands here any more, so this is a legacy transcript or a format a
  // future frizz writes and this build has never seen.
  wake("w15", "⏰ Frizz has invented a wake shape this build predates.\n\n(And whatever it says, the text must survive — the card is what guarantees that.)"),
  // …AND ITS BODY IS STILL NOT ALLOWED TO CARRY FRIZZ'S TRAILER. This is the leak, reproduced: the
  // fallback is reached exactly when a tab is a build behind the wake it was sent, and a tab is a build
  // behind whenever frizz restarts under it — so this is the ONE branch where the agent-facing
  // parenthetical ever reached an operator, and it did, an hour after the PR-state line shipped
  // (maintainer 2026-09-04: "why am I still seeing shit like this? This should just never show up").
  // The card below must show the sentence and NOT the trailer under it.
  wake("w15b", `⏰ Frizz has invented a wake shape this build predates.\n\n${PR_WATCH_ARMED_TRAILER}`),
]

function Fixture() {
  return (
    <main className="min-h-screen bg-bg p-4 sm:p-8">
      <section className="mx-auto flex max-w-[760px] flex-col border border-border bg-panel px-5 py-4 shadow-xl shadow-black/30 sm:px-7">
        <header className="border-b border-border pb-3">
          <h1 className="text-[16px] font-semibold text-fg">Frizz wakes — every shape frizz speaks in</h1>
          <p className="mt-0.5 text-[12px] text-muted">Review activity, a finished PR, a CI verdict, both at once, the PR&rsquo;s own state moving, a background shell, a usage window, a fired timer, a park that ran out or finished, a lapsed watcher — and the unparsed fallback, with and without frizz&rsquo;s agent-facing trailer.</p>
        </header>
        <div className="flex flex-1 flex-col gap-3.5 py-5">
          {messages.map((message) => <Message key={message.sourceId} m={message} />)}
        </div>
      </section>
    </main>
  )
}

// `Message` reaches for react-query (the tool cards' lazy detail fetches), so the fixture supplies a
// client the way every other transcript fixture does — without it the page throws and renders nothing.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <Fixture />
  </QueryClientProvider>,
)
