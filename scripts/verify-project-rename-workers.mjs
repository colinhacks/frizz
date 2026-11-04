// A project's FOLDER renamed through Frizz (`projectRename` with `renameDirectory`) while REAL Claude
// workers run in it, one of them the worker that asked for the rename, in the middle of its own turn.
//
// Claude Code holds its working directory as a path: on 2026-11-04 (Claude Code 2.1.316) every Bash call
// after such a rename failed with `Working directory "…" no longer exists`, and the scratch hook then
// recreated the old folder as an empty stub under the stale CLAUDE_PROJECT_DIR. project-relocation.ts
// leaves a link at the old path, retires each daemon from before the rename at its next rest, and takes
// the link down once none is left. Only a live `claude` shows any of this — the failure is Claude Code's
// own check — so this needs a real worker, and so a real HOME (see frizz-stack § A real Claude worker).
//
// What it pins, from each worker's own transcript and the folders on disk:
//   1. The caller's Bash calls after the rename, in the same turn, run: no "no longer exists", and the
//      file it writes lands in the renamed folder.
//   2. A resting worker from before the rename, and the caller once it rests, are both retired, and
//      the link and the relocation record come down — with no stub of the old folder left behind.
//   3. Each worker's next message cold-resumes in the new folder: `pwd` answers the new path, the
//      transcript keeps growing in Claude Code's original project bucket, and no crash is reported.
//
// Boot a two-project stack on the REAL home with throwaway folders (the renamed project cannot be the
// launching one), from a shell with no Frizz worker variables in it:
//   mkdir -p ~/Documents/scratch/rename-e2e/{launcher,alpha}
//   env -u FRIZZ_STATE_DIR -u FRIZZ_SERVER_LOCK -u FRIZZ_PROJECT_ID -u FRIZZ_NODE -u FRIZZ_THREAD \
//     -u FRIZZ_THREAD_SLUG -u FRIZZ_PERM_DIR -u FRIZZ_NATIVE_ASK -u NODE_COMPAT FRIZZ_DEBUG=1 \
//     nub scripts/adhoc-stack.mjs --port=NNNN --home=$HOME --project=$HOME/Documents/scratch/rename-e2e/launcher \
//     --also-project=$HOME/Documents/scratch/rename-e2e/alpha > /abs/stack.log 2>&1
// then: nub scripts/verify-project-rename-workers.mjs --stack=/abs/stack.log
// It refuses a stack whose Frizz root is "shared", because it writes Settings (bypass permissions).
// Afterwards kill the stack by pid, then each broker daemon this prints, and remove the folders and the
// `~/.claude/projects/` bucket it names.
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { execFileSync } from "node:child_process"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")))
if (!flags.stack) {
  console.error("usage: nub scripts/verify-project-rename-workers.mjs --stack=/abs/stack.log [--model=haiku]")
  process.exit(1)
}
const line = readFileSync(flags.stack, "utf8").split("\n").find((l) => l.startsWith("{"))
if (!line) throw new Error(`no json line in ${flags.stack} — is the stack booted?`)
const stack = JSON.parse(line)
if (stack.frizzRoot !== "isolated") throw new Error(`the stack's Frizz root is ${JSON.stringify(stack.frizzRoot)}; this writes Settings, so it needs an isolated one`)
const tenant = stack.tenants?.[0]
if (!tenant?.id) throw new Error("the stack has no second project — boot it with --also-project")
const model = flags.model ?? "haiku"

const base = `http://127.0.0.1:${stack.port}/`
const api = createRpcClient(base, tenant.id)
await api.waitForHealth()
const settings = await api.query("settingsGet")
await api.mutate("settingsSet", { ...settings, permissionMode: "bypassPermissions" })

const from = realpathSync(tenant.dir)
const newName = `${basename(from)}-renamed`
const to = join(dirname(from), newName)
if (existsSync(to)) throw new Error(`${to} already exists — remove it first`)
const stateDir = tenant.stateDir

// Claude Code's bucket is named after the directory the session STARTED in, and it stays there.
const bucket = join(stack.home, ".claude", "projects", from.replace(/[^a-zA-Z0-9]/g, "-"))
const jsonl = (sessionId) => join(bucket, `${sessionId}.jsonl`)
const records = (path) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").flatMap((l) => { try { return l ? [JSON.parse(l)] : [] } catch { return [] } }) : [])
const results = (path) => records(path).flatMap((r) => (r.type === "user" && Array.isArray(r.message?.content) ? r.message.content.filter((b) => b.type === "tool_result") : []))
  .map((b) => ({ error: b.is_error === true, text: typeof b.content === "string" ? b.content : (b.content ?? []).map((c) => c.text ?? "").join("") }))
const ended = (path) => records(path).filter((r) => r.type === "assistant" && r.message?.stop_reason === "end_turn").length
const lexists = (path) => { try { lstatSync(path); return true } catch { return false } }
const isLink = (path) => { try { return lstatSync(path).isSymbolicLink() } catch { return false } }
const brokerSessions = () => {
  try {
    return execFileSync("ls", [join(stateDir, "claude-broker")]).toString().split("\n").filter((n) => n.endsWith(".json"))
      .flatMap((n) => { try { const r = JSON.parse(readFileSync(join(stateDir, "claude-broker", n), "utf8")); process.kill(r.daemonPid, 0); return [r] } catch { return [] } })
  } catch { return [] }
}

