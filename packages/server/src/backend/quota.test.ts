import { test } from "node:test"
import assert from "node:assert/strict"
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { createHash } from "node:crypto"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseCodexQuotaFromRollout, parseCodexQuotaFromRateLimits, queryCodexRateLimits, readCodexQuota, resetCodexQuotaMemo } from "./codex-quota.ts"
import { parseClaudeUsage, parseClaudeUsageOutput, tokenFromCredentialsJson, readClaudeQuota, refreshClaudeQuotaInBackground, claudeQuotaRefreshSettled, withObservedClaudeQuota, resolveConfiguredRoute } from "./claude-quota.ts"
import { recordObservedClaudeQuota, resetObservedClaudeQuotaThrottle } from "./claude-quota-observed.ts"
import { frizzRoots, resetFrizzRoots } from "../frizz-paths.ts"
import { readQuota } from "../quota.ts"
import { deferRuntime, ensureRuntime, resetDeferredRuntimes } from "../runtime-deferral.ts"

// ---- Codex rollout parsing ----

test("codex: live event_msg-wrapped rate_limits (payload.rate_limits)", () => {
  const line = JSON.stringify({
    timestamp: "2026-07-15T10:00:00Z",
    type: "event_msg",
    payload: {
      type: "token_count",
      info: { total_token_usage: { total_tokens: 100 } },
      rate_limits: {
        limit_id: "codex",
        plan_type: "pro",
        primary: { used_percent: 12.5, window_minutes: 300, resets_at: 1783730191 },
        secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1784316991 },
      },
    },
  })
  const q = parseCodexQuotaFromRollout(line + "\n")
  assert.equal(q?.status, "ok")
  assert.equal(q?.planType, "pro")
  assert.deepEqual(q?.windows.map((w) => [w.key, w.usedPercent]), [["5h", 12.5], ["weekly", 40]])
})

test("codex: flattened top-level rate_limits (exec/fixture shape)", () => {
  const line = JSON.stringify({
    type: "token_count",
    info: {},
    rate_limits: {
      plan_type: "pro",
      primary: { used_percent: 0, window_minutes: 300, resets_at: 1 },
      secondary: { used_percent: 0, window_minutes: 10080, resets_at: 2 },
    },
  })
  const q = parseCodexQuotaFromRollout(line)
  assert.equal(q?.windows.length, 2)
})

test("codex: window labeled by window_minutes, not primary/secondary name (real single-window case)", () => {
  // Real observed: `primary` carries the WEEKLY window (10080), `secondary` is null.
  const line = JSON.stringify({
    type: "event_msg",
    payload: {
      type: "token_count",
      rate_limits: { plan_type: "pro", primary: { used_percent: 88, window_minutes: 10080, resets_at: 9 }, secondary: null },
    },
  })
  const q = parseCodexQuotaFromRollout(line)
  assert.equal(q?.windows.length, 1)
  assert.equal(q?.windows[0]!.key, "weekly")
  assert.equal(q?.windows[0]!.usedPercent, 88)
})

test("codex: last token_count wins; junk lines skipped", () => {
  const stale = JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 10, window_minutes: 300 } } } })
  const fresh = JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { primary: { used_percent: 55, window_minutes: 300 } } } })
  const raw = [stale, "not json {", JSON.stringify({ type: "response_item" }), fresh].join("\n")
  const q = parseCodexQuotaFromRollout(raw)
  assert.equal(q?.windows[0]!.usedPercent, 55)
})

test("codex: no rate_limits anywhere → undefined", () => {
  assert.equal(parseCodexQuotaFromRollout(JSON.stringify({ type: "response_item" })), undefined)
  assert.equal(parseCodexQuotaFromRollout(""), undefined)
})

// ---- Codex live app-server (account/rateLimits/read) parsing ----

test("codex live: camelCase rateLimits → windows labeled by windowDurationMins", () => {
  // Captured verbatim from codex-cli 0.146.0 (fields frizz ignores trimmed).
  const q = parseCodexQuotaFromRateLimits({
    rateLimits: {
      limitId: "codex",
      planType: "pro",
      primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1786130265 },
      secondary: { usedPercent: 12.5, windowDurationMins: 300, resetsAt: 1786100000 },
      credits: { hasCredits: false, unlimited: false, balance: "0" },
    },
    rateLimitsByLimitId: { codex_bengalfox: { primary: { usedPercent: 99, windowDurationMins: 10080 } } },
  })
  assert.equal(q?.status, "ok")
  assert.equal(q?.planType, "pro")
  // Per-model `rateLimitsByLimitId` is ignored — only the account aggregate is shown.
  assert.deepEqual(q?.windows.map((w) => [w.key, w.usedPercent]), [["weekly", 0], ["5h", 12.5]])
  assert.equal(q?.windows[0]!.resetsAt, 1786130265)
  assert.equal(q?.codexRecovery?.creditsAvailable, false)
})

test("codex live: 0% used is a real reading, not a missing one", () => {
  // The exact regression: a freshly-switched account reads 0 and must NOT be discarded as falsy.
  const q = parseCodexQuotaFromRateLimits({
    rateLimits: { planType: "pro", primary: { usedPercent: 0, windowDurationMins: 10080, resetsAt: 1 }, secondary: null },
  })
  assert.equal(q?.status, "ok")
  assert.equal(q?.windows.length, 1)
  assert.equal(q?.windows[0]!.usedPercent, 0)
})

test("codex live: credit-only accounts preserve positive, empty, unlimited and unknown credit evidence", () => {
  for (const credits of [
    { hasCredits: true, unlimited: false },
    { hasCredits: false, unlimited: false },
    { hasCredits: false, unlimited: true },
  ]) {
    const q = parseCodexQuotaFromRateLimits({ rateLimits: { primary: null, secondary: null, credits } }, 123)
    assert.equal(q?.status, "ok")
    assert.deepEqual(q?.windows, [])
    assert.deepEqual(q?.codexRecovery, { observedAt: 123, creditsAvailable: credits.hasCredits || credits.unlimited })
  }
  const q = parseCodexQuotaFromRateLimits({ rateLimits: {
    primary: { usedPercent: 0, windowDurationMins: 300 }, credits: { hasCredits: "true", unlimited: false },
  } }, 123)
  assert.equal(q?.codexRecovery?.creditsAvailable, undefined)
})

test("codex live: workspace and spend-control blocks survive even with positive credits and low utilization", () => {
  for (const block of [
    { rateLimitReachedType: "workspace_owner_credits_depleted" },
    { rateLimitReachedType: "workspace_member_credits_depleted" },
    { rateLimitReachedType: "workspace_owner_usage_limit_reached" },
    { rateLimitReachedType: "workspace_member_usage_limit_reached" },
    { rateLimitReachedType: "unknown_future_block" },
    { spendControlReached: true },
    { individualLimit: { remainingPercent: 0 } },
  ]) {
    const q = parseCodexQuotaFromRateLimits({ rateLimits: {
      primary: { usedPercent: 0, windowDurationMins: 300 },
      credits: { hasCredits: true, unlimited: false }, ...block,
    } })
    assert.equal(q?.codexRecovery?.blocked, true, JSON.stringify(block))
  }
})

test("codex live: the included-usage permission preserves false/null rather than inventing availability", () => {
  for (const ordinaryUsageAllowed of [true, false, null] as const) {
    const q = parseCodexQuotaFromRateLimits({ ordinaryUsageAllowed, rateLimits: {
      primary: { usedPercent: 0, windowDurationMins: 300 },
    } })
    assert.equal(q?.codexRecovery?.ordinaryUsageAllowed, ordinaryUsageAllowed)
  }
  assert.equal(parseCodexQuotaFromRateLimits({ ordinaryUsageAllowed: "true", rateLimits: {
    primary: { usedPercent: 0, windowDurationMins: 300 },
  } })?.codexRecovery?.ordinaryUsageAllowed, null)
})

