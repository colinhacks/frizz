import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { formatGithubWakeSteer, prWatchWakeMessage } from "@frizz/shared"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage, TranscriptToolCall } from "@frizz/shared"
import { TodosView } from "./components/TodosView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for the higher-level "intermediate logs collapse" in the queue card (QCard).
//
// ONE FOLD PER RUN. A run is [what re-invoked the agent → the prose it rested on]; the human's ask opens
// the first one, and every REST and every scheduler WAKE cuts a new one — so every message the agent
// rested on survives the fold, whether or not anything narrates what resumed it. Within a run the card
// shows the TEXT ONLY of its
// opening and closing messages, and everything else — the fully-hidden middles, the tool bands batched
// into those two, and any calls made after the closing prose — collapses behind that run's own HAIRLINE
// DIVIDER (the transcript's WakeDivider chrome: the stacked-chevron ChevronsUpDown glyph, the tool-call
// count, and "Click to expand"). So a card reads: pinned ask → narration → fold → where it landed →
// ⟨why it woke⟩ → narration → fold → where it landed → … Clicking is one-way and card-wide: every run's
// full log renders at once and all the dividers unmount.
//   ?variant=heavy   (default) a user ask + an opening narration (WITH batched tools) + several tool-heavy
//                    intermediate steps + a final question. First message's tools must fold into the divider.
//   ?variant=single  user ask + ONE assistant reply (no middle → NO collapse divider, control case)
//   ?variant=notools user ask + a couple of prose-only intermediate steps. NOTHING is counted (the step
//                    count was dropped), so this pins the zero-tool label: just "Click to expand".
//   ?variant=batchedends  user ask + first(narration + tools) + ONE middle step + final(summary text + a
//                         trailing tool). BOTH ends' tools fold into the divider; both texts show tool-free.
//   ?variant=questionthentool  user ask + narration + a FINAL question + a trailing TOOLS-ONLY message.
//                         Regression guard: the closing-text anchor stays on the question (chips stay live);
//                         the text-less tool message must NOT steal the anchor and hide the question. Its
//                         call folds into the run's divider — a segment spans its WHOLE run, so work done
//                         after the closing prose is that run's work.
//   ?variant=trailingevent  user ask + intermediate steps + a FINAL question, then a sub-agent completion
//                           event AFTER it. Regression guard: the question (with answer chips) must stay
//                           visible — a trailing event must NOT pull it into the collapsed range.
//   ?variant=bgshells  three background shells launched in three SEPARATE assistant records across the
//                      collapsed run (the real shape from thread `started-three-frizz-in-quick-succession`),
//                      one of them already finished. The finished one FOLDS IN like any other call
//                      (2026-08-12) — the card is a triage surface and it is history the fold carries. The
//                      two still running leave the transcript for the ops line over the prompt box, as
//                      they do in the thread view (2026-10-09).
//   ?variant=dispatches  two sub-agent dispatches inside the collapsed run, one still running (tracked in
//                      thread.subAgents) and one resolved. Same rule as background tasks: both fold in.
//   ?variant=codexpolls a codex long-poll run: ten unpaired `Wait`/`Poll process` cards (pending +
//                      `backgroundState: "unknown"`) around ONE real detached shell. The polls fold, and
//                      the still-running shell leaves for the ops line; the variant survives as the guard
//                      that 888 poll rows can never reach the card.
//   ?variant=buriedask  a ```question in the MIDDLE of the run, with tool work and a closing summary after
//                      it. Two guards at once: the ask is lifted OUT of the collapse (a decision the human
//                      owes is not disposable chatter), and its chips are LIVE even though a newer ask is
//                      not what the card is anchored on. Pre-fix the card offered "Send answers" with the
//                      question nowhere on screen.
//   ?variant=twoasks   two ```question messages stacked with work between them, neither answered. BOTH
//                      carry live chips — the queue card used to make only the most recent one answerable.
//   ?variant=humanpast an ask the human already replied PAST (a later user turn), then more agent work.
//                      Under "Load earlier messages" the old ask must still take chips; the card's own
//                      "Send answers" action stands down until one is filled (nothing stands at the tail).
//   ?variant=prwakes  THE SEGMENTED SHAPE: one ask, then three runs separated by two real PR-watcher wakes
//                     (served `wakeSteer`, so the real FrizzWake renders). Each run must get its OWN
//                     fold, each wake its own hairline BETWEEN the run it ended and the run it caused, and
//                     the third run — one prose message over four calls — must fold on its wake alone.
//   ?variant=stackedwakes THREE SUCCESSIVE HAIRLINES with nothing between them: the middle-runs fold, then
//                      ONE delivery that carries both a CI verdict and a review comment. The two parts of
//                      that delivery must stand exactly as far apart as the fold stands from the first of
//                      them — 22px of clear space, 40px pitch. They did not: a bare fragment handed the
//                      pair to the card's own spacer walk as two messages, which in a gap-less column
//                      left only the 8px their `my-1` margins draw (maintainer 2026-08-19: "inconsistent
//                      heights on three successive airlines").
//   ?variant=priorrest TWO turns — an ask, a rest, a background wake, then a second turn ending in a
//                      question and another rest. The window reaches back to the HUMAN's ask, so both
//                      turns render; neither "Agent rested" rule may be drawn at either end.
//   ?variant=loneanswer THE REGRESSION SHAPE (2026-09-02): a one-message first answer, rest-cut middle
//                      rounds, and a one-line final run — so NO kept run folds, and the middle's first
//                      index is a rest record. Both halves of that broke: the gate saw nothing to
//                      collapse, and the divider emission keyed on an index that never renders.
//   ?variant=goalwakes THE REGRESSION SHAPE (2026-08-16): a pointed question, the ANSWER, a rest, and two
//                      more turns driven by the GOAL's own bump. Every rested message must render in full
//                      — the answer above all — each run must get its own fold, and each bump must draw
//                      its "Goal · at rest" hairline directly under the message it resumed.
//   ?variant=donetail  THE BURIED HANDOFF (2026-09-02, pullfrog `if-you-were-going-to-migrate`): the
//                      worker writes its conclusive write-up and calls `mcp__frizz__done` in one breath —
//                      ONE projected message — then appends a short pointer note, which as the run's last
//                      prose anchored the fold's close and collapsed the conclusion by default. The
//                      done-carrying message must survive (textOnly, its call folded and counted), the
//                      divider must sit ABOVE it, and the registered done card must draw at the tail.
//   ?variant=pinnedtail THE PHANTOM RUN (2026-10-02, lando `we-ve-got-to-start-working`): two real runs,
//                      then the server's PINNED copy of a Monitor still `pending` from an earlier turn,
//                      appended after the final rest. Walked as a third run, it made the run the agent
//                      signed off in a MIDDLE run and folded the whole write-up behind "1 more round".
//                      The pin must belong to no run: no middle divider, the final write-up in full, and
//                      the pinned card still drawn at the foot.
//   ?variant=loneprose / loneproseafter  A RESUMED run whose ONE prose message both opens and closes it.
//                      It folds (segmentFolds), but no row after its opening prose ever reached the
//                      divider, so its calls vanished with nothing standing in for them. The divider must
//                      draw ABOVE the lone message when the work came first (`loneprose`), and BELOW it
//                      when the agent wrote and then worked (`loneproseafter`).
//   ?variant=foldedask THE QUESTION BEHIND THE FOLD (2026-10-15): five runs, and the worker asks with a
//                      registered ```question fence in the THIRD, keeps working, and is then woken twice by
//                      background tasks and rests without naming the question again. Its card stays at the
//                      rest it was asked at — a middle run — and the middle collapse used to swallow it
//                      whole, so the rail said [?] and nothing on the card showed the ask. The asking run
//                      must stay on screen with a "1 more round" line on each side of it.
//
// AND `?src=<url>` REPLAYS A REAL THREAD through the card, overriding the variant. Point it at a dump of
// the server's own `threadTranscript` reply and the card renders the actual bytes that produced a report,
// rather than a hand-built approximation of them:
//
//   curl -H 'Origin: http://127.0.0.1:9494' \
//     'http://127.0.0.1:9494/_frizz/<project>/rpc/threadTranscript?input={"slug":"<slug>"}' > /tmp/t.json
//   # serve /tmp/t.json from anywhere the fixture's origin can reach, then:
//   open '…/intermediate-collapse-fixture.html?src=http://127.0.0.1:8181/t.json'
//
// It accepts the RPC envelope (`{result:{messages}}`) or a bare `{messages}` / array, and runs before the
// fetch mock below so it uses the real `fetch`. A dump may also carry `thread` — board fields laid over
// the fixture's own thread, such as the `questions` still open and the `spawnedAt` that decides which
// question grammar it speaks — so a card queued on an open question replays with that question. This is how the 2026-08-16 collapse regression was
// confirmed fixed on the thread that reported it — a synthesized fixture cannot prove the server's own
// `boundary`/`wake` markers are the ones the walk keys on.
const params = new URLSearchParams(location.search)
const variant = params.get("variant") ?? "heavy"
const src = params.get("src")
const replay: { messages: TranscriptMessage[]; hasEarlier: boolean; thread?: Partial<ThreadViewModel> } | undefined = src
  ? await (async () => {
      const body = await (await fetch(src)).json()
      const page = body?.result ?? body
      return {
        messages: (page?.messages ?? page) as TranscriptMessage[],
        // A real dump is a WINDOW, and the card's "Load earlier messages" control is part of what the
        // replay is meant to reproduce.
        hasEarlier: page?.hasEarlier === true,
        thread: page?.thread,
      }
    })()
  : undefined

