import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { tmpdir } from "node:os"
import { join } from "node:path"
import assert from "node:assert/strict"
import { test } from "node:test"
import type { LocalFileOpener } from "@frizz/shared"
import {
  MARKDOWN_READ_LIMIT,
  localFileOpenCommand,
  openLocalFile,
  type LocalFileSpawn,
  readLocalMarkdown,
  readLocalTextFile,
  resolveLocalFile,
  resolveOpenableFile,
  resolveWatchableLocalFile,
} from "./local-file.ts"

interface SpawnCall { command: string; args: readonly string[]; options: Parameters<LocalFileSpawn>[2] }

test("Windows URL-shaped paths read, watch and open without bypassing trusted roots", { skip: process.platform !== "win32" }, async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-local-url-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const trusted = join(root, "trusted")
  mkdirSync(trusted)
  const file = join(trusted, "plan space %.md")
  writeFileSync(file, "# Plan\n")
  const urlPath = decodeURIComponent(pathToFileURL(file).pathname)
  assert.match(urlPath, /^\/[A-Za-z]:\//)
  assert.throws(() => realpathSync(urlPath), { code: "ENOENT" })
  for (const path of [file, urlPath, `/${file}`]) {
    assert.deepEqual(readLocalMarkdown(path, [trusted]), { path: file, markdown: "# Plan\n", truncated: false })
    assert.equal(readLocalTextFile(path, [trusted]).text, "# Plan\n")
    assert.equal(resolveWatchableLocalFile(path, [trusted]), file)
    assert.equal(resolveOpenableFile(path, trusted, [trusted]), file)
    assert.deepEqual(await openLocalFile(path, "copy", [trusted]), { action: "copy", path: file })
  }
  const outside = join(root, "secret.md")
  writeFileSync(outside, "secret")
  assert.throws(() => readLocalMarkdown(decodeURIComponent(pathToFileURL(outside).pathname), [trusted]), /trusted roots/)
  assert.throws(() => readLocalMarkdown(`${urlPath}/../gone.md`, [trusted]), /was not found/)
  assert.throws(() => resolveLocalFile("relative.md", [trusted]), /absolute/)
})

test("a Windows root and a path spelled in another case are one directory", { skip: process.platform !== "win32" }, (t) => {
  // `d:\dev\…` under a root git reported as `D:\Development\…` is the same file, and refusing it as
  // "outside Frizz's trusted roots" is how a live file link died for a difference of case alone.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-local-case-")))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const file = join(root, "Plan.md")
  writeFileSync(file, "# Plan\n")
  assert.equal(resolveLocalFile(file.toLowerCase(), [root.toUpperCase()]), realpathSync(file.toLowerCase()))
  assert.equal(readLocalMarkdown(file.toUpperCase(), [root.toLowerCase()]).markdown, "# Plan\n")
  // Containment itself still holds: a sibling of the root is out however it is spelled.
  const outside = join(realpathSync(tmpdir()), `frizz-local-case-outside-${process.pid}.md`)
  writeFileSync(outside, "secret")
  t.after(() => rmSync(outside, { force: true }))
  assert.throws(() => readLocalMarkdown(outside.toLowerCase(), [root]), /trusted roots/)
})

// A ChildProcess stand-in that settles the way a real spawn does: asynchronously, through a `spawn`
// or an `error` EVENT. The `error` is emitted with no listener of the fake's own, so an opener that
// forgot to attach one would throw out of the microtask and kill the test process — which is the
// production crash this pins, in miniature.
function fakeSpawn(calls: SpawnCall[], fail?: NodeJS.ErrnoException): LocalFileSpawn {
  return (command, args, options) => {
    calls.push({ command, args, options })
    const child = Object.assign(new EventEmitter(), { unref() {} })
    queueMicrotask(() => { if (fail) child.emit("error", fail); else child.emit("spawn") })
    return child
  }
}

test("local opener canonicalizes a regular file inside its trusted root and uses fixed argv", async () => {
  const root = mkdtempSync(join(tmpdir(), "frizz-local-file-"))
  const file = join(root, "space ; $(not-a-command).md")
  writeFileSync(file, "safe")
  const calls: SpawnCall[] = []
  const result = await openLocalFile(file, "system", [root], { spawn: fakeSpawn(calls) })
  assert.deepEqual(result, { action: "opened", path: realpathSync(file) })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.at(-1), realpathSync(file))
  assert.equal(calls[0].options.shell, false)
  assert.equal(calls[0].options.windowsHide, true, "a console opener never flashes a window")
})

