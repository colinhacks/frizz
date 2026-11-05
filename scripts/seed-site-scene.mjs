// Seed the disposable stack the frizz.sh screenshots are taken from: made-up projects with their own icons,
// and threads in every band, all simulated (session rows plus transcripts the REAL tailer reads). Nothing
// here is real work and no provider runs. scripts/shoot-site.mjs photographs what this stages.
//
//   nub scripts/seed-site-scene.mjs --stack=<the json line adhoc-stack printed, in a file> [--features]
//
// Plain, it stages the hero and the other projects. With --features it adds one thread per homepage feature to
// mobile-app. Run it in that order and shoot the hero between the two, or the hero's rail wears mobile-app's count.
// The pids of its stand-in daemon and shells land in <home>/scene-pids.json. Kill them with the stack.
import { execFileSync, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { formatThreadMessage } from "../packages/shared/src/index.ts"
import { launchHeadless } from "./lib/headless-browser.mjs"
import { createRpcClient } from "./lib/rpc-client.mjs"

const stackFile = process.argv.find((a) => a.startsWith("--stack="))?.slice(8)
if (!stackFile) throw new Error("--stack=<file holding adhoc-stack's json line> is required")
const features = process.argv.includes("--features")
const stack = JSON.parse(readFileSync(stackFile, "utf8").split("\n").find((l) => l.startsWith("{")))
const { home, port } = stack
const db = join(home, ".frizz", "ui.db")
const projects = Object.fromEntries([stack.launcher, ...stack.tenants].map((p) => [p.slug, p]))
const api = createRpcClient(`http://127.0.0.1:${port}/`)
await api.waitForHealth()

// One stand-in daemon for every thread: its only job is to own a pid that answers `kill -0`.
const daemon = spawn("sleep", ["28800"], { detached: true, stdio: "ignore" })
daemon.unref()
const pids = [daemon.pid]

const ago = (min) => new Date(Date.now() - min * 60_000).toISOString()
const later = (min) => new Date(Date.now() + min * 60_000).toISOString()
const sql = (v) => (v === null || v === undefined ? "NULL" : `'${String(v).replace(/'/g, "''")}'`)
let n = 0
const uuid = () => `00000000-0000-4000-9000-${String(++n).padStart(12, "0")}`
const sessionIdOf = (project, slug) => `${createHash("sha256").update(`${project}/${slug}`).digest("hex").slice(0, 8)}-0000-4000-9000-000000000000`
const logDirOf = (project) => {
  const dir = join(home, ".claude", "projects", projects[project].dir.replace(/[/.]/g, "-"))
  mkdirSync(dir, { recursive: true })
  return dir
}

// ---- record builders ----
const user = (min, text) => ({ type: "user", timestamp: ago(min), message: { role: "user", content: text } })
const say = (min, text, extra = {}) => ({
  type: "assistant", timestamp: ago(min),
  message: { model: "claude-opus-5-5", id: `msg_${uuid()}`, type: "message", role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 2, output_tokens: 40 }, ...extra },
})
const calls = (min, list, text) => ({
  type: "assistant", timestamp: ago(min),
  message: {
    model: "claude-opus-5-5", id: `msg_${uuid()}`, type: "message", role: "assistant", stop_reason: "tool_use", usage: { input_tokens: 2, output_tokens: 60 },
    content: [...(text ? [{ type: "text", text }] : []), ...list.map(([id, name, input]) => ({ type: "tool_use", id, name, input }))],
  },
})
const results = (min, list) => ({
  type: "user", timestamp: ago(min),
  message: { role: "user", content: list.map(([id, content]) => ({ type: "tool_result", tool_use_id: id, content })) },
})

/** A steer: the human's message taken mid-turn, placed where the worker read it. */
const steer = (min, text) => [
  { type: "queue-operation", operation: "enqueue", timestamp: ago(min), content: text },
  { type: "queue-operation", operation: "remove", timestamp: ago(min - 0.1), content: text, reason: "absorbed_mid_turn" },
]