test("codex live: null/absent windows → undefined so the caller falls back", () => {
  // Real shape seen on a `limit_id:"premium"` session: both windows null.
  assert.equal(parseCodexQuotaFromRateLimits({ rateLimits: { limitId: "premium", primary: null, secondary: null } }), undefined)
  assert.equal(parseCodexQuotaFromRateLimits({ rateLimits: {} }), undefined)
  assert.equal(parseCodexQuotaFromRateLimits({}), undefined)
  assert.equal(parseCodexQuotaFromRateLimits(undefined), undefined)
  assert.equal(parseCodexQuotaFromRateLimits("nope"), undefined)
})

test("codex live: snake_case rollout spelling is NOT accepted here", () => {
  // The two sources genuinely differ; accepting both in one reader would hide a protocol change.
  assert.equal(
    parseCodexQuotaFromRateLimits({ rateLimits: { primary: { used_percent: 40, window_minutes: 10080 } } }),
    undefined,
  )
})

test("codex: a failed live read degrades to the rollout tail, labeled as unconfirmed", async () => {
  // `codexBin` points at a binary that cannot answer, so the live path resolves undefined.
  const dir = await mkdtemp(join(tmpdir(), "frizz-codex-quota-"))
  try {
    const day = join(dir, "sessions", "2026", "07", "31")
    await mkdir(day, { recursive: true })
    await writeFile(
      join(day, "rollout-2026-07-31T00-00-00-aaaa.jsonl"),
      JSON.stringify({
        type: "event_msg",
        payload: { type: "token_count", rate_limits: { plan_type: "pro", primary: { used_percent: 99, window_minutes: 10080, resets_at: 7 } } },
      }) + "\n",
    )
    // Signed in, so the live read is attempted — a signed-out Codex is never asked at all.
    await writeFile(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "tok" } }))
    resetCodexQuotaMemo()
    const q = await readCodexQuota(dir, join(dir, "definitely-not-a-real-codex-binary"))
    assert.equal(q.status, "ok")
    assert.equal(q.codexRecovery, undefined, "offline fallback must never authorize a recovery wake")
    assert.equal(q.windows[0]!.usedPercent, 99)
    assert.match(q.detail ?? "", /last local session/i)
  } finally {
    resetCodexQuotaMemo()
    await rm(dir, { recursive: true, force: true })
  }
})

test("codex: a failed live read with no rollouts stays a clean unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "frizz-codex-quota-"))
  try {
    await writeFile(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "tok" } }))
    resetCodexQuotaMemo()
    const q = await readCodexQuota(dir, join(dir, "definitely-not-a-real-codex-binary"))
    assert.equal(q.status, "unavailable")
    assert.deepEqual(q.windows, [])
  } finally {
    resetCodexQuotaMemo()
    await rm(dir, { recursive: true, force: true })
  }
})

test("codex: an account switch during the live read or a mismatched backend account cannot authorize recovery", { skip: process.platform === "win32" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "frizz-codex-account-quota-"))
  const names = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"] as const
  const saved = names.map((name) => process.env[name])
  try {
    for (const name of names) delete process.env[name]
    for (const kind of ["stable", "switched", "mismatched"] as const) {
      await writeFile(join(dir, "auth.json"), JSON.stringify({ tokens: { account_id: "one" } }))
      const bin = join(dir, "codex-quota")
      await writeFile(bin, `#!/bin/sh
while IFS= read -r line; do
  case "$line" in
    *'"id":1'*) printf '%s\\n' '{"id":1,"result":{}}' ;;
    *'"id":2'*)
      ${kind === "switched" ? `printf '%s' '{"tokens":{"account_id":"two"}}' > "$CODEX_HOME/auth.json"` : ":"}
      printf '%s\\n' '{"id":2,"result":{"accountId":"${kind === "mismatched" ? "other" : "one"}","rateLimits":{"primary":{"usedPercent":0,"windowDurationMins":300}}}}' ;;
  esac
done
`)
      await chmod(bin, 0o755)
      const quota = await queryCodexRateLimits(dir, bin)
      assert.equal(quota?.status, "ok", "quota can still be displayed")
      if (kind === "stable") assert.equal(quota?.codexRecovery?.accountKey, createHash("sha256").update("one").digest("hex"))
      else assert.equal(quota?.codexRecovery, undefined, kind)
    }
  } finally {
    names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i] })
    await rm(dir, { recursive: true, force: true })
  }
})

test("codex: the configured binary is spawned for the live quota read", { skip: process.platform === "win32" }, async () => {
  // A POSIX executable is intentional here. On Windows an arbitrary script cannot stand in for an
  // executable without adding a production-only cwd/argv seam; resolveCodexExecutable's Windows
  // launcher behavior is covered separately in codex-executable.test.ts.
  const dir = await mkdtemp(join(tmpdir(), "frizz-codex-quota-"))
  const marker = join(dir, "spawned.txt")
  const bin = join(dir, "codex-stand-in")
  const envNames = ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CACHE_HOME", "FRIZZ_QUOTA_FIXTURE", "FRIZZ_TEST_CODEX_MARKER"] as const
  const savedEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]))
  try {
    await writeFile(bin, `#!/bin/sh
printf '%s' "$*" > "$FRIZZ_TEST_CODEX_MARKER"
while IFS= read -r line; do
  case "$line" in
    *'"id":1'*) printf '%s\\n' '{"id":1,"result":{}}' ;;
    *'"id":2'*) printf '%s\\n' '{"id":2,"result":{"rateLimits":{"planType":"pro","primary":{"usedPercent":17,"windowDurationMins":300,"resetsAt":7},"secondary":null}}}' ;;
  esac
done
`)
    await chmod(bin, 0o755)

    // Keep the other half of readQuota deterministic and offline: a fresh shared Claude reading
    // means this integration test reaches the Codex process boundary without touching credentials.
    process.env.HOME = dir
    process.env.CODEX_HOME = dir
    process.env.CLAUDE_CONFIG_DIR = join(dir, "claude")
    process.env.XDG_CACHE_HOME = join(dir, "cache")
    process.env.FRIZZ_TEST_CODEX_MARKER = marker
    delete process.env.FRIZZ_QUOTA_FIXTURE
    resetFrizzRoots()
    const cacheDir = join(frizzRoots().cache, "quota-cache")
    await mkdir(cacheDir, { recursive: true })
    const profile = createHash("sha256").update(process.env.CLAUDE_CONFIG_DIR).digest("hex").slice(0, 12)
    await writeFile(join(cacheDir, `claude-${profile}.json`), JSON.stringify({
      at: Date.now(),
      quota: { status: "ok", windows: [{ key: "5h", label: "5h", usedPercent: 1 }] },
    }))

    // The stand-in is only ever started for an account there is to ask about.
    await writeFile(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "tok" } }))
    resetCodexQuotaMemo()
    const q = await readQuota({ codexBin: bin })
    assert.equal(await readFile(marker, "utf8"), "app-server")
    assert.equal(q.codex.status, "ok")
    assert.equal(q.codex.windows[0]?.usedPercent, 17)
  } finally {
    resetCodexQuotaMemo()
    for (const name of envNames) {
      const value = savedEnv[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    resetFrizzRoots()
    await rm(dir, { recursive: true, force: true })
  }
})

