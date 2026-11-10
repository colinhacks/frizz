// A pid is not an identity. Every teardown used to signal the pid a daemon record named on the strength
// of `process.kill(pid, 0)`, and a record that outlived its daemon (a broker ended by a signal left its
// record behind, and the state directory survives a reboot) names a pid the OS has since handed to some
// other process. These drive the real hosts against a real process this file starts, standing in for
// that other process: it must survive every teardown.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { daemonMayBeSignalled, daemonPidVerdict, exactProcessStart, filetimeToMs, parsePsStart, type DaemonIdentityDeps } from "./daemon-identity.ts"
import { adoptOrForkBroker, brokerLastKnownPath, claudeBrokerRecordPath, claudeBrokerSocketPath, killBroker } from "./claude-broker-host.ts"
import { codexAppServerSocketPath, killCodexAppServerDaemon, liveDaemonRecord, stopCodexAppServerDaemon } from "./codex-app-server-host.ts"
import { killNativeListener, liveNativeRecord, nativeRecordPath, stopNativeListener } from "./codex-app-server-native.ts"
import { acpDaemonRecordPath, acpDaemonSocketPath, liveAcpDaemonRecord, stopAcpDaemon } from "./acp-host.ts"

const HOUR = 60 * 60_000
const SESSION = "11111111-2222-4333-8444-555555555555"

// ---- the two start-time readings ---------------------------------------------------------------------

test("a `ps` start time in the C locale and UTC reads as that instant", () => {
  assert.equal(parsePsStart("Mon Nov 10 08:36:12 2026\n"), Date.UTC(2026, 10, 10, 8, 36, 12))
  assert.equal(parsePsStart("Sun Feb  1 00:00:05 2026"), Date.UTC(2026, 1, 1, 0, 0, 5), "a one-digit day is padded with a space")
  for (const junk of ["", "08:36:12", "lun. 10 nov. 08:36:12 2026", "Mon Xyz 10 08:36:12 2026"]) {
    assert.equal(parsePsStart(junk), undefined, JSON.stringify(junk))
  }
})

test("a Windows FILETIME reads as epoch milliseconds", () => {
  // 2026-11-10T08:36:12Z, in 100ns units since 1601.
  const ms = Date.UTC(2026, 10, 10, 8, 36, 12)
  assert.equal(filetimeToMs(String((BigInt(ms) + 11_644_473_600_000n) * 10_000n)), ms)
  assert.equal(filetimeToMs("not a number"), undefined)
})

// ---- the verdict, with the OS stood in ---------------------------------------------------------------

const RECORDED = "2026-11-10T08:00:00.000Z"
const at = (iso: string) => Date.parse(iso)
const posix = (over: DaemonIdentityDeps): DaemonIdentityDeps => ({ platform: "darwin", alive: () => true, exactStart: () => undefined, ...over })

test("a process that started after the record was written is somebody else's, and is never signalled", () => {
  const claim = { pid: 4242, createdAt: RECORDED }
  // The daemon: started a few seconds before it was ready to publish.
  assert.equal(daemonPidVerdict(claim, posix({ startedAtMs: () => at("2026-11-10T07:59:57.000Z") })), "ours")
  // `ps` rounds to the second and a record can be written in the daemon's first one: inside the slack.
  assert.equal(daemonPidVerdict(claim, posix({ startedAtMs: () => at("2026-11-10T08:00:03.000Z") })), "ours")
  // Whatever holds the pid a day and a reboot later.
  const later = posix({ startedAtMs: () => at("2026-11-11T09:15:00.000Z") })
  assert.equal(daemonPidVerdict(claim, later), "not-ours")
  assert.equal(daemonMayBeSignalled(claim, later), false)
})

