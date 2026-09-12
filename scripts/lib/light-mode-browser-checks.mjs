import assert from "node:assert/strict"
import { join } from "node:path"

export async function checkThemePreferences({ browser, url, check }) {
  const loadingContext = await browser.createBrowserContext()
  try {
    const loadingPage = await loadingContext.newPage()
    await loadingPage.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
    const held = []
    let unavailable = false
    await loadingPage.setRequestInterception(true)
    loadingPage.on('request', request => {
      if (!request.url().includes('settingsGet')) return void request.continue().catch(() => {})
      if (!unavailable) held.push(request)
      else void request.respond({ status: 503, contentType: 'application/json', body: '{"error":{"message":"Settings unavailable"}}' }).catch(() => {})
    })
    await loadingPage.goto(url, { waitUntil: 'domcontentloaded' })
    await loadingPage.waitForSelector('[data-surface="newComposer"]')
    await loadingPage.evaluate(async () => { (await import('/src/store.ts')).store.showSettings = true })
    await loadingPage.waitForSelector('button[aria-label="Appearance"]')
    await loadingPage.waitForFunction(() => getComputedStyle(document.querySelector('.frizz-sheet-panel').parentElement).opacity === '1')
    await loadingPage.waitForFunction(() => document.body.textContent.includes('Loading server settings'))
    for (const choice of ['Light', 'Dark']) {
      await loadingPage.click('button[aria-label="Appearance"]')
      await loadingPage.waitForSelector('[role="menuitemradio"]')
      await loadingPage.evaluate(choice => [...document.querySelectorAll('[role="menuitemradio"]')].find(el => el.textContent.trim() === choice).click(), choice)
      await loadingPage.waitForFunction(expected => document.documentElement.dataset.theme === expected, {}, choice.toLowerCase())
      if (!unavailable) {
        unavailable = true
        await Promise.all(held.map(request => request.respond({ status: 503, contentType: 'application/json', body: '{"error":{"message":"Settings unavailable"}}' })))
      }
    }
    check('Appearance remains usable with loading and unavailable server settings (intentional 503 fault)')
  } finally { await loadingContext.close() }
  const cases = [
    { name: "Fresh browser follows light OS", preference: null, os: "light", expected: "light" },
    { name: "Fresh browser follows dark OS", preference: null, os: "dark", expected: "dark" },
    { name: "Persisted Light overrides dark OS", preference: "light", os: "dark", expected: "light" },
    { name: "Persisted Dark overrides light OS", preference: "dark", os: "light", expected: "dark" },
    { name: "System follows dark OS", preference: "system", os: "dark", expected: "dark" },
    { name: "Invalid preference follows light OS", preference: "invalid", os: "light", expected: "light" },
    { name: "Denied storage still follows light OS", preference: null, os: "light", expected: "light", deny: true },
    { name: "Missing media-query API resolves Light", preference: null, os: "dark", expected: "light", noMedia: true },
  ]
  for (const scenario of cases) {
    const context = await browser.createBrowserContext()
    try {
      const page = await context.newPage()
      const errors = []
      page.on("pageerror", error => errors.push(String(error)))
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()) })
      await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scenario.os }])
      await page.evaluateOnNewDocument(({ preference, deny, noMedia }) => {
        if (window !== top) return
        if (preference !== null) localStorage.setItem("frizz-theme", preference)
        if (deny) Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Storage denied", "SecurityError") } })
        if (noMedia) Object.defineProperty(window, "matchMedia", { value: undefined })
        window.themeFrames = []
        const tick = () => {
          if (document.documentElement) {
            const style = getComputedStyle(document.documentElement)
            const frame = { theme: document.documentElement.dataset.theme, color: style.backgroundColor, scheme: style.colorScheme, chrome: document.querySelector('meta[name="theme-color"]')?.content }
            if (JSON.stringify(frame) !== JSON.stringify(window.themeFrames.at(-1))) window.themeFrames.push(frame)
          }
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }, scenario)
      await page.setRequestInterception(true)
      page.on("request", request => {
        if (request.url().endsWith("/src/main.tsx")) setTimeout(() => request.continue().catch(() => {}), 600)
        else request.continue().catch(() => {})
      })
      await page.goto(url, { waitUntil: "networkidle2" })
      await page.waitForSelector('[data-surface="newComposer"]')
      const frames = await page.evaluate(() => window.themeFrames)
      assert.ok(frames.length, scenario.name)
      assert.deepEqual([...new Set(frames.map(frame => frame.theme))], [scenario.expected], `${scenario.name}: ${JSON.stringify(frames)}`)
      assert.deepEqual([...new Set(frames.map(frame => frame.scheme))], [scenario.expected], `${scenario.name} native controls`)
      assert.equal(new Set(frames.map(frame => frame.color)).size, 1, `${scenario.name} paints one canvas before/after the bundle`)
      assert.equal(new Set(frames.map(frame => frame.chrome)).size, 1, `${scenario.name} paints one browser chrome color`)
      check(scenario.name, frames)
      assert.deepEqual(errors, [], `${scenario.name} page errors`)
    } finally { await context.close() }
  }

  const control = await browser.newPage()
  try {
    await control.evaluateOnNewDocument(() => {
      if (window !== top) return
      localStorage.setItem("frizz-theme", "light")
      window.delayedFrames = []
      requestAnimationFrame(() => {
        document.documentElement.dataset.theme = "dark"
        document.documentElement.style.colorScheme = "dark"
        const sample = () => { window.delayedFrames.push(getComputedStyle(document.documentElement).backgroundColor); requestAnimationFrame(sample) }
        sample()
        setTimeout(() => { document.documentElement.dataset.theme = "light"; document.documentElement.style.colorScheme = "light" }, 400)
      })
    })
    await control.goto(url, { waitUntil: "networkidle2" })
    const frames = await control.evaluate(() => window.delayedFrames)
    assert.ok(new Set(frames).size > 1, "Negative control must detect a deliberately late palette")
    check("First-paint negative control detects a late palette", [...new Set(frames)])
  } finally { await control.close() }

  const page = await browser.newPage()
  const peer = await browser.newPage()
  try {
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }])
    await peer.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }])
    await page.goto(url, { waitUntil: "networkidle2" })
    await peer.goto(url, { waitUntil: "networkidle2" })
    await page.bringToFront()
    const set = async preference => page.evaluate(async preference => { const theme = await import("/src/lib/theme.ts"); theme.setThemePreference(preference) }, preference)
    const resolved = async (target, expected) => target.waitForFunction(expected => document.documentElement.dataset.theme === expected, {}, expected)
    await set("light")
    await resolved(peer, "light")
    check("A second tab adopts an explicit choice")
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }])
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }])
    await resolved(page, "light")
    check("Explicit Light ignores OS changes")
    await set("system")
    await resolved(page, "dark")
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }])
    await resolved(page, "light")
    assert.equal(await page.evaluate(() => localStorage.getItem("frizz-theme")), "system")
    check("System reacts live without persisting the resolved theme")
    await page.evaluate(() => localStorage.removeItem("frizz-theme"))
    await resolved(peer, "dark")
    assert.equal(await peer.evaluate(async () => (await import("/src/lib/theme.ts")).getThemeSnapshot().preference), "system")
    await set("light")
    await resolved(peer, "light")
    await page.evaluate(() => localStorage.clear())
    await resolved(peer, "dark")
    check("Storage removal and clear restore System in the other tab")
    await set("light")
    for (const route of [new URL("/", url).href, new URL("/project/second-project", url).href, `${url}/thread/theme-rich/full`, url]) {
      await page.goto(route, { waitUntil: "networkidle2" })
      await resolved(page, "light")
    }
    check("Light survives grid, other project, deep link and reload navigation")

    await page.evaluate(() => { Object.defineProperty(Storage.prototype, "setItem", { configurable: true, value() { throw new DOMException("Full", "QuotaExceededError") } }) })
    await set("dark")
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }])
    await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }])
    await resolved(page, "dark")
    check("Failed persistence keeps an explicit choice in memory across OS changes")
  } finally { await page.close(); await peer.close() }
}

