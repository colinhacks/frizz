#!/usr/bin/env node
// A SCRIPTED CLAUDE — a stand-in `claude` binary that a real Frizz drives through the real broker
// daemon, and that writes the real transcript JSONL a live Claude Code would. Everything between the
// browser and the model is the product's own code: dispatch, the broker socket, the delivery ledger,
// the runtime-event ingest, the tailer, the board deltas and the transcript pushes. Only the model is
// replaced, by a turn script with fixed timings, so a layout recording can be repeated exactly.
//
// WHY IT EXISTS. Layout work needs a worker whose turns end the way real ones do — a reply, then its
// `end_turn` record, then the `result` a few milliseconds later, in that race — and the only honest way
// to get that was a live model. A live Claude under a sandbox HOME raises a macOS "Keychain Not Found"
// dialog the moment its OAuth token is due (AGENTS.md § Never put a macOS keychain dialog on the
// maintainer's screen; two of them on 2026-10-13, from layout recordings). This binary holds no
// credential, never touches the keychain, and runs on any sandbox stack.
//
// USE — boot a stack with it as the Claude binary, then dispatch with a script token in the prompt:
//
//   nub scripts/adhoc-stack.mjs --port=4980 --claude-bin=/abs/path/to/scripts/scripted-claude.mjs
//   api.mutate("dispatch", { prompt: "[script ending=steps paras=3] anything", backend: "claude" })
//
// The FIRST message's `[script …]` token sets the session's behaviour; every later message (a Done,
// an answer, a steer) is replied to with the `reply…` settings. Keys, all optional:
//
//   ending=done|steps|needs|bare|question   how the first turn ends (default done). `question` ends it
//                                           on a ```question fence (a choice of two, one recommended),
//                                           the way a worker asks: Frizz registers it from the message
//   paras=N        paragraphs of prose in the first turn's final message (default 3)
//   tools=N        Bash tool calls before that message, each `toolms` long (default 0, 1500ms)
//   narrate=1      a paragraph of prose before each of those calls — a long transcript, quickly, for
//                  paging history (`tools=200 toolms=1 narrate=1 disklag=0` writes 400+ messages)
//   thinking=1     a thinking block before the final message (a "Thought for Ns" row)
//   think=MS       how long the model "thinks" before its first record (default 1500)
//   reply=done|steps|needs|bare   how every later turn ends (default done)
//   replyparas=N   replytools=N   replythink=MS    the same knobs for later turns (defaults 2, 0, 1500)
//   replythinking=1  a thinking block OPENING every later turn, before its tool calls — the shape a real
//                  extended-thinking turn writes (thinking, then tool_use, under one message id) — held
//                  for `thinkms` (default 2000) before the first call
//   gapms=MS       the model's pause between a tool result and its next call (default 0) — the inter-call
//                  gap where the slot reads `Ran N tool calls. Thinking…`
//   reply=question ends every later turn on a question fence too, each under a new id (the one before
//                  it may still be open, and an id names one open question), the way `ending=question`
//                  ends the first
//   agents=N       BACKGROUND SUB-AGENTS the first turn dispatches before its Bash calls (default 0): an
//                  `Agent` tool_use with run_in_background, its "Async agent launched successfully" ack, its
//                  own sidechain transcript (`<session>/subagents/agent-<id>.jsonl` + `.meta.json`) that it
//                  writes `agentsteps` tool calls into over `agentms` (defaults 2, 4000; `agenttext=0` drops
//                  the line of prose it writes before each), the SDK's
//                  task_started / task_progress / task_notification / background_tasks_changed frames, and at
//                  the end the `<task-notification>` Claude Code 2.1.296 writes — handed over at the next tool
//                  boundary of a running turn, or starting a turn of its own when the worker rests
//   shells=N       BACKGROUND SHELLS the same way: a `Bash` with run_in_background, its "Command running in
//                  background with ID" ack, an output file it appends a line to every 500ms for `shellms`
//                  (default 4000), and its completion notification
//   replyagents=N  replyshells=N   the same for every later turn
//   notifyparas=N  notify=done|steps|needs|bare|question   the turn a finished op starts while the worker
//                  rests (defaults 1, the `reply` ending): the shape of a worker woken by its child
//   notifythink=MS how long that turn thinks first (default 1000)
//   disklag=MS     event → JSONL write delay for each assistant record (default 15)
//   resultlag=MS   final event → `result` delay (default 30). With the defaults the final record reaches
//                  disk BEFORE the result, the order measured on real broker sessions (94c6b0ee);
//                  `disklag=40 resultlag=10` is the other order, the result first.
//
// A TURN SCRIPT, for a test that has to say exactly what the worker writes and runs — a ```question
// fence, a broken one, a reference, a ```done fence, `frizzctl done`. The knobs above generate a turn;
// this states it:
//
//   file=/abs/turns.json   (an absolute path with no spaces; the knobs above may ride beside it)
//
//   { "think": 300,                          ms before a scripted turn's first record (default: the knobs')
//     "turns": [
//       { "name": "asks",                    a label, for the log below
//         "on": "text the message contains", or "onRe": "a JavaScript regular expression"; neither = any
//         "times": 1,                        how many messages this entry answers (default 1; 0 = every one)
//         "think": 300,                      this turn's own delay
//         "tools": [                         shell commands, run for real before the final message, in order,
//           "frizzctl done --body 'x'",      each a Bash tool call whose result is the command's own output
//           { "command": "…", "description": "…", "ms": 500, "timeout": 30000 } ],
//         "agents": [{ "description": "…", "ms": 4000, "steps": 2, "result": "…" }],   background sub-agents
//         "shells": [{ "description": "…", "ms": 4000 }],                            and shells, launched first
//         "text": "the final message, verbatim",
//         "textFile": "/abs/rest.md" } ],        or the final message READ when it is written, so a tool
//                                            call earlier in the same turn can compose it (an id a
//                                            command printed, named in the fence that rests on it)
//     "otherwise": { "tools": [], "text": "…" } }      answers a message no entry takes
//
// Every incoming message that starts a turn (the dispatch prompt first, then each follow-up, wake, answer
// or correction) is answered by the FIRST entry of `turns` that still has a use left and whose `on`/`onRe`
// accepts the message's text; with none, by `otherwise`; with no `otherwise`, by a generated turn from the
// `reply…` knobs, as if there were no file. So a list with no `on` at all is a plain sequence, and an entry
// keyed on a wake's lead (`"on": "⚠️ Your ```question fence "`) answers that wake whenever it arrives.
//
// A tool command runs through `/bin/sh -c` in the worker's own cwd and environment — the broker daemon's,
// with `<--plugin-dir>/bin` last on PATH as Claude Code has it — so `frizzctl` is the one beside the
// stack's own server and reaches that server. Its result is written the way Claude Code
// writes a Bash result: stdout then stderr, and for a non-zero exit `Exit code N` on the first line with
// `is_error: true`. `"ms"` holds the call open that long after the command returns.
//
// Each choice is appended to `<file>.log` as one JSON line ({ at, turn, entry, name, message }), so a
// verifier can say which entry answered which message. A session started again with `--resume` reads its
// own transcript back, re-reads the file and replays those choices, so an entry is not spent twice.
//
// A message that arrives while a turn runs is a STEER, handled the way Claude Code 2.1.296 writes it:
// a `queue-operation enqueue` at once; handed over at the next tool boundary (`queued_command`
// attachment + `remove`) or, when no tool call is left, after the turn ends (`dequeue` + a user record),
// which then starts a reply turn.
//
// `<bin> auth status --json` answers signed in, so the dispatch preflight passes on a sandbox HOME.
// The protocol half (initialize, controls) follows packages/server/src/backend/claude-agent-sdk.fixtures/
// fake-claude-cli.mjs, the stand-in the Agent SDK contract tests drive the same broker with.
import { appendFileSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { homedir } from "node:os"
import { randomBytes, randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { createInterface } from "node:readline"

const args = process.argv.slice(2)
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(`${JSON.stringify({ loggedIn: true, authMethod: "scripted", apiProvider: "firstParty" })}\n`)
  process.exit(0)
}
if (args.includes("--version") || args[0] === "-v") {
  process.stdout.write("2.1.296 (Claude Code)\n")
  process.exit(0)
}

function optionValue(flag) {
  const index = args.indexOf(flag)
  if (index >= 0) return args[index + 1]
  return args.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1)
}
const sessionId = optionValue("--session-id") ?? optionValue("--resume") ?? randomUUID()
const cwd = process.cwd()
const transcript = join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`)
mkdirSync(join(transcript, ".."), { recursive: true })

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`)
let parentUuid = null
function write(record) {
  const full = { parentUuid, isSidechain: false, userType: "external", cwd, sessionId, version: "2.1.296", ...record }
  if (record.uuid) parentUuid = record.uuid
  appendFileSync(transcript, `${JSON.stringify(full)}\n`)
}
const now = () => new Date().toISOString()

