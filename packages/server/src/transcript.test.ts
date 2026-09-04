import { test } from "node:test"
import assert from "node:assert/strict"
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { projectStateDir } from "./frizz-paths.ts"
import { projectRetiredBackgroundOps, projectTranscriptPeerNames } from "./transcript.ts"
import { relayMessage } from "./completion-relay.ts"
import type { TranscriptMessage } from "@frizz/shared"
import { DISPATCH_TASK_BANNER_MARKER, formatGithubWakeSteer, GITHUB_DISPATCH_UI_BOUNDARY, humanGapNote, PARK_CORRECTION_NAMES_LEAD, PARK_CORRECTION_QUESTION_LEAD, PARK_CORRECTION_RETIRED_LEAD, parseRecurringPrompt, prWatchWakeMessage, restPromptMessage, wakeDeliveryToken, wakeTimeHeader, type GithubWakeSteer } from "@frizz/shared"
import {
  coalescedQueuedKeys,
  createTranscriptFold,
  frizzDispatchDisplayText,
  githubDispatchDisplayText,
  latestTranscriptWindow,
  latestWindowStart,
  LATEST_WINDOW_ASK_REACH_ITEMS,
  MAX_MESSAGES,
  pageProjectedTranscript,
  projectClaudeTranscript,
  parseTranscript,
  QUEUED_STALE_MS,
  retireStaleQueuedBubbles,
  readEarlierThreadTranscriptPage,
  readLatestThreadTranscriptPage,
  readThreadTranscript,
} from "./transcript.ts"
import { createStorage, type SessionRow } from "./storage.ts"
import { createCodexBackend } from "./backend/codex.ts"
import type { Project } from "./project.ts"

// Build a minimal assistant JSONL record carrying one tool_use block.
function toolLine(name: string, input: unknown): string {
  return JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: "m1", content: [{ type: "tool_use", name, input }] },
  })
}

const githubTask = `THREAD: investigate-cli-cli-326

Investigate this issue and make recommendations

Issue #326: Support multiple accounts
Repository: cli/cli
URL: https://github.com/cli/cli/issues/326

${GITHUB_DISPATCH_UI_BOUNDARY}

You are triaging a GitHub issue. This full worker template must remain available.`

test("Claude GitHub dispatch retains full first-user text but exposes only the compact generated lead", () => {
  // The GitHub envelope rides BELOW frizz's dispatch banner, so the two projections compose: peel frizz's
  // envelope first, then the GitHub template. `text` keeps every byte the worker actually received.
  const content = `scratchpad orientation${DISPATCH_TASK_BANNER_MARKER}${githubTask}`
  const raw = JSON.stringify({
    type: "user",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { content },
  })
  const [message] = parseTranscript(raw)
  assert.equal(message.text, content)
  assert.equal(
    message.displayText,
    "Investigate this issue and make recommendations\n\nIssue #326: Support multiple accounts\nRepository: cli/cli\nURL: https://github.com/cli/cli/issues/326",
  )
  assert.match(message.text, /full worker template must remain available/)
  assert.doesNotMatch(message.displayText!, /worker template|github-dispatch-ui-boundary/)
})

// The scheduler's wake token rides a LATER user turn (a wake is by definition a resume), which is the
// case the old first-message-only display gate never reached — so it reached the pre-wrap user bubble
// and the human read a literal `<!-- frizz-wake:… -->`. The steer above it must survive; the stored text
// must keep the token, because the outbox acks a delivery by finding it in the worker's own record.
const wakeSteer = "⏳ The session usage limit that interrupted you has reset. Continue exactly where you left off."
const wakeId = "e9590807642cfee10b251fa5c230e3ba27f02f978475d883411a5c35e81d68c0"

test("Claude wake delivery hides the wake token in the bubble while the stored text keeps it", () => {
  const delivered = `${wakeSteer}\n\n${wakeDeliveryToken(wakeId)}`
  const raw = [
    JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00.000Z", message: { content: "orientation\n\nTASK:\nthe original task" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:05.000Z", message: { id: "m1", content: [{ type: "text", text: "on it" }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:10.000Z", message: { content: delivered } }),
  ].join("\n")
  const msgs = parseTranscript(raw)
  const wake = msgs[msgs.length - 1]
  assert.equal(wake.role, "user")
  assert.equal(wake.text, delivered) // the ack (scheduler: lastUserText.includes(token)) depends on this
  assert.equal(wake.displayText, wakeSteer)
  // FRIZZ composed this turn, not the human — the chat renders it as a first-party card rather than
  // the human's own right-justified bubble, which claimed the operator had typed it.
  assert.equal(wake.wake, true)
  // …and a limit wake is not a GitHub wake, so there is no structured steer to hand over.
  assert.equal(wake.wakeSteer, undefined)
})

// A REGISTERED PR WATCHER'S WAKE, exactly as the scheduler composes and delivers it: the news, frizz's
// own agent-facing trailer, the clock line, the delivery token. The trailer is the one the operator saw
// in full on 2026-09-04 — "why am I still seeing shit like this? This should just never show up" —
// because the tab rendering it was an hour older than the state line it could not parse, so the delivery
// fell through the chat's parsers to the verbatim card and printed the boilerplate.
//
// The chat's parsers are not the defence, because the browser is the half that is routinely behind. THIS
// is: the display projection runs on the side that composed the trailer, so it can never be a build
// behind it, and a tab of any age gets a body with no worker instructions in it.
test("a PR watcher's wake shows the news and not the agent-facing trailer frizz appended", () => {
  const news = prWatchWakeMessage({ target: "nubjs/nub#879", changes: ["now CONFLICTS with the base branch"] })
  const clock = wakeTimeHeader(Date.parse("2026-09-04T22:31:00.000Z"), "2026-09-04T22:21:00.000Z")
  const delivered = `${news}\n\n${clock}\n\n${wakeDeliveryToken(wakeId)}`
  const raw = [
    JSON.stringify({ type: "user", timestamp: "2026-09-04T22:00:00.000Z", message: { content: "orientation\n\nTASK:\nthe original task" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-09-04T22:21:00.000Z", message: { id: "m1", content: [{ type: "text", text: "on it" }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-09-04T22:31:00.000Z", message: { content: delivered } }),
  ].join("\n")
  const wake = parseTranscript(raw).at(-1)!
  assert.equal(wake.wake, true)
  assert.equal(wake.text, delivered, "the worker keeps every byte — the outbox acks on the token, and the trailer is written for it")
  assert.equal(wake.displayText, "\u{1F514} nubjs/nub#879: now CONFLICTS with the base branch.")
  assert.doesNotMatch(wake.displayText!, /STILL ARMED|mcp__frizz__/, "worker instructions reached the operator")
})

// The router appends the clock note to the WORKER's copy only, and says so — but the chat renders the
// worker's TRANSCRIPT, not the delivery ledger the router left untouched, so the note landed inside the
// operator's own right-justified bubble underneath their own words, unattributed and un-asked-for
// ("can we make these invisible? they're showing up in my own user messages", 2026-08-20). It is hidden
// the way the wake token is hidden: a display projection, with the stored text keeping every byte.
test("the gap note frizz appends to a human follow-up stays out of the human's own bubble", () => {
  const note = humanGapNote(Date.parse("2026-08-20T07:17:00.000Z"), "2026-08-19T17:00:00.000Z")!
  const delivered = `can we make these invisible?\n\n${note}`
  const raw = [
    JSON.stringify({ type: "user", timestamp: "2026-08-19T16:00:00.000Z", message: { content: "orientation\n\nTASK:\nthe original task" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-08-19T17:00:00.000Z", message: { id: "m1", content: [{ type: "text", text: "done" }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-08-20T07:17:00.000Z", message: { content: delivered } }),
  ].join("\n")
  const follow = parseTranscript(raw).at(-1)!
  assert.equal(follow.text, delivered, "the worker keeps the clock it has no other way to read")
  assert.equal(follow.displayText, "can we make these invisible?")
  // The human WROTE this turn — hiding frizz's line must not turn their message into a frizz card.
  assert.equal(follow.wake, undefined)
})

// The chat's divider must not be re-derived from prose in the browser: a tab keeps its bundle across a
// server restart (boot.ts adopts a new boot id in place, so an unsent draft survives), so a promoted
// artifact routinely leaves an old parser reading a newer steer — which on 2026-07-31 cost every open
// tab its divider and dumped the raw agent-facing `gh api …` tail into the transcript. The server
// parses instead, where formatter and parser are the same build by construction.
test("a GitHub wake hands the chat its STRUCTURED steer, tail and token and all", () => {
  const steer: GithubWakeSteer = {
    ref: "nubjs/nub#645",
    omitted: 0,
    items: [{ label: "review comment", actor: "pullfrog", bot: true, at: "2026-08-01T01:51:51Z", url: "https://github.com/nubjs/nub/pull/645#pullrequestreview-4833228738" }],
  }
  // Byte for byte what the scheduler delivers: the steer, its derived review-read tail, the token.
  const delivered = `${formatGithubWakeSteer(steer)}\n\n${wakeDeliveryToken(wakeId)}`
  assert.match(delivered, /^gh api --paginate repos\/nubjs\/nub\/pulls\/645\/reviews\/4833228738\/comments$/m)
  const raw = [
    JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00.000Z", message: { content: "orientation\n\nTASK:\nthe original task" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:05.000Z", message: { id: "m1", content: [{ type: "text", text: "on it" }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:10.000Z", message: { content: delivered } }),
  ].join("\n")
  const wake = parseTranscript(raw).at(-1)!
  assert.equal(wake.wake, true)
  assert.deepEqual(wake.wakeSteer, steer, "the card renders from this, not from the text below it")
})

test("a wake token riding a QUEUED follow-up is hidden too, and the pending bubble still resolves", () => {
  const delivered = `${wakeSteer}\n\n${wakeDeliveryToken(wakeId)}`
  const raw = [
    JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00.000Z", message: { content: "orientation\n\nTASK:\nthe original task" } }),
    JSON.stringify({ type: "queue-operation", timestamp: "2026-07-01T00:00:05.000Z", operation: "enqueue", content: delivered }),
    JSON.stringify({
      type: "attachment", timestamp: "2026-07-01T00:00:09.000Z",
      attachment: { type: "queued_command", prompt: delivered, origin: { kind: "human" }, commandMode: "prompt" },
    }),
  ].join("\n")
  const msgs = parseTranscript(raw)
  const queued = msgs.filter((m) => m.role === "user")
  assert.equal(queued.length, 2, "the enqueue bubble resolves in place rather than emitting a second copy")
  assert.equal(queued[1].queued, false)
  assert.equal(queued[1].text, delivered)
  assert.equal(queued[1].displayText, wakeSteer)
  assert.equal(queued[1].wake, true, "a wake pasted into a mid-turn worker is still frizz speaking")
})

// SOURCE 12's correction is frizz talking to the WORKER about its own fence grammar — no news, nothing
// for the human to do — so it never becomes a message. The one mark it leaves on the chat is on the
// fence it refused, which stops drawing rather than claiming a park frizz declined to arm.
const refusedFence = [
  "I'll wait on the two of them.",
  "",
  "```awaiting",
  "pr: colinhacks/zod#5910",
  "agent: toolu_theWrongId",
  "for: 3h",
  "---",
  "Waiting on CI and the bisect.",
  "```",
].join("\n")

function correctionTranscript(delivered: string): TranscriptMessage[] {
  return parseTranscript([
    JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00.000Z", message: { content: "orientation\n\nTASK:\nthe original task" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:05.000Z", message: { id: "m1", content: [{ type: "text", text: refusedFence }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:10.000Z", message: { content: `${delivered}\n\n${wakeDeliveryToken(wakeId)}` } }),
  ].join("\n"))
}

test("a fence correction leaves the chat entirely, and the fence it refused stops drawing", () => {
  const msgs = correctionTranscript(
    `${PARK_CORRECTION_NAMES_LEAD}something that is not running, so it is not a park and your thread stayed in the queue.\n\n- \`agent: toolu_theWrongId\` — NOT RUNNING`,
  )
  assert.equal(msgs.filter((m) => m.role === "user").length, 1, "only the dispatch — the correction never becomes a message")
  const rested = msgs[msgs.length - 1]
  assert.equal(rested.text, refusedFence, "the worker's own words are untouched")
  assert.equal(rested.fenceRefused, true)
})

// The open-question refusal (2026-08-28) rides the same fold: the delivery never renders, and the fence
// it refused stops drawing — which is the whole point, since drawing it beside the ask was the defect.
test("an open-question correction leaves the chat and refuses its fence", () => {
  const msgs = correctionTranscript(`${PARK_CORRECTION_QUESTION_LEAD}a question of yours was still OPEN, so frizz refused the park — a question outranks a wait, and this thread sits in the human's queue on it.\n\n- \`qst_6506c36d2f28\` — how should that flag be handled?`)
  assert.equal(msgs.filter((m) => m.role === "user").length, 1)
  assert.equal(msgs[msgs.length - 1].fenceRefused, true)
})

test("a retired-line-kind correction refuses its fence too, and an expired wake refuses nothing", () => {
  const retired = correctionTranscript(`${PARK_CORRECTION_RETIRED_LEAD}a line kind that no longer exist, so frizz ignored it — the\nfence named nothing and your thread stayed in the queue.`)
  assert.equal(retired.filter((m) => m.role === "user").length, 1)
  assert.equal(retired[retired.length - 1].fenceRefused, true)
  // The expiry wake is NOT a correction: the fence was right and the clock ran out, so it stays a
  // message (it is why the thread is moving again) and the fence it names was a real park.
  const expired = correctionTranscript("⏰ Your wait expired, nothing resolved. Check back in on everything.")
  const wake = expired[expired.length - 1]
  assert.equal(wake.role, "user")
  assert.equal(wake.wake, true)
  assert.equal(expired.find((m) => m.text === refusedFence)?.fenceRefused, undefined)
})

test("a wake token is projected out only from the delivery tail, never from quoted prose", () => {
  const quoting = `Why is ${wakeDeliveryToken(wakeId)} showing up in the bubble?`
  const raw = [
    JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00.000Z", message: { content: "orientation\n\nTASK:\nthe original task" } }),
    JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:10.000Z", message: { content: quoting } }),
  ].join("\n")
  const msgs = parseTranscript(raw)
  const asked = msgs[msgs.length - 1]
  assert.equal(asked.text, quoting)
  assert.equal(asked.displayText, undefined, "a mid-sentence token is the human's own words — leave the bubble alone")
  assert.equal(asked.wake, undefined, "and it must not be laundered into a first-party frizz card either")
})

// A COALESCED record — two deliveries the runtime merged into one user turn because they landed while
// the worker was mid-turn. Measured on this machine's corpus: 14 of 380 real wake deliveries arrived
// this way, and every one lost its own presentation. The record ENDS in a token, so the old projection
// saw one wake, stripped the LAST token and handed the chat the whole run as a single blob: a recurring
// prompt whose trailer was no longer at the end could not parse, so its `Recurring prompt · at rest`
// divider became a generic bell card carrying a relay notice and an interior `<!-- frizz-wake:… -->`.
test("a coalesced user record splits back into the deliveries the scheduler actually sent", () => {
  const rest = restPromptMessage("KEEP GOING.")
  const relay = `<frizz-relay:b7xm5f1db> Background command "Trace the packages" completed (exit code 0) — its output is at /tmp/b7xm5f1db.output.`
  // Byte for byte the shape from the corpus: each delivery keeps its own token, joined by one newline.
  const coalesced = `${rest}\n\n${wakeDeliveryToken(wakeId)}\n${relay}\n\n${wakeDeliveryToken("b".repeat(64))}`
  const raw = [
    JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00.000Z", message: { content: "orientation\n\nTASK:\nthe original task" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:05.000Z", message: { id: "m1", content: [{ type: "text", text: "on it" }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:10.000Z", message: { content: coalesced } }),
  ].join("\n")
  const msgs = parseTranscript(raw)
  const wakes = msgs.filter((m) => m.wake)
  assert.equal(wakes.length, 1, "the relay is plumbing the chat drops, exactly as when it arrives alone")
  assert.equal(wakes[0].displayText, rest)
  assert.ok(parseRecurringPrompt(wakes[0].displayText), "…and the trailer is at the end again, so the divider parses")
  assert.notEqual(wakes[0].sourceId, msgs[0].sourceId, "every rendered message keeps its own scroll anchor")
  assert.doesNotMatch(msgs.map((m) => m.displayText ?? m.text).join("\n"), /frizz-wake|frizz-relay/, "no machine-facing marker survives into the chat")
  // The relay does not merely vanish: it gets the same wake divider it would have drawn arriving alone.
  // `relayNotificationBlock` anchors to the start of the text, so a relay merged UNDER another delivery
  // used to match nothing at all — it lost its divider AND showed up as prose in the card above it.
  assert.match(msgs.map((m) => m.text).join("\n"), /Background task «Trace the packages» finished \(completion relayed\)/)

  // ORDER REVERSED — the relay arrives first. The whole-record noise gate used to answer this with a
  // prefix test, so a plumbing lead swallowed the real delivery underneath it and the prompt vanished
  // from the transcript entirely. The gate now asks per segment.
  const relayFirst = `${relay}\n\n${wakeDeliveryToken("c".repeat(64))}\n${rest}\n\n${wakeDeliveryToken(wakeId)}`
  const led = parseTranscript([
    JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00.000Z", message: { content: "orientation\n\nTASK:\nthe original task" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:05.000Z", message: { id: "m1", content: [{ type: "text", text: "on it" }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:10.000Z", message: { content: relayFirst } }),
  ].join("\n"))
  const ledWakes = led.filter((m) => m.wake)
  assert.equal(ledWakes.length, 1, "the delivery under the plumbing still renders")
  assert.equal(ledWakes[0].displayText, rest)
  assert.doesNotMatch(led.map((m) => m.displayText ?? m.text).join("\n"), /frizz-wake|frizz-relay/)
  assert.match(led.map((m) => m.text).join("\n"), /Background task «Trace the packages» finished \(completion relayed\)/)

  // …and every one of those messages needs its OWN sourceId. One record now yields a divider AND a
  // delivery, and both used to take the record's bare id — silent on this side, a React duplicate-key
  // warning in the browser, which is where it was actually caught. Asserted over both orderings.
  for (const set of [msgs, led]) {
    const ids = set.map((m) => m.sourceId)
    assert.equal(new Set(ids).size, ids.length, `duplicate sourceId in ${JSON.stringify(ids)}`)
  }
})

// frizz's own dispatch envelope. The bubble shows the operator's prompt and nothing else — on the plain
// `user` record the spawned-CLI runtime writes AND on the `queue-operation` enqueue record the broker writes.
test("frizz dispatch envelope is projected out of the first bubble on every record shape", () => {
  const task = "Fix the thing.\n\nWith a second paragraph."
  const composed = `Your scratchpad is \`.frizz/threads/sid/scratch.md\` — …${DISPATCH_TASK_BANNER_MARKER}${task}`

  assert.equal(frizzDispatchDisplayText(composed), task)
  assert.equal(frizzDispatchDisplayText("just a follow-up steer"), undefined)

  const asUser = JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00.000Z", message: { content: composed } })
  assert.equal(parseTranscript(asUser)[0].displayText, task)

  const asEnqueue = JSON.stringify({ type: "queue-operation", timestamp: "2026-07-01T00:00:00.000Z", operation: "enqueue", content: composed })
  const [queued] = parseTranscript(asEnqueue)
  assert.equal(queued.displayText, task)
  assert.equal(queued.text, composed, "the raw content is the key the delivery attachment matches on")
})

// Threads dispatched before 2026-07-26 carry the retired envelope: an explanation line and a bare
// `TASK:` marker BELOW the banner. Their transcripts must still render as they always did.
test("the retired below-the-banner TASK: envelope still renders as just the task", () => {
  const task = "Fix the thing."
  const legacyTail = "Everything ABOVE this line is frizz system orientation. Everything BELOW the `TASK:` marker is the human operator's own prompt, verbatim."
  const legacy = `orientation${DISPATCH_TASK_BANNER_MARKER}${legacyTail}\n\nTASK:\n${task}`
  assert.equal(frizzDispatchDisplayText(legacy), task)

  // …and the era before the banner existed at all, which was the bare marker alone.
  assert.equal(frizzDispatchDisplayText(`orientation\n\nTASK:\n${task}`), task)
})

// The retired preamble is matched EXACTLY, so a current dispatch whose task legitimately contains a
// "TASK:" line of its own is shown whole rather than truncated at it.
test("a task that itself contains a TASK: line is never truncated at it", () => {
  const task = "Rename the header.\n\nTASK:\nthis line is part of what the operator wrote"
  const composed = `orientation${DISPATCH_TASK_BANNER_MARKER}${task}`
  assert.equal(frizzDispatchDisplayText(composed), task)
})

test("GitHub display boundary is inert without the complete generated envelope", () => {
  const ordinary = `Example HTML comment:\n\n${GITHUB_DISPATCH_UI_BOUNDARY}\n\nkeep this visible`
  assert.equal(githubDispatchDisplayText(ordinary), undefined)
  const nearMiss = githubTask.replace("github-dispatch-ui-boundary:v1", "github-dispatch-ui-boundary:v2")
  assert.equal(githubDispatchDisplayText(nearMiss), undefined)
})

test("Edit → structured edit payload (old/new captured)", () => {
  const msgs = parseTranscript(toolLine("Edit", { file_path: "/x/a.ts", old_string: "foo", new_string: "bar" }))
  const call = msgs[0].tools[0]
  assert.equal(call.name, "Edit")
  assert.deepEqual(call.edit, { file: "/x/a.ts", old: "foo", new: "bar", added: 1, removed: 1 })
})

test("Write → edit with empty old side (whole file new)", () => {
  const msgs = parseTranscript(toolLine("Write", { file_path: "/x/n.ts", content: "hello" }))
  assert.deepEqual(msgs[0].tools[0].edit, { file: "/x/n.ts", old: "", new: "hello", added: 1, removed: 0 })
})

test("MultiEdit → one tool call per sub-edit", () => {
  const msgs = parseTranscript(
    toolLine("MultiEdit", {
      file_path: "/x/m.ts",
      edits: [
        { old_string: "a", new_string: "A" },
        { old_string: "b", new_string: "B" },
      ],
    }),
  )
  assert.equal(msgs[0].tools.length, 2)
  assert.deepEqual(msgs[0].tools[0].edit, { file: "/x/m.ts", old: "a", new: "A", added: 1, removed: 1 })
  assert.deepEqual(msgs[0].tools[1].edit, { file: "/x/m.ts", old: "b", new: "B", added: 1, removed: 1 })
})

test("edit strings are capped with a truncation marker", () => {
  const big = "x".repeat(5000)
  const msgs = parseTranscript(toolLine("Write", { file_path: "/x/big.ts", content: big }))
  const newVal = msgs[0].tools[0].edit!.new
  assert.ok(newVal.length < big.length)
  assert.ok(newVal.endsWith("(truncated)"))
})

test("non-edit tool → no edit payload, detail preserved", () => {
  const msgs = parseTranscript(toolLine("Bash", { command: "ls -la" }))
  const call = msgs[0].tools[0]
  assert.equal(call.edit, undefined)
  assert.equal(call.detail, "ls -la")
})

test("Edit missing new_string → falls back to plain tool call", () => {
  const msgs = parseTranscript(toolLine("Edit", { file_path: "/x/a.ts", old_string: "foo" }))
  assert.equal(msgs[0].tools[0].edit, undefined)
})

test("multi-line Bash → raw command block + first-line summary detail", () => {
  const cmd = "cd /tmp\nnpm run build\necho done"
  const call = parseTranscript(toolLine("Bash", { command: cmd })).at(0)!.tools[0]
  assert.equal(call.command, cmd) // newlines preserved verbatim
  assert.equal(call.detail, "cd /tmp…") // summary is the first line + ellipsis
})

test("long single-line Bash (>120 chars) → raw command block", () => {
  const cmd = "echo " + "x".repeat(200)
  const call = parseTranscript(toolLine("Bash", { command: cmd })).at(0)!.tools[0]
  assert.equal(call.command, cmd)
})

test("short one-line Bash → command block too (every Bash renders as a card)", () => {
  const call = parseTranscript(toolLine("Bash", { command: "git status" })).at(0)!.tools[0]
  assert.equal(call.command, "git status") // command shipped for ALL Bash now (no block-worthiness gate)
  assert.equal(call.detail, "git status")
})

test("short `a; b` Bash also ships a command block", () => {
  const call = parseTranscript(toolLine("Bash", { command: "a; b" })).at(0)!.tools[0]
  assert.equal(call.command, "a; b")
  assert.equal(call.detail, "a; b")
})

test("a shell-backgrounded Bash attempt is visible immediately and remains identified after denial", () => {
  const launch = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: {
      id: "m-shell-job",
      content: [{
        type: "tool_use",
        id: "bash-shell-job",
        name: "Bash",
        input: {
          command: "(nub scripts/remote-build.ts --job test > /tmp/f3-test.log 2>&1) &\nsleep 2; echo build started",
          description: "Start third build",
        },
      }],
    },
  })
  const attempted = parseTranscript(launch)[0].tools[0]
  assert.equal(attempted.status, "pending", "the attempted Bash call renders before a result exists")
  assert.equal(attempted.backgroundState, "unknown", "shell job control is called out instead of folded away")

  const denied = JSON.stringify({
    type: "user",
    timestamp: "2026-07-01T00:00:00.100Z",
    message: {
      content: [{
        type: "tool_result",
        tool_use_id: "bash-shell-job",
        is_error: true,
        content: "Frizz blocked an untracked shell background job (`&`). Remove `&` and use Bash run_in_background:true.",
      }],
    },
  })
  const blocked = parseTranscript([launch, denied].join("\n"))[0].tools[0]
  assert.equal(blocked.status, "failed")
  assert.equal(blocked.backgroundState, "unknown", "the failed card remains exempt from ordinary tool collapse")
  assert.match(blocked.output ?? "", /blocked an untracked shell background job/)
})

test("background Bash launch stays running through its acknowledgement and only task-notification ends it", () => {
  const launch = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: "m-bg", content: [{ type: "tool_use", id: "bash-bg", name: "Bash", input: { command: "watch ci", description: "Watch CI", run_in_background: true } }] },
  })
  const acknowledged = JSON.stringify({
    type: "user",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { content: [{ type: "tool_result", tool_use_id: "bash-bg", content: "Command running in background" }] },
  })
  const live = parseTranscript([launch, acknowledged].join("\n"))[0].tools[0]
  assert.equal(live.status, "pending")
  assert.equal(live.backgroundState, "background")
  // The launch tool_use id, which is also the key the TAILER tracks this shell under. The ops strip
  // lists the same shell from both sources and reconciles them on exactly this — it used to reconcile on
  // label+startedAt, and the two sources do not share an instant (see lib/childOps mergeBackgroundShells).
  assert.equal(live.shellId, "bash-bg")

  const completed = parseTranscript([launch, acknowledged, taskNotification("bash-bg", "completed", "2026-07-01T00:00:05.000Z")].join("\n"))[0].tools[0]
  assert.equal(completed.status, "completed")
  assert.equal(completed.durationMs, 5000)
  assert.equal(completed.backgroundState, "background")
})

test("latest transcript window pins unresolved background shells that launched before its 300-message cap", () => {
  const oldShell = {
    sourceId: "old-shell-launch",
    role: "assistant" as const,
    text: "",
    tools: [{
      name: "exec_command",
      detail: "sleep 999",
      status: "pending" as const,
      backgroundState: "background" as const,
    }],
    parts: [],
    at: "2026-07-01T00:00:00.000Z",
  }
  // Assistant-only, so the cut lands exactly at the 300 cap: a human message near the head would make
  // the window reach BACK for it (latestWindowStart) and this test would be measuring that instead.
  const filler = Array.from({ length: 305 }, (_, index) => ({
    sourceId: `filler-${index}`,
    role: "assistant" as const,
    text: `message ${index}`,
    tools: [],
    parts: [],
  }))
  const latest = latestTranscriptWindow([oldShell, ...filler])
  assert.equal(latest.length, 301, "the normal 300-message window gains one live lifecycle card")
  const pinned = latest.at(-1)!
  assert.equal(pinned.pinnedFromSourceId, "old-shell-launch")
  assert.match(pinned.sourceId ?? "", /^pinned-bg:/)
  assert.equal(pinned.tools[0], oldShell.tools[0], "the projection carries the already-folded live call")

  const completed = { ...oldShell, tools: [{ ...oldShell.tools[0], status: "completed" as const }] }
  assert.equal(
    latestTranscriptWindow([completed, ...filler]).some((message) => message.pinnedFromSourceId),
    false,
    "a terminal fold removes the synthetic card on the next reload",
  )
})

// THE QUEUE CARD'S ANCHOR. The card windows on the human's last message and shows everything after it,
// so a latest window that cuts above that message leaves the card opening mid-turn on an assistant
// sentence answering a question the reader can no longer see. Measured on the maintainer's `nub` board
// 2026-08-18: 300 messages in the window, 14 `user` records in it, 13 of them frizz's own wakes, and the
// human's ask sitting 13 messages above the head — one earlier page away and invisible.
const windowFiller = (n: number, from = 0): TranscriptMessage[] =>
  Array.from({ length: n }, (_, i) => ({
    sourceId: `w-${from + i}`,
    role: "assistant" as const,
    text: `step ${from + i}`,
    tools: [],
    parts: [],
  }))

const humanAsk = (text: string, extra: Partial<TranscriptMessage> = {}): TranscriptMessage => ({
  sourceId: `ask-${text}`,
  role: "user",
  text,
  tools: [],
  parts: [],
  ...extra,
})

test("the latest window reaches back past its cap to keep the human's last message at the head", () => {
  const messages = [...windowFiller(40), humanAsk("what I asked"), ...windowFiller(320, 40)]
  assert.equal(messages.length - MAX_MESSAGES, 61, "the raw cap would cut 21 messages BELOW the ask")
  const start = latestWindowStart(messages)
  assert.equal(messages[start].text, "what I asked")
  assert.equal(messages.length - start, 321)
})

test("frizz's own user records are not the human, so the window reaches past every one of them", () => {
  // The exact shape of the card that provoked this: the tail is full of `wake` records (PR-watcher
  // pings, the sign-off reminder, "Keep going" stop-hook prompts) and one undelivered queued send.
  const noise = [
    humanAsk("🤖 New GitHub review comment", { sourceId: "wake-1", wake: true }),
    ...windowFiller(5, 900),
    humanAsk("Keep going.", { sourceId: "wake-2", wake: true }),
    ...windowFiller(5, 910),
    humanAsk("not sent yet", { sourceId: "queued-1", queued: true }),
  ]
  const messages = [...windowFiller(20), humanAsk("the real ask"), ...windowFiller(310, 20), ...noise]
  const start = latestWindowStart(messages)
  assert.equal(messages[start].text, "the real ask")
})

test("the reach is all-or-nothing: an ask further back than the allowance leaves the window exactly where it was", () => {
  const tooFar = LATEST_WINDOW_ASK_REACH_ITEMS + 1
  const messages = [humanAsk("far too far back"), ...windowFiller(MAX_MESSAGES + tooFar)]
  const start = latestWindowStart(messages)
  assert.equal(start, messages.length - MAX_MESSAGES, "no partial extension — it buys no anchor and still ships the bytes")
  assert.equal(latestWindowStart([...windowFiller(1), ...windowFiller(MAX_MESSAGES + 50, 1)]), 51,
    "and a window with no human message anywhere above it is untouched too")
})

test("a transcript inside the cap is returned whole, ask or no ask", () => {
  const messages = [humanAsk("hi"), ...windowFiller(10)]
  assert.equal(latestWindowStart(messages), 0)
  assert.equal(latestTranscriptWindow(messages).length, 11)
})

test("both latest-window producers agree, so a live push cannot splice the ask back out", () => {
  // readLatestThreadTranscriptPage renders the RPC page and createTranscriptFold().messages() renders
  // the /ws push. reconcileLiveMessages replaces the window wholesale, so a push whose head sat further
  // forward than the page's would undo the anchoring on the very next frame.
  const lines: string[] = []
  lines.push(USER_LINE("the real ask"))
  for (let i = 0; i < 320; i++) {
    lines.push(JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-10T18:00:01.000Z",
      message: { id: `a-${i}`, content: [{ type: "text", text: `assistant-${i}` }] },
    }))
  }
  const h = txHarness()
  try {
    h.store.upsertSession(txRow({}))
    h.writeJsonl("sid", lines)
    const page = readLatestThreadTranscriptPage(h.project, h.store, "t")
    const push = readThreadTranscript(h.project, h.store, "t")
    assert.equal(page.messages[0].text, "the real ask")
    assert.deepEqual(push.map((m) => m.sourceId), page.messages.map((m) => m.sourceId))
    // The cursor names the window's REAL head, so the first "Load earlier messages" click pages over
    // history the card is NOT already showing.
    assert.equal(page.hasEarlier, false, "the whole turn fit, so there is nothing earlier to fetch")
  } finally {
    h.cleanup()
  }
})

test("a background shell completion emits a labeled turn-boundary event that breaks the merge chain", () => {
  const launch = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: "m-bg", content: [{ type: "tool_use", id: "bash-bg", name: "Bash", input: { command: "npx vite", description: "Start vite from web package dir", run_in_background: true } }] },
  })
  // A failed completion whose summary carries the exit code the wake label should surface.
  const notify = JSON.stringify({
    type: "queue-operation",
    timestamp: "2026-07-01T00:00:05.000Z",
    content: `<task-notification>\n<tool-use-id>bash-bg</tool-use-id>\n<status>failed</status>\n<summary>Background command "Start vite from web package dir" failed with exit code 143</summary>\n</task-notification>`,
  })
  // The wake re-invokes the agent; the following turn's records can even reuse the SAME message.id as
  // the launch (id "m-bg"). Without the boundary breaking the merge chain, that record would fold back
  // into the launch message; the boundary must keep it a SEPARATE rendered turn.
  const afterWake = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:06.000Z",
    message: { id: "m-bg", content: [{ type: "text", text: "That's the vite server I just killed." }] },
  })
  const msgs = parseTranscript([launch, notify, afterWake].join("\n"))
  // The shell card (launch message) is still back-filled with the terminal state + duration…
  assert.equal(msgs[0].tools[0].status, "failed")
  assert.equal(msgs[0].tools[0].durationMs, 5000)
  // …AND a boundary event line rides the wake point carrying the cause label (desc + exit code)…
  const boundary = msgs[1]
  assert.equal(boundary.kind, "event")
  assert.equal(boundary.boundary, "wake") // a background shell returning — the kind is what puts the terminal glyph on the divider
  assert.equal(boundary.text, "Background task «Start vite from web package dir» exited 143")
  // …and the post-wake turn is its OWN message (the merge chain was broken), not merged into the launch.
  assert.equal(msgs.length, 3)
  assert.equal(msgs[2].text, "That's the vite server I just killed.")
  assert.equal(msgs[0].text, "") // launch stayed tools-only — the post-wake prose did NOT fold into it
})

