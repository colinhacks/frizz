import { ANTIGRAVITY_MODEL_PREFIX, antigravityModelId, antigravityModelSlug, isAntigravityModel, type AntigravityModels } from "@frizz/shared"
import type { ProfileGridGroup, ProfileGridOption, ProfileGridSelection } from "./profileGrid.ts"

// ANTIGRAVITY IN THE MODEL MENU. Its models are whatever the signed-in Google account's plan offers
// (`agy acp`'s `model` config option), and only some of them take a thinking level, each with its own
// set: on the free plan Gemini 3.8 Flash takes low, medium and high, while the Claude and GPT-OSS models
// it serves take none. Those line up with neither each other nor the menu's effort columns, so the group
// is a DROPDOWN group, as OpenCode's is (lib/opencodeProfile.ts): a model dropdown and a level dropdown
// under the Antigravity heading, and on the phone a row per model with its levels as chips.
//
// The trigger reads "Antigravity" and then the model name in the edition ink. The bare `antigravity:` is
// whatever model `agy` itself is set to; once the list names that model the list shows its row instead.
//
// UNLIKE OpenCode, the level is NOT in the slug: it is the profile's effort, the column a Claude or Codex
// thread keeps its own in, because Antigravity's levels are Frizz's own words (low to max). "" is the
// model's own default level, and the only choice on a model that takes none.

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
  const named = (name: string | undefined) => ({ triggerLabel: "Antigravity", ...(name ? { triggerEdition: name } : {}) })
  // A model with no levels has no level dropdown; one with levels leads with its own default.
  const efforts = (levels: readonly string[]) => levels.length ? ["", ...levels] : []
  // The configured model. Once the list names it, the list shows that model's own row in its place
  // (`aliasOf`), so this row is seen only before the list arrives, or when `agy` could not list it.
  const options: ProfileGridOption[] = [{
    model: ANTIGRAVITY_MODEL_PREFIX,
    label: defaultListed?.name ?? "Configured model",
    ...named(defaultListed?.name),
    efforts: efforts(defaultListed?.efforts ?? []),
    ...(defaultListed ? { aliasOf: antigravityModelSlug(defaultListed.id) } : {}),
  }]
  for (const model of listed) {
    options.push({ model: antigravityModelSlug(model.id), label: model.name, ...named(model.name), efforts: efforts(model.efforts) })
  }
  const savedId = antigravityModelId(saved?.model)
  const savedSlug = savedId ? antigravityModelSlug(savedId) : saved?.model !== undefined ? ANTIGRAVITY_MODEL_PREFIX : undefined
  if (savedSlug) {
    const index = options.findIndex((option) => option.model === savedSlug)
    if (index === -1 && savedId) {
      const gone = Boolean(models && !loading && !models.error)
      options.push({ model: savedSlug, label: gone ? `${savedId} (unavailable)` : savedId, ...named(savedId), efforts: saved?.effort ? ["", saved.effort] : [] })
    } else if (index !== -1 && saved?.effort && !options[index]!.efforts.includes(saved.effort)) {
      // A stored level the model is not listed with stays choosable and reads as itself: the list may
      // not have arrived, and the agent refuses a level it does not offer in the thread's own transcript.
      options[index] = { ...options[index]!, efforts: [...(options[index]!.efforts.length ? options[index]!.efforts : [""]), saved.effort] }
    }
  }
  const notice = models?.error ? `${models.error} Threads run on its configured model.` : undefined
  return {
    id: "antigravity",
    label: "Antigravity",
    experimental: true,
    layout: "dropdown",
    options,
    loading,
    ...(notice ? { notice } : {}),
    ...(onRequestOptions ? { onRequestOptions } : {}),
  }
}
