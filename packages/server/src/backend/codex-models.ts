import { join } from "node:path"
import { readFileSync } from "node:fs"
import { CODEX_MODELS_FALLBACK, type CodexModel } from "@frizz/shared"
import { defaultCodexHome } from "./codex.ts"

export { CODEX_MODELS_FALLBACK } from "@frizz/shared"

// Read the Codex model catalogue + PER-MODEL reasoning-effort options from the local
// ~/.codex/models_cache.json written by Frizz's resolved runtime. Two live breakages proved a curated
// primary list untenable: (1) a bare `gpt-5.6` id → Codex 400s (the real ids are
// gpt-5.6-sol/terra/luna); (2) the effort set is PER-MODEL (sol/terra → low..ultra, luna → …max,
// 5.5 → …xhigh). `client_version` still has to match because every Codex install shares this one file.
//
// Schema (codex-cli 0.144.1): { fetched_at, etag, client_version, models: Model[] }. Each Model:
//   slug (the `-m` id) · display_name · visibility ("list"|"hide" — offer only "list") · priority (int,
//   sort ASC; 1 = default) · default_reasoning_level (e.g. "medium") · supported_reasoning_levels:
//   [{effort, description}]. supported_in_api is IGNORED for selection: Frizz launches Codex app-server,
//   not the Responses API, so an api=false-but-listed model like gpt-5.3-codex-spark is still selectable.

function cachePath(codexHome: string): string {
  return join(codexHome, "models_cache.json")
}

// Map one raw cache entry → CodexModel, or undefined to SKIP it (hidden, or missing the fields a
// selectable model needs). Defensive against every field being the wrong type — a malformed entry is
// dropped, never allowed to throw.
function toCodexModel(raw: unknown): { model: CodexModel; priority: number } | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const m = raw as Record<string, unknown>
  if (m.visibility !== "list") return undefined // "hide" (e.g. codex-auto-review) is never offered
  const slug = typeof m.slug === "string" ? m.slug : ""
  if (!slug) return undefined
  const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : []
  const efforts = levels
    .map((l) => (l && typeof l === "object" ? (l as Record<string, unknown>).effort : undefined))
    .filter((e): e is string => typeof e === "string" && e.length > 0)
  if (efforts.length === 0) return undefined // a model with no reasoning levels can't be dispatched coherently
  const displayName = typeof m.display_name === "string" && m.display_name ? m.display_name : slug
  const def = typeof m.default_reasoning_level === "string" ? m.default_reasoning_level : ""
  // The default effort MUST be one the model actually supports (so the dropdown can select it); fall
  // back to the first supported level when the cache's default is absent/unsupported.
  const defaultEffort = def && efforts.includes(def) ? def : efforts[0]!
  const priority = typeof m.priority === "number" && Number.isFinite(m.priority) ? m.priority : Number.MAX_SAFE_INTEGER
  // The window pair (`context_window` / `max_context_window`) feeds the Settings "Context window"
  // presets. Carried only when the cache has a usable number — a missing or junk field leaves the key
  // off rather than inventing a 0 the drawer would then offer as a preset.
  const window = (key: string): number | undefined => {
    const v = m[key]
    return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined
  }
  const contextWindow = window("context_window")
  const maxContextWindow = window("max_context_window")
  return {
    model: {
      slug,
      displayName,
      defaultEffort,
      efforts,
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxContextWindow === undefined ? {} : { maxContextWindow }),
    },
    priority,
  }
}

// Parse the raw cache JSON → the listed models ordered by priority ascending (1 = codex's default).
// PURE + total: any shape surprise (not JSON, no models array, all entries dropped) → the fallback, so
// a caller never sees an empty list and never catches a throw. Exported for a direct fixture unit test.
export function parseCodexModelsCache(
  raw: string,
  expectedClientVersion?: string,
  previousModels: readonly CodexModel[] = CODEX_MODELS_FALLBACK,
): CodexModel[] {
  let doc: unknown
  try {
    doc = JSON.parse(raw)
  } catch {
    return [...previousModels]
  }
  const record = doc && typeof doc === "object" ? doc as Record<string, unknown> : undefined
  // Every Codex surface on the machine writes this ONE file. An older Codex app or editor can replace
  // the pinned runtime's richer catalogue with its own smaller one at any moment; separate browser
  // tabs then snapshot different lists and a model selected in one reads "unavailable" in the other.
  // `client_version` makes the writer explicit. Trust only the exact runtime Frizz launches, retaining
  // its last good list across foreign writes; a newer writer is no safer because it may advertise a
  // model whose minimum client is above Frizz's pin.
  if (expectedClientVersion && record?.client_version !== expectedClientVersion) return [...previousModels]
  const models = record?.models
  if (!Array.isArray(models)) return [...previousModels]
  const parsed = models
    .map(toCodexModel)
    .filter((x): x is { model: CodexModel; priority: number } => x !== undefined)
    .sort((a, b) => a.priority - b.priority)
    .map((x) => x.model)
  return parsed.length ? parsed : [...previousModels]
}

// Short read-through memo so repeated RPC calls don't re-open the file every time, while still tracking
// Codex's own periodic refreshes. Keyed on the resolved cache path AND runtime version so distinct
// CODEX_HOMEs and clients never collide. TTL is short — the file is small and changes rarely, so a few
// seconds of staleness is fine.
const TTL_MS = 5_000
const memo = new Map<string, { at: number; models: CodexModel[] }>()
const trusted = new Map<string, CodexModel[]>()

// The selectable Codex models for the picker (RPC-facing). Reads the cache fresh (past TTL), degrades to
// CODEX_MODELS_FALLBACK on any error, and NEVER throws.
export function readCodexModels(
  codexHome = defaultCodexHome(),
  expectedClientVersion?: string,
  nowMs = Date.now(), // injectable clock: the live-reader retention contract is tested without a 5s sleep
): CodexModel[] {
  const path = cachePath(codexHome)
  const key = `${path}\0${expectedClientVersion}`
  const hit = memo.get(key)
  if (hit && nowMs - hit.at < TTL_MS) return hit.models
  let models: CodexModel[]
  try {
    const raw = readFileSync(path, "utf8")
    models = parseCodexModelsCache(raw, expectedClientVersion, trusted.get(key))
    let writer: unknown
    try { writer = (JSON.parse(raw) as Record<string, unknown>).client_version } catch { /* parsed above */ }
    if (writer === expectedClientVersion) trusted.set(key, models)
  } catch {
    models = trusted.get(key) ?? CODEX_MODELS_FALLBACK // absent / unreadable cache
  }
  memo.set(key, { at: nowMs, models })
  return models
}
