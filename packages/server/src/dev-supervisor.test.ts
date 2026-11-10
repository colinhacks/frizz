import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { randomUUID } from "node:crypto"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { pathToFileURL } from "node:url"
import {
  DEV_CRASH_RETRY_MAX_MS,
  classifyDevChange,
  createSupervisorShutdownHandler,
  SUPERVISOR_ESCALATE_GRACE_MS,
  defaultDevWatchRoots,
  devChildEnv,
  devConfigSyntaxError,
  devCrashRetryDelay,
  devReexecEnv,
  isDevServerSource,
  startDevSupervisor,
  subscribeWithWatcher,
  type DevBoot,
  type DevSupervisor,
  type DevSupervisorOptions,
  type SupervisorActivity,
} from "./dev-supervisor.ts"
import { acquireProjectLaunchOwner, type ProjectLaunchLease } from "./project-launch.ts"
import { createStorage } from "./storage.ts"

const projectLaunchUrl = pathToFileURL(join(import.meta.dirname, "project-launch.ts")).href

test("dev supervisor classifies runtime and launcher/config changes without touching web HMR or artifacts", () => {
  const [workspace] = defaultDevWatchRoots()
  const server = join(workspace, "packages", "server", "src")
  const shared = join(workspace, "packages", "shared", "src")
  const rpc = join(workspace, "packages", "rpc", "src")
  // The CLI is the published root package: its source is src/ at the workspace root.
  const cli = join(workspace, "src")
  const sdk = join(workspace, "packages", "claude-agent-sdk-runtime")
  assert.equal(isDevServerSource(join(server, "router.ts")), true)
  assert.equal(isDevServerSource(join(server, "backend", "codex.ts")), true)
  assert.equal(isDevServerSource(join(shared, "index.ts")), true)
  assert.equal(isDevServerSource(join(rpc, "client.ts")), true)
  assert.equal(classifyDevChange(join(server, "router.ts")), "child")
  assert.equal(classifyDevChange(join(shared, "index.ts")), "child")
  assert.equal(classifyDevChange(join(rpc, "client.ts")), "child")
  assert.equal(classifyDevChange(join(sdk, "src", "index.ts")), "child")
  assert.equal(classifyDevChange(join(sdk, "src", "nested", "schema.json")), "child")
  assert.equal(classifyDevChange(join(sdk, "package.json")), "child")
  assert.equal(classifyDevChange(join(server, "dev-supervisor.ts")), "launcher")
  assert.equal(classifyDevChange(join(cli, "index.ts")), "launcher")
  // Root src/ is the launcher itself. A nested file must classify too: the packages/-shaped rule that
  // follows it would return null for every one of these, and do it silently — a dev server left
  // serving a launcher the developer had already edited.
  assert.equal(classifyDevChange(join(cli, "artifacts.ts")), "launcher")
  assert.equal(classifyDevChange(join(cli, "nested", "deep.ts")), "launcher")
  assert.equal(isDevServerSource(join(cli, "launcher.ts")), true)
  assert.equal(classifyDevChange(join(workspace, "packages", "server", "package.json")), "launcher")
  assert.equal(classifyDevChange(join(workspace, "packages", "shared", "package.json")), "launcher")
  assert.equal(classifyDevChange(join(workspace, "package.json")), "launcher")
  assert.equal(classifyDevChange(join(workspace, "pnpm-lock.yaml")), "launcher")
  assert.equal(classifyDevChange(join(workspace, "tsconfig.base.json")), "launcher")
  assert.equal(classifyDevChange(join(workspace, "packages", "web", "vite.config.ts")), "launcher")

  assert.equal(isDevServerSource(join(server, "router.test.ts")), false)
  assert.equal(isDevServerSource(join(server, "WORKER_PROMPT.claude.golden.txt")), false)
  assert.equal(isDevServerSource(join(server, "backend", "codex.fixtures", "sample.json")), false)
  assert.equal(isDevServerSource(join(server, "ui.db")), false)
  assert.equal(isDevServerSource(join(server, "ui.db-wal")), false)
  assert.equal(isDevServerSource(join(server, "transcript.jsonl")), false)
  assert.equal(isDevServerSource(join(server, "..", "dist", "index.js")), false)
  assert.equal(isDevServerSource(join(sdk, ".cache", "generated.ts")), false)
  assert.equal(isDevServerSource(join(sdk, ".parcel-cache", "generated.js")), false)
  assert.equal(isDevServerSource(join(sdk, "node_modules", "dependency", "index.ts")), false)
  assert.equal(isDevServerSource(join(sdk, "src", "index.test.ts")), false)
  assert.equal(isDevServerSource(join(workspace, "packages", "unrelated-tool", "src", "index.ts")), false)
  assert.equal(isDevServerSource(join(server, "..", "..", "web", "src", "main.tsx")), false)

  const disposableRoot = join(tmpdir(), "frizz-disposable-watch-root")
  assert.equal(
    classifyDevChange(join(disposableRoot, "packages", "claude-agent-sdk-runtime", "src", "index.ts"), [disposableRoot]),
    "child",
    "custom roots classify against their own workspace rather than the source checkout",
  )
  // The ignore list names directories INSIDE a checkout, never the path TO one: a worktree in
  // ~/.cache/… is still source. Judged on the absolute path, every file in it was dropped.
  const cachedRoot = join(tmpdir(), ".cache", "frizz-worktree")
  assert.equal(classifyDevChange(join(cachedRoot, "packages", "server", "src", "router.ts"), [cachedRoot]), "child")
  assert.equal(classifyDevChange(join(cachedRoot, "src", "index.ts"), [cachedRoot]), "launcher")
  assert.equal(classifyDevChange(join(cachedRoot, "packages", "server", "src", ".cache", "generated.ts"), [cachedRoot]), null)
})

test("dev child inherits the complete environment and adds only the child markers", () => {
  const input: NodeJS.ProcessEnv = {
    HOME: "/tmp/frizz-home",
    PATH: "/bin:/usr/bin",
    SSH_AUTH_SOCK: "/tmp/agent-legacy.sock",
    CUSTOM_VALUE: "kept",
  }
  const output = devChildEnv(input, 51234)
  assert.deepEqual(output, {
    ...input,
    FRIZZ_DEV_PORT: "51234",
    FRIZZ_DEV_CHILD: "1",
  })
  assert.notEqual(output, input)
  assert.equal(input.FRIZZ_DEV_PORT, undefined, "the caller's env object is not mutated")
})

test("dev launcher re-exec preserves user environment and drops only child-private markers", () => {
  const output = devReexecEnv({
    HOME: "/tmp/frizz-home",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    CUSTOM_VALUE: "kept",
    FRIZZ_DEV_CHILD: "1",
    FRIZZ_DEV_PORT: "4917",
  })
  assert.deepEqual(output, {
    HOME: "/tmp/frizz-home",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    CUSTOM_VALUE: "kept",
    FRIZZ_DEV_REEXEC: "1",
  })
})

test("dev crash retry backs off exponentially and caps restart storms", () => {
  assert.equal(devCrashRetryDelay(1), 500)
  assert.equal(devCrashRetryDelay(2), 1000)
  assert.equal(devCrashRetryDelay(3), 2000)
  assert.equal(devCrashRetryDelay(99), DEV_CRASH_RETRY_MAX_MS)
})

test("a lone supervisor signal starts exactly one close, release, and exit decision", async () => {
  let resolveClose!: () => void
  const closing = new Promise<void>((resolve) => { resolveClose = resolve })
  let closes = 0
  let releases = 0
  const exits: number[] = []
  const stop = createSupervisorShutdownHandler({
    close: () => { closes++; return closing },
    release: () => { releases++ },
    exit: (code) => { exits.push(code) },
  })
  stop()
  assert.equal(closes, 1)
  assert.equal(releases, 0)
  resolveClose()
  await closing
  await Promise.resolve()
  assert.equal(releases, 1)
  assert.deepEqual(exits, [0])
})

// The operator's second Ctrl-C is a withdrawal of patience, not a duplicate of the first. Swallowing
// it left a wedged control plane looking like a launcher that ignores the keyboard for the whole 15s
// child-stop bound.
test("a second supervisor signal escalates once instead of waiting out the drain", async () => {
  let closes = 0
  let forces = 0
  let releases = 0
  const exits: number[] = []
  const errors: string[] = []
  let clock = 1_000
  let resolveClose!: () => void
  const closing = new Promise<void>((resolve) => { resolveClose = resolve })
  const stop = createSupervisorShutdownHandler({
    close: () => { closes++; return closing },
    force: () => { forces++ },
    release: () => { releases++ },
    exit: (code) => { exits.push(code) },
    error: (line) => { errors.push(line) },
    now: () => clock,
  })
  stop()
  // ONE Ctrl-C reaches every process in the foreground group, and a shell/npm wrapper forwards it
  // again in the same tick. Those repeats are the same stop and must never force-kill anything.
  stop()
  stop()
  assert.equal(forces, 0, "a same-instant repeat is one operator action, not an escalation")
  assert.deepEqual(exits, [])

  clock += SUPERVISOR_ESCALATE_GRACE_MS
  stop()
  stop()
  assert.equal(closes, 1, "however many signals arrive, exactly one graceful close is ever started")
  assert.equal(forces, 1, "and exactly one forced reclaim answers the repeat")
  // A forced exit still releases the tokenized launch owner — abandoning the drain must not strand
  // the project — and reports failure, because the drain did not complete.
  assert.equal(releases, 1)
  assert.deepEqual(exits, [1])
  assert.ok(errors.some((line) => line.includes("second stop signal")))

  // The abandoned close settling later must not re-decide the exit.
  resolveClose()
  await closing
  await Promise.resolve()
  assert.deepEqual(exits, [1])
  assert.equal(releases, 1)
})

// The first Ctrl-C used to print nothing until the drain finished, so a slow drain and a lost
// keypress looked identical from the terminal. The acknowledgement runs once, before close() — and
// never again for the repeats that a process group and a forwarding wrapper deliver.
test("the first supervisor signal is acknowledged once, before the close starts", async () => {
  const order: string[] = []
  let resolveClose!: () => void
  const closing = new Promise<void>((resolve) => { resolveClose = resolve })
  let clock = 0
  const stop = createSupervisorShutdownHandler({
    close: () => { order.push("close"); return closing },
    onStop: () => { order.push("acknowledged") },
    release: () => {},
    exit: () => {},
    now: () => clock,
  })
  stop()
  stop()
  clock += SUPERVISOR_ESCALATE_GRACE_MS
  stop()
  assert.deepEqual(order, ["acknowledged", "close"])
  resolveClose()
  await closing
})

// Each step of the drain is bounded, and the deadline is what makes that a promise: a close() that
// never settles is forced exactly as a second signal would force it, instead of holding the terminal.
test("a drain that outlives its deadline is forced without a second signal", async () => {
  const exits: number[] = []
  const errors: string[] = []
  let forces = 0
  let releases = 0
  let armed: { callback: () => void; delayMs: number } | undefined
  const stop = createSupervisorShutdownHandler({
    close: () => new Promise<void>(() => {}),
    force: () => { forces++ },
    release: () => { releases++ },
    exit: (code) => { exits.push(code) },
    error: (line) => { errors.push(line) },
    drainDeadlineMs: 1_234,
    scheduleForce: (callback, delayMs) => { armed = { callback, delayMs }; return {} },
  })
  stop()
  assert.equal(armed?.delayMs, 1_234)
  assert.deepEqual(exits, [], "the deadline is armed, not fired, by the signal")
  armed!.callback()
  assert.equal(forces, 1)
  assert.equal(releases, 1)
  assert.deepEqual(exits, [1])
  assert.ok(errors.some((line) => line.includes("graceful stop did not finish in 1234ms")))
  // A deadline that fires after the drain already decided must not re-decide.
  armed!.callback()
  assert.equal(forces, 1)
  assert.deepEqual(exits, [1])
})

