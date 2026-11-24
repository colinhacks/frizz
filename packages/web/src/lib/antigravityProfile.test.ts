import assert from "node:assert/strict"
import test from "node:test"
import type { AntigravityModels, DispatchPreferences } from "@frizz/shared"
import { antigravityProfileGroup, antigravitySelection, isAntigravityNativeModel } from "./antigravityProfile.ts"
import { applyDispatchPreferenceUpdate, dispatchProfileGroups, dispatchProfileUpdate, dispatchProfileValue, resolveDispatchPreferences } from "./dispatchPreferences.ts"
import { dispatchProfileError } from "./githubDispatch.ts"
import { backendForModel } from "./options.ts"
import {
  moveProfileGridSelection,
  profileGridActiveKey,
  profileGridColumns,
  profileGridDisplayLabel,
  profileGridDisplayParts,
  profileGridListedMoreOptions,
  profileGridListedOptions,
  profileGridMatrixGroups,
  profileGridResolveSelection,
  profileGridSelectionKnown,
  profileGridShownModel,
} from "./profileGrid.ts"

// Google AI Ultra as `agy` 1.5.16 lists it: five regular Gemini models, three Orchestrator modes, and
// three partner/open-weight models.
const ultra: AntigravityModels = {
  available: true,
  version: "1.5.16",
  defaultModel: "gemini-4-neon",
  tier: "Google AI Ultra",
  models: [
    { id: "gemini-4-neon", name: "Gemini 4 Neon", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
    { id: "gemini-4-carbon", name: "Gemini 4 Carbon", efforts: ["low", "medium", "high"], defaultEffort: "high" },
    { id: "gemini-4-argon", name: "Gemini 4 Argon", efforts: ["low", "medium", "high"], defaultEffort: "high" },
    { id: "gemini-4-hydrogen", name: "Gemini 4 Hydrogen", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "high" },
    { id: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)", efforts: [] },
    { id: "gemini-pro-orchestrator", name: "Orchestrator (Carbon)", efforts: [] },
    { id: "gemini-pro-orchestrator-argon", name: "Orchestrator (Argon)", efforts: [] },
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", efforts: ["low", "medium", "high"], defaultEffort: "medium" },
    { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)", efforts: [] },
  ],
}

// The free plan: one regular Gemini model with thinking levels, partner models without.
const free: AntigravityModels = {
  available: true,
  version: "1.5.13",
  defaultModel: "gemini-3.8-flash",
  tier: "Free",
  models: [
    { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", efforts: ["low", "medium", "high"], defaultEffort: "high" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", efforts: [] },
  ],
}

const preferences: DispatchPreferences = {
  backend: "claude",
  claude: { model: "opus", effort: "high", permissionMode: "auto" },
  codex: { model: "gpt-5.5", effort: "medium", permissionMode: "default" },
}

test("an antigravity: slug runs on the Antigravity backend", () => {
  assert.equal(backendForModel("antigravity:"), "antigravity")
  assert.equal(backendForModel("antigravity:gemini-4-neon"), "antigravity")
  assert.equal(backendForModel("gemini-4-neon"), "claude", "a bare id cannot say which CLI runs it")
})

test("native Gemini models are separated from Orchestrator and third-party models", () => {
  assert.equal(isAntigravityNativeModel({ id: "gemini-4-neon", name: "Gemini 4 Neon" }), true)
  assert.equal(isAntigravityNativeModel({ id: "gemini-3.8-flash", name: "Gemini 3.8 Flash" }), true)
  assert.equal(isAntigravityNativeModel({ id: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" }), false)
  assert.equal(isAntigravityNativeModel({ id: "gemini-pro-orchestrator", name: "Orchestrator (Carbon)" }), false)
  assert.equal(isAntigravityNativeModel({ id: "claude-opus-5-5", name: "Claude Opus 5.5" }), false)
  assert.equal(isAntigravityNativeModel({ id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" }), false)
})

test("a selection is the slug and the thinking level, which rides the profile's effort", () => {
  assert.deepEqual(antigravitySelection("antigravity:gemini-3.8-flash", "low"), { provider: "antigravity", model: "antigravity:gemini-3.8-flash", effort: "low" })
  assert.deepEqual(antigravitySelection(undefined, undefined), { provider: "antigravity", model: "antigravity:", effort: "" })
  assert.deepEqual(antigravitySelection("opus", "high"), { provider: "antigravity", model: "antigravity:", effort: "high" })
  // The level is stored as the effort, never in the slug; the model's own default stores none.
  assert.deepEqual(dispatchProfileUpdate({ provider: "antigravity", model: "antigravity:gemini-3.8-flash", effort: "low" }), { field: "profile", backend: "antigravity", model: "antigravity:gemini-3.8-flash", effort: "low" })
  assert.deepEqual(dispatchProfileUpdate({ provider: "antigravity", model: "antigravity:claude-sonnet-4-6", effort: "" }), { field: "profile", backend: "antigravity", model: "antigravity:claude-sonnet-4-6", effort: undefined })
})

test("regular Gemini models sit in the effort grid while Orchestrator and third-party models live in Other models", () => {
  const group = antigravityProfileGroup({ models: ultra })
  assert.deepEqual(
    { id: group.id, label: group.label, layout: group.layout, experimental: group.experimental, moreLabel: group.moreLabel },
    { id: "antigravity", label: "Antigravity", layout: "grid", experimental: true, moreLabel: "Other models" },
  )
  assert.deepEqual(profileGridMatrixGroups([group]).map((g) => g.id), ["antigravity"])
  assert.deepEqual(profileGridColumns([group]), [["low"], ["medium"], ["high"], ["xhigh"]])
  assert.deepEqual(profileGridListedOptions(group).map((o) => [o.model, o.label, o.efforts]), [
    ["antigravity:gemini-4-neon", "Gemini 4 Neon", ["low", "medium", "high", "xhigh"]],
    ["antigravity:gemini-4-carbon", "Gemini 4 Carbon", ["low", "medium", "high"]],
    ["antigravity:gemini-4-argon", "Gemini 4 Argon", ["low", "medium", "high"]],
    ["antigravity:gemini-4-hydrogen", "Gemini 4 Hydrogen", ["low", "medium", "high", "xhigh"]],
    ["antigravity:gemini-3.8-flash", "Gemini 3.8 Flash", ["low", "medium", "high"]],
  ])
  assert.deepEqual(profileGridListedMoreOptions(group).map((o) => [o.model, o.label, o.section, o.efforts]), [
    ["antigravity:gemini-pro-orchestrator-neon", "Orchestrator (Neon)", "Orchestrator", []],
    ["antigravity:gemini-pro-orchestrator", "Orchestrator (Carbon)", "Orchestrator", []],
    ["antigravity:gemini-pro-orchestrator-argon", "Orchestrator (Argon)", "Orchestrator", []],
    ["antigravity:claude-opus-5-5", "Claude Opus 5.5", "Third-party", ["", "low", "medium", "high"]],
    ["antigravity:claude-sonnet-5-5", "Claude Sonnet 5.5", "Third-party", ["", "low", "medium", "high"]],
    ["antigravity:gpt-oss-120b-medium", "GPT-OSS 120B (Medium)", "Third-party", []],
  ])
  // The bare slug maps to the default Gemini row and highlights its default effort cell.
  assert.equal(profileGridShownModel(group, "antigravity:"), "antigravity:gemini-4-neon")
  assert.equal(profileGridSelectionKnown([group], { provider: "antigravity", model: "antigravity:", effort: "" }), true)
  assert.equal(
    profileGridActiveKey([group], { provider: "antigravity", model: "antigravity:", effort: "" }),
    JSON.stringify(["antigravity", "antigravity:gemini-4-neon", "high"]),
  )
  // A Gemini model saved with omitted effort ("") is still known and highlights its default effort cell.
  assert.equal(profileGridSelectionKnown([group], { provider: "antigravity", model: "antigravity:gemini-3.8-flash", effort: "" }), true)
  assert.equal(
    profileGridActiveKey([group], { provider: "antigravity", model: "antigravity:gemini-3.8-flash", effort: "" }),
    JSON.stringify(["antigravity", "antigravity:gemini-3.8-flash", "medium"]),
  )
  // Picking an effort on the configured alias pins the target model.
  assert.deepEqual(
    profileGridResolveSelection([group], { provider: "antigravity", model: "antigravity:", effort: "low" }),
    { provider: "antigravity", model: "antigravity:gemini-4-neon", effort: "low" },
  )
  // Keyboard navigation skips the hidden alias and moves across the Gemini grid rows.
  assert.deepEqual(
    moveProfileGridSelection([group], { provider: "antigravity", model: "antigravity:gemini-4-neon", effort: "xhigh" }, "ArrowDown"),
    { provider: "antigravity", model: "antigravity:gemini-4-carbon", effort: "high" },
  )
})

test("native Gemini models read directly in the trigger; fallback models keep the Antigravity prefix", () => {
  const group = antigravityProfileGroup({ models: ultra })
  assert.deepEqual(profileGridDisplayParts([group], { provider: "antigravity", model: "antigravity:gemini-4-neon", effort: "high" }), { name: "Gemini 4 Neon", effort: "high" })
  assert.equal(profileGridDisplayLabel([group], { provider: "antigravity", model: "antigravity:gemini-4-neon", effort: "high" }), "Gemini 4 Neon › high")
  assert.equal(profileGridDisplayLabel([group], { provider: "antigravity", model: "antigravity:", effort: "" }), "Gemini 4 Neon")
  // Orchestrator and third-party models keep "Antigravity" + dim model name so Antigravity's Claude is
  // never confused with Claude Code.
  assert.deepEqual(profileGridDisplayParts([group], { provider: "antigravity", model: "antigravity:gemini-pro-orchestrator-neon", effort: "" }), { name: "Antigravity", edition: "Orchestrator (Neon)" })
  assert.equal(profileGridDisplayLabel([group], { provider: "antigravity", model: "antigravity:claude-opus-5-5", effort: "medium" }), "Antigravity Claude Opus 5.5 › medium")
  // Before the list arrives, bare antigravity: reads as Antigravity alone.
  assert.deepEqual(profileGridDisplayParts([antigravityProfileGroup({ loading: true, saved: { model: "antigravity:", effort: "" } })], { provider: "antigravity", model: "antigravity:", effort: "" }), { name: "Antigravity" })
})

test("a saved profile the list does not have still reads as itself", () => {
  // Missing native Gemini model stays in the primary grid as unavailable.
  const goneNative = antigravityProfileGroup({ models: free, saved: { model: "antigravity:gemini-4-neon", effort: "xhigh" } })
  assert.deepEqual(goneNative.options.at(-1), { model: "antigravity:gemini-4-neon", label: "gemini-4-neon (unavailable)", efforts: ["xhigh"], allowDefaultEffort: true })
  // Missing non-Gemini model stays in the fallback list.
  const goneOther = antigravityProfileGroup({ models: free, saved: { model: "antigravity:gemini-pro-orchestrator-neon", effort: "" } })
  assert.deepEqual(goneOther.moreOptions?.at(-1), { model: "antigravity:gemini-pro-orchestrator-neon", label: "gemini-pro-orchestrator-neon (unavailable)", triggerLabel: "Antigravity", triggerEdition: "gemini-pro-orchestrator-neon", efforts: [] })
  // Before the list arrives nothing is known either way, so no verdict.
  const early = antigravityProfileGroup({ loading: true, saved: { model: "antigravity:gemini-4-neon", effort: "xhigh" } })
  assert.equal(early.options.at(-1)!.label, "gemini-4-neon")
  assert.equal(profileGridDisplayLabel([early], { provider: "antigravity", model: "antigravity:gemini-4-neon", effort: "xhigh" }), "gemini-4-neon › xhigh")
  // While loading on another provider, no placeholder "Configured model" row clutters the spinner.
  const loadingOther = antigravityProfileGroup({ loading: true })
  assert.deepEqual(loadingOther.options, [])
  // A stored level a fallback model no longer names stays choosable.
  const level = antigravityProfileGroup({ models: free, saved: { model: "antigravity:claude-sonnet-4-6", effort: "high" } })
  assert.deepEqual(level.moreOptions?.find((option) => option.model === "antigravity:claude-sonnet-4-6")!.efforts, ["", "high"])
  // A signed-out list marks the group signedOut, carries the notice, and keeps Configured model.
  const failed = antigravityProfileGroup({ models: { available: true, models: [], error: "Antigravity is not signed in. Run `agy` in a terminal and sign in." } })
  assert.equal(failed.signedOut, true)
  assert.equal(failed.notice, "Antigravity is not signed in. Run `agy` in a terminal and sign in. Threads run on its configured model.")
  assert.deepEqual(failed.options.map((option) => option.label), ["Configured model"])
})

test("an account whose default model is an Orchestrator resolves bare antigravity: into Other models", () => {
  const orchDefault: AntigravityModels = { ...ultra, defaultModel: "gemini-pro-orchestrator-neon" }
  const group = antigravityProfileGroup({ models: orchDefault })
  assert.equal(profileGridShownModel(group, "antigravity:"), "antigravity:gemini-pro-orchestrator-neon")
  assert.equal(profileGridDisplayLabel([group], { provider: "antigravity", model: "antigravity:", effort: "" }), "Antigravity Orchestrator (Neon)")
  assert.equal(profileGridListedMoreOptions(group).some((o) => o.model === "antigravity:"), false)
})

test("the model menu has an Antigravity group only where agy is installed", () => {
  assert.deepEqual(dispatchProfileGroups([], [], [], undefined, undefined, [], undefined, { installed: false }).map((group) => group.id), ["claude", "codex"])
  assert.deepEqual(dispatchProfileGroups([]).map((group) => group.id), ["claude", "codex"])
  const groups = dispatchProfileGroups([], [{ id: "cursor", label: "Cursor", command: "cursor-agent", available: true }], [], undefined, undefined, [], undefined, { installed: true, models: free })
  assert.deepEqual(groups.map((group) => group.id), ["claude", "codex", "antigravity", "acp:cursor"])
})

test("a saved Antigravity profile resolves to its slug and level, and is available where agy is", () => {
  const saved = applyDispatchPreferenceUpdate(preferences, { field: "profile", backend: "antigravity", model: "antigravity:gemini-3.8-flash", effort: "low" })
  assert.deepEqual(saved.antigravity, { model: "antigravity:gemini-3.8-flash", effort: "low" })
  const resolved = resolveDispatchPreferences(saved, [], [], true)
  assert.deepEqual(
    { backend: resolved.backend, model: resolved.model, pickerModel: resolved.pickerModel, effort: resolved.effort, modelAvailable: resolved.modelAvailable, effortAvailable: resolved.effortAvailable },
    { backend: "antigravity", model: "antigravity:gemini-3.8-flash", pickerModel: "antigravity:gemini-3.8-flash", effort: "low", modelAvailable: true, effortAvailable: true },
  )
  assert.deepEqual(dispatchProfileValue(resolved), { provider: "antigravity", model: "antigravity:gemini-3.8-flash", effort: "low" })
  assert.equal(resolveDispatchPreferences(saved, [], [], false).modelAvailable, false, "agy has gone from the machine")
  // No saved model is agy's own configured one, at its own level.
  const bare = resolveDispatchPreferences({ ...preferences, backend: "antigravity" }, [], [], true)
  assert.deepEqual({ model: bare.model, effort: bare.effort }, { model: "antigravity:", effort: "" })
  // The GitHub batch picker's last check before it dispatches.
  assert.equal(dispatchProfileError({ backend: "antigravity", model: "antigravity:gemini-3.8-flash", effort: "low" }, [], [], true), undefined)
  assert.equal(dispatchProfileError({ backend: "antigravity", model: "antigravity:" }, [], [], false), "Antigravity is not installed on this machine")
})
