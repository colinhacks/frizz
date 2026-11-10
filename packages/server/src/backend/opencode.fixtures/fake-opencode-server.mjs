// A fake OpenCode 2 service for the native backend's tests: real HTTP and a real SSE stream on loopback,
// speaking the routes and event shapes OpenCode 2.2.5 was measured to (plans/opencode-native-backend.md,
// the recorded stream beside this file). Small on purpose, and scripted by the prompt text itself:
//
//   [say:<text>]      the model writes <text>
//   [think:<text>]    a reasoning part
//   [shell:<cmd>]     one shell call. Its result is `ran <cmd>`, plus `slug=<FRIZZ_THREAD_SLUG>` from the
//                     session's own environment when <cmd> names that variable, which is how a test reads
//                     what a session's shell would see. Gated on the session's permission rules.
//   [wait:<ms>]       the step takes this long
//   [question]        the question tool: a form, answered through /form/:id/reply
//   [sub:<label>]     the subagent tool: a child session that runs `[shell:echo $FRIZZ_THREAD_SLUG][say:child done]`
//   [fail]            the execution fails with a `provider.auth` error
//   (any script)      fails `provider.no-route` while the fake is still "activating" (opts.activatingMs)
//
// A test drives the service's own misbehaviour through the returned handle: `dropStreams()` ends every
// event stream (events emitted while nobody listens are lost, as on the real one), `restart()` also loses
// every session's environment, as a real service restart does, and `requests` records what was called.

import { createServer } from "node:http"

// The built-in agents' own rules, as OpenCode 2.2.5's plugin/agent.ts and schema/agent.ts set them. The
// person's configured rules (`opts.configRules`, an opencode.json's `permissions`) are pushed onto every
// agent after these, as config/plugin/agent.ts does.
const AGENT_DEFAULT = [{ action: "*", resource: "*", effect: "allow" }]
const AGENT_RULES = {
  build: [...AGENT_DEFAULT, { action: "question", resource: "*", effect: "allow" }],
  general: [...AGENT_DEFAULT, { action: "question", resource: "*", effect: "deny" }, { action: "subagent", resource: "*", effect: "deny" }],
  plan: [...AGENT_DEFAULT, { action: "edit", resource: "*", effect: "deny" }],
}

// OpenCode's Wildcard.match and Permission.evaluate: the last matching rule wins, and nothing matching asks.
function wildcard(input, pattern) {
  let escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")
  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?"
  return new RegExp("^" + escaped + "$", "s").test(input)
}
function evaluate(action, resource, rules) {
  return [...rules].reverse().find((r) => wildcard(action, r.action) && wildcard(resource, r.resource))?.effect ?? "ask"
}

