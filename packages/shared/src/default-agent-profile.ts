// WHICH AGENT A MACHINE WITH NO SAVED CHOICE STARTS ON.
//
// Claude Code, unless that could not start: someone signed out of Claude and Codex who has OpenCode
// installed opens on OpenCode, which needs no account. A saved profile never reaches this function, and
// neither does a provider with a launch prefix, which may be what supplies its credentials (the caller
// passes that provider as "unknown"). The server applies the answer to an unsaved dispatch profile, and
// the composer floats the same group to the top of its model menu.
//
// OpenCode at 2.0.27 or newer runs on Frizz's own backend for it, driven through its server API
// (`opencode:`, plans/opencode-native-backend.md); an older one, or one whose version cannot be read, runs
// over ACP (`acp:opencode`).

import type { ProviderAuth } from "./index.ts"

export interface DefaultAgentProfileInput {
  claude: ProviderAuth | undefined
  codex: ProviderAuth | undefined
  opencodeInstalled: boolean
  // OpenCode is new enough for the native backend (the server's `opencodeNativeAvailable`).
  opencodeNative?: boolean
}

export interface DefaultAgentProfile {
  backend: "acp" | "opencode"
  model: string
}

/** The profile that means "OpenCode" on this machine, which the sign-in modal's "Use OpenCode" saves too. */
export function opencodeAgentProfile(native: boolean | undefined): DefaultAgentProfile {
  return native ? { backend: "opencode", model: "opencode:" } : { backend: "acp", model: "acp:opencode" }
}

export function defaultAgentProfile(input: DefaultAgentProfileInput): DefaultAgentProfile | undefined {
  if (!input.opencodeInstalled || input.claude !== "signed-out" || input.codex !== "signed-out") return undefined
  return opencodeAgentProfile(input.opencodeNative)
}
