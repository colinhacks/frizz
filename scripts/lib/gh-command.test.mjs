import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ghCommand, ghNeedsKeyward, resetGhCommand } from "./gh-command.mjs"

const posixOnly = { skip: process.platform === "win32" ? "the stubs are POSIX shell scripts" : false }

function withBin(files, run) {
  const dir = mkdtempSync(join(tmpdir(), "gh-command-"))
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  resetGhCommand()
  try {
    return run({ PATH: `${dir}:/usr/bin:/bin` })
  } finally {
    resetGhCommand()
    rmSync(dir, { recursive: true, force: true })
  }
}

const signedIn = "exit 0"
const signedOut = "exit 1"

test("a signed-in plain gh is used as is, even with keyward installed", posixOnly, () => {
  withBin({ gh: signedIn, keyward: "exit 0" }, (env) => {
    assert.equal(ghNeedsKeyward(env), false)
    assert.deepEqual(ghCommand("why", ["api", "user"], env), ["gh", ["api", "user"]])
  })
})

test("a signed-out gh with keyward installed goes through keyward, gh first after --", posixOnly, () => {
  withBin({ gh: signedOut, keyward: "exit 0" }, (env) => {
    assert.deepEqual(ghCommand("tag the release", ["api", "user"], env), ["keyward", ["--reason", "tag the release", "--", "gh", "api", "user"]])
  })
})

test("a signed-out gh with no keyward stays plain, so gh's own error is what the reader sees", posixOnly, () => {
  withBin({ gh: signedOut }, (env) => {
    assert.deepEqual(ghCommand("why", ["api", "user"], env), ["gh", ["api", "user"]])
  })
})

test("a token in the environment (CI) never reaches for keyward", posixOnly, () => {
  withBin({ gh: signedOut, keyward: "exit 0" }, (env) => {
    assert.equal(ghNeedsKeyward({ ...env, GH_TOKEN: "t" }), false)
    assert.equal(ghNeedsKeyward({ ...env, GITHUB_TOKEN: "t" }), false)
  })
})
