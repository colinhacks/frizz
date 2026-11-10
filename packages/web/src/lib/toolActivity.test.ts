import { test } from "node:test"
import assert from "node:assert/strict"
import type { TranscriptToolCall } from "@frizz/shared"
import type { ChatMessage } from "../hooks.ts"
import {
  coalesceToolActivityMessages,
  currentToolActivity,
  historicalToolActivityMessages,
  isPictureTool,
  isToolActivityException,
  liveRuntimeStartedAt,
  liveToolActivityRun,
  liveToolActivityTail,
  editedFileCount,
  settledToolActivityLabel,
  thinkingToolActivityLabel,
  toolActivityLabel,
} from "./toolActivity.ts"

function tool(name: string, over: Partial<TranscriptToolCall> = {}): TranscriptToolCall {
  return { name, ...over }
}

function toolMessage(sourceId: string, calls: TranscriptToolCall[], at = "2026-07-30T12:00:00.000Z"): ChatMessage {
  return {
    sourceId,
    role: "assistant",
    text: "",
    tools: calls,
    parts: [{ kind: "tools", tools: calls }],
    at,
  }
}

test("ordinary tool turns coalesce across provider batches while retaining a stable source", () => {
  const messages = [
    toolMessage("batch-a", [tool("Read", { detail: "src/a.ts", status: "completed" })]),
    toolMessage("batch-b", [tool("Grep", { detail: "renderActivity", status: "pending" })], "2026-07-30T12:00:02.000Z"),
  ]

  const compact = coalesceToolActivityMessages(messages)
  assert.equal(compact.length, 1)
  assert.equal(compact[0].message.sourceId, "batch-a")
  assert.equal(compact[0].message.at, "2026-07-30T12:00:02.000Z")
  assert.deepEqual(compact[0].message.tools.map((call) => call.name), ["Read", "Grep"])
  assert.equal(compact[0].messageIndex, 0)
})

test("prose, sub-agent cards AND background launches each split the activity run", () => {
  const background = toolMessage("background", [
    tool("Bash", { command: "nub run dev", backgroundState: "background", status: "pending" }),
  ])
  const agent = toolMessage("agent", [
    tool("Spawn agent", { agentId: "call-agent", detail: "inspect renderer", status: "pending" }),
  ])
  const prose: ChatMessage = {
    sourceId: "prose",
    role: "assistant",
    text: "I found the relevant renderer.",
    tools: [],
    parts: [{ kind: "text", text: "I found the relevant renderer." }],
  }
  const messages = [
    toolMessage("one", [tool("Read")]),
    background,
    {
      sourceId: "empty",
      role: "assistant",
      text: "",
      tools: [],
      parts: [],
    } satisfies ChatMessage,
    toolMessage("two", [tool("Grep")]),
    agent,
    toolMessage("three", [tool("Edit")]),
    prose,
    toolMessage("four", [tool("Bash")]),
  ]

  const compact = coalesceToolActivityMessages(messages)
  assert.deepEqual(compact.map((entry) => entry.message.sourceId), [
    "one",
    "background",
    "two",
    "agent",
    "three",
    "prose",
    "four",
  ])
  assert.deepEqual(
    compact[0].message.tools.map((call) => call.name),
    ["Read"],
    "the background launch ends the run above it instead of being absorbed into it",
  )
  assert.deepEqual(compact[1].message.tools.map((call) => call.backgroundState), ["background"])
  // A detached op keeps a dedicated card wherever it renders — the maintainer's whole point is that a
  // background task must not disappear behind `Ran N tool calls`. A blocked `&` job is a background
  // shape too (`unknown`) and gets the same treatment.
  assert.equal(isToolActivityException(background.tools[0]), true)
  assert.equal(isToolActivityException(tool("Bash", { backgroundState: "unknown" })), true)
  assert.equal(isToolActivityException(agent.tools[0]), true)
  assert.equal(isToolActivityException(tool("Send message", { sendTo: "main" })), true)
  // An ordinary foreground call is still ordinary activity — including a long one.
  assert.equal(isToolActivityException(tool("Read")), false)
  assert.equal(isToolActivityException(tool("Bash", { command: "nub --test", status: "pending" })), false)
})

// codex's `list_agents` is a roster READ, not a dispatch. It used to sit in SUB_AGENT_TOOL_NAMES, so a
// model that polled it mid-burst broke one batch into `Ran 1 tool call` / a standalone Agents card /
// `Ran 4 tool calls`.
test("the agent listing folds into the ordinary activity run", () => {
  const listing = tool("Agents", { detail: "list live agents", output: "3 agents · 2 running · 1 completed", status: "completed", durationMs: 104 })
  assert.equal(isToolActivityException(listing), false)

  const compact = coalesceToolActivityMessages([
    toolMessage("one", [tool("Read", { detail: "src/a.ts" })]),
    toolMessage("listing", [listing], "2026-07-30T12:00:01.000Z"),
    toolMessage("two", [tool("Grep"), tool("Edit")], "2026-07-30T12:00:02.000Z"),
  ])

  assert.equal(compact.length, 1)
  assert.deepEqual(compact[0].message.tools.map((call) => call.name), ["Read", "Agents", "Grep", "Edit"])
})