// ---- the script ----
const defaults = { agents: 0, shells: 0, replyagents: 0, replyshells: 0, agentms: 4000, agentsteps: 2, agenttext: 1, narrate: 0, shellms: 4000, notifyparas: 1, notifythink: 1000, ending: "done", paras: 3, tools: 0, toolms: 1500, thinking: 0, think: 1500, thinkms: 2000, replythinking: 0, gapms: 0, reply: "done", replyparas: 2, replytools: 0, replythink: 1500, disklag: 15, resultlag: 30 }
let config = null
function parseScript(text) {
  const token = /\[script([^\]]*)\]/.exec(text)?.[1] ?? ""
  const out = { ...defaults }
  for (const [, key, value] of token.matchAll(/(\w+)=([\w.-]+)/g)) {
    out[key] = /^\d+$/.test(value) ? Number(value) : value
  }
  // A path is not a knob value (`[\w.-]+` stops at the first slash), so it is read on its own.
  const file = /(?:^|\s)file=(\/[^\s\]]+)/.exec(token)?.[1]
  if (file) out.file = file
  else delete out.file
  return out
}

// ---- the turn script (`file=`) ----
// What the file said, with a use count per entry. Null when the session has no file, or it could not be
// read — in which case every turn is a generated one and the failure is on stderr and in the first reply.
let script = null
let scriptFault = ""
function loadScript(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    const entry = (raw) => ({
      name: typeof raw.name === "string" ? raw.name : undefined,
      on: typeof raw.on === "string" ? raw.on : undefined,
      onRe: typeof raw.onRe === "string" ? new RegExp(raw.onRe) : undefined,
      times: Number.isInteger(raw.times) && raw.times >= 0 ? raw.times : 1,
      think: Number.isFinite(raw.think) ? raw.think : undefined,
      tools: (Array.isArray(raw.tools) ? raw.tools : []).map((t) => (typeof t === "string" ? { command: t } : t)).filter((t) => typeof t?.command === "string"),
      text: typeof raw.text === "string" && raw.text.trim() ? raw.text : "(a scripted turn with no text)",
      textFile: typeof raw.textFile === "string" ? raw.textFile : undefined,
      agents: Array.isArray(raw.agents) ? raw.agents.filter((a) => a && typeof a === "object") : [],
      shells: Array.isArray(raw.shells) ? raw.shells.filter((a) => a && typeof a === "object") : [],
      used: 0,
    })
    script = {
      file,
      think: Number.isFinite(parsed.think) ? parsed.think : undefined,
      turns: (Array.isArray(parsed.turns) ? parsed.turns : []).map(entry),
      otherwise: parsed.otherwise && typeof parsed.otherwise === "object" ? entry(parsed.otherwise) : undefined,
    }
  } catch (error) {
    scriptFault = `scripted-claude: could not read the turn script ${file}: ${error instanceof Error ? error.message : String(error)}`
    process.stderr.write(`${scriptFault}\n`)
  }
}
/** The entry that answers `text`, counted as used — or undefined for a generated turn. */
function takeEntry(text, { log = true } = {}) {
  if (!script) return undefined
  const index = script.turns.findIndex((e) => (e.times === 0 || e.used < e.times) && (e.on === undefined || text.includes(e.on)) && (e.onRe === undefined || e.onRe.test(text)))
  const entry = index >= 0 ? script.turns[index] : script.otherwise
  if (entry) entry.used += 1
  if (log) {
    try {
      appendFileSync(`${script.file}.log`, `${JSON.stringify({ at: now(), sessionId, turn: turnNumber + 1, entry: index >= 0 ? index : entry ? "otherwise" : "generated", name: entry?.name, message: text.slice(0, 160) })}\n`)
    } catch {}
  }
  return entry
}
// Claude Code APPENDS an enabled plugin's `bin/` to its Bash PATH (measured 2026-11-03: the last of 27
// entries), and so does this stand-in, so a `frizzctl` earlier on the inherited PATH wins here exactly as
// it would for a live worker. A stack booted from inside a Frizz worker inherits the machine's installed
// one; adhoc-stack.mjs strips it, which is what makes the worker's `frizzctl` this checkout's.
const pluginDir = optionValue("--plugin-dir")
const toolEnv = pluginDir && process.env.PATH ? { ...process.env, PATH: `${process.env.PATH}:${join(pluginDir, "bin")}` } : process.env
function runShell(tool) {
  return new Promise((resolve) => {
    execFile("/bin/sh", ["-c", tool.command], { cwd, env: toolEnv, timeout: Number.isFinite(tool.timeout) ? tool.timeout : 30_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0
      resolve({ code, stdout: String(stdout), stderr: error && typeof error.code !== "number" ? `${stderr}${error.message}` : String(stderr) })
    })
  })
}

