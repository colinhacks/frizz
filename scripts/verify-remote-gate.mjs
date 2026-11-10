#!/usr/bin/env nub
/**
 * What a remote session can reach, against the real proxy and the real app server.
 *
 * `remote-gate.test.ts` proves the table over one app in one process. It cannot prove the thing that
 * matters, which is the whole path: the stable launcher's `RestartSupervisorProxy` deciding a caller is
 * public and stamping it, the child's router resolving a name, and nothing on the way re-reading a header
 * the sender chose. So this boots a disposable stack with a scripted stand-in for Claude, puts a real proxy
 * in front of it, redeems a real access code, and asks for the things a stolen cookie would ask for.
 *
 * Every refusal has its control. The same call from loopback, and from a worker's direct path, has to
 * work, or a "refused" here could only mean the call was broken. The stand-in and the command watch both
 * write a marker when they run, so "nothing ran" is a file that isn't there, not a status code.
 *
 * Four parts, because there are two levels and more than one way in:
 *
 *  1. Read and answer, through the relay listener: the port the relay agent dials, and what a phone reaches.
 *  2. Full control, the same session through the same listener, once the owner has said so.
 *  3. A public origin with no relay (Tailscale, a tunnel, a proxy of the owner's): full control, nothing asked.
 *  4. The real relay Worker on workerd, with no certificate or Cloudflare account: a phone's dispatch starts a
 *     real worker process. `--no-workerd` leaves this one out.
 *
 *   env -u NODE_COMPAT nub scripts/verify-remote-gate.mjs [--shots=/abs/dir] [--keep] [--no-workerd]
 */
import { execFileSync, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer, request as httpRequest } from "node:http"
import { createServer as createTlsServer } from "node:tls"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { WebSocket } from "ws"
import { decodeBody, encodeBody, exportClaimPublicKey, generateClaimIdentity } from "@frizz/shared"
import { loadSessionState } from "@frizz/server/access-codes"
import { RestartSupervisorProxy } from "@frizz/server/restart-supervisor"
import { auditLogPathForStateDir, fileAuditLog } from "../packages/server/src/audit.ts"
import { buildClaudePermissionInteraction } from "../packages/server/src/backend/claude-permission-interactions.ts"
import { createInteractionStore } from "../packages/server/src/interaction-store.ts"
import { REMOTE_ACCESS } from "../packages/server/src/remote-gate.ts"
import Database from "../packages/server/src/sqlite.ts"
import { cloudConfigPath, writeCloudConfig } from "../src/cloud.ts"
import { serveRelayRequest, serveRelayWebSocket } from "../src/relay-agent.ts"
import { connectRelay } from "../src/relay-connection.ts"
import { launchHeadless } from "./lib/headless-browser.mjs"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const shots = flag("shots")
const keep = process.argv.includes("--keep")
const workerd = !process.argv.includes("--no-workerd")
// The stack runs with --prod, which serves the built web app. Without one every page answers 503, and that
// reads as 11 failures of the gate. A fresh worktree has none.
if (!existsSync(join(repo, "packages/web/dist"))) {
  console.error("No web build. Run `nub run build` in packages/web first.")
  process.exit(2)
}

const CHILD = 47_961
const VITE_CHILD = 47_962
const PROXY = 47_963
const WORKERD = 47_971
const HOST = "colin.frizz.test"
const ORIGIN = `https://${HOST}`
const EVIL = "evil.frizz.test"
const UA_PHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"
const sleep = (ms) => new Promise((done) => setTimeout(done, ms))

const results = []
const check = (name, ok, detail = "") => {
  results.push(ok)
  console.log(`${ok ? "  ok  " : " FAIL "} ${name}${detail ? ` — ${detail}` : ""}`)
}
const section = (name) => console.log(`\n${name}`)
const part = (name) => console.log(`\n\n══ ${name} ══`)

// ── A disposable machine: fake secrets, two projects, one stand-in for Claude ────────────────────────────
const home = realpathSync(mkdtempSync(join(tmpdir(), "frizz-remote-gate-")))
const markers = join(home, "markers")
const project = join(home, "work", "project")
const tenantDir = join(home, "work", "other")
const files = {
  sshKey: join(home, ".ssh", "id_ed25519"),
  sshPdf: join(home, ".ssh", "key.pdf"),
  sshPng: join(home, ".ssh", "key.png"),
  identity: join(home, ".frizz", "identity.key"),
  claude: join(home, ".claude", ".credentials.json"),
  codex: join(home, ".codex", "auth.json"),
  env: join(project, ".env"),
  envPdf: join(project, ".env.pdf"),
  gitConfig: join(project, ".git", "config"),
  serverPem: join(project, "server.pem"),
  linkOut: join(project, "docs", "looks-harmless.md"),
  linkOutPdf: join(project, "docs", "looks-harmless.pdf"),
}
const FAKE = "FAKE-SECRET-VALUE-remote-gate"
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64")
const write = (path, content, mode) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content, mode ? { mode } : undefined)
}
for (const [name, path] of Object.entries(files)) {
  if (name.startsWith("linkOut")) continue
  write(path, name === "sshPng" ? PNG : `${FAKE} ${name}\n`, 0o600)
}
write(join(project, "README.md"), "# Readable\n\nA document in a registered project.\n")
write(join(project, "report.pdf"), "%PDF-1.4\n% a stand-in the viewer never parses\n%%EOF\n")
write(join(tenantDir, "README.md"), "# Tenant\n")
write(join(tenantDir, ".env"), `${FAKE} tenant\n`)
mkdirSync(dirname(files.linkOut), { recursive: true })
symlinkSync(files.sshKey, files.linkOut)
symlinkSync(files.sshPdf, files.linkOutPdf)
mkdirSync(markers)

const WORKER_MARK = join(markers, "worker-started")
const standIn = join(home, "bin", "stand-in-claude.mjs")
write(standIn, `#!/usr/bin/env node
import { appendFileSync } from "node:fs"
if (!["auth", "--version", "-v", "--help", "mcp", "doctor"].includes(process.argv[2] ?? "")) appendFileSync(${JSON.stringify(WORKER_MARK)}, process.argv.slice(2).join(" ") + "\\n")
await import(${JSON.stringify(join(repo, "scripts/scripted-claude.mjs"))})
`, 0o755)
chmodSync(standIn, 0o755)

// A worker of the real board hands this shell its own `FRIZZ_*`, and a stack that inherits them answers as
// that thread. Nothing here may reach the real one, and no real provider gets the sandbox HOME.
const cleanEnv = () => {
  const env = { ...process.env, FRIZZ_WAKERS_OFF: "1" }
  for (const name of Object.keys(env)) {
    if ((name.startsWith("FRIZZ_") && name !== "FRIZZ_WAKERS_OFF") || name.startsWith("CLAUDE") || name === "NODE_COMPAT") delete env[name]
  }
  return env
}

const children = []
const startStack = async (port, stackHome, args) => {
  const child = spawn("nub", [join(repo, "scripts/adhoc-stack.mjs"), `--port=${port}`, `--home=${stackHome}`, `--claude-bin=${standIn}`, ...args], {
    cwd: repo, env: cleanEnv(), stdio: ["ignore", "pipe", "pipe"],
  })
  children.push(child)
  return new Promise((done, fail) => {
    let out = ""
    let err = ""
    const timer = setTimeout(() => fail(new Error(`the stack never answered:\n${err.slice(-800)}`)), 120_000)
    child.stderr.on("data", (d) => { err += d })
    child.once("exit", (code) => { clearTimeout(timer); fail(new Error(`the stack exited (${code}):\n${err.slice(-800)}`)) })
    child.stdout.on("data", (d) => {
      out += d
      const line = out.split("\n").find((l) => l.startsWith("{"))
      if (line) { clearTimeout(timer); done(JSON.parse(line)) }
    })
  })
}

const raw = (port, path, { host, cookie, method = "GET", origin, body, headers = {}, ua } = {}) => new Promise((done) => {
  const all = { host, ...headers }
  if (cookie) all.cookie = cookie
  if (origin) all.origin = origin
  if (ua) all["user-agent"] = ua
  if (body !== undefined) all["content-type"] = "application/json"
  // `agent: false`: a pooled socket outlives the proxy that this run restarts.
  const req = httpRequest({ host: "127.0.0.1", port, path, method, headers: all, setHost: false, agent: false }, (res) => {
    if (res.headers["content-type"]?.includes("event-stream")) { res.destroy(); done({ status: res.statusCode, headers: res.headers, text: "", sse: true }); return }
    const chunks = []
    res.on("data", (d) => chunks.push(d))
    res.on("end", () => done({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }))
  })
  req.on("error", (error) => done({ status: 0, headers: {}, text: error.code ?? "" }))
  req.end(body === undefined ? undefined : JSON.stringify(body))
})
const jsonOf = (response) => { try { return JSON.parse(response.text) } catch { return undefined } }
const inputQuery = (input) => input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`

/** One caller: how it reaches the board, and what it says about itself. `at` is a port, or says which one now. */
const caller = (at, base) => {
  const port = () => typeof at === "function" ? at() : at
  return {
    get: (path, extra) => raw(port(), path, { ...base, ...extra }),
    post: (path, body, extra) => raw(port(), path, { ...base, method: "POST", body, ...extra }),
    query: (name, input, prefix = "/_frizz") => raw(port(), `${prefix}/rpc/${name}${inputQuery(input)}`, base),
    mutate: (name, input, prefix = "/_frizz") => raw(port(), `${prefix}/rpc/${name}`, { ...base, method: "POST", body: input ?? {} }),
  }
}
const refused = (response) => response.status === 403 && jsonOf(response)?.code === "remote_refused"
const said = (response) => `HTTP ${response.status} ${response.text.slice(0, 90)}`

const audit = (stateDir) => {
  const path = auditLogPathForStateDir(stateDir)
  if (!existsSync(path)) return []
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

const seedThread = (db, projectId, cwd, slug, permission, text) => {
  const sessionId = randomUUID()
  const now = new Date().toISOString()
  const dir = join(home, ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"))
  mkdirSync(dir, { recursive: true })
  const records = [
    { type: "user", message: { role: "user", content: "Check the release" } },
    { type: "assistant", message: { model: "claude-opus-5", id: randomUUID(), type: "message", role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text }] } },
  ].map((record) => ({ ...record, uuid: randomUUID(), parentUuid: null, isSidechain: false, timestamp: now, sessionId, session_id: sessionId, cwd }))
  writeFileSync(join(dir, `${sessionId}.jsonl`), records.map((record) => JSON.stringify(record)).join("\n") + "\n")
  execFileSync("sqlite3", [db, `INSERT INTO session (project_id, slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode, state, unread, exited, archived, rested_at)
    VALUES ('${projectId}', '${slug}', '${sessionId}', 'frizz-${slug}', '${now}', 'Release check', 'claude', 'opus', 'high', '${permission}', 'open', 0, 0, 0, '${now}')`])
  return sessionId
}
const seedQuestion = (db, projectId, slug, id, spec) => execFileSync("sqlite3", [db, `INSERT INTO thread_question (id, project_id, thread_slug, spec, state, answer, delivered, asked_at, settled_at)
  VALUES ('${id}', '${projectId}', '${slug}', '${JSON.stringify(spec).replace(/'/g, "''")}', 'open', NULL, 0, ${Date.now()}, NULL)`])

