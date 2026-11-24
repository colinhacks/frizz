import { ANTIGRAVITY_MODEL_PREFIX, antigravityModelId, antigravityModelSlug, isAntigravityModel, type AntigravityModel, type AntigravityModels } from "@frizz/shared"
import type { ProfileGridGroup, ProfileGridOption, ProfileGridSelection } from "./profileGrid.ts"

// ANTIGRAVITY IN THE MODEL MENU. `agy acp` exposes an eclectic list on paid accounts — native Gemini
// models alongside Orchestrator planner/executor modes and third-party models (Claude, GPT-OSS). Putting
// everything behind a nested dropdown hid the Gemini models that map cleanly onto the effort grid.
//
// The group is therefore a GRID group, like Claude Code and Codex:
//   - Regular Gemini models (Gemini 4 Neon, Carbon, Argon, Hydrogen, 3.8 Flash, …) sit directly in the
//     effort matrix with their concrete thinking levels (low..xhigh), and their trigger reads the model
//     name directly ("Gemini 4 Neon › high"), matching "Opus 5.5 › high" and "GPT-6.2 Sol › low".
//   - Everything else `agy` serves (Orchestrator modes, partner Claude models, GPT-OSS) sits behind a
//     compact "Other models" submenu at the bottom of the group (and a collapsible section on phone),
//     prefixed with "Antigravity" in the trigger so Antigravity's Claude models are never mistaken for
//     Claude Code.
//
// UNLIKE OpenCode, the thinking level is NOT in the slug: it rides the profile's effort column, because
// Antigravity's levels (low..xhigh) are Frizz's own words. "" is the model's own default level, kept
// valid on native Gemini rows via `allowDefaultEffort` so existing threads and preferences saved without
// an explicit level still resolve cleanly.

/** Whether a model listed by `agy` is a regular Gemini model shown directly in the effort grid.
 *  Excludes Orchestrator planner/executor modes (`gemini-pro-orchestrator*`) and partner models. */
export function isAntigravityNativeModel(model: Pick<AntigravityModel, "id" | "name">): boolean {
  const id = model.id.trim().toLowerCase()
  const name = model.name.trim().toLowerCase()
  if (id.includes("orchestrator") || name.includes("orchestrator")) return false
  return id.startsWith("gemini-") || name.startsWith("gemini ") || name === "gemini"
}

function isOrchestratorModel(model: Pick<AntigravityModel, "id" | "name">): boolean {
  const id = model.id.trim().toLowerCase()
  const name = model.name.trim().toLowerCase()
  return id.includes("orchestrator") || name.includes("orchestrator")
}

/** The menu's selection for a stored Antigravity profile. */
export function antigravitySelection(model: string | undefined, effort: string | undefined): ProfileGridSelection {
  return {
    provider: "antigravity",
    model: isAntigravityModel(model) ? model as string : ANTIGRAVITY_MODEL_PREFIX,
    effort: effort ?? "",
  }
}

/** The Antigravity group. `models` is undefined until the list has been asked for; `saved` is the stored
 *  profile, kept as an option even when the list does not have it, so it still reads as itself. */
