import assert from "node:assert/strict"
import test from "node:test"

// Opt-in like the other *.e2e.test.ts here. Needs a REAL Frizz serving at least two projects — the
// settings drawer only mounts inside a board, and the bug is in the seam between a client-side
// project switch and the per-project query cache — which `scripts/adhoc-stack.mjs` builds in one command:
//   nub scripts/adhoc-stack.mjs --port=45782 --project=/abs/a --also-project=/abs/b > /tmp/stack.log 2>&1 &
//   FRIZZ_PROJECT_RAIL_E2E_URL=http://127.0.0.1:45782 nub run test \
//     packages/web/src/lib/projectRail.e2e.test.ts
const baseUrl = process.env.FRIZZ_PROJECT_RAIL_E2E_URL

// THE RAIL FOLLOWS THE SETTING WITHOUT A RELOAD, after a client-side project switch. `["settingsGet"]`
// hashes under the project the URL names at render time (lib/queryKeyScope.ts), and the layout that
// hosts the rail is mounted once and never re-rendered by a navigation — so the rail's query stayed
// bound to the project it was cold-loaded on (the grid's "" scope), while the drawer wrote its save
// under the board's scope. The select flipped to "Always shown" and the rail did not appear until a
// reload happened to land on a board (maintainer 2026-08-24: "it literally only shows up when I'm in
// the home page"). Every piece is fine in isolation; only a real navigation followed by a real save
// reaches the seam, so this drives exactly that sequence.
test("flipping 'Project sidebar' on a board reached from the grid shows the rail without a reload", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  // Start from HIDDEN, whatever the sandbox was left at. `projectRail` is a machine setting, so the
  // unprefixed (launching-project) write is the one every board reads.
  const rpc = `${baseUrl}/_frizz/rpc`
  const headers = { origin: baseUrl!, "content-type": "application/json" }
  const current = (await (await fetch(`${rpc}/settingsGet`, { headers })).json()) as { result: Record<string, unknown> }
  const reset = await fetch(`${rpc}/settingsSet`, { method: "POST", headers, body: JSON.stringify({ ...current.result, projectRail: false }) })
  assert.equal(reset.status, 200, `settingsSet must succeed: ${await reset.text()}`)

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    const rail = () => page.evaluate(() => document.querySelector('nav[aria-label="Projects"]') !== null)

    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle2" })
    assert.equal(await rail(), false, "the rail starts hidden on the grid")

    // Into a board CLIENT-SIDE, through the grid's own tile — a document load would rebind the cache.
    const slug = await page.evaluate(() => {
      const a = document.querySelector<HTMLAnchorElement>('a[href^="/project/"]')
      a?.click()
      return a?.getAttribute("href")?.split("/")[2]
    })
    assert.ok(slug, "the grid lists at least one project")
    await page.waitForFunction((s) => location.pathname === `/project/${s}`, {}, slug)
    await page.waitForSelector('[aria-label="Settings"]', { timeout: 15_000 })
    assert.equal(await rail(), false, "still hidden after the switch")

    await page.click('[aria-label="Settings"]')
    // "Project sidebar" is an Off/On pair under its label (SettingsDrawer's OnOffToggle); it was a select
    // with an "Always shown" item until the toggle replaced it. A real click, so the press has to reach
    // the drawer through whatever sits on top of it.
    const on = await page.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"][aria-label="Settings"] button[aria-pressed]')]
      .find((button) => button.textContent?.trim() === "On" && button.closest(".flex-col")?.textContent?.includes("Project sidebar")), { timeout: 10_000 })
    await (on as unknown as { click: () => Promise<void> }).click()

    // The save is one round trip; the rail must follow it on THIS page, not on the next load.
    await page.waitForFunction(() => document.querySelector('nav[aria-label="Projects"]') !== null, { timeout: 10_000 })
      .catch(() => assert.fail("the rail never appeared after the setting flipped — the drawer's save landed in a cache entry the rail was not reading"))
    assert.equal(page.url(), `${baseUrl}/project/${slug}`, "no navigation happened along the way")
    assert.deepEqual(errors, [], "no page errors")
  } finally {
    await browser.close()
  }
})

