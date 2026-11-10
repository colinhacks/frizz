import type { BgShellView, HumanTodo, SubAgentView, ThreadLinkView, ThreadView, ThreadWatchView } from "@frizz/shared"
import { mergeBackgroundShells, visibleChildOps, type TranscriptShellRecord } from "./childOps.ts"

/** WHAT A THREAD HAS RUNNING, WATCHED OR SAVED — one answer for every place that lists it: the line of
 *  counts over the prompt box (lib/queueOpsCounts), the panel each count opens (QueueSubAgentLines,
 *  BackgroundOpsStrip), and the full-screen page's rail (FocusRail). Those picked their rows by rules of
 *  their own until 2026-10-14, and the rules had drifted: the rail had learned to leave out an archived
 *  thread's watches and every watch no longer armed, while the line over the prompt box and its panels
 *  went on counting and listing both. */
export interface ThreadOps {
  /** What the worker has handed the human to do, across the whole thread (server human-todos.ts). */
  todos: readonly HumanTodo[]
  /** Every child still unresolved — running, rested or stale — at every depth (visibleChildOps "card"). */
  agents: readonly SubAgentView[]
  /** The CHILD THREADS this thread started (`frizzctl spawn-child`) that are still open, oldest first —
   *  threads of their own, drawn under this one rather than in any band (lib/childThreads). */
  children: readonly ThreadView[]
  /** The board's shells and the transcript's, one row per process (mergeBackgroundShells). */
  shells: readonly BgShellView[]
  prs: readonly ThreadWatchView[]
  issues: readonly ThreadWatchView[]
  commands: readonly ThreadWatchView[]
  timers: readonly ThreadWatchView[]
  /** What the worker saved for the human (`frizzctl link`), split by kind. */
  files: readonly ThreadLinkView[]
  links: readonly ThreadLinkView[]
}

/** `transcriptShells` are the shells read off the transcript, whose Codex background execs the board
 *  reports none of (lib/transcriptShells); every caller passes them. `children` are the thread's child
 *  threads, which are other rows of the board rather than fields of this one, so the caller reads them
 *  (hooks.ts useChildThreads, the same list the rail's rows under the thread draw).
 *
 *  A WATCH IS LISTED WHILE IT IS ARMED AND ITS THREAD IS NOT ARCHIVED. An archived thread watches nothing,
 *  though its registrations stay armed for the day it is reopened: the scheduler neither fires its timers
 *  nor polls its PRs and issues (scheduler.ts evalTimers, and the per-watcher liveness skip). Rowed, a
 *  past-due timer read "firing…" forever and a PR row froze on its last reading. A SHELL watch
 *  is never a row of its own: the shell it waits on is already one, and listing the watch too would name
 *  one process twice (2026-08-14); it is marked on that shell's row instead (shellWatched). */
export function threadOps(
  thread: ThreadView,
  transcriptShells: readonly (BgShellView & TranscriptShellRecord)[] = [],
  children: readonly ThreadView[] = [],
): ThreadOps {
  const armed = listedWatches(thread)
  const github = armed.filter((watch) => watch.kind === "github")
  const saved = thread.links ?? []
  return {
    todos: thread.humanTodos ?? [],
    agents: visibleChildOps(thread.subAgents ?? [], "card"),
    children,
    shells: mergeBackgroundShells(thread.bgShells ?? [], transcriptShells),
    prs: github.filter((watch) => watch.subject !== "issue"),
    issues: github.filter((watch) => watch.subject === "issue"),
    commands: armed.filter((watch) => watch.kind === "command"),
    timers: armed.filter((watch) => watch.kind === "timer"),
    files: saved.filter((link) => link.kind === "file"),
    links: saved.filter((link) => link.kind === "link"),
  }
}

// The watches a thread is listed as waiting on — see threadOps.
function listedWatches(thread: ThreadView | undefined): ThreadWatchView[] {
  if (!thread || thread.state === "archived") return []
  return (thread.watches ?? []).filter((watch) => watch.state === "armed")
}

/** WILL THE THREAD HEAR ABOUT THIS SHELL? Yes when a listed `shell` watch names it — by its task id, its
 *  id or its label, whichever the worker registered it by. The answer rides the shell's own row, as its
 *  tooltip's last line (SHELL_WATCHED_NOTE), wherever the row is drawn: the ops strip and the full-screen
 *  rail. See BackgroundOpsStrip for why it is worth a line. */
export function shellWatched(thread: ThreadView | undefined): (shell: { id?: string; taskId?: string; label: string }) => boolean {
  const targets = new Set(listedWatches(thread).filter((watch) => watch.kind === "shell").map((watch) => watch.target))
  return (shell) => targets.has(shell.taskId ?? "") || targets.has(shell.id ?? "") || targets.has(shell.label)
}

export const SHELL_WATCHED_NOTE = "Watched — this thread wakes when it finishes"