// A codex long-poll gate emits hundreds of `wait` / `write_stdin` calls the projector cannot pair with
// a launch. They arrive pending + `backgroundState: "unknown"`, which used to buy each one a dedicated
// card — a queue card of `Wait · cell 29 · unknown` rows with runaway clocks (maintainer 2026-08-09).
test("an orphaned codex poll folds into the run while a real detached job keeps its card", () => {
  const cellPoll = tool("Wait", { detail: "cell 29", sessionId: 29, status: "pending", backgroundState: "unknown" })
  const ptyPoll = tool("Poll process", { detail: "session 98949", sessionId: 98949, status: "pending", backgroundState: "unknown" })
  assert.equal(isToolActivityException(cellPoll), false)
  assert.equal(isToolActivityException(ptyPoll), false)
  // The other `unknown`: a Bash command whose `&` escaped the hook DID launch something that outlives
  // the call, so it is still a card.
  assert.equal(isToolActivityException(tool("Bash", { command: "node worker.mjs &", backgroundState: "unknown" })), true)

  const compact = coalesceToolActivityMessages([
    toolMessage("one", [tool("Read", { detail: "src/a.ts" })]),
    toolMessage("poll-a", [cellPoll], "2026-07-30T12:00:01.000Z"),
    toolMessage("poll-b", [ptyPoll], "2026-07-30T12:00:02.000Z"),
    toolMessage("two", [tool("Grep")], "2026-07-30T12:00:03.000Z"),
  ])

  assert.equal(compact.length, 1, "the polls no longer split the run into four rows")
  assert.deepEqual(compact[0].message.tools.map((call) => call.name), ["Read", "Wait", "Poll process", "Grep"])
})

// Maintainer 2026-10-03: "we should stop having special rendering where we display screenshots in the
// read tool … No images or screenshots are visible unless you make them visible to the user with the
// light box". A picture a tool RETURNED is the worker looking, so it folds like any other call.
test("a call whose result is a picture folds into the run like any other call", () => {
  // An image Read: the harness returns the picture as the WHOLE result, so there is no excerpt text —
  // `outputImage` is the only signal that this Read is a screenshot rather than a source file.
  const imageRead = tool("Read", { detail: "/tmp/shots/board.png", outputImage: "/tmp/frizz-tool-images/ab.png", status: "completed" })
  const shot = tool("mcp__chrome-devtools__take_screenshot", { outputImage: "/tmp/frizz-tool-images/cd.png", status: "completed" })
  for (const call of [imageRead, shot]) {
    assert.equal(isToolActivityException(call), false)
    assert.equal(isPictureTool(call), false, "a folded call is never a picture edge for the spacing")
  }

  const compact = coalesceToolActivityMessages([
    toolMessage("one", [tool("Bash"), tool("Grep")]),
    toolMessage("shot", [imageRead, shot], "2026-07-30T12:00:01.000Z"),
    toolMessage("two", [tool("Edit")], "2026-07-30T12:00:02.000Z"),
  ])

  assert.deepEqual(compact.map((entry) => entry.message.tools.map((call) => call.name)), [
    ["Bash", "Grep", "Read", "mcp__chrome-devtools__take_screenshot", "Edit"],
  ])
})

test("a delivery of pictures to the human keeps its card and splits the run", () => {
  const delivery = tool("SendUserFile", { sentImages: ["/tmp/frizz-tool-images/ef.png"], caption: "before vs after", status: "completed" })
  assert.equal(isToolActivityException(delivery), true)
  assert.equal(isPictureTool(delivery), true)

  // A delivery of non-image files stays in the digest: its chips say no more than the digest's label.
  assert.equal(isToolActivityException(tool("SendUserFile", { sentFiles: ["notes.pdf"] })), false)

  const compact = coalesceToolActivityMessages([
    toolMessage("one", [tool("Bash"), tool("Grep")]),
    toolMessage("sent", [delivery], "2026-07-30T12:00:01.000Z"),
    toolMessage("two", [tool("Edit")], "2026-07-30T12:00:02.000Z"),
  ])

  assert.deepEqual(compact.map((entry) => entry.message.tools.map((call) => call.name)), [
    ["Bash", "Grep"],
    ["SendUserFile"],
    ["Edit"],
  ])
})

// The maintainer's 2026-08-26 screenshot: Claude batched [thinking, thinking, ToolSearch, Agent] into
// ONE provider message, so the ToolSearch could not fold into the run above and sat as its own
// `Ran 1 tool call` directly under the previous one-call digest — and live it HAD folded, then split
// retroactively when the Agent block landed in the same message.
test("ordinary calls batched ahead of a dispatch in one message fold into the run above", () => {
  const skill = tool("Skill", { detail: "claude-api", status: "completed" })
  const lead: ChatMessage = {
    sourceId: "lead",
    role: "assistant",
    text: "First I load the Claude API reference.",
    tools: [skill],
    parts: [
      { kind: "text", text: "First I load the Claude API reference." },
      { kind: "tools", tools: [skill] },
    ],
  }
  const toolSearch = tool("ToolSearch", { detail: "select:SendMessage", status: "completed" })
  const dispatch = tool("Agent", { agentId: "call-1", prompt: "Audit the token overhead", detail: "Auditing Frizz token overhead", status: "pending" })
  const mixed = toolMessage("mixed", [toolSearch, dispatch], "2026-07-30T12:00:03.000Z")

  const compact = coalesceToolActivityMessages([lead, mixed])
  assert.deepEqual(compact.map((entry) => entry.message.sourceId), ["lead", "mixed"])
  assert.deepEqual(
    compact[0].message.tools.map((call) => call.name),
    ["Skill", "ToolSearch"],
    "the leading ordinary call joins the run above instead of minting a second one-call digest",
  )
  assert.equal(compact[0].message.at, "2026-07-30T12:00:03.000Z")
  assert.deepEqual(compact[1].message.tools, [dispatch], "only the dispatch card keeps the mixed row")
  assert.deepEqual(compact[1].message.parts, [{ kind: "tools", tools: [dispatch] }])
  assert.equal(compact[1].messageIndex, 1)

  // …and a trailing ordinary call AFTER the card is the next run, absorbing later pure batches.
  const after = tool("Read", { detail: "src/a.ts", status: "completed" })
  const sandwich = coalesceToolActivityMessages([
    lead,
    toolMessage("mixed2", [toolSearch, dispatch, after], "2026-07-30T12:00:03.000Z"),
    toolMessage("later", [tool("Grep", { status: "completed" })], "2026-07-30T12:00:04.000Z"),
  ])
  assert.deepEqual(sandwich.map((entry) => entry.message.tools.map((call) => call.name)), [
    ["Skill", "ToolSearch"],
    ["Agent", "Read", "Grep"],
  ])

  // With no run above there is nothing to join — the leading call keeps its own digest ahead of the card.
  const opening = coalesceToolActivityMessages([mixed])
  assert.equal(opening.length, 1)
  assert.deepEqual(opening[0].message.tools.map((call) => call.name), ["ToolSearch", "Agent"])

  // Prose ahead of the tools bounds the run exactly as it always did: nothing moves up past it.
  const prosed: ChatMessage = {
    sourceId: "prosed",
    role: "assistant",
    text: "Now the audit.",
    tools: [toolSearch, dispatch],
    parts: [
      { kind: "text", text: "Now the audit." },
      { kind: "tools", tools: [toolSearch, dispatch] },
    ],
  }
  const bounded = coalesceToolActivityMessages([lead, prosed])
  assert.deepEqual(bounded[0].message.tools.map((call) => call.name), ["Skill"])
  assert.deepEqual(bounded[1].message.tools.map((call) => call.name), ["ToolSearch", "Agent"])
})

