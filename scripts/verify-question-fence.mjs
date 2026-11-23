// End-to-end gate for the ```question fence (2026-10-13): a worker asks by writing the fence in its own
// message, and the server registers it from the transcript. This drives that seam on a REAL disposable
// stack — a simulated worker's JSONL, read by the real tailer, registered by the real registrar, projected
// by the real board, settled through the real RPCs the worker's `frizzctl` and the human's card call.
//
// What it pins, each against the running server rather than a unit's stand-in:
//   1. A fence in an assistant message registers ONE question: the worker's id as its handle, asked at the
//      record's own timestamp, the `when:` follow-up attached under its parent option, the body below
//      `---` kept as context — and the thread queues. The latency from append to board is printed.
//   2. A fence quoted inside an outer code block registers nothing (the protocol stays quotable).
//   3. `done` in the same breath as a new fence is refused and names that fence's id — the gate catches
//      the registrar up rather than judging a transcript a second stale.
//   4. `unask` takes the worker's own id; the card's `answerQuestions` settles the row by its `qst_…`.
//   5. A settled id asked again registers a NEW question, and the answered one under it keeps its answer.
//   6. A thread dispatched before 2026-09-11 keeps the legacy grammar: the same fence registers nothing.
//   7. A follow-up whose `when:` named the wrong label is refused without taking its parent down, and the
//      corrected follow-up — written ALONE in a later message — attaches under the open parent's option,
//      on the same card, with the parent's own instant unmoved.
//   8. The openers a markdown reader takes for the same block register too: a `~~~question` fence (its
//      context holding a ```sql block) and a capitalised ```Question, each asked at the record's own
//      instant. The same forms QUOTED — inside a fence of the other character, in a blockquote — register
//      nothing. A reference written in either form makes its question stand again after the human has typed
//      past it; a malformed tilde fence is on the board as a refused fence, by name; and on a legacy thread
//      neither form registers anything.
//   9. A bare option label that opens on `Word:` (`- Yes: merge it`) is refused with ONE fault per line,
//      each giving the line to write — and that line, written, registers.
//
// It leaves `qf-shot` with one open question placed mid-handoff, for a screenshot of the card in its slot,
// and `qf-openers-shot` with a tilde question, a capitalised one and their quoted samples in its newest message.
//
// Boot a stack first (see .agents/skills/frizz-stack), then:
//   nub scripts/verify-question-fence.mjs --home=/abs/temp-home --port=NNNN
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import { createRpcClient } from "./lib/rpc-client.mjs"

const flags = Object.fromEntries(
  process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.replace(/^--/, "").split("=")),
)
const { home, port, cwd = process.cwd() } = flags
if (!home || !port) {
  console.error("usage: nub scripts/verify-question-fence.mjs --home=/abs/temp-home --port=NNNN")
  process.exit(1)
}

const db = join(home, ".frizz", "ui.db")
if (!existsSync(db)) throw new Error(`no ui.db at ${db} — is the stack booted?`)
const registry = JSON.parse(readFileSync(join(home, ".frizz", "registry.json"), "utf8"))
const projectId = registry.projects.find((p) => p.path === cwd)?.id
if (!projectId) throw new Error(`${cwd} is not registered in ${home}/.frizz/registry.json`)
const jsonlDir = join(home, ".claude", "projects", cwd.replace(/[/.]/g, "-"))
mkdirSync(jsonlDir, { recursive: true })

const api = createRpcClient(`http://127.0.0.1:${port}/`)
if (!(await api.waitForHealth())) throw new Error("the stack never answered /health")