const SLUG = "intermediate-collapse-demo"

const tool = (name: string, over: Partial<TranscriptToolCall> = {}): TranscriptToolCall => ({
  name,
  status: "completed",
  ...over,
})

const asst = (text: string, tools: TranscriptToolCall[] = []): TranscriptMessage => ({
  role: "assistant",
  text,
  tools,
  parts: [
    ...(tools.length ? [{ kind: "tools" as const, tools }] : []),
    ...(text ? [{ kind: "text" as const, text }] : []),
  ],
})

const event = (text: string): TranscriptMessage => ({ role: "assistant", kind: "event", text, tools: [], parts: [] })

const boundaryEvent = (boundary: TranscriptMessage["boundary"], text: string): TranscriptMessage =>
  ({ role: "assistant", kind: "event", boundary, text, tools: [], parts: [] })

// A real ```question block so the queue card renders answer chips + the "Send answers" flow — this is
// what the trailing-event regression must not hide.
const finalQuestion = [
  "```question",
  "I've added the collapse divider. Which label reads best?",
  "",
  "- A. **`11 tool calls · Click to expand`** — names the scale and the affordance (recommended).",
  "- B. Just **`Click to expand`** — leaner, but the reader can't tell how much is hidden.",
  "```",
].join("\n")

let counter = 0
const withId = (m: TranscriptMessage): TranscriptMessage => ({ ...m, sourceId: `m${counter++}` })

const heavy: TranscriptMessage[] = [
  { sourceId: "u-old", role: "user", text: "An earlier ask from a previous turn.", tools: [], parts: [] },
  withId(asst("Done with that earlier one.")),
  { sourceId: "u-cur", role: "user", text: "Add a collapsed-by-default view for the intermediate agent logs in the queue card, and wire up a one-way expand.", tools: [], parts: [] },
  // --- intermediate run: several tool-heavy assistant steps + chatter ---
  withId(asst("Let me find the queue card renderer and understand how it windows the transcript.", [
    tool("Grep", { detail: "QCard|QueueCard|renderCard" }),
    tool("Read", { detail: "components/TodosView.tsx", read: "…740 lines…" }),
  ])),
  withId(asst("I'll check how tool-call collapsing works today so the new one is clearly higher-level.", [
    tool("Read", { detail: "components/ChatView.tsx" }),
    tool("Grep", { detail: "collapseTools|ToolCalls" }),
    tool("Bash", { detail: "npx tsc --noEmit", desc: "Typecheck the web package" }),
  ])),
  withId(asst("Now editing the render loop to inject the summary bar and gate it on the middle range.", [
    tool("Edit", { detail: "components/TodosView.tsx" }),
    tool("Edit", { detail: "components/TodosView.tsx" }),
    tool("Edit", { detail: "components/TodosView.tsx" }),
    tool("Bash", { detail: "npx tsc --noEmit", desc: "Re-typecheck after edits" }),
    tool("Bash", { detail: "nub --test packages/web/src/**/*.test.ts", desc: "Run web tests" }),
  ])),
  withId(asst("Verified the counts line up with what the loop skips (queued + render-nothing messages).", [
    tool("Read", { detail: "packages/shared/src/index.ts" }),
  ])),
  // --- final standing message (always shown in full) ---
  withId(asst(finalQuestion)),
]

// Same as heavy, but a sub-agent completion EVENT lands in the JSONL AFTER the final question — the
// exact sequence that (pre-fix) pulled the question into the collapsed range and disabled answering.
const trailingevent: TranscriptMessage[] = [
  ...heavy,
  withId(event('Agent "reviewer" finished — 5m')),
]