// ---- How often a `codex app-server` is started for the reading ----
//
// Each test runs the REAL reader against a stand-in `codex` that logs one line per start, so a count
// here is a count of processes. `answers` decides whether it speaks the two replies the read needs or
// exits at once, which is how a broken install, a signed-in API key and an unreachable backend all look
// from here: a live read that produced nothing.
const CODEX_KEYS = ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"] as const
async function withCodexStandIn(
  answers: boolean,
  run: (home: string, bin: string, starts: () => Promise<number>, signIn: (accountId: string) => Promise<void>) => Promise<void>,
) {
  const home = await mkdtemp(join(tmpdir(), "frizz-codex-quota-"))
  const log = join(home, "starts.log")
  const bin = join(home, "codex-stand-in")
  // A key in the environment is a Codex credential, so a machine that has one is never signed out.
  const saved = Object.fromEntries(CODEX_KEYS.map((name) => [name, process.env[name]]))
  for (const name of CODEX_KEYS) delete process.env[name]
  try {
    await writeFile(bin, answers
      ? `#!/bin/sh
echo "$*" >> '${log}'
while IFS= read -r line; do
  case "$line" in
    *'"id":1'*) printf '%s\\n' '{"id":1,"result":{}}' ;;
    *'"id":2'*) printf '%s\\n' '{"id":2,"result":{"rateLimits":{"planType":"pro","primary":{"usedPercent":17,"windowDurationMins":300,"resetsAt":7},"secondary":null}}}' ;;
  esac
done
`
      : `#!/bin/sh\necho "$*" >> '${log}'\nexit 1\n`)
    await chmod(bin, 0o755)
    resetCodexQuotaMemo()
    await run(
      home,
      bin,
      async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).length,
      (accountId) => writeFile(join(home, "auth.json"), JSON.stringify({ tokens: { access_token: "tok", account_id: accountId } })),
    )
  } finally {
    resetCodexQuotaMemo()
    for (const name of CODEX_KEYS) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
    await rm(home, { recursive: true, force: true })
  }
}

const SEC = 1000
const MIN = 60 * SEC

test("codex quota: a machine that is not signed in to Codex never starts an app-server, and signing in is read at once", { skip: process.platform === "win32" }, () => withCodexStandIn(true, async (home, bin, starts, signIn) => {
  // Every caller there is — the poll past its window, and the popover's forced recheck.
  for (const at of [0, 61 * SEC, 10 * MIN, 3 * 60 * MIN]) {
    assert.equal((await readCodexQuota(home, bin, { now: () => at })).status, "unavailable")
    assert.equal((await readCodexQuota(home, bin, { now: () => at + 1, force: true })).status, "unavailable")
  }
  assert.equal(await starts(), 0)

  // The control, and the half that matters to someone who just ran `codex login`: the same stand-in is
  // started on the very next read, with no deadline left over from the signed-out hours before it.
  await signIn("acct-1")
  const q = await readCodexQuota(home, bin, { now: () => 3 * 60 * MIN + 2, force: true })
  assert.equal(q.windows[0]?.usedPercent, 17)
  assert.equal(await starts(), 1)
}))

test("codex quota: a runtime still waiting for its first thread is not started, and no deadline is spent on it", { skip: process.platform === "win32" }, () => withCodexStandIn(true, async (home, bin, starts, signIn) => {
  // Signed in after a boot that left Codex for its first thread: the pin is not on disk yet.
  await signIn("acct-1")
  deferRuntime("codex", async () => {})
  try {
    for (const at of [0, 61 * SEC, 10 * MIN]) {
      await readCodexQuota(home, bin, { now: () => at })
      await readCodexQuota(home, bin, { now: () => at + 1, force: true })
    }
    assert.equal(await starts(), 0)
    // The thread that brings the pin down, and then the very next poll past the memo reads live:
    // nothing above counted as a failed read, so there is no backoff to wait out.
    await ensureRuntime("codex")
    const q = await readCodexQuota(home, bin, { now: () => 10 * MIN + 61 * SEC })
    assert.equal(q.windows[0]?.usedPercent, 17)
    assert.equal(await starts(), 1)
  } finally {
    resetDeferredRuntimes()
  }
}))

test("codex quota: a healthy reading is shared for a minute, and callers that arrive together join one read", { skip: process.platform === "win32" }, () => withCodexStandIn(true, async (home, bin, starts, signIn) => {
  await signIn("acct-1")
  const together = await Promise.all([0, 0, 0].map((at) => readCodexQuota(home, bin, { now: () => at })))
  assert.ok(together.every((q) => q.windows[0]?.usedPercent === 17))
  assert.equal(await starts(), 1)
  // The chip polls every 30s: the second poll reads the first one's answer, the third pays for its own.
  await readCodexQuota(home, bin, { now: () => 30 * SEC })
  assert.equal(await starts(), 1)
  await readCodexQuota(home, bin, { now: () => 60 * SEC })
  assert.equal(await starts(), 2)
  // Opening the chip is a real recheck, inside the window or not.
  await readCodexQuota(home, bin, { now: () => 61 * SEC, force: true })
  assert.equal(await starts(), 3)
}))

test("codex quota: a live read that cannot succeed backs off, doubling — until a recheck or a new credential asks again", { skip: process.platform === "win32" }, () => withCodexStandIn(false, async (home, bin, starts, signIn) => {
  await signIn("acct-1")
  const poll = async (at: number) => { await readCodexQuota(home, bin, { now: () => at }) }
  await poll(0)
  assert.equal(await starts(), 1)
  // 15s polls for the first minute: nothing is asked again.
  for (const at of [15, 30, 45, 59]) await poll(at * SEC)
  assert.equal(await starts(), 1)
  await poll(1 * MIN) // the first deadline: one more, and the next is 2m out
  assert.equal(await starts(), 2)
  for (const at of [75, 120, 179]) await poll(at * SEC)
  assert.equal(await starts(), 2)
  await poll(3 * MIN) // … then 4m
  assert.equal(await starts(), 3)
  await poll(5 * MIN)
  assert.equal(await starts(), 3)

  // The popover is a person asking, so it is answered now; it does not shorten what follows.
  await readCodexQuota(home, bin, { now: () => 5 * MIN + 1, force: true })
  assert.equal(await starts(), 4)
  await poll(12 * MIN)
  assert.equal(await starts(), 4)

  // A different account is a different question, and it is asked on the next read.
  await signIn("acct-2")
  await poll(13 * MIN)
  assert.equal(await starts(), 5)
}))

// ---- Claude usage endpoint parsing ----

test("claude: five_hour + seven_day utilization → windows", () => {
  const q = parseClaudeUsage(
    { five_hour: { utilization: 34, reset_at: "2026-07-15T18:00:00Z" }, seven_day: { utilization: 61, reset_at: "2026-07-18T00:00:00Z" } },
    "max",
  )
  assert.equal(q.status, "ok")
  assert.equal(q.planType, "max")
  assert.deepEqual(q.windows.map((w) => [w.key, w.usedPercent]), [["5h", 34], ["weekly", 61]])
  assert.equal(typeof q.windows[0]!.resetsAt, "number")
})

test("claude: surfaces model-specific weekly caps (opus/sonnet) when present", () => {
  const q = parseClaudeUsage({
    five_hour: { utilization: 10, reset_at: "2026-07-15T18:00:00Z" },
    seven_day: { utilization: 40, reset_at: "2026-07-18T00:00:00Z" },
    seven_day_opus: { utilization: 91, reset_at: "2026-07-18T00:00:00Z" },
  })
  assert.deepEqual(q.windows.map((w) => w.key), ["5h", "weekly", "weekly-opus"])
  // The binding limit (opus 91% used) is the highest usedPercent → the chip's "tightest" pick.
  assert.equal(Math.max(...q.windows.map((w) => w.usedPercent)), 91)
})

test("claude: modern limits[] body (live 2026-07 shape) — session + model-scoped weekly", () => {
  // Captured verbatim (percents aside) from the live endpoint on a Fable plan: seven_day is null and
  // the windows ride in limits[], the weekly scoped to a model display name.
  const q = parseClaudeUsage({
    five_hour: { utilization: 40, resets_at: "2026-07-24T03:00:00.417680+00:00", limit_dollars: null },
    seven_day: null,
    seven_day_opus: null,
    limits: [
      { kind: "session", group: "session", percent: 40, severity: "normal", resets_at: "2026-07-24T03:00:00.417680+00:00", scope: null, is_active: false },
      { kind: "weekly_scoped", group: "weekly", percent: 49, severity: "normal", resets_at: "2026-07-27T08:00:00.417999+00:00", scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: true },
    ],
  })
  assert.equal(q.status, "ok")
  assert.deepEqual(q.windows.map((w) => [w.key, w.label, w.usedPercent]), [
    ["5h", "5h", 40],
    ["weekly-fable", "Fable wk", 49],
  ])
  assert.equal(q.windows[0]?.resetsAt, Math.round(Date.parse("2026-07-24T03:00:00.417680+00:00") / 1000))
  assert.equal(q.windows[1]?.resetsAt, Math.round(Date.parse("2026-07-27T08:00:00.417999+00:00") / 1000))
})