test("boundary wake label reads 'finished' on a clean exit and 'stopped' when killed", () => {
  const launch = (id: string) => JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: "m-bg", content: [{ type: "tool_use", id, name: "Bash", input: { command: "sleep 1", run_in_background: true } }] },
  })
  const done = parseTranscript([launch("s1"), taskNotification("s1", "completed", "2026-07-01T00:00:02.000Z")].join("\n"))[1]
  assert.match(done.text, /» finished$/)
  assert.equal(done.text, "Background task «sleep 1» finished") // desc falls back to the command summary
  const killed = parseTranscript([launch("s2"), taskNotification("s2", "killed", "2026-07-01T00:00:02.000Z")].join("\n"))[1]
  assert.match(killed.text, /» stopped$/)
})

// ---- a completion frizz had to REPAIR ----
// When the runtime drops a completion notification (upstream anthropics/claude-code#20754), frizz injects
// a prose repair that re-invokes the agent. That is the SAME real event as a delivered completion, so it
// owes the reader the same divider, the same card back-fill, and the same broken merge chain — and it paid
// none of them, because the repair is not a `<task-notification>`. The thread just resumed with nothing
// saying why (maintainer 2026-08-05: "it looks like the agent came to rest, then re-triggered with no
// external event triggering").
const bgLaunch = JSON.stringify({
  type: "assistant",
  timestamp: "2026-07-01T00:00:00.000Z",
  message: { id: "m-bg", content: [{ type: "tool_use", id: "bash-bg", name: "Bash", input: { command: "poll ssh", description: "Poll VM SSH until reachable", run_in_background: true } }] },
})
// The launch ACK is what registers taskId → tool_use_id; without it nothing can correlate by task-id.
const bgAck = JSON.stringify({
  type: "user",
  timestamp: "2026-07-01T00:00:00.500Z",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: "bash-bg", content: "Command running in background with ID: b9em1sxxw" }] },
})
const bgAfterWake = JSON.stringify({
  type: "assistant",
  timestamp: "2026-07-01T00:00:06.000Z",
  message: { id: "m-bg", content: [{ type: "text", text: "Picking the build back up." }] },
})
const relayRecord = (summary: string, type = "user") =>
  type === "user"
    ? JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:05.000Z", message: { role: "user", content: relayMessage({ taskId: "b9em1sxxw", kind: "shell", outputFile: "/tmp/b9em1sxxw.output", summary, chars: 0 }) } })
    : JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "2026-07-01T00:00:04.900Z", content: relayMessage({ taskId: "b9em1sxxw", kind: "shell", outputFile: "/tmp/b9em1sxxw.output", summary, chars: 0 }) })

test("a RELAYED completion projects exactly like a delivered one, and says it was relayed", () => {
  const summary = 'Background command "Poll VM SSH until reachable" completed (exit code 0)'
  const msgs = parseTranscript([bgLaunch, bgAck, relayRecord(summary), bgAfterWake].join("\n"))
  // The launch card is back-filled with its terminal state — it used to sit on "pending" forever…
  assert.equal(msgs[0].tools[0].status, "completed")
  // …a divider rides the wake point, naming the cause AND that frizz was the one carrying it…
  assert.equal(msgs[1].kind, "event")
  assert.equal(msgs[1].boundary, "wake")
  assert.equal(msgs[1].text, "Background task «Poll VM SSH until reachable» finished (completion relayed)")
  // …and the post-wake turn stays its OWN message instead of folding into the launch bubble.
  assert.equal(msgs.length, 3)
  assert.equal(msgs[2].text, "Picking the build back up.")
})

test("a relayed completion reads a NON-ZERO exit rather than assuming success", () => {
  const summary = 'Background command "Poll VM SSH until reachable" failed with exit code 143'
  const msgs = parseTranscript([bgLaunch, bgAck, relayRecord(summary), bgAfterWake].join("\n"))
  assert.equal(msgs[0].tools[0].status, "failed")
  assert.equal(msgs[1].text, "Background task «Poll VM SSH until reachable» exited 143 (completion relayed)")
})

