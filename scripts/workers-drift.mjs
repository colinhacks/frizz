// Fails when the frizz.sh Workers run anything that `.github/workflows/workers-deploy.yml` did not
// upload. `.github/workflows/workers-drift.yml` runs it every 30 minutes, and a failed scheduled run
// is the alarm: GitHub emails it.
//
// WHY IT EXISTS. From 2026-09-21 to 2026-10-08 an attacker holding a Cloudflare API token replaced
// both Workers with backdoored builds of our own source, and nothing noticed for seventeen days. The
// Workers now deploy from CI only, so every upload that did not come from CI is by definition wrong,
// and this is the check that says so.
//
// WHAT COUNTS AS CI. Each check below is one an attacker holding a Cloudflare deploy token must pass:
//
// - The message. CI deploys with `--message "ci:<sha> run:<run id>"`, which wrangler stamps on the
//   version AND the deployment. Anyone with a token can type that, so on its own it proves nothing;
//   what it buys is the run id for the next check.
// - The run. The named run must exist in THIS repository, be a `workflow_dispatch` of
//   workers-deploy.yml on main at the named sha, have FINISHED and succeeded on its first attempt,
//   carry an approval on the `workers-deploy` environment, and the upload must fall inside its Deploy
//   step. Until 2026-11-05 any run that was merely live counted, so an upload stamped with a run still
//   waiting for approval, or one later cancelled, passed. A Cloudflare token cannot create a GitHub
//   run, and a replayed message lands outside the step. A drift run that fires during a real deploy
//   therefore fails once, because that deploy has not finished yet.
// - The author. Every version records who uploaded it. CI uploads with an account-owned token that
//   nothing else holds, and such a token uploads as its own id with no address (seen on the first CI
//   deploy, 2026-11-06), so its author differs from any laptop's. A deploy token lasts one hour, so each
//   deploy has a new author: `cloudflare-tokens.mjs` adds each id it mints to `WORKERS_CI_AUTHOR` (a
//   repository variable, a comma-separated list). Unset, the check fails and prints the authors it saw.
// - The source. `metadata.source` must be `wrangler`. Weak — an attacker uses wrangler too — but a
//   dashboard edit or a raw API upload fails it for free.
//
// WHAT IT CANNOT CATCH. A genuine CI run of bad code passes every check here, and so does anyone who can
// dispatch and approve one. This is detection, not the gate.
//
// THE WHOLE ACCOUNT, compared with BASELINE below. Everything a deploy token or a dashboard login can
// change without uploading to these two Workers: a third Worker with a more specific route, a custom
// domain or a DNS record on a board's name, a tail or Logpush attached to a Worker, a secret, a custom
// ruleset, a new member. Changing any of those on purpose means changing BASELINE in the same commit.
// API tokens are not on the list, so each sitting's `cloudflare-tokens.mjs --audit` reads those.
//
// A NAME THE MAINTAINER'S DEVICES TRUST, in BASELINE.claims with the public key that owns it. A write to
// the registry re-points a name to another board and leaves no version and no audit event, so this asks
// the registrar who owns it. That needs no token, and drift's own can't read KV: an account-owned token
// gets 401 there (2026-11-06). A new key on the board means changing BASELINE in the same commit.
//
// A MEMBER'S OWN TOKEN is what this most has to catch. The one Keyward holds has been unable to upload,
// tail or write KV since 2026-11-06, but a member can make one in the dashboard that can, with no reviewer,
// so an upload by a member must fail however it is stamped: CI's token belongs to the account, and a
// version authored by a member's address did not come from CI, whatever WORKERS_CI_AUTHOR says. A tail
// leaves no version, so it, and every other change CI would not make, is read from the audit log.
//
// WHAT IT READS. The ACTIVE deployment always (the newest; it serves 100% of traffic unless a split
// names two versions, and then both are checked), plus every deployment and every version created in
// the last LOOKBACK. The lookback is what catches an attacker who deploys and rolls back between two
// runs, and an upload that was never deployed. It is wider than the schedule because GitHub delays
// and drops scheduled runs under load.
//
// A legitimate `wrangler secret put` or dashboard edit fails this too: each one creates a version and
// a deployment that CI did not make, and nothing here can tell the maintainer from an attacker. That
// is the point. Re-run the deploy workflow afterwards; the alarm clears once the CI deployment is
// active and the stray one has aged out of the lookback.
//
// Anything it cannot read — a missing or revoked token, a Cloudflare or GitHub error — also fails the
// run. A check that cannot see must not go green.
//
//   CLOUDFLARE_READ_TOKEN=… GITHUB_TOKEN=… GITHUB_REPOSITORY=colinhacks/frizz \
//     WORKERS_CI_AUTHOR=… node scripts/workers-drift.mjs [frizz-relay] [frizz-registrar]

