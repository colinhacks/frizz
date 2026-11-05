import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resetFrizzRoots } from "./frizz-paths.ts"
import {
  clearGithubCredential,
  frizzGhConfigDir,
  frizzGhEnv,
  frizzGithubWorkerEnv,
  frizzWorkerGhConfigDir,
  frizzGithubToken,
  githubCredentialPath,
  githubCredentialStatus,
  githubSignInState,
  readGithubCredential,
  rejectFrizzGithubToken,
  resetGithubCredentialMemo,
  startGithubSignIn,
  syncWorkerGhConfig,
  WORKER_GH_READ_ONLY_MARKER,
  writeGithubCredential,
  type StoredGithubCredential,
} from "./github-credential.ts"

const HOUR = 3600_000

async function withHome<T>(run: () => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "frizz-gh-cred-"))
  const saved = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME, FRIZZ_GITHUB_TOKEN: process.env.FRIZZ_GITHUB_TOKEN }
  process.env.HOME = home
  process.env.XDG_DATA_HOME = join(home, "data")
  delete process.env.FRIZZ_GITHUB_TOKEN
  resetFrizzRoots()
  resetGithubCredentialMemo()
  try {
    return await run()
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    resetFrizzRoots()
    resetGithubCredentialMemo()
    rmSync(home, { recursive: true, force: true })
  }
}

