import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import {
  createCodexBackend,
  parseCodexLine,
  parseCodexSessionProfile,
  codexSandbox,
  codexEffort,
  findRolloutById,
  extractCodexFrizzTitle,
  scanForeignRollouts,
  readCodexThreadNames,
} from "./codex.ts"
import { newTailState, applyEvent } from "../tailer.ts"
import type { NormalizedEvent } from "./types.ts"

// ---- REAL captured rollout fixtures (codex-cli 0.144.1, 2026-07-10) ----
// exec-two-turn: `codex exec --json` + `codex exec resume` — two turns in one rollout: turn 1 (done
// fence, 2 exec_command tools, final_answer), turn 2 (3 commentary agent_messages + 3 tools + an
// awaiting fence with a timer hint). tui-single-turn: an INTERACTIVE `codex` TUI session (source:"cli")
// — proves the TUI writes the SAME rollout schema as exec (the §6 interactive-parity risk, now closed).
const FIX_DIR = join(import.meta.dirname, "codex.fixtures")
const execTwoTurn = readFileSync(join(FIX_DIR, "exec-two-turn.jsonl"), "utf8")
const tuiSingleTurn = readFileSync(join(FIX_DIR, "tui-single-turn.jsonl"), "utf8")
const execWrapperCommonTools = readFileSync(join(FIX_DIR, "exec-wrapper-common-tools.jsonl"), "utf8")
const execLines = execTwoTurn.split("\n").filter((l) => l.trim())

// ---- REAL captured rollout fixtures (codex-cli 0.153.2, 2026-09-04) ----
// The schema codex moved to: every semantic event now rides ONE `event_msg/item_completed` envelope
// carrying a typed `item`, and the flat `agent_message` / `user_message` / `sub_agent_activity`
// payloads the fixtures above are built on are no longer written at all. Frizz read only the flat
// spelling, so on this rollout it folded ZERO assistant text, ZERO user turns and ZERO sub-agents —
// the thread went in-flight and came to rest (the turn brackets did NOT move) while the board showed
// no title, no preview, no fences and no children.
// multi-agent-0153: a slice of the orchestrator's own rollout — its opening prompt, the title-carrying
// commentary, one child's whole life (spawn → started → completed), a roster, and two item/response_item
// TWINS (Reasoning, CommandExecution) that must not be counted twice. child-turn-0153: one child's
// bracketed turn, which is where a `final_answer` phase and a `task_complete` live.
// Redacted: the fernet dispatch blobs, `encrypted_content`, the home dir, and prose over 240 chars.
const multiAgent0153 = readFileSync(join(FIX_DIR, "multi-agent-0153.jsonl"), "utf8")
const childTurn0153 = readFileSync(join(FIX_DIR, "child-turn-0153.jsonl"), "utf8")
// The first fixture line of a given rollout record type, over an arbitrary fixture.
function firstLineIn(text: string, pred: (rec: any) => boolean): string {
  for (const l of text.split("\n")) {
    if (!l.trim()) continue
    try {
      if (pred(JSON.parse(l))) return l
    } catch {}
  }
  throw new Error("no fixture line matched")
}
const itemOf = (r: any) => r?.payload?.item

// Fold a whole rollout string into a fresh accumulator via the backend's authoritative foldLine.
function foldAll(text: string) {
  const backend = createCodexBackend()
  const state = newTailState("t", "sid", "/x")
  for (const line of text.split("\n")) backend.foldLine(state, line)
  return state
}
// Every NormalizedEvent parseCodexLine emits across a rollout, flattened (fixture-grounded totals).
function allEvents(text: string): NormalizedEvent[] {
  return text
    .split("\n")
    .flatMap((l) => parseCodexLine(l))
}
// The first fixture line of a given rollout record type (+ optional event-payload subtype).
function firstLineOf(pred: (rec: any) => boolean): string {
  for (const l of execLines) {
    try {
      if (pred(JSON.parse(l))) return l
    } catch {}
  }
  throw new Error("no fixture line matched")
}

// ==== parseCodexLine — the rollout → NormalizedEvent mapping, asserted on REAL fixture lines ====

test("extractCodexFrizzTitle: first-line attribute comment is primary; H1 and legacy comments remain compatible", () => {
  assert.deepEqual(
    extractCodexFrizzTitle('<!-- frizz title="Fix queue focus" -->\nVisible answer'),
    { markerFound: true, title: "Fix queue focus", text: "Visible answer" },
  )
  assert.deepEqual(
    extractCodexFrizzTitle('<!-- frizz title="Fix &quot;queue&quot; \\&quot;focus\\&quot;" -->\nVisible answer'),
    { markerFound: true, title: 'Fix "queue" "focus"', text: "Visible answer" },
  )
  assert.deepEqual(
    extractCodexFrizzTitle("# Fix queue focus\nVisible answer"),
    { markerFound: true, title: "Fix queue focus", text: "Visible answer" },
  )
  assert.deepEqual(
    extractCodexFrizzTitle("<!-- frizz-title: Fix queue focus -->\nVisible answer"),
    { markerFound: true, title: "Fix queue focus", text: "Visible answer" },
  )
  assert.deepEqual(
    extractCodexFrizzTitle("<!-- frizz-title: Fix\tqueue\u202e focus -->\r\nVisible"),
    { markerFound: true, title: "Fix queue focus", text: "Visible" },
  )
  assert.equal(extractCodexFrizzTitle(`<!-- frizz-title: ${"x".repeat(240)} -->\nBody`).title?.length, 200)
  assert.deepEqual(
    extractCodexFrizzTitle("<!-- frizz-title: <unsafe> -->\nBody"),
    { markerFound: true, text: "Body" },
  )
  const quoted = "Answer first\n<!-- frizz title=\"Quoted example\" -->"
  assert.deepEqual(extractCodexFrizzTitle(quoted), { markerFound: false, text: quoted })
  const ordinaryComment = "<!-- frizz title=unquoted -->\nBody"
  assert.deepEqual(extractCodexFrizzTitle(ordinaryComment), { markerFound: false, text: ordinaryComment })
  const malformed = "<!-- frizz-title:Missing space -->\nBody"
  assert.deepEqual(extractCodexFrizzTitle(malformed), { markerFound: false, text: malformed })
  for (const malformedH1 of ["## Too deep\nBody", "#No space\nBody", " # Indented\nBody"]) {
    assert.deepEqual(extractCodexFrizzTitle(malformedH1), { markerFound: false, text: malformedH1 })
  }
  assert.deepEqual(
    extractCodexFrizzTitle("# H1 wins\n<!-- frizz-title: Legacy loses -->\nBody"),
    { markerFound: true, title: "H1 wins", text: "Body" },
    "legacy H1 precedence keeps the prior compatibility pair hidden",
  )
})

