import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS, claudeRetentionWarning, claudeTranscriptRetention } from "./claude-retention.ts"

function scopes() {
  const root = mkdtempSync(join(tmpdir(), "frizz-retention-"))
  const cwd = join(root, "project")
  const home = join(root, "home")
  const managed = join(root, "managed-settings.json")
  mkdirSync(join(cwd, ".claude"), { recursive: true })
  mkdirSync(join(home, ".claude"), { recursive: true })
  const where = { cwd, home, env: {}, managedPaths: [managed] }
  const write = (file: string, settings: unknown) => writeFileSync(file, typeof settings === "string" ? settings : JSON.stringify(settings))
  return {
    where,
    managed: (s: unknown) => write(managed, s),
    local: (s: unknown) => write(join(cwd, ".claude", "settings.local.json"), s),
    project: (s: unknown) => write(join(cwd, ".claude", "settings.json"), s),
    user: (s: unknown) => write(join(home, ".claude", "settings.json"), s),
    paths: { managed, local: join(cwd, ".claude", "settings.local.json"), project: join(cwd, ".claude", "settings.json"), user: join(home, ".claude", "settings.json") },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

test("no settings file sets cleanupPeriodDays: Claude Code's default of 30 applies", () => {
  const s = scopes()
  try {
    s.user({ model: "opus" })
    assert.deepEqual(claudeTranscriptRetention(s.where), { days: CLAUDE_DEFAULT_CLEANUP_PERIOD_DAYS, source: null })
  } finally {
    s.cleanup()
  }
})

test("a project's scopes can only SHORTEN its period: any other directory's process still sweeps on the user settings", () => {
  const s = scopes()
  try {
    s.user({ cleanupPeriodDays: 3650 })
    assert.deepEqual(claudeTranscriptRetention(s.where), { days: 3650, source: s.paths.user })
    s.project({ cleanupPeriodDays: 120 })
    assert.deepEqual(claudeTranscriptRetention(s.where), { days: 120, source: s.paths.project })
    s.local({ cleanupPeriodDays: 14 })
    assert.deepEqual(claudeTranscriptRetention(s.where), { days: 14, source: s.paths.local }, "local outranks project")
    s.user({ cleanupPeriodDays: 10 })
    assert.deepEqual(claudeTranscriptRetention(s.where), { days: 10, source: s.paths.user }, "the user period is shorter still")
    s.local({ cleanupPeriodDays: 4000 })
    s.project({})
    assert.deepEqual(claudeTranscriptRetention(s.where), { days: 10, source: s.paths.user }, "a long local period does not protect this project's files")
    s.managed({ cleanupPeriodDays: 7 })
    assert.deepEqual(claudeTranscriptRetention(s.where), { days: 7, source: s.paths.managed, managed: true })
  } finally {
    s.cleanup()
  }
})

test("the machine-wide reading leaves every project's scopes out", () => {
  const s = scopes()
  try {
    s.user({ cleanupPeriodDays: 3650 })
    s.local({ cleanupPeriodDays: 14 })
    const { cwd: _cwd, ...machine } = s.where
    assert.deepEqual(claudeTranscriptRetention(machine), { days: 3650, source: s.paths.user })
  } finally {
    s.cleanup()
  }
})

test("a value Claude Code refuses, or a settings file it cannot parse, pauses its sweep: nothing is deleted", () => {
  // In the user scope every Claude Code process on the machine loads it, so every sweep is paused.
  for (const value of [{ cleanupPeriodDays: 0 }, { cleanupPeriodDays: 1.5 }, { cleanupPeriodDays: "90" }, "{ not json"]) {
    const s = scopes()
    try {
      s.user(value)
      assert.equal(claudeTranscriptRetention(s.where), null, JSON.stringify(value))
    } finally {
      s.cleanup()
    }
  }
  // In a project's scopes it pauses only the processes started there; every other directory still sweeps.
  for (const [scope, value] of [["local", { cleanupPeriodDays: 0 }], ["project", { cleanupPeriodDays: "90" }], ["project", "{ not json"]] as const) {
    const s = scopes()
    try {
      s.user({ cleanupPeriodDays: 60 })
      s[scope](value)
      assert.deepEqual(claudeTranscriptRetention(s.where), { days: 60, source: s.paths.user }, `${scope}: ${JSON.stringify(value)}`)
    } finally {
      s.cleanup()
    }
  }
  const s = scopes()
  try {
    // A managed value is honoured whatever else is wrong.
    s.user({ cleanupPeriodDays: 0 })
    s.managed({ cleanupPeriodDays: 200 })
    assert.deepEqual(claudeTranscriptRetention(s.where), { days: 200, source: s.paths.managed, managed: true })
  } finally {
    s.cleanup()
  }
})

test("CLAUDE_CONFIG_DIR moves the user scope, as it moves Claude Code's", () => {
  const s = scopes()
  try {
    const configDir = join(s.where.home, "elsewhere")
    mkdirSync(configDir)
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({ cleanupPeriodDays: 200 }))
    s.user({ cleanupPeriodDays: 5 })
    assert.deepEqual(claudeTranscriptRetention({ ...s.where, env: { CLAUDE_CONFIG_DIR: configDir } }), { days: 200, source: join(configDir, "settings.json") })
  } finally {
    s.cleanup()
  }
})

test("the launcher warns below three months and names the period, where it came from, and the file to fix", () => {
  const user = "/u/.claude/settings.json"
  const tilde = (p: string) => p.replace("/u/", "~/")
  assert.equal(
    claudeRetentionWarning({ days: 30, source: null }, user, tilde),
    `Claude Code deletes a thread's history 30 days after its last activity (Claude Code's default cleanupPeriodDays). Set "cleanupPeriodDays": 3650 in ~/.claude/settings.json to keep it.`,
  )
  assert.match(claudeRetentionWarning({ days: 1, source: user }, user, tilde) ?? "", /history 1 day after .*\(cleanupPeriodDays in ~\/\.claude\/settings\.json\)/)
  assert.equal(
    claudeRetentionWarning({ days: 1, source: "/u/elsewhere/settings.json" }, "/u/elsewhere/settings.json", tilde),
    `Claude Code deletes a thread's history 1 day after its last activity (cleanupPeriodDays in ~/elsewhere/settings.json). Set "cleanupPeriodDays": 3650 in ~/elsewhere/settings.json to keep it.`,
    "CLAUDE_CONFIG_DIR's file is the one to fix",
  )
  assert.equal(
    claudeRetentionWarning({ days: 14, source: "/etc/claude-code/managed-settings.json", managed: true }, user, tilde),
    `Claude Code deletes a thread's history 14 days after its last activity (cleanupPeriodDays in /etc/claude-code/managed-settings.json, set by your organization).`,
    "no user setting overrides a managed one, so none is suggested",
  )
  assert.equal(claudeRetentionWarning({ days: 90, source: user }, user), undefined)
  assert.equal(claudeRetentionWarning({ days: 3650, source: user }, user), undefined)
  assert.equal(claudeRetentionWarning(null, user), undefined, "a paused sweep deletes nothing")
})
