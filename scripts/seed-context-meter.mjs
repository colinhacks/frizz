// Seed a disposable adhoc stack with SIMULATED workers that carry a real CONTEXT reading, so the
// footer's fullness donut (components/ContextMeter.tsx) can be judged on all three surfaces in the
// REAL app — queue card, side drawer, and the standalone `/thread/<slug>/full` page — through the real
// tailer, the real board projection and the real push. A fixture proves the component in isolation;
// only this proves the SERVER emits ThreadView.context and that every surface reads it.
//
// CODEX rows, deliberately. Both halves of the fraction have to be present for the meter to render at
// all (board.ts), and codex names them TOGETHER on its own `token_count` event — whereas a Claude row's
// denominator arrives only from the broker's event stream, which a simulated worker has no way to feed.
//
// Three threads, so the readout is judged across its range and its absence:
//   context-low   — 8% full   (a hairline of arc: the case a floored 0% would have erased)
//   context-high  — 87% full  (nearly all the way round)
//   context-none  — a claude row with a numerator and NO window ⇒ must render NOTHING, not an empty ring
//
// Follows the frizz-stack recipe: a session row + a transcript the tailer reads.
// Usage: node scripts/seed-context-meter.mjs --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = process.cwd() } = flags
if (!home) {
  console.error("usage: node seed-context-meter.mjs --home=/abs/temp-home")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)

const T0 = Date.now() - 25 * 60_000
const at = (m) => new Date(T0 + m * 60_000).toISOString()

function row({ slug, sessionId, agentSessionId, title, backend, restedAt }) {
  const threadName = `frizz-${slug}`
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, agent_session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
     VALUES (${sessionVals}'${slug}', '${sessionId}', ${agentSessionId ? `'${agentSessionId}'` : "NULL"}, '${threadName}', '${at(0)}', '${title}', '${backend}', '${backend === "codex" ? "gpt-5-codex" : "opus"}', 'high', 'default', '${restedAt}')`,
  ])
  console.log(`seeded ${slug} → ${sessionId}`)
}

// ── codex rows: a date-sharded rollout whose token_count carries BOTH halves ────────────────────────
// The tailer locates a codex rollout by the id pinned on `agent_session_id`, matching the filename
// suffix `-<id>.jsonl` under $CODEX_HOME/sessions (which is <tempHome>/.codex here, since the stack
// moves HOME). The date shard is cosmetic — discovery walks the whole tree.
const shard = join(home, ".codex", "sessions", "2026", "07", "29")
mkdirSync(shard, { recursive: true })

function codex({ slug, rolloutId, title, prompt, closing, tokens, window }) {
  const ev = (ts, payload) => JSON.stringify({ timestamp: ts, type: "event_msg", payload })
  const lines = [
    JSON.stringify({ timestamp: at(0), type: "session_meta", payload: { id: rolloutId, cwd } }),
    JSON.stringify({ timestamp: at(0), type: "turn_context", payload: { model: "gpt-5-codex", effort: "high", sandbox_policy: { type: "workspace-write" } } }),
    ev(at(0), { type: "user_message", message: `TASK:\n${prompt}` }),
    ev(at(0), { type: "task_started" }),
    // The reading itself. `last_token_usage.total_tokens` is the numerator; `model_context_window` is
    // the denominator codex names for us.
    ev(at(1), { type: "token_count", info: { last_token_usage: { total_tokens: tokens }, model_context_window: window } }),
    ev(at(2), { type: "agent_message", message: closing, phase: "final_answer" }),
    ev(at(2), { type: "task_complete", last_agent_message: closing }),
  ]
  writeFileSync(join(shard, `rollout-2026-07-29T10-00-00-${rolloutId}.jsonl`), lines.join("\n") + "\n")
  row({ slug, sessionId: rolloutId, agentSessionId: rolloutId, title, backend: "codex", restedAt: at(2) })
}

codex({
  slug: "context-low",
  rolloutId: "019842aa-0000-4000-9000-0000000000c1",
  title: "Tidy the changelog",
  prompt: "Tidy the changelog and land it.",
  closing: "Changelog tidied and committed. Nothing else outstanding.",
  tokens: 22_400,
  window: 272_000,
})

codex({
  slug: "context-high",
  rolloutId: "019842aa-0000-4000-9000-0000000000c2",
  title: "Migrate the settings store to SQLite",
  prompt: "Migrate the settings store off the JSON file and onto SQLite.",
  closing: "Migration landed with the backfill and its tests. Context is nearly full — worth a fresh session next.",
  tokens: 237_000,
  window: 272_000,
})

// ── the ABSENT case: a claude row with a numerator and no denominator ───────────────────────────────
// Its assistant record's `usage` gives contextTokens, and nothing anywhere gives contextWindow (that
// half only ever comes from the broker stream). The footer must therefore show NO meter — no 0% dial,
// no empty ring, no placeholder — and stay exactly the height it was before the donut existed.
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })
const noneSession = "8e577e57-0000-4000-9000-0000000000c3"
const claudeRecords = [
  {
    parentUuid: null, isSidechain: false, type: "user", uuid: "00000000-0000-4000-9000-000000000001",
    timestamp: at(0), session_id: noneSession, cwd, message: { role: "user", content: "TASK:\nRename the audit helper." },
  },
  {
    parentUuid: null, isSidechain: false, type: "assistant", uuid: "00000000-0000-4000-9000-000000000002",
    timestamp: at(2), session_id: noneSession, cwd,
    message: {
      model: "claude-opus-5", id: "msg_none", type: "message", role: "assistant", stop_reason: "end_turn",
      content: [{ type: "text", text: "Renamed and committed. No window reading on this row." }],
      usage: { input_tokens: 1_200, cache_read_input_tokens: 40_000, output_tokens: 80 },
    },
  },
]
writeFileSync(join(jsonlDir, `${noneSession}.jsonl`), claudeRecords.map((r) => JSON.stringify(r)).join("\n") + "\n")
row({ slug: "context-none", sessionId: noneSession, title: "Rename the audit helper", backend: "claude", restedAt: at(2) })
