import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BoardSnapshot } from "@frizz/shared"
import type { BoardManager } from "./board.ts"
import { Bus, Emitter } from "./bus.ts"
import type { AppContext } from "./context.ts"
import { resetFrizzRoots } from "./frizz-paths.ts"
import { detectGithub } from "./github.ts"
import { resetGithubCredentialMemo } from "./github-credential.ts"
import type { Project } from "./project.ts"
import { createRouter } from "./router.ts"
import { createStorage } from "./storage.ts"
import type { Tailer } from "./tailer.ts"

// A repo moved to another org while Frizz runs (2026-11-17: colinhacks/reylo → reylosql/reylo). The
// boot cache held the old name, and GitHub's search refuses a moved repo's old name with a 422 while
// every other API follows the move, so the picker read "Couldn't load issues" until a restart.
//
// The seam is a real git checkout and a stub `gh` that answers as GitHub does: `repo view` follows a
// move recorded in `moves`, and `search/issues` 422s an old name. Every call is logged, so a test can
// tell a cached answer from a fresh one.
const stubGh = `#!/bin/sh
echo "$*" >> "$STUB_DIR/calls"
case "$1" in
  --version) echo "gh version 2.0.0"; exit 0 ;;
  repo)
    url=$(git remote get-url origin) || exit 1
    name=$(printf '%s' "$url" | sed -E 's#^.*github.com[:/]##; s#\\.git$##')
    moved=$(awk -v n="$name" '$1 == n { print $2 }' "$STUB_DIR/moves")
    echo "\${moved:-$name}"
    exit 0 ;;
  api)
    case "$*" in *search/issues*) ;; *) exit 1 ;; esac
    repo=$(printf '%s\\n' "$@" | sed -n 's/^q=repo:\\([^ ]*\\) .*/\\1/p')
    if awk -v n="$repo" '$1 == n { found = 1 } END { exit !found }' "$STUB_DIR/moves"; then
      echo '{"message":"Validation Failed","status":"422"}'
      echo "gh: Validation Failed (HTTP 422)" >&2
      exit 1
    fi
    printf '{"total_count":1,"items":[{"number":7,"title":"Open in %s","html_url":"https://github.com/%s/issues/7"}]}' "$repo" "$repo"
    exit 0 ;;
esac
exit 1
`

const posixOnly = { skip: process.platform === "win32" ? "the stub is a POSIX shell script" : false }

function harness(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), "frizz-repo-moved-"))
  const repo = join(root, "app")
  const bin = join(root, "bin")
  const stub = join(root, "stub")
  for (const dir of [repo, bin, stub]) execFileSync("mkdir", ["-p", dir])
  writeFileSync(join(bin, "gh"), stubGh, { mode: 0o755 })
  writeFileSync(join(stub, "moves"), "")
  writeFileSync(join(stub, "calls"), "")
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" })
  git("init", "-q")
  git("remote", "add", "origin", "git@github.com:old-owner/app.git")

  const saved = { HOME: process.env.HOME, PATH: process.env.PATH, XDG_DATA_HOME: process.env.XDG_DATA_HOME, FRIZZ_GITHUB_TOKEN: process.env.FRIZZ_GITHUB_TOKEN, STUB_DIR: process.env.STUB_DIR }
  process.env.HOME = join(root, "home")
  process.env.XDG_DATA_HOME = join(root, "home", "data")
  process.env.PATH = `${bin}:${saved.PATH ?? ""}`
  process.env.FRIZZ_GITHUB_TOKEN = "gho_test_token"
  process.env.STUB_DIR = stub
  resetFrizzRoots()
  resetGithubCredentialMemo()

  const storage = createStorage(join(root, "ui.db"), "p")
  t.after(() => {
    storage.close()
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetFrizzRoots()
    resetGithubCredentialMemo()
    rmSync(root, { recursive: true, force: true })
  })

  const project: Project = { dir: repo, id: "p", name: "app", label: "old-owner/app", stateDir: root, cwdSlug: "app" }
  const snapshot = { threads: [] } as unknown as BoardSnapshot
  const ctx = {
    project, storage,
    board: { refresh: () => snapshot, snapshot: async () => snapshot } as unknown as BoardManager,
    tailer: { telemetry: () => new Map() } as unknown as Tailer,
    transcriptChange: new Emitter<string[]>(),
    bus: new Bus(),
    getSettings: () => ({}),
  } as unknown as AppContext
  const router = createRouter(ctx)
  return {
    ctx,
    git,
    // GitHub moves the repo: lookups of the old name now answer the new one, and search refuses it.
    move: (from: string, to: string) => writeFileSync(join(stub, "moves"), `${from} ${to}\n`),
    calls: () => readFileSync(join(stub, "calls"), "utf8").split("\n").filter(Boolean),
    status: () => router.githubStatus.handler({}),
    list: () => router.githubList.handler({ input: { kind: "issues" as const, sort: "recent" as const, page: 1, perPage: 30 } }),
    boot: async () => {
      ctx.github = await detectGithub(repo)
    },
  }
}

test("a remote repointed after boot is resolved again, and the picker searches the new name", posixOnly, async (t) => {
  const h = harness(t)
  await h.boot()
  assert.equal(h.ctx.github?.nameWithOwner, "old-owner/app")

  // Unchanged remotes: the boot cache answers, and gh is not asked again.
  const bootCalls = h.calls().length
  assert.equal((await h.status()).nameWithOwner, "old-owner/app")
  assert.equal(h.calls().length, bootCalls, "a cached name costs no gh call")

  h.move("old-owner/app", "new-owner/app")
  h.git("remote", "set-url", "origin", "git@github.com:new-owner/app.git")

  assert.equal((await h.status()).nameWithOwner, "new-owner/app")
  const page = await h.list()
  assert.deepEqual(page.items.map((it) => it.title), ["Open in new-owner/app"])
  assert.ok(!h.calls().some((c) => c.includes("q=repo:old-owner/app")), "the old name is never searched")

  // Signed out, the status reads the same: the stale cache gives way to the local remote.
  delete process.env.FRIZZ_GITHUB_TOKEN
  resetGithubCredentialMemo()
  h.git("remote", "set-url", "origin", "git@github.com:third-owner/app.git")
  assert.equal((await h.status()).nameWithOwner, "third-owner/app")
})

test("a repo moved with its remote unchanged heals on the search GitHub refuses", posixOnly, async (t) => {
  const h = harness(t)
  await h.boot()
  h.move("old-owner/app", "new-owner/app")

  const page = await h.list()
  assert.deepEqual(page.items.map((it) => it.title), ["Open in new-owner/app"])
  const searches = h.calls().filter((c) => c.includes("search/issues"))
  assert.equal(searches.length, 2, "one refused search under the old name, one under the new")
  assert.equal((await h.status()).nameWithOwner, "new-owner/app", "and the cache now holds the new name")
})

test("a refused search for a repo that did not move is still an error", posixOnly, async (t) => {
  const h = harness(t)
  await h.boot()
  // Search refuses the name, but gh's lookup answers the same name back: nothing moved, so there is
  // nothing to retry under, and the picker shows GitHub's refusal.
  h.move("old-owner/app", "old-owner/app")
  await assert.rejects(h.list(), /HTTP 422/)
  assert.equal(h.calls().filter((c) => c.includes("search/issues")).length, 1)
})
