import { useQuery } from "@tanstack/react-query"
import { opencodeModelRef, opencodeModelSlug, type OpencodeModels } from "@frizz/shared"
import { scopedKey, useProjectScope, useRpc } from "../lib/projectScope.tsx"
import { OPAQUE_PORTAL_SURFACE_Z } from "../lib/overlaySurface.ts"
import { Select, type SelectGroup } from "./ui/Select.tsx"

// THE MODEL AND VARIANT DROPDOWNS FOR OPENCODE. The list is the running service's own (`GET /api/model`),
// grouped by provider, which is what OpenCode will honour: a person signed into one provider lists that
// provider's models and its free ones. The variant is OpenCode's effort axis and each model's own (`low`,
// `xhigh`, `minimal`), so it is a second dropdown beside the model, drawn only for a model that has any.
//
// The value is the model slug (`opencode:<provider>/<id>#<variant>`); the bare `opencode:` is OpenCode's own
// default. Reading the list starts the person's service, which is why only a mounted picker asks.
const DEFAULT_VARIANT = ""

export function opencodeModelGroups(models: OpencodeModels | undefined, value: string | undefined): SelectGroup[] {
  const groups: SelectGroup[] = [{ label: "", options: [{ value: "", label: "Default", title: "The model OpenCode opens on when Frizz asks for none" }] }]
  const ref = opencodeModelRef(value)
  const saved = ref ? `${ref.providerID}/${ref.id}` : undefined
  if (saved && !models?.models.some((m) => `${m.providerID}/${m.id}` === saved)) {
    groups[0]!.options.push(models && !models.error
      ? { value: saved, label: `${saved} (unavailable)`, title: "OpenCode no longer lists this model" }
      : { value: saved, label: saved })
  }
  for (const m of models?.models ?? []) {
    let group = groups.find((candidate) => candidate.label === m.providerID)
    if (!group) { group = { label: m.providerID, options: [] }; groups.push(group) }
    group.options.push({ value: `${m.providerID}/${m.id}`, label: m.name, title: `${m.providerID}/${m.id}` })
  }
  return groups
}

export function OpencodeModelSelect({
  value,
  onValueChange,
  disabled = false,
  side = "bottom",
  menuZClass = OPAQUE_PORTAL_SURFACE_Z,
  className = "",
  compact = false,
}: {
  value: string | undefined
  onValueChange: (slug: string) => void
  disabled?: boolean
  side?: "top" | "bottom"
  menuZClass?: string
  className?: string
  /** A phone's row: the variant control only once a variant is chosen. The model menu still works. */
  compact?: boolean
}) {
  const project = useProjectScope()
  const api = useRpc()
  const models = useQuery({
    queryKey: scopedKey(["opencodeModels"], project),
    queryFn: () => api.opencodeModels(),
    staleTime: 60_000,
  })
  const ref = opencodeModelRef(value)
  const key = ref ? `${ref.providerID}/${ref.id}` : ""
  const current = ref ? models.data?.models.find((m) => m.providerID === ref.providerID && m.id === ref.id) : undefined
  const failure = models.isError ? (models.error as Error).message : models.data?.error
  const pick = (modelKey: string, variant?: string) => {
    const slash = modelKey.indexOf("/")
    onValueChange(slash > 0
      ? opencodeModelSlug({ providerID: modelKey.slice(0, slash), id: modelKey.slice(slash + 1), ...(variant ? { variant } : {}) })
      : opencodeModelSlug())
  }
  return (
    <>
      <Select
        variant="readout"
        side={side}
        value={key}
        onValueChange={(next) => pick(next)}
        groups={opencodeModelGroups(models.data, value)}
        placeholder={models.isPending ? "Models…" : "Default"}
        ariaLabel="OpenCode model"
        title={failure ? `OpenCode did not list its models (${failure}); the thread runs on its default` : "OpenCode's model for this thread"}
        disabled={disabled || models.isPending}
        indicatorPosition="right"
        menuZClass={menuZClass}
        // On a phone the row is too narrow for both selects and the permission beside them, so each
        // truncates rather than the model collapsing to a bare chevron (420px, 2026-11-06).
        className={`min-w-[5rem] ${className}`}
      />
      {current && current.variants.length > 0 && (!compact || ref?.variant) && (
        <Select
          variant="readout"
          side={side}
          value={ref?.variant ?? DEFAULT_VARIANT}
          onValueChange={(next) => pick(key, next || undefined)}
          // "Default" alone sat beside the permission pill and read as a permission mode.
          options={[{ value: DEFAULT_VARIANT, label: "Default effort" }, ...current.variants.map((variant) => ({ value: variant, label: variant }))]}
          ariaLabel="OpenCode model variant"
          title="This model's reasoning effort, in OpenCode's words"
          disabled={disabled}
          indicatorPosition="right"
          menuZClass={menuZClass}
          className="min-w-[3.5rem]"
        />
      )}
    </>
  )
}
