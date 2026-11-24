import type { CodexModel } from "@frizz/shared"
import type { ProfileGridGroup, ProfileGridOption } from "./profileGrid.ts"

// CODEX IN THE MODEL MENU. ~/.codex/models_cache.json keeps older generations visible alongside their
// replacements (e.g. gpt-6.2-sol, gpt-6.1-sol, gpt-6-sol and gpt-5.6-sol all carry visibility "list").
// Putting every listed slug directly in the effort matrix crowds out the frontier rows, so we keep the
// newest version of each Codex line (Sol, Astra, Terra, Luna, …) in the grid and fold superseded older
// versions into an expandable "Other models" submenu (and collapsible section on phone), matching
// Antigravity's fallback row.

const CODEX_LINE_PATTERN = /^([a-z]+)-?(\d+(?:\.\d+)*)(?:-(.+))?$/i

export interface ParsedCodexLine {
  /** Normalized line key shared across versions of the same tier (e.g. "gpt:sol", "gpt:astra", "gpt:"). */
  line: string
  /** Numeric version segments, most-significant first (e.g. "6.2" → [6, 2], "6" → [6]). */
  version: number[]
}

/** Parse a Codex model slug into its line key and version tuple, or undefined for an unversioned slug. */
export function parseCodexLine(slug: string): ParsedCodexLine | undefined {
  const match = CODEX_LINE_PATTERN.exec(slug.trim())
  if (!match) return undefined
  const prefix = match[1]!.toLowerCase()
  const version = match[2]!.split(".").map((part) => Number(part))
  if (version.some((n) => !Number.isFinite(n))) return undefined
  const variant = (match[3] ?? "").toLowerCase()
  return { line: `${prefix}:${variant}`, version }
}

/** Compare two version tuples numerically, treating omitted trailing parts as 0 (so 6.2 > 6.1 > 6 > 5.6). */
export function compareCodexVersions(a: readonly number[], b: readonly number[]): number {
  const length = Math.max(a.length, b.length)
  for (let i = 0; i < length; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

/** Split Codex options into frontier rows (newest version of each line, plus any unversioned slugs) and
 *  superseded older versions, preserving the catalogue's priority order within each bucket. */
export function partitionCodexOptions<T extends { model: string }>(options: readonly T[]): {
  primary: T[]
  more: T[]
} {
  const parsed = options.map((option) => ({ option, info: parseCodexLine(option.model) }))
  const latestByLine = new Map<string, number[]>()
  for (const { info } of parsed) {
    if (!info) continue
    const best = latestByLine.get(info.line)
    if (!best || compareCodexVersions(info.version, best) > 0) {
      latestByLine.set(info.line, info.version)
    }
  }
  const primary: T[] = []
  const more: T[] = []
  for (const { option, info } of parsed) {
    if (!info) {
      primary.push(option)
      continue
    }
    const best = latestByLine.get(info.line)!
    if (compareCodexVersions(info.version, best) >= 0) primary.push(option)
    else more.push(option)
  }
  return { primary, more }
}

/** Build the Codex menu group from ProfileGridOptions (shared by dispatch and live Codex threads). */
export function codexProfileGroup({ options, signedOut }: {
  options: readonly ProfileGridOption[]
  signedOut?: boolean
}): ProfileGridGroup {
  const { primary, more } = partitionCodexOptions(options)
  return {
    id: "codex",
    label: "Codex",
    ...(signedOut ? { signedOut: true } : {}),
    options: primary,
    ...(more.length ? { moreOptions: more, moreLabel: "Other models" } : {}),
  }
}

/** Build the Codex menu group directly from the codexModels RPC list. */
export function codexProfileGroupFromModels({ models, signedOut }: {
  models: readonly CodexModel[]
  signedOut?: boolean
}): ProfileGridGroup {
  return codexProfileGroup({
    signedOut,
    options: models.map((model) => ({
      model: model.slug,
      label: model.displayName,
      defaultEffort: model.defaultEffort,
      efforts: model.efforts,
    })),
  })
}