// The default deadline is a real timer, and it must not be what keeps a finished process alive.
test("the drain deadline timer is unref'd", () => {
  let unrefs = 0
  const stop = createSupervisorShutdownHandler({
    close: () => new Promise<void>(() => {}),
    release: () => {},
    exit: () => {},
    scheduleForce: () => ({ unref: () => { unrefs++ } }),
  })
  stop()
  assert.equal(unrefs, 1)
})

test("dev launcher syntax-checks package JSON and JSONC tsconfig before replacing a healthy child", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-dev-config-"))
  try {
    const pkg = join(dir, "package.json")
    writeFileSync(pkg, '{"name":"ok"}\n')
    assert.equal(devConfigSyntaxError(pkg), null)
    writeFileSync(pkg, "{ invalid json\n")
    assert.match(devConfigSyntaxError(pkg) ?? "", /package\.json/)

    const tsconfig = join(dir, "tsconfig.json")
    writeFileSync(tsconfig, '{\n  // JSONC is valid here\n  "compilerOptions": { "strict": true, },\n}\n')
    assert.equal(devConfigSyntaxError(tsconfig), null)
    writeFileSync(tsconfig, '{ "compilerOptions": { "strict": !!! } }\n')
    assert.match(devConfigSyntaxError(tsconfig) ?? "", /tsconfig\.json/)

    assert.equal(devConfigSyntaxError(join(dir, "vite.config.ts")), null, "Vite is validated by child startup")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("exported supervisor API rejects an unowned caller before status or watcher initialization", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "frizz-dev-supervisor-owner-gate-"))
  const stateDir = join(workspace, "state")
  mkdirSync(stateDir, { recursive: true })
  let watched = 0
  try {
    await assert.rejects(startDevSupervisor({
      port: 49_173,
      launchTarget: { projectId: randomUUID(), projectDir: workspace, stateDir },
      launchOwnerToken: randomUUID(),
      watchRoots: [workspace],
      watchSubscribe: async () => {
        watched++
        return { unsubscribe: async () => {} }
      },
    }), /no live matching project launch owner/u)
    assert.equal(watched, 0)
    assert.equal(existsSync(join(stateDir, "dev-supervisor.lock")), false)
  } finally {
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("exported supervisor API rejects a valid owner token presented by the wrong process", { timeout: 10_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "frizz-dev-supervisor-wrong-process-"))
  const stateDir = join(workspace, "state")
  const launchTarget = { projectId: randomUUID(), projectDir: workspace, stateDir }
  mkdirSync(stateDir, { recursive: true })
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquireProjectLaunchOwner } from ${JSON.stringify(projectLaunchUrl)}
    const target = JSON.parse(process.env.TARGET)
    const lease = acquireProjectLaunchOwner(target, "supervisor")
    console.log(JSON.stringify({ token: lease.token }))
    const stop = () => { lease.release(); process.exit(0) }
    process.on("SIGTERM", stop)
    setInterval(() => {}, 1000)
  `], {
    cwd: process.cwd(),
    env: { ...process.env, TARGET: JSON.stringify(launchTarget) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  let watched = 0
  try {
    const [chunk] = await once(child.stdout!, "data") as [Buffer]
    const { token } = JSON.parse(chunk.toString("utf8").trim()) as { token: string }
    await assert.rejects(startDevSupervisor({
      port: 49_173,
      launchTarget,
      launchOwnerToken: token,
      watchRoots: [workspace],
      watchSubscribe: async () => {
        watched++
        return { unsubscribe: async () => {} }
      },
    }), /caller is not the exact project launch owner/u)
    assert.equal(watched, 0)
    assert.equal(existsSync(join(stateDir, "dev-supervisor.lock")), false)
    assert.equal(child.exitCode, null)
    assert.equal(child.signalCode, null)
  } finally {
    await stopFixtureWorker(child)
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("supervisor rejects an unregistered child ready claim before accepting the generation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "frizz-dev-supervisor-child-gate-"))
  const stateDir = join(workspace, "state")
  const childEntry = join(workspace, "unregistered-child.mjs")
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(childEntry, `
    process.send?.({
      type: "frizz-ready",
      pid: process.pid,
      processStart: "opaque:forged-unregistered-child",
      port: Number(process.env.FRIZZ_DEV_PORT),
      bootId: "forged-ready",
    })
    process.on("SIGTERM", () => process.exit(0))
    setInterval(() => {}, 1000)
  `)
  const launchTarget = { projectId: randomUUID(), projectDir: workspace, stateDir }
  const owner = acquireProjectLaunchOwner(launchTarget, "supervisor")
  let supervisor: DevSupervisor | undefined
  try {
    supervisor = await startDevSupervisor({
      port: 49_173,
      launchTarget,
      launchOwnerToken: owner.token,
      childEntry,
      watchRoots: [workspace],
      watchSubscribe: async () => ({ unsubscribe: async () => {} }),
      log: () => {},
      error: () => {},
    })
    await eventually(() => {
      const status = readSupervisorStatus(join(stateDir, "dev-supervisor.lock"))
      return status?.state === "failed" && /without a registered owner-bound generation/u.test(status.message)
        ? status
        : undefined
    }, "unregistered child rejection")
    assert.equal(supervisor.currentBoot(), null)
  } finally {
    await supervisor?.close()
    owner.release()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("supervisor rejects a forged ready PID even when the child registered its real generation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "frizz-dev-supervisor-forged-ready-pid-"))
  const stateDir = join(workspace, "state")
  const childEntry = join(workspace, "forged-ready-child.mjs")
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(childEntry, `
    import {
      projectLaunchOwnerTokenFromEnvironment,
      projectLaunchTargetFromEnvironment,
      registerProjectLaunchDelegate,
    } from ${JSON.stringify(projectLaunchUrl)}
    const target = projectLaunchTargetFromEnvironment(process.env)
    const token = projectLaunchOwnerTokenFromEnvironment(process.env)
    if (!target || !token) process.exit(70)
    const lease = registerProjectLaunchDelegate(target, token)
    process.send?.({
      type: "frizz-ready",
      pid: process.pid + 100000,
      processStart: lease.processStart,
      port: Number(process.env.FRIZZ_DEV_PORT),
      bootId: "forged-ready-pid",
    })
    const stop = () => { lease.release(); process.exit(0) }
    process.on("SIGTERM", stop)
    process.on("disconnect", stop)
    setInterval(() => {}, 1000)
  `)
  const launchTarget = { projectId: randomUUID(), projectDir: workspace, stateDir }
  const owner = acquireProjectLaunchOwner(launchTarget, "supervisor")
  let supervisor: DevSupervisor | undefined
  try {
    supervisor = await startDevSupervisor({
      port: 49_173,
      launchTarget,
      launchOwnerToken: owner.token,
      childEntry,
      watchRoots: [workspace],
      watchSubscribe: async () => ({ unsubscribe: async () => {} }),
      log: () => {},
      error: () => {},
    })
    await eventually(() => {
      const status = readSupervisorStatus(join(stateDir, "dev-supervisor.lock"))
      return status?.state === "failed" && /without a registered owner-bound generation/u.test(status.message)
        ? status
        : undefined
    }, "registered child forged PID rejection")
    assert.equal(supervisor.currentBoot(), null)
  } finally {
    await supervisor?.close()
    owner.release()
    rmSync(workspace, { recursive: true, force: true })
  }
})

interface SupervisorStatus {
  pid: number
  childPid?: number
  state: "starting" | "restarting" | "ready" | "failed" | "degraded"
  message: string
  artifactDigest?: string
}

async function freeSupervisorPort(): Promise<number> {
  const listener = createNetServer()
  await new Promise<void>((resolveListen, rejectListen) => {
    listener.once("error", rejectListen)
    listener.listen(0, "127.0.0.1", () => resolveListen())
  })
  const address = listener.address()
  assert.ok(address && typeof address === "object")
  await new Promise<void>((resolveClose, rejectClose) => listener.close((error) => error ? rejectClose(error) : resolveClose()))
  return address.port
}

// THE UPDATE TESTS HAND THE SUPERVISOR ITS REAL DEADLINES, AND THOSE RUN FROM THE FORK. At 500 and 600ms
// a candidate that was only slow to start (node, the loader, an import of project-launch.ts) was judged
// stalled before it had run a line, and the test that expected it ready failed: three runs of six, a
// different test each time, on 2 CPUs and on a Mac at load 94. Two rules instead of one number:
//
// - A deadline the candidate is MEANT TO MEET is long. Readiness arrives by message, so a long bound
//   costs nothing when the machine is quick.
// - A deadline the candidate is MEANT TO MISS is sized from how long a child takes to start here, now,
//   measured once: four of those, and never under the 600ms these tests always used.
const MEETS_DEADLINE_MS = 30_000
let measuredStall: Promise<number> | undefined
function stallDeadlineMs(): Promise<number> {
  return (measuredStall ??= (async () => {
    const startedAt = performance.now()
    const probe = spawn(process.execPath, [...process.execArgv, "--input-type=module", "-e", `await import(${JSON.stringify(projectLaunchUrl)})`], { stdio: "ignore" })
    await once(probe, "exit")
    return Math.max(600, Math.ceil(((performance.now() - startedAt) * 4) / 100) * 100)
  })())
}

// Polled, so a long bound is only ever waited out by a test that is about to fail.
async function eventually<T>(probe: () => T | Promise<T | undefined> | undefined, description: string, timeoutMs = 30_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await probe()
    if (value !== undefined) return value
    await delay(10)
  }
  throw new Error(`timed out waiting for ${description}`)
}

function readSupervisorStatus(path: string): SupervisorStatus | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SupervisorStatus
  } catch {
    return undefined
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function nextBoot(supervisor: DevSupervisor, previousPid: number): Promise<DevBoot> {
  return eventually(() => {
    const boot = supervisor.currentBoot()
    return boot && boot.pid !== previousPid ? boot : undefined
  }, `a control-plane boot after pid ${previousPid}`)
}

async function stopFixtureWorker(worker: ChildProcess | undefined): Promise<void> {
  if (!worker || worker.exitCode !== null || worker.signalCode !== null) return
  const exited = once(worker, "exit")
  worker.kill("SIGTERM")
  await Promise.race([exited, delay(1_000)])
  if (worker.exitCode === null && worker.signalCode === null) worker.kill("SIGKILL")
}

type DurableUpdateFailure = "missing-reexec" | "prepare-throws" | "reexec-throws" | "reexec-returns" | "rollback-throws"

async function exerciseDurableUpdateFailure(kind: DurableUpdateFailure): Promise<{
  first: DevBoot
  recovered: DevBoot | undefined
  rollbackCalls: number
  reexecCalls: number
  pointer: string
  observed: string
  status: SupervisorStatus
}> {
  const workspace = mkdtempSync(join(tmpdir(), `frizz-durable-update-${kind}-`))
  const stateDir = join(workspace, ".state")
  const childEntry = join(workspace, "child.mjs")
  const observedPath = join(stateDir, "observed")
  const oldDigest = "old-artifact"
  const newDigest = "new-artifact"
  const pointer = join(stateDir, "pointer")
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(pointer, oldDigest)
  writeFileSync(childEntry, `
    import { writeFileSync } from "node:fs"
    import { registerProjectLaunchDelegate, projectLaunchOwnerTokenFromEnvironment, projectLaunchTargetFromEnvironment } from ${JSON.stringify(projectLaunchUrl)}
    const target = projectLaunchTargetFromEnvironment(process.env)
    const token = projectLaunchOwnerTokenFromEnvironment(process.env)
    const delegate = registerProjectLaunchDelegate(target, token)
    writeFileSync(process.env.OBSERVED, process.env.FRIZZ_STABLE_ARTIFACT)
    process.send?.({ type: "frizz-ready", pid: delegate.pid, processStart: delegate.processStart, port: Number(process.env.FRIZZ_DEV_PORT), bootId: "artifact-" + process.env.FRIZZ_STABLE_ARTIFACT + "-" + process.pid })
    const stop = () => { delegate.release(); process.exit(0) }
    process.once("SIGTERM", stop); process.once("disconnect", stop); setInterval(() => {}, 1000)
  `)
  const target = { projectId: randomUUID(), projectDir: workspace, stateDir }
  const owner = acquireProjectLaunchOwner(target, "supervisor")
  let supervisor: DevSupervisor | undefined
  let rollbackCalls = 0
  let reexecCalls = 0
  try {
    supervisor = await startDevSupervisor({
      port: await freeSupervisorPort(),
      cwd: workspace,
      stateDir,
      launchTarget: target,
      launchOwnerToken: owner.token,
      watch: false,
      childLaunchProvider: () => ({ entry: childEntry, environment: { FRIZZ_STABLE_ARTIFACT: readFileSync(pointer, "utf8"), OBSERVED: observedPath } }),
      updateRestart: async () => {
        writeFileSync(pointer, newDigest)
        return { state: "ready" }
      },
      rollbackUpdate: () => {
        rollbackCalls++
        if (kind === "rollback-throws") throw new Error("rollback fixture failed")
        writeFileSync(pointer, oldDigest)
      },
      ...(kind === "missing-reexec" ? {} : {
        durableReexec: async () => {
          reexecCalls++
          if (kind === "reexec-throws") throw new Error("reexec fixture failed")
        },
      }),
      log: () => {},
      error: () => {},
    })
    const first = await supervisor.firstBoot
    if (kind === "prepare-throws") {
      const internals = supervisor as unknown as { prepareDurableReexec: () => Promise<void> }
      const prepare = internals.prepareDurableReexec.bind(supervisor)
      internals.prepareDurableReexec = async () => {
        await prepare()
        throw new Error("prepare fixture failed")
      }
    }
    const response = await fetch(`http://127.0.0.1:${supervisor.port}/_frizz/control/update-restart`, {
      method: "POST", headers: { origin: `http://127.0.0.1:${supervisor.port}` },
    })
    assert.equal(response.status, 202)
    const status = await eventually(() => {
      const current = readSupervisorStatus(join(stateDir, "dev-supervisor.lock"))
      return current?.state === "failed" ? current : undefined
    }, `${kind} durable update failure`)
    const recovered = kind === "missing-reexec" ? undefined : await nextBoot(supervisor, first.pid)
    return { first, recovered, rollbackCalls, reexecCalls, pointer: readFileSync(pointer, "utf8"), observed: readFileSync(observedPath, "utf8"), status }
  } finally {
    await supervisor?.close()
    owner.release()
    rmSync(workspace, { recursive: true, force: true })
  }
}

