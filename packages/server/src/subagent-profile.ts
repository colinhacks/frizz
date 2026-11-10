import { parseClaudeWireId, type ClaudeWireId } from "@frizz/shared"
import { normalizeObservedThreadModel } from "./backend/thread-profiles.ts"
import { readObservedChildModel } from "./subagent-model.ts"

// THE DISPATCH PROFILE CELL — the one string every surface that names a sub-agent reads its model and
// effort off (the transcript's dispatch card, the drawer's readout, the rail row tooltip, the resting
// card's child line). It is composed here, on the server, for the same reason the codex spawn cell is
// (`describeCell` in codex-subagents.ts, `codexAgentCell` in transcript.ts): a reader wants ONE cell
// naming the runtime, and deriving it per surface is how two of them come to disagree.
//
// Why it needs composing at all: until 2026-08-26 a Claude dispatch named both halves in one string
// (`frizz:opus-high`), so `subagent_type` verbatim WAS the cell. Splitting the profiles to effort-only
// (`frizz:high`, the model on the Agent tool's own `model` parameter — commit e6f30cf8) left every one
// of those surfaces reading an effort with no model beside it, and the model recorded nowhere at all.
// This puts it back in the canonical form the parsers already speak, so nothing downstream had to learn
// a second shape (web/lib/subAgentProfile.ts renders both, and has since before the split).
//
// AN OMITTED `model` IS NOT AN UNKNOWN ONE — for a profile frizz itself ships. The Agent tool resolves
// an omitted model to "the agent definition's model, or inherits from the parent", and frizz's own
// `frizz:<effort>` definitions pin effort ONLY (cc-worker/agents/*.md), so for those the parent's is
// the answer. The dispatching assistant record states exactly what the parent was running
// (`message.model` on 33493/33493 records measured across this machine's corpus, `effort` on 33430),
// so the cell resolves from that TURN rather than the session's current profile: a thread whose model
// changed mid-run still reads each dispatch at the model it actually launched under.
//
// A FOREIGN agent type inherits NOTHING here. `general-purpose`, `Explore` or a project's own
// `.claude/agents/*.md` may pin a model or effort frizz cannot see, and a cell that guessed the
// parent's would state a runtime the child never ran at. Such a dispatch keeps its type name and shows
// only what the call itself named — which is still everything the card showed before this existed.
//
// THE EDITION RIDES ALONG WHEREVER THE RECORD STATES IT ("opus 5.5", not "opus"). The thread's own
// composer names the edition its worker runs, so a child's readout that said only the family read as a
// different, vaguer kind of fact (maintainer 2026-11-09: "In some places, we include a version number,
// and in others, we don't. This needs to be consistent"). The model half is then the canonical wire id
// (`claude-opus-5-5`), which @frizz/shared's parseClaudeWireId reads on both sides of the wire. The
// record states it in three cases, which together were 684 of the 727 Claude dispatches on this machine
// over a fortnight:
//   · an INHERITED model is the dispatching turn's own id, exactly;
//   · an explicit id names its edition outright;
//   · an explicit alias of the TURN'S OWN FAMILY resolves to the turn's edition, because the child is a
//     session inside the parent's daemon, the same `claude` binary that resolved the parent's alias.
// An alias of ANOTHER family (`model: "sonnet"` from an Opus turn) states no edition here: the binary
// resolves it, and that binary may predate the pin this server would look it up in. The cell keeps the
// bare family, and the drawer fills the edition in from the child's own transcript (router
// `subAgentTranscript`'s `model`).
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra", "ultracode"])

// Claude writes `<synthetic>` as the model on the records it fabricates itself (an API-error bubble).
// Nothing was dispatched at that model and no child could inherit it.
const SYNTHETIC_MODEL = "<synthetic>"

interface DispatchProfileInput {
  /** `input.subagent_type` verbatim — the profile name, which may itself carry model and/or effort. */
  subagentType?: unknown
  /** `input.model` verbatim — the dispatch's explicit model, when the caller named one. */
  model?: unknown
  /** `message.model` of the assistant record that made the dispatch — what an omitted model inherits. */
  turnModel?: unknown
  /** `effort` of that same record — what a profile carrying no effort of its own inherits. */
  turnEffort?: unknown
}

/** The profile name's own halves. A modern cell is effort-only; a legacy one pinned the model too. */
function splitFrizzProfile(routed: string): { model?: string; effort?: string } {
  if (EFFORTS.has(routed)) return { effort: routed }
  const at = routed.lastIndexOf("-")
  if (at <= 0) return { model: routed }
  const effort = routed.slice(at + 1)
  return EFFORTS.has(effort) ? { model: routed.slice(0, at), effort } : { model: routed }
}

/** Provider payloads reach both callers untyped, so every field is narrowed rather than trusted. */
function text(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined
}

