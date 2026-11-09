import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { COMMAND_WATCH_FALLBACK, MONITOR_FLOOD_REASON, MONITOR_STOPPED_BY_HUMAN_REASON, monitorCancelledWakeMessage, monitorEventWakeMessage, monitorExitedWakeMessage, monitorExpiredWakeMessage, commandWatchCancelledWakeMessage, commandWatchExpiredWakeMessage, commandWatchPassedWakeMessage, formatGithubWakeSteer, interruptEndedSubAgentsMessage, limitModelSwitchSteer, limitResumeSteer, mergedWakeMessage, ownWatchExpiredWakeMessage, parkExpiredWakeMessage, parkFinishedWakeMessage, PR_WATCH_ARMED_TRAILER, prWatchExpiredWakeMessage, prWatchGoneWakeMessage, prWatchWakeMessage, questionsCancelledWakeMessage, restPromptMessage, shellDoneMessage, timerPromptMessage } from "@frizz/shared"
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
// Recognized wakes use the scheduler's real formatters — the merged delivery included, which is several
// of them under one envelope and must draw exactly what they draw apart. Fallback samples cover text
// with no structured parser.
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

// THE MERGED DELIVERY — everything that was waiting for a thread, sent as one message. Composed by the
// scheduler's own `mergedWakeMessage`, with the reason lines it really writes, so what this page draws is
// what a transcript draws. The clock at its foot is left on: the server's display projection normally
// takes it off, and the split has to read the same either way.
const ciRed = prWatchWakeMessage({ target: "nubjs/nub#761", checks: { verdict: "failing", passed: 4, failed: 2, failing: ["build (windows-latest)", "test (macos-14)"] } })
const heldAt = Date.now() - 205 * 60_000
const merged = (...parts: [reason: string, message: string][]) =>
  mergedWakeMessage(parts.map(([reason, message]) => ({ reason, message })), heldAt, new Date(heldAt - 3 * 60_000).toISOString())