test("Update & Restart rolls back a promoted pointer when durable re-exec is unavailable", { timeout: 15_000 }, async () => {
  const result = await exerciseDurableUpdateFailure("missing-reexec")
  assert.equal(result.rollbackCalls, 1)
  assert.equal(result.reexecCalls, 0)
  assert.equal(result.pointer, "old-artifact")
  assert.equal(result.observed, "old-artifact", "the healthy control plane remains available")
  assert.match(result.status.message, /requires a durable supervisor handoff/)
})

test("Update & Restart restores the lease-owning supervisor after prepare fails", { timeout: 15_000 }, async () => {
  const result = await exerciseDurableUpdateFailure("prepare-throws")
  assert.equal(result.rollbackCalls, 1)
  assert.equal(result.reexecCalls, 0)
  assert.notEqual(result.recovered?.pid, result.first.pid)
  assert.equal(result.pointer, "old-artifact")
  assert.equal(result.observed, "old-artifact")
  assert.match(result.status.message, /prepare fixture failed/)
})

test("Update & Restart rolls back and restores after durable re-exec throws or returns", { timeout: 25_000 }, async () => {
  for (const kind of ["reexec-throws", "reexec-returns"] as const) {
    const result = await exerciseDurableUpdateFailure(kind)
    assert.equal(result.rollbackCalls, 1, kind)
    assert.equal(result.reexecCalls, 1, kind)
    assert.notEqual(result.recovered?.pid, result.first.pid, kind)
    assert.equal(result.pointer, "old-artifact", kind)
    assert.equal(result.observed, "old-artifact", kind)
    assert.match(result.status.message, kind === "reexec-throws" ? /reexec fixture failed/ : /returned unexpectedly/)
  }
})

test("Update & Restart keeps its supervisor recoverable when rollback fails", { timeout: 15_000 }, async () => {
  const result = await exerciseDurableUpdateFailure("rollback-throws")
  assert.equal(result.rollbackCalls, 1)
  assert.equal(result.reexecCalls, 1)
  assert.notEqual(result.recovered?.pid, result.first.pid)
  assert.equal(result.pointer, "new-artifact", "a failed rollback never lies about the selected pointer")
  assert.equal(result.observed, "new-artifact", "the verified selected candidate restores the control plane")
  assert.match(result.status.message, /rollback failed: rollback fixture failed/)
})

test("Update & Restart hands the durable owner to a fresh supervisor without copying project state", { timeout: 20_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "frizz-durable-update-handoff-"))
  const stateDir = join(workspace, ".state")
  const childEntry = join(workspace, "handoff-child.mjs")
  mkdirSync(stateDir, { recursive: true })
  // This is deliberately real SQLite state, including a persisted provider session and a queued
  // Codex input. The handoff must leave it in place rather than export/import a lossy snapshot.
  const storage = createStorage(join(stateDir, "ui.db"), "p")
  storage.upsertSession({
    slug: "kept", session_id: "frizz-session", thread_name: "frizz-kept", spawned_at: new Date().toISOString(),
    last_read_at: null, unread: 0, exited: 0, archived: 0, rested_at: null, title_auto: 0,
    title: null, state: "open", meta: null, seen_at: null, transcript_id: null,
    backend: "codex", agent_session_id: "provider-rollout", control_error: "existing draft",
  })
  storage.setAgentSession("kept", "provider-rollout")
  storage.close()
  writeFileSync(childEntry, `
    import { writeFileSync } from "node:fs"
    import { registerProjectLaunchDelegate, projectLaunchOwnerTokenFromEnvironment, projectLaunchTargetFromEnvironment } from ${JSON.stringify(projectLaunchUrl)}
    const target = projectLaunchTargetFromEnvironment(process.env); const token = projectLaunchOwnerTokenFromEnvironment(process.env)
    const delegate = registerProjectLaunchDelegate(target, token)
    writeFileSync(process.env.OBSERVED, process.env.GENERATION)
    process.send?.({ type: "frizz-ready", pid: delegate.pid, processStart: delegate.processStart, port: Number(process.env.FRIZZ_DEV_PORT), bootId: process.env.GENERATION + "-" + process.pid })
    const stop = () => { delegate.release(); process.exit(0) }
    process.on("SIGTERM", stop); process.on("disconnect", stop); setInterval(() => {}, 1000)
  `)
  const observed = join(stateDir, "child-generation")
  const target = { projectId: randomUUID(), projectDir: workspace, stateDir }
  const owner = acquireProjectLaunchOwner(target, "supervisor")
  const port = await freeSupervisorPort()
  let successor: DevSupervisor | undefined
  let supervisor: DevSupervisor | undefined
  try {
    supervisor = await startDevSupervisor({
      port, cwd: workspace, stateDir, launchTarget: target, launchOwnerToken: owner.token, watch: false,
      childEntry, childEnvironment: () => ({ OBSERVED: observed, GENERATION: "old-child" }),
      updateRestart: async () => ({ state: "ready" }),
      durableReexec: async () => {
        successor = await startDevSupervisor({
          port, cwd: workspace, stateDir, launchTarget: target, launchOwnerToken: owner.token, watch: false,
          childEntry, childEnvironment: () => ({ OBSERVED: observed, GENERATION: "new-child" }), log: () => {}, error: () => {},
        })
        await successor.firstBoot
      },
      log: () => {}, error: () => {},
    })
    const first = await supervisor.firstBoot
    assert.equal(readFileSync(observed, "utf8"), "old-child")
    const response = await fetch(`http://127.0.0.1:${port}/_frizz/control/update-restart`, {
      method: "POST", headers: { origin: `http://127.0.0.1:${port}` },
    })
    // The durable owner now acknowledges before its async build/re-exec can drain the request-owning
    // process. The browser follows /status rather than treating that accepted handoff as a failure.
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { protocol: 1, state: "restarting" })
    const next = await eventually(() => successor?.currentBoot() ?? undefined, "successor control-plane boot")
    assert.ok(next && next.pid !== first.pid, "the successor booted a new disposable control-plane child")
    assert.equal(readFileSync(observed, "utf8"), "new-child")
    const reopened = createStorage(join(stateDir, "ui.db"), "p")
    const kept = reopened.getSession("kept")
    reopened.close()
    assert.deepEqual({ session: kept?.session_id, provider: kept?.agent_session_id, error: kept?.control_error }, {
      session: "frizz-session", provider: "provider-rollout", error: "existing draft",
    })
  } finally {
    await successor?.close()
    await supervisor?.close()
    owner.release()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("child-only Update & Restart commits one stable child without replacing its public listener", { timeout: 90_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "frizz-child-update-success-"))
  const stateDir = join(workspace, ".state")
  const childEntry = join(workspace, "child.mjs")
  const events = join(stateDir, "events")
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(childEntry, `
    import { appendFileSync } from "node:fs"
    import { registerProjectLaunchDelegate, projectLaunchOwnerTokenFromEnvironment, projectLaunchTargetFromEnvironment } from ${JSON.stringify(projectLaunchUrl)}
    const artifact = process.env.FRIZZ_STABLE_ARTIFACT
    const target = projectLaunchTargetFromEnvironment(process.env)
    const token = projectLaunchOwnerTokenFromEnvironment(process.env)
    const delegate = registerProjectLaunchDelegate(target, token)
    appendFileSync(process.env.EVENTS, \`start:\${artifact}:\${process.pid}\\n\`)
    process.send?.({ type: "frizz-ready", pid: delegate.pid, processStart: delegate.processStart, port: Number(process.env.FRIZZ_DEV_PORT), bootId: \`\${artifact}-\${process.pid}\` })
    const stop = () => { appendFileSync(process.env.EVENTS, \`stop:\${artifact}:\${process.pid}\\n\`); delegate.release(); process.exit(0) }
    process.once("SIGTERM", stop); process.once("disconnect", stop); setInterval(() => {}, 1000)
  `)
  const target = { projectId: randomUUID(), projectDir: workspace, stateDir }
  const owner = acquireProjectLaunchOwner(target, "supervisor")
  const port = await freeSupervisorPort()
  let selected = "old"
  let active = "old"
  let prepares = 0
  let commits = 0
  let rollbacks = 0
  const logged: string[] = []
  let supervisor: DevSupervisor | undefined
  try {
    supervisor = await startDevSupervisor({
      port, cwd: workspace, stateDir, launchTarget: target, launchOwnerToken: owner.token, watch: false,
      childLaunchProvider: () => ({ entry: childEntry, environment: { FRIZZ_STABLE_ARTIFACT: selected, EVENTS: events } }),
      updateMode: "child",
      updateReadyTimeoutMs: MEETS_DEADLINE_MS,
      updateStabilizeMs: 20,
      updateRestart: async () => { prepares++; selected = "new"; return { state: "ready", message: "Frizz new is installed and compatible" } },
      commitUpdate: () => { commits++; active = selected },
      rollbackUpdate: () => { rollbacks++; selected = active },
      version: () => active,
      log: (line) => logged.push(line), error: () => {},
    })
    const first = await supervisor.firstBoot
    assert.match((await fetch(`http://127.0.0.1:${port}/_frizz/control/status`, { headers: { origin: `http://127.0.0.1:${port}` } })).statusText, /OK/)
    const one = await fetch(`http://127.0.0.1:${port}/_frizz/control/update-restart`, { method: "POST", headers: { origin: `http://127.0.0.1:${port}` } })
    const [two, ordinaryRestart] = await Promise.all([
      fetch(`http://127.0.0.1:${port}/_frizz/control/update-restart`, { method: "POST", headers: { origin: `http://127.0.0.1:${port}` } }),
      fetch(`http://127.0.0.1:${port}/_frizz/control/restart`, { method: "POST", headers: { origin: `http://127.0.0.1:${port}` } }),
    ])
    assert.equal(one.status, 202)
    assert.equal(two.status, 202)
    assert.equal(ordinaryRestart.status, 202, "a concurrent ordinary restart joins the update rather than spawning a second child")
    const status = await eventually(async () => {
      const body = await (await fetch(`http://127.0.0.1:${port}/_frizz/control/status`, { headers: { origin: `http://127.0.0.1:${port}` } })).json() as { state: string; artifactDigest?: string }
      return body.state === "ready" && body.artifactDigest === "new" ? body : undefined
    }, "the committed child update")
    assert.equal(status.artifactDigest, "new")
    assert.equal(supervisor.port, port, "the durable listener remains the same endpoint")
    assert.notEqual(supervisor.currentBoot()?.pid, first.pid)
    assert.deepEqual({ prepares, commits, rollbacks, active }, { prepares: 1, commits: 1, rollbacks: 0, active: "new" })
    const lines = readFileSync(events, "utf8").trim().split("\n")
    assert.ok(lines.findIndex((line) => line.startsWith("stop:old:")) < lines.findIndex((line) => line.startsWith("start:new:")), "old child exits before candidate starts")
    // The run log says an update was asked for, what it installed, and which server answers now. These
    // went to the terminal alone, so a log read afterwards showed a restart and nothing about why.
    const update = logged.filter((line) => line.startsWith("[frizz] update"))
    assert.deepEqual(update, [
      "[frizz] update: preparing the new build — the running one is untouched until it is ready",
      "[frizz] update: Frizz new is installed and compatible",
      "[frizz] update committed: now serving new",
    ])
  } finally {
    await supervisor?.close()
    owner.release()
    rmSync(workspace, { recursive: true, force: true })
  }
})