function app(overrides: Partial<Extract<StoredGithubCredential, { kind: "app" }>> = {}): StoredGithubCredential {
  return {
    kind: "app",
    clientId: "Iv23client",
    accessToken: "ghu_old",
    accessExpiresAt: 1_000 * HOUR,
    refreshToken: "ghr_old",
    refreshExpiresAt: Date.now() + 180 * 24 * HOUR,
    login: "colinhacks",
    savedAt: 0,
    ...overrides,
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

test("signed out: the token call throws a gh-auth failure naming Frizz's Settings, not `gh auth login`", async () => {
  await withHome(async () => {
    await assert.rejects(frizzGithubToken(), (error: Error & { githubFailureKind?: string }) => {
      assert.equal(error.githubFailureKind, "gh-auth")
      assert.match(error.message, /Settings/)
      assert.doesNotMatch(error.message, /gh auth login/)
      return true
    })
    assert.deepEqual(githubCredentialStatus(), { signedIn: false, login: null })
  })
})

test("the stored file is private: 0600 inside a 0700 folder", async () => {
  await withHome(async () => {
    writeGithubCredential(app())
    assert.equal(statSync(githubCredentialPath()).mode & 0o777, 0o600)
    assert.equal(statSync(join(githubCredentialPath(), "..")).mode & 0o777, 0o700)
  })
})

test("a fresh App token is used as is, with no request", async () => {
  await withHome(async () => {
    writeGithubCredential(app())
    const token = await frizzGithubToken({ now: () => 0, request: async () => { throw new Error("no request expected") } })
    assert.equal(token, "ghu_old")
  })
})

test("an App token near expiry is renewed with the client id alone — no secret — and written back", async () => {
  await withHome(async () => {
    writeGithubCredential(app({ accessExpiresAt: 5 * 60_000 }))
    const forms: URLSearchParams[] = []
    const request = async (_url: string | URL | Request, init?: RequestInit) => {
      forms.push(new URLSearchParams(String(init?.body)))
      return json({ access_token: "ghu_new", expires_in: 28800, refresh_token: "ghr_new", refresh_token_expires_in: 15897600 })
    }
    // Two callers at once share ONE refresh: the refresh token is single-use.
    const [a, b] = await Promise.all([frizzGithubToken({ now: () => 0, request }), frizzGithubToken({ now: () => 0, request })])
    assert.equal(a, "ghu_new")
    assert.equal(b, "ghu_new")
    assert.equal(forms.length, 1)
    assert.equal(forms[0].get("grant_type"), "refresh_token")
    assert.equal(forms[0].get("client_id"), "Iv23client")
    assert.equal(forms[0].get("refresh_token"), "ghr_old")
    assert.equal(forms[0].has("client_secret"), false)
    resetGithubCredentialMemo()
    const stored = readGithubCredential()
    assert.equal(stored?.kind, "app")
    if (stored?.kind === "app") {
      assert.equal(stored.accessToken, "ghu_new")
      assert.equal(stored.refreshToken, "ghr_new")
      assert.equal(stored.accessExpiresAt, 8 * HOUR)
    }
  })
})

test("a refused renewal marks the sign-in broken (a copied refresh token shows up), and does not retry", async () => {
  await withHome(async () => {
    writeGithubCredential(app({ accessExpiresAt: 0 }))
    let calls = 0
    const request = async () => {
      calls++
      return json({ error: "bad_refresh_token", error_description: "The refresh token passed is incorrect or expired." })
    }
    await assert.rejects(frizzGithubToken({ now: () => 0, request }), /could not be renewed/)
    const status = githubCredentialStatus()
    assert.equal(status.signedIn, false)
    assert.match(status.problem ?? "", /refused to renew/)
    await assert.rejects(frizzGithubToken({ now: () => 0, request }), /stopped working/)
    assert.equal(calls, 1)
  })
})

test("a network failure during renewal keeps the sign-in: the next call tries again", async () => {
  await withHome(async () => {
    writeGithubCredential(app({ accessExpiresAt: 0 }))
    await assert.rejects(frizzGithubToken({ now: () => 0, request: async () => { throw new TypeError("fetch failed") } }), /Could not refresh/)
    assert.equal(githubCredentialStatus().signedIn, true)
  })
})

test("another process sharing the folder renewed first: its token is adopted, not refreshed again", async () => {
  await withHome(async () => {
    writeGithubCredential(app({ accessExpiresAt: 0 }))
    // Load the old copy into memory, then let "the other process" rewrite the file underneath.
    assert.equal(githubCredentialStatus().signedIn, true)
    const theirs = JSON.stringify(app({ accessToken: "ghu_theirs", refreshToken: "ghr_theirs", accessExpiresAt: 8 * HOUR }))
    writeFileSync(githubCredentialPath(), theirs, { mode: 0o600 })
    const token = await frizzGithubToken({ now: () => 0, request: async () => { throw new Error("no refresh expected") } })
    assert.equal(token, "ghu_theirs")
  })
})

test("a 401 on an App token forces the next call to renew", async () => {
  await withHome(async () => {
    writeGithubCredential(app())
    rejectFrizzGithubToken("ghu_old")
    const token = await frizzGithubToken({ now: () => 0, request: async () => json({ access_token: "ghu_new", expires_in: 28800, refresh_token: "ghr_new" }) })
    assert.equal(token, "ghu_new")
  })
})

test("a 401 on a pasted token reports the sign-in broken", async () => {
  await withHome(async () => {
    writeGithubCredential({ kind: "token", token: "github_pat_x", login: "colinhacks", savedAt: 0 })
    rejectFrizzGithubToken("github_pat_x")
    assert.equal(githubCredentialStatus().signedIn, false)
  })
})

test("FRIZZ_GITHUB_TOKEN wins over the stored credential", async () => {
  await withHome(async () => {
    writeGithubCredential(app())
    process.env.FRIZZ_GITHUB_TOKEN = "github_pat_env"
    assert.equal(await frizzGithubToken(), "github_pat_env")
    assert.equal(githubCredentialStatus().source, "env")
  })
})

test("device-flow sign-in: shows the code, polls past authorization_pending, stores the App credential", async () => {
  await withHome(async () => {
    let polls = 0
    const request = async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname
      if (path === "/login/device/code") {
        assert.equal(new URLSearchParams(String(init?.body)).get("client_id"), "Iv23client")
        return json({ device_code: "dev", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 5 })
      }
      if (path === "/login/oauth/access_token") {
        const form = new URLSearchParams(String(init?.body))
        assert.equal(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:device_code")
        assert.equal(form.has("client_secret"), false)
        if (++polls < 3) return json({ error: "authorization_pending" })
        return json({ access_token: "ghu_signed", expires_in: 28800, refresh_token: "ghr_signed", refresh_token_expires_in: 15897600 })
      }
      if (path === "/user") return json({ login: "colinhacks" })
      throw new Error(`unexpected ${path}`)
    }
    const prompt = await startGithubSignIn({ clientId: "Iv23client", request, sleep: async () => {} })
    assert.equal(prompt.userCode, "ABCD-1234")
    for (let i = 0; i < 50 && githubSignInState().phase === "pending"; i++) await new Promise((r) => setImmediate(r))
    assert.equal(githubSignInState().phase, "idle")
    const status = githubCredentialStatus()
    assert.deepEqual(status, { signedIn: true, source: "app", login: "colinhacks" })
    assert.equal(await frizzGithubToken(), "ghu_signed")
  })
})

test("frizzGhEnv: the operator's tokens are stripped, gh gets Frizz's token and an empty private config dir", async () => {
  await withHome(async () => {
    const base = { PATH: "/usr/bin", GH_TOKEN: "operator", GITHUB_TOKEN: "operator2", GH_HOST: "example.com", GH_CONFIG_DIR: "/Users/x/.config/gh" }
    const env = frizzGhEnv("ghu_frizz", base)
    assert.equal(env.GH_TOKEN, "ghu_frizz")
    assert.equal(env.GITHUB_TOKEN, undefined)
    assert.equal(env.GH_HOST, undefined)
    assert.equal(env.GH_CONFIG_DIR, frizzGhConfigDir())
    const signedOut = frizzGhEnv(null, base)
    assert.equal(signedOut.GH_TOKEN, undefined)
    assert.equal(signedOut.GH_CONFIG_DIR, frizzGhConfigDir())
  })
})

function withKeywardOnPath<T>(run: (env: NodeJS.ProcessEnv) => T): T {
  const bin = mkdtempSync(join(tmpdir(), "frizz-keyward-bin-"))
  try {
    writeFileSync(join(bin, "keyward"), "#!/bin/sh\nexit 1\n", { mode: 0o755 })
    return run({ PATH: bin })
  } finally {
    rmSync(bin, { recursive: true, force: true })
  }
}

test("a worker's gh folder holds the token privately, is rewritten on renewal, and empties on sign-out", async () => {
  await withHome(async () => {
    writeGithubCredential(app({ accessExpiresAt: 0 }))
    const hosts = join(frizzWorkerGhConfigDir(), "hosts.yml")
    assert.match(readFileSync(hosts, "utf8"), /oauth_token: "ghu_old"/)
    assert.match(readFileSync(hosts, "utf8"), /user: "colinhacks"/)
    assert.equal(statSync(hosts).mode & 0o777, 0o600)
    assert.equal(statSync(frizzWorkerGhConfigDir()).mode & 0o777, 0o700)
    assert.equal(existsSync(join(frizzWorkerGhConfigDir(), WORKER_GH_READ_ONLY_MARKER)), true)
    await frizzGithubToken({ now: () => 0, request: async () => json({ access_token: "ghu_new", expires_in: 28800, refresh_token: "ghr_new" }) })
    assert.match(readFileSync(hosts, "utf8"), /oauth_token: "ghu_new"/)
    assert.doesNotMatch(readFileSync(hosts, "utf8"), /ghu_old/)
    clearGithubCredential()
    assert.equal(existsSync(hosts), false)
  })
})

test("a refused renewal takes the dead token out of the worker's folder", async () => {
  await withHome(async () => {
    writeGithubCredential(app({ accessExpiresAt: 0 }))
    await assert.rejects(frizzGithubToken({ now: () => 0, request: async () => json({ error: "bad_refresh_token" }) }))
    syncWorkerGhConfig()
    assert.equal(existsSync(join(frizzWorkerGhConfigDir(), "hosts.yml")), false)
  })
})

test("a worker's GH_CONFIG_DIR moves only when Frizz is signed in AND Keyward can take the writes", async () => {
  await withHome(async () => {
    // Without Keyward a worker's `gh` stays its operator's own, which may be able to write.
    writeGithubCredential(app())
    assert.deepEqual(frizzGithubWorkerEnv({ PATH: "/nonexistent" }), {})
    withKeywardOnPath((env) => {
      assert.deepEqual(frizzGithubWorkerEnv(env), { GH_CONFIG_DIR: frizzWorkerGhConfigDir() })
      clearGithubCredential()
      assert.deepEqual(frizzGithubWorkerEnv(env), {})
    })
  })
})
