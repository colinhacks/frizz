// Disposable dev control-plane child. The long-lived supervisor forks this process and replaces it
// whenever server/shared/RPC source changes. Claude and Codex workers are unaffected: each lives in its
// own detached daemon, which this process neither owns nor forks. It owns only Frizz's HTTP/Vite/watch/
// tailer/storage handles.
import { projectFromLaunchTarget } from "./project.ts"
import { existsSync } from "node:fs"
import { join } from "node:path"
import {
  currentProcessGeneration,
  projectLaunchOwnerTokenFromEnvironment,
  projectLaunchTargetFromEnvironment,
  registerProjectLaunchDelegate,
  verifyProjectLaunchDelegate,
} from "./project-launch.ts"
import { ShutdownTimeoutError } from "./shutdown.ts"
import { log as frizzLog } from "./logging.ts"
import { sessionEpochLogLine } from "./access-codes.ts"
import { signOutOlderSessionEpoch } from "./session-epoch-child.ts"

// A control-plane child that dies must leave its reason in the run log, not only on a terminal the
// launcher may have already repainted past. Its stdio is still inherited, so an uncaught stack would
// otherwise land on the operator's screen and nowhere durable.
process.on("uncaughtException", (error) => {
  frizzLog.error("dev-child", `uncaught exception: ${error instanceof Error ? error.stack ?? error.message : error}`)
  process.exit(1)
})
process.on("unhandledRejection", (reason) => {
  frizzLog.error("dev-child", `unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : reason}`)
})

// An update's download-ahead (provision-ahead.ts) runs this same entry with one variable set: fetch
// the release's runtimes, report, exit. Before anything below, which would start a server.
if (process.env.FRIZZ_PROVISION_RUNTIMES_ONLY === "1") {
  const { runProvisionAhead } = await import("./provision-ahead.ts")
  process.exit(await runProvisionAhead())
}

const rawPort = process.env.FRIZZ_DEV_PORT
const port = Number(rawPort)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  frizzLog.error("dev-child", `invalid FRIZZ_DEV_PORT: ${rawPort ?? "<unset>"}`)
  process.exit(1)
}

// Telling the supervisor something must never be able to KILL this child. `process.send` still exists
// after the parent goes away — the channel object outlives the peer — so `process.send?.(…)` is not a
// guard at all: the write fails asynchronously and, with no callback, Node surfaces it as an
// unhandled 'error' event that takes the process down. The user sees an EPIPE stack printed over
// their shell prompt seconds after they already gave up (2026-07-23, twice, in two repos).
//
// Check `connected` first, and ALWAYS pass a callback — with one, Node routes the failure there
// instead of emitting 'error'. Losing this message is harmless: a parent that is gone is not waiting.
function notifySupervisor(message: Record<string, unknown>): void {
  if (!process.connected || typeof process.send !== "function") return
  try {
    process.send(message, undefined, undefined, () => {})
  } catch {
    // The channel closed between the check and the write. Nothing to report it to.
  }
}

// The supervisor's stop is a CLOSED IPC CHANNEL, not a signal: `stopChild` calls `child.disconnect()`
// and waits for this process to exit on its own, signalling only if it does not. It has to be, because
// on Windows every signal Node can send is a TerminateProcess, so the shutdown below never ran there
// and every Restart or update cut the board off mid-request (audit 2026-09-11, finding 3). A crashed
// supervisor leaves the same event behind, and both mean the same thing: go.
//
// Installed from the first line rather than after the server is up, for two reasons. A stop that
// lands mid-boot used to be a SIGTERM that Node's default handler answered at once; waiting for the
// boot to finish and then draining would turn a Ctrl-C during startup into a wait of many seconds.
// And a listener added only after `startServer` resolved never sees an event that already fired,
// which left a control plane orphaned whenever the supervisor died during the boot.
let shutdown: (() => Promise<void>) | undefined
process.once("disconnect", () => {
  if (shutdown) {
    void shutdown()
    return
  }
  frizzLog.info("dev-child", "supervisor disconnected before the server was up; exiting")
  process.exit(0)
})
if (typeof process.send === "function" && !process.connected) process.exit(1)

