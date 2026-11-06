import assert from "node:assert/strict"
import { test } from "node:test"
import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

// The session-seed hook's gh gate has three tiers (2026-11-04, cc-worker/DECISIONS.md): a GH_CONFIG_DIR
// Frizz marked read-only gets the read-only block, with writes through Keyward; otherwise a plain `gh`
// that is signed in gets the plain block; otherwise a `keyward` on PATH gets the Keyward block, which
// routes every gh command through `keyward --reason "…" -- gh …`; none gets nothing. These run the
// real hook as Claude Code does, on a PATH and gh config built per case, so the answer never depends
// on whether the machine running the suite is signed in.

const here = dirname(fileURLToPath(import.meta.url))
const HOOK = join(here, "../../../cc-worker/hooks/session-seed.mjs")

// Every variable gh reads a token from. Any one of them signs plain gh in whatever its config says.
const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"]

interface Case {
  /** A stub `gh` that answers `auth status` with exit 0 (signed in) or 1 (signed out). */
  gh?: "signed-in" | "signed-out"
  /** A stub `keyward` on PATH: executable, or present but not executable. */
  keyward?: "executable" | "not-executable"
  /** The GH_CONFIG_DIR carries Frizz's read-only marker, as a worker's does (frizzGithubWorkerEnv). */
  frizzReadOnly?: boolean
}

function runSeed(c: Case) {
  const root = mkdtempSync(join(tmpdir(), "session-seed-gh-"))
  try {
    const bin = join(root, "bin")
    const project = join(root, "project")
    const ghConfig = join(root, "gh-config")
    for (const d of [bin, project, ghConfig]) mkdirSync(d)
    if (c.frizzReadOnly) writeFileSync(join(ghConfig, "frizz-read-only"), "")
    const keywardRan = join(root, "keyward-ran")
    if (c.gh) {
      writeFileSync(join(bin, "gh"), `#!/bin/sh\nexit ${c.gh === "signed-in" ? 0 : 1}\n`)
      chmodSync(join(bin, "gh"), 0o755)
    }
    if (c.keyward) {
      // The hook must find it WITHOUT running it: a real release raises a Touch ID sheet.
      writeFileSync(join(bin, "keyward"), `#!/bin/sh\ntouch '${keywardRan}'\nexit 1\n`)
      chmodSync(join(bin, "keyward"), c.keyward === "executable" ? 0o755 : 0o644)
    }
    // The inherited PATH minus any directory holding a real keyward, so the "neither" case is honest
    // on a machine that has one. A real gh can stay: the empty GH_CONFIG_DIR keeps it signed out.
    const inherited = (process.env.PATH ?? "").split(delimiter).filter((d) => d && !existsSync(join(d, "keyward")))
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: [bin, ...inherited].join(delimiter),
      HOME: root,
      GH_CONFIG_DIR: ghConfig,
      FRIZZ_THREAD: "gh-gate",
      CLAUDE_PROJECT_DIR: project,
    }
    for (const v of TOKEN_VARS) delete env[v]
    const out = execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify({ session_id: "gh-gate-session", source: "startup" }),
      encoding: "utf8",
      env,
      cwd: project,
    })
    const context: string = JSON.parse(out).hookSpecificOutput.additionalContext
    return { context, keywardRan: existsSync(keywardRan) }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("a signed-in plain gh gets the plain block, never the Keyward one", () => {
  const { context } = runSeed({ gh: "signed-in" })
  assert.match(context, /⟦gh available⟧ You are signed into the `gh` CLI/)
  assert.doesNotMatch(context, /keyward/i)
  assert.match(context, /READ-ONLY BOUNDARY/)
  assert.match(context, /frizzctl watch-pr add/)
  assert.match(context, /`frizz:gh` skill/)
})