test("claude: legacy body with snake resets_at still parses; limits[] wins on key collisions", () => {
  const q = parseClaudeUsage({
    five_hour: { utilization: 12, resets_at: "2026-07-24T03:00:00Z" },
    limits: [{ kind: "session", group: "session", percent: 14, resets_at: "2026-07-24T04:00:00Z" }],
  })
  // limits[] is authoritative for the same window key.
  assert.deepEqual(q.windows.map((w) => [w.key, w.usedPercent]), [["5h", 14]])
})

test("claude: malformed / empty body → unavailable, never throws", () => {
  assert.equal(parseClaudeUsage(null).status, "unavailable")
  assert.equal(parseClaudeUsage({}).status, "unavailable")
  assert.equal(parseClaudeUsage({ five_hour: { reset_at: "x" } }).status, "unavailable")
})

// ---- Credential blob parsing (same shape whether it comes from ~/.claude/.credentials.json OR the
// macOS Keychain "Claude Code-credentials" generic password — `security -w` prints this exact blob). ----

test("claude creds: nested claudeAiOauth.accessToken (current shape)", () => {
  assert.equal(tokenFromCredentialsJson(JSON.stringify({ claudeAiOauth: { accessToken: "tok-abc" } })), "tok-abc")
})

test("claude creds: flat access_token (drifted/older shape)", () => {
  assert.equal(tokenFromCredentialsJson(JSON.stringify({ access_token: "tok-flat" })), "tok-flat")
})

test("claude creds: garbage / empty / no token → undefined, never throws", () => {
  assert.equal(tokenFromCredentialsJson("not json {"), undefined)
  assert.equal(tokenFromCredentialsJson("null"), undefined)
  assert.equal(tokenFromCredentialsJson(JSON.stringify({ claudeAiOauth: { accessToken: "" } })), undefined)
  assert.equal(tokenFromCredentialsJson(JSON.stringify({ other: 1 })), undefined)
})

// ---- Claude Code `/usage` parsing + cross-window cache ----

const usageText = [
  "You are currently using your subscription to power your Claude Code usage",
  "Current session: 20% used · resets 4pm",
  "Current week (all models): 44% used · resets Thu",
  "Current week (Sonnet only): 61% used · resets Thu",
].join("\n")
const usageEnvelope = JSON.stringify({ type: "result", subtype: "success", result: usageText })

test("claude CLI usage: parses independent session, weekly, and model-scoped windows", () => {
  const now = new Date("2026-07-22T15:00:00").getTime()
  const q = parseClaudeUsageOutput(usageText, now)
  assert.equal(q.status, "ok")
  assert.deepEqual(q.windows.map((w) => [w.key, w.label, w.usedPercent]), [
    ["5h", "5h", 20],
    ["weekly", "Weekly", 44],
    ["weekly-sonnet", "Sonnet wk", 61],
  ])
  assert.equal(q.windows[0]?.resetsAt, Math.round(new Date("2026-07-22T16:00:00").getTime() / 1000))
})

test("claude CLI usage: parses the JSON result envelope and rejects cost-only signed-out output", () => {
  assert.equal(parseClaudeUsageOutput(usageEnvelope).status, "ok")
  const missing = parseClaudeUsageOutput(JSON.stringify({ result: "Total cost: $0.00\nUsage: 0 input" }))
  assert.equal(missing.status, "unavailable")
  assert.equal(missing.detail, "Claude Code did not report subscription quota")
})

test("claude CLI usage: parses the live '<Mon> <D> at <clock> (<tz>)' reset labels", () => {
  const now = new Date("2026-07-23T10:30:00").getTime()
  const q = parseClaudeUsageOutput(
    [
      "Current session: 17% used · resets Jul 23 at 3pm (America/Los_Angeles)",
      "Current week (Fable): 45% used · resets Jul 27 at 12:59am (America/Los_Angeles)",
    ].join("\n"),
    now,
  )
  assert.equal(q.status, "ok")
  assert.deepEqual(q.windows.map((w) => [w.key, w.usedPercent]), [["5h", 17], ["weekly-fable", 45]])
  assert.equal(q.windows[0]?.resetsAt, Math.round(new Date("2026-07-23T15:00:00").getTime() / 1000))
  assert.equal(q.windows[1]?.resetsAt, Math.round(new Date("2026-07-27T00:59:00").getTime() / 1000))
})

test("claude CLI usage: a year-less date label crossing New Year resolves forward", () => {
  const now = new Date("2026-12-30T10:00:00").getTime()
  const q = parseClaudeUsageOutput("Current session: 5% used · resets Jan 2 at 3pm (America/Los_Angeles)", now)
  assert.equal(q.windows[0]?.resetsAt, Math.round(new Date("2027-01-02T15:00:00").getTime() / 1000))
})

async function withCache(run: (cacheDir: string) => Promise<void>) {
  const cacheDir = await mkdtemp(join(tmpdir(), "frizz-quota-test-"))
  try {
    await run(cacheDir)
  } finally {
    await rm(cacheDir, { recursive: true, force: true })
  }
}

const signedIn = async () => "tok-live"
// Neither the credentials file nor the Keychain holds a token.
const signedOut = async () => undefined

function usageResponse(status: number, body?: unknown): typeof fetch {
  return (async () => new Response(body === undefined ? "" : JSON.stringify(body), { status })) as unknown as typeof fetch
}

const fiveHour = (percent: number) => ({ plan_type: "max", five_hour: { utilization: percent, reset_at: "2026-07-23T22:00:00Z" } })
const unreachable = (async () => { throw new TypeError("fetch failed") }) as unknown as typeof fetch

const endpointBody = {
  plan_type: "max",
  five_hour: { utilization: 30, reset_at: "2026-07-23T22:00:00Z" },
  seven_day: { utilization: 47, reset_at: "2026-07-27T08:00:00Z" },
}

test("claude quota: the OAuth endpoint is the primary source — the CLI is never spawned on a healthy read", () => withCache(async (cacheDir) => {
  let cliCalls = 0
  const q = await readClaudeQuota("claude-test", {
    cacheDir,
    now: () => 0,
    readToken: async () => "tok-live",
    fetchImpl: usageResponse(200, endpointBody),
    execUsage: async () => { cliCalls++; return usageEnvelope },
  })
  assert.equal(q.status, "ok")
  assert.equal(q.planType, "max")
  assert.deepEqual(q.windows.map((w) => [w.key, w.usedPercent]), [["5h", 30], ["weekly", 47]])
  assert.equal(cliCalls, 0)
}))

test("claude quota: a rejected token (401) starts Claude Code once, which owns refresh, and the endpoint accepting the token ends its backoff", () => withCache(async (cacheDir) => {
  let cliCalls = 0
  let status = 401
  const fetchImpl = (async () => new Response(status === 200 ? JSON.stringify(fiveHour(30)) : "", { status })) as unknown as typeof fetch
  const deps = { cacheDir, readToken: async () => "tok-expired", fetchImpl, execUsage: async () => { cliCalls++; return usageEnvelope } }
  const q = await readClaudeQuota("claude-test", { ...deps, now: () => 0 })
  assert.equal(q.status, "ok")
  assert.equal(q.windows[0]?.usedPercent, 20)
  assert.equal(cliCalls, 1)

  // Claude Code rotated the token, so the next refresh is the endpoint's and the CLI stays down.
  status = 200
  const refreshed = await readClaudeQuota("claude-test", { ...deps, now: () => 3 * 60_000 }, { force: true })
  assert.equal(refreshed.windows[0]?.usedPercent, 30)
  assert.equal(cliCalls, 1)

  // That success cleared the backoff: the NEXT expiry, minutes inside what would have been the first
  // window, is refreshed at once rather than waiting out a deadline a working token already answered.
  status = 401
  await readClaudeQuota("claude-test", { ...deps, now: () => 6 * 60_000 }, { force: true })
  assert.equal(cliCalls, 2)
}))

