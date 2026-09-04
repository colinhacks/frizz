import type { TranscriptMessage, TranscriptToolCall } from "@frizz/shared"
import type { ChatMessage } from "../hooks.ts"

export interface ToolActivityMessage {
  message: ChatMessage
  /** Index in the unmodified transcript array. */
  messageIndex: number
  /**
   * When this entry's tool run BEGAN — the first batch's `at`, held still as later batches fold in.
   *
   * `message.at` advances to the newest batch (a pending card has to time itself against the call it
   * represents), so once a run has grown the entry no longer remembers where it started. The bottom
   * runtime slot's clock needs exactly that instant, and nothing else records it.
   */
  runStartedAt?: string
}

// Calls that DISPATCH a child, address one, or block on one, recognized by NAME — the shapes that carry
// no structural signal of their own. See isToolActivityException for why they never fold into a run.
const SUB_AGENT_TOOL_NAMES = new Set([
  "agent",
  "follow up",
  "interrupt",
  "send message",
  "spawn agent",
  "wait for agents",
])

// Codex's two yielded-process poll cards — `wait` on a script cell, and the `write_stdin` exec wrapper
// on a PTY session. See orphanedPoll.
const POLL_TOOL_NAMES = new Set(["poll process", "wait"])

function readableToolName(name: string): string {
  const segment = name.split("__").pop() || name
  return segment.replaceAll("_", " ").trim()
}

function normalizedToolName(name: string): string {
  return readableToolName(name).toLowerCase()
}

/**
 * Calls that keep their dedicated card instead of entering the minimal activity disclosure.
 *
 * Three families qualify. The first two qualify for the SAME reason: the call LAUNCHES something that
 * outlives it, so the card is not a record of work already done — it is the only handle the reader has on
 * work still running (or on a process that ran detached and finished while they were reading something
 * else).
 *
 *   • A DISPATCH — it starts, addresses or blocks on a child agent.
 *   • A BACKGROUND op — `run_in_background` Bash and Monitor (`backgroundState: "background"`), plus the
 *     blocked `&` job the Bash parser flags `"unknown"`. These used to fold into
 *     the run like any other call, which meant a detached dev server, a CI watcher and a wait-for-agents
 *     poller were all invisible behind `Ran 7 tool calls` — the one class of call whose whole point is
 *     that it is still going after the batch that started it (maintainer 2026-08-01: "eject background
 *     tasks from the tool call collapsing logic. It's important that those show up in the chat").
 *     An ORPHANED POLL wears the same `"unknown"` and is deliberately NOT here — see orphanedPoll.
 *   • A call whose RESULT IS A PICTURE — an image `Read`, a `take_screenshot`, a SendUserFile delivery
 *     carrying images. The reason is different but no weaker: the whole content of the card is something
 *     the human has to LOOK at, and a digest reduces it to the one thing a picture cannot survive being
 *     reduced to — a word. A worker reading back its own screenshots produced exactly `2 tool calls ·
 *     Click to expand` with both shots hidden behind it (maintainer 2026-08-02: "the screenshots should
 *     just be rendered in the chat automatically").
 *
 *   • A SETTLED native ask (`AskUserQuestion` carrying its structured questions, with a result). The
 *     question was ON SCREEN as an answerable card until it settled; folding it into `Ran N tool calls`
 *     is how an unanswered question vanished from the transcript the moment the operator steered past
 *     it (maintainer 2026-08-30: "the questions should continue to render as they were from earlier in
 *     the transcript, even if they weren't answered"). A PENDING ask stays foldable: while it is live,
 *     the interaction stack owns the answerable copy, and history must not draw it twice.
 *
 * Deliberately NOT here: codex's `list_agents` ("Agents · list live agents"), which is a plain READ of
 * the roster — it starts nothing, addresses nobody, and its whole body is a one-line count, so a model
 * that polls it mid-burst was splitting one batch into `Ran 1 tool call` / a standalone Agents card /
 * `Ran 4 tool calls` (maintainer 2026-07-31: "The agent listing should not be specially handled here.
 * It's a tool call like any other"). Nor a SendUserFile carrying only NON-image files: that renders as a
 * row of openable chips, which the digest's label already describes as well as the card would.
 */
export function isToolActivityException(tool: Pick<
  TranscriptToolCall,
  "name" | "prompt" | "agentId" | "sendTo" | "sendBody" | "backgroundState" | "outputImage" | "sentImages" | "ask" | "status"
>): boolean {
  return tool.prompt !== undefined
    || tool.agentId !== undefined
    || tool.sendTo !== undefined
    || tool.sendBody !== undefined
    || (tool.backgroundState !== undefined && !orphanedPoll(tool))
    || isPictureTool(tool)
    || isSettledAsk(tool)
    || SUB_AGENT_TOOL_NAMES.has(normalizedToolName(tool.name))
}

