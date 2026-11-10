import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { CodexExecutableNotFoundError } from "./codex-executable.ts"
import { deferRuntime, ensureRuntime, resetDeferredRuntimes } from "../runtime-deferral.ts"
import { parseClaudeAuthStatusJson, readAuthSnapshot, readClaudeAccountEmail, readClaudeAuthState, readClaudeOtherCredential, readClaudeAuthStatusCli, readClaudePreflightAuth, readCodexAccountEmail, readCodexAccountId, readCodexAuthState, readCodexBinaryState, resetClaudeCliConfirm } from "./auth-status.ts"

// Codex reads env keys BEFORE the file, so a file-based test must run with those keys cleared or an
// ambient OPENAI_API_KEY in the dev shell would mask the file logic. Clears + restores around fn.
const CODEX_ENV_KEYS = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]
function withTmp(fn: (dir: string) => void): void {
  const saved = CODEX_ENV_KEYS.map((k) => [k, process.env[k]] as const)
  for (const k of CODEX_ENV_KEYS) delete process.env[k]
  const dir = mkdtempSync(join(tmpdir(), "frizz-auth-"))
  try {
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    for (const [k, v] of saved) if (v === undefined) delete process.env[k]; else process.env[k] = v
  }
}

// ---- Codex: fully file-based ($CODEX_HOME/auth.json), deterministic on every platform ----

test("codex: OAuth token present → authed", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: "tok", refresh_token: "r", account_id: "a" } }))
    assert.equal(readCodexAuthState(dir), "authed")
  })
})

test("codex: API key present → authed", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-live", tokens: null }))
    assert.equal(readCodexAuthState(dir), "authed")
  })
})

test("codex: no auth.json → signed-out", () => {
  withTmp((dir) => {
    assert.equal(readCodexAuthState(dir), "signed-out")
  })
})

test("codex: auth.json present but empty of credentials → signed-out", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { access_token: "" } }))
    assert.equal(readCodexAuthState(dir), "signed-out")
  })
})

test("codex: unparseable auth.json → unknown (fail open, never signed-out)", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "auth.json"), "{ not valid json")
    assert.equal(readCodexAuthState(dir), "unknown")
  })
})

test("codex: env key present with no auth.json → authed (frizz forwards OPENAI_API_KEY et al.)", () => {
  withTmp((dir) => {
    process.env.OPENAI_API_KEY = "sk-env"
    // No auth.json in dir — env auth must still read as authed, not signed-out.
    assert.equal(readCodexAuthState(dir), "authed")
  })
})

test("codex: account id reads only the non-secret ChatGPT identity", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({
      auth_mode: "chatgpt",
      tokens: { access_token: "secret", refresh_token: "also-secret", account_id: "account-one" },
    }))
    assert.equal(readCodexAccountId(dir), "account-one")
  })
})

test("codex: account id is absent for malformed, tokenless, and API-key auth", () => {
  withTmp((dir) => {
    assert.equal(readCodexAccountId(dir), undefined)
    writeFileSync(join(dir, "auth.json"), "{not json")
    assert.equal(readCodexAccountId(dir), undefined)
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "secret" } }))
    assert.equal(readCodexAccountId(dir), undefined)
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ OPENAI_API_KEY: "sk-file", tokens: null }))
    assert.equal(readCodexAccountId(dir), undefined)
  })
})

test("codex: environment auth suppresses an unrelated auth.json account id", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { account_id: "account-one" } }))
    process.env.OPENAI_API_KEY = "sk-env"
    assert.equal(readCodexAccountId(dir), undefined)
  })
})

// ---- Claude: file source is deterministic; the macOS Keychain fallback is disabled here so the
// signed-out path is reproducible off a real machine's Keychain. ----

test("claude: credentials file with token → authed", async () => {
  await withTmpAsync(async (dir) => {
    writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }))
    assert.equal(await readClaudeAuthState(dir), "authed")
  })
})

test("claude: no file + Keychain disabled → signed-out", async () => {
  const prev = process.env.FRIZZ_KEYCHAIN_DISABLED
  process.env.FRIZZ_KEYCHAIN_DISABLED = "1"
  try {
    await withTmpAsync(async (dir) => {
      assert.equal(await readClaudeAuthState(dir), "signed-out")
    })
  } finally {
    if (prev === undefined) delete process.env.FRIZZ_KEYCHAIN_DISABLED
    else process.env.FRIZZ_KEYCHAIN_DISABLED = prev
  }
})