test("extractCodexFrizzTitle: strips every Bidi_Control and unsafe default-ignorable character", () => {
  // Full Unicode Bidi_Control set: ALM, LRM/RLM, embeddings/overrides, and isolates.
  const bidiControls = "\u061c\u200e\u200f\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069"
  // Representative non-semantic Default_Ignorable_Code_Point values, including the reported U+200B.
  const invisibleControls = "\u00ad\u034f\u180e\u200b\u2060\ufeff"
  assert.deepEqual(
    extractCodexFrizzTitle(`<!-- frizz-title: Fix${bidiControls}${invisibleControls} queue -->\nBody`),
    { markerFound: true, title: "Fix queue", text: "Body" },
  )
  assert.deepEqual(
    extractCodexFrizzTitle(`<!-- frizz-title: ${bidiControls}${invisibleControls} -->\nBody`),
    { markerFound: true, text: "Body" },
    "an all-invisible candidate is stripped but never persisted as a title",
  )
})

test("extractCodexFrizzTitle: preserves emoji and language-shaping default ignorables", () => {
  const englandFlag = "\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}"
  const title = `Ship 👩🏽‍💻 and ❤️‍🔥 ${englandFlag} alerts with می‌خواهم, ᠠ\u180b, and 漢\u{e0100}`
  assert.deepEqual(
    extractCodexFrizzTitle(`<!-- frizz-title: ${title} -->\nBody`),
    { markerFound: true, title, text: "Body" },
    "ZWJ, ZWNJ, variation selectors, and complete emoji tag sequences carry visible semantics",
  )
  assert.equal(
    extractCodexFrizzTitle("<!-- frizz-title: Fix\u{e0061} queue -->\nBody").title,
    "Fix queue",
    "a free-standing invisible tag is not an emoji and is stripped",
  )
})

test("extractCodexFrizzTitle: preserves Indic virama sequences before ZWJ and ZWNJ", () => {
  for (const title of ["क्‍ष परीक्षण", "क्‌ष परीक्षण", "á‍b check"]) {
    assert.deepEqual(
      extractCodexFrizzTitle(`<!-- frizz-title: ${title} -->\nBody`),
      { markerFound: true, title, text: "Body" },
    )
  }
})

test("extractCodexFrizzTitle: joiners and selectors cannot form invisible or orphan titles", () => {
  const invisibleOnly = [
    "\u200d", // ZWJ
    "\u200c", // ZWNJ
    "\ufe0f", // VS16
    "\u180b", // Mongolian FVS1
    "\u{e0100}", // supplementary VS
    "\u0301", // a combining mark is not a visible base by itself
  ]
  for (const invisible of invisibleOnly) {
    assert.deepEqual(
      extractCodexFrizzTitle(`<!-- frizz-title: ${invisible} -->\nBody`),
      { markerFound: true, text: "Body" },
    )
  }
  const orphanCases = [
    "\u200dFix", "Fix\u200d",
    "\u200cFix", "Fix\u200c",
    "\ufe0fFix", "Fix \ufe0f",
    "\u180bFix", "Fix \u180b",
    "\u{e0100}Fix", "Fix \u{e0100}",
    "\u{e0061}Fix", "Fix\u{e0061}",
  ]
  for (const candidate of orphanCases) {
    assert.equal(
      extractCodexFrizzTitle(`<!-- frizz-title: ${candidate} -->\nBody`).title,
      "Fix",
      "leading/trailing joiners, selectors, and free-standing tags are stripped",
    )
  }
})

test("extractCodexFrizzTitle: the 200-code-point cap stops at a complete emoji grapheme", () => {
  const prefix = "x".repeat(198)
  const emoji = "👩🏽‍💻" // four code points and one extended grapheme
  const signal = extractCodexFrizzTitle(`<!-- frizz-title: ${prefix}${emoji}tail -->\nBody`)
  assert.equal(signal.title, prefix)
  assert.equal(Array.from(signal.title ?? "").length, 198)
  assert.doesNotMatch(signal.title ?? "", /\u200d|�/, "the cap cannot retain a dangling joiner or surrogate")

  const persianBoundary = extractCodexFrizzTitle(`<!-- frizz-title: ${"x".repeat(198)}ی‌خ -->\nBody`).title ?? ""
  assert.ok(Array.from(persianBoundary).length <= 200)
  assert.doesNotMatch(persianBoundary, /\u200c$/, "post-cap validation cannot leave a trailing ZWNJ")
})

test("parseCodexLine: a malformed / non-object / blank / payload-less line yields no events", () => {
  assert.deepEqual(parseCodexLine("{not json"), [])
  assert.deepEqual(parseCodexLine(""), [])
  assert.deepEqual(parseCodexLine("   "), [])
  assert.deepEqual(parseCodexLine("42"), [])
  assert.deepEqual(parseCodexLine(JSON.stringify({ type: "event_msg" })), []) // no payload
  assert.deepEqual(parseCodexLine(JSON.stringify({ type: "event_msg", payload: { type: "token_count" } })), [])
})

test("parseCodexLine: event_msg/task_started → a single turn-start (carries the line timestamp)", () => {
  const line = firstLineOf((r) => r.type === "event_msg" && r.payload?.type === "task_started")
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  assert.equal(evs[0].kind, "turn-start")
  assert.equal(typeof (evs[0] as any).at, "string")
})

test("parseCodexLine: event_msg/task_complete → turn-end carrying last_agent_message as finalText", () => {
  const line = firstLineOf((r) => r.type === "event_msg" && r.payload?.type === "task_complete")
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  assert.equal(evs[0].kind, "turn-end")
  // Turn 1's final message carries the done fence verbatim.
  assert.match((evs[0] as any).finalText, /```done\nall-good\n```/)
})

// An INTERRUPTED turn is the one that never reaches task_complete. Its ONLY closing bracket is
// turn_aborted — captured verbatim from a live rollout after frizz issued turn/interrupt (2026-07-23).
// Without it the tailer holds the turn in-flight forever, so a thread the operator deliberately
// STOPPED cards as still running and then as crashed/"Stalled" with a Retry it never earned.
const TURN_ABORTED_LINE = JSON.stringify({
  timestamp: "2026-07-23T22:01:57.355Z",
  type: "event_msg",
  payload: {
    type: "turn_aborted",
    turn_id: "019f90ff-aa4a-7673-925e-7c31905622a7",
    reason: "interrupted",
    completed_at: 1784844117,
    duration_ms: 15126,
  },
})

test("parseCodexLine: event_msg/turn_aborted → turn-end, an interrupted turn's only bracket", () => {
  const evs = parseCodexLine(TURN_ABORTED_LINE)
  assert.equal(evs.length, 1)
  assert.equal(evs[0].kind, "turn-end")
  assert.equal(typeof (evs[0] as any).at, "string")
  // No answer was produced, so it must not carry (or invent) final text — no fence, no excusal.
  assert.equal((evs[0] as any).finalText, undefined)
})

