import {
  DispatchPreferences,
  type Backend,
  type CodexModel,
  type DefaultAgentProfile,
  type DispatchProviderPreferences,
  type PermissionMode,
  type SetDispatchPreferenceInput,
  type Settings,
} from "@frizz/shared"
import { readMachineConfig, writeMachineConfig } from "./machine-config.ts"
import type { Storage } from "./storage.ts"

// The prompt box's model + effort profile is a property of the OPERATOR, not of a repository: the
// person who picks Opus/xhigh in one project expects the next project's prompt box to open on the same
// profile (maintainer 2026-08-25: "it should also be applied globally across all projects"). One
// server serves every project, so the record is the `dispatchPreferences` entry of the machine config
// store (machine-config.ts), beside the machine's settings.
//
// The per-project SQLite row under KEY is where the record lived until 2026-08-25. It stays as a READ
// fallback rather than being migrated: a project that chose a profile before the store existed keeps
// showing it, and the next selection — written to the store — is what makes it the machine's. Every
// write still mirrors into the row, so an older server reading this database sees the same choice.
const KEY = "dispatch-preferences.v1"
export const MACHINE_KEY = "dispatchPreferences"

/** The machine's record, or undefined when there is none or it does not parse. Never throws. */
export function readMachineDispatchPreferences(home: string): DispatchPreferences | undefined {
  return readMachineConfig(home, MACHINE_KEY, DispatchPreferences)
}

function permissionFor(backend: Backend, mode: PermissionMode): PermissionMode {
  if (backend === "codex") {
    if (mode === "plan" || mode === "bypassPermissions") return mode
    return "default"
  }
  return mode === "plan" ? "auto" : mode
}

// Migrate the existing single Settings profile without writing anything. This preserves the old
// configured choice on first use while ensuring a merely displayed fallback never becomes stored
// intent. Once a composer selection is changed, the dedicated record becomes authoritative.
export function defaultDispatchPreferences(
  settings: Settings,
  codexModels: readonly CodexModel[] = [],
): DispatchPreferences {
  // Older Settings records predate the explicit backend field. Infer those from the same live Codex
  // catalogue the picker uses so a saved GPT choice migrates into the Codex profile instead of being
  // mistaken for an unavailable Claude model.
  const backend: Backend = settings.backend ?? (codexModels.some((model) => model.slug === settings.model) ? "codex" : "claude")
  const selected = {
    ...(settings.model ? { model: settings.model } : {}),
    ...(settings.effort ? { effort: settings.effort } : {}),
    permissionMode: permissionFor(backend, settings.permissionMode),
  }
  return {
    backend,
    claude: backend === "claude" ? selected : { permissionMode: "auto" },
    codex: backend === "codex" ? selected : { permissionMode: "default" },
    // The ACP slot exists only once the operator has chosen an agent: it has no permission axis (the
    // agent's own CLI decides), so there is no default worth writing, and every record written before
    // the backend existed lacks the key.
    ...(backend === "acp" ? { acp: selected } : {}),
    ...(backend === "opencode" ? { opencode: selected } : {}),
  }
}

/** A backend's slot: always present for the two original runtimes, empty for `acp` until chosen. */
function profileOf(prefs: DispatchPreferences, backend: Backend): DispatchProviderPreferences {
  return prefs[backend] ?? {}
}

// machine record → this project's stored row → the Settings-derived default. Read-time validation
// never rewrites either store: an invalid record degrades in memory only.
export function getDispatchPreferences(
  storage: Storage,
  settings: Settings,
  home: string,
  codexModels: readonly CodexModel[] = [],
): DispatchPreferences {
  const machine = readMachineDispatchPreferences(home)
  if (machine) return machine
  const parsed = DispatchPreferences.safeParse(storage.getSetting(KEY))
  return parsed.success ? parsed.data : defaultDispatchPreferences(settings, codexModels)
}

/**
 * Has anyone on this machine chosen a profile? The machine record, this project's stored row, or an
 * old configured model or backend in Settings. Only a machine with none of them gets a computed default.
 */
export function hasSavedDispatchPreferences(storage: Storage, settings: Settings, home: string): boolean {
  if (readMachineDispatchPreferences(home)) return true
  if (DispatchPreferences.safeParse(storage.getSetting(KEY)).success) return true
  return Boolean(settings.model || settings.backend)
}

/** What the prompt box opens on with no saved choice. Read-time only: nothing is written, so a machine
 *  that signs in later goes back to the shipped default until someone picks. */
export function withDefaultAgentProfile(prefs: DispatchPreferences, profile: DefaultAgentProfile | undefined): DispatchPreferences {
  return profile ? { ...prefs, backend: profile.backend, [profile.backend]: { model: profile.model } } : prefs
}

export function setDispatchPreference(
  storage: Storage,
  settings: Settings,
  home: string,
  update: SetDispatchPreferenceInput,
  codexModels: readonly CodexModel[] = [],
): DispatchPreferences {
  const current = getDispatchPreferences(storage, settings, home, codexModels)
  let next: DispatchPreferences
  if (update.field === "backend") {
    next = { ...current, backend: update.value }
  } else if (update.field === "profile") {
    next = {
      ...current,
      backend: update.backend,
      [update.backend]: {
        ...profileOf(current, update.backend),
        model: update.model,
        effort: update.effort,
      },
    }
  } else {
    const profile = profileOf(current, update.backend)
    next = {
      ...current,
      ...(update.field === "model" ? { backend: update.backend } : {}),
      [update.backend]: { ...profile, [update.field]: update.value },
    }
  }
  const validated = DispatchPreferences.parse(next)
  writeMachineConfig(home, MACHINE_KEY, validated)
  storage.setSetting(KEY, validated)
  return validated
}
