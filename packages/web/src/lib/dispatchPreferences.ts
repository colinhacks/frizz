import {
  acpAgentIdFromModel,
  acpModelIdFromModel,
  acpModelSlug,
  OPENCODE_MODEL_PREFIX,
  opencodeModelSlug,
  type AcpAgent,
  type Backend,
  type ClaudeModel,
  type CodexModel,
  type DispatchPreferences,
  type SetDispatchPreferenceInput,
} from "@frizz/shared"
import type { SelectGroup, SelectOption } from "../components/ui/Select.tsx"
import type { ProfileGridGroup } from "./profileGrid.ts"
import {
  CLAUDE_MODELS,
  claudeModelOptions,
  claudeEfforts,
  claudeEffortOptions,
  codexEffortOptions,
  modelGroups,
} from "./options.ts"

export interface ResolvedDispatchPreferences {
  backend: Backend
  // The slug dispatch sends: a Claude alias, a Codex slug, or `acp:<agent>[@<model>]`.
  model: string
  // The model the profile GRID is keyed on. An ACP row is one row per AGENT (`acp:<agent>`), and the
  // agent's model lives in the dropdown beside the pill — so the grid must never see the `@<model>`
  // tail, or a saved model would read as "unknown profile" the moment one was chosen.
  pickerModel: string
  effort: string
  codexModel?: CodexModel
  // ACP only: the agent id and the model chosen inside it (undefined = the agent's own default).
  acpAgentId?: string
  acpModelId?: string
  // OpenCode only: its row is the bare prefix, and the model inside it is its own picker's.
  opencodeModel?: string
  modelAvailable: boolean
  effortAvailable: boolean
  effortOptions: SelectOption[]
}

export function applyDispatchPreferenceUpdate(
  current: DispatchPreferences,
  update: SetDispatchPreferenceInput,
): DispatchPreferences {
  if (update.field === "backend") return { ...current, backend: update.value }
  if (update.field === "profile") {
    return {
      ...current,
      backend: update.backend,
      [update.backend]: {
        ...current[update.backend],
        model: update.model,
        effort: update.effort,
      },
    }
  }
  return {
    ...current,
    ...(update.field === "model" ? { backend: update.backend } : {}),
    [update.backend]: { ...current[update.backend], [update.field]: update.value },
  }
}

// `claudeModels` is the runtime-resolved Claude catalogue (the claudeModels RPC): the Claude rows take
// their edition labels from it ("Opus 5.5"), exactly as the Codex rows take theirs from the codex cache.
export function dispatchProfileGroups(
  codexModels: readonly CodexModel[],
  acpAgents: readonly AcpAgent[] = [],
  claudeModels: readonly ClaudeModel[] = [],
  // The group a signed-out machine leads with (defaultAgentProfile). The rest keep their order.
  firstGroup?: string,
): ProfileGridGroup[] {
  // Only the agents actually on the server's PATH get a row: the catalogue lists eight, and a grid of
  // "not installed" rows would bury the two the operator has. A SAVED agent that has since gone
  // missing surfaces through resolveDispatchPreferences's `modelAvailable`, not through a row here.
  //
  // An agent marked `native` runs on Frizz's own backend for it here, so it has that row instead.
  const opencodeNative = acpAgents.some((agent) => agent.native && agent.available)
  const acpOptions = acpAgents.filter((agent) => agent.available && !agent.native).map((agent) => ({
    model: acpModelSlug(agent.id),
    label: agent.label,
    // No effort axis: an ACP agent runs on its own CLI's model and effort (ProfileGridSelector draws
    // one "Default" cell for an option with no efforts).
    efforts: [],
  }))
  const groups: ProfileGridGroup[] = [
    {
      id: "claude",
      label: "Claude Code",
      options: claudeModelOptions(claudeModels).map((option) => ({
        model: option.value,
        label: option.label,
        edition: claudeModels.find((model) => model.alias === option.value)?.edition,
        defaultEffort: "high",
        // Per-model, exactly like the codex rows below: the ultracode rung exists only on the
        // xhigh-capable models, so Haiku's row leaves that grid cell empty.
        efforts: claudeEfforts(option.value),
      })),
    },
    {
      id: "codex",
      label: "Codex",
      options: codexModels.map((model) => ({
        model: model.slug,
        label: model.displayName,
        defaultEffort: model.defaultEffort,
        efforts: model.efforts,
      })),
    },
    ...(opencodeNative ? [{ id: "opencode", label: "OpenCode", options: [{ model: OPENCODE_MODEL_PREFIX, label: "OpenCode", efforts: [] }] }] : []),
    // One agent is its own heading. "ACP agents" names the protocol, and only earns its place as a list.
    ...(acpOptions.length ? [{ id: "acp", label: acpOptions.length === 1 ? acpOptions[0]!.label : "ACP agents", options: acpOptions }] : []),
  ]
  return firstGroup ? [...groups.filter((group) => group.id === firstGroup), ...groups.filter((group) => group.id !== firstGroup)] : groups
}

