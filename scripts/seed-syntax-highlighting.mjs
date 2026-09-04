// Seed a disposable adhoc stack with one thread that puts EVERY code surface in the transcript on a
// single screen, so the app's highlighting can be judged as one system rather than one card at a time:
//
//   • a Bash card — a shell command, which used to render as an undifferentiated grey wall;
//   • Read cards — file excerpts in `cat -n` form, for a .ts, a .yml and an extensionless file (the
//     last is the control: no grammar, so it must stay plain rather than be guessed at);
//   • Edit diffs — the same .ts file and a .yml one, which is where the two palettes used to disagree;
//   • a markdown fence in the assistant's own prose, in the same languages.
//
// The point of the layout is ADJACENCY: a `const` in the fence, in the Read card and in the diff all
// sit within one scroll, and before this change they were three different colours.
//
// Follows the frizz-stack recipe: a session row + a JSONL the REAL tailer reads.
//
// Usage: node scripts/seed-syntax-highlighting.mjs --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = "/Users/colinmcd94/Documents/projects/frizz" } = flags
if (!home) {
  console.error("usage: node seed-syntax-highlighting.mjs --home=/abs/temp-home")
  process.exit(1)
}

mkdirSync(join(home, "tasks"), { recursive: true })
writeFileSync(join(home, "tasks", "shfixture1.output"), "waiting for READY…\n")

const sandbox = resolveSandboxDb(home)
const { db } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const cwdSlug = cwd.replace(/[/.]/g, "-")
const jsonlDir = join(home, ".claude", "projects", cwdSlug)
mkdirSync(jsonlDir, { recursive: true })

const now = () => new Date().toISOString()
let uuidN = 0
const uuid = () => `0000000${(++uuidN).toString().padStart(4, "0")}-0000-4000-8000-000000000000`.slice(-36)

const slug = flags.slug ?? "syntax-highlighting"
const sessionId = "5f47a1c0-0000-4000-8000-000000000001"

// Exactly the shape Claude's Read tool returns, verified against real transcripts on disk: the number
// is NOT space-padded — it is followed by a TAB, and the tab stop is what aligns line 9 with line 10.
// (Padding it by hand, which an earlier version of this fixture did, produces a misalignment the real
// app never shows.) The last line of a file that ends in a newline is a bare `N\t`, whose tab the
// server's payload trim then removes — which is why the renderer has to tolerate a tabless number.
const catN = (source, from = 1) =>
  source.split("\n").map((line, i) => `${from + i}\t${line}`).join("\n")

const TS_SOURCE = `import { useMemo } from "react"

/* The excerpt below spans several lines on purpose: a block comment is one
   token across all of them, and a renderer that splits lines naively paints
   the whole rest of the file as a comment. */
export function resolveFenceLanguage(info?: string): string {
  const declared = (info ?? "").trim().split(/\\s+/, 1)[0].toLowerCase()
  if (!declared || declared === "text") return "plaintext"
  return ALIASES.get(declared) ?? "plaintext"
}

const RETRIES = 3
const label = \`retried \${RETRIES} times\`   // a template literal
`

const YAML_SOURCE = `name: ci
on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 20        # a comment beside a value
    steps:
      - uses: actions/checkout@v4
      - name: Install
        run: pnpm install --frozen-lockfile
      - name: Test
        run: pnpm test
    env:
      URL: https://example.com/a:b   # the colon here is NOT a key
`

// No extension and not a known filename — the control. There is no grammar for it, so it must render
// plain rather than be guessed into one.
const PLAIN_SOURCE = `frizz build manifest
generated 2026-08-13
entries 412
`

const user = (text) => ({
  parentUuid: null,
  isSidechain: false,
  type: "user",
  message: { role: "user", content: text },
  uuid: uuid(),
  timestamp: now(),
  session_id: sessionId,
  cwd,
})

const toolUse = (id, name, input) => ({
  parentUuid: null,
  isSidechain: false,
  type: "assistant",
  message: {
    model: "claude-opus-5",
    id: `msg_${uuid()}`,
    type: "message",
    role: "assistant",
    content: [{ type: "tool_use", id, name, input }],
    stop_reason: "tool_use",
    usage: { input_tokens: 2, output_tokens: 40 },
  },
  uuid: uuid(),
  timestamp: now(),
  session_id: sessionId,
  cwd,
})

