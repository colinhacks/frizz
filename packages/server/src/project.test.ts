import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cwdSlug, parseRepoLabel, projectFromRegistryEntry } from "./project.ts"

test("cwdSlug: every non-alphanumeric character becomes '-', on every platform", () => {
  // The rule Claude Code applies to the cwd to name ~/.claude/projects/<slug>. Every expectation here
  // is a directory name measured on disk, not derived. The old rule replaced only '/' and '.', which
  // left a Windows path untouched — `D:\Development\Feature3` stayed `D:\Development\Feature3` — so the
  // tailer watched a path that never existed, raised "no transcript 60s after dispatch — likely a boot
  // failure" and marked every Windows thread dead while claude was still working (Windows Server 2022,
  // frizz 0.8.1, 2026-09-01). The same rule also mis-slugs '_' and ' ' on POSIX.
  assert.equal(cwdSlug("/Users/x/.workshell"), "-Users-x--workshell")
  assert.equal(cwdSlug("D:\\Development\\Feature3"), "D--Development-Feature3")
  assert.equal(cwdSlug("D:\\Development\\frizz\\slug_probe dir"), "D--Development-frizz-slug-probe-dir")
  assert.equal(cwdSlug("/home/x/my_repo v2"), "-home-x-my-repo-v2")
})

test("parseRepoLabel: scp-like ssh with .git", () => {
  assert.equal(parseRepoLabel("git@github.com:owner/repo.git"), "owner/repo")
})

test("parseRepoLabel: scp-like ssh without .git", () => {
  assert.equal(parseRepoLabel("git@github.com:owner/repo"), "owner/repo")
})

test("parseRepoLabel: https with .git", () => {
  assert.equal(parseRepoLabel("https://github.com/owner/repo.git"), "owner/repo")
})

test("parseRepoLabel: https without .git and trailing slash", () => {
  assert.equal(parseRepoLabel("https://github.com/owner/repo/"), "owner/repo")
})

test("parseRepoLabel: ssh:// url form", () => {
  assert.equal(parseRepoLabel("ssh://git@github.com/owner/repo.git"), "owner/repo")
})

test("parseRepoLabel: nested gitlab group keeps final owner/repo", () => {
  assert.equal(parseRepoLabel("https://gitlab.com/group/sub/repo.git"), "sub/repo")
})

test("parseRepoLabel: junk / empty → null", () => {
  assert.equal(parseRepoLabel(""), null)
  assert.equal(parseRepoLabel("not-a-url"), null)
})

test("a project registered but never OPENED still gets its state directory", () => {
  // The tenant path. `projectAdd` — the grid's "Add a project" and the rail's — registers an id and
  // writes the index without opening anything, so the state dir does not exist yet. SQLite will not
  // create `ui.db` under a missing directory, so this used to fail activation with "unable to open
  // database file"; and because tenants.ts REPORTS activation failures instead of throwing, it
  // surfaced as a bare 404 on that project's every route — a card you can click and a board that
  // never loads. Measured against a real second project on 2026-08-06.
  const home = mkdtempSync(join(tmpdir(), "frizz-tenant-"))
  try {
    mkdirSync(join(home, ".frizz"), { recursive: true }) // legacy collapse root, as the real tree has
    const id = "9f2b7c40-0000-4000-8000-000000000001"
    const project = projectFromRegistryEntry({ id, path: join(home, "code", "newly-added") }, home)
    assert.ok(existsSync(project.stateDir), `expected ${project.stateDir} to exist`)
    // Idempotent — every routed request to that project builds one of these.
    assert.doesNotThrow(() => projectFromRegistryEntry({ id, path: join(home, "code", "newly-added") }, home))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
