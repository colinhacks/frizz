// Seed a disposable adhoc stack with the typed APPROVAL cards a Claude worker raises through
// canUseTool — a one-line Bash command, a multi-line heredoc, a file write carrying its whole body,
// and an argument-less tool — so the card chrome can be judged in the REAL app.
//
// Unlike the ```fence seeders beside it, the card here is a TYPED interaction, so this drives the real
// producer end to end: buildClaudePermissionInteraction() builds the request, the real shared zod
// schema validates it, and the real InteractionStore writes it to the sandbox DB the server serves.
// Only the provider event is simulated.
//
// Usage: nub scripts/seed-permission-cards.mjs --home=/abs/temp-home
import { execFileSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import Database from "../packages/server/src/sqlite.ts"
import { buildClaudePermissionInteraction } from "../packages/server/src/backend/claude-permission-interactions.ts"
import { createInteractionStore } from "../packages/server/src/interaction-store.ts"
import { resolveSandboxDb, sessionProjectColumns } from "./lib/sandbox-db.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, cwd = "/Users/colinmcd94/Documents/projects/frizz" } = flags
if (!home) {
  console.error("usage: nub scripts/seed-permission-cards.mjs --home=/abs/temp-home")
  process.exit(1)
}

const sandbox = resolveSandboxDb(home)
// `projectId` comes from the resolver, NOT from the database's own parent directory. It was
// `dirname(db).split("/").pop()`, which the 2026-08-27 move to one machine-wide `~/.frizz/ui.db` turned
// into the literal string `.frizz` — so every card this script seeded was owned by a project that does
// not exist, the board derived `pendingInteraction: false` for it, and `pendingInteractionScope` then
// returned undefined and drew nothing at all. The resolver reads it off the project state dir, which
// survived the move under both layouts.
const { db, projectId } = sandbox
// The unified schema keys every row by project and the column is NOT NULL; the legacy one has no
// such column. `sessionProjectColumns` yields the right prefix pair for whichever this sandbox is.
const { cols: sessionCols, vals: sessionVals } = sessionProjectColumns(sandbox)
const cwdSlug = cwd.replace(/[/.]/g, "-")
const jsonlDir = join(home, ".claude", "projects", cwdSlug)
mkdirSync(jsonlDir, { recursive: true })

const now = () => new Date().toISOString()
let uuidN = 0
const uuid = () => `0000000${(++uuidN).toString().padStart(4, "0")}-0000-4000-8000-000000000000`.slice(-36)

const CARDS = [
  {
    slug: "perm-bash",
    title: "bash · one line",
    toolName: "Bash",
    description: "Counting commits ahead and behind origin main",
    input: { command: "git rev-list --left-right --count origin/main...HEAD", description: "Counting commits ahead and behind origin main" },
  },
  {
    slug: "perm-heredoc",
    title: "bash · heredoc",
    toolName: "Bash",
    description: "Committing the approval-card redesign",
    input: {
      command: [
        "git commit -F - <<'EOF'",
        "fix(web): the approval card shows the command, not a JSON blob",
        "",
        "The card restated the tool name four times and buried the command",
        "inside `Input: {…}`. Now the command leads, in monospace.",
        "EOF",
      ].join("\n"),
      description: "Committing the approval-card redesign",
      timeout: 120000,
    },
  },
  {
    slug: "perm-write",
    title: "write · body inline",
    toolName: "Write",
    description: "Writing the release note",
    input: {
      file_path: "/Users/colinmcd94/Documents/projects/frizz/RELEASE.md",
      content: "# Release\n\n- The approval card leads with what it is authorizing.\n",
    },
  },
  {
    slug: "perm-bare",
    title: "tool · no arguments",
    toolName: "mcp__frizz__spawn_thread",
    input: {},
  },
]

// Codex raises the SAME payload kind for a capability grant rather than a tool call — no preview, but a
// scope label and a capability list. It shares the renderer, so it is seeded here to keep a Claude-side
// change from quietly regressing it.
const CODEX_CARD = {
  slug: "perm-codex",
  title: "codex · capabilities",
  request: {
    protocolVersion: 1,
    contentFormat: "plain-text",
    provider: { kind: "codex", name: "Codex app server" },
    source: { kind: "runtime", id: "codex-permissions", label: "Codex permissions" },
    providerRequestId: "perm-codex-request",
    allowedDecisions: [
      { id: "grant-turn", semantic: "approve", label: "Grant for this turn" },
      { id: "grant-session", semantic: "approve", label: "Grant for this session" },
      { id: "deny", semantic: "deny", label: "Deny" },
    ],
    payload: {
      kind: "permission-approval",
      title: "Additional permission request",
      message: "Codex requested additional runtime permissions.",
      permission: "network+filesystem",
      workingDirectoryLabel: cwd,
      scopeLabel: "Approval can be granted for this turn or for the current Codex session.",
      capabilities: [
        { kind: "network", enabled: true, hosts: ["https://registry.npmjs.org"] },
        { kind: "filesystem", access: "write", resources: ["Project roots, subpath: packages/web"] },
      ],
    },
    expiresAt: null,
  },
}

// Not an approval at all — an MCP server asking for input. It is here because it is the card that KEEPS
// the "Request details" drawer (its `source.label` is the only place the asking server is named), so it
// is what proves the drawer still renders, and now sits underneath the buttons rather than above them.
const MCP_CARD = {
  slug: "perm-mcp",
  title: "mcp · elicitation",
  request: {
    protocolVersion: 1,
    contentFormat: "plain-text",
    provider: { kind: "claude", name: "Claude session broker" },
    source: { kind: "mcp-server", id: "chrome-devtools", label: "chrome-devtools" },
    providerRequestId: "perm-mcp-request",
    allowedDecisions: [
      { id: "accept", semantic: "accept", label: "Submit" },
      { id: "decline", semantic: "decline", label: "Decline" },
    ],
    payload: {
      kind: "mcp-elicitation-form",
      title: "Which browser profile should this run against?",
      message: "chrome-devtools needs a profile before it can attach.",
      protocolVersion: "2025-06-18",
      fields: [{ id: "profile", label: "Profile", input: "text", required: true, secret: false }],
    },
    expiresAt: null,
  },
}

const database = new Database(db)
const interactions = createInteractionStore(database)

for (const card of [...CARDS, CODEX_CARD, MCP_CARD]) {
  const sessionId = `${card.slug}-0000-4000-8000-000000000000`.slice(0, 36)
  const threadName = `frizz-${card.slug}`
  const records = [
    {
      parentUuid: null,
      isSidechain: false,
      type: "user",
      message: { role: "user", content: `TASK:\n${card.title}` },
      uuid: uuid(),
      timestamp: now(),
      session_id: sessionId,
      cwd,
    },
    {
      parentUuid: null,
      isSidechain: false,
      type: "assistant",
      message: {
        model: "claude-opus-5",
        id: `msg_${card.slug}`,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: `Working on ${card.title}.` }],
        usage: { input_tokens: 2, output_tokens: 12 },
      },
      uuid: uuid(),
      timestamp: now(),
      session_id: sessionId,
      cwd,
    },
  ]
  writeFileSync(join(jsonlDir, `${sessionId}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")

  // A live pane so the thread reads as a real working session rather than an exited one.
  try {
  } catch {
    /* already exists */
  }

  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (${sessionCols}slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode)
     VALUES (${sessionVals}'${card.slug}', '${sessionId}', '${threadName}', '${now()}', '${card.title}', 'claude', 'opus', 'high', 'default')`,
  ])

  const owner = { projectId, threadSlug: card.slug, sessionId, sessionEpoch: 0, capabilityRevision: 0 }
  const request = card.request
    ? { ...card.request, owner: { ...owner, turnId: `${card.slug}-turn`, itemId: `${card.slug}-item` } }
    : buildClaudePermissionInteraction(
      {
        requestId: `${card.slug}-request`,
        toolUseId: `${card.slug}-tool-use`,
        toolName: card.toolName,
        input: card.input,
        ...(card.description ? { description: card.description } : {}),
        suggestions: [],
      },
      { ...owner, cwd },
    )
  if (!request) throw new Error(`${card.slug}: the builder could not represent this request`)
  const created = interactions.create(request)
  console.log(`seeded ${card.slug} → ${created.interaction.id}`)
}

database.close()