import { createHash } from "node:crypto"
import { pathToFileURL } from "node:url"

export const ACCOUNT_ID = "dde3ec1f6b1f0a397ea82a9ed322f5ce"
export const WORKERS = ["frizz-relay", "frizz-registrar"]
export const DEPLOY_WORKFLOW = ".github/workflows/workers-deploy.yml"
export const DEPLOY_ENVIRONMENT = "workers-deploy"
// The step of that workflow that uploads. Renaming it there fails every deploy's check here.
export const DEPLOY_STEP = "Deploy"
export const LOOKBACK_MS = 2 * 60 * 60 * 1000
export const CLAIMS_NAMESPACE = "aa4a9c11473d4511a556e3e3a6857058"
export const REGISTRAR = "https://registrar.frizz.sh"
// A claim lapses 30 days after its last renewal, and then anyone can have the name.
const CLAIM_RENEWAL_ALARM_MS = 25 * 24 * 60 * 60 * 1000
// Cloudflare's and GitHub's clocks, and the gap between the run starting and wrangler's first call.
const SKEW_MS = 2 * 60 * 1000
const CI_MESSAGE = /^ci:([0-9a-f]{40}) run:(\d+)$/

const hashEmail = (email) => createHash("sha256").update(String(email).trim().toLowerCase()).digest("hex")
// This repository's Actions logs are public, and a member's address is the login to this account.
const maskEmail = (email) => (email ? String(email).replace(/^(.).*@/, "$1***@") : "-")

// What the account should hold, read from it on 2026-11-05. Member addresses are hashed because this
// repository and its run logs are public.
export const BASELINE = {
  zone: "frizz.sh",
  plan: "Free Website",
  members: [hashEmail("colin@pullfrog.com")],
  routes: { "*.frizz.sh/*": "frizz-relay", "registrar.frizz.sh/*": "frizz-registrar" },
  domains: { "registrar.frizz.sh": "frizz-registrar" },
  dns: ["A frizz.sh 76.76.21.21", "A www.frizz.sh 76.76.21.21", "AAAA *.frizz.sh 100::", "AAAA registrar.frizz.sh 100::"],
  workers: {
    "frizz-relay": {
      bindings: ["durable_object_namespace BOARD Board", "kv_namespace CLAIMS aa4a9c11473d4511a556e3e3a6857058", "plain_text FRIZZ_ZONE frizz.sh"],
      crons: [],
    },
    "frizz-registrar": {
      bindings: ["kv_namespace CLAIMS aa4a9c11473d4511a556e3e3a6857058", "plain_text FRIZZ_ZONE frizz.sh"],
      crons: ["17 4 * * *"],
    },
  },
  claims: {},
}

/** The sha and run id a CI deploy stamps, or null for any other message. */
export function parseCiMessage(message) {
  const match = CI_MESSAGE.exec(message ?? "")
  return match ? { sha: match[1], runId: match[2] } : null
}

/** GET a Cloudflare API path and unwrap `result`; throws on any error, so the run fails. */
export function cloudflareClient(token, { base = "https://api.cloudflare.com/client/v4" } = {}) {
  return async (path) => {
    const response = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } })
    const body = await response.json().catch(() => null)
    if (!response.ok || !body?.success) {
      const errors = (body?.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ")
      throw new Error(`Cloudflare ${path}: HTTP ${response.status}${errors ? ` (${errors})` : ""}`)
    }
    return body.result
  }
}

