import assert from "node:assert/strict"
import { join } from "node:path"
import { createServer } from "node:http"
import { once } from "node:events"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { measureTextContrast, measureControlContrast, measureThreadTitleInk, measureAppearanceInk } from "./light-mode-contrast.mjs"

export async function checkSurfaceStates({ page, url, font, palette, out, check, result }) {
  const name = `${palette}-${font}`
  const settle = async () => {
    await page.mouse.move(0, 0)
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame)
      await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))
    })
  }
  const shot = async suffix => { await settle(); await page.screenshot({ path: join(out, `${name}-${suffix}.png`) }) }
  const contrast = async suffix => { await settle(); result[`${name}-${suffix}-contrast`] = await measureTextContrast(page) }
  const crop = async (selector, suffix) => {
    const viewport = page.viewport()
    await page.setViewport({ ...viewport, deviceScaleFactor: 8 })
    try {
      const element = await page.$(selector)
      assert.ok(element, `Missing optical target ${selector}`)
      await element.screenshot({ path: join(out, `${name}-${suffix}-ink.png`) })
      await element.dispose()
    } finally { await page.setViewport(viewport) }
  }
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
  await page.goto(url, { waitUntil: "networkidle2" })
  await page.evaluate(async () => {
    const { store } = await import("/src/store.ts")
    store.sidebarCollapsed.running = false
    store.sidebarCollapsed.snoozed = false
    store.sidebarCollapsed.inactive = false
  })
  await page.waitForSelector('[data-sidebar-item="theme-snoozed"]')
  await page.waitForSelector('[data-sidebar-item="theme-done"]')
  await contrast("expanded-bands")
  await shot("expanded-bands")
  const running = await page.evaluate(async () => (await import("/src/store.ts")).store.board.threads.find(t => t.id === "theme-running").runtime)
  assert.equal(running, "running")
  check(`${name} real Rested, Active, Snoozed and Done bands`)

  for (const width of [1440, 390]) {
    await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 })
    await page.goto(url, { waitUntil: 'networkidle2' })
    await page.keyboard.down('Meta')
    await page.keyboard.press('k')
    await page.keyboard.up('Meta')
    await page.waitForSelector('[cmdk-root]')
    await contrast(`commands-${width}`)
    await shot(`commands-${width}`)
    await page.click('[cmdk-item][data-value="new thread create home"]')
    await page.waitForSelector('[role="dialog"] textarea')
    await contrast(`new-thread-dialog-${width}`)
    await shot(`new-thread-dialog-${width}`)
    await page.keyboard.press('Escape')
    await page.waitForSelector('[role="dialog"]', { hidden: true })
    // Rested deep links intentionally reveal the queue card; a running thread opens the sheet.
    await page.goto(`${url}?thread=theme-running`, { waitUntil: 'networkidle2' })
    await page.waitForSelector('[data-thread-header]')
    await contrast(`thread-sheet-${width}`)
    await shot(`thread-sheet-${width}`)
  }
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
  await page.goto(url, { waitUntil: 'networkidle2' })
  await page.evaluate(async () => { const { store, showToast } = await import('/src/store.ts'); store.view = 'status:archived'; showToast('Settings saved', { duration: 10000 }) })
  await page.waitForFunction(() => document.body.textContent.includes('Settings saved'))
  await contrast('status-list-toast')
  await shot('status-list-toast')
  await page.goto(url, { waitUntil: 'networkidle2' })
  check(`${name} command palette, new-thread modal, stacked thread reader and status list`)

  // A fresh dispatch has no AI title yet; exercise that real row without dispatching a provider. A write
  // into a thread on the board reaches no subscriber (store.ts plainThreads), so each step replaces its slot.
  const previousTitle = await page.evaluate(async () => {
    const { store, setBoard } = await import('/src/store.ts')
    const thread = store.board.threads.find(t => t.id === 'theme-running')
    const saved = { titleAuto: thread.titleAuto, aiTitle: thread.aiTitle, spawnedAt: thread.spawnedAt }
    const fresh = { titleAuto: true, aiTitle: '', spawnedAt: new Date().toISOString() }
    setBoard({ ...store.board, threads: store.board.threads.map(t => t.id === 'theme-running' ? { ...t, ...fresh } : t) })
    return saved
  })
  const provisional = '[data-sidebar-item="theme-running"]'
  await page.waitForFunction(selector => document.querySelector(selector)?.textContent.includes('Spinning up'), {}, provisional)
  await contrast('provisional-title')
  assert.ok(result[`${name}-provisional-title-contrast`].some(row => row.text.includes('Spinning up')), 'The provisional title was actually sampled')
  await shot('provisional-title')
  await page.evaluate(async saved => {
    const { store, setBoard } = await import('/src/store.ts')
    setBoard({ ...store.board, threads: store.board.threads.map(t => t.id === 'theme-running' ? { ...t, ...saved } : t) })
  }, previousTitle)
  check(`${name} provisional sidebar title`)

  await page.click('[aria-label="Model and effort"]')
  await page.waitForSelector('[aria-label="Claude Code settings"]')
  await contrast('profile-grid')
  await shot('profile-grid')
  for (const [provider, backend, label] of [['Claude Code', 'claude', 'Claude Code compaction window'], ['Codex', 'codex', 'Codex context window']]) {
    await page.click(`[aria-label="${provider} settings"]`)
    await page.waitForSelector(`[data-agent-settings-menu="${backend}"]`)
    // The draft loads asynchronously and expands the collision-positioned popover. Wait until
    // the final Select exists and its center is hittable before measuring/clicking its coordinates.
    await page.waitForFunction(label => {
      const el = document.querySelector(`button[aria-label="${label}"]`)
      if (!el) return false
      const r = el.getBoundingClientRect()
      return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
    }, {}, label)
    await contrast(`agent-settings-${backend}`)
    await shot(`agent-settings-${backend}`)
    await page.click(`button[aria-label="${label}"]`)
    await page.waitForSelector('[role="menu"]:not(.profile-grid-menu) [role="menuitemradio"]')
    await contrast(`context-${label.split(' ')[0].toLowerCase()}`)
    result[`${name}-context-${label.split(' ')[0].toLowerCase()}-ink`] = await measureAppearanceInk(page, `[aria-label="${label}"]`)
    await shot(`context-${label.split(' ')[0].toLowerCase()}`)
    await crop(`[aria-label="${label}"]`, `context-${label.split(' ')[0].toLowerCase()}`)
    await page.keyboard.press('Escape')
    await page.waitForSelector('[role="menu"]:not(.profile-grid-menu)', { hidden: true })
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-agent-settings-menu]', { hidden: true })
  }
  await page.keyboard.press('Escape')
  check(`${name} model-grid headers and nested context controls`)

  // Upstream shares ThreadTitle between the queue and the drawer. Keep both editing paths and
  // their semantic focus treatment covered when either header changes during palette migrations.
  for (const width of [1440, 390]) {
    await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 })
    for (const surface of ['queue', 'full']) {
      await page.goto(surface === 'queue' ? url : `${url}/thread/theme-question`, { waitUntil: 'networkidle2' })
      if (surface === 'queue') {
        const item = width === 390 ? '[data-mobile-thread-row="theme-question"]' : '[data-sidebar-item="theme-question"]'
        await page.waitForSelector(item)
        await page.click(item)
      }
      // The row opens the thread in the board's pane (or the phone's thread page), under its header.
      const root = '[data-thread-header]'
      const title = `${root} button[title="Edit title"]`
      const editor = `${root} input[aria-label="Thread title"]`
      await page.waitForSelector(title, { visible: true })
      const original = await page.$eval(title, el => el.textContent)
      await page.click(title)
      await page.waitForFunction(selector => document.querySelector(selector) === document.activeElement, {}, editor)
      assert.equal(await page.$eval(editor, el => el.value), original)
      await page.keyboard.type('A cancelled theme edit')
      await page.keyboard.press('Escape')
      await page.waitForSelector(editor, { hidden: true })
      assert.equal(await page.$eval(title, el => el.textContent), original)
      for (const value of ['A verified theme edit', original]) {
        await page.click(title)
        await page.waitForFunction(selector => document.querySelector(selector) === document.activeElement, {}, editor)
        await page.keyboard.type(value)
        await page.keyboard.press('Enter')
        await page.waitForFunction(({ selector, value }) => {
          const el = document.querySelector(selector)
          return el?.textContent === value && !el.disabled
        }, {}, { selector: title, value })
      }
      await page.keyboard.press('Tab')
      await page.focus(title)
      assert.equal(await page.$eval(title, el => el.matches(':focus-visible') && el.classList.contains('focus-visible:ring-focus-ink-60')), true)
      await contrast(`title-${surface}-${width}`)
      result[`${name}-title-${surface}-${width}-ink`] = await measureThreadTitleInk(page, title)
      await page.setViewport({ width, height: 1000, deviceScaleFactor: 8 })
      const row = await (await page.$(title)).evaluateHandle(el => el.parentElement)
      await row.screenshot({ path: join(out, `${name}-title-${surface}-${width}.png`) })
      await row.dispose()
      await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 })
    }
  }
  check(`${name} queue and fullscreen title focus, rename and cancel at desktop and phone widths`)
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })

  await page.goto(`${url}/thread/theme-question`, { waitUntil: "networkidle2" })
  await page.click("[data-question-option] > button")
  // A staged answer arms the prompt box's Send, which is what sends it: the cards draw no "Send answers"
  // of their own beside a prompt box (2026-10-11).
  await page.waitForFunction(() => {
    const send = document.querySelector("[data-send-split] [data-send]")
    return send && !send.disabled && !document.querySelector("[data-send-answers]")
  })
  await contrast("selected-question")
  const outlineContract = await page.evaluate(() => {
    const question = getComputedStyle(document.querySelector('.bg-question'))
    // The split pill paints the fill; its Send half paints only a hover tint over it.
    const fill = getComputedStyle(document.querySelector('[data-send-split]'))
    const send = getComputedStyle(document.querySelector('[data-send-split] [data-send]'))
    return { question: [question.backgroundColor, question.borderTopColor, question.borderTopWidth], send: [fill.backgroundColor, send.color] }
  })
  if (palette === 'light') assert.deepEqual(outlineContract.question, ['rgb(255, 255, 255)', 'rgb(220, 220, 220)', '1px'])
  assert.notEqual(outlineContract.send[0], outlineContract.send[1], 'The armed Send keeps its word legible on its fill')
  result[`${name}-question-outlines`] = outlineContract
  await shot("selected-question")
  await page.evaluate(() => {
    const text = document.querySelector('[data-question-option] p') ?? document.querySelector('[data-question-option] span')
    const range = document.createRange(); range.selectNodeContents(text)
    const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range)
  })
  assert.ok(await page.evaluate(() => getSelection().toString().length > 0))
  await shot("text-selection")
  await page.evaluate(() => getSelection().removeAllRanges())

  await page.goto(url, { waitUntil: "networkidle2" })
  await page.evaluate(async () => { (await import("/src/store.ts")).store.showSettings = true })
  await page.waitForSelector('button[aria-label="Appearance"]')
  await page.waitForFunction(() => getComputedStyle(document.querySelector(".frizz-sheet-panel").parentElement).opacity === "1")
  let serverWrites = 0
  const request = req => { if (req.url().includes("settingsSet")) serverWrites++ }
  page.on("request", request)
  for (const choice of [palette === "light" ? "Dark" : "Light", palette === "light" ? "Light" : "Dark"]) {
    await page.click('button[aria-label="Appearance"]')
    await page.waitForSelector('[role="menuitemradio"]')
    if (choice.toLowerCase() !== palette) {
      await contrast("appearance-menu")
      await shot("appearance-menu")
    }
    await page.evaluate(choice => [...document.querySelectorAll('[role="menuitemradio"]')].find(el => el.textContent.trim() === choice).click(), choice)
    await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, {}, choice.toLowerCase())
  }
  page.off("request", request)
  assert.equal(serverWrites, 0, "Appearance never writes server settings")
  await settle()
  const formEdges = await page.evaluate(() => {
    const dropdown = document.querySelector('button[aria-label="Appearance"]')
    const segments = [...document.querySelectorAll('.frizz-sheet-panel button[aria-pressed]')]
    return { dropdown: getComputedStyle(dropdown).borderTopColor, segments: segments.map(el => ({ border: getComputedStyle(el).borderTopWidth, ring: getComputedStyle(el).getPropertyValue('--tw-inset-ring-shadow'), group: getComputedStyle(el.parentElement).borderTopColor })) }
  })
  assert.ok(formEdges.segments.length >= 6)
  for (const segment of formEdges.segments) {
    assert.equal(segment.border, '0px', 'Segments do not own separate frames')
    assert.doesNotMatch(segment.ring, /inset/, 'Segments do not own inset outlines')
    assert.equal(segment.group, formEdges.dropdown, 'Dropdown and segmented group share one border tone')
  }
  assert.equal(await page.$$eval('.frizz-sheet-panel button', buttons => buttons.some(el => ['Mono', 'Sans'].includes(el.textContent.trim()))), false, 'There is no font setting')
  for (const choice of ['Off', 'On']) {
    const saved = page.waitForResponse(response => response.url().includes('/rpc/settingsSet') && response.ok())
    await page.evaluate(choice => {
      const field = document.querySelector('button[aria-label="About Project sidebar"]').closest('div.flex-col')
      ;[...field.querySelectorAll('button')].find(el => el.textContent.trim() === choice).click()
    }, choice)
    await saved
    await page.waitForFunction(() => [...document.querySelectorAll('header span')].some(el => el.textContent === 'Saved'))
    await page.evaluate(async () => {
      await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))
    })
    await contrast(`settings-saved-${choice.toLowerCase()}`)
    assert.ok(result[`${name}-settings-saved-${choice.toLowerCase()}-contrast`].some(row => row.text === 'Saved'), 'The actual settings save result was sampled')
    await shot(`settings-saved-${choice.toLowerCase()}`)
  }
  check(`${name} real settings save result`)
  await page.keyboard.press("Tab")
  await page.focus('button[aria-label="Appearance"]')
  await page.evaluate(async () => {
    await new Promise(requestAnimationFrame)
    await Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})))
  })
  const controls = await measureControlContrast(page, [
    // The light-gray frame is decorative; the readable value, chevron and keyboard focus identify
    // the control. Its resting edge deliberately matches the neighboring segmented controls.
    { label: 'Appearance focus', selector: 'button[aria-label="Appearance"]', property: 'outlineColor' },
    { label: 'Appearance chevron', selector: 'button[aria-label="Appearance"] svg', property: 'color' },
  ])
  result[`${name}-controls`] = controls
  if (palette === 'light') assert.deepEqual(controls.filter(c => c.ratio < 3), [], 'Meaningful controls meet 3:1')
  await shot("appearance-focus")
  await page.hover('button[aria-label="About Appearance"]')
  await page.waitForSelector('[role="tooltip"]')
  await contrast("appearance-help")
  await shot("appearance-help")
  check(`${name} Appearance menu, help, focus and browser-only persistence`)

  const inspectDestructive = async label => {
    const selector = '[role="dialog"] button[class*="bg-danger"]'
    await page.waitForSelector(selector, { visible: true })
    const settle = () => page.evaluate(async () => {
      await new Promise(requestAnimationFrame)
      await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))
    })
    await page.mouse.move(0, 0)
    await settle()
    assert.equal(await page.$eval(selector, el => getComputedStyle(el).opacity), '1', 'The normal sample is fully opaque')
    await contrast(`${label}-normal`)
    const input = await page.createCDPSession()
    try {
      await input.send('Emulation.setTouchEmulationEnabled', { enabled: true })
      await page.hover(selector)
      await settle()
      assert.equal(await page.$eval(selector, el => getComputedStyle(el).opacity), '1', 'Touch-only input is a negative control for the media-gated hover rule')
      if (process.env.THEME_VERIFY_HOVER_NONE === '1') {
        assert.equal(await page.evaluate(() => matchMedia('(hover: hover)').matches), false, 'The forced no-hover run must exercise the fallback')
      } else {
        await input.send('Emulation.setTouchEmulationEnabled', { enabled: false })
      }
      // Headless hosts without hover input need the equivalent media endpoint. Reuse the compiled
      // hover rules, not an inline opacity that could hide a regression in those rules.
      const media = await page.evaluateHandle(() => {
        const changed = []
        if (!matchMedia('(hover: hover)').matches) {
          const visit = rules => {
            for (const rule of rules) {
              if (rule.type === CSSRule.MEDIA_RULE && /^\(hover:\s*hover\)$/.test(rule.conditionText)) {
                changed.push({ rule, condition: rule.media.mediaText })
                rule.media.mediaText = 'all'
              }
              if (rule.cssRules) visit(rule.cssRules)
            }
          }
          for (const sheet of document.styleSheets) visit(sheet.cssRules)
          if (!changed.length) throw new Error('No compiled hover media rules were found')
        }
        return changed
      })
      try {
        result[`${name}-${label}-hover-input`] = await media.evaluate(changed => changed.length ? 'equivalent CSS media endpoint' : 'native pointer hover')
        await page.hover(selector)
        await settle()
        assert.deepEqual(await page.$eval(selector, el => ({ hovered: el.matches(':hover'), opacity: getComputedStyle(el).opacity })), { hovered: true, opacity: '0.9' }, 'The compiled CSS hover endpoint is active before sampling')
        await contrast(`${label}-hover`)
        await shot(`${label}-hover`)
      } finally {
        await media.evaluate(changed => { for (const { rule, condition } of changed) rule.media.mediaText = condition })
        await media.dispose()
      }
    } finally {
      await input.send('Emulation.setTouchEmulationEnabled', { enabled: false })
      await input.detach()
    }
    await page.keyboard.press('Escape')
    await page.waitForSelector('[role="dialog"]', { hidden: true })
  }
  await page.goto(new URL('/', url).href, { waitUntil: 'networkidle2' })
  await page.hover('[aria-label="More actions for theme-project"]')
  await page.click('[aria-label="More actions for theme-project"]')
  await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.includes('Rename')).click())
  await page.waitForSelector('[aria-label="Project name"]')
  await page.type('[aria-label="Project name"]', 'renamed-project')
  await contrast('rename-project')
  await shot('rename-project')
  // The launching project's directory cannot move. Exercise the real refusal without renaming it.
  await page.click('#rename-project input[type="checkbox"]')
  const refusal = page.waitForResponse(response => response.url().endsWith('/rpc/projectRename'))
  await page.click('button[form="rename-project"]')
  assert.equal((await refusal).status(), 500, 'The real server refuses moving its own launching directory')
  result.expectedConsoleErrors ??= []
  result.expectedConsoleErrors.push(`Failed to load resource: the server responded with a status of 500 (Internal Server Error) ${new URL('/_frizz/rpc/projectRename', url)}`)
  await page.waitForFunction(() => document.querySelector('#rename-project')?.textContent.includes('cannot be renamed'))
  await contrast('rename-project-error')
  await shot('rename-project-error')
  await page.keyboard.press('Escape')
  await page.waitForSelector('[role="dialog"]', { hidden: true })
  await page.click('[aria-label="More actions for theme-project"]')
  await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].find(el => el.textContent.includes('Delete')).click())
  await inspectDestructive('delete-project')
  await page.goto(`${url}/thread/theme-rich`, { waitUntil: 'networkidle2' })
  // The alias trims whitespace; skip skill discovery against the transcript-only fixture.
  await page.type('textarea', ' /logout')
  await page.keyboard.down('Meta')
  await page.keyboard.press('Enter')
  await page.keyboard.up('Meta')
  await inspectDestructive('sign-out')
  check(`${name} destructive confirmation labels in normal and pointer-hover states, without submitting either action`)

  await page.goto(`${url}/thread/theme-rich`, { waitUntil: "networkidle2" })
  await page.evaluate(() => [...document.querySelectorAll('button[aria-expanded="false"]')].find(el => el.textContent.includes("Ran 3 tool calls"))?.click())
  await page.waitForSelector(".frizz-diff")
  await page.$eval('[data-drawer-transcript-scroll]', el => { el.scrollTop = 0 })
  await page.evaluate(() => {
    for (const button of document.querySelectorAll('.frizz-diff-header button[aria-expanded="false"],.frizz-bash-header button[aria-expanded="false"],button.frizz-bash-header[aria-expanded="false"]')) button.click()
  })
  await page.waitForSelector('.frizz-diff-body:not([hidden])')
  await page.waitForFunction(() => [...document.querySelectorAll('.frizz-bash-body')].some(el => el.textContent.includes('const palette')))
  await contrast("tool-diff")
  await shot("tool-diff")
  check(`${name} real Edit diff, Read excerpt and failed tool`)

  // The embedded Vite server serves one HTML entry. Select the existing component-gallery entry
  // for this complementary renderer check; its network fixture is not claimed as GitHub E2E.
  // A real loopback response keeps Chrome's network address-space classification intact. Fulfilling
  // the document through request interception classifies it public and blocks Vite's loopback HMR.
  const gallery = createServer(async (req, res) => {
    try {
      const integration = req.url.startsWith('/light-mode-integration-fixture.html')
      const isEntry = integration || req.url.startsWith('/github-hovercard-fixture.html')
      const upstream = await fetch(isEntry ? url : new URL(req.url, url))
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream' })
      res.end(isEntry ? (await upstream.text()).replace('/src/main.tsx', integration ? '/src/light-mode-integration-fixture.tsx' : '/src/github-hovercard-fixture.tsx') : Buffer.from(await upstream.arrayBuffer()))
    } catch (error) { res.writeHead(502); res.end(String(error)) }
  })
  gallery.listen(0, '127.0.0.1')
  await once(gallery, 'listening')
  try {
  await page.goto(`http://127.0.0.1:${gallery.address().port}/github-hovercard-fixture.html?font=${font}&theme=${palette}`, { waitUntil: "networkidle2" })
  await page.waitForSelector('[data-case="issue-closed"]')
  const readings = []
  for (const y of [0, 600, 1200, 1800]) {
    await page.evaluate(y => scrollTo(0, y), y)
    readings.push(...await measureTextContrast(page))
  }
  result[`${name}-github-components-contrast`] = readings
  await page.evaluate(() => scrollTo(0, 0))
  await shot("github-components")
  check(`${name} actual GitHub card components: all states and external label edge cases`)
  await page.goto(`http://127.0.0.1:${gallery.address().port}/light-mode-integration-fixture.html?font=${font}&theme=${palette}`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-provider-marks] [role="img"]')
  assert.equal(await page.$$eval('[data-provider-marks] [role="img"]', els => els.length), 7)
  assert.equal(await page.$$eval('[data-issue-watches] [data-wait-row]', els => els.length), 4)
  for (const [label, selectors] of [
    ['acp-model', '[aria-label="Model for OpenCode"] > span,[aria-label="Model for OpenCode"] > svg'],
    ['issue-watch', '[data-wait-row="issue:acme/app#1"] > span:first-child svg,[data-wait-row="issue:acme/app#1"] > a'],
  ]) {
    const ink = await promisify(execFile)('nub', [fileURLToPath(new URL('../ink-gaps.mjs', import.meta.url)), page.url(), selectors,
      `--browser=${page.browser().wsEndpoint()}`, '--dsf=8', '--w=390', '--h=1000', '--wait=300', '--pad=0'], { encoding: 'utf8' })
    result[`${name}-${label}-gaps`] = JSON.parse(ink.stdout)
  }
  await page.bringToFront()
  const marks = await measureControlContrast(page, [
    ...Array.from({ length: 7 }, (_, i) => ({ label: `ACP mark ${i}`, selector: `[data-provider-marks] > div:nth-child(${i + 1}) [role="img"]`, property: 'color' })),
    { label: 'Unknown issue mark', selector: '[data-wait-row="issue:acme/app#1"] svg', property: 'color' },
  ])
  result[`${name}-integrated-marks`] = marks
  if (palette === 'light') assert.deepEqual(marks.filter(mark => mark.ratio < 3), [], 'Integrated provider and issue marks meet 3:1')
  for (const width of [1440, 390]) {
    await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 })
    const rows = await page.$$eval('[data-issue-watches] [data-wait-row]', els => els.map(el => {
      const row = el.getBoundingClientRect()
      return { height: row.height, width: row.width, scrollWidth: el.scrollWidth, children: [...el.children].map(child => {
        const rect = child.getBoundingClientRect()
        return { top: rect.top - row.top, left: rect.left - row.left, width: rect.width, height: rect.height }
      }) }
    }))
    result[`${name}-issue-rows-${width}`] = rows
    await shot(`integrated-renderers-${width}`)
    // The trailing chevron deliberately overhangs its box by 4px to align its ink. Check the
    // single-line contract and document overflow, not that intentional box-level overhang.
    assert.ok(rows.every(row => row.height < 32 && row.children.every(child => child.top >= 0 && child.top + child.height <= row.height)), 'Issue watches retain their real single-line layout')
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'Integrated controls do not overflow the viewport')
    await contrast(`integrated-renderers-${width}`)
    result[`${name}-acp-model-${width}-ink`] = await measureAppearanceInk(page, '[aria-label="Model for OpenCode"]')
    await crop('[aria-label="Model for OpenCode"]', `acp-model-${width}`)
    await crop('[data-issue-watches]', `issue-watches-${width}`)
    await page.click('[aria-label="Model for OpenCode"]')
    await page.waitForSelector('[role="menuitemradio"]')
    await contrast(`acp-model-menu-${width}`)
    await shot(`acp-model-menu-${width}`)
    await page.evaluate(() => [...document.querySelectorAll('[role="menuitemradio"]')].find(el => el.textContent === 'Model B').click())
    await page.waitForFunction(() => document.querySelector('[aria-label="Model for OpenCode"]')?.textContent === 'Model B')
  }
  check(`${name} ACP provider marks, model dropdown and issue watch states`)
  } finally {
    await page.goto(url, { waitUntil: "networkidle2" })
    gallery.closeAllConnections()
    await new Promise(resolve => gallery.close(resolve))
  }

  await page.goto(url, { waitUntil: "networkidle2" })
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 })
  await page.waitForSelector('[data-mobile-tab="snoozed"]')
  for (const band of ["snoozed", "done", "queue"]) {
    await page.click(`[data-mobile-tab="${band}"]`)
    await contrast(`phone-${band}`)
    await shot(`phone-${band}`)
  }
  await page.goto(`${url}/thread/theme-question`, { waitUntil: 'networkidle2' })
  await page.waitForSelector('[data-question-option]')
  await contrast('phone-question')
  await shot('phone-question')
  await page.goto(url, { waitUntil: 'networkidle2' })
  // The board's ⋯ sheet went away with the 2026-09-30 phone redesign; its gear opens the Settings
  // page, which now carries the connection and quota readings the sheet held.
  await page.click('[data-mobile-settings]')
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-mobile-settings-page]')
    return panel && Math.abs(panel.getBoundingClientRect().left) < .5
  })
  await contrast('phone-settings')
  await shot('phone-settings')
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
  await page.goto(url, { waitUntil: "networkidle2" })
}