/** A native AskUserQuestion that has SETTLED — its result landed, answered or not. This is the copy the
 *  transcript renders as a read-only question card; a pending one is drawn by the interaction stack
 *  (broker path) or the frozen-ask banner instead, never from history. */
export function isSettledAsk(tool: Pick<TranscriptToolCall, "ask" | "status">): boolean {
  return tool.ask !== undefined && tool.ask.length > 0 && tool.status !== undefined && tool.status !== "pending"
}

/**
 * A call whose card IS a picture — an image `Read`, a `take_screenshot`, a SendUserFile delivery
 * carrying images.
 *
 * Every other exception above renders as a compact band a couple of rows tall, which is what lets the
 * transcript's tight run (ChatView.META_CARD_STEP) sit them 6px apart: two faint borders with 6px of
 * clear space between them still read as two objects. A picture breaks that premise on both counts —
 * it is a tall block of arbitrary content, usually a dark screenshot whose own edges land near the
 * frame's, so at the run pitch the next row reads as glued to the bottom of the image rather than as
 * the next statement (maintainer 2026-08-11, on an image `Read` under the live shimmer: "we need better
 * spacing under the screenshots … it's too close"). ChatView.PICTURE_STEP is the answer; this predicate
 * is who it applies to.
 */
export function isPictureTool(tool: Pick<TranscriptToolCall, "outputImage" | "sentImages">): boolean {
  return tool.outputImage !== undefined || (tool.sentImages !== undefined && tool.sentImages.length > 0)
}

/**
 * A codex `Wait` / `Poll process` the projector could not pair with the launch it belongs to.
 *
 * It reaches the client `pending` and `backgroundState: "unknown"` — honest about the fact that frizz
 * cannot say whether that process is alive (transcript.ts, the `orphanPoll` branch) — but that is the
 * one background shape which LAUNCHED NOTHING. It is a read of somebody else's process, so the card is
 * not a handle on anything: it names a cell id the reader cannot act on, and because the call never
 * settles it wears a duration that counts up forever. A codex model that long-polls a gate emits
 * hundreds of them, and every one was landing as its own card — 888 in one measured rollout, rendering
 * as `Wait · cell 29 · unknown` / `Poll process · session 98949 · unknown` all the way down the queue
 * card (maintainer 2026-08-09). So an orphaned poll is ordinary disposable chatter and folds into the
 * run like any other call. The genuinely detached shapes above are untouched.
 *
 * Keyed on the poll NAMES rather than on `"unknown"` alone: a Bash command with an escaping `&` job
 * wears the same state and DID launch something that outlives the call, so it keeps its card.
 */
function orphanedPoll(tool: Pick<TranscriptToolCall, "name" | "backgroundState">): boolean {
  return tool.backgroundState === "unknown" && POLL_TOOL_NAMES.has(normalizedToolName(tool.name))
}

function pureToolMessage(message: ChatMessage): TranscriptToolCall[] | null {
  if (message.role !== "assistant" || message.kind || message.queued) return null
  if (message.parts && message.parts.length > 0) {
    const tools: TranscriptToolCall[] = []
    for (const part of message.parts) {
      if (part.kind === "text") {
        if (part.text.trim()) return null
      } else {
        tools.push(...part.tools)
      }
    }
    return tools.length > 0 && tools.every((tool) => !isToolActivityException(tool)) ? tools : null
  }
  if (message.text.trim() || message.tools.length === 0) return null
  return message.tools.every((tool) => !isToolActivityException(tool)) ? message.tools : null
}

// A provider can emit an assistant shell that contains no renderable content between two calls
// (Codex result/bracket records do this frequently). It is not a transcript boundary merely because
// it received a source id.
function transparentAssistantMessage(message: ChatMessage): boolean {
  if (message.role !== "assistant" || message.kind || message.queued) return false
  if (message.text.trim() || message.tools.length > 0) return false
  return !message.parts?.some((part) =>
    part.kind === "text" ? part.text.trim().length > 0 : part.tools.length > 0,
  )
}

// A prose-bearing message may END with tools: the prose closes the previous activity run and its tool
// tail starts the next one. Subsequent pure-tool provider messages belong to that tail until another
// visible block arrives. Dedicated tool cards are themselves visible blocks and therefore do not
// qualify as a mergeable tail — but calls batched AFTER one in the same part are the next run and do.
function messageToolTail(message: ChatMessage): TranscriptToolCall[] | null {
  if (message.role !== "assistant" || message.kind || message.queued) return null
  // Without parts the text renders ahead of the tools, so the trailing run is still the tail.
  if (!message.parts?.length) return trailingOrdinaryRun(message.tools)
  for (let i = message.parts.length - 1; i >= 0; i--) {
    const part = message.parts[i]
    if (part.kind === "text") {
      if (part.text.trim()) return null
      continue
    }
    if (part.tools.length === 0) continue
    return trailingOrdinaryRun(part.tools)
  }
  return null
}

