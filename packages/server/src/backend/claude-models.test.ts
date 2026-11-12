import { test } from "node:test"
import assert from "node:assert/strict"
import { homedir } from "node:os"
import { query } from "@frizz/claude-agent-sdk-runtime"
import { parseClaudeWireId } from "@frizz/shared"
import { resolveClaudeLaunchModel } from "./claude-context-window.ts"
import { CLAUDE_MODELS_FALLBACK, probeClaudeModels, resolveClaudeModels } from "./claude-models.ts"
import { CLAUDE_CODE_VERSION, provisionedBinary, runtimesRoot } from "../runtimes.ts"

// The REAL answer of `supportedModels()` on Claude Code 2.1.281 (2026-09-24), fields verbatim, trimmed
// of the capability flags the resolver ignores. Its shape is the point: there is NO bare `opus` row and
// NO bare `fable` row — Opus rides `default` and `opus[1m]`, Fable a row keyed on its wire id — so the
// resolver has to read the family off `resolvedModel` / `value`, never match the alias by name.
const REAL_2_1_281 = [
  { value: "default", resolvedModel: "claude-opus-5-5[1m]", displayName: "Default (recommended)", description: "Opus 5.5 with 1M context · Best for everyday, complex tasks" },
  { value: "opus[1m]", resolvedModel: "claude-opus-5-5[1m]", displayName: "Opus (1M context)", description: "Opus 5.5 with 1M context · Best for everyday, complex tasks" },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable", description: "Fable 5.1 · Most capable for your hardest and longest-running tasks" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5", displayName: "Sonnet", description: "Sonnet 5 · Efficient for routine tasks" },
  { value: "haiku", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku", description: "Haiku 4.5 · Fastest for quick answers" },
]

test("the 2.1.281 catalogue resolves every alias to its edition, in Frizz's order", () => {
  assert.deepEqual(resolveClaudeModels(REAL_2_1_281), [
    { alias: "fable", label: "Fable 5.1", resolvedModel: "claude-fable-5-1", edition: "5.1" },
    { alias: "opus", label: "Opus 5.5", resolvedModel: "claude-opus-5-5", edition: "5.5" },
    { alias: "sonnet", label: "Sonnet 5", resolvedModel: "claude-sonnet-5", edition: "5" },
    { alias: "haiku", label: "Haiku 4.5", resolvedModel: "claude-haiku-4-5-20251001", edition: "4.5" },
  ])
})

test("an alias no row resolves keeps its bare family label; junk rows are skipped", () => {
  assert.deepEqual(resolveClaudeModels([null, 7, "sonnet", { value: 3 }, { resolvedModel: "claude-sonnet-5" }]), [
    { alias: "fable", label: "Fable" },
    { alias: "opus", label: "Opus" },
    { alias: "sonnet", label: "Sonnet 5", resolvedModel: "claude-sonnet-5", edition: "5" },
    { alias: "haiku", label: "Haiku" },
  ])
  assert.deepEqual(resolveClaudeModels([]), CLAUDE_MODELS_FALLBACK)
})