export function antigravityProfileGroup({ models, loading = false, saved, onRequestOptions }: {
  models?: AntigravityModels
  loading?: boolean
  saved?: { model?: string; effort?: string }
  onRequestOptions?: () => void
}): ProfileGridGroup {
  const listed = models?.models ?? []
  const defaultListed = listed.find((model) => model.id === models?.defaultModel)
  const fallbackNamed = (name: string | undefined) => ({ triggerLabel: "Antigravity", ...(name ? { triggerEdition: name } : {}) })
  const fallbackEfforts = (levels: readonly string[]) => levels.length ? ["", ...levels] : []

  const options: ProfileGridOption[] = []
  const moreOptions: ProfileGridOption[] = []

  for (const model of listed) {
    const slug = antigravityModelSlug(model.id)
    if (isAntigravityNativeModel(model)) {
      options.push({
        model: slug,
        label: model.name,
        efforts: [...model.efforts],
        ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
        ...(model.efforts.length ? { allowDefaultEffort: true } : {}),
      })
    } else {
      moreOptions.push({
        model: slug,
        label: model.name,
        ...fallbackNamed(model.name),
        section: isOrchestratorModel(model) ? "Orchestrator" : "Third-party",
        efforts: fallbackEfforts(model.efforts),
        ...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
      })
    }
  }

  const savedId = antigravityModelId(saved?.model)
  const savedSlug = savedId ? antigravityModelSlug(savedId) : saved?.model !== undefined ? ANTIGRAVITY_MODEL_PREFIX : undefined

  // The bare `antigravity:` slug stands for `agy`'s configured model. Once the list names it, keep a
  // hidden alias (`aliasOf`) so the target row stands in for it without duplicating a row; before the
  // list arrives (or on error), keep a visible fallback row only when needed (error, or bare slug saved).
  if (defaultListed) {
    const nativeDefault = isAntigravityNativeModel(defaultListed)
    const alias: ProfileGridOption = {
      model: ANTIGRAVITY_MODEL_PREFIX,
      label: defaultListed.name,
      ...(nativeDefault ? {} : fallbackNamed(defaultListed.name)),
      efforts: nativeDefault ? [] : fallbackEfforts(defaultListed.efforts),
      ...(defaultListed.defaultEffort ? { defaultEffort: defaultListed.defaultEffort } : {}),
      aliasOf: antigravityModelSlug(defaultListed.id),
    }
    if (nativeDefault) options.unshift(alias)
    else moreOptions.unshift(alias)
  } else if (models?.error || (!listed.length && (!loading || savedSlug === ANTIGRAVITY_MODEL_PREFIX))) {
    options.push({
      model: ANTIGRAVITY_MODEL_PREFIX,
      label: "Configured model",
      triggerLabel: "Antigravity",
      efforts: [],
    })
  }

  // Keep a saved model or effort visible and valid even while loading or when the account no longer
  // offers it, filing it into the grid or fallback list by whether it is a native Gemini model.
  if (savedSlug) {
    const inPrimary = options.findIndex((option) => option.model === savedSlug)
    const inMore = moreOptions.findIndex((option) => option.model === savedSlug)
    if (inPrimary === -1 && inMore === -1 && savedId) {
      const gone = Boolean(models && !loading && !models.error)
      const label = gone ? `${savedId} (unavailable)` : savedId
      if (isAntigravityNativeModel({ id: savedId, name: savedId })) {
        options.push({
          model: savedSlug,
          label,
          efforts: saved?.effort ? [saved.effort] : [],
          ...(saved?.effort ? { allowDefaultEffort: true } : {}),
        })
      } else {
        moreOptions.push({
          model: savedSlug,
          label,
          ...fallbackNamed(savedId),
          efforts: saved?.effort ? ["", saved.effort] : [],
        })
      }
    } else if (inPrimary !== -1 && saved?.effort && !options[inPrimary]!.efforts.includes(saved.effort)) {
      options[inPrimary] = { ...options[inPrimary]!, efforts: [...options[inPrimary]!.efforts, saved.effort] }
    } else if (inMore !== -1 && saved?.effort && !moreOptions[inMore]!.efforts.includes(saved.effort)) {
      const current = moreOptions[inMore]!
      moreOptions[inMore] = { ...current, efforts: [...(current.efforts.length ? current.efforts : [""]), saved.effort] }
    }
  }

  const signedOut = Boolean(models?.error && /not signed in/i.test(models.error))
  const notice = models?.error ? `${models.error} Threads run on its configured model.` : undefined
  return {
    id: "antigravity",
    label: "Antigravity",
    experimental: true,
    layout: "grid",
    options,
    ...(moreOptions.length ? { moreOptions, moreLabel: "Other models" } : {}),
    loading,
    ...(signedOut ? { signedOut: true } : {}),
    ...(notice ? { notice } : {}),
    ...(onRequestOptions ? { onRequestOptions } : {}),
  }
}
