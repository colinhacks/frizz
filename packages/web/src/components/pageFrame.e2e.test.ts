import assert from "node:assert/strict"
import test from "node:test"

// BOTH PAGE SHELLS FOLLOW THE SERVER — the board and the full-screen thread page alike, because what a
// tab does about the server it is talking to is components/PageFrame.tsx's and neither shell's own.
// It was the board's alone until 2026-10-13: a tab on `/thread/<slug>/full` showed no overlay while the
// server was down, kept running the old bundle against the new server after "Update & restart", and,
// cold-loaded there, never raised a desktop notification (the setting was mirrored onto the store by
// App.tsx and by nothing else).
//
// Real server, real broker, real settings RPC; the worker is the scripted one, so nothing signs in:
//   nub scripts/adhoc-stack.mjs --port=<port> --project=<a throwaway git repo> --claude-bin=$PWD/scripts/scripted-claude.mjs
//   FRIZZ_PAGE_FRAME_E2E_URL=http://127.0.0.1:<port> nub run test <this file>
// A dev stack has no launcher, so `/_frizz/control/status` is the one thing answered here rather than
// by the server — which is also what lets the test say "restarting" and name a second build. The poll
// is woken with the app's own wake event (api/supervisorStatus.ts) instead of waiting out its 8s rest
// cadence. The Escape test's stalled hold is three minutes of silence, so it answers 503 and moves the
// page's clock instead of waiting them out; its drawer is a WORKING thread's, since a queued thread's
// link opens its card (that worker runs for about two minutes: kill the stack's workers with the
// stack). The notification half replaces `Notification` and `document.hidden` in the page, since a
// headless tab is always the visible one and has nowhere to show a notification; the event itself is
// the server's own `notify` for a scripted turn that ends, read off the feed's socket for the control.
// The test writes the stack's `notifications` setting and leaves it off.
const baseUrl = process.env.FRIZZ_PAGE_FRAME_E2E_URL

const OVERLAY = '[role="alertdialog"][aria-label="Updating and restarting Frizz"]'
const WAKE = "frizz:supervisor-status-wake"
const ARMED = "frizz:reload-after-update-restart"

type Page = import("puppeteer").Page
type Shell = { name: string; url: string; root: string }
type Answer = { state: "ready" | "restarting"; artifactDigest: string }
type AppStore = typeof import("../store.ts")
type PageGlobals = {
  frizzPageFrameE2eStore: () => Promise<AppStore>
  frizzPageFrameE2eNotifications: { title: string; tag?: string }[]
  frizzPageFrameE2eMarker?: boolean
}

// One scripted thread at rest, for the full-screen page to show and the board to queue; and the two
// shells' URLs. Shared by every test here.
let prepared: Promise<{ api: ReturnType<typeof import("../../../../scripts/lib/rpc-client.mjs").createRpcClient>; projectSlug: string; shells: Shell[] }> | null = null
function prepare() {
  return (prepared ??= (async () => {
    const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
    const api = createRpcClient(`${baseUrl}/`)
    await api.waitForHealth()
    const { slug } = await api.mutate("dispatch", { prompt: "[script ending=needs paras=6] Follow the server", backend: "claude", model: "haiku", effort: "low" }) as { slug: string }
    let projectSlug = ""
    for (let i = 0; i < 120 && !projectSlug; i++) {
      const board = await api.query("board") as { projectSlug: string; threads: { id: string; runtime: string }[] }
      if (board.threads.find((t) => t.id === slug)?.runtime === "turn-idle") projectSlug = board.projectSlug
      else await new Promise((r) => setTimeout(r, 250))
    }
    assert.ok(projectSlug, "the scripted thread came to rest")
    const board = `${baseUrl}/project/${projectSlug}`
    return {
      api,
      projectSlug,
      shells: [
        { name: "the full-screen thread page", url: `${board}/thread/${slug}`, root: "main[data-standalone-thread]" },
        { name: "the board", url: board, root: "#workpane" },
      ],
    }
  })())
}

// The app's own store, by the exact URL the app loaded it from: once vite has hot-updated anything, a
// bare `import("/src/store.ts")` is a second, empty instance (see overlayAccessibility.e2e.test.ts).
function installStoreHandle(): void {
  performance.setResourceTimingBufferSize(100_000)
  ;(globalThis as unknown as PageGlobals).frizzPageFrameE2eStore = () => {
    const loaded = performance.getEntriesByType("resource").map((entry) => entry.name)
      .filter((name) => new URL(name).pathname === "/src/store.ts")
    return import(loaded.at(-1) ?? "/src/store.ts")
  }
}