const single: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Quick one — what's the current default label?", tools: [], parts: [] },
  withId(asst("It's the `N tool calls · Click to expand` hairline. Nothing intermediate here, so no collapse divider should appear.")),
]

const notools: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Summarize the trade-offs before you build anything.", tools: [], parts: [] },
  withId(asst("First, the collapse is one-way by design, so we avoid re-collapse jank.")),
  withId(asst("Second, it keys off the pinned ask and the final message, so loaded-earlier history is untouched.")),
  withId(asst("So — proceed with the one-way collapse? That's my recommendation.")),
]

// Tools batched into BOTH the first and the last agent message. The final message is a normal summary
// (not a question) with a trailing tool call. After collapse: first + last show text only, and the
// divider counts every tool across the span (2 first + 2 middle + 1 last = 5). The one fully-hidden
// middle step is still hidden, it is simply no longer counted in the label.
const batchedends: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Rename the flag and update its callers.", tools: [], parts: [] },
  withId(asst("On it — let me locate the flag definition and every reader first.", [
    tool("Grep", { detail: "intermediateExpanded" }),
    tool("Read", { detail: "components/TodosView.tsx", read: "…820 lines…" }),
  ])),
  withId(asst("Found 3 call sites; applying the rename across them.", [
    tool("Edit", { detail: "components/TodosView.tsx" }),
    tool("Edit", { detail: "components/ChatView.tsx" }),
  ])),
  withId(asst("Done — renamed the flag and its 3 callers, and re-typechecked clean.", [
    tool("Bash", { detail: "npx tsc --noEmit", desc: "Typecheck after rename" }),
  ])),
]

// REGRESSION GUARD: the agent asks a ```question, THEN emits a TOOLS-ONLY message (text "") after it —
// e.g. it kept working past the ask. The closing-text anchor must stay on the QUESTION (not slide onto the
// text-less tool message), so its answer chips remain visible + interactive. The trailing call itself folds
// into the divider, because a segment spans its whole run. Pre-fix this hid the question and killed the
// answer flow.
const questionthentool: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Wire up the one-way expand and ask me about the label.", tools: [], parts: [] },
  withId(asst("Let me add the expand handler and draft the two label options.", [
    tool("Edit", { detail: "components/TodosView.tsx" }),
    tool("Bash", { detail: "npx tsc --noEmit", desc: "Typecheck" }),
  ])),
  withId(asst(finalQuestion)),
  // Tools-only follow-up (no prose) AFTER the question — must not become the standing message.
  withId(asst("", [tool("Read", { detail: "components/ChatView.tsx" })])),
]

// Background tasks are lifted OUT of the collapsed span and rendered for real — they are lifecycle
// state, not disposable chatter, and a detached process is the one class of call still going after the
// batch that started it (maintainer 2026-08-01: "It's important that those show up in the chat"). This
// run launches three from three SEPARATE assistant records with ordinary tool work in between — the
// exact shape the maintainer hit. On the queue card all three fold (2026-08-12, below); in the thread
// view the two LIVE ones keep their marked cards while the finished one folds into the run like any
// other settled call (2026-09-13: "Fold it once finished").
const bgShell = (desc: string, command: string, over: Partial<TranscriptToolCall> = {}) =>
  tool("Bash", { desc, detail: command, command, backgroundState: "background", status: "pending", ...over })

const bgshells: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Verify the relaunch path against a real server, cold and warm.", tools: [], parts: [] },
  withId(asst("Let me look at what the reuse path actually does today.", [
    tool("Grep", { detail: "existing server|reuse" }),
    tool("Read", { detail: "packages/server/src/project-launch.ts", read: "…410 lines…" }),
  ])),
  withId(asst("", [bgShell("Starting the first server in the sandbox", "nub run dev --port 5311")])),
  withId(asst("Server is up — driving the warm path now.", [
    tool("Bash", { detail: "curl -s localhost:5311/api/health", desc: "Checking the warm relaunch" }),
    tool("Edit", { detail: "packages/server/src/project-launch.ts" }),
  ])),
  withId(asst("", [bgShell("Capturing a genuine cold start panel", "nub run dev --fresh")])),
  // Already finished — in the thread view this one is history and folds into the run (its completion
  // wake divider is the record); the two above keep their cards because they are still going.
  withId(asst("", [bgShell("Waiting for the cold start to serve", "nub scripts/wait-for-serve.mjs 5312", { status: "completed", durationMs: 42_000 })])),
  withId(asst("Both paths verified live.", [tool("Bash", { detail: "nub --test", desc: "Running the server suite" })])),
  withId(asst("**Fixed** — a relaunch in a repo that already has a server now says so.")),
]

// The SAME rule for dispatches (maintainer 2026-08-01: "Same for sub-agent dispatches"). One child is
// still running — tracked in `thread.subAgents` below, which is what drives the pulsing accent mark —
// and one has resolved, so both dot states sit under the divider at once.
const LIVE_AGENT_ID = "agent-live-1"

const dispatches: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Audit the transcript renderer for dropped tool states, then fix what you find.", tools: [], parts: [] },
  withId(asst("Fanning out — one reader per surface, then I'll reconcile.", [
    tool("Grep", { detail: "ToolCardRouter|collapseTools" }),
  ])),
  withId(asst("", [tool("Agent", {
    detail: "Audit the queue card's collapse",
    prompt: "Read packages/web/src/components/TodosView.tsx and report every tool state the queue card can drop.",
    subagentType: "frizz:opus-high",
    agentId: LIVE_AGENT_ID,
  })])),
  withId(asst("While that runs, let me read the chat side myself.", [
    tool("Read", { detail: "packages/web/src/components/ChatView.tsx", read: "…4100 lines…" }),
    tool("Edit", { detail: "packages/web/src/lib/toolActivity.ts" }),
  ])),
  withId(asst("", [tool("Agent", {
    detail: "Cross-check the sub-agent drawer",
    prompt: "Read packages/web/src/components/SubAgentSheet.tsx and confirm it shares the parent's coalescing.",
    subagentType: "frizz:sonnet-medium",
    agentId: "agent-done-1",
    agentStatus: "completed",
    agentElapsedMs: 214_000,
  })])),
  withId(asst("Both readers agree with what I found in the renderer.", [
    tool("Bash", { detail: "nub --test", desc: "Running the web suite" }),
  ])),
  withId(asst("**Fixed** — every background lifecycle now keeps its own card.")),
]

