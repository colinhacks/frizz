import { test } from "node:test"
import assert from "node:assert/strict"
import {
  claudeFallbackModel,
  claudeModelFromLimitName,
  normalizeObservedThreadModel,
  resolveRollbackProfile,
  threadProfileOptions,
  validateThreadProfile,
} from "./thread-profiles.ts"
import type { CodexModel } from "@frizz/shared"

test("thread profile catalogues expose complete provider-owned pairs", () => {
  for (const backend of ["claude", "codex"] as const) {
    const catalogue = threadProfileOptions(backend)
    assert.equal(catalogue.backend, backend)
    assert.ok(catalogue.options.length > 0)
    for (const option of catalogue.options) {
      assert.ok(option.model)
      assert.ok(option.efforts.length > 0)
      assert.ok(option.efforts.includes(option.defaultEffort))
      assert.doesNotThrow(() => validateThreadProfile(backend, option.model, option.defaultEffort))
    }
  }
})

test("profile validation fails closed across providers and for unknown backends", () => {
  assert.throws(() => validateThreadProfile("claude", "gpt-5.5", "high"), /Unsupported claude/)
  // Claude Code 2.1.209 advertises low..max for --effort. Do not expose a Codex-only
  // value that the Claude CLI would reject at launch or on a profile reattach.
  assert.throws(() => validateThreadProfile("claude", "opus", "ultra"), /Unsupported claude model\/effort pair: opus \/ ultra/)
  assert.throws(() => validateThreadProfile("codex", "sonnet", "high"), /Unsupported codex/)
  assert.throws(() => threadProfileOptions("future-provider"), /unknown backend/)
})

test("rollback profiles reconstruct a launchable pair for a never-recorded effort", () => {
  // A recorded, supported pair is preserved exactly — coercion must never rewrite a real effort.
  assert.deepEqual(resolveRollbackProfile("claude", "opus", "high"), { model: "opus", effort: "high" })
  // Claude records the model but often not the launch effort. Both the absent and the unrecognized
  // (e.g. a codex-only "ultra") case resolve to that model's default so the rollback stays launchable.
  assert.deepEqual(resolveRollbackProfile("claude", "fable", ""), { model: "fable", effort: "medium" })
  assert.deepEqual(resolveRollbackProfile("claude", "fable", "ultra"), { model: "fable", effort: "medium" })
  // An unknown MODEL still fails closed: nothing in the catalogue can rebuild a launchable pair.
  assert.throws(() => resolveRollbackProfile("claude", "claude-mystery-9", "high"), /Unsupported claude model\/effort pair/)
  assert.throws(() => resolveRollbackProfile("future-provider", "fable", "high"), /unknown backend/)
})

test("observed model normalization accepts only the current provider's identities", () => {
  assert.equal(normalizeObservedThreadModel("claude", "claude-opus-4-6"), "opus")
  // A model whose version carries a MINOR part — Claude Code 2.1.280 bills `opus` as claude-opus-5-5 —
  // still collapses to the family the picker offers. The catalogue keys on the family, never a version.
  assert.equal(normalizeObservedThreadModel("claude", "claude-opus-5-5"), "opus")
  // …and 2.1.284 moved `sonnet` the same way, to claude-sonnet-5-5.
  assert.equal(normalizeObservedThreadModel("claude", "claude-sonnet-5-5"), "sonnet")
  assert.equal(normalizeObservedThreadModel("claude", "gpt-5.5"), undefined)
  assert.equal(normalizeObservedThreadModel("codex", "sonnet"), undefined)
})

test("Codex profile helpers share an explicitly version-checked catalogue", () => {
  const models: CodexModel[] = [{
    slug: "gpt-compatible",
    displayName: "GPT Compatible",
    defaultEffort: "medium",
    efforts: ["medium", "high"],
  }]
  assert.equal(normalizeObservedThreadModel("codex", "gpt-compatible", models), "gpt-compatible")
  assert.doesNotThrow(() => validateThreadProfile("codex", "gpt-compatible", "high", models))
  assert.deepEqual(resolveRollbackProfile("codex", "gpt-compatible", "", models), {
    model: "gpt-compatible",
    effort: "medium",
  })
  assert.throws(() => validateThreadProfile("codex", "gpt-5.5", "high", models), /Unsupported codex/)
})

