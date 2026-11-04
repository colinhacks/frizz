#!/usr/bin/env node
// Drive the Claude Code build THIS checkout pins through Frizz's own SDK path, the way a worker runs,
// and leave real transcripts behind for the rest of the bump to read.
//
//   env -u NODE_COMPAT nub scripts/pin-bump/claude-probe.mjs [--cwd <dir>] [ENV=VALUE ...]
//
// Two sessions through `createClaudeQueryFactory` against the provisioned binary (fetched first if it
// is missing): bypassPermissions on haiku, then acceptEdits on sonnet, each asked to run Bash and Read
// on a note and answer. For each it prints what the init frame reports (build, model, permission mode,
// loaded plugins), the result and the context windows, and the transcript path. It fails when the init
// frame names a different build, a different permission mode, or no `frizz` plugin.
//
// The environment is a worker's: `claudeWorkerEnv()` (so CLAUDE_CODE_FORK_SUBAGENT=0 and the lifted
// caps), plus FRIZZ_THREAD and FRIZZ_PERM_DIR, without which the worker plugin's PermissionRequest hook
// stays inert and the probe sees asks a real worker never does (2.1.317's email check reached the
// permission callback only with the hook off). Extra ENV=VALUE pairs are merged on top, e.g.
// CLAUDE_CODE_FORK_SUBAGENT=1 to see what a switch does.
//
// Run it twice per bump, from `main` and then from the bump worktree: the two runs give the old and
// new transcripts that `tools-diff.mjs` and `transcript-shape.mjs` compare, and two plugin lists to
// read side by side (2.1.317 added `cc-plugin-privacy`). The new transcripts are also what
// `log-format-conformance.test.ts` needs, once they have sat untouched for ten minutes.
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const root = fileURLToPath(new URL("../..", import.meta.url))
const source = (path) => import(pathToFileURL(join(root, path)).href)
const args = process.argv.slice(2)
const cwdAt = args.indexOf("--cwd")
const cwd = cwdAt >= 0 ? args[cwdAt + 1] : join(tmpdir(), "frizz-pin-probe")
const pairs = cwdAt >= 0 ? args.filter((_, i) => i !== cwdAt && i !== cwdAt + 1) : args
const extra = Object.fromEntries(pairs.filter((arg) => arg.includes("=")).map((pair) => {
  const at = pair.indexOf("=")
  return [pair.slice(0, at), pair.slice(at + 1)]
}))

const runtimes = await source("packages/server/src/runtimes.ts")
const { createClaudeQueryFactory } = await source("packages/server/src/backend/claude-agent-sdk.ts")
const { claudeWorkerEnv } = await source("packages/server/src/backend/types.ts")
const coordinates = runtimes.runtimeCoordinates("claude")
if (!coordinates) throw new Error("no claude coordinates for this platform")
const { bin } = await runtimes.provisionRuntime("claude", { root: runtimes.runtimesRoot(), coordinates })

mkdirSync(cwd, { recursive: true })
writeFileSync(join(cwd, "note.txt"), "42\n")
const env = {
  ...claudeWorkerEnv(),
  FRIZZ_THREAD: "pin-probe",
  FRIZZ_PERM_DIR: mkdtempSync(join(tmpdir(), "frizz-pin-probe-perm-")),
  ...extra,
}
console.log(JSON.stringify({ pin: runtimes.CLAUDE_CODE_VERSION, bin, cwd, extraEnv: extra }))

const transcriptOf = (sessionId) => {
  const projects = join(homedir(), ".claude", "projects")
  for (const dir of readdirSync(projects)) {
    const path = join(projects, dir, `${sessionId}.jsonl`)
    if (existsSync(path)) return path
  }
  return undefined
}

const factory = createClaudeQueryFactory({ enabled: true, executablePath: bin })
const runs = [
  { permissionMode: "bypassPermissions", model: "haiku" },
  { permissionMode: "acceptEdits", model: "sonnet" },
]
let failures = 0
for (const run of runs) {
  const sessionId = randomUUID()
  const handle = factory.start({
    cwd, session: { kind: "new", sessionId }, permissionMode: run.permissionMode, model: run.model,
    persistSession: true, pluginDir: join(root, "cc-worker"), settingSources: ["user", "project", "local"], env,
    canUseTool: async () => ({ behavior: "allow", updatedInput: undefined }),
  })
  // The CLI reports init only after input arrives on stream-json, so the first message goes BEFORE ready().
  await handle.send({ id: randomUUID(), text: "Run `cat note.txt` with the Bash tool, then use the Read tool on note.txt, then reply with one line: the number in the file." })
  const init = await handle.ready()
  const plugins = init.plugins.map((plugin) => plugin.name)
  console.log(JSON.stringify({ run, sessionId, init: { claudeCodeVersion: init.claudeCodeVersion, model: init.model, permissionMode: init.permissionMode, plugins } }))
  if (init.claudeCodeVersion !== runtimes.CLAUDE_CODE_VERSION) { failures++; console.log(`VERSION MISMATCH: init says ${init.claudeCodeVersion}`) }
  if (init.permissionMode !== run.permissionMode) { failures++; console.log(`PERMISSION MODE MISMATCH: init says ${init.permissionMode}`) }
  if (!plugins.includes("frizz")) { failures++; console.log("THE frizz PLUGIN DID NOT LOAD") }
  for await (const event of handle) {
    if (event.kind !== "result") continue
    console.log("result:", event.subtype, JSON.stringify(event.result), "windows:", JSON.stringify(event.modelContextWindows))
    if (event.isError) failures++
    break
  }
  await handle.close()
  console.log("transcript:", transcriptOf(sessionId) ?? "NOT FOUND")
}
console.log(failures === 0 ? "PROBE OK" : `PROBE FAILURES: ${failures}`)
process.exit(failures === 0 ? 0 : 1)
