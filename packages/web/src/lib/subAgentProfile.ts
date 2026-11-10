import { parseClaudeWireId } from "@frizz/shared"

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra", "ultracode"])
const CLAUDE_FAMILIES = new Set(["fable", "opus", "sonnet", "haiku"])

function splitEffort(value: string, separator: "/" | "-"): { model: string; effort?: string } {
  const at = value.lastIndexOf(separator)
  if (at <= 0) return { model: value }
  const effort = value.slice(at + 1)
  if (!EFFORTS.has(effort)) return { model: value }
  return { model: value.slice(0, at), effort }
}

/** One sub-agent's runtime, in the parts a surface draws. Every field is absent when it is not known. */
export interface SubAgentProfileParts {
  /** A foreign agent type's own name ("explorer", "general-purpose"), kept beside the runtime it ran. */
  role?: string
  /** The model in the picker's words: a Claude family ("opus"), or a slug the cell spells itself. */
  model?: string
  /** "5.5" of "opus 5.5" — apart from `model` so a prompt box can set it in the edition ink, as the
   *  thread's own composer does (ProfileGridSelector's TriggerLabel). */
  edition?: string
  effort?: string
  /** A cell no shape below recognises, shown as it came rather than guessed at. */
  verbatim?: string
}

// A Claude wire id reads as its family and edition; anything else is already in the words to show.
function modelParts(model: string): Pick<SubAgentProfileParts, "model" | "edition"> {
  const id = parseClaudeWireId(model)
  return id ? { model: id.alias, edition: id.edition } : { model }
}

// The server hands every surface one composed dispatch cell rather than separate profile fields
// (server/subagent-profile.ts for Claude, codex-subagents.ts `describeCell` for Codex):
//   Claude: frizz:claude-opus-5-5-high, or frizz:sonnet-high when only the family is known (and the
//           legacy frizz:opus-high / frizz:frizz-opus-high, which read the same way)
//   Codex:  explorer gpt-5.6-terra/high
//   either: general-purpose claude-opus-5-5/high — a foreign agent type keeps its name and gains the pair
// A Claude model half is the canonical wire id whenever the dispatch record states the edition, so a
// child reads "opus 5.5 › high" as its parent's composer reads "Opus 5.5 › high".
function cellParts(raw: string): SubAgentProfileParts {
  if (raw.startsWith("frizz:")) {
    const routed = raw.slice("frizz:".length).replace(/^frizz-/, "")
    // An effort-only profile the server could resolve no model for (a descendant's sidecar, a turn that
    // recorded none): the effort alone, with the model left for the child's own transcript to name.
    if (EFFORTS.has(routed)) return { effort: routed }
    const { model, effort } = splitEffort(routed, "-")
    return { ...modelParts(model), ...(effort ? { effort } : {}) }
  }

  const words = raw.split(/\s+/)
  const cell = words.at(-1) ?? raw
  const role = words.slice(0, -1).join(" ")
  const { model, effort } = splitEffort(cell, "/")
  if (effort) return { ...(role ? { role } : {}), ...modelParts(model), effort }
  // A foreign agent type the call named only a Claude model for: "general-purpose claude-opus-5-5".
  if (role && (parseClaudeWireId(cell) || CLAUDE_FAMILIES.has(cell))) return { role, ...modelParts(cell) }
  return { verbatim: raw }
}

/**
 * The parts of a sub-agent's runtime, from its dispatch cell and — where the caller has it — the model
 * the child's OWN transcript says it ran (router `subAgentTranscript`'s `model`). That observation is the
 * truth the cell can only approximate, so it names the model and edition whenever it is a Claude id; the
 * effort, which no transcript records, stays the cell's. Undefined when nothing at all is known.
 */
export function subAgentProfileParts(subagentType?: string, observedModel?: string): SubAgentProfileParts | undefined {
  const raw = subagentType?.trim()
  const parts: SubAgentProfileParts | undefined = raw ? cellParts(raw) : undefined
  const observed = observedModel ? parseClaudeWireId(observedModel) : undefined
  if (!observed) return parts
  const seen = { model: observed.alias, edition: observed.edition }
  if (!parts) return seen
  if (parts.verbatim !== undefined) return { role: parts.verbatim, ...seen }
  // A model named in another provider's words is not a Claude family this id could refine.
  if (parts.model !== undefined && !CLAUDE_FAMILIES.has(parts.model)) return parts
  return { ...parts, ...seen }
}

/** The parts as one line, in the prompt-box selector's separators: "explorer · opus 5.5 › high". */
export function subAgentProfileText(parts: SubAgentProfileParts): string {
  if (parts.verbatim !== undefined) return parts.verbatim
  const model = [parts.model, parts.edition].filter(Boolean).join(" ")
  const runtime = model && parts.effort ? `${model} › ${parts.effort}` : (model || parts.effort || "")
  return parts.role ? `${parts.role} · ${runtime}` : runtime
}

// The readout's whole label: what is known, or a plain statement that nothing is.
export function subAgentProfileLabel(subagentType?: string, observedModel?: string): string {
  const parts = subAgentProfileParts(subagentType, observedModel)
  return parts ? subAgentProfileText(parts) : "Profile unknown"
}

// The same reading for a surface that must stay SILENT when nothing is known — the transcript's
// dispatch card, where "Profile unknown" would occupy a column on every legacy card to say nothing.
export function subAgentProfileCell(subagentType?: string, observedModel?: string): string | undefined {
  const parts = subAgentProfileParts(subagentType, observedModel)
  return parts ? subAgentProfileText(parts) : undefined
}