test("claude: file present but tokenless + Keychain disabled → signed-out", async () => {
  const prev = process.env.FRIZZ_KEYCHAIN_DISABLED
  process.env.FRIZZ_KEYCHAIN_DISABLED = "1"
  try {
    await withTmpAsync(async (dir) => {
      writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: {} }))
      assert.equal(await readClaudeAuthState(dir), "signed-out")
    })
  } finally {
    if (prev === undefined) delete process.env.FRIZZ_KEYCHAIN_DISABLED
    else process.env.FRIZZ_KEYCHAIN_DISABLED = prev
  }
})

async function withTmpAsync(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "frizz-auth-"))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- Claude CLI preflight (`claude auth status --json`) — stubbed executable, no real CLI ----

// EVERY case that spawns the stub is POSIX-only, and there is no portable substitute: the stub is a
// `#!/bin/sh` script, a shebang means nothing on Windows, and Node has refused to spawn a `.bat`/`.cmd`
// without `shell: true` since the CVE-2024-27980 fix — so `execFile`ing a fake `claude` there cannot
// run at all and every verdict collapses to the fail-open "unknown". Two of these cases EXPECT
// "unknown", so on Windows they passed while proving nothing; skipping is the honest reading. What the
// classifier does with the output is pinned separately by parseClaudeAuthStatusJson, which is pure and
// runs everywhere, and the missing-binary case below spawns for real on every platform.
const posixOnlyStub = { skip: process.platform === "win32" ? "the CLI stub is a POSIX shell script" : false }

function withStub(script: string, fn: (bin: string) => Promise<void>): Promise<void> {
  return withTmpAsync(async (dir) => {
    const bin = join(dir, "claude-stub")
    writeFileSync(bin, `#!/bin/sh\n${script}\n`, { mode: 0o755 })
    await fn(bin)
  })
}

test("auth-status CLI: exit 0 with loggedIn true → authed", posixOnlyStub, () =>
  withStub(`echo '{"loggedIn": true, "authMethod": "oauth"}'`, async (bin) => {
    assert.equal(await readClaudeAuthStatusCli({ claudeBin: bin }), "authed")
  }))

test("auth-status CLI: exit 0 with unparseable output → authed (exit code is the login signal)", posixOnlyStub, () =>
  withStub(`echo 'Logged in as someone'`, async (bin) => {
    assert.equal(await readClaudeAuthStatusCli({ claudeBin: bin }), "authed")
  }))

test("auth-status CLI: nonzero exit with positive loggedIn false → signed-out", posixOnlyStub, () =>
  withStub(`echo '{"loggedIn": false}'; exit 1`, async (bin) => {
    assert.equal(await readClaudeAuthStatusCli({ claudeBin: bin }), "signed-out")
  }))

test("auth-status CLI: loggedIn false printed amid human noise → signed-out", posixOnlyStub, () =>
  withStub(`echo 'Not logged in.'; echo '{"loggedIn": false}'; exit 1`, async (bin) => {
    assert.equal(await readClaudeAuthStatusCli({ claudeBin: bin }), "signed-out")
  }))

test("auth-status CLI: nonzero exit WITHOUT parseable loggedIn → unknown (fail open)", posixOnlyStub, () =>
  withStub(`echo 'config corrupted'; exit 1`, async (bin) => {
    assert.equal(await readClaudeAuthStatusCli({ claudeBin: bin }), "unknown")
  }))

test("auth-status CLI: missing binary → unknown (fail open)", async () => {
  assert.equal(await readClaudeAuthStatusCli({ claudeBin: "/nonexistent/claude-definitely-absent" }), "unknown")
})

test("auth-status CLI: hang beyond the timeout → unknown (fail open)", posixOnlyStub, () =>
  withStub(`sleep 30`, async (bin) => {
    assert.equal(await readClaudeAuthStatusCli({ claudeBin: bin, timeoutMs: 200 }), "unknown")
  }))

test("parseClaudeAuthStatusJson: strict positive-signal parsing", () => {
  assert.equal(parseClaudeAuthStatusJson(`{"loggedIn": false}`), false)
  assert.equal(parseClaudeAuthStatusJson(`{"loggedIn": true}`), true)
  assert.equal(parseClaudeAuthStatusJson(`{"loggedIn": "no"}`), undefined)
  assert.equal(parseClaudeAuthStatusJson(`not json`), undefined)
  assert.equal(parseClaudeAuthStatusJson(``), undefined)
  assert.equal(parseClaudeAuthStatusJson(`prefix {"loggedIn": false} suffix`), false)
})