const PARAGRAPH = "Release engineering is the discipline of shipping exactly what you tested: a pipeline checks out one commit, builds it hermetically, records where every artifact came from, and publishes only after every gate it depends on has passed on that same revision."
const prose = (n, lead) => [lead, ...Array.from({ length: n }, (_, i) => `${i + 1}. ${PARAGRAPH}`)].filter(Boolean).join("\n\n")
const FENCES = {
  done: "```done\n- **Explained the release pipeline** in the prose above.\n```",
  steps: "```awaiting\ntitle: Approve the npm sign-in so the release can publish\nsteps:\n  - Open [the npm sign-in page](https://www.npmjs.com/login) and sign in with the maintainer account.\n  - Approve the request with that account's security key or one-time code.\n---\n`npm login --auth-type=web` is waiting on that approval.\n```",
  needs: "```awaiting\nstatus: needs_input\ntitle: Two of three audits ready\nfor: 1h\n---\nTwo audits are written and can be read now; the third is still running.\n```",
  bare: "",
}
// `ending=question` / `reply=question`. Until 2026-10-13 these ran the `ask` command mid-turn; that command
// is retired (it exits 2 and registers nothing), and a worker asks by writing the fence. The id carries
// the turn's number because an id names one open question at a time, and `reply=question` asks at every
// turn, whether or not the last turn's question has been answered.
const questionFence = (turn) => [
  "```question",
  `id: publish-release-${turn}`,
  "kind: choice",
  "question: Publish the release now, or hold it for the changelog?",
  "options:",
  "  - label: Publish now",
  "    description: every gate passed on this commit",
  "    recommended: true",
  "  - label: Hold it",
  "    description: the changelog entry is still a draft",
  "```",
].join("\n")