// The ordinary calls at the END of a batch, stopping at the newest exception card. The server folds
// consecutive tool blocks into one part (appendToolPart), so a dispatch and the calls issued beside it
// share a part — all-or-nothing here left everything after the card unable to seed a run.
function trailingOrdinaryRun(tools: readonly TranscriptToolCall[]): TranscriptToolCall[] | null {
  const tail: TranscriptToolCall[] = []
  for (let i = tools.length - 1; i >= 0; i--) {
    if (isToolActivityException(tools[i])) break
    tail.unshift(tools[i])
  }
  return tail.length > 0 ? tail : null
}

// The mirror of messageToolTail: a message's LEADING ordinary calls, up to the first visible block —
// prose or a dedicated card. A provider can batch an ordinary call and a dispatch into ONE assistant
// message ([ToolSearch, Agent] between thinking blocks), and all-or-nothing folding left that leading
// call stranded as its own `Ran 1 tool call` digest directly under the previous run's — two successive
// one-call digests where the reader sees one unbroken run (maintainer 2026-08-26: "seeing 2 successive
// uncollapsed tool calls"). Worse, LIVE it did merge — the batch's exception had not landed yet, so the
// message was still pure — and then split retroactively when the dispatch block arrived. Returns null
// when there is nothing to strip, or when no visible block bounds the prefix (that message is pure and
// the whole-message fold owns it).
function messageToolPrefix(message: ChatMessage): TranscriptToolCall[] | null {
  if (message.role !== "assistant" || message.kind || message.queued) return null
  const prefix: TranscriptToolCall[] = []
  // Returns true when it hits the bounding exception call.
  const scan = (tools: TranscriptToolCall[]): boolean => {
    for (const tool of tools) {
      if (isToolActivityException(tool)) return true
      prefix.push(tool)
    }
    return false
  }
  if (!message.parts?.length) {
    // Without parts the text renders ahead of the tools, so any prose disqualifies the whole prefix.
    if (message.text.trim()) return null
    return scan(message.tools) && prefix.length > 0 ? prefix : null
  }
  for (const part of message.parts) {
    if (part.kind === "text") {
      if (!part.text.trim()) continue
      return prefix.length > 0 ? prefix : null
    }
    if (scan(part.tools)) return prefix.length > 0 ? prefix : null
  }
  return null
}

function withoutToolPrefix(message: ChatMessage, prefix: readonly TranscriptToolCall[]): ChatMessage {
  return withoutToolCalls(message, new Set(prefix))
}

// Strip a set of calls from a message, by call IDENTITY — the only key a run has, since a call carries
// no id of its own on the client. Where the flat list comes from is the whole trick: a message off the
// wire carries every call TWICE, as two separate objects — once in the flat `tools` and once inside
// `parts` — and identity found in `parts` (where messageToolTail and messageToolPrefix look) never
// matches the flat copy. Filtering the flat list by that identity left the run's FIRST call behind in
// `tools` while `parts` emptied; the renderer, seeing no parts, fell back to the flat list and drew a
// settled `Ran 1 tool call` directly above a shimmer already counting the same call (maintainer
// 2026-08-27: "back-to-back tool calls like this are not supposed to happen"). Reproduced on a replayed
// transcript: every run that OPENS on a pure tool batch — right under the human's ask — paid it, because
// only a run opened by prose keeps a text part that hides the fallback. So when the message has parts,
// the flat list is DERIVED from what survives in them; a part-less legacy message filters it directly.
function withoutToolCalls(message: ChatMessage, drop: ReadonlySet<TranscriptToolCall>): ChatMessage {
  if (!message.parts?.length) return { ...message, tools: message.tools.filter((tool) => !drop.has(tool)) }
  const parts = message.parts
    .map((part) => (part.kind === "text" ? part : { kind: "tools" as const, tools: part.tools.filter((tool) => !drop.has(tool)) }))
    .filter((part) => part.kind === "text" || part.tools.length > 0)
  return { ...message, tools: parts.flatMap((part) => (part.kind === "tools" ? part.tools : [])), parts }
}

