import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { resetFrizzRoots } from "./frizz-paths.ts"
import { remoteReadablePath } from "./remote-reads.ts"

// Every file below is fake, on a disposable HOME. This file runs in its own process, so the override is
// contained to it (see project-teardown.test.ts homeSandbox).
function sandbox(t: { after: (fn: () => void) => void }) {
  const home = mkdtempSync(join(tmpdir(), "frizz-remote-reads-"))
  const previous = process.env.HOME
  process.env.HOME = home
  resetFrizzRoots()
  t.after(() => {
    process.env.HOME = previous
    resetFrizzRoots()
    rmSync(home, { recursive: true, force: true })
  })
  const put = (path: string, text = "secret") => {
    const full = join(home, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, text)
    return full
  }
  return { home, put, project: join(home, "work", "repo") }
}

test("a remote caller reads a project's files, a thread's scratch and an attachment", (t) => {
  const { put, project } = sandbox(t)
  for (const path of [
    put("work/repo/src/index.ts"),
    put("work/repo/README.md"),
    put("work/repo/.frizz/threads/abc/notes.md"),
    put("work/repo/.frizz/worktrees/feature/src/a.ts"),
    put(".frizz/projects/p1/attachments/1730000000-ab/shot.png"),
  ]) {
    assert.ok(remoteReadablePath(path, [project]), path)
  }
})

test("a remote caller reads no secret: keys, dot-files, the state root, and whatever a symlink reaches", (t) => {
  const { home, put, project } = sandbox(t)
  const envFile = put("work/repo/.env")
  const publicFile = put("work/repo/public.txt", "public")
  const sshKey = put(".ssh/id_rsa")
  const refused: Record<string, string> = {
    "an ssh key": sshKey,
    "ssh config": put(".ssh/config"),
    "Frizz's claim key": put(".frizz/identity.key"),
    "a board's session key": put(".frizz/projects/p1/session-key"),
    "a board's device list": put(".frizz/projects/p1/sessions.json"),
    "a board's database": put(".frizz/frizz.db"),
    "Claude's credentials": put(".claude/.credentials.json"),
    "Codex's credentials": put(".codex/auth.json"),
    "a project's .env": envFile,
    "a project's git config": put("work/repo/.git/config"),
    "a nested dot-file": put("work/repo/packages/web/.npmrc"),
    "a key-named file": put("work/repo/deploy/server.pem"),
    "an ssh key name": put("work/repo/backup/id_ed25519"),
    "a credentials file": put("work/repo/config/credentials.json"),
    "an attachment named like a key": put(".frizz/projects/p1/attachments/1730000000-ab/session-key"),
    "another project": put("work/other/README.md"),
    "something beside the project": put("work/notes.txt"),
    "a system file": "/etc/hosts",
    "no such file": join(project, "missing.txt"),
    "a relative path": "README.md",
    "a path that climbs out": join(project, "..", "..", ".ssh", "id_rsa"),
  }
  const link = (name: string, target: string) => {
    const path = join(project, name)
    symlinkSync(target, path)
    return path
  }
  refused["a symlink out of the project"] = link("harmless.txt", sshKey)
  refused["a symlink to the project's .env"] = link("config.txt", envFile)
  refused["a symlink named .env"] = link(".env.local", publicFile)
  refused["a symlink out to a directory"] = join(link("home", home), ".ssh", "id_rsa")
  for (const [what, path] of Object.entries(refused)) {
    assert.equal(remoteReadablePath(path, [project]), null, `${what}: ${path}`)
  }
})

test("a project at the home folder still reads no secret", (t) => {
  const { home, put } = sandbox(t)
  assert.ok(remoteReadablePath(put("work/repo/a.ts"), [home]))
  for (const path of [put(".ssh/id_rsa"), put(".frizz/identity.key"), put(".frizz/projects/p1/session-key"), put(".claude/.credentials.json")]) {
    assert.equal(remoteReadablePath(path, [home]), null, path)
  }
})