// Both actions drain the running child and fork its replacement in the launch folder. With the
// folder gone that fork fails, and so does the one that would restore the old child (2026-10-11).
test("Restart and Update & Restart refuse, and leave the child serving, once the launch folder is deleted", { timeout: 15_000 }, async () => {
  const base = mkdtempSync(join(tmpdir(), "frizz-launch-folder-gone-"))
  const workspace = join(base, "project")
  const stateDir = join(base, "state")
  const childEntry = join(base, "child.mjs")
  const events = join(base, "events")
  mkdirSync(workspace)
  mkdirSync(stateDir)
  writeFileSync(childEntry, `
    import { appendFileSync } from "node:fs"
    import { registerProjectLaunchDelegate, projectLaunchOwnerTokenFromEnvironment, projectLaunchTargetFromEnvironment } from ${JSON.stringify(projectLaunchUrl)}
    const delegate = registerProjectLaunchDelegate(projectLaunchTargetFromEnvironment(process.env), projectLaunchOwnerTokenFromEnvironment(process.env))
    appendFileSync(process.env.EVENTS, \`start:\${process.pid}\\n\`)
    process.send?.({ type: "frizz-ready", pid: delegate.pid, processStart: delegate.processStart, port: Number(process.env.FRIZZ_DEV_PORT), bootId: \`boot-\${process.pid}\` })
    const stop = () => { appendFileSync(process.env.EVENTS, \`stop:\${process.pid}\\n\`); delegate.release(); process.exit(0) }
    process.once("SIGTERM", stop); process.once("disconnect", stop); setInterval(() => {}, 1000)
  `)
  const target = { projectId: randomUUID(), projectDir: workspace, stateDir }
  const owner = acquireProjectLaunchOwner(target, "supervisor")
  const port = await freeSupervisorPort()
  const control = (path: string, method = "GET") =>
    fetch(`http://127.0.0.1:${port}/_frizz/control/${path}`, { method, headers: { origin: `http://127.0.0.1:${port}` } })
  let prepares = 0
  let supervisor: DevSupervisor | undefined
  try {
    supervisor = await startDevSupervisor({
      port, cwd: workspace, stateDir, launchTarget: target, launchOwnerToken: owner.token, watch: false,
      childLaunchProvider: () => ({ entry: childEntry, environment: { FRIZZ_STABLE_ARTIFACT: "old", EVENTS: events } }),
      updateMode: "child",
      updateRestart: async () => { prepares++; return { state: "ready" } },
      commitUpdate: () => {},
      rollbackUpdate: () => {},
      log: () => {}, error: () => {},
    })
    const first = await supervisor.firstBoot
    rmSync(workspace, { recursive: true })
    const refusal = /is running on .*project, which no longer exists/
    // Restart answers with its own result; an update acknowledges and reports through /status.
    const restart = await control("restart", "POST")
    assert.equal(restart.status, 503)
    assert.match((await restart.json() as { message?: string }).message ?? "", refusal)
    assert.equal((await control("update-restart", "POST")).status, 202)
    const update = await eventually(async () => {
      const body = await (await control("status")).json() as { state: string; message?: string }
      return body.state === "failed" ? body : undefined
    }, "the refused update")
    assert.match(update.message ?? "", refusal)
    assert.equal(prepares, 0, "an update that cannot finish is never prepared")
    assert.equal(supervisor.currentBoot()?.pid, first.pid)
    assert.equal(processIsAlive(first.pid), true, "the running child is never drained")
    assert.equal(readFileSync(events, "utf8"), `start:${first.pid}\n`)
  } finally {
    await supervisor?.close()
    owner.release()
    rmSync(base, { recursive: true, force: true })
  }
})

test("child updates wait for advancing candidate boot progress, but bound stalls and endless progress", { timeout: 180_000 }, async () => {
  // Three of these four candidates are meant to miss a deadline, and "slow" is meant to outlast the
  // stall window while staying inside the hard one: all three numbers come from one measured start.
  const stall = await stallDeadlineMs()
  const hard = stall * 5
  for (const mode of ["slow", "stalled", "foreign", "endless"] as const) {
    const workspace = mkdtempSync(join(tmpdir(), `frizz-update-progress-${mode}-`))
    const stateDir = join(workspace, ".state")
    mkdirSync(stateDir)
    const childEntry = join(workspace, "child.mjs")
    const progressUrl = pathToFileURL(join(import.meta.dirname, "boot-progress.ts")).href
    writeFileSync(childEntry, `
      import { readFileSync, writeFileSync } from "node:fs"
      import { createBootProgressPublisher, bootProgressPath } from ${JSON.stringify(progressUrl)}
      import { registerProjectLaunchDelegate, projectLaunchOwnerTokenFromEnvironment, projectLaunchTargetFromEnvironment } from ${JSON.stringify(projectLaunchUrl)}
      const target = projectLaunchTargetFromEnvironment(process.env)
      const delegate = registerProjectLaunchDelegate(target, projectLaunchOwnerTokenFromEnvironment(process.env))
      const progress = createBootProgressPublisher(target.stateDir, 0)
      const ready = () => {
        progress.done()
        process.send?.({ type: "frizz-ready", pid: delegate.pid, processStart: delegate.processStart, port: Number(process.env.FRIZZ_DEV_PORT), bootId: String(process.pid) })
      }
      const stop = () => { progress.done(); delegate.release(); process.exit(0) }
      process.once("SIGTERM", stop); process.once("disconnect", stop)
      setInterval(() => {}, 1000)
      if (process.env.FRIZZ_STABLE_ARTIFACT === "old") ready()
      else {
        let foreignStep = 0
        const publish = () => {
          if (${JSON.stringify(mode)} === "foreign") {
            // Never publish the candidate's real PID first: the supervisor can observe that
            // intermediate file before a rewrite and correctly count it as genuine progress.
            const file = bootProgressPath(target.stateDir)
            writeFileSync(file, JSON.stringify({ pid: process.ppid, step: ++foreignStep, phase: "runtimes: downloading", at: new Date().toISOString() }))
          } else progress("runtimes: downloading")
        }
        publish()
        if (${JSON.stringify(mode)} !== "stalled") setInterval(publish, 50)
        if (${JSON.stringify(mode)} === "slow") setTimeout(ready, ${stall * 3})
      }
    `)
    const target = { projectId: randomUUID(), projectDir: workspace, stateDir }
    const owner = acquireProjectLaunchOwner(target, "supervisor")
    const port = await freeSupervisorPort()
    let selected = "old"
    let commits = 0
    let rollbacks = 0
    let supervisor: DevSupervisor | undefined
    try {
      supervisor = await startDevSupervisor({
        port, cwd: workspace, stateDir, launchTarget: target, launchOwnerToken: owner.token, watch: false,
        childLaunchProvider: () => ({ entry: childEntry, environment: { FRIZZ_STABLE_ARTIFACT: selected } }),
        updateMode: "child", updateReadyTimeoutMs: stall, updateHardTimeoutMs: hard, updateStabilizeMs: 20,
        updateRestart: async () => { selected = "new"; return { state: "ready" } },
        commitUpdate: () => { commits++ },
        rollbackUpdate: () => { rollbacks++; selected = "old" },
        log: () => {}, error: () => {},
      })
      await supervisor.firstBoot
      const origin = `http://127.0.0.1:${port}`
      assert.equal((await fetch(`${origin}/_frizz/control/update-restart`, { method: "POST", headers: { origin } })).status, 202)
      const result = await eventually(async () => {
        const status = await (await fetch(`${origin}/_frizz/control/status`, { headers: { origin } })).json() as { state: string; artifactDigest?: string; message?: string }
        return (mode === "slow" ? status.state === "ready" && status.artifactDigest === "new" : status.state === "failed") ? status : undefined
      }, `${mode} candidate verdict`)
      assert.equal(commits, mode === "slow" ? 1 : 0, mode)
      assert.equal(rollbacks, mode === "slow" ? 0 : 1, mode)
      assert.equal(result.artifactDigest, mode === "slow" ? "new" : "old", mode)
      if (mode === "endless") assert.ok(result.message!.includes(`did not become ready within ${hard}ms; last boot step: runtimes: downloading`), result.message)
      if (mode === "stalled") assert.ok(result.message!.includes(`no boot progress for ${stall}ms; last boot step: runtimes: downloading`), result.message)
      if (mode === "foreign") assert.equal(result.message, `update candidate made no boot progress for ${stall}ms`)
    } finally {
      await supervisor?.close()
      owner.release()
      rmSync(workspace, { recursive: true, force: true })
    }
  }
})