test("with no row named for the alias, the first row of a family wins", () => {
  const rows = [
    { value: "default", resolvedModel: "claude-opus-5-5[1m]" },
    { value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8" },
  ]
  assert.equal(resolveClaudeModels(rows).find((m) => m.alias === "opus")?.label, "Opus 5.5")
})

// The REAL Fable rows of `supportedModels()` on 2026-11-09, the day Fable 5.2 shipped, in the order each
// build lists them. 2.1.319 lists `claude-fable-5-2` first, though `fable` still runs 5.1 on it (a real
// `--model fable` turn was served by `claude-fable-5-1`); 2.1.321 moved the alias.
const REAL_2_1_319_FABLE = [
  { value: "claude-fable-5-2", resolvedModel: "claude-fable-5-2", displayName: "Fable 5.2" },
  { value: "fable", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1" },
  { value: "claude-fable-5", resolvedModel: "claude-fable-5", displayName: "Fable 5" },
]
const REAL_2_1_321_FABLE = [
  { value: "fable", resolvedModel: "claude-fable-5-2", displayName: "Fable 5.2" },
  { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1" },
  { value: "claude-fable-5", resolvedModel: "claude-fable-5", displayName: "Fable 5" },
]

test("a family is labelled by the row named for its alias, because the alias is what a worker runs", () => {
  const fable = (rows: readonly unknown[]) => resolveClaudeModels(rows).find((m) => m.alias === "fable")
  assert.deepEqual(fable(REAL_2_1_319_FABLE), { alias: "fable", label: "Fable 5.1", resolvedModel: "claude-fable-5-1", edition: "5.1" })
  assert.deepEqual(fable(REAL_2_1_321_FABLE), { alias: "fable", label: "Fable 5.2", resolvedModel: "claude-fable-5-2", edition: "5.2" })
})

// The REAL answer of `supportedModels()` on Claude Code 2.1.322 (2026-11-12) on a machine whose account
// model list had not refreshed since 2026-10-05: a token-broker proxy gave Claude Code a placeholder
// token, and the refresh, which skips `ANTHROPIC_BASE_URL`, got 401s. Fable is a frozen account row, with
// no `fable` row beside it, while `--model fable` on the same binary started on `claude-fable-5-2`.
const REAL_2_1_322_FROZEN_ACCOUNT = [
  { value: "default", resolvedModel: "claude-sonnet-5-5", displayName: "Default (recommended)" },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet" },
  { value: "claude-fable-5-1[1m]", resolvedModel: "claude-fable-5-1", displayName: "Fable" },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus" },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku" },
]
const RUNS_2_1_322 = { fable: "claude-fable-5-2", opus: "claude-opus-5-5", sonnet: "claude-sonnet-5-5", haiku: "claude-haiku-5-5" }

test("what the runtime says an alias runs outranks every row", () => {
  const fable = (runs?: Parameters<typeof resolveClaudeModels>[1]) => resolveClaudeModels(REAL_2_1_322_FROZEN_ACCOUNT, runs).find((m) => m.alias === "fable")
  assert.equal(fable()?.label, "Fable 5.1")
  assert.deepEqual(fable(RUNS_2_1_322), { alias: "fable", label: "Fable 5.2", resolvedModel: "claude-fable-5-2", edition: "5.2" })
  assert.equal(resolveClaudeModels(REAL_2_1_319_FABLE, { fable: "claude-fable-5-1" }).find((m) => m.alias === "fable")?.label, "Fable 5.1")
})

test("an answer naming another family, or nothing parseable, leaves the alias to its rows", () => {
  const models = resolveClaudeModels(REAL_2_1_322_FROZEN_ACCOUNT, { fable: "claude-opus-5-5", opus: "", sonnet: "default" })
  assert.deepEqual(models.map((m) => m.label), ["Fable 5.1", "Opus 5.5", "Sonnet 5.5", "Haiku 5.5"])
})

test("the 1M suffix on an alias row still names the alias", () => {
  const rows = [
    { value: "claude-opus-5-5", resolvedModel: "claude-opus-5-5" },
    { value: "opus[1m]", resolvedModel: "claude-opus-5[1m]" },
  ]
  assert.equal(resolveClaudeModels(rows).find((m) => m.alias === "opus")?.label, "Opus 5")
})

// LIVE: the provisioned pin answers, and every alias Frizz offers resolves to an edition on it. This is
// the check that a pin bump cannot silently return the picker to bare family words. Skipped when the
// pin has not been provisioned on this machine (a fresh clone before first boot).
test("the pinned Claude Code resolves every alias to an edition", { skip: !provisionedBinary("claude", runtimesRoot(process.env), CLAUDE_CODE_VERSION) && `Claude Code ${CLAUDE_CODE_VERSION} is not provisioned` }, async () => {
  const bin = provisionedBinary("claude", runtimesRoot(process.env), CLAUDE_CODE_VERSION)!
  const models = await probeClaudeModels(bin, homedir())
  assert.deepEqual(models.map((m) => m.alias), ["fable", "opus", "sonnet", "haiku"])
  for (const model of models) {
    assert.match(model.label, /^(Fable|Opus|Sonnet|Haiku) \d+(\.\d+)*$/, `${model.alias} resolved to "${model.label}"`)
    assert.ok(model.resolvedModel?.startsWith(`claude-${model.alias}-`), `${model.alias} → ${model.resolvedModel}`)
  }
  // The probe switches one runtime between aliases; a worker is LAUNCHED on one, with the model pair the
  // spawn carries. Each has to land on the edition the picker names.
  for (const model of models) {
    const launch = resolveClaudeLaunchModel(model.alias)!
    const q = query({
      prompt: (async function* () { await new Promise<never>(() => {}) })(),
      options: { cwd: homedir(), pathToClaudeCodeExecutable: bin, persistSession: false, maxTurns: 0, ...launch },
    })
    try {
      assert.equal(parseClaudeWireId((await q.getContextUsage({ detail: "summary" })).model)?.resolvedModel, model.resolvedModel, `a worker launched on ${launch.model}`)
    } finally {
      q.close()
    }
  }
})