test("a relay that correlates to NO card still draws its divider", () => {
  // The measured real case: an op adopted from an earlier process, whose launch is not in this file at
  // all. Correlation cannot succeed, so the wake most in need of explaining was the one guaranteed to
  // render as nothing. Note there is no launch and no ack here — only the repair.
  const summary = 'Background command "Poll VM SSH until reachable" completed (exit code 0)'
  const msgs = parseTranscript([relayRecord(summary), bgAfterWake].join("\n"))
  const divider = msgs.find((m) => m.boundary === "wake")
  assert.ok(divider, "an uncorrelated relay must still explain why the agent moved")
  assert.equal(divider.text, "Background task «Poll VM SSH until reachable» finished (completion relayed)")
})

test("frizz writes each repair as TWO carriers — the divider is drawn exactly once", () => {
  const summary = 'Background command "Poll VM SSH until reachable" completed (exit code 0)'
  // queue-operation AND user record, which is what a real repair looks like on disk.
  const msgs = parseTranscript([relayRecord(summary, "queue-operation"), relayRecord(summary), bgAfterWake].join("\n"))
  assert.equal(msgs.filter((m) => m.boundary === "wake").length, 1)
})

// ---- the agent came to rest ----
// `stop_reason: "end_turn"` is the record that ends a claude turn — the same signal backend/claude.ts
// folds into `turn-end` for the board's idle state. The transcript closes the turn with a rest divider
// so a reader can tell "finished, your move" from "still working, this is just the newest thing said".
const restLine = (id: string, text: string, at: string, stop: string | null = "end_turn") =>
  JSON.stringify({ type: "assistant", timestamp: at, message: { id, stop_reason: stop, content: [{ type: "text", text }] } })

test("an end_turn record closes the turn with a rest divider", () => {
  const msgs = parseTranscript([
    JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:00.000Z", message: { content: "fix the thing" } }),
    restLine("m1", "Working on it.", "2026-07-01T00:00:01.000Z", "tool_use"),
    restLine("m1", "Fixed — landed on main.", "2026-07-01T00:00:02.000Z"),
  ].join("\n"))
  assert.equal(msgs.length, 3)
  assert.equal(msgs[0].role, "user")
  // Both assistant records share one message id, so they fold into ONE bubble…
  assert.equal(msgs[1].text, "Working on it.\n\nFixed — landed on main.")
  // …and the divider closes it, at the resting record's own timestamp.
  assert.equal(msgs[2].kind, "event")
  assert.equal(msgs[2].boundary, "rest")
  assert.equal(msgs[2].text, "Agent rested")
  assert.equal(msgs[2].at, "2026-07-01T00:00:02.000Z")
})

test("end_turn riding EVERY record of a split message yields ONE divider, under ONE bubble", () => {
  // Real shape: a multi-block final message is written as several records that all carry the message's
  // `stop_reason`. 9 such message ids across 12 of this machine's transcripts. Emitting per record would
  // repeat the rule AND — because a divider at the tail is `kind:"event"`, which fails the merge check —
  // strand the later blocks in a second bubble BELOW it.
  const msgs = parseTranscript([
    restLine("m1", "First block.", "2026-07-01T00:00:01.000Z"),
    restLine("m1", "Second block.", "2026-07-01T00:00:02.000Z"),
  ].join("\n"))
  assert.equal(msgs.length, 2, "one bubble + one divider")
  assert.equal(msgs[0].text, "First block.\n\nSecond block.")
  assert.equal(msgs[1].boundary, "rest")
})

test("the CURRENT rest renders without waiting for a following record", () => {
  // The rest that matters most is the trailing one — the agent has stopped and it is the reader's move.
  // The incremental fold never calls finalize(), so this only works if the accessors surface the still-
  // held divider rather than it being flushed on some later record that may never arrive.
  const fold = createTranscriptFold()
  fold.ingest(restLine("m1", "All done.", "2026-07-01T00:00:01.000Z") + "\n")
  assert.equal(fold.messages().at(-1)?.boundary, "rest")
  assert.equal(fold.allMessages().at(-1)?.boundary, "rest")
  // …and it is not duplicated once the next turn's records land on top of it.
  fold.ingest(JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:03.000Z", message: { content: "one more thing" } }) + "\n")
  const msgs = fold.messages()
  assert.equal(msgs.filter((m) => m.boundary === "rest").length, 1)
  assert.equal(msgs.at(-1)?.role, "user", "the divider sits BETWEEN the turns, not after the follow-up")
})

test("a turn that stopped for any other reason gets no rest divider", () => {
  // stop_sequence is the synthetic usage-limit stop (backend/usage-limit.ts) — the board reports that
  // its own way; claiming the agent "rested" would name a handoff that never happened. And an end_turn
  // record that rendered NOTHING has no bubble for a divider to close.
  const limited = parseTranscript(restLine("m1", "Working.", "2026-07-01T00:00:01.000Z", "stop_sequence"))
  assert.deepEqual(limited.map((m) => m.boundary), [undefined])
  const empty = parseTranscript(restLine("m1", "", "2026-07-01T00:00:01.000Z"))
  assert.equal(empty.length, 0)
})

test("a Monitor card stays pending through launch ack + progress event; the timeout record ends it", () => {
  // Corpus-real Monitor-timeout shape (session 54b37ebe / bnmdbtlwx): the timeout emits ONE
  // notification with NO <status> and NO <tool-use-id> — only <task-id> + the "[Monitor timed out"
  // <event> sentinel. Correlation rides the task id captured from the launch ack.
  const launch = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: "m-mon", content: [{ type: "tool_use", id: "mon-1", name: "Monitor", input: { command: "test -f /tmp/marker", description: "wait for agent sweep" } }] },
  })
  const acked = JSON.stringify({
    type: "user",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { content: [{ type: "tool_result", tool_use_id: "mon-1", content: "Monitor started (task bnmdbtlwx, timeout 300s). You will be notified on each event." }] },
  })
  const monitorEvent = (event: string, at: string) => JSON.stringify({
    type: "queue-operation",
    timestamp: at,
    content: `<task-notification>\n<task-id>bnmdbtlwx</task-id>\n<summary>Monitor event: "wait for agent sweep"</summary>\n<event>${event}</event>\n</task-notification>`,
  })
  // Launch ack must NOT complete the card (it is only an acknowledgement)…
  const live = parseTranscript([launch, acked].join("\n"))[0].tools[0]
  assert.equal(live.status, "pending")
  assert.equal(live.backgroundState, "background")
  // …and neither must an ordinary progress event (it also has <event> and no <status> — the trap).
  const stillLive = parseTranscript([launch, acked, monitorEvent("DISK READY", "2026-07-01T00:02:00.000Z")].join("\n"))
  assert.equal(stillLive[0].tools[0].status, "pending", "a status-less progress event must not end a live monitor")
  assert.equal(stillLive.length, 1, "a progress event emits no boundary card")
  // The timeout record reaches a terminal state and emits a labeled wake boundary.
  const msgs = parseTranscript(
    [launch, acked, monitorEvent("DISK READY", "2026-07-01T00:02:00.000Z"), monitorEvent("[Monitor timed out — re-arm if needed.]", "2026-07-01T00:05:00.000Z")].join("\n"),
  )
  assert.equal(msgs[0].tools[0].status, "cancelled")
  assert.equal(msgs[0].tools[0].durationMs, 5 * 60_000) // launch (00:00) → timeout record (05:00)
  const boundary = msgs[1]
  assert.equal(boundary.kind, "event")
  assert.equal(boundary.text, "Background task «wait for agent sweep» timed out")
})

test("a manual TaskStop result marks the stopped Monitor's card cancelled (no dangling pending card)", () => {
  const launch = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: "m-mon", content: [{ type: "tool_use", id: "mon-1", name: "Monitor", input: { command: "gh pr checks --watch", description: "Watch PR checks", persistent: true } }] },
  })
  const acked = JSON.stringify({
    type: "user",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { content: [{ type: "tool_result", tool_use_id: "mon-1", content: "Monitor started (task b1ew0iy19, persistent — runs until TaskStop or session end)." }] },
  })
  const stopUse = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:30.000Z",
    message: { id: "m-stop", content: [{ type: "tool_use", id: "stop-1", name: "TaskStop", input: { task_id: "b1ew0iy19" } }] },
  })
  const stopResult = JSON.stringify({
    type: "user",
    timestamp: "2026-07-01T00:00:31.000Z",
    message: { content: [{ type: "tool_result", tool_use_id: "stop-1", content: JSON.stringify({ message: "Successfully stopped task: b1ew0iy19 (gh pr checks --watch)", task_id: "b1ew0iy19", task_type: "monitor" }) }] },
  })
  const msgs = parseTranscript([launch, acked, stopUse, stopResult].join("\n"))
  assert.equal(msgs[0].tools[0].status, "cancelled", "a TaskStop is the terminal signal for the op it killed")
})

test("a shell completion RACING ahead of its launch is recovered by the inline attachment carrier", () => {
  // Real 2026-07-22 tailer leak, timeline-side: a shell completing MID-TURN gets its queue-operation
  // completion flushed at a file position BEFORE the launch record — folded first, it correlates to
  // nothing. The attachment (queued_command) carrier is written inline AFTER the launch and must
  // back-fill the card; reading only the queue-operation carrier left it "running" forever.
  const early = JSON.stringify({
    type: "queue-operation",
    timestamp: "2026-07-01T00:00:05.000Z",
    content: `<task-notification>\n<task-id>b9race</task-id>\n<tool-use-id>bash-race</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>`,
  })
  const launch = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:06.000Z",
    message: { id: "m-bg", content: [{ type: "tool_use", id: "bash-race", name: "Bash", input: { command: "git worktree add ../wt", run_in_background: true } }] },
  })
  const acked = JSON.stringify({
    type: "user",
    timestamp: "2026-07-01T00:00:07.000Z",
    message: { content: [{ type: "tool_result", tool_use_id: "bash-race", content: "Command running in background with ID: b9race. Output is being written to: /tmp/tasks/b9race.output." }] },
  })
  const attachment = JSON.stringify({
    type: "attachment",
    timestamp: "2026-07-01T00:00:08.000Z",
    attachment: { type: "queued_command", commandMode: "task-notification", prompt: `<task-notification>\n<task-id>b9race</task-id>\n<tool-use-id>bash-race</tool-use-id>\n<status>completed</status>\n<summary>done</summary>\n</task-notification>` },
  })
  const withoutAttachment = parseTranscript([early, launch, acked].join("\n"))[0].tools[0]
  assert.equal(withoutAttachment.status, "pending", "the early queue-op correlates to nothing — no false back-fill")
  const msgs = parseTranscript([early, launch, acked, attachment].join("\n"))
  assert.equal(msgs[0].tools[0].status, "completed", "the inline attachment carrier back-fills the raced card")
  assert.equal(msgs.at(-1)?.kind, "event", "the wake boundary rides the attachment's position")
})

test("a FOREGROUND Bash auto-backgrounded on timeout keeps its card pending, then ends on its notification", () => {
  // Regression: the harness moves a foreground Bash that outlives its `timeout` into the background,
  // saying so ONLY in the result. The projector keyed `backgroundState` off `run_in_background` alone,
  // so the card read COMPLETED the instant the shell detached and its real completion landed on
  // nothing — no wake boundary, no terminal status. Real shape, 2026-07-30 pullfrog session.
  const launch = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: "m-fg", content: [{ type: "tool_use", id: "bash-fg", name: "Bash", input: { command: "until grep -q '^TOTALS' log; do sleep 25; done", description: "Wait for the backfill to finish", timeout: 590000 } }] },
  })
  const handoff = JSON.stringify({
    type: "user",
    timestamp: "2026-07-01T00:10:00.000Z",
    message: { content: [{ type: "tool_result", tool_use_id: "bash-fg", content: "Command did not complete within its 590s timeout and was moved to the background (ID: bhlfxzwg1). Output is being written to: /tmp/tasks/bhlfxzwg1.output. You will be notified when it completes. To check interim output, use Read on that file path." }] },
  })
  const detached = parseTranscript([launch, handoff].join("\n"))[0].tools[0]
  assert.equal(detached.status, "pending", "the handoff ack is not the command's result — the shell is still running")
  assert.equal(detached.backgroundState, "background", "from the handoff on it is an ordinary detached shell")
  assert.equal(detached.shellId, "bash-fg", "the tailer parks an auto-backgrounded shell under its ORIGINAL tool_use id too, so the strip can still reconcile the two rows")

  // Correlating by TASK id alone (the notification shape that carries no tool-use-id) proves the
  // handoff's "(ID: …)" was captured, not just the tool_use pairing.
  const notification = JSON.stringify({
    type: "attachment",
    timestamp: "2026-07-01T00:20:00.000Z",
    attachment: { type: "queued_command", commandMode: "task-notification", prompt: `<task-notification>\n<task-id>bhlfxzwg1</task-id>\n<status>completed</status>\n<summary>Background command "Wait for the backfill to finish" completed (exit code 0)</summary>\n</task-notification>` },
  })
  const msgs = parseTranscript([launch, handoff, notification].join("\n"))
  assert.equal(msgs[0].tools[0].status, "completed", "its completion notification ends the card")
  assert.equal(msgs.at(-1)?.kind, "event", "the wake it caused is shown as a turn boundary")
})

test("a `stopped` RECOVERY notification back-fills EVERY orphaned card it names (task-ids only)", () => {
  // A new session's recovery record carries one block naming every orphan by runtime task-id, NO
  // tool-use-ids, status "stopped". Both cards must end (cancelled), not just the first.
  const launch = (id: string, cmd: string) => JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: `m-${id}`, content: [{ type: "tool_use", id, name: "Bash", input: { command: cmd, run_in_background: true } }] },
  })
  const ack = (id: string, taskId: string) => JSON.stringify({
    type: "user",
    timestamp: "2026-07-01T00:00:01.000Z",
    message: { content: [{ type: "tool_result", tool_use_id: id, content: `Command running in background with ID: ${taskId}. Output is being written to: /tmp/tasks/${taskId}.output.` }] },
  })
  const recovery = JSON.stringify({
    type: "queue-operation",
    timestamp: "2026-07-01T00:05:00.000Z",
    content: `<task-notification>\n<task-id>bxx1</task-id>\n<task-id>bxx2</task-id>\n<task-id>__orphan_summary__:shell</task-id>\n<status>stopped</status>\n<summary>These ops have no completion record and have been marked stopped.</summary>\n</task-notification>`,
  })
  const msgs = parseTranscript([launch("sh1", "watch ci"), ack("sh1", "bxx1"), launch("sh2", "tail -f app.log"), ack("sh2", "bxx2"), recovery].join("\n"))
  const cards = msgs.flatMap((m) => m.tools)
  assert.deepEqual(cards.map((c) => c.status), ["cancelled", "cancelled"], "every named orphan's card ends")
})

test("a completion notification riding a USER record's text back-fills the card (carrier b)", () => {
  const launch = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: "m-bg", content: [{ type: "tool_use", id: "bash-u", name: "Bash", input: { command: "sleep 1", run_in_background: true } }] },
  })
  const userCarrier = JSON.stringify({
    type: "user",
    timestamp: "2026-07-01T00:00:04.000Z",
    message: { role: "user", content: [{ type: "text", text: `<task-notification>\n<tool-use-id>bash-u</tool-use-id>\n<status>failed</status>\n<summary>Background command failed with exit code 9</summary>\n</task-notification>` }] },
  })
  const msgs = parseTranscript([launch, userCarrier].join("\n"))
  assert.equal(msgs[0].tools[0].status, "failed")
  assert.equal(msgs.filter((m) => m.role === "user").length, 0, "the carrier record never renders as a human bubble")
})

test("background Bash with no completion remains live after transcript reload", () => {
  const raw = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: "m-bg", content: [{ type: "tool_use", id: "bash-orphan", name: "Bash", input: { command: "watch ci", run_in_background: true } }] },
  })
  const once = parseTranscript(raw)[0].tools[0]
  const reloaded = parseTranscript(raw)[0].tools[0]
  assert.deepEqual({ status: reloaded.status, backgroundState: reloaded.backgroundState }, { status: once.status, backgroundState: once.backgroundState })
  assert.equal(reloaded.status, "pending")
})

test("Bash command block is capped with a truncation marker", () => {
  const cmd = "run\n" + "y".repeat(5000)
  const call = parseTranscript(toolLine("Bash", { command: cmd })).at(0)!.tools[0]
  assert.ok(call.command!.length < cmd.length)
  assert.ok(call.command!.endsWith("(truncated)"))
})

// ---- Agent dispatch card + completion event ----

// An assistant record carrying an Agent tool_use with an explicit block id (toolLine omits the id).
function agentDispatch(id: string, input: unknown, ts = "2026-07-01T00:00:00.000Z"): string {
  return JSON.stringify({ type: "assistant", timestamp: ts, message: { id: "m1", content: [{ type: "tool_use", name: "Agent", id, input }] } })
}
function taskNotification(toolUseId: string, status: string, ts: string): string {
  return JSON.stringify({
    type: "queue-operation",
    timestamp: ts,
    content: `<task-notification>\n<tool-use-id>${toolUseId}</tool-use-id>\n<status>${status}</status>\n</task-notification>`,
  })
}

test("Agent dispatch with a prompt → AgentBlock fields captured (detail/prompt/type/id)", () => {
  const rec = agentDispatch("toolu_a", { description: "Do the thing", prompt: "Long prompt here", subagent_type: "frizz:frizz-opus-high", run_in_background: true })
  const call = parseTranscript(rec).at(0)!.tools[0]
  assert.equal(call.name, "Agent")
  assert.equal(call.detail, "Do the thing")
  assert.equal(call.prompt, "Long prompt here")
  // The cell is RESOLVED, not verbatim: the legacy double prefix collapses to the one canonical shape
  // every surface renders (see subagent-profile.ts).
  assert.equal(call.subagentType, "frizz:opus-high")
  assert.equal(call.agentId, "toolu_a")
})

test("Agent dispatch: the card names a model whether the call gave one or inherited it", () => {
  // The shape since 2026-08-26 — an effort-only profile, the model on the call's own parameter.
  const explicit = agentDispatch("toolu_a", { description: "d", prompt: "p", subagent_type: "frizz:high", model: "sonnet", run_in_background: true })
  assert.equal(parseTranscript(explicit).at(0)!.tools[0].subagentType, "frizz:sonnet-high")
  // …and with the model omitted, the child inherits the dispatching turn's, which the record states.
  const inherited = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    effort: "max",
    message: { id: "m1", model: "claude-opus-5", content: [{ type: "tool_use", name: "Agent", id: "toolu_b", input: { description: "d", prompt: "p", subagent_type: "frizz:high", run_in_background: true } }] },
  })
  assert.equal(parseTranscript(inherited).at(0)!.tools[0].subagentType, "frizz:opus-high")
})

test("Agent prompt is capped with a truncation marker", () => {
  const big = "z".repeat(6000)
  const call = parseTranscript(agentDispatch("toolu_a", { description: "x", prompt: big, run_in_background: true })).at(0)!.tools[0]
  assert.ok(call.prompt!.length < big.length)
  assert.ok(call.prompt!.endsWith("(truncated)"))
})

