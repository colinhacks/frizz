import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { createServer } from "node:http"
import { test } from "node:test"
import { ACCOUNT_ID, auditLogProblems, BASELINE, checkAccount, checkClaims, checkWorker, claimReader, cloudflareClient, githubClient, parseAuthors, parseCiMessage } from "./workers-drift.mjs"

// The bodies below follow the shapes Cloudflare documents for
//   GET /accounts/{account_id}/workers/scripts/{script}/deployments
//   GET /accounts/{account_id}/workers/scripts/{script}/versions[/{version_id}]
// and GitHub's GET /repos/{owner}/{repo}/actions/runs/{run_id}[/jobs], cut down to the fields the check
// reads. They are NOT captured from the live account: nothing that wrote this held a read token. The
// first scheduled run is the one that meets the real API, and it fails loudly on any shape it
// cannot read rather than passing.

const REPO = "colinhacks/frizz"
const SHA = "6b6436701f2a3c4d5e6f708192a3b4c5d6e7f809"
const RUN = "18123456789"
const CI_AUTHOR = "4f1c2b3a9d8e7f60a1b2c3d4e5f60718"
const NOW = Date.parse("2026-10-09T12:00:00Z")
const base = `/accounts/${ACCOUNT_ID}/workers/scripts/frizz-relay`

const ciVersion = (id, created_on, overrides = {}) => ({
  id,
  number: 41,
  metadata: { author_id: CI_AUTHOR, author_email: "", created_on, modified_on: created_on, source: "wrangler", hasPreview: false },
  annotations: { "workers/message": `ci:${SHA} run:${RUN}`, "workers/triggered_by": "upload" },
  ...overrides,
})
const deployment = (id, created_on, versionIds, message = `ci:${SHA} run:${RUN}`, author_email = "") => ({
  id,
  created_on,
  source: "wrangler",
  strategy: "percentage",
  author_email,
  annotations: { "workers/message": message, "workers/triggered_by": "upload" },
  versions: versionIds.map((version_id) => ({ version_id, percentage: 100 / versionIds.length })),
})
const run = (overrides = {}) => ({
  id: Number(RUN),
  path: ".github/workflows/workers-deploy.yml",
  event: "workflow_dispatch",
  head_branch: "main",
  head_sha: SHA,
  status: "completed",
  conclusion: "success",
  run_attempt: 1,
  created_at: "2026-10-09T09:00:00Z",
  updated_at: "2026-10-09T09:04:00Z",
  ...overrides,
})

/** Fake `cf` and `gh` over fixed bodies; a path nobody recorded is a test bug, so it throws. */
const deployJobs = (overrides = {}) => ({
  jobs: [{
    name: "deploy",
    steps: [
      { name: "Test the Workers", conclusion: "success", started_at: "2026-10-09T09:02:00Z", completed_at: "2026-10-09T09:03:00Z" },
      { name: "Deploy", conclusion: "success", started_at: "2026-10-09T09:03:00Z", completed_at: "2026-10-09T09:03:50Z", ...overrides },
    ],
  }],
})

function apis({ deployments, versions, runs = { [RUN]: run() }, jobs = deployJobs() }) {
  const requested = []
  const cf = async (path) => {
    requested.push(path)
    if (path === `${base}/deployments`) return { deployments }
    const page = /\/versions\?page=(\d+)&per_page=50$/.exec(path)
    if (page) return { items: Number(page[1]) === 1 ? versions.map(({ annotations, ...item }) => item) : [] }
    const one = /\/versions\/([^/?]+)$/.exec(path)
    if (one) {
      const found = versions.find((v) => v.id === one[1])
      if (found) return found
    }
    throw new Error(`unrecorded Cloudflare path ${path}`)
  }
  const gh = async (path) => {
    const match = new RegExp(`^/repos/${REPO}/actions/runs/(\\d+)(/jobs)?$`).exec(path)
    if (!match) throw new Error(`unrecorded GitHub path ${path}`)
    if (match[2] === "/jobs") return jobs
    return runs[match[1]] ?? null
  }
  return { cf, gh, requested }
}

const check = (fixture, options = {}) => {
  const { cf, gh } = apis(fixture)
  return checkWorker("frizz-relay", { cf, gh, repo: REPO, expectedAuthors: [CI_AUTHOR], now: NOW, ...options })
}

