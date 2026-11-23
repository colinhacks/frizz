// Restart gate for the ```question fence, in two phases around a server restart — the registrar re-reads
// every transcript from byte 0 on boot, and nothing it finds there may be judged twice:
//
//   --phase=seed    (stack up)  a simulated worker asks four questions over three messages; one is
//                   answered, one withdrawn (`unask`), one is a SECRET answered through the card's RPC, and
//                   one stays open with a follow-up attached by a LATER message. The answered id is then
//                   asked again (refused), and the open one referenced. Prints the rows as they stand.
//   — kill the stack, write one more fence while it is DOWN, boot it again on the same --home —
//   --phase=check   (stack up)  every row is byte-identical to the seed's (asked_at, state, answer, spec);
//                   the fence written during the downtime registered at ITS OWN instant; the secret's value
//                   is in no SQLite file, no transcript and no log; its pipe from the dead process is gone.
//
// Also the Claude transcript shapes the fold has to survive, each written the way Claude Code writes it: one
// API message as several records (text, then tool_use), the same record twice, a sidechain record, an API
// error record, a record with no timestamp, and a last line cut off mid-write.
//
//   nub scripts/adhoc-stack.mjs --port=NNNN --keep            # note its "home"
//   nub scripts/verify-question-fence-restart.mjs --home=… --port=NNNN --phase=seed
//   kill <stack pid> ; nub scripts/verify-question-fence-restart.mjs --home=… --port=NNNN --phase=down
//   nub scripts/adhoc-stack.mjs --port=NNNN --home=…
//   nub scripts/verify-question-fence-restart.mjs --home=… --port=NNNN --phase=check --log=/abs/stack.log
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")))
const { home, port, phase, log, run = "1", cwd = process.cwd() } = flags
if (!home || !port || !["seed", "down", "check"].includes(phase)) {
  console.error("usage: nub scripts/verify-question-fence-restart.mjs --home=/abs/temp-home --port=NNNN --phase=seed|down|check [--log=/abs/stack.log]")
  process.exit(1)
}

