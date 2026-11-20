import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { shellWriteTargets, type EditedFile, type TranscriptMessage } from "@frizz/shared"

// THE FILES A THREAD'S WORKER HAS WRITTEN, derived from its projected transcript — the fullscreen
// page's rail lists them (maintainer 2026-08-28: "the edited files, if that's even possible"). Two
// readings feed it:
//
//  1. TOOL CALLS. Every Edit/Write/MultiEdit call carries a structured `edit.file`, and a codex
//     apply_patch the projection could not reconstruct still arrives named Edit with the file as its
//     `detail` — the same two readings the web's toolActivity uses for the "edited N files" digest,
//     kept in step by construction (the same name set, the same fallback order).
//  2. SHELL WRITES. A Bash call's own command text, parsed for redirects and in-place editors
//     (shared/shell-writes.ts). Added 2026-09-04 after a real doc a nub thread authored with
//     `cat > .frizz/sandbox-direction-decisions.md <<'MD'` never reached the rail: Claude Code's
//     `auto` permission mode TELLS the worker to edit with "sed, heredocs, or short scripts, rather
//     than using the dedicated Read, Edit, or Write tools", so on the maintainer's own threads the
//     tool-call reading alone is blind by design, not by worker error.
//
// READING 2 IS THIS RAIL'S ALONE, and that divergence from the digest is deliberate rather than drift:
// it needs the project dir to resolve a relative target and the filesystem to reject one that was never
// written, and the per-turn digest runs in the browser with neither. A count that swept in `/dev/null`
// and every `/tmp` capture would be worse than one that admits what it counts.
//
// It runs over the FULL projection, never the latest window: the window is the last ~300 messages,
// and a worker's edits sit in the middle of an effort with verification and the handoff after them.
// Distinct by path, newest edit first, each with how many write calls touched it and when the last
// one was issued (the emitting message's own stamp).
//
// A FILE THAT NO LONGER EXISTS IS NOT A ROW, whichever reading named it. A Bash `rm`/`mv` is not
// parsed; the rail asks the filesystem at read time instead, which also catches a file deleted by
// another thread, by the maintainer, or by anything else. Until 2026-09-25 an Edit/Write row was kept
// after its file was deleted, as part of "the account of what the effort did" — and two memory files a
// worker wrote under `~/.claude` and then deleted stayed on the rail for good, each row opening a file
// that was not there (maintainer: "These two files keep showing up in the sidebar … despite the fact
// that they've been deleted"). The rail is a way into the files; one that is gone has no way in.
//
// NOR IS A CLAUDE CODE MEMORY FILE, which a worker writes with the same Write and Edit tools as its real
// work. The memory is Claude Code's bookkeeping about the maintainer and the project, kept across
// sessions, not something this effort made (maintainer 2026-11-20: "exclude Claude memory directories
// from the edited files in the artifact sidebar"). See isClaudeMemoryPath.

const FILE_WRITING_TOOL_NAMES = new Set(["edit", "multiedit", "write", "apply patch"])

// The tail `capCommand` appends verbatim when a command exceeds COMMAND_CAP (transcript.ts). The cut
// can sever a path mid-token, so the last target of a truncated command is dropped rather than shown
// as half a filename. The tail has to be STRIPPED before parsing, not merely detected: its leading
// newline terminates the severed token, which would otherwise read as a complete one.
const TRUNCATION_TAIL = "\n… (truncated)"

type ToolLike = {
  name: string
  detail?: string
  command?: string
  cwd?: string
  edit?: { file: string; added?: number; removed?: number }
}
type MessageLike = Pick<TranscriptMessage, "tools"> & { at?: string }

function normalizedToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[_-]+/g, " ")
}

// A `${…}` left in a path is a codex exec-wrapper placeholder the projection could not fill — a loop
// variable, an expression — not a directory the worker wrote (transcript.ts, fillTemplatePlaceholders).
// It stays on the card, which shows what the script said; it stays OFF the rail, whose rows open the
// file they name. The web digest (toolActivity.ts editedFileCount) applies the same test.
const UNRESOLVED_PLACEHOLDER = /\$\{/

export function editedFilePath(tool: ToolLike): string | null {
  const structured = tool.edit?.file.trim()
  if (structured) return UNRESOLVED_PLACEHOLDER.test(structured) ? null : structured
  const detail = tool.detail?.trim()
  if (!detail || UNRESOLVED_PLACEHOLDER.test(detail)) return null
  return FILE_WRITING_TOOL_NAMES.has(normalizedToolName(tool.name)) ? detail : null
}

// `path.resolve` treats a leading tilde as an ordinary segment, so `cd ~/.cache/nub/worktrees/x &&
// cat > a.rs` resolved to `<project>/~/.cache/…` and then passed the containment check below as an
// in-project file. Expanding first lands it in HOME, where the check drops it as it always should have.
function expandHome(candidate: string, home: string): string {
  if (candidate === "~") return home
  return candidate.startsWith("~/") ? path.join(home, candidate.slice(2)) : candidate
}

// Claude Code's memory directories, as Claude Code 2.1.328 lays them out:
//
//  - auto memory, `<config>/projects/<project key>/memory/` (MEMORY.md and one file per memory);
//  - a sub-agent's user-scope memory, `<config>/agent-memory/<agent>/`;
//  - its project- and local-scope memory, `<cwd>/.claude/agent-memory/<agent>/` and
//    `<cwd>/.claude/agent-memory-local/<agent>/`.
//
// `<config>` is `~/.claude` unless CLAUDE_CONFIG_DIR moves it, and Frizz hands a worker the server's own
// environment, so the server's reading is the worker's. The shapes are matched under ANY `.claude`
// directory as well as under that one: a worker's HOME is not always the server's (a sandbox stack), and
// the `<cwd>` of a project-scope memory is the worker's, which a worktree moves. A memory directory moved
// by the `autoMemoryDirectory` setting is not followed.
function underClaudeMemory(segments: readonly string[]): boolean {
  const [first, second, third] = segments
  if (first === "agent-memory" || first === "agent-memory-local") return segments.length > 1
  return first === "projects" && second !== undefined && third === "memory" && segments.length > 3
}

export function isClaudeMemoryPath(file: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim()
  if (configDir) {
    const relative = path.relative(path.resolve(expandHome(configDir, os.homedir())), file)
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative) && underClaudeMemory(relative.split(path.sep))) return true
  }
  const segments = path.resolve(file).split(path.sep)
  return segments.some((segment, i) => segment === ".claude" && underClaudeMemory(segments.slice(i + 1)))
}

