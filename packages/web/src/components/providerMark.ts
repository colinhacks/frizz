import { acpAgentIdFromModel } from "@frizz/shared"

/** One entry per mark ProviderMark can draw: the two rich backends, the generic ACP plug, and a brand
 *  mark per ACP agent Frizz has a CC0 glyph for. `acp:<id>` keys match the catalogue ids in
 *  packages/server/src/backend/acp-agents.ts. */
export type ProviderMarkKey =
  | "claude" | "codex" | "acp"
  | "acp:opencode" | "acp:cursor" | "acp:gemini" | "acp:copilot" | "acp:qwen" | "acp:kimi"

export interface ProviderMarkDefinition {
  key: ProviderMarkKey
  /** Backend value carried on a known, owned thread. */
  backend: "claude" | "codex" | "acp"
  /** Exposed to assistive technology because the mark is the provider cue. */
  label: string
}

/**
 * Provider-specific optical sizing is intentionally part of the component contract. The OpenAI
 * knot fills its viewBox more densely than the Claude Code asterisk, so matching nominal boxes
 * makes Codex read too large. The Codex knot also needs no downward baseline correction: at this
 * compact size that correction left it reading one pixel low beside title text.
 *
 * Every ACP mark below was MEASURED the same way (visual-review cap-band probe on
 * provider-mark-fixture.html, 13px system-ui title, dsf 6) and the numbers are in the comment beside
 * it — re-measure rather than re-guess if a glyph, the type scale or the rail's font changes.
 */
export const PROVIDER_MARK_GEOMETRY: Record<ProviderMarkKey, string> = {
  claude: "size-[11px] translate-y-px",
  codex: "size-[10px]",
  // lucide's plug, cropped to its ink (ProviderMark's AcpMark sets the viewBox), so the box IS the ink
  // and the caller's `ml-1` is 4px of ink gap like the two marks above (uncropped, the 24-unit box
  // carried 2.75px of dead space per side and drew 6.75px). Ink 9.17px tall against a 9.16px cap
  // height, riding 0.92px HIGH of the cap band before `translate-y-px` — the same 1px drop the Claude
  // asterisk needs.
  acp: "h-[11px] w-[6.65px] translate-y-px",
  // The brand marks take the Codex knot's treatment (a 10px box, no baseline nudge) and read the SAME
  // residual as it on the rail's font: ink centre 0.42px above the cap band's in 13px system-ui, 0.85px
  // in the mono UI font — sub-pixel, and identical to the mark they sit beside, so left alone. Ink
  // heights at 10px: OpenCode 10.0, Cursor 10.0, Gemini 10.0, Qwen 9.9, Kimi 9.7. Copilot's head fills
  // only 20 of its 24 units (8.35px at a 10px box), so it takes a 12px box for 10.0px of ink — and
  // the 1px drop, because an inline-flex box grows upward from the baseline and the larger box read
  // 1.42px high without it.
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
