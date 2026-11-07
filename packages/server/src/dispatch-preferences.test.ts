import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createStorage } from "./storage.ts"
import { defaultSettings } from "./settings.ts"
import { machineConfigPath } from "./machine-config.ts"
import {
  defaultDispatchPreferences,
  getDispatchPreferences,
  hasSavedDispatchPreferences,
  readMachineDispatchPreferences,
  setDispatchPreference,
  withDefaultAgentProfile,
} from "./dispatch-preferences.ts"

// One sandbox HOME with as many project databases as a test wants: the record under test is
// machine-level, so the interesting cases are all "two projects, one home".
function sandbox(): { home: string; open: (name: string) => ReturnType<typeof createStorage>; done: () => void } {
  const home = mkdtempSync(join(tmpdir(), "frizz-dispatch-preferences-"))
  const opened: ReturnType<typeof createStorage>[] = []
  return {
    home,
    open: (name) => {
      const storage = createStorage(join(home, `${name}.db`), "p")
      opened.push(storage)
      return storage
    },
    done: () => {
      for (const storage of opened) storage.close()
      rmSync(home, { recursive: true, force: true })
    },
  }
}

test("dispatch preferences migrate the selected Settings runtime without contaminating the other provider", () => {
  const settings = {
    ...defaultSettings(),
    backend: "codex" as const,
    model: "gpt-5.6-sol",
    effort: "ultra" as const,
    permissionMode: "bypassPermissions" as const,
  }
  assert.deepEqual(defaultDispatchPreferences(settings), {
    backend: "codex",
    claude: { permissionMode: "auto" },
    codex: { model: "gpt-5.6-sol", effort: "ultra", permissionMode: "bypassPermissions" },
  })
})

test("dispatch preferences infer an old Settings record's Codex backend from the live catalogue", () => {
  const settings = {
    ...defaultSettings(),
    backend: undefined,
    model: "gpt-new-from-cache",
    effort: "xhigh" as const,
  }
  assert.deepEqual(
    defaultDispatchPreferences(settings, [
      { slug: "gpt-new-from-cache", displayName: "GPT New", defaultEffort: "medium", efforts: ["medium", "xhigh"] },
    ]),
    {
      backend: "codex",
      claude: { permissionMode: "auto" },
      codex: { model: "gpt-new-from-cache", effort: "xhigh", permissionMode: "default" },
    },
  )
})

test("dispatch preferences persist provider-specific selections across a database restart", () => {
  const box = sandbox()
  const path = join(box.home, "restart.db")
  const settings = defaultSettings()
  let storage = createStorage(path, "p")

  setDispatchPreference(storage, settings, box.home, { field: "model", backend: "claude", value: "sonnet" })
  setDispatchPreference(storage, settings, box.home, { field: "effort", backend: "claude", value: "max" })
  setDispatchPreference(storage, settings, box.home, { field: "model", backend: "codex", value: "gpt-5.5" })
  setDispatchPreference(storage, settings, box.home, { field: "effort", backend: "codex", value: "xhigh" })
  setDispatchPreference(storage, settings, box.home, { field: "backend", value: "claude" })
  storage.close()

  storage = createStorage(path, "p")
  assert.deepEqual(getDispatchPreferences(storage, settings, box.home), {
    backend: "claude",
    claude: { model: "sonnet", effort: "max", permissionMode: "auto" },
    codex: { model: "gpt-5.5", effort: "xhigh", permissionMode: "default" },
  })
  storage.close()
  box.done()
})

test("a selection made in one project is the profile every other project opens on", () => {
  const box = sandbox()
  const settings = defaultSettings()
  const alpha = box.open("alpha")
  const beta = box.open("beta")
  try {
    setDispatchPreference(alpha, settings, box.home, { field: "profile", backend: "claude", model: "haiku", effort: "low" })
    assert.ok(existsSync(machineConfigPath(box.home)), "the record lives in the machine config store")
    assert.deepEqual(getDispatchPreferences(beta, settings, box.home).claude, {
      model: "haiku",
      effort: "low",
      permissionMode: "auto",
    })
    // …and the other direction: beta's change is what alpha sees next, not alpha's own last write.
    setDispatchPreference(beta, settings, box.home, { field: "effort", backend: "claude", value: "xhigh" })
    assert.equal(getDispatchPreferences(alpha, settings, box.home).claude.effort, "xhigh")
  } finally {
    box.done()
  }
})

