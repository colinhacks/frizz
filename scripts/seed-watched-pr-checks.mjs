// Seed a disposable adhoc stack with the two parks the awaiting fence now supports, so the REAL server
// projects them and the REAL card renders them:
//
//   1. a `watch:` park on a live background shell — the declared park, which takes the thread out of the
//      queue and into the Active rail with its own dot;
//   2. `pr-watch:` parks in every check state, against a pre-published status book — the reading the
//      poller would have written, seeded directly so the case does not depend on finding a real PR whose
//      CI happens to be running at the moment you look.
//
// The transcripts are read by the production tailer and the fences parsed by the production parser; the
// only thing shortcut is `gh` itself.
//
// Usage: nub scripts/seed-watched-pr-checks.mjs --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = "/Users/colinmcd94/Documents/projects/frizz" } = flags
if (!home) {
  console.error("usage: node seed-watched-pr-checks.mjs --home=/abs/temp-home")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const ago = (mins) => new Date(Date.now() - mins * 60_000).toISOString().replace(/\.\d+Z$/, "Z")
const at = ago(3)

const TASK_ID = "bzvtnt3ig"
const TOOL_USE = "toolu_01SeedWatchProbe"

const status = (over) => ({
  checks: "running", running: 0, passed: 0, failed: 0, failing: [], merge: "unknown", state: "open",
  polledAt: at, ...over,
})

// The book the poller publishes, keyed by ref. Written straight into `settings` because the alternative
// is finding a real PR whose CI is mid-run on demand.
const BOOK = {
  "acme/app#391": status({ checks: "running", running: 3, passed: 12, merge: "blocked" }),
  "acme/app#392": status({ checks: "passing", passed: 15, merge: "mergeable" }),
  "acme/app#393": status({ checks: "failing", running: 1, passed: 9, failed: 2, failing: ["lint", "e2e (chromium)"], merge: "blocked" }),
}

// A broker DISCOVERY RECORD naming a pid that is actually alive — this process. The tailer probes it to
// answer "is the daemon that owns this thread's background shells still there", and its fail-safe is
// ALIVE, so an absent record is the one shape that answers dead. Seeding a thread WITH live shells
// therefore has to seed one of these too.
function brokerRecord(sessionId) {
  const stateDir = dirname(db)
  const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 16)
  const path = join(stateDir, "claude-broker", `${key}.json`)
  mkdirSync(dirname(path), { recursive: true })
  // The SERVER's pid, not this script's parent. The probe runs on every board rebuild, so a pid that
  // dies with the seeder answers "the daemon is gone" seconds later — and the thread's background shells
  // are then correctly dropped, silently emptying the very case being seeded.
  writeFileSync(path, JSON.stringify({ sessionId, daemonPid: serverPid(), socketPath: join(stateDir, "claude-broker", `${key}.sock`), startedAt: at }))
}

/** The adhoc stack's own pid, off its server.lock — alive for as long as the stack is. */
function serverPid() {
  try {
    const lock = JSON.parse(readFileSync(join(dirname(db), "server.lock"), "utf8"))
    if (Number.isFinite(lock?.pid)) return lock.pid
  } catch {}
  return process.ppid
}

const CASES = [
  {
    slug: "watch-shell",
    title: "watch · parked on its own background shell",
    // A real background-shell launch pair, so the fold produces a LIVE bgShell the fence can name.
    extra: [
      {
        type: "assistant", timestamp: at, uuid: "s1",
        message: { role: "assistant", content: [{ type: "tool_use", id: TOOL_USE, name: "Bash", input: { command: "nub run test", description: "Running the suite", run_in_background: true } }] },
      },
      {
        type: "user", timestamp: at, uuid: "s2",
        message: { role: "user", content: [{ tool_use_id: TOOL_USE, type: "tool_result", is_error: false, content: `Command running in background with ID: ${TASK_ID}. Output is being written to: /tmp/${TASK_ID}.output. You will be notified when it completes.` }] },
        toolUseResult: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: TASK_ID },
      },
    ],
    tail: `Kicked the suite off in the background.\n\n\`\`\`awaiting\nwatch: ${TASK_ID}\nWaiting on the test run.\n\`\`\``,
  },
  {
    slug: "watch-ci-running",
    title: "watch · CI still running on every PR",
    prs: ["acme/app#391"],
    tail: "Both PRs are pushed.\n\n```awaiting\npr-watch: acme/app#391\nWatching CI and review.\n```",
  },
  {
    slug: "watch-ci-mixed",
    title: "watch · three PRs, three check states",
    prs: ["acme/app#391", "acme/app#392", "acme/app#393"],
    tail: "Three PRs up.\n\n```awaiting\npr-watch: acme/app#391\npr-watch: acme/app#392\npr-watch: acme/app#393\nWatching CI and review across all three.\n```",
  },
]

for (const [n, c] of CASES.entries()) {
  const sessionId = `${c.slug}-0000-4000-8000-000000000000`.slice(0, 36)
  const records = [
    {
      parentUuid: null, isSidechain: false, type: "user",
      message: { role: "user", content: `TASK:\n${c.title}` },
      uuid: `0000000${n}-0000-4000-8000-000000000001`.slice(-36), timestamp: ago(10), session_id: sessionId, cwd,
    },
    ...(c.extra ?? []).map((r) => ({ ...r, session_id: sessionId, cwd })),
    {
      parentUuid: null, isSidechain: false, type: "assistant",
      message: {
        model: "claude-opus-5", id: `msg_${c.slug}`, type: "message", role: "assistant",
        content: [{ type: "text", text: c.tail }],
        stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 40 },
      },
      uuid: `0000000${n}-0000-4000-8000-000000000009`.slice(-36), timestamp: at, session_id: sessionId, cwd,
    },
  ]
  writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  brokerRecord(sessionId)
  // THE WATCHERS, registered the way the tool registers them. A `pr-watch:` fence line only DECLARES a
  // wait now; without a row here the board refuses the declaration and the thread queues as usual.
  for (const [n2, ref] of (c.prs ?? []).entries()) {
    const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(ref)
    execFileSync("sqlite3", [
      db,
      // `project_id` is NOT NULL on every keyed table, not just `session` — the same prefix pair serves
      // them all, because the value is the project either way.
      `INSERT OR REPLACE INTO pr_watch (${sessionCols}id, thread_slug, owner, repo, number, state, created_at, settled_at, cursor)
       VALUES (${sessionVals}'prw-${c.slug}-${n2}', '${c.slug}', '${m[1]}', '${m[2]}', ${m[3]}, 'armed', ${Date.parse(at)}, NULL, NULL)`,
    ])
  }
  execFileSync("sqlite3", [
    db,
    // BROKER, and it has to be: a non-headless row has no live transport any more, so `deriveRuntime`
    // reports `exited` for it and nothing downstream reads as a rest. The broker arm needs a discovery
    // record whose pid is alive, or the daemon probe answers "gone" and drops the thread's background
    // shells — correctly, which is exactly why this seeder writes one (see brokerRecord below).
    `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, claude_runtime, model, effort, permission_mode, rested_at)
     VALUES (${sessionVals}'${c.slug}', '${sessionId}', 'frizz-${c.slug}', '${at}', '${c.title}', 'claude', 'broker', 'opus', 'high', 'default', '${at}')`,
  ])
  console.log(`seeded ${c.slug}`)
}

execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO settings (${sessionCols}key, value) VALUES (${sessionVals}'waker.github.status.v1', '${JSON.stringify(BOOK).replace(/'/g, "''")}')`,
])
console.log("seeded the watched-PR status book")