test("SendMessage → SendMessageCard fields captured (to/summary/body/type)", () => {
  const call = parseTranscript(toolLine("SendMessage", { to: "win-vm-provision", summary: "Steer to UTM path", message: "Try `utmctl` first.", type: "message" })).at(0)!.tools[0]
  assert.equal(call.name, "SendMessage")
  assert.equal(call.sendTo, "win-vm-provision")
  assert.equal(call.sendSummary, "Steer to UTM path")
  assert.equal(call.sendBody, "Try `utmctl` first.")
  assert.equal(call.sendType, "message")
  // detail falls back to the summary (else the recipient) so a degrading old client still shows something.
  assert.equal(call.detail, "Steer to UTM path")
})

test("SendMessage accepts the recipient/content aliases and a shutdown_request type", () => {
  const call = parseTranscript(toolLine("SendMessage", { recipient: "peer", content: "please rest", type: "shutdown_request" })).at(0)!.tools[0]
  assert.equal(call.sendTo, "peer")
  assert.equal(call.sendBody, "please rest")
  assert.equal(call.sendType, "shutdown_request")
  assert.equal(call.sendSummary, undefined)
})

test("SendMessage body is capped with a truncation marker", () => {
  const big = "z".repeat(6000)
  const call = parseTranscript(toolLine("SendMessage", { to: "x", message: big })).at(0)!.tools[0]
  assert.ok(call.sendBody!.length < big.length)
  assert.ok(call.sendBody!.endsWith("(truncated)"))
})

test("SendUserFile → an image is copied into the servable cache (sentImages) + caption captured", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-sent-"))
  const png = join(dir, "shot.png")
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4])) // PNG magic + filler
  try {
    const call = parseTranscript(toolLine("SendUserFile", { files: [png], caption: "the fix", status: "proactive" })).at(0)!.tools[0]
    assert.equal(call.name, "SendUserFile")
    assert.equal(call.caption, "the fix")
    assert.equal(call.sentImages?.length, 1)
    // Separator-agnostic: the copy is placed with path.join, so win32 spells it with a backslash.
    assert.match(call.sentImages![0], /frizz-tool-images-[0-9a-f]{16}[\\/][0-9a-f]{32}\.png$/) // servable cache copy, not the source
    assert.equal(call.sentFiles, undefined)
    assert.ok(readFileSync(call.sentImages![0]).length >= 12) // the copy exists on disk
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("SendUserFile → a non-image file is an openable chip (sentFiles keeps the full path); no image copy", () => {
  const call = parseTranscript(toolLine("SendUserFile", { files: ["/abs/report.md"], caption: "the report" })).at(0)!.tools[0]
  assert.equal(call.sentImages, undefined)
  assert.deepEqual(call.sentFiles, ["/abs/report.md"]) // full path so the client can link it
  assert.equal(call.caption, "the report")
})

test("SendUserFile display:attach renders even an image as a chip, never inline", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-sent-"))
  const png = join(dir, "shot.png")
  writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]))
  try {
    const call = parseTranscript(toolLine("SendUserFile", { files: [png], display: "attach" })).at(0)!.tools[0]
    assert.equal(call.sentImages, undefined)
    assert.deepEqual(call.sentFiles, [png])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("SendUserFile reusing a path with new content across calls is NOT served stale (cache keyed on the call)", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-sent-"))
  const png = join(dir, "shot.png") // the SAME filename the worker overwrites each QA iteration
  const toolLineId = (id: string) => JSON.stringify({
    type: "assistant", timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: "m1", content: [{ type: "tool_use", id, name: "SendUserFile", input: { files: [png] } }] },
  })
  try {
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 1, 1, 1]))
    const first = parseTranscript(toolLineId("sf-call-1")).at(0)!.tools[0].sentImages![0]
    writeFileSync(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9, 9, 9])) // overwrite, new bytes
    const second = parseTranscript(toolLineId("sf-call-2")).at(0)!.tools[0].sentImages![0]
    assert.notEqual(first, second) // distinct cache entries — the second call is not the stale first copy
    assert.deepEqual([...readFileSync(second)].slice(8), [9, 9, 9, 9, 9, 9]) // the fresh content
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("Agent completion → inline marker call (agentCompletion) + back-filled terminal state", () => {
  const msgs = parseTranscript(
    [
      agentDispatch("toolu_a", { description: "Do the thing", prompt: "p", run_in_background: true }, "2026-07-01T00:00:00.000Z"),
      taskNotification("toolu_a", "completed", "2026-07-01T00:35:00.000Z"),
    ].join("\n"),
  )
  // The completion re-emits the dispatch's Agent tool call inline at the notification's position — a
  // plain assistant message carrying the finished call as a tools part, NOT a text event line. The
  // `agentCompletion` flag is what tells the client this copy is the wake DIVIDER (the same rendering
  // a background shell's completion gets) rather than a second AgentBlock card.
  const completion = msgs.at(-1)!
  assert.equal(completion.kind, undefined)
  const inline = completion.tools[0]
  assert.equal(inline.name, "Agent")
  assert.equal(inline.detail, "Do the thing")
  assert.equal(inline.agentId, "toolu_a", "carries the correlation id so the divider title links into the drawer")
  assert.equal(inline.agentStatus, "completed")
  assert.equal(inline.agentElapsedMs, 35 * 60_000)
  assert.equal(inline.agentCompletion, true)
  assert.deepEqual(completion.parts, [{ kind: "tools", tools: [inline] }])
  // the ORIGINAL launch card is also back-filled with the outcome — but is NOT a completion marker, so
  // it keeps its expandable prompt card. Flagging both would have turned the launch into a divider too.
  const call = msgs[0].tools[0]
  assert.equal(call.agentCompletion, undefined)
  assert.equal(call.prompt, "p")
  assert.equal(call.agentStatus, "completed")
  assert.equal(call.agentElapsedMs, 35 * 60_000)
  assert.equal(call.status, "completed")
  assert.equal(call.durationMs, 35 * 60_000)
})

test("failed sub-agent → inline failed completion marker; a background-bash notification is ignored", () => {
  const msgs = parseTranscript(
    [
      agentDispatch("toolu_a", { description: "X", prompt: "p", run_in_background: true }, "2026-07-01T00:00:00.000Z"),
      taskNotification("toolu_bash", "completed", "2026-07-01T00:05:00.000Z"), // not a tracked Agent id
      taskNotification("toolu_a", "failed", "2026-07-01T00:12:00.000Z"),
    ].join("\n"),
  )
  // Dispatch card + ONE completion card; the untracked background-bash notification emits nothing.
  assert.equal(msgs.length, 2)
  const inline = msgs.at(-1)!.tools[0]
  assert.equal(inline.agentStatus, "failed")
  assert.equal(inline.agentElapsedMs, 12 * 60_000)
  assert.equal(inline.status, "failed")
})

test("an immediate Agent launch error terminates the card instead of leaving it pending forever", () => {
  const raw = [
    agentDispatch("tu1", { prompt: "review", description: "reviewer", subagent_type: "general" }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-13T06:24:01.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", is_error: true, content: "Agent launch failed: thread limit reached" }] },
    }),
  ].join("\n")
  const call = parseTranscript(raw)[0].tools[0]
  assert.equal(call.status, "failed")
  assert.match(call.output ?? "", /thread limit reached/)
})

// The SECOND completion shape: the harness names the finished child ONLY by its agent id. The tailer
// always correlated this (launchTaskId reads the ack's agentId), so the row left every live surface —
// while this parser resolved the task-id against a shells-only map, drew no divider and left the launch
// card pending. 8.1% of the local corpus's 1905 Agent dispatches terminate this way; the maintainer saw
// it as sub-agents disappearing from the rendered list with no notification (2026-07-30).
test("a task-id-ONLY completion notification still retires the sub-agent and emits its divider", () => {
  const ack = (toolUseId: string, agentId: string) =>
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-01T00:00:01.000Z",
      toolUseResult: { isAsync: true, status: "async_launched", agentId },
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolUseId, content: `Async agent launched successfully.\nagentId: ${agentId} (internal ID - do not mention to user.)` }],
      },
    })
  const taskIdNotification = (agentId: string, ts: string) =>
    JSON.stringify({
      type: "queue-operation",
      timestamp: ts,
      content: `<task-notification>\n<task-id>${agentId}</task-id>\n<status>completed</status>\n<summary>Agent "Survey" finished</summary>\n</task-notification>`,
    })
  const msgs = parseTranscript(
    [
      agentDispatch("toolu_a", { description: "Survey", prompt: "p", run_in_background: true }, "2026-07-01T00:00:00.000Z"),
      ack("toolu_a", "aab99c3e7b670a3ae"),
      taskIdNotification("aab99c3e7b670a3ae", "2026-07-01T00:14:00.000Z"),
    ].join("\n"),
  )
  const inline = msgs.at(-1)!.tools[0]
  assert.equal(inline.agentCompletion, true, "the divider marker — with no tool-use-id to correlate on")
  assert.equal(inline.agentStatus, "completed")
  assert.equal(inline.agentElapsedMs, 14 * 60_000)
  // …and the launch card up-thread stops spinning, the other half of the same disappearance.
  const launch = msgs[0].tools[0]
  assert.equal(launch.status, "completed")
  assert.equal(launch.agentStatus, "completed")
})

test("a Bash ack whose output merely mentions an agentId never claims the task id", () => {
  // The agent arm is gated on the card actually BEING an Agent dispatch — a shell that echoes the word
  // must not hijack a later task-id notification and retire the wrong card.
  const msgs = parseTranscript(
    [
      JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:00.000Z", message: { id: "m1", content: [{ type: "tool_use", name: "Bash", id: "toolu_sh", input: { command: "echo agentId: aab99c3e7b670a3ae", run_in_background: true } }] } }),
      JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:01.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_sh", content: "Command running in background with ID: bsh1.\nagentId: aab99c3e7b670a3ae" }] } }),
      JSON.stringify({ type: "queue-operation", timestamp: "2026-07-01T00:05:00.000Z", content: `<task-notification>\n<task-id>aab99c3e7b670a3ae</task-id>\n<status>completed</status>\n</task-notification>` }),
    ].join("\n"),
  )
  assert.equal(msgs.filter((m) => m.boundary).length, 0, "the shell's real id is bsh1 — this notification correlates to nothing")
})

test("a duplicate terminal notification re-renders the completion card only once", () => {
  const msgs = parseTranscript(
    [
      agentDispatch("toolu_a", { description: "X", prompt: "p", run_in_background: true }, "2026-07-01T00:00:00.000Z"),
      taskNotification("toolu_a", "completed", "2026-07-01T00:10:00.000Z"),
      taskNotification("toolu_a", "completed", "2026-07-01T00:10:00.000Z"),
    ].join("\n"),
  )
  // First notification consumes the dispatch entry; the second matches nothing → no second card.
  assert.equal(msgs.length, 2) // dispatch card + exactly one completion card
})

// ---- long thinking windows (no longer surfaced; see the test below) ----
const userRec = (ts: string) => JSON.stringify({ type: "user", timestamp: ts, message: { content: "go" } })
const thinkRec = (ts: string, mid: string) => JSON.stringify({ type: "assistant", timestamp: ts, message: { id: mid, content: [{ type: "thinking", signature: "sig", thinking: "" }] } })
const bashRec = (ts: string, mid: string) => JSON.stringify({ type: "assistant", timestamp: ts, message: { id: mid, content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } })

test("a long thinking window leaves NO row behind, only the turn's own card", () => {
  // Claude's thinking content is redacted, so this line could only ever have reported a DURATION — and a
  // permanent row whose whole payload is "the model paused here" is what the transcript stopped carrying
  // (maintainer 2026-08-01: "it should never show up persistently like that"). The live shimmer says
  // `Thinking…` while it is happening, which is when the fact is worth something.
  const msgs = parseTranscript([userRec("2026-07-01T00:00:00.000Z"), thinkRec("2026-07-01T00:00:30.000Z", "m1"), bashRec("2026-07-01T00:00:31.000Z", "m1")].join("\n"))
  assert.equal(msgs.filter((m) => m.kind === "event").length, 0, "a thinking window emits no event line at any duration")
  const toolMsg = msgs.find((m) => m.role === "assistant" && m.kind === undefined && m.tools.length > 0)
  assert.ok(toolMsg, "the turn's tool card is still its own message")
})

test("a thinking-only record opening a NEW turn does not glue that turn onto the previous one", () => {
  // The interleave "wall of text" trap: turn A (text + tool) is out's tail, a tool_result sits between,
  // then turn B opens with a THINKING-ONLY record (short gap → no event line). A thinking-only record
  // renders nothing, so it must NOT claim the merge anchor for its new id — otherwise B's text+tools
  // fold into A's bubble (tool calls under the wrong turn, texts coalesced into one wall).
  const asstMulti = (mid: string, ts: string, blocks: unknown[]) =>
    JSON.stringify({ type: "assistant", timestamp: ts, message: { id: mid, content: blocks } })
  const msgs = parseTranscript([
    asstMulti("mA", "2026-07-01T00:00:00.000Z", [
      { type: "text", text: "Answer A." },
      { type: "tool_use", id: "tu-a", name: "Read", input: { file_path: "/a" } },
    ]),
    JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:01.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu-a", content: "ok" }] } }),
    thinkRec("2026-07-01T00:00:03.000Z", "mB"), // short gap → no event; the trap record
    asstMulti("mB", "2026-07-01T00:00:04.000Z", [
      { type: "text", text: "Answer B." },
      { type: "tool_use", id: "tu-b", name: "Read", input: { file_path: "/b" } },
    ]),
  ].join("\n"))
  const assistant = msgs.filter((m) => m.role === "assistant" && m.kind === undefined)
  assert.equal(assistant.length, 2, "A and B are TWO separate assistant messages, not glued into one")
  assert.ok(assistant[0].text.includes("Answer A") && !assistant[0].text.includes("Answer B"), "A's bubble holds only A")
  assert.ok(assistant[1].text.includes("Answer B") && !assistant[1].text.includes("Answer A"), "B's bubble holds only B")
})

// ---- ordered parts (block-order fidelity) ----
const asstBlock = (mid: string, block: unknown) => JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:00.000Z", message: { id: mid, content: [block] } })

test("parts preserve text↔tool block ORDER within a turn (the lead-in fix)", () => {
  // Same message id across split records: text lead-in, then its tool_use, then a trailing text.
  const msgs = parseTranscript(
    [
      asstBlock("m1", { type: "text", text: "Let me draft the release notes:" }),
      asstBlock("m1", { type: "tool_use", name: "Write", input: { file_path: "/x/notes.md", content: "notes" } }),
      asstBlock("m1", { type: "text", text: "Done — notes written." }),
    ].join("\n"),
  )
  assert.equal(msgs.length, 1)
  const parts = msgs[0].parts
  assert.deepEqual(parts.map((p) => p.kind), ["text", "tools", "text"]) // ORDER preserved
  assert.equal(parts[0].kind === "text" && parts[0].text, "Let me draft the release notes:")
  assert.equal(parts[1].kind === "tools" && parts[1].tools[0].name, "Write")
  // legacy flat fields still populated for the pre-restart client window
  assert.equal(msgs[0].tools.length, 1)
  assert.ok(msgs[0].text.includes("Let me draft") && msgs[0].text.includes("Done"))
})

test("contiguous same-kind blocks coalesce into one part", () => {
  const msgs = parseTranscript(
    [
      asstBlock("m1", { type: "tool_use", name: "Read", input: { file_path: "/a" } }),
      asstBlock("m1", { type: "tool_use", name: "Read", input: { file_path: "/b" } }),
      asstBlock("m1", { type: "text", text: "para one" }),
      asstBlock("m1", { type: "text", text: "para two" }),
    ].join("\n"),
  )
  const parts = msgs[0].parts
  assert.deepEqual(parts.map((p) => p.kind), ["tools", "text"]) // two Reads → one tools part; two texts → one text part
  assert.equal(parts[0].kind === "tools" && parts[0].tools.length, 2)
})

// ---- queued human follow-ups to a mid-turn worker (the message-swallow fix) ----
const enqueue = (content: string, ts = "2026-07-01T00:00:00.000Z") =>
  JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: ts, content })
const removeOp = (op: string, content: string, ts = "2026-07-01T00:00:01.000Z") =>
  JSON.stringify({ type: "queue-operation", operation: op, timestamp: ts, content })
const deliver = (prompt: string, ts = "2026-07-01T00:00:01.000Z", commandMode = "prompt", kind = "human") =>
  JSON.stringify({ type: "attachment", timestamp: ts, attachment: { type: "queued_command", prompt, commandMode, origin: { kind } } })

test("enqueue with no delivery yet → a pending queued user bubble", () => {
  const msgs = parseTranscript(enqueue("ping the worker"))
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].role, "user")
  assert.equal(msgs[0].text, "ping the worker")
  assert.equal(msgs[0].queued, true)
})

test("enqueue + delivering attachment → ONE delivered user message (not two), un-queued", () => {
  const msgs = parseTranscript([enqueue("do the thing"), deliver("do the thing")].join("\n"))
  const users = msgs.filter((m) => m.role === "user")
  assert.equal(users.length, 1)
  assert.equal(users[0].text, "do the thing")
  assert.equal(users[0].queued, false) // resolved in place — no longer grayed
})

test("real lifecycle enqueue → remove → attachment → ONE delivered user message (session 2cfe3c81 shape)", () => {
  const text = "Stop. Ask me the questions again."
  const msgs = parseTranscript([enqueue(text), removeOp("remove", text), deliver(text)].join("\n"))
  const users = msgs.filter((m) => m.role === "user")
  assert.equal(users.length, 1)
  assert.equal(users[0].text, text)
  assert.ok(!users[0].queued)
})

test("attachment-only (older session, no enqueue seen) → a delivered user message", () => {
  const msgs = parseTranscript(deliver("hello from the past"))
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].role, "user")
  assert.equal(msgs[0].text, "hello from the past")
  assert.ok(!msgs[0].queued)
})

test("an EMPTY-content dequeue does NOT evict a still-pending human bubble (cross-talk guard)", () => {
  const msgs = parseTranscript(
    [enqueue("human still waiting"), JSON.stringify({ type: "queue-operation", operation: "dequeue", timestamp: "2026-07-01T00:00:02.000Z" })].join("\n"),
  )
  const users = msgs.filter((m) => m.role === "user")
  assert.equal(users.length, 1)
  assert.equal(users[0].queued, true)
})

test("a non-'prompt' commandMode attachment (a task-notification materialized the same way) is not a human bubble", () => {
  const msgs = parseTranscript(deliver("<task-notification>x</task-notification>", "2026-07-01T00:00:01.000Z", "task-notification"))
  assert.equal(msgs.length, 0)
})

test("an enqueue carrying task-notification content is not rendered as a human bubble", () => {
  const msgs = parseTranscript(
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-07-01T00:00:00.000Z",
      content: "<task-notification>\n<tool-use-id>x</tool-use-id>\n<status>running</status>\n</task-notification>",
    }),
  )
  assert.equal(msgs.length, 0) // non-terminal notification → no completion event AND no queued bubble
})

