import { test } from "node:test"
import assert from "node:assert/strict"
import { SIGN_IN_COMMAND, PROVIDER_LABEL, parseAccountAlias, runtimeDownloadNote } from "./signIn.ts"

// Lock the exact commands surfaced by the sign-in gate. These are real CLI invocations the user runs
// verbatim, verified against `claude auth --help` / `codex login --help` — a silent drift here would
// tell a signed-out user to run a command that doesn't exist.
test("sign-in commands are the verified provider login invocations", () => {
  assert.equal(SIGN_IN_COMMAND.claude, "claude auth login")
  assert.equal(SIGN_IN_COMMAND.codex, "codex login")
})

test("provider labels are human-facing names", () => {
  assert.equal(PROVIDER_LABEL.claude, "Claude")
  assert.equal(PROVIDER_LABEL.codex, "Codex")
})

// The alias boundary: ONLY the complete, exact spelling invokes an account action; everything else —
// arguments, other slash-words, mid-text mentions — remains an ordinary prompt frizz must not confiscate.
test("parseAccountAlias: exact complete input only", () => {
  assert.equal(parseAccountAlias("/login"), "login")
  assert.equal(parseAccountAlias("  /logout \n"), "logout")
  assert.equal(parseAccountAlias("/login please"), null)
  assert.equal(parseAccountAlias("/LOGIN"), null)
  assert.equal(parseAccountAlias("run /login for me"), null)
  assert.equal(parseAccountAlias("/loginx"), null)
  assert.equal(parseAccountAlias("/compact"), null)
  assert.equal(parseAccountAlias(""), null)
})

test("a runtime download reads as a toast, and only the download does", () => {
  assert.equal(runtimeDownloadNote("claude", "downloading 320 MB, 40%"), "Downloading Claude Code: 320 MB, 40%")
  assert.equal(runtimeDownloadNote("codex", "downloading 378 MB"), "Downloading Codex: 378 MB")
  assert.equal(runtimeDownloadNote("codex", "downloading, 12 MB so far"), "Downloading Codex: 12 MB so far")
  assert.equal(runtimeDownloadNote("claude", "downloading"), "Downloading Claude Code…")
  assert.equal(runtimeDownloadNote("claude", "resolving @anthropic-ai/x@1"), undefined)
  assert.equal(runtimeDownloadNote("claude", undefined), undefined)
})