// ---- turns ----
let turnNumber = 0
let running = false
const queued = [] // steers waiting for the next handover point: { text, uuid }

async function assistantRecord(messageId, block, stopReason, s) {
  const uuid = randomUUID()
  send({ type: "assistant", message: { id: messageId, type: "message", role: "assistant", model: "claude-haiku-5-5", content: [block], stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, parent_tool_use_id: null, uuid, session_id: sessionId })
  await sleep(s.disklag)
  write({ type: "assistant", message: { model: "claude-haiku-5-5", id: messageId, type: "message", role: "assistant", content: [block], stop_reason: stopReason, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, uuid, timestamp: now() })
}

function deliverAtToolBoundary() {
  // Claude Code hands a queued message over WITH the tool result: the attachment, then the removal.
  while (queued.length) {
    const { text, uuid, notification } = queued.shift()
    if (notification) {
      write({ type: "attachment", attachment: { type: "queued_command", prompt: text, commandMode: "task-notification", origin: { kind: "task-notification", producer: "session-task" }, timestamp: now() }, uuid: randomUUID(), timestamp: now() })
      appendFileSync(transcript, `${JSON.stringify({ type: "queue-operation", operation: "remove", timestamp: now(), sessionId, content: text })}\n`)
      continue
    }
    write({ type: "attachment", attachment: { type: "queued_command", prompt: text, source_uuid: uuid, commandMode: "prompt", timestamp: now() }, uuid: randomUUID(), timestamp: now() })
    appendFileSync(transcript, `${JSON.stringify({ type: "queue-operation", operation: "remove", timestamp: now(), sessionId, content: text })}\n`)
    send({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid, session_id: sessionId })
  }
}


// ---- background ops: sub-agents and shells ----
// Every op the session launched and has not yet reported finished, for `background_tasks_changed`
// (REPLACE semantics: the whole live set every time it changes).
const liveOps = new Map() // taskId → { taskType, description }
const sendLevel = () => send({ type: "system", subtype: "background_tasks_changed", tasks: [...liveOps].map(([task_id, o]) => ({ task_id, task_type: o.taskType, description: o.description })), uuid: randomUUID(), session_id: sessionId })
const sessionDir = join(dirname(transcript), sessionId)
const tasksDir = join(homedir(), ".scripted-claude-tasks", sessionId, "tasks")

/** One background sub-agent: dispatch, ack, its own transcript over `ms`, then its notification. */
async function launchAgent(turn, index, spec, s) {
  const toolUseId = `toolu_scripted_${turn}_a${index}`
  const agentId = `a${randomBytes(8).toString("hex")}`
  const description = typeof spec.description === "string" ? spec.description : `Auditing part ${index + 1} of the pipeline`
  const ms = Number.isFinite(spec.ms) ? spec.ms : s.agentms
  const steps = Number.isFinite(spec.steps) ? spec.steps : s.agentsteps
  const result = typeof spec.result === "string" ? spec.result : `Part ${index + 1} checks out: every gate ran on the commit that was published.`
  const prompt = `Audit part ${index + 1} of the release pipeline and report what you find.`
  await assistantRecord(`msg_scripted_${turn}_a${index}`, { type: "tool_use", id: toolUseId, name: "Agent", input: { description, subagent_type: "frizz:low", run_in_background: true, prompt } }, "tool_use", s)
  // The child's own transcript, as Claude Code writes it: a meta file, then the prompt as its first record.
  mkdirSync(join(sessionDir, "subagents"), { recursive: true })
  const sidechain = join(sessionDir, "subagents", `agent-${agentId}.jsonl`)
  writeFileSync(join(sessionDir, "subagents", `agent-${agentId}.meta.json`), JSON.stringify({ agentType: "frizz:low", description, toolUseId, spawnDepth: 1, requestShape: "background", requestNonInteractive: true }))
  let childParent = null
  const child = (record) => {
    const uuid = randomUUID()
    appendFileSync(sidechain, `${JSON.stringify({ parentUuid: childParent, isSidechain: true, agentId, userType: "external", cwd, sessionId, version: "2.1.296", ...record, uuid, timestamp: now() })}\n`)
    childParent = uuid
  }
  child({ type: "user", message: { role: "user", content: prompt } })
  // Claude Code's output file for an agent IS its transcript: a symlink to the sidechain JSONL.
  mkdirSync(tasksDir, { recursive: true })
  const outputFile = join(tasksDir, `${agentId}.output`)
  try { symlinkSync(sidechain, outputFile) } catch {}
  liveOps.set(agentId, { taskType: "local_agent", description })
  send({ type: "system", subtype: "task_started", task_id: agentId, tool_use_id: toolUseId, description, subagent_type: "frizz:low", is_backgrounded: true, spawn_depth: 1, task_type: "local_agent", uuid: randomUUID(), session_id: sessionId })
  sendLevel()
  const ack = `Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: ${agentId} (internal ID - do not mention to user. Use SendMessage with to: '${agentId}', summary: '<5-10 word recap>' to continue this agent.)\nThe agent is working in the background. You will be notified automatically when it completes.\noutput_file: ${outputFile}`
  toolResult(toolUseId, ack, { isAsync: true, status: "async_launched", agentId, description, prompt })
  const started = Date.now()
  void (async () => {
    for (let k = 0; k < steps; k++) {
      await sleep(ms / (steps + 1))
      const id = `toolu_child_${agentId}_${k}`
      // A line of prose before each call, as a real child narrates its work — and what makes its
      // drawer tall enough to scroll.
      if (s.agenttext) child({ type: "assistant", message: { model: "claude-haiku-5-5", id: `msg_child_${agentId}_${k}_t`, type: "message", role: "assistant", content: [{ type: "text", text: `Gate ${k + 1}: ${PARAGRAPH}` }], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
      child({ type: "assistant", message: { model: "claude-haiku-5-5", id: `msg_child_${agentId}_${k}`, type: "message", role: "assistant", content: [{ type: "tool_use", id, name: "Bash", input: { command: `sleep 1`, description: `Checking gate ${k + 1}` } }], stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
      child({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "", is_error: false }] }, toolUseResult: { stdout: "", stderr: "", interrupted: false } })
      send({ type: "system", subtype: "task_progress", task_id: agentId, tool_use_id: toolUseId, description: `Running Checking gate ${k + 1}`, subagent_type: "frizz:low", usage: { total_tokens: 100 * (k + 1), tool_uses: k + 1, duration_ms: Date.now() - started }, last_tool_name: "Bash", uuid: randomUUID(), session_id: sessionId })
    }
    await sleep(ms / (steps + 1))
    child({ type: "assistant", message: { model: "claude-haiku-5-5", id: `msg_child_${agentId}_end`, type: "message", role: "assistant", content: [{ type: "text", text: result }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
    finishOp(agentId, toolUseId, outputFile, `Agent "${description}" finished`, `<note>A task-notification fires each time this agent stops with no live background children of its own.</note>\n<result>${result}</result>\n`, { total_tokens: 100 * (steps + 1), tool_uses: steps, duration_ms: Date.now() - started })
  })()
}

/** One background shell: the Bash call, its ack, an output file that grows for `ms`, its notification. */
async function launchShell(turn, index, spec, s) {
  const toolUseId = `toolu_scripted_${turn}_s${index}`
  const taskId = `b${randomBytes(6).toString("base64url").replace(/[^a-z0-9]/gi, "x").toLowerCase().slice(0, 8)}`
  const description = typeof spec.description === "string" ? spec.description : `Watching build ${index + 1}`
  const ms = Number.isFinite(spec.ms) ? spec.ms : s.shellms
  const command = `for i in $(seq ${Math.max(1, Math.round(ms / 500))}); do echo "build step $i"; sleep 0.5; done`
  await assistantRecord(`msg_scripted_${turn}_s${index}`, { type: "tool_use", id: toolUseId, name: "Bash", input: { command, description, run_in_background: true } }, "tool_use", s)
  mkdirSync(tasksDir, { recursive: true })
  const outputFile = join(tasksDir, `${taskId}.output`)
  writeFileSync(outputFile, "")
  liveOps.set(taskId, { taskType: "local_bash", description })
  send({ type: "system", subtype: "task_started", task_id: taskId, tool_use_id: toolUseId, description, is_backgrounded: true, task_type: "local_bash", uuid: randomUUID(), session_id: sessionId })
  sendLevel()
  toolResult(toolUseId, `Command running in background with ID: ${taskId}. Output is being written to: ${outputFile}. You will be notified when it completes. To check interim output, use Read on that file path.`, { stdout: "", stderr: "", interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: taskId })
  void (async () => {
    const lines = Math.max(1, Math.round(ms / 500))
    for (let k = 1; k <= lines; k++) {
      await sleep(ms / lines)
      appendFileSync(outputFile, `build step ${k}\n`)
    }
    finishOp(taskId, toolUseId, outputFile, `Background command "${description}" completed (exit code 0)`, "", undefined)
  })()
}

function toolResult(toolUseId, content, toolUseResult) {
  const uuid = randomUUID()
  write({ type: "user", message: { role: "user", content: [{ tool_use_id: toolUseId, type: "tool_result", content, is_error: false }] }, uuid, timestamp: now(), toolUseResult })
  send({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] }, parent_tool_use_id: null, uuid, session_id: sessionId, isSynthetic: true })
}

/** An op ended: the SDK's frames, then the `<task-notification>` — handed over in a running turn, or a turn of its own. */
function finishOp(taskId, toolUseId, outputFile, summary, tail, usage) {
  liveOps.delete(taskId)
  send({ type: "system", subtype: "task_notification", task_id: taskId, tool_use_id: toolUseId, status: "completed", output_file: outputFile, summary, ...(usage ? { usage } : {}), uuid: randomUUID(), session_id: sessionId })
  sendLevel()
  const text = `<task-notification>\n<task-id>${taskId}</task-id>\n<tool-use-id>${toolUseId}</tool-use-id>\n<output-file>${outputFile}</output-file>\n<status>completed</status>\n<summary>${summary}</summary>\n${tail}</task-notification>`
  appendFileSync(transcript, `${JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: now(), sessionId, content: text })}\n`)
  if (running) {
    queued.push({ text, uuid: randomUUID(), notification: true })
    return
  }
  appendFileSync(transcript, `${JSON.stringify({ type: "queue-operation", operation: "dequeue", timestamp: now(), sessionId })}\n`)
  startNotificationTurn(text)
}

function startNotificationTurn(text) {
  write({ type: "user", message: { role: "user", content: text }, uuid: randomUUID(), timestamp: now(), origin: { kind: "task-notification", producer: "session-task" }, promptSource: "system", turnOrigin: "task_notification" })
  void runTurn("notify")
}

async function runTurn(kind) {
  running = true
  turnNumber += 1
  const s = config
  const first = kind === "first"
  const notify = kind === "notify"
  const ending = first ? s.ending : notify ? (s.notify ?? s.reply) : s.reply
  const tools = first ? s.tools : notify ? 0 : s.replytools
  const paras = first ? s.paras : notify ? s.notifyparas : s.replyparas
  await sleep(first ? s.think : notify ? s.notifythink : s.replythink)
  const agents = first ? s.agents : notify ? 0 : s.replyagents
  const shells = first ? s.shells : notify ? 0 : s.replyshells
  for (let i = 0; i < agents; i++) await launchAgent(turnNumber, i, {}, s)
  for (let i = 0; i < shells; i++) await launchShell(turnNumber, i, {}, s)
  if (!first && !notify && s.replythinking) {
    await assistantRecord(tools ? `msg_scripted_${turnNumber}_t0` : `msg_scripted_${turnNumber}`, { type: "thinking", thinking: "", signature: "scripted" }, null, s)
    await sleep(s.thinkms)
  }
  for (let i = 0; i < tools; i++) {
    if (i > 0 && s.gapms) await sleep(s.gapms)
    const id = `toolu_scripted_${turnNumber}_${i}`
    if (s.narrate) await assistantRecord(`msg_scripted_${turnNumber}_n${i}`, { type: "text", text: `Step ${i + 1}. ${PARAGRAPH}` }, null, s)
    await assistantRecord(`msg_scripted_${turnNumber}_t${i}`, { type: "tool_use", id, name: "Bash", input: { command: `sleep ${Math.round(s.toolms / 1000)}`, description: `Running step ${i + 1} of ${tools}` } }, "tool_use", s)
    await sleep(s.toolms)
    const resultUuid = randomUUID()
    write({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "", is_error: false }] }, uuid: resultUuid, timestamp: now(), toolUseResult: { stdout: "", stderr: "", interrupted: false } })
    send({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "" }] }, parent_tool_use_id: null, uuid: resultUuid, session_id: sessionId, isSynthetic: true })
    deliverAtToolBoundary()
  }
  const messageId = `msg_scripted_${turnNumber}`
  if (first && s.thinking) await assistantRecord(messageId, { type: "thinking", thinking: "", signature: "scripted" }, null, s)
  const fence = ending === "question" ? questionFence(turnNumber) : FENCES[ending] ?? ""
  const lead = ending === "question" ? "One decision is needed before this can go further; it is asked below." : undefined
  await finishTurn(messageId, [prose(paras, lead), fence].filter(Boolean).join("\n\n"), s)
}

/** The turn's final message, its `result`, and whatever waited the turn out. */
async function finishTurn(messageId, text, s) {
  // The final record and the `result` each trail the final event by their OWN lag, so either can win:
  // `resultlag < disklag` is the result reaching Frizz before the record reaches the disk.
  const landed = assistantRecord(messageId, { type: "text", text }, "end_turn", s)
  await sleep(s.resultlag)
  send({ type: "result", subtype: "success", duration_ms: 1, duration_api_ms: 1, is_error: false, num_turns: 1, result: "", stop_reason: "end_turn", total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], uuid: randomUUID(), session_id: sessionId })
  await landed
  running = false
  // A message that waited out the turn is handed over now and starts the next one.
  if (queued.length) {
    const { text, uuid, notification } = queued.shift()
    appendFileSync(transcript, `${JSON.stringify({ type: "queue-operation", operation: "dequeue", timestamp: now(), sessionId })}\n`)
    if (notification) startNotificationTurn(text)
    else acceptInput(text, uuid)
  }
}

