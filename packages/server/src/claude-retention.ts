// HOW LONG CLAUDE CODE KEEPS A TRANSCRIPT, which is how long a Claude thread in Frizz keeps its history.
//
// A Claude thread's conversation is Claude Code's own session file (~/.claude/projects/<cwd>/<id>.jsonl),
// and Claude Code deletes every session file that has gone unwritten for `cleanupPeriodDays` days (30 by
// default) each time any Claude Code process starts — a Frizz worker included. Frizz keeps the thread's
// row, its questions and its done card in its own database, so an idle thread outlives its history and
// opened on "No conversation yet." with nothing to say why. Measured on one machine on 2026-11-13: 496 of
// 920 Claude threads had lost their transcript this way, and the oldest surviving file in every project
// bucket was exactly 30 days old.
//
// THE SWEEP IS MACHINE-WIDE. Read from Claude Code 2.1.296 (2026-11-14): the startup sweep walks EVERY
// bucket under `projects/`, with the period from the merged settings of the process doing the sweeping.
// So a project's `.claude/settings.json` only decides what a process started in that project deletes —
// everywhere — and a `claude` started in any other directory still sweeps this project's files on the
// managed and user settings alone. Two readings follow:
//   - the MACHINE period (managed, then user) is what every Claude Code process on the machine applies,
//     so it is what the launcher warns about: the directory a launch happens in decides nothing, since one
//     Frizz serves every project;
//   - a THREAD's file is gone once it is older than the shorter of that and its own project's period
//     (managed, local, project, user — claudeSettingsFiles, the scopes a worker there loads).
//
// The period is configurable, so it is READ, never assumed, and Claude Code's own refusals are mirrored:
// it accepts only a positive integer, and when a settings file cannot be parsed, or one sets
// `cleanupPeriodDays` to something it rejects, it PAUSES the sweep altogether ("Transcript retention
// cleanup is paused until the settings errors above are fixed") unless a managed file sets a valid value.
// A paused sweep deletes nothing, so it reads here as null: no notice, no warning.

import { readFileSync } from "node:fs"
import { CLAUDE_MANAGED_SETTINGS_PATHS, claudeSettingsFiles, claudeUserSettingsFile, type ClaudeSettingsLocations } from "./command-watch.ts"

export { claudeUserSettingsFile }

/** Claude Code's own default, used when no settings file sets `cleanupPeriodDays`. */
export const CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS = 30

/** Below this, the launcher warns that idle threads will lose their history. Three months covers a thread
 *  left open over a holiday or a long review cycle; the warning names the value, so a deliberate short
 *  period reads as a reminder rather than an error. */
export const CLAUDE_RETENTION_WARN_BELOW_DAYS = 90

/** The value Claude Code suggests itself for "keep transcripts a long time" (~10 years). */
export const CLAUDE_SUGGESTED_CLEANUP_PERIOD_DAYS = 3650

export interface ClaudeTranscriptRetention {
  days: number
  /** The settings file that set it; null when none does and Claude Code's default applies. */
  source: string | null
  /** Set when `source` is a managed file: an organization's policy, which no user scope overrides. */
  managed?: true
}

/** Where to read: `cwd` adds that project's local and project scopes to the machine-wide ones. */
export type ClaudeRetentionLocations = Omit<ClaudeSettingsLocations, "cwd"> & { cwd?: string }

type ScopeReading = { kind: "absent" } | { kind: "unset" } | { kind: "days"; days: number } | { kind: "refused" }

function readScope(file: string): ScopeReading {
  let raw: string
  try {
    raw = readFileSync(file, "utf8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    // A file Claude Code cannot read either is one it cannot see a period in: it pauses the sweep.
    return code === "ENOENT" || code === "ENOTDIR" ? { kind: "absent" } : { kind: "refused" }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: "refused" }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { kind: "unset" }
  const days = (parsed as Record<string, unknown>).cleanupPeriodDays
  if (days === undefined) return { kind: "unset" }
  // Claude Code's schema: `z.number().int().positive()`.
  return typeof days === "number" && Number.isInteger(days) && days >= 1 ? { kind: "days", days } : { kind: "refused" }
}

/** One process's effective period over `files`, highest precedence first; null when its sweep is paused. */
function periodOver(files: readonly string[], managed: readonly string[]): ClaudeTranscriptRetention | null {
  let first: ClaudeTranscriptRetention | undefined
  let refused = false
  for (const file of files) {
    const reading = readScope(file)
    if (reading.kind === "refused") refused = true
    else if (reading.kind === "days" && !first) first = { days: reading.days, source: file, ...(managed.includes(file) ? { managed: true as const } : {}) }
  }
  // A managed value is honoured whatever else is wrong; anything else waits on the broken file.
  if (first?.managed) return first
  if (refused) return null
  return first ?? { days: CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS, source: null }
}

/** The period after which Claude Code deletes an idle transcript, or null when its sweep is paused. With
 *  `cwd`, the shorter of the machine-wide period and that project's own (see the header). */
export function claudeTranscriptRetention(where: ClaudeRetentionLocations): ClaudeTranscriptRetention | null {
  const managed = where.managedPaths ?? CLAUDE_MANAGED_SETTINGS_PATHS
  const machine = periodOver([...managed, claudeUserSettingsFile(where)], managed)
  if (!machine || where.cwd === undefined) return machine
  const project = periodOver(claudeSettingsFiles({ ...where, cwd: where.cwd }), managed)
  return project && project.days < machine.days ? project : machine
}

/** The launcher's warning, or undefined when the period is long enough (or the sweep paused). */
export function claudeRetentionWarning(
  retention: ClaudeTranscriptRetention | null,
  userSettingsFile: string,
  displayPath: (path: string) => string = (p) => p,
): string | undefined {
  if (!retention || retention.days >= CLAUDE_RETENTION_WARN_BELOW_DAYS) return undefined
  const period = `${retention.days} ${retention.days === 1 ? "day" : "days"}`
  if (retention.managed) {
    return `Claude Code deletes a thread's history ${period} after its last activity (cleanupPeriodDays in ${displayPath(retention.source!)}, set by your organization).`
  }
  const where = retention.source ? `cleanupPeriodDays in ${displayPath(retention.source)}` : "Claude Code's default cleanupPeriodDays"
  return `Claude Code deletes a thread's history ${period} after its last activity (${where}). Set "cleanupPeriodDays": ${CLAUDE_SUGGESTED_CLEANUP_PERIOD_DAYS} in ${displayPath(userSettingsFile)} to keep it.`
}
