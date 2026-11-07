import { execFile, spawn } from "node:child_process"
import { existsSync, readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { findOnPath } from "./acp-agents.ts"
import { asObject, asString } from "./opencode-types.ts"
import { inheritWorkerEnvironment } from "./worker-env.ts"

// Finding the person's OpenCode (ARCHITECTURE.md § OpenCode backend). Frizz connects to the managed
// background service OpenCode already runs for itself, the one its terminal and desktop clients share, and
// never runs a private one: the service holds the database and sweeps a restarted turn, and an
// unregistered server sharing that database does neither.
//
// `opencode service start` is called only when nothing healthy is registered, because it REPLACES a healthy
// service of another version. Frizz never stops or restarts the service: other clients are attached to it.

export const OPENCODE_MIN_VERSION = "2.0.27"
const START_WAIT_MS = 30_000

export interface OpencodeRegistration { id?: string; version?: string; url: string; pid?: number; password?: string }

/** Its `password` is a credential: never log this object, and never hand it to a worker. */
export function readOpencodeRegistration(env: NodeJS.ProcessEnv = process.env): OpencodeRegistration | undefined {
  let raw: unknown
  try { raw = JSON.parse(readFileSync(opencodeRegistrationPath(env), "utf8")) } catch { return undefined }
  const obj = asObject(raw)
  const url = asString(obj?.url)
  if (!obj || !url) return undefined
  return {
    url,
    ...(asString(obj.id) ? { id: obj.id as string } : {}),
    ...(asString(obj.version) ? { version: obj.version as string } : {}),
    ...(typeof obj.pid === "number" ? { pid: obj.pid } : {}),
    ...(asString(obj.password) ? { password: obj.password as string } : {}),
  }
}

export function opencodeRegistrationPath(env: NodeJS.ProcessEnv = process.env): string {
  const state = env.XDG_STATE_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".local", "state")
  return join(state, "opencode", "service.json")
}

/** Dotted versions, numerically. A pre-release suffix reads as its base version. */
export function opencodeVersionAtLeast(version: string | undefined, min: string): boolean {
  if (!version) return false
  const parts = (v: string) => v.replace(/^v/, "").split(/[-+]/)[0]!.split(".").map((n) => Number.parseInt(n, 10) || 0)
  const a = parts(version)
  const b = parts(min)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0)
    if (d !== 0) return d > 0
  }
  return true
}

export function resolveOpencodeBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const override = env.FRIZZ_OPENCODE_BIN?.trim()
  if (override) return existsSync(override) ? override : undefined
  return findOnPath("opencode", env) ?? undefined
}

const versionCache = new Map<string, { mtimeMs: number; version: string | undefined }>()

/** `opencode --version`, cached per binary until it changes on disk, for the composer: it answers whether
 *  the native entry is offered without ever starting a service for someone who does not use OpenCode. */
export function opencodeBinaryVersion(bin: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  let mtimeMs = -1
  try { mtimeMs = statSync(bin).mtimeMs } catch { return Promise.resolve(undefined) }
  const cached = versionCache.get(bin)
  if (cached && cached.mtimeMs === mtimeMs) return Promise.resolve(cached.version)
  return new Promise((resolve) => {
    execFile(bin, ["--version"], { timeout: 20_000, env: inheritWorkerEnvironment(env) }, (err, stdout) => {
      const version = err ? undefined : /(\d+\.\d+\.\d+[\w.+-]*)/.exec(String(stdout))?.[1]
      versionCache.set(bin, { mtimeMs, version })
      resolve(version)
    })
  })
}

/** Whether this machine should offer the native backend. */
export async function opencodeNativeAvailable(env: NodeJS.ProcessEnv = process.env): Promise<{ available: boolean; version?: string; reason?: string }> {
  const bin = resolveOpencodeBinary(env)
  if (!bin) return { available: false, reason: "OpenCode is not installed, or `opencode` is not on PATH." }
  const version = await opencodeBinaryVersion(bin, env)
  if (!version) return { available: false, reason: `Could not read the version of ${bin}.` }
  if (!opencodeVersionAtLeast(version, OPENCODE_MIN_VERSION)) return { available: false, version, reason: `OpenCode ${version} is older than ${OPENCODE_MIN_VERSION}.` }
  return { available: true, version }
}

function authHeader(reg: OpencodeRegistration): Record<string, string> {
  return reg.password ? { authorization: `Basic ${Buffer.from(`opencode:${reg.password}`).toString("base64")}` } : {}
}

/** Whether the registered service answers, and what it says it is. */
export async function probeOpencodeService(reg: OpencodeRegistration, timeoutMs = 3_000): Promise<{ version?: string } | undefined> {
  try {
    const res = await fetch(`${reg.url}/api/info`, { headers: authHeader(reg), signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return undefined
    const info = asObject(await res.json())
    return { ...(asString(info?.version) ? { version: info!.version as string } : {}) }
  } catch {
    return undefined
  }
}

export interface OpencodeDiscovery { registration: OpencodeRegistration; version?: string }

/** A healthy registered service, without starting one. */
export async function discoverOpencodeService(env: NodeJS.ProcessEnv = process.env): Promise<OpencodeDiscovery | undefined> {
  const registration = readOpencodeRegistration(env)
  if (!registration) return undefined
  const info = await probeOpencodeService(registration)
  return info ? { registration, ...(info.version ? { version: info.version } : {}) } : undefined
}

let starting: Promise<OpencodeDiscovery> | undefined

/** A healthy service, starting one only when none is registered or it stopped answering. Shared across
 *  the projects on this server, so two dispatches at once run `service start` once. */
export function ensureOpencodeService(env: NodeJS.ProcessEnv = process.env, opts: { waitMs?: number } = {}): Promise<OpencodeDiscovery> {
  if (starting) return starting
  starting = ensure(env, opts.waitMs ?? START_WAIT_MS).finally(() => { starting = undefined })
  return starting
}

async function ensure(env: NodeJS.ProcessEnv, waitMs: number): Promise<OpencodeDiscovery> {
  const existing = await discoverOpencodeService(env)
  if (existing) return checked(existing)
  const bin = resolveOpencodeBinary(env)
  if (!bin) throw new Error("OpenCode is not installed, or `opencode` is not on PATH.")
  await new Promise<void>((resolve, reject) => {
    // The service outlives this server, and the environment it starts with is what a session's shell falls
    // back on, so it takes the worker's filtered environment rather than Frizz's own control plane.
    const child = spawn(bin, ["service", "start"], { env: inheritWorkerEnvironment(env), stdio: "ignore", detached: true })
    child.once("error", (err) => reject(new Error(`Could not start OpenCode's service (${bin}): ${err.message}`)))
    child.once("exit", () => resolve())
    child.unref()
  })
  const deadline = Date.now() + waitMs
  while (Date.now() < deadline) {
    const found = await discoverOpencodeService(env)
    if (found) return checked(found)
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error("`opencode service start` finished, but no healthy OpenCode service registered itself.")
}

function checked(found: OpencodeDiscovery): OpencodeDiscovery {
  if (found.version && !opencodeVersionAtLeast(found.version, OPENCODE_MIN_VERSION)) {
    throw new Error(`The running OpenCode service is ${found.version}; Frizz needs ${OPENCODE_MIN_VERSION} or newer. Upgrade it with \`opencode upgrade\`, then retry.`)
  }
  return found
}
