import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { createServer, type Server } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"
// @ts-expect-error — the worker plugin is plain .mjs shipped loose beside the server; it has no types.
import { CLI, TOOLS } from "../../../cc-worker/lib/frizz-tools.mjs"
import { questionFenceBlocks } from "@frizz/shared"
import { buildWorkerPrompt } from "./workerPrompt.ts"

// Drives the REAL cc-worker/bin/frizzctl as a child process — its real argv, stdin, stdout and exit code
// — against a REAL http server standing in for Frizz's RPC surface. Nothing is imported from the command
// line itself: a worker reaches it through a shell, so that is the only honest way to test it.

// The module is run directly where a test only needs an answer; the tests that go through a real shell
// put the plugin's own bin/ on PATH and call `frizzctl`, which is the launcher a worker actually runs.
const BIN = fileURLToPath(new URL("../../../cc-worker/bin", import.meta.url))
const FRIZZCTL = join(BIN, "frizzctl.mjs")

interface Seen { url: string; body: any }
interface Fake { port: number; seen: Seen[]; close(): void; stateDir: string }

/** What a procedure answers when a test has nothing particular to say about it: the smallest result
 *  its handler accepts as success. A handler that reads a field this leaves out fails the examples test. */
function plausible(procedure: string, body: any): unknown {
  switch (procedure) {
    case "dispatch": return { slug: "spawned-child" }
    case "steerThread": return { slug: body.to, title: "The other thread", delivery: "resting" }
    case "spawnThread": return { slug: "spawned-child", sessionId: "sid-spawned-child", project: body.project }
    case "spawnChild": return { slug: "spawned-child", sessionId: "sid-spawned-child" }
    case "upsertOwnLink": return { link: { id: "lnk_1", kind: "url", label: body.label, target: body.target } }
    case "dropOwnLink": return { dropped: true }
    case "listThreads": return { project: { slug: "frizz", id: "proj-1", name: "frizz" }, threads: [], counts: { rested: 0, active: 0, snoozed: 0, done: 0 } }
    case "setOwnThreadTitle": return { accepted: true, title: body.title }
    case "ask": return { registered: body.questions.map((q: any, i: number) => ({ id: `qst_${i}`, spec: q, ...(q.secret ? { secretPath: "/tmp/a dir/secret" } : {}) })) }
    case "unask": return { withdrawn: true }
    case "markOwnDone": return { done: true }
    case "addOwnWatch": return { id: "wch_1", kind: body.kind, target: body.target, expiresAt: "2026-10-11T20:00:00.000Z" }
    case "dropOwnWatch": return { dropped: true }
    case "addOwnPrWatch": return { id: "prw_1", target: body.target }
    case "dropOwnPrWatch": return { dropped: true }
    case "addOwnCommandWatch": return { id: "cmw_1", alreadyArmed: false, passed: false, every: "5m", expiresAt: "2026-10-11T20:00:00.000Z", firstRun: { at: "2026-10-11T14:00:00.000Z", outcome: "exit", exitCode: 1, output: "" }, watches: [] }
    case "dropOwnCommandWatch": return { dropped: true, watches: [] }
    case "listOwnCommandWatches": return { watches: [] }
    case "setOwnThreadTimer": return { id: "tmr_1", fireAt: "2026-10-11T20:00:00.000Z", prompt: body.prompt, timers: [] }
    case "cancelOwnThreadTimer": return { cancelled: true, timers: [] }
    case "setOwnThreadRecurringPrompt": return { recurringPrompt: body.action === "stop" ? null : { prompt: body.prompt, stopHook: !!body.stopHook, postCompaction: !!body.postCompaction } }
    default: return {}
  }
}

async function fakeFrizz(answer: (procedure: string, body: any) => { status?: number; result?: unknown } | undefined = () => undefined): Promise<Fake> {
  const seen: Seen[] = []
  const http: Server = createServer((req, res) => {
    let raw = ""
    req.on("data", (c) => (raw += c))
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : undefined
      const url = req.url ?? ""
      seen.push({ url, body })
      const procedure = url.split("/rpc/")[1] ?? ""
      const custom = answer(procedure, body)
      res.writeHead(custom?.status ?? 200, { "content-type": "application/json" })
      res.end(JSON.stringify({ result: custom?.result ?? plausible(procedure, body) }))
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as { port: number }).port
  // A state dir shaped like the real one — `<root>/projects/<project id>` — because the command line
  // reads its project id off that path.
  const stateDir = join(mkdtempSync(join(tmpdir(), "frizzctl-root-")), "projects", "proj-1")
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(join(stateDir, "server.lock"), JSON.stringify({ port }))
  return { port, seen, stateDir, close: () => http.close() }
}

interface Ran { code: number | null; stdout: string; stderr: string }

/** This process's environment minus the Frizz identity a test runner inside a worker would leak in:
 *  left set, FRIZZ_SERVER_LOCK points a child at the LIVE server the worker belongs to. */
function unleaked(): NodeJS.ProcessEnv {
  return { ...process.env, FRIZZ_THREAD: "", FRIZZ_THREAD_SLUG: "", FRIZZ_STATE_DIR: "", FRIZZ_PERM_DIR: "", FRIZZ_SERVER_LOCK: "", FRIZZ_PROJECT_ID: "" }
}

/** One invocation. `env` REPLACES the Frizz identity a test runner inside a worker would leak in. */
function run(argv: string[], opts: { env?: Record<string, string>; stdin?: string; cwd?: string; holdStdinOpen?: boolean } = {}): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FRIZZCTL, ...argv], {
      cwd: opts.cwd ?? mkdtempSync(join(tmpdir(), "frizzctl-cwd-")),
      env: { ...unleaked(), ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (c) => (stdout += c))
    child.stderr.on("data", (c) => (stderr += c))
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, stdout, stderr }))
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin)
    else if (!opts.holdStdinOpen) child.stdin.end()
  })
}

const worker = (fake: Fake, slug = "the-caller") => ({ FRIZZ_STATE_DIR: fake.stateDir, FRIZZ_THREAD: slug })