test("foldLine: turn_aborted brackets the turn IDLE so a stopped thread stops carding as running", () => {
  const backend = createCodexBackend()
  const state = newTailState("t", "sid", "/x")
  backend.foldLine(state, firstLineOf((r) => r.payload?.type === "task_started"))
  assert.equal(state.turn, "in-flight")
  backend.foldLine(state, TURN_ABORTED_LINE)
  assert.equal(state.turn, "idle")
  assert.equal(state.lastFence, undefined, "an aborted turn excuses nothing")
})

test("parseCodexLine: event_msg/agent_message final_answer → assistant-text{final:true}; text from .message", () => {
  const line = firstLineOf((r) => r.type === "event_msg" && r.payload?.type === "agent_message" && r.payload?.phase === "final_answer")
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  assert.deepEqual({ kind: evs[0].kind, final: (evs[0] as any).final }, { kind: "assistant-text", final: true })
  assert.match((evs[0] as any).text, /```done\nall-good\n```/)
})

test("parseCodexLine: event_msg/agent_message commentary → assistant-text{final:false} (never the answer)", () => {
  const line = firstLineOf((r) => r.type === "event_msg" && r.payload?.type === "agent_message" && r.payload?.phase === "commentary")
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  assert.equal(evs[0].kind, "assistant-text")
  assert.equal((evs[0] as any).final, false)
})

test("parseCodexLine: event_msg/user_message → a genuine (non-synthetic) user-message with .message text", () => {
  const line = firstLineOf((r) => r.type === "event_msg" && r.payload?.type === "user_message")
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  assert.equal(evs[0].kind, "user-message")
  assert.equal((evs[0] as any).synthetic, false)
  assert.match((evs[0] as any).text, /FRIZZ-SENTINEL/) // the real first prompt carried a sentinel
})

// ==== the codex >=0.153 `item_completed` envelope (the same mapping, respelled) ====

test("parseCodexLine: item_completed/AgentMessage commentary → assistant-text{final:false}, text from content[]", () => {
  const line = firstLineIn(multiAgent0153, (r) => itemOf(r)?.type === "AgentMessage" && itemOf(r).phase === "commentary")
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  assert.equal(evs[0].kind, "assistant-text")
  assert.equal((evs[0] as any).final, false)
  // The whole point: the title signal reaches the extractor, which only ever sees assistant-text.
  assert.match((evs[0] as any).text, /^<!-- frizz title="Investigate compiled JavaScript routing" -->/)
})

test("parseCodexLine: item_completed/AgentMessage final_answer → assistant-text{final:true} (the fence-bearing one)", () => {
  const line = firstLineIn(childTurn0153, (r) => itemOf(r)?.type === "AgentMessage" && itemOf(r).phase === "final_answer")
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  assert.deepEqual({ kind: evs[0].kind, final: (evs[0] as any).final }, { kind: "assistant-text", final: true })
  assert.match((evs[0] as any).text, /^Completed \[buildtime-extraction/)
})

test("parseCodexLine: item_completed/UserMessage → a genuine (non-synthetic) user-message", () => {
  const line = firstLineIn(multiAgent0153, (r) => itemOf(r)?.type === "UserMessage")
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  assert.equal(evs[0].kind, "user-message")
  assert.equal((evs[0] as any).synthetic, false)
  assert.match((evs[0] as any).text, /^Your scratch directory is/)
})

test("parseCodexLine: every OTHER item type stays dropped — an item and its response_item twin are one event", () => {
  // Reasoning and CommandExecution appear BOTH as an item and as the response_item this parser already
  // reads. Counting the item as well would paint every codex tool call and reasoning block twice.
  const reasoningItem = firstLineIn(multiAgent0153, (r) => itemOf(r)?.type === "Reasoning")
  const commandItem = firstLineIn(multiAgent0153, (r) => itemOf(r)?.type === "CommandExecution")
  assert.deepEqual(parseCodexLine(reasoningItem), [])
  assert.deepEqual(parseCodexLine(commandItem), [])
  // Counted against the RAW records rather than a hard-coded number, so the invariant survives a
  // fixture edit: one event per response_item, and the item twins add nothing.
  const records = multiAgent0153.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l))
  const responseItems = (type: string) => records.filter((r) => r.type === "response_item" && r.payload?.type === type).length
  const kinds = allEvents(multiAgent0153).map((e) => e.kind)
  assert.equal(kinds.filter((k) => k === "reasoning").length, responseItems("reasoning"))
  assert.equal(kinds.filter((k) => k === "tool-call").length, responseItems("function_call") + responseItems("custom_tool_call"))
  // …and the twins really are present, so this is not passing vacuously.
  assert.ok(records.some((r) => itemOf(r)?.type === "Reasoning") && records.some((r) => itemOf(r)?.type === "CommandExecution"))
})

test("foldLine: a 0.153 rollout yields the frizz title, the human's opening turn and the visible text without the marker", () => {
  const state = foldAll(multiAgent0153)
  assert.equal(state.aiTitle, "Investigate compiled JavaScript routing")
  assert.equal(state.autoTitleSource, "frizz")
  assert.match(state.firstUserText ?? "", /^Your scratch directory is/)
  // The transport comment is metadata, never chat: the preview starts at the agent's own first word.
  assert.match(state.lastAssistant ?? "", /^I’m mapping the existing router/)
})

test("parseCodexLine: response_item/function_call → tool-call with call_id + JSON-parsed arguments", () => {
  const line = firstLineOf((r) => r.type === "response_item" && r.payload?.type === "function_call")
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  const ev = evs[0] as any
  assert.equal(ev.kind, "tool-call")
  assert.equal(ev.name, "exec_command")
  assert.ok(ev.id.startsWith("call_"))
  assert.equal(typeof ev.input, "object") // arguments JSON string parsed to an object
  assert.equal(ev.input.cmd, "cat hello.txt")
})

test("parseCodexLine: response_item/function_call_output → tool-result with call_id + output text", () => {
  const line = firstLineOf((r) => r.type === "response_item" && r.payload?.type === "function_call_output")
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  const ev = evs[0] as any
  assert.equal(ev.kind, "tool-result")
  assert.ok(ev.id.startsWith("call_"))
  assert.match(ev.text, /test file/)
})

test("parseCodexLine: response_item/custom_tool_call (apply_patch) → tool-call carrying the raw patch STRING input", () => {
  // Codex delivers file edits (apply_patch) as a custom_tool_call whose .input is the V4A patch string,
  // NOT a function_call with JSON arguments. Missing this dropped every codex edit from the fold + drawer.
  const line = JSON.stringify({
    timestamp: "2026-07-11T00:00:00.000Z",
    type: "response_item",
    payload: {
      type: "custom_tool_call",
      call_id: "call_abc",
      name: "apply_patch",
      input: "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch\n",
    },
  })
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  const ev = evs[0] as any
  assert.equal(ev.kind, "tool-call")
  assert.equal(ev.name, "apply_patch")
  assert.equal(ev.id, "call_abc")
  assert.equal(typeof ev.input, "string")
  assert.match(ev.input, /Begin Patch/)
})