export async function startFakeOpencode(opts = {}) {
  const password = opts.password ?? "fake-secret-password"
  const version = opts.version ?? "2.2.5"
  const configRules = opts.configRules ?? []
  const agentRules = (agent) => [...(AGENT_RULES[agent] ?? AGENT_DEFAULT), ...configRules]
  // A service that has just started: until `activatingMs` has passed, `/api/model` answers 503 and a prompt
  // fails "Model unavailable" (`provider.no-route`), as 2.0.27 did a moment after `service start`.
  const bootedAt = Date.now()
  const activating = () => Date.now() - bootedAt < (opts.activatingMs ?? 0)
  const sessions = new Map()
  const streams = new Set()
  const requests = []
  let seq = 0
  let idn = 0
  const id = (p) => `${p}_fake${String(++idn).padStart(6, "0")}`
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // A scripted `wait` that an interrupt cuts short. The timer goes with it: a test scripts a 60s wait
  // and interrupts it at once, and the timer left armed kept that test's process alive for the minute.
  const waitOrAbort = (ms, signal) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve()
      const timer = setTimeout(done, ms)
      function done() {
        clearTimeout(timer)
        signal.removeEventListener("abort", done)
        resolve()
      }
      signal.addEventListener("abort", done)
    })
  let listening = true

  function emit(type, data) {
    const frame = `data: ${JSON.stringify({ id: id("evt"), created: Date.now(), type, data })}\n\n`
    for (const res of streams) res.write(frame)
  }

  function newSession(body) {
    const s = {
      id: id("ses"), parentID: body.parentID, title: body.title, agent: body.agent ?? "build", model: body.model ?? { id: "big-pickle", providerID: "opencode" },
      permissions: body.permissions ?? [], metadata: body.metadata, directory: body.location?.directory,
      messages: [], inbox: [], env: undefined, instructions: new Map(), running: false, abort: undefined,
      permissionsPending: new Map(), forms: new Map(),
    }
    sessions.set(s.id, s)
    emit("session.created", { sessionID: s.id, ...(s.parentID ? { parentID: s.parentID } : {}), title: s.title, agent: s.agent, model: s.model, location: { directory: s.directory }, version })
    return s
  }

  function info(s) {
    return { id: s.id, ...(s.parentID ? { parentID: s.parentID } : {}), title: s.title, agent: s.agent, model: s.model, permissions: s.permissions, metadata: s.metadata }
  }

  function message(s, m) { m.seq = ++seq; s.messages.push(m); return m }

  function enqueue(s, item) {
    const existing = s.inbox.find((i) => i.id === item.id) || s.messages.find((m) => m.id === item.id)
    if (existing) return existing
    s.inbox.push(item)
    emit("session.inbox.enqueued", { inboxID: item.id, sessionID: s.id, item: { type: item.type, payload: { text: item.text }, delivery: item.delivery } })
    if (!s.running) void execute(s)
    return item
  }

  function deliver(s, item) {
    s.inbox = s.inbox.filter((i) => i !== item)
    emit("session.inbox.delivered", { sessionID: s.id, inboxID: item.id })
    if (item.type === "compaction") return
    message(s, { id: item.id, type: "user", text: item.text, time: { created: Date.now() } })
  }

  async function runScript(s, text, signal) {
    const tokens = [...text.matchAll(/\[(say|think|shell|wait|question|sub|fail)(?::([^\]]*))?\]/g)]
    if (!tokens.length) tokens.push([null, "say", "ok"])
    let assistant
    const step = () => {
      assistant = message(s, { id: id("msg"), type: "assistant", agent: s.agent, model: s.model, content: [], time: { created: Date.now() } })
      emit("session.step.started", { sessionID: s.id, assistantMessageID: assistant.id, agent: s.agent, model: s.model })
    }
    const endStep = (finish) => {
      assistant.finish = finish
      assistant.tokens = { input: 1000, output: 10, reasoning: 0, cache: { read: 500, write: 0 } }
      emit("session.step.ended", { sessionID: s.id, assistantMessageID: assistant.id, finish, tokens: assistant.tokens })
    }
    step()
    if (activating()) {
      const error = { type: "provider.no-route", message: "Model unavailable: opencode/big-pickle" }
      assistant.error = error
      emit("session.step.failed", { sessionID: s.id, assistantMessageID: assistant.id, error })
      return { failed: error }
    }
    let text0 = 0
    for (const [, kind, arg = ""] of tokens) {
      if (signal.aborted) return "interrupted"
      if (kind === "wait") { await waitOrAbort(Number(arg), signal); continue }
      if (kind === "fail") {
        const error = { type: "provider.auth", message: "No credentials for opencode" }
        assistant.error = error
        emit("session.step.failed", { sessionID: s.id, assistantMessageID: assistant.id, error })
        return { failed: error }
      }
      if (kind === "say") {
        const ordinal = text0++
        emit("session.text.started", { sessionID: s.id, assistantMessageID: assistant.id, ordinal })
        for (const piece of arg.match(/.{1,6}/gs) ?? []) emit("session.text.delta", { sessionID: s.id, assistantMessageID: assistant.id, ordinal, delta: piece })
        assistant.content.push({ type: "text", text: arg })
        emit("session.text.ended", { sessionID: s.id, assistantMessageID: assistant.id, ordinal, text: arg })
        continue
      }
      if (kind === "think") {
        emit("session.reasoning.started", { sessionID: s.id, assistantMessageID: assistant.id, ordinal: 0 })
        assistant.content.push({ type: "reasoning", text: arg })
        emit("session.reasoning.ended", { sessionID: s.id, assistantMessageID: assistant.id, ordinal: 0, text: arg })
        continue
      }
      // A tool: its own step, then a fresh step after it, as a real model does.
      const callId = id("call")
      const name = kind === "shell" ? "shell" : kind === "sub" ? "subagent" : "question"
      const input = kind === "shell" ? { command: arg } : kind === "sub" ? { agent: "general", description: arg, prompt: "child work" } : { questions: [{ header: "Colour", question: "Which colour?", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] }] }
      const part = { type: "tool", id: callId, name, state: { status: "running", input } }
      assistant.content.push(part)
      // `unseenCalls`: a call Frizz never saw, as after a restart or a dropped stream, so a permission request
      // arrives with no call before it.
      if (!opts.unseenCalls) {
        emit("session.tool.input.started", { sessionID: s.id, assistantMessageID: assistant.id, id: callId, name })
        emit("session.tool.called", { sessionID: s.id, assistantMessageID: assistant.id, id: callId, input })
      }
      let result
      if (kind === "shell") {
        // Per sub-command, as the shell tool asks: any deny blocks the call, any ask raises one request.
        const rules = [...agentRules(s.agent), ...s.permissions]
        const effects = arg.split(/\s*(?:\||&&)\s*/).map((c) => evaluate("shell", c, rules))
        if (effects.includes("deny")) {
          const error = { type: "permission.blocked", message: "The user has specified a rule which prevents you from using this specific tool call" }
          part.state = { status: "error", input, error }
          emit("session.tool.failed", { sessionID: s.id, assistantMessageID: assistant.id, id: callId, error })
          endStep("tool-calls"); step(); continue
        }
        if (effects.includes("ask")) {
          const reqId = id("per")
          const reply = await new Promise((resolve) => {
            s.permissionsPending.set(reqId, { id: reqId, sessionID: s.id, action: "shell", resources: arg.split(/\s*(?:\||&&)\s*/), save: arg.split(/\s*(?:\||&&)\s*/).map((c) => c.split(" ")[0] + " *"), source: { type: "tool", messageID: assistant.id, id: callId }, resolve })
            emit("permission.asked", { id: reqId, sessionID: s.id, action: "shell", resources: arg.split(/\s*(?:\||&&)\s*/), save: arg.split(/\s*(?:\||&&)\s*/).map((c) => c.split(" ")[0] + " *"), source: { type: "tool", messageID: assistant.id, id: callId } })
            signal.addEventListener("abort", () => resolve({ decision: "reject" }))
          })
          s.permissionsPending.delete(reqId)
          emit("permission.replied", { sessionID: s.id, requestID: reqId, reply: reply.decision })
          if (reply.decision === "reject") {
            if (reply.message) {
              part.state = { status: "error", input, error: { type: "corrected", message: reply.message } }
              emit("session.tool.failed", { sessionID: s.id, assistantMessageID: assistant.id, id: callId, error: { type: "corrected", message: reply.message } })
              endStep("tool-calls"); step(); continue
            }
            part.state = { status: "error", input, error: { type: "aborted", message: "The user declined this tool call" } }
            emit("session.tool.failed", { sessionID: s.id, assistantMessageID: assistant.id, id: callId, error: { type: "aborted", message: "The user declined this tool call" } })
            assistant.error = { type: "aborted", message: "Step interrupted" }
            emit("session.step.failed", { sessionID: s.id, assistantMessageID: assistant.id, error: assistant.error })
            return "declined"
          }
        }
        const slug = /FRIZZ_THREAD_SLUG/.test(arg) ? ` slug=${s.env?.FRIZZ_THREAD_SLUG ?? ""}` : ""
        result = `ran ${arg}${slug}`
      } else if (kind === "question") {
        const formId = id("frm")
        const answer = await new Promise((resolve) => {
          const form = { id: formId, sessionID: s.id, title: "Questions", metadata: { kind: "question", tool: { messageID: assistant.id, id: callId } }, fields: [{ key: "q0", title: "Colour", description: "Which colour?", type: "string", options: [{ value: "Red", label: "Red", description: "warm" }, { value: "Blue", label: "Blue", description: "cool" }], custom: true }] }
          s.forms.set(formId, { form, resolve })
          emit("form.created", { form })
          signal.addEventListener("abort", () => resolve(undefined))
        })
        s.forms.delete(formId)
        if (!answer) { emit("form.cancelled", { id: formId, sessionID: s.id }); return "declined" }
        emit("form.replied", { id: formId, sessionID: s.id, answer })
        part.state = { status: "completed", input, content: [{ type: "text", text: `answered ${JSON.stringify(answer)}` }], metadata: { answers: [[].concat(answer.q0)] } }
        emit("session.tool.success", { sessionID: s.id, assistantMessageID: assistant.id, id: callId, content: part.state.content, metadata: part.state.metadata })
        endStep("tool-calls"); step(); continue
      } else {
        const child = newSession({ parentID: s.id, title: arg, agent: "general", location: { directory: s.directory }, permissions: s.permissions })
        emit("session.tool.progress", { sessionID: s.id, assistantMessageID: assistant.id, id: callId, metadata: { sessionID: child.id, status: "running" } })
        await sleep(opts.childDelayMs ?? 50)
        enqueue(child, { id: id("msg"), type: "user", text: opts.childScript ?? "[shell:echo $FRIZZ_THREAD_SLUG][say:child done]", delivery: "steer" })
        await new Promise((resolve) => { child.onIdle = resolve })
        result = `<subagent sessionID="${child.id}" state="completed">\nchild done\n</subagent>`
        part.state = { status: "completed", input, content: [{ type: "text", text: result }], metadata: { sessionID: child.id, status: "completed" } }
        emit("session.tool.success", { sessionID: s.id, assistantMessageID: assistant.id, id: callId, content: part.state.content, metadata: part.state.metadata })
        endStep("tool-calls"); step(); continue
      }
      part.state = { status: "completed", input, content: [{ type: "text", text: result }] }
      emit("session.tool.success", { sessionID: s.id, assistantMessageID: assistant.id, id: callId, content: part.state.content })
      endStep("tool-calls")
      // The safe step boundary: steers go in here.
      for (const item of s.inbox.filter((i) => i.delivery === "steer")) { deliver(s, item); await runScript(s, item.text, signal) }
      step()
    }
    endStep("stop")
    return "ok"
  }

  async function execute(s) {
    s.running = true
    const ac = new AbortController()
    s.abort = ac
    emit("session.execution.started", { sessionID: s.id })
    let outcome = "ok"
    for (;;) {
      const item = s.inbox.find((i) => i.delivery === "steer") ?? s.inbox.find((i) => i.delivery === "queue")
      if (!item || ac.signal.aborted) break
      deliver(s, item)
      if (item.type === "compaction") {
        emit("session.compaction.started", { sessionID: s.id, reason: "manual", inputID: item.id })
        message(s, { id: id("msg"), type: "compaction", status: "completed", time: { created: Date.now() } })
        emit("session.compaction.ended", { sessionID: s.id, reason: "manual", text: "summary" })
        continue
      }
      outcome = await runScript(s, item.text, ac.signal)
      if (outcome !== "ok") break
    }
    s.running = false
    s.abort = undefined
    if (ac.signal.aborted && !s.shutdown) {
      message(s, { id: id("msg"), type: "idle", outcome: "interrupted" })
      emit("session.execution.interrupted", { sessionID: s.id, reason: "user" })
    } else if (s.shutdown || outcome === "declined") {
      s.shutdown = false
      emit("session.execution.interrupted", { sessionID: s.id, reason: "shutdown" })
    } else if (outcome.failed) {
      message(s, { id: id("msg"), type: "idle", outcome: "failed", error: outcome.failed })
      emit("session.execution.failed", { sessionID: s.id, error: outcome.failed })
    } else {
      message(s, { id: id("msg"), type: "idle", outcome: "succeeded" })
      emit("session.execution.succeeded", { sessionID: s.id })
    }
    s.onIdle?.()
    if (s.resumeAfterInterrupt && s.inbox.length) { s.resumeAfterInterrupt = false; void execute(s) }
  }

  const json = (res, status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(body === undefined ? "" : JSON.stringify(body)) }
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://x")
    const auth = req.headers.authorization ?? ""
    if (auth !== "Basic " + Buffer.from(`opencode:${password}`).toString("base64")) return json(res, 401, { message: "unauthorized" })
    if (!listening) { res.destroy(); return }
    let body
    if (req.method !== "GET" && req.method !== "DELETE") {
      const chunks = []
      for await (const c of req) chunks.push(c)
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined
    }
    requests.push({ method: req.method, path: url.pathname, query: url.search, body, directory: req.headers["x-opencode-directory"] })
    const p = url.pathname.split("/").filter(Boolean)
    if (url.pathname === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" })
      res.write(`data: ${JSON.stringify({ id: id("evt"), type: "server.connected", data: {} })}\n\n`)
      streams.add(res)
      req.on("close", () => streams.delete(res))
      return
    }
    if (url.pathname === "/api/info") return json(res, 200, { version, pid: process.pid, urls: [], paths: {}, capabilities: {} })
    if (url.pathname.startsWith("/api/model") && activating()) return json(res, 503, { message: "Location plugins did not finish activating" })
    if (url.pathname === "/api/model") return json(res, 200, { data: [
      { id: "big-pickle", providerID: "opencode", name: "Big Pickle", variants: [], limit: { context: 200000 }, enabled: true, status: "active" },
      { id: "flash", providerID: "opencode", name: "Flash", variants: [{ id: "low" }, { id: "high" }], limit: { context: 100000 }, enabled: true, status: "active" },
    ] })
    if (url.pathname === "/api/agent") {
      if (opts.noAgentRoute) return json(res, 404, { message: "no route" })
      return json(res, 200, { data: ["build", "plan", "general"].map((id) => ({ id, name: id, mode: id === "general" ? "subagent" : "primary", hidden: false, permissions: agentRules(id) })) })
    }
    if (url.pathname === "/api/model/default") return json(res, 200, { data: { id: "big-pickle", providerID: "opencode" } })
    if (url.pathname === "/api/session/active") return json(res, 200, { data: Object.fromEntries([...sessions.values()].filter((s) => s.running).map((s) => [s.id, { type: "running" }])) })
    if (url.pathname === "/api/session" && req.method === "POST") return json(res, 200, { data: info(newSession(body)) })
    if (url.pathname === "/api/session" && req.method === "GET") return json(res, 200, { data: [...sessions.values()].filter((s) => s.parentID === url.searchParams.get("parentID")).map(info) })
    if (p[0] === "api" && p[1] === "experimental" && p[2] === "session") {
      const s = sessions.get(p[3])
      if (!s) return json(res, 404, { message: "no session" })
      if (opts.noInstructions) return json(res, 404, { message: "no route" })
      if (req.method === "PUT") { s.instructions.set(p[6], body.value); return json(res, 204) }
      return json(res, 200, { data: Object.fromEntries(s.instructions) })
    }
    if (p[0] !== "api" || p[1] !== "session") return json(res, 404, { message: "no route" })
    const s = sessions.get(p[2])
    if (!s) return json(res, 404, { message: "no session" })
    const rest = p.slice(3).join("/")
    if (!rest && req.method === "GET") return json(res, 200, { data: info(s) })
    if (!rest && req.method === "PATCH") {
      if (body.title) { s.title = body.title; emit("session.renamed", { sessionID: s.id, title: body.title }) }
      if (body.permissions) s.permissions = body.permissions
      if (body.metadata) s.metadata = body.metadata
      return json(res, 200, { data: info(s) })
    }
    if (rest === "agent") { s.agent = body.agent; return json(res, 204) }
    if (rest === "model") { s.model = body.model; return json(res, 204) }
    if (rest === "environment") { s.env = body.variables; return json(res, 204) }
    if (rest === "prompt") {
      const item = enqueue(s, { id: body.id ?? id("msg"), type: "user", text: body.text, delivery: body.delivery ?? "steer" })
      return json(res, 200, { data: { id: item.id, sessionID: s.id, type: "user", payload: { text: item.text }, delivery: item.delivery } })
    }
    if (rest === "compact") { enqueue(s, { id: id("msg"), type: "compaction", text: "", delivery: "steer" }); return json(res, 200, { data: {} }) }
    if (rest === "inbox") return json(res, 200, { data: s.inbox.map((i) => ({ id: i.id, sessionID: s.id, type: i.type, payload: { text: i.text }, delivery: i.delivery })) })
    if (p[3] === "inbox" && req.method === "DELETE") {
      const at = s.inbox.findIndex((i) => i.id === p[4])
      if (at >= 0) { s.inbox.splice(at, 1); emit("session.inbox.cancelled", { sessionID: s.id, inboxID: p[4] }) }
      return json(res, 204)
    }
    if (p[3] === "inbox" && req.method === "PATCH") {
      const item = s.inbox.find((i) => i.id === p[4])
      if (item) item.delivery = body.delivery
      return json(res, 204)
    }
    if (rest === "interrupt") {
      const was = s.running
      if (url.searchParams.get("resume") === "true") s.resumeAfterInterrupt = true
      s.abort?.abort()
      return json(res, 200, { data: { interrupted: was } })
    }
    if (p[3] === "message" && p[4]) {
      if (opts.noMessageRoute) return json(res, 404, { message: "no route" })
      const m = s.messages.find((x) => x.id === p[4])
      return m ? json(res, 200, { data: m }) : json(res, 404, { message: "no message" })
    }
    if (rest === "message") {
      const desc = [...s.messages].sort((a, b) => b.seq - a.seq)
      const from = Number(url.searchParams.get("cursor") ?? 0)
      const limit = Number(url.searchParams.get("limit") ?? 50)
      const page = desc.slice(from, from + limit)
      return json(res, 200, { data: page, cursor: { ...(from + limit < desc.length ? { next: String(from + limit) } : {}) } })
    }
    if (rest === "permission") return json(res, 200, { data: [...s.permissionsPending.values()].map(({ resolve, ...r }) => r) })
    if (p[3] === "permission" && p[5] === "reply") {
      const pending = s.permissionsPending.get(p[4])
      if (!pending) return json(res, 404, { message: "no request" })
      pending.resolve(body)
      return json(res, 204)
    }
    if (rest === "form") return json(res, 200, { data: [...s.forms.values()].map((f) => f.form) })
    if (p[3] === "form") {
      const pending = s.forms.get(p[4])
      if (!pending) return json(res, 404, { message: "no form" })
      pending.resolve(req.method === "DELETE" ? undefined : body.answer)
      return json(res, 204)
    }
    return json(res, 404, { message: "no route" })
  })
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${server.address().port}`
  return {
    url, password, version, sessions, requests,
    registration: { id: "fake", version, url, pid: process.pid, password },
    emit,
    /** End every event stream. Events emitted until a client reconnects reach nobody. */
    dropStreams() { for (const res of streams) res.destroy(); streams.clear() },
    /** What a service restart costs a session: its environment, and every running turn gets a shutdown. */
    restart() { for (const s of sessions.values()) s.env = undefined; this.dropStreams() },
    /** Refuse connections for a while, as a stopped service does. */
    pause(on) { listening = !on; if (on) this.dropStreams() },
    async close() { this.dropStreams(); await new Promise((r) => server.close(r)) },
  }
}