// M2 (review): the two Claude detectors must not disagree into a dead-end — a positive local
// "signed-out" is confirmed against the CLI, and a CLI "authed" wins (credential stored somewhere
// the file/keychain reader doesn't cover).
test("readAuthSnapshot: CLI overrides a local signed-out; local verdict stands when CLI agrees or is unknown", async () => {
  const savedConfig = process.env.CLAUDE_CONFIG_DIR
  const savedKeychain = process.env.FRIZZ_KEYCHAIN_DISABLED
  try {
    await withTmpAsync(async (dir) => {
      process.env.CLAUDE_CONFIG_DIR = dir // empty → local reader: signed-out
      process.env.FRIZZ_KEYCHAIN_DISABLED = "1"
      // The two stub arms only (see posixOnlyStub) — the CLI-unavailable arm below is the one that
      // needs no child process, and it is asserted on every platform.
      if (process.platform !== "win32") {
        await withStub(`echo '{"loggedIn": true}'`, async (bin) => {
          assert.equal((await readAuthSnapshot({ claudeBin: bin })).claude, "authed")
        })
        await withStub(`echo '{"loggedIn": false}'; exit 1`, async (bin) => {
          assert.equal((await readAuthSnapshot({ claudeBin: bin })).claude, "signed-out")
        })
      }
      // CLI unavailable → the positive local signed-out stands (never silently unknown).
      assert.equal((await readAuthSnapshot({ claudeBin: "/nonexistent/claude-absent" })).claude, "signed-out")
    })
  } finally {
    if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfig
    if (savedKeychain === undefined) delete process.env.FRIZZ_KEYCHAIN_DISABLED
    else process.env.FRIZZ_KEYCHAIN_DISABLED = savedKeychain
  }
})

// The snapshot is POLLED — every open tab, every window focus, every page load — and on a machine that
// is not signed in to Claude each call used to start the CLI. The stub counts its own starts, so the
// number here is a number of Claude Code processes.
test("readAuthSnapshot: a signed-out machine starts the Claude CLI once per window, not once per poll", posixOnlyStub, async () => {
  const savedConfig = process.env.CLAUDE_CONFIG_DIR
  const savedKeychain = process.env.FRIZZ_KEYCHAIN_DISABLED
  try {
    await withTmpAsync(async (dir) => {
      process.env.CLAUDE_CONFIG_DIR = dir // empty → local reader: signed-out
      process.env.FRIZZ_KEYCHAIN_DISABLED = "1"
      const log = join(dir, "starts.log")
      const starts = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).length : 0)
      await withStub(`echo start >> '${log}'; echo '{"loggedIn": false}'; exit 1`, async (bin) => {
        resetClaudeCliConfirm()
        const MIN = 60_000
        const poll = async (at: number, fresh = false) =>
          (await readAuthSnapshot({ claudeBin: bin, now: () => at, ...(fresh ? { fresh } : {}) })).claude
        // A page load mounts two readers at once; the chips then poll every 2m and on every focus.
        assert.deepEqual(await Promise.all([poll(0), poll(0)]), ["signed-out", "signed-out"])
        for (const at of [30_000, 2 * MIN, 4 * MIN, 15 * MIN - 1]) assert.equal(await poll(at), "signed-out")
        assert.equal(starts(), 1)
        assert.equal(await poll(15 * MIN), "signed-out")
        assert.equal(starts(), 2)

        // The sign-in dialog's "check again" is a person who may have just signed in: asked at once.
        assert.equal(await poll(16 * MIN, true), "signed-out")
        assert.equal(starts(), 3)
        assert.equal(await poll(30 * MIN), "signed-out")
        assert.equal(starts(), 3)

        // A credential the local reader can see is answered without the CLI — and forgets what it said,
        // so signing out again is confirmed afresh rather than from a verdict about another state.
        writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }))
        assert.equal(await poll(30 * MIN + 1), "authed")
        assert.equal(starts(), 3)
        rmSync(join(dir, ".credentials.json"))
        assert.equal(await poll(30 * MIN + 2), "signed-out")
        assert.equal(starts(), 4)
      })
    })
  } finally {
    resetClaudeCliConfirm()
    if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfig
    if (savedKeychain === undefined) delete process.env.FRIZZ_KEYCHAIN_DISABLED
    else process.env.FRIZZ_KEYCHAIN_DISABLED = savedKeychain
  }
})