function shortModel(raw: unknown): string | undefined {
  const value = text(raw)
  if (!value || value === SYNTHETIC_MODEL) return undefined
  // `claude-opus-5` → `opus`, so an inherited model reads in the same words the picker and an explicit
  // `model: "opus"` use. An id the catalogue doesn't know survives verbatim rather than being dropped.
  return normalizeObservedThreadModel("claude", value) ?? value
}

/** The edition the child runs at, when the dispatch record states it — the three cases in the header. */
function dispatchEdition(family: string | undefined, explicit: unknown, turnModel: unknown): ClaudeWireId | undefined {
  const named = text(explicit)
  const namedId = named ? parseClaudeWireId(named) : undefined
  if (namedId) return namedId
  const turn = text(turnModel)
  const turnId = turn ? parseClaudeWireId(turn) : undefined
  return turnId && turnId.alias === family ? turnId : undefined
}

/**
 * The cell for one Claude `Agent` dispatch, or `undefined` when nothing is known about its runtime.
 * Shapes out, all of which web/lib/subAgentProfile.ts renders:
 *   frizz:claude-opus-5-5-high              a frizz profile (or none at all), edition known
 *   frizz:sonnet-high                       the same, from an alias whose edition the record cannot state
 *   general-purpose claude-opus-5-5/high    a foreign agent type, which keeps its name and gains what the call named
 *   frizz:high                              the model genuinely unknown — the profile verbatim, as before
 */
export function dispatchProfileCell(input: DispatchProfileInput): string | undefined {
  const type = text(input.subagentType)
  const namespaced = type?.startsWith("frizz:") ?? false
  const ours = namespaced || !type
  const fromType = namespaced ? splitFrizzProfile(type!.slice("frizz:".length).replace(/^frizz-/, "")) : {}
  // Explicit beats the profile's own pin, which beats inheritance — the order the runtime resolves them,
  // and the last of the three is offered only for a profile whose definition we know pins nothing.
  const family = shortModel(input.model) ?? fromType.model ?? (ours ? shortModel(input.turnModel) : undefined)
  const model = dispatchEdition(family, input.model, input.turnModel)?.resolvedModel ?? family
  const effort = fromType.effort ?? (ours ? text(input.turnEffort) : undefined)
  if (!model && !effort) return type
  const pair = model && effort ? `${model}/${effort}` : (model ?? effort)!
  // A frizz profile and a bare dispatch both speak the namespaced form; anything else is an agent type
  // with a name worth keeping, so the pair joins it the way a codex spawn's role does.
  if (ours) return `frizz:${[model, effort].filter(Boolean).join("-")}`
  return `${type} ${pair}`
}

const CLAUDE_FAMILIES = new Set(["fable", "opus", "sonnet", "haiku"])

// The cell's Claude model half, and how to put a resolved id in its place — the inverse of the composer
// above, for the shapes it writes. `model` is absent when the cell names none.
function cellModelSlot(cell: string | undefined): { model?: string; compose: (id: string) => string } {
  if (!cell) return { compose: (id) => `frizz:${id}` }
  if (cell.startsWith("frizz:")) {
    const { model, effort } = splitFrizzProfile(cell.slice("frizz:".length).replace(/^frizz-/, ""))
    return { model, compose: (id) => `frizz:${[id, effort].filter(Boolean).join("-")}` }
  }
  // A foreign agent type, with the model its call named, if it named one: "general-purpose sonnet".
  const at = cell.lastIndexOf(" ")
  const last = at > 0 ? cell.slice(at + 1) : undefined
  if (last && (CLAUDE_FAMILIES.has(last) || parseClaudeWireId(last))) return { model: last, compose: (id) => `${cell.slice(0, at)} ${id}` }
  return { compose: (id) => `${cell} ${id}` }
}

/** Does this cell lack the edition of a Claude model — the only cells worth reading a child's transcript for? */
export function cellLacksEdition(cell: string | undefined): boolean {
  const { model } = cellModelSlot(cell)
  return model === undefined || CLAUDE_FAMILIES.has(model)
}

/**
 * A cell refined by the model the child's OWN transcript says it ran (a Claude wire id): the edition the
 * dispatch record could not state — see the header. A cell that already states one, or names a model
 * that is not a Claude family, is returned as it was, and so is any cell when the id is not a Claude one.
 */
export function cellWithObservedModel(cell: string | undefined, observed: string | undefined): string | undefined {
  const id = observed ? parseClaudeWireId(observed) : undefined
  if (!id || !cellLacksEdition(cell)) return cell
  return cellModelSlot(cell).compose(id.resolvedModel)
}

/**
 * The cell a surface shows for one CLAUDE child: refined from the child's own transcript only when the
 * cell lacks its edition, so the common case — an edition the parent's record already stated — costs no
 * read at all. A Codex or OpenCode child (`outputFormat`) keeps its provider's own cell.
 */
export function observedDispatchCell(cell: string | undefined, child: { outputFile?: string; outputFormat?: string } | undefined): string | undefined {
  if (!child?.outputFile || child.outputFormat || !cellLacksEdition(cell)) return cell
  return cellWithObservedModel(cell, readObservedChildModel(child.outputFile))
}
