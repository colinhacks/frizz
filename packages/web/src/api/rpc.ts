import { noteServerBootId } from "./boot.ts"
import { store } from "../store.ts"
import { PROCEDURES, type Api, type ProcType, type RpcCallOpts } from "./contract.ts"
import { FRIZZ_ROUTE_PREFIX } from "@frizz/shared"
import { apiBase, isConsolePath, projectApiBase } from "../lib/base-path.ts"
import { splitThreadKey, threadKey } from "../lib/threadKey.ts"

export type { Api, ProcType, RpcCallOpts } from "./contract.ts"
export { PROCEDURES } from "./contract.ts"

export const CONTROL_PLANE_RESTARTING_MESSAGE = "Frizz is updating and restarting. Your draft is preserved; wait until it is ready before sending or changing settings."

// A failure the caller may safely REPLAY, because the request provably took no effect: either the
// server refused it at a contention gate upstream of any side effect (`retryable` in the error
// envelope — see RetryableDeliveryError), or it was refused here before it ever reached the wire.
// The absence of this marker means AMBIGUOUS — the request may well have landed — so an unmarked
// failure must be surfaced, never re-sent.
export function isRetryableRpcError(error: unknown): boolean {
  return (error as { retryableRpc?: unknown } | null)?.retryableRpc === true
}

// The server wrote this follow-up into its delivery ledger before the failure and still holds it — as a
// failed bubble with Retry / Edit / Dismiss (`kept` in the envelope; server/src/router.ts
// keepFailedFollowUp). The words are no longer only the browser's to lose.
export function isKeptDeliveryError(error: unknown): boolean {
  return (error as { deliveryKept?: unknown } | null)?.deliveryKept === true
}

function markRetryable(error: Error): Error {
  Object.defineProperty(error, "retryableRpc", { value: true, enumerable: false })
  return error
}

export function assertMutationAllowedDuringControlPlaneTransition(type: ProcType): void {
  if (type === "mutation" && store.controlPlaneState === "restarting") {
    // Nothing was sent, so this is the safest replay there is: a send caught by a build promotion
    // should wait the promotion out, not be handed back to the operator as a failure.
    throw markRetryable(new Error(CONTROL_PLANE_RESTARTING_MESSAGE))
  }
}

// Parse one RPC envelope without leaking a browser JSON SyntaxError into the UI. During local HMR the
// web bundle can update before the long-running server process; a brand-new route then returns Hono's
// plain-text 404 ("404 Not Found"), which `res.json()` misleadingly reported as "Unexpected
// non-whitespace character after JSON". Name that operational fix directly.
export async function parseRpcResponse(res: Response, name: string): Promise<unknown> {
  const body = await res.text()
  let json: { result?: unknown; error?: unknown; retryable?: unknown; kept?: unknown }
  try {
    json = JSON.parse(body) as { result?: unknown; error?: unknown; retryable?: unknown; kept?: unknown }
  } catch {
    if (res.status === 404 || res.status === 405) {
      throw new Error("Frizz server restart required — this control is newer than the running server")
    }
    // SAY THE STATUS. A non-JSON body is always something OTHER than the RPC answering, and which
    // something is the entire diagnosis — 403 is the local-origin gate refusing (a stale tab, a
    // host/origin mismatch), 5xx is the server failing, 200-with-HTML is a dev restart window serving
    // the SPA shell. Reporting all of them as "invalid response" sent one debugging session down the
    // wrong path entirely (2026-08-15: a 403 read as a schema problem and cost half an hour).
    if (res.status === 403) {
      throw new Error(`RPC ${name} was refused (403) — the page's origin does not match the server it is talking to. Reload from the URL frizz is actually serving.`)
    }
    throw new Error(`RPC ${name} returned a non-JSON response (HTTP ${res.status})`)
  }
  if (!res.ok) {
    const error = new Error(typeof json.error === "string" ? json.error : `RPC ${name} failed`)
    if (json.kept === true) Object.defineProperty(error, "deliveryKept", { value: true, enumerable: false })
    throw json.retryable === true ? markRetryable(error) : error
  }
  return json.result
}

// WHICH PROJECT A CALL IS FOR, and the one place that decides it.
//
// On a project's page the page says (`apiBase()`), as it always has. On the Console the page names no
// project, so the CALL must: a thread procedure names its thread by key (lib/threadKey.ts), and the key
// carries the project; a project procedure is made through `rpcFor(project)`. What the Console must never
// do is fall through to `apiBase()`, which there answers `/_frizz` — the project that LAUNCHED the server
// — so a call that forgot its project would read or write a stranger's state and look like it worked.
// Here that call throws instead.

/**
 * Procedures that read ONE project's state but name no thread in their input, so nothing in the call
 * says which project they are for (packages/server/src/router.ts reads `ctx.project`, its storage, its
 * settings or its roots for each). The Console must make them through `rpcFor`.
 *
 * `settingsGet`/`settingsSet`/`settingsReset` are deliberately NOT here: the keys the Console itself
 * reads (`notifications`, `projectRail`, the file opener) are machine-level (server/settings.ts), and any
 * project answers them the same way. The AGENT settings are per project, though, so the prompt box's
 * gear makes its calls through its scope's `rpcFor` (hooks/useSettingsAutosave.tsx).
 */
export const PROJECT_SCOPED_PROCEDURES: ReadonlySet<string> = new Set([
  "board",
  "dispatch",
  "repairThread",
  "openLocalFile",
  "localMarkdown",
  "localFile",
  "resolveLocalPaths",
  "githubStatus",
  "githubList",
  "githubDispatchBatch",
  "claudeModels",
  "acpAgents",
  "acpAgentModels",
  "opencodeModels",
  // Names its threads in a list, not by a keyed `slug`, so the key cannot route it: the Console makes
  // one call per project through `rpcFor` (lib/consoleBoard.ts reorderConsolePins).
  "reorderConsolePinnedThreads",
])

