import assert from "node:assert/strict"
import test from "node:test"
import { CODEX_MODELS_FALLBACK, type CodexModel } from "@frizz/shared"
import { codexProfileGroupFromModels, compareCodexVersions, parseCodexLine, partitionCodexOptions } from "./codexProfile.ts"
import {
  profileGridActiveKey,
  profileGridDisplayLabel,
  profileGridListedMoreOptions,
  profileGridListedOptions,
  profileGridMorePickEffort,
  profileGridSelectionKnown,
} from "./profileGrid.ts"

test("parseCodexLine extracts line key and numeric version tuples", () => {
  assert.deepEqual(parseCodexLine("gpt-6.2-sol"), { line: "gpt:sol", version: [6, 2] })
  assert.deepEqual(parseCodexLine("gpt-6.2-astra"), { line: "gpt:astra", version: [6, 2] })
  assert.deepEqual(parseCodexLine("gpt-6-astra"), { line: "gpt:astra", version: [6] })
  assert.deepEqual(parseCodexLine("gpt-5.6-terra"), { line: "gpt:terra", version: [5, 6] })
  assert.deepEqual(parseCodexLine("gpt-5.5"), { line: "gpt:", version: [5, 5] })
  assert.deepEqual(parseCodexLine("gpt-5.3-codex-spark"), { line: "gpt:codex-spark", version: [5, 3] })
  assert.deepEqual(parseCodexLine("o4-mini"), { line: "o:mini", version: [4] })
  assert.equal(parseCodexLine("codex-mini-latest"), undefined)
})

test("compareCodexVersions orders dotted versions numerically", () => {
  assert.ok(compareCodexVersions([6, 2], [6, 1]) > 0)
  assert.ok(compareCodexVersions([6, 1], [6]) > 0)
  assert.ok(compareCodexVersions([6], [5, 6]) > 0)
  assert.equal(compareCodexVersions([6, 0], [6]), 0)
  assert.ok(compareCodexVersions([10], [6, 9]) > 0)
})

test("codexProfileGroupFromModels keeps the latest version of each line in the grid and folds older versions into Other models", () => {
  const group = codexProfileGroupFromModels({ models: CODEX_MODELS_FALLBACK })
  assert.equal(group.id, "codex")
  assert.equal(group.label, "Codex")
  assert.equal(group.moreLabel, "Other models")
  assert.deepEqual(
    profileGridListedOptions(group).map((o) => o.model),
    ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.1-terra", "gpt-6-luna"],
    "only the latest Sol, Astra, Terra, and Luna sit in the primary effort grid, in cache priority order",
  )
  assert.deepEqual(
    profileGridListedMoreOptions(group).map((o) => o.model),
    ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
    "superseded versions live in Other models, preserving priority order",
  )
  // Older models stay known, selectable, and render their exact readout.
  assert.equal(profileGridSelectionKnown([group], { provider: "codex", model: "gpt-6-astra", effort: "high" }), true)
  assert.equal(
    profileGridActiveKey([group], { provider: "codex", model: "gpt-6-astra", effort: "high" }),
    JSON.stringify(["codex", "gpt-6-astra", "high"]),
  )
  assert.equal(
    profileGridDisplayLabel([group], { provider: "codex", model: "gpt-6-astra", effort: "high" }),
    "GPT-6 Astra › high",
  )
})

test("a catalogue with no superseded lines has no Other models row", () => {
  const small: CodexModel[] = [
    { slug: "gpt-6.2-sol", displayName: "GPT-6.2 Sol", defaultEffort: "low", efforts: ["low", "medium", "high"] },
    { slug: "gpt-6.2-astra", displayName: "GPT-6.2 Astra", defaultEffort: "low", efforts: ["low", "medium", "high"] },
    { slug: "custom-model", displayName: "Custom Model", defaultEffort: "medium", efforts: ["medium"] },
  ]
  const group = codexProfileGroupFromModels({ models: small })
  assert.deepEqual(group.options.map((o) => o.model), ["gpt-6.2-sol", "gpt-6.2-astra", "custom-model"])
  assert.equal(group.moreOptions, undefined)
  assert.equal(group.moreLabel, undefined)
})

test("partitionCodexOptions preserves unversioned slugs in primary", () => {
  const { primary, more } = partitionCodexOptions([
    { model: "gpt-6.2-astra" },
    { model: "experimental-codex" },
    { model: "gpt-6-astra" },
  ])
  assert.deepEqual(primary.map((o) => o.model), ["gpt-6.2-astra", "experimental-codex"])
  assert.deepEqual(more.map((o) => o.model), ["gpt-6-astra"])
})

test("picking a Codex model from Other models always yields a valid concrete effort", () => {
  const group = codexProfileGroupFromModels({ models: CODEX_MODELS_FALLBACK })
  const astra6 = group.moreOptions!.find((o) => o.model === "gpt-6-astra")!
  const luna56 = group.moreOptions!.find((o) => o.model === "gpt-5.6-luna")!
  // Coming from another Codex model whose effort is supported: keep it.
  assert.equal(profileGridMorePickEffort(astra6, undefined, "high", true), "high")
  // Coming from another Codex model at "ultra" onto a model that stops at "max": use its defaultEffort.
  assert.equal(profileGridMorePickEffort(luna56, undefined, "ultra", true), "medium")
  // Coming from another provider (e.g. Claude): use the model's own defaultEffort, never "".
  assert.equal(profileGridMorePickEffort(astra6, undefined, "high", false), "medium")
})
