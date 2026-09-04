// Seed a disposable adhoc stack with SIMULATED workers whose last turn is an `awaiting` fence carrying
// SEVERAL `pr-watch:` lines and a timer backstop. These scheduler instructions must remain parsed and
// actionable without being echoed as a second imperative after the worker-authored card copy.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads,
// so the fence is parsed by the production server parser and rendered by the production card — not by a
// hand-built props fixture.
//
// Usage: nub scripts/seed-multi-prwatch.mjs --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = "/Users/colinmcd94/Documents/projects/frizz" } = flags
if (!home) {
  console.error("usage: node seed-multi-prwatch.mjs --home=/abs/temp-home")
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
const ahead = (mins) => new Date(Date.now() + mins * 60_000).toISOString().replace(/\.\d+Z$/, "Z")

const CASES = [
  {
    slug: "watch-one",
    title: "watch · instructions stay hidden",
    fence: [
      "pr-watch: dependabot/dependabot-core#15524",
      `timer: ${ahead(600)}`,
      "PR watcher armed — wakes on any review, approval, or comment on #15524 (plus merge/close). Ping posted at issuecomment-5110553111; on wake, address whatever landed. Fallback timer: if a week passes with zero activity, re-check CI health and report the continued silence.",
    ].join("\n"),
  },
  {
    slug: "watch-three",
    title: "watch · three PRs across three repos",
    fence: [
      "pr-watch: withastro/astro#17487",
      "pr-watch: vitejs/vite#23019",
      "pr-watch: strapi/strapi#26864",
      "All three adoption PRs are open and green, in their maintainers' hands.",
    ].join("\n"),
  },
  {
    slug: "watch-many",
    title: "watch · past the naming cap, with a timer backstop",
    fence: [
      "pr-watch: withastro/astro#17487",
      "pr-watch: vitejs/vite#23019",
      "pr-watch: strapi/strapi#26864",
      "pr-watch: expo/expo#48060",
      "pr-watch: QwikDev/qwik#8786",
      "pr-watch: payloadcms/payload#17163",
      `timer: ${ahead(600)}`,
      "Six adoption PRs watched; the timer re-sweeps the long tail the 8-hint cap can't hold.",
    ].join("\n"),
  },
]

CASES.forEach((c, n) => {
  const sessionId = `${c.slug}-0000-4000-8000-000000000000`.slice(0, 36)
  const threadName = `frizz-${c.slug}`
  const at = ago(3)
  const records = [
    {
      parentUuid: null, isSidechain: false, type: "user",
      message: { role: "user", content: `TASK:\n${c.title}` },
      uuid: `0000000${n}-0000-4000-8000-000000000001`.slice(-36), timestamp: ago(10), session_id: sessionId, cwd,
    },
    {
      parentUuid: null, isSidechain: false, type: "assistant",
      message: {
        model: "claude-opus-5", id: `msg_${c.slug}`, type: "message", role: "assistant",
        content: [{ type: "text", text: `Every PR is pushed and green.\n\n\`\`\`awaiting\n${c.fence}\n\`\`\`` }],
        stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 40 },
      },
      uuid: `0000000${n}-0000-4000-8000-000000000002`.slice(-36), timestamp: at, session_id: sessionId, cwd,
    },
  ]
  writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

  try {
  } catch {
    /* already exists */
  }
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
     VALUES (${sessionVals}'${c.slug}', '${sessionId}', '${threadName}', '${at}', '${c.title}', 'claude', 'opus', 'high', 'default', '${at}')`,
  ])
  console.log(`seeded ${c.slug}`)
})