const db = join(home, ".frizz", "ui.db")
if (!existsSync(db)) throw new Error(`no ui.db at ${db} — is the stack booted?`)
const registry = JSON.parse(readFileSync(join(home, ".frizz", "registry.json"), "utf8"))
const projectId = registry.projects.find((p) => p.path === cwd)?.id
if (!projectId) throw new Error(`${cwd} is not registered in ${home}/.frizz/registry.json`)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })
const snapshot = join(home, `qf-restart-snapshot-${run}.json`)
const SECRET = "otp-918273-NEVER-ON-DISK"
// `--run=N` gives a second attempt on the same home its own thread, rather than rewriting a transcript
// the tailer has already folded.
const SLUG = run === "1" ? "qf-restart" : `qf-restart-${run}`
const SESSION = `9f0e1a00-0000-4000-9000-${String(run).padStart(10, "0")}e5`
const path = join(jsonlDir, `${SESSION}.jsonl`)

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sql = (q) => execFileSync("sqlite3", ["-json", db, q]).toString().trim()
const rowsNow = () => JSON.parse(sql(`SELECT id, handle, state, asked_at, settled_at, answer, spec FROM thread_question WHERE thread_slug = '${SLUG}' ORDER BY asked_at, rowid`) || "[]")
async function until(what, probe, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const got = await probe()
    if (got) return got
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

let n = Number(existsSync(path) ? readFileSync(path, "utf8").split("\n").length : 0)
const uuid = () => `${SESSION.slice(0, 24)}${String(++n).padStart(12, "0")}`
const base = (type, at, extra = {}) => ({ parentUuid: null, isSidechain: false, type, uuid: uuid(), ...(at ? { timestamp: at } : {}), session_id: SESSION, cwd, ...extra })
const write = (rec) => appendFileSync(path, JSON.stringify(rec) + "\n")
const assistant = (at, content, { id = `msg_${n}`, stop = "end_turn", extra = {} } = {}) => ({
  ...base("assistant", at, extra),
  message: { model: "claude-opus-5", id, type: "message", role: "assistant", stop_reason: stop, content, usage: { input_tokens: 38_000, output_tokens: 280 } },
})
const text = (t) => [{ type: "text", text: t }]
const fence = (...lines) => ["```question", ...lines, "```"].join("\n")
const choice = (id, question) => fence(`id: ${id}`, "kind: choice", `question: ${question}`, "options:", "  - label: SQLite", "    recommended: true", "  - label: JSON file")

if (phase === "seed") {
  const api = createRpcClient(`http://127.0.0.1:${port}/`)
  if (!(await api.waitForHealth())) throw new Error("the stack never answered /health")
  const threadOf = async () => (await api.query("board")).threads.find((t) => t.id === SLUG)
  const now = Date.now()
  const ago = (s) => new Date(now - s * 1000).toISOString()
  writeFileSync(path, "")
  execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode)
     VALUES ('${projectId}', '${SLUG}', '${SESSION}', 'frizz-${SLUG}', '${ago(600)}', 'Restart gate', 'claude', 'opus', 'high', 'default')`])
  write({ ...base("user", ago(590)), message: { role: "user", content: "move the settings into a real store" } })

  // ONE API MESSAGE, SEVERAL RECORDS: a thinking block, the text with two fences, then the tool call —
  // all one message id, each its own line, as Claude Code writes them.
  const asked = `Before I go on:\n\n${choice("to-answer", "Which store?")}\n\n${choice("to-withdraw", "Which cache?")}`
  write(assistant(ago(580), [{ type: "thinking", thinking: choice("thought-only", "Never asked?") }], { id: "msg_a", stop: null }))
  const textRecord = assistant(ago(580), text(asked), { id: "msg_a", stop: null })
  write(textRecord)
  write(assistant(ago(579), [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: `cat <<'X'\n${choice("in-tool-input", "Never asked?")}\nX` } }], { id: "msg_a", stop: "tool_use" }))
  write({ ...base("user", ago(578)), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_1", content: choice("in-tool-result", "Never asked?") }] } })
  // The same text record AGAIN (same uuid, same timestamp), a child's record, and an API error's.
  write(textRecord)
  write(assistant(ago(577), text(choice("from-a-child", "Never asked?")), { extra: { isSidechain: true } }))
  write(assistant(ago(576), text(choice("from-an-api-error", "Never asked?")), { extra: { isApiErrorMessage: true } }))
  write(assistant(undefined, text(choice("no-timestamp", "Never asked?"))))
  // A secret and a question that stays open, in a second message at rest.
  write(assistant(ago(570), text(`Two more:\n\n${fence("id: npm-otp", "kind: secret", "question: The npm one-time code for the publish")}\n\n${choice("stays-open", "Which log format?")}`)))
  const first = await until("the four questions", async () => {
    const t = await threadOf()
    return t?.questions?.length === 4 ? t : undefined
  })
  check("one message written as several records registers its two fences once each", first.questions.filter((q) => ["to-answer", "to-withdraw"].includes(q.spec.handle)).length === 2)
  check("nothing registered from thinking, a tool's input or result, a child, an API error or an undated record", first.questions.every((q) => ["to-answer", "to-withdraw", "npm-otp", "stays-open"].includes(q.spec.handle)), first.questions.map((q) => q.spec.handle).join(", "))
  // The WORKER's own read-back (what `frizzctl activity` is built from) — the board's copy of a question
  // carries no pipe path, since the card has no use for one.
  const own = (await api.mutate("listOwnThreadActivity", { slug: SLUG })).questions
  const by = Object.fromEntries(own.map((q) => [q.handle, q]))
  check("the worker's read-back names each question by the worker's own id", own.map((q) => q.handle).sort().join(",") === "npm-otp,stays-open,to-answer,to-withdraw", own.map((q) => q.handle).join(", "))
  check("the fences are asked at their record's own timestamp", by["to-answer"].askedAt === ago(580) && by["stays-open"].askedAt === ago(570))
  check("the secret registers as a secret and names its pipe", by["npm-otp"].spec.secret === true && by["npm-otp"].secretPath === join(home, ".frizz", "projects", projectId, "secrets", SLUG, by["npm-otp"].id), by["npm-otp"].secretPath)

  // Settle three of them, each through the RPC that really does it.
  await api.mutate("answerQuestions", { slug: SLUG, answers: [{ questionId: by["to-answer"].id, question: by["to-answer"].spec.question, chosen: ["SQLite"] }] })
  const unasked = await api.mutate("unask", { slug: SLUG, id: "to-withdraw" })
  check("`unask to-withdraw` withdraws it and names it back", unasked.withdrawn === true && unasked.id === "to-withdraw")
  const secretAnswer = await api.mutate("answerQuestions", { slug: SLUG, answers: [{ questionId: by["npm-otp"].id, question: by["npm-otp"].spec.question, chosen: [], text: SECRET }] })
  check("the secret is answered through the card's RPC", secretAnswer.answered.includes(by["npm-otp"].id))
  const stored = JSON.parse(rowsNow().find((r) => r.handle === "npm-otp").answer)
  check("its stored answer is the pipe's path, not the value", stored.text.includes(by["npm-otp"].secretPath) && !stored.text.includes(SECRET), stored.text)
  check("the pipe exists and is a FIFO", execFileSync("stat", ["-f", "%HT", by["npm-otp"].secretPath]).toString().trim() === "Fifo File")
  const read = execFileSync("cat", [by["npm-otp"].secretPath]).toString()
  check("one read of the pipe yields the value", read === SECRET, JSON.stringify(read.length))
  await sleep(400)
  check("…and the pipe is gone after that read", !existsSync(by["npm-otp"].secretPath))

  // The human speaks; the worker re-asks the answered id (refused), references the open one, and hangs a
  // follow-up off it in a message of its own.
  write({ ...base("user", ago(60)), message: { role: "user", content: "carry on" } })
  write(assistant(ago(50), text(`Asking again:\n\n${choice("to-answer", "Which store?")}\n\nStill waiting on:\n\n${fence("id: stays-open")}`)))
  write(assistant(ago(40), text(fence("id: log-rotation", "kind: text", "when: stays-open = JSON file", "question: How many rotated files should be kept?"))))
  await until("the late follow-up under stays-open", async () => (await threadOf())?.questions?.find((q) => q.spec.handle === "stays-open")?.spec.options?.[1].followUps?.length === 1)
  const done = await api.mutate("markOwnDone", { slug: SLUG, body: "- Done." })
  check("`done` is refused on the one open question, by the worker's id", done.done === false && done.blockingQuestions.length === 1 && done.blockingQuestions[0].id === "stays-open", JSON.stringify(done.blockingQuestions))
  const rows = rowsNow()
  check("four rows, and only four", rows.length === 4, rows.map((r) => `${r.handle}:${r.state}`).join(", "))
  writeFileSync(snapshot, JSON.stringify(rows))
  console.log(`      snapshot of ${rows.length} rows written; now kill the stack, run --phase=down, and boot it again on --home=${home}`)
}

if (phase === "down") {
  // WRITTEN WHILE NO SERVER IS RUNNING — a worker is a detached daemon and keeps going through a restart.
  const at = new Date().toISOString()
  write(assistant(at, text(`While you were away:\n\n${choice("asked-while-down", "Which retention window?")}`)))
  // …and a LAST LINE CUT OFF MID-WRITE: half a record, no newline.
  appendFileSync(path, JSON.stringify(assistant(new Date(Date.now() + 1000).toISOString(), text(choice("half-written", "Never asked?")))).slice(0, 180))
  writeFileSync(join(home, `qf-restart-down-${run}.json`), JSON.stringify({ at }))
  console.log(`      wrote one fence at ${at} and a half-written record, with the stack down`)
}

if (phase === "check") {
  const api = createRpcClient(`http://127.0.0.1:${port}/`)
  if (!(await api.waitForHealth())) throw new Error("the stack never answered /health")
  const before = JSON.parse(readFileSync(snapshot, "utf8"))
  const { at: downAt } = JSON.parse(readFileSync(join(home, `qf-restart-down-${run}.json`), "utf8"))
  await until("the fence written during the downtime", async () => rowsNow().some((r) => r.handle === "asked-while-down"))
  await sleep(3000) // several tailer polls: anything a replay was going to do wrongly, it has done by now
  const after = rowsNow()
  const carried = after.filter((r) => r.handle !== "asked-while-down")
  check("every row from before the restart is byte-identical after it", JSON.stringify(carried) === JSON.stringify(before), carried.map((r) => `${r.handle}:${r.state}@${r.asked_at}`).join(", "))
  check("no row was minted twice", new Set(after.map((r) => r.handle)).size === after.length && after.length === before.length + 1, `${after.length} rows`)
  const down = after.find((r) => r.handle === "asked-while-down")
  check("the fence written while the server was down registered, at its own instant", down?.state === "open" && down.asked_at === Date.parse(downAt), `${down?.asked_at} vs ${Date.parse(downAt)}`)
  check("the half-written last line registered nothing", !after.some((r) => r.handle === "half-written"))
  const board = (await api.query("board")).threads.find((t) => t.id === SLUG)
  check("the board shows the two open questions, the follow-up still under its option", board.questions.length === 2 && board.questions.find((q) => q.spec.handle === "stays-open")?.spec.options?.[1].followUps?.[0].handle === "log-rotation", board.questions.map((q) => q.spec.handle).join(", "))
  // THE SECRET, everywhere a byte could have landed.
  const holds = (file) => readFileSync(file).includes(Buffer.from(SECRET))
  const frizzDir = join(home, ".frizz")
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.isFile() ? [join(dir, e.name)] : []))
  const leaked = [...walk(frizzDir), ...walk(jsonlDir), ...(log ? [log] : [])].filter(holds)
  check("the secret's value is in no database, state file, transcript or log", leaked.length === 0, leaked.join(", "))
  check("the secrets directory holds no pipe from the process that died", !existsSync(join(frizzDir, "projects", projectId, "secrets", SLUG)) || readdirSync(join(frizzDir, "projects", projectId, "secrets", SLUG)).length === 0)
}

if (phase !== "down") console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