// The dispatch preflight is the first thing dispatch() awaits, so what it shells out to is a latency
// question as much as a correctness one. These pin BOTH: the verdicts, and — via a stub that records
// whether it ran at all — that a signed-in user never pays for the CLI.
test("readClaudePreflightAuth: a local credential answers alone; the CLI is never spawned", async () => {
  const savedConfig = process.env.CLAUDE_CONFIG_DIR
  try {
    await withTmpAsync(async (dir) => {
      process.env.CLAUDE_CONFIG_DIR = dir
      writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }))
      // A stub that TOUCHES a marker file if it is ever executed. The absence of that file is the
      // whole point of this change: the CLI must not be on the signed-in path.
      const marker = join(dir, "cli-ran")
      await withStub(`touch ${marker}; echo '{"loggedIn": true}'`, async (bin) => {
        assert.equal(await readClaudePreflightAuth({ claudeBin: bin }), "authed")
        assert.equal(existsSync(marker), false, "the auth CLI must not run when a local credential exists")
      })
    })
  } finally {
    if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfig
  }
})

test("readClaudePreflightAuth: a positive local signed-out is confirmed against the CLI, which fails open on unknown", async () => {
  const savedConfig = process.env.CLAUDE_CONFIG_DIR
  const savedKeychain = process.env.FRIZZ_KEYCHAIN_DISABLED
  try {
    await withTmpAsync(async (dir) => {
      process.env.CLAUDE_CONFIG_DIR = dir // empty → local reader: signed-out
      process.env.FRIZZ_KEYCHAIN_DISABLED = "1"
      // The two stub arms only (see posixOnlyStub); the inconclusive-CLI arm below runs everywhere.
      if (process.platform !== "win32") {
        // A credential the file/keychain reader cannot see must not block a dispatch.
        await withStub(`echo '{"loggedIn": true}'`, async (bin) => {
          assert.equal(await readClaudePreflightAuth({ claudeBin: bin }), "authed")
        })
        // Genuinely signed out — this is the ONE verdict dispatch blocks on.
        await withStub(`echo '{"loggedIn": false}'; exit 1`, async (bin) => {
          assert.equal(await readClaudePreflightAuth({ claudeBin: bin }), "signed-out")
        })
      }
      // Preflight-specific: an inconclusive CLI stays "unknown" so dispatch fails OPEN. (readAuthSnapshot
      // deliberately differs here — a gate that cannot confirm should keep offering sign-in.)
      assert.equal(await readClaudePreflightAuth({ claudeBin: "/nonexistent/claude-absent" }), "unknown")
    })
  } finally {
    if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfig
    if (savedKeychain === undefined) delete process.env.FRIZZ_KEYCHAIN_DISABLED
    else process.env.FRIZZ_KEYCHAIN_DISABLED = savedKeychain
  }
})

test("readCodexBinaryState: present, ENOENT→missing, everything-else→unknown (fail open)", async () => {
  // The resolver is injected so this pins the CLASSIFICATION, not whether this machine has a codex.
  const found = () => ({ file: "/stub/codex", args: [] })
  // present: the exec resolves — and it is handed the RESOLVED argv, not the bare name.
  const seen: Array<[string, string[]]> = []
  const exec = (async (file: string, args: string[]) => { seen.push([file, args]); return { stdout: "codex-cli 0.144.6\n", stderr: "" } }) as never
  assert.equal(await readCodexBinaryState("codex", exec, found), "present")
  assert.deepEqual(seen, [["/stub/codex", ["--version"]]])
  // a resolver that hands back an argv prefix (the JS launcher under node) is spliced before --version.
  seen.length = 0
  assert.equal(await readCodexBinaryState("codex", exec, () => ({ file: "/usr/bin/node", args: ["/npm/codex.js"] })), "present")
  assert.deepEqual(seen, [["/usr/bin/node", ["/npm/codex.js", "--version"]]])
  // a positive ENOENT is the ONLY "missing" — from the spawn …
  const enoent = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" })
  assert.equal(await readCodexBinaryState("codex", (async () => { throw enoent }) as never, found), "missing")
  // … or from the resolver's own PATH walk, which is the same miss reported one step earlier
  // (Windows audit 2026-09-11, finding 8: on Windows the spawn's ENOENT was a lie for an installed CLI).
  assert.equal(await readCodexBinaryState("codex", exec, () => { throw new CodexExecutableNotFoundError("codex") }), "missing")
  // a broken-but-present binary (non-zero exit) is NOT missing — fail open.
  assert.equal(await readCodexBinaryState("codex", (async () => { throw Object.assign(new Error("exit 1"), { code: 1 }) }) as never, found), "unknown")
  // a timeout is NOT missing — fail open, never trap a working-but-slow environment.
  assert.equal(await readCodexBinaryState("codex", (async () => { throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) }) as never, found), "unknown")
})

