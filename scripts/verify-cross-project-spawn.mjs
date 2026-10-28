// `frizzctl spawn-thread --project` (2026-10-28), driven through the real path: two projects on one Frizz,
// a scripted worker in the launching project (scripts/scripted-claude.mjs under the real broker daemon),
// and that worker's own `frizzctl` — the checkout's, run as a real Bash tool call in the daemon's
// environment — starting a thread on the OTHER project's board. The thread it starts is a scripted worker
// too, and it answers through the footer it was handed. Only the model is replaced.
//
// What it pins, in each worker's own transcript and on each project's own RPC:
//   1. The spawner's receipt names the other project, and its link and steer command say so.
//   2. The thread is on the OTHER project's board and not on the spawner's, and its worker runs in the
//      other project's checkout: its transcript is under that directory's Claude project folder.
//   3. Its prompt ends with the footer naming the spawner and the spawner's project, and the steer back it
//      runs from that footer lands in the spawner's thread, naming the other project.
//   4. Refusals: `--project` naming no project exits 1 and lists the projects, and starts no thread.
//
// Boot a two-project stack with the scripted worker, from a shell with no Frizz worker variables in it:
//   env -u FRIZZ_STATE_DIR -u FRIZZ_SERVER_LOCK -u FRIZZ_PROJECT_ID -u FRIZZ_NODE -u FRIZZ_THREAD \
//     -u FRIZZ_THREAD_SLUG -u FRIZZ_PERM_DIR -u FRIZZ_NATIVE_ASK -u NODE_COMPAT \
//     nub scripts/adhoc-stack.mjs --port=NNNN --project=/abs/repo-a --also-project=/abs/repo-b \
//     --claude-bin=/abs/path/to/scripts/scripted-claude.mjs > /abs/stack.log 2>&1
// then hand this the stack's json line (the first line of that log):
//   nub scripts/verify-cross-project-spawn.mjs --stack=/abs/stack.log
// The dispatched workers are DETACHED broker daemons: kill each by pid when done (this prints them).
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")))
if (!flags.stack) {
  console.error("usage: nub scripts/verify-cross-project-spawn.mjs --stack=/abs/stack.log")
  process.exit(1)
}
const line = readFileSync(flags.stack, "utf8").split("\n").find((l) => l.startsWith("{"))
if (!line) throw new Error(`no json line in ${flags.stack} — is the stack booted?`)
const stack = JSON.parse(line)
const launcher = { slug: stack.launcher.slug, dir: stack.project }
const tenant = stack.tenants[0]
if (!tenant?.slug) throw new Error("the stack has no second project — boot it with --also-project")

const base = `http://127.0.0.1:${stack.port}/`
const apiA = createRpcClient(base, launcher.slug)
const apiB = createRpcClient(base, tenant.slug)
await apiA.waitForHealth()

const run = Date.now().toString(36)
const A = `cross-spawner-${run}`
const scratch = join(stack.home, "cross-spawn")
mkdirSync(scratch, { recursive: true })

const turns = (file, list) => {
  writeFileSync(file, JSON.stringify({ think: 150, turns: list, otherwise: { name: "unscripted", text: "Nothing was scripted for that message." } }, null, 1))
  return file
}
// The child's whole life: read its prompt, answer through the footer it was given. The marker is how its
// transcript is found below without knowing its slug in advance.
const marker = `child-marker-${run}`
const fileChild = turns(join(scratch, `child-${run}.json`), [
  { name: "start", tools: [`frizzctl steer ${A} --project ${launcher.slug} --message 'Child reporting from the other board.'`], text: "Reported." },
])
const fileA = turns(join(scratch, `${A}.json`), [
  { name: "start", text: "Ready." },
  {
    name: "spawn",
    on: "go spawn",
    tools: [`frizzctl spawn-thread --project ${tenant.slug} --model opus --effort high --title 'Cross-project child' --prompt '[script file=${fileChild}] ${marker}'`],
    text: "Spawned.",
  },
  { name: "report", on: "<thread-message", text: "Got the report." },
  {
    name: "refusals",
    on: "try the refusals",
    tools: [`frizzctl spawn-thread --project no-such-project --model opus --effort high --prompt 'never runs'; echo "exit=$?"`],
    text: "Tried.",
  },
])

const claudeDir = (dir) => join(stack.home, ".claude", "projects", dir.replace(/[^a-zA-Z0-9]/g, "-"))
const jsonl = (dir, sessionId) => join(claudeDir(dir), `${sessionId}.jsonl`)
const records = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").flatMap((l) => { try { return l ? [JSON.parse(l)] : [] } catch { return [] } }) : [])
const userTexts = (path) => records(path).filter((r) => r.type === "user" && typeof r.message?.content === "string").map((r) => r.message.content)
const rests = (path) => records(path).filter((r) => r.type === "assistant" && r.message?.stop_reason === "end_turn").map((r) => r.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n"))
const toolResults = (path) => records(path).flatMap((r) => (r.type === "user" && Array.isArray(r.message?.content) ? r.message.content.filter((b) => b.type === "tool_result") : []))
  .map((b) => (typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => c.text ?? "").join("")))
