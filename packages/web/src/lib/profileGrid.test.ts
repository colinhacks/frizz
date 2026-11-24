import assert from "node:assert/strict"
import test from "node:test"
import {
  moveProfileGridSelection,
  profileGridColumns,
  PROFILE_GRID_CELL_CLASS,
  PROFILE_GRID_COMPACT_TYPOGRAPHY_CLASS,
  PROFILE_GRID_TYPOGRAPHY_CLASS,
  profileGridDisplayLabel,
  profileGridDisplayParts,
  profileGridEfforts,
  profileGridSelectionFromKey,
  profileGridSelectionKey,
  profileGridSelectionKnown,
  profileGridSelections,
  profileGridTemplateColumns,
  type ProfileGridGroup,
} from "./profileGrid.ts"
import { PROMPT_CONTROL_TYPOGRAPHY_CLASS } from "./promptControlTypography.ts"

const groups: ProfileGridGroup[] = [
  {
    id: "claude",
    label: "Claude Code",
    options: [
      { model: "sonnet", label: "Sonnet", defaultEffort: "high", efforts: ["low", "high", "max"] },
      { model: "opus", label: "Opus with a deliberately long display name", defaultEffort: "max", efforts: ["high", "max"] },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    options: [
      { model: "gpt-5.6-sol", label: "GPT-5.6 Sol", defaultEffort: "medium", efforts: ["low", "medium", "high", "xhigh", "ultra"] },
    ],
  },
]

test("profile grid emits complete pairs and omits unsupported cells", () => {
  const cells = profileGridSelections(groups)
  assert.ok(cells.some((cell) => cell.provider === "codex" && cell.model === "gpt-5.6-sol" && cell.effort === "ultra"))
  assert.equal(cells.some((cell) => cell.model === "opus" && cell.effort === "low"), false)
  assert.deepEqual(profileGridEfforts(groups), ["low", "medium", "high", "xhigh", "max", "ultra"])
})

test("profile grid resolves a radio value only to a complete supported pair", () => {
  const expected = { provider: "codex", model: "gpt-5.6-sol", effort: "low" }
  assert.deepEqual(profileGridSelectionFromKey(groups, profileGridSelectionKey(expected)), expected)
  assert.equal(
    profileGridSelectionFromKey(groups, JSON.stringify(["codex", "gpt-5.6-sol", "max"])),
    undefined,
    "a cell absent from the model's effort row must not be committed",
  )
})

test("profile grid represents recovered, effort-unknown, retired, and pending labels honestly", () => {
  const current = { provider: "claude", model: "sonnet", effort: "high" }
  assert.equal(profileGridSelectionKnown(groups, current), true)
  assert.equal(profileGridDisplayLabel(groups, current), "Sonnet › high")
  assert.equal(profileGridSelectionKnown(groups, { provider: "claude", model: "retired", effort: "max" }), false)
  assert.equal(profileGridDisplayLabel(groups, { model: "retired", effort: "max" }), "retired › max")
  assert.equal(
    profileGridDisplayLabel(groups, { model: "sonnet" }),
    "Sonnet",
    "a provider-observed model without a launch effort shows the model alone — never a 'Legacy profile' label",
  )
  assert.equal(profileGridDisplayLabel(groups, undefined, "Profile loading…"), "Profile loading…")
  assert.equal(profileGridDisplayLabel(groups, { model: "gpt-5.6-sol", effort: "ultra" }, "Pending profile"), "GPT-5.6 Sol › ultra")
  // A running thread names the edition its worker RUNS, not the one the row resolves to now.
  assert.equal(profileGridDisplayLabel(groups, current, undefined, "Sonnet 4.6"), "Sonnet 4.6 › high")
})

test("profile grid keyboard movement follows rows and supported effort columns", () => {
  assert.deepEqual(
    moveProfileGridSelection(groups, { provider: "claude", model: "sonnet", effort: "high" }, "ArrowRight"),
    { provider: "claude", model: "sonnet", effort: "max" },
  )
  assert.deepEqual(
    moveProfileGridSelection(groups, { provider: "claude", model: "sonnet", effort: "low" }, "ArrowDown"),
    { provider: "claude", model: "opus", effort: "high" },
    "vertical movement lands on the nearest supported cell instead of an absent one",
  )
  assert.deepEqual(
    moveProfileGridSelection(groups, { provider: "claude", model: "opus", effort: "max" }, "ArrowDown"),
    { provider: "codex", model: "gpt-5.6-sol", effort: "xhigh" },
  )
  assert.equal(moveProfileGridSelection(groups, { provider: "claude", model: "sonnet", effort: "low" }, "ArrowLeft"), null)
})

test("profile grid triggers match the adjacent prompt-control type scale in every context", () => {
  const promptBoxContexts = [
    "new-thread",
    "sidebar",
    "queue-card",
    "thread-desktop",
    "thread-390px",
  ]
  const typographyFor = (context: string) => context.startsWith("thread") || context === "queue-card"
    ? PROFILE_GRID_COMPACT_TYPOGRAPHY_CLASS
    : PROFILE_GRID_TYPOGRAPHY_CLASS

  for (const context of promptBoxContexts) {
    const typography = typographyFor(context)
    assert.match(typography, /petite-caps/, `${context} keeps petite caps`)
    assert.equal(typography, PROMPT_CONTROL_TYPOGRAPHY_CLASS, `${context} uses the shared prompt-control type scale`)
    assert.doesNotMatch(typography, /max-|min-|sm:|md:|lg:/i, `${context} has no responsive type scale`)
    assert.doesNotMatch(typography, /text-\[(?:9\.5|11)px\]/, `${context} cannot regress to the tiny compact type`)
    assert.doesNotMatch(typography, /scale(?:-|\[)/, `${context} cannot scale profile text down`)
  }
  assert.equal(PROFILE_GRID_COMPACT_TYPOGRAPHY_CLASS, PROFILE_GRID_TYPOGRAPHY_CLASS)
})

test("profile grid cells use pointer affordance and icon-free selection ring/tint classes", () => {
  assert.match(PROFILE_GRID_CELL_CLASS, /cursor-pointer/)
  assert.match(PROFILE_GRID_CELL_CLASS, /data-\[state=checked\]:ring-accent/)
  assert.match(PROFILE_GRID_CELL_CLASS, /data-\[state=checked\]:bg-accent/)
  assert.match(PROFILE_GRID_CELL_CLASS, /data-\[highlighted\]:outline-fg/)
  assert.match(PROFILE_GRID_CELL_CLASS, /prompt-control-type/)
  assert.doesNotMatch(PROFILE_GRID_CELL_CLASS, /pl-/)
})

test("profile grid keeps the model column bounded and lets every effort column hug its label", () => {
  // 8.5rem holds the longest native model names (e.g. "Gemini 4 Hydrogen", 129px with padding) without
  // truncating; no effort track minimum so left-aligned labels leave no trailing slack.
  assert.equal(profileGridTemplateColumns(5), "minmax(6rem, 8.5rem) repeat(5, auto)")
})

test("profile grid cells hug their label rather than a fixed minimum", () => {
  assert.doesNotMatch(PROFILE_GRID_CELL_CLASS, /min-w-/, "a minimum width is trailing slack once the label sits left")
  assert.match(PROFILE_GRID_CELL_CLASS, /justify-start/)
  assert.match(PROFILE_GRID_CELL_CLASS, /text-left/)
  assert.doesNotMatch(PROFILE_GRID_CELL_CLASS, /text-center|justify-center/)
})

// Both ladders top out in ONE column. A column each leaves every Claude row ghosting codex's "ultra",
// so ULTRACODE rendered a full empty column clear of MAX.
const bothLaddersGroups: ProfileGridGroup[] = [
  {
    id: "claude",
    label: "Claude Code",
    options: [
      { model: "opus", label: "Opus", efforts: ["low", "medium", "high", "xhigh", "max", "ultracode"] },
      { model: "haiku", label: "Haiku", efforts: ["low", "medium", "high", "xhigh", "max"] },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    options: [
      { model: "gpt-5.6-sol", label: "GPT-5.6 Sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"] },
    ],
  },
]

test("profile grid gives ultra and ultracode ONE shared ceiling column", () => {
  assert.deepEqual(profileGridColumns(bothLaddersGroups), [["low"], ["medium"], ["high"], ["xhigh"], ["max"], ["ultra", "ultracode"]])
  assert.equal(profileGridEfforts(bothLaddersGroups).length, 7, "the two ladders contribute seven distinct effort NAMES…")
  assert.equal(profileGridColumns(bothLaddersGroups).length, 6, "…but only six columns — no empty column between max and the ceiling")
})

test("profile grid movement treats the shared ceiling as one column", () => {
  assert.deepEqual(
    moveProfileGridSelection(bothLaddersGroups, { provider: "claude", model: "opus", effort: "ultracode" }, "ArrowDown"),
    { provider: "claude", model: "haiku", effort: "max" },
    "the row below has no ceiling rung, so movement falls back to max",
  )
  assert.deepEqual(
    moveProfileGridSelection(bothLaddersGroups, { provider: "claude", model: "haiku", effort: "max" }, "ArrowDown"),
    { provider: "codex", model: "gpt-5.6-sol", effort: "max" },
  )
  assert.deepEqual(
    moveProfileGridSelection(bothLaddersGroups, { provider: "claude", model: "opus", effort: "max" }, "ArrowUp"),
    null,
  )
  const adjacent = bothLaddersGroups.map((group) => ({ ...group, options: group.options.filter((option) => option.model !== "haiku") }))
  assert.deepEqual(
    moveProfileGridSelection(adjacent, { provider: "claude", model: "opus", effort: "ultracode" }, "ArrowDown"),
    { provider: "codex", model: "gpt-5.6-sol", effort: "ultra" },
    "the ceiling column is continuous across providers, under each provider's own name",
  )
})

test("the trigger splits the version off the model so it can be set in the edition ink", () => {
  const claude = [{ id: "claude", label: "Claude Code", options: [{ model: "opus", label: "Opus 5.5", edition: "5.5", efforts: ["high"] }] }]
  // The dispatch composer: the row's own edition.
  assert.deepEqual(profileGridDisplayParts(claude, { model: "opus", effort: "high" }), { name: "Opus", edition: "5.5", effort: "high" })
  // A running thread: the edition its worker RUNS, read off the running label.
  assert.deepEqual(profileGridDisplayParts(claude, { model: "opus", effort: "high" }, undefined, "Opus 5"), { name: "Opus", edition: "5", effort: "high" })
  // No edition (a codex row, the degraded family word) renders whole, never a guessed split.
  assert.deepEqual(profileGridDisplayParts(groups, { model: "gpt-5.6-sol", effort: "ultra" }), { name: "GPT-5.6 Sol", effort: "ultra" })
  assert.deepEqual(profileGridDisplayParts(claude, undefined, "Profile loading…"), { name: "Profile loading…" })
  assert.equal(profileGridDisplayLabel(claude, { model: "opus", effort: "high" }, undefined, "Opus 5"), "Opus 5 › high")
})