function write(project, slug, spec) {
  const { title, records, rested = 0, model = "claude-opus-5-5", effort = "high", backend = "claude", snoozedUntil = null, archived = false, mtimeMin = null } = spec
  const sessionId = sessionIdOf(project, slug)
  const { id, dir } = projects[project]
  const stateDir = join(home, ".frizz", "projects", id)
  mkdirSync(join(stateDir, "claude-broker"), { recursive: true })
  const lines = records.flat().map((r) => JSON.stringify({ parentUuid: null, isSidechain: false, uuid: uuid(), session_id: sessionId, cwd: dir, ...r }))
  const file = join(logDirOf(project), `${sessionId}.jsonl`)
  writeFileSync(file, lines.join("\n") + "\n")
  if (mtimeMin !== null) { const t = new Date(Date.now() - mtimeMin * 60_000); utimesSync(file, t, t) }
  writeFileSync(
    join(stateDir, "claude-broker", `${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}.json`),
    JSON.stringify({ sessionId, daemonPid: daemon.pid, socketPath: join(stateDir, "claude-broker", `${slug}.sock`) }),
  )
  const spawnedAt = records.flat()[0]?.timestamp ?? ago(30)
  execFileSync("sqlite3", ["-cmd", ".timeout 15000", db, `INSERT OR REPLACE INTO session (project_id, slug, session_id, thread_name, spawned_at, title, title_auto, backend, claude_runtime, model, effort, permission_mode, state, unread, exited, archived, rested_at, snoozed_until, archived_at)
    VALUES (${sql(id)}, ${sql(slug)}, ${sql(sessionId)}, ${sql(`frizz-${slug}`)}, ${sql(spawnedAt)}, ${sql(title)}, 0, ${sql(backend)}, 'broker', ${sql(model)}, ${sql(effort)}, 'default', ${sql(archived ? "archived" : "active")}, 0, 0, ${archived ? 1 : 0}, ${rested === null ? "NULL" : sql(ago(rested))}, ${sql(snoozedUntil)}, ${archived ? sql(ago(rested)) : "NULL"})`])
  return { sessionId, file, dir: logDirOf(project) }
}

/** A sub-agent a worker launched, with a transcript of its own. Fresh = reads as running. */
function subAgent(project, slug, { agent, id, type = "frizz:high", label, lines = [], minutesAgo = 0 }) {
  const sessionId = sessionIdOf(project, slug)
  const dir = join(logDirOf(project), sessionId, "subagents")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `agent-${agent}.meta.json`), JSON.stringify({ agentType: type, description: label, toolUseId: id, spawnDepth: 1 }))
  const file = join(dir, `agent-${agent}.jsonl`)
  // A line is prose, or [call id, tool, input, result] for a tool call and what it returned.
  const records = lines.flatMap((line) => {
    const base = { parentUuid: null, isSidechain: true, uuid: uuid(), timestamp: ago(minutesAgo), session_id: sessionId, cwd: projects[project].dir }
    const assistant = (content, stop) => ({ ...base, type: "assistant", message: { model: "claude-opus-5-5", id: `msg_${agent}_${uuid()}`, type: "message", role: "assistant", stop_reason: stop, content, usage: { input_tokens: 2, output_tokens: 20 } } })
    if (typeof line === "string") return [assistant([{ type: "text", text: line }], null)]
    const [callId, name, input, result] = line
    return [
      assistant([{ type: "tool_use", id: callId, name, input }], "tool_use"),
      { ...base, uuid: uuid(), type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: result }] } },
    ]
  })
  writeFileSync(file, (records.length ? records : []).map((r) => JSON.stringify(r)).join("\n") + "\n")
  if (minutesAgo) { const t = new Date(Date.now() - minutesAgo * 60_000); utimesSync(file, t, t) }
  return file
}
const launched = (agent, file) => `Async agent launched successfully.\nagentId: ${agent}\noutput_file: ${file}`

/** A background shell a real process holds open, which is what makes it read as live. */
function liveShell(op, output) {
  const dir = join(home, "tasks")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `${op}.output`)
  writeFileSync(path, output)
  const fd = openSync(path, "a")
  const proc = spawn("sleep", ["28800"], { detached: true, stdio: ["ignore", fd, "ignore"] })
  proc.unref()
  closeSync(fd)
  pids.push(proc.pid)
  return path
}
const shellAck = (op, path) => `Command running in background with ID: ${op}. Output is being written to: ${path}. You will be notified when it completes. To check interim output, use Read on that file path.`
const shellDone = (min, op, id, label, path) => ({
  type: "queue-operation", operation: "enqueue", timestamp: ago(min),
  content: `<task-notification>\n<task-id>${op}</task-id>\n<tool-use-id>${id}</tool-use-id>\n<output-file>${path}</output-file>\n<status>completed</status>\n<summary>Background command "${label}" completed (exit code 0)</summary>\n</task-notification>`,
})

const question = (id, q, opts, context = "") => [
  "```question", `id: ${id}`, "kind: choice", `question: ${q}`, "options:",
  ...opts.flatMap(([label, description, rec]) => [`  - label: ${label}`, `    description: ${description}`, ...(rec ? ["    recommended: true"] : [])]),
  ...(context ? ["---", context] : []),
  "```",
].join("\n")


// ---- one thread per homepage feature, in mobile-app ----