test("a delivered queued message is deduped against an immediately-following identical user record", () => {
  const msgs = parseTranscript(
    [deliver("same text"), JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:02.000Z", message: { content: "same text" } })].join("\n"),
  )
  assert.equal(msgs.filter((m) => m.role === "user").length, 1)
})

test("a queued follow-up between assistant turns leaves the assistant cards intact", () => {
  const msgs = parseTranscript(
    [
      asstBlock("m1", { type: "tool_use", name: "Bash", input: { command: "ls" } }),
      enqueue("interrupt!"),
      deliver("interrupt!"),
      asstBlock("m2", { type: "text", text: "resuming" }),
    ].join("\n"),
  )
  assert.equal(msgs.filter((m) => m.role === "user").length, 1) // one delivered human message…
  assert.equal(msgs.filter((m) => m.role === "assistant" && m.kind === undefined).length, 2) // …between two intact assistant turns
})

// An autonomous /loop wakeup is ENQUEUED like a human follow-up (gray bubble) but DELIVERED as an
// isMeta harness record — not the human's words. The isMeta drop must also splice out the pending
// queued bubble, or it lingers forever as a stuck "queued" message (thread review-nubjs-nub-515-2).
const isMetaUser = (content: string, ts = "2026-07-01T00:00:02.000Z") =>
  JSON.stringify({ type: "user", timestamp: ts, isMeta: true, message: { role: "user", content } })

test("an isMeta-delivered queued wakeup (autonomous /loop) leaves NO stuck queued bubble", () => {
  const text = "# Autonomous loop tick (dynamic pacing)\n\nRun the autonomous check."
  const msgs = parseTranscript(
    [
      enqueue(text),
      JSON.stringify({ type: "queue-operation", operation: "dequeue", timestamp: "2026-07-01T00:00:01.000Z" }),
      isMetaUser(text),
    ].join("\n"),
  )
  // Harness plumbing → neither a delivered bubble nor a lingering gray one.
  assert.equal(msgs.filter((m) => m.role === "user").length, 0)
  assert.equal(msgs.filter((m) => m.queued).length, 0)
})

test("an isMeta wakeup between assistant turns removes its bubble but keeps the assistant cards", () => {
  const text = "# Autonomous loop check\n\nyou're invoked on a timer"
  const msgs = parseTranscript(
    [
      asstBlock("m1", { type: "text", text: "resting" }),
      enqueue(text),
      JSON.stringify({ type: "queue-operation", operation: "dequeue", timestamp: "2026-07-01T00:00:01.000Z" }),
      isMetaUser(text),
      asstBlock("m2", { type: "text", text: "heartbeat tick" }),
    ].join("\n"),
  )
  assert.equal(msgs.filter((m) => m.role === "user").length, 0) // wakeup bubble spliced out
  assert.equal(msgs.filter((m) => m.role === "assistant" && m.kind === undefined).length, 2) // both turns intact
})

test("real Claude Code 2.1.207 SDK lifecycle dedupes its prompt and back-fills common tool results", () => {
  const prompt = "Exercise the disposable tool fixture."
  const raw = [
    JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "2026-07-13T06:23:55.650Z", content: prompt }),
    JSON.stringify({ type: "queue-operation", operation: "dequeue", timestamp: "2026-07-13T06:23:55.651Z" }),
    JSON.stringify({ type: "user", timestamp: "2026-07-13T06:23:55.660Z", message: { role: "user", content: prompt }, promptSource: "sdk" }),
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-13T06:23:59.000Z",
      message: {
        id: "m-real",
        content: [
          { type: "tool_use", id: "grep", name: "Grep", input: { pattern: "FRIZZ_CLAUDE_RENDER_NEEDLE", path: "/tmp/README.md" } },
          { type: "tool_use", id: "bash", name: "Bash", input: { command: "printf ok", description: "Print output" } },
          { type: "tool_use", id: "edit", name: "Edit", input: { file_path: "/tmp/a.ts", old_string: "hello", new_string: "hello-renderer" } },
          { type: "tool_use", id: "cancel", name: "Bash", input: { command: "sleep 60" } },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-13T06:24:01.000Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "grep", content: "Found 1 file\nREADME.md" },
          { type: "tool_result", tool_use_id: "bash", is_error: false, content: "FRIZZ_API_TOKEN=secret-value\nok" },
          { type: "tool_result", tool_use_id: "edit", content: "The file /tmp/a.ts has been updated successfully." },
          { type: "tool_result", tool_use_id: "cancel", is_error: true, content: "Interrupted by user" },
        ],
      },
    }),
  ].join("\n")
  const messages = parseTranscript(raw)
  assert.equal(messages.filter((m) => m.role === "user").length, 1, "enqueue + ordinary SDK user record is one prompt")
  const [grep, bash, edit, cancelled] = messages.flatMap((m) => m.tools)
  assert.equal(grep.detail, "FRIZZ_CLAUDE_RENDER_NEEDLE · /tmp/README.md")
  assert.equal(grep.output, "Found 1 file\nREADME.md")
  assert.equal(grep.status, "completed")
  assert.equal(grep.durationMs, 2000)
  assert.equal(bash.output, "FRIZZ_API_TOKEN=[redacted]\nok")
  assert.equal(bash.status, "completed")
  assert.equal(edit.status, "completed")
  assert.equal(edit.output, undefined, "successful edit acknowledgement is redundant with its diff")
  assert.equal(cancelled.status, "cancelled")
  assert.equal(cancelled.output, "Interrupted by user")
})

test("a recorded Claude call without its result remains visibly pending", () => {
  const call = parseTranscript(
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-13T06:23:59.000Z",
      message: { id: "m", content: [{ type: "tool_use", id: "still-running", name: "Monitor", input: { description: "Await CI" } }] },
    }),
  )[0].tools[0]
  assert.equal(call.status, "pending")
  assert.equal(call.detail, "Await CI")
})

test("Claude generic JSON inputs redact quoted secrets and harmless killed prose stays completed", () => {
  const raw = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-13T06:23:59.000Z",
      message: {
        id: "m",
        content: [{ type: "tool_use", id: "generic", name: "Custom", input: { FRIZZ_API_TOKEN: "json-secret-value", Authorization: "Bearer top-secret-value" } }],
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-13T06:24:01.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "generic", content: "0 killed processes; all checks passed" }] },
    }),
  ].join("\n")
  const call = parseTranscript(raw)[0].tools[0]
  assert.equal(call.status, "completed")
  assert.doesNotMatch(JSON.stringify(call), /json-secret|top-secret/)
})

// ---- screenshot / image tool results render inline (take_screenshot) ----
// A minimal valid 1×1 PNG — decodes to real bytes so the persisted file is a genuine image.
const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

// A Read of the human's OWN prompt attachment keeps its plain header: the picture is already in their
// bubble, and lifting it onto the card repeated it directly beneath (2026-08-27: "no need to auto-open
// the images read from attachments in the transcript"). The control Read — the same image result from
// any other path (a screenshot the worker took) — still renders, which is the behaviour this gate must
// not erode.
function imageRead(id: string, filePath: string): string {
  return [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-08-27T14:49:15.000Z",
      message: { id: `m-${id}`, content: [{ type: "tool_use", id, name: "Read", input: { file_path: filePath } }] },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-08-27T14:49:15.113Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1x1 } }] }],
      },
    }),
  ].join("\n")
}

test("a Read of a prompt attachment keeps its plain header; a Read of any other image still renders", () => {
  const attachment = join(projectStateDir("029a30af-f126-40e3-b04c-d80e74e3e090"), "attachments", "1787867365865-f12df6c2-Screenshot-2026-08-27-at-14-49-15.png")
  const [attached] = parseTranscript(imageRead("read-attachment", attachment))[0].tools
  assert.equal(attached.name, "Read")
  assert.equal(attached.detail, attachment)
  assert.equal(attached.status, "completed")
  assert.equal(attached.durationMs, 113)
  assert.equal(attached.outputImage, undefined, "the human's own attachment is not repeated on the card")
  assert.equal(attached.read, undefined, "an image result carries no text excerpt either")

  const [shot] = parseTranscript(imageRead("read-screenshot", "/tmp/frizz-shots/board.png"))[0].tools
  assert.match(shot.outputImage!, /frizz-tool-images-[0-9a-f]{16}[/\\][0-9a-f]{32}\.png$/, "a worker's own screenshot still renders")
})

test("a screenshot tool_result carrying a base64 image is decoded to a servable outputImage path", () => {
  const raw = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-13T06:23:59.000Z",
      message: { id: "m", content: [{ type: "tool_use", id: "shot", name: "mcp__chrome-devtools__take_screenshot", input: {} }] },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-13T06:24:00.000Z",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "shot",
          content: [
            { type: "text", text: "Took a screenshot of the current page." },
            { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1x1 } },
          ],
        }],
      },
    }),
  ].join("\n")
  const call = parseTranscript(raw)[0].tools[0]
  assert.equal(call.status, "completed")
  assert.ok(call.outputImage, "outputImage path is set")
  assert.match(call.outputImage!, /frizz-tool-images-[0-9a-f]{16}[/\\][0-9a-f]{32}\.png$/)
  // The decoded file exists on disk with the exact source bytes, so /local-image can serve it.
  const bytes = readFileSync(call.outputImage!)
  assert.deepEqual(bytes, Buffer.from(PNG_1x1, "base64"))
  // Accompanying text still renders as the output pane.
  assert.match(call.output ?? "", /Took a screenshot/)
})

test("a failed screenshot tool_result does not persist an image", () => {
  const raw = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-13T06:23:59.000Z",
      message: { id: "m", content: [{ type: "tool_use", id: "shot", name: "take_screenshot", input: {} }] },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-13T06:24:00.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "shot", is_error: true, content: "Error: no page open" }],
      },
    }),
  ].join("\n")
  const call = parseTranscript(raw)[0].tools[0]
  assert.equal(call.status, "failed")
  assert.equal(call.outputImage, undefined)
})

// `id` must be UNIQUE per test: the cache filename derives from the tool_use id, so reusing an id that a
// prior test persisted would (correctly) short-circuit via existsSync and return that earlier file.
function screenshotResult(id: string, mediaType: string, dataB64: string): string {
  return [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-13T06:23:59.000Z",
      message: { id: "m", content: [{ type: "tool_use", id, name: "take_screenshot", input: {} }] },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-13T06:24:00.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: id, content: [{ type: "image", source: { type: "base64", media_type: mediaType, data: dataB64 } }] }],
      },
    }),
  ].join("\n")
}

test("an unrecognized image media type (svg) is never persisted or guessed as png", () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString("base64")
  const call = parseTranscript(screenshotResult("shot-svg", "image/svg+xml", svg))[0].tools[0]
  assert.equal(call.status, "completed")
  assert.equal(call.outputImage, undefined, "svg is skipped — no png-mislabeled file")
})

test("a base64 payload whose bytes are not the claimed image type is skipped (no broken img)", () => {
  const garbage = Buffer.from("this is not a png at all").toString("base64")
  const call = parseTranscript(screenshotResult("shot-garbage", "image/png", garbage))[0].tools[0]
  assert.equal(call.status, "completed")
  assert.equal(call.outputImage, undefined, "magic-byte mismatch → text fallback, not a broken image")
})

test("Claude command, description, and result projections redact CLI and URL credential syntax", () => {
  const fixtures = {
    user: "fixture-claude-user-credential",
    token: "fixture-claude-token-credential",
    encoded: "%66%69%78%74%75%72%65-claude-url-credential",
    result: "fixture-claude-result-credential",
  }
  const raw = [
    JSON.stringify({
      type: "assistant",
      timestamp: "2026-07-13T06:23:59.000Z",
      message: {
        id: "m",
        content: [{
          type: "tool_use",
          id: "bash-credentials",
          name: "Bash",
          input: {
            command: `curl -u alice:${fixtures.user} --api-key=${fixtures.token} https://bob:${fixtures.encoded}@example.test/private`,
            description: `Retry https://ops:${fixtures.token}@example.test`,
          },
        }],
      },
    }),
    JSON.stringify({
      type: "user",
      timestamp: "2026-07-13T06:24:01.000Z",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "bash-credentials",
          is_error: true,
          content: `failed --password '${fixtures.result}' at https://service:${fixtures.result}@example.test`,
        }],
      },
    }),
  ].join("\n")
  const call = parseTranscript(raw)[0].tools[0]
  const rendered = JSON.stringify(call)
  for (const fixture of Object.values(fixtures)) assert.equal(rendered.includes(fixture), false, fixture)
  assert.match(call.command ?? "", /curl -u alice:\[redacted\] --api-key=\[redacted\]/)
  assert.match(call.command ?? "", /https:\/\/bob:\[redacted\]@example\.test/)
  assert.match(call.desc ?? "", /https:\/\/ops:\[redacted\]@example\.test/)
  assert.match(call.output ?? "", /--password \[redacted\].*https:\/\/service:\[redacted\]@example\.test/)
})

// ---- readThreadTranscript: transcript_id honoring + GATED discovery fallback (session-transcript-drift) ----
// These exercise the real path resolution, which reads ~/.claude/projects/<cwdSlug>/<id>.jsonl. We use a
// unique throwaway cwdSlug under the real log root and clean it up, so the test is hermetic in practice.