/** Asks the registrar who owns a name: its public key and last renewal, or null for no row. Throws on anything else. */
export function claimReader({ base = REGISTRAR } = {}) {
  return async (name) => {
    const response = await fetch(`${base}/claim/${encodeURIComponent(name)}`)
    if (response.status === 404) {
      await response.body?.cancel()
      return null
    }
    if (!response.ok) throw new Error(`the registrar on ${name}: HTTP ${response.status}`)
    return response.json()
  }
}

/** GET a GitHub API path; null on 404 (a run that does not exist is a finding, not an error). */
export function githubClient(token, { base = "https://api.github.com" } = {}) {
  return async (path) => {
    const response = await fetch(`${base}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    })
    if (response.status === 404) {
      await response.body?.cancel()
      return null
    }
    if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`)
    return response.json()
  }
}

/** The authors `WORKERS_CI_AUTHOR` names. */
export const parseAuthors = (value) => String(value ?? "").split(",").map((author) => author.trim()).filter(Boolean)

/**
 * Every problem with one Worker, as sentences; an empty list means everything it runs came from CI.
 * `cf` and `gh` take an API path and return the parsed body (see the two clients above).
 */
export async function checkWorker(script, { cf, gh, repo, expectedAuthors = [], members = BASELINE.members, now = Date.now(), lookbackMs = LOOKBACK_MS, log = () => {} }) {
  const problems = []
  const answers = new Map()
  const since = now - lookbackMs
  const base = `/accounts/${ACCOUNT_ID}/workers/scripts/${script}`

  const ask = (path) => {
    if (!answers.has(path)) answers.set(path, gh(path))
    return answers.get(path)
  }

  // Why `message` stamped at `createdOn` is not a CI upload, or null when it is.
  const notFromCi = async (message, createdOn) => {
    const ci = parseCiMessage(message)
    if (!ci) return `its message ${JSON.stringify(message ?? "")} is not a CI deploy's`
    const runPath = `/repos/${repo}/actions/runs/${ci.runId}`
    const run = await ask(runPath)
    if (!run) return `it names run ${ci.runId}, which does not exist in ${repo}`
    const path = String(run.path ?? "").split("@")[0]
    if (path !== DEPLOY_WORKFLOW) return `it names run ${ci.runId}, which is ${path || "an unknown workflow"}, not ${DEPLOY_WORKFLOW}`
    if (run.event !== "workflow_dispatch") return `it names run ${ci.runId}, which was started by ${run.event}, not a dispatch`
    if (run.head_branch !== "main") return `it names run ${ci.runId}, which ran on ${run.head_branch}, not main`
    if (run.head_sha !== ci.sha) return `it names ${ci.sha} but run ${ci.runId} ran ${run.head_sha}`
    if (run.status !== "completed" || run.conclusion !== "success") {
      return `it names run ${ci.runId}, which is ${run.status}${run.conclusion ? `/${run.conclusion}` : ""}, not a finished, successful deploy`
    }
    // A re-run reopens an old run, so it could lend a months-old approval to a new upload.
    if (run.run_attempt !== 1) return `it names run ${ci.runId}, on attempt ${run.run_attempt}; only a first attempt counts`
    const approvals = (await ask(`${runPath}/approvals`)) ?? []
    const approved = approvals.some((a) => a.state === "approved" && (a.environments ?? []).some((e) => e.name === DEPLOY_ENVIRONMENT))
    if (!approved) return `it names run ${ci.runId}, which nobody approved on ${DEPLOY_ENVIRONMENT}`
    const jobs = (await ask(`${runPath}/jobs`))?.jobs ?? []
    const step = jobs.flatMap((job) => job.steps ?? []).find((s) => s.name === DEPLOY_STEP && s.conclusion === "success")
    if (!step) return `it names run ${ci.runId}, whose ${DEPLOY_STEP} step did not succeed`
    const at = Date.parse(createdOn)
    if (!(at >= Date.parse(step.started_at) - SKEW_MS && at <= Date.parse(step.completed_at) + SKEW_MS)) {
      return `it was created at ${createdOn}, outside the ${DEPLOY_STEP} step of run ${ci.runId} (${step.started_at} to ${step.completed_at}) — a replayed message`
    }
    return null
  }

  // Independent of WORKERS_CI_AUTHOR on purpose, so that a variable set to the wrong author passes nothing.
  const byMember = (email) => Boolean(email) && members.includes(hashEmail(email))

  const checkedVersions = new Set()
  const checkVersion = async (id, why) => {
    if (checkedVersions.has(id)) return
    checkedVersions.add(id)
    const version = await cf(`${base}/versions/${id}`)
    const meta = version.metadata ?? {}
    const message = version.annotations?.["workers/message"]
    log(`  version ${id} (${why}): created ${meta.created_on}, source ${meta.source}, author_id ${meta.author_id ?? "-"}, author_email ${maskEmail(meta.author_email)}, message ${JSON.stringify(message ?? "")}`)
    const label = `${script} version ${id} (${why}, created ${meta.created_on})`
    const reason = await notFromCi(message, meta.created_on)
    if (reason) problems.push(`${label}: ${reason}`)
    if (meta.source !== "wrangler") problems.push(`${label}: uploaded from ${meta.source ?? "an unknown source"}, not wrangler`)
    if (expectedAuthors.length === 0) {
      problems.push(`${label}: WORKERS_CI_AUTHOR is not set, so its author (author_id ${meta.author_id ?? "-"}, author_email ${maskEmail(meta.author_email)}) cannot be checked`)
    } else if (!expectedAuthors.includes(meta.author_id) && !expectedAuthors.includes(meta.author_email)) {
      problems.push(`${label}: uploaded by author_id ${meta.author_id ?? "-"} / author_email ${maskEmail(meta.author_email)}, which is none of the CI tokens in WORKERS_CI_AUTHOR`)
    }
    if (byMember(meta.author_email)) problems.push(`${label}: uploaded by an account member's own sign-in or token, and CI's token belongs to the account`)
  }

  const { deployments = [] } = await cf(`${base}/deployments`)
  const newestFirst = [...deployments].sort((a, b) => Date.parse(b.created_on) - Date.parse(a.created_on))
  if (newestFirst.length === 0) problems.push(`${script}: Cloudflare lists no deployments at all`)
  for (const [index, deployment] of newestFirst.entries()) {
    const active = index === 0
    if (!active && Date.parse(deployment.created_on) < since) continue
    const why = active ? "active" : "recent"
    const message = deployment.annotations?.["workers/message"]
    log(`${script} deployment ${deployment.id} (${why}): created ${deployment.created_on}, author ${maskEmail(deployment.author_email)}, message ${JSON.stringify(message ?? "")}`)
    const reason = await notFromCi(message, deployment.created_on)
    if (reason) problems.push(`${script} deployment ${deployment.id} (${why}, created ${deployment.created_on}): ${reason}`)
    if (byMember(deployment.author_email)) problems.push(`${script} deployment ${deployment.id} (${why}, created ${deployment.created_on}): made by an account member's own sign-in or token, and CI's token belongs to the account`)
    for (const { version_id: id } of deployment.versions ?? []) await checkVersion(id, `in the ${why} deployment`)
  }

  // An upload that was never deployed serves nothing on frizz.sh, but it is still an upload CI did
  // not make — and the step before a deploy.
  for (let page = 1; page <= 20; page++) {
    const { items = [] } = await cf(`${base}/versions?page=${page}&per_page=50`)
    for (const item of items) {
      if (Date.parse(item.metadata?.created_on) >= since) await checkVersion(item.id, "uploaded recently")
    }
    if (items.length < 50) break
  }

  return problems
}

