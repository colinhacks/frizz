import { test } from "node:test"
import assert from "node:assert/strict"
import { acpAgentIdFromModel, acpModelIdFromModel, acpModelSlug, type CodexModel, type DispatchPreferences } from "@frizz/shared"
import { applyDispatchPreferenceUpdate, dispatchModelGroups, dispatchProfileGroups, resolveDispatchPreferences } from "./dispatchPreferences.ts"

const models: CodexModel[] = [
  { slug: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", defaultEffort: "medium", efforts: ["low", "medium", "high", "ultra"] },
  { slug: "gpt-5.5", displayName: "GPT-5.5", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh"] },
]

const preferences: DispatchPreferences = {
  backend: "claude",
  claude: { model: "sonnet", effort: "max", permissionMode: "acceptEdits" },
  codex: { model: "gpt-5.5", effort: "xhigh", permissionMode: "plan" },
}

test("provider switching restores each runtime's exact model and effort profile", () => {
  assert.deepEqual(resolveDispatchPreferences(preferences, models), {
    backend: "claude",
    model: "sonnet",
    pickerModel: "sonnet",
    effort: "max",
    codexModel: undefined,
    modelAvailable: true,
    effortAvailable: true,
    effortOptions: [
      { value: "low", label: "Low" },
      { value: "medium", label: "Medium" },
      { value: "high", label: "High" },
      { value: "xhigh", label: "X-high" },
      { value: "max", label: "Max" },
      // Sonnet is xhigh-capable, so it carries the ultracode rung (xhigh + workflow orchestration).
      { value: "ultracode", label: "Ultracode" },
    ],
  })
  const codex = applyDispatchPreferenceUpdate(preferences, { field: "backend", value: "codex" })
  const resolved = resolveDispatchPreferences(codex, models)
  assert.equal(resolved.model, "gpt-5.5")
  assert.equal(resolved.effort, "xhigh")
  assert.deepEqual(codex.claude, preferences.claude, "switching provider leaves Claude intent untouched")
})

test("choosing a model switches runtime atomically without replacing the other runtime profile", () => {
  const next = applyDispatchPreferenceUpdate(preferences, { field: "model", backend: "codex", value: "gpt-5.6-sol" })
  assert.equal(next.backend, "codex")
  assert.equal(next.codex.model, "gpt-5.6-sol")
  assert.deepEqual(next.claude, preferences.claude)
})

test("choosing a matrix cell writes one complete provider profile atomically", () => {
  const next = applyDispatchPreferenceUpdate(preferences, {
    field: "profile",
    backend: "codex",
    model: "gpt-5.6-sol",
    effort: "ultra",
  })
  assert.equal(next.backend, "codex")
  assert.deepEqual(next.codex, { ...preferences.codex, model: "gpt-5.6-sol", effort: "ultra" })
  assert.deepEqual(next.claude, preferences.claude)
})

test("dispatch profile groups keep provider catalogues and per-model effort sets scoped", () => {
  const groups = dispatchProfileGroups(models)
  assert.deepEqual(groups.map((group) => group.id), ["claude", "codex"])
  assert.deepEqual(
    groups[0]?.options.find((option) => option.model === "opus")?.efforts,
    ["low", "medium", "high", "xhigh", "max", "ultracode"],
    "the Claude ladder tops out at ultracode — and must never offer Codex-only ultra",
  )
  // Ultracode needs an xhigh-capable model; Claude ignores the setting on Haiku rather than failing,
  // so that row must not offer a rung that would quietly do nothing.
  assert.deepEqual(
    groups[0]?.options.find((option) => option.model === "haiku")?.efforts,
    ["low", "medium", "high", "xhigh", "max"],
    "Haiku cannot honour ultracode, so its row stops at max",
  )
  for (const option of groups[0]?.options ?? []) {
    assert.equal(option.efforts.includes("ultra"), false, "the Claude selector must not offer Codex-only ultra")
  }
  assert.deepEqual(groups[1]?.options[0], {
    model: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    defaultEffort: "medium",
    efforts: ["low", "medium", "high", "ultra"],
  })
  assert.equal(groups[1]?.options.some((option) => option.model === "opus"), false)
})

test("a renamed/unavailable saved model remains visible and invalid instead of becoming Opus or a catalogue default", () => {
  const saved: DispatchPreferences = {
    ...preferences,
    backend: "codex",
    codex: { model: "gpt-renamed", effort: "ultra", permissionMode: "bypassPermissions" },
  }
  const resolved = resolveDispatchPreferences(saved, models)
  assert.equal(resolved.model, "gpt-renamed")
  assert.equal(resolved.effort, "ultra")
  assert.equal(resolved.modelAvailable, false)
  assert.equal(resolved.effortAvailable, false)
  assert.equal(dispatchModelGroups(models, "codex", "gpt-renamed")[0]?.options[0]?.value, "gpt-renamed")
  assert.deepEqual(saved.codex, { model: "gpt-renamed", effort: "ultra", permissionMode: "bypassPermissions" }, "resolution is read-only")
})

test("an incompatible saved effort is surfaced for explicit correction rather than silently clamped", () => {
  const saved: DispatchPreferences = {
    ...preferences,
    backend: "codex",
    codex: { model: "gpt-5.5", effort: "ultra", permissionMode: "default" },
  }
  const resolved = resolveDispatchPreferences(saved, models)
  assert.equal(resolved.modelAvailable, true)
  assert.equal(resolved.effort, "ultra")
  assert.equal(resolved.effortAvailable, false)
  assert.equal(resolved.effortOptions[0]?.value, "ultra")
})

test("the acp model slug carries an optional agent model after @, and model ids may contain / and :", () => {
  assert.equal(acpModelSlug("opencode"), "acp:opencode")
  assert.equal(acpModelSlug("opencode", "openai/gpt-5.5"), "acp:opencode@openai/gpt-5.5")
  assert.equal(acpAgentIdFromModel("acp:opencode@openai/gpt-5.5"), "opencode")
  assert.equal(acpModelIdFromModel("acp:opencode@openai/gpt-5.5"), "openai/gpt-5.5")
  assert.equal(acpModelIdFromModel("acp:opencode"), undefined)
  assert.equal(acpAgentIdFromModel("acp:"), undefined)
  assert.equal(acpAgentIdFromModel("opus"), undefined)
  assert.equal(acpModelIdFromModel("acp:grok@grok-4.6:fast"), "grok-4.6:fast")
})

test("an acp profile naming a model resolves the agent for the grid and the model for the dropdown", () => {
  const agents = [{ id: "opencode", label: "OpenCode", command: "opencode", args: ["acp"], available: true }]
  const resolved = resolveDispatchPreferences({ ...preferences, backend: "acp", acp: { model: "acp:opencode@openai/gpt-5.5" } }, models, agents)
  assert.equal(resolved.model, "acp:opencode@openai/gpt-5.5")
  assert.equal(resolved.pickerModel, "acp:opencode")
  assert.equal(resolved.acpAgentId, "opencode")
  assert.equal(resolved.acpModelId, "openai/gpt-5.5")
  assert.equal(resolved.modelAvailable, true)
  assert.equal(resolved.effort, "")
  // The bare agent slug (the agent's own default model) has no model id, and a non-acp profile carries neither.
  const bare = resolveDispatchPreferences({ ...preferences, backend: "acp", acp: { model: "acp:opencode" } }, models, agents)
  assert.equal(bare.pickerModel, "acp:opencode")
  assert.equal(bare.acpModelId, undefined)
  assert.equal(resolveDispatchPreferences(preferences, models, agents).pickerModel, "sonnet")
  // Availability is the AGENT's: a model inside an uninstalled agent is unavailable, a model inside an installed one is not judged here.
  const missing = resolveDispatchPreferences({ ...preferences, backend: "acp", acp: { model: "acp:cursor@gpt-5.5" } }, models, agents)
  assert.equal(missing.modelAvailable, false)
  assert.equal(missing.pickerModel, "acp:cursor")
})

// The Claude rows read the EDITION the pinned runtime resolves each alias to ("Opus 5.5") — the same
// treatment the Codex rows get from the codex cache — while the VALUE stays the alias the profile is
// keyed on. An alias the runtime list does not name keeps its family word, which is also the whole
// loading / older-server state.
test("the Claude rows take their edition labels from the runtime-resolved catalogue, keyed on the alias", () => {
  const claudeModels = [
    { alias: "fable", label: "Fable 5.1", resolvedModel: "claude-fable-5-1" },
    { alias: "opus", label: "Opus 5.5", resolvedModel: "claude-opus-5-5" },
    { alias: "sonnet", label: "Sonnet 5", resolvedModel: "claude-sonnet-5" },
  ]
  const claude = dispatchProfileGroups(models, [], claudeModels).find((group) => group.id === "claude")!
  assert.deepEqual(claude.options.map((option) => [option.model, option.label]), [
    ["fable", "Fable 5.1"],
    ["opus", "Opus 5.5"],
    ["sonnet", "Sonnet 5"],
    ["haiku", "Haiku"],
  ])
  // Without the list (loading, an older server) every row keeps its family word.
  assert.deepEqual(
    dispatchProfileGroups(models).find((group) => group.id === "claude")!.options.map((option) => option.label),
    ["Fable", "Opus", "Sonnet", "Haiku"],
  )
  // The dropdown form overlays the same labels, and a saved alias still resolves as available.
  const groups = dispatchModelGroups(models, "claude", "opus", claudeModels)
  assert.equal(groups[0]!.label, "Claude Code")
  assert.equal(groups[0]!.options.find((option) => option.value === "opus")?.label, "Opus 5.5")
  assert.equal(resolveDispatchPreferences({ ...preferences, claude: { model: "opus", effort: "high", permissionMode: "acceptEdits" } }, models).modelAvailable, true)
})

test("the group a signed-out machine leads with goes first, and one agent is its own heading", () => {
  const opencode = { id: "opencode", label: "OpenCode", command: "opencode", available: true }
  const led = dispatchProfileGroups(models, [opencode], [], "acp")
  assert.deepEqual(led.map((group) => group.id), ["acp", "claude", "codex"])
  assert.equal(led[0]?.label, "OpenCode")
  assert.deepEqual(dispatchProfileGroups(models, [opencode]).map((group) => group.id), ["claude", "codex", "acp"])
  // No such group on this machine: the order is untouched rather than the menu emptied.
  assert.deepEqual(dispatchProfileGroups(models, [], [], "acp").map((group) => group.id), ["claude", "codex"])
  const two = dispatchProfileGroups(models, [opencode, { ...opencode, id: "kilo", label: "Kilo" }])
  assert.equal(two.at(-1)?.label, "ACP agents")
})
