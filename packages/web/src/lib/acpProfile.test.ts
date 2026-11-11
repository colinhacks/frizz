import assert from "node:assert/strict"
import test from "node:test"
import type { AcpAgentModels } from "@frizz/shared"
import { acpProfileGroup, acpSelection } from "./acpProfile.ts"
import { dispatchProfileUpdate } from "./dispatchPreferences.ts"
import { profileGridDisplayLabel, profileGridDisplayParts, profileGridListedOptions, profileGridShownModel } from "./profileGrid.ts"

const agent = { id: "opencode", label: "OpenCode" }
const advertised: AcpAgentModels = {
  agentId: "opencode",
  models: [
    { id: "openai/gpt-5.5", name: "OpenAI/GPT-5.5" },
    { id: "xai/grok-4.6", name: "xAI/Grok 4.6" },
    { id: "openai/gpt-5.4", name: "OpenAI/GPT-5.4" },
    { id: "opencode/big-pickle", name: "OpenCode Zen/Big Pickle" },
    { id: "anthropic/claude-opus-5", name: "Claude Opus 5" },
    { id: "local-llm", name: "Local" },
  ],
  current: "opencode/big-pickle",
  probedAt: "2026-09-16T00:00:00.000Z",
}

test("the group is the agent's, its models filed by the provider prefix of their names, with no level and no Default row", () => {
  const group = acpProfileGroup({ agent, models: advertised })
  assert.equal(group.id, "acp:opencode")
  assert.equal(group.label, "OpenCode")
  assert.equal(group.layout, "dropdown")
  assert.deepEqual(profileGridListedOptions(group).map((option) => [option.model, option.label, option.section, option.efforts]), [
    ["acp:opencode@openai/gpt-5.5", "GPT-5.5", "OpenAI", []],
    ["acp:opencode@xai/grok-4.6", "Grok 4.6", "xAI", []],
    ["acp:opencode@openai/gpt-5.4", "GPT-5.4", "OpenAI", []],
    ["acp:opencode@opencode/big-pickle", "Big Pickle", "OpenCode Zen", []],
    // No slash in the name: the id's prefix names the provider; neither: a generic section.
    ["acp:opencode@anthropic/claude-opus-5", "Claude Opus 5", "anthropic", []],
    ["acp:opencode@local-llm", "Local", "Models", []],
  ])
  // The bare slug, the agent's own configured model, is checked on that model's row.
  assert.equal(profileGridShownModel(group, "acp:opencode"), "acp:opencode@opencode/big-pickle")
})

test("the trigger reads the agent, then the model in the edition ink", () => {
  const group = acpProfileGroup({ agent, models: advertised })
  assert.deepEqual(profileGridDisplayParts([group], acpSelection("acp:opencode")), { name: "OpenCode", edition: "Big Pickle" })
  assert.equal(profileGridDisplayLabel([group], acpSelection("acp:opencode@openai/gpt-5.5")), "OpenCode GPT-5.5")
  // Before the list arrives the agent is all there is to name.
  assert.deepEqual(profileGridDisplayParts([acpProfileGroup({ agent, loading: true })], acpSelection("acp:opencode")), { name: "OpenCode" })
})

test("a selection names the agent's group, and a pick is saved as the ACP profile it names", () => {
  assert.deepEqual(acpSelection("acp:cursor@gpt-5.5"), { provider: "acp:cursor", model: "acp:cursor@gpt-5.5", effort: "" })
  assert.deepEqual(acpSelection("acp:cursor"), { provider: "acp:cursor", model: "acp:cursor", effort: "" })
  assert.deepEqual(dispatchProfileUpdate(acpSelection("acp:cursor@gpt-5.5")), { field: "profile", backend: "acp", model: "acp:cursor@gpt-5.5" })
})

test("a saved model the agent no longer lists stays visible and reads unavailable; while unknown it is shown verbatim", () => {
  const gone = acpProfileGroup({ agent, models: advertised, saved: "acp:opencode@openai/gpt-4o" })
  assert.equal(gone.options.at(-1)?.label, "openai/gpt-4o (unavailable)")
  assert.deepEqual(profileGridDisplayParts([gone], acpSelection("acp:opencode@openai/gpt-4o")), { name: "OpenCode", edition: "openai/gpt-4o" })
  assert.equal(acpProfileGroup({ agent, saved: "acp:opencode@openai/gpt-4o", loading: true }).options.at(-1)?.label, "openai/gpt-4o")
  // A saved model that IS listed is not listed twice, and another agent's saved slug adds nothing.
  assert.equal(acpProfileGroup({ agent, models: advertised, saved: "acp:opencode@openai/gpt-5.5" }).options.filter((option) => option.model === "acp:opencode@openai/gpt-5.5").length, 1)
  assert.equal(acpProfileGroup({ agent, models: advertised, saved: "acp:cursor@gpt-4o" }).options.length, acpProfileGroup({ agent, models: advertised }).options.length)
})

test("an agent that could not list its models says so and keeps its configured model as its one row", () => {
  const failed: AcpAgentModels = { agentId: "cursor", models: [], error: "not logged in", probedAt: advertised.probedAt }
  const group = acpProfileGroup({ agent: { id: "cursor", label: "Cursor" }, models: failed })
  assert.deepEqual(profileGridListedOptions(group).map((option) => [option.model, option.label]), [["acp:cursor", "Configured model"]])
  assert.equal(group.notice, "Cursor did not list its models (not logged in); threads run on its configured model")
})