export async function checkRichRendererState({ page, url, check }) {
  await page.goto(`${url}/thread/theme-rich/full`, { waitUntil: "networkidle2" })
  await page.waitForSelector('[data-mermaid-state="ready"]')
  const iframe = await page.waitForSelector('iframe[title="theme counter"]')
  const frame = await iframe.contentFrame()
  await frame.waitForSelector("#value")
  await frame.click("#increment")
  const before = await frame.evaluate(() => ({ identity: window.mountIdentity, value: document.querySelector("#value").value, color: getComputedStyle(document.querySelector("#series span")).backgroundColor }))
  const beforeSrc = await iframe.evaluate(el => el.src)
  await page.evaluate(async () => {
    window.richNode = document.querySelector('[data-mermaid-state="ready"]').parentElement
    const theme = await import("/src/lib/theme.ts")
    for (const preference of ["light", "dark", "light", "dark", "light"]) {
      theme.setThemePreference(preference)
      await new Promise(requestAnimationFrame)
    }
  })
  await frame.waitForFunction(() => getComputedStyle(document.documentElement).colorScheme === "light")
  await page.waitForFunction(() => document.querySelectorAll('[data-mermaid-state="ready"]').length === 2 && !document.querySelector('[data-mermaid-state="loading"]'))
  const after = await frame.evaluate(() => ({ identity: window.mountIdentity, value: document.querySelector("#value").value, color: getComputedStyle(document.querySelector("#series span")).backgroundColor }))
  assert.equal(before.identity, after.identity)
  assert.equal(after.value, "43")
  assert.equal(await iframe.evaluate(el => el.src), beforeSrc)
  assert.equal(await iframe.evaluate(el => el.getAttribute("sandbox")), "allow-scripts")
  assert.equal(await page.evaluate(() => document.querySelector('[data-mermaid-state="ready"]').parentElement === window.richNode), true)
  assert.notEqual(after.color, before.color, "Chart colors respond to the selected palette")
  assert.ok(await frame.evaluate(() => window.themeEvents >= 2), "Cooperative renderers receive theme-change notifications")
  await page.waitForFunction(() => !document.querySelector('[id^="dfrizz-mermaid-"]'))
  check("Rapid theme changes preserve iframe controls and transcript nodes", { before, after })
  const initialHeight = await iframe.evaluate(el => el.getBoundingClientRect().height)
  await frame.evaluate(() => { const el = document.createElement("div"); el.style.height = "500px"; document.body.append(el) })
  await page.waitForFunction(initialHeight => document.querySelector('iframe[title="theme counter"]').getBoundingClientRect().height > initialHeight, {}, initialHeight)
  check("Iframe natural height still updates after theme application")
  await page.goto(`${url}/thread/theme-invalid/full`, { waitUntil: "networkidle2" })
  await page.waitForSelector('[data-mermaid-state="error"]')
  await page.waitForSelector('[data-mermaid-state="ready"]')
  await page.evaluate(async () => {
    const theme = await import("/src/lib/theme.ts")
    theme.setThemePreference("dark")
    theme.setThemePreference("light")
    const { router } = await import("/src/routes.tsx")
    await router.navigate(location.pathname.replace("theme-invalid", "theme-rich"))
  })
  await page.waitForSelector('iframe[title="theme counter"]')
  await page.waitForFunction(() => !document.querySelector('[id^="dfrizz-mermaid-"]'))
  check("Malformed diagrams do not block later jobs or leak scratch nodes on unmount")
}

