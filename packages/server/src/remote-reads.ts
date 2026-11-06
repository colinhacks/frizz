import { realpathSync } from "node:fs"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import { frizzRoots, launchHostDir } from "./frizz-paths.ts"
import { isUnderRoot } from "./local-file.ts"
import { normalizeLocalPath } from "./local-path.ts"
import { listProjects } from "./project-registry.ts"

// ── WHAT A REMOTE CALLER MAY READ OFF THE DISK ──────────────────────────────────────────────────────
// A file route was a session's whole way to `~/.ssh`: the readers' roots include all of home, on the
// reasoning that anyone holding a session could dispatch a worker anyway. A remote session no longer can,
// so this is the boundary now, and it is narrower than the local one on purpose:
//
//   · registered project directories, which covers each thread's scratch under `.frizz/threads/`;
//   · the state root's attachment folders, and nothing else under any state root (`session-key`,
//     `identity.key` and `sessions.json` live there);
//   · below any of those, no dot-segment but `.frizz`, and no name that looks like a key.
//
// Judged on the path as asked AND where it really leads, so neither a symlink inside a project pointing
// out of it, nor a symlink named `.env`, gets through. The machine's own tab keeps the readers' roots.

const SECRET_NAME = new RegExp(
  "^(?:" + [
    "id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?",
    "credentials(?:\\..*)?",
    "secrets?(?:\\..*)?",
    "token(?:\\..*)?",
    "session-key",
    "sessions\\.json",
    "identity\\.key",
    "auth\\.json",
    "service-account.*\\.json",
    ".*\\.(?:pem|key|p12|pfx|keystore|jks|ppk|kdbx|tfstate|asc|gpg|token)",
  ].join("|") + ")$",
  "i",
)

function refusedSegment(segment: string): boolean {
  if (segment === "" || segment === ".frizz") return false
  return segment.startsWith(".") || SECRET_NAME.test(segment)
}

function refusedBelow(root: string, path: string): boolean {
  return relative(root, path).split(sep).some(refusedSegment)
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync(path)
  } catch {
    return null
  }
}

/** Where a state root's readable parts are: each project's attachments, and the host folder's thread scratch. */
function readableUnderStateRoots(real: string): string | undefined {
  const data = realOrNull(frizzRoots().data)
  if (!data) return undefined
  const projects = join(data, "projects")
  if (isUnderRoot(real, projects)) {
    const [id, kept] = relative(projects, real).split(sep)
    return id && kept === "attachments" ? join(projects, id, "attachments") : undefined
  }
  const scratch = realOrNull(join(launchHostDir(), ".frizz", "threads"))
  return scratch && isUnderRoot(real, scratch) ? scratch : undefined
}

/** The directories a board's remote readers may reach: every registered project, and the one it serves. */
export function remoteProjectDirs(current: string): string[] {
  return [current, ...listProjects().map((project) => project.path)]
}

/**
 * The real path of a file a remote caller may read, or null. `projectDirs` are the registered project
 * directories. One null for every refusal, so the answer says nothing about what exists.
 */
export function remoteReadablePath(rawPath: string, projectDirs: readonly string[]): string | null {
  const raw = normalizeLocalPath(rawPath)
  if (!isAbsolute(raw)) return null
  const real = realOrNull(raw)
  if (!real) return null
  const roots = frizzRoots()
  const underStateRoot = [roots.data, roots.state, roots.cache].some((root) => isUnderRoot(real, root))
  const root = underStateRoot ? readableUnderStateRoots(real) : projectDirs.find((dir) => isUnderRoot(real, dir))
  if (!root) return null
  const realRoot = realOrNull(root)
  if (!realRoot || refusedBelow(realRoot, real)) return null
  // The path as asked: a symlink's own name counts, whatever it points at. A path that reached this file
  // through an alias of the root (macOS `/tmp` for `/private/tmp`) has nothing further to say.
  const asked = resolve(raw)
  for (const base of [root, realRoot]) {
    if (isUnderRoot(asked, base, false) && refusedBelow(base, asked)) return null
  }
  return real
}