test("an opener that cannot start is the RPC's error, not an unhandled `error` event", async () => {
  // Windows audit 2026-09-11, finding 1: `xdg-open` does not exist on Windows, so the spawn emitted
  // ENOENT with nobody listening and the control-plane child exited. Now it is a rejection the
  // router answers with.
  const root = mkdtempSync(join(tmpdir(), "frizz-local-file-enoent-"))
  const file = join(root, "README.md")
  writeFileSync(file, "safe")
  const enoent = Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" })
  await assert.rejects(
    openLocalFile(file, "system", [root], { platform: "linux", spawn: fakeSpawn([], enoent) }),
    /^Error: xdg-open is not installed or not on PATH$/u,
  )
  const eacces = Object.assign(new Error("spawn cursor EACCES"), { code: "EACCES" })
  await assert.rejects(
    openLocalFile(file, "cursor", [root], { platform: "linux", spawn: fakeSpawn([], eacces) }),
    /^Error: could not start cursor: spawn cursor EACCES$/u,
  )
})

test("windows: explorer opens and reveals, an installed editor runs its exe, a missing one runs its shim through cmd.exe", () => {
  const path = "C:\\Users\\op\\proj\\space & caret^.md"
  const env = { LOCALAPPDATA: "C:\\Users\\op\\AppData\\Local" }
  const cursorExe = join(env.LOCALAPPDATA, "Programs", "cursor", "Cursor.exe")
  const exists = (candidate: string) => candidate === cursorExe
  const opts = { platform: "win32" as const, env, exists }
  assert.deepEqual(localFileOpenCommand(path, "system", opts), { command: "explorer.exe", args: [path] })
  assert.deepEqual(localFileOpenCommand(path, "finder", opts), { command: "explorer.exe", args: [`/select,${path}`] })
  assert.deepEqual(localFileOpenCommand(path, "cursor", opts), { command: cursorExe, args: [path] })
  // No Code.exe under %LOCALAPPDATA%: the `code` shim runs through cmd.exe, in ONE verbatim argument
  // with the path quoted, so `&` and `^` stay characters of the path.
  assert.deepEqual(localFileOpenCommand(path, "vscode", opts), {
    command: "cmd.exe", args: ["/d", "/s", "/c", `"code "${path}""`], verbatim: true,
  })
  // A `%` would be expanded by cmd.exe even inside quotes, so that path is refused rather than run.
  assert.throws(() => localFileOpenCommand("C:\\p\\100%done.md", "vscode", opts), /cannot hand .* through cmd\.exe/u)
  // Without LOCALAPPDATA at all the shim path is still reachable.
  assert.equal(localFileOpenCommand(path, "cursor", { platform: "win32", env: {}, exists }).command, "cmd.exe")
})

test("windows: the cmd.exe shape reaches spawn with verbatim arguments, everything else without", async () => {
  const root = mkdtempSync(join(tmpdir(), "frizz-local-file-win32-"))
  const file = join(root, "app.ts")
  writeFileSync(file, "safe")
  const calls: SpawnCall[] = []
  const win32 = { platform: "win32" as const, env: {}, exists: () => false, spawn: fakeSpawn(calls) }
  await openLocalFile(file, "vscode", [root], win32)
  await openLocalFile(file, "system", [root], win32)
  assert.equal(calls[0].command, "cmd.exe")
  assert.equal(calls[0].options.windowsVerbatimArguments, true)
  assert.equal(calls[0].options.shell, false, "never shell: true — the quoting is ours, inside one argument")
  assert.equal(calls[1].command, "explorer.exe")
  assert.equal(calls[1].options.windowsVerbatimArguments, undefined)
})

test("each opener preference selects its own app, and an image ignores the preference entirely", async () => {
  const root = mkdtempSync(join(tmpdir(), "frizz-local-file-opener-"))
  const file = join(root, "app.ts")
  writeFileSync(file, "safe")
  const argvFor = async (opener: LocalFileOpener, forceSystem = false) => {
    const calls: SpawnCall[] = []
    await openLocalFile(file, opener, [root], { forceSystem, spawn: fakeSpawn(calls) })
    return [calls[0]!.command, ...calls[0]!.args.slice(0, -1)]
  }
  // The reported bug was upstream of here — the transcript's file links carried a `cursor://` href the
  // OS resolved, so "VS Code" never reached this function at all — but nothing pinned the mapping the
  // setting is FOR, so a swap here would have gone unnoticed too.
  const expected = process.platform === "darwin"
    ? { system: ["open"], cursor: ["open", "-a", "Cursor"], vscode: ["open", "-a", "Visual Studio Code"], finder: ["open", "-R"] }
    : { system: ["xdg-open"], cursor: ["cursor"], vscode: ["code"], finder: ["xdg-open"] }
  assert.deepEqual(await argvFor("system"), expected.system)
  assert.deepEqual(await argvFor("cursor"), expected.cursor)
  assert.deepEqual(await argvFor("vscode"), expected.vscode)
  assert.deepEqual(await argvFor("finder"), expected.finder)
  // An image has a viewer of its own, so it goes to the OS default whatever the editor preference says.
  assert.deepEqual(await argvFor("vscode", true), expected.system)
})