test("claude quota: a credential Claude Code cannot refresh costs one start per backoff window, and the window doubles", () => withCache(async (cacheDir) => {
  let cliCalls = 0
  const deps = {
    cacheDir,
    readToken: async () => "tok-revoked",
    fetchImpl: usageResponse(401),
    execUsage: async () => { cliCalls++; throw new Error("Not logged in · Please run /login") },
  }
  const MIN = 60_000
  const recheck = async (at: number) => (await readClaudeQuota("claude-test", { ...deps, now: () => at }, { force: true })).status
  const heartbeat = async (at: number) => {
    await refreshClaudeQuotaInBackground("claude-test", { ...deps, now: () => at })
    await claudeQuotaRefreshSettled()
  }

  assert.equal(await recheck(0), "unavailable")
  assert.equal(cliCalls, 1)
  // Inside the first 15m nothing starts it again — not a forced recheck, a plain read or the heartbeat —
  // and the "unavailable" each of those writes over the reading does not erase the deadline.
  await recheck(11_000)
  await readClaudeQuota("claude-test", { ...deps, now: () => 30_000 })
  await heartbeat(60_000)
  await recheck(15 * MIN - 1)
  assert.equal(cliCalls, 1)

  await recheck(15 * MIN)
  assert.equal(cliCalls, 2)
  await recheck(44 * MIN)
  assert.equal(cliCalls, 2)
  // The heartbeat's start is recorded like any other: 45m + the third window, 1h.
  await heartbeat(45 * MIN)
  assert.equal(cliCalls, 3)
  await recheck(104 * MIN)
  await heartbeat(105 * MIN - 1)
  assert.equal(cliCalls, 3)
  await recheck(105 * MIN)
  assert.equal(cliCalls, 4)
}))

// The heartbeat is armed once per PROJECT and the credential is the machine's, so what bounds a failing
// refresh has to be shared by every one of them — and by the chip's poll, which arrives between ticks.
test("claude quota: a failed refresh is not repeated for 30s by anyone — every project's heartbeat and the chip's poll share one attempt", () => withCache(async (cacheDir) => {
  for (const [state, deps] of [
    ["signed out", { readToken: signedOut, fetchImpl: unreachable }],
    ["offline", { readToken: signedIn, fetchImpl: unreachable }],
  ] as const) {
    let lookups = 0
    const at = (now: number) => ({
      cacheDir: join(cacheDir, state),
      now: () => now,
      fetchImpl: deps.fetchImpl,
      readToken: async () => { lookups++; return deps.readToken() },
    })
    // Twenty-two open projects tick inside the same second, and a tab polls 15s later.
    for (let project = 0; project < 22; project++) {
      await refreshClaudeQuotaInBackground("claude-test", at(project * 40))
      await claudeQuotaRefreshSettled()
    }
    assert.equal((await readClaudeQuota("claude-test", at(15_000))).status, "unavailable")
    assert.equal(lookups, 1, `${state}: one attempt for the whole window`)

    // The window passes: one more, again shared. A forced recheck never waits for it.
    await refreshClaudeQuotaInBackground("claude-test", at(30_000))
    await claudeQuotaRefreshSettled()
    await refreshClaudeQuotaInBackground("claude-test", at(30_500))
    await claudeQuotaRefreshSettled()
    await readClaudeQuota("claude-test", at(45_000))
    assert.equal(lookups, 2, `${state}: one attempt for the next window`)
    await readClaudeQuota("claude-test", at(46_000), { force: true })
    assert.equal(lookups, 3, `${state}: a recheck asks at once`)
  }
}))

test("claude quota: a stale good reading rides through an outage on one attempt per window, and recovers on the first one that lands", () => withCache(async (cacheDir) => {
  let fetches = 0
  let online = true
  const fetchImpl = (async () => {
    fetches++
    if (!online) throw new TypeError("fetch failed")
    return new Response(JSON.stringify(fiveHour(online && fetches > 1 ? 55 : 20)), { status: 200 })
  }) as unknown as typeof fetch
  const at = (now: number) => ({ cacheDir, readToken: signedIn, fetchImpl, now: () => now })
  await readClaudeQuota("claude-test", at(0))
  online = false
  // Past the 2m TTL every poll kicks a background refresh; inside one failure window they share it.
  for (const now of [3 * 60_000, 3 * 60_000 + 15_000, 3 * 60_000 + 29_000]) {
    assert.equal((await readClaudeQuota("claude-test", at(now))).windows[0]?.usedPercent, 20)
    await claudeQuotaRefreshSettled()
  }
  assert.equal(fetches, 2)
  online = true
  await readClaudeQuota("claude-test", at(3 * 60_000 + 30_000))
  await claudeQuotaRefreshSettled()
  assert.equal(fetches, 3)
  assert.equal((await readClaudeQuota("claude-test", at(3 * 60_000 + 31_000))).windows[0]?.usedPercent, 55)
}))

test("claude quota: a failed Claude Code refresh keeps the last good reading and still records its start", () => withCache(async (cacheDir) => {
  await readClaudeQuota("claude-test", { cacheDir, readToken: signedIn, now: () => 0, fetchImpl: usageResponse(200, fiveHour(20)) })
  let cliCalls = 0
  const deps = { cacheDir, readToken: signedIn, fetchImpl: usageResponse(403), execUsage: async () => { cliCalls++; throw new Error("CLI failed") } }
  const stale = await readClaudeQuota("claude-test", { ...deps, now: () => 3 * 60_000 }, { force: true })
  assert.equal(stale.windows[0]?.usedPercent, 20)
  assert.equal(stale.detail, "Could not refresh · last updated 3m ago")
  const again = await readClaudeQuota("claude-test", { ...deps, now: () => 4 * 60_000 }, { force: true })
  assert.equal(again.detail, "Could not refresh · last updated 4m ago")
  assert.equal(cliCalls, 1)
}))

// The REAL exec path against a counting stand-in for the `claude` binary: `execUsage` is never
// injected, so a start here is a process the production reader would have started. Until 2026-10-11
// the first three blocks each started one per attempt — six a minute on a signed-out machine.
test("claude quota: Claude Code is never started for a machine that is signed out, offline, or facing a failing endpoint", { skip: process.platform === "win32" }, () => withCache(async (cacheDir) => {
  const starts = join(cacheDir, "starts.log")
  const claude = join(cacheDir, "claude")
  await writeFile(claude, `#!/bin/sh\necho "$@" >> '${starts}'\necho 'Not logged in · Please run /login'\nexit 1\n`)
  await chmod(claude, 0o755)
  const started = async () => (await readFile(starts, "utf8").catch(() => "")).split("\n").filter(Boolean)
  let clock = 0
  // One attempt of each kind production makes: the server heartbeat, the chip's poll, the popover's recheck.
  const everyCaller = async (deps: { readToken: () => Promise<string | undefined>; fetchImpl: typeof fetch }, cache: string) => {
    for (let i = 0; i < 4; i++) {
      const at = { cacheDir: join(cacheDir, cache), ...deps, now: () => clock }
      await refreshClaudeQuotaInBackground(claude, at)
      await claudeQuotaRefreshSettled()
      assert.equal((await readClaudeQuota(claude, at)).status, "unavailable")
      assert.equal((await readClaudeQuota(claude, at, { force: true })).status, "unavailable")
      clock += 15_000
    }
  }

  await everyCaller({ readToken: signedOut, fetchImpl: unreachable }, "signed-out")
  await everyCaller({ readToken: signedIn, fetchImpl: unreachable }, "offline")
  await everyCaller({ readToken: signedIn, fetchImpl: usageResponse(500) }, "endpoint-down")
  assert.deepEqual(await started(), [])

  // The control: the same twelve attempts against a REJECTED token do reach the stand-in, once — so
  // the empty log above is the reader declining to start it, not a stand-in nothing could reach.
  await everyCaller({ readToken: signedIn, fetchImpl: usageResponse(401) }, "rejected")
  assert.deepEqual(await started(), ["-p /usage --safe-mode --output-format json --no-session-persistence --tools "])
}))