let failures = 0
const check = (label, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`)
  if (!ok) failures++
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const threadOf = async (slug) => (await api.query("board")).threads.find((t) => t.id === slug)
async function until(what, probe, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const got = await probe()
    if (got) return got
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(100)
  }
}

// ---- the simulated worker ---------------------------------------------------------------------------

function worker({ slug, sessionId, spawnedAt, title }) {
  let n = 0
  const uuid = () => `${sessionId.slice(0, 24)}${String(++n).padStart(12, "0")}`
  const path = join(jsonlDir, `${sessionId}.jsonl`)
  const base = (type, at) => ({ parentUuid: null, isSidechain: false, type, uuid: uuid(), timestamp: at, session_id: sessionId, cwd })
  const write = (rec) => appendFileSync(path, JSON.stringify(rec) + "\n")
  writeFileSync(path, "")
  execFileSync("sqlite3", [
    db,
    `INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, backend, model, effort, permission_mode)
     VALUES ('${projectId}', '${slug}', '${sessionId}', 'frizz-${slug}', '${spawnedAt}', '${title}', 'claude', 'opus', 'high', 'default')`,
  ])
  return {
    slug,
    user(text, at = new Date().toISOString()) {
      write({ ...base("user", at), message: { role: "user", content: text } })
      return at
    },
    /** One assistant message at rest. Returns the record's timestamp — the instant a question is asked at. */
    say(text, at = new Date().toISOString()) {
      write({
        ...base("assistant", at),
        message: {
          model: "claude-opus-5", id: `msg_${n}`, type: "message", role: "assistant", stop_reason: "end_turn",
          content: [{ type: "text", text }], usage: { input_tokens: 38_000, output_tokens: 280 },
        },
      })
      return at
    },
  }
}

const SETTINGS_FENCE = [
  "```question",
  "id: settings-store",
  "kind: choice",
  "header: Settings store",
  "question: Should the settings store use SQLite or a JSON file?",
  "options:",
  "  - label: SQLite",
  "    description: transactional, and one store to back up",
  "    recommended: true",
  "  - label: JSON file",
  "    description: no dependency, hand-editable",
  "---",
  "Settings are read on every request and written by the server and by every worker's `frizzctl` calls.",
  "",
  "| Store | Survives a crash mid-write | Concurrent writers |",
  "|---|---|---|",
  "| SQLite | yes | safe |",
  "| JSON file | no | last write wins |",
  "```",
].join("\n")
const FOLLOW_UP_FENCE = [
  "```question",
  "id: sqlite-path",
  "kind: choice",
  "when: settings-store = SQLite",
  "question: Where should the database file live?",
  "options:",
  "  - label: Beside the sessions database",
  "  - label: In the project's `.frizz/`",
  "```",
].join("\n")
const QUOTED_SAMPLE = ["````md", "```question", "id: quoted-sample", "kind: text", "question: Only an example of the grammar", "```", "````"].join("\n")
const ASKING_HANDOFF = [
  "**Needs you** — the settings layer is written against an interface; the store behind it is the open call.",
  "",
  "The two candidates differ on what happens when two writers land at once:",
  "",
  SETTINGS_FENCE,
  "",
  FOLLOW_UP_FENCE,
  "",
  "For reference, the grammar a worker writes looks like this — quoted, so it is not a question:",
  "",
  QUOTED_SAMPLE,
  "",
  "Everything that does not depend on the answer is committed on `main`.",
].join("\n")

const now = Date.now()
const minutesAgo = (m) => new Date(now - m * 60_000).toISOString()

// ---- 1, 2: a fence registers; a quoted one does not ------------------------------------------------

const live = worker({ slug: "qf-live", sessionId: "9f0e1a00-0000-4000-9000-0000000000a1", spawnedAt: minutesAgo(10), title: "Settings store" })
live.user("move the settings into a real store", minutesAgo(10))
live.say("Reading the settings layer.", minutesAgo(9))
await until("qf-live on the board", () => threadOf("qf-live"))

const t0 = Date.now()
const askedAt = live.say(ASKING_HANDOFF)
const asked = await until("the settings-store question on the board", async () => {
  const t = await threadOf("qf-live")
  return t?.questions?.find((q) => q.spec.handle === "settings-store") ? t : undefined
})
console.log(`      registered ${Date.now() - t0}ms after the append`)
const q = asked.questions.find((x) => x.spec.handle === "settings-store")
check("one question registered for the two fences (the follow-up rides its parent)", asked.questions.length === 1, `${asked.questions.length} open`)
check("its id is a minted qst_… and its handle the worker's id", /^qst_/.test(q.id) && q.spec.handle === "settings-store", q.id)
check("asked at the record's own timestamp", q.askedAt === askedAt, `${q.askedAt} vs ${askedAt}`)
check("a choice with two options, SQLite recommended", q.spec.kind === "question" && q.spec.options?.length === 2 && q.spec.options[0].recommended === true)
const follow = q.spec.options?.find((o) => o.label === "SQLite")?.followUps?.[0]
check("the `when:` follow-up hangs under SQLite with its own handle", follow?.handle === "sqlite-path" && follow?.question === "Where should the database file live?")
check("the body below `---` is the question's context, table included", q.spec.context?.includes("| JSON file | no | last write wins |") === true)
check("an untaught `header:` is still accepted rather than faulted", q.spec.header === "Settings store")
check("the thread queues on it", asked.needsYou === true)
check("the quoted sample registered nothing", !asked.questions.some((x) => x.spec.handle === "quoted-sample"))