// The codex LONG-POLL shape: a model babysitting a gate through `wait`/`write_stdin`, whose polls the
// projector could not pair with a launch, so each arrives pending + `backgroundState: "unknown"`. That
// state used to make every one of them a lifted-out card, and a real rollout produced 888 of them — a
// queue card that was nothing but `Wait · cell 30 · unknown` rows with runaway clocks (maintainer
// 2026-08-09). They are reads of somebody else's process, so they belong in the divider's count like any
// other call; the genuinely detached `run_in_background` shell below them still keeps its card.
const orphanPoll = (name: string, detail: string, over: Partial<TranscriptToolCall> = {}) =>
  tool(name, { detail, status: "pending", backgroundState: "unknown", ...over })

const codexpolls: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Watch the release workflow and tell me when it lands.", tools: [], parts: [] },
  withId(asst("Kicking the workflow off, then I'll sit on it until it reaches a terminal state.", [
    tool("Bash", { detail: "gh workflow run release.yml", desc: "Starting the release workflow" }),
  ])),
  withId(asst("", [bgShell("Tailing the release log", "gh run watch 8891241")])),
  ...[29, 30, 31, 32, 34].flatMap((cell) => [
    withId(asst("", [orphanPoll("Wait", `cell ${cell}`)])),
    withId(asst("", [orphanPoll("Poll process", "session 98949", { durationMs: 63_807_000 })])),
  ]),
  withId(asst("I'm performing one final lightweight state check before I report back.", [
    tool("Bash", { detail: "gh run view 8891241 --json conclusion", desc: "Checking the final conclusion" }),
  ])),
  withId(asst("**Fixed** — the release workflow finished green.")),
]

// A second, differently-worded ask so the stacked-question variants are readable apart at a glance.
const engineQuestion = [
  "```question",
  "Before I go further — which engine should the layer target?",
  "",
  "- A. Postgres — matches prod (recommended).",
  "- B. SQLite — zero setup, but no parity with prod.",
  "```",
].join("\n")

// The ask sits in the MIDDLE of the run: the agent asked and then kept working (a background wake). The
// collapse must lift it out (it is a decision the human owes) and its chips must be live.
const buriedask: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Set up the database layer end to end.", tools: [], parts: [] },
  withId(asst("Reading the current schema and migration setup first.", [
    tool("Read", { detail: "packages/server/src/storage.ts", read: "…980 lines…" }),
    tool("Grep", { detail: "migrate|schema" }),
  ])),
  withId(asst(engineQuestion)),
  withId(asst("Meanwhile I wired the migrations runner so either answer lands cleanly.", [
    tool("Edit", { detail: "packages/server/src/storage.ts" }),
    tool("Bash", { detail: "nub --test", desc: "Running the server suite" }),
  ])),
  withId(asst("Runner and a connection-pool stub are in — waiting on the engine call above before I go further.")),
]

// Two unanswered asks stacked with work between them. Both must take chips.
const twoasks: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Set up the database layer end to end.", tools: [], parts: [] },
  withId(asst("Reading the current schema first.", [tool("Read", { detail: "packages/server/src/storage.ts" })])),
  withId(asst(engineQuestion)),
  withId(asst("Sketching the collapse label while I wait.", [tool("Edit", { detail: "components/TodosView.tsx" })])),
  withId(asst(finalQuestion)),
]

// The human already replied PAST the ask. Nothing stands at the tail, so the card's Send action is down —
// but the ask itself stays answerable once "Load earlier messages" brings it back on screen.
const humanpast: TranscriptMessage[] = [
  { sourceId: "u-old", role: "user", text: "Set up the database layer end to end.", tools: [], parts: [] },
  withId(asst("Reading the current schema first.", [tool("Read", { detail: "packages/server/src/storage.ts" })])),
  withId(asst(engineQuestion)),
  { sourceId: "u-cur", role: "user", text: "Park the engine question — do the migrations runner first.", tools: [], parts: [] },
  withId(asst("On it — runner first.", [
    tool("Edit", { detail: "packages/server/src/storage.ts" }),
    tool("Bash", { detail: "nub --test", desc: "Running the server suite" }),
  ])),
  withId(asst("Migrations runner is in and green.")),
]

// A thread that RESTED and was then woken again by a background task, so the transcript holds two whole
// turns. The card must show only the newest one: everything back to (and excluding) the `rest` divider
// that closed the previous turn, with the trailing rest that closed THIS turn drawn nowhere either. The
// old ask and its "Fixed —" sign-off stay reachable behind "Load earlier messages".
const priorrest: TranscriptMessage[] = [
  { sourceId: "u-old", role: "user", text: "Kick off the release workflow and watch it.", tools: [], parts: [] },
  withId(asst("Starting the workflow, then I'll sit on the run until it reaches a terminal state.", [
    tool("Bash", { detail: "gh workflow run release.yml", desc: "Starting the release workflow" }),
  ])),
  withId(asst("**Fixed** — the workflow is running; I'll report when the watcher returns.")),
  withId(boundaryEvent("rest", "Agent rested")),
  withId(boundaryEvent("wake", "Background task «Watching the release run» exited 0")),
  withId(asst("The watcher came back green — checking what the run actually published.", [
    tool("Bash", { detail: "gh run view 8891241 --json conclusion", desc: "Reading the run conclusion" }),
    tool("Bash", { detail: "gh release view v2.4.0", desc: "Reading the published release" }),
  ])),
  withId(asst("The tag is up but the notes are the template default.", [
    tool("Read", { detail: ".github/workflows/release.yml" }),
    tool("Edit", { detail: ".github/workflows/release.yml" }),
  ])),
  withId(asst(finalQuestion)),
  withId(boundaryEvent("rest", "Agent rested")),
]

// THE SHAPE THIS COLLAPSE EXISTS FOR (maintainer 2026-08-12): an agent parks on a PR watcher, the
// watcher fires, it works, it rests, the watcher fires AGAIN. Three runs, three folds, with each wake's
// hairline sitting between the run it ended and the run it caused — "multiple messages in their complete
// form, with various collapsed tool call blocks between them, plus some hairline indicators showing why
// they were reawoken."
//
// The wake messages carry a SERVED `wakeSteer`, exactly as the server sends it, so this drives the real
// FrizzWake rather than the parser fallback. The third run is deliberately ONE prose message with a
// pile of calls behind it: a woken run folds on the strength of its own wake hairline, which is the case
// the old single-span collapse could not fold at all.
// The `text` is built by the REAL formatter, not hand-written, because the card reads it: a first-park
// replay is told apart from genuine news by the backlog tail `formatGithubWakeSteer` appends, and a
// hand-rolled string would silently render every wake as news.
const prWake = (
  ref: string,
  items: { label: string; actor: string; bot: boolean; at: string }[],
  opts: { backlog?: boolean } = {},
): TranscriptMessage => {
  const steer = {
    ref,
    // Each item gets its OWN permalink, as a real steer does.
    items: items.map((i, n) => ({ ...i, url: `https://github.com/${ref.split("#")[0]}/pull/${ref.split("#")[1]}#pullrequestreview-49222${n}` })),
    omitted: 0,
  }
  return withId({
    role: "user",
    wake: true,
    wakeSteer: steer,
    text: formatGithubWakeSteer(steer, opts),
    tools: [],
    parts: [],
  } as unknown as TranscriptMessage)
}