test("local opener refuses relative, outside, directory, and escaping symlink paths", () => {
  const root = mkdtempSync(join(tmpdir(), "frizz-local-file-root-"))
  const outside = mkdtempSync(join(tmpdir(), "frizz-local-file-outside-"))
  const outsideFile = join(outside, "secret.txt")
  writeFileSync(outsideFile, "no")
  const link = join(root, "escape.txt")
  symlinkSync(outsideFile, link)
  assert.throws(() => resolveLocalFile("relative.txt", [root]), /absolute/)
  assert.throws(() => resolveLocalFile(outsideFile, [root]), /trusted roots/)
  assert.throws(() => resolveLocalFile(root, [root]), /regular file/)
  assert.throws(() => resolveLocalFile(link, [root]), /trusted roots/)
})

test("copy preference returns only the canonical trusted path without spawning", async () => {
  const root = mkdtempSync(join(tmpdir(), "frizz-local-file-copy-"))
  const file = join(root, "artifact.txt")
  writeFileSync(file, "safe")
  assert.deepEqual(await openLocalFile(file, "copy", [root], { spawn: () => { throw new Error("must not spawn") } }), { action: "copy", path: realpathSync(file) })
})

test("resolveOpenableFile classifies references: home (~), project-relative, absolute, :line, and misses", () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "frizz-openable-home-")))
  const project = realpathSync(mkdtempSync(join(tmpdir(), "frizz-openable-proj-")))
  const roots = [home, project]
  writeFileSync(join(home, "CLAUDE.md"), "cfg")
  mkdirSync(join(project, "packages", "web", "src"), { recursive: true })
  writeFileSync(join(project, "packages", "web", "src", "App.tsx"), "code")

  // ~-relative expands to the home root
  assert.equal(resolveOpenableFile("~/CLAUDE.md", project, roots, home), join(home, "CLAUDE.md"))
  // A Windows worker spells the same reference with a backslash (2026-09-11).
  assert.equal(resolveOpenableFile("~\\CLAUDE.md", project, roots, home), join(home, "CLAUDE.md"))
  // repo-relative resolves against the project dir
  assert.equal(resolveOpenableFile("packages/web/src/App.tsx", project, roots, home), join(project, "packages", "web", "src", "App.tsx"))
  // an absolute path is taken as-is
  assert.equal(resolveOpenableFile(join(project, "packages/web/src/App.tsx"), project, roots, home), join(project, "packages", "web", "src", "App.tsx"))
  // a trailing :line[:col] editor suffix is stripped before resolving
  assert.equal(resolveOpenableFile("packages/web/src/App.tsx:42:7", project, roots, home), join(project, "packages", "web", "src", "App.tsx"))
  // misses → null (never throws): nonexistent, a directory, and a path outside the roots
  assert.equal(resolveOpenableFile("~/nope.md", project, roots, home), null)
  assert.equal(resolveOpenableFile("packages/web", project, roots, home), null) // a directory, not a file
  assert.equal(resolveOpenableFile("/etc/hosts", project, roots, home), null) // outside the openable roots
  assert.equal(resolveOpenableFile("   ", project, roots, home), null)
})

