import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { test } from "node:test"
import { createStorage } from "./storage.ts"
import { machineConfigPath, readMachineConfig, writeMachineConfig } from "./machine-config.ts"
import {
  defaultSettings,
  getSettings,
  legacyMachineSettingsPath,
  readMachineSettings,
  resetSettings,
  setSettings,
} from "./settings.ts"
import { z } from "zod"
import { Settings } from "@frizz/shared"

/** The pre-store file, as an install that predates the machine config store would have left it. */
function writeLegacySettings(home: string, value: unknown): void {
  const path = legacyMachineSettingsPath(home)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value))
}

function sandbox(): { home: string; open: (name: string) => ReturnType<typeof createStorage>; done: () => void } {
  const home = mkdtempSync(join(tmpdir(), "frizz-settings-"))
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

test("the rail, notifications and the file opener are the MACHINE's, shared by every project", () => {
  const box = sandbox()
  try {
    const alpha = box.open("alpha")
    const beta = box.open("beta")
    assert.equal(getSettings(alpha, box.home).projectRail, false)

    setSettings(alpha, { ...defaultSettings(), projectRail: true, notifications: false, localFileOpener: "cursor" }, box.home)

    // The point: a project that was never touched sees it, because the value is not its to hold.
    const seen = getSettings(beta, box.home)
    assert.equal(seen.projectRail, true)
    assert.equal(seen.notifications, false)
    assert.equal(seen.localFileOpener, "cursor")
    assert.ok(existsSync(machineConfigPath(box.home)))
  } finally {
    box.done()
  }
})

test("a project's own settings stay its own", () => {
  const box = sandbox()
  try {
    const alpha = box.open("alpha")
    const beta = box.open("beta")
    setSettings(alpha, { ...defaultSettings(), permissionMode: "auto", model: "opus" }, box.home)
    assert.equal(getSettings(alpha, box.home).permissionMode, "auto")
    assert.equal(getSettings(beta, box.home).permissionMode, "bypassPermissions", "permissions are per project")
    assert.equal(getSettings(beta, box.home).model, undefined)
  } finally {
    box.done()
  }
})

// No migration ships with this: resolution falls back through the project blob, so an existing
// project keeps what it had until the next save promotes it.
test("a project that already stored a machine value keeps it with no machine file present", () => {
  const box = sandbox()
  try {
    const alpha = box.open("alpha")
    alpha.setSetting("settings", { ...defaultSettings(), localFileOpener: "cursor" })
    assert.deepEqual(readMachineSettings(box.home), {})
    assert.equal(getSettings(alpha, box.home).localFileOpener, "cursor")

    // …and the next save is what makes it the machine's.
    setSettings(alpha, getSettings(alpha, box.home), box.home)
    assert.equal(readMachineSettings(box.home).localFileOpener, "cursor")
    assert.equal(getSettings(box.open("beta"), box.home).localFileOpener, "cursor")
  } finally {
    box.done()
  }
})

test("reset means defaults, so the machine record goes with the project blob", () => {
  const box = sandbox()
  try {
    const alpha = box.open("alpha")
    writeLegacySettings(box.home, { localFileOpener: "cursor" })
    setSettings(alpha, { ...defaultSettings(), localFileOpener: "cursor" }, box.home)
    assert.equal(resetSettings(alpha, box.home).localFileOpener, "system")
    assert.equal(readMachineConfig(box.home, "settings", z.unknown()), undefined, "leaving it would resurrect the old value")
    assert.equal(existsSync(legacyMachineSettingsPath(box.home)), false, "…and so would the pre-store file")
    assert.equal(getSettings(alpha, box.home).localFileOpener, "system")
  } finally {
    box.done()
  }
})

test("an unreadable machine store degrades to the project's values rather than throwing", () => {
  const box = sandbox()
  try {
    const alpha = box.open("alpha")
    setSettings(alpha, { ...defaultSettings(), localFileOpener: "cursor" }, box.home)
    writeFileSync(machineConfigPath(box.home), "{ not json")
    assert.deepEqual(readMachineSettings(box.home), {})
    assert.equal(getSettings(alpha, box.home).localFileOpener, "cursor", "the project blob is still there")
  } finally {
    box.done()
  }
})

// The machine settings were their own file until the machine config store arrived (2026-08-25). An
// install that has that file keeps its values from it; the next save writes the store and never the
// file. A `font` in that file — the key the file was created for — is stripped on read now that the
// setting is gone (2026-09-19); the other machine keys survive.
test("a pre-store settings.json is read until the next save promotes it into the store", () => {
  const box = sandbox()
  try {
    const alpha = box.open("alpha")
    writeLegacySettings(box.home, { font: "mono", localFileOpener: "cursor", projectRail: true })
    assert.deepEqual(readMachineSettings(box.home), { localFileOpener: "cursor", projectRail: true })
    assert.equal(getSettings(alpha, box.home).localFileOpener, "cursor")

    setSettings(alpha, { ...getSettings(alpha, box.home), notifications: false }, box.home)
    assert.deepEqual(readMachineConfig(box.home, "settings", Settings.partial()), { notifications: false, localFileOpener: "cursor", projectRail: true, childThreads: false })
    assert.equal(JSON.parse(readFileSync(legacyMachineSettingsPath(box.home), "utf8")).notifications, undefined, "the legacy file is never written again")
    // The store now wins outright, even where the legacy file disagrees.
    writeLegacySettings(box.home, { localFileOpener: "vscode" })
    assert.equal(getSettings(box.open("beta"), box.home).localFileOpener, "cursor")
  } finally {
    box.done()
  }
})

// The GitHub picker's issue and PR prompts merged into ONE `githubPrompt` on 2026-08-15. The backfill
// is the schema itself: Settings is a non-strict z.object, so a blob still carrying the two old keys
// has them STRIPPED on read, and the reader falls through to the new shipped default. That is the
// maintainer's intended migration — drop every stored override rather than guess how to fuse two
// customized templates into one. This test is what keeps it true if Settings ever turns strict/
// passthrough, which would either throw on an old blob or leak a dead key back out.
test("an old blob's githubIssuePrompt/githubPrPrompt are dropped, not carried into githubPrompt", () => {
  const box = sandbox()
  try {
    const alpha = box.open("alpha")
    alpha.setSetting("settings", {
      ...defaultSettings(),
      githubIssuePrompt: "my hand-tuned issue template",
      githubPrPrompt: "my hand-tuned PR template",
    })

    const seen = getSettings(alpha, box.home) as Record<string, unknown>
    assert.equal(seen.githubPrompt, undefined, "unset ⇒ the server uses the shipped default")
    assert.equal(seen.githubIssuePrompt, undefined, "the old key does not survive the read")
    assert.equal(seen.githubPrPrompt, undefined)
    // …and the next save writes the stripped shape back, so the dead keys leave the DB for good.
    setSettings(alpha, getSettings(alpha, box.home), box.home)
    const stored = alpha.getSetting("settings") as Record<string, unknown>
    assert.equal("githubIssuePrompt" in stored, false)
    assert.equal("githubPrPrompt" in stored, false)
  } finally {
    box.done()
  }
})

test("retired font preferences are stripped from every settings source without resetting other values", () => {
  const box = sandbox()
  try {
    const alpha = box.open("alpha")
    alpha.setSetting("settings", { ...defaultSettings(), font: "mono", promptCacheTtl: "5m" })
    for (const source of ["project", "legacy", "machine"]) {
      if (source === "legacy") writeLegacySettings(box.home, { font: "mono", notifications: false })
      if (source === "machine") writeMachineConfig(box.home, "settings", { font: "mono", notifications: false })
      const settings = getSettings(alpha, box.home)
      assert.equal("font" in settings, false, source)
      assert.equal(settings.promptCacheTtl, "5m")
      if (source !== "project") assert.equal(settings.notifications, false)
    }
    setSettings(alpha, Settings.parse({ ...getSettings(alpha, box.home), font: "mono" }), box.home)
    assert.equal("font" in (alpha.getSetting("settings") as object), false)
    assert.equal("font" in readMachineConfig(box.home, "settings", z.record(z.string(), z.unknown()))!, false)
  } finally {
    box.done()
  }
})

test("a launch prefix that does not parse is refused at save, and the stored settings are left as they were", () => {
  const box = sandbox()
  try {
    const alpha = box.open("alpha")
    setSettings(alpha, { ...defaultSettings(), launchPrefix: { claude: "op run --" } }, box.home)
    assert.throws(
      () => setSettings(alpha, { ...defaultSettings(), launchPrefix: { claude: "op run --env-file=$HOME/.env --" } }, box.home),
      /Claude Code launch prefix: `\$` is shell syntax/,
    )
    assert.deepEqual(getSettings(alpha, box.home).launchPrefix, { claude: "op run --" })

    // A stored prefix that no longer parses (written by hand here) must not hold every OTHER setting
    // hostage: the save that leaves it untouched goes through.
    alpha.setSetting("settings", { ...defaultSettings(), launchPrefix: { claude: "a | b" } })
    const saved = setSettings(alpha, { ...getSettings(alpha, box.home), notifications: false }, box.home)
    assert.equal(saved.notifications, false)
    assert.equal(saved.launchPrefix?.claude, "a | b", "the untouched prefix is kept as it was")
  } finally {
    box.done()
  }
})