const v1 = "11111111-1111-4111-8111-111111111111"
const v2 = "22222222-2222-4222-8222-222222222222"
const d1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const d2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

test("a CI message parses to its sha and run, and nothing else does", () => {
  assert.deepEqual(parseCiMessage(`ci:${SHA} run:${RUN}`), { sha: SHA, runId: RUN })
  for (const bad of [undefined, "", "Automatic deployment on upload.", `ci:${SHA.slice(0, 7)} run:${RUN}`, `ci:${SHA} run:${RUN} extra`, ` ci:${SHA} run:${RUN}`]) {
    assert.equal(parseCiMessage(bad), null, JSON.stringify(bad))
  }
})

test("a Worker running only what CI uploaded passes", async () => {
  const problems = await check({
    deployments: [deployment(d1, "2026-10-09T09:03:10Z", [v1])],
    versions: [ciVersion(v1, "2026-10-09T09:03:05Z")],
  })
  assert.deepEqual(problems, [])
})

test("a deploy from a laptop fails on its message and on its author", async () => {
  const laptop = ciVersion(v2, "2026-10-09T11:00:00Z", {
    metadata: { author_id: "e0c1d2b3a4f5", author_email: "someone@example.com", created_on: "2026-10-09T11:00:00Z", source: "wrangler" },
    annotations: { "workers/triggered_by": "upload" },
  })
  const problems = await check({
    deployments: [deployment(d2, "2026-10-09T11:00:02Z", [v2], "", "someone@example.com"), deployment(d1, "2026-10-09T09:03:10Z", [v1])],
    versions: [ciVersion(v1, "2026-10-09T09:03:05Z"), laptop],
  })
  assert.ok(problems.some((p) => p.includes(`deployment ${d2} (active`) && p.includes("is not a CI deploy's")), problems.join("\n"))
  assert.ok(problems.some((p) => p.includes(`version ${v2}`) && p.includes("s***@example.com") && p.includes("none of the CI tokens")), problems.join("\n"))
  assert.ok(!problems.join("\n").includes("someone@"), "a public log must not carry a member's address")
})

test("a forged CI message is caught by the run: replayed outside its window, wrong workflow, wrong sha, no such run", async () => {
  const forged = (runs, created = "2026-10-09T11:30:00Z") => check({
    deployments: [deployment(d1, created, [v1])],
    versions: [ciVersion(v1, created)],
    runs,
  })
  const replayed = await forged({ [RUN]: run() })
  assert.ok(replayed.some((p) => p.includes(`deployment ${d1}`) && p.includes("a replayed message")), replayed.join("\n"))
  assert.ok(replayed.some((p) => p.includes(`version ${v1}`) && p.includes("a replayed message")), replayed.join("\n"))

  const otherWorkflow = await forged({ [RUN]: run({ path: ".github/workflows/release.yml", updated_at: "2026-10-09T11:59:00Z" }) })
  assert.ok(otherWorkflow.some((p) => p.includes(".github/workflows/release.yml, not .github/workflows/workers-deploy.yml")), otherWorkflow.join("\n"))

  const otherSha = await forged({ [RUN]: run({ head_sha: "f".repeat(40), updated_at: "2026-10-09T11:59:00Z" }) })
  assert.ok(otherSha.some((p) => p.includes(`run ${RUN} ran ${"f".repeat(40)}`)), otherSha.join("\n"))

  const otherBranch = await forged({ [RUN]: run({ head_branch: "workers-deploy-ci", updated_at: "2026-10-09T11:59:00Z" }) })
  assert.ok(otherBranch.some((p) => p.includes("ran on workers-deploy-ci, not main")), otherBranch.join("\n"))

  const pushed = await forged({ [RUN]: run({ event: "push", updated_at: "2026-10-09T11:59:00Z" }) })
  assert.ok(pushed.some((p) => p.includes("started by push, not a dispatch")), pushed.join("\n"))

  const missing = await forged({})
  assert.ok(missing.some((p) => p.includes(`run ${RUN}, which does not exist in ${REPO}`)), missing.join("\n"))
})