test("the Markdown reader admits only Markdown, only inside the roots, and only as a real file", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-local-md-")))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "frizz-local-md-outside-")))
  writeFileSync(join(root, "README.md"), "# Title\n\nBody.\n")
  writeFileSync(join(root, "notes.txt"), "not markdown")
  writeFileSync(join(root, "post.mdx"), "import X from './x'\n\n# Post\n")
  writeFileSync(join(outside, "secret.md"), "no")
  // A `.md` name whose canonical target is something else: the extension is on the href, not the file.
  writeFileSync(join(root, "real.conf"), "PASSWORD=hunter2")
  symlinkSync(join(root, "real.conf"), join(root, "decoy.md"))
  // …while an ordinary symlinked doc (a skill file linked out of a shared tree) still reads.
  symlinkSync(join(root, "README.md"), join(root, "linked.md"))

  assert.deepEqual(readLocalMarkdown(join(root, "README.md"), [root]), {
    path: join(root, "README.md"),
    markdown: "# Title\n\nBody.\n",
    truncated: false,
  })
  assert.equal(readLocalMarkdown(join(root, "linked.md"), [root]).path, join(root, "README.md"))
  assert.equal(readLocalMarkdown(join(root, "post.mdx"), [root]).markdown, "import X from './x'\n\n# Post\n")
  assert.throws(() => readLocalMarkdown(join(root, "notes.txt"), [root]), /not a Markdown file/)
  assert.throws(() => readLocalMarkdown(join(root, "decoy.md"), [root]), /not a Markdown file/)
  assert.throws(() => readLocalMarkdown(join(outside, "secret.md"), [root]), /trusted roots/)
  assert.throws(() => readLocalMarkdown(join(root, "gone.md"), [root]), /was not found/)
  assert.throws(() => readLocalMarkdown("README.md", [root]), /absolute/)
})

test("an oversized Markdown file is cut at a line boundary and reports the cut", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-local-md-big-")))
  const file = join(root, "huge.md")
  const line = `${"x".repeat(99)}\n`
  writeFileSync(file, line.repeat(Math.ceil((MARKDOWN_READ_LIMIT * 1.5) / line.length)))
  const read = readLocalMarkdown(file, [root])
  assert.equal(read.truncated, true)
  assert.ok(read.markdown.length <= MARKDOWN_READ_LIMIT, "the cut respects the ceiling")
  assert.ok(read.markdown.length > MARKDOWN_READ_LIMIT - line.length, "the cut takes the whole prefix it can")
  // Whole lines only — the tail is never a half-written line (nor a split multi-byte character).
  assert.equal(read.markdown.endsWith("x".repeat(99)), true)
  assert.equal(read.markdown.split("\n").every((l) => l === "" || l.length === 99), true)
})

test("the text reader spans every openable root, not the project dir alone, and refuses binary", () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "frizz-local-text-project-")))
  // A worker's checkout is very often NOT the project directory — a git worktree, a sibling clone,
  // `/tmp` scratch. The viewer's gate is the reader's, so every one of those rows opens.
  const worktree = realpathSync(mkdtempSync(join(tmpdir(), "frizz-local-text-worktree-")))
  const untrusted = realpathSync(mkdtempSync(join(tmpdir(), "frizz-local-text-untrusted-")))
  const roots = [project, worktree]
  writeFileSync(join(project, "app.ts"), "export const a = 1\n")
  writeFileSync(join(worktree, "mod.rs"), "fn main() {}\n")
  writeFileSync(join(untrusted, "elsewhere.ts"), "no")
  writeFileSync(join(worktree, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]))

  assert.equal(readLocalTextFile(join(project, "app.ts"), roots).text, "export const a = 1\n")
  assert.deepEqual(readLocalTextFile(join(worktree, "mod.rs"), roots), {
    path: join(worktree, "mod.rs"),
    text: "fn main() {}\n",
    truncated: false,
  })
  assert.throws(() => readLocalTextFile(join(untrusted, "elsewhere.ts"), roots), /trusted roots/)
  assert.throws(() => readLocalTextFile(join(worktree, "logo.png"), roots), /not a text file/)
})

test("a watch attaches exactly where the read is allowed, and a decoy .md arms nothing", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "frizz-local-watch-")))
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "frizz-local-watch-outside-")))
  writeFileSync(join(root, "README.md"), "# Title\n")
  writeFileSync(join(root, "app.ts"), "export const a = 1\n")
  writeFileSync(join(root, "real.conf"), "PASSWORD=hunter2")
  symlinkSync(join(root, "real.conf"), join(root, "decoy.md"))
  writeFileSync(join(outside, "other.ts"), "no")

  assert.equal(resolveWatchableLocalFile(join(root, "README.md"), [root]), join(root, "README.md"))
  assert.equal(resolveWatchableLocalFile(join(root, "app.ts"), [root]), join(root, "app.ts"))
  // The Markdown reader refuses a `.md` href whose canonical target is not Markdown, so the watch must
  // too — otherwise a file the reader cannot show still reports that it changed.
  assert.throws(() => resolveWatchableLocalFile(join(root, "decoy.md"), [root]), /not a Markdown file/)
  assert.throws(() => resolveWatchableLocalFile(join(outside, "other.ts"), [root]), /trusted roots/)
})