const QUESTIONS = {
  qst_choice: { question: "Which store?", kind: "question", options: [{ label: "SQLite" }, { label: "Postgres" }] },
  qst_multi: { question: "Which gates?", kind: "multi", options: [{ label: "lint" }, { label: "test" }, { label: "e2e" }] },
  qst_text: { question: "What name should the release use?", kind: "question" },
  qst_secret: { question: "Paste the signing token", kind: "question", secret: true },
  qst_danger: { question: "Force push over main?", kind: "question", danger: true, options: [{ label: "Yes" }, { label: "No" }] },
  qst_click: { question: "Ship it today?", kind: "question", options: [{ label: "Ship" }, { label: "Wait" }] },
}
const answer = (id, chosen, extra = {}) => ({ questionId: id, question: QUESTIONS[id].question, chosen, ...extra })

let proxy = null
let viteProxy = null
let browser = null
const servers = []
const SLUG = "release-check"
let viteHome = null
let relayConnection = null
let workerdRelay = null

try {
  mkdirSync(join(home, ".frizz"), { recursive: true })
  const stack = await startStack(CHILD, home, [`--project=${project}`, `--also-project=${tenantDir}`, "--prod", "--keep"])
  const stateDir = dirname(stack.launcher.serverLock)
  const tenant = stack.tenants[0]
  const db = join(home, ".frizz", "ui.db")
  const projectId = stack.launcher.id
  const auditPath = auditLogPathForStateDir(stateDir)

  const sessionId = seedThread(db, projectId, project, SLUG, "bypassPermissions", `Here is the chart.\n\n::codex-inline-vis{file="chart.html"}\n\nThe report is [report.pdf](${join(project, "report.pdf")}).`)
  write(join(project, ".codex", "visualizations", "2026", "11", "05", sessionId, "chart.html"), "<p id=\"chart\">A chart fragment.</p>\n")
  for (const [id, spec] of Object.entries(QUESTIONS)) seedQuestion(db, projectId, SLUG, id, spec)
  // What a worker would hand over: the attachment and scratch directories are the two readable state roots.
  const scratchFile = join(project, ".frizz", "threads", "some-thread", "notes.md")
  write(scratchFile, "# Scratch\n")

  const sessions = loadSessionState(stateDir)
  let restarts = 0
  let updates = 0
  const restartCounters = {
    restart: async () => { restarts++; return { state: "ready" } },
    updateRestart: async () => { updates++; return { state: "ready" } },
  }
  proxy = new RestartSupervisorProxy({
    port: PROXY, publicOrigin: ORIGIN, childPort: () => CHILD,
    ...restartCounters,
    sessionKey: sessions.key, rotateSessionKey: sessions.rotateKey, sessionDirectory: sessions.directory,
    audit: fileAuditLog(auditPath),
  })
  await proxy.listen()
  // What a launcher does with the R pane's answer: declared before the relay can carry anything.
  proxy.setRelayAccess("read-and-answer")
  let RELAY = await proxy.relayListener()

  const LOOP = `127.0.0.1:${PROXY}`
  const loop = caller(PROXY, { host: LOOP, origin: `http://${LOOP}` })
  const direct = caller(CHILD, { host: `127.0.0.1:${CHILD}`, origin: `http://127.0.0.1:${CHILD}` })
  const stranger = caller(() => RELAY, { host: HOST, origin: ORIGIN })
  const mint = async () => new URL(jsonOf(await loop.post("/_frizz/control/access-code")).url).searchParams.get("frizz_code")
  const redeem = async (code, ua) => {
    const res = await raw(RELAY, `/?frizz_code=${encodeURIComponent(code)}`, { host: HOST, ua })
    return { res, cookie: (res.headers["set-cookie"] ?? []).map((line) => line.split(";")[0]).join("; "), line: (res.headers["set-cookie"] ?? [])[0] ?? "" }
  }

  part("1. Read and answer, through the relay listener")
  section("A real session")
  const phone = await redeem(await mint(), UA_PHONE)
  check("an access code redeems to a real session cookie", phone.cookie.startsWith("__Host-frizz_session="))
  check("the cookie is host-only and secure", /;\s*Secure/i.test(phone.line) && /;\s*Path=\//i.test(phone.line) && !/;\s*Domain=/i.test(phone.line))
  const pub = caller(() => RELAY, { host: HOST, origin: ORIGIN, cookie: phone.cookie, ua: UA_PHONE })
  const status = jsonOf(await pub.get("/_frizz/control/status"))
  check("control status stays, and says the session is remote and limited", status?.remoteSession === true && status?.remoteAccess === "read-and-answer", JSON.stringify(status ?? {}).slice(0, 120))
  check("no session: 401, and the child is not asked", (await stranger.query("board")).status === 401)

  section("Nothing runs: the bypass thread is armed, and a stolen cookie gets 403")
  const threadCount = () => Number(execFileSync("sqlite3", [db, "SELECT count(*) FROM session"], { encoding: "utf8" }).trim())
  const threadsBefore = threadCount()
  const WATCH_MARK = join(markers, "command-watch")
  const watch = (mark) => ({ slug: SLUG, command: `/usr/bin/id -un > ${mark}; /bin/echo ran`, every: "1m", for: "1m" })
  const dispatchBody = { prompt: "[script ending=done paras=1] remote gate", backend: "claude" }
  const publicDispatch = await pub.mutate("dispatch", dispatchBody)
  check("dispatch is refused", refused(publicDispatch), said(publicDispatch))
  check("and its message is plain", jsonOf(publicDispatch)?.error === `This can only be done on ${process.platform === "darwin" ? "the Mac" : "the computer running Frizz"}.`, jsonOf(publicDispatch)?.error)
  const publicWatch = await pub.mutate("addOwnCommandWatch", watch(WATCH_MARK))
  check("addOwnCommandWatch is refused", refused(publicWatch), said(publicWatch))

  section("An approval card a worker is waiting on")
  // A risky action asking to go ahead. Journaled the way the bridge does it, so the page below draws a real
  // card and the store below answers for it.
  const cards = createInteractionStore(new Database(db))
  const cardScope = { projectId, threadSlug: SLUG, sessionId }
  const seedCard = (requestId, thread = { slug: SLUG, sessionId }) => cards.create(buildClaudePermissionInteraction(
    { requestId, toolUseId: `toolu_${requestId}`, toolName: "Bash", input: { command: "git push --force origin main" }, suggestions: [] },
    { projectId, threadSlug: thread.slug, sessionId: thread.sessionId, cwd: project },
  )).interaction
  const addressOf = (record) => ({ slug: record.owner.threadSlug, sessionId: record.owner.sessionId, interactionId: record.id, sessionEpoch: record.owner.sessionEpoch, capabilityRevision: record.owner.capabilityRevision, expectedRecordRevision: record.recordRevision })
  const lifecycleOf = (record) => cards.get({ projectId, threadSlug: record.owner.threadSlug, sessionId: record.owner.sessionId }, record.id)?.lifecycle
  // The board caches which threads hold a card, and only its own store tells it otherwise. These cards come in
  // through another connection, so one that the server cancels itself is what makes it look again.
  const showCard = async (requestId, thread) => {
    const record = seedCard(requestId, thread)
    await direct.mutate("interactionCancel", addressOf(seedCard(`${requestId}-nudge`, thread)))
    return record
  }
  const approval = await showCard("verify-request")
  const cardAddress = addressOf(approval)
  const grant = { ...cardAddress, responseId: "verify-grant", decisionId: "grant-turn" }
  const remoteGrant = await pub.mutate("interactionResolve", grant)
  check("granting it is refused", refused(remoteGrant), said(remoteGrant))
  const remoteCancel = await pub.mutate("interactionCancel", cardAddress)
  check("cancelling it is refused", refused(remoteCancel), said(remoteCancel))
  check("and it is still waiting", cards.get(cardScope, approval.id)?.lifecycle === "pending")

  await sleep(1500)
  check("the command watch's marker was not created", !existsSync(WATCH_MARK))
  check("no worker started", !existsSync(WORKER_MARK))

  section("Encoding and path tricks")
  const tricks = [
    "/_frizz/rpc/%64ispatch", "/_frizz/rpc/dispatc%68", "/_frizz/rpc/DISPATCH", "/_frizz/rpc/dispatch/", "/_frizz/rpc/dispatch%2F", "/_frizz/rpc/dispatch%00",
    "//_frizz/rpc/dispatch", "/_frizz//rpc/dispatch", "/_frizz/./rpc/dispatch", "/_frizz/rpc/./dispatch", "/_frizz/rpc/board/../dispatch", "/_frizz/rpc/board/..%2Fdispatch",
    "/_frizz/%2e%2e/_frizz/rpc/dispatch", "/%5Ffrizz/rpc/dispatch", "/_frizz%2Frpc%2Fdispatch", "/_frizz/rpc%2Fdispatch", "/_frizz/rpc/dispatch?x=/rpc/board", "/_frizz/rpc/dispatch;board",
    `/_frizz/${projectId}/rpc/dispatch`, `/_frizz/${stack.slug}/rpc/dispatch`, `/_frizz/${tenant.id}/rpc/dispatch`, `/_frizz/${tenant.slug}/rpc/dispatch`,
    `/_frizz/${tenant.slug}/rpc/%64ispatch`, `/_frizz/${encodeURIComponent(tenant.slug).replace(/^./, (c) => `%${c.charCodeAt(0).toString(16)}`)}/rpc/dispatch`,
    "http://127.0.0.1:47963/_frizz/rpc/dispatch", `http://${LOOP}/_frizz/rpc/dispatch`,
  ]
  let trickFailures = []
  for (const path of tricks) {
    const response = await raw(RELAY, path, { host: HOST, origin: ORIGIN, cookie: phone.cookie, method: "POST", body: dispatchBody })
    // A spelling the child doesn't read as an API path gets the page, as any other unknown path does.
    if (response.status === 200 ? !response.text.startsWith("<!doctype html") : response.status !== 403 && response.status !== 404 && response.status !== 400) trickFailures.push(`${path} ${response.status} ${response.text.slice(0, 60)}`)
  }
  check(`${tricks.length} spellings of dispatch: none of them answers`, trickFailures.length === 0, trickFailures.join(", "))
  const fullClaim = Buffer.from(JSON.stringify({ via: "public", remote: "127.0.0.1", session: null, access: "full" })).toString("base64url")
  const forged = [
    { "x-frizz-caller": Buffer.from(JSON.stringify({ via: "loopback", remote: "127.0.0.1", session: null })).toString("base64url") },
    { "x-frizz-caller": fullClaim },
    { "X-Frizz-Caller": "direct" }, { "x-forwarded-for": "127.0.0.1" }, { "x-forwarded-host": LOOP }, { forwarded: "for=127.0.0.1;host=127.0.0.1" },
    { "x-http-method-override": "GET" },
  ]
  let forgedFailures = []
  for (const headers of forged) {
    const response = await raw(RELAY, "/_frizz/rpc/dispatch", { host: HOST, origin: ORIGIN, cookie: phone.cookie, method: "POST", body: dispatchBody, headers })
    if (!refused(response)) forgedFailures.push(`${Object.keys(headers)[0]} ${response.status}`)
  }
  check("a caller's own headers claiming to be local change nothing", forgedFailures.length === 0, forgedFailures.join(", "))
  const asGet = await pub.query("dispatch", dispatchBody)
  check("dispatch as a GET is refused too", asGet.status !== 200 && !jsonOf(asGet)?.result, said(asGet))
  for (const name of ["__procedures", "constructor", "__proto__", "hasOwnProperty", "notAProcedure"]) {
    const [asQuery, asMutation] = [await pub.query(name), await pub.mutate(name)]
    check(`${name} is refused`, refused(asQuery) && refused(asMutation), `${asQuery.status}/${asMutation.status}`)
  }
  await sleep(500)
  check("after every trick: no marker", !existsSync(WATCH_MARK))
  check("no worker", !existsSync(WORKER_MARK))
  check("no new thread", threadCount() === threadsBefore, `${threadsBefore} then ${threadCount()}`)

  section("The whole table")
  const denied = Object.entries(REMOTE_ACCESS).filter(([, rule]) => rule === "deny" || rule === "full").map(([name]) => name)
  const answered = []
  for (const name of denied) {
    const [asQuery, asMutation] = [await pub.query(name, { garbage: true }), await pub.mutate(name, { garbage: true })]
    if (!refused(asQuery) || !refused(asMutation)) answered.push(`${name} ${asQuery.status}/${asMutation.status}`)
  }
  check(`all ${denied.length} denied procedures refuse a real remote session, both ways`, answered.length === 0, answered.join(", "))
  const conditional = [
    ["quota", { force: true }], ["authStatus", { fresh: true }],
    ["setThreadSnooze", { slug: SLUG, sessionId, until: new Date(Date.now() + 3_600_000).toISOString(), prompt: "run the deploy" }],
  ]
  for (const [name, input] of conditional) {
    const response = name === "setThreadSnooze" ? await pub.mutate(name, input) : await pub.query(name, input)
    check(`${name} with its dangerous input is refused`, refused(response), said(response))
  }

  section("Routes outside RPC, sockets and the supervisor")
  for (const [method, path] of [
    ["POST", "/_frizz/control/restart"], ["POST", "/_frizz/control/update-restart"], ["POST", "/_frizz/control/access-code"],
    ["GET", "/_frizz/control/sessions"], ["POST", "/_frizz/control/sessions"], ["POST", "/_frizz/control/%72estart"], ["POST", "/_frizz/control/stop"], ["POST", "/_frizz/control/launch"],
    ["POST", "/_frizz/attachments"], ["POST", "/_frizz/attach"], ["GET", "/_frizz/health"], ["GET", "/_frizz/nothing-here"],
    ["GET", `/_frizz/${tenant.slug}/health`], ["POST", `/_frizz/${tenant.slug}/control/stop`],
  ]) {
    const response = await raw(RELAY, path, { host: HOST, origin: ORIGIN, cookie: phone.cookie, method, body: method === "POST" ? {} : undefined })
    check(`${method} ${path} is refused`, response.status === 403, said(response))
  }
  check("no restart ran", restarts === 0)
  const upgrade = (path, cookie) => new Promise((done) => {
    const socket = new WebSocket(`ws://127.0.0.1:${RELAY}${path}`, { headers: { host: HOST, origin: ORIGIN, ...(cookie ? { cookie } : {}) } })
    socket.on("open", () => { socket.close(); done("open") })
    socket.on("unexpected-response", (_req, res) => { res.destroy(); done(res.statusCode) })
    socket.on("error", () => done("error"))
  })
  for (const path of ["/attach", "/_frizz/attach", "/term", "/_frizz/term", "/terminal"]) {
    const outcome = await upgrade(path, phone.cookie)
    check(`upgrade ${path} is refused`, outcome !== "open", String(outcome))
  }
  check("upgrade /_frizz/ws works for a session", (await upgrade("/_frizz/ws", phone.cookie)) === "open")
  check("and not without one", (await upgrade("/_frizz/ws")) !== "open")

  // The bytes after a refused handshake, on the same connection, to the same child. A raw pipe carries no
  // stamp, so anything the child read from it as HTTP would come in as a local caller.
  const smuggle = (path) => new Promise((done) => {
    const socket = connect(RELAY, "127.0.0.1")
    let text = ""
    const handshake = `GET ${path} HTTP/1.1\r\nhost: ${HOST}\r\norigin: ${ORIGIN}\r\ncookie: ${phone.cookie}\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`
    const body = JSON.stringify(dispatchBody)
    const posted = `POST /_frizz/rpc/dispatch HTTP/1.1\r\nhost: 127.0.0.1:${CHILD}\r\norigin: http://127.0.0.1:${CHILD}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
    socket.on("connect", () => {
      socket.write(handshake + posted)
      setTimeout(() => socket.write(posted, () => {}), 300)
      setTimeout(() => { socket.destroy(); done(text) }, 1200)
    })
    socket.on("data", (chunk) => { text += chunk })
    socket.on("error", () => done(text))
  })
  for (const path of ["/nothing-here", "/_frizz/nothing-here", "/_frizz/attach", "/attach"]) {
    const text = await smuggle(path)
    check(`a dispatch sent after a refused upgrade of ${path} runs nothing`, !text.includes("sessionId"), JSON.stringify(text.slice(0, 40)))
  }
  check("and no worker started", !existsSync(WORKER_MARK))

  const socketFor = (port, headers) => new Promise((done, fail) => {
    const frames = []
    const socket = new WebSocket(`ws://127.0.0.1:${port}/_frizz/ws`, { headers })
    socket.on("message", (data) => { try { frames.push(JSON.parse(String(data))) } catch { /* not a frame this asks about */ } })
    socket.on("open", () => done({ socket, frames }))
    socket.on("error", fail)
  })
  const remoteSocket = await socketFor(RELAY, { host: HOST, origin: ORIGIN, cookie: phone.cookie })
  const localSocket = await socketFor(PROXY, { host: LOOP, origin: `http://${LOOP}` })
  const refusedSocketBefore = audit(stateDir).filter((r) => r.action === "remoteRefused" && r.detail?.socket === "file").length
  const readme = join(project, "README.md")
  for (const { socket } of [remoteSocket, localSocket]) {
    socket.send(JSON.stringify({ t: "sub", topic: "file", path: files.sshPdf }))
    socket.send(JSON.stringify({ t: "sub", topic: "file", path: readme }))
    socket.send(JSON.stringify({ t: "sub", topic: "transcript", slug: SLUG }))
  }
  const changed = (frames, path) => frames.some((frame) => frame.t === "file-changed" && frame.path === path)
  // A directory watch on macOS can lag by seconds on a busy machine, so this writes until it is heard, up to a
  // limit. The silence below is measured after a local socket has heard the same file change.
  const toldOfChange = async (frames, path, content) => {
    for (let i = 0; i < 12 && !changed(frames, path); i++) {
      if (i === 0) await sleep(1500)
      writeFileSync(path, `${content} ${i}\n`)
      for (let tick = 0; tick < 10 && !changed(frames, path); tick++) await sleep(500)
    }
    return changed(frames, path)
  }
  check("a local socket watching a file under ~/.ssh is told", await toldOfChange(localSocket.frames, files.sshPdf, `${FAKE} changed, and longer than it was`))
  check("a remote socket hears about a project document", await toldOfChange(remoteSocket.frames, readme, "# Readable\n\nChanged, and longer than it was."))
  check("the file topic tells a remote socket nothing about ~/.ssh", !changed(remoteSocket.frames, files.sshPdf))
  check("the refused subscription is written down", audit(stateDir).filter((r) => r.action === "remoteRefused" && r.detail?.socket === "file").length > refusedSocketBefore)
  remoteSocket.socket.close()
  localSocket.socket.close()

  section("Reads are confined")
  const secretPaths = Object.entries(files)
  secretPaths.push(["sessionKey", join(stateDir, "session-key")], ["sessions", join(stateDir, "sessions.json")], ["dotdot", `${project}/../../.ssh/id_ed25519`], ["audit", auditPath], ["db", db])
  for (const [name, path] of secretPaths) {
    const reads = {
      "local-file": await pub.get(`/_frizz/local-file?path=${encodeURIComponent(path)}`),
      "local-image": await pub.get(`/_frizz/local-image?path=${encodeURIComponent(path)}`),
      localFile: await pub.query("localFile", { path }),
      localMarkdown: await pub.query("localMarkdown", { path }),
      resolveLocalPaths: await pub.query("resolveLocalPaths", { paths: [path] }),
    }
    const leaked = Object.entries(reads).filter(([route, response]) => route === "resolveLocalPaths" ? jsonOf(response)?.result?.resolved?.[0]?.path !== null : response.status === 200 || response.text.includes(FAKE))
    check(`${name} (${path.replace(home, "~")}) is refused by all five reads`, leaked.length === 0, leaked.map(([route, response]) => `${route} ${response.status}`).join(", "))
  }
  const loopControl = await loop.query("localFile", { path: files.sshKey })
  check("the same read from loopback works, as it always has", jsonOf(loopControl)?.result?.text?.includes(FAKE), said(loopControl))
  const loopPdf = await loop.get(`/_frizz/local-file?path=${encodeURIComponent(files.sshPdf)}`)
  check("and the same file route", loopPdf.status === 200, `HTTP ${loopPdf.status}`)
  const loopPng = await loop.get(`/_frizz/local-image?path=${encodeURIComponent(files.sshPng)}`)
  check("and the same image route", loopPng.status === 200, `HTTP ${loopPng.status}`)
  check("a remote session reads a project document", jsonOf(await pub.query("localMarkdown", { path: readme }))?.result?.markdown?.includes("Readable"))
  check("and a registered tenant's", jsonOf(await pub.query("localFile", { path: join(tenantDir, "README.md") }))?.result?.text?.includes("Tenant"))
  check("and a tenant's secrets it does not", (await pub.query("localFile", { path: join(tenantDir, ".env") })).status !== 200)
  check("and a thread's scratch directory", jsonOf(await pub.query("localMarkdown", { path: scratchFile }))?.result?.markdown?.includes("Scratch"))
  check("resolveLocalPaths names a project document", jsonOf(await pub.query("resolveLocalPaths", { paths: [readme] }))?.result?.resolved?.[0]?.path === readme)

  section("The board reads")
  for (const [name, input] of [["board"], ["boardState"], ["projectsList"], ["projectsRailCounts"], ["settingsGet"], ["threadBody", { slug: SLUG }], ["pendingInteractions", { slug: SLUG, sessionId }], ["threadSettledQuestions", { slug: SLUG }], ["threadRegisteredDone", { slug: SLUG }]]) {
    const response = await pub.query(name, input)
    check(`${name} answers`, response.status === 200 && jsonOf(response)?.result !== undefined, `HTTP ${response.status} ${response.status === 200 ? "" : response.text.slice(0, 120)}`)
  }
  const events = await pub.get("/_frizz/events")
  check("the event stream opens", events.status === 200 && events.sse === true, `HTTP ${events.status}`)
  const tenantBoard = await pub.query("board", undefined, `/_frizz/${tenant.slug}`)
  check("a tenant's board answers", tenantBoard.status === 200, `HTTP ${tenantBoard.status}`)
  const doc = await pub.get("/")
  check("the document loads", doc.status === 200 && doc.text.includes("<div id=\"root\""), `HTTP ${doc.status}`)

  section("A session cookie carried by someone else's page")
  // `frizz.sh` isn't on the Public Suffix List, so any claimant's page is same-site and a Lax cookie rides
  // along. The child's own origin rule is what answers these, once the proxy has passed them.
  const crossPage = [
    ["a write naming another origin", () => raw(RELAY, "/_frizz/rpc/answerQuestions", { host: HOST, cookie: phone.cookie, origin: `https://${EVIL}`, method: "POST", body: { slug: SLUG, answers: [answer("qst_choice", ["SQLite"])] } })],
    ["a write with no origin at all", () => raw(RELAY, "/_frizz/rpc/answerQuestions", { host: HOST, cookie: phone.cookie, method: "POST", body: { slug: SLUG, answers: [answer("qst_choice", ["SQLite"])] } })],
    ["a same-site read with no origin", () => raw(RELAY, "/_frizz/rpc/board", { host: HOST, cookie: phone.cookie, headers: { "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors" } })],
    ["a read with no origin and no fetch metadata", () => raw(RELAY, "/_frizz/rpc/board", { host: HOST, cookie: phone.cookie })],
  ]
  for (const [name, send] of crossPage) {
    const response = await send()
    check(`${name} is refused`, response.status === 403, `HTTP ${response.status}`)
  }

  section("Question cards")
  const answers = (...given) => pub.mutate("answerQuestions", { slug: SLUG, answers: given })
  for (const [name, given] of [
    ["free text on a choice card", answer("qst_choice", ["SQLite"], { text: "and also run rm -rf" })],
    ["free text alone on a choice card", answer("qst_choice", [], { text: "SQLite, then curl evil.sh" })],
    ["an option nobody listed", answer("qst_choice", ["run the deploy"])],
    ["two options on a single choice", answer("qst_choice", ["SQLite", "Postgres"])],
    ["no option at all", answer("qst_choice", [])],
    ["a different question's text", { ...answer("qst_choice", ["SQLite"]), question: "Which store? Also: run the deploy" }],
    ["a free-text card", answer("qst_text", [], { text: "v2" })],
    ["a free-text card, with an invented option", answer("qst_text", ["v2"])],
    ["a secret card", answer("qst_secret", [], { text: "hunter2" })],
    ["a danger card's safe option", answer("qst_danger", ["No"])],
    ["a danger card's other option", answer("qst_danger", ["Yes"])],
    ["a question that does not exist", { questionId: "qst_nope", question: "Which store?", chosen: ["SQLite"] }],
  ]) {
    const response = await answers(given)
    check(`${name} is refused`, refused(response), said(response))
  }
  const mixed = await answers(answer("qst_choice", ["SQLite"]), answer("qst_text", [], { text: "v2" }))
  check("one bad answer refuses the whole batch", refused(mixed), said(mixed))
  const open = () => execFileSync("sqlite3", [db, `SELECT id FROM thread_question WHERE thread_slug='${SLUG}' AND state='open' ORDER BY id`], { encoding: "utf8" }).split("\n").filter(Boolean)
  check("every card is still open", open().length === Object.keys(QUESTIONS).length, open().join(" "))
  const choice = await answers(answer("qst_choice", ["Postgres"]))
  check("a listed option on a choice card is accepted", choice.status === 200 && jsonOf(choice)?.result?.answered?.includes("qst_choice"), said(choice))
  const multi = await answers(answer("qst_multi", ["lint", "e2e"]))
  check("listed options on a multi card are accepted", multi.status === 200 && jsonOf(multi)?.result?.answered?.includes("qst_multi"), said(multi))
  const stored = execFileSync("sqlite3", [db, "SELECT answer FROM thread_question WHERE id='qst_choice'"], { encoding: "utf8" })
  check("and stored as picked", JSON.parse(stored).chosen?.[0] === "Postgres", stored.slice(0, 120))
  const localText = await direct.mutate("answerQuestions", { slug: SLUG, answers: [answer("qst_text", [], { text: "v2" })] })
  check("the free-text card answers from a local caller", jsonOf(localText)?.result?.answered?.includes("qst_text"), said(localText))

  section("Relay frames: public by construction")
  const relayOptions = { origin: `http://127.0.0.1:${await proxy.relayListener()}`, publicOrigin: ORIGIN }
  const relayed = (path, headers, method = "GET", body) => new Promise((done) => {
    let status
    let text = ""
    serveRelayRequest(
      { t: "req", id: randomUUID(), method, url: `${ORIGIN}${path}`, headers, ...(body ? { body: encodeBody(new TextEncoder().encode(JSON.stringify(body))) } : {}) },
      { ...relayOptions, send: (frame) => {
        if (frame.t === "res") { status = frame.status; if (frame.body) text = Buffer.from(decodeBody(frame.body)).toString() }
        if (frame.t === "res" && frame.end !== false) done({ status, text })
        if (frame.t === "res-end") done({ status, text })
      } },
    )
  })
  const forgeries = [
    ["a second host header", [["host", HOST], ["Host", LOOP], ["origin", `http://${LOOP}`], ["sec-fetch-site", "same-origin"]]],
    ["HOST in capitals", [["HOST", LOOP], ["origin", `http://${LOOP}`]]],
    ["a forged caller stamp", [["x-frizz-caller", Buffer.from(JSON.stringify({ via: "loopback" })).toString("base64url")], ["origin", ORIGIN]]],
    ["a stamp claiming full control", [["x-frizz-caller", fullClaim], ["origin", ORIGIN]]],
    ["a forwarded host", [["x-forwarded-host", LOOP], ["origin", ORIGIN]]],
  ]
  for (const [name, headers] of forgeries) {
    const response = await relayed("/_frizz/rpc/dispatch", [...headers, ["content-type", "application/json"]], "POST", dispatchBody)
    check(`no cookie, ${name}: stopped at the gate`, response.status === 401 || response.status === 403, `HTTP ${response.status}`)
    const withCookie = await relayed("/_frizz/rpc/dispatch", [...headers, ["cookie", phone.cookie], ["content-type", "application/json"]], "POST", dispatchBody)
    check(`a real cookie, ${name}: arrives public and is refused`, withCookie.status === 403, `HTTP ${withCookie.status} ${withCookie.text.slice(0, 60)}`)
  }
  const relayedBoard = await relayed("/_frizz/rpc/board", [["cookie", phone.cookie], ["origin", ORIGIN]])
  check("a real cookie reads the board through the relay path", relayedBoard.status === 200, `HTTP ${relayedBoard.status}`)
  const relayedSocket = await new Promise((done) => {
    serveRelayWebSocket(
      { t: "ws-open", id: randomUUID(), url: `${ORIGIN}/_frizz/ws`, headers: [["Host", LOOP], ["origin", `http://${LOOP}`]] },
      { ...relayOptions, send: (frame) => { if (frame.t === "ws-ack") done(frame.ok) } },
    )
  })
  check("no cookie, a forged upgrade through the relay path is refused", relayedSocket === false, String(relayedSocket))
  await sleep(500)
  check("no marker, no worker", !existsSync(WATCH_MARK) && !existsSync(WORKER_MARK))

  section("The same calls from this machine still work")
  const loopWatch = await loop.mutate("addOwnCommandWatch", watch(WATCH_MARK))
  check("addOwnCommandWatch from loopback runs its first check", jsonOf(loopWatch)?.result?.passed === true && existsSync(WATCH_MARK), said(loopWatch))
  const directMark = join(markers, "command-watch-direct")
  const directWatch = await direct.mutate("addOwnCommandWatch", watch(directMark))
  check("and from a worker's direct path", jsonOf(directWatch)?.result?.passed === true && existsSync(directMark), said(directWatch))
  const loopDispatch = await loop.mutate("dispatch", dispatchBody)
  check("dispatch from loopback starts the stand-in", Boolean(jsonOf(loopDispatch)?.result?.slug), said(loopDispatch))
  const directDispatch = await direct.mutate("dispatch", dispatchBody)
  check("and from a worker's direct path", Boolean(jsonOf(directDispatch)?.result?.slug), said(directDispatch))
  for (let i = 0; i < 40 && !existsSync(WORKER_MARK); i++) await sleep(250)
  check("the stand-in's marker appeared, so the refused calls above were armed", existsSync(WORKER_MARK))

  section("Evidence")
  const log = audit(stateDir)
  const refusal = log.find((r) => r.action === "remoteRefused" && r.detail?.procedure === "dispatch")
  check("a refused dispatch is one audit line", Boolean(refusal), JSON.stringify(refusal ?? {}).slice(0, 220))
  check("and it names via, session, device and procedure", refusal?.origin?.via === "public" && Boolean(refusal?.origin?.session) && /iPhone/.test(refusal?.origin?.device ?? "") , JSON.stringify(refusal?.origin ?? {}).slice(0, 200))
  check("a refused route is written down", log.some((r) => r.action === "remoteRefused" && String(r.detail?.route ?? "").includes("/attach")))
  check("a refused supervisor control is written down", log.some((r) => r.action === "remoteRefused" && String(JSON.stringify(r.detail)).includes("/control/restart")))
  check("no dispatch record came from a public caller", !log.some((r) => r.action === "dispatch" && r.origin?.via === "public"))
  const dispatched = log.find((r) => r.action === "dispatch" && r.outcome === "ok")
  check("a dispatch record stores the permission mode", typeof dispatched?.detail?.permissionMode === "string", JSON.stringify(dispatched?.detail ?? {}).slice(0, 200))
  check("arming a command watch is written down", log.some((r) => r.action === "commandWatchArm" && r.thread === SLUG))

  section("A document can't be framed, and the board's own frames still work")
  const shell = await pub.get("/")
  check("a remote document says so", shell.headers["x-frame-options"] === "DENY" && shell.headers["content-security-policy"] === "frame-ancestors 'none'", `${shell.headers["x-frame-options"]} / ${shell.headers["content-security-policy"]}`)
  const local = await loop.get("/")
  check("so does a loopback one", local.headers["x-frame-options"] === "DENY" && local.headers["content-security-policy"] === "frame-ancestors 'none'")
  const childDoc = await direct.get("/thread/anything")
  check("and the child's own", childDoc.status === 200 && childDoc.headers["x-frame-options"] === "DENY", `HTTP ${childDoc.status}`)
  const signIn = await stranger.get("/")
  check("and the page a stranger gets", signIn.headers["x-frame-options"] === "DENY", `HTTP ${signIn.status}`)
  const viz = await pub.get(`/_frizz/local-visualization?slug=${SLUG}&file=chart.html`)
  check("a visualization may be framed by its own origin", viz.status === 200 && viz.headers["x-frame-options"] === "SAMEORIGIN" && /frame-ancestors 'self'/.test(viz.headers["content-security-policy"]), `HTTP ${viz.status}`)
  const pdf = await pub.get(`/_frizz/local-file?path=${encodeURIComponent(join(project, "report.pdf"))}`)
  check("so may a PDF", pdf.status === 200 && pdf.headers["x-frame-options"] === "SAMEORIGIN", `HTTP ${pdf.status}`)

  // A public name needs TLS for a `__Host-` cookie, and the page has to be same-site with the attacker's
  // for that cookie to ride along, as any `x.frizz.sh` is with another. So: one self-signed certificate,
  // the board and an attacker on subdomains of one name, and a frame that would load if nothing refused it.
  const key = join(home, "tls.key")
  const cert = join(home, "tls.crt")
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${HOST}`, "-keyout", key, "-out", cert], { stdio: "ignore" })
  const tls = { key: readFileSync(key), cert: readFileSync(cert) }
  const listenTls = (port) => new Promise((done) => {
    const server = createTlsServer(tls, (socket) => {
      const upstream = connect(port, "127.0.0.1")
      socket.on("error", () => upstream.destroy())
      upstream.on("error", () => socket.destroy())
      socket.pipe(upstream).pipe(socket)
    })
    server.listen(0, "127.0.0.1", () => { servers.push(server); done(server.address().port) })
  })
  let framed = "/"
  const attacker = createServer((req, res) => {
    if (req.url === "/control") { res.writeHead(200, { "content-type": "text/html" }); res.end("<p id=x>a page that sets no frame policy</p>"); return }
    res.writeHead(200, { "content-type": "text/html" })
    res.end(`<!doctype html><iframe id="target" name="target" src="${framed}" width="800" height="600"></iframe>`)
  })
  await new Promise((done) => attacker.listen(0, "127.0.0.1", done))
  servers.push(attacker)
  const boardTls = await listenTls(RELAY)
  const evilTls = await listenTls(attacker.address().port)
  // What the supervisor itself draws while the child is down: nothing is asked of a loopback caller.
  const childDown = new RestartSupervisorProxy({ port: PROXY + 10, childPort: () => 1, restart: async () => ({ state: "ready" }) })
  await childDown.listen()
  servers.push({ close: () => childDown.close() })
  const downPage = await raw(PROXY + 10, "/", { host: `127.0.0.1:${PROXY + 10}` })
  check("and what the supervisor draws while the child is down", downPage.text.includes("<") && downPage.headers["x-frame-options"] === "DENY", `HTTP ${downPage.status}`)
  browser = await launchHeadless({ args: [
    "--ignore-certificate-errors",
    `--host-resolver-rules=MAP ${HOST} 127.0.0.1:${boardTls},MAP ${EVIL} 127.0.0.1:${evilTls}`,
  ] })
  const page = await browser.newPage()
  await page.setViewport({ width: 1280, height: 860 })
  const refusedCalls = []
  page.on("response", async (response) => {
    if (response.status() !== 403) return
    refusedCalls.push(new URL(response.url()).pathname)
  })
  const consoleErrors = []
  page.on("pageerror", (error) => consoleErrors.push(String(error)))
  const signedIn = await page.goto(`${ORIGIN}/?frizz_code=${encodeURIComponent(await mint())}`, { waitUntil: "domcontentloaded" })
  check("a real browser signs in with a real code, through the relay listener", signedIn.status() === 200, `HTTP ${signedIn.status()}`)
  const jar = await browser.cookies()
  const held = jar.find((cookie) => cookie.name === "__Host-frizz_session")
  check("and holds the __Host- cookie", held?.secure === true && held?.domain === HOST, JSON.stringify({ secure: held?.secure, domain: held?.domain, sameSite: held?.sameSite }))

  const frameOutcome = async (src) => {
    framed = src
    await page.goto(`https://${EVIL}/`, { waitUntil: "load" })
    await sleep(1200)
    const frame = page.frames().find((f) => f.name() === "target")
    return frame?.url() ?? "(no frame)"
  }
  const control = await frameOutcome(`https://${EVIL}/control`)
  check("control: a page with no policy loads in the attacker's frame", control === `https://${EVIL}/control`, control)
  for (const [name, src] of [
    ["the signed-in board, its cookie riding along", `${ORIGIN}/`],
    ["a thread page", `${ORIGIN}/thread/${SLUG}`],
    ["the board from loopback", `http://${LOOP}/`],
    ["the child directly", `http://127.0.0.1:${CHILD}/`],
    ["the supervisor's own page, with the child down", `http://127.0.0.1:${PROXY + 10}/`],
  ]) {
    const url = await frameOutcome(src)
    check(`${name} refuses the frame`, url.startsWith("chrome-error:"), url)
  }

  section("The page a remote session gets")
  await page.goto(`${ORIGIN}/thread/${SLUG}`, { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => document.body.innerText.includes("Check the release"), { timeout: 30_000 })
  await page.waitForFunction(() => /This has to be answered on /.test(document.body.innerText), { timeout: 20_000 }).catch(() => {})
  await sleep(2000)
  const seen = await page.evaluate(() => ({
    text: document.body.innerText,
    disabledComposer: !document.querySelector("textarea:not([disabled]), [contenteditable=true]"),
    viz: (() => { const el = document.querySelector("iframe[sandbox=allow-scripts]"); return el ? { visible: getComputedStyle(el).visibility, height: el.getBoundingClientRect().height } : null })(),
  }))
  check("it says starting or steering a thread happens on this machine", /Starting or steering a thread happens on (the Mac|the computer running Frizz)\./.test(seen.text))
  check("there is nowhere to type", seen.disabledComposer)
  check("the secret and free-text cards say to answer on this machine", (seen.text.match(/This question has to be answered on /g) ?? []).length >= 2, `${(seen.text.match(/This question has to be answered on /g) ?? []).length} cards`)
  check("the approval card says to answer it on this machine", /This has to be answered on (the Mac|the computer running Frizz)\./.test(seen.text))
  const cardButtons = await page.evaluate(() => [...document.querySelectorAll("button")].map((button) => button.textContent?.trim()).filter((label) => label === "Grant for turn" || label === "Deny"))
  check("and offers no button to grant or deny it", cardButtons.length === 0, cardButtons.join(" "))
  check("the visualization frame renders, in the thread", seen.viz?.visible === "visible", JSON.stringify(seen.viz))
  const vizFrame = page.frames().find((f) => f.url().includes("/local-visualization"))
  check("and draws its fragment", (await vizFrame?.evaluate(() => document.body.innerText))?.includes("A chart fragment"))
  // The real reader, by the real link: what `PdfView` frames is the board's own route.
  const pdfLink = '[data-local-path$="/report.pdf"]'
  await page.evaluateOnNewDocument(() => Object.defineProperty(navigator, "pdfViewerEnabled", { get: () => true }))
  await page.reload({ waitUntil: "domcontentloaded" })
  await page.waitForSelector(pdfLink, { timeout: 15_000 })
  const pdfResponse = page.waitForResponse((r) => new URL(r.url()).pathname.endsWith("/local-file") && r.request().resourceType() === "document", { timeout: 15_000 })
  await page.click(pdfLink)
  const pdfDocument = await pdfResponse
  await sleep(1000)
  check("the PDF reader frames its route", pdfDocument.frame() !== page.mainFrame() && pdfDocument.status() === 200 && pdfDocument.headers()["content-type"] === "application/pdf", `HTTP ${pdfDocument.status()} ${pdfDocument.headers()["x-frame-options"]}`)
  check("and no frame on the page was refused", !page.frames().some((f) => f.url().startsWith("chrome-error:")), page.frames().map((f) => f.url().slice(0, 50)).join(" | "))
  check("the reader's frame is on the page", Boolean(await page.$("iframe[data-pdf-view]")))
  if (shots) {
    mkdirSync(shots, { recursive: true })
    await page.screenshot({ path: join(shots, "read-and-answer-thread-pdf.png") })
  }
  await page.goto(`${ORIGIN}/thread/${SLUG}`, { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => document.body.innerText.includes("Check the release"), { timeout: 30_000 })
  await sleep(1500)
  if (shots) {
    mkdirSync(shots, { recursive: true })
    await page.screenshot({ path: join(shots, "read-and-answer-thread-desktop.png") })
  }
  // The control: the same call from this machine is a good one, so the refusals were the gate's.
  const localGrant = await loop.mutate("interactionResolve", grant)
  check("from this machine, the same grant goes through", localGrant.status === 200 && cards.get(cardScope, approval.id)?.lifecycle === "resolved", said(localGrant))

  // A real click, the path a phone takes: the option, then the send.
  const before = open().length
  const clicked = await page.evaluate(() => {
    const option = [...document.querySelectorAll("*")].find((el) => el.children.length === 0 && el.textContent?.trim() === "Ship")
    option?.click()
    return Boolean(option)
  })
  check("a listed option can be clicked", clicked)
  await sleep(500)
  const sent = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((el) => /^Send answers?\b/.test(el.textContent?.trim() ?? "") && !el.disabled)
    button?.click()
    return Boolean(button)
  })
  check("and sent", sent)
  for (let i = 0; i < 40 && open().length === before; i++) await sleep(250)
  check("the card is answered, by a click in a remote session", !open().includes("qst_click"), open().join(" "))
  if (shots) await page.screenshot({ path: join(shots, "read-and-answer-thread-answered.png") })
  const done = await page.evaluate(() => {
    const button = document.querySelector('[aria-label="Mark as done"]')
    button?.click()
    return Boolean(button)
  })
  await sleep(1000)
  const toast = await page.evaluate(() => document.body.innerText)
  check("a refused call shows the server's own message", done && /This can only be done on (the Mac|the computer running Frizz)\./.test(toast), done ? toast.slice(-120).replace(/\s+/g, " ") : "no Mark as done button")
  if (shots) await page.screenshot({ path: join(shots, "read-and-answer-refused-message.png") })

  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" })
  await sleep(2500)
  if (shots) await page.screenshot({ path: join(shots, "read-and-answer-board-desktop.png") })
  const nothingToType = () => page.evaluate(() => !document.querySelector("textarea:not([disabled]), [contenteditable=true]"))
  const noteShown = () => page.evaluate(() => /Starting or steering a thread happens on /.test(document.body.innerText))
  await page.goto(`${ORIGIN}/project/${stack.slug}`, { waitUntil: "domcontentloaded" })
  await sleep(2500)
  await page.keyboard.down("Meta")
  await page.keyboard.press("k")
  await page.keyboard.up("Meta")
  await sleep(600)
  const palette = await page.evaluate(() => {
    const item = [...document.querySelectorAll("[cmdk-item]")].find((el) => el.textContent?.trim().startsWith("New thread"))
    item?.click()
    return Boolean(item)
  })
  await sleep(800)
  check("the new-thread dialog offers nothing to type", palette && await noteShown() && await nothingToType())
  if (shots) await page.screenshot({ path: join(shots, "read-and-answer-new-thread-desktop.png") })
  // The viewport and not the user agent: naming an iPhone here hides `HeadlessChrome` from the check that
  // keeps the dictation probe away from it (lib/dictation.ts), and that probe hangs the headless shell.
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await page.goto(`${ORIGIN}/thread/${SLUG}`, { waitUntil: "domcontentloaded" })
  await sleep(3000)
  const phoneText = await page.evaluate(() => document.body.innerText)
  check("the phone says it too", /happens on (the Mac|the computer running Frizz)\./.test(phoneText))
  if (shots) await page.screenshot({ path: join(shots, "read-and-answer-thread-phone.png") })
  await page.goto(`${ORIGIN}/project/${stack.slug}`, { waitUntil: "domcontentloaded" })
  await sleep(2500)
  if (shots) await page.screenshot({ path: join(shots, "read-and-answer-board-phone.png") })
  const tapped = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === "New thread")
    button?.click()
    return Boolean(button)
  })
  await sleep(800)
  check("and so does the phone's new-thread page, with nothing to type", tapped && await noteShown() && await nothingToType(), tapped ? "" : "no New thread button")
  if (shots) await page.screenshot({ path: join(shots, "read-and-answer-new-thread-phone.png") })
  // Not a pass or a fail. A page that asks for something refused is noise in the audit trail, so it shows.
  console.log(`  ..   refused during real page loads: ${[...new Set(refusedCalls)].join(", ") || "(nothing)"}`)
  console.log(`  ..   page errors: ${consoleErrors.join(" | ").slice(0, 300) || "(none)"}`)


  part("2. Full control, on the same session through the same listener")
  // One thing to prove first, at the level it is hardest: no remote session can move this setting. It lives in
  // the launcher's saved setup, and here is a real one to watch.
  writeCloudConfig({ hostname: HOST, claim: "colin", serve: "relay", relayAccess: "read-and-answer" }, home)
  const savedSetup = cloudConfigPath(home)
  const levelOf = async () => jsonOf(await pub.get("/_frizz/control/status"))?.remoteAccess
  const cannotMoveTheSetting = async (level) => {
    const before = readFileSync(savedSetup)
    const heard = []
    for (const value of ["full", "read-and-answer"]) {
      for (const name of ["settingsSet", "setRelayAccess", "relayAccess", "setAccess"]) heard.push(await pub.mutate(name, { relayAccess: value, access: value }))
      for (const path of ["relay-access", "access", "settings", "setRelayAccess", "cloud"]) {
        heard.push(await pub.post(`/_frizz/control/${path}`, { relayAccess: value, access: value }), await pub.post(`/_frizz/${path}`, { relayAccess: value, access: value }))
      }
    }
    const { socket } = await socketFor(RELAY, { host: HOST, origin: ORIGIN, cookie: phone.cookie })
    for (const t of ["relayAccess", "setRelayAccess", "settings", "board"]) socket.send(JSON.stringify({ t, relayAccess: "full", access: "full" }))
    await sleep(500)
    socket.close()
    check(`${level}: ${heard.length} requests and four socket messages leave the saved setup byte for byte`, readFileSync(savedSetup).equals(before))
    check(`${level}: and the level is what it was`, await levelOf() === level, await levelOf())
    const asked = await pub.get("/_frizz/control/status")
    check(`${level}: the status answer offers no way to change it`, !/"relayAccess"/.test(asked.text), asked.text.slice(0, 120))
  }
  section("Read and answer cannot change what it may do")
  await cannotMoveTheSetting("read-and-answer")
  const stillRefused = await pub.mutate("dispatch", dispatchBody)
  check("and dispatch is still refused", refused(stillRefused), said(stillRefused))

  section("The owner says full control, in the R pane")
  const heldSocket = await socketFor(RELAY, { host: HOST, origin: ORIGIN, cookie: phone.cookie })
  const heldClosed = new Promise((done) => heldSocket.socket.once("close", () => done(true)))
  proxy.setRelayAccess("full")
  check("a socket opened under the old answer closes", await Promise.race([heldClosed, sleep(4000).then(() => false)]))
  check("the session is at full control", await levelOf() === "full")

  section("Starting and steering threads")
  const workersStarted = () => existsSync(WORKER_MARK) ? readFileSync(WORKER_MARK, "utf8").split("\n").filter(Boolean).length : 0
  const anotherWorker = async (than) => {
    for (let i = 0; i < 80 && workersStarted() <= than; i++) await sleep(250)
    return workersStarted() > than
  }
  const beforeDispatch = workersStarted()
  const fullDispatch = await pub.mutate("dispatch", dispatchBody)
  const fullThread = jsonOf(fullDispatch)?.result
  check("dispatch runs", Boolean(fullThread?.slug), said(fullDispatch))
  check("and a worker process really started", await anotherWorker(beforeDispatch))
  const fullRecord = () => audit(stateDir).find((r) => r.action === "dispatch" && r.origin?.via === "public")
  check("the audit line says who, through what, at which level", fullRecord()?.origin?.access === "full" && Boolean(fullRecord()?.origin?.session) && /iPhone/.test(fullRecord()?.origin?.device ?? ""), JSON.stringify(fullRecord()?.origin ?? {}))
  const STEER = "[script ending=done paras=1] steered from the phone"
  const steered = await pub.mutate("followUp", { slug: fullThread?.slug, sessionId: fullThread?.sessionId, message: STEER })
  check("followUp is accepted", steered.status === 200, said(steered))
  const delivered = await (async () => {
    for (let i = 0; i < 80; i++) {
      const body = await pub.query("threadTranscript", { slug: fullThread?.slug })
      if (body.text.includes("steered from the phone")) return true
      await sleep(250)
    }
    return false
  })()
  check("and the worker's transcript has the message", delivered)
  const renamed = await pub.mutate("renameThread", { slug: SLUG, title: "Release check, renamed from the phone" })
  check("a thread can be renamed", renamed.status === 200, said(renamed))
  const permission = await pub.mutate("setThreadPermission", { slug: SLUG, permissionMode: "acceptEdits" })
  check("its permission mode can be changed", permission.status === 200, said(permission))
  const currentSettings = jsonOf(await pub.query("settingsGet"))?.result
  const settingsWrite = await pub.mutate("settingsSet", currentSettings)
  check("settings can be written", settingsWrite.status === 200, said(settingsWrite))

  section("Every kind of card")
  Object.assign(QUESTIONS, { qst_full_text: { question: "What should the tag say?", kind: "question" } })
  seedQuestion(db, projectId, SLUG, "qst_full_text", QUESTIONS.qst_full_text)
  const SECRET_VALUE = "a-stand-in-secret-value"
  for (const [name, given] of [
    ["free text", answer("qst_full_text", [], { text: "v2.1" })],
    ["a secret", answer("qst_secret", [], { text: SECRET_VALUE })],
    ["a danger gate", answer("qst_danger", ["Yes"])],
  ]) {
    const response = await pub.mutate("answerQuestions", { slug: SLUG, answers: [given] })
    check(`${name} is answered`, jsonOf(response)?.result?.answered?.includes(given.questionId), said(response))
  }
  const storedSecret = execFileSync("sqlite3", [db, "SELECT answer FROM thread_question WHERE id='qst_secret'"], { encoding: "utf8" })
  check("and a secret's value still stops at its pipe", !storedSecret.includes(SECRET_VALUE) && storedSecret.length > 0)
  const grantCard = seedCard("verify-full-grant")
  const fullGrant = await pub.mutate("interactionResolve", { ...addressOf(grantCard), responseId: "verify-full-grant", decisionId: "grant-turn" })
  check("a real approval card is granted", fullGrant.status === 200 && lifecycleOf(grantCard) === "resolved", said(fullGrant))
  const cancelCard = seedCard("verify-full-cancel")
  const fullCancel = await pub.mutate("interactionCancel", addressOf(cancelCard))
  check("and another is cancelled", fullCancel.status === 200 && lifecycleOf(cancelCard) === "cancelled", said(fullCancel))

  section("Reading and attaching, as a tab on this machine can")
  const sshRead = await pub.query("localFile", { path: files.sshKey })
  check("~/.ssh reads", jsonOf(sshRead)?.result?.text?.includes(FAKE), `HTTP ${sshRead.status}`)
  check("and through the file route", (await pub.get(`/_frizz/local-file?path=${encodeURIComponent(files.sshPdf)}`)).status === 200)
  check("and the image route", (await pub.get(`/_frizz/local-image?path=${encodeURIComponent(files.sshPng)}`)).status === 200)
  check("and resolveLocalPaths", jsonOf(await pub.query("resolveLocalPaths", { paths: [files.sshKey] }))?.result?.resolved?.[0]?.path === files.sshKey)
  const attached = await pub.post("/_frizz/attach", { name: "note.txt", data: Buffer.from("from a phone").toString("base64") })
  check("an attachment is taken", attached.status === 200 && Boolean(jsonOf(attached)?.path), said(attached))
  const fullSocket = await socketFor(RELAY, { host: HOST, origin: ORIGIN, cookie: phone.cookie })
  fullSocket.socket.send(JSON.stringify({ t: "sub", topic: "file", path: files.sshPdf }))
  check("a socket is told about a file under ~/.ssh", await toldOfChange(fullSocket.frames, files.sshPdf, `${FAKE} changed again, and longer than it was before`))
  fullSocket.socket.close()

  section("Restarting and updating")
  const [restartsBefore, updatesBefore] = [restarts, updates]
  const remoteRestart = await pub.post("/_frizz/control/restart", {})
  check("restart is accepted", remoteRestart.status === 202, said(remoteRestart))
  await sleep(200)
  const remoteUpdate = await pub.post("/_frizz/control/update-restart", {})
  check("update is accepted", remoteUpdate.status === 202, said(remoteUpdate))
  await sleep(200)
  check("and both ran", restarts === restartsBefore + 1 && updates === updatesBefore + 1, `restarts ${restarts}, updates ${updates}`)

  /** What no remote session reaches, at any level, whichever way it came in. */
  const machineOnly = async (label, port, session, cookie, tenantPaths = []) => {
    for (const [method, path] of [
      ["POST", "/_frizz/control/access-code"], ["GET", "/_frizz/control/sessions"], ["POST", "/_frizz/control/sessions"],
      ["POST", "/_frizz/control/stop"], ["POST", "/_frizz/control/launch"], ["GET", "/_frizz/health"], ["GET", "/_frizz/nothing-here"],
      ...tenantPaths,
    ]) {
      const response = await raw(port, path, { host: HOST, origin: ORIGIN, cookie, method, body: method === "POST" ? {} : undefined })
      check(`${label}: ${method} ${path} is refused`, response.status === 403, said(response))
    }
    const noPageCalls = Object.entries(REMOTE_ACCESS).filter(([, rule]) => rule === "deny").map(([name]) => name)
    const answeredAnyway = []
    for (const name of noPageCalls) {
      const [asQuery, asMutation] = [await session.query(name, { garbage: true }), await session.mutate(name, { garbage: true })]
      if (!refused(asQuery) || !refused(asMutation)) answeredAnyway.push(`${name} ${asQuery.status}/${asMutation.status}`)
    }
    check(`${label}: all ${noPageCalls.length} procedures no page calls refuse it, both ways`, answeredAnyway.length === 0, answeredAnyway.join(", "))
    const mark = join(markers, `command-watch-${label.replace(/\W/g, "-")}`)
    const realWatch = await session.mutate("addOwnCommandWatch", watch(mark))
    check(`${label}: a real command watch is refused`, refused(realWatch), said(realWatch))
    await sleep(500)
    check(`${label}: and nothing ran`, !existsSync(mark))
    for (const name of ["__procedures", "constructor", "notAProcedure"]) {
      const [asQuery, asMutation] = [await session.query(name), await session.mutate(name)]
      check(`${label}: ${name} is refused`, refused(asQuery) && refused(asMutation), `${asQuery.status}/${asMutation.status}`)
    }
  }
  section("What stays the machine's")
  await machineOnly("full control", RELAY, pub, phone.cookie, [["GET", `/_frizz/${tenant.slug}/health`], ["POST", `/_frizz/${tenant.slug}/control/stop`], ["POST", "/_frizz/control/%72estart"]])

  section("Relay frames, at full control")
  for (const [name, headers] of forgeries) {
    const beforeForgery = workersStarted()
    const noCookie = await relayed("/_frizz/rpc/dispatch", [...headers, ["content-type", "application/json"]], "POST", dispatchBody)
    check(`no cookie, ${name}: stopped at the gate`, noCookie.status === 401 || noCookie.status === 403, `HTTP ${noCookie.status}`)
    await sleep(300)
    check(`and nothing started`, workersStarted() === beforeForgery)
    const minting = await relayed("/_frizz/control/access-code", [...headers, ["cookie", phone.cookie], ["content-type", "application/json"]], "POST", {})
    check(`a real cookie, ${name}: still cannot mint a sign-in link`, minting.status === 403 && !minting.text.includes("frizz_code"), `HTTP ${minting.status} ${minting.text.slice(0, 60)}`)
  }
  const forgedUpgrade = await new Promise((done) => {
    serveRelayWebSocket(
      { t: "ws-open", id: randomUUID(), url: `${ORIGIN}/_frizz/ws`, headers: [["Host", LOOP], ["origin", `http://${LOOP}`]] },
      { ...relayOptions, send: (frame) => { if (frame.t === "ws-ack") done(frame.ok) } },
    )
  })
  check("no cookie, a forged upgrade is refused", forgedUpgrade === false, String(forgedUpgrade))
  check("no cookie through the listener: 401", (await stranger.query("board")).status === 401)
  check("and no socket", (await upgrade("/_frizz/ws")) !== "open")
  const signedOutStill = await caller(() => RELAY, { host: HOST, origin: ORIGIN, cookie: "__Host-frizz_session=AAAA.BBBB.CCCC" }).query("board")
  check("a made-up cookie: 401", signedOutStill.status === 401, `HTTP ${signedOutStill.status}`)

  section("Full control cannot change what it may do either")
  await cannotMoveTheSetting("full")

  section("The page a device with full control gets")
  refusedCalls.length = 0
  await page.setViewport({ width: 1280, height: 860, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
  // The worker dispatched above, since a thread that only exists as seeded rows has no broker to deliver to.
  const pageCard = await showCard("verify-page-card", fullThread)
  await page.goto(`${ORIGIN}/thread/${fullThread.slug}`, { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => document.querySelector("textarea:not([disabled]), [contenteditable=true]"), { timeout: 30_000 })
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Grant for turn"), { timeout: 20_000 }).catch(() => {})
  await sleep(1000)
  const seenFull = await page.evaluate(() => ({
    text: document.body.innerText,
    composer: Boolean(document.querySelector("textarea:not([disabled]), [contenteditable=true]")),
    buttons: [...document.querySelectorAll("button")].map((button) => button.textContent?.trim()),
  }))
  check("there is somewhere to type", seenFull.composer)
  check("nothing says to go back to the machine", !/happens on (the Mac|the computer running Frizz)|has to be answered on/.test(seenFull.text))
  check("the approval card offers its buttons", seenFull.buttons.includes("Grant for turn") && seenFull.buttons.includes("Deny"), seenFull.buttons.filter((label) => /Grant|Deny/.test(label ?? "")).join(" "))
  if (shots) await page.screenshot({ path: join(shots, "full-control-thread-desktop.png") })
  await page.evaluate(() => [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Grant for turn")?.click())
  for (let i = 0; i < 40 && lifecycleOf(pageCard) === "pending"; i++) await sleep(250)
  check("a real click on the card grants it", lifecycleOf(pageCard) === "resolved", lifecycleOf(pageCard))
  const pageFollowUps = () => audit(stateDir).filter((r) => r.action === "followUp" && r.origin?.via === "public" && r.thread === fullThread.slug)
  const followUpsBefore = pageFollowUps().length
  await page.click("textarea:not([disabled])")
  await page.keyboard.type("[script ending=done paras=1] typed on the page")
  await sleep(300)
  await page.click('[aria-label="Send"]')
  for (let i = 0; i < 40 && pageFollowUps().length === followUpsBefore; i++) await sleep(250)
  const typedRecord = pageFollowUps().at(-1)
  check("a message typed on the page is sent", pageFollowUps().length > followUpsBefore && typedRecord?.outcome === "ok" && typedRecord?.origin?.access === "full", JSON.stringify(typedRecord ?? {}).slice(0, 200))
  for (let i = 0; i < 40 && !(await page.evaluate(() => document.body.innerText.includes("typed on the page"))); i++) await sleep(250)
  check("and the page shows it in the thread", await page.evaluate(() => document.body.innerText.includes("typed on the page")))
  await sleep(1000)
  if (shots) await page.screenshot({ path: join(shots, "full-control-thread-after-send.png") })
  await page.goto(`${ORIGIN}/project/${stack.slug}`, { waitUntil: "domcontentloaded" })
  await sleep(2500)
  if (shots) await page.screenshot({ path: join(shots, "full-control-board-desktop.png") })
  await page.keyboard.down("Meta")
  await page.keyboard.press("k")
  await page.keyboard.up("Meta")
  await sleep(600)
  const fullPalette = await page.evaluate(() => {
    const item = [...document.querySelectorAll("[cmdk-item]")].find((el) => el.textContent?.trim().startsWith("New thread"))
    item?.click()
    return Boolean(item)
  })
  await sleep(800)
  check("the new-thread dialog has somewhere to type", fullPalette && !(await nothingToType()) && !(await noteShown()))
  if (shots) await page.screenshot({ path: join(shots, "full-control-new-thread-desktop.png") })
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await showCard("verify-phone-card", fullThread)
  await page.goto(`${ORIGIN}/thread/${fullThread.slug}`, { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Grant for turn"), { timeout: 20_000 }).catch(() => {})
  await sleep(1000)
  check("so does the phone", !(await nothingToType()) && !(await noteShown()))
  check("and its approval card offers its buttons", await page.evaluate(() => [...document.querySelectorAll("button")].some((button) => button.textContent?.trim() === "Grant for turn")))
  if (shots) await page.screenshot({ path: join(shots, "full-control-thread-phone.png") })
  await page.goto(`${ORIGIN}/project/${stack.slug}`, { waitUntil: "domcontentloaded" })
  await sleep(2500)
  const fullTapped = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === "New thread")
    button?.click()
    return Boolean(button)
  })
  await sleep(800)
  check("and the phone's new-thread page", fullTapped && !(await nothingToType()) && !(await noteShown()), fullTapped ? "" : "no New thread button")
  if (shots) await page.screenshot({ path: join(shots, "full-control-new-thread-phone.png") })
  const refusedOnFull = [...new Set(refusedCalls)]
  check("every page above asked for nothing it was refused", refusedOnFull.length === 0, refusedOnFull.join(", "))

  section("The owner says read and answer again, with the page open")
  proxy.setRelayAccess("read-and-answer")
  await page.setViewport({ width: 1280, height: 860, isMobile: false, hasTouch: false, deviceScaleFactor: 1 })
  await page.goto(`${ORIGIN}/thread/${SLUG}`, { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => /happens on (the Mac|the computer running Frizz)\./.test(document.body.innerText), { timeout: 30_000 })
  check("the page goes back to its note", await nothingToType())
  const refusedAgain = await pub.mutate("dispatch", dispatchBody)
  check("and dispatch is refused again", refused(refusedAgain), said(refusedAgain))
  await machineOnly("read and answer", RELAY, pub, phone.cookie)

  part("3. A public origin with no relay: Tailscale, a tunnel, a proxy of the owner's")
  const OWN_PORT = PROXY + 2
  const ownProxy = new RestartSupervisorProxy({
    port: OWN_PORT, publicOrigin: ORIGIN, childPort: () => CHILD,
    ...restartCounters,
    sessionKey: sessions.key, rotateSessionKey: sessions.rotateKey, sessionDirectory: sessions.directory,
    audit: fileAuditLog(auditPath),
  })
  await ownProxy.listen()
  servers.push({ close: () => ownProxy.close() })
  const ownStranger = caller(OWN_PORT, { host: HOST, origin: ORIGIN })
  check("no session: 401", (await ownStranger.query("board")).status === 401)
  const ownRedeem = await raw(OWN_PORT, `/?frizz_code=${encodeURIComponent(ownProxy.issueAccessCode().code)}`, { host: HOST, ua: UA_PHONE })
  const ownCookie = (ownRedeem.headers["set-cookie"] ?? []).map((line) => line.split(";")[0]).join("; ")
  const own = caller(OWN_PORT, { host: HOST, origin: ORIGIN, cookie: ownCookie, ua: UA_PHONE })
  const ownStatus = jsonOf(await own.get("/_frizz/control/status"))
  check("the session has full control, and nobody was asked", ownStatus?.remoteSession === true && ownStatus?.remoteAccess === "full", JSON.stringify(ownStatus ?? {}).slice(0, 120))
  const beforeOwn = workersStarted()
  const ownDispatch = await own.mutate("dispatch", dispatchBody)
  check("dispatch runs", Boolean(jsonOf(ownDispatch)?.result?.slug), said(ownDispatch))
  check("and a worker process really started", await anotherWorker(beforeOwn))
  const ownCard = seedCard("verify-own-grant")
  const ownGrant = await own.mutate("interactionResolve", { ...addressOf(ownCard), responseId: "verify-own-grant", decisionId: "grant-turn" })
  check("a real approval card is granted", ownGrant.status === 200 && lifecycleOf(ownCard) === "resolved", said(ownGrant))
  check("~/.ssh reads", jsonOf(await own.query("localFile", { path: files.sshKey }))?.result?.text?.includes(FAKE))
  const ownRestarts = restarts
  check("restart is accepted", (await own.post("/_frizz/control/restart", {})).status === 202)
  await sleep(200)
  check("and ran", restarts === ownRestarts + 1)
  await machineOnly("own proxy", OWN_PORT, own, ownCookie)
  // The setting is about the relay, and this door is not the relay.
  ownProxy.setRelayAccess("read-and-answer")
  check("the relay's setting does not reach this door", jsonOf(await own.get("/_frizz/control/status"))?.remoteAccess === "full")
  const stillOwnDispatch = await own.mutate("dispatch", dispatchBody)
  check("and dispatch still runs", Boolean(jsonOf(stillOwnDispatch)?.result?.slug), said(stillOwnDispatch))

  section("Sessions")
  const second = await redeem(await mint(), "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15")
  const forgedSession = (() => {
    const parts = second.cookie.split("=")[1].split(".")
    parts[1] = "AAAAAAAA"
    return `__Host-frizz_session=${parts.join(".")}`
  })()
  check("a cookie for a session nobody issued is refused", (await raw(RELAY, "/_frizz/rpc/board", { host: HOST, origin: ORIGIN, cookie: forgedSession })).status === 401)
  await proxy.close()
  const again = loadSessionState(stateDir)
  proxy = new RestartSupervisorProxy({ port: PROXY, publicOrigin: ORIGIN, childPort: () => CHILD, restart: async () => ({ state: "ready" }), sessionKey: again.key, rotateSessionKey: again.rotateKey, sessionDirectory: again.directory, audit: fileAuditLog(auditPath) })
  await proxy.listen()
  proxy.setRelayAccess("read-and-answer")
  RELAY = await proxy.relayListener()
  check("a real session survives a restart of the launcher", (await pub.query("board")).status === 200)
  const heldOpen = await socketFor(RELAY, { host: HOST, origin: ORIGIN, cookie: phone.cookie })
  const closed = new Promise((done) => heldOpen.socket.once("close", () => done(true)))
  const signedOut = await raw(RELAY, "/_frizz/control/sign-out", { host: HOST, origin: ORIGIN, cookie: second.cookie, method: "POST", body: {} })
  check("a remote session can sign itself out", signedOut.status === 200, said(signedOut))
  check("and only itself", (await pub.query("board")).status === 200)
  const revoke = await caller(PROXY, { host: LOOP, origin: `http://${LOOP}` }).post("/_frizz/control/sessions", { all: true })
  check("sign-out-all from loopback works", revoke.status === 200, said(revoke))
  check("and closes a socket that was already open", await Promise.race([closed, sleep(4000).then(() => false)]))
  check("the old cookie is dead", (await pub.query("board")).status === 401)
  await proxy.close()
  proxy = new RestartSupervisorProxy({ port: PROXY, childPort: () => CHILD, restart: async () => ({ state: "ready" }), sessionKey: again.key, rotateSessionKey: again.rotateKey, sessionDirectory: again.directory })
  await proxy.listen()
  const rotateLocal = await caller(PROXY, { host: LOOP, origin: `http://${LOOP}` }).post("/_frizz/control/sessions", { all: true })
  check("sign-out-all works with no public origin declared", rotateLocal.status === 200, said(rotateLocal))

  section("The Vite path")
  viteHome = realpathSync(mkdtempSync(join(tmpdir(), "frizz-remote-gate-vite-")))
  mkdirSync(join(viteHome, ".frizz"), { recursive: true })
  const viteProject = join(viteHome, "project")
  mkdirSync(viteProject)
  const viteStack = await startStack(VITE_CHILD, viteHome, [`--project=${viteProject}`, "--keep"])
  const viteState = loadSessionState(dirname(viteStack.launcher.serverLock))
  viteProxy = new RestartSupervisorProxy({ port: PROXY + 1, publicOrigin: ORIGIN, childPort: () => VITE_CHILD, restart: async () => ({ state: "ready" }), sessionKey: viteState.key, rotateSessionKey: viteState.rotateKey, sessionDirectory: viteState.directory })
  await viteProxy.listen()
  viteProxy.setRelayAccess("read-and-answer")
  const viteRelay = await viteProxy.relayListener()
  const viteLoop = caller(PROXY + 1, { host: `127.0.0.1:${PROXY + 1}`, origin: `http://127.0.0.1:${PROXY + 1}` })
  for (const path of ["/", "/index.html", "/thread/anything"]) {
    const response = await viteLoop.get(path)
    check(`Vite serves ${path} locally, refusing frames`, response.status === 200 && response.headers["x-frame-options"] === "DENY" && response.headers["content-security-policy"] === "frame-ancestors 'none'", `HTTP ${response.status} ${response.headers["x-frame-options"]}`)
  }
  const viteCode = new URL(jsonOf(await viteLoop.post("/_frizz/control/access-code")).url).searchParams.get("frizz_code")
  const viteCookie = ((await raw(viteRelay, `/?frizz_code=${encodeURIComponent(viteCode)}`, { host: HOST })).headers["set-cookie"] ?? [])[0]?.split(";")[0]
  const viteRemote = caller(viteRelay, { host: HOST, origin: ORIGIN, cookie: viteCookie })
  for (const path of ["/", "/@fs/etc/hosts", "/__open-in-editor?file=/etc/hosts", "/@vite/client", "/src/main.tsx"]) {
    const response = await viteRemote.get(path)
    check(`read and answer gets nothing from Vite at ${path}`, response.status === 403 && response.headers["x-frame-options"] === "DENY", `HTTP ${response.status}`)
  }
  // Only these two: `/__open-in-editor` would open a window on this machine's screen.
  viteProxy.setRelayAccess("full")
  for (const path of ["/", "/src/main.tsx"]) {
    const response = await viteRemote.get(path)
    check(`full control gets Vite's ${path}`, response.status === 200, `HTTP ${response.status}`)
  }

  if (workerd) {
    part("4. The real relay Worker on workerd: a phone starts a real worker")
    // The zone is `localhost`, as in verify-relay-e2e.mjs, so `ada.localhost` resolves to loopback and no real
    // Cloudflare state is touched. Nothing here signs in: wrangler runs its local dev server, with no token.
    const relayState = join(home, "relay-state")
    mkdirSync(relayState)
    const wranglerEnv = { ...cleanEnv(), WRANGLER_SEND_METRICS: "false" }
    const relayCwd = join(repo, "packages/relay")
    const identity = await generateClaimIdentity()
    const pubkey = await exportClaimPublicKey(identity.publicKey)
    const seeded = spawn("nubx", ["-y", "wrangler", "kv", "key", "put", "claim:ada", JSON.stringify({ pubkey, tunnelId: "", port: PROXY + 3, claimedAt: Date.now(), renewedAt: Date.now() }), "--binding", "CLAIMS", "--local", "--persist-to", relayState], { cwd: relayCwd, env: wranglerEnv, stdio: "ignore" })
    const seededCode = await new Promise((done) => seeded.once("exit", done))
    if (seededCode !== 0) throw new Error(`seeding the claim failed with exit ${seededCode}`)
    const devConfig = join(relayState, "wrangler.dev.toml")
    writeFileSync(devConfig, [
      'name = "frizz-relay-dev"', `main = "${join(repo, "packages/relay/src/worker.ts")}"`, 'compatibility_date = "2026-08-24"', "",
      "[vars]", 'FRIZZ_ZONE = "localhost"', "",
      "[[durable_objects.bindings]]", 'name = "BOARD"', 'class_name = "Board"', "",
      "[[migrations]]", 'tag = "v1"', 'new_sqlite_classes = ["Board"]', "",
      "[[kv_namespaces]]", 'binding = "CLAIMS"', 'id = "aa4a9c11473d4511a556e3e3a6857058"', "",
    ].join("\n"))
    workerdRelay = spawn("nubx", ["-y", "wrangler", "dev", "-c", devConfig, "--port", String(WORKERD), "--ip", "127.0.0.1", "--persist-to", relayState], { cwd: relayCwd, env: wranglerEnv, stdio: "ignore" })
    const relayOrigin = `http://ada.localhost:${WORKERD}`
    const viaWorkerd = async (path, { cookie, method = "GET", body, headers = {} } = {}) => {
      const response = await fetch(`${relayOrigin}${path}`, {
        method, redirect: "manual",
        headers: { origin: relayOrigin, ...(cookie ? { cookie } : {}), ...(body ? { "content-type": "application/json" } : {}), ...headers },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
      return { status: response.status, headers: response.headers, text: await response.text() }
    }
    const settled = async (label, ask, ms = 90_000) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        const value = await ask().catch(() => false)
        if (value) return value
        await sleep(500)
      }
      throw new Error(`timed out waiting for ${label}`)
    }
    await settled("wrangler dev", async () => (await viaWorkerd("/")).status > 0)
    check("the relay Worker runs on workerd", true, `127.0.0.1:${WORKERD}`)

    const relayedBoardProxy = new RestartSupervisorProxy({
      port: PROXY + 3, publicOrigin: relayOrigin, childPort: () => CHILD,
      ...restartCounters,
      sessionKey: again.key, rotateSessionKey: again.rotateKey, sessionDirectory: again.directory,
      audit: fileAuditLog(auditPath),
    })
    await relayedBoardProxy.listen()
    servers.push({ close: () => relayedBoardProxy.close() })
    relayConnection = connectRelay({ name: "ada", identity, relayOrigin, boardOrigin: `http://127.0.0.1:${await relayedBoardProxy.relayListener()}`, publicOrigin: relayOrigin })
    await settled("the board's socket to the relay", async () => (await viaWorkerd("/")).status === 401)
    check("no cookie through the relay: 401", true)
    const unasked = await viaWorkerd("/_frizz/rpc/dispatch", { method: "POST", body: dispatchBody, headers: { "x-frizz-caller": fullClaim } })
    check("no cookie, and a stamp claiming full control: 401", unasked.status === 401, `HTTP ${unasked.status}`)

    const relayRedeem = await viaWorkerd(`/?frizz_code=${encodeURIComponent(relayedBoardProxy.issueAccessCode().code)}`)
    const relayCookie = relayRedeem.headers.getSetCookie().map((line) => line.split(";")[0]).join("; ")
    check("a code redeems through the relay", relayCookie.startsWith("__Host-frizz_session="), `HTTP ${relayRedeem.status}`)
    const levelThroughRelay = async () => jsonOf(await viaWorkerd("/_frizz/control/status", { cookie: relayCookie }))?.remoteAccess
    check("a board that never answered the question is at full control", await levelThroughRelay() === "full")

    const beforeRelayed = workersStarted()
    const relayedDispatch = await viaWorkerd("/_frizz/rpc/dispatch", { cookie: relayCookie, method: "POST", body: dispatchBody })
    const relayedThread = jsonOf(relayedDispatch)?.result
    check("dispatch through the relay is accepted", Boolean(relayedThread?.slug), said(relayedDispatch))
    check("and a real worker process started", await anotherWorker(beforeRelayed))
    const relayedSteer = await viaWorkerd("/_frizz/rpc/followUp", { cookie: relayCookie, method: "POST", body: { slug: relayedThread?.slug, sessionId: relayedThread?.sessionId, message: "[script ending=done paras=1] steered through the relay" } })
    check("followUp through the relay is accepted", relayedSteer.status === 200, said(relayedSteer))
    const heardSteer = await settled("the steer in the worker's transcript", async () => (await viaWorkerd(`/_frizz/rpc/threadTranscript${inputQuery({ slug: relayedThread?.slug })}`, { cookie: relayCookie })).text.includes("steered through the relay"), 30_000).catch(() => false)
    check("and the worker's transcript has the message", heardSteer)
    const relayRecord = audit(stateDir).find((r) => r.action === "dispatch" && r.thread === relayedThread?.slug)
    check("the audit line says public, at full control", relayRecord?.origin?.via === "public" && relayRecord?.origin?.access === "full", JSON.stringify(relayRecord?.origin ?? {}))
    for (const [method, path] of [["POST", "/_frizz/control/access-code"], ["GET", "/_frizz/control/sessions"], ["POST", "/_frizz/control/sessions"]]) {
      const response = await viaWorkerd(path, { cookie: relayCookie, method, ...(method === "POST" ? { body: {} } : {}) })
      check(`${method} ${path} is refused through the relay`, response.status === 403 && jsonOf(response)?.code === "remote_refused", said(response))
    }

    const relayedHeld = new WebSocket(`ws://ada.localhost:${WORKERD}/_frizz/ws`, { headers: { origin: relayOrigin, cookie: relayCookie } })
    const relayedOpen = await new Promise((done) => {
      relayedHeld.once("open", () => done(true))
      relayedHeld.once("error", () => done(false))
      relayedHeld.once("unexpected-response", () => done(false))
    })
    check("a socket opens through the relay", relayedOpen)
    relayedBoardProxy.setRelayAccess("read-and-answer")
    // CLOSING, which is the visitor having heard the relay's close frame. The `close` event waits on the TCP
    // connection too, and wrangler's dev proxy holds that past the handshake.
    const closingAt = Date.now()
    for (let i = 0; i < 80 && relayedHeld.readyState === WebSocket.OPEN; i++) await sleep(250)
    check("saying read and answer closes it", relayedHeld.readyState !== WebSocket.OPEN, `after ${Date.now() - closingAt}ms`)
    relayedHeld.terminate()
    check("the session is limited now", await levelThroughRelay() === "read-and-answer")
    const beforeRefused = workersStarted()
    const relayedRefused = await viaWorkerd("/_frizz/rpc/dispatch", { cookie: relayCookie, method: "POST", body: dispatchBody })
    check("dispatch through the relay is refused", relayedRefused.status === 403 && jsonOf(relayedRefused)?.code === "remote_refused", said(relayedRefused))
    await sleep(1500)
    check("and no worker started", workersStarted() === beforeRefused)
    check("and the board still reads", (await viaWorkerd("/_frizz/rpc/board", { cookie: relayCookie })).status === 200)
  } else {
    console.log("\n\n══ 4. The real relay Worker on workerd: left out by --no-workerd ══")
  }
} catch (error) {
  check("the run completed", false, error instanceof Error ? error.stack : String(error))
} finally {
  await browser?.close().catch(() => {})
  relayConnection?.stop()
  if (workerdRelay) {
    workerdRelay.kill("SIGINT")
    await Promise.race([new Promise((done) => workerdRelay.once("exit", done)), sleep(10_000)])
    workerdRelay.kill("SIGKILL")
  }
  await proxy?.close().catch(() => {})
  await viteProxy?.close().catch(() => {})
  for (const server of servers) { try { server.close() } catch { /* already closed */ } }
  for (const child of children) { try { child.kill("SIGTERM") } catch { /* already gone */ } }
  await sleep(1500)
  // A dispatched stand-in is detached, and its command line names this run's temp HOME. Only those.
  const mine = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n")
    .filter((line) => line.includes(home) || (viteHome && line.includes(viteHome))).map((line) => Number(line.trim().split(/\s+/)[0])).filter((pid) => pid && pid !== process.pid)
  for (const pid of mine) { try { process.kill(pid, "SIGTERM") } catch { /* already gone */ } }
  if (!keep) {
    rmSync(home, { recursive: true, force: true, maxRetries: 3 })
    if (viteHome) rmSync(viteHome, { recursive: true, force: true, maxRetries: 3 })
  }
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
