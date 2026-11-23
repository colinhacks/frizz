import { homedir } from "node:os"
import { claudeRetentionWarning, claudeTranscriptRetention, claudeUserSettingsFile, type ClaudeRetentionLocations } from "./claude-retention.ts"
import type { LaunchRouteRequest } from "./launch-routing.ts"

/**
 * The lines a launch's readout prints about this machine, answered with the launch route (app.ts).
 *
 * The launcher wrote them itself until 2026-11-23, so one new line cost a `frizz` shell release: 0.13.21
 * was the Claude Code retention warning alone (plans/shell-release-cadence.md). Here a new line ships in
 * a server release. The launcher never imports this module, so what it reads stays out of the shell.
 */
export function launchNotices(
  request: Pick<LaunchRouteRequest, "sandbox">,
  where: Pick<ClaudeRetentionLocations, "home" | "env" | "managedPaths"> = {},
): string[] {
  // A sandbox's home is deleted when it exits, so it has no history worth keeping.
  if (request.sandbox) return []
  // Claude Code deletes an idle session's file after `cleanupPeriodDays`, and with it the thread's whole
  // conversation; Frizz cannot keep it, only say so while there is still time to raise the period. The
  // machine-wide period: one Frizz serves every project, and the sweep deletes every project's files.
  const home = where.home ?? homedir()
  const retention = claudeRetentionWarning(claudeTranscriptRetention({ ...where, home }), claudeUserSettingsFile({ ...where, home }), (path) => tildePath(path, home))
  return retention ? [retention] : []
}

/** `~/…` for a path under the home folder, as the launcher's readout writes every other path. */
function tildePath(path: string, home: string): string {
  if (!path.startsWith(home)) return path
  const rest = path.slice(home.length)
  return rest === "" ? "~" : /^[\\/]/.test(rest) ? `~${rest}` : path
}