function appendToolTail(message: ChatMessage, tools: TranscriptToolCall[], at?: string): ChatMessage {
  const combinedTools = [...message.tools, ...tools]
  const parts = message.parts?.map((part) =>
    part.kind === "text" ? part : { ...part, tools: [...part.tools] },
  ) ?? []
  let tailIndex = -1
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i]
    if (part.kind === "text") {
      if (part.text.trim()) break
      continue
    }
    if (part.tools.length > 0) {
      tailIndex = i
      break
    }
  }
  const tailPart = parts[tailIndex]
  if (tailPart?.kind === "tools") {
    parts[tailIndex] = { kind: "tools", tools: [...tailPart.tools, ...tools] }
  } else {
    parts.push({ kind: "tools", tools })
  }
  return {
    ...message,
    at: at ?? message.at,
    tools: combinedTools,
    parts,
  }
}

/**
 * Coalesce a visible activity run into one presentation message.
 *
 * Providers split a long tool run into several assistant messages and sometimes insert empty assistant
 * records between calls. Neither is visible, so neither can mint another loader/digest. A prose-bearing
 * message's final tools part starts a fresh run after that prose. A dedicated block tool (sub-agent,
 * send, etc.) ends it — but ordinary calls batched AHEAD of it in the same message still belong to the
 * run above (messageToolPrefix). The first source id remains stable as the run grows, while `at` advances to the
 * latest batch so a pending card's clock still starts from the call it represents. `runStartedAt` keeps
 * the instant `at` is walking away from — the one the runtime slot's own clock counts from.
 */
export function coalesceToolActivityMessages(messages: readonly ChatMessage[]): ToolActivityMessage[] {
  const out: ToolActivityMessage[] = []
  let activityTail: ToolActivityMessage | null = null

  messages.forEach((message, messageIndex) => {
    if (transparentAssistantMessage(message)) return
    // A QUEUED bubble is pinned to the BOTTOM of the pane and never drawn inline (every row builder
    // skips it), so it is not a visible block between the messages it happens to sit between — and it
    // must not end a run. It used to: a steer typed mid-turn split one live run in two, stranding the
    // calls above it as a settled `Ran N tool calls` digest for no cause the reader could see. It still
    // takes its slot in `out` — the callers that pin it read this list — it simply leaves `activityTail`
    // alone.
    if (message.queued) {
      out.push({ message, messageIndex })
      return
    }
    const tools = pureToolMessage(message)
    if (tools && activityTail) {
      activityTail.message = appendToolTail(activityTail.message, tools, message.at)
      return
    }
    // A message the whole-message fold rejected can still OPEN with ordinary calls — the reader sees
    // them as the run above continuing, so they move up into it and only the visible block that bounded
    // them (and whatever follows) keeps this row.
    const prefix = activityTail ? messageToolPrefix(message) : null
    const entryMessage = prefix ? withoutToolPrefix(message, prefix) : message
    if (prefix && activityTail) {
      activityTail.message = appendToolTail(activityTail.message, prefix, message.at)
    }
    const entry: ToolActivityMessage = { message: entryMessage, messageIndex }
    out.push(entry)
    if (messageToolTail(entryMessage)) {
      entry.runStartedAt = entryMessage.at
      activityTail = entry
    } else {
      activityTail = null
    }
  })

  return out
}

/** A call whose result has landed — it is no longer occupying the runtime, whatever its outcome. */
function settledToolCall(tool: Pick<TranscriptToolCall, "status">): boolean {
  return tool.status === "completed" || tool.status === "failed" || tool.status === "cancelled"
}

/**
 * The newest ordinary call in the landed assistant tail, while ANY call in that tail is STILL RUNNING.
 *
 * The gerund is a claim that a tool is executing right now, so it has to stop the moment the last result
 * lands: from there until the next call appears, the model is reading what came back and deciding what to
 * do with it, which is what the bottom slot's `Thinking…` says (returning undefined is how the caller
 * gets it). Without this the label pinned the last call's gerund across the whole inter-call gap, and a
 * model that spends thirty seconds reasoning over a returned file reads as `Reading foo.ts` that has hung
 * — the tool finished in 18ms (maintainer 2026-08-04: "it seems like a tool call is hanging for a long
 * time, but it's only because the tool call has already completed and the agent is thinking about the
 * results").
 *
 * ANY, not the newest one specifically: a parallel batch returns out of order, and the newest call
 * settling first must not blank the label while its siblings are still executing. The newest call still
 * NAMES the activity in that case (3386b01) — one of several concurrent gerunds has to win, and the
 * newest is the stable pick, because an earlier call finishing cannot then shuffle the label.
 *
 * A call with NO status at all is a pre-restart transcript, where completion is simply not observable —
 * those keep the previous always-name-the-newest reading rather than falling to a permanent `Thinking…`.
 *
 * This is the LABEL half only. History still hides the whole run until a visible block or the turn's end
 * (see historicalToolActivityMessages): the digest must not flash in the same gap, which is the other
 * half of what 3386b01 fixed and stays fixed.
 */