test("a signed-in plain gh wins over a keyward on PATH", () => {
  const { context, keywardRan } = runSeed({ gh: "signed-in", keyward: "executable" })
  assert.match(context, /⟦gh available⟧/)
  assert.doesNotMatch(context, /⟦gh available through Keyward⟧/)
  assert.equal(keywardRan, false)
})

test("signed-out gh with keyward on PATH gets the Keyward block, and keyward is never run", () => {
  // The real gh if this machine has one, against an empty config: signed out exactly as after
  // `gh auth logout`. No stub, so the gate is checked against gh's own answer.
  const { context, keywardRan } = runSeed({ keyward: "executable" })
  assert.equal(keywardRan, false, "finding keyward must not execute it")
  assert.match(context, /⟦gh available through Keyward⟧/)
  assert.doesNotMatch(context, /⟦gh available⟧/)
  assert.match(context, /`keyward --reason "<what this command is for>" -- gh …`/)
  assert.match(context, /10 minutes/)
  assert.match(context, /BATCH/)
  assert.match(context, /`keyward: not released:`.*STOP and report it to the human; NEVER retry/)
  assert.match(context, /frizzctl watch-pr add` \/ `frizzctl watch-issue add`/)
  assert.match(context, /READ-ONLY BOUNDARY/)
  assert.match(context, /`frizz:gh` skill/)
})

test("signed-out gh with a stub gh and keyward also gets the Keyward block", () => {
  const { context } = runSeed({ gh: "signed-out", keyward: "executable" })
  assert.match(context, /⟦gh available through Keyward⟧/)
})

test("signed-out gh and no keyward inject no gh guidance at all", () => {
  for (const c of [{}, { gh: "signed-out" }] as Case[]) {
    const { context } = runSeed(c)
    assert.match(context, /⟦frizz worker contract⟧/, "the rest of the seed is unaffected")
    assert.doesNotMatch(context, /⟦gh available/)
  }
})

test("a keyward file that is not executable does not count", { skip: process.platform === "win32" }, () => {
  const { context } = runSeed({ gh: "signed-out", keyward: "not-executable" })
  assert.doesNotMatch(context, /⟦gh available/)
})

test("Frizz's read-only config gets the read-only block: plain gh reads, a write reruns through keyward", () => {
  // Signed in or not, this tier asks nothing of gh: it is decided from the marker alone, with no network.
  const { context, keywardRan } = runSeed({ gh: "signed-out", keyward: "executable", frizzReadOnly: true })
  assert.equal(keywardRan, false, "finding keyward must not execute it")
  assert.match(context, /⟦gh available, read-only⟧/)
  assert.doesNotMatch(context, /⟦gh available⟧/)
  assert.doesNotMatch(context, /⟦gh available through Keyward⟧/)
  assert.match(context, /READ freely: `gh issue view N/)
  assert.match(context, /Resource not accessible by integration/)
  assert.match(context, /`keyward --reason "<what this command is for>" -- gh …`/)
  assert.match(context, /`keyward: not released:`.*STOP and report it to the human; NEVER retry/)
  assert.match(context, /READ-ONLY BOUNDARY/)
  assert.match(context, /frizzctl watch-pr add/)
})

test("the read-only marker wins over a signed-in gh, whose answer it never asks for", () => {
  const { context } = runSeed({ gh: "signed-in", frizzReadOnly: true })
  assert.match(context, /⟦gh available, read-only⟧/)
})

test("Frizz's read-only config with no keyward teaches the reads and never names a command that isn't there", () => {
  const { context } = runSeed({ frizzReadOnly: true })
  assert.match(context, /⟦gh available, read-only⟧/)
  assert.match(context, /READ freely: `gh issue view N/)
  assert.match(context, /--log-failed/)
  assert.match(context, /Resource not accessible by integration/)
  assert.match(context, /hand the write to the human as steps/)
  assert.doesNotMatch(context, /keyward/i)
  assert.doesNotMatch(context, /Touch ID/)
  assert.match(context, /READ-ONLY BOUNDARY/)
})