const AUDIT_PAGE = 1000
// checkWorker judges these by the version or deployment each one made, so the log has nothing to add.
const JUDGED_BY_VERSION = new Set(["script_update", "script_deploy"])

/**
 * Every change in the audit log that nothing else here judges, as sentences. Nobody but CI changes this
 * account in the ordinary run of things, so anything else is an alarm for as long as it is in the lookback,
 * whoever did it. A tail above all: it changes no version and no setting, and it streams each request's URL
 * and headers, which are the relay's cookies and access codes, so this log is its only record. Cloudflare's
 * own events (certificate renewals) read `system`. Nothing about the actor is printed: these logs are public.
 */
export function auditLogProblems(events) {
  const problems = []
  if (events.length >= AUDIT_PAGE) problems.push(`the audit log's page is full at ${AUDIT_PAGE} events, so a change could be past the end of it`)
  for (const event of events) {
    const type = event.action?.type
    if (event.actor?.type === "system" || JUDGED_BY_VERSION.has(type)) continue
    const on = `${event.resource?.type ?? "unknown"} ${event.resource?.id ?? "-"}`
    if (type === "tail_logs_start") problems.push(`a tail was started on ${on} at ${event.when}, and a tail reads every request's cookies`)
    else problems.push(`the audit log shows ${type} on ${on} at ${event.when}, which CI does not do`)
  }
  return problems
}