test("child-only update rolls back failed candidates and a close race without retrying them", { timeout: 180_000 }, async () => {
  const stall = await stallDeadlineMs()
  for (const failure of ["hang", "crash", "commit", "rollback", "close"] as const) {
    const workspace = mkdtempSync(join(tmpdir(), `frizz-child-update-${failure}-`))
    const stateDir = join(workspace, ".state")
    const childEntry = join(workspace, "child.mjs")
    const events = join(stateDir, "events")
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(childEntry, `
      import { appendFileSync } from "node:fs"
      import { registerProjectLaunchDelegate, projectLaunchOwnerTokenFromEnvironment, projectLaunchTargetFromEnvironment } from ${JSON.stringify(projectLaunchUrl)}
      const artifact = process.env.FRIZZ_STABLE_ARTIFACT
      if (artifact === "hang") { appendFileSync(process.env.EVENTS, \"start:hang\\n\"); setInterval(() => {}, 1000) }
      else {
        const target = projectLaunchTargetFromEnvironment(process.env); const token = projectLaunchOwnerTokenFromEnvironment(process.env)
        const delegate = registerProjectLaunchDelegate(target, token)
        appendFileSync(process.env.EVENTS, \`start:\${artifact}:\${process.pid}\\n\`)
        // The crash follows the ready message out of the process, not a timer: a 5ms timer in a starved
        // child could fire after the supervisor's whole stabilize window, and the crash it is here to
        // catch then landed on a committed update instead.
        process.send?.({ type: "frizz-ready", pid: delegate.pid, processStart: delegate.processStart, port: Number(process.env.FRIZZ_DEV_PORT), bootId: \`\${artifact}-\${process.pid}\` }, artifact === "crash" ? () => process.exit(19) : undefined)
        const stop = () => { appendFileSync(process.env.EVENTS, \`stop:\${artifact}:\${process.pid}\\n\`); delegate.release(); process.exit(0) }
        process.once("SIGTERM", stop); process.once("disconnect", stop); setInterval(() => {}, 1000)
      }
    `)
    const target = { projectId: randomUUID(), projectDir: workspace, stateDir }
    const owner = acquireProjectLaunchOwner(target, "supervisor")
    const port = await freeSupervisorPort()
    let selected = "old"
    let active = "old"
    let rollbacks = 0
    const launchSelections: string[] = []
    let supervisor: DevSupervisor | undefined
    try {
      supervisor = await startDevSupervisor({
        port, cwd: workspace, stateDir, launchTarget: target, launchOwnerToken: owner.token, watch: false,
        childLaunchProvider: () => { launchSelections.push(selected); return { entry: childEntry, environment: { FRIZZ_STABLE_ARTIFACT: selected, EVENTS: events } } },
        // Only the candidate that hangs is meant to miss this; every other one reports ready.
        updateMode: "child", updateReadyTimeoutMs: failure === "hang" || failure === "close" ? stall : MEETS_DEADLINE_MS, updateStabilizeMs: 60,
        updateRestart: async () => { selected = failure === "commit" || failure === "rollback" ? "new" : failure === "close" ? "hang" : failure; return { state: "ready" } },
        commitUpdate: () => {
          if (failure === "commit" || failure === "rollback") throw new Error("commit fixture failed")
          active = selected
        },
        rollbackUpdate: () => {
          rollbacks++
          if (failure === "rollback") throw new Error("rollback fixture failed")
          selected = active
        },
        log: () => {}, error: () => {},
      })
      await supervisor.firstBoot
      const response = await fetch(`http://127.0.0.1:${port}/_frizz/control/update-restart`, { method: "POST", headers: { origin: `http://127.0.0.1:${port}` } })
      assert.equal(response.status, 202, failure)
      if (failure === "close") {
        await supervisor.close()
        await eventually(() => rollbacks === 1 && selected === "old" ? true : undefined, "close-race selection rollback")
        assert.equal(supervisor.currentBoot(), null, "close leaves no candidate child behind")
        assert.equal(existsSync(join(stateDir, "dev-supervisor.lock")), false, "late update completion does not recreate owner status")
        continue
      }
      if (failure === "rollback") {
        const status = await eventually(async () => {
          const body = await (await fetch(`http://127.0.0.1:${port}/_frizz/control/status`, { headers: { origin: `http://127.0.0.1:${port}` } })).json() as { state: string; message?: string }
          return body.state === "failed" && /rollback failed/.test(body.message ?? "") ? body : undefined
        }, "rollback failure")
        assert.match(status.message ?? "", /not restarted because rollback did not restore/, failure)
        assert.equal(selected, "new", failure)
        assert.equal(rollbacks, 1, failure)
        assert.deepEqual(launchSelections, ["old", "new"], "a failed rollback never launches the candidate again")
        continue
      }
      const status = await eventually(async () => {
        const body = await (await fetch(`http://127.0.0.1:${port}/_frizz/control/status`, { headers: { origin: `http://127.0.0.1:${port}` } })).json() as { state: string; artifactDigest?: string }
        return body.state === "failed" && body.artifactDigest === "old" ? body : undefined
      }, `${failure} rollback`)
      assert.equal(status.artifactDigest, "old", failure)
      assert.equal(selected, "old", failure)
      assert.equal(rollbacks, 1, failure)
      const lines = readFileSync(events, "utf8").trim().split("\n")
      const bad = failure === "commit" ? "new" : failure
      // Counted where the supervisor launches, not by the line a candidate writes once it is running:
      // one killed at its deadline before it got that far wrote none, and was still launched once.
      assert.equal(launchSelections.filter((launched) => launched === bad).length, 1, `${failure} candidate never enters watchdog retry: ${lines.join(", ")}; selections=${launchSelections.join(",")}`)
      assert.ok(lines.filter((line) => line.startsWith(`start:${bad}`)).length <= 1, `${failure} candidate ran at most once: ${lines.join(", ")}`)
      assert.ok(lines.filter((line) => line.startsWith("start:old:")).length >= 2, `${failure} restores a real old child`)
    } finally {
      await supervisor?.close()
      owner.release()
      rmSync(workspace, { recursive: true, force: true })
    }
  }
})

test("child-only update rejects a candidate that exits during an async commit", { timeout: 90_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "frizz-child-update-commit-exit-"))
  const stateDir = join(workspace, ".state")
  const childEntry = join(workspace, "child.mjs")
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(childEntry, `
    import { registerProjectLaunchDelegate, projectLaunchOwnerTokenFromEnvironment, projectLaunchTargetFromEnvironment } from ${JSON.stringify(projectLaunchUrl)}
    const target = projectLaunchTargetFromEnvironment(process.env); const token = projectLaunchOwnerTokenFromEnvironment(process.env)
    const delegate = registerProjectLaunchDelegate(target, token)
    process.send?.({ type: "frizz-ready", pid: delegate.pid, processStart: delegate.processStart, port: Number(process.env.FRIZZ_DEV_PORT), bootId: \`\${process.env.FRIZZ_STABLE_ARTIFACT}-\${process.pid}\` })
    const stop = () => { delegate.release(); process.exit(0) }
    process.once("SIGTERM", stop); process.once("disconnect", stop); setInterval(() => {}, 1000)
  `)
  const target = { projectId: randomUUID(), projectDir: workspace, stateDir }
  const owner = acquireProjectLaunchOwner(target, "supervisor")
  const port = await freeSupervisorPort()
  let selected = "old"
  let active = "old"
  let rollbacks = 0
  let startCommit!: () => void
  const committing = new Promise<void>((resolve) => { startCommit = resolve })
  let finishCommit!: () => void
  const commitGate = new Promise<void>((resolve) => { finishCommit = resolve })
  let supervisor: DevSupervisor | undefined
  try {
    supervisor = await startDevSupervisor({
      port, cwd: workspace, stateDir, launchTarget: target, launchOwnerToken: owner.token, watch: false,
      childLaunchProvider: () => ({ entry: childEntry, environment: { FRIZZ_STABLE_ARTIFACT: selected } }),
      updateMode: "child", updateReadyTimeoutMs: MEETS_DEADLINE_MS, updateStabilizeMs: 20,
      updateRestart: async () => { selected = "new"; return { state: "ready" } },
      commitUpdate: async () => { startCommit(); await commitGate; active = selected },
      rollbackUpdate: () => { rollbacks++; active = "old"; selected = active },
      log: () => {}, error: () => {},
    })
    const first = await supervisor.firstBoot
    const response = await fetch(`http://127.0.0.1:${port}/_frizz/control/update-restart`, { method: "POST", headers: { origin: `http://127.0.0.1:${port}` } })
    assert.equal(response.status, 202)
    await committing
    const candidate = supervisor.currentBoot()
    assert.ok(candidate && candidate.pid !== first.pid, "commit is gated with the candidate as current child")
    process.kill(candidate.pid, "SIGTERM")
    await eventually(() => supervisor?.currentBoot() === null ? true : undefined, "candidate exit during commit")
    finishCommit()
    const status = await eventually(async () => {
      const body = await (await fetch(`http://127.0.0.1:${port}/_frizz/control/status`, { headers: { origin: `http://127.0.0.1:${port}` } })).json() as { state: string; artifactDigest?: string; message?: string }
      return body.state === "failed" && body.artifactDigest === "old" ? body : undefined
    }, "dead committed candidate rollback")
    assert.match(status.message ?? "", /stopped while committing/)
    assert.equal(selected, "old")
    assert.equal(active, "old", "the rollback callback reverses a commit that completed before liveness was rechecked")
    assert.equal(rollbacks, 1)
  } finally {
    await supervisor?.close()
    owner.release()
    rmSync(workspace, { recursive: true, force: true })
  }
})