// ---- 3: `done` in the same breath as a new fence ----------------------------------------------------

live.user("also: which npm scope?")
live.say(["One more input before the publish step can be written.", "", "```question", "id: npm-scope", "kind: text", "question: What npm scope should the new packages publish under?", "```"].join("\n"))
const refusal = await api.mutate("markOwnDone", { slug: "qf-live", body: "- Moved the settings into a store." })
check("`done` written with the fence is refused", refusal.done === false)
check("…naming the new fence by the worker's id", refusal.blockingQuestions.some((b) => b.id === "npm-scope"), refusal.blockingQuestions.map((b) => b.id).join(", "))
check("…and the older one too", refusal.blockingQuestions.some((b) => b.id === "settings-store"))

// ---- 4: unask by the worker's id; answer by the card's ------------------------------------------------

const unasked = await api.mutate("unask", { slug: "qf-live", id: "npm-scope" })
check("`unask npm-scope` withdraws it", unasked.withdrawn === true && !unasked.open.some((o) => o.handle === "npm-scope"))
const answered = await api.mutate("answerQuestions", {
  slug: "qf-live",
  answers: [{ questionId: q.id, question: q.spec.question, chosen: ["JSON file"] }],
})
check("the card's answer settles the row", answered.answered.includes(q.id) && answered.open.length === 0)
const afterAnswer = await until("the board to drop the answered card", async () => {
  const t = await threadOf("qf-live")
  return t && t.questions.length === 0 ? t : undefined
})
check("no open question left on the board", afterAnswer.questions.length === 0)

// ---- 5: a settled id is free again ---------------------------------------------------------------------

live.user("thanks")
const reaskedAt = live.say(["Switching to the JSON file.", "", "```question", "id: settings-store", "kind: text", "question: Which directory should the JSON file live in?", "```"].join("\n"))
const reuse = await until("the re-asked settings-store on the board", async () => {
  const t = await threadOf("qf-live")
  return t?.questions?.length === 1 ? t : undefined
})
const reasked = reuse.questions[0]
check("asking a settled id again registers a NEW question", reasked.id !== q.id && reasked.spec.handle === "settings-store" && reasked.spec.question === "Which directory should the JSON file live in?", reasked.id)
check("…asked at its own message's instant", reasked.askedAt === reaskedAt, `${reasked.askedAt} vs ${reaskedAt}`)
const rows = execFileSync("sqlite3", [db, `SELECT state FROM thread_question WHERE thread_slug = 'qf-live' AND handle = 'settings-store' ORDER BY asked_at`]).toString().trim()
check("…beside the answered one, which keeps its answer", rows === "answered\nopen", rows.replace(/\n/g, ", "))

// ---- 6: a legacy thread keeps its grammar -------------------------------------------------------------

const legacy = worker({ slug: "qf-legacy", sessionId: "9f0e1a00-0000-4000-9000-0000000000b2", spawnedAt: "2026-09-01T12:00:00.000Z", title: "Legacy thread" })
legacy.user("same task, older contract", minutesAgo(8))
legacy.say(ASKING_HANDOFF)
await until("qf-legacy on the board", () => threadOf("qf-legacy"))
await sleep(2500)
const legacyRows = execFileSync("sqlite3", [db, `SELECT count(*) FROM thread_question WHERE thread_slug = 'qf-legacy'`]).toString().trim()
check("a thread dispatched before 2026-09-11 registers nothing from the fence", legacyRows === "0", `${legacyRows} rows`)

// ---- 7: a follow-up that arrives later ------------------------------------------------------------------

