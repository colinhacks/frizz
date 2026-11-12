import assert from "node:assert/strict"
import test from "node:test"

// On the full-screen page (`/thread/<slug>`) the ops over the prompt box give way to the rail beside the
// column (maintainer 2026-10-02: "it's already showing up in the sidebar to the right") — so the rail has to carry every row the
// line of counts holds, and the line has to come back the moment the window is too narrow for the rail.
// Real server, real tailer, real broker-row thread; only the absent launcher status probe is stubbed.
// Boot scripts/adhoc-stack.mjs, then scripts/seed-full-rail-ops.mjs --port=<its port> --home=<its HOME>.
// FRIZZ_FULL_RAIL_OPS_E2E_URL=http://127.0.0.1:<port> nub run test <this file>
// Through the suite's runner, not a bare `nub --test`: nub 0.9.5 runs a file handed to `nub --test` twice
// at once (in the runner process AND in its test child), and two copies of this test race one stack.
// Step 4 clears a row, so every run needs a fresh seed.
const baseUrl = process.env.FRIZZ_FULL_RAIL_OPS_E2E_URL

test("the full-screen page lists the thread's ops in its rail, and over the prompt box only once the rail is gone", { skip: !baseUrl, timeout: 120_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()) })
    await page.setRequestInterception(true)
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/_frizz/control/status") {
        void r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 1, state: "ready", updateRestart: false }) })
      } else void r.continue()
    })
    const railKinds = () => page.$$eval("[data-focus-rail] [data-wait-row]", (rows) => rows.map((r) => (r as HTMLElement).dataset.waitKind).sort())
    const stripIn = (scope: string) => page.$(`${scope} [data-background-ops], ${scope} [data-queue-ops-summary]`)

    // 1. Wide enough for the rail: every row is there, and none of them is under the prompt box.
    await page.setViewport({ width: 1440, height: 900 })
    await page.goto(`${baseUrl}/thread/full-rail-ops`, { waitUntil: "networkidle2" })
    await page.waitForFunction(() => document.querySelectorAll("[data-focus-rail] [data-wait-row]").length === 6)
    assert.deepEqual(await railKinds(), ["agent", "agent", "link", "link", "shell", "shell"])
    assert.equal(await stripIn("[data-standalone-thread]"), null, "the prompt box must not repeat the rail's rows")

    // THE TWO ROWS THE RAIL USED TO DROP (until 2026-10-05), so on full screen they were shown nowhere: a
    // sub-agent quiet past its window, and a shell the OS reports gone. Each says what it is by its MARK
    // and its tooltip; the status is the elapsed time alone (2026-10-08). The shell's verdict lands a
    // probe tick after the first board read, so it is waited for rather than read once.
    const railRow = (id: string) => `[data-focus-rail] [data-wait-row="${id}"]`
    const statusOf = (id: string) => page.$eval(`${railRow(id)} [data-wait-status]`, (el) => (el as HTMLElement).innerText)
    assert.match(await statusOf("toolu_fro_agent2"), /^\d+[smhdw]/)
    assert.equal(await page.$(`${railRow("toolu_fro_agent2")} [class*="animate-spin"]`), null, "a stale sub-agent does not spin")
    assert.ok(await page.$(`${railRow("toolu_fro_agent2")} .rounded-full.bg-muted\\/30`), "…it wears the stale dot")
    assert.equal(await page.$(`${railRow("toolu_fro_agent")} [class*="animate-spin"]`) !== null, true, "the live one still spins")
    await page.waitForSelector(`${railRow("toolu_fro_sh2")} [title*="its process has exited"]`)
    assert.equal(await page.$(`${railRow("toolu_fro_sh2")} svg.text-shell`), null, "a dead shell does not wear the live shell blue")
    assert.match(await statusOf("toolu_fro_sh1"), /^\d+[smhdw]/)
    assert.ok(await page.$(`${railRow("toolu_fro_sh1")} svg.text-shell`), "the live shell wears the shell blue")
    // A saved URL is a real link out; a saved file opens in the page's own viewer.
    assert.equal(await page.$eval('[data-focus-rail] [data-wait-kind="link"] a', (a) => a.getAttribute("href")), "http://127.0.0.1:5173/project/demo")
    await page.click('[data-focus-rail] [data-wait-kind="link"] button')
    await page.waitForFunction(() => document.querySelectorAll("[data-file-viewer-slot]").length === 1)
    await page.keyboard.press("Escape")
    await page.waitForFunction(() => document.querySelectorAll("[data-file-viewer-slot]").length === 0)

    // 2. Narrower than the split: the rail is not drawn, so the line of op counts over the prompt box —
    // the drawer's and the queue card's, since 2026-10-09 — is the only place these rows are, one hover
    // away. A live resize, not a fresh load — the page has to follow the window as it changes.
    await page.setViewport({ width: 1000, height: 900 })
    await page.waitForSelector("[data-standalone-thread] [data-queue-ops-summary] button")
    const counts = await page.$$eval("[data-standalone-thread] [data-ops-count]", (els) => els.map((el) => (el as HTMLElement).innerText.replace(/\s+/g, " ").trim()))
    assert.deepEqual(counts, ["2 agents", "2 shells", "1 file", "1 link"])
    // Each count opens a panel of its own rows (2026-10-11), so between them the four panels hold all
    // six, and each row is in exactly the panel its count names.
    const narrowRows = {
      agent: ["Verify the rail carries every row", "Audit the old projection"],
      shell: ["Run the dev server", "Tail the old log"],
      file: ["Working plan"],
      link: ["Open dev server"],
    }
    for (const [kind, rows] of Object.entries(narrowRows)) {
      await page.hover(`[data-standalone-thread] [data-ops-count="${kind}"]`)
      await page.waitForSelector(`[data-queue-ops-panel="${kind}"]`)
      await page.waitForFunction(() => document.querySelectorAll("[data-queue-ops-panel]").length === 1)
      const panel = await page.$eval(`[data-queue-ops-panel="${kind}"]`, (el) => (el as HTMLElement).innerText)
      for (const row of rows) assert.ok(panel.includes(row), `the narrow ${kind} panel lists "${row}"`)
      for (const other of Object.values(narrowRows).flat().filter((row) => !rows.includes(row))) {
        assert.ok(!panel.includes(other), `the narrow ${kind} panel does not list "${other}"`)
      }
    }
    await page.mouse.move(0, 0)
    await page.waitForFunction(() => !document.querySelector("[data-queue-ops-panel]"))

    // 3. Back to wide: the line yields to the rail again.
    await page.setViewport({ width: 1440, height: 900 })
    await page.waitForFunction(() => !document.querySelector("[data-standalone-thread] [data-queue-ops-summary]"))

    // 4. …and with it the strip's ×, which the rail carries under the strip's own gate (it had none until
    // 2026-10-05, so full screen wide offered no way to stop or clear a row). A stale row's × CLEARS — nothing
    // runs to stop — so pressing the gone shell's retires it through the real server, without opening
    // the drawer the rest of its row opens.
    assert.ok(await page.$(`${railRow("toolu_fro_agent2")} button[aria-label="Clear sub-agent: Audit the old projection"]`), "the stale child offers Clear")
    await page.click(`${railRow("toolu_fro_sh2")} button[aria-label="Clear background shell: Tail the old log"]`)
    await page.waitForFunction((sel) => !document.querySelector(sel), {}, railRow("toolu_fro_sh2"))
    assert.equal(await page.$(".frizz-sheet-panel"), null, "the × did not open the shell's drawer")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
