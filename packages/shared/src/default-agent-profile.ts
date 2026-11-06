// WHICH AGENT A MACHINE WITH NO SAVED CHOICE STARTS ON.
//
// Claude Code, unless that could not start: someone signed out of Claude and Codex who has OpenCode
// installed opens on OpenCode, which needs no account. A saved profile never reaches this function, and
// neither does a provider with a launch prefix, which may be what supplies its credentials (the caller
// passes that provider as "unknown"). The server applies the answer to an unsaved dispatch profile, and
// the composer floats the same group to the top of its model menu.

import type { ProviderAuth } from "./index.ts"

export interface DefaultAgentProfileInput {
  claude: ProviderAuth | undefined
  codex: ProviderAuth | undefined
  opencodeInstalled: boolean
}

export interface DefaultAgentProfile {
  backend: "acp"
  model: string
}

export function defaultAgentProfile(input: DefaultAgentProfileInput): DefaultAgentProfile | undefined {
  if (!input.opencodeInstalled || input.claude !== "signed-out" || input.codex !== "signed-out") return undefined
  return { backend: "acp", model: "acp:opencode" }
}