// A tab nobody is looking at, with permission granted, that records what it would have raised.
function installNotificationStub(): void {
  const raised: { title: string; tag?: string }[] = []
  ;(globalThis as unknown as PageGlobals).frizzPageFrameE2eNotifications = raised
  class RecordedNotification {
    static permission = "granted"
    static requestPermission = async () => "granted"
    onclick: unknown = null
    constructor(title: string, options?: { tag?: string }) { raised.push({ title, tag: options?.tag }) }
    close() {}
  }
  Object.defineProperty(window, "Notification", { configurable: true, writable: true, value: RecordedNotification })
  Object.defineProperty(document, "hidden", { configurable: true, get: () => true })
}

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms))

// THE SUPERVISOR THIS PAGE HEARS: what it says (`null` is silence, the way a server that is down
// answers), how often it was asked, and how often the document was loaded.
async function supervisorFor(page: Page, name: string) {
  let answer: Answer | null = { state: "ready", artifactDigest: "build-a" }
  let polls = 0
  let documents = 0
  await page.setRequestInterception(true)
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/_frizz/control/status") {
      polls++
      if (answer === null) void r.respond({ status: 503, contentType: "text/plain", body: "down" })
      else void r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 1, updateRestart: false, ...answer }) })
      return
    }
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) documents++
    void r.continue()
  })
  // One more answer, asked for now and applied by the time this resolves.
  const poll = async () => {
    const before = polls
    await page.evaluate((wake) => { window.dispatchEvent(new Event(wake)) }, WAKE)
    for (let i = 0; i < 100 && polls === before; i++) await settle(50)
    assert.ok(polls > before, `${name}: the supervisor was asked again`)
    await settle(150)
  }
  return {
    say(next: Answer | null) { answer = next },
    poll,
    documents: () => documents,
    /** "restarting" from the build that is answering now, and the overlay it raises. */
    async restart() {
      answer = { artifactDigest: answer?.artifactDigest ?? "build-a", state: "restarting" }
      await poll()
      await page.waitForSelector(OVERLAY, { visible: true }).catch((error) => { throw new Error(`${name}: no restart overlay while the supervisor says "restarting"`, { cause: error }) })
    },
    /** The same build answering "ready" again, and the overlay gone. */
    async back() {
      answer = { artifactDigest: answer?.artifactDigest ?? "build-a", state: "ready" }
      await poll()
      await page.waitForSelector(OVERLAY, { hidden: true })
    },
  }
}