test("a prose tool tail absorbs ordinary calls, and a background launch is what ends it", () => {
  const first = tool("Bash", { desc: "Starting the focused build", status: "completed" })
  const lead: ChatMessage = {
    sourceId: "lead",
    role: "assistant",
    text: "I found the build entry point.",
    tools: [first],
    parts: [
      { kind: "text", text: "I found the build entry point." },
      { kind: "tools", tools: [first] },
    ],
  }
  const messages = [
    lead,
    toolMessage("batch-a", [tool("Read", { status: "completed" })]),
    toolMessage("batch-edit", [tool("Edit", { status: "completed" })]),
    toolMessage("batch-b", [tool("Bash", { backgroundState: "background", status: "pending" })]),
    {
      sourceId: "empty",
      role: "assistant",
      text: "",
      tools: [],
      parts: [{ kind: "text", text: "  " }],
    } satisfies ChatMessage,
    toolMessage("batch-c", [tool("Bash", { status: "completed" })]),
    {
      sourceId: "finished-event",
      role: "assistant",
      kind: "event",
      boundary: "wake",
      text: "Background task finished",
      tools: [],
      parts: [],
    } satisfies ChatMessage,
  ]

  const compact = coalesceToolActivityMessages(messages)
  assert.deepEqual(
    compact.map((entry) => entry.message.sourceId),
    ["lead", "batch-b", "batch-c", "finished-event"],
    "the detached launch gets its own row; the ordinary run resumes after it",
  )
  assert.equal(compact[0].message.text, lead.text)
  assert.deepEqual(compact[0].message.parts?.map((part) => part.kind), ["text", "tools"])
  assert.deepEqual(compact[0].message.tools.map((call) => call.name), ["Bash", "Read", "Edit"])
  assert.equal(compact[0].message.parts?.[1].kind, "tools")
  assert.equal(compact[0].message.parts?.[1].kind === "tools" ? compact[0].message.parts[1].tools.length : 0, 3)
  assert.equal(compact[1].message.tools[0].backgroundState, "background")
  // The empty-parts record between the launch and `batch-c` is still transparent — a provider shell with
  // nothing renderable in it never becomes a boundary of its own.
  assert.deepEqual(compact[2].message.tools.map((call) => call.name), ["Bash"])
})

// The WIRE shape: a message off the server carries every call twice, as separate objects — the flat
// `tools` and the copy inside `parts` — because JSON gives them no shared identity. The helpers above
// build both from ONE array, which is exactly the shape a real message never has.
function wireMessage(message: ChatMessage): ChatMessage {
  return JSON.parse(JSON.stringify(message)) as ChatMessage
}

test("a live run that opens on a pure tool batch is withheld whole, in the wire shape", () => {
  const ask: ChatMessage = { sourceId: "ask", role: "user", text: "is it done?", tools: [], parts: [] }
  const first = wireMessage(toolMessage("first", [tool("Bash", { desc: "Checking the drain state", status: "completed" })]))
  const second = wireMessage(
    toolMessage("second", [tool("Bash", { desc: "Reading current coverage", status: "completed" })], "2026-07-30T12:00:09.000Z"),
  )

  const compact = coalesceToolActivityMessages([ask, first, second])
  assert.equal(liveToolActivityRun(compact)?.tools.length, 2)
  // Before the fix this returned ["ask", "first"] with `first` still holding ONE flat call — the copy
  // the identity filter could not see — so the drawer painted `Ran 1 tool call` directly above a
  // shimmer reading `Ran 2 tool calls. Thinking…` (maintainer 2026-08-27).
  assert.deepEqual(
    historicalToolActivityMessages(compact).map((entry) => entry.message.sourceId),
    ["ask"],
    "the run's first call must not survive as its own digest above the shimmer",
  )
})

test("a leading ordinary call folded up out of a dispatch batch leaves no flat copy behind, in the wire shape", () => {
  const run = wireMessage(toolMessage("run", [tool("Read", { status: "completed" })]))
  const mixed = wireMessage(toolMessage("mixed", [
    tool("Grep", { status: "completed" }),
    tool("Agent", { agentId: "call-agent", detail: "inspect renderer", status: "pending" }),
  ]))

  const compact = coalesceToolActivityMessages([run, mixed])
  assert.deepEqual(compact.map((entry) => entry.message.tools.map((call) => call.name)), [["Read", "Grep"], ["Agent"]])
  assert.deepEqual(
    compact[1].message.parts?.map((part) => (part.kind === "tools" ? part.tools.map((call) => call.name) : "text")),
    [["Agent"]],
    "the flat list and the parts must describe the same calls",
  )
})