// ---- Account emails (the quota popover's "signed in as who?") ----

// A JWT the way Codex stores one: three dot-separated base64url segments, of which only the payload is
// ever read. Signed with nothing — frizz does not verify it (see readCodexAccountEmail).
function idToken(payload: unknown): string {
  return `hdr.${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.sig`
}

test("codex account email: read from the id_token payload, absent for an API-key-only install", () => {
  withTmp((dir) => {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: idToken({ email: "someone@example.com" }) } }))
    assert.equal(readCodexAccountEmail(dir), "someone@example.com")
  })
  // API-key auth carries no id_token — a normal outcome, not a failure.
  withTmp((dir) => {
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "sk-live", tokens: null }))
    assert.equal(readCodexAccountEmail(dir), undefined)
  })
})

test("codex account email: every malformed shape degrades to undefined, never throws", () => {
  withTmp((dir) => {
    assert.equal(readCodexAccountEmail(dir), undefined) // no auth.json at all
    writeFileSync(join(dir, "auth.json"), "{ not json")
    assert.equal(readCodexAccountEmail(dir), undefined)
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: "nodots" } }))
    assert.equal(readCodexAccountEmail(dir), undefined)
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: "hdr.!!!not-base64!!!.sig" } }))
    assert.equal(readCodexAccountEmail(dir), undefined)
    // A payload that decodes but names no email, and one whose "email" isn't email-shaped: the label
    // is rendered verbatim in the UI, so a corrupt record must not smuggle arbitrary text into it.
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: idToken({ sub: "u_1" }) } }))
    assert.equal(readCodexAccountEmail(dir), undefined)
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: idToken({ email: "not an email" }) } }))
    assert.equal(readCodexAccountEmail(dir), undefined)
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: idToken({ email: `${"a".repeat(320)}@example.com` }) } }))
    assert.equal(readCodexAccountEmail(dir), undefined)
  })
})

test("claude account email: read from .claude.json's oauthAccount, memoized until the file changes", () => {
  withTmp((dir) => {
    const file = join(dir, ".claude.json")
    assert.equal(readClaudeAccountEmail(file), undefined) // absent
    writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: "colin@example.com" }, projects: {} }))
    assert.equal(readClaudeAccountEmail(file), "colin@example.com")
    // The memo is keyed on (path, mtime, size) — a rewrite with different content must be picked up,
    // not served from the previous parse.
    writeFileSync(file, JSON.stringify({ oauthAccount: { emailAddress: "someone-else@example.com" }, projects: { a: 1 } }))
    assert.equal(readClaudeAccountEmail(file), "someone-else@example.com")
    // Signed out of the account but the config file survives (Claude Code drops oauthAccount).
    writeFileSync(file, JSON.stringify({ projects: { a: 1, b: 2 } }))
    assert.equal(readClaudeAccountEmail(file), undefined)
    writeFileSync(file, "{ truncated")
    assert.equal(readClaudeAccountEmail(file), undefined)
  })
})