export function resolveDispatchPreferences(
  preferences: DispatchPreferences,
  codexModels: readonly CodexModel[],
  acpAgents: readonly AcpAgent[] = [],
): ResolvedDispatchPreferences {
  // A profile saved when OpenCode ran over ACP becomes the native one once this machine can run that,
  // keeping the model it named. A thread already running over ACP stays there: this is only what the
  // next dispatch uses.
  const savedAcpAgent = preferences.backend === "acp" ? acpAgentIdFromModel(preferences.acp?.model) : undefined
  if (savedAcpAgent && acpAgents.some((agent) => agent.id === savedAcpAgent && agent.native)) {
    const inner = acpModelIdFromModel(preferences.acp?.model)
    const slash = inner?.indexOf("/") ?? -1
    const model = inner && slash > 0 ? opencodeModelSlug({ providerID: inner.slice(0, slash), id: inner.slice(slash + 1) }) : OPENCODE_MODEL_PREFIX
    return resolveDispatchPreferences({ ...preferences, backend: "opencode", opencode: { ...preferences.opencode, model } }, codexModels, acpAgents)
  }
  const backend = preferences.backend
  // `acp` is optional on the record (older rows predate it), so an ACP backend with no saved profile
  // reads as an empty one and falls through to the first installed agent below.
  const profile = preferences[backend] ?? {}
  const firstAcpAgent = acpAgents.find((agent) => agent.available)
  const model = profile.model ?? (
    backend === "claude" ? "opus"
      : backend === "codex" ? codexModels[0]?.slug ?? ""
        : backend === "opencode" ? OPENCODE_MODEL_PREFIX
          : firstAcpAgent ? acpModelSlug(firstAcpAgent.id) : ""
  )
  const codexModel = backend === "codex"
    ? codexModels.find((candidate) => candidate.slug === model)
    : undefined
  const acpAgentId = backend === "acp" ? acpAgentIdFromModel(model) : undefined
  const acpModelId = backend === "acp" ? acpModelIdFromModel(model) : undefined
  const pickerModel = backend === "acp" && acpAgentId ? acpModelSlug(acpAgentId) : backend === "opencode" ? OPENCODE_MODEL_PREFIX : model
  // An ACP profile is available when its AGENT is installed: the model inside it is the agent's to
  // honour or refuse (the bridge notes a refusal in the transcript), never a reason to block dispatch.
  const modelAvailable = backend === "claude"
    ? CLAUDE_MODELS.some((candidate) => candidate.value === model)
    : backend === "codex"
      ? codexModels.some((candidate) => candidate.slug === model)
      : backend === "opencode"
        ? acpAgents.some((candidate) => candidate.native === true && candidate.available)
        : acpAgents.some((candidate) => candidate.available && candidate.id === acpAgentId)
  const opencodeModel = backend === "opencode" ? model : undefined
  const defaultEffort = backend === "claude" ? "high" : codexModel?.defaultEffort ?? ""
  // An ACP agent has no effort axis in Frizz — it runs on its own CLI's model and effort — so its
  // effort is "" and always "available": there is nothing to be unavailable.
  const effort = backend === "acp" || backend === "opencode" ? "" : profile.effort ?? defaultEffort
  const baseEfforts = backend === "claude"
    ? claudeEffortOptions(model, { withDefault: false })
    : backend === "codex"
      ? codexEffortOptions(codexModel, { withDefault: false })
      : []
  const effortAvailable = backend === "acp" || baseEfforts.some((option) => option.value === effort)
  const effortOptions = effort && !effortAvailable
    ? [{ value: effort, label: `${effort} (unavailable)`, title: "Saved reasoning level is not available for this model" }, ...baseEfforts]
    : baseEfforts
  return {
    backend,
    model,
    pickerModel,
    effort,
    codexModel,
    ...(acpAgentId ? { acpAgentId } : {}),
    ...(acpModelId ? { acpModelId } : {}),
    modelAvailable,
    effortAvailable,
    effortOptions,
  }
}

export function dispatchModelGroups(
  codexModels: readonly CodexModel[],
  backend: Backend,
  selectedModel: string,
  claudeModels: readonly ClaudeModel[] = [],
): SelectGroup[] {
  const groups = modelGroups(codexModels, { withDefault: false }, claudeModels)
  if (!selectedModel || groups.some((group) => group.options.some((option) => option.value === selectedModel))) return groups
  const unavailable: SelectGroup = {
    label: backend === "codex" ? "Saved Codex model" : backend === "acp" ? "Saved ACP agent" : backend === "opencode" ? "Saved OpenCode model" : "Saved Claude model",
    options: [{ value: selectedModel, label: `${selectedModel} (unavailable)`, title: "This saved model is no longer in the runtime catalogue" }],
  }
  return [unavailable, ...groups]
}