test("the runtime gerund ends with its call; only the digest stays hidden across the inter-call gap", () => {
  const settled = toolMessage("settled", [tool("Read", { status: "completed" })])
  const pending = toolMessage("pending", [tool("Bash", { desc: "Running focused tests", status: "pending" })])
  const queued: ChatMessage = {
    sourceId: "queued",
    role: "user",
    text: "Also check the narrow layout.",
    tools: [],
    parts: [],
    queued: true,
  }

  const compact = coalesceToolActivityMessages([settled, pending, queued])
  assert.equal(liveToolActivityTail(compact), pending.tools[0])
  const liveHistory = historicalToolActivityMessages(compact)
  assert.deepEqual(liveHistory.map((entry) => entry.message.sourceId), ["queued"])
  assert.equal(
    liveHistory.some((entry) => entry.message.role === "assistant"),
    false,
    "a live pure-tool run must not render a partial historical disclosure",
  )

  pending.tools[0].status = "completed"
  const completed = coalesceToolActivityMessages([settled, pending])
  assert.equal(
    liveToolActivityTail(completed),
    undefined,
    "with the last result landed nothing is executing — the slot reverts to the generic Thinking reading",
  )
  assert.deepEqual(
    historicalToolActivityMessages(completed),
    [],
    "individual completion must not flash the digest while the turn is still running",
  )
  assert.deepEqual(
    completed[0].message.tools.map((call) => call.name),
    ["Read", "Bash"],
    "the idle caller can reveal the unmodified coalesced digest",
  )
})

test("expanding the shimmer opens exactly the run history is withholding, gap included", () => {
  const first = tool("Read", { detail: "src/a.ts", status: "completed" })
  const second = tool("Grep", { detail: "renderActivity", status: "pending" })
  const settled = toolMessage("batch-a", [first])
  const pending = toolMessage("batch-b", [second], "2026-07-30T12:00:02.000Z")

  const compact = coalesceToolActivityMessages([settled, pending])
  assert.deepEqual(
    liveToolActivityRun(compact),
    { tools: [first, second], at: "2026-07-30T12:00:02.000Z" },
    "the whole coalesced run backs the disclosure, not just the call the shimmer names — and the newest batch's clock rides with it, so an expanded pending card times itself",
  )

  // The INTER-CALL GAP: the label reverts to `Thinking…`, but history is still withholding the run, so
  // an expanded panel must keep showing it rather than emptying and refilling on the next call.
  second.status = "completed"
  const idle = coalesceToolActivityMessages([settled, pending])
  assert.equal(liveToolActivityTail(idle), undefined)
  assert.deepEqual(
    liveToolActivityRun(idle)?.tools,
    [first, second],
    "a settled-but-still-hidden run stays open across the gap",
  )

  // Prose ends the run, and with it the shimmer's claim on those calls — they return as history's own
  // digest, so the live disclosure must not also hold them.
  const prose: ChatMessage = {
    sourceId: "prose",
    role: "assistant",
    text: "Found it.",
    tools: [],
    parts: [{ kind: "text", text: "Found it." }],
  }
  assert.equal(
    liveToolActivityRun(coalesceToolActivityMessages([settled, pending, prose])),
    undefined,
  )
})

test("the runtime clock counts the live stretch, not the turn", () => {
  const first = tool("Read", { detail: "src/a.ts", status: "completed" })
  const second = tool("Grep", { detail: "renderActivity", status: "pending" })
  const settled = toolMessage("batch-a", [first])
  const pending = toolMessage("batch-b", [second], "2026-07-30T12:00:02.000Z")

  // The run opened at batch-a. `at` walks forward to batch-b so a pending card times itself against the
  // call it represents — the clock must NOT walk with it, or the count and the clock stop describing
  // the same run.
  const compact = coalesceToolActivityMessages([settled, pending])
  assert.equal(compact[0].runStartedAt, "2026-07-30T12:00:00.000Z")
  assert.equal(compact[0].message.at, "2026-07-30T12:00:02.000Z")
  assert.equal(liveRuntimeStartedAt(compact), "2026-07-30T12:00:00.000Z")

  // The inter-call gap is the same stretch: `Ran 2 tool calls. Thinking…` keeps the run's own clock.
  second.status = "completed"
  assert.equal(
    liveRuntimeStartedAt(coalesceToolActivityMessages([settled, pending])),
    "2026-07-30T12:00:00.000Z",
  )

  // Prose ends the run and opens a fresh stretch — the model is now reasoning past what it just wrote,
  // so the clock re-bases on that block rather than falling back to the turn's start.
  const prose: ChatMessage = {
    sourceId: "prose",
    role: "assistant",
    text: "Found it.",
    tools: [],
    parts: [{ kind: "text", text: "Found it." }],
    at: "2026-07-30T12:00:09.000Z",
  }
  assert.equal(
    liveRuntimeStartedAt(coalesceToolActivityMessages([settled, pending, prose])),
    "2026-07-30T12:00:09.000Z",
  )

  // A queued steer is pinned to the bottom of the pane, not drawn inline — it interrupts nothing, so it
  // must not become the stretch the clock times.
  const queued: ChatMessage = { sourceId: "steer", role: "user", text: "also check the tests", tools: [], parts: [], queued: true, at: "2026-07-30T12:00:11.000Z" }
  assert.equal(
    liveRuntimeStartedAt(coalesceToolActivityMessages([settled, pending, queued])),
    "2026-07-30T12:00:00.000Z",
  )

  // A steer that waited out the turn is drawn under that turn's rest: the stretch it opens begins at the
  // rest, not four seconds earlier when it was typed. A send that answers an older rest keeps its own instant.
  const rest: ChatMessage = { sourceId: "rest", role: "assistant", kind: "event", boundary: "rest", text: "Agent rested", tools: [], parts: [], at: "2026-07-30T12:00:15.000Z" }
  const waited: ChatMessage = { ...queued, restReply: true }
  assert.equal(liveRuntimeStartedAt(coalesceToolActivityMessages([prose, rest, waited])), "2026-07-30T12:00:15.000Z")
  assert.equal(liveRuntimeStartedAt(coalesceToolActivityMessages([prose, rest, { ...waited, queued: false, restReply: undefined }])), "2026-07-30T12:00:15.000Z")
  assert.equal(liveRuntimeStartedAt(coalesceToolActivityMessages([prose, rest, { ...waited, at: "2026-07-30T12:00:40.000Z" }])), "2026-07-30T12:00:40.000Z")

  assert.equal(liveRuntimeStartedAt([]), undefined)
})

