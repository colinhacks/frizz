import { useEffect, useMemo } from "react"
import { useQuery } from "@tanstack/react-query"
import { subscribe } from "valtio"
import type { ProjectCard } from "@frizz/shared"
import { rpc, rpcFor, type Api } from "../api/rpc.ts"
import { apiBase, isConsolePath, projectApiBase } from "./base-path.ts"
import { setConsoleProjects } from "../api/consoleFeed.ts"
import { store } from "../store.ts"
import { setProjectPathBases } from "./localPathBase.ts"

// WHICH PROJECTS THE CONSOLE SHOWS — every project the server has OPEN, in the rail's order.
//
// "Open" is the rail's own reading (`projectsRailCounts` answers for exactly the projects with a board
// on the server, keyed by id), so the Console never opens a project's connection out of the server's
// paced start-up (server/tenant-prime.ts): a project it has not opened yet joins on the next poll. A
// project whose directory is gone has no board worth showing and is left out. Both reads are machine-wide
// (lib/queryKeyScope.ts), so the rail and the Console share one copy of each.

export interface ConsoleProjects {
  /** Open projects in rail order. */
  projects: ProjectCard[]
  bySlug: ReadonlyMap<string, ProjectCard>
  /** False until both reads have answered once. */
  ready: boolean
}

const NO_PROJECTS: ConsoleProjects = { projects: [], bySlug: new Map(), ready: false }

/**
 * `enabled` false reads nothing and ANSWERS nothing — for a component that renders on a project's page too.
 *
 * Turning the queries off is not enough for the second half. Both keys are machine-wide and the project rail,
 * the crumb and the projects page keep them filled, so a disabled query still hands back their cached list.
 * Until 2026-11-19 that put the Console's project chip on every project page's New thread dialog, naming the
 * remembered or first project ("docs" on mobile-app's board) while the thread started in the page's own.
 */
export function useConsoleProjectList(enabled = true): ConsoleProjects {
  const list = useQuery({ queryKey: ["projectsList"], queryFn: () => rpc.projectsList(), enabled })
  const counts = useQuery({ queryKey: ["projectsRailCounts"], queryFn: () => rpc.projectsRailCounts(), refetchInterval: 5_000, enabled })
  const openIds = counts.data ? Object.keys(counts.data).sort().join("\n") : null
  return useMemo(() => {
    if (!enabled) return NO_PROJECTS
    const open = new Set(openIds ? openIds.split("\n") : [])
    const projects = (list.data ?? []).filter((project) => !project.stale && open.has(project.id))
    return { projects, bySlug: new Map(projects.map((project) => [project.slug, project])), ready: list.data !== undefined && openIds !== null }
    // `openIds` is the set as a string, so a poll that answers the same projects keeps the same list.
  }, [enabled, list.data, openIds])
}

/** The Console's list, and the one place that points its feed at it. Mounted once, by the Console's route. */
export function useConsoleFeedProjects(): ConsoleProjects {
  const projects = useConsoleProjectList()
  const slugs = projects.projects.map((project) => project.slug).join("\n")
  useEffect(() => {
    if (projects.ready) setConsoleProjects(slugs ? slugs.split("\n") : [])
  }, [projects.ready, slugs])
  useEffect(() => {
    setFileProjects(projects.projects.map(({ slug, path }) => ({ slug, path })))
  }, [projects.projects])
  // Each project's directory is the base a relative path in ITS cards resolves against, and the home
  // (carried on the merged board, the one payload that has it) expands `~` — lib/localPathBase.ts. A
  // subscription rather than a snapshot, so the route does not re-render on every board change for a
  // value that is set once.
  useEffect(() => {
    const dirs = projects.projects.map(({ slug, path }) => [slug, path] as const)
    const sync = () => setProjectPathBases(dirs, store.board?.homeDir)
    sync()
    const unsubscribe = subscribe(store, sync)
    return () => {
      unsubscribe()
      setProjectPathBases([], "")
    }
  }, [projects.projects])
  return projects
}

let fileProjects: { slug: string; path: string }[] = []

/** The open projects `fileRpc` chooses among. Set by the Console's route; exported for tests. */
export function setFileProjects(projects: { slug: string; path: string }[]): void {
  fileProjects = projects
}

/**
 * The API to read or open a local FILE with. A file names no project, and the reads are not React (a
 * query factory, a click interceptor, a batched resolver), so on the Console the project is the one
 * whose directory holds the path — the deepest, for a project nested in another — or the first open
 * project for a path outside them all. Every project's file gate is the same home-rooted one
 * (server/local-file.ts), so for an absolute path any of them answers alike; the owner is preferred
 * because it is also the one a RELATIVE path is resolved against. On a project's page it is plain `rpc`.
 */
export function fileRpc(path?: string): Api {
  if (!isConsolePath()) return rpc
  const project = fileProject(path)
  return project ? rpcFor(project.slug) : rpc
}

function fileProject(path: string | undefined): { slug: string; path: string } | undefined {
  const owner = path
    ? fileProjects.filter((p) => path === p.path || path.startsWith(`${p.path}/`)).sort((a, b) => b.path.length - a.path.length)[0]
    : undefined
  return owner ?? fileProjects[0]
}

/**
 * A local file's bytes, through the `/local-file` route of the project `fileRpc` would ask: inline for a
 * PDF, a download for anything else (server/local-file.ts resolveServedLocalFile).
 */
export function localFileUrl(path: string): string {
  const project = isConsolePath() ? fileProject(path) : undefined
  return `${project ? projectApiBase(project.slug) : apiBase()}/local-file?path=${encodeURIComponent(path)}`
}
