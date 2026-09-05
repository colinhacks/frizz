import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRIZZ_SUBAGENT_STEER_VISIBILITY_E2E_URL
const screenshotBase = process.env.FRIZZ_SUBAGENT_STEER_VISIBILITY_SCREENSHOT

test("the sub-agent drawer shows native follow-up arrivals and exact Frizz-authored steers", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("console", (message) => {
    if (message.type() === "error" && !/404|favicon/i.test(message.text())) errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push(String(error)))

  try {
    await page.setViewport({ width: 1200, height: 900, deviceScaleFactor: 1 })
    // The running-child drawer intentionally refetches its transcript, so "networkidle0" can never
    // be the readiness signal. The fixture's own button + transcript column are the convergence points.
    await page.goto(`${baseUrl}/subagent-steer-fixture.html?state=rich`, { waitUntil: "domcontentloaded" })
    await page.waitForSelector("[data-open-drawer]")
    await page.click("[data-open-drawer]")
    await page.waitForSelector("[data-transcript-column]")

    const transcript = await page.$eval("[data-transcript-column]", (element) => (element as HTMLElement).innerText)
    assert.match(transcript, /Follow-up instructions received\. Codex encrypted the message body, so Frizz can't display it\./)
    assert.match(transcript, /Focus the second pass on the queue divider semantics\./)
    assert.ok(
      transcript.indexOf("Follow-up instructions received") < transcript.indexOf("I received the follow-up"),
      "the arrival marker stays at its real point in the child's timeline",
    )
    assert.ok(
      transcript.indexOf("I received the follow-up") < transcript.indexOf("Focus the second pass"),
      "the exact Frizz-authored steer stays after the response to the native follow-up",
    )
    assert.deepEqual(errors, [], `browser console/page errors: ${errors.join("\n")}`)
    if (screenshotBase) await page.screenshot({ path: `${screenshotBase}-desktop.png` })
    await page.setViewport({ width: 430, height: 850, deviceScaleFactor: 2 })
    const overflow = await page.$eval("[data-transcript-column]", (column) => column.scrollWidth - column.clientWidth)
    assert.ok(overflow <= 1, `the drawer transcript overflows its narrow column by ${overflow}px`)
    if (screenshotBase) await page.screenshot({ path: `${screenshotBase}-narrow.png` })
  } finally {
    await browser.close()
  }
})
