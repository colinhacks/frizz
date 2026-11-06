import assert from "node:assert/strict"
import test, { after, before } from "node:test"

// The composer's SKILLS TYPEAHEAD (issue #21). A draft that is exactly one `/`-led token opens a menu
// of the thread's invocable skills; these tests pin the whole keyboard contract against the real
// <Composer> in a real browser: lazy single fetch, prefix-then-substring filtering, ArrowDown/Enter
// completion, Tab completion, Escape dismissing WITHOUT blurring (and staying dismissed until the
// draft changes), and — the seam that matters most — the ⌘/Ctrl-Enter send still reaching the worker
// the moment the menu is NOT showing, exactly as before the feature existed.
//
// A BARE Enter and the SEND CHORD are two different keys here (maintainer 2026-08-26,
// `lib/composerKeyboard.ts`): ⌘/Ctrl-Enter is the app-wide send, a plain Enter is a newline, and while
// the menu is open the menu claims the unmodified Enter as its accept key.
//
// Skipped unless a Vite URL serving the fixtures is provided (same pattern as the other *.e2e.test.ts
// here): start `vite` in packages/web and set FRIZZ_SKILLS_TYPEAHEAD_E2E_URL to its origin.
const baseUrl = process.env.FRIZZ_SKILLS_TYPEAHEAD_E2E_URL

const BOX = 'textarea[data-surface="chatComposer"]'
const MENU = "[data-slash-menu]"

type Hooks = { fetches: number; submitted: string[] }
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

const hooks = (): Promise<Hooks> => page!.evaluate(() => {
  const h = (window as unknown as { __typeahead: Hooks }).__typeahead
  return { fetches: h.fetches, submitted: h.submitted }
})
const menuRows = (): Promise<string[]> => page!.evaluate((sel) =>
  [...document.querySelectorAll(`${sel} button`)].map((row) => row.querySelector("span")!.textContent!), MENU)
const menuVisible = (): Promise<boolean> => page!.evaluate((sel) => Boolean(document.querySelector(sel)), MENU)
const boxValue = (): Promise<string> => page!.$eval(BOX, (el) => (el as HTMLTextAreaElement).value)
// Accepting a suggestion restores the caret in a requestAnimationFrame — the same idiom the
// Option-Enter newline path uses, because a controlled re-render has to commit before the offset means
// anything. A human cannot type inside that ~16ms; puppeteer's `type()` dispatches CDP events with no
// frame pacing and does, which lands the first characters at the OLD offset and scrambles the draft
// ("/frizz:gh heck the PRc"). Measured at roughly one run in four, on this file's own base. So wait for
// the caret the product actually reaches rather than racing it — this asserts the post-accept state, it
// does not paper over it.
const waitForCaretAtEnd = (): Promise<unknown> => page!.waitForFunction((sel) => {
  const el = document.querySelector(sel) as HTMLTextAreaElement | null
  return Boolean(el) && el!.selectionStart === el!.value.length && el!.selectionEnd === el!.value.length
}, {}, BOX)
// Each row's SOURCE cell, as the operator reads it: the visible label, and the cell's own box so the
// column's uniformity can be asserted rather than eyeballed. The invisible sizers under the label are
// excluded by `:not([aria-hidden])` — they exist only to reserve the width.
type SourceCell = { label: string; left: number; right: number }
const menuSources = (): Promise<Array<SourceCell | null>> => page!.evaluate((sel) =>
  [...document.querySelectorAll(`${sel} button`)].map((row) => {
    const cell = row.querySelector("span.grid > span:not([aria-hidden])")
    if (!cell) return null
    const box = cell.getBoundingClientRect()
    return { label: cell.textContent ?? "", left: Math.round(box.left), right: Math.round(box.right) }
  }), MENU)

// The app-wide send chord. Held as Meta because <Composer> accepts metaKey OR ctrlKey, and puppeteer
// sets the modifier on the CDP event regardless of the host OS.
async function pressSendChord() {
  await page!.keyboard.down("Meta")
  await page!.keyboard.press("Enter")
  await page!.keyboard.up("Meta")
}

async function open() {
  errors = []
  await page!.goto(`${baseUrl}/skills-typeahead-fixture.html`, { waitUntil: "networkidle2" })
  await page!.waitForSelector(BOX)
  await page!.click(BOX)
}

