import { chmodSync, lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { frizzTempDir } from "./frizz-paths.ts"
import { projectFrizzDir } from "./project-root.ts"

// Per-install. The filenames are UUIDs so content cannot collide, but on Linux the first OS user to
// create this directory sets its mode and the second user's writeFileSync then fails EACCES — and
// that write (dispatch.ts) is NOT wrapped, so every dispatch for the second user throws.
export const SYSTEM_PROMPT_DIR = frizzTempDir("frizz-sysprompts")

// A worker's `--mcp-config`, as a FILE. It used to ride the `claude` argv inline, and the config carries
// the operator's credentials — the `headers` of a remote server (`Authorization: Bearer …` for Neon and
// Better Stack on the maintainer's machine) and the `env` of a stdio one — so every token was readable
// by any local process through `ps` for the life of every worker (found 2026-09-30). The file is no
// more exposed than `~/.claude.json`, where those tokens already live: owner-only, in an owner-only dir.
export const MCP_CONFIG_DIR = frizzTempDir("frizz-mcp-config")

const SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/

export function systemPromptPath(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error("invalid session id")
  return join(SYSTEM_PROMPT_DIR, `${sessionId}.md`)
}

export function mcpConfigPath(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error("invalid session id")
  return join(MCP_CONFIG_DIR, `${sessionId}.json`)
}

/** Write `{ mcpServers }` for `sessionId` owner-only and return the path to hand `--mcp-config`. The
 *  chmods are not redundant with the create modes: a mode applies only when the path is CREATED, and a
 *  directory or file left behind by an older build is world-readable. */
export function writeMcpConfigFile(sessionId: string, mcpServers: Record<string, unknown>): string {
  const path = mcpConfigPath(sessionId)
  mkdirSync(MCP_CONFIG_DIR, { recursive: true, mode: 0o700 })
  chmodSync(MCP_CONFIG_DIR, 0o700)
  writeFileSync(path, JSON.stringify({ mcpServers }), { mode: 0o600 })
  chmodSync(path, 0o600)
  return path
}

function isDirectDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch {
    return false
  }
}

function pathAbsent(path: string): boolean {
  try {
    lstatSync(path)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
  }
}

function unlinkDirectChild(parent: string, filename: string): boolean {
  if (!isDirectDirectory(parent)) return pathAbsent(parent)
  const child = join(parent, filename)
  try {
    // rm/unlink of the direct child itself does not follow a child symlink. Parent validation above
    // prevents a poisoned directory symlink from redirecting recovery outside Frizz-owned roots.
    rmSync(child, { force: true })
  } catch {
    return false
  }
  return pathAbsent(child)
}

export function cleanupAdoptionSessionFiles(projectDir: string, sessionId: string): boolean {
  if (!SESSION_ID_RE.test(sessionId)) return false
  const frizzDir = projectFrizzDir(projectDir)
  let clean = true
  if (isDirectDirectory(frizzDir)) {
    const threads = join(frizzDir, "threads")
    // A UUID-named child belongs to exactly one dispatch. Remove the complete private scratch directory
    // directory rather than leaving an empty per-thread shell after a failed spawn/adoption.
    if (isDirectDirectory(threads)) {
      const child = join(threads, sessionId)
      try {
        rmSync(child, { recursive: true, force: true })
      } catch {
        clean = false
      }
    } else if (!pathAbsent(threads)) clean = false
  } else if (!pathAbsent(frizzDir)) clean = false
  clean = unlinkDirectChild(SYSTEM_PROMPT_DIR, `${sessionId}.md`) && clean
  clean = unlinkDirectChild(MCP_CONFIG_DIR, `${sessionId}.json`) && clean
  return clean
}