test("the board and the full-screen thread page both follow a restart: the overlay, inert content, and a reload onto a new build", { skip: !baseUrl, timeout: 240_000 }, async () => {
  const { shells } = await prepare()
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    for (const shell of shells) {
      const page = await browser.newPage()
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
      const errors: string[] = []
      page.on("pageerror", (e) => errors.push(String(e)))
      page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })

      const supervisor = await supervisorFor(page, shell.name)
      const { poll, restart } = supervisor
      const mark = () => page.evaluate(() => { (globalThis as unknown as PageGlobals).frizzPageFrameE2eMarker = true })
      const marked = () => page.evaluate(() => (globalThis as unknown as PageGlobals).frizzPageFrameE2eMarker === true)
      const box = `${shell.root} textarea`
      // What the eye and the keyboard get: is the overlay drawn over the whole window, does a click on
      // the prompt box land on it, and can the box take focus at all.
      const read = () => page.evaluate((overlaySelector, rootSelector, boxSelector) => {
        const overlay = document.querySelector<HTMLElement>(overlaySelector)
        const root = document.querySelector<HTMLElement>(rootSelector)
        const box = document.querySelector<HTMLTextAreaElement>(boxSelector)
        const rect = overlay?.getBoundingClientRect()
        const at = box?.getBoundingClientRect()
        const hit = at ? document.elementFromPoint(at.left + at.width / 2, at.top + at.height / 2) : null
        box?.focus()
        return {
          overlay: overlay !== null,
          coversWindow: !!rect && rect.left === 0 && rect.top === 0 && rect.width === window.innerWidth && rect.height === window.innerHeight,
          overlayInert: overlay?.closest("[inert]") != null,
          contentInert: root?.closest("[inert]") != null,
          clickLandsOnOverlay: !!overlay && !!hit && overlay.contains(hit),
          boxTakesFocus: !!box && document.activeElement === box,
        }
      }, OVERLAY, shell.root, box)
      const atRest = { overlay: false, coversWindow: false, overlayInert: false, contentInert: false, clickLandsOnOverlay: false, boxTakesFocus: true }
      const blocked = { overlay: true, coversWindow: true, overlayInert: false, contentInert: true, clickLandsOnOverlay: true, boxTakesFocus: false }
      const loaded = () => page.waitForSelector(box, { visible: true })

      await page.goto(shell.url, { waitUntil: "domcontentloaded" })
      await loaded()
      await mark()
      // Counted from here: the first page a fresh vite serves can load twice on its own account (it
      // reloads the tab once it has optimized the dependencies it discovered).
      const before = supervisor.documents()
      const reloads = () => supervisor.documents() - before

      // THE CONTROL: the same build answering "ready" throughout raises nothing and reloads nothing.
      for (let i = 0; i < 3; i++) await poll()
      assert.deepEqual(await read(), atRest, `${shell.name}: at rest`)
      assert.deepEqual({ marked: await marked(), reloads: reloads() }, { marked: true, reloads: 0 }, `${shell.name}: "ready" from the same build does not reload`)

      // 1. "restarting": the overlay covers the window and stays interactive; the page under it is inert.
      await restart()
      assert.deepEqual(await read(), blocked, `${shell.name}: while restarting`)

      // The same build coming back lifts the block and loads nothing: a reload is for a NEW build.
      await supervisor.back()
      assert.deepEqual(await read(), atRest, `${shell.name}: the same build back`)
      assert.deepEqual({ marked: await marked(), reloads: reloads() }, { marked: true, reloads: 0 }, `${shell.name}: the same build coming back does not reload`)

      // 2. "ready" from a DIFFERENT build than the one that served this page: the tab reloads in place.
      await restart()
      supervisor.say({ state: "ready", artifactDigest: "build-b" })
      await page.waitForFunction(() => (globalThis as unknown as PageGlobals).frizzPageFrameE2eMarker !== true, { timeout: 15_000 })
        .catch((error) => { throw new Error(`${shell.name}: a "ready" naming another build did not reload the tab`, { cause: error }) })
      await loaded()
      assert.equal(reloads(), 1, `${shell.name}: one reload`)
      assert.equal(page.url(), shell.url, `${shell.name}: reloaded in place`)
      for (let i = 0; i < 2; i++) await poll()
      assert.deepEqual(await read(), atRest, `${shell.name}: after the reload`)
      assert.equal(reloads(), 1, `${shell.name}: the new page takes the new build as its own and does not reload again`)

      // 3. The tab that clicked Update armed a destination (RestartFrizzButton): it is taken on the
      // first believed "ready" after the restart, whatever build answers, and the arming is spent.
      const destination = `${new URL(shell.url).pathname}?after=update`
      await mark()
      await page.evaluate((key, to) => sessionStorage.setItem(key, to), ARMED, destination)
      await restart()
      supervisor.say({ state: "ready", artifactDigest: "build-b" })
      await page.waitForFunction(() => (globalThis as unknown as PageGlobals).frizzPageFrameE2eMarker !== true && location.search === "?after=update", { timeout: 15_000 })
        .catch((error) => { throw new Error(`${shell.name}: the armed destination was not taken`, { cause: error }) })
      await loaded()
      assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), ARMED), null, `${shell.name}: the destination is spent`)
      assert.equal(reloads(), 2, `${shell.name}: one load onto the destination`)

      assert.deepEqual(errors, [], `${shell.name}: no page errors`)
      await page.close()
    }
  } finally {
    await browser.close()
  }
})