// A registry launcher's update, committed: `new` serves, and `old` is what going back selects. The
// body then tells the new release how to misbehave by writing its orders: `stop N` stops it N more
// times, each a moment after it reported ready, and `boot` makes it unable to start at all.
async function withCommittedUpdate(
  options: { probationMs?: number; revert?: "throws" | "none" },
  body: (run: {
    counts: { commits: number; rollbacks: number; reverts: number }
    logged: string[]
    errors: string[]
    order: (orders: string) => void
    starts: () => string[]
    control: (path: string, method?: string) => Promise<Response>
    status: () => Promise<{ state: string; artifactDigest?: string; version?: string; rejectedUpdate?: string }>
    serving: (artifact: string, description: string) => Promise<{ state: string; artifactDigest?: string; version?: string; rejectedUpdate?: string }>
  }) => Promise<void>,
): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), "frizz-update-probation-"))
  const stateDir = join(workspace, ".state")
  const childEntry = join(workspace, "child.mjs")
  const events = join(stateDir, "events")
  const orders = join(stateDir, "orders")
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(childEntry, `
    import { appendFileSync, readFileSync, writeFileSync } from "node:fs"
    import { registerProjectLaunchDelegate, projectLaunchOwnerTokenFromEnvironment, projectLaunchTargetFromEnvironment } from ${JSON.stringify(projectLaunchUrl)}
    const artifact = process.env.FRIZZ_STABLE_ARTIFACT
    const orders = () => { try { return readFileSync(process.env.ORDERS, "utf8").trim() } catch { return "" } }
    appendFileSync(process.env.EVENTS, \`start:\${artifact}\\n\`)
    if (artifact === "new" && orders() === "boot") process.exit(9)
    const delegate = registerProjectLaunchDelegate(projectLaunchTargetFromEnvironment(process.env), projectLaunchOwnerTokenFromEnvironment(process.env))
    process.send?.({ type: "frizz-ready", pid: delegate.pid, processStart: delegate.processStart, port: Number(process.env.FRIZZ_DEV_PORT), bootId: \`\${artifact}-\${process.pid}\` })
    const stop = () => { delegate.release(); process.exit(0) }
    process.once("SIGTERM", stop); process.once("disconnect", stop)
    setInterval(() => {
      const left = artifact === "new" ? /^stop (\\d+)$/.exec(orders()) : null
      if (!left || left[1] === "0") return
      writeFileSync(process.env.ORDERS, \`stop \${Number(left[1]) - 1}\`)
      process.exit(7)
    }, 20)
  `)
  const target = { projectId: randomUUID(), projectDir: workspace, stateDir }
  const owner = acquireProjectLaunchOwner(target, "supervisor")
  const port = await freeSupervisorPort()
  const counts = { commits: 0, rollbacks: 0, reverts: 0 }
  const logged: string[] = []
  const errors: string[] = []
  let selected = "old"
  let active = "old"
  let rejected: string | undefined
  const control = (path: string, method = "GET") =>
    fetch(`http://127.0.0.1:${port}/_frizz/control/${path}`, { method, headers: { origin: `http://127.0.0.1:${port}` } })
  const status = async () => await (await control("status")).json() as { state: string; artifactDigest?: string; version?: string; rejectedUpdate?: string }
  const serving = (artifact: string, description: string) => eventually(async () => {
    const answer = await status()
    return answer.state === "ready" && answer.artifactDigest === artifact ? answer : undefined
  }, description, 60_000)
  let supervisor: DevSupervisor | undefined
  try {
    supervisor = await startDevSupervisor({
      port, cwd: workspace, stateDir, launchTarget: target, launchOwnerToken: owner.token, watch: false,
      childLaunchProvider: () => ({ entry: childEntry, environment: { FRIZZ_STABLE_ARTIFACT: selected, EVENTS: events, ORDERS: orders } }),
      updateMode: "child",
      updateReadyTimeoutMs: MEETS_DEADLINE_MS,
      updateStabilizeMs: 20,
      ...(options.probationMs === undefined ? {} : { updateProbationMs: options.probationMs }),
      updateRestart: async () => { selected = "new"; return { state: "ready" } },
      commitUpdate: () => { counts.commits++; active = selected },
      rollbackUpdate: () => { counts.rollbacks++; selected = active },
      ...(options.revert === "none" ? {} : {
        revertUpdate: () => {
          counts.reverts++
          if (options.revert === "throws") throw new Error("no earlier release is held")
          rejected = active
          selected = "old"
          active = "old"
        },
      }),
      rejectedUpdate: () => rejected,
      version: () => active,
      log: (line) => logged.push(line), error: (line) => errors.push(line),
    })
    await supervisor.firstBoot
    assert.equal((await control("update-restart", "POST")).status, 202)
    await eventually(() => logged.some((line) => line.startsWith("[frizz] update committed")) || undefined, "the update to commit")
    await serving("new", "the committed update")
    await body({
      counts, logged, errors, control, status, serving,
      order: (text) => writeFileSync(orders, text),
      starts: () => readFileSync(events, "utf8").trim().split("\n").map((line) => line.slice("start:".length)),
    })
  } finally {
    await supervisor?.close()
    owner.release()
    rmSync(workspace, { recursive: true, force: true })
  }
}

// After its one second of health a committed update was final: a release that booted and then died
// was restarted for ever, by a retry that can only start the same release, behind a page whose
// Update button it could not serve.
test("a committed child update that stops three times inside its probation is undone", { timeout: 120_000 }, async () => {
  await withCommittedUpdate({}, async (run) => {
    assert.equal((await run.status()).rejectedUpdate, undefined, "nothing has been gone back from yet")
    run.order("stop 3")
    const back = await run.serving("old", "the release before the update")
    assert.equal(back.version, "old")
    assert.equal(back.rejectedUpdate, "new", "the page is told which version it is no longer offered")
    assert.deepEqual(run.counts, { commits: 1, rollbacks: 0, reverts: 1 })
    assert.deepEqual(run.starts(), ["old", "new", "new", "new", "old"], "two retries of the new release, then the old one")
    assert.ok(run.logged.includes("[frizz] update undone: Frizz new stopped 3 times after it was installed; serving Frizz old again"), run.logged.join("\n"))
  })
})

test("a committed child update that cannot start again is undone at its first stop", { timeout: 120_000 }, async () => {
  await withCommittedUpdate({}, async (run) => {
    run.order("boot")
    // Restart Frizz, pressed in the page: the answer is the release that came back, not a failure.
    const restart = await run.control("restart", "POST")
    assert.equal(restart.status, 202)
    const back = await run.serving("old", "the release before the update")
    assert.equal(back.rejectedUpdate, "new")
    assert.deepEqual(run.counts, { commits: 1, rollbacks: 0, reverts: 1 })
    assert.deepEqual(run.starts(), ["old", "new", "new", "old"])
    assert.ok(run.logged.includes("[frizz] update undone: Frizz new could not start again after it was installed (exit 9); serving Frizz old again"), run.logged.join("\n"))
  })
})

test("a committed child update keeps its release through two stops, and through three once the probation is over", { timeout: 180_000 }, async () => {
  await withCommittedUpdate({}, async (run) => {
    run.order("stop 2")
    await eventually(() => run.starts().length === 4 || undefined, "the third start of the new release")
    await run.serving("new", "the new release, still selected")
    assert.deepEqual(run.counts, { commits: 1, rollbacks: 0, reverts: 0 })
  })
  await withCommittedUpdate({ probationMs: 1 }, async (run) => {
    await delay(20)
    run.order("stop 3")
    await eventually(() => run.starts().length === 5 || undefined, "the fourth start of the new release", 60_000)
    await run.serving("new", "the new release, retried as any crash is")
    assert.deepEqual(run.counts, { commits: 1, rollbacks: 0, reverts: 0 })
    assert.deepEqual(run.starts(), ["old", "new", "new", "new", "new"])
  })
})

test("a launcher that cannot go back retries the new release as it always did", { timeout: 180_000 }, async () => {
  for (const revert of ["throws", "none"] as const) {
    await withCommittedUpdate({ revert }, async (run) => {
      run.order("stop 3")
      await eventually(() => run.starts().length === 5 || undefined, `the fourth start of the new release (${revert})`, 60_000)
      await run.serving("new", "the new release")
      assert.deepEqual(run.starts(), ["old", "new", "new", "new", "new"])
      assert.equal(run.counts.reverts, revert === "throws" ? 1 : 0)
      assert.equal(run.errors.includes("[frizz] the update could not be undone: no earlier release is held"), revert === "throws")
      assert.equal((await run.status()).rejectedUpdate, undefined)
    })
  }
})

// The drain is an IPC ask, not a signal (audit 2026-09-11, finding 3). This child listens for
// 'disconnect' ONLY — no SIGTERM handler — so a supervisor that still led with kill("SIGTERM") would
// end it under Node's default handler on POSIX with no marker written (and after the 15 s escalation
// timer, which this test's timeout does not allow). On Windows, where every signal Node can send is a
// TerminateProcess, the marker is the only evidence that a shutdown handler ran at all.
test("stopping the control plane asks over IPC first, so the child's own shutdown runs before any signal", { timeout: 12_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "frizz-dev-supervisor-drain-"))
  const stateDir = join(workspace, ".state")
  const markers = join(workspace, "markers")
  const childEntry = join(workspace, "drain-child.mjs")
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(markers, { recursive: true })
  writeFileSync(childEntry, `
    import { writeFileSync } from "node:fs"
    import { join } from "node:path"
    import { registerProjectLaunchDelegate, projectLaunchOwnerTokenFromEnvironment, projectLaunchTargetFromEnvironment } from ${JSON.stringify(projectLaunchUrl)}
    const target = projectLaunchTargetFromEnvironment(process.env); const token = projectLaunchOwnerTokenFromEnvironment(process.env)
    const delegate = registerProjectLaunchDelegate(target, token)
    process.send?.({ type: "frizz-ready", pid: delegate.pid, processStart: delegate.processStart, port: Number(process.env.FRIZZ_DEV_PORT), bootId: "drain-" + process.pid })
    process.once("disconnect", () => {
      writeFileSync(join(process.env.MARKERS, String(process.pid)), "shutdown handler ran")
      delegate.release()
      process.exit(0)
    })
    setInterval(() => {}, 1000)
  `)
  const target = { projectId: randomUUID(), projectDir: workspace, stateDir }
  const owner = acquireProjectLaunchOwner(target, "supervisor")
  const port = await freeSupervisorPort()
  const errors: string[] = []
  let supervisor: DevSupervisor | undefined
  try {
    supervisor = await startDevSupervisor({
      port, cwd: workspace, stateDir, launchTarget: target, launchOwnerToken: owner.token, watch: false,
      childEntry, childEnvironment: () => ({ MARKERS: markers }),
      log: () => {}, error: (line) => { errors.push(line) },
    })
    const first = await supervisor.firstBoot
    // Restart Frizz: the old generation was asked, not shot.
    const restart = await fetch(`http://127.0.0.1:${port}/_frizz/control/restart`, {
      method: "POST", headers: { origin: `http://127.0.0.1:${port}` },
    })
    assert.equal(restart.status, 202)
    const second = await nextBoot(supervisor, first.pid)
    assert.equal(readFileSync(join(markers, String(first.pid)), "utf8"), "shutdown handler ran")
    // A supervisor close is the same ask.
    const startedAt = Date.now()
    await supervisor.close()
    supervisor = undefined
    assert.equal(readFileSync(join(markers, String(second.pid)), "utf8"), "shutdown handler ran")
    assert.ok(Date.now() - startedAt < 5_000, "the child answered the ask; no escalation timer had to fire")
    assert.deepEqual(errors.filter((line) => /did not close|SIGTERM|killing/.test(line)), [], "no signal was sent")
  } finally {
    await supervisor?.close()
    owner.release()
    rmSync(workspace, { recursive: true, force: true })
  }
})