test("parseCodexLine: response_item/custom_tool_call_output → tool-result with call_id + output text", () => {
  const line = JSON.stringify({
    timestamp: "2026-07-11T00:00:00.000Z",
    type: "response_item",
    payload: { type: "custom_tool_call_output", call_id: "call_abc", output: "Success. Updated the following files:\nM a.txt\n" },
  })
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  const ev = evs[0] as any
  assert.equal(ev.kind, "tool-result")
  assert.equal(ev.id, "call_abc")
  assert.match(ev.text, /Success/)
})

test("parseCodexLine: unified custom-tool content blocks flatten to ordered text, not JSON plumbing", () => {
  const line = execWrapperCommonTools
    .split("\n")
    .find((raw) => {
      const rec = JSON.parse(raw)
      return rec.payload?.type === "custom_tool_call_output" && rec.payload?.call_id === "call_fail"
    })
  assert.ok(line)
  const ev = parseCodexLine(line)[0] as Extract<NormalizedEvent, { kind: "tool-result" }>
  assert.equal(ev.kind, "tool-result")
  assert.match(ev.text, /^Script completed/)
  assert.match(ev.text, /"exit_code":7/)
  assert.doesNotMatch(ev.text, /"type":"input_text"/)
})

// ---- a tool result that CARRIED a picture keeps it on its own channel ----
// An MCP `take_screenshot` answers with an `input_image` data URL. The text channel must keep showing the
// "[image output]" stand-in (the board fold, summaries and the output pane all read `text`, and none of
// them want megabytes of base64), while the picture rides `image` for the transcript projection alone.
const screenshotOutput = (imageUrl: string) => JSON.stringify({
  timestamp: "2026-07-29T20:29:00.000Z",
  type: "response_item",
  payload: {
    type: "function_call_output",
    call_id: "shot",
    output: [
      { type: "input_text", text: "Wall time: 0.0580 seconds\nOutput:" },
      { type: "input_text", text: "Took a screenshot of the current page's viewport." },
      { type: "input_image", image_url: imageUrl },
    ],
  },
})

test("parseCodexLine: an input_image result exposes the data URL on `image`, never inside `text`", () => {
  const dataUrl = "data:image/png;base64,iVBORw0KGgo="
  const ev = parseCodexLine(screenshotOutput(dataUrl))[0] as Extract<NormalizedEvent, { kind: "tool-result" }>
  assert.equal(ev.kind, "tool-result")
  assert.equal(ev.image, dataUrl)
  assert.match(ev.text, /Took a screenshot/)
  assert.match(ev.text, /\[image output\]/, "the text channel keeps the stand-in")
  assert.doesNotMatch(ev.text, /base64/, "and never the blob itself")
})

test("parseCodexLine: a REMOTE image url is not adopted (the transcript never fetches to draw a card)", () => {
  const ev = parseCodexLine(screenshotOutput("https://example.com/shot.png"))[0] as Extract<NormalizedEvent, { kind: "tool-result" }>
  assert.equal(ev.image, undefined)
  assert.match(ev.text, /\[image output\]/, "still reported as an image result, just not a drawable one")
})

test("parseCodexLine: an ordinary text-only result carries no `image` key at all", () => {
  const line = JSON.stringify({
    timestamp: "2026-07-29T20:29:00.000Z",
    type: "response_item",
    payload: { type: "function_call_output", call_id: "c1", output: [{ type: "input_text", text: "done" }] },
  })
  const ev = parseCodexLine(line)[0] as Extract<NormalizedEvent, { kind: "tool-result" }>
  assert.equal("image" in ev, false)
  assert.equal(ev.text, "done")
})

// Shapes captured from the real corpus (2026-07-24: 2282 `compacted` records across 355 rollouts under
// ~/.codex/sessions/2026; `payload.message` empty in every one, a token_count immediately before in 2281
// and immediately after in 2282). Written inline rather than fixtured because a real record's
// `replacement_history` is the whole prior conversation.
test("parseCodexLine: the top-level `compacted` envelope is a compaction event (codex measures no tokens)", () => {
  const line = JSON.stringify({
    timestamp: "2026-07-20T22:12:57.947Z",
    type: "compacted",
    payload: { message: "", replacement_history: [{ type: "message", role: "developer", content: [] }] },
  })
  assert.deepEqual(parseCodexLine(line), [{ kind: "compaction", at: "2026-07-20T22:12:57.947Z" }])
  // Defensive: the envelope alone is the signal, so a payload-less variant still reports the event.
  assert.deepEqual(parseCodexLine(JSON.stringify({ timestamp: "2026-07-20T22:12:57.947Z", type: "compacted" })), [
    { kind: "compaction", at: "2026-07-20T22:12:57.947Z" },
  ])
})

test("parseCodexLine: token_count reports the LAST request's total as context usage; a shapeless one yields nothing", () => {
  const tokenCount = (info: unknown) => JSON.stringify({ timestamp: "2026-07-20T22:11:14.818Z", type: "event_msg", payload: { type: "token_count", info } })
  const ev = parseCodexLine(tokenCount({ last_token_usage: { input_tokens: 242204, output_tokens: 288, total_tokens: 242492 }, model_context_window: 258400 }))
  // The window rides the SAME event as the tokens — which is why the footer's fullness readout never
  // needs a per-model table for codex. It is the DENOMINATOR, so a wrong one is worse than none: a
  // non-numeric or non-positive value must be dropped rather than passed through.
  assert.deepEqual(ev, [{ kind: "context-usage", at: "2026-07-20T22:11:14.818Z", tokens: 242492, window: 258400 }])
  const noWindow = parseCodexLine(tokenCount({ last_token_usage: { total_tokens: 10 } }))
  assert.deepEqual(noWindow, [{ kind: "context-usage", at: "2026-07-20T22:11:14.818Z", tokens: 10 }])
  assert.deepEqual(parseCodexLine(tokenCount({ last_token_usage: { total_tokens: 10 }, model_context_window: 0 })), noWindow)
  assert.deepEqual(parseCodexLine(tokenCount({ last_token_usage: { total_tokens: 10 }, model_context_window: "258400" })), noWindow)
  assert.deepEqual(parseCodexLine(tokenCount({ last_token_usage: {} })), [])
  assert.deepEqual(parseCodexLine(tokenCount(null)), [])
})

test("parseCodexLine: NO DOUBLE COUNT — response_item/message (the assistant/prompt echo) yields nothing", () => {
  const asstEcho = firstLineOf((r) => r.type === "response_item" && r.payload?.type === "message" && r.payload?.role === "assistant")
  const userEcho = firstLineOf((r) => r.type === "response_item" && r.payload?.type === "message" && r.payload?.role === "user")
  assert.deepEqual(parseCodexLine(asstEcho), [])
  assert.deepEqual(parseCodexLine(userEcho), [])
})