test("a live tool tail is removed without hiding the prose that introduced it", () => {
  const pending = tool("Read", { detail: "src/render.tsx", status: "pending" })
  const lead: ChatMessage = {
    sourceId: "lead",
    role: "assistant",
    text: "I found the renderer.",
    tools: [pending],
    parts: [
      { kind: "text", text: "I found the renderer." },
      { kind: "tools", tools: [pending] },
    ],
  }

  const compact = coalesceToolActivityMessages([lead])
  const liveHistory = historicalToolActivityMessages(compact)
  assert.equal(liveToolActivityTail(compact), pending)
  assert.equal(liveHistory.length, 1)
  assert.equal(liveHistory[0].message.text, "I found the renderer.")
  assert.deepEqual(liveHistory[0].message.tools, [])
  assert.deepEqual(liveHistory[0].message.parts, [{ kind: "text", text: "I found the renderer." }])

  pending.status = "completed"
  const settledHistory = coalesceToolActivityMessages([lead])
  assert.equal(settledHistory[0].message.tools.length, 1)
  assert.deepEqual(settledHistory[0].message.parts?.map((part) => part.kind), ["text", "tools"])
})

test("only the final live tail leaves history; an earlier pending run ended by prose remains", () => {
  const earlier = toolMessage("earlier", [tool("Read", { status: "pending" })])
  const boundary: ChatMessage = {
    sourceId: "boundary",
    role: "assistant",
    text: "That check is complete.",
    tools: [],
    parts: [{ kind: "text", text: "That check is complete." }],
  }
  const latest = toolMessage("latest", [tool("Bash", { status: "pending" })])

  const history = historicalToolActivityMessages(
    coalesceToolActivityMessages([earlier, boundary, latest]),
  )
  assert.deepEqual(history.map((entry) => entry.message.sourceId), ["earlier", "boundary"])
  assert.equal(history[0].message.tools[0].status, "pending")
})

test("activity labels are gerunds with a clean fallback for arbitrary tools", () => {
  assert.equal(toolActivityLabel(tool("Read", { detail: "src/render.tsx" })), "Reading src/render.tsx")
  assert.equal(toolActivityLabel(tool("Grep", { detail: "ToolCalls" })), "Searching for ToolCalls")
  assert.equal(toolActivityLabel(tool("Bash", { desc: "Run focused tests", detail: "nub --test" })), "Running focused tests")
  assert.equal(toolActivityLabel(tool("Bash", { desc: "Checking generated output" })), "Checking generated output")
  assert.equal(
    toolActivityLabel(tool("Bash", { desc: "Find relative links in the README", detail: "rg -n ']\\(' README.md" })),
    "Finding relative links in the README",
    "an imperative description is converted, never prefixed with `Running`",
  )
  assert.equal(
    toolActivityLabel(tool("Bash", { desc: "Final workflow validation", detail: "cd /a/very/long/path && actionlint" })),
    "Final workflow validation",
    "an authored noun-phrase description suppresses the raw command fallback and is shown as written",
  )
  assert.equal(toolActivityLabel(tool("Todos")), "Updating the plan")
  assert.equal(toolActivityLabel(tool("mcp__example__frobnicate")), "Using frobnicate")
})

test("in-project absolute paths render project-relative in the live label", () => {
  const root = "/Users/me/Documents/projects/frizz"
  const edit = tool("Edit", { detail: `${root}/packages/web/src/lib/toolActivity.ts` })
  assert.equal(toolActivityLabel(edit, root), "Editing packages/web/src/lib/toolActivity.ts")
  // No root (a board snapshot that has not landed yet) leaves the label exactly as before.
  assert.equal(toolActivityLabel(edit), `Editing ${root}/packages/web/src/lib/toolActivity.ts`)
  assert.equal(toolActivityLabel(edit, `${root}/`), "Editing packages/web/src/lib/toolActivity.ts")

  // Every path in the label shortens, including the ones inside a Bash description's arguments and
  // the directory a Grep detail scopes to.
  assert.equal(
    toolActivityLabel(tool("Bash", { desc: `Compare ${root}/ui/a.ts against ${root}/ui/b.ts` }), root),
    "Comparing ui/a.ts against ui/b.ts",
  )
  assert.equal(
    toolActivityLabel(tool("Grep", { detail: `useProjectDir · ${root}/ui/packages/web` }), root),
    "Searching for useProjectDir · ui/packages/web",
  )

  // A worker's own worktree under the project keeps the directory that identifies it.
  assert.equal(
    toolActivityLabel(tool("Edit", { detail: `${root}/wt-relative-path/ui/a.ts` }), root),
    "Editing wt-relative-path/ui/a.ts",
  )

  // A sibling checkout that merely shares the prefix is NOT in the project, so it keeps its own path
  // (home-collapsed, not project-relative) — the trailing slash is part of the needle.
  assert.equal(
    toolActivityLabel(tool("Read", { detail: "/Users/me/Documents/projects/frizz-old/ui/a.ts" }), root),
    "Reading ~/Documents/projects/frizz-old/ui/a.ts",
  )
  // Outside the project the home prefix still collapses, inferred from the project root's own.
  assert.equal(
    toolActivityLabel(tool("Read", { detail: "/Users/me/.claude/CLAUDE.md" }), root),
    "Reading ~/.claude/CLAUDE.md",
  )
  assert.equal(
    toolActivityLabel(tool("Read", { detail: "/Users/me/.claude/CLAUDE.md" }), "/opt/checkouts/frizz"),
    "Reading /Users/me/.claude/CLAUDE.md",
  )
  // Anything with no home prefix stays absolute: there is no root that makes it shorter and honest.
  assert.equal(toolActivityLabel(tool("Read", { detail: "/etc/hosts" }), root), "Reading /etc/hosts")
  // A degenerate root would eat every leading slash; it is ignored instead.
  assert.equal(toolActivityLabel(tool("Read", { detail: "/etc/hosts" }), "/"), "Reading /etc/hosts")
  assert.equal(toolActivityLabel(tool("Read", { detail: "/etc/hosts" }), ""), "Reading /etc/hosts")
})

