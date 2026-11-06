import assert from "node:assert/strict"
import test from "node:test"

// The new-thread box's model chip and the marks that answer to it hold one line at the sidebar's narrowest:
// a long model name truncates, and the gauge and the plug stay beside it. A static render cannot see this,
// because whether a flex row wraps or shrinks is the browser's to decide. On 2026-11-06 the chip's own
// `max-w-full` beat its 72% cap, so the name took the whole line and pushed both marks onto a row of their own.
//
//   cd packages/web && nubx vite --port 5947 --strictPort
//   FRIZZ_QUOTA_GAUGE_E2E_URL=http://127.0.0.1:5947 nub run test packages/web/src/components/agentMarksWidth.e2e.test.ts
const baseUrl = process.env.FRIZZ_QUOTA_GAUGE_E2E_URL

test("at the sidebar's 272px floor a long model name truncates and the marks keep its line", { skip: !baseUrl, timeout: 90_000 }, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    const errors: string[] = []
    page.on("pageerror", (error) => errors.push(String(error)))
    await page.setViewport({ width: 900, height: 600, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/status-row-fixture.html?model=long&width=272`, { waitUntil: "networkidle0" })
    await page.waitForSelector("[data-agent-marks] [data-quota-gauge]")
    await page.waitForSelector("[data-agent-marks] [data-mcp-plug]")
    const layout = await page.$eval("[data-composer-box]", (box) => {
      const middle = (selector: string) => {
        const rect = box.querySelector(selector)!.getBoundingClientRect()
        return rect.top + rect.height / 2
      }
      const value = box.querySelector<HTMLElement>(".profile-grid-value")!
      return {
        label: value.textContent,
        truncated: value.scrollWidth > value.clientWidth,
        chip: middle(".profile-grid-trigger"),
        gauge: middle("[data-quota-gauge]"),
        plug: middle("[data-mcp-plug]"),
        clip: middle('button[aria-label="Attach files"]'),
        marksRight: box.querySelector("[data-agent-marks]")!.getBoundingClientRect().right,
        clipLeft: box.querySelector('button[aria-label="Attach files"]')!.getBoundingClientRect().left,
      }
    })
    assert.match(layout.label ?? "", /gpt-5\.5-codex-max-preview/)
    assert.equal(layout.truncated, true, "the name is the thing that gives way")
    for (const mark of ["gauge", "plug", "clip"] as const) assert.equal(layout[mark], layout.chip, `${mark} is on the chip's line`)
    assert.ok(layout.marksRight <= layout.clipLeft, "the marks stop short of the rail")
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