test("a run only vouches for an upload once it has finished well and the upload is inside its Deploy step", async () => {
  const stamped = (fixture) => check({
    deployments: [deployment(d1, "2026-10-09T09:03:10Z", [v1])],
    versions: [ciVersion(v1, "2026-10-09T09:03:05Z")],
    ...fixture,
  })
  const refusedFor = async (fixture, reason) => {
    const problems = await stamped(fixture)
    assert.ok(problems.length > 0 && problems.every((p) => p.includes(reason)), `${reason}\n${problems.join("\n")}`)
  }
  await refusedFor({ runs: { [RUN]: run({ status: "waiting", conclusion: null }) } }, "waiting, not a finished")
  await refusedFor({ runs: { [RUN]: run({ status: "in_progress", conclusion: null }) } }, "in_progress, not a finished")
  await refusedFor({ runs: { [RUN]: run({ conclusion: "cancelled" }) } }, "completed/cancelled, not a finished")
  await refusedFor({ runs: { [RUN]: run({ conclusion: "failure" }) } }, "completed/failure, not a finished")
  await refusedFor({ runs: { [RUN]: run({ run_attempt: 2 }) } }, "on attempt 2")
  await refusedFor({ jobs: deployJobs({ conclusion: "skipped" }) }, "Deploy step did not succeed")
  await refusedFor({ jobs: { jobs: [] } }, "Deploy step did not succeed")
  // Inside the run, but long before the step that uploads.
  await refusedFor({ jobs: deployJobs({ started_at: "2026-10-09T09:30:00Z", completed_at: "2026-10-09T09:31:00Z" }) }, "a replayed message")
  // A path carrying a ref still names the workflow, and two minutes of clock skew either way is allowed.
  assert.deepEqual(await stamped({ runs: { [RUN]: run({ path: ".github/workflows/workers-deploy.yml@refs/heads/main" }) } }), [])
  assert.deepEqual(await stamped({ jobs: deployJobs({ started_at: "2026-10-09T09:04:30Z", completed_at: "2026-10-09T09:05:00Z" }) }), [])
})

test("a stray deploy that was rolled back still fails while it is inside the lookback, and stops once it is not", async () => {
  const stray = ciVersion(v2, "2026-10-09T11:10:00Z", {
    metadata: { author_id: "e0c1d2b3a4f5", author_email: "someone@example.com", created_on: "2026-10-09T11:10:00Z", source: "api" },
    annotations: {},
  })
  const fixture = {
    deployments: [
      deployment(d1, "2026-10-09T11:20:00Z", [v1], "Rollback to CI", ""),
      deployment(d2, "2026-10-09T11:10:05Z", [v2], "", "someone@example.com"),
    ],
    versions: [ciVersion(v1, "2026-10-09T09:03:05Z"), stray],
  }
  const recent = await check(fixture)
  assert.ok(recent.some((p) => p.includes(`deployment ${d2} (recent`)), recent.join("\n"))
  assert.ok(recent.some((p) => p.includes(`version ${v2}`) && p.includes("uploaded from api, not wrangler")), recent.join("\n"))
  // The rollback itself is a deployment CI did not make, even though the version it points at is CI's.
  assert.ok(recent.some((p) => p.includes(`deployment ${d1} (active`)), recent.join("\n"))
  assert.ok(!recent.some((p) => p.includes(`version ${v1}`)), recent.join("\n"))

  const later = await check(fixture, { now: Date.parse("2026-10-09T14:00:00Z") })
  assert.ok(!later.some((p) => p.includes(d2) || p.includes(v2)), later.join("\n"))
})

test("an upload that was never deployed is an alarm too", async () => {
  const problems = await check({
    deployments: [deployment(d1, "2026-10-09T09:03:10Z", [v1])],
    versions: [ciVersion(v1, "2026-10-09T09:03:05Z"), ciVersion(v2, "2026-10-09T11:40:00Z", { annotations: { "workers/message": "test" } })],
  })
  assert.deepEqual(problems.length, 1, problems.join("\n"))
  assert.match(problems[0], new RegExp(`version ${v2} \\(uploaded recently`))
})

test("both versions of a split deployment are checked", async () => {
  const other = ciVersion(v2, "2026-10-09T08:00:00Z", { annotations: {} })
  const problems = await check({
    deployments: [deployment(d1, "2026-10-09T09:03:10Z", [v1, v2])],
    versions: [ciVersion(v1, "2026-10-09T09:03:05Z"), other],
  })
  assert.ok(problems.some((p) => p.includes(`version ${v2} (in the active deployment`)), problems.join("\n"))
})

