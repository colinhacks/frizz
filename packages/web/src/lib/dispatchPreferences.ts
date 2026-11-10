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
import type { ProfileGridGroup, ProfileGridSelection } from "./profileGrid.ts"
import { opencodeProfileGroup, opencodeSelection, opencodeSlugOf } from "./opencodeProfile.ts"
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
  // OpenCode only: the whole stored slug, variant included. The menu reads it through `opencodeSelection`.
  opencodeModel?: string
  modelAvailable: boolean
  effortAvailable: boolean
  effortOptions: SelectOption[]
}

// What the model menu shows as chosen. OpenCode's variant is its effort there, though dispatch sends none.
export function dispatchProfileValue(resolved: ResolvedDispatchPreferences): ProfileGridSelection {
  if (resolved.backend === "opencode") return opencodeSelection(resolved.opencodeModel)
  return { provider: resolved.backend, model: resolved.pickerModel, effort: resolved.effort }
}

// The preference write for a pick in the model menu. An ACP or OpenCode row carries no Frizz effort: an
// ACP agent has none, and OpenCode's variant rides in its model slug.
export function dispatchProfileUpdate(selection: ProfileGridSelection): SetDispatchPreferenceInput {
  if (selection.provider === "opencode") return { field: "profile", backend: "opencode", model: opencodeSlugOf(selection) }
  return {
    field: "profile",
    backend: selection.provider as Backend,
    model: selection.model,
    effort: (selection.effort || undefined) as Extract<SetDispatchPreferenceInput, { field: "profile" }>["effort"],
  }
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
  // OpenCode's listed models and the saved slug, for its dropdown group (lib/opencodeProfile.ts).
  opencode?: Parameters<typeof opencodeProfileGroup>[0],
  // The groups whose account is known to be signed out here (useDispatchProfile), by id.
  signedOut: readonly string[] = [],
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
      signedOut: signedOut.includes("claude") || undefined,
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
      signedOut: signedOut.includes("codex") || undefined,
      options: codexModels.map((model) => ({
        model: model.slug,
        label: model.displayName,
        defaultEffort: model.defaultEffort,
        efforts: model.efforts,
      })),
    },
    ...(opencodeNative ? [opencodeProfileGroup(opencode ?? {})] : []),
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
  const effortAvailable = backend === "acp" || backend === "opencode" || baseEfforts.some((option) => option.value === effort)
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
    ...(opencodeModel ? { opencodeModel } : {}),
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