test("parseCodexLine: sidecar records (session_meta, turn_context, world_state, reasoning) yield nothing", () => {
  for (const type of ["session_meta", "turn_context", "world_state"]) {
    const line = firstLineOf((r) => r.type === type)
    assert.deepEqual(parseCodexLine(line), [], `${type} should be skipped`)
  }
  // The captured reasoning records are encryption-only (summary: []) → no reasoning event: the raw
  // encrypted CoT is never surfaced. A summary-BEARING reasoning record is covered separately below.
  const reasoning = firstLineOf((r) => r.type === "response_item" && r.payload?.type === "reasoning")
  assert.deepEqual(parseCodexLine(reasoning), [])
})

// ---- response_item/agent_message: codex's INTER-AGENT channel ----
// A spawn_agent child returns through this record, not through the parent's tool result. Shapes are
// verbatim from a real 19k-line orchestration rollout (263 FINAL_ANSWER + 125 MESSAGE, all recipient
// "/root"); before this arm existed parseCodexLine dropped every one of them.
function interAgent(author: string, recipient: string, type: string, body: string): string {
  return JSON.stringify({
    timestamp: "2026-07-31T01:00:39.106Z",
    type: "response_item",
    payload: {
      type: "agent_message",
      id: "amsg_019fb5b0-0323-7533-8508-42ec8b42abbc",
      author,
      recipient,
      content: [
        { type: "input_text", text: `Message Type: ${type}\nTask name: ${recipient}\nSender: ${author}\nPayload:\n${body}` },
        { type: "encrypted_content", data: "gAAAAABqbMTRjP0uenKvddqxbODpjhMbID3F" },
      ],
    },
  })
}

test("parseCodexLine: a child's inter-agent message → agent-report, FINAL_ANSWER splitting the terminal return from a progress MESSAGE", () => {
  assert.deepEqual(parseCodexLine(interAgent("/root/node_license_audit", "/root", "FINAL_ANSWER", "## Finding\n\nNode's notices must ship with the artifact.")), [
    { kind: "agent-report", at: "2026-07-31T01:00:39.106Z", author: "/root/node_license_audit", text: "## Finding\n\nNode's notices must ship with the artifact.", final: true },
  ])
  // Every MESSAGE in the corpus has an EMPTY plaintext payload (its body rides the sibling encrypted
  // block). It must still report: the divider it draws carries no excerpt anyway, so suppressing the
  // empty ones would hide mid-flight progress entirely.
  assert.deepEqual(parseCodexLine(interAgent("/root/bun_project_survey", "/root", "MESSAGE", "")), [
    { kind: "agent-report", at: "2026-07-31T01:00:39.106Z", author: "/root/bun_project_survey", text: "", final: false },
  ])
})

test("parseCodexLine: a parent's instruction is preserved in the CHILD transcript, including the encrypted-body limitation", () => {
  // What a CHILD's own rollout carries: the parent addressing it. Current Codex records an empty
  // plaintext payload plus an encrypted_content sibling; retain the arrival rather than dropping the
  // whole turn. A plaintext payload remains displayable for older/future Codex builds.
  assert.deepEqual(parseCodexLine(interAgent("/root", "/root/bun_project_survey", "NEW_TASK", "")), [{
    kind: "agent-instruction",
    at: "2026-07-31T01:00:39.106Z",
    author: "/root",
    encrypted: true,
  }])
  assert.deepEqual(parseCodexLine(interAgent("/root", "/root/bun_project_survey", "MESSAGE", "steer")), [{
    kind: "agent-instruction",
    at: "2026-07-31T01:00:39.106Z",
    author: "/root",
    text: "steer",
    encrypted: true,
  }])
  // A sibling/unrelated path is not a descendant of ours either.
  assert.deepEqual(parseCodexLine(interAgent("/other/child", "/root", "FINAL_ANSWER", "x")), [])
  // A future message type is not rendered blind, and a record with no readable block yields nothing.
  assert.deepEqual(parseCodexLine(interAgent("/root/x", "/root", "SOMETHING_NEW", "body")), [])
  assert.deepEqual(parseCodexLine(JSON.stringify({ type: "response_item", payload: { type: "agent_message", author: "/root/x", recipient: "/root", content: [{ type: "encrypted_content", data: "gAAAA" }] } })), [])
})

test("applyEvent: an agent-report is session ACTIVITY and nothing else — it never moves the turn, preview, fence or rest time", () => {
  const state = newTailState("t", "sid", "/x")
  applyEvent(state, { kind: "turn-end", at: "2026-07-31T01:00:00.000Z", finalText: "the parent's answer\n\n```awaiting\nhuman: review\n```" })
  const restedAt = state.lastAssistantAt
  const fence = state.lastFence
  const preview = state.lastAssistant
  applyEvent(state, { kind: "agent-report", at: "2026-07-31T01:00:39.106Z", author: "/root/child", text: "the CHILD's answer", final: true })
  // The clock advances (a parent waiting on children is working, not stalled) …
  assert.equal(state.lastActivityAt, "2026-07-31T01:00:39.106Z")
  // … and nothing else moves: a child's return must not re-open the parent's turn, nor excuse or
  // overwrite the fence/preview/rest time that belong to the parent's OWN final message.
  assert.equal(state.turn, "idle")
  assert.equal(state.lastAssistantAt, restedAt)
  assert.deepEqual(state.lastFence, fence)
  assert.equal(state.lastAssistant, preview)
  assert.equal(state.lastUserAt, undefined)
})

test("parseCodexLine: response_item/reasoning WITH summary[] → one reasoning event joining the summary_text items", () => {
  const line = JSON.stringify({
    timestamp: "2026-07-15T14:42:06.000Z",
    type: "response_item",
    payload: {
      type: "reasoning",
      encrypted_content: "gAAAAAB-opaque-blob",
      summary: [
        { type: "summary_text", text: "**Checking the config**" },
        { type: "summary_text", text: "The user wants X, so I'll read Y first." },
      ],
    },
  })
  const evs = parseCodexLine(line)
  assert.equal(evs.length, 1)
  const ev = evs[0] as any
  assert.equal(ev.kind, "reasoning")
  assert.equal(ev.at, "2026-07-15T14:42:06.000Z")
  // summary_text items join with a blank line; the encrypted CoT never leaks into the text.
  assert.equal(ev.text, "**Checking the config**\n\nThe user wants X, so I'll read Y first.")
  assert.ok(!ev.text.includes("gAAAA"))
})

test("parseCodexLine: reasoning with an empty / whitespace-only / absent summary → no event (encryption-only)", () => {
  const mk = (summary: unknown) => JSON.stringify({ type: "response_item", payload: { type: "reasoning", summary } })
  assert.deepEqual(parseCodexLine(mk([])), [])
  assert.deepEqual(parseCodexLine(mk([{ type: "summary_text", text: "   " }])), [])
  assert.deepEqual(parseCodexLine(JSON.stringify({ type: "response_item", payload: { type: "reasoning" } })), [])
})