const prwakes: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Fix #5178 — the v3→v4 optional key behavior change — and get it merged.", tools: [], parts: [] },
  withId(asst("Reproducing the report against v4 before I touch anything.", [
    tool("Bash", { detail: "nub scripts/repro-5178.mts", desc: "Reproducing the reported behavior" }),
    tool("Read", { detail: "packages/zod/src/v4/classic/schemas.ts", read: "…2140 lines…" }),
  ])),
  withId(asst("Real regression. Fixing it and pinning it with a test.", [
    tool("Edit", { detail: "packages/zod/src/v4/classic/schemas.ts" }),
    tool("Edit", { detail: "packages/zod/src/v4/classic/tests/object.test.ts" }),
    tool("Bash", { detail: "nub --test", desc: "Running the suite" }),
    tool("Bash", { detail: "gh pr create --fill", desc: "Opening the PR" }),
  ])),
  withId(asst("PR #6382 is open against main, mergeable, all checks green. Waiting on your review — I'll address comments as they land.")),
  withId(boundaryEvent("rest", "Agent rested")),
  // THE FIRST PARK: the watcher hands over everything already sitting on the PR. Eleven items here,
  // which used to mean eleven rows in the card; a long-lived PR means a hundred.
  prWake("colinhacks/zod#6382", Array.from({ length: 11 }, (_, n) => ({
    label: n % 3 === 0 ? "review" : "review comment",
    actor: n % 2 === 0 ? "copilot-pull-request-reviewer" : "pullfrog",
    bot: true,
    at: new Date(Date.now() - (600 - n * 40) * 60_000).toISOString(),
  })), { backlog: true }),
  withId(asst("Reading both reviews before I change anything.", [
    tool("Bash", { detail: "gh api repos/colinhacks/zod/pulls/6382/reviews/4922222194/comments", desc: "Reading the first review's inline comments" }),
    tool("Bash", { detail: "gh api repos/colinhacks/zod/pulls/6382/reviews/4922256690/comments", desc: "Reading the second review's inline comments" }),
    tool("Read", { detail: "packages/zod/src/v4/core/parse.ts" }),
  ])),
  withId(asst("One of the two is a real defect — the JIT path skips the same guard. Fixing both.", [
    tool("Edit", { detail: "packages/zod/src/v4/core/parse.ts" }),
    tool("Edit", { detail: "packages/zod/src/v4/classic/tests/object.test.ts" }),
    tool("Bash", { detail: "nub --test", desc: "Re-running the suite" }),
    tool("Bash", { detail: "git push", desc: "Pushing the review fixes" }),
  ])),
  withId(asst("Both review findings are addressed and pushed. CI is green again on the new head.")),
  withId(boundaryEvent("rest", "Agent rested")),
  prWake("colinhacks/zod#6382", [
    { label: "approval", actor: "colinhacks", bot: false, at: new Date(Date.now() - 4 * 60_000).toISOString() },
  ]),
  withId(asst("Approved — merging.", [
    tool("Bash", { detail: "gh pr checks 6382", desc: "Confirming every check is still green" }),
    tool("Bash", { detail: "gh pr merge 6382 --squash", desc: "Merging the PR" }),
    tool("Bash", { detail: "git fetch origin main", desc: "Syncing the merged head" }),
    tool("Bash", { detail: "nub --test", desc: "Re-running the suite on merged main" }),
  ])),
  withId(asst("**Fixed** — #5178 is merged as `d7bc1c3e`, and the JIT defect the review caught went with it.")),
  withId(boundaryEvent("rest", "Agent rested")),
]

// NEITHER KEPT RUN FOLDS, AND THE MIDDLE IS CUT BY RESTS — the shape that painted fifteen hours of a
// real nub thread raw (maintainer 2026-09-02, `investigate-divergences-fix-this-and-all`: an "insane"
// card at 15,756px). Two defects at once, so this variant pins both:
//   1. The first run answers in ONE prose message (open === close, deliberately never folds) and the
//      last run is one quiet status line (nothing hidden, never folds) — so the collapse gate, counting
//      only the kept folding runs, read "nothing to collapse" while twelve rounds sat in the middle.
//   2. Every middle run here is opened by a REST + a background-task completion, not a `wake:true`
//      steer — so `middle.start` reaches back onto the rest record, which the render loop drops before
//      the middle branch, and the exact-index divider emission never fired: the rounds vanished with
//      NO line standing in for them.
const loneanswer: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "ci failing", tools: [], parts: [] },
  withId(boundaryEvent("wake", "Background task «Building and testing the fix» finished")),
  withId(asst("Fix pushed — the lockfile drift is gone and CI is restarted on the new head.", [
    tool("Bash", { detail: "git push", desc: "Pushing the fix" }),
    tool("Bash", { detail: "gh pr checks 837", desc: "Confirming CI restarted" }),
  ])),
  withId(boundaryEvent("rest", "Agent rested")),
  withId(boundaryEvent("wake", "Background task «Re-running the full suite» finished")),
  withId(asst("", [tool("Read", { detail: "target/test-output.log" })])),
  withId(asst("", [tool("Bash", { detail: "gh pr checks 837", desc: "Reading the check runs" })])),
  withId(asst("The full suite is green on the new head.", [tool("Bash", { detail: "git log -1", desc: "Recording the head" })])),
  withId(boundaryEvent("rest", "Agent rested")),
  withId(boundaryEvent("wake", "Background task «Watching the follow-up run» finished")),
  withId(asst("", [tool("Bash", { detail: "gh run view 991 --json conclusion", desc: "Reading the run conclusion" })])),
  withId(asst("Still green — nothing new to act on.", [tool("Bash", { detail: "gh pr view 837 --json mergeable", desc: "Re-checking mergeability" })])),
  withId(boundaryEvent("rest", "Agent rested")),
  prWake("nubjs/nub#837", [
    { label: "approval", actor: "colinhacks", bot: false, at: new Date(Date.now() - 4 * 60_000).toISOString() },
  ]),
  withId(asst("That is the watcher confirming what I already verified — nothing changed; the merge is yours.")),
  withId(boundaryEvent("rest", "Agent rested")),
]

