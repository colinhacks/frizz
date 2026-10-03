import type { Backend, ClaudeModel, CodexModel, ThreadProfileOption } from "@frizz/shared"
import { readCodexModels } from "./codex-models.ts"
import { CLAUDE_ULTRACODE, claudeModelSupportsUltracode } from "./claude-effort.ts"

// Claude Code 2.1.207 accepts model and effort together on both a new session and --resume. Keep the
// native aliases here on the server: an existing-thread mutation must never depend on the browser's
// model-name classifier (whose historical unknown=>Claude fallback is intentionally irrelevant).
//
// "ultracode" rides the ladder as its top rung, exactly where Claude Code's own `/effort` puts it, but
// it is NOT an --effort value — claude-effort.ts translates it into (xhigh + the ultracode session
// setting) at the spawn edge. It is offered only on the xhigh-capable models, because Claude ignores
// the setting on Haiku rather than erroring (measured); see CLAUDE_ULTRACODE_MODELS.
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const

/** The Claude effort ladder for one model — the ultracode rung only where the model can honour it. */
export function claudeEffortsFor(model: string): string[] {
  return claudeModelSupportsUltracode(model) ? [...CLAUDE_EFFORTS, CLAUDE_ULTRACODE] : [...CLAUDE_EFFORTS]
}

export const CLAUDE_THREAD_PROFILES: readonly ThreadProfileOption[] = [
  { model: "fable", label: "Fable", defaultEffort: "medium", efforts: claudeEffortsFor("fable") },
  { model: "opus", label: "Opus", defaultEffort: "medium", efforts: claudeEffortsFor("opus") },
  { model: "sonnet", label: "Sonnet", defaultEffort: "medium", efforts: claudeEffortsFor("sonnet") },
  { model: "haiku", label: "Haiku", defaultEffort: "medium", efforts: claudeEffortsFor("haiku") },
]

// ---- The MODEL-SCOPED-CAP fallback ladder ---------------------------------------------------------
// A model-scoped limit ("You've reached your Fable 5 limit. Switch to another model, or manage usage
// credits…") is the provider saying the ACCOUNT can still work — just not on that model. So the
// scheduler steps the thread one rung down this list and resumes it, rather than parking it behind a
// weekly window (see evalLimits). CLAUDE_THREAD_PROFILES is already ordered by capability — it is what
// the composer renders, top to bottom — so "one rung down" is simply the next entry, and the bottom of
// the ladder (Haiku) has no fallback and falls back to waiting for the window.

/** The next model down from `model`, or undefined when it is unknown or already the bottom rung. */
export function claudeFallbackModel(model: string): string | undefined {
  const index = CLAUDE_THREAD_PROFILES.findIndex((option) => option.model === model)
  if (index < 0) return undefined
  return CLAUDE_THREAD_PROFILES[index + 1]?.model
}

/** The catalogue entry for a model slug — the label a steer names it by. */
export function claudeProfile(model: string): ThreadProfileOption | undefined {
  return CLAUDE_THREAD_PROFILES.find((option) => option.model === model)
}

// The catalogue model a provider LIMIT MESSAGE names. The message writes a display name carrying its
// version ("Fable 5"); the catalogue keys on the bare family ("fable"). The two spellings are the
// provider's, not ours, so the match is TOKEN-PREFIX in either direction — the same discipline
// scopedQuotaWindow uses against the usage endpoint's `weekly-<model>` keys, and for the same reason.
export function claudeModelFromLimitName(name: string): string | undefined {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  if (!slug) return undefined
  return CLAUDE_THREAD_PROFILES.find(({ model }) => slug === model || slug.startsWith(`${model}-`) || model.startsWith(`${slug}-`))?.model
}

// `claudeModels` is the runtime-resolved catalogue (claude-models.ts): each Claude row takes its
// EDITION label from it ("Opus 5.5") so a running thread's selector reads the same words as the
// composer's; without it (a caller with no runtime on hand) the rows keep their bare family labels.
export function threadProfileOptions(
  backend: unknown,
  claudeModels?: readonly ClaudeModel[],
  codexModels?: readonly CodexModel[],
): { backend: Backend; options: ThreadProfileOption[] } {
  if (backend === "claude") {
    return {
      backend,
      options: CLAUDE_THREAD_PROFILES.map((option) => {
        const resolved = claudeModels?.find((model) => model.alias === option.model)
        return {
          ...option,
          label: resolved?.label ?? option.label,
          ...(resolved?.edition ? { edition: resolved.edition } : {}),
          efforts: [...option.efforts],
        }
      }),
    }
  }
  if (backend === "codex") {
    return {
      backend,
      options: (codexModels ?? readCodexModels()).map((model) => ({
        model: model.slug,
        label: model.displayName,
        defaultEffort: model.defaultEffort,
        efforts: [...model.efforts],
      })),
    }
  }
  // An ACP agent's model is chosen inside the agent (its own config options); Frizz offers no profile
  // for it yet, so the picker shows nothing rather than failing the RPC.
  if (backend === "acp") return { backend, options: [] }
  throw new Error("This thread has an unknown backend; its runtime profile cannot be changed")
}

export function validateThreadProfile(
  backend: unknown,
  model: string,
  effort: string,
  codexModels?: readonly CodexModel[],
): void {
  const catalogue = threadProfileOptions(backend, undefined, codexModels)
  const option = catalogue.options.find((candidate) => candidate.model === model)
  if (!option || !option.efforts.includes(effort)) {
    throw new Error(`Unsupported ${catalogue.backend} model/effort pair: ${model} / ${effort}`)
  }
}

// The LIVE handoff journals the thread's CURRENT pair as its rollback target and RELAUNCHES the worker
// with it if the target profile fails (resume.ts spawns from `profiles.current`), so that pair must be
// launchable argv. Claude records a thread's model but frequently never its launch effort, so a known
// model with an absent/unrecognized effort is a NORMAL state, not corruption — rejecting it outright
// left such a thread permanently unable to change its model. Reconstruct the missing half from the
// catalogue's default effort (exactly what a fresh dispatch of that model would use) so the rollback
// stays launchable. An unknown MODEL still fails closed: there is no entry to rebuild a pair from.
export function resolveRollbackProfile(
  backend: unknown,
  model: string,
  effort: string,
  codexModels?: readonly CodexModel[],
): { model: string; effort: string } {
  const catalogue = threadProfileOptions(backend, undefined, codexModels)
  const option = catalogue.options.find((candidate) => candidate.model === model)
  if (!option || !option.efforts.includes(option.defaultEffort)) {
    // Name the absent half explicitly: this pair comes from stored/observed state rather than a grid
    // click, so an empty model rendered a message ("pair:  / ") that identified nothing to act on.
    throw new Error(`Unsupported ${catalogue.backend} model/effort pair: ${model || "(unknown model)"} / ${effort || "(unrecorded effort)"}`)
  }
  return { model: option.model, effort: option.efforts.includes(effort) ? effort : option.defaultEffort }
}

export function normalizeObservedThreadModel(
  backend: unknown,
  model: string,
  codexModels?: readonly CodexModel[],
): string | undefined {
  const value = model.trim()
  if (backend === "codex") {
    return threadProfileOptions(backend, undefined, codexModels).options.some((option) => option.model === value) ? value : undefined
  }
  if (backend === "claude") {
    const exact = CLAUDE_THREAD_PROFILES.find((option) => option.model === value)
    if (exact) return exact.model
    return CLAUDE_THREAD_PROFILES.find((option) => value.toLowerCase().includes(option.model))?.model
  }
  return undefined
}