/** Pictures for an agent to show: two takes on a billing page, drawn from HTML so they carry no real data. */
async function drawPictures(dir) {
  mkdirSync(dir, { recursive: true })
  const css = `*{box-sizing:border-box}body{margin:0;font:15px/1.45 Inter,system-ui,sans-serif;color:#17181c;background:#f4f5f7}
    .nav{display:flex;align-items:center;gap:22px;height:58px;padding:0 28px;background:#fff;border-bottom:1px solid #e6e7eb;font-weight:600}.nav i{width:22px;height:22px;border-radius:6px;background:#4f46e5}.nav span{font-weight:500;color:#6b7078}
    h1{font-size:26px;margin:0 0 4px;letter-spacing:-.02em}.sub{color:#6b7078;margin:0 0 22px}.card{background:#fff;border:1px solid #e6e7eb;border-radius:12px;padding:20px}
    .big{font-size:32px;font-weight:700;letter-spacing:-.03em}.btn{display:inline-block;margin-top:14px;padding:9px 14px;border-radius:8px;background:#4f46e5;color:#fff;font-weight:600}
    table{width:100%;border-collapse:collapse}td{padding:11px 0;border-top:1px solid #eeeff2}td:last-child{text-align:right;font-weight:600}.bar{height:8px;border-radius:9px;background:#e8e8f6;margin-top:12px}.bar b{display:block;height:100%;width:62%;border-radius:9px;background:#4f46e5}`
  const nav = `<div class="nav"><i></i>Acme<span>Projects</span><span>Team</span><span style="color:#17181c">Billing</span></div>`
  const invoices = `<table><tr><td>Oct 2026</td><td>$84.00</td></tr><tr><td>Sep 2026</td><td>$84.00</td></tr><tr><td>Aug 2026</td><td>$62.00</td></tr><tr><td>Jul 2026</td><td>$62.00</td></tr></table>`
  const plan = `<div class="sub" style="margin:0">Team plan</div><div class="big">$84<span style="font-size:15px;font-weight:500;color:#6b7078"> / month</span></div><div class="bar"><b></b></div><div class="sub" style="margin:10px 0 0">62 of 100 seats used</div><span class="btn">Change plan</span>`
  const pages = {
    "billing-two": `${nav}<div style="padding:32px 40px"><h1>Billing</h1><p class="sub">Your plan and invoices</p><div style="display:grid;grid-template-columns:5fr 7fr;gap:20px"><div class="card">${plan}</div><div class="card"><b>Invoices</b>${invoices}</div></div></div>`,
    "billing-one": `${nav}<div style="padding:32px 40px;max-width:680px;margin:0 auto"><h1>Billing</h1><p class="sub">Your plan and invoices</p><div class="card" style="margin-bottom:16px">${plan}</div><div class="card"><b>Invoices</b>${invoices}</div></div>`,
    "billing-dark": `<style>body{background:#101114;color:#eceef2}.nav,.card{background:#17181c;border-color:#2a2c31}td{border-color:#2a2c31}.nav span:last-child{color:#eceef2!important}</style>${nav}<div style="padding:32px 40px"><h1>Billing</h1><p class="sub">Your plan and invoices</p><div style="display:grid;grid-template-columns:5fr 7fr;gap:20px"><div class="card">${plan}</div><div class="card"><b>Invoices</b>${invoices}</div></div></div>`,
  }
  const browser = await launchHeadless({ colorScheme: "light" })
  try {
    for (const [name, html] of Object.entries(pages)) {
      const page = await browser.newPage()
      await page.setViewport({ width: 960, height: 600, deviceScaleFactor: 1.5 })
      await page.setContent(`<!doctype html><style>${css}</style>${html}`)
      await page.screenshot({ path: join(dir, `${name}.png`) })
      await page.close()
    }
    const page = await browser.newPage()
    await page.setViewport({ width: 390, height: 600, deviceScaleFactor: 2 })
    await page.setContent(`<!doctype html><style>${css}</style>${nav}<div style="padding:22px 18px"><h1>Billing</h1><p class="sub">Your plan and invoices</p><div class="card" style="margin-bottom:14px">${plan}</div><div class="card"><b>Invoices</b>${invoices}</div></div>`)
    await page.screenshot({ path: join(dir, "billing-phone.png") })
  } finally {
    // close() can hang once the pages are done, so give it a moment and then end the process it owns.
    await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 3000))])
    browser.process()?.kill()
  }
}

async function askWhenKnown(slug, questions) {
  for (let attempt = 0; ; attempt++) {
    try { return await createRpcClient(`http://127.0.0.1:${port}/`, projects[APP].id).mutate("ask", { slug, questions }) } catch (error) {
      if (attempt >= 30) throw error
      await new Promise((r) => setTimeout(r, 500))
    }
  }
}

