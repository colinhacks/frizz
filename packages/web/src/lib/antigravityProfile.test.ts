import assert from "node:assert/strict"
import test from "node:test"
import type { AntigravityModels, DispatchPreferences } from "@frizz/shared"
import { antigravityProfileGroup, antigravitySelection } from "./antigravityProfile.ts"
import { applyDispatchPreferenceUpdate, dispatchProfileGroups, dispatchProfileUpdate, dispatchProfileValue, resolveDispatchPreferences } from "./dispatchPreferences.ts"
import { dispatchProfileError } from "./githubDispatch.ts"
import { backendForModel } from "./options.ts"
import { profileGridDisplayLabel, profileGridDisplayParts, profileGridListedOptions, profileGridMatrixGroups, profileGridResolveSelection, profileGridShownModel } from "./profileGrid.ts"

// The free plan as `agy` 1.5.13 lists it: one model with thinking levels, the rest with none.
const listed: AntigravityModels = {
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
  assert.equal(backendForModel("antigravity:gemini-3.8-flash"), "antigravity")
  assert.equal(backendForModel("gemini-3.8-flash"), "claude", "a bare id cannot say which CLI runs it")
})

test("a selection is the slug and the thinking level, which rides the profile's effort", () => {
  assert.deepEqual(antigravitySelection("antigravity:gemini-3.8-flash", "low"), { provider: "antigravity", model: "antigravity:gemini-3.8-flash", effort: "low" })
  assert.deepEqual(antigravitySelection(undefined, undefined), { provider: "antigravity", model: "antigravity:", effort: "" })
  assert.deepEqual(antigravitySelection("opus", "high"), { provider: "antigravity", model: "antigravity:", effort: "high" })
  // The level is stored as the effort, never in the slug; the model's own default stores none.
  assert.deepEqual(dispatchProfileUpdate({ provider: "antigravity", model: "antigravity:gemini-3.8-flash", effort: "low" }), { field: "profile", backend: "antigravity", model: "antigravity:gemini-3.8-flash", effort: "low" })
  assert.deepEqual(dispatchProfileUpdate({ provider: "antigravity", model: "antigravity:claude-sonnet-4-6", effort: "" }), { field: "profile", backend: "antigravity", model: "antigravity:claude-sonnet-4-6", effort: undefined })
})

test("the group is a dropdown of the listed models, each with its own levels after its default", () => {
  const group = antigravityProfileGroup({ models: listed })
  assert.deepEqual({ id: group.id, label: group.label, layout: group.layout, experimental: group.experimental }, { id: "antigravity", label: "Antigravity", layout: "dropdown", experimental: true })
  assert.deepEqual(profileGridMatrixGroups([group]), [], "its levels are not the grid's columns")
  assert.deepEqual(profileGridListedOptions(group).map((option) => [option.model, option.label, option.efforts]), [
    ["antigravity:gemini-3.8-flash", "Gemini 3.8 Flash", ["", "low", "medium", "high"]],
    ["antigravity:claude-sonnet-4-6", "Claude Sonnet 4.6", []],
  ])
  // The bare slug, agy's configured model, is checked on that model's own row.
  assert.equal(profileGridShownModel(group, "antigravity:"), "antigravity:gemini-3.8-flash")
  // A level picked on the configured model stores that model itself, since a level belongs to a model.
  assert.deepEqual(profileGridResolveSelection([group], { provider: "antigravity", model: "antigravity:", effort: "low" }), { provider: "antigravity", model: "antigravity:gemini-3.8-flash", effort: "low" })
  assert.deepEqual(profileGridResolveSelection([group], { provider: "antigravity", model: "antigravity:", effort: "" }), { provider: "antigravity", model: "antigravity:", effort: "" })
})

test("the trigger reads Antigravity, then the model name, then the level", () => {
  const group = antigravityProfileGroup({ models: listed })
  assert.deepEqual(profileGridDisplayParts([group], { provider: "antigravity", model: "antigravity:", effort: "" }), { name: "Antigravity", edition: "Gemini 3.8 Flash" })
  assert.equal(profileGridDisplayLabel([group], { provider: "antigravity", model: "antigravity:gemini-3.8-flash", effort: "low" }), "Antigravity Gemini 3.8 Flash › low")
  assert.equal(profileGridDisplayLabel([group], { provider: "antigravity", model: "antigravity:claude-sonnet-4-6", effort: "" }), "Antigravity Claude Sonnet 4.6")
  // Before the list arrives the model has no name yet: the trigger says Antigravity alone.
  assert.deepEqual(profileGridDisplayParts([antigravityProfileGroup({ loading: true })], { provider: "antigravity", model: "antigravity:", effort: "" }), { name: "Antigravity" })
})

test("a saved profile the list does not have still reads as itself", () => {
  // Not listed, and the list is in: gone from the plan.
  const gone = antigravityProfileGroup({ models: listed, saved: { model: "antigravity:gemini-4-neon", effort: "xhigh" } })
  assert.deepEqual(gone.options.at(-1), { model: "antigravity:gemini-4-neon", label: "gemini-4-neon (unavailable)", triggerLabel: "Antigravity", triggerEdition: "gemini-4-neon", efforts: ["", "xhigh"] })
  // Before the list arrives nothing is known either way, so no verdict.
  const early = antigravityProfileGroup({ loading: true, saved: { model: "antigravity:gemini-4-neon", effort: "xhigh" } })
  assert.equal(early.options.at(-1)!.label, "gemini-4-neon")
  assert.equal(profileGridDisplayLabel([early], { provider: "antigravity", model: "antigravity:gemini-4-neon", effort: "xhigh" }), "Antigravity gemini-4-neon › xhigh")
  // A stored level the listed model no longer names stays choosable.
  const level = antigravityProfileGroup({ models: listed, saved: { model: "antigravity:claude-sonnet-4-6", effort: "high" } })
  assert.deepEqual(level.options.find((option) => option.model === "antigravity:claude-sonnet-4-6")!.efforts, ["", "high"])
  // A list that could not be read says why, in the agent's own words.
  const failed = antigravityProfileGroup({ models: { available: true, models: [], error: "Antigravity is not signed in. Run `agy` in a terminal and sign in." } })
  assert.equal(failed.notice, "Antigravity is not signed in. Run `agy` in a terminal and sign in. Threads run on its configured model.")
  assert.deepEqual(failed.options.map((option) => option.label), ["Configured model"])
})

test("the model menu has an Antigravity group only where agy is installed", () => {
  assert.deepEqual(dispatchProfileGroups([], [], [], undefined, undefined, [], undefined, { installed: false }).map((group) => group.id), ["claude", "codex"])
  assert.deepEqual(dispatchProfileGroups([]).map((group) => group.id), ["claude", "codex"])
  const groups = dispatchProfileGroups([], [{ id: "cursor", label: "Cursor", command: "cursor-agent", available: true }], [], undefined, undefined, [], undefined, { installed: true, models: listed })
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