test("claude quota: a 429 backs off — no CLI hammering, last good reading served", () => withCache(async (cacheDir) => {
  await readClaudeQuota("claude-test", { cacheDir, readToken: signedIn, now: () => 0, fetchImpl: usageResponse(200, fiveHour(20)) })
  let cliCalls = 0
  const q = await readClaudeQuota(
    "claude-test",
    {
      cacheDir,
      now: () => 4 * 60_000,
      readToken: async () => "tok-live",
      fetchImpl: usageResponse(429),
      execUsage: async () => { cliCalls++; return usageEnvelope },
    },
    { force: true },
  )
  assert.equal(q.status, "ok")
  assert.equal(q.windows[0]?.usedPercent, 20)
  // A refusal is not a failure: no `retry-after` header → the 5m default, and the copy says when.
  assert.equal(q.detail, "Next refresh in 5m · last updated 4m ago")
  assert.equal(cliCalls, 0)
}))

test("claude quota: a 429's retry-after is honored by every caller until it passes, then cleared by a success", () => withCache(async (cacheDir) => {
  let fetches = 0
  let status = 429
  const fetchImpl = (async () => {
    fetches++
    return status === 429
      ? new Response("", { status: 429, headers: { "retry-after": "139" } })
      : new Response(JSON.stringify(endpointBody), { status: 200 })
  }) as unknown as typeof fetch
  const deps = { cacheDir, readToken: async () => "tok-live", fetchImpl, execUsage: async () => { throw new Error("CLI must not run") } }
  await readClaudeQuota("claude-test", { cacheDir, readToken: signedIn, now: () => 0, fetchImpl: usageResponse(200, fiveHour(20)) })

  // The recheck that learns the deadline: 3m in, the endpoint answers 429 + retry-after 139s.
  const refused = await readClaudeQuota("claude-test", { ...deps, now: () => 3 * 60_000 }, { force: true })
  assert.equal(refused.detail, "Next refresh in 3m · last updated 3m ago")
  assert.equal(fetches, 1)

  // Inside the window nothing asks again — not a forced recheck, not the heartbeat, not a stale read.
  const again = await readClaudeQuota("claude-test", { ...deps, now: () => 4 * 60_000 }, { force: true })
  assert.equal(again.detail, "Next refresh in 2m · last updated 4m ago")
  await refreshClaudeQuotaInBackground("claude-test", { ...deps, now: () => 4 * 60_000 })
  assert.equal((await readClaudeQuota("claude-test", { ...deps, now: () => 5 * 60_000 })).detail, undefined)
  await claudeQuotaRefreshSettled()
  assert.equal(fetches, 1)

  // Past it, the heartbeat refreshes; the success clears the deadline, so a recheck is live again.
  status = 200
  await refreshClaudeQuotaInBackground("claude-test", { ...deps, now: () => 3 * 60_000 + 140_000 })
  await claudeQuotaRefreshSettled()
  assert.equal(fetches, 2)
  const fresh = await readClaudeQuota("claude-test", { ...deps, now: () => 6 * 60_000 }, { force: true })
  assert.equal(fresh.detail, undefined)
  assert.equal(fresh.windows[0]?.usedPercent, 30)
  assert.equal(fetches, 3)
}))

test("claude quota: the heartbeat leaves a reading inside its TTL alone", () => withCache(async (cacheDir) => {
  let fetches = 0
  const fetchImpl = (async () => { fetches++; return new Response(JSON.stringify(endpointBody), { status: 200 }) }) as unknown as typeof fetch
  const deps = { cacheDir, readToken: async () => "tok-live", fetchImpl }
  await refreshClaudeQuotaInBackground("claude-test", { ...deps, now: () => 0 })
  await claudeQuotaRefreshSettled()
  await refreshClaudeQuotaInBackground("claude-test", { ...deps, now: () => 30_000 })
  await claudeQuotaRefreshSettled()
  assert.equal(fetches, 1)
}))

test("claude quota: healthy result is shared, while force performs a real recheck", () => withCache(async (cacheDir) => {
  let calls = 0
  const fetchImpl = (async () => {
    calls++
    return new Response(JSON.stringify(fiveHour(20)), { status: 200 })
  }) as unknown as typeof fetch
  const deps = { cacheDir, readToken: signedIn, fetchImpl }
  assert.equal((await readClaudeQuota("claude-test", { ...deps, now: () => 0 })).status, "ok")
  // A second read comfortably within the 2m healthy TTL is served from the shared cache, no new call.
  assert.equal((await readClaudeQuota("claude-test", { ...deps, now: () => 30_000 })).status, "ok")
  assert.equal(calls, 1)
  await readClaudeQuota("claude-test", { ...deps, now: () => 30_001 }, { force: true })
  assert.equal(calls, 2)
}))

test("claude quota: the proactive heartbeat warms the shared cache off the endpoint, no browser read, no CLI", () => withCache(async (cacheDir) => {
  let cliCalls = 0
  let percent = 30
  const fetchImpl = (async () =>
    new Response(JSON.stringify({ plan_type: "max", five_hour: { utilization: percent, reset_at: "2026-07-23T22:00:00Z" } }), { status: 200 })) as unknown as typeof fetch
  const deps = { cacheDir, readToken: async () => "tok-live", fetchImpl, execUsage: async () => { cliCalls++; return usageEnvelope } }

  // No foreground read has happened — the cache is cold. The heartbeat alone must populate it.
  await refreshClaudeQuotaInBackground("claude-test", { ...deps, now: () => 0 })
  await claudeQuotaRefreshSettled()
  const warmed = await readClaudeQuota("claude-test", { ...deps, now: () => 0 })
  assert.equal(warmed.status, "ok")
  assert.equal(warmed.windows[0]?.usedPercent, 30)

  // The value moves; a heartbeat past the 2m TTL rewrites the cache so the next read is fresh — all
  // from the endpoint, never spawning the CLI.
  percent = 85
  await refreshClaudeQuotaInBackground("claude-test", { ...deps, now: () => 121_000 })
  await claudeQuotaRefreshSettled()
  const refreshed = await readClaudeQuota("claude-test", { ...deps, now: () => 121_000 })
  assert.equal(refreshed.windows[0]?.usedPercent, 85)
  assert.equal(cliCalls, 0)
}))

test("claude quota: concurrent project windows collapse onto one usage request", () => withCache(async (cacheDir) => {
  let calls = 0
  const fetchImpl = (async () => {
    calls++
    await new Promise((resolve) => setTimeout(resolve, 100))
    return new Response(JSON.stringify(fiveHour(20)), { status: 200 })
  }) as unknown as typeof fetch
  const deps = { cacheDir, readToken: signedIn, now: () => 1_000, fetchImpl }
  const results = await Promise.all([
    readClaudeQuota("claude-test", deps),
    readClaudeQuota("claude-test", deps),
    readClaudeQuota("claude-test", deps),
  ])
  assert.equal(calls, 1)
  assert.ok(results.every((result) => result.status === "ok"))
}))

test("claude quota: an expired reading is served instantly while a background refresh updates the cache", () => withCache(async (cacheDir) => {
  let calls = 0
  const fetchImpl = (async () => {
    calls++
    return new Response(JSON.stringify(fiveHour(calls === 1 ? 20 : 55)), { status: 200 })
  }) as unknown as typeof fetch
  const deps = { cacheDir, readToken: signedIn, fetchImpl }
  await readClaudeQuota("claude-test", { ...deps, now: () => 0 })
  assert.equal(calls, 1)
  // TTL expired: the poll gets the stale-but-recent reading back immediately (no wait for the
  // endpoint on the request path) and the refresh happens behind it.
  const swr = await readClaudeQuota("claude-test", { ...deps, now: () => 4 * 60_000 })
  assert.equal(swr.status, "ok")
  assert.equal(swr.windows[0]?.usedPercent, 20)
  assert.equal(swr.detail, undefined)
  await claudeQuotaRefreshSettled()
  assert.equal(calls, 2)
  const after = await readClaudeQuota("claude-test", { ...deps, now: () => 4 * 60_000 + 1 })
  assert.equal(after.windows[0]?.usedPercent, 55)
  assert.equal(calls, 2)
}))