/** One entry of the turn script: its commands as real Bash tool calls, then its text. */
async function runScriptedTurn(entry, kind) {
  running = true
  turnNumber += 1
  const s = config
  await sleep(entry.think ?? script?.think ?? (kind === "first" ? s.think : s.replythink))
  for (const [i, spec] of entry.agents.entries()) await launchAgent(turnNumber, i, spec, s)
  for (const [i, spec] of entry.shells.entries()) await launchShell(turnNumber, i, spec, s)
  for (let i = 0; i < entry.tools.length; i++) {
    const tool = entry.tools[i]
    const id = `toolu_scripted_${turnNumber}_${i}`
    await assistantRecord(`msg_scripted_${turnNumber}_t${i}`, { type: "tool_use", id, name: "Bash", input: { command: tool.command, description: tool.description ?? `Running step ${i + 1} of ${entry.tools.length}` } }, "tool_use", s)
    const ran = await runShell(tool)
    if (tool.ms) await sleep(tool.ms)
    const output = [ran.stdout, ran.stderr].filter(Boolean).join(ran.stdout.endsWith("\n") || !ran.stdout ? "" : "\n").trimEnd()
    const failed = ran.code !== 0
    const content = failed ? `Exit code ${ran.code}${output ? `\n${output}` : ""}` : output
    const resultUuid = randomUUID()
    write({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: failed }] }, uuid: resultUuid, timestamp: now(), toolUseResult: failed ? `Error: ${content}` : { stdout: ran.stdout, stderr: ran.stderr, interrupted: false } })
    send({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, ...(failed ? { is_error: true } : {}) }] }, parent_tool_use_id: null, uuid: resultUuid, session_id: sessionId, isSynthetic: true })
    deliverAtToolBoundary()
  }
  const text = entry.textFile ? turnText(entry.textFile) : entry.text
  await finishTurn(`msg_scripted_${turnNumber}`, turnNumber === 1 && scriptFault ? `${scriptFault}\n\n${text}` : text, s)
}

