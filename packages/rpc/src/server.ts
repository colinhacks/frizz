import type { Context, Hono } from "hono"
import { streamSSE } from "hono/streaming"
import { z } from "zod"

// ---- Procedure definition helpers ----

export type QueryDef<TInput extends z.ZodType | undefined, TOutput extends z.ZodType> = {
  _tag: "query"
  input?: TInput
  output: TOutput
  handler: (
    args: TInput extends z.ZodType ? { input: z.infer<TInput> } : {}
  ) => Promise<z.infer<TOutput>>
}

export type MutationDef<TInput extends z.ZodType, TOutput extends z.ZodType | undefined> = {
  _tag: "mutation"
  input: TInput
  output?: TOutput
  handler: (args: {
    input: z.infer<TInput>
  }) => Promise<TOutput extends z.ZodType ? z.infer<TOutput> : void>
}

export type StreamDef<TInput extends z.ZodType | undefined, TEvent extends z.ZodType> = {
  _tag: "stream"
  input?: TInput
  event: TEvent
  handler: (
    args: TInput extends z.ZodType ? { input: z.infer<TInput> } : {}
  ) => AsyncGenerator<z.infer<TEvent>>
}

export function query<
  TInput extends z.ZodType | undefined,
  TOutput extends z.ZodType,
>(
  def: Omit<QueryDef<TInput, TOutput>, "_tag">
): QueryDef<TInput, TOutput> {
  return { ...def, _tag: "query" }
}

export function mutation<
  TInput extends z.ZodType,
  TOutput extends z.ZodType | undefined = undefined,
>(
  def: Omit<MutationDef<TInput, TOutput>, "_tag">
): MutationDef<TInput, TOutput> {
  return { ...def, _tag: "mutation" }
}

export function stream<
  TInput extends z.ZodType | undefined,
  TEvent extends z.ZodType,
>(
  def: Omit<StreamDef<TInput, TEvent>, "_tag">
): StreamDef<TInput, TEvent> {
  return { ...def, _tag: "stream" }
}

// ---- Router type ----

export type AnyProcedure = QueryDef<any, any> | MutationDef<any, any> | StreamDef<any, any>
export type Router = Record<string, AnyProcedure>

// ---- Extract procedure map (shared with client) ----

export function extractProcedureMap(router: Router): Record<string, "query" | "mutation" | "stream"> {
  const map: Record<string, "query" | "mutation" | "stream"> = {}
  for (const [name, proc] of Object.entries(router)) {
    map[name] = proc._tag
  }
  return map
}

// A validation failure must travel as a READABLE STRING. Both clients surface `error` verbatim only
// when it is a string — the web one otherwise falls back to an opaque "RPC <name> failed", which hid
// a real timer-format bug behind a message naming nothing. Keep the field's type stable at `string`.
function validationMessage(error: z.ZodError): string {
  const issues = error.issues.map((i) => (i.path.length > 0 ? `${i.path.join(".")}: ${i.message}` : i.message))
  return issues.length > 0 ? issues.join("; ") : "Invalid input"
}

// A handler may additionally mark its failure as safely REPLAYABLE by raising an error carrying
// `retryableDelivery` (server/src/resume.ts RetryableDeliveryError): the operation was refused by a
// contention gate before it could take any effect, so the caller may send the identical request again
// instead of surfacing the failure. It rides the envelope as a separate boolean precisely because
// `error` itself must stay a plain readable string.
//
// `kept` is the other half of a failed follow-up: the server recorded the message in its delivery
// ledger (server/src/delivery-ledger.ts, the write-ahead entry) before the failure, and still holds it
// as a failed send the operator can retry or edit. The client then leaves the words where the server
// keeps them instead of also pushing them back into the prompt box.
/**
 * A handler's deliberate "no": the request was understood and refused, in a sentence written for whoever
 * asked. It is answered 409 with the same `{ error }` envelope, so a caller can tell a refusal from a
 * fault (500) without reading the sentence. `frizzctl` prints a refusal's sentence and exits 2, and
 * reports a fault as a failure. A plain Error thrown by a handler is still a 500: a handler throws this
 * instead where a caller needs the difference, which so far is every procedure a worker's `frizzctl`
 * calls (measured on 2026-11-09, a worker read `steerThread returned HTTP 500: {"error":"no thread …"}`
 * for a mistyped slug).
 */
export class RpcRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = "RpcRefusal"
  }
}

/** The status a refusal is answered with. */
export const RPC_REFUSED_STATUS = 409

const failureStatus = (err: unknown): 409 | 500 => (err instanceof RpcRefusal ? RPC_REFUSED_STATUS : 500)

function errorEnvelope(err: any): { error: string; retryable?: true; kept?: true } {
  const error = err?.message ?? "Internal server error"
  return {
    error,
    ...(err?.retryableDelivery === true ? { retryable: true as const } : {}),
    ...(err?.deliveryKept === true ? { kept: true as const } : {}),
  }
}

// ---- Mount router onto Hono ----