const messages: ChatMessage[] = [
  // THE PAIR THIS WAS REPORTED ON, and the commonest one there is: a park ending and the shell whose
  // exit ended it are one event, so they are always queued together. It drew a bordered card holding
  // both agent-facing bodies ("READ ITS OUTPUT AND CARRY ON…") under the scheduler's internal reason
  // strings, from the day the merge shipped until 2026-10-11. Two hairlines, at the pitch of any other
  // two — compare the lone pair `w17` and `w9` further down, which must read identically.
  wake("batched", merged(
    ["awaiting park named 1 dead item(s)", `${parkFinishedWakeMessage(["- `shells: [br6vpp762]` — FINISHED — its result is waiting for you"], false)}\n\nYou have NOTHING running right now — no shell, no sub-agent, no timer, no registered\npull request. There is nothing that could wake you, so this thread is not awaiting: finish in\n\`\`\`done, or ask the human in a \`\`\`question fence.`],
    ["background shell finished (br6vpp762)", shellDoneMessage({ taskId: "br6vpp762", label: "Running the update harness against the built shell and server", status: "completed" })],
  )),
  // EVERY ROUTE A LONE WAKE CAN TAKE, taken from inside one delivery: a CI verdict reported by two polls
  // and folded into one section, a fired timer whose own trailer is what its parser anchors on, and a
  // Goal prompt. Three hairlines — the repeated verdict is said once.
  //
  // THE GOAL IS LAST ON PURPOSE. Its parser matches a trailer at the END of the text, and a delivery
  // that ends in the Goal's prompt ends in that trailer too — so routed ahead of the split, this whole
  // delivery drew as the one line "Goal · at rest" and the two wakes above it were never shown.
  wake("batched-mixed", merged(
    ["pr-watch nubjs/nub#761 CI failing", ciRed],
    ["pr-watch nubjs/nub#761 CI failing", ciRed],
    ["one-off timer elapsed (2026-10-11T16:40:00.000Z)", timerPromptMessage("Re-check the promoted artifact once the release job finishes.", new Date(heldAt - 60_000).toISOString())],
    ["recurring prompt at rest", restPromptMessage("KEEP GOING.")],
  )),
  // …and a part this build cannot read keeps the fallback card FOR THAT PART ALONE: the wake beside it
  // is still a hairline, and the envelope around both is still not drawn.
  wake("batched-unread", merged(
    ["background shell finished (b52kqwc13)", shellDoneMessage({ taskId: "b52kqwc13", label: "vite --port 5199 --strictPort", status: "failed" })],
    ["a wake this build predates", "⏰ Frizz has invented a wake shape this build predates.\n\nIts text survives, in a card of its own."],
  )),
  wake("w1", review),
  wake("w2", prWatchWakeMessage({ target: "nubjs/nub#760", closed: true })),
  wake("w3", prWatchWakeMessage({ target: "nubjs/nub#756", merged: true })),
  wake("w4", prWatchWakeMessage({ target: "nubjs/nub#761", checks: { verdict: "passing", passed: 7, failed: 0, failing: [] } })),
  wake("w5", prWatchWakeMessage({ target: "nubjs/nub#761", checks: { verdict: "passing", passed: 1, failed: 0, failing: [] } })),
  wake("w6", prWatchWakeMessage({ target: "nubjs/nub#761", checks: { verdict: "failing", passed: 4, failed: 2, failing: ["build (windows-latest)", "test (macos-14)"] } })),
  wake("w7", prWatchWakeMessage({ target: "nubjs/nub#761", checks: { verdict: "failing", passed: 0, failed: 1, failing: [] } })),
  // The verdict naming its commit (2026-11-06), which every line above predates and still parses without.
  wake("w7c", prWatchWakeMessage({ target: "nubjs/nub#761", checks: { verdict: "failing", passed: 4, failed: 1, failing: ["lint"], head: "abc1234def5678" } })),
  wake("w7g", prWatchWakeMessage({ target: "nubjs/nub#761", checks: { verdict: "passing", passed: 29, failed: 0, failing: [], skipped: 3, head: "abc1234def5678" } })),
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
  // …and a watcher that settled because GitHub stopped resolving its PR: deleted, transferred, or out
  // of the `gh` login's sight. The same line with its own sentence.
  wake("w19a", prWatchGoneWakeMessage("nubjs/nub#777", "pull", 30)),
  // …and the same lapse on one of the worker's OWN waits, a `frizzctl watch` on a shell or a
  // sub-agent. It had no parser and was the other wake still drawing the verbatim card on 2026-10-11.
  wake("w19b", ownWatchExpiredWakeMessage("shell", "bzvtnt3ig")),
  wake("w19c", ownWatchExpiredWakeMessage("agent", "a01b2d20b32feab11")),
  // A COMMAND WATCH SETTLING, all three ways. It had no parser and drew the fallback card — its closing
  // instructions to the worker included — until 2026-10-14. Named by its command with the paths cut, as
  // the board's row names it; click one for the whole command and what its check printed.
  wake("w22", commandWatchPassedWakeMessage({ id: "cmw_3d480448ae89", command: "/Users/colin/.local/share/nub/node/26.11.1/bin/node /Users/colin/Documents/frizz/.frizz/threads/a74bbfc8/screen-unlocked.mjs", output: "newest: keywardd: screen unlocked", runs: 49, armedMs: 8_040_000 })),
  wake("w23", commandWatchExpiredWakeMessage({ id: "cmw_6197f27a1cb0", command: "npm view frizz-server@0.13.14 version", lastRun: { outcome: "exit", exitCode: 1, output: "npm error code E404\nnpm error 404 No match found for version 0.13.14" } })),
  wake("w24", commandWatchCancelledWakeMessage({ id: "cmw_a1b2c3d4e5f6", command: "gh run view 18273645 --exit-status", reason: `this thread runs in \`default\` permission mode. ${COMMAND_WATCH_FALLBACK}` })),
  // A MONITOR (`frizzctl watch-command add --persistent`, 2026-11-02): one hairline per EVENT, named by the worker's
  // description, the lines it printed behind the disclosure; then the three ways one ends. The last pair
  // went out MERGED — the script's final line and its exit, which the scheduler queues together — and
  // must draw exactly the two hairlines it would apart.
  wake("w27", monitorEventWakeMessage({ id: "cmw_0a1b2c3d4e5f", label: "errors in deploy.log", lines: ["ERROR 502 from upstream api.internal", "ERROR retry budget exhausted"], event: 3 })),
  wake("w28", monitorExitedWakeMessage({ id: "cmw_0a1b2c3d4e5f", label: "CI steps on nubjs/nub#879", command: "/Users/colin/.local/share/nub/node/26.11.1/bin/node /Users/colin/Documents/frizz/.frizz/threads/a74bbfc8/ci-steps.mjs 879", events: 6, run: { outcome: "exit", exitCode: 1, output: "gh: HTTP 502: Bad Gateway\n" } })),
  wake("w29", monitorExpiredWakeMessage({ id: "cmw_6197f27a1cb0", label: "new comments on acme/app#62", command: "node poll-comments.mjs acme/app#62", events: 0 })),
  wake("w30", monitorCancelledWakeMessage({ id: "cmw_a1b2c3d4e5f6", label: "errors in app.log", command: "tail -F /var/log/app.log", events: 30, reason: MONITOR_FLOOD_REASON })),
  // …and the human's own stop, from the monitor's drawer: "stopped by you", not "by Frizz".
  wake("w32", monitorCancelledWakeMessage({ id: "cmw_b2c3d4e5f6a1", label: "Failed jobs in jobs.ndjson", command: "tail -n0 -F jobs.ndjson | jq --unbuffered -c 'select(.state==\"failed\")'", events: 4, reason: MONITOR_STOPPED_BY_HUMAN_REASON, by: "human" })),
  wake("w31", mergedWakeMessage([
    { reason: "monitor cmw_0a1b2c3d4e5f event 7", message: monitorEventWakeMessage({ id: "cmw_0a1b2c3d4e5f", label: "CI steps on nubjs/nub#879", lines: ["test (macos-14): pass"], event: 7 }) },
    { reason: "monitor cmw_0a1b2c3d4e5f ended (exit 0) after 7 event(s)", message: monitorExitedWakeMessage({ id: "cmw_0a1b2c3d4e5f", label: "CI steps on nubjs/nub#879", command: "node ci-steps.mjs 879", events: 7, run: { outcome: "exit", exitCode: 0, output: "" } }) },
  ], Date.now())),
  // SUB-AGENTS AN INTERRUPT TOOK WITH IT — "Interrupt and send" ends every background child with the
  // turn. The same fallback card until 2026-10-14, telling the operator to re-dispatch them. One
  // hairline per child, the way each child's own completion is drawn.
  wake("w25", interruptEndedSubAgentsMessage([{ taskId: "abc9b9b5f0da4c677", label: "Audit the auth flow" }])),
  wake("w26", interruptEndedSubAgentsMessage([{ taskId: "a1", label: "Survey the dev server readouts" }, { taskId: "a2", label: "Fix the cache collision" }, { label: "Review the diff" }])),
  // THE PR ITSELF MOVING — a conflict, a label, a reviewer requested. Same watcher and the same class of
  // event as the two hairlines above, and the clauses of one poll stay on ONE line: a label edit must
  // not be given the weight of a red build.
  wake("w20", prWatchWakeMessage({ target: "nubjs/nub#879", changes: ["now CONFLICTS with the base branch"] })),
  wake("w21", prWatchWakeMessage({ target: "nodejs/node#65796", changes: ["labels +blocked, −needs-ci", "review requested from richardlau"] })),
  // The FALLBACK still has to work: a wake this build cannot read keeps its first-party card and loses
  // no prose.
  wake("w15", "⏰ Frizz has invented a wake shape this build predates.\n\n(And whatever it says, the text must survive — the card is what guarantees that.)"),
  // …and that prose is rendered as the Markdown it may be, SAFELY: a list, a link, a fenced block too
  // long for the card, and a script tag that must stay text. Whatever wake reaches this card is one no
  // parser vouched for, so it is the last place to trust what it carries.
  wake("md", `⏰ Frizz has invented a wake shape this build predates.

### What it carries

- \`shells: [bc3rwp1k7]\` — FINISHED — its result is waiting

Read the **finished** [report](https://example.com/report).

\`\`\`text
${"long-token-".repeat(35)}
\`\`\`

<script>window.__wakePwned = true</script>

${PR_WATCH_ARMED_TRAILER}`),
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
          <p className="mt-0.5 text-[12px] text-muted">Several wakes held and sent as one delivery, review activity, a finished PR, a CI verdict, both at once, the PR&rsquo;s own state moving, a background shell, a usage window, a fired timer, a park that ran out or finished, a lapsed watcher or watch, a command watch settling, sub-agents an interrupt stopped — and the unparsed fallback, with and without frizz&rsquo;s agent-facing trailer.</p>
        </header>
        <div className="flex flex-1 flex-col gap-3.5 py-5">
          {messages.map((message) => <Message key={message.sourceId} m={message} dense={new URLSearchParams(location.search).has("dense")} />)}
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
