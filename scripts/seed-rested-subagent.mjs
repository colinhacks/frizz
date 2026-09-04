// Seed an adhoc stack with the REAL shape of the "rested sub-agent" bug: a worker thread holding one
// live child and one child that RESTED (its <task-notification> arrived with status `completed`) while
// the five sub-agents IT dispatched are all still appending to their transcripts.
//
// Modelled on the transcript that produced the report — nub session 5258ebe4, 2026-07-29, the "Sweep
// corpus for system-library grants" child — so the board sees exactly the records the harness really
// writes: an Agent dispatch, its async launch ack, the flat `subagents/agent-<id>.meta.json` sidecars
// claude drops beside every descendant transcript, and the queue-operation notification that retires
// the run.
//
// Usage (from ui/, against a running scripts/adhoc-stack.mjs — pass ITS home):
//   nub scripts/seed-rested-subagent.mjs --port=4931 --home=<stack home> [--tag=-b] [--project=/abs]
// Prints the thread slug + the board's own view of the branch, so the caller can assert before it shoots.
// `--tag` suffixes the slug/session so several fixtures can coexist in one stack.
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync, utimesSync } from "node:fs"
import { join } from "node:path"

import { createRpcClient } from "./lib/rpc-client.mjs"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const args = process.argv.slice(2)
const opt = (k, d) => { const hit = args.find((a) => a.startsWith(`--${k}=`)); return hit ? hit.slice(k.length + 3) : d }
const port = Number(opt("port", "4931"))
const home = opt("home")
if (!home) { console.error("--home is required (from the stack's json line)"); process.exit(1) }