// LOAD-BEARING since the spawn edge started requesting the 1M window: every Claude dispatch of a
// 1M-capable alias now launches as `opus[1m]`, so the model Claude reports back carries the suffix
// (`claude-opus-5[1m]`). It must normalize to the BARE picker alias — the catalogue has no `[1m]` row,
// and a value that failed to collapse would strand the thread's model select on an unknown option.
// See claude-context-window.ts.
test("an observed 1M model collapses to the bare picker alias", () => {
  assert.equal(normalizeObservedThreadModel("claude", "claude-opus-5[1m]"), "opus")
  assert.equal(normalizeObservedThreadModel("claude", "claude-sonnet-5[1m]"), "sonnet")
  // Measured on the provisioned 2.1.280: the pair frizz actually launches (`opus[1m]` + `--fallback-model
  // opus`) comes back as `claude-opus-5-5[1m]` — a minor version AND the suffix in one observed value.
  assert.equal(normalizeObservedThreadModel("claude", "claude-opus-5-5[1m]"), "opus")
  assert.equal(normalizeObservedThreadModel("claude", "opus[1m]"), "opus")
  // The bare id is unaffected — an account already on 1M reports no suffix at all.
  assert.equal(normalizeObservedThreadModel("claude", "claude-opus-5"), "opus")
})

// ---- The MODEL-SCOPED-CAP fallback ladder ---------------------------------------------------------
// Read by the scheduler when the provider says "You've reached your Fable 5 limit. Switch to another
// model … to continue" — so the two functions below are what turn that sentence into an argv change.

test("the fallback ladder walks the catalogue down and ends at the bottom rung", () => {
  assert.equal(claudeFallbackModel("fable"), "opus")
  assert.equal(claudeFallbackModel("opus"), "sonnet")
  assert.equal(claudeFallbackModel("sonnet"), "haiku")
  // Haiku has nothing below it, and an unknown model has no place on the ladder at all — both cases
  // leave the thread waiting for its window rather than being switched to a guess.
  assert.equal(claudeFallbackModel("haiku"), undefined)
  assert.equal(claudeFallbackModel("claude-mystery-9"), undefined)
})

test("a limit message names a model in the PROVIDER's spelling, matched by token prefix", () => {
  // The verbatim name from the real 2026-08-31 record. The catalogue keys on the bare family, so the
  // version the message carries has to be tolerated rather than matched literally.
  assert.equal(claudeModelFromLimitName("Fable 5"), "fable")
  assert.equal(claudeModelFromLimitName("Opus 4.6"), "opus")
  assert.equal(claudeModelFromLimitName("Opus 5.5"), "opus")
  assert.equal(claudeModelFromLimitName("Sonnet 5.5"), "sonnet")
  assert.equal(claudeModelFromLimitName("Haiku 4.5"), "haiku")
  assert.equal(claudeModelFromLimitName("sonnet"), "sonnet")
  // …and it fails closed rather than reaching for the nearest rung: a name the catalogue cannot place
  // must not be answered with a downgrade to something the operator never chose.
  assert.equal(claudeModelFromLimitName("Fabulous 5"), undefined)
  assert.equal(claudeModelFromLimitName(""), undefined)
  assert.equal(claudeModelFromLimitName("  "), undefined)
})

test("a running Claude thread's profile rows take their edition labels from the resolved catalogue", () => {
  const { options } = threadProfileOptions("claude", [
    { alias: "opus", label: "Opus 5.5", resolvedModel: "claude-opus-5-5" },
    { alias: "haiku", label: "Haiku 4.5", resolvedModel: "claude-haiku-4-5-20251001" },
  ])
  assert.deepEqual(options.map((option) => [option.model, option.label]), [
    ["fable", "Fable"],
    ["opus", "Opus 5.5"],
    ["sonnet", "Sonnet"],
    ["haiku", "Haiku 4.5"],
  ])
  assert.deepEqual(threadProfileOptions("claude").options.map((option) => option.label), ["Fable", "Opus", "Sonnet", "Haiku"])
})

test("a running Codex thread's profile rows use the runtime-compatible catalogue", () => {
  const { options } = threadProfileOptions("codex", undefined, [{
    slug: "gpt-compatible",
    displayName: "GPT Compatible",
    defaultEffort: "high",
    efforts: ["medium", "high"],
  }])
  assert.deepEqual(options, [{
    model: "gpt-compatible",
    label: "GPT Compatible",
    defaultEffort: "high",
    efforts: ["medium", "high"],
  }])
})