test("claude quota: a meaningfully old reading served via stale-while-revalidate says so", () => withCache(async (cacheDir) => {
  await readClaudeQuota("claude-test", { cacheDir, readToken: signedIn, now: () => 0, fetchImpl: usageResponse(200, fiveHour(20)) })
  const swr = await readClaudeQuota("claude-test", { cacheDir, readToken: signedIn, now: () => 15 * 60_000, fetchImpl: unreachable })
  assert.equal(swr.status, "ok")
  assert.equal(swr.detail, "Refreshing · last updated 15m ago")
  await claudeQuotaRefreshSettled()
}))

test("claude quota: a failed refresh retains the last good reading with an honest stale label", () => withCache(async (cacheDir) => {
  await readClaudeQuota("claude-test", { cacheDir, readToken: signedIn, now: () => 0, fetchImpl: usageResponse(200, fiveHour(20)) })
  const stale = await readClaudeQuota(
    "claude-test",
    { cacheDir, readToken: signedIn, now: () => 4 * 60_000, fetchImpl: unreachable, execUsage: async () => { throw new Error("CLI must not run") } },
    { force: true },
  )
  assert.equal(stale.status, "ok")
  assert.equal(stale.windows[0]?.usedPercent, 20)
  assert.equal(stale.detail, "Could not refresh · last updated 4m ago")
}))

// ---- What Claude Code's own sessions report (claude-quota-observed.ts) ----

// The frame Claude Code 2.1.296 sent on 2026-10-11; see claude-quota-observed.test.ts.
const REPORTED = {
  status: "allowed_warning",
  rateLimitType: "seven_day",
  utilization: 0.76,
  resetsAt: 1791792000,
  unifiedWindows: { five_hour: { utilization: 0.65, resetsAt: 1791757200 }, seven_day: { utilization: 0.76, resetsAt: 1791792000 } },
}

