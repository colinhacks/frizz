// A LEASE on a provisioned runtime: "a live process still executes out of this version directory".
//
// runtimes.ts sweeps every version directory the current pin superseded, and until 2026-09-10 it did
// so on sight. That evening a source-tree stack pinned to Claude Code 2.1.268 booted against the
// machine's real `~/.frizz/runtimes` root (the ad-hoc stack shares it on purpose, to skip a 200 MB
// download) and retired `claude/2.1.267/` — the directory the RUNNING 0.12.9 server handed to every
// broker it forked. Daemons already up kept going (the binary stays mapped after the unlink); every
// NEW thread died before it could publish its record, and the operator saw only "Claude broker …
// did not become ready" for the rest of the day. The header of runtimes.ts had already named "a pin
// that can vanish under a running server" as the worst failure; the sweep was the one causing it.
//
// So a directory is only swept when nobody holds a live lease on it. A lease is a file named by pid
// under `<versionDir>/.leases/`, written by the server the moment it resolves a pin and by each
// detached daemon when it starts (a daemon outlives the server that forked it, and the codex
// app-server spawns helpers out of its own version directory long after boot). Liveness is the pid,
// checked with a null signal at sweep time, so a lease needs no refresh and a crash leaves nothing
// that lingers past the next sweep. A reused pid keeps a directory one sweep longer, which is the
// harmless direction.
//
// Deliberately tiny and fs-only: both daemon bundles import this, and neither should drag the
// provisioner's fetch/tar code along.
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

/** The marker provisionRuntime writes into a version directory; its presence is what makes one. */
const PROVISIONED_MARKER = "provisioned.json"
const LEASES_DIR = ".leases"
/** codex sits at `<label>/vendor/<triple>/bin/codex` — three levels down. Six leaves headroom. */
const MAX_ASCENT = 6

export interface RuntimeLease {
  pid: number
  role: string
  bin: string
  at: string
}

/** The provisioned version directory an executable lives in, or undefined for a PATH/override bin. */
export function runtimeVersionDir(bin: string): string | undefined {
  let dir = dirname(bin)
  for (let step = 0; step < MAX_ASCENT; step++) {
    if (existsSync(join(dir, PROVISIONED_MARKER))) return dir
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM" }
}

/** Record that this process runs `bin`. Best-effort: a lease that cannot be written costs one early
 *  sweep at worst, never the process. Returns a release for the normal exit path; a crash is covered
 *  by the pid check.
 *
 *  `pid` is for a process that cannot write its own: codex's native listener is codex's own program,
 *  so the server that starts it leases on its behalf. Until 2026-11-10 nothing did, and a later pin's
 *  sweep removed the version directory a surviving listener was still starting its helpers from. */
export function leaseRuntime(bin: string, role: string, pid: number = process.pid): () => void {
  const versionDir = runtimeVersionDir(bin)
  if (!versionDir) return () => {}
  const path = join(versionDir, LEASES_DIR, `${pid}.json`)
  try {
    mkdirSync(dirname(path), { recursive: true })
    const lease: RuntimeLease = { pid, role, bin, at: new Date().toISOString() }
    writeFileSync(path, JSON.stringify(lease))
  } catch { return () => {} }
  return () => { try { unlinkSync(path) } catch {} }
}

/** Every lease on a version directory whose holder is still running. Dead holders are pruned. */
export function liveRuntimeLeases(versionDir: string): RuntimeLease[] {
  const dir = join(versionDir, LEASES_DIR)
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const live: RuntimeLease[] = []
  for (const name of names) {
    if (!name.endsWith(".json")) continue
    const path = join(dir, name)
    let lease: Partial<RuntimeLease>
    try { lease = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeLease> } catch { continue }
    if (typeof lease.pid !== "number" || !pidAlive(lease.pid)) { try { unlinkSync(path) } catch {}; continue }
    live.push({ pid: lease.pid, role: typeof lease.role === "string" ? lease.role : "unknown", bin: typeof lease.bin === "string" ? lease.bin : "", at: typeof lease.at === "string" ? lease.at : "" })
  }
  return live
}
