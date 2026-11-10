import type { AppContext, ContextOptions } from "./context.ts"
import { projectContextCleanups } from "./context.ts"
import type { Project } from "./project.ts"
import { log as frizzLog } from "./logging.ts"

// ONE PROCESS, N PROJECTS.
//
// `startServer` used to build exactly one AppContext and tear it down at process exit. That is the
// assumption plans/singleton-frizz.md §4 item 2 calls out: there was no way to open a second project,
// and no way to close one without closing the server.
//
// This is the keyed map that replaces it — projectId → AppContext, with activate/deactivate. The
// AppContext itself needed no changes to get here: it is already a per-call object, documented as
// "derived once at boot and threaded through", with zero `process.chdir`, zero `process.env`
// mutation, and every module-level cache keyed by absolute path or genuinely machine-global.
//
// THE ERROR BOUNDARY LIVES HERE (§4 item 3). Per-subsystem guards are already good — tailer ticks,
// board rebuilds, `fs.watch` setup and transcript discovery are each individually caught. What was
// missing is a catch at the AppContext SEAM, so one project's malformed `.frizz/` (or, until the
// unified database of 2026-08-27, its own corrupt `ui.db`) cannot take down every other project in a
// shared process. `activate` therefore reports and returns
// undefined rather than throwing: a project that will not open is one dead card, not an outage.

export interface TenantMapOptions<App = unknown> {
  /** Builds the HTTP app for a tenant. Without it the map holds contexts only. */
  createApp?: (ctx: AppContext) => App
  /**
   * Close what createApp built. Runs FIRST in a deactivation, before any of the context's own
   * subsystems: a transport still serving a board whose storage has just closed is the one ordering
   * that produces errors instead of a clean stop.
   */
  closeApp?: (app: App) => void | Promise<void>
  /**
   * Start the project's producers — board, tailer, scheduler — the way boot starts the launching
   * project's.
   *
   * Without this an activated project is a STATIC board: the RPC reads storage directly so threads
   * render, which is exactly why the omission looks like it works. But nothing tails the transcripts,
   * so the board never updates as agents work, and nothing runs the scheduler, so that project's
   * timers, awaiting wakes, snooze expiry and PR watches stay dead until the process restarts with it
   * as the launcher. Supplied by the caller rather than done here, because which producers exist and
   * whether wakes are armed are the server's business, not the map's.
   */
  startProducers?: (ctx: AppContext) => void | Promise<void>
  /**
   * Runs LAST in a deactivation, once the project's scheduler and storage are closed — where the
   * server gives up its claim on the project (project-serving.ts), so no second server can open it
   * while this one could still fire a timer.
   */
  afterDeactivate?: (project: Project) => void
  /** Injected so a test can build a context without the real one. Defaults to `createContext`. */
  createContext: (opts: ContextOptions) => AppContext | Promise<AppContext>
  /** Extra options every tenant's context is built with (claudeBin, codexBin, …). */
  contextOptions?: Omit<ContextOptions, "project">
  onError?: (project: Project, error: unknown) => void
}

export interface TenantMap<App = unknown> {
  /**
   * Open a project, or return the already-open one. `undefined` means it failed and was reported.
   * An open project handed in at a DIFFERENT `dir` is a moved checkout: it is closed and reopened there.
   */
  activate(project: Project): Promise<AppContext | undefined>
  /**
   * Take ownership of a context somebody else built.
   *
   * The project the server was LAUNCHED from is built by startServer's own boot phases, because its
   * failure is a boot failure — it must roll back and abort, not be caught and reported as one dead
   * card the way an additional project is. Adopting the result afterwards makes it addressable here
   * without moving that boot path, and without giving `activate` a second failure mode.
   */
  adopt(project: Project, ctx: AppContext, app?: App): AppContext
  /** The HTTP app for an OPEN project, if one was built. */
  appFor(projectId: string): App | undefined
  get(projectId: string): AppContext | undefined
  /** Close one project's resources while every other project keeps serving. */
  deactivate(projectId: string): Promise<boolean>
  /** Every open project, in activation order. */
  active(): { project: Project; ctx: AppContext; app?: App }[]
  closeAll(): Promise<void>
}

