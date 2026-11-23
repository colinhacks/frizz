import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { launchNotices } from "./launch-notices.ts"

function home(t: test.TestContext, settings?: object): string {
  const dir = mkdtempSync(join(tmpdir(), "frizz-launch-notices-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  if (settings) {
    mkdirSync(join(dir, ".claude"))
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(settings))
  }
  return dir
}

const where = (dir: string) => ({ home: dir, env: {}, managedPaths: [] })

test("a short Claude Code retention period is a notice, with the settings file written from ~", (t) => {
  const dir = home(t, { cleanupPeriodDays: 7 })
  assert.deepEqual(launchNotices({}, where(dir)), [
    'Claude Code deletes a thread\'s history 7 days after its last activity (cleanupPeriodDays in ~/.claude/settings.json). Set "cleanupPeriodDays": 3650 in ~/.claude/settings.json to keep it.',
  ])
  // No settings file is Claude Code's default of 30 days, which is short too.
  assert.match(launchNotices({}, where(home(t)))[0] ?? "", /history 30 days after .*default cleanupPeriodDays/)
})

test("a long period, and a sandbox, have nothing to say", (t) => {
  assert.deepEqual(launchNotices({}, where(home(t, { cleanupPeriodDays: 3650 }))), [])
  assert.deepEqual(launchNotices({ sandbox: true }, where(home(t, { cleanupPeriodDays: 7 }))), [])
})