test("parseCodexSessionProfile: turn_context exposes the actual model/effort without rendering an event", () => {
  const line = firstLineOf((r) => r.type === "turn_context")
  assert.deepEqual(parseCodexSessionProfile(line), {
    model: "gpt-5.5",
    effort: "high",
    profileAt: "2026-07-10T21:58:44.858Z",
    permissionMode: "bypassPermissions",
    permissionModeAt: "2026-07-10T21:58:44.858Z",
  })
  assert.deepEqual(parseCodexLine(line), [], "profile telemetry stays out of the conversation event stream")
  assert.equal(parseCodexSessionProfile("{not json"), undefined)
})

test("parseCodexSessionProfile: thread_settings_applied maps verified Codex permission telemetry", () => {
  const settings = (thread_settings: object) =>
    JSON.stringify({ type: "event_msg", payload: { type: "thread_settings_applied", thread_settings } })
  assert.equal(
    parseCodexSessionProfile(settings({ permission_profile: { type: "managed" }, active_permission_profile: { id: ":workspace" } }))?.permissionMode,
    "default",
  )
  assert.equal(
    parseCodexSessionProfile(settings({ permission_profile: { type: "disabled" }, active_permission_profile: { id: ":danger-full-access" } }))?.permissionMode,
    "bypassPermissions",
  )
  assert.equal(parseCodexSessionProfile(JSON.stringify({ type: "turn_context", payload: { sandbox_policy: { type: "read-only" } } }))?.permissionMode, "plan")
})

// ==== event totals across the whole real fixture (the no-double-count invariant, quantified) ====

test("parseCodexLine over the full 2-turn fixture: event counts match the raw record counts exactly", () => {
  const evs = allEvents(execTwoTurn)
  const count = (k: NormalizedEvent["kind"]) => evs.filter((e) => e.kind === k).length
  // 2 task_started / 2 task_complete brackets; the 5 agent_messages (2 final + 3 commentary) become 5
  // assistant-texts (NOT 10 — the 5 response_item/message duplicates are dropped); 5 exec tools.
  assert.equal(count("turn-start"), 2)
  assert.equal(count("turn-end"), 2)
  assert.equal(count("assistant-text"), 5)
  assert.equal(count("tool-call"), 5)
  assert.equal(count("tool-result"), 5)
  assert.equal(count("user-message"), 2)
  // the fixture's 6 token_count records — telemetry the fold ignores and the transcript uses only to
  // bracket a compaction (this fixture has none, so no compaction event).
  assert.equal(count("context-usage"), 6)
  assert.equal(count("compaction"), 0)
  // exactly one final answer per turn
  assert.equal(evs.filter((e) => e.kind === "assistant-text" && (e as any).final).length, 2)
})

// ==== foldLine — the AUTHORITATIVE fold drives FoldState (codex turn-read flows in correctly) ====

test("foldLine: task_started flips the fold IN-FLIGHT, task_complete brackets it IDLE (codex turn-read)", () => {
  const backend = createCodexBackend()
  const state = newTailState("t", "sid", "/x")
  backend.foldLine(state, firstLineOf((r) => r.payload?.type === "task_started"))
  assert.equal(state.turn, "in-flight")
  backend.foldLine(state, firstLineOf((r) => r.payload?.type === "task_complete"))
  assert.equal(state.turn, "idle")
})

test("foldLine: folding the whole 2-turn fixture lands idle with the LAST turn's awaiting+timer fence", () => {
  const state = foldAll(execTwoTurn)
  assert.equal(state.turn, "idle")
  assert.ok(state.sawRecords)
  assert.equal(state.model, "gpt-5.5", "turn_context pins the backend-observed model")
  assert.equal(state.effort, "high", "turn_context pins the backend-observed effort")
  assert.equal(state.permissionMode, "bypassPermissions", "turn_context pins the backend-observed sandbox")
  // Turn 2's final message ends in ```awaiting / `timer: 5m` — a REAL RECORDING, and it predates the
  // 2026-08-24 YAML cutover, so it is exactly the shape an in-flight worker still writes. The fence is
  // still recognised; its retired singular key names NOTHING and falls to the body, which is where the
  // scheduler reads it back to tell the worker that `timers: [tmr_…]` replaced it. A park that cannot
  // resolve must never look like one that can — the fixture is left as recorded rather than rewritten.
  assert.equal(state.lastFence?.kind, "awaiting")
  assert.deepEqual(state.lastFence?.hints, [])
  assert.match(state.lastFence?.body ?? "", /timer: 5m/, "the offending line stays visible to SOURCE 12")
  // Preview reflects the final answer, not a commentary line.
  assert.match(state.lastAssistant ?? "", /1 line/)
  // The genuine human turns bumped the row-order key.
  assert.equal(typeof state.lastUserAt, "string")
  assert.match(state.lastUserText ?? "", /^Now do three things/, "latest exact user text is available for durable input confirmation")
})

test("foldLine: after only turn 1 (through its task_complete) the fence is the ```done excusal", () => {
  const backend = createCodexBackend()
  const state = newTailState("t", "sid", "/x")
  for (const l of execLines) {
    backend.foldLine(state, l)
    if (JSON.parse(l).payload?.type === "task_complete") break // stop at end of turn 1
  }
  assert.equal(state.turn, "idle")
  assert.equal(state.lastFence?.kind, "done")
  assert.equal(state.lastFence?.body, "all-good")
})

test("foldLine: a commentary agent_message refreshes the preview but carries NO fence", () => {
  // A quoted excusal fence inside a COMMENTARY message must never excuse the thread.
  const backend = createCodexBackend()
  const state = newTailState("t", "sid", "/x")
  backend.foldLine(state, JSON.stringify({ type: "event_msg", timestamp: "2026-07-01T00:00:00.000Z", payload: { type: "task_started" } }))
  backend.foldLine(state, JSON.stringify({ type: "event_msg", timestamp: "2026-07-01T00:00:01.000Z", payload: { type: "agent_message", phase: "commentary", message: "working on it\n\n```done\nnope\n```" } }))
  assert.equal(state.turn, "in-flight")
  assert.equal(state.lastFence, undefined) // commentary never sets the excusal fence
  assert.match(state.lastAssistant ?? "", /working on it/)
})