async function seedFeatures() {
  const dir = projects[APP].dir
  const shots = join(home, "pictures")
  await drawPictures(shots)
  const pic = (name) => join(shots, `${name}.png`)

  write(APP, "billing-layout", {
    title: "Redesign the billing page", rested: 6,
    records: [user(30, "Redesign the billing page. Show me the options before you build one."), say(6, "Both layouts are built behind a flag. Screenshots are in each option.")],
  })
  await askWhenKnown("billing-layout", [{
    question: "Which layout should the billing page use?", kind: "question",
    options: [
      { label: "Two columns", recommended: true, description: ["Plan beside invoices, so both are visible without scrolling.", "", "```lightbox", `${pic("billing-two")}  Desktop`, `${pic("billing-phone")}  Phone`, "```"].join("\n") },
      { label: "One column", description: ["A single scrolling page that matches the rest of settings.", "", "```lightbox", `${pic("billing-one")}  Desktop`, `${pic("billing-phone")}  Phone`, "```"].join("\n") },
    ],
  }])

  write(APP, "publish-docs", {
    title: "Publish the mobile docs", rested: 14,
    records: [user(50, "Publish the mobile docs once the preview is green."), say(14, "The preview build is green and the release is drafted. Only the signed-in steps are left.\n\n```awaiting\ntitle: Approve the docs release\nsteps:\n  - Open the [release draft](https://github.com/acme/mobile-app/releases) and press **Publish release**.\n  - Sign in to the [App Store Connect review page](https://appstoreconnect.apple.com/) and approve build `2.4.0 (118)`.\n  - Run `npm login` and approve the prompt with the maintainer account.\n```")],
  })

  write(APP, "publish-sdk", {
    title: "Publish the SDK to npm", rested: 9,
    records: [user(25, "Publish the SDK to npm."), say(9, ["The tarball is built and the dry run is clean. `npm publish` needs the account's one-time code.", "", "```question", "id: npm-otp", "kind: secret", "question: The npm one-time code for the maintainer account, to publish acme-sdk", "```"].join("\n"))],
  })

  write(APP, "offline-sync", {
    title: "Fix the offline sync conflict", rested: 11,
    records: [user(70, "A phone that was offline for a week overwrote newer work when it reconnected. Fix the sync conflict."), say(11, "The conflict came from comparing local clocks. Sync now keys on the server's revision, and the regression test covers a phone that was offline for a week.\n\n```done\ntitle: Sync keys on the server revision\n---\n- Fixed the conflict in `src/sync/merge.ts`.\n- Added a regression test for a phone offline for a week.\n```")],
  })

  write(APP, "push-provider", {
    title: "Add push notifications", rested: 2,
    records: [user(40, "Add push notifications to the app."), say(2, ["The notification service is stubbed behind one interface, so either provider fits. This choice decides what I wire up next.", "", question("push-provider", "Which push provider should the app use?", [["APNs and FCM directly", "No vendor or per-message cost; two integrations to maintain", true], ["A push vendor", "One API and delivery reports; a monthly bill and a third party"]])].join("\n"))],
  })

  // A thread resting on its own work: one helper and one shell, still running.
  const loadAgent = "toolu_load_agent", loadShell = "toolu_load_shell"
  const loadFile = subAgent(APP, "load-test", {
    agent: "siteC", id: loadAgent, label: "Compare sync latency against last week",
    lines: ["Pulling last week's numbers to compare against."],
  })
  const loadPath = liveShell("bgsite03", Array.from({ length: 1840 }, (_, i) => `req ${i}`).join("\n") + "\n")
  write(APP, "load-test", {
    title: "Load test the new sync path", rested: 4,
    records: [
      user(24, "Load test the new sync path against last week's numbers."),
      calls(22, [
        [loadAgent, "Agent", { description: "Compare sync latency against last week", prompt: "Compare them.", run_in_background: true, subagent_type: "frizz:high" }],
        [loadShell, "Bash", { command: "npm run load-test", description: "Running the sync load test", run_in_background: true }],
      ]),
      results(22, [[loadAgent, launched("siteC", loadFile)], [loadShell, shellAck("bgsite03", loadPath)]]),
      say(4, "The load test is running and a helper is pulling last week's numbers. Nothing for you yet.\n\n```awaiting\nagents: [siteC]\nshells: [bgsite03]\nstatus: working\nfor: 2h\ntitle: Sync load test\n```"),
    ],
  })

  // Pull requests a thread rests on, with checks in three states.
  const watched = (number, id) => `INSERT OR REPLACE INTO pr_watch (project_id, id, thread_slug, owner, repo, number, state, created_at, settled_at, cursor) VALUES (${sql(projects[APP].id)}, ${sql(id)}, 'ship-sync', 'acme', 'mobile-app', ${number}, 'armed', ${Date.now() - 600_000}, NULL, NULL)`
  write(APP, "ship-sync", {
    title: "Ship the offline sync fixes", rested: 3,
    records: [user(60, "Ship the offline sync fixes."), say(3, "All three pull requests are up. I am watching CI and reviews and will pick the failing one back up.\n\n```awaiting\nprs: [acme/mobile-app#391, acme/mobile-app#392, acme/mobile-app#393]\nstatus: needs_input\nfor: 2h\n---\nThe failing lint job on acme/mobile-app#393 is the next thing I will fix.\n```")],
  })
  for (const [number, id] of [[391, "a"], [392, "b"], [393, "c"]]) execFileSync("sqlite3", ["-cmd", ".timeout 15000", db, watched(number, `prw-${id}`)])
  const status = (over) => ({ checks: "running", running: 0, passed: 0, failed: 0, failing: [], merge: "unknown", state: "open", polledAt: ago(1), ...over })
  execFileSync("sqlite3", ["-cmd", ".timeout 15000", db, `INSERT OR REPLACE INTO settings (project_id, key, value) VALUES (${sql(projects[APP].id)}, 'waker.github.status.v1', ${sql(JSON.stringify({
    "acme/mobile-app#391": status({ checks: "running", running: 3, passed: 12, merge: "blocked" }),
    "acme/mobile-app#392": status({ checks: "passing", passed: 15, merge: "mergeable" }),
    "acme/mobile-app#393": status({ checks: "failing", running: 1, passed: 9, failed: 2, failing: ["lint", "e2e (ios)"], merge: "blocked" }),
  }))})`])

  const goal = write(APP, "green-suite", {
    title: "Get the test suite green", rested: 4,
    records: [user(90, "Get the test suite green."), say(4, "Down to three failures, all in the push notification tests. Moving on to those next.\n\n```done\ntitle: Three failures left\n---\n- Fixed 11 of 14 failing tests.\n```")],
  })
  await createRpcClient(`http://127.0.0.1:${port}/`, projects[APP].id).mutate("setThreadRecurringPrompt", { slug: "green-suite", sessionId: goal.sessionId, prompt: "Keep going until the test suite is green.", stopHook: true, heartbeat: true, intervalSeconds: 1800 })

  write(APP, "steer-running", {
    title: "Add dark mode to settings", rested: null,
    records: [user(12, "Add dark mode to the settings screen."), say(8, "Reading how the theme is applied today."), calls(0.2, [["toolu_steer", "Bash", { command: "npm run test:ui", description: "Running the UI tests" }]])],
  })

  write(APP, "peer-message", {
    title: "Rotate the push notification keys", rested: 7,
    records: [
      user(35, "Rotate the push notification keys."),
      say(20, "The new keys are generated and stored. The old ones stay live until every client has moved."),
      user(12, formatThreadMessage({ slug: "ship-sync", title: "Ship the offline sync fixes" }, "Heads up: `acme/mobile-app#392` touches the same key loader. Rebase on it before you remove the old keys, or the sync worker loses its credentials.")),
      say(7, "Thanks. I rebased on acme/mobile-app#392, and the sync worker reads the new loader. The old keys come out once the last client has moved.\n\n```done\ntitle: Push keys rotated\n---\n- Rotated the keys in `src/push/keys.ts`.\n- Rebased on acme/mobile-app#392.\n```"),
    ],
  })

  write(APP, "retry-report", {
    title: "Explain the upload failures", rested: 5,
    records: [user(40, "Why do uploads fail on slow networks?"), say(5, [
      "## Why uploads fail", "",
      "Retries wait a fixed `100ms`, so a slow network burns all five tries in under a second.", "",
      "```mermaid", "flowchart LR", "  A[Upload] --> B{Timed out?}", "  B -- no --> C[Done]", "  B -- yes --> D[Wait longer]", "  D --> A", "```", "",
      "> [!TIP] Worth keeping", "> The cap stops a long outage from holding the upload queue open.", "",
      "```ts-diff", "-  await sleep(100)", "+  await sleep(2 ** attempt * 100)", "```", "",
      "```done", "title: Uploads back off on slow networks", "---", "- Fixed the retry in `src/upload.ts`.", "```",
    ].join("\n"))],
  })

  write(APP, "billing-gallery", {
    title: "Check the billing page at every width", rested: 8,
    records: [user(30, "Check the billing page at every width."), say(8, ["The page holds at every width. Nothing clips, and the plan card stacks above invoices on a phone.", "", "```lightbox", `${pic("billing-two")}  Desktop`, `${pic("billing-dark")}  Desktop, dark`, `${pic("billing-one")}  Tablet`, `${pic("billing-phone")}  Phone`, "```", "", "```done", "title: Billing page checked at every width", "---", "- Checked four widths and both themes; nothing clips.", "```"].join("\n"))],
  })

  mkdirSync(join(dir, "docs"), { recursive: true })
  writeFileSync(join(dir, "docs", "sync-design.md"), [
    "# Offline sync design", "", "How the app reconciles changes made while a phone is offline.", "",
    "## The problem", "", "Sync compared device clocks, and a phone with a wrong clock could silently overwrite newer work.", "",
    "## The fix", "", "Every write carries the server revision it was based on. On reconnect:", "",
    "1. The client sends its writes with their base revision.", "2. The server applies any write whose base is current.", "3. Anything else comes back as a conflict the client merges.", "",
    "| Case | Result |", "|---|---|", "| Base is current | Applied |", "| Same field changed | Conflict |", "| Different field changed | Merged |", "",
    "## Rollout", "", "The new path ships behind `sync_v2`, on for staff first.",
  ].join("\n"))
  write(APP, "sync-design", {
    title: "Write up the offline sync design", rested: 10,
    records: [user(30, "Write up the offline sync design."), say(10, `The design is in [the sync design doc](${join(dir, "docs", "sync-design.md")}). It covers the failure, the fix and the rollout.\n\n\`\`\`done\ntitle: Sync design written\n---\n- Wrote \`docs/sync-design.md\`.\n\`\`\``)],
  })
}

