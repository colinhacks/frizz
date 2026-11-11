import assert from "node:assert/strict"
import test, { after, before } from "node:test"

// D7 REGRESSION. `/login` and `/logout` are frizz-owned account actions, intercepted at the composer
// submit boundary and never delivered to the worker as prompt text. That intercept used to live only in
// the drawer's ThreadActionBar: the queue cue card had its own send path with NO alias check, so typing
// `/login` into a card pasted the literal string into the running agent's stdin. Every surface now
// renders the SAME components/ThreadComposerBox, which owns the intercept — these tests pin it there.
//
// Skipped unless a Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts
// here): start `vite` in packages/web and set FRIZZ_COMPOSER_ALIAS_E2E_URL to its origin.
//
// ONE headless Chrome is shared across the whole file (via before/after) — a fresh browser per test is
// wasteful and, on a loaded machine, times out. Each test wipes the draft cache + reloads so it never
// bleeds between cases.
//
// SENDING IS ⌘/Ctrl-Enter, not a bare Enter (maintainer 2026-08-26, `lib/composerKeyboard.ts`): every
// prompt box reads as a form field, and a plain Enter is always a newline. These tests pressed a bare
// Enter and so never submitted anything — the modal simply never opened.
const baseUrl = process.env.FRIZZ_COMPOSER_ALIAS_E2E_URL

const SLUG = "alias-thread"
const CHAT = 'textarea[data-surface="chatComposer"]'

type Worker = { sent: string[]; rpc: string[] }
type PuppeteerModule = typeof import("puppeteer")
type Browser = Awaited<ReturnType<PuppeteerModule["launch"]>>
type Page = Awaited<ReturnType<Browser["newPage"]>>

let browser: Browser | undefined
let page: Page | undefined
let errors: string[] = []

before(async () => {
  if (!baseUrl) return
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  browser = await launchHeadless()
  page = await browser.newPage()
  page.setDefaultTimeout(60_000)
  await page.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 })
  page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
})

after(async () => { await browser?.close() })

const sent = (): Promise<string[]> => page!.evaluate(() => (window as unknown as { __worker: Worker }).__worker.sent)
const dialogText = (): Promise<string | null> =>
  page!.evaluate(() => document.querySelector('[role="dialog"], [role="alertdialog"]')?.textContent ?? null)
const boxValue = (sel: string): Promise<string> => page!.$eval(sel, (el) => (el as HTMLTextAreaElement).value)

// A fresh surface with an empty draft cache — drafts are localStorage-backed and deliberately survive
// navigation, so wipe + reload between cases.
async function open(box: string) {
  errors = []
  await page!.goto(`${baseUrl}/composer-alias-fixture.html`, { waitUntil: "networkidle2" })
  await page!.evaluate(() => localStorage.removeItem("frizz-drafts:v1"))
  await page!.reload({ waitUntil: "networkidle2" })
  await page!.waitForSelector(box)
}

// The app-wide send chord. Held as Meta because <Composer> accepts metaKey OR ctrlKey, and puppeteer
// sets the modifier on the CDP event regardless of the host OS.
async function pressSendChord() {
  await page!.keyboard.down("Meta")
  await page!.keyboard.press("Enter")
  await page!.keyboard.up("Meta")
}

async function typeAndSend(selector: string, text: string) {
  await page!.click(selector)
  await page!.type(selector, text)
  await pressSendChord()
  await new Promise((r) => setTimeout(r, 350))
}

async function dismissModal() {
  await page!.keyboard.press("Escape")
  await new Promise((r) => setTimeout(r, 300))
}

for (const surface of ["drawer"] as const) {
  const box = CHAT

  test(`${surface} composer: /login opens the sign-in modal and never reaches the worker`, {
    skip: !baseUrl,
    timeout: 150_000,
  }, async () => {
    await open(box)

    await typeAndSend(box, "/login")
    const modal = await dialogText()
    assert.ok(modal, `the ${surface} composer must open a modal for /login`)
    assert.match(modal, /Signed out of Claude/, "…and it must be the sign-in modal for this thread's backend")
    assert.deepEqual(await sent(), [], "/login must NEVER be delivered to the worker")
    assert.equal(await boxValue(box), "", "the intercepted alias clears the draft, exactly like a real send")

    // An ORDINARY follow-up from the same box still reaches the worker — the intercept is narrow.
    await dismissModal()
    await typeAndSend(box, "ship it")
    assert.deepEqual(await sent(), ["ship it"], "a plain follow-up is delivered untouched")
    assert.deepEqual(errors, [], "no console/page errors during the alias flow")
  })

  test(`${surface} composer: /logout opens the sign-out confirm and never reaches the worker`, {
    skip: !baseUrl,
    timeout: 150_000,
  }, async () => {
    await open(box)

    await typeAndSend(box, "/logout")
    const modal = await dialogText()
    assert.ok(modal, `the ${surface} composer must open a modal for /logout`)
    assert.match(modal, /Sign out of Claude\?/, "…and it must be the sign-out confirmation")
    assert.deepEqual(await sent(), [], "/logout must NEVER be delivered to the worker")

    // "/login please" is NOT an alias — frizz does not confiscate syntax it cannot prove is a command.
    await dismissModal()
    await typeAndSend(box, "/login please")
    assert.deepEqual(await sent(), ["/login please"], "only the exact alias is intercepted")
    assert.deepEqual(errors, [], "no console/page errors during the alias flow")
  })
}