test("with WORKERS_CI_AUTHOR unset it fails, and says which author it saw", async () => {
  const problems = await check({
    deployments: [deployment(d1, "2026-10-09T09:03:10Z", [v1])],
    versions: [ciVersion(v1, "2026-10-09T09:03:05Z")],
  }, { expectedAuthors: [] })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /WORKERS_CI_AUTHOR is not set/)
  assert.ok(problems[0].includes(CI_AUTHOR))
})

test("every deploy token in WORKERS_CI_AUTHOR counts, so the last deploy passes until the next one replaces it", async () => {
  const fixture = {
    deployments: [deployment(d1, "2026-10-09T09:03:10Z", [v1])],
    versions: [ciVersion(v1, "2026-10-09T09:03:05Z")],
  }
  assert.deepEqual(await check(fixture, { expectedAuthors: parseAuthors(`${CI_AUTHOR},newer-token`) }), [])
  assert.deepEqual(await check(fixture, { expectedAuthors: parseAuthors(`older-token, ${CI_AUTHOR}`) }), [])
  const problems = await check(fixture, { expectedAuthors: parseAuthors("older-token,newer-token") })
  assert.equal(problems.length, 1)
  assert.ok(problems[0].includes(CI_AUTHOR), problems[0])
})

test("an empty WORKERS_CI_AUTHOR names no author", () => {
  for (const value of [undefined, "", " , "]) assert.deepEqual(parseAuthors(value), [])
})

test("an author email matches as well as an author id", async () => {
  const problems = await check({
    deployments: [deployment(d1, "2026-10-09T09:03:10Z", [v1])],
    versions: [ciVersion(v1, "2026-10-09T09:03:05Z", { metadata: { author_id: "x", author_email: "ci@example.com", created_on: "2026-10-09T09:03:05Z", source: "wrangler" } })],
  }, { expectedAuthors: ["ci@example.com"] })
  assert.deepEqual(problems, [])
})

test("an upload by a member's own token fails however it is stamped, even with WORKERS_CI_AUTHOR set to that member", async () => {
  const member = "owner@example.com"
  const members = [createHash("sha256").update(member).digest("hex")]
  const mine = { author_id: "user1234", author_email: member, created_on: "2026-10-09T09:03:05Z", source: "wrangler" }
  // A forged stamp of a real, finished run, inside its Deploy step: the only thing left to go on is who uploaded.
  const fixture = {
    deployments: [deployment(d1, "2026-10-09T09:03:10Z", [v1], `ci:${SHA} run:${RUN}`, member)],
    versions: [ciVersion(v1, "2026-10-09T09:03:05Z", { metadata: mine })],
  }
  const lines = []
  const wrongVariable = await check(fixture, { expectedAuthors: ["user1234"], members, log: (line) => lines.push(line) })
  assert.ok(![...wrongVariable, ...lines].join("\n").includes(member), "these logs are public, and that address is the account's login")
  assert.ok(wrongVariable.some((p) => p.includes(`version ${v1}`) && p.includes("account member's own")), wrongVariable.join("\n"))
  assert.ok(wrongVariable.some((p) => p.includes(`deployment ${d1}`) && p.includes("account member's own")), wrongVariable.join("\n"))

  const rightVariable = await check(fixture, { members })
  assert.ok(rightVariable.some((p) => p.includes("user1234") && p.includes("none of the CI tokens")), rightVariable.join("\n"))

  // The control: the same upload by an address that is no member, with the variable naming it, passes.
  assert.deepEqual(await check(fixture, { expectedAuthors: ["user1234"], members: [] }), [])
})

test("a Worker with no deployments at all is a finding", async () => {
  const problems = await check({ deployments: [], versions: [] })
  assert.deepEqual(problems, ["frizz-relay: Cloudflare lists no deployments at all"])
})