test("a project that stored a profile before the machine file existed keeps it until the next selection", () => {
  const box = sandbox()
  const settings = defaultSettings()
  const alpha = box.open("alpha")
  const beta = box.open("beta")
  try {
    // The pre-2026-08-25 shape: a per-project row and no machine record.
    alpha.setSetting("dispatch-preferences.v1", {
      backend: "codex",
      claude: { permissionMode: "auto" },
      codex: { model: "gpt-5.5", effort: "high", permissionMode: "default" },
    })
    assert.equal(readMachineDispatchPreferences(box.home), undefined)
    assert.equal(getDispatchPreferences(alpha, settings, box.home).codex.model, "gpt-5.5", "the row is the fallback")
    assert.equal(getDispatchPreferences(beta, settings, box.home).backend, "claude", "a project with no row gets the default")

    // The next selection, wherever it is made, promotes the record to the machine…
    setDispatchPreference(alpha, settings, box.home, { field: "effort", backend: "codex", value: "xhigh" })
    assert.equal(readMachineDispatchPreferences(box.home)?.codex.effort, "xhigh")
    assert.equal(getDispatchPreferences(beta, settings, box.home).codex.model, "gpt-5.5", "…so beta now sees alpha's profile")
    // …and the row is mirrored, so an older server reading this database sees the same choice.
    assert.deepEqual(alpha.getSetting("dispatch-preferences.v1"), readMachineDispatchPreferences(box.home))
  } finally {
    box.done()
  }
})

test("a profile cell persists model and effort in one provider-scoped mutation", () => {
  const box = sandbox()
  const storage = box.open("profile")
  const settings = defaultSettings()
  const next = setDispatchPreference(storage, settings, box.home, {
    field: "profile",
    backend: "codex",
    model: "gpt-5.6-sol",
    effort: "ultra",
  })
  assert.equal(next.backend, "codex")
  assert.deepEqual(next.codex, { model: "gpt-5.6-sol", effort: "ultra", permissionMode: "default" })
  assert.deepEqual(next.claude, { permissionMode: "auto" })
  box.done()
})

test("an invalid saved record degrades in memory and never silently persists a fallback", () => {
  const box = sandbox()
  const storage = box.open("invalid")
  storage.setSetting("dispatch-preferences.v1", { backend: "codex", codex: { model: "" } })
  const settings = defaultSettings()
  assert.deepEqual(getDispatchPreferences(storage, settings, box.home), defaultDispatchPreferences(settings))
  assert.deepEqual(
    storage.getSetting("dispatch-preferences.v1"),
    { backend: "codex", codex: { model: "" } },
    "read-time validation must not rewrite user storage",
  )
  box.done()
})

test("an unreadable machine store degrades to the project's row rather than throwing", () => {
  const box = sandbox()
  const settings = defaultSettings()
  const alpha = box.open("alpha")
  try {
    setDispatchPreference(alpha, settings, box.home, { field: "model", backend: "claude", value: "sonnet" })
    writeFileSync(machineConfigPath(box.home), "{ not json")
    assert.equal(readMachineDispatchPreferences(box.home), undefined)
    assert.equal(getDispatchPreferences(alpha, settings, box.home).claude.model, "sonnet")
    assert.equal(existsSync(machineConfigPath(box.home)), true, "a read never rewrites the file")
  } finally {
    box.done()
  }
})

test("a computed default applies to the read and writes nothing, and the first real choice replaces it", () => {
  const box = sandbox()
  try {
    const storage = box.open("a")
    const settings = defaultSettings()
    assert.equal(hasSavedDispatchPreferences(storage, settings, box.home), false)
    const shown = withDefaultAgentProfile(getDispatchPreferences(storage, settings, box.home), { backend: "acp", model: "acp:opencode" })
    assert.equal(shown.backend, "acp")
    assert.equal(shown.acp?.model, "acp:opencode")
    assert.equal(readMachineDispatchPreferences(box.home), undefined, "showing it stored nothing")
    assert.equal(withDefaultAgentProfile(getDispatchPreferences(storage, settings, box.home), undefined).backend, "claude")

    setDispatchPreference(storage, settings, box.home, { field: "profile", backend: "claude", model: "opus", effort: "high" })
    assert.equal(hasSavedDispatchPreferences(storage, settings, box.home), true)
    // On a project with its own row and on a new project alike: the machine record speaks for both.
    assert.equal(hasSavedDispatchPreferences(box.open("b"), settings, box.home), true)
  } finally {
    box.done()
  }
})

test("a project's old row or an old configured model counts as saved", () => {
  const box = sandbox()
  try {
    const storage = box.open("a")
    assert.equal(hasSavedDispatchPreferences(storage, { ...defaultSettings(), model: "opus" }, box.home), true)
    assert.equal(hasSavedDispatchPreferences(storage, { ...defaultSettings(), backend: "codex" }, box.home), true)
    storage.setSetting("dispatch-preferences.v1", { backend: "codex", claude: { permissionMode: "auto" }, codex: { permissionMode: "default" } })
    assert.equal(hasSavedDispatchPreferences(storage, defaultSettings(), box.home), true)
  } finally {
    box.done()
  }
})
