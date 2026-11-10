import assert from "node:assert/strict"
import test from "node:test"
import { subAgentProfileCell, subAgentProfileLabel, subAgentProfileParts } from "./subAgentProfile.ts"

test("sub-agent profile readout formats provider cells without inventing missing values", () => {
  assert.equal(subAgentProfileLabel("frizz:opus-high"), "opus › high")
  assert.equal(subAgentProfileLabel("frizz:frizz-sonnet-medium"), "sonnet › medium")
  assert.equal(subAgentProfileLabel("frizz:haiku"), "haiku")
  // An effort-only profile (the shape since 2026-08-26) reads as the effort alone: the model is not in
  // the cell, and the readout does not invent one.
  assert.equal(subAgentProfileLabel("frizz:high"), "high")
  assert.equal(subAgentProfileLabel("frizz:opus-ultracode"), "opus › ultracode")
  assert.equal(subAgentProfileLabel("explorer gpt-5.6-terra/high"), "explorer · gpt-5.6-terra › high")
  assert.equal(subAgentProfileLabel("gpt-5.6-sol/ultra"), "gpt-5.6-sol › ultra")
  assert.equal(subAgentProfileLabel("general-purpose"), "general-purpose")
  assert.equal(subAgentProfileLabel(), "Profile unknown")
  assert.equal(subAgentProfileCell(), undefined)
})

test("a cell carrying the Claude wire id reads its edition, as the thread's own composer does", () => {
  assert.equal(subAgentProfileLabel("frizz:claude-opus-5-5-xhigh"), "opus 5.5 › xhigh")
  assert.deepEqual(subAgentProfileParts("frizz:claude-opus-5-5-xhigh"), { model: "opus", edition: "5.5", effort: "xhigh" })
  assert.equal(subAgentProfileLabel("frizz:claude-opus-5-high"), "opus 5 › high")
  // A dated snapshot is not an edition.
  assert.equal(subAgentProfileLabel("frizz:claude-haiku-4-5-20251001-low"), "haiku 4.5 › low")
  // No effort recorded: the model and edition alone.
  assert.equal(subAgentProfileLabel("frizz:claude-sonnet-5"), "sonnet 5")
  assert.equal(subAgentProfileLabel("general-purpose claude-opus-5-5/high"), "general-purpose · opus 5.5 › high")
  assert.equal(subAgentProfileLabel("general-purpose claude-opus-5-5"), "general-purpose · opus 5.5")
  assert.equal(subAgentProfileLabel("general-purpose sonnet"), "general-purpose · sonnet")
})

test("the child's own observed model names the model and edition the cell could not", () => {
  // Another family than the parent's: the cell has the alias only, the child's transcript the edition.
  assert.equal(subAgentProfileLabel("frizz:sonnet-medium", "claude-sonnet-5-5"), "sonnet 5.5 › medium")
  // A descendant's bare profile, and a foreign type with no model named at all.
  assert.equal(subAgentProfileLabel("frizz:high", "claude-opus-5-5"), "opus 5.5 › high")
  assert.equal(subAgentProfileLabel("Explore", "claude-haiku-4-5-20251001"), "Explore · haiku 4.5")
  assert.equal(subAgentProfileLabel(undefined, "claude-opus-5-5"), "opus 5.5")
  // What the child ran beats what the dispatch expected.
  assert.equal(subAgentProfileLabel("frizz:claude-opus-5-high", "claude-opus-5-5"), "opus 5.5 › high")
  // Nothing a Claude id can refine, or nothing a Claude id at all: the cell stands.
  assert.equal(subAgentProfileLabel("explorer gpt-5.6-terra/high", "claude-opus-5-5"), "explorer · gpt-5.6-terra › high")
  assert.equal(subAgentProfileLabel("frizz:opus-high", "<synthetic>"), "opus › high")
  assert.equal(subAgentProfileLabel("frizz:opus-high", "some-future-model"), "opus › high")
})