/** A fake `cf` over an account that matches BASELINE, with `overrides` replacing an answer by path. */
function account(overrides = {}) {
  const a = `/accounts/${ACCOUNT_ID}`
  const z = "/zones/zone1"
  const script = (name, bindings, crons) => ({
    [`${a}/workers/scripts/${name}/settings`]: { bindings, tail_consumers: [], logpush: false },
    [`${a}/workers/scripts/${name}/secrets`]: [],
    [`${a}/workers/scripts/${name}/schedules`]: { schedules: crons.map((cron) => ({ cron })) },
    [`${a}/workers/scripts/${name}/subdomain`]: { enabled: false, previews_enabled: false },
  })
  const kv = { type: "kv_namespace", name: "CLAIMS", namespace_id: "aa4a9c11473d4511a556e3e3a6857058" }
  const zone = { type: "plain_text", name: "FRIZZ_ZONE", text: "frizz.sh" }
  const answers = {
    [`${a}/workers/scripts`]: [{ id: "frizz-relay" }, { id: "frizz-registrar" }],
    [`${a}/workers/domains`]: [{ hostname: "registrar.frizz.sh", service: "frizz-registrar" }],
    [`${a}/members?per_page=50`]: [{ user: { email: "Colin@pullfrog.com" } }],
    [`/zones?name=frizz.sh&account.id=${ACCOUNT_ID}`]: [{ id: "zone1", plan: { name: "Free Website" } }],
    [`${z}/workers/routes`]: [{ pattern: "*.frizz.sh/*", script: "frizz-relay" }, { pattern: "registrar.frizz.sh/*", script: "frizz-registrar" }],
    [`${z}/dns_records?per_page=100`]: [
      { type: "A", name: "frizz.sh", content: "76.76.21.21" },
      { type: "A", name: "www.frizz.sh", content: "76.76.21.21" },
      { type: "AAAA", name: "*.frizz.sh", content: "100::" },
      { type: "AAAA", name: "registrar.frizz.sh", content: "100::" },
      { type: "TXT", name: "_acme-challenge.frizz.sh", content: "renewal" },
    ],
    [`${z}/rulesets`]: [{ kind: "managed", name: "Cloudflare Managed Free Ruleset", phase: "http_request_firewall_managed" }],
    ...script("frizz-relay", [{ type: "durable_object_namespace", name: "BOARD", class_name: "Board", namespace_id: "f56284c028544a1582161e1e2b6f3c52" }, kv, zone], []),
    ...script("frizz-registrar", [kv, zone], ["17 4 * * *"]),
    ...overrides,
  }
  return async (path) => {
    if (path.startsWith(`${a}/audit_logs?`)) return answers.audit ?? []
    if (!(path in answers)) throw new Error(`unrecorded Cloudflare path ${path}`)
    const answer = answers[path]
    if (answer instanceof Error) throw answer
    return answer
  }
}

test("an account that matches its baseline has no problems", async () => {
  assert.deepEqual(await checkAccount({ cf: account() }), [])
})