const tag = opt("tag", "")
const SLUG = `sweep-the-grants-corpus${tag}`
const SESSION = `5258ebe4-c050-4afd-b080-a73effe565${tag ? tag.length : 5}c`
// The same default the stack itself uses for --project (run from ui/), so the two agree on the cwd slug
// that names the transcript directory.
const PROJECT = opt("project", process.cwd())
const cwdSlug = PROJECT.replace(/\//g, "-")
const logDir = join(home, ".claude", "projects", cwdSlug)
const sessionDir = join(logDir, SESSION)
const subagents = join(sessionDir, "subagents")
mkdirSync(subagents, { recursive: true })

const at = (offsetSec) => new Date(Date.now() + offsetSec * 1000).toISOString()
const rows = []
const assistant = (content, ts) => rows.push({ type: "assistant", timestamp: ts, message: { id: `m${rows.length}`, role: "assistant", stop_reason: "end_turn", content } })
const user = (content, ts) => rows.push({ type: "user", timestamp: ts, message: { role: "user", content } })

// ── the thread's own turn ────────────────────────────────────────────────────────────────────────
user([{ type: "text", text: "Sweep the dependency corpus for packages that need system-library grants to build." }], at(-900))
assistant([{ type: "text", text: "Fanning this out: one lane for the pkg-config sweep, one for the shard rollup." }], at(-880))

// A child that is still working — the control row, so the shot shows a live row beside a rested one.
// `prompt` is load-bearing in the fixture, not decoration: transcript.ts only renders an Agent call as
// an AgentBlock (the card that carries the correlation id and joins the live board row) when the
// dispatch carries one. Without it the card degrades to a generic tool row with no agentId, and the
// header's live state can never resolve — which is exactly what a first pass at this fixture proved.
assistant([{ type: "tool_use", id: "toolu_live", name: "Agent", input: { description: "Audit parser panic/DoS surface", subagent_type: "frizz:opus-high", run_in_background: true, prompt: "Audit the parser for panic and DoS surface. Report every unchecked index and unbounded allocation." } }], at(-870))
user([{ type: "tool_result", tool_use_id: "toolu_live", content: [{ type: "text", text: `Async agent launched successfully.\nagentId: aLive\noutput_file: ${join(subagents, "agent-aLive.jsonl")}` }] }], at(-869))

// The child at the centre of the bug: dispatched, launched, fanned out, then STOPPED.
assistant([{ type: "tool_use", id: "toolu_sweep", name: "Agent", input: { description: "Sweep corpus for system-library grants", subagent_type: "frizz:sonnet-high", run_in_background: true, prompt: "Determine which npm packages need read access to SYSTEM library paths outside the project to build, and what exact paths." } }], at(-800))
user([{ type: "tool_result", tool_use_id: "toolu_sweep", content: [{ type: "text", text: `Async agent launched successfully.\nagentId: aSweep\noutput_file: ${join(subagents, "agent-aSweep.jsonl")}` }] }], at(-799))

// Its terminal notification — verbatim shape, including the note that says outright that `completed`
// only means the agent STOPPED and may notify again.
rows.push({
  type: "queue-operation",
  operation: "enqueue",
  timestamp: at(-120),
  sessionId: SESSION,
  content: [
    "<task-notification>",
    "<task-id>aSweep</task-id>",
    "<tool-use-id>toolu_sweep</tool-use-id>",
    "<status>completed</status>",
    '<summary>Agent "Sweep corpus for system-library grants" finished</summary>',
    "<note>A task-notification fires each time this agent stops with no live background children of its own. The user can send it another message and resume it, so the same task-id may notify more than once.</note>",
    "<result>I've launched five parallel sweep agents (one per remaining shard) plus a Monitor that polls their output files. I'll continue once that notification lands.</result>",
    "<usage><subagent_tokens>143991</subagent_tokens><tool_uses>28</tool_uses><duration_ms>359842</duration_ms></usage>",
    "</task-notification>",
  ].join("\n"),
})
assistant([{ type: "text", text: "The pkg-config lane is fanned out across the remaining shards. I'll fold the results in when they land." }], at(-110))

writeFileSync(join(logDir, `${SESSION}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`)

// ── the flat descendant sidecars claude writes for every child, at every depth ────────────────────
const sidecar = (agentId, body, ageSec) => {
  const path = join(subagents, `agent-${agentId}.meta.json`)
  writeFileSync(path, JSON.stringify(body))
  // The sidecar's mtime IS the spawn instant the row's duration reads from.
  const t = (Date.now() - ageSec * 1000) / 1000
  utimesSync(path, t, t)
}
const transcript = (agentId, text, ageSec = 0) => {
  const path = join(subagents, `agent-${agentId}.jsonl`)
  writeFileSync(path, `${JSON.stringify({ type: "assistant", timestamp: at(0), message: { id: "x", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } })}\n`)
  if (ageSec) { const t = (Date.now() - ageSec * 1000) / 1000; utimesSync(path, t, t) }
}

sidecar("aLive", { agentType: "frizz:opus-high", description: "Audit parser panic/DoS surface", toolUseId: "toolu_live", spawnDepth: 1 }, 870)
transcript("aLive", "still reading the parser")

sidecar("aSweep", { agentType: "frizz:sonnet-high", description: "Sweep corpus for system-library grants", toolUseId: "toolu_sweep", spawnDepth: 1 }, 800)
// The rested child's own transcript stopped when it stopped — 2 minutes ago.
transcript("aSweep", "I've launched five parallel sweep agents plus a Monitor.", 120)

// Its five shard children, all still appending RIGHT NOW.
for (const n of [1, 2, 3, 4, 6]) {
  sidecar(`aShard${n}`, { agentType: "frizz:sonnet-high", description: `System-lib sweep shard ${n}`, toolUseId: `toolu_shard${n}`, parentAgentId: "aSweep", spawnDepth: 2 }, 600 - n * 15)
  transcript(`aShard${n}`, `grepping binding.gyp for pkg-config in shard ${n}`)
}

// ── the registry row + a live dummy pane, so the tailer treats it as a real thread ────────────────
const sandbox = resolveSandboxDb(home)
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const db = sandbox.db
execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, state, backend, model, effort, permission_mode, title_auto, unread, exited, archived) VALUES (${sessionVals}'${SLUG}', '${SESSION}', 'frizz-${SLUG}', '${at(-900)}', 'Sweep the grants corpus', 'open', 'claude', 'opus', 'high', 'bypassPermissions', 0, 0, 0, 0)`])

// ── let the tailer fold it, then report what the BOARD says ───────────────────────────────────────
const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()
let branch = []
for (let i = 0; i < 40; i++) {
  const board = await api.query("board")
  const thread = (board.threads ?? []).find((t) => t.id === SLUG || t.slug === SLUG)
  branch = thread?.subAgents ?? []
  if (branch.length >= 7) break
  await new Promise((r) => setTimeout(r, 500))
}
console.log(JSON.stringify({ slug: SLUG, url: `http://127.0.0.1:${port}/thread/${SLUG}/full`, branch: branch.map((a) => [a.label, a.state, a.depth ?? 1]) }, null, 1))