const API = "acme-api"
const APP = "mobile-app"

if (!features) {
// ---- the thread the hero photographs ----
{
  const slug = "settings-store"
  const dir = projects[API].dir
  const auditId = "toolu_site_audit", migrateId = "toolu_site_migrate", doneShellId = "toolu_site_suite", devId = "toolu_site_dev"
  mkdirSync(join(dir, "src"), { recursive: true })
  for (const f of ["store.ts", "settings-schema.ts", "server.ts"]) writeFileSync(join(dir, "src", f), "export {}\n")
  const auditFile = subAgent(API, slug, {
    agent: "siteA", id: auditId, label: "Audit every reader of the settings store",
    lines: [
      "Starting with every call site of the store, then how each one handles a missing key.",
      ["toolu_a1", "Grep", { pattern: "settings\\.(get|set)", path: "src", description: "Finding every reader of the settings store" }, "src/store.ts:14\nsrc/server.ts:88\nsrc/cli.ts:31\nsrc/jobs/retention.ts:52\nsrc/routes/admin.ts:19"],
      ["toolu_a2", "Read", { file_path: `${dir}/src/jobs/retention.ts`, description: "Reading the retention job" }, "export async function pruneOldRuns() { const days = settings.get('retentionDays') … }"],
      "Five readers so far. `retention.ts` assumes `retentionDays` is always set, so a fresh database would make it delete everything older than `undefined` days. That needs a default before the store persists.",
      ["toolu_a3", "Read", { file_path: `${dir}/src/routes/admin.ts`, description: "Reading the admin route" }, "router.post('/settings', (req, res) => settings.set(req.body.key, req.body.value))"],
      "The admin route writes whatever it is given. Checking whether anything validates it first.",
    ],
  })
  const migrateFile = subAgent(API, slug, {
    agent: "siteB", id: migrateId, label: "Write the migration and its rollback test",
    lines: ["Reading the existing migrations to match their shape."],
  })
  const devPath = liveShell("bgsite01", Array.from({ length: 212 }, (_, i) => `request ${i}`).join("\n") + "\n")
  const suitePath = join(home, "tasks", "bgsite02.output")
  writeFileSync(suitePath, "214 passed in 38s\n")
  write(API, slug, {
    title: "Persist the settings store across restarts",
    rested: 3,
    records: [
      user(46, "Make the settings store persist across restarts. Read how sessions are stored first, then pick the mechanism."),
      calls(44, [
        ["toolu_e1", "Edit", { file_path: `${dir}/src/store.ts`, old_string: "const values = new Map()", new_string: "const values = openStore()", description: "Editing src/store.ts" }],
        ["toolu_e2", "Write", { file_path: `${dir}/src/settings-schema.ts`, content: "export const SettingsSchema = z.object({ retentionDays: z.number().default(30) })\n", description: "Writing src/settings-schema.ts" }],
        ["toolu_e3", "Edit", { file_path: `${dir}/src/server.ts`, old_string: "boot()", new_string: "await boot()", description: "Editing src/server.ts" }],
      ]),
      results(44, [["toolu_e1", "ok"], ["toolu_e2", "ok"], ["toolu_e3", "ok"]]),
      calls(45, [["toolu_r1", "Read", { file_path: `${dir}/src/session-registry.ts`, description: "Reading the session registry" }], ["toolu_r2", "Grep", { pattern: "settings\\.(get|set)", path: `${dir}/src`, description: "Finding every reader of the settings store" }]], "Reading how the session registry persists today."),
      results(45, [["toolu_r1", "export class SessionRegistry { … }"], ["toolu_r2", "src/store.ts:14\nsrc/server.ts:88\nsrc/cli.ts:31"]]),
      calls(38, [
        [auditId, "Agent", { description: "Audit every reader of the settings store", prompt: "Audit every reader.", run_in_background: true, subagent_type: "frizz:high" }],
        [migrateId, "Agent", { description: "Write the migration and its rollback test", prompt: "Write the migration.", run_in_background: true, subagent_type: "frizz:high" }],
        [doneShellId, "Bash", { command: "npm test", description: "Running the integration suite", run_in_background: true }],
        [devId, "Bash", { command: "npm run dev", description: "Serving the API on port 4000", run_in_background: true }],
      ], "Two helpers are on the readers and the migration while the suite runs."),
      results(38, [[auditId, launched("siteA", auditFile)], [migrateId, launched("siteB", migrateFile)], [doneShellId, shellAck("bgsite02", suitePath)], [devId, shellAck("bgsite01", devPath)]]),
      steer(21, "Keep it readable from the CLI too. Support will want to inspect it."),
      say(20, "Understood. The CLI will read the same file, so it stays one store with one schema."),
      shellDone(11, "bgsite02", doneShellId, "Running the integration suite", suitePath),
      user(8, formatThreadMessage({ slug: "audit-store", title: "Audit src/store.js for correctness bugs" }, "The write path in `store.ts` is not atomic. If the store is persisted, write to a temp file and rename it.")),
      say(3, ["The store is scaffolded and the session registry already uses SQLite. One call is yours before I wire persistence.", "", question("settings-store", "Should the settings store use SQLite or a JSON file?", [
        ["SQLite", "Transactional, matches how sessions are already stored", true],
        ["JSON file", "Zero dependencies, editable by hand"],
      ])].join("\n")),
    ],
  })
  execFileSync("sqlite3", ["-cmd", ".timeout 15000", db, `INSERT OR REPLACE INTO pr_watch (project_id, id, thread_slug, owner, repo, number, state, created_at, settled_at, cursor)
    VALUES (${sql(projects[API].id)}, 'prw-hero', ${sql(slug)}, 'acme', 'acme-api', 412, 'armed', ${Date.now() - 20 * 60_000}, NULL, NULL)`])
  execFileSync("sqlite3", ["-cmd", ".timeout 15000", db, `INSERT OR REPLACE INTO settings (project_id, key, value) VALUES (${sql(projects[API].id)}, 'waker.github.status.v1', ${sql(JSON.stringify({ "acme/acme-api#412": { checks: "running", running: 2, passed: 13, failed: 0, failing: [], merge: "blocked", state: "open", polledAt: ago(2) } }))})`])
  await api.mutate("upsertOwnLink", { slug, label: "API dev server", target: "http://127.0.0.1:4000/" })
  await api.mutate("upsertOwnLink", { slug, label: "Storage notes", target: join(dir, "README.md") })
  await api.mutate("upsertOwnLink", { slug, label: "Migration plan", target: join(dir, "package.json") })
}

// ---- the rest of the queue ----
write(API, "api-table", {
  title: "Add API table to README and query curl examples", rested: 44,
  records: [
    user(70, "Add an API table to the README, plus a curl example for every query endpoint."),
    say(44, "README now carries a nine-row API table and a curl example under each of the four query endpoints. `npm run docs:lint` is clean.\n\n```awaiting\ntitle: Publish the docs site\nsteps:\n  - Open the [docs deploy](https://example.com/deploy) and approve the release.\n---\nThe preview build is green.\n```"),
  ],
})
write(API, "retry-backoff", {
  title: "Fix the retry backoff on the flaky upload", rested: 18,
  records: [
    user(52, "The upload fails about one run in twenty. Fix the retry."),
    say(18, "```done\ntitle: Exponential backoff on the upload\n---\n- Fixed the retry in `src/upload.ts`: it doubles from 100ms, capped at five tries.\n- Added a regression test; `npm test` green.\n```"),
  ],
})

// A Codex thread beside the Claude ones. Its transcript is a rollout, found by the id on its row.
{
  const slug = "flag-parser", rollout = "11111111-2222-4333-8444-555555555555"
  const shard = join(home, ".codex", "sessions", "2026", "11", "04")
  mkdirSync(shard, { recursive: true })
  const ev = (min, payload) => JSON.stringify({ timestamp: ago(min), type: "event_msg", payload })
  const closing = "The CLI now parses flags through `parseArgs`. All 41 CLI tests pass, and the old parser is gone."
  writeFileSync(join(shard, `rollout-2026-11-04T10-00-00-${rollout}.jsonl`), [
    JSON.stringify({ timestamp: ago(60), type: "session_meta", payload: { id: rollout, cwd: projects[API].dir } }),
    JSON.stringify({ timestamp: ago(60), type: "turn_context", payload: { model: "gpt-5-codex", effort: "high", sandbox_policy: { type: "workspace-write" } } }),
    ev(60, { type: "user_message", message: "TASK:\nMove the CLI to the new flag parser." }),
    ev(60, { type: "task_started" }),
    ev(31, { type: "agent_message", message: closing, phase: "final_answer" }),
    ev(31, { type: "task_complete", last_agent_message: closing }),
  ].join("\n") + "\n")
  execFileSync("sqlite3", ["-cmd", ".timeout 15000", db, `INSERT OR REPLACE INTO session (project_id, slug, session_id, agent_session_id, thread_name, spawned_at, title, backend, codex_runtime, model, effort, permission_mode, rested_at)
    VALUES (${sql(projects[API].id)}, ${sql(slug)}, ${sql(rollout)}, ${sql(rollout)}, ${sql(`frizz-${slug}`)}, ${sql(ago(60))}, 'Move the CLI to the new flag parser', 'codex', 'app-server', 'gpt-5-codex', 'high', 'default', ${sql(ago(31))})`])
}

// ---- running ----
const running = (slug, title, gerund, command = "npm test") => write(API, slug, {
  title, rested: null,
  records: [
    user(9, title + "."),
    calls(0.2, [[`toolu_${slug}`, "Bash", { command, description: gerund }]]),
  ],
})
running("audit-store", "Audit src/store.js for correctness bugs", "Reading src/store.js", "cat src/store.js")
running("receipt-bus", "Fix the flaky receipt-bus test", "Running the focused tests")
running("vite-8", "Upgrade Vite to 8 and fix the build", "Running the production build", "npm run build")

// ---- snoozed ----
const parked = (slug, title, minutes, closing) => write(API, slug, {
  title, rested: 60, snoozedUntil: later(minutes),
  records: [user(90, title + "."), say(60, closing)],
})
parked("deploy-errors", "Watch the deploy error rate", 45, "The deploy is out. The error rate is flat so far; I will read it again after the morning peak.")
parked("changelog", "Draft the 2.4 changelog", 16 * 60, "The changelog is drafted and needs a read tomorrow.")
parked("quota-estimator", "Re-run the quota estimator", 3 * 60, "The estimator needs the window to reset before it can run again.")

// ---- other projects, so the rail carries counts ----
const queued = (project, slug, title, min, done, first) => write(project, slug, {
  title, rested: min,
  records: [user(min + 20, title + "."), say(min, `${first}\n\n\`\`\`done\ntitle: ${title}\n---\n${done.map((d) => `- ${d}`).join("\n")}\n\`\`\``)],
})
queued("acme-web", "checkout-copy", "Tighten the checkout copy", 12, ["Rewrote the three checkout steps in `src/checkout/copy.ts`.", "Updated the snapshot tests; `npm test` is green."], "The checkout reads in half the words now, and nothing about the flow changed.")
queued("acme-web", "nav-a11y", "Fix keyboard focus in the nav", 33, ["Fixed the focus trap in `src/nav/Menu.tsx`.", "Added a keyboard test that walks the whole menu."], "Tab now moves through the nav in order, and Escape returns focus to the button that opened the menu.")
queued("mobile-app", "app-icons", "Regenerate the app icons", 26, ["Regenerated every size in `assets/icons/`.", "Updated the asset catalog."], "All the app icons are regenerated.")
queued("design-system", "token-rename", "Rename the colour tokens", 21, ["Renamed 48 tokens in `tokens/colors.json`.", "Added a codemod for projects still on the old names."], "Every colour token now says what it is for, not what shade it is.")
queued("docs", "api-reference", "Regenerate the API reference", 5, ["Regenerated `reference/api.md` from the OpenAPI spec.", "Fixed the two endpoints the old generator dropped."], "The reference now matches the spec, including the two endpoints the old generator skipped.")
queued("docs", "broken-links", "Fix the broken links", 44, ["Fixed 17 broken links across `guides/`.", "Added a link check to CI."], "All 17 broken links are fixed, and CI now fails on a new one.")
queued("docs", "search-index", "Rebuild the search index", 70, ["Rebuilt the index in `scripts/search.ts`.", "Search now covers the changelog."], "The index is rebuilt and now covers the changelog.")

await api.mutate("settingsSet", { ...(await api.query("settingsGet")), projectRail: true })
// A project counts on the rail once its board is open, so open them all now.
for (const { id } of Object.values(projects)) await createRpcClient(`http://127.0.0.1:${port}/`, id).query("board")
} // the hero set

if (features) await seedFeatures()
// Everything to stop with the stack.
const pidFile = join(home, "scene-pids.json")
writeFileSync(pidFile, JSON.stringify([...(existsSync(pidFile) ? JSON.parse(readFileSync(pidFile, "utf8")) : []), ...pids]))
console.log(JSON.stringify({ pids }))
process.exit(0)