test("foldLine: the first commentary title comment is persisted immediately and never enters preview telemetry", () => {
  const backend = createCodexBackend()
  const state = newTailState("t", "sid", "/x")
  backend.foldLine(state, JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-01T00:00:01.000Z",
    payload: {
      type: "agent_message",
      phase: "commentary",
      message: '<!-- frizz title="Fix reliable Codex titles" -->\nI’m tracing the launch path.',
    },
  }))
  assert.equal(state.aiTitle, "Fix reliable Codex titles")
  assert.equal(state.autoTitleSource, "frizz")
  assert.equal(state.lastAssistant, "I’m tracing the launch path.")

  backend.foldLine(state, JSON.stringify({
    type: "event_msg",
    timestamp: "2026-07-01T00:00:02.000Z",
    payload: { type: "agent_message", phase: "final_answer", message: "Finished." },
  }))
  assert.equal(state.aiTitle, "Fix reliable Codex titles", "the final response cannot churn an early title")
})

test("foldLine: legacy H1 is not interpreted as title metadata in commentary", () => {
  const backend = createCodexBackend()
  const state = newTailState("t", "sid", "/x")
  backend.foldLine(state, JSON.stringify({
    type: "event_msg",
    payload: { type: "agent_message", phase: "commentary", message: "# Ordinary progress heading\nStill working." },
  }))
  assert.equal(state.aiTitle, undefined)
  assert.match(state.lastAssistant ?? "", /Ordinary progress heading/)
})

test("foldLine: legacy H1 compatibility remains first-final-only; omitted primary markers retain the dispatch fallback", () => {
  const backend = createCodexBackend()
  const state = newTailState("t", "sid", "/x")
  const final = (message: string) => JSON.stringify({
    timestamp: "2026-07-01T00:00:01.000Z",
    type: "event_msg",
    payload: { type: "agent_message", phase: "final_answer", message },
  })

  // Legacy transcript compatibility only: newly dispatched workers are instructed to emit the
  // invisible `<!-- frizz title="…" -->` transport instead.
  backend.foldLine(state, final("# Fix queue focus\nVisible answer"))
  assert.equal(state.aiTitle, "Fix queue focus")
  assert.equal(state.lastAssistant, "Visible answer", "the hidden marker never enters preview telemetry")
  assert.equal(state.titleCandidateFinalSeen, true)

  backend.foldLine(state, JSON.stringify({
    timestamp: "2026-07-01T00:00:02.000Z",
    type: "event_msg",
    payload: {
      type: "task_complete",
      last_agent_message: "# Fix queue focus\nVisible answer",
    },
  }))
  assert.equal(state.lastAssistant, "Visible answer", "task_complete's echo cannot restore the hidden marker")

  backend.foldLine(state, final("# Later rewrite\nSecond answer"))
  assert.equal(state.aiTitle, "Fix queue focus", "later turns cannot rename the thread")

  const omitted = newTailState("t", "sid", "/x")
  backend.foldLine(omitted, final("First final omitted the marker"))
  assert.equal(omitted.aiTitle, undefined, "the useful dispatch fallback stays in storage, not generic telemetry")
  assert.equal(omitted.autoTitleSource, "fallback")
  backend.foldLine(omitted, final("# Too late\nSecond answer"))
  assert.equal(omitted.aiTitle, "Too late", "a later marker repairs only the neutral auto fallback")
  assert.equal(omitted.autoTitleSource, "frizz")

  backend.foldLine(omitted, final("# Still too late\nThird answer"))
  assert.equal(omitted.aiTitle, "Too late", "a generated title is stable after recovery")
})

test("foldLine: task_complete-only finals can title once, while an existing native title wins", () => {
  const backend = createCodexBackend()
  const completion = (text: string) => JSON.stringify({
    timestamp: "2026-07-01T00:00:02.000Z",
    type: "event_msg",
    payload: { type: "task_complete", last_agent_message: text },
  })
  const fallback = newTailState("t", "sid", "/x")
  backend.foldLine(fallback, completion("<!-- frizz-title: Completion fallback -->\nVisible"))
  assert.equal(fallback.aiTitle, "Completion fallback")
  assert.equal(fallback.lastAssistant, "Visible")

  const native = newTailState("t", "sid", "/x")
  applyEvent(native, { kind: "title", title: "Provider native title" })
  backend.foldLine(native, completion("<!-- frizz-title: Frizz fallback -->\nVisible"))
  assert.equal(native.aiTitle, "Provider native title")
})

test("foldLine: real interactive Codex rollout without a marker marks the dispatch fallback as replaceable", () => {
  const state = foldAll(tuiSingleTurn)
  assert.equal(state.aiTitle, undefined)
  assert.equal(state.autoTitleSource, "fallback")
})

test("foldLine: codex folds NO sub-agents / bg-shells / pending-ask (Claude-only surfaces stay empty)", () => {
  const state = foldAll(execTwoTurn)
  assert.equal(state.subAgents.size, 0)
  assert.equal(state.retiredSubAgents.size, 0)
  assert.equal(state.pendingAsk, undefined)
})

test("foldLine: the INTERACTIVE TUI rollout folds identically (source:\"cli\" parity) — idle + done fence", () => {
  const state = foldAll(tuiSingleTurn)
  assert.equal(state.turn, "idle")
  assert.equal(state.lastFence?.kind, "done")
  assert.equal(state.lastFence?.body, "tui-ok")
})

test("foldLine agrees with applyEvent(parseCodexLine): foldLine IS parseLine→applyEvent", () => {
  // Independently drive the events through applyEvent and assert the same terminal state.
  const backend = createCodexBackend()
  const a = newTailState("t", "s", "/x")
  const b = newTailState("t", "s", "/x")
  for (const l of execTwoTurn.split("\n")) {
    backend.foldLine(a, l)
    for (const ev of parseCodexLine(l)) applyEvent(b, ev)
  }
  assert.equal(a.turn, b.turn)
  assert.deepEqual(a.lastFence, b.lastFence)
  assert.equal(a.lastAssistant, b.lastAssistant)
  assert.equal(a.lastUserAt, b.lastUserAt)
})

// ==== effort / sandbox mappings ====

test("codexEffort: passes through codex's full universe (incl. max/ultra), unknown → undefined", () => {
  assert.equal(codexEffort("low"), "low")
  assert.equal(codexEffort("medium"), "medium")
  assert.equal(codexEffort("high"), "high")
  assert.equal(codexEffort("xhigh"), "xhigh")
  // max/ultra are REAL codex levels (per-model gated in the UI) — no longer clamped down (the old
  // max→xhigh clamp WRONGLY downgraded a 5.6 model that supports them).
  assert.equal(codexEffort("max"), "max")
  assert.equal(codexEffort("ultra"), "ultra")
  assert.equal(codexEffort(undefined), undefined)
  assert.equal(codexEffort("bogus"), undefined)
})

test("codexSandbox: plan→read-only, bypassPermissions→danger-full-access, else→workspace-write", () => {
  assert.equal(codexSandbox("plan"), "read-only")
  assert.equal(codexSandbox("bypassPermissions"), "danger-full-access")
  assert.equal(codexSandbox("acceptEdits"), "workspace-write")
  assert.equal(codexSandbox("auto"), "workspace-write")
  assert.equal(codexSandbox("default"), "workspace-write")
})