const toolResult = (id, text) => ({
  parentUuid: null,
  isSidechain: false,
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] },
  uuid: uuid(),
  timestamp: now(),
  session_id: sessionId,
  cwd,
})

const assistant = (text) => ({
  parentUuid: null,
  isSidechain: false,
  type: "assistant",
  message: {
    model: "claude-opus-5",
    id: `msg_${uuid()}`,
    type: "message",
    role: "assistant",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 2, output_tokens: 200 },
  },
  uuid: uuid(),
  timestamp: now(),
  session_id: sessionId,
  cwd,
})

const file = (p) => `${cwd}/${p}`
const pair = (id, name, input, result) => [toolUse(id, name, input), toolResult(id, result)]

const records = [
  user("TASK:\nGet syntax highlighting going across the transcript."),

  ...pair("c1", "Bash", {
    command: [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      '',
      '# Every shell construct that carries colour, on one card.',
      'for pkg in web server shared; do',
      '  if [[ -d "packages/$pkg" ]]; then',
      '    pnpm --filter "@frizz/$pkg" typecheck 2>&1 | tee "/tmp/tc-$pkg.log"',
      '  fi',
      'done',
      'echo "checked ${#pkg} packages" && exit 0',
    ].join("\n"),
    description: "Typechecking every workspace package",
  }, "All three packages typecheck clean."),

  ...pair("c2", "Read", { file_path: file("packages/web/src/lib/syntaxHighlight.ts") }, catN(TS_SOURCE)),
  ...pair("c3", "Read", { file_path: file(".github/workflows/ci.yml") }, catN(YAML_SOURCE)),
  ...pair("c4", "Read", { file_path: file("build/MANIFEST") }, catN(PLAIN_SOURCE)),

  // An auto-backgrounded Bash, so the background-shell DRAWER has a real command to render. That
  // drawer is the fourth code surface, and it is not reachable from the transcript cards.
  ...pair("c7", "Bash", {
    command: "until grep -q '^READY' /tmp/frizz-boot.log; do sleep 5; done\necho \"up after ${SECONDS}s\"",
    description: "Waiting for the stack to report ready",
    timeout: 590000,
  }, `Command did not complete within its 590s timeout and was moved to the background (ID: shfixture1). Output is being written to: ${home}/tasks/shfixture1.output. You will be notified when it completes.`),

  ...pair("c5", "Edit", {
    file_path: file("packages/web/src/lib/syntaxHighlight.ts"),
    old_string: '  if (!declared || declared === "text") return "plaintext"\n  return ALIASES.get(declared) ?? "plaintext"',
    new_string: '  if (PLAINTEXT_ALIASES.has(declared)) return "plaintext"\n  return ALIAS_TO_LANGUAGE.get(declared) ?? "plaintext"',
  }, "ok"),

  ...pair("c6", "Edit", {
    file_path: file(".github/workflows/ci.yml"),
    old_string: "    timeout-minutes: 20        # a comment beside a value",
    new_string: "    timeout-minutes: 30        # raised for the browser suite",
  }, "ok"),

  assistant([
    "**Fixed** — every code surface in the transcript now highlights, and they all share one palette.",
    "",
    "The fence below is the reference: the same `const`, the same string, the same comment as the Read",
    "card and the diff above it, so the three can be compared without scrolling.",
    "",
    "```ts",
    'const RETRIES = 3',
    'const label = `retried ${RETRIES} times` // a template literal',
    'export function resolve(info?: string): string {',
    '  return ALIASES.get(info ?? "") ?? "plaintext"',
    "}",
    "```",
    "",
    "```yaml",
    "jobs:",
    "  test:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 30   # a comment",
    "```",
    "",
    "```bash",
    'for pkg in web server shared; do',
    '  pnpm --filter "@frizz/$pkg" typecheck',
    "done",
    "```",
  ].join("\n")),
]

writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

execFileSync("sqlite3", [
  db,
  `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, rested_at)
   VALUES (${sessionVals}'${slug}', '${sessionId}', 'frizz-${slug}', '${now()}', 'syntax highlighting', 'claude', 'opus', 'high', 'default', '${now()}')`,
])
console.log(`seeded ${slug} → ${sessionId}`)