const late = worker({ slug: "qf-late", sessionId: "9f0e1a00-0000-4000-9000-0000000000d4", spawnedAt: minutesAgo(7), title: "Preferences store" })
late.user("persist user preferences", minutesAgo(7))
const prefsStore = ["```question", "id: prefs-store", "kind: choice", "question: Should user preferences persist in SQLite or in Postgres?", "options:", "  - label: SQLite (better-sqlite3)", "    recommended: true", "  - label: Postgres", "```"].join("\n")
const prefsPath = (when) => ["```question", "id: prefs-sqlite-path", "kind: choice", `when: ${when}`, "question: Where should the SQLite preferences file live?", "options:", "  - label: Beside `data/sessions.db`", "  - label: Its own `data/prefs.db`", "```"].join("\n")
const prefsAskedAt = late.say(`The store is your call.\n\n${prefsStore}\n\n${prefsPath("prefs-store = SQLite")}`)
const parentOnly = await until("prefs-store on the board", async () => {
  const t = await threadOf("qf-late")
  return t?.questions?.length === 1 ? t : undefined
})
check("a wrong `when:` label leaves the parent registered, without the follow-up", parentOnly.questions[0].spec.handle === "prefs-store" && !parentOnly.questions[0].spec.options[0].followUps)
late.say(`Its SQLite option is labelled \`SQLite (better-sqlite3)\`, so here is the follow-up again.\n\n${prefsPath("prefs-store = SQLite (better-sqlite3)")}`)
const grown = await until("the follow-up under prefs-store", async () => {
  const t = await threadOf("qf-late")
  return t?.questions?.[0]?.spec.options?.[0].followUps?.length === 1 ? t : undefined
})
check("the corrected follow-up, written alone in a later message, attaches under the option it names", grown.questions[0].spec.options[0].followUps[0].handle === "prefs-sqlite-path")
check("…on the SAME question: one row, asked when the parent was", grown.questions.length === 1 && grown.questions[0].id === parentOnly.questions[0].id && grown.questions[0].askedAt === prefsAskedAt)
const lateRows = execFileSync("sqlite3", [db, `SELECT count(*) FROM thread_question WHERE thread_slug = 'qf-late'`]).toString().trim()
check("…and no second row", lateRows === "1", `${lateRows} rows`)

// ---- 8: a tilde fence and a capitalised info string ------------------------------------------------------

const TILDE_FENCE = [
  "~~~question",
  "id: migration-window",
  "kind: choice",
  "question: When should the `archived_at` migration run?",
  "options:",
  "  - label: Tonight, in the maintenance window",
  "    recommended: true",
  "  - label: With the next release",
  "---",
  "It takes a lock on `orders` for the length of the index build:",
  "",
  "```sql",
  "ALTER TABLE orders ADD COLUMN archived_at timestamptz;",
  "CREATE INDEX CONCURRENTLY orders_archived_at_idx ON orders (archived_at);",
  "```",
  "",
  "The window tonight is 02:00 to 03:00 UTC.",
  "~~~",
].join("\n")
const CAPITAL_FENCE = ["```Question", "id: release-notes-owner", "kind: text", "question: Who should the release notes name as the owner of the migration?", "```"].join("\n")
const QUOTED_TILDE = ["```md", "~~~question", "id: quoted-tilde", "kind: text", "question: Only an example, on tildes", "~~~", "```"].join("\n")
const QUOTED_IN_TILDE = ["~~~md", "```question", "id: quoted-in-tilde", "kind: text", "question: Only an example, inside a tilde block", "```", "~~~"].join("\n")
const QUOTED_BLOCKQUOTE = ["> ```Question", "> id: quoted-blockquote", "> kind: text", "> question: Only an example, in a blockquote", "> ```"].join("\n")
const OPENERS_HANDOFF = [
  "**Needs you** — the migration is written and dry-run; when it runs and who owns it are yours to say.",
  "",
  TILDE_FENCE,
  "",
  "One more thing only you know:",
  "",
  CAPITAL_FENCE,
  "",
  "For the record, these three are samples of the grammar, quoted, and ask nothing:",
  "",
  QUOTED_TILDE,
  "",
  QUOTED_IN_TILDE,
  "",
  QUOTED_BLOCKQUOTE,
  "",
  "The migration file is committed on `main` and has not been applied anywhere.",
].join("\n")