// A Durable Object binding is named by its class, because its namespace id belongs to Cloudflare.
const bindingKey = (b) => [b.type, b.name, b.class_name ?? b.namespace_id ?? b.text].filter(Boolean).join(" ")

/**
 * Every way the account differs from `baseline`, as sentences; an empty list means it matches. A read
 * Cloudflare refuses throws, so a token that cannot see something fails the run instead of passing it.
 */
export async function checkAccount({ cf, baseline = BASELINE, accountId = ACCOUNT_ID, now = Date.now(), lookbackMs = LOOKBACK_MS }) {
  const problems = []
  const account = `/accounts/${accountId}`

  const since = new Date(now - lookbackMs).toISOString().replace(/\.\d{3}Z$/, "Z")
  problems.push(...auditLogProblems(await cf(`${account}/audit_logs?since=${since}&direction=desc&per_page=${AUDIT_PAGE}`)))

  const sameSet = (what, actual, expected) => {
    for (const item of actual) if (!expected.includes(item)) problems.push(`${what}: unexpected ${item}`)
    for (const item of expected) if (!actual.includes(item)) problems.push(`${what}: missing ${item}`)
  }
  const pairs = (map) => Object.entries(map).map(([from, to]) => `${from} -> ${to}`)

  const workers = Object.keys(baseline.workers)
  sameSet("Workers", (await cf(`${account}/workers/scripts`)).map((w) => w.id), workers)
  sameSet("custom domains", (await cf(`${account}/workers/domains`)).map((d) => `${d.hostname} -> ${d.service}`), pairs(baseline.domains))

  const members = await cf(`${account}/members?per_page=50`)
  const unexpected = members.map((m) => m.user?.email ?? m.email ?? "").filter((email) => !baseline.members.includes(hashEmail(email)))
  for (const email of unexpected) problems.push(`members: unexpected ${maskEmail(email)}`)
  if (members.length - unexpected.length !== baseline.members.length) problems.push(`members: ${members.length - unexpected.length} of the ${baseline.members.length} expected`)

  const zones = await cf(`/zones?name=${baseline.zone}&account.id=${accountId}`)
  if (zones.length !== 1) throw new Error(`expected one zone named ${baseline.zone}, found ${zones.length}`)
  const zone = `/zones/${zones[0].id}`
  // Snippets and other injection features need a paid plan, so a change of plan is the first sign of one.
  if (zones[0].plan?.name !== baseline.plan) problems.push(`${baseline.zone} is on plan ${zones[0].plan?.name}, not ${baseline.plan}`)
  sameSet("routes", (await cf(`${zone}/workers/routes`)).map((r) => `${r.pattern} -> ${r.script}`), pairs(baseline.routes))
  // Certificate renewals add and remove these TXT records by themselves, and a TXT record re-points nothing.
  const records = (await cf(`${zone}/dns_records?per_page=100`)).filter((r) => !(r.type === "TXT" && r.name.startsWith("_acme-challenge.")))
  sameSet("DNS", records.map((r) => `${r.type} ${r.name} ${r.content}`), baseline.dns)
  for (const ruleset of await cf(`${zone}/rulesets`)) {
    if (ruleset.kind === "managed") continue
    problems.push(`rulesets: unexpected ${ruleset.kind} ruleset ${JSON.stringify(ruleset.name)} in phase ${ruleset.phase}`)
  }

  for (const [script, expected] of Object.entries(baseline.workers)) {
    const base = `${account}/workers/scripts/${script}`
    const settings = await cf(`${base}/settings`)
    sameSet(`${script} bindings`, (settings.bindings ?? []).map(bindingKey), expected.bindings)
    if ((settings.tail_consumers ?? []).length) problems.push(`${script}: a tail consumer is attached: ${JSON.stringify(settings.tail_consumers)}`)
    if (settings.logpush) problems.push(`${script}: Logpush is on`)
    if (settings.observability?.enabled) problems.push(`${script}: observability is on, and it can record requests`)
    sameSet(`${script} secrets`, (await cf(`${base}/secrets`)).map((s) => s.name), [])
    sameSet(`${script} crons`, ((await cf(`${base}/schedules`)).schedules ?? []).map((c) => c.cron), expected.crons)
    const subdomain = await cf(`${base}/subdomain`)
    if (subdomain.enabled || subdomain.previews_enabled) problems.push(`${script}: it also answers on workers.dev`)
  }
  return problems
}