/**
 * Who may call what, judged at the one place a request's URL has already become a procedure. Returning a
 * Response ends the request with it. `procedure` runs first, for every request including a name this
 * router does not hold and the procedure list, before any input is read. `input` runs with the input as
 * parsed, for a rule that depends on what was asked.
 */
export interface RouterGuard {
  procedure(c: Context, name: string): Response | undefined
  input?(c: Context, name: string, input: unknown): Response | undefined
}

/**
 * A query's or a stream's input, off its `?input=` parameter. Hono's `c.req.query` has already
 * percent-decoded it, and every client encodes once (`url.searchParams.set`), so this is the JSON as
 * sent. It was decoded a second time until 2026-11-10: any input holding a `%` either failed the
 * decode and was refused as invalid JSON (`"notes/50% done.md"`), or came through altered
 * (`"a%2Fb.md"` arrived as `"a/b.md"`).
 */
function readQueryInput(raw: string): unknown {
  return JSON.parse(raw)
}

export function mountRouter(app: Hono, prefix: string, router: Router, guard?: RouterGuard) {
  // Serve the procedure map so the client can self-configure
  const procMap = extractProcedureMap(router)
  app.get(`${prefix}/__procedures`, (c) => guard?.procedure(c, "__procedures") ?? c.json(procMap))

  for (const [name, proc] of Object.entries(router)) {
    const path = `${prefix}/${name}`

    if (proc._tag === "query") {
      app.get(path, async (c) => {
        const refused = guard?.procedure(c, name)
        if (refused) return refused
        const rawInput = c.req.query("input")
        let input: unknown
        if (rawInput) {
          try {
            input = readQueryInput(rawInput)
          } catch {
            return c.json({ error: "Invalid input JSON" }, 400)
          }
        }
        if (proc.input) {
          const parsed = proc.input.safeParse(input)
          if (!parsed.success) {
            return c.json({ error: validationMessage(parsed.error) }, 400)
          }
          input = parsed.data
        }
        const refusedInput = guard?.input?.(c, name, input)
        if (refusedInput) return refusedInput
        try {
          const result = await proc.handler(input !== undefined ? { input } : {} as any)
          return c.json({ result })
        } catch (err: any) {
          return c.json(errorEnvelope(err), failureStatus(err))
        }
      })
    } else if (proc._tag === "mutation") {
      app.post(path, async (c) => {
        const refused = guard?.procedure(c, name)
        if (refused) return refused
        let input: unknown
        const contentType = c.req.header("content-type")
        if (contentType?.includes("application/json")) {
          // A body that is not JSON is the caller's mistake, so it is a 400 like any other bad input.
          // Unguarded, the parse threw out of the handler and Hono answered 500.
          try {
            input = await c.req.json()
          } catch {
            return c.json({ error: "Invalid input JSON" }, 400)
          }
        }
        if (proc.input) {
          const parsed = proc.input.safeParse(input)
          if (!parsed.success) {
            return c.json({ error: validationMessage(parsed.error) }, 400)
          }
          input = parsed.data
        }
        const refusedInput = guard?.input?.(c, name, input)
        if (refusedInput) return refusedInput
        try {
          const result = await proc.handler({ input } as any)
          return c.json({ result: result ?? null })
        } catch (err: any) {
          return c.json(errorEnvelope(err), failureStatus(err))
        }
      })
    } else if (proc._tag === "stream") {
      app.get(path, async (c) => {
        const refused = guard?.procedure(c, name)
        if (refused) return refused
        const rawInput = c.req.query("input")
        let input: unknown
        if (rawInput) {
          try {
            input = readQueryInput(rawInput)
          } catch {
            return c.json({ error: "Invalid input JSON" }, 400)
          }
        }
        if (proc.input) {
          const parsed = proc.input.safeParse(input)
          if (!parsed.success) {
            return c.json({ error: validationMessage(parsed.error) }, 400)
          }
          input = parsed.data
        }
        const refusedInput = guard?.input?.(c, name, input)
        if (refusedInput) return refusedInput
        return streamSSE(c, async (sseStream) => {
          let id = 0
          const gen = proc.handler(input !== undefined ? { input } : {} as any)
          for await (const event of gen) {
            await sseStream.writeSSE({
              data: JSON.stringify(event),
              id: String(id++),
            })
          }
        })
      })
    }
  }

  // Registered LAST so every concrete procedure above wins the match: an unknown name under this prefix
  // is almost always version SKEW rather than a routing accident, because a frizz worker's MCP server is
  // spawned once from the build its session was dispatched with and outlives every server restart — it
  // keeps POSTing whatever procedure names THAT build knew. Hono's fall-through answers those with a bare
  // `404 Not Found` naming nothing, which is exactly how a renamed procedure cost a live worker three
  // silent retries and a debugging session. Name the procedure and say what a 404 here MEANS, in the
  // readable-string `error` field both clients surface verbatim.
  app.all(`${prefix}/:procedure`, (c) =>
    guard?.procedure(c, c.req.param("procedure")) ?? c.json(
      {
        error:
          `unknown RPC procedure \`${c.req.param("procedure")}\` — this server does not implement it. ` +
          `A caller built against a different version of frizz is the usual cause.`,
      },
      404,
    ))
}
