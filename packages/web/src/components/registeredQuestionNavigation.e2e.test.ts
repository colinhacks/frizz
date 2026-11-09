import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import test from "node:test"
import { createRpcClient } from "../../../../scripts/lib/rpc-client.mjs"

// A real two-project adhoc-stack, no provider required. The session row is the simulated worker;
// questions are registered and answered through the real RPC. Both variables come from the stack.
// Create two empty directories, then start the stack in a separate terminal:
//   nub scripts/adhoc-stack.mjs --port=45837 --project=/abs/a --also-project=/abs/b
// Its first JSON line contains the sandbox "home" field. With the stack still running:
//   FRIZZ_QUESTION_NAVIGATION_E2E_URL=http://127.0.0.1:45837 \
//   FRIZZ_QUESTION_NAVIGATION_E2E_HOME=<the "home" field> nub --test \
//     packages/web/src/components/registeredQuestionNavigation.e2e.test.ts
// Stop the disposable stack with Ctrl-C when finished.
const baseUrl = process.env.FRIZZ_QUESTION_NAVIGATION_E2E_URL
const home = process.env.FRIZZ_QUESTION_NAVIGATION_E2E_HOME

test("registered picks survive fullscreen, project switches and reload, then clear only after a successful send", {
  skip: !baseUrl || !home, timeout: 120_000,
}, async () => {
  const api = createRpcClient(baseUrl!)
  const projects = await api.query("projectsList") as Array<{ id: string; slug: string }>
  assert.ok(projects.length >= 2)
  const [a, b] = projects
  const slug = "question-navigation"
  const db = join(home!, ".frizz", "ui.db")
  for (const [i, project] of [a, b].entries()) {
    execFileSync("sqlite3", [db, `INSERT OR REPLACE INTO session
      (project_id, slug, session_id, thread_name, spawned_at, title, backend, claude_runtime, model, effort, permission_mode, rested_at)
      VALUES ('${project.id}', '${slug}', 'aabbccdd-0000-4000-9000-00000000000${i}', 'frizz-${slug}',
      '2026-10-09T00:00:00Z', 'Question navigation', 'claude', 'broker', 'opus', 'high', 'default', '2026-10-09T00:01:00Z')`])
  }
  const projectApi = createRpcClient(baseUrl!, a.slug)
  const asked = await projectApi.mutate("ask", { slug, questions: [
    { kind: "question", question: "Land the fix?", options: [
      { label: "Land it", followUps: [{ kind: "multi", question: "Which gates?", options: [{ label: "Tests" }, { label: "Browser" }] }] },
      { label: "Hold it" },
    ] },
    { kind: "question", question: "Where should it ship?", options: [{ label: "Local main" }, { label: "Release" }] },
  ] }) as { registered: Array<{ id: string }> }
  await createRpcClient(baseUrl!, b.slug).mutate("ask", { slug, questions: [
    { kind: "question", question: "Other project", options: [{ label: "Other first" }, { label: "Other second" }] },
  ] })
  const [tree, single] = asked.registered.map((q) => `[data-question-id='${q.id}']`)
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless({ protocolTimeout: 30_000 })
  const errors: string[] = []
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1200, height: 1100, deviceScaleFactor: 2 })
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }])
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => {
      // adhoc-stack has no launcher control server; throwaway projects have no icon. These 404s
      // are the app's normal fallback, unrelated to answering. The one 500 below is deliberate.
      const url = m.location().url ?? ""
      if (m.type() === "error" && !/\/_frizz\/(control\/status|project-icon)/.test(url)
        && !(/\/rpc\/followUp$/.test(url) && /status of 500/.test(m.text()))) errors.push(`${m.text()} ${url}`)
    })
    await page.goto(`${baseUrl}/project/${a.slug}`, { waitUntil: "networkidle2" })
    await page.waitForSelector(tree)
    const pick = async (card: string, index: number) => {
      await page.$$eval(`${card} [data-question-option]`, (rows, i) => (rows[i].querySelector("button") as HTMLButtonElement).click(), index)
    }
    await pick(tree, 0)
    await page.waitForFunction((sel) => document.querySelectorAll(`${sel} [data-question-option]`).length === 4, {}, tree)
    await pick(tree, 2)
    await pick(tree, 3)
    await pick(single, 1)
    const texts = `${tree} textarea[data-surface='questionAnswer']`
    const handles = await page.$$(texts)
    await handles[1].type("also typecheck")
    const check = async () => {
      await page.waitForFunction((sel) => document.querySelectorAll(`${sel} [data-question-option]`).length === 4, {}, tree)
      assert.deepEqual(await page.$$eval(`${tree} [data-question-option]`, (rows) => rows.map((el) => el.classList.contains("border-selection-border"))), [true, false, true, true])
      assert.deepEqual(await page.$$eval(`${single} [data-question-option]`, (rows) => rows.map((el) => el.classList.contains("border-selection-border"))), [false, true])
      assert.equal(await page.$$eval(texts, (els) => (els[1] as HTMLTextAreaElement).value), "also typecheck")
    }
    await check()
    // The real fullscreen door unmounts the board and creates a fresh answering provider.
    await page.$eval(`[data-expand-thread='${slug}']`, (el) => (el as HTMLAnchorElement).click())
    await page.waitForSelector("main[data-standalone-thread]")
    await check()
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => !/\/thread\/[^/]+$/.test(location.pathname))
    await check()
    // Client-side project switches remount App. The same thread slug in B must not inherit A's picks.
    const switchProject = async (project: string) => {
      const link = `a[href='/project/${project}']`
      await page.waitForSelector(link)
      await page.$eval(link, (el) => (el as HTMLAnchorElement).click())
      await page.waitForFunction((path) => location.pathname === path, {}, `/project/${project}`)
    }
    // The home button leads to the grid; its project links exercise the SPA switch, not a new document.
    const grid = async () => {
      // PROJECTS_HREF (lib/homeView.ts): the grid's own address, which never forwards to a kept Console.
      await page.$eval("a[href^='/?']", (el) => (el as HTMLAnchorElement).click())
      await page.waitForFunction(() => location.pathname === "/")
    }
    await grid()
    await switchProject(b.slug)
    await page.waitForSelector("[data-question-option]")
    assert.equal(await page.$$eval("[data-question-option]", (rows) => rows.some((el) => el.classList.contains("border-selection-border"))), false)
    await grid()
    await switchProject(a.slug)
    await check()
    await page.reload({ waitUntil: "networkidle2" })
    await check()
    // The answers leave through the prompt box's Send, on the follow-up path (2026-10-11): the cards
    // draw no "Send answers" of their own beside a prompt box. A rejected send keeps the staged picks
    // and says so in a toast. A successful real one settles the questions and clears the cache.
    assert.equal(await page.$("[data-send-answers]"), null)
    const send = "[data-send-split] [data-send]"
    assert.equal(await page.$eval(send, (el) => (el as HTMLButtonElement).disabled), false, "staged answers arm the Send with nothing typed")
    let reject = true
    await page.setRequestInterception(true)
    page.on("request", (r) => {
      if (reject && /\/rpc\/followUp$/.test(r.url())) {
        reject = false
        void r.respond({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Test rejection" }) })
      } else void r.continue()
    })
    await page.$eval(send, (el) => (el as HTMLButtonElement).click())
    await page.waitForFunction(() => [...document.querySelectorAll("[data-toast]")].some((el) => /Test rejection/.test(el.textContent ?? "")))
    await check()
    // Both shapes are staged before the send: the picks and the follow-up's typed text.
    const ids = asked.registered.map((q) => q.id)
    const draftKeys = () => page.evaluate((ids) => {
      const raw = localStorage.getItem("frizz-drafts:v1")
      return Object.keys(raw ? JSON.parse(raw).entries : {}).filter((k) => k.startsWith("question:") && ids.some((id) => k.includes(id)))
    }, ids)
    const before = await draftKeys()
    assert.ok(before.some((k) => k.endsWith(":picks")) && before.some((k) => !k.endsWith(":picks")), before.join(" "))
    await page.$eval(send, (el) => (el as HTMLButtonElement).click())
    // The board push can drop the registration before the reply lands, so only the keys captured at send
    // can clear the text draft. Wait for the answer to settle, then require that every key is gone.
    await page.waitForFunction(() => {
      const raw = localStorage.getItem("frizz-drafts:v1")
      return !raw || !Object.keys(JSON.parse(raw).entries).some((k) => k.includes("question-navigation") && k.endsWith(":picks"))
    })
    assert.deepEqual(await draftKeys(), [])
    const settled = JSON.parse(execFileSync("sqlite3", [db, `SELECT answer FROM thread_question WHERE id = '${asked.registered[0].id}'`], { encoding: "utf8" }))
    assert.deepEqual(settled.chosen, ["Land it"])
    assert.deepEqual(settled.followUps[0].chosen, ["Tests", "Browser"])
    assert.equal(settled.followUps[0].text, "also typecheck")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
