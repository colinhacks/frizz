import { lstatSync, readdirSync, realpathSync } from "node:fs"
import path from "node:path"
import type { ScratchFiles } from "@frizz/shared"

// THE THREAD'S SCRATCH DIRECTORY AS A ROOT OF ITS OWN ON THE RAIL (maintainer 2026-11-14: "We should
// automatically register the scratch directory as well as its own root").
//
// Every thread gets `.frizz/threads/<session id>/` at dispatch (dispatch.ts writeScratchDir), keyed on the
// row's session id for every backend. Neither of the rail's other sources can see into it: git ignores
// `.frizz/`, so "Edited files" drops a Write there (repo-files.ts), and the transcript never shows the
// screenshot a script saved or the report a sub-agent wrote. And nothing in it is anyone's but this
// thread's, so there is nothing to attribute: the group is the folder's listing, read off the folder.
//
// A listing, not a diff, and no line counts: everything in it is new, so a "+N" on every row would say
// nothing a reader needs. Regular files only. A symlink is not listed, because what it names is not the
// thread's file, and a fifo or socket is not a file anyone opens.

/** More than a thread keeps. Past it the group says it is truncated rather than growing without bound. */
const MAX_FILES = 500
/** Entries looked at in all, so a folder someone ran `npm install` in costs a bounded walk. */
const MAX_ENTRIES = 5000
const MAX_DEPTH = 8
/** Finder's per-folder state, which appears the moment a human opens the folder and is nobody's work. */
const SKIPPED = new Set([".DS_Store"])

/** The same shape dispatch.ts accepts for the folder's name. Anything else names no scratch directory. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/

/** The thread's scratch directory under `projectDir`, whether or not it exists. */
export function scratchRoot(projectDir: string, sessionId: string): string | undefined {
  return SESSION_ID.test(sessionId) ? path.join(projectDir, ".frizz", "threads", sessionId) : undefined
}

/** Every file in the thread's scratch directory, or undefined when it holds none (or is not there). */
export function scratchFiles(projectDir: string, sessionId: string): ScratchFiles | undefined {
  const named = scratchRoot(projectDir, sessionId)
  if (!named) return undefined
  let root: string
  try {
    // Provisioned as a real folder (dispatch.ts ensureSafeDirectDirectory). One that is a symlink now
    // was not made by Frizz, and is not walked. The real path, because that is what a file under it is
    // matched by (worktree-changes.ts underAnyRoot) and what the viewer resolves.
    if (!lstatSync(named).isDirectory()) return undefined
    root = realpathSync(named)
  } catch {
    return undefined
  }
  const files: { path: string }[] = []
  let entries = 0
  let truncated = false
  const walk = (dir: string, depth: number): void => {
    let listing
    try {
      listing = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of listing) {
      if (files.length === MAX_FILES || ++entries > MAX_ENTRIES) {
        truncated = true
        return
      }
      if (SKIPPED.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isFile()) files.push({ path: full })
      else if (entry.isDirectory() && depth < MAX_DEPTH) walk(full, depth + 1)
      if (truncated) return
    }
  }
  walk(root, 0)
  if (files.length === 0) return undefined
  return { root, files, ...(truncated ? { truncated: true } : {}) }
}