test("every registry command has a command-line spelling, and the spelling names real arguments", () => {
  for (const tool of TOOLS as Array<{ name: string; inputSchema: { properties?: Record<string, unknown> } }>) {
    const spec = CLI[tool.name]
    assert.ok(spec, `${tool.name} has no CLI entry — \`frizzctl --help\` would not list it`)
    assert.ok(spec.summary && !spec.summary.includes("\n"), `${tool.name} needs a one-line summary`)
    // A RETIRED command is in no group (so the index does not list it) and has nothing to run as an
    // example: what it prints instead of running is its whole page.
    if (spec.retired) {
      assert.equal(spec.group, undefined, `${tool.name} is retired, and must not be listed`)
      assert.deepEqual(spec.examples, [], `${tool.name} is retired, and has nothing to show as an example`)
      continue
    }
    assert.ok(["Sign off", "Waiting", "This thread", "Other threads"].includes(spec.group), `${tool.name} is in no listed group`)
    const props = Object.keys(tool.inputSchema.properties ?? {})
    for (const key of [...(spec.positional ?? []), ...Object.values(spec.then ?? {}).flat(), ...(spec.wrap ? [spec.wrap] : [])] as string[]) {
      assert.ok(props.includes(key), `${tool.name} spells an argument \`${key}\` its schema does not have`)
    }
    assert.ok(spec.examples?.length, `${tool.name} has no example`)
  }
  assert.deepEqual(Object.keys(CLI).sort(), (TOOLS as Array<{ name: string }>).map((t) => t.name).sort())
})