/** Every transcript under a checkout's Claude project folder whose first prompt carries the marker. */
const transcriptsWith = (dir, text) => (existsSync(claudeDir(dir)) ? readdirSync(claudeDir(dir)) : [])
  .filter((f) => f.endsWith(".jsonl")).map((f) => join(claudeDir(dir), f)).filter((p) => userTexts(p)[0]?.includes(text))

async function until(what, probe, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}
const results = []
const check = (name, ok, detail = "") => {
  results.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`)
}

const a = await apiA.mutate("dispatch", { prompt: `[script file=${fileA}] spawner`, backend: "claude", slug: A, title: "Cross-project spawner" })
const pathA = jsonl(launcher.dir, a.sessionId)
await until("the spawner's first rest", () => rests(pathA).includes("Ready."))
await apiA.mutate("followUp", { slug: A, sessionId: a.sessionId, message: "go spawn" })

// 1. The spawner's receipt.
const receipt = await until("the spawner's receipt", () => toolResults(pathA).find((t) => t.includes("Spawned a new frizz thread") || t.includes("failed") || t.includes("Exit code")))
const child = /Spawned a new frizz thread `([^`]+)`/.exec(receipt)?.[1]
check("the receipt names the other project, its link and its steer command",
  !!child && receipt.includes(`on the \`${tenant.slug}\` project's board`) && receipt.includes(`(/project/${tenant.slug}/thread/${child})`) &&
  receipt.includes(`frizzctl steer ${child} --project ${tenant.slug}`), receipt.split("\n")[0])
if (!child) process.exit(1)

// 2. Where it landed.
const onB = await until("the child on the other project's board", async () => (await apiB.query("board"))?.threads?.find((t) => t.id === child))
const onA = (await apiA.query("board"))?.threads?.find((t) => t.id === child)
check("the thread is on the other project's board, not the spawner's", !!onB && !onA, `tenant: ${onB?.title ?? "missing"}; launcher: ${onA ? "PRESENT" : "absent"}`)
const childPath = await until("the child's transcript in the other checkout", () => transcriptsWith(tenant.dir, marker)[0])
check("its worker runs in the other project's checkout", childPath.startsWith(claudeDir(tenant.dir)) && transcriptsWith(launcher.dir, marker).length === 0, childPath)

// 3. The way back.
const prompt = userTexts(childPath)[0]
check("its prompt ends with the footer naming the spawner's project",
  prompt.includes(`Spawned by the Frizz thread \`${A}\`, on the \`${launcher.slug}\` project's board.`) &&
  prompt.includes(`\`frizzctl steer ${A} --project ${launcher.slug} --message-file <file|->\``), prompt.slice(prompt.indexOf("Spawned by")).split("\n")[0])
const back = await until("the child's report in the spawner's transcript", () => userTexts(pathA).find((t) => t.startsWith("<thread-message")))
check("the steer back from the footer reaches the spawner, naming the other project",
  back.includes(`from-thread="${child}"`) && back.includes(`from-project="${tenant.slug}"`) && back.includes("Child reporting from the other board."), back.split("\n")[0])
await until("the spawner's rest on the report", () => rests(pathA).includes("Got the report."))

// 4. Refusals.
const boardBefore = (await apiB.query("board"))?.threads?.length
await apiA.mutate("followUp", { slug: A, sessionId: a.sessionId, message: "try the refusals" })
await until("the refusals turn", () => rests(pathA).includes("Tried."))
const noProject = toolResults(pathA).at(-1)
check("--project naming no project exits 1 and lists the projects",
  /no project `no-such-project` on this machine/.test(noProject) && noProject.includes(`\`${tenant.slug}\``) && noProject.includes("exit=1"), noProject.split("\n")[0])
check("and starts no thread", (await apiB.query("board"))?.threads?.length === boardBefore && transcriptsWith(launcher.dir, "never runs").length === 0)

const childSession = /([0-9a-f-]{36})\.jsonl$/.exec(childPath)?.[1]
const daemons = execFileSync("ps", ["-Ao", "pid,command"], { encoding: "utf8" }).split("\n")
  .filter((l) => l.includes(a.sessionId) || (childSession && l.includes(childSession))).map((l) => l.trim().split(/\s+/)[0])
console.log(`\nworker processes to kill: ${daemons.join(" ") || "(none found by session id)"}`)
const failed = results.filter((r) => !r.ok).length
console.log(`${results.length - failed}/${results.length} passed`)
process.exit(failed ? 1 : 0)