// THE SHAPE THAT BROKE IT (maintainer 2026-08-16, zod thread
// `dedupe-zod-6236-exactoptional-with-coercion-2-prs`): the human asks a pointed question, the agent
// ANSWERS it and rests, and the GOAL — not a watcher — wakes it twice more. Every wake here is the Goal's
// own bump, which the card used to drop outright and which therefore cut nothing: the three turns merged
// into one run, and the fold that stood for it hid the answer he had just asked for ("the entire answer
// to that question was collapsed by default").
//
// The bump text is the REAL delivery, token and all — the same string frizz wrote into that thread. The
// `<!-- frizz-wake:… -->` token is what the server strips into `displayText`, and RecurringPromptLine
// parses the `$`-anchored trailer off the presentation text, so a hand-trimmed copy would render as a
// plain wake card instead of the "Goal · at rest" hairline this variant exists to pin.
const GOAL_BODY =
  "If further work towards the original task/goal remains, keep going. If there are open questions that require human input, ask them with question fences.\n\n" +
  "(Goal — sent each time you come to rest. To stop these, sign off with a ```done fence — but ONLY when the work is genuinely finished: it files this thread away, and nothing but new work from the human reopens it.)"

const goalBump = (n: number): TranscriptMessage =>
  withId({
    role: "user",
    wake: true,
    text: `${GOAL_BODY}\n\n<!-- frizz-wake:${String(n).repeat(8)} -->`,
    displayText: GOAL_BODY,
    tools: [],
    parts: [],
  } as unknown as TranscriptMessage)

const goalwakes: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "why do you remove the input field from that object, the object where you now add `is_present`? I'm a little suspicious of that.", tools: [], parts: [] },
  withId(asst("Fair challenge. Let me answer the first precisely and then actually test the second.", [
    tool("Bash", { detail: "rg -n 'key in input' packages/zod/src/v4/core", desc: "Finding every use of the field" }),
  ])),
  withId(asst("Confirmed on `input`: it was used for exactly one thing. Prototyping the alternative.", [
    tool("Edit", { detail: "packages/zod/src/v4/core/schemas.ts" }),
    tool("Bash", { detail: "nub --test packages/zod/src/v4", desc: "Running the suite on the prototype" }),
    tool("Read", { detail: "packages/zod/src/v4/core/parse.ts", read: "…412 lines…" }),
  ])),
  // THE ANSWER. It is the message the agent RESTED on, so it must render in full — this is the row the
  // old single-run fold swallowed.
  withId(asst("You were right on both counts. I rewrote it — `c6fdada5` replaces the whole approach.\n\n## On removing `input`\n\nIt was load-bearing for exactly one check, and the rewrite makes that check unnecessary rather than moving it.")),
  withId(boundaryEvent("rest", "Agent rested")),
  goalBump(1),
  withId(asst("CI check first, then I need to fix the write-up — it still describes the approach I just abandoned.", [
    tool("Bash", { detail: "gh pr checks 6385", desc: "Reading the check runs" }),
    tool("Edit", { detail: ".triage/issues/6236/results.md" }),
    tool("Bash", { detail: "git commit -am 'fix: rewrite the write-up'", desc: "Committing the write-up" }),
  ])),
  withId(asst("All six real CI checks are green on the rewritten `c6fdada5`, `MERGEABLE`. The durable write-up matches the code again.")),
  withId(boundaryEvent("rest", "Agent rested")),
  goalBump(2),
  withId(asst("Review count went from 9 to 10 — checking whether pullfrog re-reviewed the rewrite.", [
    tool("Bash", { detail: "gh api repos/colinhacks/zod/pulls/6385/reviews", desc: "Listing the reviews" }),
    tool("Bash", { detail: "gh api repos/colinhacks/zod/pulls/6385/reviews/492266/comments", desc: "Reading the newest review" }),
  ])),
  withId(asst("That review predates my rewrite — it is against `1a5d0804`, the design that no longer exists. Nothing to act on.")),
  withId(boundaryEvent("rest", "Agent rested")),
]

// THREE AIRLINES IN A ROW, which is the only arrangement that shows the defect at all. Five runs against
// one ask, so the middle three collapse into a single fold; the last run is woken by ONE poll that saw
// both CI settle and a comment land, and `prWatchWakeMessage` composes those into a single delivery. The
// card therefore draws fold → CI verdict → review comment with no prose between any of them, and the
// three gaps have to be the same gap. Written with the REAL formatter, so the pair only renders as two
// hairlines for as long as the shipped wording still parses.
const combinedWake = (ref: string, passed: number, actor: string, minutesAgo: number): TranscriptMessage =>
  withId({
    role: "user",
    wake: true,
    text: prWatchWakeMessage({
      target: ref,
      checks: { verdict: "passing", passed, failed: 0, failing: [] },
      review: formatGithubWakeSteer({
        ref,
        omitted: 0,
        items: [{
          label: "review comment",
          actor,
          bot: true,
          at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
          url: `https://github.com/${ref.split("#")[0]}/pull/${ref.split("#")[1]}#pullrequestreview-4930112233`,
        }],
      }),
    }),
    tools: [],
    parts: [],
  } as unknown as TranscriptMessage)

const stackedwakes: TranscriptMessage[] = [
  { sourceId: "u-stacked", role: "user", text: "Take #6440 to merge-readiness — address whatever the reviewers raise.", tools: [], parts: [] },
  withId(asst("Reading the PR and its open threads before I touch anything.", [
    tool("Bash", { detail: "gh pr view 6440 --json title,body,files", desc: "Reading the PR" }),
    tool("Bash", { detail: "gh api repos/colinhacks/zod/pulls/6440/comments", desc: "Reading the inline review comments" }),
  ])),
  withId(asst("Two of the four findings are real. Fixing both and pushing.")),
  withId(boundaryEvent("rest", "Agent rested")),
  prWake("colinhacks/zod#6440", [
    { label: "review comment", actor: "copilot-pull-request-reviewer", bot: true, at: new Date(Date.now() - 96 * 60_000).toISOString() },
  ]),
  withId(asst("That one is a false positive — the guard it wants is already two frames up.", [
    tool("Read", { detail: "packages/zod/src/v4/core/parse.ts" }),
    tool("Bash", { detail: "nub --test", desc: "Re-running the suite" }),
  ])),
  withId(boundaryEvent("rest", "Agent rested")),
  prWake("colinhacks/zod#6440", [
    { label: "review", actor: "pullfrog", bot: true, at: new Date(Date.now() - 64 * 60_000).toISOString() },
  ]),
  withId(asst("Addressed the naming nit and rebased onto main.", [
    tool("Edit", { detail: "packages/zod/src/v4/classic/schemas.ts" }),
    tool("Bash", { detail: "git rebase origin/main", desc: "Rebasing onto main" }),
    tool("Bash", { detail: "git push --force-with-lease", desc: "Pushing the rebase" }),
  ])),
  withId(boundaryEvent("rest", "Agent rested")),
  prWake("colinhacks/zod#6440", [
    { label: "review comment", actor: "copilot-pull-request-reviewer", bot: true, at: new Date(Date.now() - 41 * 60_000).toISOString() },
  ]),
  withId(asst("Nothing actionable in that one either. Waiting on the rebased CI run.", [
    tool("Bash", { detail: "gh pr checks 6440 --watch", desc: "Watching the rebased run" }),
  ])),
  withId(boundaryEvent("rest", "Agent rested")),
  // THE COMBINED DELIVERY: one poll, two events, two hairlines — and the pair the fold above them is
  // measured against.
  combinedWake("colinhacks/zod#6440", 10, "pullfrog", 16),
  withId(asst('"No new issues found." #6440 is fully green on `f94f6138` — all checks passed, `MERGEABLE` / `CLEAN`, zero unresolved threads, five commits, +166/−4. Ready to merge whenever you want.')),
  withId(boundaryEvent("rest", "Agent rested")),
]

