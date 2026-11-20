import { test } from "node:test"
import assert from "node:assert/strict"
import { editedFilesOf, isClaudeMemoryPath } from "./edited-files.ts"

// Every candidate exists unless a test says otherwise, so existence is not silently doing the work.
const allPresent = () => true

const msg = (at: string, ...tools: { name: string; detail?: string; command?: string; edit?: { file: string; added?: number; removed?: number } }[]) => ({ at, tools } as never)

test("distinct files, newest edit first, counted per write call, diffstat summed", () => {
  const out = editedFilesOf([
    msg("2026-08-28T10:00:00Z", { name: "Edit", edit: { file: "/r/a.ts", added: 5, removed: 2 } }, { name: "Write", edit: { file: "/r/b.ts", added: 40, removed: 0 } }),
    msg("2026-08-28T10:05:00Z", { name: "Edit", edit: { file: "/r/a.ts", added: 1, removed: 1 } }, { name: "Read", detail: "/r/c.ts" }),
  ], undefined, allPresent)
  assert.deepEqual(out, [
    { path: "/r/a.ts", edits: 2, lastEditedAt: "2026-08-28T10:05:00Z", added: 6, removed: 3 },
    { path: "/r/b.ts", edits: 1, lastEditedAt: "2026-08-28T10:00:00Z", added: 40, removed: 0 },
  ])
})

test("an unreconstructed apply_patch counts by name + detail; a Bash SUMMARY never does", () => {
  // `detail` is the one-line summary of a Bash call, never a path it wrote — only `command` is parsed.
  const out = editedFilesOf([msg("t", { name: "apply_patch", detail: "/r/d.ts" }, { name: "Bash", detail: "rm /r/e.ts" })], undefined, allPresent)
  assert.deepEqual(out.map((f) => f.path), ["/r/d.ts"])
})

test("a path still carrying a `${…}` placeholder is a codex script's variable, not a row", () => {
  // The projection fills `${const}` from the script's own bindings (transcript.ts); what it could not
  // fill — a loop variable, an expression — is not a file, and a row for it would open nothing.
  const out = editedFilesOf([
    msg("t", { name: "Edit", detail: "${dir}/a.ts", edit: { file: "${dir}/a.ts" } }, { name: "apply_patch", detail: "${p}" }, { name: "Edit", edit: { file: "/r/b.ts" } }),
  ], undefined, allPresent)
  assert.deepEqual(out.map((f) => f.path), ["/r/b.ts"])
})

// ---- Shell writes (see the header): the reading that makes a heredoc-authored file visible. ----

const bash = (command: string) => ({ name: "Bash", detail: command.split("\n")[0], command })
test("a file written by a shell redirect reaches the rail, resolved against the project", () => {
  const out = editedFilesOf(
    [msg("2026-09-04T13:13:00Z", bash("cd /p/nub; cat > .frizz/notes.md <<'MD'\n# hi\nMD"))],
    "/p/nub",
    allPresent,
  )
  assert.deepEqual(out, [{ path: "/p/nub/.frizz/notes.md", edits: 1, lastEditedAt: "2026-09-04T13:13:00Z" }])
})

test("the same file written relatively and absolutely is ONE row", () => {
  const out = editedFilesOf(
    [msg("t1", bash("echo a > notes.md")), msg("t2", bash("echo b >> /p/nub/notes.md"))],
    "/p/nub",
    allPresent,
  )
  assert.deepEqual(out, [{ path: "/p/nub/notes.md", edits: 2, lastEditedAt: "t2" }])
})

test("a shell write carries no diffstat, and an Edit to the same path keeps its own", () => {
  const out = editedFilesOf(
    [msg("t1", { name: "Edit", edit: { file: "/p/nub/a.ts", added: 3, removed: 1 } }), msg("t2", bash("sed -i 's/x/y/' /p/nub/a.ts"))],
    "/p/nub",
    allPresent,
  )
  assert.deepEqual(out, [{ path: "/p/nub/a.ts", edits: 2, lastEditedAt: "t2", added: 3, removed: 1 }])
})