test("the newest call drives the live gerund even when an earlier call remains pending", () => {
  const earlier = tool("Read", { detail: "src/old.ts", status: "pending" })
  const newest = tool("Bash", { desc: "Inspect PR review state and comments", status: "completed" })
  const compact = coalesceToolActivityMessages([toolMessage("parallel", [earlier, newest])])
  assert.equal(liveToolActivityTail(compact), newest)
  assert.equal(toolActivityLabel(newest), "Inspecting PR review state and comments")

  // …and when that straggler lands too, nothing in the batch is executing any more.
  earlier.status = "completed"
  const drained = coalesceToolActivityMessages([toolMessage("parallel", [earlier, newest])])
  assert.equal(liveToolActivityTail(drained), undefined)
})

test("a failed or cancelled result ends the gerund exactly like a completed one", () => {
  for (const status of ["failed", "cancelled"] as const) {
    const compact = coalesceToolActivityMessages([toolMessage(status, [tool("Bash", { detail: "nub test", status })])])
    assert.equal(
      liveToolActivityTail(compact),
      undefined,
      `a ${status} call is no longer executing`,
    )
  }
})

test("a pre-restart transcript with no statuses keeps naming its newest call", () => {
  // Completion is simply not observable on this data, so the gerund is the best reading available —
  // falling to a permanent `Thinking…` for the whole turn would be strictly worse.
  const newest = tool("Grep", { detail: "resolver" })
  const compact = coalesceToolActivityMessages([toolMessage("legacy", [tool("Read", { detail: "src/a.ts" }), newest])])
  assert.equal(liveToolActivityTail(compact), newest)
})

test("the newest pending call drives the live label, then the final call drives settled history", () => {
  const pending = tool("Read", { status: "pending" })
  assert.deepEqual(
    currentToolActivity([
      tool("Grep", { status: "completed" }),
      pending,
      tool("Bash", { status: "completed" }),
    ]),
    { tool: pending, pending: true },
  )
  const settled = [tool("Read", { status: "completed" }), tool("Edit", { status: "failed" })]
  assert.deepEqual(currentToolActivity(settled), { tool: settled[1], pending: false })
  assert.equal(settledToolActivityLabel(1), "Ran 1 tool call")
  assert.equal(settledToolActivityLabel(settled.length), "Ran 2 tool calls")
})

test("the digest reports how many distinct files the run edited", () => {
  assert.equal(settledToolActivityLabel(27, 4), "Ran 27 tool calls, edited 4 files")
  assert.equal(settledToolActivityLabel(3, 1), "Ran 3 tool calls, edited 1 file")
  // A run that wrote nothing keeps the bare reading rather than trailing an "edited 0 files".
  assert.equal(settledToolActivityLabel(3, 0), "Ran 3 tool calls")
})

test("the inter-call gap states the run it is standing in for, so waiting reads as progress", () => {
  // The alternation the maintainer asked for (2026-08-08): a count, the next call's own gerund, then the
  // count one higher. Only the generic half is this helper's — the gerund comes from toolActivityLabel.
  assert.equal(thinkingToolActivityLabel(23), "Ran 23 tool calls. Thinking…")
  assert.equal(thinkingToolActivityLabel(24), "Ran 24 tool calls. Thinking…")
  assert.equal(thinkingToolActivityLabel(1), "Ran 1 tool call. Thinking…")
  // The opening of a turn, and the pause right after prose closed a run: there is nothing to report yet,
  // and `Ran 0 tool calls` would be a claim about the turn that is worse than saying nothing.
  assert.equal(thinkingToolActivityLabel(0), "Thinking…")
  // Never the digest's file tail. The row truncates at one line, and the half that has to survive a
  // narrow pane is the one saying the model is still going.
  assert.doesNotMatch(thinkingToolActivityLabel(9), /edited/)
})

