// The documents an agent is told to read name files, and a file that was renamed or deleted stays
// named: ARCHITECTURE.md sent readers to `sessions.ts` for the SQLite registry months after it
// became `storage.ts`. So every file named in backticks has to be in the tree, and the reading
// table at the top of ARCHITECTURE.md has to name sections that exist.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const DOCS = ["AGENTS.md", "AGENTS.local.md", "FRIZZ.md", "ARCHITECTURE.md", "README.md"]

// Named in a document and not in the tree, each on purpose. An entry that no document names any
// more, or whose file now exists, fails: the list cannot outlive its reasons.
const NOT_IN_THE_TREE = new Map([
  ["packages/server/src/tmux.ts", "deleted on 2026-08-02, which is what the documents say about it"],
  ["dist/frizz.js", "built: the published shell's one file"],
  ["dist/dev-child.js", "built: the published server's entry"],
  ["config.json", "a file in Frizz's own state folder"],
  ["auth.json", "the Codex CLI's credential file"],
  ["opencode.json", "OpenCode's own configuration file"],
  ["tool/plugin/subagent.ts", "a file in OpenCode's repository"],
  ["core/src/permission.ts", "a file in OpenCode's repository"],
  ["core/src/session/environment.ts", "a file in OpenCode's repository"],
  ["session/execution/restart.ts", "a file in OpenCode's repository"],
])

const FILE = /^[\w@.\-/]+\.(?:ts|tsx|mts|mjs|cjs|js|json|md|yml|yaml|sh|css|html|toml)$/u

/** The files a document names in backticks: `a/b.ts`, `b.ts`, `a/b.ts:120`, `./a/b.ts`. */
export function namedFiles(markdown) {
  const named = new Set()
  for (const [, token] of markdown.matchAll(/`([^`\s]+)`/gu)) {
    const path = token.replace(/:\d+(?:-\d+)?$/u, "").replace(/^\.\//u, "")
    if (FILE.test(path)) named.add(path)
  }
  return named
}

/** A name is in the tree when a file has it as its path, or as the end of its path at a `/`. */
export function inTree(files) {
  const suffixes = new Set()
  for (const file of files) {
    const parts = file.split("/")
    for (let index = 0; index < parts.length; index++) suffixes.add(parts.slice(index).join("/"))
  }
  return (name) => suffixes.has(name)
}

/** The sections ARCHITECTURE.md's reading table sends a reader to. */
export function tableSections(markdown) {
  const start = markdown.indexOf("| Touching | Read |")
  if (start < 0) return []
  const rows = markdown.slice(start).split("\n\n")[0].split("\n").slice(2)
  return rows.flatMap((row) => [...(row.split("|")[2] ?? "").matchAll(/§ ([^,|]+)/gu)].map(([, name]) => name.trim()))
}

let tracked
try {
  // What a clone holds, so a local build's output cannot make a name resolve here and nowhere else.
  tracked = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\n").filter(Boolean)
} catch {
  tracked = undefined
}

test("every file a document names in backticks is in the tree", { skip: tracked ? false : "not a git checkout" }, () => {
  const exists = inTree(tracked)
  const missing = []
  const excused = new Set()
  for (const doc of DOCS) {
    for (const name of namedFiles(readFileSync(join(root, doc), "utf8"))) {
      if (exists(name)) continue
      if (NOT_IN_THE_TREE.has(name)) excused.add(name)
      else missing.push(`${doc}: ${name}`)
    }
  }
  assert.deepEqual(missing, [], "a document names a file that is not in the tree: fix the name, or say why in NOT_IN_THE_TREE")
  const stale = [...NOT_IN_THE_TREE.keys()].filter((name) => !excused.has(name))
  assert.deepEqual(stale, [], "NOT_IN_THE_TREE excuses a name that no document uses any more, or that now exists")
})

test("the reading table in ARCHITECTURE.md names sections that exist", () => {
  const markdown = readFileSync(join(root, "ARCHITECTURE.md"), "utf8")
  const headings = [...markdown.matchAll(/^#{2,3} (.+)$/gmu)].map(([, heading]) => heading)
  const sections = tableSections(markdown)
  assert.ok(sections.length >= 10, "the table is there, and read")
  const unknown = sections.filter((section) => !headings.some((heading) => heading === section || heading.startsWith(`${section} `) || heading.startsWith(`${section},`)))
  assert.deepEqual(unknown, [])
})

test("a name is read out of backticks with its line number and leading ./ removed, and prose is not a name", () => {
  const named = namedFiles("See `src/a.ts`, `b.tsx:120`, `./scripts/c.mjs`, `packages/x/y.test.ts:10-12`, `nub run test`, `--flag`, `<cache>/x.json`, `v1.2.3` and `*.md`.")
  assert.deepEqual([...named].sort(), ["b.tsx", "packages/x/y.test.ts", "scripts/c.mjs", "src/a.ts"])
  const exists = inTree(["packages/server/src/storage.ts", "README.md"])
  assert.deepEqual(["storage.ts", "src/storage.ts", "packages/server/src/storage.ts", "README.md", "sessions.ts", "rver/src/storage.ts"].map(exists), [true, true, true, true, false, false])
  assert.deepEqual(tableSections("x\n\n| Touching | Read |\n| --- | --- |\n| Anything | § Invariants, § Conventions |\n| Web | § The Console |\n\nafter § Nothing"), ["Invariants", "Conventions", "The Console"])
})
