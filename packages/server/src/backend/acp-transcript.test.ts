import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AcpTranscriptWriter, acpTranscriptPath, createAcpBackend, parseAcpLine, projectAcpTranscript, type AcpRecord } from "./acp-transcript.ts"
import { newTailState } from "../tailer.ts"

// One recorded turn, in the shape the bridge writes it (an opencode turn that wrote a file, ran a
// command, then answered), followed by a follow-up whose turn is still open.
const T = (s: number) => `2026-09-15T22:00:${String(s).padStart(2, "0")}.000Z`
const RECORDS: AcpRecord[] = [
  { kind: "acp-session", at: T(0), agent: { id: "opencode", name: "OpenCode", version: "1.18.29" }, acpSessionId: "ses_1", cwd: "/tmp/p", model: "opencode/big-pickle" },
  { kind: "user-message", at: T(1), text: "Create hello.txt and cat it.", synthetic: false },
  { kind: "turn-start", at: T(1) },
  { kind: "reasoning", at: T(2), text: "The user wants a file, then a cat." },
  { kind: "assistant-text", at: T(2), text: "I'll write the file first.", final: false, messageId: "m1" },
  { kind: "tool-call", at: T(3), id: "call_w", name: "write", input: { filePath: "/tmp/p/hello.txt", content: "hi" }, acp: { kind: "edit", title: "hello.txt", locations: ["/tmp/p/hello.txt"] } },
  { kind: "tool-result", at: T(4), id: "call_w", text: "Wrote file successfully." },
  { kind: "tool-call", at: T(4), id: "call_b", name: "bash", input: { command: "cat hello.txt", workdir: "/tmp/p" }, acp: { kind: "execute", title: "cat hello.txt" } },
  { kind: "tool-result", at: T(5), id: "call_b", text: "hi" },
  { kind: "assistant-text", at: T(6), text: "Done: the file", final: false, messageId: "m2" },
  { kind: "assistant-text", at: T(6), text: " contains `hi`.", final: true, messageId: "m2" },
  { kind: "context-usage", at: T(6), tokens: 14120, window: 200000 },
  { kind: "turn-end", at: T(6), finalText: "Done: the file contains `hi`.", successful: true },
  { kind: "user-message", at: T(9), text: "Now delete it.", synthetic: false },
  { kind: "turn-start", at: T(9) },
]
const RAW = RECORDS.map((r) => JSON.stringify(r)).join("\n") + "\n"

test("acp-transcript: parseAcpLine strips the transcript-only fields and skips the header", () => {
  assert.deepEqual(parseAcpLine(JSON.stringify(RECORDS[0])), [])
  assert.deepEqual(parseAcpLine(JSON.stringify(RECORDS[4])), [{ kind: "assistant-text", at: T(2), text: "I'll write the file first.", final: false }])
  assert.deepEqual(parseAcpLine(JSON.stringify(RECORDS[5])), [{ kind: "tool-call", at: T(3), id: "call_w", name: "write", input: { filePath: "/tmp/p/hello.txt", content: "hi" } }])
  assert.deepEqual(parseAcpLine("not json"), [])
  assert.deepEqual(parseAcpLine('{"kind":"something-new","at":"x"}'), [], "an unknown record kind is skipped, never thrown")
})

test("acp-transcript: the fold reaches idle with the final preview after the first turn, and in-flight after the follow-up", () => {
  const backend = createAcpBackend({ stateDir: "/tmp/state" })
  assert.equal(backend.transcriptPath("abc"), acpTranscriptPath("/tmp/state", "abc"))
  const s = newTailState("t", "s", "/x")
  const lines = RAW.split("\n")
  for (const line of lines.slice(0, 13)) backend.foldLine(s, line)
  assert.equal(s.model, "opencode/big-pickle", "the header pins the model the agent reported")
  assert.equal(s.turn, "idle")
  assert.equal(s.lastAssistant, "Done: the file contains `hi`.")
  assert.equal(s.lastAssistantAt, T(6))
  assert.equal(s.lastUserAt, T(1))
  assert.equal(s.firstUserText, "Create hello.txt and cat it.")
  for (const line of lines.slice(13)) backend.foldLine(s, line)
  assert.equal(s.turn, "in-flight")
  assert.equal(s.lastUserAt, T(9))
})

test("acp-transcript: the drawer projection — user bubble, reasoning, one assistant message with ordered parts, tool statuses", () => {
  const msgs = projectAcpTranscript(RAW, "acp:s")
  assert.deepEqual(msgs.map((m) => [m.role, m.kind ?? "message"]), [
    ["user", "message"], ["assistant", "reasoning"], ["assistant", "message"], ["user", "message"],
  ])
  assert.equal(msgs[0]!.text, "Create hello.txt and cat it.")
  assert.equal(msgs[0]!.sourceId, "acp:s:1")
  assert.equal(msgs[1]!.text, "The user wants a file, then a cat.")
  const a = msgs[2]!
  assert.deepEqual(a.parts.map((p) => p.kind), ["text", "tools", "text"])
  assert.equal(a.text, "I'll write the file first.\n\nDone: the file contains `hi`.", "two partial flushes of message m2 render as one text part")
  assert.deepEqual(a.tools.map((t) => [t.name, t.status, t.detail, t.output]), [
    ["write", "completed", "/tmp/p/hello.txt", "Wrote file successfully."],
    ["bash", "completed", "cat hello.txt", "hi"],
  ])
  assert.equal(a.tools[1]!.command, "cat hello.txt")
  assert.equal(a.tools[0]!.command, undefined)
  assert.match(a.tools[0]!.input ?? "", /hello\.txt/)
  assert.equal(msgs[3]!.text, "Now delete it.")
})