// The reader keys the report by the config directory, so each of these tests names its own.
async function withConfigDir(configDir: string, run: () => Promise<void>) {
  const before = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = configDir
  resetObservedClaudeQuotaThrottle()
  try {
    await run()
  } finally {
    if (before === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = before
  }
}

// THE TOKEN-BROKER MACHINE. Claude Code is signed in by a route that leaves no token where Frizz can
// read one, so the endpoint cannot be asked — and until 2026-10-11 the only other source was starting
// Claude Code, which is the process storm that route was removed for. The workers there report the
// plan's windows on every turn; that report is the reading.
test("claude quota: a machine whose token Frizz cannot read shows what its own sessions report — no request, no process", () => withCache(async (cacheDir) => {
  const configDir = join(cacheDir, "config")
  await withConfigDir(configDir, async () => {
    let requests = 0
    let starts = 0
    const at = (now: number) => ({
      cacheDir,
      readToken: signedOut,
      now: () => now,
      fetchImpl: (async () => { requests++; throw new TypeError("no request may be made without a token") }) as unknown as typeof fetch,
      execUsage: async () => { starts++; return "" },
    })
    const T0 = 1791750000 * SEC
    // NEGATIVE CONTROL: before any session has reported, there is nothing to show.
    assert.equal((await readClaudeQuota("claude-test", at(T0))).status, "unavailable")

    await recordObservedClaudeQuota(REPORTED, { cacheDir, configDir, now: T0 + MIN })
    const expected = {
      status: "ok",
      windows: [
        { key: "5h", label: "5h", usedPercent: 65, resetsAt: 1791757200 },
        { key: "weekly", label: "Weekly", usedPercent: 76, resetsAt: 1791792000 },
      ],
    }
    assert.deepEqual(await readClaudeQuota("claude-test", at(T0 + 4 * MIN)), { ...expected, detail: "From this machine's Claude sessions · 3m ago" })
    // The popover's forced recheck has nothing better to ask, and says the same.
    assert.deepEqual(await readClaudeQuota("claude-test", at(T0 + 4 * MIN + SEC), { force: true }), { ...expected, detail: "From this machine's Claude sessions · 3m ago" })
    // Another config directory is another account: its report is not this one's.
    await withConfigDir(join(cacheDir, "other"), async () => {
      assert.equal((await readClaudeQuota("claude-test", at(T0 + 4 * MIN))).status, "unavailable")
    })
    // Past the 5-hour window's own reset only the weekly is still a reading (1h 59m after the report).
    const later = await readClaudeQuota("claude-test", at(1791757200 * SEC))
    assert.deepEqual(later.windows.map((w) => w.key), ["weekly"])
    assert.equal(later.detail, "From this machine's Claude sessions · 1h 59m ago")
    assert.equal((await readClaudeQuota("claude-test", at(1791792000 * SEC))).status, "unavailable", "and past the weekly's, nothing is")
    await claudeQuotaRefreshSettled()
    assert.equal(requests, 0)
    assert.equal(starts, 0)
  })
}))

test("claude quota: a session's report newer than the endpoint's reading takes over the windows it names, and only those", () => {
  const T = 1791750000 * SEC
  const served = {
    status: "ok" as const,
    planType: "max",
    windows: [
      { key: "5h", label: "5h", usedPercent: 20, resetsAt: 1791757200 },
      { key: "weekly", label: "Weekly", usedPercent: 40, resetsAt: 1791792000 },
      { key: "weekly-fable", label: "Fable wk", usedPercent: 1, resetsAt: 1791792000 },
    ],
  }
  const report = (at: number) => ({ at, windows: [{ key: "5h", label: "5h", usedPercent: 35, resetsAt: 1791757200, at }] })

  assert.equal(withObservedClaudeQuota(served, T, undefined, T + 9 * MIN), served)
  assert.equal(withObservedClaudeQuota(served, T, report(T - SEC), T + 9 * MIN), served, "a report older than the endpoint's reading changes nothing")
  assert.equal(withObservedClaudeQuota(served, undefined, report(T + MIN), T + 9 * MIN), served, "nor does one beside a reading taken just now")
  assert.equal(
    withObservedClaudeQuota(served, T, { at: T + MIN, windows: [{ key: "weekly-opus", label: "Opus wk", usedPercent: 9, at: T + MIN }] }, T + 9 * MIN),
    served,
    "nor one for a window the endpoint's reading does not carry",
  )

  // Newer: its window's numbers, the endpoint's for the rest, and no note on a reading that had none.
  assert.deepEqual(withObservedClaudeQuota(served, T, report(T + 7 * MIN), T + 9 * MIN), {
    ...served,
    windows: [{ key: "5h", label: "5h", usedPercent: 35, resetsAt: 1791757200 }, served.windows[1], served.windows[2]],
  })
  // A staleness note described the endpoint's reading; it no longer describes what is shown.
  assert.equal(
    withObservedClaudeQuota({ ...served, detail: "Could not refresh · last updated 40m ago" }, T, report(T + 38 * MIN), T + 40 * MIN).detail,
    "Updated from this machine's Claude sessions · 2m ago",
  )
  assert.equal(withObservedClaudeQuota({ ...served, detail: "x" }, T, report(T + 40 * MIN - 1), T + 40 * MIN).detail, "Updated from this machine's Claude sessions · just now")
})

test("claude quota: while the endpoint cannot be reached, the chip follows the sessions' reports instead of freezing", () => withCache(async (cacheDir) => {
  const configDir = join(cacheDir, "config")
  await withConfigDir(configDir, async () => {
    await readClaudeQuota("claude-test", { cacheDir, readToken: signedIn, now: () => 0, fetchImpl: usageResponse(200, fiveHour(20)) })
    const outage = (now: number) => readClaudeQuota("claude-test", { cacheDir, readToken: signedIn, now: () => now, fetchImpl: unreachable })
    // CONTROL: with no report, the old reading is served under its staleness note.
    const frozen = await outage(20 * MIN)
    assert.equal(frozen.windows[0]?.usedPercent, 20)
    assert.equal(frozen.detail, "Refreshing · last updated 20m ago")
    await claudeQuotaRefreshSettled()

    await recordObservedClaudeQuota({ rateLimitType: "five_hour", utilization: 0.35, resetsAt: 1791757200 }, { cacheDir, configDir, now: 21 * MIN })
    const followed = await outage(22 * MIN)
    assert.deepEqual(followed.windows, [{ key: "5h", label: "5h", usedPercent: 35, resetsAt: 1791757200 }])
    assert.equal(followed.planType, "max", "what only the endpoint knows is kept")
    assert.equal(followed.detail, "Updated from this machine's Claude sessions · 1m ago")
    await claudeQuotaRefreshSettled()

    // The endpoint comes back with a NEWER reading: it wins again, silently.
    const back = await readClaudeQuota("claude-test", { cacheDir, readToken: signedIn, now: () => 30 * MIN, fetchImpl: usageResponse(200, fiveHour(50)) }, { force: true })
    assert.equal(back.windows[0]?.usedPercent, 50)
    assert.equal(back.detail, undefined)
  })
}))

// ---- The configured route: a proxy or an environment token (resolveConfiguredRoute) ----

async function withSettings(env: Record<string, string> | undefined, run: (configDir: string) => Promise<void>) {
  const configDir = await mkdtemp(join(tmpdir(), "frizz-route-config-"))
  try {
    if (env) await writeFile(join(configDir, "settings.json"), JSON.stringify({ env }))
    await run(configDir)
  } finally {
    await rm(configDir, { recursive: true, force: true })
  }
}

test("configured route: the usage request goes where Claude Code's own requests go, with the credential it would send", async () => {
  // A proxy's installer writes the pair into Claude Code's user settings; a base with a path keeps it.
  await withSettings({ ANTHROPIC_BASE_URL: "https://proxy.example/anthropic/", ANTHROPIC_AUTH_TOKEN: "placeholder" }, async (dir) => {
    const route = await resolveConfiguredRoute(dir, {})
    assert.equal(route?.url, "https://proxy.example/anthropic/api/oauth/usage")
    assert.deepEqual(route?.headers, { Authorization: "Bearer placeholder" })
    assert.doesNotMatch(route?.fingerprint ?? "", /placeholder/)
    // The settings' pair wins over the environment's, as it does for Claude Code (measured).
    const both = await resolveConfiguredRoute(dir, { ANTHROPIC_BASE_URL: "http://127.0.0.1:9", ANTHROPIC_AUTH_TOKEN: "other" })
    assert.equal(both?.url, route?.url)
    assert.deepEqual(both?.headers, route?.headers)
  })
  await withSettings(undefined, async (dir) => {
    const route = (env: NodeJS.ProcessEnv) => resolveConfiguredRoute(dir, env)
    // An API-key placeholder rides in Claude Code's API-key header, to the proxy.
    assert.deepEqual((await route({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8080", ANTHROPIC_API_KEY: "placeholder" }))?.headers, { "x-api-key": "placeholder" })
    // The gateway bearer outranks the others, as in Claude Code's own order.
    assert.deepEqual((await route({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8080", ANTHROPIC_API_KEY: "k", ANTHROPIC_AUTH_TOKEN: "b", CLAUDE_CODE_OAUTH_TOKEN: "o" }))?.headers, { Authorization: "Bearer b" })
    // A `claude setup-token` token with no proxy goes to Anthropic itself.
    const direct = await route({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-direct" })
    assert.equal(direct?.url, "https://api.anthropic.com/api/oauth/usage")
    assert.deepEqual(direct?.headers, { Authorization: "Bearer sk-ant-oat01-direct" })
    // A credential change is a new route.
    assert.notEqual((await route({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-other" }))?.fingerprint, direct?.fingerprint)
    // NO ROUTE: nothing configured; a Console key sent to Anthropic itself (no plan behind it); a cloud
    // provider; an address that is not one.
    for (const env of [
      {},
      { ANTHROPIC_API_KEY: "sk-ant-api03-real" },
      { ANTHROPIC_BASE_URL: "https://api.anthropic.com", ANTHROPIC_API_KEY: "sk-ant-api03-real" },
      { CLAUDE_CODE_USE_BEDROCK: "1", ANTHROPIC_AUTH_TOKEN: "b" },
      { ANTHROPIC_BASE_URL: "not a url", ANTHROPIC_AUTH_TOKEN: "b" },
      { ANTHROPIC_BASE_URL: "file:///etc/passwd", ANTHROPIC_AUTH_TOKEN: "b" },
      { ANTHROPIC_BASE_URL: "http://127.0.0.1:8080" },
    ]) assert.equal(await route(env), undefined, JSON.stringify(env))
  })
})

test("claude quota: with no readable token, the configured route is asked — never Claude Code — and a route that fails backs off", () => withCache(async (cacheDir) => {
  await withSettings({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8787", ANTHROPIC_AUTH_TOKEN: "placeholder" }, async (configDir) => {
    const requests: Array<{ url: string; auth: string | null }> = []
    let answer: () => Response = () => new Response("", { status: 404 })
    let starts = 0
    const deps = (now: number, env: NodeJS.ProcessEnv = {}) => ({
      cacheDir,
      readToken: signedOut,
      readRoute: () => resolveConfiguredRoute(configDir, env),
      now: () => now,
      execUsage: async () => { starts++; return "" },
      fetchImpl: (async (url: string, init?: RequestInit) => {
        requests.push({ url, auth: new Headers(init?.headers).get("authorization") })
        return answer()
      }) as unknown as typeof fetch,
    })
    // A proxy that does not forward the usage path: the chip polls every 30s for 20 minutes.
    for (let t = 0; t <= 20 * MIN; t += 30 * SEC) {
      assert.equal((await readClaudeQuota("claude-test", deps(t))).status, "unavailable")
      await claudeQuotaRefreshSettled()
    }
    assert.deepEqual(requests.map((r) => r.url), Array(3).fill("http://127.0.0.1:8787/api/oauth/usage"), "asked at 0, 5m and 15m: one request per window, the window doubling")
    assert.ok(requests.every((r) => r.auth === "Bearer placeholder"), "carrying exactly what Claude Code sends")
    assert.equal(starts, 0, "Claude Code cannot repair a credential it was handed, so it is never started")

    // A changed configuration is asked at once, and a proxy that forwards the path is a reading.
    answer = () => new Response(JSON.stringify(fiveHour(30)), { status: 200 })
    await withSettings({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8787", ANTHROPIC_AUTH_TOKEN: "placeholder-2" }, async (fixed) => {
      const q = await readClaudeQuota("claude-test", { ...deps(20 * MIN + 31 * SEC), readRoute: () => resolveConfiguredRoute(fixed, {}) })
      assert.equal(q.status, "ok")
      assert.equal(q.windows[0]?.usedPercent, 30)
      assert.equal(requests.length, 4)
      assert.equal(requests[3]?.auth, "Bearer placeholder-2")
    })
    // A refusal from the proxy (its credential, not one Claude Code could refresh) is a route failure too.
    answer = () => new Response("", { status: 401 })
    const refused = await readClaudeQuota("claude-test", { ...deps(30 * MIN), readRoute: () => resolveConfiguredRoute(configDir, {}) }, { force: true })
    assert.equal(refused.status, "ok", "the last good reading rides")
    assert.equal(refused.detail, "Could not refresh · last updated 9m ago")
    assert.equal(starts, 0)
  })
}))

test("claude quota: a token Frizz can read is still the first source — the configured route is not consulted", () => withCache(async (cacheDir) => {
  let routeAsked = 0
  const q = await readClaudeQuota("claude-test", {
    cacheDir,
    readToken: signedIn,
    readRoute: async () => { routeAsked++; return undefined },
    now: () => 0,
    fetchImpl: usageResponse(200, fiveHour(12)),
  })
  assert.equal(q.status, "ok")
  assert.equal(routeAsked, 0)
}))