test("Escape does nothing while the restart overlay blocks, on either shell, and works again once it stops blocking", { skip: !baseUrl, timeout: 240_000 }, async () => {
  const { api, shells } = await prepare()
  const [full, board] = shells
  // A drawer needs a thread that is WORKING: a queued thread's link opens its card instead.
  const { slug: working } = await api.mutate("dispatch", { prompt: "[script ending=done paras=2 tools=40 toolms=3000] Keep working", backend: "claude", model: "haiku", effort: "low" }) as { slug: string }
  let running = false
  for (let i = 0; i < 120 && !running; i++) {
    const snapshot = await api.query("board") as { threads: { id: string; runtime: string }[] }
    running = snapshot.threads.find((t) => t.id === working)?.runtime === "running"
    if (!running) await settle(250)
  }
  assert.ok(running, "a scripted thread is working")

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const open = async (name: string) => {
      const page = await browser.newPage()
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
      const errors: string[] = []
      page.on("pageerror", (e) => errors.push(String(e)))
      // The 503 is this test's own: it is how the supervisor goes silent.
      page.on("console", (m) => { if (m.type() === "error" && !/404|503|favicon/i.test(m.text())) errors.push(m.text()) })
      return { page, errors, supervisor: await supervisorFor(page, name) }
    }
    // Escape, and long enough for whatever it started to show: a drawer's slide-out is 210ms and the
    // fullscreen door's view transition starts within a frame or two.
    const escape = async (page: Page) => {
      await page.keyboard.press("Escape")
      await settle(600)
    }
    const blocking = (page: Page) => page.$(OVERLAY).then((overlay) => overlay !== null)

    // THE FULL-SCREEN PAGE. Escape at rest is its way out (fullscreenEscape.e2e.test.ts), and under the
    // block it used to take it: the tab went to the board behind the scrim.
    {
      const { page, errors, supervisor } = await open(full.name)
      const onFull = () => page.evaluate(() => /\/thread\/[^/]+$/.test(location.pathname) && document.querySelector("main[data-standalone-thread]") !== null)
      const leftFull = (when: string) => page.waitForFunction(() => !/\/thread\/[^/]+$/.test(location.pathname) && !document.querySelector("main[data-standalone-thread]"), { timeout: 10_000 })
        .catch((error) => { throw new Error(`${full.name}: Escape did not exit fullscreen ${when}`, { cause: error }) })
      const load = async () => {
        await page.goto(full.url, { waitUntil: "domcontentloaded" })
        await page.waitForSelector(`${full.root} textarea`, { visible: true })
      }

      await load()
      await supervisor.restart()
      await escape(page)
      assert.deepEqual({ onFull: await onFull(), blocking: await blocking(page) }, { onFull: true, blocking: true }, `${full.name}: Escape under the block leaves the page where it is`)
      // The same build back: the page is live again, and so is its Escape.
      await supervisor.back()
      await escape(page)
      await leftFull("once the server was back")

      // THE STALLED HOLD: nothing has answered for three minutes, the overlay is a notice and the page
      // is interactive again. The swallow has to be gone with the block, or a tab whose server never
      // came back could not even close its own drawers.
      await load()
      await supervisor.restart()
      await escape(page)
      assert.equal(await onFull(), true, `${full.name}: Escape under the block, before the hold stalls`)
      supervisor.say(null)
      await supervisor.poll() // the first unanswered poll starts the hold's clock
      await page.evaluate(() => { const real = Date.now.bind(Date); Date.now = () => real() + 200_000 })
      await supervisor.poll()
      await page.waitForSelector('[role="alert"]', { visible: true })
      assert.deepEqual({ onFull: await onFull(), blocking: await blocking(page), inert: await page.$eval(full.root, (el) => el.closest("[inert]") !== null) }, { onFull: true, blocking: false, inert: false }, `${full.name}: stalled, the block is lifted`)
      await escape(page)
      await leftFull("once the hold had stalled")

      assert.deepEqual(errors, [], `${full.name}: no page errors`)
      await page.close()
    }

    // THE BOARD, with a thread's drawer open. The sheet is portaled out of the page (ThreadSheet), so
    // `inert` never covered it, and both Radix and the drawer stack close it on Escape.
    {
      const { page, errors, supervisor } = await open(board.name)
      const boardPath = new URL(board.url).pathname
      const drawer = `.frizz-sheet-panel [data-thread-surface="${working}"]`
      const drawerOpen = () => page.evaluate((selector, path) => ({ drawer: document.querySelector(selector) !== null, path: `${location.pathname}${location.search}` === path }), drawer, `${boardPath}?thread=${working}`)

      await page.goto(`${board.url}?thread=${working}`, { waitUntil: "domcontentloaded" })
      await page.waitForSelector(drawer, { visible: true })
      await supervisor.restart()
      await escape(page)
      assert.deepEqual({ ...await drawerOpen(), blocking: await blocking(page) }, { drawer: true, path: true, blocking: true }, `${board.name}: Escape under the block leaves the drawer open`)
      await supervisor.back()
      assert.deepEqual(await drawerOpen(), { drawer: true, path: true }, `${board.name}: the drawer is still open when the server is back`)
      await page.keyboard.press("Escape")
      await page.waitForFunction((selector, path) => !document.querySelector(selector) && location.pathname === path, { timeout: 10_000 }, drawer, boardPath)
        .catch((error) => { throw new Error(`${board.name}: Escape did not close the drawer once the server was back`, { cause: error }) })

      assert.deepEqual(errors, [], `${board.name}: no page errors`)
      await page.close()
    }
  } finally {
    await browser.close()
  }
})