test("readAuthSnapshot: never labels a signed-out provider with a leftover email", async () => {
  const savedConfig = process.env.CLAUDE_CONFIG_DIR
  const savedKeychain = process.env.FRIZZ_KEYCHAIN_DISABLED
  const savedCodexHome = process.env.CODEX_HOME
  const savedCodexEnv = CODEX_ENV_KEYS.map((k) => [k, process.env[k]] as const)
  try {
    for (const k of CODEX_ENV_KEYS) delete process.env[k]
    await withTmpAsync(async (dir) => {
      // Both providers signed out, yet both account records still name an account — exactly the state
      // a `claude auth logout` leaves behind, since it clears the credential and not the config file.
      process.env.CLAUDE_CONFIG_DIR = dir
      process.env.FRIZZ_KEYCHAIN_DISABLED = "1"
      process.env.CODEX_HOME = dir
      writeFileSync(join(dir, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "stale@example.com" } }))
      writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { id_token: idToken({ email: "stale-codex@example.com" }) } }))
      const signedOut = await readAuthSnapshot({ claudeBin: "/nonexistent/claude-absent" })
      assert.equal(signedOut.claude, "signed-out")
      assert.deepEqual(signedOut.emails, {})

      // Same records, but with a live credential for each → both labels appear.
      writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "tok" } }))
      writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "tok", id_token: idToken({ email: "live-codex@example.com" }) } }))
      const authed = await readAuthSnapshot({ claudeBin: "/nonexistent/claude-absent" })
      assert.equal(authed.claude, "authed")
      assert.equal(authed.codex, "authed")
      assert.deepEqual(authed.emails, { claude: "stale@example.com", codex: "live-codex@example.com" })
    })
  } finally {
    for (const [k, v] of savedCodexEnv) if (v === undefined) delete process.env[k]; else process.env[k] = v
    if (savedConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = savedConfig
    if (savedKeychain === undefined) delete process.env.FRIZZ_KEYCHAIN_DISABLED
    else process.env.FRIZZ_KEYCHAIN_DISABLED = savedKeychain
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = savedCodexHome
  }
})

test("a Claude runtime waiting for its first thread is never started to confirm a signed-out", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-deferred-auth-"))
  const marker = join(dir, "ran")
  const bin = join(dir, "claude")
  writeFileSync(bin, `#!/bin/sh\ntouch "${marker}"\necho '{"loggedIn":true}'\n`, { mode: 0o755 })
  const saved = { config: process.env.CLAUDE_CONFIG_DIR, keychain: process.env.FRIZZ_KEYCHAIN_DISABLED }
  process.env.CLAUDE_CONFIG_DIR = dir
  process.env.FRIZZ_KEYCHAIN_DISABLED = "1"
  t.after(() => {
    resetDeferredRuntimes()
    resetClaudeCliConfirm()
    if (saved.config === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = saved.config
    if (saved.keychain === undefined) delete process.env.FRIZZ_KEYCHAIN_DISABLED; else process.env.FRIZZ_KEYCHAIN_DISABLED = saved.keychain
    rmSync(dir, { recursive: true, force: true })
  })
  resetClaudeCliConfirm()
  deferRuntime("claude", async () => {})
  assert.equal((await readAuthSnapshot({ claudeBin: bin, fresh: true })).claude, "signed-out")
  assert.equal(await readClaudePreflightAuth({ claudeBin: bin }), "signed-out", "a positive signed-out, so the gate opens instead of a download")
  assert.equal(existsSync(marker), false, "nothing ran the binary")
  // The negative control: the same machine once the runtime is down asks the CLI as it always has.
  await ensureRuntime("claude")
  assert.equal(await readClaudePreflightAuth({ claudeBin: bin }), "authed")
  assert.equal(existsSync(marker), true)
})

test("a Claude credential only Claude Code itself can see counts against deferring its download", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-claude-other-"))
  try {
    assert.equal(readClaudeOtherCredential({}, dir), false, "no settings file is the ordinary case")
    assert.equal(readClaudeOtherCredential({ ANTHROPIC_API_KEY: "x" }, dir), true)
    assert.equal(readClaudeOtherCredential({ CLAUDE_CODE_USE_BEDROCK: "1" }, dir), true)
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "dark" }))
    assert.equal(readClaudeOtherCredential({}, dir), false)
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ apiKeyHelper: "op read x" }))
    assert.equal(readClaudeOtherCredential({}, dir), true)
    // A Bedrock or Vertex setup usually lives in the settings' `env` block, which Claude Code applies to
    // itself at start: the same names as the real environment, and nothing else in the block.
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1" } }))
    assert.equal(readClaudeOtherCredential({}, dir), true)
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ env: { ANTHROPIC_API_KEY: "x" } }))
    assert.equal(readClaudeOtherCredential({}, dir), true)
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ env: { AWS_REGION: "us-east-1", ANTHROPIC_API_KEY: "" } }))
    assert.equal(readClaudeOtherCredential({}, dir), false)
    for (const odd of ["null", "[]", JSON.stringify({ env: "x" }), JSON.stringify({ env: null })]) {
      writeFileSync(join(dir, "settings.json"), odd)
      assert.equal(readClaudeOtherCredential({}, dir), false, odd)
    }
    writeFileSync(join(dir, "settings.json"), "{ not json")
    assert.equal(readClaudeOtherCredential({}, dir), true, "an unreadable answer provisions as today")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