const DGRACE_MS = 60_000
function txHarness() {
  const slug = `-tmp-frizz-tx-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const logDir = join(homedir(), ".claude", "projects", slug)
  mkdirSync(logDir, { recursive: true })
  const store = createStorage(join(mkdtempSync(join(tmpdir(), "frizz-tx-")), "ui.db"), "p")
  const project = { cwdSlug: slug } as unknown as Project
  const writeJsonl = (id: string, lines: string[]) => writeFileSync(join(logDir, `${id}.jsonl`), lines.map((l) => l + "\n").join(""))
  const cleanup = () => { try { rmSync(logDir, { recursive: true, force: true }) } catch { /* best-effort */ } }
  return { slug, logDir, store, project, writeJsonl, cleanup }
}
function txRow(over: Partial<SessionRow>): SessionRow {
  return { slug: "t", session_id: "sid", thread_name: "frizz-t", spawned_at: new Date().toISOString(), last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0, title: null, state: "open", meta: null, seen_at: null, transcript_id: null, ...over }
}
const USER_LINE = (text: string) => JSON.stringify({ type: "user", timestamp: "2026-07-10T18:00:00.000Z", message: { role: "user", content: text } })

test("readThreadTranscript: honors a cached transcript_id over the pinned session_id", () => {
  const h = txHarness()
  try {
    h.store.upsertSession(txRow({ transcript_id: "forked-x" }))
    h.writeJsonl("forked-x", [USER_LINE("render me from the drifted file")])
    // NO sid.jsonl written — resolution must pick the transcript_id file.
    const msgs = readThreadTranscript(h.project, h.store, "t")
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].text, "render me from the drifted file")
  } finally {
    h.cleanup()
  }
})

test("readThreadTranscript: a FOREIGN codex rollout renders through the codex reader, exactly like the paged reader", () => {
  // The /ws producer and the HTTP page reader must bind a foreign slug to the SAME file. Until
  // 2026-08-24 this reader tried only the Claude log dir, so an external codex row's socket keyframe
  // was [] and blanked the page the HTTP reader had just rendered ("No conversation yet." for ~7s).
  const h = txHarness()
  const codexHome = mkdtempSync(join(tmpdir(), "frizz-tx-codex-"))
  try {
    const fixture = readFileSync(join(import.meta.dirname, "backend/codex.fixtures/tui-single-turn.jsonl"), "utf8")
    const id = "019f4e0c-8ab2-7bc3-8b19-fc108b2d3114" // the fixture's own session id; the filename must end with it
    const day = join(codexHome, "sessions", "2026", "08", "24")
    mkdirSync(day, { recursive: true })
    writeFileSync(join(day, `rollout-2026-08-24T12-00-00-${id}.jsonl`), fixture)
    const backendFor = () => createCodexBackend({ codexHome })
    const msgs = readThreadTranscript(h.project, h.store, id, backendFor)
    assert.ok(msgs.length > 0, "a foreign codex id resolves to its rollout, not to a missing Claude file")
    const paged = readLatestThreadTranscriptPage(h.project, h.store, id, backendFor)
    assert.deepEqual(msgs.map((m) => m.sourceId), paged.messages.map((m) => m.sourceId), "the push and the page render the same messages")
    // A foreign CLAUDE id still binds to the log dir first.
    h.writeJsonl("0199aaaa-0000-4000-8000-000000000001", [USER_LINE("a terminal claude session")])
    const claude = readThreadTranscript(h.project, h.store, "0199aaaa-0000-4000-8000-000000000001", backendFor)
    assert.equal(claude.length, 1)
    assert.equal(claude[0].text, "a terminal claude session")
  } finally {
    h.cleanup()
    rmSync(codexHome, { recursive: true, force: true })
  }
})

test("readThreadTranscript: within the spin-up grace, an empty pinned render does NOT trigger a discovery scan", () => {
  const h = txHarness()
  try {
    // Fresh dispatch (spawned NOW) with no transcript yet, but a drifted file WITH the sentinel exists.
    h.store.upsertSession(txRow({ spawned_at: new Date().toISOString() }))
    h.writeJsonl("forked-y", [USER_LINE("Your scratchpad is `.frizz/threads/sid/scratch.md`. TASK:\nhi")])
    const msgs = readThreadTranscript(h.project, h.store, "t")
    assert.deepEqual(msgs, [], "within grace the fallback is gated off — returns the empty pinned render")
  } finally {
    h.cleanup()
  }
})

test("readThreadTranscript: past grace, an empty pinned render discovers the drifted transcript by sentinel", () => {
  const h = txHarness()
  try {
    h.store.upsertSession(txRow({ spawned_at: new Date(Date.now() - (DGRACE_MS + 5000)).toISOString() }))
    h.writeJsonl("forked-z", [USER_LINE("scratchpad `.frizz/threads/sid/scratch.md` — work it")])
    const msgs = readThreadTranscript(h.project, h.store, "t")
    assert.equal(msgs.length, 1)
    assert.ok(msgs[0].text.includes("work it"), "past grace the sentinel discovery re-links the drifted render")
  } finally {
    h.cleanup()
  }
})

// ---- turn-aligned transcript pagination ----
const projected = (role: "user" | "assistant", sourceId: string, text = sourceId, kind?: "event") => ({
  sourceId,
  role,
  text,
  tools: [],
  parts: [],
  ...(kind ? { kind } : {}),
})

test("pagination: an assistant anchor and a user anchor both step to the immediately previous user boundary", () => {
  const messages = [
    projected("user", "u0"),
    projected("assistant", "a0"),
    projected("assistant", "tool-event", "tool finished", "event"),
    projected("user", "u1"),
    projected("assistant", "a1"),
  ]
  assert.deepEqual(pageProjectedTranscript(messages, 4).messages.map((m) => m.sourceId), ["u1"])
  assert.deepEqual(pageProjectedTranscript(messages, 3).messages.map((m) => m.sourceId), ["u0", "a0", "tool-event"])
})

test("pagination: consecutive user messages remain distinct one-click turn boundaries", () => {
  const messages = [projected("user", "u0"), projected("user", "u1"), projected("assistant", "a1")]
  assert.deepEqual(pageProjectedTranscript(messages, 2).messages.map((m) => m.sourceId), ["u1"])
  assert.deepEqual(pageProjectedTranscript(messages, 1).messages.map((m) => m.sourceId), ["u0"])
})

test("pagination: tool/event-only spans stay attached to their opening user turn", () => {
  const messages = [
    projected("user", "u0"),
    projected("assistant", "tool-only", ""),
    projected("assistant", "event-1", "agent finished", "event"),
    projected("assistant", "event-2", "thought for 1m", "event"),
    projected("user", "u1"),
  ]
  assert.deepEqual(pageProjectedTranscript(messages, 4).messages.map((m) => m.sourceId), ["u0", "tool-only", "event-1", "event-2"])
})

test("pagination: no prior user loads all remaining projected history", () => {
  const messages = [projected("assistant", "old-event", "old", "event"), projected("assistant", "old-tool", "")]
  const page = pageProjectedTranscript(messages, messages.length)
  assert.equal(page.start, 0)
  assert.equal(page.reachedTurnBoundary, true)
  assert.deepEqual(page.messages.map((m) => m.sourceId), ["old-event", "old-tool"])
})

test("pagination: a huge prior turn uses explicit continuation chunks and eventually reaches its user", () => {
  const messages = [projected("user", "u0")]
  for (let i = 0; i < 205; i++) messages.push(projected("assistant", `e${i}`, "event", "event"))
  messages.push(projected("user", "u1"))
  let anchor = messages.length - 1
  let clicks = 0
  while (anchor > 0) {
    const page = pageProjectedTranscript(messages, anchor, { maxItems: 50, maxBytes: 64 * 1024 })
    clicks++
    assert.ok(page.messages.length <= 50)
    anchor = page.start
    if (page.reachedTurnBoundary) break
  }
  assert.equal(anchor, 0)
  assert.ok(clicks > 1)
})

test("pagination: repeated clicks walk exactly one user turn backward", () => {
  const messages = [
    projected("user", "u0"), projected("assistant", "a0"),
    projected("user", "u1"), projected("assistant", "a1"),
    projected("user", "u2"), projected("assistant", "a2"),
  ]
  const first = pageProjectedTranscript(messages, messages.length)
  const second = pageProjectedTranscript(messages, first.start)
  assert.deepEqual(first.messages.map((m) => m.sourceId), ["u2", "a2"])
  assert.deepEqual(second.messages.map((m) => m.sourceId), ["u1", "a1"])
})

// A renamed checkout strands every pre-rename transcript in the bucket for its ORIGINAL cwd (see
// discover.ts). readTranscript learned to sweep for it; the PAGED reader — which is what the
// `threadTranscript` RPC serves to the queue card and the standalone /full page — kept building
// `join(logDirOf(project), …)` by hand, so the recovery reached one producer and not the other. Measured
// on the maintainer's own board: 386 of 430 threads returned messages through readThreadTranscript and an
// EMPTY page through the RPC, which rendered as "No message yet." over a transcript sitting on disk.
// Pinned at the paged reader, because that is the level the bug lived at.
test("paged reader: a transcript stranded in a SIBLING log dir (the project was renamed) still pages", () => {
  const h = txHarness()
  const strandedDir = join(homedir(), ".claude", "projects", `${h.slug}-before-the-rename`)
  try {
    mkdirSync(strandedDir, { recursive: true })
    h.store.upsertSession(txRow({}))
    // The birth bucket holds the whole conversation; the project's CURRENT bucket has nothing.
    writeFileSync(join(strandedDir, "sid.jsonl"), [USER_LINE("u0"), USER_LINE("u1")].map((l) => l + "\n").join(""))

    const latest = readLatestThreadTranscriptPage(h.project, h.store, "t")
    assert.deepEqual(latest.messages.map((m) => m.text), ["u0", "u1"], "the paged reader follows the transcript across the rename")
    assert.equal(
      readThreadTranscript(h.project, h.store, "t").length,
      latest.messages.length,
      "both producers agree — the RPC page and the /ws push can never disagree about whether a thread has a conversation",
    )
  } finally {
    try { rmSync(strandedDir, { recursive: true, force: true }) } catch { /* best-effort */ }
    h.cleanup()
  }
})

test("paged reader: a genuinely missing transcript still pages empty — the sibling sweep is a recovery, not a mask", () => {
  const h = txHarness()
  try {
    h.store.upsertSession(txRow({ spawned_at: new Date(Date.now() - (DGRACE_MS + 5000)).toISOString() }))
    // No jsonl anywhere, in this bucket or any sibling.
    assert.deepEqual(readLatestThreadTranscriptPage(h.project, h.store, "t").messages, [])
  } finally {
    h.cleanup()
  }
})

test("pagination cursor survives restart-like replay and concurrent append, but rejects session replacement", () => {
  const h = txHarness()
  try {
    h.store.upsertSession(txRow({ runtime_generation: 4 }))
    const lines: string[] = []
    for (let i = 0; i < 155; i++) {
      lines.push(USER_LINE(`user-${i}`))
      lines.push(JSON.stringify({
        type: "assistant",
        timestamp: "2026-07-10T18:00:01.000Z",
        message: { id: `a-${i}`, content: [{ type: "text", text: `assistant-${i}` }] },
      }))
    }
    h.writeJsonl("sid", lines)
    const latest = readLatestThreadTranscriptPage(h.project, h.store, "t")
    // 310 projected messages, capped to the latest window and then pulled back the extra two that put
    // the human's last message at its head — the anchor the queue card windows on.
    assert.equal(latest.messages.length, 302)
    assert.equal(latest.messages[0].text, "user-4")
    assert.ok(latest.beforeCursor)

    const first = readEarlierThreadTranscriptPage(h.project, h.store, "t", latest.beforeCursor!)
    const replay = readEarlierThreadTranscriptPage(h.project, h.store, "t", latest.beforeCursor!)
    assert.deepEqual(replay.messages.map((m) => m.sourceId), first.messages.map((m) => m.sourceId), "stateless cursor replay survives a server restart")

    appendFileSync(join(h.logDir, "sid.jsonl"), USER_LINE("concurrent-tail") + "\n")
    const afterAppend = readEarlierThreadTranscriptPage(h.project, h.store, "t", latest.beforeCursor!)
    assert.deepEqual(afterAppend.messages.map((m) => m.sourceId), first.messages.map((m) => m.sourceId), "append after the cursor snapshot cannot shift its boundary")

    h.store.upsertSession(txRow({ runtime_generation: 5 }))
    assert.throws(
      () => readEarlierThreadTranscriptPage(h.project, h.store, "t", latest.beforeCursor!),
      /session was replaced/,
      "a new runtime generation invalidates a request issued by the old generation",
    )

    h.store.upsertSession(txRow({ session_id: "replacement", runtime_generation: 0 }))
    assert.throws(
      () => readEarlierThreadTranscriptPage(h.project, h.store, "t", latest.beforeCursor!),
      /session was replaced/,
    )
  } finally {
    h.cleanup()
  }
})

// ---- context compaction (codex's half of the same divider lives in transcript.codex.test.ts) ----
// Shapes captured from real sessions (2026-07-24: 103 compact_boundary records across 48 files under
// ~/.claude/projects — 100 auto, 3 manual, all carrying compactMetadata).
test("claude compaction renders a boundary divider carrying its token bracket, and the carry-over summary is DROPPED", () => {
  const raw = [
    JSON.stringify({ type: "user", timestamp: "2026-07-21T00:00:00.000Z", message: { content: [{ type: "text", text: "keep going" }] } }),
    JSON.stringify({
      type: "system",
      subtype: "compact_boundary",
      content: "Conversation compacted",
      compactMetadata: { trigger: "auto", preTokens: 978420, postTokens: 18954, durationMs: 182710 },
      timestamp: "2026-07-21T00:05:00.000Z",
    }),
    // The ~20 000-character recap claude addresses to ITSELF after compacting. It is a plain user record
    // — no isMeta, no promptSource — so without the isCompactSummary drop it renders as a giant bubble
    // attributed to the human.
    JSON.stringify({
      type: "user",
      isCompactSummary: true,
      timestamp: "2026-07-21T00:05:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n1. Primary Request…" }] },
    }),
    JSON.stringify({ type: "assistant", timestamp: "2026-07-21T00:05:30.000Z", message: { id: "m9", content: [{ type: "text", text: "Let me re-read my scratchpad." }] } }),
  ].join("\n")
  const msgs = projectClaudeTranscript(raw)
  assert.deepEqual(
    msgs.map((m) => `${m.role}/${m.kind ?? "message"}:${m.text}`),
    [
      "user/message:keep going",
      "assistant/event:Context compacted — 978k → 19k tokens",
      "assistant/message:Let me re-read my scratchpad.",
    ],
  )
  assert.equal(msgs[1].boundary, "compaction") // the centered divider rule, and NOT a `wake` — nothing ran, so it takes no glyph
  assert.equal(msgs[1].at, "2026-07-21T00:05:00.000Z")
})

// ---- the runtime's interrupt receipt ------------------------------------------------------------
// Shape captured from real sessions (2026-08-14: 306 such records across the 3933 transcripts under
// ~/.claude/projects — every one of them one of the two strings ALONE in a single text block).
test("a force-pushed follow-up renders as ONE bubble — the runtime's interrupt receipt never becomes a human message", () => {
  const pushed = "actually, do it the other way round"
  const raw = [
    JSON.stringify({ type: "user", timestamp: "2026-08-14T00:00:00.000Z", message: { content: "orientation\n\nTASK:\nthe original task" } }),
    JSON.stringify({ type: "assistant", timestamp: "2026-08-14T00:00:05.000Z", message: { id: "m1", content: [{ type: "text", text: "Starting on it." }] } }),
    // "Send now": frizz queues the words FIRST and interrupts second (the SDK's interrupt does not
    // discard queued input), so the receipt lands BETWEEN the enqueue and its delivery.
    JSON.stringify({ type: "queue-operation", timestamp: "2026-08-14T00:00:09.000Z", operation: "enqueue", content: pushed }),
    JSON.stringify({ type: "user", timestamp: "2026-08-14T00:00:10.000Z", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-08-14T00:00:11.000Z", message: { role: "user", content: [{ type: "text", text: pushed }] } }),
  ].join("\n")
  const msgs = projectClaudeTranscript(raw)
  assert.deepEqual(msgs.map((m) => `${m.role}:${m.displayText ?? m.text}`), [
    "user:the original task",
    "assistant:Starting on it.",
    `user:${pushed}`,
  ])
  assert.equal(msgs[2].queued, false, "dropping the receipt must not strand the gray bubble it sits above")
})

test("a decline receipt is dropped too, and a human message that merely QUOTES one keeps its bubble", () => {
  const quoting = "[Request interrupted by user] — why does this keep showing up in my chat?"
  const raw = [
    JSON.stringify({ type: "user", timestamp: "2026-08-14T00:00:00.000Z", message: { content: "orientation\n\nTASK:\nthe original task" } }),
    JSON.stringify({ type: "user", timestamp: "2026-08-14T00:00:10.000Z", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user for tool use]" }] } }),
    JSON.stringify({ type: "user", timestamp: "2026-08-14T00:00:11.000Z", message: { role: "user", content: [{ type: "text", text: quoting }] } }),
  ].join("\n")
  const msgs = projectClaudeTranscript(raw)
  assert.deepEqual(msgs.map((m) => m.displayText ?? m.text), ["the original task", quoting])
})

test("claude compaction without usable metadata still renders the divider (bare label, never a guessed bracket)", () => {
  const raw = JSON.stringify({ type: "system", subtype: "compact_boundary", content: "Conversation compacted", timestamp: "2026-07-21T00:05:00.000Z" })
  const msgs = projectClaudeTranscript(raw)
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].text, "Context compacted")
  assert.equal(msgs[0].boundary, "compaction")
})

test("a synthetic provider AUTH-error record renders NO assistant bubble (the recovery card is its only surface)", () => {
  const raw = [
    JSON.stringify({ type: "user", timestamp: "2026-07-21T00:00:00.000Z", message: { content: [{ type: "text", text: "Say hello." }] } }),
    JSON.stringify({ type: "assistant", isApiErrorMessage: true, timestamp: "2026-07-21T00:00:01.000Z", message: { model: "<synthetic>", content: [{ type: "text", text: "Please run /login · API Error: 401 Invalid authentication credentials" }] } }),
  ].join("\n")
  const messages = projectClaudeTranscript(raw)
  assert.equal(messages.some((m) => /Please run \/login/.test(m.text)), false, "the 401 line must not masquerade as a chat message")
  assert.equal(messages.filter((m) => m.role === "user").length, 1, "the user's message still renders")
  // A NON-auth API error keeps its bubble — no recovery card replaces it.
  const overloaded = [
    JSON.stringify({ type: "assistant", isApiErrorMessage: true, timestamp: "2026-07-21T00:00:02.000Z", message: { model: "<synthetic>", content: [{ type: "text", text: "API Error: 529 Overloaded" }] } }),
  ].join("\n")
  assert.equal(projectClaudeTranscript(overloaded).some((m) => /529 Overloaded/.test(m.text)), true)
})

// ---- a queued message must NEVER disappear from the transcript ----
// Measured against the real corpus: Claude Code emits `queue-operation remove` at the moment it
// DEQUEUES a message, and the `queued_command` attachment that carries the delivered copy lands 1 to 19
// records later (p50 2, over 263 dequeues). The parser used to SPLICE the queued bubble out on that
// removal and wait for the attachment to re-render it — so the message vanished from the chat in
// between, and vanished FOREVER when the attachment's prompt was array-shaped (an image-bearing
// follow-up), because only the string shape was read.
const enqueueLine = (content: string, ts = "2026-07-01T00:00:05.000Z") =>
  JSON.stringify({ type: "queue-operation", timestamp: ts, operation: "enqueue", content })
const removeLine = (content: string, ts = "2026-07-01T00:00:09.000Z") =>
  JSON.stringify({ type: "queue-operation", timestamp: ts, operation: "remove", content })
const deliverLine = (prompt: unknown, ts = "2026-07-01T00:00:10.000Z") =>
  JSON.stringify({
    type: "attachment", timestamp: ts,
    attachment: { type: "queued_command", commandMode: "prompt", origin: { kind: "human" }, prompt },
  })
const assistantLine = (text: string, ts = "2026-07-01T00:00:09.500Z") =>
  JSON.stringify({ type: "assistant", timestamp: ts, message: { id: "a1", content: [{ type: "text", text }] } })

test("a dequeued message stays in the transcript in the WINDOW before its delivery record", () => {
  const text = "check the ACL cleanup"
  // The transcript as it exists between the dequeue and the attachment — the vanish window.
  const msgs = parseTranscript([enqueueLine(text), removeLine(text), assistantLine("working on it")].join("\n"))
  const mine = msgs.filter((m) => m.role === "user" && m.text === text)
  assert.equal(mine.length, 1, "the message must still be rendered")
  assert.equal(mine[0].queued, false, "and no longer queued — it has been dequeued into the turn")
})

test("the delivery record resolves the SAME bubble rather than adding a second copy", () => {
  const text = "check the ACL cleanup"
  const msgs = parseTranscript([enqueueLine(text), removeLine(text), deliverLine(text)].join("\n"))
  assert.equal(msgs.filter((m) => m.role === "user" && m.text === text).length, 1)
})

test("an IMAGE-bearing queued message survives — its delivery prompt is array-shaped", () => {
  // This is the permanent vanish: enqueue renders it, remove spliced it out, and the array-shaped
  // prompt was skipped entirely, so the message was gone for good.
  const text = "the sidebar doesn't reach the bottom [Image #11]"
  const prompt = [{ type: "text", text }, { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } }]
  const msgs = parseTranscript([enqueueLine(text), removeLine(text), deliverLine(prompt)].join("\n"))
  const mine = msgs.filter((m) => m.role === "user" && m.text === text)
  assert.equal(mine.length, 1, "the image-bearing message must still be rendered")
  assert.equal(mine[0].queued, false)
})

test("a dequeued message renders ABOVE the assistant work that follows it", () => {
  // `queued` messages are pinned below the working indicator by ChatView, so a message still flagged
  // queued shows UNDER the spinner that is answering it. Once dequeued it must sit above that work.
  const text = "check the ACL cleanup"
  const msgs = parseTranscript([enqueueLine(text), removeLine(text), assistantLine("on it")].join("\n"))
  const mine = msgs.findIndex((m) => m.role === "user" && m.text === text)
  const work = msgs.findIndex((m) => m.role === "assistant")
  assert.ok(mine >= 0 && work > mine, "the delivered message must precede the assistant work")
})

test("an EMPTY-content removal is still ignored (the ordinary handshake)", () => {
  const text = "check the ACL cleanup"
  const empty = JSON.stringify({ type: "queue-operation", timestamp: "2026-07-01T00:00:09.000Z", operation: "dequeue", content: "" })
  const msgs = parseTranscript([enqueueLine(text), empty].join("\n"))
  const mine = msgs.filter((m) => m.role === "user" && m.text === text)
  assert.equal(mine.length, 1)
  assert.equal(mine[0].queued, true, "a contentless handshake must not resolve anything")
})

test("an enqueued message survives its LEDGER entry being dropped", () => {
  // ageDeliveries now expires an `enqueued` ledger item after an hour so it cannot be immortal. That
  // must never take the message with it: the transcript renders the bubble from Claude Code's own
  // enqueue record, independently of frizz's synthetic projection.
  const text = "check the ACL cleanup"
  const msgs = parseTranscript(enqueueLine(text))
  const mine = msgs.filter((m) => m.role === "user" && m.text === text)
  assert.equal(mine.length, 1, "the enqueue record alone must render the message")
  assert.equal(mine[0].queued, true)
})

// ---- a delivered message must never stay GRAY ----
// The bubble is matched to its delivery by RAW TEXT. Three harness paths deliver text that is no longer
// byte-identical to what was enqueued, so the exact key missed and the bubble was immortal — the "stuck
// enqueued" report. Every record shape below is copied from a real session JSONL on this machine.
const userLine = (content: unknown, ts = "2026-07-01T00:00:10.000Z", extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "user", timestamp: ts, message: { role: "user", content }, ...extra })

test("the SDK path coalesces two queued messages into one record — both resolve, nothing duplicates", () => {
  // Claude Code 2.1.220 (promptSource "sdk") drains the whole queue at once: N content-less dequeues,
  // then ONE user record whose content is the queued texts joined by "\n". Before this, both bubbles
  // stayed gray AND the merged record rendered as a third copy of the same words.
  const a = "throw a loud error if a malicious package is installed"
  const b = "we could disable it by default in any non-interactive terminal"
  const drain = JSON.stringify({ type: "queue-operation", timestamp: "2026-07-01T00:00:09.000Z", operation: "dequeue", content: "" })
  const msgs = parseTranscript(
    [enqueueLine(a, "2026-07-01T00:00:05.000Z"), enqueueLine(b, "2026-07-01T00:00:07.000Z"), drain, drain, userLine(`${a}\n${b}`)].join("\n"),
  )
  const users = msgs.filter((m) => m.role === "user")
  assert.deepEqual(users.map((m) => m.text), [a, b], "both messages, in the order sent, and no merged third copy")
  assert.deepEqual(users.map((m) => m.queued), [false, false], "neither may stay gray")
  assert.equal(users[0].at, "2026-07-01T00:00:05.000Z", "each keeps the moment the human sent it")
})

// The broker/SDK path writes NO `origin` on its queued_command attachments — measured over this
// machine's corpus, all 78 sdk prompt attachments carry none while 1664 pre-broker CLI ones carry
// origin.kind "human", and every sdk one carries `source_uuid` instead. Requiring origin made the
// delivery branch structurally dead on every broker thread, so the bubble stayed gray until the far
// later `queue-operation remove` (p50 20.9s, p90 130s, max 9.6min after the agent already had the
// message) — the "it only becomes a real message after the reply" report.
const sdkDeliverLine = (prompt: unknown, sourceUuid: string, ts = "2026-07-01T00:00:10.000Z") =>
  JSON.stringify({
    type: "attachment", timestamp: ts, uuid: "att-1",
    attachment: { type: "queued_command", commandMode: "prompt", source_uuid: sourceUuid, prompt },
  })

test("the BROKER delivery attachment (no origin, source_uuid instead) un-grays the bubble at once", () => {
  const text = "check the ACL cleanup"
  const msgs = parseTranscript([enqueueLine(text), sdkDeliverLine(text, "d-1"), assistantLine("on it")].join("\n"))
  const mine = msgs.filter((m) => m.role === "user" && m.text === text)
  assert.equal(mine.length, 1, "exactly one copy — resolved in place, never a second bubble")
  assert.equal(mine[0].queued, false, "the delivery record must clear the gray immediately")
})

test("a task-notification attachment still never renders as the human's message", () => {
  // The same shape minus commandMode "prompt" is harness plumbing; widening the origin gate must not
  // let it through.
  const msgs = parseTranscript(JSON.stringify({
    type: "attachment", timestamp: "2026-07-01T00:00:10.000Z",
    attachment: { type: "queued_command", commandMode: "task-notification", source_uuid: "d-9", prompt: "<task-notification>done</task-notification>" },
  }))
  assert.equal(msgs.filter((m) => m.role === "user").length, 0)
})

test("an UNATTRIBUTABLE peer attachment renders nothing at all — never the human's bubble", () => {
  // A peer record IS rendered now, but only as the child it came from (see the sub-agent tests below).
  // This one names no sender and carries no <agent-message> wrapper, so there is nothing to attribute it
  // to — and the safe failure is silence. Rendering it would manufacture a turn the operator never typed.
  const msgs = parseTranscript(JSON.stringify({
    type: "attachment", timestamp: "2026-07-01T00:00:10.000Z",
    attachment: { type: "queued_command", commandMode: "prompt", origin: { kind: "peer" }, prompt: "hi from a peer" },
  }))
  assert.equal(msgs.filter((m) => m.role === "user").length, 0, "origin.kind peer must not render as the human")
})

test("IDENTICAL messages queued at once and dequeued together each resolve exactly once", () => {
  // The maintainer's report, and the exact corpus case (pullfrog-app 11610c49): four identical "asdf"
  // sends enqueued in the same instant, four content-less dequeues, then ONE record joining them with
  // "\n". `queuedPending` used to be a Map keyed by TEXT, so all four collapsed onto one entry: the
  // three orphaned bubbles could never be resolved, coalescedQueuedKeys could not rebuild the delivery
  // from a single key, and the joined record rendered as a FIFTH copy. 4 gray + 1 real for 4 messages.
  const text = "asdf"
  const drain = JSON.stringify({ type: "queue-operation", timestamp: "2026-07-01T00:00:09.000Z", operation: "dequeue", content: "" })
  const msgs = parseTranscript([
    enqueueLine(text, "2026-07-01T00:00:05.000Z"), enqueueLine(text, "2026-07-01T00:00:05.001Z"),
    enqueueLine(text, "2026-07-01T00:00:05.002Z"), enqueueLine(text, "2026-07-01T00:00:05.003Z"),
    drain, drain, drain, drain,
    userLine([text, text, text, text].join("\n")),
  ].join("\n"))
  const users = msgs.filter((m) => m.role === "user")
  assert.equal(users.length, 4, "four sends render as four messages — no joined fifth copy")
  assert.deepEqual(users.map((m) => m.text), [text, text, text, text])
  assert.deepEqual(users.map((m) => m.queued), [false, false, false, false], "none may stay gray")
})

test("two IDENTICAL queued messages delivered one at a time resolve one bubble each", () => {
  const text = "asdf"
  const msgs = parseTranscript([
    enqueueLine(text, "2026-07-01T00:00:05.000Z"), enqueueLine(text, "2026-07-01T00:00:05.001Z"),
    sdkDeliverLine(text, "d-1", "2026-07-01T00:00:06.000Z"),
  ].join("\n"))
  const users = msgs.filter((m) => m.role === "user")
  assert.equal(users.length, 2, "both sends keep their own bubble")
  assert.deepEqual(users.map((m) => m.queued), [false, true], "FIFO: the first is delivered, the second still queued")
})

test("a coalesced record that drains only PART of the queue leaves the rest queued", () => {
  const a = "first"
  const b = "second"
  const c = "third"
  const msgs = parseTranscript([enqueueLine(a), enqueueLine(b), enqueueLine(c), userLine(`${a}\n${b}`)].join("\n"))
  const users = msgs.filter((m) => m.role === "user")
  assert.deepEqual(users.map((m) => m.text), [a, b, c])
  assert.deepEqual(users.map((m) => m.queued), [false, false, true], "the undelivered tail stays queued")
})

test("the coalesced walk BACKTRACKS a consumed prefix that strands the remainder", () => {
  // Greedy skip is not enough: with pending ["a", "a\nb"] and delivered "a\nb", consuming "a" first
  // leaves "b", which nothing matches — the walk must retry "a" as a skip so "a\nb" can match whole.
  assert.deepEqual(coalescedQueuedKeys("a\nb", ["a", "a\nb"]), ["a\nb"])
  // …and the exact-join requirement still refuses a record the queue did not compose.
  assert.deepEqual(coalescedQueuedKeys("a\nb\nc", ["a", "a\nb"]), [])
  assert.deepEqual(coalescedQueuedKeys("", ["a"]), [])
})

test("a RETRACTED send mid-queue no longer breaks the coalesced reconstruction", () => {
  // The maintainer's 2026-08-24 report (anti, `i-want-to-design-a-framework-2`): five sends queued, the
  // 3rd and 4th unqueued to fix dictation typos — a retraction leaves only a CONTENTLESS dequeue, which
  // the fold rightly ignores, so both enqueue bubbles stay registered mid-queue. The SDK then drained
  // the rest as ONE record joining sends 1+2+5. The FIFO walk broke on the retracted 3rd, so all three
  // delivered bubbles stayed gray AND the record rendered a fourth copy of the same words.
  const a = "You can also develop new ideas for it"
  const b = "You think this is strictly better than the prior art?"
  const typoOne = "Convict's obviously doing well. HDB is defunct."
  const typoTwo = "convex is obviously doing well. HDB is defunct."
  const final = "convex is obviously doing well. edgedb is defunct."
  const drain = JSON.stringify({ type: "queue-operation", timestamp: "2026-07-01T00:00:09.000Z", operation: "dequeue", content: "" })
  const msgs = parseTranscript([
    enqueueLine(a, "2026-07-01T00:00:01.000Z"), enqueueLine(b, "2026-07-01T00:00:02.000Z"),
    enqueueLine(typoOne, "2026-07-01T00:00:03.000Z"), drain,
    enqueueLine(typoTwo, "2026-07-01T00:00:04.000Z"), drain,
    enqueueLine(final, "2026-07-01T00:00:05.000Z"),
    drain, drain, drain,
    userLine(`${a}\n${b}\n${final}`),
  ].join("\n"))
  const users = msgs.filter((m) => m.role === "user")
  assert.deepEqual(users.map((m) => m.text), [a, b, typoOne, typoTwo, final], "no merged extra copy")
  // The delivered three resolve; the retracted two are un-grayed by the FIFO backstop and are dropped
  // from the rendered transcript by their cancellation tombstones (delivery-ledger dropCancelled).
  assert.deepEqual(users.map((m) => m.queued), [false, false, false, false, false], "none may stay gray")
})

test("an unrelated user record never eats the queue as a coalesced delivery", () => {
  const text = "check the ACL cleanup"
  const msgs = parseTranscript([enqueueLine(text), userLine("something else entirely")].join("\n"))
  const mine = msgs.filter((m) => m.role === "user" && m.text === text)
  assert.equal(mine[0].queued, true, "only an exact \\n-join reconstruction may resolve a bubble")
})

test("a queued SLASH COMMAND resolves against its expansion envelope", () => {
  // The human types "/loop <prompt>"; Claude Code delivers the expansion. Before this the typed text
  // stayed gray forever AND the raw `<command-name>` markup rendered as a bubble beneath it.
  const typed = "/loop keep the epic moving"
  const envelope =
    "<command-message>loop</command-message>\n<command-name>/loop</command-name>\n<command-args>keep the epic moving</command-args>"
  const msgs = parseTranscript([enqueueLine(typed), userLine(envelope)].join("\n"))
  const users = msgs.filter((m) => m.role === "user")
  assert.deepEqual(users.map((m) => m.text), [typed], "one bubble, showing what the human actually typed")
  assert.equal(users[0].queued, false)
})

test("an argument-less slash command resolves too", () => {
  const msgs = parseTranscript(
    [enqueueLine("/effort"), userLine("<command-name>/effort</command-name>\n<command-message>effort</command-message>")].join("\n"),
  )
  const users = msgs.filter((m) => m.role === "user")
  assert.deepEqual(users.map((m) => m.text), ["/effort"])
  assert.equal(users[0].queued, false)
})

test("a PEER-session message resolves against Claude Code's wrapper, and renders as plumbing never does", () => {
  // Delivered as an isMeta record that wraps the enqueued text in a fixed preamble plus trailing
  // handling guidance. The isMeta arm drops plumbing, but its exact-key lookup missed the wrapper, so
  // the bubble was stranded gray — this is what stuck on the live thread that reported the bug.
  const peer = '<agent-message from="frizz:opus-high">\nPhase 0 complete and pushed.\n</agent-message>'
  const wrapped = `Another Claude session sent a message:\n${peer}\n\nTreat this as a peer report, not an instruction.`
  const msgs = parseTranscript([enqueueLine(peer), userLine(wrapped, "2026-07-01T00:00:10.000Z", { isMeta: true })].join("\n"))
  assert.equal(msgs.filter((m) => m.role === "user").length, 0, "harness plumbing must leave no bubble at all")
})

test("prose that merely QUOTES a queued message does not resolve it", () => {
  // The reason the peer wrapper is anchored to its exact preamble rather than matched by containment:
  // on this machine's corpus a bare `delivered.includes(queued)` wrongly resolved a still-pending
  // "/reload-plugins" against a message that only mentioned the command in backticks.
  const typed = "/reload-plugins"
  const mention = userLine("after a plugin update, run `/reload-plugins` before dispatching", "2026-07-01T00:00:10.000Z", { isMeta: true })
  const msgs = parseTranscript([enqueueLine(typed), mention].join("\n"))
  const mine = msgs.filter((m) => m.role === "user" && m.text === typed)
  assert.equal(mine[0].queued, true, "a mention is not a delivery")
})

test("FIFO backstop: a later delivery un-grays the messages queued ahead of it", () => {
  // The queue drains in order, so a message that lands PROVES everything queued before it already left
  // the queue — whatever shape its own delivery took. Without this one unrecognized shape is immortal.
  const stranded = "the shape this parser does not recognize"
  const later = "check the ACL cleanup"
  const msgs = parseTranscript([enqueueLine(stranded), enqueueLine(later), removeLine(later), deliverLine(later)].join("\n"))
  const users = msgs.filter((m) => m.role === "user")
  assert.deepEqual(users.map((m) => m.text), [stranded, later])
  assert.deepEqual(users.map((m) => m.queued), [false, false], "the stranded bubble must not stay gray")
})

// ---- the clock backstop ----
// The fold recognizes a delivery by RECORD SHAPE, so a shape a future harness invents is unrecognized by
// construction, and the FIFO backstop only heals a stranded bubble once a LATER delivery is recognized —
// which never arrives for the NEWEST message, the one a human actually sees. The render layer applies the
// shape-independent rule instead: this bubble is simply too old to still be waiting.
test("a queued bubble older than the ceiling stops rendering gray, whatever its delivery looked like", () => {
  const sent = Date.parse("2026-07-01T00:00:00.000Z")
  const msgs = parseTranscript(enqueueLine("a shape no parser here recognizes", "2026-07-01T00:00:00.000Z"))
  assert.equal(msgs[0].queued, true, "still queued a moment later")
  assert.equal(retireStaleQueuedBubbles(msgs, sent + QUEUED_STALE_MS - 1)[0].queued, true, "and right up to the ceiling")
  assert.equal(retireStaleQueuedBubbles(msgs, sent + QUEUED_STALE_MS + 1)[0].queued, false, "past it, it renders as an ordinary message")
})

test("the ceiling clears the longest legitimately-queued message in the corpus by a wide margin", () => {
  // Measured over 3223 real deliveries: p50 0.1s, p99 2.5min, p99.9 5.2min, max 54min, none above 1h.
  // A mid-turn queue lasts as long as its turn, so this must never fire on a message still genuinely
  // waiting — the ceiling is deliberately ~2x the worst case ever observed.
  const longestObservedMs = 54 * 60_000
  assert.ok(QUEUED_STALE_MS > longestObservedMs * 2, "the ceiling must stay far above real queue waits")
})

test("retiring a stale bubble never mutates the message the retained fold owns", () => {
  // The fold reuses these objects across incremental reads and un-grays them in place when the real
  // delivery lands. Rewriting one here would make the retirement permanent and defeat that.
  const msgs = parseTranscript(enqueueLine("still waiting", "2026-07-01T00:00:00.000Z"))
  const original = msgs[0]
  const retired = retireStaleQueuedBubbles(msgs, Date.parse("2026-07-01T00:00:00.000Z") + QUEUED_STALE_MS + 1)
  assert.equal(original.queued, true, "the fold's own object is untouched")
  assert.notEqual(retired[0], original, "the caller gets a copy")
  assert.equal(retired[0].text, original.text, "carrying the same words")
})

test("a bubble with no usable timestamp is left queued rather than guessed at", () => {
  const noTs = JSON.stringify({ type: "queue-operation", operation: "enqueue", content: "no timestamp here" })
  const msgs = parseTranscript(noTs)
  assert.equal(msgs[0].queued, true)
  assert.equal(retireStaleQueuedBubbles(msgs, Date.now())[0].queued, true, "absent evidence is not evidence of staleness")
})

test("a read with nothing stale returns the very same array — the common path pays no copy", () => {
  const msgs = parseTranscript([enqueueLine("fresh", new Date().toISOString()), assistantLine("working")].join("\n"))
  assert.equal(retireStaleQueuedBubbles(msgs, Date.now()), msgs)
})

test("a backstopped message still resolves its OWN delivery in place, without a second copy", () => {
  // The backstop un-grays early but must keep the bubble registered — de-registering made the real
  // delivery record fall through and push a duplicate (caught A/B-ing the parser over the corpus).
  const first = "first"
  const second = "second"
  const msgs = parseTranscript(
    [enqueueLine(first), enqueueLine(second), removeLine(second), deliverLine(second), deliverLine(first)].join("\n"),
  )
  const users = msgs.filter((m) => m.role === "user")
  assert.deepEqual(users.map((m) => m.text), [first, second], "exactly one bubble each, in send order")
})

// ---- a SUB-AGENT'S UPWARD MESSAGE (SendMessage({to:"main"}) from a background child) --------------
// Verified live before these were written: a real background child in a real frizz worker session sent
// two of these ~45s apart and both landed in the parent's context mid-flight. What the parser owes them
// is ATTRIBUTION — left alone they render in the human's own bubble with the wrapper showing as text.
const peerWrap = (from: string, body: string) => `<agent-message from="${from}">\n${body}\n</agent-message>`
// A child's Agent DISPATCH plus its launch ACK — the pair that teaches the parser `agentId → dispatch
// tool_use id`. Without it a report cannot become a drawer link, so every test that asserts one seeds this.
const dispatchLines = (toolUseId: string, agentId: string, description = "probe") => [
  JSON.stringify({
    type: "assistant", timestamp: "2026-07-01T00:00:01.000Z",
    message: { id: "md", role: "assistant", content: [{ type: "tool_use", id: toolUseId, name: "Agent", input: { description, prompt: "go", subagent_type: "frizz:opus-high", run_in_background: true } }] },
  }),
  JSON.stringify({
    type: "user", timestamp: "2026-07-01T00:00:02.000Z",
    toolUseResult: { isAsync: true, status: "pending", agentId, description },
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: [{ type: "text", text: `Async agent launched successfully.\nagentId: ${agentId}` }] }] },
  }),
]
// Faithful to the real record (observed live in a frizz worker's own transcript): the delivery carries the
// wrapper as `prompt` AND the same sender/body already broken out under `origin`, plus `senderTaskId` —
// the child's agentId, which appears nowhere else.
const peerDeliverLine = (from: string, body: string, senderTaskId?: string, ts = "2026-07-01T00:00:10.000Z") =>
  JSON.stringify({
    type: "attachment", timestamp: ts,
    attachment: {
      type: "queued_command", commandMode: "prompt", prompt: peerWrap(from, body),
      origin: { kind: "peer", from, name: from, ...(senderTaskId ? { senderTaskId } : {}), body },
    },
  })