// The board is not blocked for the prepare phase (audit 2026-09-11, finding 6): while the update hook
// runs — an npm install, a source build — the old child is untouched, and /status says "ready" with
// the additive `preparing` stamp. "restarting" begins when the drain does. This child answers the ask
// slowly on purpose, so the drain is wide enough to observe through the still-open proxy.
test("an update reports the old child ready and preparing until the drain begins, then restarting", { timeout: 20_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "frizz-dev-supervisor-preparing-"))
  const stateDir = join(workspace, ".state")
  const childEntry = join(workspace, "slow-drain-child.mjs")
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(childEntry, `
    import { registerProjectLaunchDelegate, projectLaunchOwnerTokenFromEnvironment, projectLaunchTargetFromEnvironment } from ${JSON.stringify(projectLaunchUrl)}
    const target = projectLaunchTargetFromEnvironment(process.env); const token = projectLaunchOwnerTokenFromEnvironment(process.env)
    const delegate = registerProjectLaunchDelegate(target, token)
    process.send?.({ type: "frizz-ready", pid: delegate.pid, processStart: delegate.processStart, port: Number(process.env.FRIZZ_DEV_PORT), bootId: "slow-" + process.pid })
    const stop = () => setTimeout(() => { delegate.release(); process.exit(0) }, 1_000)
    process.once("SIGTERM", stop); process.once("disconnect", stop); setInterval(() => {}, 1000)
  `)
  const target = { projectId: randomUUID(), projectDir: workspace, stateDir }
  const owner = acquireProjectLaunchOwner(target, "supervisor")
  const port = await freeSupervisorPort()
  let release!: (result: { state: "ready" }) => void
  const prepared = new Promise<{ state: "ready" }>((resolve) => { release = resolve })
  const status = async (): Promise<{ state: string; preparing?: boolean } | undefined> => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/_frizz/control/status`, { headers: { origin: `http://127.0.0.1:${port}` } })
      return await response.json() as { state: string; preparing?: boolean }
    } catch {
      return undefined
    }
  }
  let supervisor: DevSupervisor | undefined
  try {
    supervisor = await startDevSupervisor({
      port, cwd: workspace, stateDir, launchTarget: target, launchOwnerToken: owner.token, watch: false,
      childEntry,
      updateRestart: () => prepared,
      rollbackUpdate: () => {},
      // Returning is the "reexec-returns" failure: the supervisor restores itself, which is how this
      // test gets a proxy back to read the settled verdict from.
      durableReexec: async () => {},
      log: () => {}, error: () => {},
    })
    const first = await supervisor.firstBoot
    const response = await fetch(`http://127.0.0.1:${port}/_frizz/control/update-restart`, {
      method: "POST", headers: { origin: `http://127.0.0.1:${port}` },
    })
    assert.equal(response.status, 202)
    for (let poll = 0; poll < 5; poll++) {
      const observed = await status()
      assert.equal(observed?.state, "ready", "the old child is untouched while the update is prepared")
      assert.equal(observed?.preparing, true, "and the poll can tell that an update is in progress")
      assert.equal(supervisor.currentBoot()?.pid, first.pid)
      await delay(40)
    }
    release({ state: "ready" })
    let draining: { state: string; preparing?: boolean } | undefined
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
      const observed = await status()
      if (observed?.state === "restarting") { draining = observed; break }
      if (observed === undefined) break
      await delay(10)
    }
    assert.equal(draining?.state, "restarting", "the drain, once begun, is reported as one")
    assert.equal("preparing" in (draining ?? {}), false)
    await eventually(() => {
      const current = readSupervisorStatus(join(stateDir, "dev-supervisor.lock"))
      return current?.state === "failed" ? current : undefined
    }, "the returned handoff to be reported as a failure")
    await nextBoot(supervisor, first.pid)
    const settled = await status()
    assert.equal(settled?.state, "failed")
    assert.equal("preparing" in (settled ?? {}), false)
  } finally {
    await supervisor?.close()
    owner.release()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("authenticated restart takes one fresh artifact launch snapshot and fails closed when it cannot verify one", { timeout: 15_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "frizz-dev-supervisor-artifact-restart-"))
  const stateDir = join(workspace, ".state")
  const observed = join(stateDir, "child-artifact.json")
  mkdirSync(stateDir, { recursive: true })
  const artifactEntry = (digest: string) => join(workspace, `artifact-${digest}.mjs`)
  const writeArtifactEntry = (digest: string) => writeFileSync(artifactEntry(digest), `
    import { writeFileSync } from "node:fs"
    import {
      projectLaunchOwnerTokenFromEnvironment,
      projectLaunchTargetFromEnvironment,
      registerProjectLaunchDelegate,
    } from ${JSON.stringify(projectLaunchUrl)}
    const target = projectLaunchTargetFromEnvironment(process.env)
    const token = projectLaunchOwnerTokenFromEnvironment(process.env)
    if (!target || !token) process.exit(73)
    const delegate = registerProjectLaunchDelegate(target, token)
    writeFileSync(${JSON.stringify(observed)}, JSON.stringify({
      artifact: process.env.FRIZZ_STABLE_ARTIFACT,
      web: process.env.FRIZZ_STABLE_WEB_DIST,
      entry: import.meta.url,
    }))
    process.send?.({
      type: "frizz-ready",
      pid: delegate.pid,
      processStart: delegate.processStart,
      port: Number(process.env.FRIZZ_DEV_PORT),
      bootId: \`artifact-\${process.pid}-\${Date.now()}\`,
    })
    const stop = () => { delegate.release(); process.exit(0) }
    process.once("SIGTERM", stop)
    process.once("disconnect", stop)
    setInterval(() => {}, 1000)
  `)
  const firstDigest = "a".repeat(64)
  const secondDigest = "b".repeat(64)
  writeArtifactEntry(firstDigest)
  writeArtifactEntry(secondDigest)
  const launchTarget = { projectId: randomUUID(), projectDir: workspace, stateDir }
  const owner = acquireProjectLaunchOwner(launchTarget, "supervisor")
  const port = await freeSupervisorPort()
  const pointer = join(stateDir, "promoted-digest")
  writeFileSync(pointer, firstDigest)
  let supervisor: DevSupervisor | undefined
  const artifactLaunch = () => {
    const promoted = readFileSync(pointer, "utf8")
    if (promoted === "broken") throw new Error("promoted artifact failed manifest verification")
    return {
      entry: artifactEntry(promoted),
      environment: {
        FRIZZ_STABLE_ARTIFACT: promoted,
        FRIZZ_STABLE_WEB_DIST: `/immutable/${promoted}/web`,
      },
    }
  }
  try {
    supervisor = await startDevSupervisor({
      port,
      cwd: workspace,
      stateDir,
      launchTarget,
      launchOwnerToken: owner.token,
      watch: false,
      childLaunchProvider: artifactLaunch,
      log: () => {},
      error: () => {},
    })
    const first = await supervisor.firstBoot
    const firstObserved = JSON.parse(readFileSync(observed, "utf8")) as Record<string, string>
    assert.deepEqual({ artifact: firstObserved.artifact, web: firstObserved.web }, {
      artifact: firstDigest,
      web: `/immutable/${firstDigest}/web`,
    })
    assert.match(firstObserved.entry, new RegExp(`artifact-${firstDigest}\\.mjs$`))

    writeFileSync(pointer, secondDigest) // equivalent to verified `frizz-dev promote <digest>`
    const response = await fetch(`http://127.0.0.1:${port}/_frizz/control/restart`, {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${port}` },
    })
    assert.equal(response.status, 202)
    assert.deepEqual(await response.json(), { protocol: 1, state: "ready" })
    const second = await nextBoot(supervisor, first.pid)
    assert.notEqual(second.bootId, first.bootId)
    const secondObserved = JSON.parse(readFileSync(observed, "utf8")) as Record<string, string>
    assert.deepEqual({ artifact: secondObserved.artifact, web: secondObserved.web }, {
      artifact: secondDigest,
      web: `/immutable/${secondDigest}/web`,
    })
    assert.match(secondObserved.entry, new RegExp(`artifact-${secondDigest}\\.mjs$`))
    assert.equal(readSupervisorStatus(join(stateDir, "dev-supervisor.lock"))?.artifactDigest, secondDigest)

    writeFileSync(pointer, "broken")
    const failed = await fetch(`http://127.0.0.1:${port}/_frizz/control/restart`, {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${port}` },
    })
    assert.equal(failed.status, 503)
    assert.match((await failed.json() as { message: string }).message, /failed manifest verification/)
    const status = readSupervisorStatus(join(stateDir, "dev-supervisor.lock"))
    assert.equal(status?.state, "failed")
    assert.equal(status?.artifactDigest, undefined, "a failed launch never claims the promoted digest is running")
  } finally {
    await supervisor?.close()
    owner.release()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("the foreground launcher is told when the board restarts, recovers, and fails", { timeout: 15_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "frizz-dev-supervisor-activity-"))
  const stateDir = join(workspace, ".state")
  mkdirSync(stateDir, { recursive: true })
  const entry = join(workspace, "child.mjs")
  writeFileSync(entry, `
    import {
      projectLaunchOwnerTokenFromEnvironment,
      projectLaunchTargetFromEnvironment,
      registerProjectLaunchDelegate,
    } from ${JSON.stringify(projectLaunchUrl)}
    const target = projectLaunchTargetFromEnvironment(process.env)
    const token = projectLaunchOwnerTokenFromEnvironment(process.env)
    if (!target || !token) process.exit(73)
    const delegate = registerProjectLaunchDelegate(target, token)
    process.send?.({
      type: "frizz-ready",
      pid: delegate.pid,
      processStart: delegate.processStart,
      port: Number(process.env.FRIZZ_DEV_PORT),
      bootId: \`activity-\${process.pid}-\${Date.now()}\`,
    })
    const stop = () => { delegate.release(); process.exit(0) }
    process.once("SIGTERM", stop)
    process.once("disconnect", stop)
    setInterval(() => {}, 1000)
  `)
  const launchTarget = { projectId: randomUUID(), projectDir: workspace, stateDir }
  const owner = acquireProjectLaunchOwner(launchTarget, "supervisor")
  const port = await freeSupervisorPort()
  const activity: SupervisorActivity[] = []
  let usableEntry = true
  let childExits = 0
  let supervisor: DevSupervisor | undefined
  try {
    supervisor = await startDevSupervisor({
      port,
      cwd: workspace,
      stateDir,
      launchTarget,
      launchOwnerToken: owner.token,
      watch: false,
      childLaunchProvider: () => {
        if (!usableEntry) throw new Error("promoted artifact failed manifest verification")
        return { entry, environment: {} }
      },
      log: () => {},
      error: () => {},
      onActivity: (event) => activity.push(event),
      onChildExit: () => { childExits += 1 },
    })
    const first = await supervisor.firstBoot
    // The boot readout is still painting its own region here, and a beat written into it would be
    // erased by the next repaint. Nothing is announced until there is something to announce.
    assert.equal(activity.length, 0, "the first boot is the readout's story, not a lifecycle beat")
    assert.equal(childExits, 0)

    const restart = await fetch(`http://127.0.0.1:${port}/_frizz/control/restart`, {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${port}` },
    })
    assert.equal(restart.status, 202)
    await nextBoot(supervisor, first.pid)
    await eventually(() => activity.some((event) => event.kind === "ready") || undefined, "a ready beat")
    assert.deepEqual(activity.map((event) => event.kind), ["restarting", "ready"])
    assert.match(activity[0]!.message, /requested from browser/)
    assert.ok(typeof activity[1]!.ms === "number", "the closing beat carries the restart's duration")
    // The launcher reclaims its raw-mode terminal on every child exit, because the exiting child hands
    // the terminal back as it found it at its fork (PaneHost.reclaim).
    assert.equal(childExits, 1, "the replaced child's exit is reported")

    activity.length = 0
    usableEntry = false
    const failed = await fetch(`http://127.0.0.1:${port}/_frizz/control/restart`, {
      method: "POST",
      headers: { origin: `http://127.0.0.1:${port}` },
    })
    assert.equal(failed.status, 503)
    const reported = activity.filter((event) => event.kind === "failed")
    assert.equal(reported.length, 1, "a failure written twice reaches the terminal once")
    assert.match(reported[0]!.message, /failed manifest verification/)
    await supervisor.close()
    assert.equal(childExits, 2, "a stop reports the last child's exit too")
  } finally {
    await supervisor?.close()
    owner.release()
    rmSync(workspace, { recursive: true, force: true })
  }
})

