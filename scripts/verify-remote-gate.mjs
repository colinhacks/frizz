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
 *   env -u NODE_COMPAT nub scripts/verify-remote-gate.mjs [--shots=/abs/dir] [--keep]
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
import { decodeBody, encodeBody } from "@frizz/shared"
import { loadSessionState } from "@frizz/server/access-codes"
import { RestartSupervisorProxy } from "@frizz/server/restart-supervisor"
import { auditLogPathForStateDir, fileAuditLog } from "../packages/server/src/audit.ts"
import { REMOTE_ACCESS } from "../packages/server/src/remote-gate.ts"
import { serveRelayRequest, serveRelayWebSocket } from "../src/relay-agent.ts"
import { launchHeadless } from "./lib/headless-browser.mjs"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const flag = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
const shots = flag("shots")
const keep = process.argv.includes("--keep")

const CHILD = 47_961
const VITE_CHILD = 47_962
const PROXY = 47_963
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

/** One caller: how it reaches the board, and what it says about itself. */
const caller = (port, base) => ({
  get: (path, extra) => raw(port, path, { ...base, ...extra }),
  post: (path, body, extra) => raw(port, path, { ...base, method: "POST", body, ...extra }),
  query: (name, input, prefix = "/_frizz") => raw(port, `${prefix}/rpc/${name}${inputQuery(input)}`, base),
  mutate: (name, input, prefix = "/_frizz") => raw(port, `${prefix}/rpc/${name}`, { ...base, method: "POST", body: input ?? {} }),
})
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
  proxy = new RestartSupervisorProxy({
    port: PROXY, publicOrigin: ORIGIN, childPort: () => CHILD,
    restart: async () => { restarts++; return { state: "ready" } },
    sessionKey: sessions.key, rotateSessionKey: sessions.rotateKey, sessionDirectory: sessions.directory,
    audit: fileAuditLog(auditPath),
  })
  await proxy.listen()

  const LOOP = `127.0.0.1:${PROXY}`
  const loop = caller(PROXY, { host: LOOP, origin: `http://${LOOP}` })
  const direct = caller(CHILD, { host: `127.0.0.1:${CHILD}`, origin: `http://127.0.0.1:${CHILD}` })
  const stranger = caller(PROXY, { host: HOST, origin: ORIGIN })
  const mint = async () => new URL(jsonOf(await loop.post("/_frizz/control/access-code")).url).searchParams.get("frizz_code")
  const redeem = async (code, ua) => {
    const res = await raw(PROXY, `/?frizz_code=${encodeURIComponent(code)}`, { host: HOST, ua })
    return { res, cookie: (res.headers["set-cookie"] ?? []).map((line) => line.split(";")[0]).join("; "), line: (res.headers["set-cookie"] ?? [])[0] ?? "" }
  }

  section("A real session")
  const phone = await redeem(await mint(), UA_PHONE)
  check("an access code redeems to a real session cookie", phone.cookie.startsWith("__Host-frizz_session="))
  check("the cookie is host-only and secure", /;\s*Secure/i.test(phone.line) && /;\s*Path=\//i.test(phone.line) && !/;\s*Domain=/i.test(phone.line))
  const pub = caller(PROXY, { host: HOST, origin: ORIGIN, cookie: phone.cookie, ua: UA_PHONE })
  const status = jsonOf(await pub.get("/_frizz/control/status"))
  check("control status stays, and says the session is remote", status?.remoteSession === true, JSON.stringify(status ?? {}).slice(0, 120))
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
    const response = await raw(PROXY, path, { host: HOST, origin: ORIGIN, cookie: phone.cookie, method: "POST", body: dispatchBody })
    // A spelling the child doesn't read as an API path gets the page, as any other unknown path does.
    if (response.status === 200 ? !response.text.startsWith("<!doctype html") : response.status !== 403 && response.status !== 404 && response.status !== 400) trickFailures.push(`${path} ${response.status} ${response.text.slice(0, 60)}`)
  }
  check(`${tricks.length} spellings of dispatch: none of them answers`, trickFailures.length === 0, trickFailures.join(", "))
  const forged = [
    { "x-frizz-caller": Buffer.from(JSON.stringify({ via: "loopback", remote: "127.0.0.1", session: null })).toString("base64url") },
    { "X-Frizz-Caller": "direct" }, { "x-forwarded-for": "127.0.0.1" }, { "x-forwarded-host": LOOP }, { forwarded: "for=127.0.0.1;host=127.0.0.1" },
    { "x-http-method-override": "GET" },
  ]
  let forgedFailures = []
  for (const headers of forged) {
    const response = await raw(PROXY, "/_frizz/rpc/dispatch", { host: HOST, origin: ORIGIN, cookie: phone.cookie, method: "POST", body: dispatchBody, headers })
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
  const denied = Object.entries(REMOTE_ACCESS).filter(([, rule]) => rule === "deny").map(([name]) => name)
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
    const response = await raw(PROXY, path, { host: HOST, origin: ORIGIN, cookie: phone.cookie, method, body: method === "POST" ? {} : undefined })
    check(`${method} ${path} is refused`, response.status === 403, said(response))
  }
  check("no restart ran", restarts === 0)
  const upgrade = (path, cookie) => new Promise((done) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PROXY}${path}`, { headers: { host: HOST, origin: ORIGIN, ...(cookie ? { cookie } : {}) } })
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
    const socket = connect(PROXY, "127.0.0.1")
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
  const remoteSocket = await socketFor(PROXY, { host: HOST, origin: ORIGIN, cookie: phone.cookie })
  const localSocket = await socketFor(PROXY, { host: LOOP, origin: `http://${LOOP}` })
  const refusedSocketBefore = audit(stateDir).filter((r) => r.action === "remoteRefused" && r.detail?.socket === "file").length
  const readme = join(project, "README.md")
  for (const { socket } of [remoteSocket, localSocket]) {
    socket.send(JSON.stringify({ t: "sub", topic: "file", path: files.sshPdf }))
    socket.send(JSON.stringify({ t: "sub", topic: "file", path: readme }))
    socket.send(JSON.stringify({ t: "sub", topic: "transcript", slug: SLUG }))
  }
  await sleep(1500)
  writeFileSync(files.sshPdf, `${FAKE} changed, and longer than it was\n`)
  writeFileSync(readme, "# Readable\n\nChanged, and longer than it was.\n")
  await sleep(3000)
  const changed = (frames, path) => frames.some((frame) => frame.t === "file-changed" && frame.path === path)
  check("the file topic tells a remote socket nothing about ~/.ssh", !changed(remoteSocket.frames, files.sshPdf))
  check("a local socket watching the same file is told", changed(localSocket.frames, files.sshPdf))
  check("a remote socket hears about a project document", changed(remoteSocket.frames, readme))
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
  for (const [name, input] of [["board"], ["boardState"], ["projectsList"], ["projectsRailCounts"], ["settingsGet"], ["threadBody", { slug: SLUG }], ["pendingInteractions", { slug: SLUG, sessionId }], ["threadSettledQuestions", { slug: SLUG }]]) {
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
    ["a write naming another origin", () => raw(PROXY, "/_frizz/rpc/answerQuestions", { host: HOST, cookie: phone.cookie, origin: `https://${EVIL}`, method: "POST", body: { slug: SLUG, answers: [answer("qst_choice", ["SQLite"])] } })],
    ["a write with no origin at all", () => raw(PROXY, "/_frizz/rpc/answerQuestions", { host: HOST, cookie: phone.cookie, method: "POST", body: { slug: SLUG, answers: [answer("qst_choice", ["SQLite"])] } })],
    ["a same-site read with no origin", () => raw(PROXY, "/_frizz/rpc/board", { host: HOST, cookie: phone.cookie, headers: { "sec-fetch-site": "same-site", "sec-fetch-mode": "no-cors" } })],
    ["a read with no origin and no fetch metadata", () => raw(PROXY, "/_frizz/rpc/board", { host: HOST, cookie: phone.cookie })],
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
  const childDoc = await direct.get("/thread/anything/full")
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
  const boardTls = await listenTls(PROXY)
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
  check("a real browser signs in with a real code", signedIn.status() === 200, `HTTP ${signedIn.status()}`)
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
    ["a thread page", `${ORIGIN}/thread/${SLUG}/full`],
    ["the board from loopback", `http://${LOOP}/`],
    ["the child directly", `http://127.0.0.1:${CHILD}/`],
    ["the supervisor's own page, with the child down", `http://127.0.0.1:${PROXY + 10}/`],
  ]) {
    const url = await frameOutcome(src)
    check(`${name} refuses the frame`, url.startsWith("chrome-error:"), url)
  }

  section("The page a remote session gets")
  await page.goto(`${ORIGIN}/thread/${SLUG}/full`, { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => document.body.innerText.includes("Check the release"), { timeout: 30_000 })
  await sleep(2000)
  const seen = await page.evaluate(() => ({
    text: document.body.innerText,
    disabledComposer: !document.querySelector("textarea:not([disabled]), [contenteditable=true]"),
    viz: (() => { const el = document.querySelector("iframe[sandbox=allow-scripts]"); return el ? { visible: getComputedStyle(el).visibility, height: el.getBoundingClientRect().height } : null })(),
  }))
  check("it says starting or steering a thread happens on this machine", /Starting or steering a thread happens on (the Mac|the computer running Frizz)\./.test(seen.text))
  check("there is nowhere to type", seen.disabledComposer)
  check("the secret and free-text cards say to answer on this machine", (seen.text.match(/This question has to be answered on /g) ?? []).length >= 2, `${(seen.text.match(/This question has to be answered on /g) ?? []).length} cards`)
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
    await page.screenshot({ path: join(shots, "remote-thread-pdf.png") })
  }
  await page.goto(`${ORIGIN}/thread/${SLUG}/full`, { waitUntil: "domcontentloaded" })
  await page.waitForFunction(() => document.body.innerText.includes("Check the release"), { timeout: 30_000 })
  await sleep(1500)
  if (shots) {
    mkdirSync(shots, { recursive: true })
    await page.screenshot({ path: join(shots, "remote-thread-desktop.png") })
  }

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
  if (shots) await page.screenshot({ path: join(shots, "remote-thread-answered.png") })
  const done = await page.evaluate(() => {
    const button = document.querySelector('[aria-label="Mark as done"]')
    button?.click()
    return Boolean(button)
  })
  await sleep(1000)
  const toast = await page.evaluate(() => document.body.innerText)
  check("a refused call shows the server's own message", done && /This can only be done on (the Mac|the computer running Frizz)\./.test(toast), done ? toast.slice(-120).replace(/\s+/g, " ") : "no Mark as done button")
  if (shots) await page.screenshot({ path: join(shots, "remote-refused-message.png") })

  await page.goto(`${ORIGIN}/`, { waitUntil: "domcontentloaded" })
  await sleep(2500)
  if (shots) await page.screenshot({ path: join(shots, "remote-board-desktop.png") })
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
  if (shots) await page.screenshot({ path: join(shots, "remote-new-thread-desktop.png") })
  // The viewport and not the user agent: naming an iPhone here hides `HeadlessChrome` from the check that
  // keeps the dictation probe away from it (lib/dictation.ts), and that probe hangs the headless shell.
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 })
  await page.goto(`${ORIGIN}/thread/${SLUG}/full`, { waitUntil: "domcontentloaded" })
  await sleep(3000)
  const phoneText = await page.evaluate(() => document.body.innerText)
  check("the phone says it too", /happens on (the Mac|the computer running Frizz)\./.test(phoneText))
  if (shots) await page.screenshot({ path: join(shots, "remote-thread-phone.png") })
  await page.goto(`${ORIGIN}/project/${stack.slug}`, { waitUntil: "domcontentloaded" })
  await sleep(2500)
  if (shots) await page.screenshot({ path: join(shots, "remote-board-phone.png") })
  const tapped = await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === "New thread")
    button?.click()
    return Boolean(button)
  })
  await sleep(800)
  check("and so does the phone's new-thread page, with nothing to type", tapped && await noteShown() && await nothingToType(), tapped ? "" : "no New thread button")
  if (shots) await page.screenshot({ path: join(shots, "remote-new-thread-phone.png") })
  // Not a pass or a fail. A page that asks for something refused is noise in the audit trail, so it shows.
  console.log(`  ..   refused during real page loads: ${[...new Set(refusedCalls)].join(", ") || "(nothing)"}`)
  console.log(`  ..   page errors: ${consoleErrors.join(" | ").slice(0, 300) || "(none)"}`)

  section("Sessions")
  const second = await redeem(await mint(), "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15")
  const forgedSession = (() => {
    const parts = second.cookie.split("=")[1].split(".")
    parts[1] = "AAAAAAAA"
    return `__Host-frizz_session=${parts.join(".")}`
  })()
  check("a cookie for a session nobody issued is refused", (await raw(PROXY, "/_frizz/rpc/board", { host: HOST, origin: ORIGIN, cookie: forgedSession })).status === 401)
  await proxy.close()
  const again = loadSessionState(stateDir)
  proxy = new RestartSupervisorProxy({ port: PROXY, publicOrigin: ORIGIN, childPort: () => CHILD, restart: async () => ({ state: "ready" }), sessionKey: again.key, rotateSessionKey: again.rotateKey, sessionDirectory: again.directory, audit: fileAuditLog(auditPath) })
  await proxy.listen()
  check("a real session survives a restart of the launcher", (await pub.query("board")).status === 200)
  const heldOpen = await socketFor(PROXY, { host: HOST, origin: ORIGIN, cookie: phone.cookie })
  const closed = new Promise((done) => heldOpen.socket.once("close", () => done(true)))
  const signedOut = await raw(PROXY, "/_frizz/control/sign-out", { host: HOST, origin: ORIGIN, cookie: second.cookie, method: "POST", body: {} })
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
  const viteHome = realpathSync(mkdtempSync(join(tmpdir(), "frizz-remote-gate-vite-")))
  mkdirSync(join(viteHome, ".frizz"), { recursive: true })
  const viteProject = join(viteHome, "project")
  mkdirSync(viteProject)
  const viteStack = await startStack(VITE_CHILD, viteHome, [`--project=${viteProject}`, "--keep"])
  const viteState = loadSessionState(dirname(viteStack.launcher.serverLock))
  viteProxy = new RestartSupervisorProxy({ port: PROXY + 1, publicOrigin: ORIGIN, childPort: () => VITE_CHILD, restart: async () => ({ state: "ready" }), sessionKey: viteState.key, rotateSessionKey: viteState.rotateKey, sessionDirectory: viteState.directory })
  await viteProxy.listen()
  const viteLoop = caller(PROXY + 1, { host: `127.0.0.1:${PROXY + 1}`, origin: `http://127.0.0.1:${PROXY + 1}` })
  for (const path of ["/", "/index.html", "/thread/anything/full"]) {
    const response = await viteLoop.get(path)
    check(`Vite serves ${path} locally, refusing frames`, response.status === 200 && response.headers["x-frame-options"] === "DENY" && response.headers["content-security-policy"] === "frame-ancestors 'none'", `HTTP ${response.status} ${response.headers["x-frame-options"]}`)
  }
  const viteCode = new URL(jsonOf(await viteLoop.post("/_frizz/control/access-code")).url).searchParams.get("frizz_code")
  const viteCookie = ((await raw(PROXY + 1, `/?frizz_code=${encodeURIComponent(viteCode)}`, { host: HOST })).headers["set-cookie"] ?? [])[0]?.split(";")[0]
  const viteRemote = caller(PROXY + 1, { host: HOST, origin: ORIGIN, cookie: viteCookie })
  for (const path of ["/", "/@fs/etc/hosts", "/__open-in-editor?file=/etc/hosts", "/@vite/client", "/src/main.tsx"]) {
    const response = await viteRemote.get(path)
    check(`a remote session gets nothing from Vite at ${path}`, response.status === 403 && response.headers["x-frame-options"] === "DENY", `HTTP ${response.status}`)
  }
  rmSync(viteHome, { recursive: true, force: true, maxRetries: 3 })
} catch (error) {
  check("the run completed", false, error instanceof Error ? error.stack : String(error))
} finally {
  await browser?.close().catch(() => {})
  await proxy?.close().catch(() => {})
  await viteProxy?.close().catch(() => {})
  for (const server of servers) { try { server.close() } catch { /* already closed */ } }
  for (const child of children) { try { child.kill("SIGTERM") } catch { /* already gone */ } }
  await sleep(1500)
  // A dispatched stand-in is detached, and its command line names this run's temp HOME. Only those.
  const mine = execFileSync("ps", ["-axo", "pid=,command="], { encoding: "utf8" }).split("\n")
    .filter((line) => line.includes(home)).map((line) => Number(line.trim().split(/\s+/)[0])).filter((pid) => pid && pid !== process.pid)
  for (const pid of mine) { try { process.kill(pid, "SIGTERM") } catch { /* already gone */ } }
  if (!keep) rmSync(home, { recursive: true, force: true, maxRetries: 3 })
}

const failed = results.filter((ok) => !ok).length
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