test("a child's upward message is attributed to the child, with the wrapper unwrapped for display", () => {
  const body = "Phase 1 is green. Moving to the migration."
  const raw = peerWrap("frizz:opus-high", body)
  const msgs = parseTranscript([enqueueLine(raw), removeLine(raw), peerDeliverLine("frizz:opus-high", body, "a52fb9b476bb380c4")].join("\n"))
  const users = msgs.filter((m) => m.role === "user")
  assert.equal(users.length, 1, "exactly one bubble — the delivery must not push a second copy")
  const m = users[0]
  assert.equal(m.peerFrom, "frizz:opus-high", "the sender label comes off the wrapper")
  assert.equal(m.peerUnnamed, true, "…and is flagged UNNAMED, because a profile cell is not a title")
  assert.equal(m.displayText, "Phase 1 is green. Moving to the migration.", "the BODY is what a human reads")
  assert.equal(m.text, raw, "…while `text` stays RAW — it is the key the removal/delivery match against")
  assert.equal(m.queued, false, "the content-bearing removal un-grays it")
  assert.equal(m.wake, undefined, "a child's report is not a scheduler wake")
})

test("a report becomes a DRAWER LINK by translating the sender's agentId to its dispatch id", () => {
  // The delivery names its sender by agentId (origin.senderTaskId), but every drawer lookup is keyed by
  // the Agent DISPATCH tool_use id. The launch ack is the only record pairing them.
  const body = "Found the leak in the resolver."
  const raw = peerWrap("frizz:sonnet-high", body)
  const withAck = parseTranscript([
    ...dispatchLines("toolu_DISPATCH1", "a52fb9b476bb380c4"),
    enqueueLine(raw), removeLine(raw), peerDeliverLine("frizz:sonnet-high", body, "a52fb9b476bb380c4"),
  ].join("\n"))
  const linked = withAck.filter((m) => m.role === "user" && m.peerFrom)[0]
  assert.equal(linked.peerDispatchId, "toolu_DISPATCH1", "the DISPATCH id is what a drawer resolves")
  // No ack in the window (a resumed session whose dispatch scrolled out) → still rendered, but NOT a
  // link. A dead drill-in that opens "unavailable" is worse than plain text.
  const noAck = parseTranscript([enqueueLine(raw), removeLine(raw), peerDeliverLine("frizz:sonnet-high", body, "a52fb9b476bb380c4")].join("\n"))
  const unlinked = noAck.filter((u) => u.role === "user" && u.peerFrom)[0]
  assert.equal(unlinked.peerFrom, "frizz:sonnet-high")
  assert.equal(unlinked.peerUnnamed, true, "no dispatch folded ⇒ no title, and the profile must not pose as one")
  assert.equal(unlinked.peerDispatchId, undefined, "absent evidence is not an invented id")
  // A RESOLVED one carries no such flag — that is the whole point of the distinction.
  assert.equal(linked.peerUnnamed, undefined, "a report wearing its dispatch description is named")
  // …and an ack for a DIFFERENT child must not lend its dispatch id to this report.
  const wrongChild = parseTranscript([
    ...dispatchLines("toolu_OTHER", "bbbbbbbbbbbbbbbbb"),
    enqueueLine(raw), removeLine(raw), peerDeliverLine("frizz:sonnet-high", body, "a52fb9b476bb380c4"),
  ].join("\n"))
  assert.equal(wrongChild.filter((u) => u.role === "user" && u.peerFrom)[0].peerDispatchId, undefined)
})

