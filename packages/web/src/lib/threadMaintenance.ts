import type { ThreadView } from "@frizz/shared"

// WHEN THE WORKER-MAINTENANCE VERB APPLIES, stated once. The desktop header draws it as an icon
// (RestartWorkerButton) and the phone's ⋯ sheet draws it as a row; both read this predicate, so the
// phone can never offer a verb the header would hide, or the reverse.

/** Restart worker: a live Claude worker frizz owns, on a dev build of frizz only. */
export function offersRestartWorker(thread: ThreadView, devBuild: boolean): boolean {
  if (!devBuild) return false
  if (thread.kind !== "session" || thread.foreign) return false
  if (thread.backend === "codex" || thread.backend === "acp" || thread.backend === "opencode") return false
  return thread.runtime !== "exited"
}
