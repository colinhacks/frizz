import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const quote = (s) => `'${String(s).replaceAll("'", "''")}'`

export async function seedLightModeFixture(stack, api) {
  const db = join(stack.home, ".frizz", "ui.db")
  const project = stack.launcher.dir
  const projectId = stack.launcher.id
  const state = join(stack.home, ".frizz", "projects", projectId)
  const dir = join(stack.home, ".claude", "projects", project.replace(/[/.]/g, "-"))
  mkdirSync(dir, { recursive: true })
  mkdirSync(join(state, "claude-broker"), { recursive: true })
  const timestamp = new Date(Date.now() - 60_000).toISOString()
  const richText = [
    "## A readable workspace in either appearance",
    "The same transcript keeps **important information**, *secondary context*, `inline code`, and [a link](https://example.com) legible.",
    "```typescript", "// Keep the theme choice in this browser", 'const appearance = { preference: "system", resolved: "light" };', "function applyTheme(value: string) { return value.length > 0 }", "```",
    "```diff", "- const cached = false", "+ const cached = true", "  return cached", "```",
    "```mermaid", "flowchart LR", "  A[Browser preference] --> B{System?}", "  B --> C[Light palette]", "  B --> D[Dark palette]", "```",
    "```mermaid", "sequenceDiagram", "  Browser->>Terminal: Apply palette", "  Terminal-->>Browser: Keep connection", "```",
    '::codex-inline-vis{file="theme-counter.html"}',
    "All renderers preserve their existing state when the palette changes.",
  ].join("\n\n")
  const fixtures = [
    { slug: "theme-rich", title: "Review the complete theme surface", text: richText },
    { slug: "theme-question", title: "Choose the next checkpoint", text: "The implementation is ready for a decision." },
    { slug: "theme-running", title: "Running the verification suite", text: "Checking the live renderers and their connection state.", running: true },
    { slug: "theme-snoozed", title: "Waiting for the nightly checks", text: "The scheduled checks are still running." },
    { slug: "theme-done", title: "Preserve the existing dark appearance", text: "```done\n- Preserved the existing dark palette.\n- Verified the first visible canvas.\n```", archived: true },
    { slug: "theme-invalid", title: "Recover from a malformed diagram", text: "```mermaid\nthis is not a valid diagram !\n```\n\n```mermaid\nflowchart LR\nA[Still renders] --> B[After a rejected job]\n```" },
  ]
  for (const fixture of fixtures) {
    const sessionId = randomUUID()
    fixture.sessionId = sessionId
    const records = [
      { type: "user", parentUuid: null, isSidechain: false, uuid: randomUUID(), timestamp, session_id: sessionId, cwd: project, message: { role: "user", content: `TASK:\n${fixture.title}` } },
      { type: "assistant", parentUuid: null, isSidechain: false, uuid: randomUUID(), timestamp, session_id: sessionId, cwd: project, message: { id: `msg_${fixture.slug}`, model: "claude-opus-5", type: "message", role: "assistant", content: [{ type: "text", text: fixture.text }, ...(fixture.running ? [{ type: "tool_use", id: "theme-verification", name: "Bash", input: { command: "nub --test", description: "Checking the live renderers" } }] : [])], stop_reason: fixture.running ? "tool_use" : "end_turn", usage: { input_tokens: 4200, output_tokens: 320 } } },
    ]
    if (fixture.slug === "theme-rich") {
      const tool = (id, name, input, content, error = false) => [
        { ...records[1], uuid: randomUUID(), message: { ...records[1].message, id: `msg_${id}`, content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" } },
        { ...records[0], uuid: randomUUID(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: error }] } },
      ]
      records.splice(1, 0,
        ...tool("theme-edit", "Edit", { file_path: join(project, "theme.ts"), old_string: "// Remember this browser\nconst palette = 'dark'", new_string: "// Follow the saved preference\nconst palette = 'light'" }, "Updated theme.ts"),
        ...tool("theme-read", "Read", { file_path: join(project, "theme.ts") }, "1\t// Follow the saved preference\n2\tconst palette = 'light'"),
        ...tool("theme-error", "Bash", { command: "nub --test missing.test.ts", description: "Checking an unavailable test" }, "Could not find missing.test.ts", true),
      )
    }
    writeFileSync(join(dir, `${sessionId}.jsonl`), records.map(JSON.stringify).join("\n") + "\n")
    const key = createHash("sha256").update(sessionId).digest("hex").slice(0, 16)
    writeFileSync(join(state, "claude-broker", `${key}.json`), JSON.stringify({ sessionId, daemonPid: process.pid, socketPath: join(state, "fixture.sock") }))
    execFileSync("sqlite3", [db, `INSERT INTO session (project_id,slug,session_id,thread_name,spawned_at,title,backend,claude_runtime,model,effort,permission_mode,rested_at) VALUES (${[projectId, fixture.slug, sessionId, `frizz-${fixture.slug}`, timestamp, fixture.title, "claude", "broker", "opus", "high", "default"].map(quote).join(",")},${fixture.running ? "NULL" : quote(timestamp)})`])
  }
  const vis = join(project, ".codex", "visualizations", "2026", "09", "11", fixtures[0].sessionId)
  mkdirSync(vis, { recursive: true })
  writeFileSync(join(vis, "theme-counter.html"), `<section class="card">
<h2 style="margin:0 0 12px">Interactive visualization</h2>
<div class="viz-controls"><label class="form-label">Value <input id="value" class="form-control" value="42"></label><button id="increment" class="btn">Increment</button></div>
<div id="series" style="height:35px;margin-top:14px;display:flex;gap:8px">${[1,2,3,4,5,6].map(n => `<span style="flex:1;background:var(--viz-series-${n})"></span>`).join("")}</div>
<p class="text-muted">State remains here while the host changes appearance.</p>
</section><script>window.mountIdentity = Math.random(); window.themeEvents = 0; addEventListener("frizz-theme-change", () => window.themeEvents++); document.querySelector("#increment").onclick = () => document.querySelector("#value").value = String(Number(document.querySelector("#value").value)+1);</script>`)
  for (let i = 0; i < 60; i++) {
    const board = await api.query("board")
    if (board.threads.some(t => t.id === "theme-rich")) break
    await new Promise(r => setTimeout(r, 250))
  }
  await api.mutate("setThreadState", { slug: "theme-done", state: "archived" })
  await api.mutate("setThreadState", { slug: "theme-invalid", state: "archived" })
  await api.mutate("setThreadSnooze", { slug: "theme-snoozed", sessionId: fixtures[3].sessionId, until: new Date(Date.now() + 3_600_000).toISOString() })
  await api.mutate("ask", { slug: "theme-question", questions: [{ question: "Which checkpoint should run next?", kind: "question", options: [{ label: "Renderer checks", description: "Verify state survives an appearance change", recommended: true }, { label: "Navigation checks", description: "Verify the first visible canvas on every route" }] }] })
  return fixtures
}