test("nothing under the pid is gone; a start time nobody can read is unknown, and still signalled", () => {
  const claim = { pid: 4242, createdAt: RECORDED }
  assert.equal(daemonPidVerdict(claim, posix({ alive: () => false })), "gone")
  assert.equal(daemonMayBeSignalled(claim, posix({ alive: () => false })), false)
  const unreadable = posix({ startedAtMs: () => undefined })
  assert.equal(daemonPidVerdict(claim, unreadable), "unknown")
  assert.equal(daemonMayBeSignalled(claim, unreadable), true, "the choice there is a worker that can never be stopped")
  assert.equal(daemonPidVerdict({ pid: 4242 }, posix({ startedAtMs: () => 0 })), "unknown", "a record with no instant has nothing to compare")
})

test("a Linux daemon's exact stamp decides alone, and a Linux record without one is judged as before", () => {
  const stamped = { pid: 4242, createdAt: RECORDED, processStart: "linux:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0:123456" }
  const same = { platform: "linux" as const, alive: () => true, exactStart: () => stamped.processStart, startedAtMs: () => at("2026-11-12T00:00:00.000Z") }
  assert.equal(daemonPidVerdict(stamped, same), "ours", "the wall clock moved; the ticks since boot did not")
  const other = { ...same, exactStart: () => "linux:0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0:999999" }
  assert.equal(daemonPidVerdict(stamped, other), "not-ours")
  // A record from a daemon that predates the stamp. `ps` derives a Linux start time from the boot time,
  // which moves when the clock is stepped, so it is not held against the record.
  const legacy = { platform: "linux" as const, alive: () => true, exactStart: () => undefined, startedAtMs: () => at("2026-11-12T00:00:00.000Z") }
  assert.equal(daemonPidVerdict({ pid: 4242, createdAt: RECORDED }, legacy), "unknown")
})

// ---- the real thing ----------------------------------------------------------------------------------

