import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer } from '../packages/web/node_modules/vite/dist/node/index.js'
import { launchHeadless } from './lib/headless-browser.mjs'
import { measureTextContrast, measureAppearanceInk } from './lib/light-mode-contrast.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const out = resolve(process.env.THEME_EVIDENCE_DIR ?? '.adhoc-shots/light-mode-gallery')
mkdirSync(out, { recursive: true })
const server = await createServer({ root: join(root, 'packages/web'), configFile: join(root, 'packages/web/vite.config.ts'), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error', plugins: [{ name: 'fixture-favicon', configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url === '/favicon.ico') { res.writeHead(204); res.end() } else next() }) } }] })
let browser, page
const results = [], errors = []
let current = ''
try {
  await server.listen()
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await launchHeadless()
  console.log('BROWSER', browser.process().pid)
  page = await browser.newPage()
  page.on('pageerror', error => errors.push({ current, error: String(error) }))
  page.on('console', event => { if (event.type() === 'error') errors.push({ current, error: `${event.text()} ${event.location().url}` }) })
  for (const theme of ['light', 'dark']) for (const width of [1100, 390]) {
    await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 })
    const load = async (fixture, query = '') => {
      current = `${theme}-${width}-${fixture}${query}`
      console.log('OPEN', current)
      await page.goto(`${origin}/${fixture}-fixture.html?theme=${theme}&font=sans&${query}`, { waitUntil: 'networkidle2' })
      await page.evaluate(async theme => {
        (await import('/src/lib/theme.ts')).setThemePreference(theme)
        ;(await import('/src/lib/font.ts')).initFont()
        await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))
      }, theme)
      assert.match(await page.$eval('body', el => getComputedStyle(el).fontFamily), /system-ui/)
    }
    const shot = async (name, selector) => {
      await page.mouse.move(0, 0)
      await page.evaluate(async () => {
        await new Promise(requestAnimationFrame)
        await Promise.all(document.getAnimations().filter(a => a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {})))
      })
      const file = `${theme}-${width}-${name}.png`
      if (selector) {
        const el = await page.waitForSelector(selector, { visible: true })
        await el.screenshot({ path: join(out, file) })
      } else await page.screenshot({ path: join(out, file) })
      results.push({ name, theme, width, file, contrast: await measureTextContrast(page), overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) })
      console.log('CAPTURE', file)
    }
    for (const mode of ['cards', 'shell', 'markdown', 'file', 'signin', 'restart', 'stalled', 'render-error']) {
      await load('light-mode-panels', `mode=${mode}`)
      await page.waitForSelector('[data-panel-fixture]')
      await shot(mode)
    }
    await load('github-picker-range', 'rows=8')
    await page.waitForSelector('[data-row-number]')
    await shot('github-picker')
    const tabs = await page.$$eval('button[aria-pressed]', buttons => buttons.map(el => ({ border: getComputedStyle(el).borderTopWidth, ring: getComputedStyle(el).getPropertyValue('--tw-inset-ring-shadow') })))
    assert.equal(tabs.length, 4, 'Both the Issues/PRs and Recent/Reactions segmented groups are present')
    for (const tab of tabs) {
      assert.equal(tab.border, '0px', 'GitHub tabs share the group frame')
      assert.doesNotMatch(tab.ring, /inset/, 'No separate tab outlines')
    }
    await page.click('[data-row-number]')
    await shot('github-picker-selected')
    await page.click('[aria-label="Triage prompt settings"]')
    await page.waitForSelector('[data-github-prompt-menu] textarea')
    await shot('github-prompt')
    assert.equal(await page.$eval('[data-github-prompt-menu] textarea', el => getComputedStyle(el).borderTopColor), await page.$eval('button[aria-pressed]', el => getComputedStyle(el.parentElement).borderTopColor), 'Triage prompt and tab group share one border tone')
    await load('first-run')
    await page.waitForSelector('[data-quota-gauge]')
    await shot('first-run')
    await page.click('[data-quota-gauge]')
    await page.waitForSelector('[data-quota-account]')
    await shot('quota')
    await load('icon-rhythm')
    await page.waitForSelector('button[title^="Attach"]')
    await shot('controls')
    if (width === 1100) {
      const scope = '.group:has(textarea[data-surface="iconRhythmFixturePlain"])'
      const selectors = `${scope} [title^="Attach"],${scope} button[title^="Send"]`
      const ink = await promisify(execFile)('nub', [join(root, 'scripts/ink-gaps.mjs'), page.url(), selectors, `--browser=${browser.wsEndpoint()}`, '--dsf=8', '--w=1100', '--h=1000', '--pad=0', `--before=document.documentElement.dataset.theme='${theme}'`], { cwd: root })
      writeFileSync(join(out, `${theme}-composer-ink.txt`), ink.stdout)
      const gaps = JSON.parse(ink.stdout).gaps.map(row => row.inkGap)
      assert.ok(gaps.length === 1 && gaps[0] >= 13.5 && gaps[0] <= 15.5, `The paperclip keeps its ink distance from send: ${gaps}`)
      await page.bringToFront()
      const viewport = page.viewport()
      await page.setViewport({ ...viewport, deviceScaleFactor: 8 })
      await (await page.$(scope)).screenshot({ path: join(out, `${theme}-composer-crop.png`) })
      await page.setViewport(viewport)
    }
    await page.click('button[data-snooze-menu]')
    await page.waitForSelector('[role="menu"]')
    await shot('snooze-menu')
    await page.evaluate(() => [...document.querySelectorAll('[role="menuitem"]')].find(el => /Custom/.test(el.textContent)).click())
    await page.waitForSelector('[role="dialog"]')
    await shot('snooze-custom')
    await load('icon-rhythm')
    await page.click('[aria-label="Goal"]')
    await page.waitForSelector('textarea[placeholder="What is this thread trying to achieve?"]')
    await shot('goal')
    await load('dispatch-composer-profile')
    await page.waitForSelector('[aria-label="Model and effort"]')
    const profileInk = await measureAppearanceInk(page, '[aria-label="Model and effort"]')
    assert.ok(Math.abs(profileInk.residual) < 0.5, 'The profile caret stays on the sans cap band')
    results.push({ name: 'profile-ink', theme, width, profileInk })
    await shot('new-thread')
    await load('subagent-completion')
    await page.waitForSelector('[data-live-rows]')
    await shot('subagent-rows', '[data-live-rows]')
    await page.click('[data-live-rows] button')
    await page.waitForSelector('.frizz-sheet-panel')
    await shot('subagent-drawer')
    await load('fence-card-gallery')
    await page.waitForSelector('main > div')
    const sections = await page.$$('main > div')
    for (const [i, section] of sections.entries()) {
      await section.screenshot({ path: join(out, `${theme}-${width}-card-${i}.png`) })
      results.push({ name: `card-${i}`, theme, width, file: `${theme}-${width}-card-${i}.png`, label: await section.$eval('p', el => el.textContent).catch(() => ''), contrast: await measureTextContrast(page) })
    }
  }
  assert.deepEqual(errors, [], 'No component page or console errors')
  assert.deepEqual(results.filter(row => row.overflow), [], 'No document overflow at either width')
  assert.deepEqual(results.filter(row => row.theme === 'light').flatMap(row => (row.contrast ?? []).filter(text => !text.disabled && text.ratio < 4.5).map(text => ({ file: row.file, ...text }))), [], 'Light text meets 4.5:1 across component states')
} catch (error) {
  if (page) await page.screenshot({ path: join(out, 'failure.png') }).catch(() => {})
  throw error
} finally {
  writeFileSync(join(out, 'gallery-results.json'), JSON.stringify({ results, errors }, null, 2))
  if (browser) { const pid = browser.process().pid; await browser.close(); console.log('CLOSED', pid) }
  await server.close()
  console.log('CLEANUP complete')
}
