// scripts/scripted-claude.mjs is the worker every layout recording and scripts/verify-question-fence-wakes.mjs
// is built on, so what it writes is itself under test: a turn script (`file=`) that drifts, or a knob that
// stops meaning what it meant, turns a verifier's PASS into a statement about nothing.
//
// The binary is driven here the way the broker drives it — stream-json on stdin, one process per session,
// a transcript under HOME — with no Frizz anywhere: the seam under test is the script file → the records.
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const BIN = join(dirname(fileURLToPath(import.meta.url)), "scripted-claude.mjs")

/** One scripted session in a throwaway HOME. `args` are the CLI's own (`--session-id=…`, `--resume=…`). */
function session(home, cwd, args, env = {}) {
  const child = spawn(process.execPath, [BIN, ...args], { cwd, env: { ...process.env, HOME: home, ...env }, stdio: ["pipe", "pipe", "inherit"] })
  const results = []
  let buffered = ""
  child.stdout.on("data", (chunk) => {
    buffered += chunk
    for (;;) {
      const at = buffered.indexOf("\n")
      if (at < 0) break
      const line = buffered.slice(0, at)
      buffered = buffered.slice(at + 1)
      try {
        const event = JSON.parse(line)
        if (event.type === "result") results.push(event)
      } catch {}
    }
  })
  const until = async (probe) => {
    const deadline = Date.now() + 15_000
    while (!probe()) {
      if (Date.now() > deadline) throw new Error("the scripted session did not answer")
      await new Promise((r) => setTimeout(r, 15))
    }
  }
  return {
    /** Send one message and wait for the turn it starts to end. */
    async say(text) {
      const before = results.length
      child.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`)
      await until(() => results.length > before)
    },
    async stop() {
      const gone = new Promise((r) => child.once("exit", r))
      child.kill("SIGTERM")
      await gone
    },
  }
}

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "scripted-claude-test-"))
  const cwd = join(home, "project")
  const file = join(home, "turns.json")
  const transcript = (id) => {
    // The path is resolved by the binary from ITS cwd, which the OS may spell differently (/var → /private/var).
    const dir = join(home, ".claude", "projects")
    const found = existsSync(dir) ? readFileSync(join(dir, readdirSync(dir)[0], `${id}.jsonl`), "utf8") : ""
    return found.split("\n").filter(Boolean).map((l) => JSON.parse(l))
  }
  return { home, cwd, file, transcript, done: () => rmSync(home, { recursive: true, force: true }) }
}

/** What the worker said and ran, in order: `> text` for a message in, `$ cmd` and `→ result` for a tool
 *  call, `< text` for a final message. */
function story(records) {
  return records.flatMap((r) => {
    const c = r.message?.content
    if (r.type === "user" && typeof c === "string") return [`> ${c}`]
    if (r.type === "user" && Array.isArray(c)) return c.filter((b) => b.type === "tool_result").map((b) => `→ ${b.is_error ? "!" : ""}${b.content}`)
    if (r.type === "assistant") return c.map((b) => (b.type === "tool_use" ? `$ ${b.input.command}` : `< ${b.text}`))
    return []
  })
}

test("a turn script states each turn: its commands run for real, its text is written verbatim", async () => {
  const box = sandbox()
  mkdirSync(box.cwd, { recursive: true })
  writeFileSync(box.file, JSON.stringify({
    think: 0,
    turns: [
      { name: "first", tools: ["printf 'one\\n'; exit 0", { command: "echo out; echo err >&2; exit 2", description: "Fail on purpose" }], text: "Asked.\n\n```question\nid: store\nkind: text\nquestion: Where?\n```" },
      { name: "corrected", on: "could not register", text: "Fixed." },
      { name: "next in line", text: "Second plain turn." },
      { name: "every answer", onRe: "^Answers to", times: 0, text: "Heard." },
    ],
    otherwise: { text: "Nothing scripted." },
  }))
  const s = session(box.home, box.cwd, ["--session-id=11111111-1111-4111-8111-111111111111"])
  try {
    await s.say(`[script file=${box.file} disklag=0 resultlag=5] go`)
    await s.say("anything at all") // no `on` matches it: the next entry with no `on` takes it
    await s.say("Your fence could not register") // …and the keyed entry waits for its own message
    await s.say("Answers to earlier questions: 1")
    await s.say("Answers to earlier questions: 2") // `times: 0` answers every one
    await s.say("a message nothing expects")
  } finally {
    await s.stop()
  }
  assert.deepEqual(story(box.transcript("11111111-1111-4111-8111-111111111111")), [
    `> [script file=${box.file} disklag=0 resultlag=5] go`,
    "$ printf 'one\\n'; exit 0",
    "→ one",
    "$ echo out; echo err >&2; exit 2",
    "→ !Exit code 2\nout\nerr",
    "< Asked.\n\n```question\nid: store\nkind: text\nquestion: Where?\n```",
    "> anything at all",
    "< Second plain turn.",
    "> Your fence could not register",
    "< Fixed.",
    "> Answers to earlier questions: 1",
    "< Heard.",
    "> Answers to earlier questions: 2",
    "< Heard.",
    "> a message nothing expects",
    "< Nothing scripted.",
  ])
  const log = readFileSync(`${box.file}.log`, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  assert.deepEqual(log.map((l) => l.entry), [0, 2, 1, 3, 3, "otherwise"], "the log names the entry that answered each message")
  box.done()
})

// Claude Code APPENDS a plugin's bin to the PATH it inherited (measured 2026-11-03), so a `frizzctl`
// already on that PATH shadows the plugin's — the reason adhoc-stack.mjs strips an inherited one.
test("a tool call finds the plugin's bin LAST on PATH, as Claude Code's Bash does", async () => {
  const box = sandbox()
  mkdirSync(join(box.cwd, "plugin", "bin"), { recursive: true })
  mkdirSync(join(box.cwd, "inherited"), { recursive: true })
  writeFileSync(join(box.cwd, "plugin", "bin", "frizzctl"), "#!/bin/sh\necho the-plugin-frizzctl\n", { mode: 0o755 })
  writeFileSync(join(box.cwd, "inherited", "frizzctl"), "#!/bin/sh\necho an-inherited-frizzctl\n", { mode: 0o755 })
  writeFileSync(box.file, JSON.stringify({ think: 0, turns: [{ tools: ["frizzctl"], text: "Ran it." }] }))
  const ran = async (id, PATH) => {
    const s = session(box.home, box.cwd, [`--session-id=${id}`, `--plugin-dir=${join(box.cwd, "plugin")}`], { PATH })
    try {
      await s.say(`[script file=${box.file} disklag=0 resultlag=5] go`)
    } finally {
      await s.stop()
    }
    return story(box.transcript(id))[2]
  }
  assert.equal(await ran("22222222-2222-4222-8222-222222222222", "/usr/bin:/bin"), "→ the-plugin-frizzctl", "with none inherited, the plugin's runs")
  assert.equal(await ran("44444444-4444-4444-8444-444444444444", `${join(box.cwd, "inherited")}:/usr/bin:/bin`), "→ an-inherited-frizzctl", "one already on PATH wins")
  box.done()
})

test("a resumed session carries on from its script instead of starting it over", async () => {
  const box = sandbox()
  mkdirSync(box.cwd, { recursive: true })
  writeFileSync(box.file, JSON.stringify({ think: 0, turns: [{ text: "One." }, { text: "Two." }, { text: "Three." }] }))
  const id = "33333333-3333-4333-8333-333333333333"
  const first = session(box.home, box.cwd, [`--session-id=${id}`])
  await first.say(`[script file=${box.file} disklag=0 resultlag=5] go`)
  await first.say("again")
  await first.stop()
  const second = session(box.home, box.cwd, [`--resume=${id}`])
  await second.say("and again")
  await second.stop()
  const records = box.transcript(id)
  assert.deepEqual(story(records).filter((l) => l.startsWith("<")), ["< One.", "< Two.", "< Three."])
  const ids = records.filter((r) => r.type === "assistant").map((r) => r.message.id)
  assert.equal(new Set(ids).size, ids.length, "and no message id is reused across the resume")
  box.done()
})

test("with no file the knobs generate every turn, exactly as before", async () => {
  const box = sandbox()
  mkdirSync(box.cwd, { recursive: true })
  const id = "44444444-4444-4444-8444-444444444444"
  const s = session(box.home, box.cwd, [`--session-id=${id}`])
  try {
    await s.say("[script ending=steps paras=1 think=0 replythink=0 reply=bare replyparas=1 disklag=0 resultlag=5] go")
    await s.say("a follow-up")
  } finally {
    await s.stop()
  }
  const said = story(box.transcript(id)).filter((l) => l.startsWith("<"))
  assert.equal(said.length, 2)
  assert.match(said[0], /^< 1\. Release engineering[\s\S]*```awaiting\ntitle: Approve the npm sign-in/, "the first turn ends the way `ending=` says")
  assert.match(said[1], /^< 1\. Release engineering[^`]*$/, "and a later one the way `reply=` says: bare, no fence")
  assert.equal(existsSync(`${box.file}.log`), false)
  box.done()
})

test("`ending=question` and `reply=question` ask the way a worker asks: a question fence, a new id each turn", async () => {
  const box = sandbox()
  mkdirSync(box.cwd, { recursive: true })
  const id = "55555555-5555-4555-8555-555555555555"
  const s = session(box.home, box.cwd, [`--session-id=${id}`])
  try {
    await s.say("[script ending=question paras=1 think=0 replythink=0 reply=question replyparas=1 disklag=0 resultlag=5] go")
    await s.say("an answer")
  } finally {
    await s.stop()
  }
  const records = box.transcript(id)
  assert.equal(records.some((r) => r.type === "assistant" && r.message.content.some((b) => b.type === "tool_use")), false, "no command is run to ask")
  const said = story(records).filter((l) => l.startsWith("<"))
  const fence = (n) => [
    "```question", `id: publish-release-${n}`, "kind: choice", "question: Publish the release now, or hold it for the changelog?",
    "options:", "  - label: Publish now", "    description: every gate passed on this commit", "    recommended: true",
    "  - label: Hold it", "    description: the changelog entry is still a draft", "```",
  ].join("\n")
  assert.ok(said[0].endsWith(`\n\n${fence(1)}`), "the first turn closes on the fence")
  assert.ok(said[1].endsWith(`\n\n${fence(2)}`), "and a later one on the same question under a new id")
  assert.match(said[0], /^< One decision is needed before this can go further; it is asked below\.\n\n1\. Release engineering/)
  box.done()
})