/** Some other program that happens to hold a pid: node, idle, started by this file. */
function bystander(t: { after(fn: () => void): void }): Promise<{ pid: number; child: ChildProcess; exit: Promise<string> }> {
  const child = spawn(process.execPath, ["-e", "process.stdout.write('up\\n'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "pipe", "ignore"] })
  const exit = new Promise<string>((resolve) => child.once("exit", (code, signal) => resolve(signal ?? `code ${code}`)))
  t.after(() => { try { child.kill("SIGKILL") } catch {} })
  return new Promise((resolve, reject) => {
    child.once("error", reject)
    child.stdout!.once("data", () => resolve({ pid: child.pid!, child, exit }))
  })
}
const stillRunning = async (who: { exit: Promise<string> }, ms = 400): Promise<string> =>
  Promise.race([who.exit, new Promise<string>((resolve) => setTimeout(() => resolve("still running"), ms))])
/** What a record written an hour before this process existed says about when it was written. */
const longAgo = () => new Date(Date.now() - HOUR).toISOString()
/** A record no real start time contradicts, for the control: written after the process began. */
const justNow = () => new Date(Date.now() + 1_000).toISOString()
/** On Linux a record needs the daemon's own stamp to be judged at all (see the legacy case above). */
const staleStamp = () => (process.platform === "linux" ? { processStart: "linux:00000000-0000-4000-8000-000000000000:1" } : {})
const liveStamp = (pid: number) => { const stamp = exactProcessStart(pid); return stamp ? { processStart: stamp } : {} }

test("the OS itself: a real process is ours for a record written after it began, and not for one written long before", async (t) => {
  const other = await bystander(t)
  assert.equal(daemonPidVerdict({ pid: other.pid, createdAt: justNow(), ...liveStamp(other.pid) }), "ours")
  assert.equal(daemonPidVerdict({ pid: other.pid, createdAt: longAgo(), ...staleStamp() }), "not-ours")
  other.child.kill("SIGKILL")
  await other.exit
  assert.equal(daemonPidVerdict({ pid: other.pid, createdAt: justNow() }), "gone")
})

test("Claude broker: Stop drops a record whose pid is another process, and that process lives; the daemon itself is signalled", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-daemon-identity-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const recordPath = claudeBrokerRecordPath(dir, SESSION)
  const publish = (pid: number, createdAt: string, stamp: object) => {
    mkdirSync(dirname(recordPath), { recursive: true })
    writeFileSync(recordPath, JSON.stringify({ daemonPid: pid, socketPath: claudeBrokerSocketPath(dir, SESSION), sessionId: SESSION, generation: "g1", createdAt, ...stamp }))
  }

  const other = await bystander(t)
  publish(other.pid, longAgo(), staleStamp())
  assert.equal(killBroker(dir, SESSION), true, "there was a record to clear")
  assert.equal(existsSync(recordPath), false, "the stale record is dropped")
  assert.equal(await stillRunning(other), "still running", "the process that only shares the pid was not signalled")

  // CONTROL: the same call, the same process, a record that process could have written.
  publish(other.pid, justNow(), liveStamp(other.pid))
  assert.equal(killBroker(dir, SESSION), true)
  assert.equal(await stillRunning(other, 5_000), "SIGTERM", "a daemon is still stopped")
})

test("Claude broker: a record whose pid is another process is not a daemon to reattach to", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-daemon-identity-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const recordPath = claudeBrokerRecordPath(dir, SESSION)
  mkdirSync(dirname(recordPath), { recursive: true })
  const other = await bystander(t)
  const stale = { daemonPid: other.pid, socketPath: claudeBrokerSocketPath(dir, SESSION), sessionId: SESSION, generation: "the-dead-daemon", createdAt: longAgo(), ...staleStamp() }
  writeFileSync(recordPath, JSON.stringify(stale))

  // A daemon entry that dies at once: what matters is that a fork was ATTEMPTED, where the stale record
  // used to be handed back as `reattached` and every send to the thread then failed for good.
  const entry = join(dir, "dies.mjs")
  writeFileSync(entry, "process.exit(3)\n")
  const options = { stateDir: dir, cwd: dir, sessionId: SESSION, executablePath: process.execPath, env: {}, daemonEntry: entry, timeoutMs: 20_000 }
  await assert.rejects(adoptOrForkBroker(options), /exited before it became ready/)
  assert.equal(existsSync(recordPath), false, "the stale record is gone")
  assert.equal(JSON.parse(readFileSync(brokerLastKnownPath(recordPath), "utf8")).generation, "the-dead-daemon", "and who it named is remembered for the death report")
  assert.equal(await stillRunning(other), "still running")

  // CONTROL: a record its process could have written is adopted as before, with no fork.
  writeFileSync(recordPath, JSON.stringify({ ...stale, generation: "alive", createdAt: justNow(), ...liveStamp(other.pid) }))
  const adopted = await adoptOrForkBroker(options)
  assert.equal(adopted.reattached, true)
  assert.equal(adopted.record.generation, "alive")
})

