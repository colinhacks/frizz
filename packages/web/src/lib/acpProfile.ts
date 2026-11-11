import { acpAgentIdFromModel, acpModelIdFromModel, acpModelSlug, type AcpAgent, type AcpAgentModels } from "@frizz/shared"
import type { ProfileGridGroup, ProfileGridOption, ProfileGridSelection } from "./profileGrid.ts"

// AN ACP AGENT IN THE MODEL MENU, the way OpenCode is in it (lib/opencodeProfile.ts): each installed agent
// is a DROPDOWN group under its own name, holding a model dropdown, and the trigger reads the agent and
// then the model in the edition ink ("Cursor GPT-5.5"). Its models were a separate pill beside the
// trigger until 2026-11-10 (maintainer: "Yes, into the menu", after OpenCode's moved for reading as the
// effort or the permission). An agent has no effort axis Frizz can set, so the group has no level
// dropdown.
//
// The list is the agent's own: the server opens a throwaway session and reads its `model` config option
// (rpc.acpAgentModels, cached ten minutes), so it is exactly what the agent honours, and an agent that is
// not signed in lists nothing. It is read only once the agent is chosen or its dropdown opens
// (hooks/useAcpAgentModels.ts), because the probe starts the agent's CLI.
//
// The group's id is the agent's bare slug (`acp:<agent>`), which is also the option for the agent's own
// configured model: Frizz asks for none, and the agent opens on whatever its config names. A model is
// `acp:<agent>@<model id>`.

/** The menu's selection for a stored ACP slug: the agent's group, the slug as the model, no effort. */
export function acpSelection(slug: string): ProfileGridSelection {
  const agentId = acpAgentIdFromModel(slug)
  return { provider: agentId ? acpModelSlug(agentId) : slug, model: slug, effort: "" }
}

/** Whether a menu group or selection provider is an ACP agent's. */
export function isAcpGroupId(id: string | undefined): boolean {
  return Boolean(id && acpAgentIdFromModel(id))
}

/** One agent's group. `models` is undefined until the list has been asked for; `saved` is the stored slug,
 *  kept as an option even when the agent no longer lists its model, so it still reads as itself. */
export function acpProfileGroup({ agent, models, loading = false, saved, onRequestOptions }: {
  agent: Pick<AcpAgent, "id" | "label">
  models?: AcpAgentModels
  loading?: boolean
  saved?: string
  onRequestOptions?: () => void
}): ProfileGridGroup {
  const listed = models?.models ?? []
  const current = listed.find((model) => model.id === models?.current)
  const currentName = current ? splitProvider(current).model : undefined
  const named = (name: string | undefined) => ({ triggerLabel: agent.label, ...(name ? { triggerEdition: name } : {}) })
  // The agent's configured model. Once the list names it, the list shows that model's own row in its place
  // (`aliasOf`), so this row is seen only before the list arrives, or when the agent could not list it.
  const options: ProfileGridOption[] = [{
    model: acpModelSlug(agent.id),
    label: currentName ?? "Configured model",
    ...named(currentName),
    efforts: [],
    ...(current ? { aliasOf: acpModelSlug(agent.id, current.id) } : {}),
  }]
  for (const model of listed) {
    const { provider, model: name } = splitProvider(model)
    options.push({ model: acpModelSlug(agent.id, model.id), label: name, ...named(name), section: provider, efforts: [] })
  }
  // A saved model the agent no longer lists stays visible and verbatim: the operator chose it, and the
  // bridge notes the refusal in the transcript if the agent declines it. While the list is loading or
  // failed nothing is known either way, so it gets no "(unavailable)" verdict.
  const savedModelId = acpAgentIdFromModel(saved) === agent.id ? acpModelIdFromModel(saved) : undefined
  if (savedModelId && !listed.some((model) => model.id === savedModelId)) {
    const gone = Boolean(models && !loading && !models.error)
    options.push({ model: acpModelSlug(agent.id, savedModelId), label: gone ? `${savedModelId} (unavailable)` : savedModelId, ...named(savedModelId), efforts: [] })
  }
  const notice = models?.error ? `${agent.label} did not list its models (${models.error}); threads run on its configured model` : undefined
  return {
    id: acpModelSlug(agent.id),
    label: agent.label,
    layout: "dropdown",
    options,
    loading,
    ...(notice ? { notice } : {}),
    ...(onRequestOptions ? { onRequestOptions } : {}),
  }
}

// "OpenAI/GPT-5.5" → OpenAI + GPT-5.5 (maintainer 2026-09-16: "we should definitely group these by
// provider"): an agent's list spans providers, and each name carries its provider as a prefix. A name with
// no slash falls back to its id's prefix ("anthropic/…" → "anthropic"), and a bare id with neither is filed
// under "Models".
export function splitProvider(model: { id: string; name: string }): { provider: string; model: string } {
  const slash = model.name.indexOf("/")
  if (slash > 0) return { provider: model.name.slice(0, slash).trim(), model: model.name.slice(slash + 1).trim() }
  const idSlash = model.id.indexOf("/")
  if (idSlash > 0) return { provider: model.id.slice(0, idSlash), model: model.name }
  return { provider: "Models", model: model.name }
}
