import assert from "node:assert/strict"
import test, { after, before } from "node:test"

// The GitHub door sits in the line above the new-thread box and renders only in a GitHub repo, signed in
// or not, because clicking it is how someone signs in. These tests pin those states off the composer-icons
// fixture, whose `?norepo` stubs a project that is no GitHub repo and `?unauthed` a signed-out Frizz. The
// rail below it stays the paperclip and send whichever way the door goes.
//
// Skipped unless a Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts
// here): start `vite` in packages/web and set FRIZZ_COMPOSER_ICONS_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_COMPOSER_ICONS_E2E_URL

type PuppeteerModule = typeof import("puppeteer")
type Browser = Awaited<ReturnType<PuppeteerModule["launch"]>>
type Page = Awaited<ReturnType<Browser["newPage"]>>

let browser: Browser | undefined
let page: Page | undefined

before(async () => {
  if (!baseUrl) return
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  browser = await launchHeadless()
  page = await browser.newPage()
  page.setDefaultTimeout(60_000)
  await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 })
})

after(async () => {
  await browser?.close()
})

// The evaluate body must stay a single flat arrow — Nub's transform wraps nested function
// declarations in a `__name` helper that doesn't exist in the page context.
const rail = async (p: Page) =>
  p.evaluate(`(() => {
    const box = (label) => {
      const el = document.querySelector('button[aria-label^="' + label + '"]')
      return el ? el.getBoundingClientRect().toJSON() : null
    }
    return { github: box("Start threads"), attach: box("Attach files"), send: box("Send") }
  })()`) as Promise<{ github: DOMRect | null; attach: DOMRect | null; send: DOMRect | null }>

const assertAboveTheBox = (r: Awaited<ReturnType<typeof rail>>) => {
  assert.ok(r.github && r.attach && r.send)
  assert.ok(r.github!.bottom <= r.attach!.top, "the trigger sits above the box, not in its rail")
  const gap = r.send!.left - r.attach!.right
  assert.ok(gap >= 0 && gap <= 12, `attach abuts send (gap was ${gap}px)`)
}

test("authed: GitHub trigger renders above the box", { skip: !baseUrl }, async () => {
  await page!.goto(`${baseUrl}/composer-icons-fixture.html`, { waitUntil: "networkidle0" })
  await page!.waitForSelector('button[aria-label^="Start threads"]')
  const r = await rail(page!)
  assertAboveTheBox(r)
})

// REGRESSION (2026-08-11). The network to api.github.com dropped for nine minutes. `gh repo view` is a
// live API call, so the server answered inRepo:false, the trigger vanished — and it STAYED vanished in an
// open tab long after the network came back, because nothing re-asks a question already answered.
// useGithubStatus now polls while the answer is NO and stops at the first yes. This drives the real
// thing: a real browser, a real react-query interval, a real wall-clock minute. No reload.
const POLL_WINDOW_MS = 90_000
// The heal is waited for on a MUCH longer leash than the control sleeps. `GithubTrigger`'s
// `refetchInterval` is 60s while the answer is NO, and react-query starts that timer only once the
// first query settles — so the icon returns at 60s PLUS page load, plus the fetch, plus whatever the
// machine is doing. A 90s ceiling leaves 30s of headroom for all of that, and it is not enough: this
// test passed at 60s in one run and timed out at 91s in the next, on the same code (2026-08-24).
//
// A bigger ceiling costs nothing when the test passes, because the wait EXITS on the icon appearing —
// the usual run is still ~62s. What it buys is that a failure here means the icon never came back,
// which is the claim, rather than that the machine was busy. The CONTROL below keeps the 90s window,
// because that one sleeps the whole thing and only needs to outlast a single poll.
const HEAL_CEILING_MS = 180_000

test("a NO heals itself: the trigger comes back with no reload once the answer turns yes", { skip: !baseUrl, timeout: HEAL_CEILING_MS + 30_000 }, async () => {
  await page!.goto(`${baseUrl}/composer-icons-fixture.html?heals`, { waitUntil: "networkidle0" })
  await page!.waitForSelector('button[aria-label="Attach files"]')
  // The outage answer is in: the trigger is genuinely absent, so what follows cannot be a false pass.
  assert.equal((await rail(page!)).github, null, "the first (outage) answer must hide the trigger")
  await page!.waitForSelector('button[aria-label^="Start threads"]', { timeout: HEAL_CEILING_MS })
  const r = await rail(page!)
  assert.ok(r.github, "the trigger must return on its own once the answer turns yes")
  assertAboveTheBox(r)
})

test("a genuine NO stays no — the poll re-asks, it does not invent an icon", { skip: !baseUrl, timeout: POLL_WINDOW_MS + 30_000 }, async () => {
  // The control for the test above. Same wall-clock window, same poll, an answer that never turns yes.
  await page!.goto(`${baseUrl}/composer-icons-fixture.html?norepo`, { waitUntil: "networkidle0" })
  await page!.waitForSelector('button[aria-label="Attach files"]')
  await new Promise((resolve) => setTimeout(resolve, POLL_WINDOW_MS))
  assert.equal((await rail(page!)).github, null, "outside a GitHub repo it must stay hidden however many times it is re-asked")
})

test("signed out in a GitHub repo: the trigger still renders", { skip: !baseUrl }, async () => {
  await page!.goto(`${baseUrl}/composer-icons-fixture.html?unauthed`, { waitUntil: "networkidle0" })
  await page!.waitForSelector('button[aria-label^="Start threads"]')
  const r = await rail(page!)
  assertAboveTheBox(r)
})

test("no GitHub repo: no trigger, and attach sits directly beside send", { skip: !baseUrl }, async () => {
  await page!.goto(`${baseUrl}/composer-icons-fixture.html?norepo`, { waitUntil: "networkidle0" })
  await page!.waitForSelector('button[aria-label="Attach files"]')
  const r = await rail(page!)
  assert.equal(r.github, null, "GitHub trigger must not render outside a GitHub repo")
  assert.ok(r.attach && r.send)
  const gap = r.send!.left - r.attach!.right
  assert.ok(gap >= 0 && gap <= 12, `attach must abut send (gap was ${gap}px)`)
})
