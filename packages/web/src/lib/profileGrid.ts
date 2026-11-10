import { PROMPT_CONTROL_TYPOGRAPHY_CLASS } from "./promptControlTypography.ts"

export interface ProfileGridOption {
  model: string
  label: string
  // The version at the END of `label` ("5.5" of "Opus 5.5"). The model column sets it dimmer than the
  // family word, so the eye reads the family first and the version on a second look.
  edition?: string
  efforts: readonly string[]
  defaultEffort?: string
  /** A DROPDOWN group's subheading for this option: OpenCode's provider ("opencode", "anthropic"). */
  section?: string
  /** Dim text after the label in a list, never in the trigger: OpenCode's default row names its model. */
  hint?: string
  /** What the trigger reads when this option is chosen, where it differs from the list's label. */
  triggerLabel?: string
  /** An alias for another option's model (OpenCode's "Default" names its default model): choosing one of
   *  its non-default levels stores that model, since a level belongs to a model, not to a default. */
  aliasOf?: string
}

export interface ProfileGridGroup {
  id: string
  label: string
  options: readonly ProfileGridOption[]
  /** Draws an Experimental chip beside the group's name. */
  experimental?: boolean
  /** `dropdown`: the menu draws a model dropdown and an effort dropdown for this group instead of grid
   *  rows, for a provider whose models and efforts are too many, and too unlike the grid's columns, to
   *  lay out as a matrix (OpenCode). The phone's sheet lists its options as it lists any group's. */
  layout?: "grid" | "dropdown"
  /** The options are still being fetched. */
  loading?: boolean
  /** Why the options could not be listed, shown in the group's dropdown. */
  notice?: string
  /** Asks for the options. Called when the group's model list is opened, so a provider whose list costs
   *  something to read (OpenCode starts its service to answer) is never asked merely because a menu opened. */
  onRequestOptions?: () => void
}

/** The groups the effort matrix lays out: every group but a dropdown one. */
export function profileGridMatrixGroups(groups: readonly ProfileGridGroup[]): ProfileGridGroup[] {
  return groups.filter((group) => group.layout !== "dropdown")
}

export interface ProfileGridSelection {
  provider: string
  model: string
  effort: string
}

// Kept in the pure profile module so the component and deterministic contract tests share the exact
// class tokens. Apply this directly to every piece of profile text (rather than relying on the
// trigger/menu inheritance): model labels, effort cells, and the selected combined value must remain
// the same readable 12px/16px petite-cap treatment in queue cards, drawers, and narrow layouts.
// Compact changes control density and icon size only; it must never make the text smaller.
export const PROFILE_GRID_TYPOGRAPHY_CLASS = PROMPT_CONTROL_TYPOGRAPHY_CLASS
export const PROFILE_GRID_COMPACT_TYPOGRAPHY_CLASS = PROMPT_CONTROL_TYPOGRAPHY_CLASS
// LEFT-aligned, and every cell HUGS its label. Once the labels sit left, a cell wider than its word
// leaves that slack trailing: a 2.75rem minimum made the gap after LOW/HIGH/MAX 23px against 14px
// after MEDIUM/X-HIGH, and hung the selection ring off the right of the word it marks. Hugging gives
// one uniform 14px gap the whole way across and a ring that is symmetric around every label.
export const PROFILE_GRID_CELL_CLASS = `profile-grid-cell relative flex h-6 cursor-pointer select-none items-center justify-start rounded border border-transparent px-1 text-left text-muted outline-none transition-colors ${PROFILE_GRID_TYPOGRAPHY_CLASS} data-[highlighted]:border-border data-[highlighted]:bg-panel-2 data-[highlighted]:text-fg data-[highlighted]:outline data-[highlighted]:outline-1 data-[highlighted]:outline-offset-1 data-[highlighted]:outline-fg/55 data-[state=checked]:border-accent/70 data-[state=checked]:bg-accent/10 data-[state=checked]:font-medium data-[state=checked]:text-fg data-[state=checked]:ring-1 data-[state=checked]:ring-inset data-[state=checked]:ring-accent/90`

// Effort tracks are `auto` with NO minimum: a track floor wider than the word it holds is slack, and
// left-aligned slack all lands on one side. The row itself is `w-max` (see the component), so `auto`
// resolves to max-content and every column is exactly as wide as its label plus the cell's padding.
export function profileGridTemplateColumns(columnCount: number): string {
  return `minmax(6rem, 7rem) repeat(${Math.max(0, columnCount)}, auto)`
}