test("private SDK runtime changes recycle only disposable children and recover without touching workers", { timeout: 25_000 }, async () => {
  const workspace = mkdtempSync(join(tmpdir(), "frizz-dev-supervisor-e2e-"))
  const stateDir = join(workspace, ".state")
  const sdkDir = join(workspace, "packages", "claude-agent-sdk-runtime")
  const sdkSrc = join(sdkDir, "src")
  const sdkIndex = join(sdkSrc, "index.ts")
  const sdkExtra = join(sdkSrc, "extra.ts")
  const sdkPackage = join(sdkDir, "package.json")
  const childEntry = join(workspace, "fixture-control-plane.mjs")
  const workerIdentityPath = join(stateDir, "worker-session.json")
  const supervisorLock = join(stateDir, "dev-supervisor.lock")
  mkdirSync(sdkSrc, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(sdkIndex, "export const generation = 1\n")
  writeFileSync(sdkPackage, '{"name":"@frizz/claude-agent-sdk-runtime","private":true,"type":"module"}\n')
  writeFileSync(workerIdentityPath, '{"slug":"kept-worker","sessionId":"session-stable"}\n')
  writeFileSync(childEntry, `
    import { readFileSync } from "node:fs"
    import { join } from "node:path"
    import {
      projectLaunchOwnerTokenFromEnvironment,
      projectLaunchTargetFromEnvironment,
      registerProjectLaunchDelegate,
    } from ${JSON.stringify(projectLaunchUrl)}
    const workspace = process.argv[2]
    let source = ""
    try { source = readFileSync(join(workspace, "packages", "claude-agent-sdk-runtime", "src", "index.ts"), "utf8") }
    catch { process.exit(71) }
    if (source.includes("FAIL_BOOT")) process.exit(72)
    const target = projectLaunchTargetFromEnvironment(process.env)
    const token = projectLaunchOwnerTokenFromEnvironment(process.env)
    if (!target || !token) process.exit(73)
    const delegate = registerProjectLaunchDelegate(target, token)
    process.send?.({
      type: "frizz-ready",
      pid: delegate.pid,
      processStart: delegate.processStart,
      port: Number(process.env.FRIZZ_DEV_PORT),
      bootId: \`fixture-\${process.pid}-\${Date.now()}\`,
    })
    const stop = () => { delegate.release(); process.exit(0) }
    process.once("SIGINT", stop)
    process.once("SIGTERM", stop)
    process.once("disconnect", stop)
    setInterval(() => {}, 1000)
  `)

  let notify: Parameters<NonNullable<DevSupervisorOptions["watchSubscribe"]>>[1] | undefined
  let watchOptions: Parameters<NonNullable<DevSupervisorOptions["watchSubscribe"]>>[2] | undefined
  let unsubscribed = false
  const reexecs: Parameters<NonNullable<DevSupervisorOptions["reexec"]>>[0][] = []
  const parentPid = process.pid
  let supervisor: DevSupervisor | undefined
  let launchOwner: ProjectLaunchLease | undefined
  let worker: ChildProcess | undefined

  const assertWorkerPreserved = () => {
    assert.equal(process.pid, parentPid, "runtime changes keep the stable supervisor process")
    assert.equal(reexecs.length, 0, "runtime changes never request launcher re-exec")
    assert.ok(worker?.pid && processIsAlive(worker.pid), "the independent worker process remains alive")
    assert.equal(readFileSync(workerIdentityPath, "utf8"), '{"slug":"kept-worker","sessionId":"session-stable"}\n')
  }
  const emit = (path: string, type: "create" | "update" | "delete") => {
    assert.ok(notify, "watch subscription is active")
    notify(null, [{ path, type }])
  }
  const recycle = async (boot: DevBoot, path: string, type: "create" | "update" | "delete") => {
    emit(path, type)
    const next = await nextBoot(supervisor!, boot.pid)
    assertWorkerPreserved()
    return next
  }

  try {
    worker = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000)"], {
      stdio: "ignore",
    })
    await once(worker, "spawn")

    const launchTarget = { projectId: randomUUID(), projectDir: workspace, stateDir }
    launchOwner = acquireProjectLaunchOwner(launchTarget, "supervisor")

    supervisor = await startDevSupervisor({
      port: 49_173,
      cwd: workspace,
      stateDir,
      launchTarget,
      launchOwnerToken: launchOwner.token,
      watchRoots: [workspace],
      debounceMs: 1,
      childEntry,
      childArgs: [workspace],
      watchSubscribe: async (_root, callback, options) => {
        notify = callback
        watchOptions = options
        return { unsubscribe: async () => { unsubscribed = true } }
      },
      reexec: (request) => { reexecs.push(request) },
      log: () => {},
      error: () => {},
    })
    let boot = await supervisor.firstBoot
    assertWorkerPreserved()
    assert.ok(watchOptions?.ignore?.includes("**/.cache/**"))
    assert.ok(watchOptions?.ignore?.includes("**/.parcel-cache/**"))
    assert.ok(watchOptions?.ignore?.includes("**/node_modules/**"))

    // Runtime edit/add/delete events all recycle only the disposable child.
    writeFileSync(sdkIndex, "export const generation = 2\n")
    boot = await recycle(boot, sdkIndex, "update")
    writeFileSync(sdkExtra, "export const extra = true\n")
    boot = await recycle(boot, sdkExtra, "create")
    unlinkSync(sdkExtra)
    boot = await recycle(boot, sdkExtra, "delete")

    // The private membrane's package metadata belongs to the child graph, not the stable launcher.
    writeFileSync(sdkPackage, '{"name":"@frizz/claude-agent-sdk-runtime","private":true,"type":"module","version":"0.0.2"}\n')
    boot = await recycle(boot, sdkPackage, "update")

    // A deleted/invalid config is rejected before the healthy generation is stopped. Re-creation is
    // the corrective event and validates through a fresh child generation.
    unlinkSync(sdkPackage)
    emit(sdkPackage, "delete")
    await eventually(() => {
      const status = readSupervisorStatus(supervisorLock)
      return status?.state === "failed" && /package\.json/.test(status.message) ? status : undefined
    }, "deleted package metadata to enter failed state")
    assert.equal(supervisor.currentBoot()?.pid, boot.pid)
    assertWorkerPreserved()
    writeFileSync(sdkPackage, '{"name":"@frizz/claude-agent-sdk-runtime","private":true,"type":"module"}\n')
    boot = await recycle(boot, sdkPackage, "create")

    // A child that cannot reach ready leaves the stable watcher alive in a precise failed state; the
    // next source edit is a fresh corrective generation.
    writeFileSync(sdkIndex, "FAIL_BOOT\n")
    emit(sdkIndex, "update")
    await eventually(() => {
      const status = readSupervisorStatus(supervisorLock)
      return status?.state === "failed" && /before ready/.test(status.message) && supervisor?.currentBoot() === null
        ? status
        : undefined
    }, "failed child generation")
    assertWorkerPreserved()
    writeFileSync(sdkIndex, "export const generation = 3\n")
    emit(sdkIndex, "update")
    boot = await eventually(() => supervisor?.currentBoot() ?? undefined, "recovered child generation")
    assertWorkerPreserved()

    // Watch failures are degraded, not fatal. A later valid event clears the state via a normal child
    // recycle without replacing the parent or disturbing independent workers.
    notify?.(new Error("fixture watch stream interrupted"), [])
    await eventually(() => {
      const status = readSupervisorStatus(supervisorLock)
      return status?.state === "degraded" && /watch stream interrupted/.test(status.message) ? status : undefined
    }, "degraded watcher status")
    assert.equal(supervisor.currentBoot()?.pid, boot.pid)
    assertWorkerPreserved()
    writeFileSync(sdkIndex, "export const generation = 4\n")
    boot = await recycle(boot, sdkIndex, "update")
    await eventually(() => readSupervisorStatus(supervisorLock)?.state === "ready" ? true : undefined, "ready status after watcher recovery")
    assertWorkerPreserved()
  } finally {
    await supervisor?.close()
    launchOwner?.release()
    await stopFixtureWorker(worker)
    assert.equal(supervisor ? unsubscribed : true, true)
    rmSync(workspace, { recursive: true, force: true })
  }
})

// The escalation path runs while a drain still holds the project's ownership guard, so release() can
// genuinely fail there. It must never replace the exit with an unhandled stack over the prompt.
test("a forced supervisor stop still exits when releasing launch ownership throws", () => {
  const exits: number[] = []
  const errors: string[] = []
  let clock = 0
  const stop = createSupervisorShutdownHandler({
    close: () => new Promise<void>(() => {}),
    force: () => {},
    release: () => { throw new Error("timed out waiting for the Frizz project ownership guard") },
    exit: (code) => { exits.push(code) },
    error: (line) => { errors.push(line) },
    now: () => clock,
  })
  stop()
  clock += SUPERVISOR_ESCALATE_GRACE_MS
  stop()
  assert.deepEqual(exits, [1])
  assert.ok(errors.some((line) => line.includes("could not release launch ownership")))
})

test("the default subscriber loads the real watcher and reports a change in the tree", { timeout: 120_000 }, async () => {
  // The supervisor's own tests hand it a stand-in subscriber, so nothing else here would notice the
  // default one failing to load. It is an `import()` since 2026-11-10 (the note at the top of
  // dev-supervisor.ts): the launcher's bundle no longer needs the addon installed to start.
  const root = mkdtempSync(join(tmpdir(), "frizz-default-watch-"))
  const seen: string[] = []
  const subscription = await subscribeWithWatcher(root, (err, events) => {
    assert.equal(err, null)
    for (const event of events) seen.push(event.path)
  }, {})
  try {
    // The operating system reports a new directory's first change late: 0.6s to 8.3s here on a busy
    // machine, the same with the watcher imported statically. So the file is written until one write
    // is reported.
    const deadline = Date.now() + 90_000
    for (let write = 0; seen.length === 0 && Date.now() < deadline; write++) {
      writeFileSync(join(root, "touched.ts"), `// ${write}\n`)
      await delay(50)
    }
    assert.ok(seen.some((path) => path.endsWith("touched.ts")), `no change was reported; saw ${JSON.stringify(seen)}`)
  } finally {
    await subscription.unsubscribe()
    rmSync(root, { recursive: true, force: true })
  }
})