export function liveToolActivityTail(entries: readonly ToolActivityMessage[]): TranscriptToolCall | undefined {
  const run = liveToolActivityRun(entries)
  return run?.tools.some((tool) => !settledToolCall(tool)) ? run.tools.at(-1) : undefined
}

/**
 * The WHOLE run the shimmer stands for — every call historicalToolActivityMessages is withholding —
 * with the emitting message's `at`, so an expanded pending card can time itself like any other. The instant
 * the run OPENED is a different question with a different reader — see liveRuntimeStartedAt.
 *
 * The shimmer names one call; expanding it has to show all of them, so this returns the run rather than
 * its newest member. Deliberately NOT status-gated, unlike liveToolActivityTail: history withholds the
 * tail for as long as the turn runs, settled or not, and an expanded panel that emptied itself in every
 * inter-call gap and refilled on the next call would be the same row-jumping flicker withoutLiveToolTail
 * exists to prevent. So the label falls to `Thinking…` in that gap while the calls stay put underneath.
 */
export function liveToolActivityRun(
  entries: readonly ToolActivityMessage[],
): { tools: TranscriptToolCall[]; at?: string } | undefined {
  const entry = newestLandedEntry(entries)
  if (!entry) return undefined
  const tools = messageToolTail(entry.message)
  return tools ? { tools, at: entry.message.at } : undefined
}

/** The newest entry the turn has actually landed — a queued bubble is pinned elsewhere and interrupts nothing. */
function newestLandedEntry(entries: readonly ToolActivityMessage[]): ToolActivityMessage | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!entries[i].message.queued) return entries[i]
  }
  return undefined
}

/**
 * When the model's CURRENT stretch of work began — the instant the bottom runtime slot's clock counts from.
 *
 * The slot reports one live stretch: the run it names call by call, or the generating pause that follows the
 * last visible block. So the clock belongs to that stretch, not to the turn. It used to count from
 * `thread.lastUserAt`, which on an autonomously-driven thread is the last time a HUMAN spoke — hours back —
 * so a model three calls into a fresh burst was captioned `Ran 3 tool calls` beside `2h 14m` (maintainer
 * 2026-08-08: "does not reflect the amount of time since the start of that block of tool calls. I believe it
 * reflects the total session run time thus far"). The count and the clock now describe the same run.
 *
 * The newest landed entry supplies it: a live run's own opening batch (`runStartedAt`, which survives the
 * coalescing that walks `at` forward), or otherwise that block's `at` — the prose the model is reasoning past,
 * the dispatch it just made, the turn's own opening message. Undefined only for an empty transcript or a
 * pre-restart record with no timestamp, where the caller falls back to the turn.
 */
export function liveRuntimeStartedAt(entries: readonly ToolActivityMessage[]): string | undefined {
  const entry = newestLandedEntry(entries)
  if (!entry) return undefined
  return messageToolTail(entry.message) ? entry.runStartedAt ?? entry.message.at : entry.message.at
}

/**
 * The instant a transcript row should READ as, for the per-message hover timestamp.
 *
 * For an ordinary message that is just `message.at`. For a COALESCED tool run it is not: `appendToolTail`
 * walks `at` forward to each newest batch as they fold in, so a settled "Ran 12 tool calls" digest
 * spanning minutes carries the instant the run FINISHED. A reader hovering a band asks when it started —
 * the same reading `liveRuntimeStartedAt` gives the runtime slot's clock, and the same precedence.
 *
 * No tail check, and a tail check would be WRONG. While the turn runs, `historicalToolActivityMessages`
 * strips the live tail off the run's opener — a prose-bearing opener survives that stripping with its
 * walked-forward `at` intact but no tail left, so a guard would fail on exactly the entry it is meant
 * to catch and the reading would rewind by the run's whole length the moment the turn settled (measured
 * 2026-08-28 against the real module: a run opening 10:00 and folding batches through 10:09 read 10:09
 * live, 10:00 settled). `runStartedAt` is set at `coalesceToolActivityMessages` on exactly the entries
 * whose `at` can be walked, and equals `message.at` when nothing folds in, so the unguarded form is a
 * no-op on every other row. (`liveRuntimeStartedAt` still needs its guard — it asks the different
 * question of whether a run is live NOW.)
 */
export function toolActivityStampAt(entry: ToolActivityMessage): string | undefined {
  return entry.runStartedAt ?? entry.message.at
}

function withoutLiveToolTail(message: ChatMessage): ChatMessage {
  const tail = messageToolTail(message)
  if (!tail) return message

  // `message.tools` is the flattened provider view while `parts` preserves exact render order.
  // Remove the whole live run from both (withoutToolCalls), by call identity — the tail can be the
  // trailing slice of a part it shares with a dispatch card, so a whole-part match would miss it. A
  // settled run is still LIVE HISTORY while the turn is running: revealing its digest during the
  // inter-call gap makes the row jump to `Ran N` + a generic shimmer, only to disappear again when the
  // next call lands.
  // Deliberately NOT keyed on status, unlike the label (liveToolActivityTail) — the label switching to
  // `Thinking…` in that gap is a word changing inside one span, whereas revealing the digest here
  // moves rows.
  return withoutToolCalls(message, new Set(tail))
}

