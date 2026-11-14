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
// The period is configurable, so it is READ, never assumed: the same four scopes a Frizz worker loads
// (managed, local, project, user — claudeSettingsFiles), highest precedence first, and the first one that
// sets a usable value wins. Claude Code rejects anything below 1 (0 once silently disabled transcript
// writes altogether), so a value it would refuse is skipped here rather than reported.

import { readFileSync } from "node:fs"
import { claudeSettingsFiles, type ClaudeSettingsLocations } from "./command-watch.ts"

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
}

export function claudeTranscriptRetention(where: ClaudeSettingsLocations): ClaudeTranscriptRetention {
  for (const file of claudeSettingsFiles(where)) {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"))
    } catch {
      // Absent or unreadable: a file Frizz cannot read sets nothing it can report.
      continue
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue
    const days = (parsed as Record<string, unknown>).cleanupPeriodDays
    if (typeof days === "number" && Number.isFinite(days) && days >= 1) return { days, source: file }
  }
  return { days: CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS, source: null }
}

/** The launcher's warning, or undefined when the period is long enough to leave alone. */
export function claudeRetentionWarning(retention: ClaudeTranscriptRetention, displayPath: (path: string) => string = (p) => p): string | undefined {
  if (retention.days >= CLAUDE_RETENTION_WARN_BELOW_DAYS) return undefined
  const where = retention.source ? `cleanupPeriodDays in ${displayPath(retention.source)}` : "Claude Code's default cleanupPeriodDays"
  return `Claude Code deletes a thread's history ${retention.days} ${retention.days === 1 ? "day" : "days"} after its last activity (${where}). Set "cleanupPeriodDays": ${CLAUDE_SUGGESTED_CLEANUP_PERIOD_DAYS} in ~/.claude/settings.json to keep it.`
}