test("edited files are counted once per file, whatever shape the write arrived in", () => {
  assert.equal(editedFileCount([]), 0)
  assert.equal(editedFileCount([{ name: "Read", detail: "src/a.ts" }, { name: "Bash", detail: "rm src/b.ts" }]), 0)
  assert.equal(
    editedFileCount([
      // The collapsed shape merges consecutive edits to one file into a single `edits` entry.
      { name: "Edit", detail: "src/a.ts", edits: [{ file: "src/a.ts" }, { file: "src/a.ts" }] },
      { name: "Edit", detail: "src/a.ts", edit: { file: "src/a.ts" } },
      // A creation reads as an edit — Write ships the whole file as the new side.
      { name: "Write", detail: "src/b.ts", edit: { file: "src/b.ts" } },
      { name: "Read", detail: "src/c.ts" },
    ]),
    2,
  )
  // A codex apply_patch the server could not reconstruct (a Delete File, a multi-file hunk) arrives
  // named Edit with the file only in `detail`.
  assert.equal(editedFileCount([{ name: "Edit", detail: "src/gone.ts" }, { name: "apply_patch", detail: "src/gone.ts" }]), 1)
  // A `${…}` left in a path is a codex exec-wrapper placeholder the server could not fill, not a file.
  assert.equal(editedFileCount([{ name: "Edit", detail: "${dir}/a.ts", edit: { file: "${dir}/a.ts" } }, { name: "apply_patch", detail: "${p}" }]), 0)
})

function eventMessage(sourceId: string, text: string, at = "2026-07-30T12:00:01.000Z"): ChatMessage {
  return { sourceId, role: "assistant", kind: "event", text, tools: [], parts: [], at }
}

test("a queued steer is transparent to the run it sits inside", () => {
  // The bubble is pinned to the BOTTOM of the pane and never drawn inline, so nothing visible separates
  // the calls either side of it. It used to end the run anyway: the calls above stranded into a settled
  // `Ran N tool calls` digest, and the thought below — the next turn's opening pause — found no run to
  // fold into and took a row of its own (maintainer 2026-08-01: "I thought we'd dropped the 'thought for
  // the x seconds' thing entirely").
  const steer: ChatMessage = {
    sourceId: "steer", role: "user", queued: true,
    text: "So we still require TMUX?", tools: [], parts: [],
  }
  const compact = coalesceToolActivityMessages([
    toolMessage("a", [tool("Bash", { detail: "git log" })]),
    steer,
    toolMessage("b", [tool("Bash", { detail: "git diff" })], "2026-07-30T12:00:02.000Z"),
  ])

  // The bubble keeps its slot — the callers that pin it read this list — but the run is unbroken.
  assert.deepEqual(compact.map((entry) => entry.message.sourceId), ["a", "steer"])
  assert.deepEqual(compact[0].message.tools.map((call) => call.detail), ["git log", "git diff"])
})

test("a DELIVERED steer still ends the run", () => {
  // The control for the case above: once the bubble lands it is a real inline message, so the calls
  // either side of it belong to two different turns and must not share one disclosure.
  const steer: ChatMessage = {
    sourceId: "steer", role: "user",
    text: "So we still require TMUX?", tools: [], parts: [],
  }
  const compact = coalesceToolActivityMessages([
    toolMessage("a", [tool("Bash", { detail: "git log" })]),
    steer,
    toolMessage("b", [tool("Bash", { detail: "git diff" })], "2026-07-30T12:00:02.000Z"),
  ])

  assert.deepEqual(compact.map((entry) => entry.message.sourceId), ["a", "steer", "b"])
})

test("a quiet event line still ends the run it follows", () => {
  // Thinking no longer reaches the client at all, but a compaction note / "Agent … finished" line does,
  // and those are real transcript punctuation: the calls either side of one are not one batch.
  const compact = coalesceToolActivityMessages([
    toolMessage("a", [tool("Bash", { detail: "git log" })]),
    eventMessage("c", "Context compacted"),
    toolMessage("b", [tool("Bash", { detail: "git diff" })], "2026-07-30T12:00:02.000Z"),
  ])

  assert.deepEqual(compact.map((entry) => entry.message.sourceId), ["a", "c", "b"])
})

test("a wake divider is not thinking and still ends the run", () => {
  const boundary: ChatMessage = {
    sourceId: "wake", role: "assistant", kind: "event", boundary: "wake",
    text: "Background task «boot» finished", tools: [], parts: [],
  }
  const compact = coalesceToolActivityMessages([
    toolMessage("a", [tool("Bash")]),
    boundary,
    toolMessage("b", [tool("Bash")]),
  ])

  assert.deepEqual(compact.map((entry) => entry.message.sourceId), ["a", "wake", "b"])
})

test("the newest call in the landed tail names the live gerund", () => {
  const compact = coalesceToolActivityMessages([
    toolMessage("a", [tool("Bash", { detail: "git log", status: "completed" }), tool("Grep", { detail: "resolver", status: "pending" })]),
  ])
  const live = liveToolActivityTail(compact)

  assert.equal(live?.name, "Grep")
  assert.equal(currentToolActivity(compact[0].message.tools).tool?.name, "Grep")
})

// The maintainer's screenshot: the shimmer read "Restarting the census sweep · 11m 57s" for a shell they
// had force-killed two days earlier. The server pins a below-the-window background launch at the TAIL of
// the transcript, and the retirement projection used to strip `backgroundState` off it — which left the
// killed shell as the newest ordinary call in the tail, and this function handed its description to the
// shimmer. The field survives now, and since 2026-09-13 a FINISHED background op folds into the run like
// any other settled call — so the guard is no longer "it keeps its card" but "the gerund never names it",
// even when a live call sits beside it in the same run.
test("a retired background op never becomes the live gerund", () => {
  const retired = toolMessage("pinned-bg:abc", [
    tool("Bash", { command: "node census.ts", desc: "Restart the census sweep", backgroundState: "background", status: "cancelled", shellId: "toolu_sh" }),
  ])
  const compact = coalesceToolActivityMessages([toolMessage("a", [tool("Read", { detail: "src/a.ts", status: "completed" })]), retired])

  assert.equal(isToolActivityException(retired.tools[0]), false, "a killed shell is history, not a handle on anything")
  assert.equal(compact.length, 1, "so it folds into the run above it")
  assert.equal(liveToolActivityTail(compact), undefined)

  // The dangerous shape: the pinned launch lands as the LAST call of a run that is still executing.
  const straggler = tool("Read", { detail: "src/b.ts", status: "pending" })
  const live = coalesceToolActivityMessages([toolMessage("a", [straggler]), retired])
  assert.equal(live.length, 1)
  assert.equal(liveToolActivityTail(live), straggler, "the newest call that is NOT a finished detached op drives the gerund")
})

