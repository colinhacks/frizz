// Exercise the real Frizz bridge against a real Codex app-server with no credentials. The harmless
// request must fail visibly, including retry notifications that Codex omits from its rollout.
// Usage: nub scripts/verify-codex-native-errors.mjs /absolute/path/to/codex
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createStorage } from "../packages/server/src/storage.ts"
import { createCodexAppServerBridge } from "../packages/server/src/backend/codex-app-server.ts"
import { parseCodexTranscript } from "../packages/server/src/transcript.ts"

assert.ok(process.argv[2], "Pass an installed Codex binary")
const bin = resolve(process.argv[2])
const root = mkdtempSync(join(tmpdir(), "frizz-codex-native-error-"))
const home = join(root, "home")
console.log(`Isolated probe ${root}`)
mkdirSync(join(home, ".codex"), { recursive: true })
const storage = createStorage(join(root, "ui.db"), "probe")
let bridge, child, timer
let stderr = ""
const notices = []
let finish
const terminal = new Promise((resolve, reject) => {
  finish = resolve
  timer = setTimeout(() => reject(new Error("Codex did not report a terminal failure within 90s")), 90_000)
})
// Observe this immediately even if initialization throws before the waiter below is reached.
void terminal.catch(() => {})
try {
  bridge = createCodexAppServerBridge({
    projectId: "probe", projectDir: root, stateDir: root,
    db: storage.db, interactions: storage.interactions, codexBin: bin,
    codexAuthAccountId: () => undefined,
    spawn: (command, args, options) => {
      // No ambient API key, account, provider configuration or project instructions can enter.
      child = spawn(command, args, { ...options, env: {
        PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, SHELL: process.env.SHELL,
        HOME: home, CODEX_HOME: join(home, ".codex"),
      } })
      child.stderr.on("data", (chunk) => { stderr += chunk })
      return child
    },
    onStatusChange: () => {
      const live = bridge.turnLiveness("failure", "sid")
      if (!live?.providerError) return
      notices.push(live.providerError)
      console.log(JSON.stringify(live.providerError))
      if (!live.providerError.retrying && !live.bridgeTurn) finish(live.providerError)
    },
  })
  assert.equal(bridge.turnLiveness("failure", "sid"), undefined, "negative control: no fabricated failure before a request")
  await bridge.startDisposableSession({ threadSlug: "failure", sessionId: "sid", cwd: root, ephemeral: false })
  await bridge.startTurn({ threadSlug: "failure", sessionId: "sid", text: "Reply with OK." })
  const error = await terminal
  assert.match(error.message, /401|unauthorized|authentication|missing bearer|not signed in/i)
  assert.equal(bridge.turnLiveness("failure", "sid").bridgeTurn, false)
  assert.ok(notices.some((notice) => notice.retrying), "real retry notifications reached the bridge consumer")
  const rollout = readdirSync(join(home, ".codex", "sessions"), { recursive: true }).find((path) => path.endsWith(".jsonl"))
  assert.ok(rollout, "Codex wrote a durable rollout")
  const messages = parseCodexTranscript(readFileSync(join(home, ".codex", "sessions", rollout), "utf8"))
  assert.ok(messages.some((message) => message.providerError?.message === error.message), "the terminal error survives in the real rollout")
  console.log("PASS real Codex app-server → Frizz bridge → live retry/terminal notifications → durable error transcript")
} catch (error) {
  console.error(error, stderr)
  throw error
} finally {
  clearTimeout(timer)
  const exited = child && child.exitCode === null && child.signalCode === null ? once(child, "exit") : Promise.resolve()
  const kill = setTimeout(() => child?.kill("SIGKILL"), 5_000)
  try { await bridge?.shutdown(); await exited } finally { clearTimeout(kill) }
  storage.interactions.dispose()
  storage.close()
  assert.ok(!child || child.exitCode !== null || child.signalCode !== null, "the owned Codex child exited")
  rmSync(root, { recursive: true, force: true })
  console.log("CLEANUP real Codex child closed; isolated credential-free state removed")
}