/**
 * Historical transcript rows exclude the live ordinary-tool tail.
 *
 * Its newest call supplies the bottom runtime gerund instead. Callers use this only while the turn
 * is running, so individual call completion cannot flash a digest between sequential calls. Once a
 * visible block ends the run—or the turn goes idle—the unmodified message renders `Ran N tool calls`.
 */
export function historicalToolActivityMessages(
  entries: readonly ToolActivityMessage[],
): ToolActivityMessage[] {
  let liveTailMessage: ChatMessage | undefined
  for (let i = entries.length - 1; i >= 0; i--) {
    const message = entries[i].message
    if (message.queued) continue
    if (messageToolTail(message)) liveTailMessage = message
    break
  }

  if (!liveTailMessage) return [...entries]
  const out: ToolActivityMessage[] = []
  for (const entry of entries) {
    const message = entry.message === liveTailMessage
      ? withoutLiveToolTail(entry.message)
      : entry.message
    if (transparentAssistantMessage(message)) continue
    out.push(message === entry.message ? entry : { ...entry, message })
  }
  return out
}

function target(tool: Pick<TranscriptToolCall, "detail">): string | undefined {
  const detail = tool.detail?.trim()
  return detail || undefined
}

/**
 * Imperative first words a provider still sends despite the worker prompt asking for a gerund, mapped
 * to the gerund the shimmer should show. Curated rather than derived: English spelling rules alone
 * cannot tell a verb from a noun, so a generic `+ing` would turn the noun phrase "Final workflow
 * validation" into "Finaling workflow validation". Words that are also common nouns (`test`, `check`,
 * `diff`, `patch`) are still safe here, because as a description's FIRST word they read as the verb.
 */
const IMPERATIVE_GERUNDS: Record<string, string> = {
  add: "Adding",
  analyze: "Analyzing",
  apply: "Applying",
  audit: "Auditing",
  benchmark: "Benchmarking",
  build: "Building",
  bump: "Bumping",
  capture: "Capturing",
  check: "Checking",
  clean: "Cleaning",
  collect: "Collecting",
  commit: "Committing",
  compare: "Comparing",
  confirm: "Confirming",
  copy: "Copying",
  count: "Counting",
  create: "Creating",
  debug: "Debugging",
  delete: "Deleting",
  diff: "Diffing",
  disable: "Disabling",
  dispatch: "Dispatching",
  drive: "Driving",
  dump: "Dumping",
  edit: "Editing",
  enable: "Enabling",
  extract: "Extracting",
  fetch: "Fetching",
  find: "Finding",
  fix: "Fixing",
  format: "Formatting",
  generate: "Generating",
  grep: "Grepping",
  inspect: "Inspecting",
  install: "Installing",
  kill: "Killing",
  launch: "Launching",
  lint: "Linting",
  list: "Listing",
  load: "Loading",
  measure: "Measuring",
  merge: "Merging",
  migrate: "Migrating",
  move: "Moving",
  open: "Opening",
  parse: "Parsing",
  patch: "Patching",
  poll: "Polling",
  print: "Printing",
  probe: "Probing",
  profile: "Profiling",
  publish: "Publishing",
  pull: "Pulling",
  push: "Pushing",
  query: "Querying",
  read: "Reading",
  rebase: "Rebasing",
  refactor: "Refactoring",
  regenerate: "Regenerating",
  remove: "Removing",
  rename: "Renaming",
  render: "Rendering",
  reproduce: "Reproducing",
  restart: "Restarting",
  revert: "Reverting",
  review: "Reviewing",
  run: "Running",
  save: "Saving",
  scan: "Scanning",
  search: "Searching",
  seed: "Seeding",
  spawn: "Spawning",
  start: "Starting",
  stop: "Stopping",
  summarize: "Summarizing",
  sync: "Syncing",
  tag: "Tagging",
  test: "Testing",
  trace: "Tracing",
  typecheck: "Typechecking",
  update: "Updating",
  validate: "Validating",
  verify: "Verifying",
  wait: "Waiting",
  watch: "Watching",
  write: "Writing",
}

