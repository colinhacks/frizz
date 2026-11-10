import assert from "node:assert/strict"
import test from "node:test"
import { cellLacksEdition, cellWithObservedModel, dispatchProfileCell, observedDispatchCell } from "./subagent-profile.ts"

// The dispatching turn every case below inherits from unless it names its own.
const turn = { turnModel: "claude-opus-5", turnEffort: "xhigh" }

test("an effort-only profile takes the model from the dispatch's own `model` parameter", () => {
  // The turn's own family: the same binary resolves the alias to the turn's edition, so the cell states it.
  assert.equal(dispatchProfileCell({ subagentType: "frizz:high", model: "opus", ...turn }), "frizz:claude-opus-5-high")
  // Another family: its edition is the binary's to resolve, and the record does not say, so the bare
  // family stands rather than a guessed edition.
  assert.equal(dispatchProfileCell({ subagentType: "frizz:low", model: "haiku", ...turn }), "frizz:haiku-low")
  // The explicit model wins over the turn's, which is the whole point of naming one.
  assert.equal(dispatchProfileCell({ subagentType: "frizz:max", model: "sonnet", ...turn }), "frizz:sonnet-max")
  // An explicit id names its edition outright, whatever the turn ran.
  assert.equal(dispatchProfileCell({ subagentType: "frizz:max", model: "claude-sonnet-5-5", ...turn }), "frizz:claude-sonnet-5-5-max")
})

test("an omitted model is INHERITED from the dispatching turn, edition and all", () => {
  assert.equal(dispatchProfileCell({ subagentType: "frizz:high", ...turn }), "frizz:claude-opus-5-high")
  assert.equal(dispatchProfileCell({ subagentType: "frizz:medium", turnModel: "claude-opus-5-5" }), "frizz:claude-opus-5-5-medium")
  // The 1M context window is not a model, and a dated snapshot is not an edition: the cell keeps the id
  // the shared parser reads, minus the window suffix.
  assert.equal(dispatchProfileCell({ subagentType: "frizz:high", turnModel: "claude-fable-5-1[1m]" }), "frizz:claude-fable-5-1-high")
  assert.equal(dispatchProfileCell({ subagentType: "frizz:low", turnModel: "claude-haiku-4-5-20251001" }), "frizz:claude-haiku-4-5-20251001-low")
  // …and a model id the catalogue does not know survives verbatim rather than vanishing.
  assert.equal(dispatchProfileCell({ subagentType: "frizz:high", turnModel: "some-future-model" }), "frizz:some-future-model-high")
})

test("a profile that pins BOTH halves keeps them (the pre-2026-08-26 shape)", () => {
  // Its pinned alias is the turn's own family, so the edition is the turn's.
  assert.equal(dispatchProfileCell({ subagentType: "frizz:opus-high", ...turn }), "frizz:claude-opus-5-high")
  assert.equal(dispatchProfileCell({ subagentType: "frizz:frizz-sonnet-medium", ...turn }), "frizz:sonnet-medium")
  // A model-only profile (the old haiku one) inherits the effort it never named.
  assert.equal(dispatchProfileCell({ subagentType: "frizz:haiku", ...turn }), "frizz:haiku-xhigh")
})

test("a foreign agent type keeps its name and shows only what the CALL named", () => {
  assert.equal(dispatchProfileCell({ subagentType: "general-purpose", model: "opus", ...turn }), "general-purpose claude-opus-5")
  assert.equal(dispatchProfileCell({ subagentType: "general-purpose", model: "sonnet", ...turn }), "general-purpose sonnet")
  // Nothing is inherited into it: `Explore`'s own definition may pin a model or effort frizz cannot
  // read, so claiming the dispatcher's would state a runtime the child never ran at.
  assert.equal(dispatchProfileCell({ subagentType: "Explore", ...turn }), "Explore")
})

test("nothing is invented when the turn recorded nothing", () => {
  assert.equal(dispatchProfileCell({ subagentType: "frizz:high" }), "frizz:high")
  assert.equal(dispatchProfileCell({ subagentType: "general-purpose" }), "general-purpose")
  assert.equal(dispatchProfileCell({}), undefined)
  // Claude stamps `<synthetic>` on the records it fabricates itself; no child ran at that model.
  assert.equal(dispatchProfileCell({ subagentType: "frizz:high", turnModel: "<synthetic>" }), "frizz:high")
  // Non-string provider fields are narrowed away rather than trusted.
  assert.equal(dispatchProfileCell({ subagentType: 7, model: {}, turnModel: null, turnEffort: [] }), undefined)
})

test("a dispatch with no profile at all still names the runtime it inherited", () => {
  assert.equal(dispatchProfileCell({ ...turn }), "frizz:claude-opus-5-xhigh")
  assert.equal(dispatchProfileCell({ model: "haiku" }), "frizz:haiku")
})

test("the child's own observed model fills in the edition a cell lacked, and nothing else", () => {
  // Another family than the parent's: the alias, refined to the edition the child ran.
  assert.equal(cellWithObservedModel("frizz:sonnet-medium", "claude-sonnet-5-5"), "frizz:claude-sonnet-5-5-medium")
  // A descendant's bare sidecar profile, and a foreign type the call named no model for.
  assert.equal(cellWithObservedModel("frizz:high", "claude-opus-5-5"), "frizz:claude-opus-5-5-high")
  assert.equal(cellWithObservedModel("Explore", "claude-haiku-4-5-20251001"), "Explore claude-haiku-4-5-20251001")
  assert.equal(cellWithObservedModel("general-purpose sonnet", "claude-sonnet-5-5"), "general-purpose claude-sonnet-5-5")
  assert.equal(cellWithObservedModel(undefined, "claude-opus-5-5"), "frizz:claude-opus-5-5")
  // A cell that already states its edition, or a model that is not a Claude family, stands.
  assert.equal(cellWithObservedModel("frizz:claude-opus-5-high", "claude-opus-5-5"), "frizz:claude-opus-5-high")
  assert.equal(cellWithObservedModel("frizz:some-future-model-high", "claude-opus-5-5"), "frizz:some-future-model-high")
  // An observation that is not a Claude id refines nothing.
  assert.equal(cellWithObservedModel("frizz:sonnet-medium", "<synthetic>"), "frizz:sonnet-medium")
  assert.equal(cellWithObservedModel("frizz:sonnet-medium", undefined), "frizz:sonnet-medium")
})

test("a cell that states its edition, or a non-Claude child, costs no read", () => {
  // A path that does not exist: had either call read it, the cell would still stand, so these pin the
  // GUARD by what reaches the reader — `cellLacksEdition` is what decides.
  assert.equal(cellLacksEdition("frizz:claude-opus-5-5-high"), false)
  assert.equal(cellLacksEdition("general-purpose claude-opus-5-5"), false)
  assert.equal(cellLacksEdition("frizz:sonnet-high"), true)
  assert.equal(cellLacksEdition("frizz:high"), true)
  assert.equal(cellLacksEdition("Explore"), true)
  assert.equal(observedDispatchCell("explorer high", { outputFile: "/nonexistent/rollout.jsonl", outputFormat: "codex" }), "explorer high")
  assert.equal(observedDispatchCell("frizz:sonnet-high", undefined), "frizz:sonnet-high")
})