// The files a shell command wrote, as absolute paths inside the project.
//
// SCOPED TO THE PROJECT, unlike the tool-call reading, which lists whatever path the tool named. A
// redirect is a far weaker signal of intent than an Edit: a worker writes `/tmp` scratch, capture logs
// and probe fixtures all day, and the corpus behind the parser is 77,541 redirect targets of which
// 66,705 are `/dev/null` or `/tmp`. Everything outside the project is that noise; everything inside it
// is work the maintainer has a reason to look at, INCLUDING the thread's own `.frizz/` scratch — which
// is exactly where the file that prompted this was written.
function shellWrittenPaths(tool: ToolLike, projectDir: string): string[] {
  if (normalizedToolName(tool.name) !== "bash" || !tool.command) return []
  const truncated = tool.command.endsWith(TRUNCATION_TAIL)
  const targets = shellWriteTargets(truncated ? tool.command.slice(0, -TRUNCATION_TAIL.length) : tool.command)
  const home = os.homedir()
  const out: string[] = []
  for (const target of targets) {
    if (truncated && target.atEnd) continue
    // The command's own `cd`, else the call's recorded cwd (codex records one), else the project.
    const base = expandHome(target.base ?? tool.cwd ?? projectDir, home)
    const absoluteBase = path.isAbsolute(base) ? base : path.resolve(projectDir, base)
    const resolved = path.resolve(absoluteBase, expandHome(target.path, home))
    const relative = path.relative(projectDir, resolved)
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) continue
    // It also has to EXIST, which editedFilesOf checks for every row — and which matters most here. A
    // shell write is read out of a command the worker TYPED, so a relative target written while the
    // worker stood somewhere this parser cannot see (`cd "$TMP"` earlier in the effort, a fixture tree
    // built under a temp root) resolves against the project and names a file that was never there —
    // 26% of in-project targets over the measured corpus.
    out.push(resolved)
  }
  return out
}

// `onDisk` is injected so the readings stay testable without a filesystem; the server always takes the
// default. It runs once per distinct path, after the writes have collapsed into rows.
export function editedFilesOf(
  messages: readonly MessageLike[],
  projectDir?: string,
  onDisk: (p: string) => boolean = fs.existsSync,
): EditedFile[] {
  const byPath = new Map<string, EditedFile>()
  const bump = (rawPath: string, at: string | undefined, added?: number, removed?: number) => {
    const existing = byPath.get(rawPath)
    if (existing) {
      existing.edits++
      if (at) existing.lastEditedAt = at
      if (added !== undefined) existing.added = (existing.added ?? 0) + added
      if (removed !== undefined) existing.removed = (existing.removed ?? 0) + removed
      // Re-insert so Map order tracks recency.
      byPath.delete(rawPath)
      byPath.set(rawPath, existing)
      return
    }
    byPath.set(rawPath, {
      path: rawPath,
      edits: 1,
      ...(at ? { lastEditedAt: at } : {}),
      ...(added !== undefined ? { added } : {}),
      ...(removed !== undefined ? { removed } : {}),
    })
  }
  for (const message of messages) {
    for (const tool of message.tools ?? []) {
      const toolPath = editedFilePath(tool)
      if (toolPath) {
        bump(toolPath, message.at, tool.edit?.added, tool.edit?.removed)
        continue
      }
      // A shell write carries no diffstat: the command says which file it wrote, never how many lines
      // it changed. FileRow already renders a file with no counted lines as a row with no status
      // rather than a fabricated 0.
      if (!projectDir) continue
      for (const shellPath of shellWrittenPaths(tool, projectDir)) bump(shellPath, message.at)
    }
  }
  // A tool-call path is normally absolute; a relative one (a codex patch) is read against the project.
  const located = (file: EditedFile): string =>
    projectDir && !path.isAbsolute(file.path) ? path.resolve(projectDir, file.path) : file.path
  return [...byPath.values()].filter((file) => !isClaudeMemoryPath(located(file)) && onDisk(located(file))).reverse()
}
