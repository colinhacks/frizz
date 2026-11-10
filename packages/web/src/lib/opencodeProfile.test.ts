import assert from "node:assert/strict"
import test from "node:test"
import type { OpencodeModels } from "@frizz/shared"
import { dispatchProfileUpdate } from "./dispatchPreferences.ts"
import { opencodeProfileGroup, opencodeSelection, opencodeSlugOf } from "./opencodeProfile.ts"
import {
  moveProfileGridSelection,
  profileGridDisplayLabel,
  profileGridDisplayParts,
  profileGridEfforts,
  profileGridListedOptions,
  profileGridMatrixGroups,
  profileGridResolveSelection,
  profileGridShownModel,
  type ProfileGridGroup,
} from "./profileGrid.ts"

const listed: OpencodeModels = {
  available: true,
  version: "2.0.27",
  defaultModel: "opencode:opencode/big-pickle",
  models: [
    { providerID: "opencode", id: "big-pickle", name: "Big Pickle", variants: ["low", "high"] },
    { providerID: "opencode", id: "glm-5.3-flash-free", name: "GLM 5.3 Flash", variants: [] },
    { providerID: "openai", id: "gpt-5.5", name: "GPT-5.5", variants: ["minimal", "xhigh"] },
  ],
}

test("a stored slug splits into the model and its variant, and goes back together", () => {
  assert.deepEqual(opencodeSelection("opencode:"), { provider: "opencode", model: "opencode:", effort: "" })
  assert.deepEqual(opencodeSelection(undefined), { provider: "opencode", model: "opencode:", effort: "" })
  assert.deepEqual(opencodeSelection("opencode:openai/gpt-5.5#xhigh"), { provider: "opencode", model: "opencode:openai/gpt-5.5", effort: "xhigh" })
  assert.equal(opencodeSlugOf({ model: "opencode:openai/gpt-5.5", effort: "xhigh" }), "opencode:openai/gpt-5.5#xhigh")
  assert.equal(opencodeSlugOf({ model: "opencode:openai/gpt-5.5", effort: "" }), "opencode:openai/gpt-5.5")
  assert.equal(opencodeSlugOf({ model: "opencode:", effort: "high" }), "opencode:")
  assert.deepEqual(dispatchProfileUpdate({ provider: "opencode", model: "opencode:openai/gpt-5.5", effort: "minimal" }), {
    field: "profile",
    backend: "opencode",
    model: "opencode:openai/gpt-5.5#minimal",
  })
})

test("the list is the models by name, each with its own levels, and no Default row", () => {
  const group = opencodeProfileGroup({ models: listed })
  assert.equal(group.layout, "dropdown")
  assert.equal(group.experimental, true)
  assert.deepEqual(profileGridListedOptions(group).map((option) => [option.model, option.label, option.section, option.efforts]), [
    ["opencode:opencode/big-pickle", "Big Pickle", "opencode", ["", "low", "high"]],
    ["opencode:opencode/glm-5.3-flash-free", "GLM 5.3 Flash", "opencode", [""]],
    ["opencode:openai/gpt-5.5", "GPT-5.5", "openai", ["", "minimal", "xhigh"]],
  ])
  // The bare slug, OpenCode's configured model, is checked on that model's own row.
  assert.equal(profileGridShownModel(group, "opencode:"), "opencode:opencode/big-pickle")
  assert.equal(profileGridShownModel(group, "opencode:openai/gpt-5.5"), "opencode:openai/gpt-5.5")
})

test("the trigger reads OpenCode, then the model name in the edition ink, then the level", () => {
  const group = opencodeProfileGroup({ models: listed })
  assert.deepEqual(profileGridDisplayParts([group], { provider: "opencode", model: "opencode:", effort: "" }), { name: "OpenCode", edition: "Big Pickle" })
  assert.deepEqual(
    profileGridDisplayParts([group], { provider: "opencode", model: "opencode:openai/gpt-5.5", effort: "xhigh" }),
    { name: "OpenCode", edition: "GPT-5.5", effort: "xhigh" },
  )
  assert.equal(profileGridDisplayLabel([group], { provider: "opencode", model: "opencode:openai/gpt-5.5", effort: "xhigh" }), "OpenCode GPT-5.5 › xhigh")
  // Before the list arrives the model has no name yet: the trigger says OpenCode alone.
  const early = opencodeProfileGroup({ loading: true })
  assert.deepEqual(profileGridDisplayParts([early], { provider: "opencode", model: "opencode:", effort: "" }), { name: "OpenCode" })
})

test("a level picked on the configured model stores that model itself", () => {
  const group = opencodeProfileGroup({ models: listed })
  assert.deepEqual(
    profileGridResolveSelection([group], { provider: "opencode", model: "opencode:", effort: "high" }),
    { provider: "opencode", model: "opencode:opencode/big-pickle", effort: "high" },
  )
  // With no level, the bare slug stays: OpenCode's own config keeps deciding the model.
  assert.deepEqual(
    profileGridResolveSelection([group], { provider: "opencode", model: "opencode:", effort: "" }),
    { provider: "opencode", model: "opencode:", effort: "" },
  )
})

test("a saved model the list no longer has still reads as itself", () => {
  const gone = opencodeProfileGroup({ models: listed, saved: "opencode:anthropic/claude-x#max" })
  const option = gone.options.find((entry) => entry.model === "opencode:anthropic/claude-x")
  assert.equal(option?.label, "anthropic/claude-x (unavailable)")
  assert.deepEqual(option?.efforts, ["", "max"])
  assert.deepEqual(profileGridDisplayParts([gone], { provider: "opencode", model: "opencode:anthropic/claude-x", effort: "max" }), { name: "OpenCode", edition: "anthropic/claude-x", effort: "max" })
  // Before the list arrives nothing is known to be gone.
  const early = opencodeProfileGroup({ saved: "opencode:anthropic/claude-x", loading: true })
  assert.equal(early.options.at(-1)?.label, "anthropic/claude-x")
  // A saved level the model stopped listing is kept on that model.
  const level = opencodeProfileGroup({ models: listed, saved: "opencode:openai/gpt-5.5#turbo" })
  assert.deepEqual(level.options.find((entry) => entry.model === "opencode:openai/gpt-5.5")?.efforts, ["", "minimal", "xhigh", "turbo"])
})

test("a failed list says so and keeps the configured model as its one row", () => {
  const group = opencodeProfileGroup({ models: { available: true, models: [], error: "service did not start" } })
  assert.deepEqual(profileGridListedOptions(group).map((option) => [option.model, option.label]), [["opencode:", "Configured model"]])
  assert.match(group.notice ?? "", /did not list its models \(service did not start\)/)
})

test("the dropdown group stays out of the Claude and Codex matrix", () => {
  const claude: ProfileGridGroup = {
    id: "claude",
    label: "Claude Code",
    options: [{ model: "sonnet", label: "Sonnet", efforts: ["low", "high"] }],
  }
  const groups = [claude, opencodeProfileGroup({ models: listed })]
  assert.deepEqual(profileGridMatrixGroups(groups).map((group) => group.id), ["claude"])
  // OpenCode's levels ("minimal", "xhigh") add no columns to the grid.
  assert.deepEqual(profileGridEfforts(groups), ["low", "high"])
  // Arrow keys move through the grid and never land on an OpenCode row.
  assert.equal(moveProfileGridSelection(groups, { provider: "claude", model: "sonnet", effort: "low" }, "ArrowDown"), null)
})
