import { OPENCODE_MODEL_PREFIX, opencodeModelRef, opencodeModelSlug, type OpencodeModels } from "@frizz/shared"
import type { ProfileGridGroup, ProfileGridOption, ProfileGridSelection } from "./profileGrid.ts"

// OPENCODE IN THE MODEL MENU. OpenCode's models are whatever its running service lists (`GET /api/model`,
// the route `opencode models` itself prints from), across every provider the person holds keys for, and
// each model has its own reasoning levels ("variants": `minimal`, `xhigh`, `none`), which line up with
// neither each other nor the menu's effort columns. So the group is a DROPDOWN group: the desktop menu
// draws a model dropdown and an effort dropdown under the OpenCode heading, and the phone's sheet lists
// the models as rows with each one's levels as its effort chips (maintainer 2026-11-09: "For opencode, it
// should be a dropdown because opencode obviously supports many models and many effort levels"). A
// separate model pill stood to the right of the trigger until then, where it read as the effort or the
// permission.
//
// The trigger reads "OpenCode" and then the model name in the edition ink, the way a Claude trigger reads
// "Opus" and then "5.5" (maintainer, same day: "Let's have OpenCode be in that chip as well, kind of in
// the same way that we have Opus, but then the whole model name is in that lighter gray font"). The bare
// `opencode:` is OpenCode's own configured model; it has no "Default" row, because the list shows that
// model by name and checks it ("what is the point of having the word 'default' in that dropdown").
//
// A selection is the model slug WITHOUT its variant, with the variant as the effort ("" for the model's
// own default), and the stored slug puts them back together: `opencode:<provider>/<id>#<variant>`.

/** The menu's selection for a stored OpenCode slug. The bare `opencode:` is OpenCode's own default model. */
export function opencodeSelection(slug: string | undefined): ProfileGridSelection {
  const ref = opencodeModelRef(slug)
  return {
    provider: "opencode",
    model: ref ? opencodeModelSlug({ providerID: ref.providerID, id: ref.id }) : OPENCODE_MODEL_PREFIX,
    effort: ref?.variant ?? "",
  }
}

/** The slug a menu selection stores: its model, with its effort as the variant. */
export function opencodeSlugOf(selection: { model: string; effort?: string }): string {
  const ref = opencodeModelRef(selection.model)
  if (!ref) return OPENCODE_MODEL_PREFIX
  return opencodeModelSlug({ providerID: ref.providerID, id: ref.id, ...(selection.effort ? { variant: selection.effort } : {}) })
}

/** The OpenCode group. `models` is undefined until the list has been asked for; `saved` is the stored slug,
 *  kept as an option even when the list does not have it, so it still reads as itself. */
export function opencodeProfileGroup({ models, loading = false, saved, onRequestOptions }: {
  models?: OpencodeModels
  loading?: boolean
  saved?: string
  onRequestOptions?: () => void
}): ProfileGridGroup {
  const listed = models?.models ?? []
  const defaultRef = opencodeModelRef(models?.defaultModel)
  const defaultListed = defaultRef ? listed.find((model) => model.providerID === defaultRef.providerID && model.id === defaultRef.id) : undefined
  const defaultName = defaultRef ? defaultListed?.name ?? `${defaultRef.providerID}/${defaultRef.id}` : undefined
  const named = (name: string | undefined) => ({ triggerLabel: "OpenCode", ...(name ? { triggerEdition: name } : {}) })
  // The configured model. Once the list names it, the list shows that model's own row in its place
  // (`aliasOf`), so this row is seen only before the list arrives, or when OpenCode could not list it.
  const options: ProfileGridOption[] = [{
    model: OPENCODE_MODEL_PREFIX,
    label: defaultName ?? "Configured model",
    ...named(defaultName),
    efforts: ["", ...(defaultListed?.variants ?? [])],
    ...(defaultListed ? { aliasOf: opencodeModelSlug({ providerID: defaultListed.providerID, id: defaultListed.id }) } : {}),
  }]
  for (const model of listed) {
    options.push({
      model: opencodeModelSlug({ providerID: model.providerID, id: model.id }),
      label: model.name,
      ...named(model.name),
      section: model.providerID,
      efforts: ["", ...model.variants],
    })
  }
  const savedRef = opencodeModelRef(saved)
  if (savedRef) {
    const model = opencodeModelSlug({ providerID: savedRef.providerID, id: savedRef.id })
    const index = options.findIndex((option) => option.model === model)
    const name = `${savedRef.providerID}/${savedRef.id}`
    if (index === -1) {
      const gone = Boolean(models && !loading && !models.error)
      options.push({ model, label: gone ? `${name} (unavailable)` : name, ...named(name), efforts: ["", ...(savedRef.variant ? [savedRef.variant] : [])] })
    } else if (savedRef.variant && !options[index]!.efforts.includes(savedRef.variant)) {
      options[index] = { ...options[index]!, efforts: [...options[index]!.efforts, savedRef.variant] }
    }
  }
  const notice = models?.error ? `OpenCode did not list its models (${models.error}); threads run on its configured model` : undefined
  return {
    id: "opencode",
    label: "OpenCode",
    experimental: true,
    layout: "dropdown",
    options,
    loading,
    ...(notice ? { notice } : {}),
    ...(onRequestOptions ? { onRequestOptions } : {}),
  }
}