/** A `textFile` turn's message, read now. A file that is missing or empty says so, as the message. */
function turnText(file) {
  try {
    return readFileSync(file, "utf8").trim() || `(scripted-claude: ${file} is empty)`
  } catch (error) {
    return `(scripted-claude: could not read ${file}: ${error instanceof Error ? error.message : String(error)})`
  }
}

/** Start the turn that answers `text`: the script's entry for it, or a generated one. */
function startTurn(kind, text) {
  const entry = takeEntry(text)
  void (entry ? runScriptedTurn(entry, kind) : runTurn(kind))
}

function acceptInput(text, uuid) {
  write({ type: "user", message: { role: "user", content: text }, uuid: randomUUID(), timestamp: now(), promptSource: "sdk" })
  send({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid, session_id: sessionId })
  startTurn("reply", text)
}

function handleUserMessage(message) {
  const content = message.message?.content
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((b) => b?.type === "text").map((b) => b.text).join("\n") : ""
  const uuid = message.uuid ?? randomUUID()
  if (config === null) {
    config = parseScript(text)
    if (config.file) loadScript(config.file)
    write({ type: "user", message: { role: "user", content: text }, uuid: randomUUID(), timestamp: now(), promptSource: "sdk" })
    send({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null, uuid, session_id: sessionId })
    startTurn("first", text)
    return
  }
  if (running) {
    appendFileSync(transcript, `${JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: now(), sessionId, content: text })}\n`)
    queued.push({ text, uuid })
    return
  }
  acceptInput(text, uuid)
}