test("Codex daemon, Codex native listener and ACP daemon: each stop leaves another process alone and still stops its own", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-daemon-identity-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const project = "proj-x"
  const families = [
    {
      name: "codex daemon",
      path: join(dir, "codex-app-server", `${project}.json`),
      record: (pid: number, createdAt: string, stamp: object) => ({ projectId: project, generation: "g", daemonPid: pid, childPid: 0, socketPath: codexAppServerSocketPath(dir, project), createdAt, ...stamp }),
      live: () => liveDaemonRecord(dir, project) !== null,
      stop: () => stopCodexAppServerDaemon(dir, project, 3_000),
    },
    {
      name: "codex native listener",
      path: nativeRecordPath(dir, project),
      // This one is live only while its socket path exists, so the record names a file that does.
      record: (pid: number, createdAt: string, stamp: object) => ({ projectId: project, generation: "g", listenerPid: pid, socketPath: join(dir, "listener.sock"), createdAt, ...stamp }),
      live: () => liveNativeRecord(dir, project) !== null,
      stop: () => stopNativeListener(dir, project, 3_000),
    },
    {
      name: "acp daemon",
      path: acpDaemonRecordPath(dir, SESSION),
      record: (pid: number, createdAt: string, stamp: object) => ({ threadSlug: "t", sessionId: SESSION, generation: "g", daemonPid: pid, childPid: 0, socketPath: acpDaemonSocketPath(dir, SESSION), createdAt, ...stamp }),
      live: () => liveAcpDaemonRecord(dir, SESSION) !== null,
      stop: () => stopAcpDaemon(dir, SESSION, 3_000),
    },
  ]
  writeFileSync(join(dir, "listener.sock"), "")

  for (const family of families) {
    const other = await bystander(t)
    mkdirSync(dirname(family.path), { recursive: true })
    writeFileSync(family.path, JSON.stringify(family.record(other.pid, longAgo(), staleStamp())))
    assert.equal(family.live(), true, `${family.name}: control, the record reads live on the pid alone`)
    const began = Date.now()
    await family.stop()
    assert.equal(existsSync(family.path), false, `${family.name}: the stale record is dropped`)
    assert.ok(Date.now() - began < 2_000, `${family.name}: and nothing waits for a death that is not coming`)
    assert.equal(await stillRunning(other), "still running", `${family.name}: the other process was not signalled`)

    writeFileSync(family.path, JSON.stringify(family.record(other.pid, justNow(), liveStamp(other.pid))))
    await family.stop()
    assert.equal(await stillRunning(other, 5_000), "SIGTERM", `${family.name}: its own daemon is still stopped`)
  }
})

// Each of these three reads its record back field by field, so a field the reader does not name is
// dropped without a word. The exact stamp was: written by the daemon, absent from what the host read,
// and a Linux record therefore judged as unstamped (`unknown`, which signals). Driven with the Linux
// rule on every platform, since the stamp itself only exists there.
test("Codex daemon, Codex native listener and ACP daemon: the exact stamp in a record reaches the verdict", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-daemon-identity-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const project = "proj-y"
  const STAMP = "linux:11111111-1111-4111-8111-111111111111:4242"
  const linux = (now: string): DaemonIdentityDeps => ({ platform: "linux", exactStart: () => now })
  writeFileSync(join(dir, "listener.sock"), "")
  const families = [
    {
      name: "codex daemon",
      path: join(dir, "codex-app-server", `${project}.json`),
      record: (pid: number) => ({ projectId: project, generation: "g", daemonPid: pid, childPid: 0, socketPath: codexAppServerSocketPath(dir, project), createdAt: justNow(), processStart: STAMP }),
      stop: async (identity: DaemonIdentityDeps) => { killCodexAppServerDaemon(dir, project, identity) },
    },
    {
      name: "codex native listener",
      path: nativeRecordPath(dir, project),
      record: (pid: number) => ({ projectId: project, generation: "g", listenerPid: pid, socketPath: join(dir, "listener.sock"), createdAt: justNow(), processStart: STAMP }),
      stop: async (identity: DaemonIdentityDeps) => { killNativeListener(dir, project, identity) },
    },
    {
      name: "acp daemon",
      path: acpDaemonRecordPath(dir, SESSION),
      record: (pid: number) => ({ threadSlug: "t", sessionId: SESSION, generation: "g", daemonPid: pid, childPid: 0, socketPath: acpDaemonSocketPath(dir, SESSION), createdAt: justNow(), processStart: STAMP }),
      stop: (identity: DaemonIdentityDeps) => stopAcpDaemon(dir, SESSION, 3_000, identity),
    },
  ]
  for (const family of families) {
    const other = await bystander(t)
    mkdirSync(dirname(family.path), { recursive: true })
    writeFileSync(family.path, JSON.stringify(family.record(other.pid)))
    await family.stop(linux("linux:11111111-1111-4111-8111-111111111111:9999"))
    assert.equal(await stillRunning(other), "still running", `${family.name}: a pid whose stamp differs from the record's is not signalled`)

    writeFileSync(family.path, JSON.stringify(family.record(other.pid)))
    await family.stop(linux(STAMP))
    assert.equal(await stillRunning(other, 5_000), "SIGTERM", `${family.name}: the pid whose stamp matches is`)
  }
})
