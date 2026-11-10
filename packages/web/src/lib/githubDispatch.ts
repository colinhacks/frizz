import {
  acpAgentIdFromModel,
  type AcpAgent,
  type CodexModel,
  type DispatchProfileSnapshot,
  type GithubBatchInput,
} from "@frizz/shared"
import { CLAUDE_MODELS, claudeEfforts } from "./options.ts"

// Validate the picker's live model/effort pair immediately before the final mutation. A Codex cache
// refresh can invalidate a model or effort while the picker is open; that must stop visibly (the
// selector's own red line + a disabled dispatch) instead of falling back or downgrading.
// No permissionMode participates: the server stamps every created worker itself
// (workerDispatchPermission — the non-interactive floor, raised to bypass only when Settings asks), so
// the GitHub flow carries no per-thread permission choice.
export function dispatchProfileError(
  profile: DispatchProfileSnapshot,
  codexModels: readonly CodexModel[],
  acpAgents: readonly AcpAgent[] = [],
): string | undefined {
  if (profile.backend === "opencode") {
    return acpAgents.some((agent) => agent.native && agent.available) ? undefined : "OpenCode 2 is not installed on this machine"
  }
  if (profile.backend === "acp") {
    // `acp:<agent>@<model>`: the agent must be installed; the model inside it is the agent's to honour.
    const agent = acpAgents.find((candidate) => candidate.id === acpAgentIdFromModel(profile.model))
    if (!agent) return `ACP agent ${profile.model} is not in the catalogue`
    if (!agent.available) return `${agent.label} is not installed on this machine`
    return undefined
  }
  if (!profile.effort) return `Reasoning level is required for ${profile.model}`
  if (profile.backend === "claude") {
    if (!CLAUDE_MODELS.some((option) => option.value === profile.model)) {
      return `Claude model ${profile.model} is no longer available`
    }
    // Per-model, so picking ultracode and then switching to a model that cannot honour it stops here
    // rather than dispatching a level that would be silently ignored.
    if (!claudeEfforts(profile.model).includes(profile.effort)) {
      return `Reasoning level ${profile.effort} is not available for ${profile.model}`
    }
    return undefined
  }

  const model = codexModels.find((candidate) => candidate.slug === profile.model)
  if (!model) return `Codex model ${profile.model} is no longer available`
  if (!model.efforts.includes(profile.effort)) {
    return `Reasoning level ${profile.effort} is not available for ${profile.model}`
  }
  return undefined
}

export function buildGithubBatchInput(
  profile: DispatchProfileSnapshot,
  items: GithubBatchInput["items"],
): GithubBatchInput {
  return {
    items: items.map((item) => ({ ...item })),
    backend: profile.backend,
    model: profile.model,
    effort: profile.effort,
  }
}