// ---- the protocol half (see fake-claude-cli.mjs) ----
function respond(requestId, response, extra = {}) {
  send({ type: "control_response", response: { subtype: "success", request_id: requestId, response, ...extra } })
}
let systemInitSent = false
function handleHostControl(message) {
  const request = message.request ?? {}
  switch (request.subtype) {
    case "initialize":
      respond(message.request_id, {
        commands: [], agents: [], output_style: "default", available_output_styles: ["default"], account: {},
        models: [{ value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku (scripted)", description: "Scripted stand-in", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"], supportsAdaptiveThinking: true, supportsFastMode: false }],
      })
      if (!systemInitSent) {
        systemInitSent = true
        send({ type: "system", subtype: "init", apiKeySource: "none", claude_code_version: "2.1.296", cwd, tools: ["Bash"], mcp_servers: [], model: "claude-haiku-5-5", permissionMode: optionValue("--permission-mode") ?? "default", slash_commands: [], output_style: "default", skills: [], plugins: [], capabilities: ["interrupt_receipt_v1"], uuid: randomUUID(), session_id: sessionId })
      }
      return
    case "interrupt":
      return respond(message.request_id, { still_queued: [] })
    case "cancel_async_message": {
      const i = queued.findIndex((q) => q.uuid === request.message_uuid)
      if (i >= 0) queued.splice(i, 1)
      return respond(message.request_id, { cancelled: i >= 0 })
    }
    case "get_context_usage":
      return respond(message.request_id, { skills: { totalSkills: 0, includedSkills: 0, tokens: 0, skillFrontmatter: [] }, isAutoCompactEnabled: false })
    case "generate_session_title":
      return respond(message.request_id, { title: String(request.description ?? "Scripted session").replace(/\[script[^\]]*\]\s*/, "").slice(0, 48) || "Scripted session" })
    case "reload_plugins":
      return respond(message.request_id, { commands: [], agents: [], plugins: [], mcpServers: [], error_count: 0 })
    default:
      return respond(message.request_id, {})
  }
}

