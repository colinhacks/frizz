// LIVE proof (not a unit test) that a Codex LAUNCH PREFIX (Settings.launchPrefix.codex) really sits
// between Frizz and the app-server, against real codex over the native listener — the transport Frizz
// selects on macOS and Linux.
//
// The wrapper is deliberately the WORST shape an operator could write: a `sh` script that runs codex
// as a child instead of `exec`ing it, so it neither forwards signals nor gets out of the way. Three
// things must still hold:
//   1. a variable only the wrapper sets reaches the shell of a real Codex turn;
//   2. changing the prefix replaces the shared app-server at the next turn, through the new wrapper;
//   3. the replacement ends the OLD codex too, not just the wrapper that started it — a signal to the
//      wrapper's pid alone would leave codex holding the socket (see signalListener).
// Run:
//   CODEX_BIN=<codex 0.166.0> nub packages/server/src/backend/_live_codex_launch_prefix.mts
import { execFileSync, spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { CodexAppServerBridge } from "./codex-app-server.ts"
import { killNativeListener, liveNativeRecord, nativeListenCodexAppServerHost } from "./codex-app-server-native.ts"

const CODEX_BIN = process.env.CODEX_BIN || "codex"
const root = mkdtempSync(join(tmpdir(), "frizz-codex-prefix-"))
const PROJECT = "codex-prefix"
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

let failures = 0
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`)
  if (!ok) failures++
}

// Each wrapper records that it ran and the words it was handed, exports a marker only it knows, and
// runs codex as its CHILD (no exec), staying alive as its parent.
function wrapper(name: string, marker: string): string {
  const path = join(root, name)
  writeFileSync(path, `#!/bin/sh
printf '%s\\n' "$@" > '${join(root, `${name}.argv`)}'
FRIZZ_LP_MARKER='${marker}'
export FRIZZ_LP_MARKER
shift
"$@"
`)
  chmodSync(path, 0o700)
  return path
}

/** pid → { ppid, command } for every process, so the wrapper's codex child can be named. */
function processTable(): Map<number, { ppid: number; command: string }> {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
  const rows = new Map<number, { ppid: number; command: string }>()
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    if (match) rows.set(Number(match[1]), { ppid: Number(match[2]), command: match[3]! })
  }
  return rows
}
const codexChildOf = (pid: number) => [...processTable()].find(([, row]) => row.ppid === pid && /\bapp-server\b/.test(row.command))?.[0]

function rolloutText(codexSessionId: string): string {
  const base = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "sessions")
  let hit: string | undefined
  const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name.endsWith(`-${codexSessionId}.jsonl`)) hit = p
  } }
  try { walk(base) } catch {}
  return hit ? readFileSync(hit, "utf8") : ""
}

async function turnDone(bridge: CodexAppServerBridge, slug: string, sessionId: string): Promise<boolean> {
  for (let i = 0; i < 240; i++) {
    if (bridge.binding(slug, sessionId)?.currentTurnId === null) return true
    await sleep(500)
  }
  return false
}

;(async () => {
  const db = new Database(join(root, "ui.db"))
  db.pragma("journal_mode = WAL")
  let iid = 0
  const interactions = createInteractionStore(db, { now: () => new Date(), id: () => `i-${++iid}` })
  const first = wrapper("inject-one", "marker-from-prefix-one")
  const second = wrapper("inject-two", "marker-from-prefix-two")
  let prefix = [first, "--via-frizz"]
  const diagnostics: string[] = []
  const bridge = new CodexAppServerBridge({
    projectId: PROJECT, projectDir: root, stateDir: root, db, interactions,
    codexBin: CODEX_BIN, now: () => new Date(), requestTimeoutMs: 60_000,
    host: nativeListenCodexAppServerHost,
    launchPrefix: () => prefix,
    diagnostic: (e) => { const ev = (e as { event?: string }).event; if (ev) diagnostics.push(ev) },
  })
  try {
    console.log("======== Codex launch prefix, live ========")
    const slug = "prefixed", sessionId = "prefixed-session"
    const binding = await bridge.startDisposableSession({ threadSlug: slug, sessionId, cwd: root, sandbox: "read-only", ephemeral: false })
    await bridge.startTurn({ threadSlug: slug, sessionId, text: "Run the shell command `printenv FRIZZ_LP_MARKER` and reply with exactly what it printed, nothing else." })
    check("the first turn completed", await turnDone(bridge, slug, sessionId))

    const one = liveNativeRecord(root, PROJECT)
    check("the listener record names the prefix it was started through", JSON.stringify(one?.launchPrefix) === JSON.stringify(prefix), one?.launchPrefix)
    const firstWrapperPid = one?.listenerPid ?? -1
    const firstCodexPid = codexChildOf(firstWrapperPid)
    check("the recorded pid is the WRAPPER, and codex is its child", processTable().get(firstWrapperPid)?.command.includes("inject-one") === true && firstCodexPid !== undefined, { firstWrapperPid, firstCodexPid })
    check("the wrapper was handed its own words, then the codex command", existsSync(join(root, "inject-one.argv")) && readFileSync(join(root, "inject-one.argv"), "utf8").startsWith(`--via-frizz\n${CODEX_BIN}\napp-server\n`))
    check("a variable only the wrapper set reached the Codex turn's shell", rolloutText(binding.codexSessionId).includes("marker-from-prefix-one"))

    console.log("  --- the operator changes the prefix ---")
    prefix = [second, "--via-frizz"]
    await bridge.startTurn({ threadSlug: slug, sessionId, text: "Run `printenv FRIZZ_LP_MARKER` again and reply with exactly what it printed." })
    check("the second turn completed", await turnDone(bridge, slug, sessionId))
    const two = liveNativeRecord(root, PROJECT)
    check("the app-server was replaced", two !== null && two.generation !== one?.generation)
    check("…and reported as a prefix change", diagnostics.includes("launch-prefix-applied"), diagnostics)
    check("the replacement runs through the NEW wrapper", processTable().get(two?.listenerPid ?? -1)?.command.includes("inject-two") === true)
    check("the turn on the replacement saw the new prefix's variable", rolloutText(binding.codexSessionId).includes("marker-from-prefix-two"))
    await sleep(500)
    check("the OLD wrapper is gone", !alive(firstWrapperPid))
    check("the OLD codex is gone too, though its wrapper never forwarded a signal", firstCodexPid !== undefined && !alive(firstCodexPid), { firstCodexPid })

    console.log("  --- teardown ---")
    const lastWrapperPid = two?.listenerPid ?? -1
    const lastCodexPid = codexChildOf(lastWrapperPid)
    bridge.close()
    killNativeListener(root, PROJECT)
    await sleep(1500)
    check("killNativeListener ends the wrapper and its codex", !alive(lastWrapperPid) && lastCodexPid !== undefined && !alive(lastCodexPid), { lastWrapperPid, lastCodexPid })
    console.log(`\n==== ${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`} ====`)
  } catch (e) {
    failures++
    console.error("HARNESS ERROR:", (e as Error).message, (e as Error).stack)
  } finally {
    try { bridge.close() } catch {}
    killNativeListener(root, PROJECT)
    try { const r = liveNativeRecord(root, PROJECT); if (r) spawnSync("kill", ["-9", `-${r.listenerPid}`]) } catch {}
    try { interactions.dispose(); db.close() } catch {}
    process.exit(failures === 0 ? 0 : 1)
  }
})()