test("`frizzctl --help` is the short index; a command's own `--help` is the full reference", async () => {
  const top = await run(["--help"])
  assert.equal(top.code, 0)
  for (const tool of TOOLS as Array<{ name: string; description: string }>) {
    if (CLI[tool.name].retired) {
      assert.doesNotMatch(top.stdout, new RegExp(`^  ${tool.name}\\s`, "m"), `${tool.name} is retired, and must not be listed`)
      continue
    }
    assert.match(top.stdout, new RegExp(`^  ${tool.name.replace(/_/g, "-")}\\s+${CLI[tool.name].summary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"))
    // The index must stay an index: no command's long description leaks into it.
    assert.ok(!top.stdout.includes(tool.description.slice(0, 60)), `${tool.name}'s description is in the top-level help`)
  }
  assert.ok(top.stdout.split("\n").length < 60, "the top-level help is meant to be read whole")
  assert.equal((await run([])).stdout, top.stdout, "no arguments at all prints the same index")

  const one = await run(["watch-pr", "--help"])
  assert.equal(one.code, 0)
  assert.match(one.stdout, /^frizzctl watch-pr — /)
  assert.match(one.stdout, /REGISTER A PULL REQUEST/)
  assert.match(one.stdout, /--for {2}<string>/)
  assert.match(one.stdout, /frizzctl watch-pr add acme\/app#391 --for 180d/)
  assert.equal((await run(["help", "watch_pr"])).stdout, one.stdout, "`help <command>` and the underscore spelling are the same page")

  // A retired command's page is what it prints instead of running: the fence that replaced it.
  const ask = await run(["ask", "--help"])
  assert.equal(ask.code, 0)
  assert.match(ask.stdout, /^frizzctl ask — Retired: a question is a ```question fence in your own message\n/)
  assert.match(ask.stdout, /```question\nid: settings-store\nkind: choice\n/)

  const schema = await run(["timer", "--schema"])
  assert.deepEqual(JSON.parse(schema.stdout), (TOOLS as Array<{ name: string; inputSchema: unknown }>).find((t) => t.name === "timer")!.inputSchema)
})

test("a misspelled command or flag fails with the fix in the message, and reaches no server", async () => {
  const fake = await fakeFrizz()
  try {
    const cmd = await run(["wach", "shell", "x"], { env: worker(fake) })
    assert.equal(cmd.code, 1)
    assert.match(cmd.stderr, /has no command "wach"\. Did you mean: watch/)

    const flag = await run(["timer", "set", "--in-secs", "5"], { env: worker(fake) })
    assert.equal(flag.code, 1)
    assert.match(flag.stderr, /`frizzctl timer` has no --in-secs\. It takes: --action, --prompt, --in-seconds, --at, --id\./)
    assert.match(flag.stderr, /frizzctl timer --help/)

    const extra = await run(["title", "Fix", "queue", "focus"], { env: worker(fake) })
    assert.equal(extra.code, 1)
    assert.match(extra.stderr, /got an extra "queue"\. Quote a value that has spaces\./)

    const typed = await run(["timer", "set", "--in-seconds", "soon"], { env: worker(fake) })
    assert.match(typed.stderr, /--in-seconds takes a whole number, not "soon"/)

    // A JSON key the command does not take is refused, not dropped: `heartbeat` for
    // `heartbeat_seconds` would otherwise arm a goal with no clock and say nothing.
    const key = await run(["goal", '{"action":"start","prompt":"p","heartbeat":600}'], { env: worker(fake) })
    assert.equal(key.code, 1)
    assert.match(key.stderr, /does not take: heartbeat\. It takes: action, prompt, stop_hook, heartbeat_seconds, post_compaction\./)
    assert.deepEqual(fake.seen, [])
  } finally {
    fake.close()
  }
})

test("flags, bare arguments, inline JSON, `--input <file>` and `--input -` all say the same thing", async () => {
  const fake = await fakeFrizz()
  try {
    const cwd = mkdtempSync(join(tmpdir(), "frizzctl-cwd-"))
    writeFileSync(join(cwd, "timer.json"), JSON.stringify({ action: "set", prompt: "re-check the deploy", in_seconds: 600 }))
    const ways: Array<{ argv: string[]; stdin?: string }> = [
      { argv: ["timer", "set", "--prompt", "re-check the deploy", "--in-seconds", "600"] },
      { argv: ["timer", "--action=set", "--prompt=re-check the deploy", "--in_seconds=600"] },
      { argv: ["timer", '{"action":"set","prompt":"re-check the deploy","in_seconds":600}'] },
      { argv: ["timer", "--input", "timer.json"] },
      { argv: ["timer", "--input", "-"], stdin: '{"action":"set","prompt":"re-check the deploy","in_seconds":600}' },
      // A flag wins over the JSON it rides beside.
      { argv: ["timer", "--input", "-", "--in-seconds", "600"], stdin: '{"action":"set","prompt":"re-check the deploy","in_seconds":5}' },
    ]
    for (const way of ways) {
      fake.seen.length = 0
      const ran = await run(way.argv, { env: worker(fake), cwd, stdin: way.stdin })
      assert.equal(ran.code, 0, `${way.argv.join(" ")}: ${ran.stderr}`)
      assert.equal(fake.seen.length, 1, way.argv.join(" "))
      assert.equal(fake.seen[0].url, "/_frizz/proj-1/rpc/setOwnThreadTimer")
      assert.equal(fake.seen[0].body.slug, "the-caller")
      assert.equal(fake.seen[0].body.prompt, "re-check the deploy")
    }

    // A switch: alone, negated, and spelled out.
    for (const [argv, stopHook] of [
      [["goal", "start", "--prompt", "p", "--post-compaction", "--no-stop-hook"], false],
      [["goal", "start", "--prompt", "p", "--post-compaction", "--stop-hook=false"], false],
      [["goal", "start", "--prompt", "p", "--stop-hook"], true],
    ] as Array<[string[], boolean]>) {
      fake.seen.length = 0
      const ran = await run(argv, { env: worker(fake) })
      assert.equal(ran.code, 0, ran.stderr)
      assert.equal(fake.seen[0].body.stopHook, stopHook, argv.join(" "))
    }

    // An action given as a flag leaves the next bare argument for what that action takes.
    fake.seen.length = 0
    assert.equal((await run(["watch-pr", "--action", "drop", "prw_9"], { env: worker(fake) })).code, 0)
    assert.equal((await run(["watch-pr", "drop", "prw_9"], { env: worker(fake) })).code, 0)
    assert.deepEqual(fake.seen.map((s) => [s.url, s.body.id]), [["/_frizz/proj-1/rpc/dropOwnPrWatch", "prw_9"], ["/_frizz/proj-1/rpc/dropOwnPrWatch", "prw_9"]])
  } finally {
    fake.close()
  }
})

// `ask` AND `secret` ARE RETIRED (2026-10-13): a question is a ```question fence the worker writes in its
// own message. Both commands stay, so the worker that reaches for one — a contract that predates the fence,
// a project doc that still names it — is taught the fence at that moment. They refuse (exit 2) whatever
// they are given, WITHOUT calling Frizz and without reading the stdin a heredoc hands them, and the fence
// in the refusal is one the shared parser registers as written.
test("`ask` and `secret` refuse with the fence that replaced them, and call nothing", async () => {
  const fake = await fakeFrizz()
  try {
    const question = { question: "SQLite or a JSON file?", kind: "question", options: [{ label: "SQLite", recommended: true }, { label: "JSON file" }] }
    for (const argv of [["ask", "--input", "-"], ["ask", JSON.stringify({ questions: [question] })], ["ask", "--no-such-flag"], ["ask"]]) {
      const ran = await run(argv, { env: worker(fake), stdin: JSON.stringify({ questions: [question] }) })
      assert.equal(ran.code, 2, `${argv.join(" ")}: ${ran.stderr}`)
      assert.equal(ran.stderr, "")
      assert.match(ran.stdout, /^NOT registered — `frizzctl ask` is retired \(2026-10-13\), and nothing was sent\./)
      const fences = questionFenceBlocks(ran.stdout)
      assert.equal(fences.length, 1)
      assert.equal(fences[0].read.form, "ask")
    }
    const secret = await run(["secret", "The npm one-time code", "--header", "npm OTP"], { env: worker(fake) })
    assert.equal(secret.code, 2)
    assert.match(secret.stdout, /^NOT registered — `frizzctl secret` is retired/)
    const [otp] = questionFenceBlocks(secret.stdout)
    assert.ok(otp.read.form === "ask" && otp.read.spec.secret, "the secret refusal shows a `kind: secret` fence")
    assert.match(secret.stdout, /--otp "\$\(cat '<path>'\)"/)
    assert.deepEqual(fake.seen, [], "a retired command calls nothing")
  } finally {
    fake.close()
  }
})

// THE REASON TEXT GOES THROUGH A FILE OR A QUOTED HEREDOC. A handoff is full of backticked commands and
// paths; this is the path the contract teaches for them, driven through a real shell.
test("a body through a quoted heredoc reaches Frizz byte for byte — backticks, `$( )` and quotes unrun", async () => {
  const fake = await fakeFrizz()
  try {
    const marker = join(mkdtempSync(join(tmpdir(), "frizzctl-marker-")), "ran")
    const body = `- **Fixed the lookup** in \`src/resolver.ts\`; \`touch ${marker}\` and $(touch ${marker}) stayed text.\n- It's "done", $HOME and all.`
    const script = `frizzctl done --body-file - <<'EOF'\n${body}\nEOF`
    const ran = await new Promise<Ran>((resolve) => {
      const child = spawn("sh", ["-c", script], {
        env: { ...unleaked(), ...worker(fake), FRIZZ_THREAD_SLUG: "", FRIZZ_NODE: process.execPath, PATH: `${BIN}${delimiter}${process.env.PATH}` },
        stdio: ["ignore", "pipe", "pipe"],
      })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (c) => (stdout += c))
      child.stderr.on("data", (c) => (stderr += c))
      child.on("close", (code) => resolve({ code, stdout, stderr }))
    })
    assert.equal(ran.code, 0, ran.stderr)
    assert.deepEqual(fake.seen, [{ url: "/_frizz/proj-1/rpc/markOwnDone", body: { slug: "the-caller", body } }])
    assert.match(ran.stdout, /^Marked done\./)
    assert.equal(existsSync(marker), false, "the shell ran a command out of the body")
  } finally {
    fake.close()
  }
})

// `--title` rides INSIDE the body, in the ```done fence's own grammar, so the server's one splitter
// heads a registered card exactly as it heads a fenced one (2026-10-13).
test("`done --title` sends the body as `title:`, `---`, then the ledger — and the flag replaces a title the body opens with", async () => {
  const fake = await fakeFrizz()
  try {
    const ran = await run(["done", "--title", "Resolver cache\n  keyed on the normalized id ", "--body-file", "-"], { env: worker(fake), stdin: "- **Fixed** the lookup.\n" })
    assert.equal(ran.code, 0, ran.stderr)
    assert.deepEqual(fake.seen, [{ url: "/_frizz/proj-1/rpc/markOwnDone", body: { slug: "the-caller", body: "title: Resolver cache keyed on the normalized id\n---\n- **Fixed** the lookup." } }])

    // The body's own heading block goes; one written lower down is the ledger's prose and stays.
    fake.seen.length = 0
    const both = await run(["done", "--title", "From the flag", "--body-file", "-"], { env: worker(fake), stdin: "title: From the body\n  continued\n---\n- Fixed.\ntitle: a sentence\n" })
    assert.equal(both.code, 0, both.stderr)
    assert.equal(fake.seen[0]?.body.body, "title: From the flag\n---\n- Fixed.\ntitle: a sentence")

    // `--title-file` comes free with the string property, as for every text argument.
    fake.seen.length = 0
    const dir = mkdtempSync(join(tmpdir(), "frizzctl-title-"))
    writeFileSync(join(dir, "title.txt"), "From a file\n")
    const file = await run(["done", "--title-file", join(dir, "title.txt"), "--body", "- Fixed."], { env: worker(fake) })
    assert.equal(file.code, 0, file.stderr)
    assert.equal(fake.seen[0]?.body.body, "title: From a file\n---\n- Fixed.")

    // No title, or a blank one, sends the body exactly as before.
    fake.seen.length = 0
    await run(["done", "--title", "  ", "--body", "---\n- Fixed."], { env: worker(fake) })
    assert.equal(fake.seen[0]?.body.body, "---\n- Fixed.")
  } finally {
    fake.close()
  }
})

test("the caller is the environment's thread and nothing a command line can say", async () => {
  const fake = await fakeFrizz()
  try {
    // FRIZZ_THREAD is what every worker shell has; the explicit stamp wins when a front-end set one.
    await run(["title", "Fix queue focus"], { env: { FRIZZ_STATE_DIR: fake.stateDir, FRIZZ_THREAD: "from-thread" } })
    await run(["title", "Fix queue focus"], { env: { FRIZZ_STATE_DIR: fake.stateDir, FRIZZ_THREAD: "from-thread", FRIZZ_THREAD_SLUG: "from-stamp" } })
    assert.deepEqual(fake.seen.map((s) => s.body.slug), ["from-thread", "from-stamp"])

    // There is no argument for it, in either spelling.
    fake.seen.length = 0
    const flag = await run(["title", "x", "--slug", "someone-else"], { env: worker(fake) })
    assert.equal(flag.code, 1)
    assert.match(flag.stderr, /has no --slug/)
    const key = await run(["title", '{"title":"x","slug":"someone-else"}'], { env: worker(fake) })
    assert.equal(key.code, 1)
    assert.match(key.stderr, /does not take: slug/)

    // Outside a worker there is no thread, and the message says so rather than naming a command.
    const outside = await run(["activity"], { env: { FRIZZ_STATE_DIR: fake.stateDir } })
    assert.equal(outside.code, 1)
    assert.match(outside.stderr, /could not tell which thread is calling/)
    assert.deepEqual(fake.seen, [])
  } finally {
    fake.close()
  }
})

// `spawn-thread --project` goes to OUR project's `spawnThread`, never to the other project's `dispatch`:
// our project verifies the caller and writes the footer, because it knows our slug and we hold its id.
test("`spawn-thread --project` asks our own project, with the raw prompt, and links the thread into the other one", async () => {
  const fake = await fakeFrizz()
  try {
    const ran = await run(["spawn-thread", "--project", "nub", "--model", "opus", "--effort", "high", "--title", "Bump the SDK", "--prompt", "do it"], { env: worker(fake, "the-caller") })
    assert.equal(ran.code, 0, ran.stderr)
    assert.deepEqual(fake.seen, [{
      url: "/_frizz/proj-1/rpc/spawnThread",
      body: { model: "opus", effort: "high", title: "Bump the SDK", prompt: "do it", from: "the-caller", project: "nub" },
    }])
    assert.match(ran.stdout, /now on the `nub` project's board/)
    assert.match(ran.stdout, /with `frizzctl steer spawned-child --project nub`/)
    assert.match(ran.stdout, /\[Bump the SDK\]\(\/project\/nub\/thread\/spawned-child\)/)

    // Any link into that board names the project as well as its slug does.
    fake.seen.length = 0
    await run(["spawn-thread", "--project", "http://localhost:9393/project/nub/thread/some-thread/full", "--model", "opus", "--effort", "high", "--prompt", "x"], { env: worker(fake) })
    assert.equal(fake.seen[0]?.body.project, "nub")

    // With no project, the spawn is the same-project `dispatch` it always was, footer and all.
    fake.seen.length = 0
    const local = await run(["spawn-thread", "--model", "opus", "--effort", "high", "--prompt", "x"], { env: worker(fake, "the-caller") })
    assert.equal(local.code, 0, local.stderr)
    assert.equal(fake.seen[0]?.url, "/_frizz/proj-1/rpc/dispatch")
    assert.match(fake.seen[0]?.body.prompt, /Spawned by the Frizz thread `the-caller`\. .*`frizzctl steer the-caller --message-file <file\|->`\.$/s)
    assert.match(local.stdout, /\(\/thread\/spawned-child\)/)

    // The other project's board takes a real caller: a shell with no thread has none to send.
    fake.seen.length = 0
    const outside = await run(["spawn-thread", "--project", "nub", "--model", "opus", "--effort", "high", "--prompt", "x"], { env: { FRIZZ_STATE_DIR: fake.stateDir } })
    assert.equal(outside.code, 1)
    assert.match(outside.stderr, /could not tell which thread is calling/)
    assert.deepEqual(fake.seen, [])
  } finally {
    fake.close()
  }
})

// `threads` asks OUR project's `listThreads`, naming the other project when there is one, and prints the
// board banded the way the sidebar is — the caller marked, the Done band counted even when it is left out.
test("`threads` lists a board by band, marks the caller, reads a project out of a link, and prints JSON on request", async () => {
  const now = Date.now()
  const ago = (ms: number) => new Date(now - ms).toISOString()
  const listing = {
    project: { slug: "frizz", id: "proj-1", name: "frizz" },
    threads: [
      { slug: "fix-queue-focus", title: "Fix queue focus", band: "rested", runtime: "turn-idle", fence: "done", questions: 0, subAgents: 0, shells: 0, watches: [], lastLine: "**Fixed** — the queue keeps focus.", lastActivityAt: ago(2 * 3600_000 + 5 * 60_000) },
      { slug: "the-caller", title: "List the threads", band: "active", runtime: "running", doing: "Running the focused tests", questions: 0, subAgents: 1, shells: 0, watches: [], lastActivityAt: ago(30_000) },
      { slug: "bump-the-pin", title: "Bump the pin", band: "snoozed", runtime: "turn-idle", fence: "awaiting", questions: 0, subAgents: 0, shells: 0, watches: ["acme/app#391"], pinned: true, lastActivityAt: ago(3 * 86400_000) },
    ],
    counts: { rested: 1, active: 1, snoozed: 1, done: 122 },
  }
  const fake = await fakeFrizz((procedure) => (procedure === "listThreads" ? { result: listing } : undefined))
  try {
    const ran = await run(["threads"], { env: worker(fake, "the-caller") })
    assert.equal(ran.code, 0, ran.stderr)
    assert.deepEqual(fake.seen, [{ url: "/_frizz/proj-1/rpc/listThreads", body: {} }])
    assert.equal(ran.stdout, [
      "frizz (`frizz`) — 3 open threads (1 rested, 1 active, 1 snoozed); 122 done, not listed (`--all` lists them).",
      "",
      "Rested — in the human's queue",
      "  fix-queue-focus  Fix queue focus",
      "    signed off done · last moved 2h 5m ago",
      "    > **Fixed** — the queue keeps focus.",
      "",
      "Active — spinning",
      "  the-caller  List the threads  (this thread)",
      "    turn in flight: Running the focused tests · 1 sub-agent running · last moved 30s ago",
      "",
      "Snoozed — parked",
      "  bump-the-pin  Bump the pin  (pinned)",
      "    watching acme/app#391 · last moved 3d ago",
      "",
      "Message one with `frizzctl steer <slug>`. `--json` prints every field.",
      "",
    ].join("\n"))

    // Another project's board, named by any link into it; the caller is not marked there, and the steer
    // hint carries the project it needs.
    fake.seen.length = 0
    const other = { ...listing, project: { slug: "nub", id: "proj-nub", name: "nub" } }
    const fakeOther = await fakeFrizz((procedure) => (procedure === "listThreads" ? { result: other } : undefined))
    try {
      const there = await run(["threads", "http://localhost:9393/project/nub/thread/x/full", "--all"], { env: worker(fakeOther, "the-caller") })
      assert.equal(there.code, 0, there.stderr)
      assert.deepEqual(fakeOther.seen[0]?.body, { project: "nub", all: true })
      assert.doesNotMatch(there.stdout, /this thread/)
      assert.match(there.stdout, /; 122 done\.\n/)
      assert.match(there.stdout, /`frizzctl steer <slug> --project nub`/)
    } finally {
      fakeOther.close()
    }

    // `--json` is the listing itself, and a shell with no thread of its own can read a board too.
    const json = await run(["threads", "--json"], { env: { FRIZZ_STATE_DIR: fake.stateDir } })
    assert.equal(json.code, 0, json.stderr)
    assert.deepEqual(JSON.parse(json.stdout), listing)
  } finally {
    fake.close()
  }
})

// A worker forked by a Frizz that predates the command line was never handed FRIZZ_STATE_DIR. Its shell
// has had FRIZZ_PERM_DIR all along, and that is enough to find the server and name the project.
test("a shell that only has FRIZZ_PERM_DIR still finds the server and its own project", async () => {
  const fake = await fakeFrizz()
  try {
    const ran = await run(["activity"], { env: { FRIZZ_PERM_DIR: join(fake.stateDir, "perm-requests"), FRIZZ_THREAD: "old-worker" } })
    assert.equal(ran.code, 0, ran.stderr)
    assert.deepEqual(fake.seen, [{ url: "/_frizz/proj-1/rpc/listOwnThreadActivity", body: { slug: "old-worker" } }])

    const nowhere = await run(["activity"], { env: { FRIZZ_THREAD: "lost" } })
    assert.equal(nowhere.code, 1)
    assert.match(nowhere.stderr, /cannot locate the Frizz server/)
    assert.match(nowhere.stderr, /NOTHING WAS SAVED/)
  } finally {
    fake.close()
  }
})

test("exit 0 is done, 1 is a failure, and 2 is a gate that held", async () => {
  const fake = await fakeFrizz((procedure) => {
    if (procedure === "markOwnDone") return { result: { done: false, blockingQuestions: [{ id: "settings-store", question: "SQLite or JSON?" }], blockingWatches: [] } }
    if (procedure === "setOwnThreadTitle") return { status: 500 }
    return undefined
  })
  try {
    const refused = await run(["done", "--body", "all finished"], { env: worker(fake) })
    assert.equal(refused.code, 2)
    assert.match(refused.stdout, /^NOT marked done\./)
    // The server names a question by the worker's own id where it has one — the id `unask` takes.
    assert.match(refused.stdout, /settings-store {2}SQLite or JSON\?/)
    assert.equal(refused.stderr, "")

    const failed = await run(["title", "Fix queue focus"], { env: worker(fake) })
    assert.equal(failed.code, 1)
    assert.equal(failed.stdout, "")
    assert.match(failed.stderr, /^frizzctl title failed: setOwnThreadTitle returned HTTP 500/)

    const ok = await run(["unask", "settings-store"], { env: worker(fake) })
    assert.equal(ok.code, 0)
    assert.match(ok.stdout, /^Question settings-store withdrawn\./)
  } finally {
    fake.close()
  }
})

test("unask reports the question that actually went, and why nothing did when nothing did", async () => {
  // The server resolves a follow-up's id to the root it rides in (router `unask`); each reading below is
  // what the worker is told for one answer of that call.
  const answers: Record<string, unknown> = {
    "sqlite-path": { withdrawn: false, id: "settings-store", state: "open", open: [] },
    "settings-store": { withdrawn: true, id: "settings-store", state: "open", open: [] },
    "npm-scope": { withdrawn: false, id: "npm-scope", state: "answered", open: [] },
    "retry-backoff": { withdrawn: false, id: "retry-backoff", state: "dismissed", open: [] },
    "no-such-id": { withdrawn: false, open: [] },
  }
  const fake = await fakeFrizz((procedure, body) => (procedure === "unask" ? { result: answers[body.id] } : undefined))
  try {
    const out = async (id: string) => (await run(["unask", id], { env: worker(fake) })).stdout
    const viaFollowUp = await out("sqlite-path")
    assert.match(viaFollowUp, /^Nothing was withdrawn: sqlite-path is a follow-up of settings-store/)
    assert.match(viaFollowUp, /run `frizzctl unask settings-store`/)
    assert.match(await out("settings-store"), /^Question settings-store withdrawn\./)
    assert.match(await out("npm-scope"), /^Question npm-scope was already answered, so nothing was withdrawn — the answer reaches you as its own message\./)
    assert.match(await out("retry-backoff"), /^Question retry-backoff was already dismissed by the human/)
    assert.match(await out("no-such-id"), /^No OPEN question no-such-id on this thread/)
  } finally {
    fake.close()
  }
})

// `watch-command` (2026-10-11): the server runs the check, so what the command line owes is the right
// body, the refusal as exit 2 (it is the permission gate holding, with the background-shell fallback in
// it), a first check that already passed read as "nothing armed", and `unwatch` reaching the right RPC.
test("`watch-command` registers for the calling thread, reads a refusal as exit 2, and `unwatch` drops a cmw_ id", async () => {
  let mode: "armed" | "refused" | "passed" = "armed"
  const fake = await fakeFrizz((procedure, body) => {
    if (procedure !== "addOwnCommandWatch") return undefined
    if (mode === "refused") {
      return { result: { refused: "Frizz will not run a command watch for this thread: this thread runs in `default` permission mode. Run the check in a background shell instead.", alreadyArmed: false, passed: false, watches: [] } }
    }
    if (mode === "passed") {
      return { result: { alreadyArmed: false, passed: true, firstRun: { at: "2026-10-11T14:00:00.000Z", outcome: "exit", exitCode: 0, output: "0.13.12\n" }, watches: [] } }
    }
    return { result: {
      id: "cmw_abc", alreadyArmed: false, passed: false, every: "5m", expiresAt: "2026-10-11T20:00:00.000Z",
      firstRun: { at: "2026-10-11T14:00:00.000Z", outcome: "exit", exitCode: 1, output: "npm error 404 No match found for version 0.13.12" },
      watches: [{ id: "cmw_abc", command: body.command, every: "5m", state: "armed", createdAt: "2026-10-11T14:00:00.000Z", expiresAt: "2026-10-11T20:00:00.000Z", runs: 1, lastRun: { at: "2026-10-11T14:00:00.000Z", outcome: "exit", exitCode: 1, output: "" } }],
    } }
  })
  try {
    const armed = await run(["watch-command", "add", "npm view frizz@0.13.12 version", "--every", "5m", "--for", "6h"], { env: worker(fake) })
    assert.equal(armed.code, 0, armed.stderr)
    assert.deepEqual(fake.seen.at(-1)?.body, { slug: "the-caller", command: "npm view frizz@0.13.12 version", every: "5m", for: "6h" })
    assert.match(armed.stdout, /^Watching as cmw_abc: Frizz runs it every 5m until it exits 0/)
    assert.match(armed.stdout, /Its first check exited 1\./)
    assert.match(armed.stdout, /`commands: \[cmw_abc\]`, `status: watching`/)
    assert.match(armed.stdout, /cmw_abc {2}every 5m, until 2026-10-11T20:00:00.000Z — 1 check, last check exited 1\n {4}\$ npm view frizz@0\.13\.12 version/)

    mode = "refused"
    const refused = await run(["watch-command", "add", "true", "--every", "5m", "--for", "1h"], { env: worker(fake) })
    assert.equal(refused.code, 2)
    assert.match(refused.stdout, /^NOT registered\. Frizz will not run a command watch for this thread/)
    assert.match(refused.stdout, /background shell instead/)

    mode = "passed"
    const passed = await run(["watch-command", "add", "true", "--every", "5m", "--for", "1h"], { env: worker(fake) })
    assert.equal(passed.code, 0)
    assert.match(passed.stdout, /^NOTHING WAS ARMED: your command exited 0 on its first check/)
    assert.match(passed.stdout, /0\.13\.12/)

    const missing = await run(["watch-command", "add", "true", "--for", "1h"], { env: worker(fake) })
    assert.equal(missing.code, 1)
    assert.match(missing.stderr, /`every` is required/)

    fake.seen.length = 0
    const dropped = await run(["unwatch", "cmw_abc"], { env: worker(fake) })
    assert.equal(dropped.code, 0)
    assert.ok(fake.seen[0]?.url.endsWith("/rpc/dropOwnCommandWatch"), fake.seen[0]?.url)
    assert.match(dropped.stdout, /^Command watch cmw_abc dropped\./)
  } finally {
    fake.close()
  }
})

// `watch-command add --persistent` (2026-11-06, `frizzctl monitor` until then): a script the server keeps
// running. The command line owes the right body, the lines the script printed in registration's window, a
// refusal as exit 2, a script that ended at once read as "nothing running", and neither shape quietly
// taking the other's argument.
test("`watch-command add --persistent` starts for the calling thread, hands back its first lines, reads a refusal as exit 2, and drops", async () => {
  let mode: "running" | "refused" | "exited" = "running"
  const view = (command: string) => ({
    id: "cmw_mon", command, every: "0s", state: "armed", createdAt: "2026-11-02T14:00:00.000Z", expiresAt: "2026-11-03T14:00:00.000Z", runs: 1,
    monitor: { description: "errors in app.log", events: 1, lastEvent: { at: "2026-11-02T14:00:01.000Z", text: "ERROR boot" } },
  })
  const fake = await fakeFrizz((procedure, body) => {
    if (procedure === "dropOwnCommandWatch") return { result: { dropped: true, watches: [] } }
    if (procedure !== "addOwnMonitor") return undefined
    if (mode === "refused") {
      return { result: { refused: "Frizz will not run a persistent command watch for this thread: this thread runs in `default` permission mode. Run the script with Claude Code's Monitor tool, or in a background shell, instead.", alreadyArmed: false, running: false, events: [], watches: [] } }
    }
    if (mode === "exited") {
      return { result: { id: "cmw_mon", alreadyArmed: false, running: false, events: ["done"], exited: { at: "2026-11-02T14:00:00.000Z", outcome: "exit", exitCode: 0, output: "done\n" }, watches: [] } }
    }
    return { result: { id: "cmw_mon", alreadyArmed: false, running: true, events: ["ERROR boot"], expiresAt: "2026-11-03T14:00:00.000Z", watches: [view(body.command as string)] } }
  })
  try {
    const add = (...rest: string[]) => run(["watch-command", "add", ...rest], { env: worker(fake) })
    const script = "tail -F app.log | grep --line-buffered ERROR"
    const armed = await add(script, "--persistent", "--description", "errors in app.log", "--for", "1d")
    assert.equal(armed.code, 0, armed.stderr)
    assert.deepEqual(fake.seen.at(-1)?.body, { slug: "the-caller", command: script, for: "1d", description: "errors in app.log" })
    assert.match(armed.stdout, /^Watching as cmw_mon: Frizz keeps your script running until 2026-11-03T14:00:00.000Z/)
    assert.match(armed.stdout, /It printed in its first 2s \(handed to you here, not as a wake\):\n {2}ERROR boot/)
    assert.match(armed.stdout, /`commands: \[cmw_mon\]`, `status: watching`/)
    assert.match(armed.stdout, /frizzctl watch-command drop cmw_mon/)
    assert.match(armed.stdout, /cmw_mon {2}persistent "errors in app\.log", running until 2026-11-03T14:00:00.000Z — 1 event so far, the latest at 2026-11-02T14:00:01.000Z: ERROR boot\n {4}\$ tail -F/)

    mode = "refused"
    const refused = await add("true", "--persistent", "--description", "x", "--for", "1h")
    assert.equal(refused.code, 2)
    assert.match(refused.stdout, /^NOT registered\. Frizz will not run a persistent command watch for this thread/)

    // The flag on a check is the likely mistake, so the reply names the shape it wanted.
    mode = "exited"
    const exited = await add("echo done", "--persistent", "--description", "x", "--for", "1h")
    assert.equal(exited.code, 0)
    assert.match(exited.stdout, /^NOTHING IS RUNNING: your script exited 0 within its first 2s/)
    assert.match(exited.stdout, /A check that finishes takes `--every` instead/)

    const posted = fake.seen.length
    const missing = await add("true", "--persistent")
    assert.equal(missing.code, 1)
    assert.match(missing.stderr, /`for` is required/)
    // A persistent watch is named by its description on every surface, so one without a name is refused.
    const unnamed = await add("true", "--persistent", "--for", "1h")
    assert.equal(unnamed.code, 1)
    assert.match(unnamed.stderr, /`description` is required with `persistent`/)
    const cadence = await add("true", "--persistent", "--every", "5m", "--description", "x", "--for", "1h")
    assert.equal(cadence.code, 1)
    assert.match(cadence.stderr, /`every` does not go with `persistent`/)
    const named = await add("true", "--every", "5m", "--description", "x", "--for", "1h")
    assert.equal(named.code, 1)
    assert.match(named.stderr, /`description` goes with `persistent`/)
    assert.equal(fake.seen.length, posted, "none of those reached the server")

    fake.seen.length = 0
    const dropped = await run(["watch-command", "drop", "cmw_mon"], { env: worker(fake) })
    assert.equal(dropped.code, 0)
    assert.ok(fake.seen[0]?.url.endsWith("/rpc/dropOwnCommandWatch"), fake.seen[0]?.url)
    assert.match(dropped.stdout, /^Command watch cmw_mon dropped\./)
  } finally {
    fake.close()
  }
})

// A resumed worker keeps the contract it started with, so it may still call the old command.
test("`monitor` is retired: it refuses with the command to run, and calls nothing", async () => {
  const fake = await fakeFrizz(() => undefined)
  try {
    for (const argv of [["monitor", "add", "true", "--description", "x", "--for", "1h"], ["monitor", "list"], ["monitor", "drop", "cmw_mon"]]) {
      const refused = await run(argv, { env: worker(fake) })
      assert.equal(refused.code, 2, argv.join(" "))
      assert.match(refused.stdout, /`frizzctl monitor` is retired/)
      assert.match(refused.stdout, /frizzctl watch-command add "<script>" --persistent --description/)
    }
    assert.equal(fake.seen.length, 0)
    const help = await run(["--help"], { env: worker(fake) })
    assert.match(help.stdout, /watch-command/)
    assert.doesNotMatch(help.stdout, /^\s*monitor\b/m, "it is out of the listing")
  } finally {
    fake.close()
  }
})

// Three ways a command line can mean something other than it says, each of which used to run anyway: a
// help flag that is really a flag's VALUE, a flag that is really the missing value of the flag before
// it, and a JSON value of the wrong type that the handler then reads as absent.
test("a value is never read as a flag, a flag never as a value, and a JSON value has the schema's type", async () => {
  const fake = await fakeFrizz()
  try {
    const steered = await run(["steer", "other-thread", "--message", "-h"], { env: worker(fake) })
    assert.equal(steered.code, 0, steered.stderr)
    assert.deepEqual(fake.seen.map((s) => s.body), [{ from: "the-caller", to: "other-thread", message: "-h" }])
    // …while `-h` standing as a flag of its own is still help, and reads no stdin to get there.
    const help = await run(["steer", "--input", "-", "-h"], { env: worker(fake), holdStdinOpen: true })
    assert.equal(help.code, 0)
    assert.match(help.stdout, /^frizzctl steer — /)

    fake.seen.length = 0
    const missing = await run(["goal", "start", "--prompt", "--post-compaction"], { env: worker(fake) })
    assert.equal(missing.code, 1)
    assert.match(missing.stderr, /--prompt needs a value, and the next argument is the flag --post-compaction/)
    // A value that really starts with `--` says so with `=`.
    const dashed = await run(["goal", "start", "--prompt=--resume the audit", "--post-compaction"], { env: worker(fake) })
    assert.equal(dashed.code, 0, dashed.stderr)

    const mistyped = await run(["goal", '{"action":"start","prompt":"x","stop_hook":"false"}'], { env: worker(fake) })
    assert.equal(mistyped.code, 1)
    assert.match(mistyped.stderr, /stop_hook must be a boolean, not "false"/)
    assert.deepEqual(fake.seen.map((s) => s.body?.prompt), ["--resume the audit"])
  } finally {
    fake.close()
  }
})

// A codex thread a human narrowed to `workspace-write` or `read-only` cannot open a socket, loopback
// included, and codex says so in the shell's environment. "fetch failed" there reads as Frizz being
// down, which a worker answers by retrying; the message has to say that no retry can work.
test("a shell sandboxed off the network is told so, and told not to retry", async () => {
  const fake = await fakeFrizz()
  fake.close()
  await new Promise((resolve) => setTimeout(resolve, 50))

  const sandboxed = await run(["title", "Fix queue focus"], { env: { ...worker(fake), CODEX_SANDBOX_NETWORK_DISABLED: "1" } })
  assert.equal(sandboxed.code, 1)
  assert.equal(sandboxed.stdout, "")
  assert.match(sandboxed.stderr, /sandboxed with network access off/)
  assert.match(sandboxed.stderr, /NOTHING WAS SAVED/)
  assert.match(sandboxed.stderr, /do not retry/)

  // The same dead port from an ordinary shell is an ordinary failure, which IS worth a retry.
  const down = await run(["title", "Fix queue focus"], { env: { ...worker(fake), CODEX_SANDBOX_NETWORK_DISABLED: "" } })
  assert.equal(down.code, 1)
  assert.match(down.stderr, /setOwnThreadTitle request failed/)
  assert.doesNotMatch(down.stderr, /sandboxed/)
})

// An agent's shell hands a command an OPEN PIPE for stdin more often than a terminal. A command that
// reads it uninvited never returns, and that reads as the command being broken.
test("stdin is never read unless `-` asks for it", async () => {
  const fake = await fakeFrizz()
  try {
    const ran = await Promise.race([
      run(["activity"], { env: worker(fake), holdStdinOpen: true }),
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 10_000)),
    ])
    assert.notEqual(ran, "hung", "`frizzctl activity` waited on a stdin nobody asked it to read")
    assert.equal((ran as Ran).code, 0)
  } finally {
    fake.close()
  }
})

// The examples are what a worker copies. Every one of them is run, through a real shell, against the
// fake — so an example that names a flag the command lost, or a heredoc that no longer parses, fails here.
test("every example in every command's help runs as written", async () => {
  const fake = await fakeFrizz()
  try {
    const cwd = mkdtempSync(join(tmpdir(), "frizzctl-examples-"))
    for (const file of ["handoff.md", "prompt.md", "resume-prompt.md"]) writeFileSync(join(cwd, file), "Some text with `backticks`.\n")
    for (const [name, spec] of Object.entries(CLI as Record<string, { examples: string[] }>)) {
      for (const example of spec.examples) {
        fake.seen.length = 0
        const ran = await new Promise<Ran>((resolve) => {
          const child = spawn("sh", ["-c", example], {
            cwd,
            env: { ...unleaked(), ...worker(fake), FRIZZ_THREAD_SLUG: "", FRIZZ_NODE: process.execPath, PATH: `${BIN}${delimiter}${process.env.PATH}` },
            stdio: ["ignore", "pipe", "pipe"],
          })
          let stdout = ""
          let stderr = ""
          child.stdout.on("data", (c) => (stdout += c))
          child.stderr.on("data", (c) => (stderr += c))
          child.on("close", (code) => resolve({ code, stdout, stderr }))
        })
        assert.equal(ran.code, 0, `${name}: \`${example.split("\n")[0]}\` exited ${ran.code}: ${ran.stderr}`)
        assert.equal(fake.seen.length, 1, `${name}: \`${example.split("\n")[0]}\` made ${fake.seen.length} calls`)
      }
    }
  } finally {
    fake.close()
  }
})

// THE CONTRACT'S OWN SPELLINGS. The system prompt (workerPrompt.ts) is where a worker first meets the
// command line, and it lives in another file from the registry that defines it. So every `sh` fence the
// contract writes out is run here through a real shell, and every `frizzctl <command>` it names in
// prose must be a command that exists, in the hyphenated spelling the help prints. A rename in the
// registry would otherwise leave every worker taught a command that exits 1.
test("every frizzctl example the worker contract writes out runs as written, and every command it names exists", async () => {
  const fake = await fakeFrizz()
  try {
    const commands = new Set((TOOLS as Array<{ name: string }>).map((t) => t.name.replace(/_/g, "-")))
    for (const kind of ["claude", "codex", "acp"] as const) {
      const prompt = buildWorkerPrompt(kind)
      assert.doesNotMatch(prompt, /mcp__frizz__/, `${kind}: the contract still names an MCP tool`)
      const named = [...prompt.matchAll(/`frizzctl ([a-z][a-z_-]*)/g)].map((m) => m[1])
      assert.ok(named.length >= 30, `${kind}: the contract names the command line throughout (${named.length})`)
      for (const name of named) assert.ok(commands.has(name), `${kind}: the contract names \`frizzctl ${name}\`, which is not a command`)
      // …nor one that only refuses: a question is a fence the worker writes, never a command it runs.
      for (const name of named) assert.ok(!CLI[name.replace(/-/g, "_")]?.retired, `${kind}: the contract teaches the retired \`frizzctl ${name}\``)
      // Every capability a worker is told about by name is one it was introduced to as `frizzctl`.
      assert.match(prompt, /`frizzctl --help` lists every command; `frizzctl <command> --help` is that command's full\s+reference/)

      const examples = [...prompt.matchAll(/```sh\n(frizzctl [^]*?)\n```/g)].map((m) => m[1])
      assert.equal(examples.length, 1, `${kind}: the done heredoc`)
      for (const example of examples) {
        fake.seen.length = 0
        const ran = await new Promise<Ran>((resolve) => {
          const child = spawn("sh", ["-c", example], {
            cwd: mkdtempSync(join(tmpdir(), "frizzctl-contract-")),
            env: { ...unleaked(), ...worker(fake), FRIZZ_THREAD_SLUG: "", FRIZZ_NODE: process.execPath, PATH: `${BIN}${delimiter}${process.env.PATH}` },
            stdio: ["ignore", "pipe", "pipe"],
          })
          let stdout = ""
          let stderr = ""
          child.stdout.on("data", (c) => (stdout += c))
          child.stderr.on("data", (c) => (stderr += c))
          child.on("close", (code) => resolve({ code, stdout, stderr }))
        })
        const first = example.split("\n")[0]
        assert.equal(ran.code, 0, `${kind}: \`${first}\` exited ${ran.code}: ${ran.stderr}`)
        assert.equal(fake.seen.length, 1, `${kind}: \`${first}\` made ${fake.seen.length} calls`)
        const { url, body } = fake.seen[0]
        assert.ok(url.endsWith("/rpc/markOwnDone"), url)
        assert.equal(body.body, "- **Fixed the lookup** in `src/resolver.ts`; `npm test` green.")
      }
    }
  } finally {
    fake.close()
  }
})