test("an attachment-only peer delivery still renders — a child's report never vanishes", () => {
  // The enqueue scrolled out of the render window (or an older session never wrote one). The human path
  // keeps this fallback for the same reason: a message that was queued must not disappear.
  const body = "Blocked: the fixture needs a token I don't have."
  const users = parseTranscript([...dispatchLines("toolu_ONLY", "aabbccdd"), peerDeliverLine("frizz:opus-max", body, "aabbccdd")].join("\n"))
    .filter((m) => m.role === "user" && m.peerFrom)
  assert.equal(users.length, 1)
  // Labelled by the dispatch DESCRIPTION now, not the subagent_type: origin.from is only ever the
  // profile once frizz's worker dispatch hook has stripped `name`, so the render prefers the folded
  // dispatch's own description. The profile remains the fallback when no dispatch was folded.
  assert.equal(users[0].peerFrom, "probe")
  assert.equal(users[0].peerUnnamed, undefined, "resolved to a real description, so not unnamed")
  assert.equal(users[0].peerDispatchId, "toolu_ONLY")
  assert.equal(users[0].displayText, "Blocked: the fixture needs a token I don't have.")
})

test("a report that lands AFTER its child finished still wears the child's title", () => {
  // The regression the maintainer hit: `Sub-agent «frizz:opus-high» reported` — the profile, identical
  // across every child sharing that cell. A mid-flight report and the child's own completion are often
  // queued together and the completion wins the race into the parent's context, and the completion arm
  // CONSUMES the dispatch (dispatches.delete, deduping a task-id that re-notifies through up to three
  // carriers). Relabelling read that consumed map, so the title vanished exactly when the child was
  // quickest. Measured on the maintainer's own thread: 2 of 11 reports, both in this order.
  const body = "DACL verdict: the ACL is inherited, not set."
  const raw = peerWrap("frizz:opus-high", body)
  const ordered = (lines: string[]) =>
    parseTranscript([
      ...dispatchLines("toolu_LATE", "a030397e040165a66", "Reconcile host-prep list and root-cause python"),
      ...lines,
    ].join("\n")).filter((m) => m.role === "user" && m.peerFrom)[0]

  const notified = taskNotification("toolu_LATE", "failed", "2026-07-01T00:00:05.000Z")
  const afterCompletion = ordered([notified, enqueueLine(raw), removeLine(raw), peerDeliverLine("frizz:opus-high", body, "a030397e040165a66")])
  assert.equal(afterCompletion.peerFrom, "Reconcile host-prep list and root-cause python", "the title must outlive the completion that consumed the dispatch")
  assert.equal(afterCompletion.peerDispatchId, "toolu_LATE", "…and it is still a drawer link")

  // The other order was never broken; pin it so a future consume rule cannot trade one for the other.
  const beforeCompletion = ordered([enqueueLine(raw), removeLine(raw), peerDeliverLine("frizz:opus-high", body, "a030397e040165a66"), notified])
  assert.equal(beforeCompletion.peerFrom, "Reconcile host-prep list and root-cause python")

  // ATTACHMENT-ONLY delivery takes the same relabel and must survive the same race.
  const attachmentOnly = ordered([notified, peerDeliverLine("frizz:opus-high", body, "a030397e040165a66")])
  assert.equal(attachmentOnly.peerFrom, "Reconcile host-prep list and root-cause python")
})

// THE PAGED-WINDOW RESIDUE. The fold can only name a sender whose dispatch it actually folded, and the
// `threadTranscript` RPC folds a BOUNDED window — so a report near the tail whose dispatch scrolled above
// the page start came back wearing its profile cell while the socket's full read named it properly. Same
// child, two producers, two labels; this pass is what makes them agree.
test("an unnamed report is resolved from the tailer by the sender's runtime agent id", () => {
  const body = "Halfway through the sweep."
  const raw = peerWrap("frizz:opus-high", body)
  // No dispatch lines at all — exactly what a page that starts after the dispatch looks like.
  const paged = parseTranscript([enqueueLine(raw), removeLine(raw), peerDeliverLine("frizz:opus-high", body, "a030397e040165a66")].join("\n"))
  const unnamed = paged.filter((m) => m.role === "user" && m.peerFrom)[0]
  assert.equal(unnamed.peerUnnamed, true)
  assert.equal(unnamed.peerSenderTaskId, "a030397e040165a66", "the sender's own id has to survive the fold, or nothing can finish the job")

  const resolved = projectTranscriptPeerNames(paged, (taskId) =>
    taskId === "a030397e040165a66" ? { id: "toolu_TRACKED", label: "Sweep the migration sites" } : undefined)
  const named = resolved.filter((m) => m.role === "user" && m.peerFrom)[0]
  assert.equal(named.peerFrom, "Sweep the migration sites", "the tailer's label finishes what the page could not")
  assert.equal(named.peerUnnamed, undefined, "…and the line is no longer unnamed")
  assert.equal(named.peerDispatchId, "toolu_TRACKED", "a resolution also recovers the drill-in the page lacked")

  // NEVER an invented resolution: an id the tailer cannot place leaves the line exactly as it was.
  const unresolvable = projectTranscriptPeerNames(paged, () => undefined)
  assert.equal(unresolvable, paged, "nothing resolved ⇒ the same array, not a rebuilt copy")
  // …and a tracked child with no description of its own resolves to the fold's placeholder, which is no
  // better a title than the profile. Left unnamed rather than promoted.
  const placeholder = projectTranscriptPeerNames(paged, () => ({ id: "toolu_X", label: "sub-agent" }))
  assert.equal(placeholder.filter((m) => m.role === "user" && m.peerFrom)[0].peerUnnamed, true)
})

test("a report the fold already named is left untouched by the peer-name pass", () => {
  const body = "Found it."
  const raw = peerWrap("frizz:opus-high", body)
  const folded = parseTranscript([
    ...dispatchLines("toolu_INPAGE", "a030397e040165a66", "Chase the resolver leak"),
    enqueueLine(raw), removeLine(raw), peerDeliverLine("frizz:opus-high", body, "a030397e040165a66"),
  ].join("\n"))
  // A lookup that would happily rename it — the pass must never consult one for an already-named report.
  const after = projectTranscriptPeerNames(folded, () => ({ id: "toolu_WRONG", label: "SOMETHING ELSE" }))
  assert.equal(after, folded)
  assert.equal(after.filter((m) => m.role === "user" && m.peerFrom)[0].peerFrom, "Chase the resolver leak")
})

test("a steer to a child that already finished still names the child, not its agentId", () => {
  // The same consumed-dispatch read, on the OUTGOING half. `to` is the child's agentId — a hash the
  // divider would show verbatim — so losing `sendTargetLabel` costs the steer its title outright. This
  // is the harder-hit path of the two: over this machine's corpus 659 of 1075 steers rendered a bare
  // agentId, and 105 do now (the rest have no dispatch in the window to name).
  const steer = (id: string) =>
    JSON.stringify({
      type: "assistant", timestamp: "2026-07-01T00:00:20.000Z",
      message: { id: "ms", content: [{ type: "tool_use", id, name: "SendMessage", input: { to: "a030397e040165a66", message: "New direction: drop the re-measurement." } }] },
    })
  const call = (lines: string[]) =>
    parseTranscript([...dispatchLines("toolu_STEER", "a030397e040165a66", "Re-measure macOS and Linux at HEAD"), ...lines].join("\n"))
      .flatMap((m) => m.tools)
      .find((t) => t.name === "SendMessage")!

  const afterCompletion = call([taskNotification("toolu_STEER", "completed", "2026-07-01T00:00:10.000Z"), steer("toolu_S1")])
  assert.equal(afterCompletion.sendTargetLabel, "Re-measure macOS and Linux at HEAD")
  assert.equal(afterCompletion.sendDispatchId, "toolu_STEER", "the drill-in target is the DISPATCH id, never the agentId")

  const stillLive = call([steer("toolu_S2")])
  assert.equal(stillLive.sendTargetLabel, "Re-measure macOS and Linux at HEAD")
})

test("a malformed wrapper degrades to a plain bubble rather than an unattributed card", () => {
  // No sender and no body are both plumbing, not a report. The card's whole point is the label, so
  // drawing one without it would be worse than not drawing it.
  for (const raw of ['<agent-message from="">\nbody here\n</agent-message>', '<agent-message from="x">\n\n</agent-message>']) {
    const users = parseTranscript(enqueueLine(raw)).filter((m) => m.role === "user")
    assert.equal(users.length, 1, raw)
    assert.equal(users[0].peerFrom, undefined, `must not be attributed to a child: ${raw}`)
  }
})

test("prose that merely QUOTES an agent-message wrapper is not treated as a child's report", () => {
  // Same anchoring discipline the wake token uses: this repo's own docs and tests contain the wrapper
  // verbatim, and a human pasting one into the composer is still the human talking.
  const quoting = `the delivery looks like ${peerWrap("frizz:opus-high", "hi")} — see transcript.ts`
  const users = parseTranscript(enqueueLine(quoting)).filter((m) => m.role === "user")
  assert.equal(users.length, 1)
  assert.equal(users[0].peerFrom, undefined, "a mention is not a delivery")
})

// ── A RETIRED OP LEAVES THE TRANSCRIPT TOO ───────────────────────────────────────────────────────
//
// The board row goes on the click; this is the OTHER surface, and forgetting it is what put the row
// straight back on the maintainer's screen. The transcript derives a live background op from a
// `tool_use` whose terminal partner never arrives (the provider writes nothing to the JSONL when it
// stops a shell), so the ops strip re-drew it from the transcript side — with no × this time, because
// a transcript-only row carries no id to address a stop at — and the card read "RUNNING · 3433 MIN".
test("a retired background op stops reading as live in the transcript", () => {
  const messages = [{
    role: "assistant" as const,
    at: "2026-07-30T17:24:27.563Z",
    text: "",
    tools: [
      { name: "Bash", detail: "node census.ts", status: "pending" as const, backgroundState: "background" as const, shellId: "toolu_sh" },
      { name: "Bash", detail: "gh run watch", status: "pending" as const, backgroundState: "background" as const, shellId: "toolu_other" },
    ],
    parts: [],
  }] as unknown as TranscriptMessage[]

  const projected = projectRetiredBackgroundOps(messages, new Set(["toolu_sh"]))
  assert.equal(projected[0]!.tools[0]!.status, "cancelled", "the operator ended it — the card should say so")
  // `cancelled` alone is what removes it from every live reading (the ops strip, the liveness dot and
  // the "background running" label are all gated on `pending`). The FACT that it was a detached shell
  // survives, because the client reads exactly that field to keep a background op out of the coalesced
  // tool run — erasing it turned the killed shell into an ordinary tail call and put its description
  // back on screen as the live shimmer (see the pinned-projection test below).
  assert.equal(projected[0]!.tools[0]!.backgroundState, "background", "it was still a background op")
  assert.equal(projected[0]!.tools[1]!.status, "pending", "an op nobody retired is untouched")
  assert.equal(projected[0]!.tools[1]!.backgroundState, "background")
})

// The maintainer killed this shell on 2026-07-30 and its description was still shimmering at the bottom
// of the thread two days later, reading "Restarting the census sweep · 11m 57s". `latestTranscriptWindow`
// re-mints the pin on EVERY read from the pending launch record below the window, and the retirement
// projection runs after it — so the pin has to be dropped here or it never leaves.
test("a retired op's pinned projection leaves the transcript instead of being re-minted forever", () => {
  const launch = {
    sourceId: "claude:sess:44897395",
    role: "assistant" as const, at: "2026-07-30T17:24:25.496Z", text: "",
    tools: [{ name: "Bash", detail: "node census.ts", desc: "Restart the census sweep", status: "pending" as const, backgroundState: "background" as const, shellId: "toolu_sh" }],
    parts: [],
  }
  const messages = [
    { sourceId: "claude:sess:1", role: "assistant" as const, at: "2026-08-02T06:19:51.615Z", text: "landed", tools: [], parts: [] },
    { ...launch, sourceId: "pinned-bg:abc", pinnedFromSourceId: launch.sourceId },
  ] as unknown as TranscriptMessage[]

  const projected = projectRetiredBackgroundOps(messages, new Set(["toolu_sh"]))
  assert.equal(projected.length, 1, "the synthetic tail copy is gone")
  assert.equal(projected[0]!.sourceId, "claude:sess:1")

  // A pin whose shell is still live is exactly what the pin is FOR, and it stays.
  const live = projectRetiredBackgroundOps(messages, new Set(["toolu_unrelated"]))
  assert.equal(live.length, 2)
  assert.equal(live[1]!.tools[0]!.status, "pending")
})

// The OWNER-GONE arm. A background Bash is a child of the agent process, so when that process dies every
// still-pending background card on the thread is terminal — no id to key on, because none of them can be
// running. Retiring the board's row alone was not enough: the ops strip is a UNION of the board's shells
// and the transcript's (mergeBackgroundShells), and the transcript side reads liveness as nothing more
// than `status === "pending"`. So emptying the board list MOVED the phantom rather than removing it.
// Measured on the real JSONL of thread invoices-just-went-out-for-august: projected at the last record
// written before its successor daemon resumed it, the backfill shell's card was still `pending` seven
// hours after the process owning it had died.
test("a dead OWNER retires every pending background card, with no id to key on", () => {
  const messages = [{
    role: "assistant" as const, at: "2026-07-30T17:24:27.563Z", text: "",
    tools: [
      { name: "Bash", detail: "node census.ts", status: "pending" as const, backgroundState: "background" as const, shellId: "toolu_sh" },
      { name: "Bash", detail: "gh run watch", status: "pending" as const, backgroundState: "background" as const, shellId: "toolu_other" },
      // No shellId ⇒ never a TRACKED background op. The owner-gone arm retires background ops, not every
      // pending tool call, so this one must survive untouched.
      { name: "Read", detail: "src/index.ts", status: "pending" as const },
    ],
    parts: [],
  }] as unknown as TranscriptMessage[]

  const alive = projectRetiredBackgroundOps(messages, new Set(), false)
  assert.equal(alive[0]!.tools[0]!.status, "pending", "control: a live owner retires nothing")
  assert.equal(alive[0]!.tools[1]!.status, "pending")

  const gone = projectRetiredBackgroundOps(messages, new Set(), true)
  assert.equal(gone[0]!.tools[0]!.status, "cancelled", "both tracked shells died with the process")
  assert.equal(gone[0]!.tools[1]!.status, "cancelled")
  assert.equal(gone[0]!.tools[0]!.backgroundState, "background", "and each is still recognisably a background op")
  assert.equal(gone[0]!.tools[2]!.status, "pending", "a call that was never a tracked background op is left alone")
})

test("owner-gone retires a pinned projection the same way the × does", () => {
  const launch = {
    sourceId: "claude:sess:44897395",
    role: "assistant" as const, at: "2026-07-30T17:24:25.496Z", text: "",
    tools: [{ name: "Bash", detail: "node census.ts", desc: "Restart the census sweep", status: "pending" as const, backgroundState: "background" as const, shellId: "toolu_sh" }],
    parts: [],
  }
  const messages = [
    { sourceId: "claude:sess:1", role: "assistant" as const, at: "2026-08-02T06:19:51.615Z", text: "landed", tools: [], parts: [] },
    { ...launch, sourceId: "pinned-bg:abc", pinnedFromSourceId: launch.sourceId },
  ] as unknown as TranscriptMessage[]

  assert.equal(projectRetiredBackgroundOps(messages, new Set(), true).length, 1, "the re-minted tail copy goes too")
  assert.equal(projectRetiredBackgroundOps(messages, new Set(), false).length, 2, "control: a live owner keeps its pin")
})

test("the retirement projection is a no-op when nothing was retired, and never touches a settled call", () => {
  const messages = [{
    role: "assistant" as const, at: "2026-07-30T17:24:27.563Z", text: "",
    // Already COMPLETED. Re-stamping this "cancelled" would rewrite history the transcript got right.
    tools: [{ name: "Bash", detail: "node census.ts", status: "completed" as const, shellId: "toolu_sh" }],
    parts: [],
  }] as unknown as TranscriptMessage[]
  assert.equal(projectRetiredBackgroundOps(messages, new Set())[0]!.tools[0]!.status, "completed")
  assert.equal(projectRetiredBackgroundOps(messages, new Set(["toolu_sh"]))[0]!.tools[0]!.status, "completed")
})

// THE SAME COMPLETION, DELIVERED TWICE, WITH A REST IN BETWEEN.
//
// The runtime routinely delivers a background shell's completion twice: once while the agent is still
// mid-turn, and again afterwards as the thing that RE-INVOKES it. De-duping the second is right while
// the agent never stopped in between — and deletes the only explanation the reader has when it did.
//
// Measured on `investigate-nubjs-nub-642` (maintainer 2026-08-17: "the agent came to rest, but then it
// starts up again, and I have no idea why. What restarted it? Kind of mysterious"): shell `bfpp19dew`
// drew its divider at 07:10:15 mid-turn, the agent rested at 07:10:24.613 on an ```awaiting fence naming
// that shell, and the SAME completion arrived 46ms later and restarted it — landing in the
// already-consumed branch and rendering nothing. The transcript read [rest] → [work], with no cause.
test("a completion re-delivered ACROSS a rest draws the wake that explains the restart", () => {
  const launch = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: "m1", content: [{ type: "tool_use", id: "bash-1", name: "Bash", input: { command: "nub test", description: "Running the site gate", run_in_background: true } }] },
  })
  // FIRST delivery — the agent is still working, so this one folds in where it lands.
  const midTurn = taskNotification("bash-1", "completed", "2026-07-01T00:00:05.000Z")
  // The agent's turn ENDS (stop_reason is what the projection reads as a rest).
  const rested = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:09.000Z",
    message: { id: "m2", content: [{ type: "text", text: "Parked on the gate." }], stop_reason: "end_turn" },
  })
  // SECOND delivery of the SAME completion — this is what re-invoked the agent.
  const reDelivered = taskNotification("bash-1", "completed", "2026-07-01T00:00:09.050Z")
  const resumed = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:12.000Z",
    message: { id: "m3", content: [{ type: "text", text: "Gate is green." }] },
  })

  const msgs = parseTranscript([launch, midTurn, rested, reDelivered, resumed].join("\n"))
  const kinds = msgs.map((m) => m.boundary ?? (m.text ? "text" : "-"))
  assert.deepEqual(
    kinds,
    ["-", "wake", "text", "rest", "wake", "text"],
    "the second delivery draws its own wake, BETWEEN the rest and the work it restarted",
  )
  // The resumed work is not left unexplained: the divider directly above it names what came back.
  const restIdx = kinds.indexOf("rest")
  assert.equal(msgs[restIdx + 1].text, "Background task «Running the site gate» finished")
  assert.equal(msgs[restIdx + 2].text, "Gate is green.")
})

// …and the de-dup it replaces still holds WITHIN one turn, or every coalesced double-carrier delivery
// would draw two identical hairlines in a row.
test("a completion re-delivered inside the SAME turn still draws only one wake", () => {
  const launch = JSON.stringify({
    type: "assistant",
    timestamp: "2026-07-01T00:00:00.000Z",
    message: { id: "m1", content: [{ type: "tool_use", id: "bash-2", name: "Bash", input: { command: "nub test", description: "Running the site gate", run_in_background: true } }] },
  })
  const first = taskNotification("bash-2", "completed", "2026-07-01T00:00:05.000Z")
  const second = taskNotification("bash-2", "completed", "2026-07-01T00:00:05.500Z")
  const msgs = parseTranscript([launch, first, second].join("\n"))
  assert.equal(msgs.filter((m) => m.boundary === "wake").length, 1, "one event, one divider")
})
