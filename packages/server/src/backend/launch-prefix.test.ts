import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hasLaunchPrefix, launchPrefixArgv, launchPrefixAwareAuth, launchPrefixSettingsError, recordedLaunchPrefix } from "./launch-prefix.ts"

const posix = process.platform === "win32" ? "command lookup answers yes on Windows" : false

function sandbox(): { dir: string; bin: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "frizz-launch-prefix-"))
  const bin = join(dir, "bin")
  mkdirSync(bin)
  const tool = join(bin, "inject")
  writeFileSync(tool, "#!/bin/sh\nexec \"$@\"\n")
  chmodSync(tool, 0o755)
  writeFileSync(join(dir, "not-executable"), "")
  return { dir, bin, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test("no prefix, or a blank one, is no prefix — for every runtime, and never for an ACP agent", () => {
  assert.deepEqual(launchPrefixArgv(undefined, "claude"), [])
  assert.deepEqual(launchPrefixArgv({ launchPrefix: { claude: "   " } }, "claude"), [])
  assert.deepEqual(launchPrefixArgv({ launchPrefix: { claude: "env" } }, "codex"), [])
  assert.equal(hasLaunchPrefix({ launchPrefix: { claude: " env A=1 " } }, "claude"), true)
  assert.equal(hasLaunchPrefix({ launchPrefix: { claude: " " } }, "claude"), false)
  assert.equal(hasLaunchPrefix({ launchPrefix: { claude: "env" } }, "codex"), false)
  assert.equal(hasLaunchPrefix({ launchPrefix: { claude: "env" } }, "acp"), false)
})

test("a prefix resolves to its words, with ~/ and a bare command found the way spawn will find them", { skip: posix }, () => {
  const box = sandbox()
  try {
    const env = { PATH: box.bin }
    assert.deepEqual(launchPrefixArgv({ launchPrefix: { claude: "inject --flag 'two words' --" } }, "claude", { env }), ["inject", "--flag", "two words", "--"])
    assert.deepEqual(launchPrefixArgv({ launchPrefix: { codex: "~/bin/inject --" } }, "codex", { home: box.dir, env: {} }), [join(box.bin, "inject"), "--"])
    assert.deepEqual(launchPrefixArgv({ launchPrefix: { claude: "./bin/inject" } }, "claude", { cwd: box.dir, env: {} }), ["./bin/inject"])
  } finally {
    box.done()
  }
})

test("a prefix that cannot be used throws a sentence naming the runtime and the reason", { skip: posix }, () => {
  const box = sandbox()
  try {
    assert.throws(() => launchPrefixArgv({ launchPrefix: { claude: "sh -c 'exec" } }, "claude"), /^Error: The Claude Code launch prefix in this project's settings cannot be used: A single quote is never closed\.$/)
    assert.throws(() => launchPrefixArgv({ launchPrefix: { codex: "frizz-no-such-tool --" } }, "codex", { env: { PATH: box.bin } }), /The Codex launch prefix in this project's settings starts `frizz-no-such-tool`, which was not found on PATH\./)
    assert.throws(() => launchPrefixArgv({ launchPrefix: { claude: "./not-executable" } }, "claude", { cwd: box.dir }), /starts `\.\/not-executable`, which is not an executable file\./)
    assert.throws(() => launchPrefixArgv({ launchPrefix: { claude: box.bin } }, "claude"), /which is not an executable file/, "a directory is not a command")
  } finally {
    box.done()
  }
})

test("the settings save names the first prefix that does not parse, and only that", () => {
  assert.equal(launchPrefixSettingsError({ launchPrefix: { claude: "op run --", codex: "" } }), undefined)
  assert.match(launchPrefixSettingsError({ launchPrefix: { codex: "a | b" } }) ?? "", /^Codex launch prefix: `\|` is shell syntax/)
  // Only a CHANGED prefix is judged, so a stored one that no longer parses cannot block other saves.
  assert.equal(launchPrefixSettingsError({ launchPrefix: { codex: "a | b" } }, { launchPrefix: { codex: "a | b" } }), undefined)
  assert.match(launchPrefixSettingsError({ launchPrefix: { codex: "a | c" } }, { launchPrefix: { codex: "a | b" } }) ?? "", /shell syntax/)
  // A command that is not installed is not a save error: the field is for the machine that RUNS it.
  assert.equal(launchPrefixSettingsError({ launchPrefix: { claude: "frizz-no-such-tool --" } }), undefined)
})

test("a process record's launchPrefix is read only when it is a list of words", () => {
  assert.deepEqual(recordedLaunchPrefix(["op", "run", "--"]), { launchPrefix: ["op", "run", "--"] })
  assert.deepEqual(recordedLaunchPrefix([]), {})
  assert.deepEqual(recordedLaunchPrefix("op run --"), {})
  assert.deepEqual(recordedLaunchPrefix(["op", 7]), {})
  assert.deepEqual(recordedLaunchPrefix(undefined), {})
})

test("the sign-in gate stands down for a runtime with a prefix, and only for that runtime", async () => {
  let reads = 0
  const signedOut = async () => { reads++; return "signed-out" as const }
  const settings = { launchPrefix: { claude: "op run --" } }
  assert.equal(await launchPrefixAwareAuth(settings, "claude", signedOut), "unknown", "the prefix may supply the credentials")
  assert.equal(reads, 0, "…so the local credential is not even read")
  assert.equal(await launchPrefixAwareAuth(settings, "codex", signedOut), "signed-out", "Codex has no prefix here, so it is gated as before")
  assert.equal(await launchPrefixAwareAuth(undefined, "claude", signedOut), "signed-out")
  assert.equal(await launchPrefixAwareAuth({ launchPrefix: { claude: "  " } }, "claude", signedOut), "signed-out", "a blank prefix is no prefix")
})