// A background shell's card is the reader's handle on a process that outlives the batch — and only that.
// Once its terminal <task-notification> has landed the card drew no mark and read `done · 20s` exactly like
// a foreground Bash, yet still stood alone between two digests: `Ran 43 tool calls` / the card / `Ran 1
// tool call`, with nothing on it saying why (maintainer 2026-09-12: "why this random uncollapsed bash
// call??", then "Fold it once finished"). The completion wake divider is the visible record of the run.
test("a background shell keeps its own card while it runs and folds into the run once finished", () => {
  const shell = (status: TranscriptToolCall["status"]) =>
    tool("Bash", { command: "cargo check", desc: "Type-checking the standalone phantom eval tool", backgroundState: "background", status })
  const before = tool("Read", { detail: "src/a.ts", status: "completed" })
  const after = tool("Edit", { detail: "src/a.ts", status: "completed" })

  assert.equal(isToolActivityException(shell("pending")), true, "still going — the card is the only handle on it")
  const running = coalesceToolActivityMessages([toolMessage("a", [before]), toolMessage("bg", [shell("pending")]), toolMessage("c", [after])])
  assert.deepEqual(running.map((entry) => entry.message.sourceId), ["a", "bg", "c"], "a live launch splits the run: digest / card / digest")

  for (const status of ["completed", "failed", "cancelled"] as const) {
    assert.equal(isToolActivityException(shell(status)), false, `${status}: the process is gone, the card points at nothing`)
    const finished = coalesceToolActivityMessages([toolMessage("a", [before]), toolMessage("bg", [shell(status)]), toolMessage("c", [after])])
    assert.deepEqual(finished.map((entry) => entry.message.sourceId), ["a"], `${status}: one digest`)
    assert.deepEqual(finished[0].message.tools.map((call) => call.name), ["Read", "Bash", "Edit"], `${status}: carrying the shell in order`)
  }

  // A status-less call is a pre-restart transcript where completion is unobservable; it keeps its card,
  // like every other reading that treats "no status" as "not settled".
  assert.equal(isToolActivityException(shell(undefined)), true)
  // The `"unknown"` job never gets a completion signal, so settling the CALL is not the process ending.
  assert.equal(isToolActivityException(tool("Bash", { command: "node worker.mjs &", backgroundState: "unknown", status: "failed" })), true)
})

test("a Windows project root shortens labels the same way, and the board's homeDir collapses to ~ (Windows audit 2026-09-11, finding 12)", () => {
  // Before the audit a root that did not start with `/` bailed, so every label read the whole path.
  const root = "C:\\Users\\me\\proj"
  assert.equal(toolActivityLabel(tool("Edit", { detail: `${root}\\src\\a.ts` }), root), "Editing src\\a.ts")
  assert.equal(toolActivityLabel(tool("Edit", { detail: `${root}\\src\\a.ts` }), `${root}\\`), "Editing src\\a.ts")
  // The drive letter is case-insensitive and either separator matches; the remainder keeps its own.
  assert.equal(toolActivityLabel(tool("Edit", { detail: "c:/Users/me/proj/src/a.ts" }), root), "Editing src/a.ts")
  assert.equal(
    toolActivityLabel(tool("Bash", { desc: `Compare ${root}\\ui\\a.ts against ${root}/ui/b.ts` }), root),
    "Comparing ui\\a.ts against ui/b.ts",
  )
  // A sibling checkout is not in the project; it collapses to the home guessed from `C:\Users\<name>`.
  assert.equal(toolActivityLabel(tool("Read", { detail: "C:\\Users\\me\\proj-old\\a.ts" }), root), "Reading ~\\proj-old\\a.ts")
  assert.equal(toolActivityLabel(tool("Read", { detail: "C:\\Users\\me\\.claude\\CLAUDE.md" }), root), "Reading ~\\.claude\\CLAUDE.md")
  // The board's own homeDir beats the guess: a repo under `D:\` or `/opt` still collapses the home.
  assert.equal(
    toolActivityLabel(tool("Read", { detail: "C:\\Users\\me\\.claude\\CLAUDE.md" }), "D:\\src\\proj", "C:\\Users\\me"),
    "Reading ~\\.claude\\CLAUDE.md",
  )
  assert.equal(
    toolActivityLabel(tool("Read", { detail: "/Users/me/.claude/CLAUDE.md" }), "/opt/checkouts/frizz", "/Users/me"),
    "Reading ~/.claude/CLAUDE.md",
  )
  // Another drive and a degenerate root stay as they are.
  assert.equal(toolActivityLabel(tool("Read", { detail: "D:\\other\\a.ts" }), root), "Reading D:\\other\\a.ts")
  assert.equal(toolActivityLabel(tool("Read", { detail: "C:\\Windows\\hosts" }), "C:\\"), "Reading C:\\Windows\\hosts")
})

test("an agent's own shell tool reads as running its command once the command is known", () => {
  assert.equal(toolActivityLabel({ name: "shell" }), "Running a command")
  assert.equal(toolActivityLabel({ name: "shell", detail: "sleep 40", command: "sleep 40" }), "Running sleep 40")
  assert.equal(toolActivityLabel({ name: "Reading it: shell", detail: "cat hello.txt", command: "cat hello.txt" }), "Running cat hello.txt")
})