// ==== transcript discovery (the §6 session-id race) ====

// Build a temp $CODEX_HOME with a date-sharded rollout for a given id, cwd, and embedded sentinel.
function writeRollout(codexHome: string, id: string, cwd: string, sentinel: string, shard = "2026/07/10"): string {
  const dir = join(codexHome, "sessions", ...shard.split("/"))
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `rollout-2026-07-10T00-00-00-${id}.jsonl`)
  writeFileSync(
    path,
    [
      JSON.stringify({ timestamp: "2026-07-10T00:00:00.000Z", type: "session_meta", payload: { session_id: id, cwd } }),
      JSON.stringify({ timestamp: "2026-07-10T00:00:01.000Z", type: "event_msg", payload: { type: "user_message", message: `task <!-- ${sentinel} --> more` } }),
    ].join("\n") + "\n",
  )
  return path
}

test("findRolloutById / transcriptPath: locate a rollout by its codex id suffix", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-"))
  try {
    const p = writeRollout(home, "FFFFFFFF-ffff-ffff-ffff-ffffffffffff", "/repo/w", "frizz-session:disp-F")
    assert.equal(findRolloutById("FFFFFFFF-ffff-ffff-ffff-ffffffffffff", home), p)
    assert.equal(findRolloutById("does-not-exist", home), undefined)
    const backend = createCodexBackend({ codexHome: home })
    assert.equal(backend.transcriptPath("FFFFFFFF-ffff-ffff-ffff-ffffffffffff"), p)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
// ---- FOREIGN rollout discovery: which of the machine's rollouts belong to THIS project ----
//
// Codex keeps one global sessions tree, so unlike Claude's per-project bucket every filter that decides
// whether a rollout is one of this project's own terminals lives inside the file. Each exclusion below
// is one that produces a WRONG board row if it is skipped, not a tidiness rule.
test("scanForeignRollouts: this project's own human-started rollouts, and nothing else", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-foreign-"))
  const shard = join(home, "sessions", "2026", "08", "19")
  mkdirSync(shard, { recursive: true })
  const NOW = Date.parse("2026-08-19T12:00:00.000Z")

  // `base_instructions` is inlined on line 1 in real rollouts and pushes it past any small head read,
  // so the fixture carries a bulky one too — a 16KB reader would truncate the JSON and match nothing.
  const write = (id: string, meta: Record<string, unknown>, ageMs = 60_000) => {
    const path = join(shard, `rollout-2026-08-19T11-00-00-${id}.jsonl`)
    const line = JSON.stringify({
      timestamp: "2026-08-19T11:00:00.000Z",
      type: "session_meta",
      payload: { session_id: id, base_instructions: { text: "x".repeat(40_000) }, ...meta },
    })
    writeFileSync(path, `${line}\n`)
    utimesSync(path, new Date(NOW - ageMs), new Date(NOW - ageMs))
    return path
  }

  const MINE = "11111111-1111-4111-8111-111111111111"
  const CHILD = "22222222-2222-4222-8222-222222222222"
  const OTHER_PROJECT = "33333333-3333-4333-8333-333333333333"
  const STALE = "44444444-4444-4444-8444-444444444444"
  const DISPATCHED = "55555555-5555-4555-8555-555555555555"
  const LEGACY_CHILD = "66666666-6666-4666-8666-666666666666"

  write(MINE, { cwd: "/work/app", thread_source: "user" })
  write(CHILD, { cwd: "/work/app", thread_source: "subagent" })
  // An older rollout predating `thread_source` still names its parent, which is the same answer.
  write(LEGACY_CHILD, { cwd: "/work/app", parent_thread_id: MINE })
  write(OTHER_PROJECT, { cwd: "/work/other", thread_source: "user" })
  write(STALE, { cwd: "/work/app", thread_source: "user" }, 48 * 3600_000)
  write(DISPATCHED, { cwd: "/work/app", thread_source: "user" })

  try {
    const found = scanForeignRollouts({
      cwds: ["/work/app"],
      nowMs: NOW,
      freshMs: 24 * 3600_000,
      // A frizz-dispatched codex thread pins its rollout id in `agent_session_id`. Without it here the
      // thread frizz is actively driving comes back as its own read-only twin.
      exclude: new Set([DISPATCHED]),
      max: 20,
    }, home)
    assert.deepEqual(found.map((f) => f.id), [MINE])

    // The project is matched against every cwd spelling offered, because a rollout records the cwd the
    // codex process actually had — on macOS `/private/tmp/x` where frizz holds `/tmp/x`.
    const aliased = scanForeignRollouts({
      cwds: ["/tmp/app", "/work/app"], nowMs: NOW, freshMs: 24 * 3600_000, exclude: new Set(), max: 20,
    }, home)
    assert.deepEqual(aliased.map((f) => f.id).sort(), [DISPATCHED, MINE].sort())

    // The cap is honoured, and a home with no sessions tree at all is empty rather than a throw.
    assert.equal(scanForeignRollouts({ cwds: ["/work/app"], nowMs: NOW, freshMs: 24 * 3600_000, exclude: new Set(), max: 1 }, home).length, 1)
    assert.deepEqual(scanForeignRollouts({ cwds: ["/work/app"], nowMs: NOW, freshMs: 24 * 3600_000, exclude: new Set(), max: 20 }, join(home, "nope")), [])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// Codex names its own threads in a SIDECAR, not in the rollout: `$CODEX_HOME/session_index.jsonl`.
// Coverage is thin on a real machine (22 entries against 1,586 rollouts here), so every caller has to
// treat a miss as ordinary — which is why the misses below are all silent rather than thrown.
test("readCodexThreadNames: the sidecar index, last writer winning, degrading on anything malformed", () => {
  const home = mkdtempSync(join(tmpdir(), "codexhome-names-"))
  try {
    // A missing index is the common case for a fresh install, and must be empty rather than an error.
    assert.equal(readCodexThreadNames(home).size, 0)

    writeFileSync(join(home, "session_index.jsonl"), [
      JSON.stringify({ id: "aaa", thread_name: "Explain account status differences", updated_at: "2026-08-01T00:00:00Z" }),
      "{ not json at all",
      JSON.stringify({ id: "bbb", thread_name: "   ", updated_at: "2026-08-02T00:00:00Z" }), // blank name is no name
      JSON.stringify({ id: "ccc" }), // no name at all
      // The file is APPEND-ONLY, so a renamed thread appears twice and the later line is current.
      JSON.stringify({ id: "aaa", thread_name: "Explain account status", updated_at: "2026-08-03T00:00:00Z" }),
      "",
    ].join("\n"))

    const names = readCodexThreadNames(home)
    assert.equal(names.get("aaa"), "Explain account status", "the newer line wins")
    assert.equal(names.get("bbb"), undefined)
    assert.equal(names.get("ccc"), undefined)
    assert.equal(names.size, 1, "one malformed line must not cost the whole index")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
