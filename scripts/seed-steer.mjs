// Seed an adhoc stack (scripts/adhoc-stack.mjs) with a realistic board: N simulated Claude workers
// (real session rows, real JSONL transcripts) so a board-scale
// behavior — steering latency, board-refresh cost, rail rendering — can be exercised against something
// that looks like a working operator's board rather than one empty thread. Pairs with steer-stack.sh,
// which boots the stack and calls this. Kept in-tree because "the board is slow" recurs and reproducing
// it needs a populated board.
//
//   node scripts/seed-steer.mjs <tempHome> <unused> <projectDir> [count=25] [inFlight=0]
import { mkdirSync, writeFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const [home, _socket, projectDirArg, countArg, inFlightArg] = process.argv.slice(2)
// The server resolves its project dir through realpath, so on macOS `/tmp/x` becomes `/private/tmp/x`
// and its Claude log dir is `-private-tmp-x`. Seeding under the un-resolved spelling put every fixture
// transcript somewhere the tailer never looks: each row read as noTranscript, which degrades to the
// "Stalled"/exited affordance AND makes the pane sniff fire on every tick (the bootWedge branch). The
// board then looked like 25 boot-failed threads rather than 25 working ones.
const projectDir = projectDirArg ? realpathSync(projectDirArg) : projectDirArg
const count = Number(countArg ?? 25)
// How many of the seeded threads are left MID-TURN (a tool_use with no result, last activity long
// enough ago to clear PERM_SNIFF_MS). That is the shape that costs: an at-rest thread is sniff-free,
// while every quiet in-flight one is pane-captured on every tailer tick. A real operator board running
// N agents that think/run-tools for tens of seconds looks exactly like this, so latency work has to be
// measured against it — a board of resting threads hides the whole problem.
const inFlight = Number(inFlightArg ?? 0)
if (!home || !projectDir) {
  console.error("usage: node seed-steer.mjs <tempHome> <unused> <projectDir> [count] [inFlight]")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const db = sandbox.db
const cwdSlug = projectDir.replace(/\//g, "-")
const jsonlDir = join(home, ".claude", "projects", cwdSlug)
mkdirSync(jsonlDir, { recursive: true })

const now = Date.now()
const ts = (secondsAgo) => new Date(now - secondsAgo * 1000).toISOString()

const sql = []
for (let i = 0; i < count; i++) {
  const slug = i === 0 ? "steer-demo" : `worker-${i}`
  const sessionId = `${String(i).padStart(8, "0")}-2222-3333-4444-555555555555`
  const title = i === 0 ? "Steering latency demo" : `Worker thread ${i}`

  const rows = [
    { type: "user", timestamp: ts(600), message: { content: `Task ${i}: refactor the pricing table so the tiers line up on narrow viewports.` } },
  ]
  // A realistic tail: a long run of tool calls interleaved with prose, like a worker mid-effort.
  const depth = i === 0 ? 3 : 30
  for (let k = 0; k < depth; k++) {
    rows.push({ type: "assistant", timestamp: ts(590 - k * 10), message: { id: `t${k}`, content: [{ type: "tool_use", name: "Read", input: { file_path: `/src/component-${k}.tsx` } }] } })
    rows.push({ type: "assistant", timestamp: ts(589 - k * 10), message: { id: `x${k}`, content: [{ type: "text", text: `Checked component ${k} — the spacing scale is consistent there.` }] } })
  }
  if (i < inFlight) {
    // Mid-turn: the last record is an unanswered tool_use, so the tailer derives turn="in-flight", and
    // its timestamp is old enough that the perm-prompt sniff's quiet gate (PERM_SNIFF_MS) is satisfied.
    rows.push({ type: "assistant", timestamp: ts(30), message: { id: "z", content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }], stop_reason: "tool_use" } })
  } else {
    rows.push({
      type: "assistant",
      timestamp: ts(20),
      message: { id: "z", content: [{ type: "text", text: i === 0 ? "Done — the tiers now wrap cleanly at 420px and the CTA stays optically centered." : `Finished task ${i}.` }], stop_reason: "end_turn" },
    })
  }
  writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n")

  sql.push(
    `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, state) ` +
    `VALUES (${sessionVals}'${slug}','${sessionId}','frizz-${slug}','${ts(700)}','${title}','claude','opus','high','default','active');`,
  )
}
execFileSync("sqlite3", [db, sql.join("\n")], { stdio: "inherit" })
console.log(JSON.stringify({ seeded: count, inFlight, db, jsonlDir }))
