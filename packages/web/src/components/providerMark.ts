import { acpAgentIdFromModel } from "@frizz/shared"

/** One entry per mark ProviderMark can draw: the two rich backends, the generic ACP plug, and a brand
 *  mark per ACP agent Frizz has a CC0 glyph for. `acp:<id>` keys match the catalogue ids in
 *  packages/server/src/backend/acp-agents.ts. */
export type ProviderMarkKey =
  | "claude" | "codex" | "acp" | "antigravity"
  | "acp:opencode" | "acp:cursor" | "acp:gemini" | "acp:copilot" | "acp:qwen" | "acp:kimi"

export interface ProviderMarkDefinition {
  key: ProviderMarkKey
  /** Backend value carried on a known, owned thread. */
  backend: "claude" | "codex" | "acp" | "antigravity"
  /** Exposed to assistive technology because the mark is the provider cue. */
  label: string
}

/**
 * Provider-specific optical sizing is intentionally part of the component contract. The OpenAI
 * knot fills its viewBox more densely than the Claude Code asterisk, so matching nominal boxes
 * makes Codex read too large.
 *
 * The sidebar keeps these sizes but replaces the default vertical nudges with the measured
 * cap-band alignment in `.sidebar-provider-mark` (styles.css). Other uses keep the defaults.
 */
export const PROVIDER_MARK_GEOMETRY: Record<ProviderMarkKey, string> = {
  claude: "size-[11px] translate-y-px",
  codex: "size-[10px]",
  // The plug's box matches its cropped viewBox, so the sidebar's 4px margin isn't padded out by
  // the 2.75px of empty space the original viewBox carried on each side.
  acp: "h-[11px] w-[6.65px] translate-y-px",
  // The Gemini spark also serves Antigravity. Beside its 11px quota label it measured 0.25–0.31px
  // below the cap band (2026-11-20, sans dark and light, DSF 8), so the 10px box needs no nudge there.
  antigravity: "size-[10px]",
  // Ink heights at 10px: OpenCode 10.0, Cursor 10.0, Gemini 10.0, Qwen 9.9, Kimi 9.7. Copilot's head
  // fills only 20 of its 24 units, so it takes a 12px box for 10px of ink.
  "acp:opencode": "size-[10px]",
  "acp:cursor": "size-[10px]",
  "acp:gemini": "size-[10px]",
  "acp:copilot": "size-[12px] translate-y-px",
  "acp:qwen": "size-[10px]",
  "acp:kimi": "size-[10px]",
}

const PROVIDER_MARKS: Record<ProviderMarkKey, ProviderMarkDefinition> = {
  claude: { key: "claude", backend: "claude", label: "Claude Code" },
  codex: { key: "codex", backend: "codex", label: "OpenAI Codex" },
  // The generic mark for an ACP agent Frizz has no brand glyph for (Grok Build, pi, Kilo):
  // the protocol is the identity Frizz can vouch for, the agent is named in the profile readout.
  acp: { key: "acp", backend: "acp", label: "ACP agent" },
  antigravity: { key: "antigravity", backend: "antigravity", label: "Antigravity" },
  "acp:opencode": { key: "acp:opencode", backend: "acp", label: "OpenCode" },
  "acp:cursor": { key: "acp:cursor", backend: "acp", label: "Cursor agent" },
  "acp:gemini": { key: "acp:gemini", backend: "acp", label: "Gemini CLI" },
  "acp:copilot": { key: "acp:copilot", backend: "acp", label: "GitHub Copilot CLI" },
  "acp:qwen": { key: "acp:qwen", backend: "acp", label: "Qwen Code" },
  "acp:kimi": { key: "acp:kimi", backend: "acp", label: "Kimi CLI" },
}

function isMarkKey(key: string): key is ProviderMarkKey { return Object.hasOwn(PROVIDER_MARKS, key) }

// Board snapshots from an older server, legacy rows, and future backends intentionally have
// no identity mark. Do not infer one from the current dispatch preference or model name — except
// that an ACP thread's `model` IS its agent (`acp:<id>`), which is exactly what picks its brand mark.
export function providerMarkFor(backend: string | null | undefined, model?: string | null): ProviderMarkDefinition | undefined {
  if (backend === "claude" || backend === "codex") return PROVIDER_MARKS[backend]
  if (backend === "opencode") return PROVIDER_MARKS["acp:opencode"]
  if (backend === "antigravity") return PROVIDER_MARKS.antigravity
  if (backend !== "acp") return undefined
  const agent = acpAgentIdFromModel(model)
  const key = agent ? `acp:${agent}` : "acp"
  return isMarkKey(key) ? PROVIDER_MARKS[key] : PROVIDER_MARKS.acp
}

/** What a thread's own provider is called in a sentence ("Codex request failed"). The short word for the
 *  two subscriptions; an ACP agent's own name, read off its `acp:<id>` slug when Frizz has no mark for it. */
export function providerNameFor(backend: string | null | undefined, model?: string | null): string {
  if (backend === "codex") return "Codex"
  if (backend === "claude") return "Claude"
  if (backend === "opencode") return "OpenCode"
  if (backend === "antigravity") return "Antigravity"
  if (backend !== "acp") return "Agent"
  const agent = acpAgentIdFromModel(model)
  const key = agent ? `acp:${agent}` : "acp"
  if (isMarkKey(key) && key !== "acp") return PROVIDER_MARKS[key].label
  return agent ? agent[0]!.toUpperCase() + agent.slice(1) : "Agent"
}

/** The backend-level mark, for surfaces that have no thread (the quota chips). */
export function providerMarkForBackend(backend: string | null | undefined): ProviderMarkDefinition | undefined {
  return providerMarkFor(backend)
}