export function createTenantMap<App = unknown>(options: TenantMapOptions<App>): TenantMap<App> {
  const open = new Map<string, { project: Project; ctx: AppContext; app?: App }>()
  // An activation in flight, so two concurrent openings of one project build ONE context rather than
  // two racing SQLite handles onto the same file.
  const opening = new Map<string, Promise<AppContext | undefined>>()

  const report = (project: Project, error: unknown): void => {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error)
    frizzLog.error("tenants", `project ${project.name} (${project.id}) failed to open: ${detail}`)
    options.onError?.(project, error)
  }

  async function activate(project: Project): Promise<AppContext | undefined> {
    const already = open.get(project.id)
    // THE SAME PROJECT AT A DIFFERENT PATH IS A MOVED CHECKOUT, and the open context is wrong about
    // where it lives. Identity is the id in the tree, so a rename or `mv` keeps every thread — but the
    // context was built with the old `project.dir`, and every dispatch, scratch write and realpath on it
    // fails with ENOENT against a directory that is no longer there (2026-09-18: `hypergres` renamed to
    // `porg`, registry updated by the reopen, tenant still holding the old path, first dispatch dead
    // on `lstat '/…/hypergres'`). Close it and open it again where the registry now says it is. The
    // workers are detached daemons and survive exactly as they do a restart.
    if (already && already.project.dir === project.dir) return already.ctx
    const inFlight = opening.get(project.id)
    if (inFlight) return inFlight

    const attempt = (async () => {
      try {
        if (already) {
          frizzLog.info("tenants", `project ${project.name} (${project.id}) moved from ${already.project.dir} to ${project.dir}; reopening it there`)
          // Synchronously drops the entry from `open` before its first await, and `opening` is set the
          // moment this function yields — so a concurrent activate joins this attempt rather than
          // racing a second context onto the same database.
          await deactivate(project.id)
        }
        // Copied by descriptor, not spread: a spread reads each getter once, and `claudeBin` is a getter
        // because the Claude Code a server runs can move while it serves (claude-float.ts).
        const ctx = await options.createContext(Object.defineProperties({}, {
          ...Object.getOwnPropertyDescriptors(options.contextOptions ?? {}),
          project: { value: project, enumerable: true, writable: true, configurable: true },
        }) as ContextOptions)
        open.set(project.id, { project, ctx, app: options.createApp?.(ctx) })
        // Inside the try on purpose: a producer that fails to start is reported through the same seam
        // as a context that fails to open, and must not end a process serving other projects.
        await options.startProducers?.(ctx)
        return ctx
      } catch (error) {
        // THE SEAM. createContext already rolls its own partial resources back; what must not happen
        // is the failure propagating out and ending a process that is serving other projects.
        report(project, error)
        return undefined
      }
    })()
    opening.set(project.id, attempt)
    // Cleared once the attempt SETTLES, never from inside it: an attempt that fails before its first
    // await (a createContext that throws synchronously) has already settled by the time the line above
    // runs, and a `finally` in there would clear the entry before it was set — leaving a settled
    // failure that every later activate of this project would be handed.
    void attempt.then(() => {
      if (opening.get(project.id) === attempt) opening.delete(project.id)
    })
    return attempt
  }

  async function deactivate(projectId: string): Promise<boolean> {
    const entry = open.get(projectId)
    if (!entry) return false
    // Drop it from the map FIRST: a deactivation that fails half way must not leave a context
    // reachable that has already had its storage closed.
    open.delete(projectId)
    const cleanups = projectContextCleanups(() => entry.ctx)
    // The same order the process barrier uses, with this tenant's own transports at the front.
    for (const [name, run] of [
      ["transports", async () => { if (entry.app !== undefined) await options.closeApp?.(entry.app) }],
      ["tailer", cleanups.tailer],
      ["subscriptions", cleanups.subscriptions],
      ["scheduler", cleanups.scheduler],
      ["board", cleanups.board],
      ["Codex app-server bridge", cleanups.bridge],
      ["storage", cleanups.storage],
    ] as const) {
      try {
        await run()
      } catch (error) {
        // Keep going. A stuck subsystem must not strand the ones after it — storage above all, which
        // is the one whose handle actually has to be released.
        const detail = error instanceof Error ? error.message : String(error)
        frizzLog.error("tenants", `project ${entry.project.name}: ${name} did not close cleanly: ${detail}`)
      }
    }
    try {
      options.afterDeactivate?.(entry.project)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      frizzLog.error("tenants", `project ${entry.project.name}: could not record that it closed: ${detail}`)
    }
    return true
  }

  return {
    activate,
    adopt(project, ctx, app) {
      open.set(project.id, { project, ctx, app })
      return ctx
    },
    appFor: (projectId) => open.get(projectId)?.app,
    get: (projectId) => open.get(projectId)?.ctx,
    deactivate,
    active: () => [...open.values()],
    async closeAll() {
      for (const id of [...open.keys()]) await deactivate(id)
    },
  }
}