const openers = worker({ slug: "qf-openers", sessionId: "9f0e1a00-0000-4000-9000-0000000000e5", spawnedAt: minutesAgo(5), title: "Archive migration" })
openers.user("add archived_at to orders", minutesAgo(5))
openers.say("Reading the schema.", minutesAgo(4))
await until("qf-openers on the board", () => threadOf("qf-openers"))
const openersAt = openers.say(OPENERS_HANDOFF)
const twoForms = await until("both new-form questions on the board", async () => {
  const t = await threadOf("qf-openers")
  return t?.questions?.length === 2 ? t : undefined
})
const byHandle = (t, handle) => t.questions.find((x) => x.spec.handle === handle)
const windowQ = byHandle(twoForms, "migration-window")
const ownerQ = byHandle(twoForms, "release-notes-owner")
check("a `~~~question` fence registers, under the worker's id", windowQ !== undefined && /^qst_/.test(windowQ.id))
check("…asked at the record's own timestamp", windowQ?.askedAt === openersAt, `${windowQ?.askedAt} vs ${openersAt}`)
check("…its context whole, the ```sql block inside it closed", windowQ?.spec.context?.includes("```sql\nALTER TABLE orders") === true && windowQ.spec.context.endsWith("The window tonight is 02:00 to 03:00 UTC."))
check("a capitalised ```Question fence registers", ownerQ?.spec.question === "Who should the release notes name as the owner of the migration?" && ownerQ.askedAt === openersAt)
check("the thread queues on them, both standing", twoForms.needsYou === true && twoForms.questions.every((x) => x.standing === true))
const openerRows = () => execFileSync("sqlite3", [db, `SELECT handle FROM thread_question WHERE thread_slug = 'qf-openers' ORDER BY handle`]).toString().trim().split("\n").filter(Boolean)
check("the three quoted samples registered nothing", openerRows().join(",") === "migration-window,release-notes-owner", openerRows().join(","))
check("…and nothing in the message was refused", !twoForms.questionFaults?.length, JSON.stringify(twoForms.questionFaults ?? []))

// The human types past both; a reference in each new form makes its question stand again.
openers.user("leave the notes for now — what was the lock again?")
await until("both questions to fade once the human has typed", async () => {
  const t = await threadOf("qf-openers")
  return t?.questions?.length === 2 && t.questions.every((x) => x.standing === false) ? t : undefined
})
openers.say(["It is a brief `ACCESS EXCLUSIVE` lock for the column, and none for the concurrent index build.", "", "The window is still yours to pick:", "", "~~~question", "id: migration-window", "~~~"].join("\n"))
const referenced = await until("the tilde reference to make migration-window stand", async () => {
  const t = await threadOf("qf-openers")
  return byHandle(t, "migration-window")?.standing === true ? t : undefined
})
check("an `id:`-only `~~~question` references the open question: it stands again, the other does not", byHandle(referenced, "release-notes-owner")?.standing === false && referenced.questions.length === 2)
openers.user("ok")
// (A reference stands when its message is LATER than the human's; two appends in one millisecond are not.)
await until("migration-window to fade again", async () => byHandle(await threadOf("qf-openers"), "migration-window")?.standing === false)
openers.say(["And the owner, when you have it:", "", "```QUESTION", "id: release-notes-owner", "```"].join("\n"))
await until("the capitalised reference to make release-notes-owner stand", async () => byHandle(await threadOf("qf-openers"), "release-notes-owner")?.standing === true)
check("…and so does one written ```QUESTION", openerRows().length === 2, `${openerRows().length} rows`)

// A malformed fence in the new form is refused BY NAME, where it used to be a code block nobody mentioned.
openers.user("one more?")
await sleep(50)
openers.say(["~~~question", "id: backfill-batch", "kind: pick", "question: How large should each backfill batch be?", "~~~"].join("\n"))
const refusedTilde = await until("the malformed tilde fence on the board as a refused fence", async () => {
  const t = await threadOf("qf-openers")
  return t?.questionFaults?.some((f) => f.id === "backfill-batch") ? t : undefined
})
check("a malformed `~~~question` is on the board as a refused fence, its fault named", refusedTilde.questionFaults.find((f) => f.id === "backfill-batch").faults.join(" ").includes("`kind: pick`"), refusedTilde.questionFaults.find((f) => f.id === "backfill-batch").faults.join(" "))