test("anything that re-points a board's name or copies its traffic without an upload is an alarm", async () => {
  const a = `/accounts/${ACCOUNT_ID}`
  const relay = `${a}/workers/scripts/frizz-relay`
  const flagged = async (overrides, expected) => {
    const problems = await checkAccount({ cf: account(overrides) })
    assert.ok(problems.some((p) => p.includes(expected)), `${expected}\n${problems.join("\n")}`)
  }
  await flagged({ [`${a}/workers/scripts`]: [{ id: "frizz-relay" }, { id: "frizz-registrar" }, { id: "evil" }] }, "Workers: unexpected evil")
  await flagged({ "/zones/zone1/workers/routes": [{ pattern: "*.frizz.sh/*", script: "frizz-relay" }, { pattern: "registrar.frizz.sh/*", script: "frizz-registrar" }, { pattern: "colin.frizz.sh/*", script: "evil" }] }, "routes: unexpected colin.frizz.sh/* -> evil")
  await flagged({ "/zones/zone1/workers/routes": [{ pattern: "registrar.frizz.sh/*", script: "frizz-registrar" }] }, "routes: missing *.frizz.sh/* -> frizz-relay")
  await flagged({ [`${a}/workers/domains`]: [{ hostname: "registrar.frizz.sh", service: "frizz-registrar" }, { hostname: "colin.frizz.sh", service: "evil" }] }, "custom domains: unexpected colin.frizz.sh -> evil")
  await flagged({ "/zones/zone1/dns_records?per_page=100": [{ type: "CNAME", name: "colin.frizz.sh", content: "evil.example" }] }, "DNS: unexpected CNAME colin.frizz.sh evil.example")
  await flagged({ "/zones/zone1/rulesets": [{ kind: "zone", name: "default", phase: "http_custom_errors" }] }, "unexpected zone ruleset")
  await flagged({ [`/zones?name=frizz.sh&account.id=${ACCOUNT_ID}`]: [{ id: "zone1", plan: { name: "Pro Website" } }] }, "on plan Pro Website")
  await flagged({ [`${a}/members?per_page=50`]: [{ user: { email: "colin@pullfrog.com" } }, { user: { email: "attacker@example.com" } }] }, "members: unexpected a***@example.com")
  await flagged({ [`${a}/members?per_page=50`]: [] }, "members: 0 of the 1 expected")
  await flagged({ [`${relay}/settings`]: { bindings: [], tail_consumers: [{ service: "evil" }] } }, "a tail consumer is attached")
  await flagged({ [`${relay}/settings`]: { bindings: [], logpush: true } }, "Logpush is on")
  await flagged({ [`${relay}/settings`]: { bindings: [], observability: { enabled: true } } }, "observability is on")
  await flagged({ [`${relay}/settings`]: { bindings: [{ type: "service", name: "EVIL" }] } }, "frizz-relay bindings: unexpected service EVIL")
  await flagged({ [`${relay}/secrets`]: [{ name: "STOLEN" }] }, "frizz-relay secrets: unexpected STOLEN")
  await flagged({ [`${relay}/schedules`]: { schedules: [{ cron: "* * * * *" }] } }, "frizz-relay crons: unexpected * * * * *")
  await flagged({ [`${relay}/subdomain`]: { enabled: true } }, "it also answers on workers.dev")
})

test("a tail in the lookback is an alarm, because it changes nothing else the check can see", async () => {
  const asked = []
  const script = { type: "script", id: "frizz-relay" }
  const inner = account({ audit: [
    { when: "2026-10-09T11:30:00Z", actor: { type: "user" }, action: { type: "tail_logs_start" }, resource: script },
    { when: "2026-10-09T11:31:00Z", actor: { type: "user" }, action: { type: "logpush_create" }, resource: { type: "logpush", id: "7" } },
    { when: "2026-10-09T11:32:00Z", actor: { type: "user" }, action: { type: "script_update" }, resource: script },
    { when: "2026-10-09T11:33:00Z", actor: { type: "user" }, action: { type: "script_deploy" }, resource: script },
    { when: "2026-10-09T11:34:00Z", actor: { type: "system" }, action: { type: "create" }, resource: { type: "dns.record", id: "9" } },
    // An actor nobody has seen is not excused: only Cloudflare's own events are.
    { when: "2026-10-09T11:35:00Z", action: { type: "add_member" }, resource: { type: "account", id: "a" } },
  ] })
  const problems = await checkAccount({ cf: (path) => { asked.push(path); return inner(path) }, now: NOW })
  assert.deepEqual(problems, [
    "a tail was started on script frizz-relay at 2026-10-09T11:30:00Z, and a tail reads every request's cookies",
    "the audit log shows logpush_create on logpush 7 at 2026-10-09T11:31:00Z, which CI does not do",
    "the audit log shows add_member on account a at 2026-10-09T11:35:00Z, which CI does not do",
  ])
  assert.ok(asked.some((p) => p.includes("/audit_logs?since=2026-10-09T10:00:00Z&")), asked.join("\n"))
})

test("a full page of the audit log is an alarm, or a burst of noise would push a tail off it", () => {
  const noise = Array.from({ length: 1000 }, () => ({ actor: { type: "system" }, action: { type: "create" } }))
  assert.deepEqual(auditLogProblems(noise), ["the audit log's page is full at 1000 events, so a change could be past the end of it"])
  assert.deepEqual(auditLogProblems(noise.slice(1)), [])
})

test("a read the token is refused fails the run rather than passing it", async () => {
  const cf = account({ "/zones/zone1/workers/routes": new Error("Cloudflare /zones/zone1/workers/routes: HTTP 403") })
  await assert.rejects(checkAccount({ cf }), /HTTP 403/)
})