export async function checkIframeFirstPaint({ browser, url, check }) {
  for (const suppressAck of [false, true]) {
    const page = await browser.newPage()
    try {
      await page.evaluateOnNewDocument(() => {
        if (window !== top) return
        localStorage.setItem("frizz-theme", "light")
        window.iframePaints = []
        const sample = () => {
          const frame = document.querySelector('iframe[title="theme counter"]')
          if (frame) window.iframePaints.push({ at: performance.now(), visibility: getComputedStyle(frame).visibility })
          requestAnimationFrame(sample)
        }
        requestAnimationFrame(sample)
      })
      if (suppressAck) {
        await page.setRequestInterception(true)
        page.on("request", async req => {
          if (req.url().includes("/local-visualization?") && req.method() === "GET") {
            const response = await fetch(req.url())
            const body = (await response.text()).replaceAll('type: "frizz-inline-vis-applied"', 'type: "deliberately-suppressed-ack"')
            await req.respond({ status: 200, contentType: "text/html", body })
          } else await req.continue()
        })
      }
      await page.goto(`${url}/thread/theme-rich/full`, { waitUntil: "networkidle2" })
      const iframe = await page.waitForSelector('iframe[title="theme counter"]')
      if (suppressAck) {
        assert.equal(await iframe.evaluate(el => getComputedStyle(el).visibility), "hidden")
        await page.waitForFunction(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent.includes("Visualization unavailable")), { timeout: 8000 })
        const paints = await page.evaluate(() => window.iframePaints)
        assert.ok(paints.length > 2)
        assert.ok(paints.every(p => p.visibility === "hidden"))
        assert.ok(paints.at(-1).at - paints[0].at >= 4500, "The acknowledgement deadline is 5s, not an early fallback")
        check("No-ack negative control stays hidden and reaches the unavailable state after 5s")
      } else {
        await page.waitForFunction(() => getComputedStyle(document.querySelector('iframe[title="theme counter"]')).visibility === "visible")
        const frame = await iframe.contentFrame()
        assert.equal(await frame.evaluate(() => getComputedStyle(document.documentElement).colorScheme), "light")
        const paints = await page.evaluate(() => window.iframePaints)
        assert.ok(paints.some(p => p.visibility === "visible"))
        check("The first visible iframe has the complete light palette", paints.filter((p, i) => !i || p.visibility !== paints[i - 1].visibility))
      }
    } finally { await page.close() }
  }
}

