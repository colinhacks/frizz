import { execFile } from "node:child_process"
import { SHARE_ENV, Worker } from "node:worker_threads"

// CHILD PROCESSES STARTED FROM A WORKER THREAD.
//
// Starting a process blocks the thread that starts it until the fork and exec are done, and the async
// `execFile` only saves the wait for the process to FINISH. On a Mac at load 100 the start alone cost 47ms
// each on the live server (profiled 2026-11-06: 75 `lsof` starts held the main thread for 3.5s in 5 minutes),
// and every RPC, board push and transcript read in Frizz queues behind that thread. This runs them from a
// worker instead, so the main thread never takes the hit.
//
// The worker is inline source rather than a file of its own so the bundle has nothing to emit beside it, and
// `execFile` is all it does: no state, nothing to go stale. A worker that cannot start or that dies hands its
// work back to this thread, which is slower and still correct.

export interface OffThreadExecOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  timeout?: number
  maxBuffer?: number
  windowsHide?: boolean
  /** Written to the child's stdin, which then closes. */
  input?: string
}

export interface OffThreadExecResult {
  stdout: string
  stderr: string
}

/** The same shape a promisified `execFile` rejects with: `code` is the exit code, or a string such as ENOENT. */
export type OffThreadExecError = Error & OffThreadExecResult & {
  code?: number | string
  signal?: string | null
  killed?: boolean
}

interface ExecRequest {
  file: string
  args: readonly string[]
  options: OffThreadExecOptions
  resolve: (result: OffThreadExecResult) => void
  reject: (error: OffThreadExecError) => void
}

const WORKER_SOURCE = `
const { parentPort } = require("node:worker_threads");
const { execFile } = require("node:child_process");
parentPort.on("message", ({ id, file, args, options, input }) => {
  const done = (error, stdout, stderr) => parentPort.postMessage({
    id,
    stdout: stdout ?? "",
    stderr: stderr ?? "",
    error: error ? { message: error.message, code: error.code, signal: error.signal, killed: error.killed } : null,
  });
  try {
    const child = execFile(file, args, { ...options, encoding: "utf8" }, done);
    if (input !== undefined) {
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    }
  } catch (error) {
    done(error);
  }
});
`

function runOnThisThread({ file, args, options: { input, ...options }, resolve, reject }: ExecRequest): void {
  try {
    const child = execFile(file, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(error, { stdout, stderr }) as OffThreadExecError)
      else resolve({ stdout, stderr })
    })
    if (input !== undefined) {
      child.stdin?.on("error", () => {})
      child.stdin?.end(input)
    }
  } catch (error) {
    reject(Object.assign(error as Error, { stdout: "", stderr: "" }))
  }
}

let worker: Worker | undefined
const inFlight = new Map<number, ExecRequest>()
let nextId = 0

function abandonWorker(from: Worker): void {
  if (worker !== from) return
  worker = undefined
  const orphaned = [...inFlight.values()]
  inFlight.clear()
  for (const request of orphaned) runOnThisThread(request)
}

function liveWorker(): Worker | undefined {
  if (worker) return worker
  try {
    const started = new Worker(WORKER_SOURCE, { eval: true, env: SHARE_ENV, stdout: false, stderr: false })
    started.on("message", ({ id, stdout, stderr, error }: OffThreadExecResult & { id: number; error: { message: string; code?: number | string; signal?: string | null; killed?: boolean } | null }) => {
      const request = inFlight.get(id)
      if (!request) return
      inFlight.delete(id)
      if (inFlight.size === 0) started.unref()
      if (error) request.reject(Object.assign(new Error(error.message), { ...error, stdout, stderr }))
      else request.resolve({ stdout, stderr })
    })
    started.on("error", () => abandonWorker(started))
    started.on("exit", () => abandonWorker(started))
    started.unref()
    worker = started
    return started
  } catch {
    return undefined
  }
}

/** `execFile`, as a promise of utf8 output, without starting the process on this thread. */
export function execFileOffThread(file: string, args: readonly string[], options: OffThreadExecOptions = {}): Promise<OffThreadExecResult> {
  return new Promise((resolve, reject) => {
    const request: ExecRequest = { file, args, options, resolve, reject }
    const target = liveWorker()
    if (!target) return runOnThisThread(request)
    const id = ++nextId
    inFlight.set(id, request)
    // Held only while there is an answer to wait for, as a child of this thread would hold it.
    target.ref()
    const { input, ...rest } = options
    target.postMessage({ id, file, args, options: rest, input })
  })
}