test("typing `/` opens the menu once fetched, filters as the name grows, and a space closes it", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  await page!.type(BOX, "/")
  await page!.waitForSelector(MENU)
  assert.equal((await menuRows()).length, 7, "a bare slash offers the whole list")

  await page!.type(BOX, "fr")
  // Prefix matches lead; the namespaced `frizz:gh` is still reachable this way.
  assert.deepEqual(await menuRows(), ["/frizz-stack", "/frizz:gh"])

  await page!.type(BOX, "izz-stack now")
  assert.equal(await menuVisible(), false, "arguments have begun — the menu must be gone")
  assert.equal((await hooks()).fetches, 1, "the list is fetched exactly once")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

// Where a skill came FROM, which the harness reports and frizz normalizes to one vocabulary. The
// column has to be ONE width across every row — including the row whose source is unknown — or an
// unlabelled row's description truncates ~50px further right than its neighbours' and the list reads
// ragged. The width is reserved by invisible sizers so the browser measures it in whichever of this
// app's two fonts is set, rather than by a constant that could only be right in one.
test("each suggestion names its source, in one column that every row shares", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  await page!.type(BOX, "/")
  await page!.waitForSelector(MENU)
  const cells = await menuSources()
  assert.deepEqual(cells.map((cell) => cell?.label), ["project", "plugin", "project", "global", "built-in", "global", ""],
    "the harness's own scopes, in frizz's vocabulary — and an empty cell where it reported none")
  const lefts = new Set(cells.map((cell) => cell!.left))
  const rights = new Set(cells.map((cell) => cell!.right))
  assert.equal(lefts.size, 1, `every source cell starts at one x: ${[...lefts].join(", ")}`)
  assert.equal(rights.size, 1, `every source cell ends at one x: ${[...rights].join(", ")}`)
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

test("ArrowDown+Enter completes the highlighted skill instead of sending, and the send still works after", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  await page!.type(BOX, "/fr")
  await page!.waitForSelector(MENU)
  await page!.keyboard.press("ArrowDown")
  await page!.keyboard.press("Enter")
  // The exact value also proves the accept swallowed the key: no newline, no send.
  assert.equal(await boxValue(), "/frizz:gh ", "Enter with the menu open completes, with a trailing space for arguments")
  assert.deepEqual((await hooks()).submitted, [], "…and must NOT send the draft")

  await waitForCaretAtEnd()
  await page!.type(BOX, "check the PR")
  await pressSendChord()
  assert.deepEqual((await hooks()).submitted, ["/frizz:gh check the PR"], "⌘-Enter with the menu closed sends as always")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

test("⌘-Enter overrides the open menu and sends the draft as typed", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  await page!.type(BOX, "/fr")
  await page!.waitForSelector(MENU)
  // The menu claims only the UNMODIFIED Enter. A send chord mid-name is the operator overriding the
  // suggestion, so the draft goes out uncompleted rather than turning into `/frizz-stack`.
  await pressSendChord()
  assert.deepEqual((await hooks()).submitted, ["/fr"], "the send chord is not the menu's accept key")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

test("Tab completes the highlighted skill", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  await page!.type(BOX, "/head")
  await page!.waitForSelector(MENU)
  await page!.keyboard.press("Tab")
  assert.equal(await boxValue(), "/headless-browser ")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

test("Escape dismisses without blurring and stays dismissed until the draft changes", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  await page!.type(BOX, "/vis")
  await page!.waitForSelector(MENU)
  await page!.keyboard.press("Escape")
  assert.equal(await menuVisible(), false, "Escape closes the menu")
  const focused = await page!.evaluate((sel) => document.activeElement === document.querySelector(sel), BOX)
  assert.equal(focused, true, "…but must NOT blur the box — that is the NEXT Escape's job")
  await page!.type(BOX, "u")
  await page!.waitForSelector(MENU)
  assert.deepEqual(await menuRows(), ["/visual-review"], "typing again reopens the menu")
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})

// NO PANEL IS AS WIDE AS THE BOX IT OPENS OFF (maintainer 2026-11-06). The menu took the box's exact span
// until then. It keeps the box's left edge, where its `/name` lands under the row that offered it.
test("the menu takes a share of the prompt box, from its left edge", {
  skip: !baseUrl,
  timeout: 150_000,
}, async () => {
  await open()
  await page!.type(BOX, "/")
  await page!.waitForSelector(MENU)
  const { share, offset, boxWidth } = await page!.evaluate((menu, textarea) => {
    const panel = document.querySelector(menu)!.getBoundingClientRect()
    const box = document.querySelector(textarea)!.closest("[data-composer-box]")!.getBoundingClientRect()
    return { share: panel.width / box.width, offset: panel.left - box.left, boxWidth: box.width }
  }, MENU, BOX)
  assert.ok(share <= 0.72, `the menu takes ${share} of the ${boxWidth}px box`)
  assert.ok(Math.abs(offset) < 0.5, `it starts on the box's left edge, off by ${offset}`)
  assert.deepEqual(errors, [], `no page errors: ${errors.join(" | ")}`)
})