// A RESUMED SESSION PICKS ITS SCRIPT UP WHERE IT LEFT IT. `--resume` starts a new process on an old
// transcript; without this the next message would be read as the first, find no `[script …]` token and
// be answered by a default turn. Every user record with a string body started a turn, so replaying them
// against the file spends the same entries the first process spent. Only a session scripted from a file
// is recovered: one driven by knobs alone behaves on resume as it always has.
if (optionValue("--resume") && existsSync(transcript)) {
  const started = []
  let last = null
  for (const line of readFileSync(transcript, "utf8").split("\n")) {
    let record
    try { record = JSON.parse(line) } catch { continue }
    if (record.uuid) last = record.uuid
    if (record.type === "user" && typeof record.message?.content === "string") started.push(record.message.content)
  }
  const recovered = started.length ? parseScript(started[0]) : undefined
  if (recovered?.file) {
    config = recovered
    loadScript(recovered.file)
    parentUuid = last
    for (const text of started) {
      takeEntry(text, { log: false })
      turnNumber += 1
    }
  }
}

createInterface({ input: process.stdin, crlfDelay: Infinity }).on("line", (line) => {
  if (!line.trim()) return
  let message
  try { message = JSON.parse(line) } catch { return }
  if (message.type === "control_request") handleHostControl(message)
  else if (message.type === "user") handleUserMessage(message)
}).on("close", () => process.exit(0))
process.on("SIGTERM", () => process.exit(0))