// The product's own word for an effort level, as the picker's cells print it: "X-high" for xhigh, the
// rest capitalised ("Low", "Ultracode"). Shared by the desktop grid and the phone's model sheet.
export function profileGridEffortLabel(effort: string): string {
  // "" is a model's own default level, which is what an OpenCode model runs on until a level is picked.
  if (effort === "") return "Default"
  if (effort === "xhigh") return "X-high"
  return effort.charAt(0).toUpperCase() + effort.slice(1)
}

export type ProfileGridMoveKey = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown" | "Home" | "End"

// "ultra" (codex) and "ultracode" (Claude Code) are ONE rung under two provider-specific names: the
// ceiling of each ladder, where each CLI's own /effort lists it. They therefore share one column. Give
// them a column each and every Claude row holds a ghost where codex's "ultra" sits, which floated
// ULTRACODE a full 2.75rem clear of MAX with nothing in between (screenshot, 2026-08-11).
const CEILING_EFFORTS = ["ultra", "ultracode"]

// Column order for the matrix. The ceiling sorts last, and a model that cannot honour it simply
// renders an empty cell in that column.
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max", ...CEILING_EFFORTS]

export function profileGridEfforts(groups: readonly ProfileGridGroup[]): string[] {
  const efforts = new Set(profileGridMatrixGroups(groups).flatMap((group) => group.options.flatMap((option) => option.efforts)))
  return [...efforts].sort((a, b) => {
    const ai = EFFORT_ORDER.indexOf(a)
    const bi = EFFORT_ORDER.indexOf(b)
    if (ai === -1 && bi === -1) return a.localeCompare(b)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
}

// The rendered columns: one entry per column, holding every effort name that shares it. All but the
// ceiling column carry a single name; the ceiling carries whichever of "ultra"/"ultracode" the loaded
// providers offer, so a row fills it with the one its own model supports.
export function profileGridColumns(groups: readonly ProfileGridGroup[]): string[][] {
  const columns: string[][] = []
  for (const effort of profileGridEfforts(groups)) {
    const ceiling = CEILING_EFFORTS.includes(effort)
      ? columns.find((column) => CEILING_EFFORTS.includes(column[0]!))
      : undefined
    if (ceiling) ceiling.push(effort)
    else columns.push([effort])
  }
  return columns
}

// An option with NO efforts (an ACP agent, which runs on its own CLI's model and effort) is one
// selection with `effort: ""` — a single cell in the row — rather than none at all.
export function profileGridOptionEfforts(option: ProfileGridOption): readonly string[] {
  return option.efforts.length ? option.efforts : [""]
}

export function profileGridSelections(groups: readonly ProfileGridGroup[]): ProfileGridSelection[] {
  return groups.flatMap((group) => group.options.flatMap((option) => profileGridOptionEfforts(option).map((effort) => ({
    provider: group.id,
    model: option.model,
    effort,
  }))))
}

/** The selection to store for a pick: an alias option's model with a level of its own becomes its target. */
export function profileGridResolveSelection(groups: readonly ProfileGridGroup[], selection: ProfileGridSelection): ProfileGridSelection {
  if (!selection.effort) return selection
  const option = groups.find((group) => group.id === selection.provider)?.options.find((candidate) => candidate.model === selection.model)
  return option?.aliasOf ? { ...selection, model: option.aliasOf } : selection
}

export function profileGridSelectionKey(selection: ProfileGridSelection): string {
  return JSON.stringify([selection.provider, selection.model, selection.effort])
}

// DropdownMenu's RadioGroup reports only its string value. Resolve that value through the rendered
// catalogue rather than parsing it back into an untrusted selection, so a radio change can only
// commit one complete, supported provider/model/effort pair.
export function profileGridSelectionFromKey(
  groups: readonly ProfileGridGroup[],
  key: string,
): ProfileGridSelection | undefined {
  return profileGridSelections(groups).find((selection) => profileGridSelectionKey(selection) === key)
}

export function profileGridSelectionKnown(
  groups: readonly ProfileGridGroup[],
  selection: Partial<ProfileGridSelection> | undefined,
): boolean {
  if (!selection?.model || selection.effort === undefined) return false
  return groups.some((group) =>
    (!selection.provider || group.id === selection.provider) &&
    group.options.some((option) => option.model === selection.model && profileGridOptionEfforts(option).includes(selection.effort!)),
  )
}

// The trigger's readout in parts, so the version can be set in the edition ink the menu's model column
// uses (maintainer 2026-09-25: "make sure that the version numbers show up with the light gray" in both
// composers' prompt boxes). `edition` is present only when it is the literal tail of the model label.
export interface ProfileGridDisplayParts {
  name: string
  edition?: string
  effort?: string
}

// A Claude edition label's version: "5" of "Opus 5", "4.5" of "Haiku 4.5". Only applied to the RUNNING
// label, which the server always spells `${family} ${edition}` (ThreadView.runningModelLabel).
const TRAILING_EDITION = / (\d+(?:\.\d+)*)$/

export function profileGridDisplayParts(
  groups: readonly ProfileGridGroup[],
  selection: Partial<ProfileGridSelection> | undefined,
  placeholder = "Profile unknown",
  // What a RUNNING thread actually runs ("Opus 5"), when that is not what its row names ("Opus 5.5") —
  // ThreadView.runningModelLabel. The row is what the family resolves to NOW; the readout must not claim
  // an edition the worker is not on.
  modelLabel?: string,
): ProfileGridDisplayParts {
  if (!selection?.model && !selection?.effort) return { name: placeholder }
  const option = groups.flatMap((group) => group.options).find((candidate) => candidate.model === selection.model)
  const label = modelLabel ?? option?.triggerLabel ?? option?.label ?? selection.model ?? "Model unknown"
  const edition = modelLabel ? TRAILING_EDITION.exec(modelLabel)?.[1] : option?.edition
  const split = edition !== undefined && label.endsWith(` ${edition}`)
  // A Claude thread records its resolved model in the provider transcript but never the launch effort,
  // so a thread dispatched without an explicit effort (or an older/foreign session) has a known model
  // and an unknown effort. Show the model alone in that case: a concrete effort is displayed verbatim
  // when present, and no effort is ever inferred — but the profile never reads as a "legacy" state.
  return {
    name: split ? label.slice(0, -(edition.length + 1)) : label,
    ...(split ? { edition } : {}),
    ...(selection.effort ? { effort: selection.effort } : {}),
  }
}

export function profileGridDisplayLabel(
  groups: readonly ProfileGridGroup[],
  selection: Partial<ProfileGridSelection> | undefined,
  placeholder = "Profile unknown",
  modelLabel?: string,
): string {
  const { name, edition, effort } = profileGridDisplayParts(groups, selection, placeholder, modelLabel)
  const model = edition ? `${name} ${edition}` : name
  return effort ? `${model} › ${effort}` : model
}

// Arrow keys move through the visual matrix rather than the DOM's flattened menu order. Horizontal
// movement stays on a model and skips unsupported cells; vertical movement preserves the effort
// column when possible, falling back to the nearest supported effort in the destination row.
export function moveProfileGridSelection(
  groups: readonly ProfileGridGroup[],
  current: ProfileGridSelection,
  key: ProfileGridMoveKey,
): ProfileGridSelection | null {
  const columns = profileGridColumns(groups)
  const columnOf = (effort: string) => columns.findIndex((column) => column.includes(effort))
  const rows = profileGridMatrixGroups(groups).flatMap((group) => group.options.map((option) => ({ provider: group.id, option })))
  const rowIndex = rows.findIndex((row) => row.provider === current.provider && row.option.model === current.model)
  if (rowIndex === -1) return null
  const row = rows[rowIndex]!
  const rowEfforts = profileGridOptionEfforts(row.option)
  const currentEffortIndex = rowEfforts.indexOf(current.effort)
  if (currentEffortIndex === -1) return null

  if (key === "Home" || key === "End" || key === "ArrowLeft" || key === "ArrowRight") {
    const nextIndex = key === "Home"
      ? 0
      : key === "End"
        ? rowEfforts.length - 1
        : currentEffortIndex + (key === "ArrowLeft" ? -1 : 1)
    const effort = rowEfforts[nextIndex]
    return effort !== undefined ? { provider: row.provider, model: row.option.model, effort } : null
  }

  const nextRow = rows[rowIndex + (key === "ArrowUp" ? -1 : 1)]
  if (!nextRow) return null
  const currentColumn = columnOf(current.effort)
  const effort = profileGridOptionEfforts(nextRow.option).reduce<string | undefined>((nearest, candidate) => {
    if (nearest === undefined) return candidate
    return Math.abs(columnOf(candidate) - currentColumn) < Math.abs(columnOf(nearest) - currentColumn)
      ? candidate
      : nearest
  }, undefined)
  return effort !== undefined ? { provider: nextRow.provider, model: nextRow.option.model, effort } : null
}