// THE RAIL IS THERE ON THE FIRST RENDER OF A RELOAD, before the server has answered. `projectRail`
// arrives in `settingsGet`, one round trip after React mounts, and the hook used to answer HIDDEN
// until then — so with the rail on, every refresh painted the page flush left and then pushed it 57px
// right when the answer came (maintainer 2026-08-25: "This is layout shift"). The hook now mirrors
// the last answer into localStorage and reads it while the query is pending. Holding the RPC response
// is what turns "a beat late" into something an assertion can see; the control clears the mirror and
// holds the same response, and the rail must NOT be there — otherwise the check would pass on a
// page that simply rendered the rail unconditionally.
test("reloading with the rail on renders it before settingsGet answers, from the localStorage mirror", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const rpc = `${baseUrl}/_frizz/rpc`
  const headers = { origin: baseUrl!, "content-type": "application/json" }
  const current = (await (await fetch(`${rpc}/settingsGet`, { headers })).json()) as { result: Record<string, unknown> }
  const set = async (projectRail: boolean) => {
    const r = await fetch(`${rpc}/settingsSet`, { method: "POST", headers, body: JSON.stringify({ ...current.result, projectRail }) })
    assert.equal(r.status, 200, `settingsSet must succeed: ${await r.text()}`)
  }
  await set(true)

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    const rail = () => page.evaluate(() => document.querySelector('nav[aria-label="Projects"]') !== null)

    // One ordinary load with the rail on: the server answers, the hook writes the mirror.
    await page.goto(`${baseUrl}/`, { waitUntil: "networkidle2" })
    assert.equal(await rail(), true, "the rail shows once settings have loaded")
    assert.equal(await page.evaluate(() => localStorage.getItem("frizz-project-rail")), "shown", "the mirror recorded the answer")

    // From here every settingsGet is HELD: the page renders, mounts, and never hears from the server.
    let held: Array<{ continue: () => Promise<void> }> = []
    let holding = false
    await page.setRequestInterception(true)
    page.on("request", (req) => {
      if (holding && /\/rpc\/settingsGet/.test(req.url())) held.push(req)
      else void req.continue()
    })
    const mounted = () => page.waitForSelector("#root > *", { timeout: 15_000 })

    holding = true
    await page.reload({ waitUntil: "domcontentloaded" })
    await mounted()
    // Give a wrong render every chance to happen: the request is in flight, nothing will answer it.
    await new Promise((r) => setTimeout(r, 500))
    assert.ok(held.length > 0, "the reload asked for settings (the hold is real)")
    assert.equal(await rail(), true, "the rail is on the first render, with settingsGet still unanswered")

    // CONTROL: no mirror, same hold — the rail must be absent, or the assertion above proved nothing.
    // The held requests are NOT released first: the answer would land in the old document and the
    // hook would write the mirror straight back, after this has cleared it. The reload cancels them.
    held = []
    await page.evaluate(() => localStorage.removeItem("frizz-project-rail"))
    await page.reload({ waitUntil: "domcontentloaded" })
    await mounted()
    await new Promise((r) => setTimeout(r, 500))
    assert.ok(held.length > 0, "the control reload asked for settings too")
    assert.equal(await rail(), false, "with no mirror and no answer the rail stays hidden (the server default)")

    for (const r of held) await r.continue()
    assert.deepEqual(errors, [], "no page errors")
  } finally {
    await browser.close()
    await set(false)
  }
})

// "ADD A PROJECT" ON THE RAIL, WITH NO PICKER TO OPEN, ASKS FOR THE FOLDER WHERE THE OPERATOR IS. The
// server answers `unavailable` when the machine has no folder picker, and at once when the page is on
// another machine than the picker would open on (server router `pickerOnAnotherScreen`). The rail then
// sent its operator to `/`, where nothing opened: the grid shows the typed-path dialog for its own click
// only, and `/` is the Console for whoever keeps it as home. It opens the dialog itself now.
//
// The picker's two procedures are answered HERE, in the page, and never reach the server: a real answer
// from this machine's own tab is a native panel on the screen of whoever runs the test.
test("the rail's Add a project, told there is no picker, opens the typed-path dialog in place", {
  skip: !baseUrl,
  timeout: 90_000,
}, async () => {
  const rpc = `${baseUrl}/_frizz/rpc`
  const headers = { origin: baseUrl!, "content-type": "application/json" }
  const current = (await (await fetch(`${rpc}/settingsGet`, { headers })).json()) as { result: Record<string, unknown> }
  const set = await fetch(`${rpc}/settingsSet`, { method: "POST", headers, body: JSON.stringify({ ...current.result, projectRail: true }) })
  assert.equal(set.status, 200, `settingsSet must succeed: ${await set.text()}`)
  const projects = (await (await fetch(`${rpc}/projectsList`, { headers })).json()) as { result: Array<{ slug: string }> }
  const slug = projects.result[0]?.slug
  assert.ok(slug, "the stack serves at least one project")
  const reason = "The folder picker opens on the computer running Frizz"

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    const asked: string[] = []
    await page.setRequestInterception(true)
    page.on("request", (request) => {
      const procedure = /\/rpc\/(projectPick(?:Warm)?)(?:\?|$)/u.exec(request.url())?.[1]
      if (!procedure) return void request.continue()
      asked.push(procedure)
      const result = procedure === "projectPick" ? { kind: "unavailable", reason } : { warming: false }
      void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ result }) })
    })
    const add = 'nav[aria-label="Projects"] button[aria-label="Add a project"]'
    const dialog = () => page.evaluate(() => document.querySelector('[role="dialog"]')?.textContent ?? null)

    for (const path of [`/project/${slug}`, "/console"]) {
      await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" })
      await page.waitForSelector(add, { visible: true, timeout: 30_000 })
      await page.click(add)
      await page.waitForFunction(() => document.querySelector('[role="dialog"]') !== null, { timeout: 5_000 })
        .catch(() => assert.fail(`${path}: no dialog opened, at ${page.url()}`))
      assert.equal(await dialog().then((text) => text?.includes(`${reason}. Paste the folder instead`)), true, `${path}: the dialog says why and what to do`)
      assert.equal(new URL(page.url()).pathname, path, "the operator is where they were")
      assert.equal(await page.$eval(add, (button) => (button as HTMLButtonElement).disabled), false, "the square is not left disabled")
      await page.keyboard.press("Escape")
      await page.waitForFunction(() => document.querySelector('[role="dialog"]') === null, { timeout: 5_000 })
    }
    assert.ok(asked.includes("projectPick"), "the click asked for the picker, and the page answered it")
    assert.deepEqual(errors, [], "no page errors")
  } finally {
    await browser.close()
  }
})
