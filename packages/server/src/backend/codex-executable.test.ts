import { test } from "node:test"
import assert from "node:assert/strict"
import { CodexExecutableNotFoundError, resolveCodexExecutable } from "./codex-executable.ts"

// The resolver is pure over an injected environment, so every Windows layout is pinned HERE, on the
// machines that run this suite, rather than on a Windows box nobody has (Windows audit 2026-09-11,
// finding 8). Each case is a tiny virtual filesystem: a set of paths that exist plus the text of any
// `.cmd` shim, spelled exactly as npm's cmd-shim writes them.

const BIN = "C:\\Users\\op\\AppData\\Roaming\\npm"
const NODE = "C:\\Program Files\\nodejs\\node.exe"

// npm cmd-shim's output for a shebang'd JS bin (read from cmd-shim 6 on 2026-09-11): the target sits
// mid-line after `endLocal & …`, and `%dp0%\node.exe` appears earlier in an IF EXIST. Both traps the
// resolver's regex must survive.
const JS_SHIM = [
  "@ECHO off",
  "GOTO start",
  ":find_dp0",
  "SET dp0=%~dp0",
  "EXIT /b",
  ":start",
  "SETLOCAL",
  "CALL :find_dp0",
  "",
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ") ELSE (",
  '  SET "_prog=node"',
  "  SET PATHEXT=%PATHEXT:;.JS;=;%",
  ")",
  "",
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join("\r\n")

// The other cmd-shim shape: a bin with no shebang is called directly.
const EXE_SHIM = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\vendor\\codex.exe"   %*\r\n'

const LAUNCHER = `${BIN}\\node_modules\\@openai\\codex\\bin\\codex.js`
const NESTED_EXE = `${BIN}\\node_modules\\@openai\\codex\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`
const HOISTED_EXE = `${BIN}\\node_modules\\@openai\\codex-win32-x64\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`
const HOISTED_ARM64_EXE = `${BIN}\\node_modules\\@openai\\codex-win32-arm64\\vendor\\aarch64-pc-windows-msvc\\bin\\codex.exe`
const LEGACY_EXE = `${BIN}\\node_modules\\@openai\\codex\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe`

function windowsResolve(files: Record<string, string | true>, over: { arch?: string; env?: NodeJS.ProcessEnv; bin?: string } = {}) {
  return resolveCodexExecutable(over.bin, {
    platform: "win32",
    arch: over.arch ?? "x64",
    execPath: NODE,
    env: over.env ?? { Path: `C:\\Windows\\system32;${BIN}` },
    access: (path) => path in files,
    readFile: (path) => { const body = files[path]; return typeof body === "string" ? body : undefined },
  })
}

test("codex resolver, win32: the table of npm layouts", () => {
  const cases: Array<{ name: string; files: Record<string, string | true>; arch?: string; expected: { file: string; args: string[] } }> = [
    {
      name: "a real codex.exe on PATH wins outright, before any shim is read",
      files: { [`${BIN}\\codex.exe`]: true, [`${BIN}\\codex.cmd`]: JS_SHIM, [LAUNCHER]: true, [HOISTED_EXE]: true },
      expected: { file: `${BIN}\\codex.exe`, args: [] },
    },
    {
      name: "the shim's JS launcher is followed to the native binary in the hoisted platform package",
      files: { [`${BIN}\\codex.cmd`]: JS_SHIM, [LAUNCHER]: true, [HOISTED_EXE]: true },
      expected: { file: HOISTED_EXE, args: [] },
    },
    {
      name: "… or in a platform package nested under @openai/codex",
      files: { [`${BIN}\\codex.cmd`]: JS_SHIM, [LAUNCHER]: true, [NESTED_EXE]: true },
      expected: { file: NESTED_EXE, args: [] },
    },
    {
      name: "… or in the package's own vendor/ (the pre-platform-package layout)",
      files: { [`${BIN}\\codex.cmd`]: JS_SHIM, [LAUNCHER]: true, [LEGACY_EXE]: true },
      expected: { file: LEGACY_EXE, args: [] },
    },
    {
      name: "the triple follows the arch: arm64 looks for aarch64-pc-windows-msvc",
      files: { [`${BIN}\\codex.cmd`]: JS_SHIM, [LAUNCHER]: true, [HOISTED_EXE]: true, [HOISTED_ARM64_EXE]: true },
      arch: "arm64",
      expected: { file: HOISTED_ARM64_EXE, args: [] },
    },
    {
      name: "no vendored binary where this launcher version keeps it ⇒ run the launcher under node",
      files: { [`${BIN}\\codex.cmd`]: JS_SHIM, [LAUNCHER]: true },
      expected: { file: NODE, args: [LAUNCHER] },
    },
    {
      name: "a shim that calls a non-script target runs that target",
      files: { [`${BIN}\\codex.cmd`]: EXE_SHIM, [`${BIN}\\node_modules\\vendor\\codex.exe`]: true },
      expected: { file: `${BIN}\\node_modules\\vendor\\codex.exe`, args: [] },
    },
  ]
  for (const c of cases) {
    assert.deepEqual(windowsResolve(c.files, { arch: c.arch }), c.expected, c.name)
  }
})

test("codex resolver, win32: never the extensionless sh script, and a dangling shim is a miss", () => {
  // The bin dir holds `codex` (a `#!/bin/sh` script) — the one file a Windows spawn can never run.
  assert.throws(() => windowsResolve({ [`${BIN}\\codex`]: true }), CodexExecutableNotFoundError)
  // A shim whose target is gone (a half-removed install) is skipped, not returned.
  assert.throws(() => windowsResolve({ [`${BIN}\\codex.cmd`]: JS_SHIM }), CodexExecutableNotFoundError)
  // An unreadable shim reads as absent.
  assert.throws(() => windowsResolve({ [`${BIN}\\codex.cmd`]: true, [LAUNCHER]: true }), CodexExecutableNotFoundError)
})

test("codex resolver, win32: the search path is read under every spelling, and an absolute pin is passed through", () => {
  const files: Record<string, string | true> = { [`${BIN}\\codex.exe`]: true }
  for (const spelling of ["PATH", "Path", "path", "pAtH"]) {
    assert.deepEqual(windowsResolve(files, { env: { [spelling]: BIN } }), { file: `${BIN}\\codex.exe`, args: [] }, spelling)
  }
  // The provisioned pin arrives absolute and is never re-resolved (it is not on PATH at all).
  const pin = "C:\\Users\\op\\AppData\\Local\\frizz\\runtimes\\codex\\0.165.0\\vendor\\x86_64-pc-windows-msvc\\bin\\codex.exe"
  assert.deepEqual(windowsResolve({}, { bin: pin }), { file: pin, args: [] })
})

test("codex resolver, posix: the first executable on PATH, an absolute or relative path as given, else ENOENT", () => {
  const resolve = (bin: string | undefined, files: Record<string, true>, env: NodeJS.ProcessEnv = { PATH: "/usr/local/bin:/home/op/.local/bin" }) =>
    resolveCodexExecutable(bin, { platform: "linux", env, access: (path, mode) => mode === "executable" && path in files })
  assert.deepEqual(resolve(undefined, { "/home/op/.local/bin/codex": true }), { file: "/home/op/.local/bin/codex", args: [] })
  assert.deepEqual(resolve(undefined, { "/usr/local/bin/codex": true, "/home/op/.local/bin/codex": true }), { file: "/usr/local/bin/codex", args: [] })
  assert.deepEqual(resolve("/opt/codex/bin/codex", {}), { file: "/opt/codex/bin/codex", args: [] })
  assert.deepEqual(resolve("./codex", {}), { file: "./codex", args: [] })
  let miss: unknown
  try { resolve(undefined, {}) } catch (err) { miss = err }
  assert.ok(miss instanceof CodexExecutableNotFoundError)
  assert.equal(miss.code, "ENOENT", "a miss must classify as the positive ENOENT a bare spawn would have raised")
  assert.throws(() => resolve(undefined, { "/usr/local/bin/codex": true }, {}), /could not resolve 'codex'/, "no PATH at all is a miss, not a crash")
})
