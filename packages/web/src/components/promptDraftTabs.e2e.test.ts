import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import test from "node:test"
import { createRpcClient } from "../../../../scripts/lib/rpc-client.mjs"

// A thread's prompt box is ONE box: the board pane's and its /full page's, in the same tab or in two.
// The fullscreen door is a real link, so ⌘-click and middle-click open /full in a NEW tab — which, while
// drafts were per-tab sessionStorage, opened on an empty box (maintainer 2026-10-11: "The stuff that I
// type into the prompt box when it's in the queue does not transfer over if I open that same queue card
// in full-screen view"). The queue card that quote names was replaced by the one-thread pane on
// 2026-11-09: a queued thread now opens in the pane's column, and the door's PLAIN click folds that pane
// in place (lib/threadPane foldPane) instead of opening a page, so the same composer goes full screen; the
// address follows it to the thread's own path since 2026-11-11.
//
// A real adhoc-stack, no provider required: the session row is the simulated worker, and nothing is
// ever sent. Start the stack in a separate terminal:
//   nub scripts/adhoc-stack.mjs --port=45911
// Its first JSON line contains the sandbox "home" field. With the stack still running:
//   FRIZZ_PROMPT_DRAFT_TABS_E2E_URL=http://127.0.0.1:45911 \
//   FRIZZ_PROMPT_DRAFT_TABS_E2E_HOME=<the "home" field> nub run test \
//     packages/web/src/components/promptDraftTabs.e2e.test.ts
// Stop the disposable stack with Ctrl-C when finished.
const baseUrl = process.env.FRIZZ_PROMPT_DRAFT_TABS_E2E_URL
const home = process.env.FRIZZ_PROMPT_DRAFT_TABS_E2E_HOME

test("a draft typed in the board pane is in the thread's /full prompt box in another tab, and stays put when the pane folds to full screen", {
  skip: !baseUrl || !home, timeout: 120_000,
}, async () => {
  const api = createRpcClient(baseUrl!)
  const [project] = await api.query("projectsList") as Array<{ id: string; slug: string }>
  assert.ok(project)
  const slug = "prompt-draft-tabs"
  execFileSync("sqlite3", [join(home!, ".frizz", "ui.db"), `INSERT OR REPLACE INTO session
    (project_id, slug, session_id, thread_name, spawned_at, title, backend, claude_runtime, model, effort, permission_mode, rested_at)
    VALUES ('${project.id}', '${slug}', 'aabbccdd-0000-4000-9000-0000000000d1', 'frizz-${slug}',
    '2026-10-11T00:00:00Z', 'Prompt draft tabs', 'claude', 'broker', 'opus', 'high', 'default', '2026-10-11T00:01:00Z')`])
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless({ protocolTimeout: 30_000 })
  const errors: string[] = []
  try {
    const open = async () => {
      const page = await browser.newPage()
      await page.setViewport({ width: 1400, height: 1000 })
      await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }])
      page.on("pageerror", (e) => errors.push(String(e)))
      page.on("console", (m) => {
        // adhoc-stack has no launcher control server; throwaway projects have no icon. These 404s
        // are the app's normal fallback, unrelated to drafts.
        const url = m.location().url ?? ""
        if (m.type() === "error" && !/\/_frizz\/(control\/status|project-icon)/.test(url)) errors.push(`${m.text()} ${url}`)
      })
      return page
    }
    const pane = "[data-pane-thread]"
    const paneBox = `${pane} [data-thread-composer-box='chatComposer'] textarea`
    const door = `${pane} [data-expand-thread='${slug}']`
    const fullBox = "[data-standalone-thread] [data-thread-composer-box='chatComposer'] textarea"
    type Tab = Awaited<ReturnType<typeof open>>
    // Polled on a timer, not on animation frames (puppeteer's default): one of the two tabs is always
    // in the background here, and a hidden tab is not promised a frame.
    const holds = (page: Tab, box: string, text: string) =>
      page.waitForFunction((box, text) => (document.querySelector(box) as HTMLTextAreaElement | null)?.value === text, { polling: 100 }, box, text)

    const board = await open()
    // The pane remembers full screen and a hidden rail across loads; start from the default layout.
    await board.evaluateOnNewDocument(() => localStorage.removeItem("frizz.threadPanePrototype.v1"))
    // The queued thread's board link opens it in the pane (as its card did, until 2026-11-09).
    await board.goto(`${baseUrl}/project/${project.slug}?thread=${slug}`, { waitUntil: "networkidle2" })
    await board.waitForSelector(paneBox, { timeout: 60_000 })
    await board.click(paneBox)
    await board.keyboard.type("typed in the pane")

    // 1. ANOTHER TAB — what ⌘-click on the pane's fullscreen door opens: the same href, a tab of its own.
    const href = await board.$eval(door, (el) => el.getAttribute("href"))
    const full = await open()
    await full.goto(`${baseUrl}${href}`, { waitUntil: "networkidle2" })
    await full.waitForSelector(fullBox)
    assert.equal(await full.$eval(fullBox, (el) => (el as HTMLTextAreaElement).value), "typed in the pane")

    // 2. The two stay ONE box while both are open: words added on /full reach the pane...
    await full.bringToFront()
    await full.click(fullBox)
    await full.keyboard.type(", finished on /full")
    await holds(board, paneBox, "typed in the pane, finished on /full")
    // ...and emptying it in the pane (what a send does) empties /full, so nothing is left to send twice.
    await board.bringToFront()
    await board.click(paneBox)
    await board.$eval(paneBox, (el) => (el as HTMLTextAreaElement).select())
    await board.keyboard.press("Backspace")
    await holds(board, paneBox, "")
    await holds(full, fullBox, "")

    // 3. THIS TAB — the door's plain click. In the pane it is no new page: the pane folds to full screen in
    // place, the same thread in the same composer, and the draft is still in it (and still in the /full
    // tab, which follows it). The address moves to the thread's own path, the door's own href, which is a
    // route of the same board (lib/threadPane.ts), so nothing remounts.
    await board.keyboard.type("carried through the door")
    await board.$eval(paneBox, (el) => { (el as HTMLTextAreaElement & { __kept?: boolean }).__kept = true })
    await board.$eval(door, (el) => (el as HTMLAnchorElement).click())
    await board.waitForSelector("[data-pane-layout='folded']")
    await board.waitForFunction((href) => location.pathname === href, {}, href)
    assert.equal(await board.$eval(paneBox, (el) => (el as HTMLTextAreaElement & { __kept?: boolean }).__kept === true), true, "the same prompt box, not a remounted one")
    assert.equal(await board.$eval(paneBox, (el) => (el as HTMLTextAreaElement).value), "carried through the door")
    await holds(full, fullBox, "carried through the door")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