/** Machine-wide procedures whose input carries a REAL slug that is not this page's thread. */
const MACHINE_SLUG_PROCEDURES: ReadonlySet<string> = new Set(["threadLocate"])

export interface RoutedCall {
  base: string
  input: unknown
  /** The project the call was sent to by name — set on the Console's calls, and only there. */
  project?: string
}

/** Where `name` goes and with what input. Pure apart from reading the page's path; unit-tested. */
export function routeCall(name: string, input: unknown, project?: string, pathname?: string): RoutedCall {
  const onConsole = isConsolePath(pathname)
  const slug = input && typeof input === "object" ? (input as { slug?: unknown }).slug : undefined
  const parts = typeof slug === "string" ? splitThreadKey(slug) : null
  if (parts) {
    if (project && parts.project !== project) throw new Error(`RPC ${name}: ${slug} is not a thread of ${project}`)
    return { base: projectApiBase(parts.project), input: { ...(input as object), slug: parts.slug }, project: parts.project }
  }
  if (project) return { base: projectApiBase(project), input, project }
  if (onConsole) {
    if (typeof slug === "string" && !MACHINE_SLUG_PROCEDURES.has(name)) {
      throw new Error(`RPC ${name}: "${slug}" names no project, and the Console has none of its own`)
    }
    if (PROJECT_SCOPED_PROCEDURES.has(name)) throw new Error(`RPC ${name} needs a project on the Console`)
  }
  return { base: apiBase(pathname), input }
}

// A slug the server hands BACK names a thread in the project the call went to. On the Console it goes
// back out as a key, so whatever the caller does with it next — open a drawer, call again, key a cache —
// stays addressed to that project. Outputs are not validated by the server's RPC layer, so the shapes
// are named here one by one, beside the procedures that return them.
function rekeyOutput(name: string, result: unknown, project: string): unknown {
  if (!result || typeof result !== "object") return result
  const key = (slug: unknown) => (typeof slug === "string" && !splitThreadKey(slug) ? threadKey(project, slug) : slug)
  switch (name) {
    case "dispatch":
    case "adoptThread":
    case "repairThread": {
      const r = result as { slug?: unknown }
      return { ...r, slug: key(r.slug) }
    }
    case "githubDispatchBatch": {
      const r = result as { dispatched?: { slug?: unknown }[] }
      return { ...r, dispatched: r.dispatched?.map((d) => ({ ...d, slug: key(d.slug) })) }
    }
    case "pendingInteractions":
    case "interactionGet":
    case "interactionResolve":
    case "interactionCancel": {
      const rekeyRecord = (record: { owner?: { threadSlug?: unknown } }) =>
        record?.owner ? { ...record, owner: { ...record.owner, threadSlug: key(record.owner.threadSlug) } } : record
      const r = result as { interactions?: { owner?: { threadSlug?: unknown } }[]; interaction?: { owner?: { threadSlug?: unknown } } }
      return {
        ...r,
        ...(r.interactions ? { interactions: r.interactions.map(rekeyRecord) } : {}),
        ...(r.interaction ? { interaction: rekeyRecord(r.interaction) } : {}),
      }
    }
    default:
      return result
  }
}

async function call(name: string, type: ProcType, rawInput?: unknown, opts?: RpcCallOpts, project?: string): Promise<unknown> {
  // The old child may remain healthy while its durable owner is building a replacement. Do not let
  // a mutation race that handoff; local draft state remains editable and every query stays available.
  assertMutationAllowedDuringControlPlaneTransition(type)
  const routed = routeCall(name, rawInput, project)
  const { base, input } = routed
  // Whether this is a Console call is decided NOW, not when the answer lands: a dispatch can take
  // seconds, and an operator who moved to a project's page meanwhile still started a thread in the
  // project the call went to. Read after the await, a bare slug came back and opened that page's
  // same-named thread instead (ARCHITECTURE.md § Switching projects: capture before the await).
  const rekey = routed.project !== undefined && isConsolePath()
  const finish = (result: unknown) => (rekey ? rekeyOutput(name, result, routed.project!) : result)
  if (type === "query") {
    const url = new URL(`${base}/rpc/${name}`, location.origin)
    if (input !== undefined) url.searchParams.set("input", JSON.stringify(input))
    const res = await fetch(url.toString(), { signal: opts?.signal })
    noteServerBootId(res.headers.get("x-frizz-boot")) // notice a server restart on any RPC roundtrip
    return finish(await parseRpcResponse(res, name))
  }
  const res = await fetch(`${base}/rpc/${name}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input ?? {}),
    signal: opts?.signal,
  })
  noteServerBootId(res.headers.get("x-frizz-boot"))
  return finish(await parseRpcResponse(res, name))
}

function rpcProxy(project?: string): Api {
  return new Proxy({} as Api, {
    get(_target, name: string) {
      const type = (PROCEDURES as Record<string, ProcType | undefined>)[name]
      if (!type) return undefined
      return (input?: unknown, opts?: RpcCallOpts) => call(name, type, input, opts, project)
    },
  })
}

export const rpc = rpcProxy()

const projectRpcs = new Map<string, Api>()

/**
 * The API of ONE named project, from any page — how the Console makes a project procedure (the prompt
 * box's dispatch, a card's file reads). Undefined means "this page's project", which is plain `rpc`.
 */
export function rpcFor(project: string | undefined): Api {
  if (!project) return rpc
  let api = projectRpcs.get(project)
  if (!api) projectRpcs.set(project, (api = rpcProxy(project)))
  return api
}