export async function checkLoginTerminal({ page, url, check, out }) {
  await page.evaluate(async () => (await import("/src/lib/theme.ts")).setThemePreference("dark"))
  await page.goto(url, { waitUntil: "networkidle2" })
  const cdp = await page.createCDPSession()
  await cdp.send("Network.enable")
  let connections = 0
  cdp.on("Network.webSocketCreated", event => { if (event.url.includes("/term/login-")) connections++ })
  await page.waitForSelector('[data-surface="newComposer"]')
  await page.type('[data-surface="newComposer"]', "/login")
  await page.keyboard.press("Enter")
  await page.waitForSelector('[role="dialog"]')
  await page.evaluate(() => [...document.querySelectorAll('button')].find(button => button.textContent.trim() === "Sign in here").click())
  await page.waitForSelector(".xterm-screen", { timeout: 30_000 })
  await page.waitForFunction(() => document.querySelector(".xterm-rows")?.textContent.length > 20, { timeout: 45_000 })
  await page.evaluate(() => {
    const root = document.querySelector(".xterm").parentElement
    let fiber = root[Object.keys(root).find(key => key.startsWith("__reactFiber"))]
    for (; fiber; fiber = fiber.return) {
      for (let hook = fiber.memoizedState; hook && typeof hook === "object"; hook = hook.next) {
        const term = hook.memoizedState?.current
        if (term?.buffer?.active && term?.options?.theme) { window.loginTerm = term; break }
      }
      if (window.loginTerm) break
    }
    if (!window.loginTerm) throw new Error("The rendered terminal instance was not found")
    window.loginNode = document.querySelector(".xterm")
    window.loginTerm.focus()
    window.loginTerm.select(0, 0, 12)
  })
  const read = () => page.evaluate(() => ({
    buffer: Array.from({ length: window.loginTerm.buffer.active.length }, (_, i) => window.loginTerm.buffer.active.getLine(i)?.translateToString(true)).join("\n"),
    selection: window.loginTerm.getSelection(),
    theme: window.loginTerm.options.theme,
    sameNode: document.querySelector(".xterm") === window.loginNode,
    focused: document.activeElement === document.querySelector(".xterm-helper-textarea"),
  }))
  const before = await read()
  assert.equal(connections, 1)
  for (const theme of ["dark", "light", "dark", "light"]) {
    await page.evaluate(async theme => (await import("/src/lib/theme.ts")).setThemePreference(theme), theme)
    await page.waitForFunction(theme => document.documentElement.dataset.theme === theme, {}, theme)
  }
  const after = await read()
  assert.equal(connections, 1, "No reconnect while changing appearance")
  assert.equal(after.buffer, before.buffer, "Login output and scrollback survive")
  assert.equal(after.selection, before.selection)
  assert.equal(after.sameNode, true)
  assert.equal(after.focused, true)
  assert.equal(Object.keys(after.theme).filter(name => !name.startsWith("extended")).length >= 20, true, "Complete default, selection, cursor and ANSI palette")
  assert.notEqual(after.theme.background, before.theme.background)
  await page.screenshot({ path: join(out, "light-login-terminal.png") })
  check("Real login terminal preserves buffer, selection, focus and one WebSocket", { connections, lines: before.buffer.split("\n").length })
  await page.evaluate(() => [...document.querySelectorAll("button")].find(button => button.textContent.trim() === "Cancel sign-in").click())
  await cdp.detach()
}