// THE REAL SHAPE, condensed from the thread that reported it: the projection coalesces the write-up and
// the registration it punctuates into one message (raw stream order is text → tool_use, so the parts go
// the same way), and the afterword is genuinely short — the whole reason it must not be the only prose
// the fold leaves visible.
const doneConclusion = [
  "It looks that way from the app-developer seat, but the field is bigger than two vendors.",
  "",
  "**The two you named** are the ones with a generous free tier and instant provisioning, which is why they own the tutorial mindshare.",
  "",
  "**The hyperscalers** all host Postgres (RDS, Cloud SQL, Azure Flexible Server) — mature, but slow to provision and priced for steady-state production, not per-app experiments.",
  "",
  "**The specialists** round out the map: Crunchy Bridge on operational rigor, Timescale on time-series, Aiven on multi-cloud, and Fly/Railway/Render bundling Postgres beside the app runtime.",
  "",
  "So the honest summary: for the workflow this thread's design assumes — spin up a database per preview branch, pay nothing at idle — it really is a two-horse race today.",
].join("\n")

const donetail: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Wow, so it's really just Neon and Supabase letting people host Postgres, huh? That seems like a big market gap.", tools: [], parts: [] },
  withId(asst("One quick check so I do not answer from a stale map of that market.", [
    tool("WebSearch", { detail: "managed Postgres providers 2026" }),
  ])),
  withId({
    role: "assistant",
    text: doneConclusion,
    tools: [tool("mcp__frizz__done")],
    parts: [
      { kind: "text" as const, text: doneConclusion },
      { kind: "tools" as const, tools: [tool("mcp__frizz__done")] },
    ],
  }),
  withId(asst("The market map is in the message above, and the design report is unchanged — this question needed no edits to it.")),
  withId(boundaryEvent("rest", "Agent rested")),
]

// The pin is the server's own shape (latestTranscriptWindow): a tools-only assistant record carrying the
// still-pending background call, pointing back at the launch message that scrolled out of the window.
const pinnedMonitor = tool("Monitor", {
  status: "pending",
  backgroundState: "background",
  shellId: "toolu_pinned_monitor",
  detail: "tail -f build.log | grep --line-buffered -E 'EXIT=|FAILED'",
  desc: "Watching the engine build",
})

const pinnedtail: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Make Jest work, build the docs site, and set up Zed.", tools: [], parts: [] },
  withId(asst("Starting the three tasks in parallel.", [
    tool("Agent", { detail: "Setting up Zed" }),
    tool("Bash", { detail: "nub run build", desc: "Building the engine" }),
  ])),
  withId(asst("", [tool("Bash", { detail: "nub --test", desc: "Running the suite" })])),
  withId(asst("Jest and the docs site are committed. The Zed helper still runs.")),
  withId(boundaryEvent("rest", "Agent rested")),
  withId(boundaryEvent("wake", "Background task «Setting up Zed» finished")),
  withId(asst("Status: the Zed section is written. Now I commit it.", [tool("Read", { detail: "lab/nextjs/.zed/settings.json" })])),
  withId(asst("", [tool("Bash", { detail: "git commit -am 'docs: Zed setup'", desc: "Committing the Zed section" })])),
  withId(asst("Everything is done in five commits on local `main`: Jest, the docs site, and the Zed setup.")),
  withId(boundaryEvent("rest", "Agent rested")),
  {
    sourceId: "pinned-bg:demo",
    pinnedFromSourceId: "m-launch-scrolled-out",
    role: "assistant",
    text: "",
    tools: [pinnedMonitor],
    parts: [{ kind: "tools" as const, tools: [pinnedMonitor] }],
    at: new Date(Date.now() - 45 * 3_600_000).toISOString(),
  },
]

// The lone message carries a fixed id so the test can read the divider's side of it in document order.
const loneProse = (workFirst: boolean): TranscriptMessage[] => [
  { sourceId: "u-cur", role: "user", text: "Take #6440 to merge-readiness.", tools: [], parts: [] },
  withId(asst("Reading the PR before I touch anything.", [
    tool("Bash", { detail: "gh pr view 6440 --json title,body,files", desc: "Reading the PR" }),
  ])),
  withId(asst("Both findings are fixed and pushed.")),
  withId(boundaryEvent("rest", "Agent rested")),
  withId(boundaryEvent("wake", "Background task «Re-running the suite» finished")),
  ...(workFirst
    ? [
        withId(asst("", [tool("Read", { detail: "target/test-output.log" })])),
        withId(asst("", [tool("Bash", { detail: "gh pr checks 6440", desc: "Reading the check runs" })])),
        { ...asst("The suite is green on the new head."), sourceId: "lone-prose" },
      ]
    : [
        { ...asst("The suite is green. Recording the head and re-checking mergeability.", [tool("Bash", { detail: "git log -1", desc: "Recording the head" })]), sourceId: "lone-prose" },
        withId(asst("", [tool("Bash", { detail: "gh pr view 6440 --json mergeable", desc: "Re-checking mergeability" })])),
      ]),
  withId(boundaryEvent("rest", "Agent rested")),
]

const DB_ENGINE_FENCE = [
  "```question",
  "id: db-engine",
  "kind: choice",
  "question: Which engine should the storage layer target?",
  "options:",
  "  - label: Postgres",
  "    description: matches production",
  "    recommended: true",
  "  - label: SQLite",
  "    description: zero setup, no parity with production",
  "```",
].join("\n")