/** Every problem with the names in `pins` (name to owning public key), as sentences. */
export async function checkClaims({ read, pins = BASELINE.claims, now = Date.now() }) {
  const problems = []
  for (const [name, pubkey] of Object.entries(pins)) {
    const record = await read(name)
    if (!record) {
      problems.push(`${name}.${BASELINE.zone} has no row in the registry, so anyone can claim it`)
    } else if (record.pubkey !== pubkey) {
      problems.push(`${name}.${BASELINE.zone} is owned by key ${record.pubkey}, not ${pubkey}, so another board can serve it`)
    } else if (!(now - record.renewedAt < CLAIM_RENEWAL_ALARM_MS)) {
      problems.push(`${name}.${BASELINE.zone} was last renewed on ${new Date(Number(record.renewedAt) || 0).toISOString()} and lapses 30 days after that. Restarting Frizz renews it`)
    }
  }
  return problems
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { CLOUDFLARE_READ_TOKEN, GITHUB_TOKEN, GITHUB_REPOSITORY, WORKERS_CI_AUTHOR } = process.env
  for (const [name, value] of Object.entries({ CLOUDFLARE_READ_TOKEN, GITHUB_TOKEN, GITHUB_REPOSITORY })) {
    if (!value) {
      console.error(`::error::${name} is not set; the drift check cannot read anything, so it fails`)
      process.exit(1)
    }
  }
  const scripts = process.argv.slice(2).length ? process.argv.slice(2) : WORKERS
  const cf = cloudflareClient(CLOUDFLARE_READ_TOKEN)
  const gh = githubClient(GITHUB_TOKEN)
  let failed = false
  try {
    const problems = await checkAccount({ cf })
    if (problems.length === 0) console.log("✓ the account matches its baseline")
    for (const problem of problems) console.error(`::error::${problem}`)
    failed ||= problems.length > 0
  } catch (error) {
    console.error(`::error::the account: ${error.message}`)
    failed = true
  }
  try {
    const problems = await checkClaims({ read: claimReader() })
    for (const problem of problems) console.error(`::error::${problem}`)
    failed ||= problems.length > 0
  } catch (error) {
    console.error(`::error::the registry: ${error.message}`)
    failed = true
  }
  for (const script of scripts) {
    try {
      const problems = await checkWorker(script, { cf, gh, repo: GITHUB_REPOSITORY, expectedAuthors: parseAuthors(WORKERS_CI_AUTHOR), log: console.log })
      if (problems.length === 0) console.log(`✓ ${script}: everything it ran in the lookback came from ${DEPLOY_WORKFLOW}`)
      for (const problem of problems) console.error(`::error::${problem}`)
      failed ||= problems.length > 0
    } catch (error) {
      console.error(`::error::${script}: ${error.message}`)
      failed = true
    }
  }
  process.exit(failed ? 1 : 0)
}