function gerundDescription(description: string | undefined, fallback: string): string {
  const clean = description?.trim()
  if (!clean) return fallback
  const firstSpace = clean.indexOf(" ")
  const first = (firstSpace === -1 ? clean : clean.slice(0, firstSpace)).replace(/[.:]$/, "")
  if (/ing$/i.test(first)) return first.charAt(0).toUpperCase() + first.slice(1) + (firstSpace === -1 ? "" : clean.slice(firstSpace))
  const gerund = IMPERATIVE_GERUNDS[first.toLowerCase()]
  // An authored description is always a better activity label than the raw command in `fallback`, so
  // anything we cannot convert is shown AS WRITTEN (sentence-cased) rather than leaking
  // `Running <long command>`. It is never prefixed with `Running`: that word is a claim about what
  // the tool is doing, and pasted in front of a noun phrase or an unrecognized verb it produces
  // nonsense like "Running Final workflow validation".
  if (!gerund) return clean.charAt(0).toUpperCase() + clean.slice(1)
  return gerund + (firstSpace === -1 ? "" : clean.slice(firstSpace))
}

/**
 * Rewrite absolute in-project paths as project-relative ones for display.
 *
 * `detail` carries the provider's raw input, and every Claude/Codex file tool passes an ABSOLUTE path,
 * so the shimmer reads `Editing /Users/me/Documents/projects/frizz/packages/web/src/App.tsx` — one
 * short row whose only identifying part is pushed off the end by a home prefix that never varies.
 * Stripping the project root leaves `Editing packages/web/src/App.tsx`.
 *
 * The root is the board's `projectDir`, which is the git toplevel of the dir the server was launched in
 * — so when Frizz runs on a linked worktree that IS the worktree root, and no separate detection is
 * needed. A worktree a worker created underneath the project keeps its own directory in the relative
 * path (`wt-fix/ui/…`), which is exactly the disambiguation you want. Paths outside the project are left
 * absolute: there is no root that makes them both shorter and honest.
 *
 * Applied to the finished label rather than to `detail` alone so a Bash description's arguments shorten
 * too, and every occurrence is replaced because a command line can name several paths. The trailing
 * slash is part of the needle, so a sibling checkout (`…/frizz-old/a.ts`) never matches.
 *
 * A path outside the project still gets its home prefix collapsed to `~` — `~/.claude/CLAUDE.md` says
 * the same thing in a quarter of the width. The browser can't read $HOME, so it comes from the project
 * root's own leading `/Users/<user>` or `/home/<user>`; any other shape (a repo under `/opt`, `/srv`, a
 * volume) yields no home and those paths stay absolute rather than being cut at a guess.
 */
export function relativeToolPaths(label: string, projectDir: string | undefined): string {
  const root = projectDir?.trim().replace(/\/+$/, "")
  if (!root || root === "/" || !root.startsWith("/")) return label
  const withinProject = label.replaceAll(`${root}/`, "")
  const home = /^(\/(?:Users|home)\/[^/]+)(?:\/|$)/.exec(root)?.[1]
  return home ? withinProject.replaceAll(`${home}/`, "~/") : withinProject
}

/** A concise, sentence-case gerund for the latest visible activity. */
export function toolActivityLabel(
  tool: Pick<TranscriptToolCall, "name" | "detail" | "desc">,
  projectDir?: string,
): string {
  return relativeToolPaths(rawToolActivityLabel(tool), projectDir)
}

function rawToolActivityLabel(tool: Pick<TranscriptToolCall, "name" | "detail" | "desc">): string {
  const name = normalizedToolName(tool.name)
  const detail = target(tool)
  const suffix = detail ? ` ${detail}` : ""

  if (name === "bash" || name === "exec" || name === "run command") {
    return gerundDescription(tool.desc, detail ? `Running ${detail}` : "Running a command")
  }
  if (name === "read" || name === "view image") return `Reading${suffix || " a file"}`
  if (name === "grep" || name === "search" || name === "search query" || name === "find") {
    return detail ? `Searching for ${detail}` : "Searching"
  }
  if (name === "glob" || name === "find files") return detail ? `Finding ${detail}` : "Finding files"
  if (name === "edit" || name === "write" || name === "apply patch") return detail ? `Editing ${detail}` : "Editing files"
  if (name === "todos" || name === "update plan") return "Updating the plan"
  if (name === "screenshot" || name === "snapshot") return detail ? `Capturing ${detail}` : "Capturing the page"
  if (name === "navigate") return detail ? `Navigating to ${detail}` : "Navigating"
  if (name === "evaluate") return "Evaluating the page"
  if (name === "pages") return "Listing pages"
  if (name === "new page") return "Opening a new page"
  if (name === "close page") return "Closing the page"
  if (name === "select page") return "Selecting a page"
  if (name === "console" || name === "console message") return "Reading the console"
  if (name === "network" || name === "network request") return "Inspecting network traffic"
  if (name === "press key") return detail ? `Pressing ${detail}` : "Pressing a key"
  if (name === "fill form") return "Filling the form"
  if (name === "dialog") return "Handling a dialog"
  if (name === "upload") return detail ? `Uploading ${detail}` : "Uploading a file"
  if (name === "wait for" || name === "wait") return detail ? `Waiting for ${detail}` : "Waiting"
  if (name === "resize") return "Resizing the page"
  if (name === "ask") return "Preparing a question"
  if (name === "web" || name === "web search") return detail ? `Searching for ${detail}` : "Searching the web"
  return `Using ${readableToolName(tool.name) || "a tool"}`
}

