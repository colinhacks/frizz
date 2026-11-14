import type { EditedFile } from "@frizz/shared"
import { isRooted, relativeTo, splitPath } from "./paths.ts"

// THE RAIL'S EDITED FILES AS A TREE (maintainer 2026-09-03: "maybe we could do a file tree here
// instead. with a tiny indent per-level. would help organize this and show more context … you can
// collapse paths if there's a chain of directories, similar to github").
//
// The flat list showed basenames alone — a 340px rail cannot hold a repo path, and truncating one
// from the end lost the part that names the file — so twenty-two rows read as twenty-two names with
// no idea where any of them lived. A tree gives each name its directory once, above it, and the
// indent says how deep.
//
// A CHAIN OF DIRECTORIES WITH ONE CHILD EACH IS ONE ROW, joined with `/`, exactly as GitHub's file
// tree draws `packages/web/src` when nothing branches off `packages` or `web`. A directory holding a
// file as well as one subdirectory does branch — the file is a sibling — so it keeps its own row.
//
// Paths under the project directory are shown relative to it. A path under the server's home
// directory is rooted at `~` (maintainer 2026-10-05: "abbreviate the machine's home directory to ~ in
// the fullscreen view sidebar") — the memory and skill files a worker writes under `~/.claude` and
// `~/.agents` are the everyday case, and spelled out they read `/Users/<user>/.claude`, a prefix that
// never varies on a 340px rail. Anything else (a scratch file in /tmp) keeps its absolute path, rooted
// at `/`. All three collapse the same way. A Windows path (`C:\Users\x\proj\src\a.ts`, which is how
// Claude Code and Codex report every file there) splits on either separator, so it nests instead of
// standing as one flat node carrying the whole path (Windows audit 2026-09-11, finding 12); its home
// collapses to `~` like any other, and outside the home the drive is the first segment, so the
// collapsed row reads `D:/scratch` — the tree joins with `/` and Windows accepts it.
//
// Order is GitHub's: directories before files, each set alphabetical, case-insensitive — not the
// list's most-recently-edited-first, because a tree that reorders itself on every save cannot be
// read. Recency has to come back some other way if it is wanted; it was never what the tree is for.

// A directory's `path` is its segments from the tree's root, joined with `/` — unique where `name` is
// not: `one/lib` and `two/lib` both draw a row named `lib` at the same depth, and the rail keys on it.
//
// GENERIC IN THE ROW, not the file: the rail draws a registered checkout's "Changes" (git's rows,
// WorktreeChangedFile) with the same tree, rooted at that checkout as the edited files are at the project.
export type EditedFileTreeNode<F extends { path: string } = EditedFile> =
  | { kind: "dir"; name: string; path: string; depth: number; children: EditedFileTreeNode<F>[] }
  | { kind: "file"; name: string; depth: number; file: F }

type Dir<F> = { dirs: Map<string, Dir<F>>; files: Map<string, F> }

function newDir<F>(): Dir<F> {
  return { dirs: new Map(), files: new Map() }
}

// The path's segments as the tree should show them: project-relative when under the project
// directory (never for the directory itself), else home-relative under a `~` first segment, else
// absolute with `/` as the first segment — or the drive (`C:`) as the first segment, which splitPath
// already yields for a drive-rooted path. The project wins over the home it almost always sits in.
export function editedFileSegments(path: string, projectDir?: string, homeDir?: string): string[] {
  const clean = path.replace(/[\\/]+$/, "")
  if (projectDir) {
    const rel = relativeTo(projectDir, clean)
    if (rel !== null) return splitPath(rel)
  }
  if (homeDir) {
    const rel = relativeTo(homeDir, clean)
    if (rel !== null) return ["~", ...splitPath(rel)]
  }
  const parts = splitPath(clean)
  return /^[\\/]/.test(clean) ? ["/", ...parts] : parts
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base", numeric: true })

function emit<F extends { path: string }>(dir: Dir<F>, depth: number, parent = ""): EditedFileTreeNode<F>[] {
  const out: EditedFileTreeNode<F>[] = []
  for (const name of [...dir.dirs.keys()].sort(byName)) {
    let node = dir.dirs.get(name)!
    let label = name
    // Collapse the chain: a directory whose only content is one directory lends its name to that
    // child and disappears as a row. The `/` root never joins — `/Users` reads, `//Users` does not;
    // the `~` root joins like any name, `~/.claude`.
    while (node.files.size === 0 && node.dirs.size === 1) {
      const [childName, child] = [...node.dirs.entries()][0]
      label = label === "/" ? `/${childName}` : `${label}/${childName}`
      node = child
    }
    const path = parent === "" || parent === "/" ? `${parent}${label}` : `${parent}/${label}`
    out.push({ kind: "dir", name: label, path, depth, children: emit(node, depth + 1, path) })
  }
  for (const name of [...dir.files.keys()].sort(byName)) {
    out.push({ kind: "file", name, depth, file: dir.files.get(name)! })
  }
  return out
}

export function editedFileTree<F extends { path: string } = EditedFile>(files: readonly F[], projectDir?: string, homeDir?: string): EditedFileTreeNode<F>[] {
  const root = newDir<F>()
  for (const file of files) {
    const segments = editedFileSegments(file.path, projectDir, homeDir)
    if (segments.length === 0) continue
    let dir = root
    for (const segment of segments.slice(0, -1)) {
      let next = dir.dirs.get(segment)
      if (!next) {
        next = newDir<F>()
        dir.dirs.set(segment, next)
      }
      dir = next
    }
    dir.files.set(segments[segments.length - 1], file)
  }
  return emit(root, 0)
}

// The tree in row order — what the rail renders, top to bottom.
export function flattenEditedFileTree<F extends { path: string }>(nodes: readonly EditedFileTreeNode<F>[]): EditedFileTreeNode<F>[] {
  const out: EditedFileTreeNode<F>[] = []
  const walk = (list: readonly EditedFileTreeNode<F>[]) => {
    for (const node of list) {
      out.push(node)
      if (node.kind === "dir") walk(node.children)
    }
  }
  walk(nodes)
  return out
}
