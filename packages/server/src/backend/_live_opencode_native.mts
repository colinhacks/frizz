// Manual live probe, not CI: drive a REAL OpenCode 2 service through the native bridge exactly as a Frizz
// thread does, on a throwaway HOME, so a new OpenCode release can be checked before anyone runs on it.
// Run from the repo root (a free model, so it spends nothing; the free models share a machine-wide limit):
//
//   env -u NODE_COMPAT nub packages/server/src/backend/_live_opencode_native.mts [opencode-bin] [provider/model]
//   defaults: `opencode` on PATH, opencode/big-pickle
//
// The service runs under a temporary HOME with every XDG directory inside it and a port of its own (the
// managed port is fixed per machine), so it never reaches the operator's OpenCode or its service. It is
// stopped by its registered pid at the end, pass or fail.
//
// Checks: a dispatch in Ask mode raises a command-approval card carrying the whole command; approving it
// runs the command with this thread's FRIZZ_THREAD_SLUG in its environment; a steer sent during the next
// command lands inside that turn; the transcript folds to an idle turn. Exit 0 only when all of that held.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import Database from "../sqlite.ts"
import { createInteractionStore } from "../interaction-store.ts"
import { newTailState } from "../tailer.ts"
import { createOpencodeBridge } from "./opencode-bridge.ts"
import { OpencodeHub } from "./opencode-hub.ts"
import { opencodeTranscriptPath, createOpencodeBackend } from "./opencode-transcript.ts"

const [bin, modelArg = "opencode/big-pickle"] = process.argv.slice(2)
const [providerID, ...rest] = modelArg.split("/")
const model = { providerID: providerID!, id: rest.join("/") }
const root = mkdtempSync(join(tmpdir(), "opencode-native-live-"))
const home = join(root, "home")
const cwd = join(root, "project")
mkdirSync(cwd, { recursive: true })
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH, HOME: home,
  XDG_DATA_HOME: join(home, ".local/share"), XDG_CONFIG_HOME: join(home, ".config"),
  XDG_STATE_HOME: join(home, ".local/state"), XDG_CACHE_HOME: join(home, ".cache"),
  ...(bin ? { FRIZZ_OPENCODE_BIN: bin } : {}),
}
mkdirSync(join(home, ".config/opencode"), { recursive: true })
writeFileSync(join(home, ".config/opencode/service.json"), JSON.stringify({ port: 20_000 + Math.floor(Math.random() * 20_000) }) + "\n")

const store = createInteractionStore(new Database(":memory:"))
const hub = new OpencodeHub(env)
// frizzCli is what puts the thread's identity (FRIZZ_THREAD_SLUG, FRIZZ_PROJECT_ID) into a session's shell.
const frizzCli = { binDir: join(root, "bin"), stateDir: join(root, "state"), projectId: "live-probe" }
const bridge = createOpencodeBridge({ projectId: "live-probe", stateDir: join(root, "state"), frizzCli, interactions: store, env, hub, contractFor: () => "You are being probed. End every finished turn with the single word DONE." })
const scope = { projectId: "live-probe", threadSlug: "probe", sessionId: randomUUID() }
const file = () => opencodeTranscriptPath(join(root, "state"), scope.sessionId)
const records = (): Array<Record<string, any>> => { try { return readFileSync(file(), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
const until = async <T,>(what: string, fn: () => T | undefined | false, ms = 240_000): Promise<T> => {
  const end = Date.now() + ms
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await new Promise((r) => setTimeout(r, 300)) }
}
const results: Record<string, boolean> = {}
const check = (name: string, ok: boolean, detail = "") => { results[name] = ok; console.log(ok ? "PASS" : "FAIL", name, detail.slice(0, 300)) }

// The bridge's own waits (an unref'd `service start` child, the hub's timers) hold nothing open, as is
// right inside the server, which its listening socket keeps alive. A script has to hold the loop itself.
const keepAlive = setInterval(() => {}, 1_000)
const stopService = () => {
  try {
    const reg = JSON.parse(readFileSync(join(home, ".local/state/opencode/service.json"), "utf8")) as { pid?: number }
    if (reg.pid) process.kill(reg.pid, "SIGTERM")
  } catch {}
}
process.once("SIGINT", () => { stopService(); process.exit(130) })

try {
  const { opencodeSessionId, version } = await bridge.spawnDispatch({
    threadSlug: scope.threadSlug, sessionId: scope.sessionId, cwd, mode: "default", model,
    prompt: "Run exactly `echo first-$FRIZZ_THREAD_SLUG | tr a-z A-Z` with your shell tool, then run exactly `sleep 20 && echo second`, then reply with one line.",
  })
  console.log("OpenCode", version ?? "(version unknown)", "session", opencodeSessionId)
  const card = await until("a permission card", () => store.listPending(scope)[0])
  const command = (card.payload as { command?: { preview?: string } }).command?.preview ?? ""
  check("card-whole-command", card.payload.kind === "command-approval" && command.includes("|"), command)
  store.resolve(scope, { slug: scope.threadSlug, sessionId: scope.sessionId, interactionId: card.id, sessionEpoch: 0, capabilityRevision: 0, expectedRecordRevision: card.recordRevision, responseId: randomUUID(), decisionId: "accept" })
  await until("the first result", () => records().find((r) => r.kind === "tool-result"))
  check("env-reaches-shell", records().some((r) => r.kind === "tool-result" && /FIRST-PROBE/.test(r.text ?? "")), JSON.stringify(records().filter((r) => r.kind === "tool-result").map((r) => r.text)))
  // The sleep asks too; approve it, then steer while it runs.
  const card2 = await until("the second card", () => store.listPending(scope)[0])
  store.resolve(scope, { slug: scope.threadSlug, sessionId: scope.sessionId, interactionId: card2.id, sessionEpoch: 0, capabilityRevision: 0, expectedRecordRevision: card2.recordRevision, responseId: randomUUID(), decisionId: "accept" })
  await until("the sleep call", () => records().find((r) => r.kind === "tool-call" && /sleep 20/.test(JSON.stringify(r.input))))
  await bridge.followUp({ threadSlug: scope.threadSlug, sessionId: scope.sessionId, cwd, opencodeSessionId, mode: "default", text: "Also put the word MARIGOLD in your final line.", delivery: "steer" })
  await until("the turn's end", () => records().find((r) => r.kind === "turn-end"))
  const recs = records()
  const steerAt = recs.findIndex((r) => r.kind === "user-message" && /MARIGOLD/.test(r.text ?? ""))
  const endAt = recs.findIndex((r) => r.kind === "turn-end")
  check("steer-inside-turn", steerAt > 0 && steerAt < endAt && /MARIGOLD/.test(recs[endAt]!.finalText ?? ""), recs[endAt]!.finalText ?? "")
  const state = newTailState(scope.threadSlug, scope.sessionId, file())
  const backend = createOpencodeBackend({ stateDir: join(root, "state") })
  for (const line of readFileSync(file(), "utf8").split("\n")) backend.foldLine(state, line)
  check("folds-idle", state.turn === "idle", String(state.turn))
} catch (err) {
  check("probe", false, (err as Error).message)
} finally {
  clearInterval(keepAlive)
  await bridge.shutdown()
  hub.stop()
  stopService()
  rmSync(root, { recursive: true, force: true })
}
const failed = Object.entries(results).filter(([, ok]) => !ok).map(([k]) => k)
console.log(failed.length ? `FAILED: ${failed.join(", ")}` : "ALL PASS")
process.exit(failed.length ? 1 : 0)
