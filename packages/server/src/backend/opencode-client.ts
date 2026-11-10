import { asArray, asObject, asString, parseOpencodeEvent, type Json, type OpencodeEvent, type OpencodeRule } from "./opencode-types.ts"
import type { OpencodeRegistration } from "./opencode-service.ts"

// A hand-rolled client for the few routes Frizz uses of OpenCode 2's server API, rather than
// `@opencode/client`, whose generated surface moves with every release. It holds the service password and
// never puts it in an error or a log line.

export class OpencodeHttpError extends Error {
  constructor(readonly status: number, readonly route: string, detail: string) {
    super(`OpenCode ${route} answered ${status}${detail ? `: ${detail}` : ""}`)
  }
}

export type ModelRef = { providerID: string; id: string; variant?: string }

const REQUEST_TIMEOUT_MS = 30_000

export class OpencodeClient {
  private readonly auth: Record<string, string>
  constructor(readonly registration: OpencodeRegistration) {
    this.auth = registration.password ? { authorization: `Basic ${Buffer.from(`opencode:${registration.password}`).toString("base64")}` } : {}
  }

  private async send(method: string, path: string, opts: { body?: unknown; directory?: string; timeoutMs?: number } = {}): Promise<unknown> {
    const route = `${method} ${path.split("?")[0]}`
    const res = await fetch(`${this.registration.url}${path}`, {
      method,
      headers: {
        ...this.auth,
        ...(opts.directory ? { "x-opencode-directory": encodeURI(opts.directory) } : {}),
        ...(opts.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
    })
    const text = await res.text()
    if (!res.ok) {
      let detail = ""
      try { detail = asString(asObject(JSON.parse(text))?.message) ?? asString(asObject(asObject(JSON.parse(text))?.data)?.message) ?? "" } catch { detail = text.slice(0, 200) }
      throw new OpencodeHttpError(res.status, route, detail.slice(0, 500))
    }
    if (!text) return undefined
    try { return JSON.parse(text) } catch { return text }
  }

  private async data(method: string, path: string, opts: { body?: unknown; directory?: string; timeoutMs?: number } = {}): Promise<unknown> {
    const raw = await this.send(method, path, opts)
    const obj = asObject(raw)
    return obj && "data" in obj ? obj.data : raw
  }

  info(): Promise<unknown> { return this.send("GET", "/api/info") }
  /** Every agent with its resolved rules (built-ins, then the person's configuration), the default primary one first. */
  async agents(directory: string): Promise<Json[]> { return asArray(await this.data("GET", "/api/agent", { directory })).map((a) => asObject(a)).filter((a): a is Json => !!a) }
  async models(directory: string): Promise<Json[]> { return asArray(await this.data("GET", "/api/model", { directory })).map((m) => asObject(m)).filter((m): m is Json => !!m) }
  async defaultModel(directory: string): Promise<Json | undefined> { return asObject(await this.data("GET", "/api/model/default", { directory })) }

  async createSession(body: { model?: ModelRef; agent?: string; title?: string; parentID?: string; directory: string; metadata?: Json; permissions?: OpencodeRule[] }): Promise<Json> {
    const { directory, ...rest } = body
    const session = asObject(await this.data("POST", "/api/session", { body: { ...rest, location: { directory } }, directory }))
    if (!asString(session?.id)) throw new Error("OpenCode created a session without an id")
    return session!
  }
  /** One message, with its parts (a tool part carries the call's input). */
  async message(id: string, messageId: string, directory?: string): Promise<Json | undefined> { return asObject(await this.data("GET", `/api/session/${id}/message/${encodeURIComponent(messageId)}`, { directory })) }
  async getSession(id: string, directory?: string): Promise<Json | undefined> { return asObject(await this.data("GET", `/api/session/${id}`, { directory })) }
  async childSessions(id: string, directory: string): Promise<Json[]> {
    const raw = await this.data("GET", `/api/session?parentID=${encodeURIComponent(id)}&limit=200`, { directory })
    return asArray(raw).map((s) => asObject(s)).filter((s): s is Json => !!s)
  }
  async patchSession(id: string, body: { title?: string; metadata?: Json; permissions?: OpencodeRule[] }, directory?: string): Promise<void> { await this.send("PATCH", `/api/session/${id}`, { body, directory }) }
  async selectAgent(id: string, agent: string, directory?: string): Promise<void> { await this.send("POST", `/api/session/${id}/agent`, { body: { agent }, directory }) }
  async selectModel(id: string, model: ModelRef, directory?: string): Promise<void> { await this.send("POST", `/api/session/${id}/model`, { body: { model }, directory }) }
  async prompt(id: string, body: { id?: string; text: string; delivery?: "steer" | "queue" }, directory?: string): Promise<void> { await this.send("POST", `/api/session/${id}/prompt`, { body, directory }) }
  async compact(id: string, directory?: string): Promise<void> { await this.send("POST", `/api/session/${id}/compact`, { body: {}, directory }) }
  async inbox(id: string, directory?: string): Promise<Json[]> { return asArray(await this.data("GET", `/api/session/${id}/inbox`, { directory })).map((i) => asObject(i)).filter((i): i is Json => !!i) }
  async cancelInbox(id: string, inboxId: string, directory?: string): Promise<void> { await this.send("DELETE", `/api/session/${id}/inbox/${encodeURIComponent(inboxId)}`, { directory }) }
  async patchInbox(id: string, inboxId: string, delivery: "steer" | "queue", directory?: string): Promise<void> { await this.send("PATCH", `/api/session/${id}/inbox/${encodeURIComponent(inboxId)}`, { body: { delivery }, directory }) }
  async interrupt(id: string, opts: { resume?: boolean; directory?: string } = {}): Promise<void> { await this.send("POST", `/api/session/${id}/interrupt${opts.resume ? "?resume=true" : ""}`, { directory: opts.directory }) }
  /** One page of a session's messages, newest first. */
  async messages(id: string, opts: { cursor?: string; directory?: string } = {}): Promise<{ data: Json[]; cursor?: string }> {
    const raw = asObject(await this.send("GET", `/api/session/${id}/message?limit=200&order=desc${opts.cursor ? `&cursor=${encodeURIComponent(opts.cursor)}` : ""}`, { directory: opts.directory }))
    const cursor = asString(asObject(raw?.cursor)?.next) ?? asString(raw?.cursor)
    return { data: asArray(raw?.data).map((m) => asObject(m)).filter((m): m is Json => !!m), ...(cursor ? { cursor } : {}) }
  }
  async active(): Promise<Set<string>> { return new Set(Object.keys(asObject(await this.data("GET", "/api/session/active")) ?? {})) }
  async permissions(id: string, directory?: string): Promise<Json[]> { return asArray(await this.data("GET", `/api/session/${id}/permission`, { directory })).map((p) => asObject(p)).filter((p): p is Json => !!p) }
  async replyPermission(id: string, requestId: string, decision: "once" | "always" | "reject", directory?: string, message?: string): Promise<void> { await this.send("POST", `/api/session/${id}/permission/${requestId}/reply`, { body: { decision, ...(message ? { message } : {}) }, directory }) }
  async forms(id: string, directory?: string): Promise<Json[]> { return asArray(await this.data("GET", `/api/session/${id}/form`, { directory })).map((f) => asObject(f)).filter((f): f is Json => !!f) }
  async replyForm(id: string, formId: string, answer: Json, directory?: string): Promise<void> { await this.send("POST", `/api/session/${id}/form/${formId}/reply`, { body: { answer }, directory }) }
  async cancelForm(id: string, formId: string, directory?: string): Promise<void> { await this.send("DELETE", `/api/session/${id}/form/${formId}`, { directory }) }
  async putEnvironment(id: string, variables: Record<string, string>, directory?: string): Promise<void> { await this.send("PUT", `/api/session/${id}/environment`, { body: { variables }, directory }) }
  async putInstruction(id: string, key: string, value: string, directory?: string): Promise<void> { await this.send("PUT", `/api/experimental/session/${id}/instructions/entries/${key}`, { body: { value }, directory }) }

  /** The event stream: `onEvent` for each frame until the stream ends or `signal` aborts. The reader never
   *  waits on `onEvent`, because the server fails a slow consumer's stream. */
  async stream(signal: AbortSignal, onEvent: (ev: OpencodeEvent) => void): Promise<void> {
    const res = await fetch(`${this.registration.url}/api/event`, { headers: { ...this.auth, accept: "text/event-stream" }, signal })
    if (!res.ok || !res.body) throw new OpencodeHttpError(res.status, "GET /api/event", "")
    const decoder = new TextDecoder()
    let buffer = ""
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n")
      let at: number
      while ((at = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, at)
        buffer = buffer.slice(at + 2)
        const data = frame.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim()).join("\n")
        if (!data) continue
        let parsed: unknown
        try { parsed = JSON.parse(data) } catch { continue }
        const ev = parseOpencodeEvent(parsed)
        if (ev) onEvent(ev)
      }
    }
  }
}
