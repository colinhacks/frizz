// Seeds an adhoc stack with the EXACT shape that wedged a live thread on 2026-08-02: a long transcript
// whose last record is a dangling AskUserQuestion tool_use, plus a PENDING `agent-question` interaction
// scoped to that session. Everything downstream of the seed is the real pipeline — the real tailer reads
// the JSONL, the real board derives needsYou/pendingInteraction, the real RPC serves the interaction, and
// the real ChatView decides where the card goes.
//
//   nub scripts/verify-ask-card-placement.mjs <tempHome> <unused> <port> [slug] [--no-ask]
//
// `--no-ask` seeds the SAME long transcript with no pending interaction — the control that proves the
// fixed-key head-anchor row costs nothing when there is no card to show.
//
// Prints the slug + sessionId to drive the browser check against.
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const [home, _socket, port, slugArg] = process.argv.slice(2)
if (!home || !port) throw new Error("usage: <tempHome> <unused> <port> [slug] [--no-ask]")
const withAsk = !process.argv.includes("--no-ask")

const projectDir = "/Users/colinmcd94/Documents/projects/frizz"
const cwdSlug = projectDir.replaceAll("/", "-")
const sessionId = randomUUID()
const slug = slugArg && !slugArg.startsWith("--") ? slugArg : "ask-placement-probe"
const askToolId = "toolu_probe_ask_1"

// ---- 1. the transcript: long enough that the tail is thousands of px below the head ----------------
const t = (n) => new Date(Date.parse("2026-08-02T02:00:00.000Z") + n * 1000).toISOString()
const lines = []
let seq = 0
const push = (rec) => lines.push(JSON.stringify({ sessionId, timestamp: t(seq++), ...rec }))

push({ type: "user", message: { role: "user", content: "Build the syntax highlighter and show me the options." } })
for (let i = 0; i < 40; i++) {
  push({
    type: "assistant",
    message: {
      role: "assistant",
      stop_reason: "tool_use",
      content: [
        { type: "text", text: `Step ${i + 1}: measuring the gutter offset against the textarea's own line box, then correcting the drift.` },
        { type: "tool_use", name: "Bash", id: `toolu_probe_${i}`, input: { command: `echo step-${i}`, description: `Measuring step ${i}` } },
      ],
    },
  })
  push({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_probe_${i}`, content: `step-${i}` }] } })
}
push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Horizontal sync is exact too. Let me present the options." }] } })
// The dangling ask — a tool_use with no tool_result, exactly what a parked canUseTool leaves behind.
if (withAsk) {
  push({
    type: "assistant",
    message: {
      role: "assistant",
      stop_reason: "tool_use",
      content: [{
        type: "tool_use", name: "AskUserQuestion", id: askToolId,
        input: { questions: [{ question: "Which example should load by default when the highlighter opens?", header: "Default", options: [{ label: "Full-stack app schema", description: "A realistic .env.schema" }, { label: "Grammar tour", description: "Every token" }], multiSelect: false }] },
      }],
    },
  })
}

const transcriptDir = join(home, ".claude", "projects", cwdSlug)
mkdirSync(transcriptDir, { recursive: true })
writeFileSync(join(transcriptDir, `${sessionId}.jsonl`), `${lines.join("\n")}\n`)

// ---- 2. a live pane so the row reads as a running session ------------------------------------------

// ---- 3. the session row + the pending interaction --------------------------------------------------
const sandbox = resolveSandboxDb(home)
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const { db, projectId } = sandbox
const sql = (text) => execFileSync("sqlite3", [db, text], { encoding: "utf8" })

sql(`INSERT INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, state)
     VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${t(0)}', 'Ask card placement probe', 'claude', 'opus', 'xhigh', 'auto', 'open')`)

if (!withAsk) {
  console.log(JSON.stringify({ slug, sessionId, projectId, ask: false, url: `http://127.0.0.1:${port}/thread/${slug}/full` }))
  process.exit(0)
}

const interactionId = randomUUID()
const request = {
  protocolVersion: 1,
  contentFormat: "plain-text",
  provider: { kind: "claude", name: "Claude session broker" },
  source: { kind: "agent", id: "claude-ask-user-question", label: "Claude" },
  owner: { projectId, threadSlug: slug, sessionId, turnId: "probe-turn-1", itemId: askToolId, sessionEpoch: 0, capabilityRevision: 0 },
  providerRequestId: "probe-turn-1",
  allowedDecisions: [
    { id: "answer", semantic: "answer", label: "Send answer", description: "Send these answers back to the agent." },
    { id: "decline", semantic: "decline", label: "Decline", description: "Tell the agent nobody answered, so it decides for itself." },
  ],
  payload: {
    kind: "agent-question",
    title: "Default",
    fields: [
      {
        id: "q0", label: "Default", description: "Which example should load by default when the highlighter opens?",
        required: false, secret: false, input: "select",
        options: [
          { value: "Full-stack app schema", label: "Full-stack app schema — A realistic .env.schema" },
          { value: "Grammar tour", label: "Grammar tour — Every token" },
        ],
      },
      { id: "q0_notes", label: "Default", required: false, secret: false, input: "multiline", maxLength: 4000 },
    ],
  },
  expiresAt: null,
}
sql(`INSERT INTO interaction_journal (id, schema_version, project_id, thread_slug, session_id, session_epoch,
       capability_revision, provider, provider_request_id, kind, request_json, lifecycle, created_at, updated_at)
     VALUES ('${interactionId}', 1, '${projectId}', '${slug}', '${sessionId}', 0, 0, 'claude', 'probe-turn-1',
       'agent-question', '${JSON.stringify(request).replaceAll("'", "''")}', 'pending', '${t(0)}', '${t(0)}')`)

console.log(JSON.stringify({ slug, sessionId, projectId, url: `http://127.0.0.1:${port}/thread/${slug}/full` }))