test("acp-transcript: a provider error closes the assistant message with the error attached; a synthetic user record is a wake", () => {
  const recs: AcpRecord[] = [
    { kind: "user-message", at: T(1), text: "go", synthetic: false },
    { kind: "turn-start", at: T(1) },
    { kind: "provider-error", at: T(2), error: { message: "Authentication required", code: "-32000" } },
    { kind: "turn-end", at: T(2), successful: false },
    { kind: "user-message", at: T(3), text: "Goal: keep going", synthetic: true },
  ]
  const msgs = projectAcpTranscript(recs.map((r) => JSON.stringify(r)).join("\n"))
  assert.equal(msgs.length, 3)
  assert.equal(msgs[1]!.providerError?.message, "Authentication required")
  assert.equal(msgs[2]!.wake, true)
})

test("acp-transcript: the writer creates the file under <stateDir>/acp on construction and appends one JSON line per record", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "acp-transcript-"))
  const w = new AcpTranscriptWriter(acpTranscriptPath(stateDir, "sess-1"))
  assert.equal(readFileSync(w.path, "utf8"), "")
  w.append(RECORDS[0]!)
  w.append(RECORDS[1]!)
  const lines = readFileSync(w.path, "utf8").trim().split("\n")
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[1]!).text, "Create hello.txt and cat it.")
})

test("acp-transcript: a tool-result carrying the target the call lacked names the file, not the tool", () => {
  // opencode's `tool_call` frame has neither rawInput nor locations; the completing tool_call_update
  // has both. Before this the drawer read "edited 1 file: write".
  const raw = [
    JSON.stringify({ kind: "user-message", at: T(0), text: "write it", synthetic: false }),
    JSON.stringify({ kind: "turn-start", at: T(0) }),
    JSON.stringify({ kind: "tool-call", at: T(1), id: "call_w", name: "write", input: {}, acp: { kind: "edit", title: "write", locations: [] } }),
    JSON.stringify({ kind: "tool-result", at: T(2), id: "call_w", text: "Wrote file successfully.", acp: { kind: "completed", locations: ["/repo/second.txt"], input: { filePath: "/repo/second.txt", content: "second" } } }),
    JSON.stringify({ kind: "turn-end", at: T(3), finalText: "done", successful: true }),
  ].join("\n") + "\n"
  const msgs = projectAcpTranscript(raw, "x")
  const call = msgs.find((m) => m.role === "assistant" && m.tools.length)!.tools[0]!
  assert.equal(call.name, "write")
  assert.equal(call.status, "completed")
  assert.equal(call.detail, "/repo/second.txt", "the path arrived with the result and replaced the tool's own name")
  // A call that already knew its target keeps it: a bash command is not overwritten by a location.
  const raw2 = [
    JSON.stringify({ kind: "tool-call", at: T(1), id: "call_b", name: "bash", input: { command: "cat x" }, acp: { kind: "execute", title: "bash", locations: [] } }),
    JSON.stringify({ kind: "tool-result", at: T(2), id: "call_b", text: "hi", acp: { kind: "completed", locations: ["/repo"] } }),
  ].join("\n") + "\n"
  assert.equal(projectAcpTranscript(raw2, "x")[0]!.tools[0]!.detail, "cat x")
})

test("acp-transcript: a provider error is its own message, so it stays drawn beside the turn's text", () => {
  const raw = ([
    { kind: "user-message", at: T(1), text: "go", synthetic: false },
    { kind: "turn-start", at: T(1) },
    { kind: "assistant-text", at: T(2), text: "Starting.", final: false, messageId: "m1" },
    { kind: "provider-error", at: T(3), error: { message: "agent connection closed" } },
    { kind: "turn-end", at: T(3), successful: false },
    { kind: "user-message", at: T(5), text: "again", synthetic: false },
  ] as AcpRecord[]).map((r) => JSON.stringify(r)).join("\n")
  const msgs = projectAcpTranscript(raw)
  assert.equal(msgs.length, 4)
  assert.equal(msgs[1]!.text, "Starting.")
  assert.equal(msgs[1]!.providerError, undefined)
  assert.equal(msgs[2]!.kind, "event", "the Codex projector's shape, which the web draws whatever the board says")
  assert.equal(msgs[2]!.text, "agent connection closed")
  assert.equal(msgs[2]!.providerError?.message, "agent connection closed")
})

test("acp-transcript: a later input replaces a path detail with the command, and an unknown call is ignored", () => {
  const raw = ([
    { kind: "tool-call", at: T(1), id: "c1", name: "shell", input: { cwd: "/tmp/p" }, acp: { kind: "execute", title: "shell", locations: ["/tmp/p"] } },
    { kind: "acp-tool-input", at: T(2), id: "gone", input: { command: "nope" } },
    { kind: "acp-tool-input", at: T(2), id: "c1", input: { command: "sleep 1", cwd: "/tmp/p" }, acp: { title: "sleep 1", locations: ["/tmp/p"] } },
    { kind: "tool-call", at: T(3), id: "c2", name: "subagent", input: {}, acp: { kind: "think", title: "subagent", locations: [] } },
    { kind: "acp-tool-input", at: T(4), id: "c2", input: { agent: "general", prompt: "read it" } },
  ] as AcpRecord[]).map((r) => JSON.stringify(r)).join("\n")
  const [msg] = projectAcpTranscript(raw)
  const [shell, sub] = msg!.tools
  assert.equal(shell!.detail, "sleep 1")
  assert.equal(shell!.command, "sleep 1")
  assert.equal(shell!.input, undefined)
  assert.equal(sub!.command, undefined)
  assert.match(sub!.input!, /read it/)
  assert.deepEqual(parseAcpLine(JSON.stringify({ kind: "acp-tool-input", at: T(2), id: "c1", input: {} })), [], "the fold never sees it")
})