async function until(what, probe, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await probe()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}
const outcomes = []
const check = (name, ok, detail = "") => {
  outcomes.push({ name, ok })
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `\n      ${detail}` : ""}`)
}
const pids = new Set()
const notePids = () => { for (const r of brokerSessions()) pids.add(r.daemonPid) }

const verbatim = (command) => `Run exactly this Bash command and report its output verbatim: ${command}`
const rename = `curl -s -X POST -H 'content-type: application/json' -H 'origin: http://127.0.0.1:${stack.port}' 'http://127.0.0.1:${stack.port}/_frizz/${tenant.id}/rpc/projectRename' -d '{"id":"${tenant.id}","name":"${newName}","renameDirectory":true}'`

// A worker that rests in the folder before the rename, and is retired while it rests.
const resting = await api.mutate("dispatch", { prompt: verbatim("pwd"), backend: "claude", model, title: "Resting through a rename" })
await until("the resting worker's first rest", () => ended(jsonl(resting.sessionId)) >= 1)
notePids()

// The worker that asks for the rename, and keeps working in the same turn.
const callerPrompt = [
  "Run each of these commands as its own separate Bash tool call, one at a time, in this order, and then report each output verbatim:",
  `1. ${rename}`,
  "2. pwd; ls -d ../*",
  "3. echo after-rename > after-rename.txt && cat after-rename.txt",
  "Do not combine them, do not skip any, and do not run anything else.",
].join("\n")
const caller = await api.mutate("dispatch", { prompt: callerPrompt, backend: "claude", model, title: "Rename the folder from inside it" })
await until("the caller's rename", () => existsSync(to), 240_000)
notePids()
check("the rename left a link at the old path while workers from before it run", isLink(from) && realpathSync(from) === to)
await until("the caller's rest", () => ended(jsonl(caller.sessionId)) >= 1, 240_000)

// 1. The caller's own turn, after the rename.
const callerResults = results(jsonl(caller.sessionId))
const broken = callerResults.filter((r) => /no longer exists/.test(r.text))
check("the caller's Bash calls after the rename all ran", callerResults.length >= 3 && broken.length === 0 && callerResults.every((r) => !r.error),
  callerResults.map((r) => `${r.error ? "ERR " : ""}${r.text.replace(/\s+/g, " ").slice(0, 120)}`).join("\n      "))
check("the file it wrote after the rename is in the renamed folder", existsSync(join(to, "after-rename.txt")))

// 2. Both are retired at rest, and the link comes down.
const sessions = [resting.sessionId, caller.sessionId]
await until("both daemons retired", () => !brokerSessions().some((r) => sessions.includes(r.sessionId)), 120_000)
check("both workers from before the rename were retired at rest", true)
await until("the link to come down", () => !isLink(from) && !existsSync(join(stateDir, "relocation.json")), 60_000)
check("the link and the relocation record are gone, and nothing stands at the old path", !lexists(from))

// 3. Each resumes in the new folder.
for (const [name, thread] of [["resting", resting], ["caller", caller]]) {
  const before = records(jsonl(thread.sessionId)).length
  const endedBefore = ended(jsonl(thread.sessionId))
  await api.mutate("followUp", { slug: thread.slug, sessionId: thread.sessionId, message: verbatim("pwd") })
  await until(`the ${name} worker's next rest`, () => ended(jsonl(thread.sessionId)) > endedBefore, 240_000)
  notePids()
  const after = records(jsonl(thread.sessionId)).slice(before)
  const pwd = results(jsonl(thread.sessionId)).at(-1)
  check(`the ${name} worker resumed in the new folder and kept its transcript`,
    after.length > 0 && pwd?.error === false && pwd.text.trim() === to && after.some((r) => r.cwd === to),
    `pwd → ${pwd?.text.trim()}; cwd on new records: ${[...new Set(after.map((r) => r.cwd).filter(Boolean))].join(", ")}`)
}
check("still nothing at the old path after the resumed turns and their hooks", !lexists(from))
const scratchState = sessions.map((s) => join(to, ".frizz", "threads", s, ".scratchpad-state.json"))
check("the hooks' state went to the renamed folder", scratchState.some((p) => existsSync(p)), scratchState.join(", "))
// With FRIZZ_DEBUG=1 the server's log is mirrored into the stack log, where a broker death it could
// not explain is a `claude broker <slug>: …` warning — the line a retirement must never produce.
const log = readFileSync(flags.stack, "utf8")
const deaths = log.split("\n").filter((l) => l.includes(`claude broker ${resting.slug}:`) || l.includes(`claude broker ${caller.slug}:`))
const relocated = log.split("\n").filter((l) => l.includes("relocate:"))
check("no death was reported for a retired worker", relocated.length > 0 && deaths.length === 0,
  [...relocated, ...deaths].map((l) => l.slice(0, 200)).join("\n      ") || "(FRIZZ_DEBUG=1 was not set on the stack: no server log to read)")

console.log(`\nbroker daemons started: ${[...pids].join(" ") || "none"}`)
console.log(`Claude Code bucket: ${bucket}`)
const failed = outcomes.filter((o) => !o.ok)
console.log(failed.length ? `\n${failed.length} FAILED` : `\nall ${outcomes.length} passed`)
process.exit(failed.length ? 1 : 0)