// On a legacy thread neither form is the fence: the registrar reads nothing there, as before.
legacy.say(`${TILDE_FENCE}\n\n${CAPITAL_FENCE}`)
await sleep(2500)
const legacyAfter = execFileSync("sqlite3", [db, `SELECT count(*) FROM thread_question WHERE thread_slug = 'qf-legacy'`]).toString().trim()
check("a thread dispatched before 2026-09-11 registers nothing from the new forms either", legacyAfter === "0", `${legacyAfter} rows`)

// ---- 9: a bare option label that opens on `Word:` ----------------------------------------------------------

const colon = worker({ slug: "qf-colon", sessionId: "9f0e1a00-0000-4000-9000-0000000000f6", spawnedAt: minutesAgo(5), title: "Merge the PR" })
colon.user("review the PR and tell me", minutesAgo(5))
const mergeFence = (options) => ["```question", "id: merge-now", "kind: choice", "question: Merge the pull request now?", "options:", ...options, "```"].join("\n")
colon.say(`The review is clean.\n\n${mergeFence(["  - Yes: merge it", "  - No: leave it open"])}`)
const colonRefused = await until("the colon-label fence on the board as a refused fence", async () => {
  const t = await threadOf("qf-colon")
  return t?.questionFaults?.some((f) => f.id === "merge-now") ? t : undefined
})
const colonFaults = colonRefused.questionFaults.filter((f) => f.id === "merge-now").flatMap((f) => f.faults)
check("`- Yes: merge it` is refused with one fault per line, and nothing registers", colonFaults.length === 2 && colonRefused.questions.length === 0, `${colonFaults.length} fault(s)`)
check("…the first naming the line and the line to write", colonFaults[0]?.includes("`- Yes: merge it` reads as a key named `Yes`") && colonFaults[0].endsWith('a label that holds a colon is written `- label: "Yes: merge it"`'), colonFaults[0])
check("…the second its own line to write", colonFaults[1] === 'option 2: `- No: leave it open` reads as a key named `No` too — write `- label: "No: leave it open"`', colonFaults[1])
// The worker writes the lines the fault gave it.
colon.say(`Written the way the correction says.\n\n${mergeFence(['  - label: "Yes: merge it"', '  - label: "No: leave it open"'])}`)
const colonFixed = await until("the corrected fence to register", async () => {
  const t = await threadOf("qf-colon")
  return t?.questions?.length === 1 ? t : undefined
})
check("the lines the fault spelled register, labels whole", colonFixed.questions[0].spec.options.map((o) => o.label).join(" | ") === "Yes: merge it | No: leave it open", colonFixed.questions[0].spec.options.map((o) => o.label).join(" | "))

// ---- the screenshot fixtures ----------------------------------------------------------------------------

// `qf-openers-shot`: the new-form handoff as the NEWEST message, so the page shows both cards in their slots
// with the three quoted samples drawn as the code blocks they are.
const openersShot = worker({ slug: "qf-openers-shot", sessionId: "9f0e1a00-0000-4000-9000-0000000000a7", spawnedAt: minutesAgo(5), title: "Archive migration — tilde and capitalised fences" })
openersShot.user("add archived_at to orders", minutesAgo(5))
openersShot.say("Reading the schema.", minutesAgo(4))
openersShot.say(OPENERS_HANDOFF)
await until("qf-openers-shot's two questions on the board", async () => (await threadOf("qf-openers-shot"))?.questions?.length === 2)
console.log(`      screenshot fixture: qf-openers-shot`)


const shot = worker({ slug: "qf-shot", sessionId: "9f0e1a00-0000-4000-9000-0000000000c3", spawnedAt: minutesAgo(6), title: "Settings store — open question" })
shot.user("move the settings into a real store", minutesAgo(6))
shot.say("Reading the settings layer.", minutesAgo(5))
shot.say(ASKING_HANDOFF)
await until("qf-shot's question on the board", async () => (await threadOf("qf-shot"))?.questions?.length === 1)
console.log(`      screenshot fixture: qf-shot`)

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