const foldedask: TranscriptMessage[] = [
  { sourceId: "u-cur", role: "user", text: "Set up the storage layer end to end.", tools: [], parts: [] },
  withId(asst("Reading the current schema and migration setup first.", [
    tool("Read", { detail: "packages/server/src/storage.ts", read: "…980 lines…" }),
    tool("Grep", { detail: "migrate|schema" }),
  ])),
  withId(asst("Starting the schema audit in the background; I'll pick up when it reports.", [
    tool("Bash", { detail: "nub scripts/audit-schema.mts", desc: "Auditing the schema" }),
  ])),
  withId(boundaryEvent("rest", "Agent rested")),
  withId(boundaryEvent("wake", "Background task «Auditing the schema» finished")),
  withId(asst("The audit found two tables with no index on their foreign key. Adding both.", [
    tool("Edit", { detail: "packages/server/src/storage.ts" }),
    tool("Bash", { detail: "nub --test", desc: "Running the server suite" }),
  ])),
  withId(asst("Indexes are in and green. Running the migration dry-run against a copy of the data.")),
  withId(boundaryEvent("rest", "Agent rested")),
  withId(boundaryEvent("wake", "Background task «Dry-running the migrations» finished")),
  withId(asst("The dry-run is clean.", [tool("Read", { detail: "target/migrate-dry-run.log" })])),
  withId(asst(`One decision belongs to you before the connection layer goes in:\n\n${DB_ENGINE_FENCE}`)),
  withId(asst("The rest doesn't depend on the answer, so I'm writing the migrations runner meanwhile.", [
    tool("Edit", { detail: "packages/server/src/migrate.ts" }),
    tool("Bash", { detail: "nub --test", desc: "Running the server suite" }),
  ])),
  withId(boundaryEvent("rest", "Agent rested")),
  withId(boundaryEvent("wake", "Background task «Running the full suite» finished")),
  withId(asst("The full suite is green with the runner in.", [tool("Bash", { detail: "git log -1", desc: "Recording the head" })])),
  withId(boundaryEvent("rest", "Agent rested")),
  withId(boundaryEvent("wake", "Background task «Packaging the server build» finished")),
  withId(asst("The server build packages cleanly.", [
    tool("Bash", { detail: "nub run build", desc: "Building the server" }),
    tool("Read", { detail: "dist/manifest.json" }),
  ])),
  withId(boundaryEvent("rest", "Agent rested")),
]

// The registered row the `foldedask` fence became — what queues the thread and draws the card.
const foldedaskThread: Partial<ThreadViewModel> = {
  spawnedAt: new Date(Date.now() - 3 * 3_600_000).toISOString(),
  questions: [{
    id: "qst_foldedask01",
    handle: "db-engine",
    askedAt: new Date(Date.now() - 50 * 60_000).toISOString(),
    standing: true,
    spec: {
      handle: "db-engine",
      kind: "question",
      question: "Which engine should the storage layer target?",
      options: [
        { label: "Postgres", description: "matches production", recommended: true },
        { label: "SQLite", description: "zero setup, no parity with production" },
      ],
    },
  }],
}

const messages =
  replay?.messages ??
  (variant === "foldedask" ? foldedask
  : variant === "loneprose" ? loneProse(true)
  : variant === "loneproseafter" ? loneProse(false)
  : variant === "pinnedtail" ? pinnedtail
  : variant === "donetail" ? donetail
  : variant === "goalwakes" ? goalwakes
  : variant === "prwakes" ? prwakes
  : variant === "single" ? single
  : variant === "bgshells" ? bgshells
  : variant === "dispatches" ? dispatches
  : variant === "codexpolls" ? codexpolls
  : variant === "notools" ? notools
  : variant === "batchedends" ? batchedends
  : variant === "questionthentool" ? questionthentool
  : variant === "trailingevent" ? trailingevent
  : variant === "buriedask" ? buriedask
  : variant === "twoasks" ? twoasks
  : variant === "humanpast" ? humanpast
  : variant === "stackedwakes" ? stackedwakes
  : variant === "priorrest" ? priorrest
  : variant === "loneanswer" ? loneanswer
  : heavy)

const thread: ThreadViewModel = {
  id: SLUG,
  title: "Intermediate-logs collapse demo",
  status: "needs-human",
  statusText: "Waiting on your review of the collapsed intermediate view",
  mechanism: null,
  humanBlocked: false,
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
  // The live child behind the `dispatches` variant's first Agent card — AgentBlock reads its mark and
  // its runtime from HERE (the board's tracked set), not from the transcript call.
  subAgents: variant === "dispatches"
    ? [{ id: LIVE_AGENT_ID, label: "Audit the queue card's collapse", state: "running", startedAt: new Date(Date.now() - 186_000).toISOString(), depth: 1 }]
    : [],
  // A live board shell, so the ops strip shows the BLUE hue beside the green one — the fixture is where
  // the three-hue family (yellow sub-agent, blue shell, green PR watcher) can be compared at a glance.
  bgShells: variant === "dispatches"
    ? [{ id: "sh-live-1", label: "Tailing the release log", state: "running", startedAt: new Date(Date.now() - 512_000).toISOString() }]
    : [],
  // The board synthesizes one of these per parseable `prs:` entry on a standing fence (see
  // board.githubWatchViews). The strip under the prompt box lists them beside sub-agents and shells.
  watches: variant === "prwakes" || variant === "bgshells" || variant === "dispatches"
    ? [{ id: "github:demo:colinhacks/zod#6382", kind: "github", target: "colinhacks/zod#6382", state: "armed", createdAt: new Date(Date.now() - 37 * 60_000).toISOString() }]
    : [],
  // The registered sign-off behind the `donetail` variant's tail card: a `thread_done` row is in no
  // message, so the card only draws if the thread carries the synthesized fence (showsRegisteredDoneCard).
  lastFence: variant === "donetail"
    ? { kind: "done", registered: true, body: "- **Answered the market question** — the map is in the final message; the design report needed no edits." }
    : undefined,
  lastActivityAt: new Date().toISOString(),
  ...(variant === "foldedask" ? foldedaskThread : undefined),
  ...replay?.thread,
} as unknown as ThreadViewModel

store.board = { projectDir: "/fixture/frizz", threads: [thread] } as BoardSnapshot

const transcriptPage = { messages, transcriptKey: "fixture-key", hasEarlier: replay?.hasEarlier === true, historyLoaded: false }

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.origin)
  if (url.pathname === "/_frizz/rpc/threadTranscript" || url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    return new Response(JSON.stringify({ result: transcriptPage }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

function Fixture() {
  return (
    <div className="mx-auto w-[min(680px,calc(100%-32px))] py-8">
      <TodosView />
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </QueryClientProvider>,
)
