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
    paths: { managed, local: join(cwd, ".claude", "settings.local.json"), user: join(home, ".claude", "settings.json") },
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

test("the highest-precedence scope that sets it wins, and the file is named", () => {
  const s = scopes()
  try {
    s.user({ cleanupPeriodDays: 3650 })
    assert.deepEqual(claudeTranscriptRetention(s.where), { days: 3650, source: s.paths.user })
    s.project({ cleanupPeriodDays: 120 })
    s.local({ cleanupPeriodDays: 14 })
    assert.deepEqual(claudeTranscriptRetention(s.where), { days: 14, source: s.paths.local })
    s.managed({ cleanupPeriodDays: 7 })
    assert.deepEqual(claudeTranscriptRetention(s.where), { days: 7, source: s.paths.managed })
  } finally {
    s.cleanup()
  }
})

test("a value Claude Code would refuse, or a file that is not JSON, sets nothing", () => {
  const s = scopes()
  try {
    s.user({ cleanupPeriodDays: 365 })
    s.local({ cleanupPeriodDays: 0 })
    s.project("{ not json")
    s.managed({ cleanupPeriodDays: "90" })
    assert.deepEqual(claudeTranscriptRetention(s.where), { days: 365, source: s.paths.user })
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

test("the launcher warns below three months and names the period and where it came from", () => {
  assert.equal(
    claudeRetentionWarning({ days: 30, source: null }),
    `Claude Code deletes a thread's history 30 days after its last activity (Claude Code's default cleanupPeriodDays). Set "cleanupPeriodDays": 3650 in ~/.claude/settings.json to keep it.`,
  )
  assert.match(claudeRetentionWarning({ days: 1, source: "/u/.claude/settings.json" }, () => "~/.claude/settings.json") ?? "", /history 1 day after .*\(cleanupPeriodDays in ~\/\.claude\/settings\.json\)/)
  assert.equal(claudeRetentionWarning({ days: 90, source: "/u/.claude/settings.json" }), undefined)
  assert.equal(claudeRetentionWarning({ days: 3650, source: "/u/.claude/settings.json" }), undefined)
})
