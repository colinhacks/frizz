import { realpathSync } from "node:fs"
import { homedir } from "node:os"
import { isAbsolute } from "node:path"
import { findById, findByPath } from "./project-registry.ts"
import { discoverProjectRoot, hasProjectMarker, isExistingProjectRoot, isHomeDirectory } from "./project-root.ts"

/**
 * WHERE A LAUNCH LANDS — the rules about folders, kept where a server release can change them.
 *
 * `frizz` typed in a folder is a question: is this a project Frizz knows, one to offer, or neither?
 * The launcher answered it itself until this module, from its own bundled copy of the registry and
 * project-root code, so every change to the answer needed a `frizz` shell release — four of the
 * seven between 2026-10-01 and 2026-10-11, at hours each in npm's review — while the same rule in a
 * running server had changed minutes after it landed. The launcher now ASKS the running server
 * (`POST /_frizz/control/launch`, app.ts) and keeps its own copy only for a server that predates the
 * route. plans/server-side-launch-routing.md has the whole design.
 */

/** The request and the answer are versioned together; a launcher refuses an answer it cannot read. */
export const LAUNCH_ROUTE_PROTOCOL = 1

/** Under `/_frizz`. `control` is already reserved as a project name, so no project can take it. */
export const LAUNCH_ROUTE_PATH = "/control/launch"

/** A capability only the OS user who started Frizz can read: the same header `/control/stop` takes. */
export const LAUNCH_TOKEN_HEADER = "x-frizz-launch-token"

export interface LaunchRouteRequest {
  protocol: typeof LAUNCH_ROUTE_PROTOCOL
  /** The folder the command was typed in, exactly as the launcher saw it. */
  dir: string
  /** Positional arguments the launcher did not consume. Nothing reads them yet. */
  args?: string[]
  /** A `--sandbox` launch: a throwaway home, where a notice about keeping history does not apply. */
  sandbox?: boolean
}

export interface LaunchRoute {
  /** Where the browser lands, relative to the origin the launcher already holds. Always starts `/`. */
  path: string
  /** The project this launch opened, for the launcher's readout. */
  project?: { name: string; dir: string }
  /** One line for the launcher to print. */
  notice?: string
  /**
   * More lines for the launcher to print, written by the server (launch-notices.ts) so that a new one
   * ships in a server release. A launcher from before this field reads `notice` alone.
   */
  notices?: string[]
}

export type LaunchKind =
  /** A folder Frizz already knows: it opens as itself. */
  | { kind: "open"; root: string }
  /** A folder that looks like a project and is not one yet: the dashboard asks before adopting it. */
  | { kind: "offer"; directory: string }
  /** Anything else: the dashboard. */
  | { kind: "grid" }

/**
 * What a launch in `dir` is about. Pure: it reads the folder and the registry and writes nothing.
 *
 * A directory Frizz already knows opens as itself — including one it knows only from the registry,
 * so forgetting to commit `.frizz/.id` never costs someone their board. Running the command never
 * ADOPTS the folder it was run in, and $HOME is never a project however many markers it carries.
 */
export function classifyLaunch(dir: string, home = homedir()): LaunchKind {
  const candidate = realpathSync(discoverProjectRoot(dir, home))
  const refused = isHomeDirectory(candidate, home)
  if (!refused && (isExistingProjectRoot(candidate) || findByPath(candidate, home) !== undefined)) {
    return { kind: "open", root: candidate }
  }
  return !refused && hasProjectMarker(candidate) ? { kind: "offer", directory: candidate } : { kind: "grid" }
}

/** `?add=` is a REQUEST, not a registration — nothing on disk changes until the operator confirms. */
export function offerPath(directory: string): string {
  return `/?add=${encodeURIComponent(directory)}`
}

/**
 * Answer a launch: classify the folder, and for one Frizz knows, open it — which registers it.
 *
 * `open` is the server's own project resolver (project.ts resolveProject): the Git top level, a
 * linked worktree's own identity, the id file, the registry entry, and the re-mint for a copied
 * checkout. It is injected because this module is also bundled into the launcher, which must not
 * pull the whole server in for a classification.
 *
 * A folder that cannot be opened — a repository Git cannot read — lands on the dashboard with the
 * reason, where the launcher used to die with it: the server is already up, and the dashboard is
 * where every other project still is.
 */
export function routeLaunch(
  dir: string,
  open: (dir: string) => { id: string; dir: string; name: string },
  home = homedir(),
): LaunchRoute {
  const launch = classifyLaunch(dir, home)
  if (launch.kind === "grid") return { path: "/" }
  if (launch.kind === "offer") return { path: offerPath(launch.directory) }
  let project: { id: string; dir: string; name: string }
  try {
    project = open(dir)
  } catch (error) {
    return { path: "/", notice: `Could not open ${launch.root}: ${error instanceof Error ? error.message : String(error)}` }
  }
  // The registry is an index, and a project it could not record still has a board — but no name to
  // address it by, and under a server hosted on Frizz's own folder nothing else leads to it.
  const slug = findById(project.id, home)?.slug
  if (!slug) return { path: "/", notice: `Could not add ${project.dir} to the project list.` }
  return { path: `/project/${slug}`, project: { name: project.name, dir: project.dir } }
}

/** Read a request body, or say what is wrong with it. */
export function parseLaunchRouteRequest(body: unknown): LaunchRouteRequest | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "expected a JSON object" }
  const { protocol, dir, args, sandbox } = body as Record<string, unknown>
  if (protocol !== LAUNCH_ROUTE_PROTOCOL) return { error: `unsupported launch protocol ${String(protocol)}` }
  if (typeof dir !== "string" || dir.length === 0 || dir.length > 4096 || !isAbsolute(dir)) return { error: "dir must be an absolute path" }
  if (args !== undefined && !(Array.isArray(args) && args.length <= 64 && args.every((arg) => typeof arg === "string" && arg.length <= 4096)))
    return { error: "args must be a short list of strings" }
  if (sandbox !== undefined && typeof sandbox !== "boolean") return { error: "sandbox must be true or false" }
  return { protocol: LAUNCH_ROUTE_PROTOCOL, dir, ...(args ? { args: args as string[] } : {}), ...(sandbox ? { sandbox } : {}) }
}

/**
 * Read an answer on the launcher's side. Undefined for anything it should not act on: another
 * protocol, or a path that is not a plain same-origin path — an answer is appended to the origin and
 * handed to a browser, so `//elsewhere` and `/\elsewhere` are refused rather than followed.
 */
export function parseLaunchRoute(body: unknown): LaunchRoute | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined
  const { protocol, path, project, notice, notices } = body as Record<string, unknown>
  if (protocol !== LAUNCH_ROUTE_PROTOCOL || typeof path !== "string") return undefined
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || /[\u0000-\u001f]/u.test(path)) return undefined
  const named = project && typeof project === "object" ? (project as Record<string, unknown>) : undefined
  return {
    path,
    ...(named && typeof named.name === "string" && typeof named.dir === "string" ? { project: { name: named.name, dir: named.dir } } : {}),
    ...(typeof notice === "string" && notice.length > 0 ? { notice: notice.slice(0, 500) } : {}),
    ...(Array.isArray(notices) ? listedNotices(notices) : {}),
  }
}

/** A server's extra lines, as many as a readout has room for, each as long as `notice` may be. */
function listedNotices(notices: unknown[]): { notices?: string[] } {
  const lines = notices.filter((line): line is string => typeof line === "string" && line.length > 0).slice(0, 8).map((line) => line.slice(0, 500))
  return lines.length > 0 ? { notices: lines } : {}
}