/** Prefer the newest pending call; otherwise summarize the final call in the settled batch. */
export function currentToolActivity<T extends Pick<TranscriptToolCall, "status">>(tools: readonly T[]): {
  tool: T | undefined
  pending: boolean
} {
  for (let i = tools.length - 1; i >= 0; i--) {
    if (tools[i].status === "pending") return { tool: tools[i], pending: true }
  }
  return { tool: tools[tools.length - 1], pending: false }
}

/** Tools whose whole job is to write a file — the ones the digest reports as "edited". */
const FILE_WRITING_TOOL_NAMES = new Set(["edit", "multiedit", "write", "apply patch"])

/** The collapsed render shape merges consecutive edits to one file, so `edits` is the plural of `edit`. */
export interface FileWritingTool {
  name: string
  detail?: string
  edit?: { file: string }
  edits?: { file: string }[]
}

/**
 * How many DISTINCT files a settled run wrote.
 *
 * Creation, deletion and modification all collapse to one "edited" reading — the digest is a one-line
 * recap, not a changelog, and splitting it three ways buys nothing (maintainer 2026-07-31: "no need to
 * be pedantic"). The path comes from the structured `edit` payload where there is one; a codex
 * apply_patch the server could not reconstruct (a `Delete File`, a multi-file hunk) still arrives named
 * Edit with the file as its `detail`, which is why the name check is the fallback rather than dead code.
 * A Bash `rm`/`mv` is deliberately not inspected — the digest counts file tools, not shell side effects.
 *
 * Nor is a Bash WRITE, which is where this parts company with the fullscreen rail's own list: that one
 * does read redirects and in-place editors out of the command text (server/edited-files.ts), because it
 * has the project dir to resolve a relative target against and the filesystem to reject one that was
 * never written. This runs in the browser with neither, and a per-turn count that swept in `/dev/null`
 * and every `/tmp` capture would be less true than one that counts file tools and says so.
 */
export function editedFileCount(tools: readonly FileWritingTool[]): number {
  const files = new Set<string>()
  for (const tool of tools) {
    for (const edit of tool.edits ?? (tool.edit ? [tool.edit] : [])) {
      if (edit.file.trim()) files.add(edit.file.trim())
    }
    if (tool.edit || tool.edits?.length) continue
    const detail = tool.detail?.trim()
    if (detail && FILE_WRITING_TOOL_NAMES.has(normalizedToolName(tool.name))) files.add(detail)
  }
  return files.size
}

export function settledToolActivityLabel(total: number, editedFiles = 0): string {
  const calls = `Ran ${total} tool ${total === 1 ? "call" : "calls"}`
  if (editedFiles === 0) return calls
  return `${calls}, edited ${editedFiles} file${editedFiles === 1 ? "" : "s"}`
}

/**
 * The bottom runtime slot's reading while the turn runs and NO call is executing — the INTER-CALL GAP.
 *
 * A bare `Thinking…` is true and says nothing about what the turn has already done, while the clock
 * beside it counts the whole TURN — so a model that has run twenty-three calls and paused to reason over
 * the last result reads as a thread that has sat there thinking for ten minutes (maintainer 2026-08-08:
 * "there's a period where it's thinking, and it looks like the thread has just been thinking for like ten
 * minutes"). The run's own count carries that work across the gap, and because the slot alternates
 * `Ran 23 tool calls. Thinking…` → the next call's gerund → `Ran 24 tool calls. Thinking…`, the number
 * ticking up is itself the evidence the turn is moving.
 *
 * The count is the LIVE RUN's, i.e. exactly the calls history is withholding behind this row
 * (liveToolActivityRun) — the same number its digest will state once the run settles. So it resets when
 * prose or a dedicated card ends the run, which is correct: those calls are already stated by a digest the
 * reader can see, and restating them here would double-count the turn.
 *
 * Calls only — never the settled digest's `, edited N files` tail. This is a one-line status that
 * TRUNCATES, and the half that must survive a narrow pane is the one saying the model is still going.
 */
export function thinkingToolActivityLabel(ranCalls: number): string {
  return ranCalls > 0 ? `${settledToolActivityLabel(ranCalls)}. Thinking…` : "Thinking…"
}

export type ToolActivityTool = TranscriptMessage["tools"][number]