test("the baseline names both Workers the deploy workflow ships", () => {
  assert.deepEqual(Object.keys(BASELINE.workers).sort(), ["frizz-registrar", "frizz-relay"])
})

async function server(t, handler) {
  const s = createServer(handler)
  s.listen(0, "127.0.0.1")
  await once(s, "listening")
  t.after(() => new Promise((done) => { s.close(done); s.closeAllConnections() }))
  return `http://127.0.0.1:${s.address().port}`
}

test("the Cloudflare client sends the token, unwraps result, and throws on any failure", async (t) => {
  const seen = []
  const url = await server(t, (request, response) => {
    seen.push([request.url, request.headers.authorization])
    if (request.url === "/ok") return response.end(JSON.stringify({ success: true, errors: [], messages: [], result: { deployments: [] } }))
    if (request.url === "/denied") {
      response.writeHead(403)
      return response.end(JSON.stringify({ success: false, errors: [{ code: 10000, message: "Authentication error" }], messages: [], result: null }))
    }
    response.end(JSON.stringify({ success: false, errors: [{ code: 10007, message: "This Worker does not exist on your account." }], messages: [], result: null }))
  })
  const cf = cloudflareClient("read-token", { base: url })
  assert.deepEqual(await cf("/ok"), { deployments: [] })
  await assert.rejects(cf("/denied"), /HTTP 403 \(10000: Authentication error\)/)
  await assert.rejects(cf("/unsuccessful"), /HTTP 200 \(10007: This Worker does not exist/)
  assert.deepEqual(seen.map(([, auth]) => auth), ["Bearer read-token", "Bearer read-token", "Bearer read-token"])
})

test("the GitHub client returns null for a missing run and throws on anything else", async (t) => {
  const url = await server(t, (request, response) => {
    if (request.url.endsWith("/1")) return response.end(JSON.stringify(run()))
    response.writeHead(request.url.endsWith("/2") ? 404 : 500)
    response.end("{}")
  })
  const gh = githubClient("gh-token", { base: url })
  assert.equal((await gh(`/repos/${REPO}/actions/runs/1`)).head_sha, SHA)
  assert.equal(await gh(`/repos/${REPO}/actions/runs/2`), null)
  await assert.rejects(gh(`/repos/${REPO}/actions/runs/3`), /HTTP 500/)
})

const CLAIM_NOW = Date.parse("2026-11-06T12:00:00Z")
const claimCheck = (record) => checkClaims({ read: async () => record, pins: { colin: "good-key" }, now: CLAIM_NOW })
const daysAgo = (days) => CLAIM_NOW - days * 24 * 60 * 60 * 1000

test("a pinned name passes while its key owns it and its lease is fresh", async () => {
  assert.deepEqual(await claimCheck({ pubkey: "good-key", renewedAt: daysAgo(24) }), [])
})

test("a pinned name fails on another key, on no row, and before its lease lapses", async () => {
  assert.match((await claimCheck({ pubkey: "other-key", renewedAt: daysAgo(0) }))[0], /owned by key other-key, not good-key/)
  assert.match((await claimCheck(null))[0], /no row in the registry/)
  assert.match((await claimCheck({ pubkey: "good-key", renewedAt: daysAgo(26) }))[0], /Restarting Frizz renews it/)
  assert.match((await claimCheck({ pubkey: "good-key" }))[0], /lapses 30 days/, "a row with no date is not a fresh one")
})

test("the claim reader asks the registrar, parses an owner, is null on 404 and throws on anything else", async (t) => {
  const seen = []
  const server = createServer((req, res) => {
    seen.push([req.url, req.headers.authorization])
    if (req.url === "/claim/colin") return res.end(JSON.stringify({ pubkey: "k", renewedAt: 1 }))
    res.statusCode = req.url === "/claim/free" ? 404 : 500
    res.end("{}")
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => server.close())
  const read = claimReader({ base: `http://127.0.0.1:${server.address().port}` })
  assert.deepEqual(await read("colin"), { pubkey: "k", renewedAt: 1 })
  assert.equal(await read("free"), null)
  await assert.rejects(read("broken"), /HTTP 500/)
  assert.equal(seen[0][1], undefined, "it sends no credential")
})