test("a tab cold-loaded on the board or on the full-screen thread page raises desktop notifications when the setting is on, and none when it is off", { skip: !baseUrl, timeout: 240_000 }, async () => {
  const { api, projectSlug, shells } = await prepare()
  const setNotifications = async (on: boolean) => {
    const settings = await api.query("settingsGet") as Record<string, unknown>
    await api.mutate("settingsSet", { ...settings, notifications: on })
  }
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    for (const shell of shells) {
      const page = await browser.newPage()
      await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
      await page.evaluateOnNewDocument(installStoreHandle)
      await page.evaluateOnNewDocument(installNotificationStub)
      await page.setRequestInterception(true)
      page.on("request", (r) => {
        if (new URL(r.url()).pathname === "/_frizz/control/status") {
          void r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 1, state: "ready", updateRestart: false }) })
        } else void r.continue()
      })
      // Every `notify` the server pushed to this tab, whatever the tab then did with it.
      const delivered: string[] = []
      const cdp = await page.createCDPSession()
      await cdp.send("Network.enable")
      cdp.on("Network.webSocketFrameReceived", ({ response }) => {
        const slug = /"type":"notify"[^{}]*"slug":"([^"]+)"|"slug":"([^"]+)"[^{}]*"type":"notify"/.exec(response.payloadData)
        if (slug) delivered.push(slug[1] ?? slug[2])
      })
      const mirrored = () => page.evaluate(async () => (await (globalThis as unknown as PageGlobals).frizzPageFrameE2eStore()).store.notificationsEnabled)
      const raisedFor = (slug: string) => page.evaluate((slug) => (globalThis as unknown as PageGlobals).frizzPageFrameE2eNotifications.map((n) => n.tag).filter((tag) => tag?.endsWith(`/${slug}`)), slug)
      // A turn that ends is a `notify` from the server to every tab on the project.
      const endATurn = async () => {
        const { slug } = await api.mutate("dispatch", { prompt: "[script ending=done paras=1 think=300] End a turn", backend: "claude", model: "haiku", effort: "low" }) as { slug: string }
        for (let i = 0; i < 200 && !delivered.includes(slug); i++) await settle(100)
        assert.ok(delivered.includes(slug), `${shell.name}: the server's notify for ${slug} reached the tab`)
        await settle()
        return slug
      }
      const coldLoad = async () => {
        const settingsRead = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/settingsGet"), { timeout: 20_000 })
          .catch((error) => { throw new Error(`${shell.name}: the page never read the settings`, { cause: error }) })
        await page.goto(shell.url, { waitUntil: "domcontentloaded" })
        await page.waitForSelector(`${shell.root} textarea`, { visible: true })
        await settingsRead
      }

      await setNotifications(true)
      await coldLoad()
      await page.waitForFunction(async () => (await (globalThis as unknown as PageGlobals).frizzPageFrameE2eStore()).store.notificationsEnabled === true, { timeout: 10_000 })
        .catch((error) => { throw new Error(`${shell.name}: the setting is on and the store's mirror of it is still off`, { cause: error }) })
      // The server announces one rest more than once (the turn ending, then the thread entering the
      // queue), and each is raised under the thread's tag, which is what makes a browser show one.
      const loud = await endATurn()
      const raised = await raisedFor(loud)
      assert.ok(raised.length >= 1, `${shell.name}: a notification for the turn that ended`)
      assert.deepEqual([...new Set(raised)], [`/project/${projectSlug}/${loud}`], `${shell.name}: tagged with its project and thread`)

      // THE CONTROL: the same event, delivered to the same tab, raises nothing with the setting off.
      await setNotifications(false)
      await coldLoad()
      await settle()
      assert.equal(await mirrored(), false, `${shell.name}: the mirror follows the setting off`)
      const quiet = await endATurn()
      assert.deepEqual(await raisedFor(quiet), [], `${shell.name}: no notification with the setting off`)

      await page.close()
    }
  } finally {
    await setNotifications(false).catch(() => {})
    await browser.close()
  }
})