try {
  const target = projectLaunchTargetFromEnvironment(process.env)
  const launchOwnerToken = projectLaunchOwnerTokenFromEnvironment(process.env)
  if (!target || !launchOwnerToken) throw new Error("dev child is missing pinned project launch ownership")
  verifyProjectLaunchDelegate(target, launchOwnerToken)
  // Stable launchers fence EVERY project, including the gap after a launcher crash. Register before
  // importing/opening the server; leave this delegate until process death, not merely server.close().
  // A successor must observe this exact generation gone before another scheduler can start.
  let machineOwnerToken: string | undefined
  if (process.env.FRIZZ_SERVER_OWNERSHIP) {
    const ownership = JSON.parse(process.env.FRIZZ_SERVER_OWNERSHIP) as NodeJS.ProcessEnv
    const serverTarget = projectLaunchTargetFromEnvironment(ownership)
    const serverToken = projectLaunchOwnerTokenFromEnvironment(ownership)
    if (!serverTarget || !serverToken) throw new Error("stable server is missing global launch ownership")
    registerProjectLaunchDelegate(serverTarget, serverToken)
    machineOwnerToken = serverToken
  }
  const { startServer } = await import("./index.ts")
  const project = projectFromLaunchTarget(target)
  const stableWebDist = process.env.FRIZZ_STABLE_WEB_DIST
  const stableArtifact = process.env.FRIZZ_STABLE_ARTIFACT
  if (stableArtifact && !stableWebDist)
    throw new Error("stable artifact launch is missing FRIZZ_STABLE_WEB_DIST")
  if (stableWebDist) {
    const required = [
      ["FRIZZ_SCRIPTS_DIR", process.env.FRIZZ_SCRIPTS_DIR, "index.mjs"],
      ["FRIZZ_WORKER_PLUGIN_DIR", process.env.FRIZZ_WORKER_PLUGIN_DIR, ".claude-plugin/plugin.json"],
    ] as const
    if (!existsSync(stableWebDist)) throw new Error("stable artifact launch is missing its verified web directory")
    for (const [name, directory, requiredFile] of required) {
      if (!directory || !existsSync(join(directory, requiredFile)))
        throw new Error(`stable artifact launch is missing verified ${name}`)
    }
  }
  const server = await startServer({
    dev: !stableWebDist,
    port,
    installSignalHandlers: false,
    requireDevWeb: !stableWebDist,
    ...(stableWebDist ? { webDistDir: stableWebDist } : {}),
    project,
    launchOwnerToken,
    ...(machineOwnerToken ? { machineOwnerToken } : {}),
    requestOwnerStop: () => notifySupervisor({ type: "frizz-stop-owner", token: launchOwnerToken }),
  })
  notifySupervisor({
    type: "frizz-ready",
    ...currentProcessGeneration(),
    port: server.port,
    bootId: server.ctx.bootId,
  })
  // After ready, never before: the launcher has to be answering for the sign-out request to land, and
  // a slow or failed request must not hold up the board. A launcher that applied SESSION_EPOCH at its
  // own start makes this a no-op; one older than the bump is why it exists (see the module).
  if (process.connected) {
    void signOutOlderSessionEpoch({ stateDir: target.stateDir, supervisorPid: process.ppid })
      .then(({ advance, signedOut }) => {
        const line = sessionEpochLogLine(advance, signedOut)
        if (line) frizzLog.warn("dev-child", `${line} (a launcher older than this release refuses the rest from its next start)`)
      })
      .catch((error) => frizzLog.warn("dev-child", `session epoch: ${error instanceof Error ? error.message : error}`))
  }

  let shuttingDown = false
  const stop = async () => {
    if (shuttingDown) return
    shuttingDown = true
    const force = setTimeout(() => process.exit(1), 15_000)
    force.unref()
    try {
      await server.close()
      process.exit(0)
    } catch (err) {
      // close() reports its bounded public deadline while the shutdown fence continues draining.
      // Do not turn that diagnostic into an immediate process exit: doing so repeatedly kills clean
      // late drains and makes the supervisor log a misleading restart storm.
      if (err instanceof ShutdownTimeoutError) {
        frizzLog.warn("dev-child", `shutdown exceeded ${err.timeoutMs}ms; retaining ownership while the drain completes`)
        try {
          await server.shutdownFence.whenSafe()
          process.exit(0)
          return
        } catch (drainError) {
          frizzLog.error("dev-child", `late shutdown drain failed: ${drainError instanceof Error ? drainError.stack ?? drainError.message : drainError}`)
        }
      }
      frizzLog.error("dev-child", `shutdown failed: ${err instanceof Error ? err.stack ?? err.message : err}`)
      process.exit(1)
    }
  }

  // From here the supervisor's ask (the 'disconnect' listener installed above) drains the server
  // instead of exiting outright.
  shutdown = stop
  // Keep the guard installed for repeated same-kind signals so they cannot restore Node's default
  // immediate termination while the server's bounded shutdown barrier is draining. On POSIX these
  // are the supervisor's ESCALATION after the ask went unanswered, and an operator's own Ctrl-C.
  process.on("SIGINT", () => void stop())
  process.on("SIGTERM", () => void stop())
} catch (err) {
  frizzLog.error("dev-child", `failed to start: ${err instanceof Error ? err.stack ?? err.message : err}`)
  process.exit(1)
}