test("scratch, HOME and anything outside the project are not the worker's edits", () => {
  const out = editedFilesOf(
    [msg("t", bash("build > /tmp/x.log 2>/dev/null; cd ~/.cache/nub/worktrees/wt && cat > a.rs; echo z > ../sibling/b.ts"))],
    "/p/nub",
    allPresent,
  )
  assert.deepEqual(out, [])
})

test("a target severed by the command cap is dropped rather than shown as half a name", () => {
  // capCommand's tail verbatim — the leading newline is what makes the severed token look whole.
  const truncated = "cat > .frizz/long-considered-fi\n… (truncated)"
  assert.deepEqual(editedFilesOf([msg("t", bash(truncated))], "/p/nub", allPresent), [])
  // The same text untruncated is a real write.
  assert.deepEqual(
    editedFilesOf([msg("t", bash("cat > .frizz/name.md"))], "/p/nub", allPresent).map((f) => f.path),
    ["/p/nub/.frizz/name.md"],
  )
})

test("a file no longer on disk is not a row, whether a shell write or an Edit named it", () => {
  const messages = [
    msg(
      "t",
      bash("echo x > gone.txt"),
      { name: "Write", edit: { file: "/Users/me/notes/removed.md", added: 13, removed: 0 } },
      { name: "apply_patch", detail: "src/removed.ts" },
      { name: "Edit", edit: { file: "/p/nub/kept.ts", added: 1, removed: 0 } },
    ),
  ]
  const present = new Set(["/p/nub/kept.ts"])
  const asked: string[] = []
  const onDisk = (p: string) => (asked.push(p), present.has(p))
  assert.deepEqual(editedFilesOf(messages, "/p/nub", onDisk).map((f) => f.path), ["/p/nub/kept.ts"])
  // A relative tool path is checked against the project, not the server's cwd.
  assert.ok(asked.includes("/p/nub/src/removed.ts"))
})

test("a Claude Code memory file is not a row, whichever memory directory holds it", () => {
  const write = (file: string) => ({ name: "Write", edit: { file, added: 3, removed: 0 } })
  const out = editedFilesOf(
    [
      msg(
        "t",
        write("/Users/me/.claude/projects/-p-nub/memory/MEMORY.md"),
        write("/Users/me/.claude/projects/-p-nub/memory/user-role.md"),
        write("/Users/me/.claude/agent-memory/reviewer/notes.md"),
        write("/p/nub/.claude/agent-memory/reviewer/notes.md"),
        bash("cat > .claude/agent-memory-local/reviewer/notes.md"),
        // Neighbours that are NOT memory: the project's own settings, a transcript, a memory.md of the project's.
        write("/p/nub/.claude/settings.json"),
        write("/Users/me/.claude/projects/-p-nub/abc.jsonl"),
        write("/p/nub/docs/memory/notes.md"),
      ),
    ],
    "/p/nub",
    allPresent,
  )
  assert.deepEqual(out.map((f) => f.path), ["/p/nub/docs/memory/notes.md", "/Users/me/.claude/projects/-p-nub/abc.jsonl", "/p/nub/.claude/settings.json"])
})

test("CLAUDE_CONFIG_DIR moves the user-level memory directories with it", () => {
  const env = { CLAUDE_CONFIG_DIR: "/srv/claude-work" }
  assert.equal(isClaudeMemoryPath("/srv/claude-work/projects/-p-nub/memory/MEMORY.md", env), true)
  assert.equal(isClaudeMemoryPath("/srv/claude-work/agent-memory/reviewer/notes.md", env), true)
  assert.equal(isClaudeMemoryPath("/srv/claude-work/settings.json", env), false)
  // The memory directory itself is not a file in it.
  assert.equal(isClaudeMemoryPath("/srv/claude-work/projects/-p-nub/memory", env), false)
  // Unset, the same path is just a folder with no `.claude` in it.
  assert.equal(isClaudeMemoryPath("/srv/claude-work/projects/-p-nub/memory/MEMORY.md", {}), false)
})

test("without a project dir the shell reading is off entirely", () => {
  assert.deepEqual(editedFilesOf([msg("t", bash("cat > a.md"))]), [])
})
