import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRIZZ_SUBAGENT_COMPLETION_E2E_URL

// Both of the maintainer's 2026-07-27 asks are RENDERING facts, so they are pinned in a real browser
// against the real components (subagent-completion-fixture.html), not in string assertions:
//
//   1. A sub-agent finishing draws the SAME centred wake divider a background shell's completion draws
//      — same chrome, adjacent in the same transcript — instead of a second AgentBlock card that
//      disappeared into the surrounding tool band.
//   2. Every sub-agent title is a drill-in link that opens the drawer: the transcript launch card, the
//      completion divider, the rail row, the queue-card row, the ops-strip row, AND a nested dispatch
//      inside the sub-agent drawer itself (which had no slug at all and rendered as dead text).
//
// Run it against a plain vite over packages/web:
//   npx vite --port 5211 --strictPort --host 127.0.0.1
//   FRIZZ_SUBAGENT_COMPLETION_E2E_URL=http://127.0.0.1:5211 nub --test …
test("a finished sub-agent draws the shell's wake divider, and every sub-agent title opens the drawer", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  const errors: string[] = []
  // The bare fixture page serves no favicon, so Chrome logs a 404 whose console text carries no URL.
  // Track failing RESPONSE urls separately and exclude that one by path.
  const notFound: string[] = []
  page.on("response", (r) => { if (r.status() === 404) notFound.push(new URL(r.url()).pathname) })
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))

  try {
    await page.setViewport({ width: 1440, height: 1200, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/subagent-completion-fixture.html`, { waitUntil: "networkidle0" })

    // ---- 1. convergence ----
    const dividers = await page.$$eval("[data-after] [data-wake-divider]", (nodes) =>
      nodes.map((n) => ({
        marker: (n as HTMLElement).dataset.wakeDivider,
        text: (n as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
        hairlines: n.querySelectorAll("span.h-px").length,
        cls: n.className,
      })),
    )
    assert.equal(dividers.length, 4, "the after panel holds a steer, a codex follow-up, an agent completion and a shell wake")
    const [steer, followup, agent, shell] = dividers
    assert.equal(agent.marker, "agent")
    assert.equal(shell.marker, "event")
    // The convergence itself: identical chrome, two hairlines each, same wrapper classes.
    assert.equal(agent.cls, shell.cls, "the agent divider must reuse the shell wake divider's chrome verbatim")
    assert.equal(agent.hairlines, 2)
    assert.equal(shell.hairlines, 2)
    // innerText inserts a space between the guillemets and the title because they are separate flex
    // items (the guillemets sit OUTSIDE the truncating title so a clipped title still closes its
    // quote); the gap-less nested flex renders them touching. Tolerate that in the extraction only.
    assert.match(agent.text, /Sub-agent\s+«\s*Audit the pricing parser for edge cases\s*»\s+finished · 35m$/)
    assert.match(shell.text, /Background task «.+» exited 143$/)

    // ---- 1b. a STEER draws the same divider (maintainer 2026-07-31) ----
    // "render 'Steered' or SendMessage using the same full width notifications, the horizontal rule
    // style component that we render when an agent completes." Same chrome as the completion beside it,
    // and the title is the child's DISPATCH DESCRIPTION — not the raw agentId the model addressed.
    assert.equal(steer.marker, "agent-steer")
    assert.equal(steer.cls, agent.cls, "the steer divider must reuse the completion divider's chrome verbatim")
    assert.equal(steer.hairlines, 2)
    assert.match(steer.text, /^Steered\s+«\s*Audit the pricing parser for edge cases\s*»$/)
    // NEITHER the summary NOR the body may appear on it — the same ruling the report line took.
    assert.doesNotMatch(steer.text, /narrow the audit|Skip the currency formatting/)
    // A codex peer call names a target this transcript never dispatch-acked, so it has no dispatch id:
    // the title must stay PLAIN TEXT rather than become a dead link.
    assert.equal(followup.marker, "agent-steer")
    assert.match(followup.text, /^Followed up\s+«\s*codex-child-2\s*»$/)
    const followupLinks = await page.$$eval("[data-after] [data-wake-divider]", (ns) =>
      ns.filter((n) => (n as HTMLElement).innerText.includes("Followed up")).map((n) => n.querySelectorAll("button").length),
    )
    assert.deepEqual(followupLinks, [0], "an unresolvable codex target must not render a button")

    // The steer point must no longer draw a bordered tool card anywhere in the thread's chat.
    const sendHeaders = await page.$$eval("[data-after] .frizz-bash-label", (n) => n.map((e) => e.textContent))
    assert.ok(!sendHeaders.includes("Steered"), "the thread chat draws no Steered card")

    // The completion point must no longer draw a bordered tool card. The after panel's ONLY Agent card
    // is the launch one; the before panel (the old rendering) keeps two, which is what made them
    // indistinguishable.
    const agentCards = (label: string) => page.$$eval(`${label} .frizz-bash-header`, (h) => h.filter((n) => n.textContent?.startsWith("Agent")).length)
    assert.equal(await agentCards("[data-after]"), 1, "after: the dispatch card only")
    assert.equal(await agentCards("[data-before]"), 2, "before: the duplicate card this change removed")

    // ---- 2. every title opens the drawer ----
    const surfaces: [string, string][] = [
      ["completion divider", "[data-after] [data-subagent-completion-open]"],
      ["steer divider", "[data-after] [data-subagent-steer-open]"],
      ["transcript launch card", '[data-after] button[aria-label^="Open sub-agent transcript"]'],
      ["sidebar rail row", '[data-live-rows] button[class*="pl-[26px]"]'],
      ["queue card row", "[data-queue-subagents] button"],
      ["drawer ops strip row", '[data-live-rows] [data-op-row] button[aria-label^="Open sub-agent transcript"]'],
    ]
    // Teardown between surfaces goes through the DOM (a drawer mid-slide-out fails hit-testing, which
    // would be a flake, not a finding). The affordance assertions above are the ones that use a real
    // mouse press.
    const closeAll = async () => {
      await page.evaluate(() => { for (const b of document.querySelectorAll<HTMLElement>('[aria-label="Close"]')) b.click() })
      await page.waitForFunction(() => document.querySelectorAll('[aria-label="Close"]').length === 0, { timeout: 5000 })
    }
    // A REAL mouse click on the rendered button (not el.click()), so a zero-size or covered affordance
    // fails here rather than silently "passing" through a synthetic dispatch.
    const mouseClick = async (selector: string) => {
      const el = await page.$(selector)
      if (!el) return false
      await el.evaluate((n) => n.scrollIntoView({ block: "center" }))
      await new Promise((r) => setTimeout(r, 120))
      await el.click()
      return true
    }
    for (const [label, selector] of surfaces) {
      assert.ok(await mouseClick(selector), `${label} must render a real, clickable button`)
      await page.waitForSelector('[aria-label="Close"]', { timeout: 5000 })
      // WAIT FOR THE CONTENT, not for 400ms. The drawer mounts before its transcript resolves, and a
      // fixed sleep only holds on an idle machine: under any real load this read landed on an empty
      // drawer and failed with "must open a resolved … drawer", which reads as a broken affordance
      // rather than as a slow one. Measured 2026-08-24 — this file failed inside a full suite run and
      // passed 2/2 alone. The assertion below is unchanged; it is now reached when there is something
      // to assert about.
      await page.waitForFunction(() => {
        const text = document.body.innerText
        return text.includes("Reading the tier table") || text.includes("Transcript unavailable")
      }, { timeout: 5000 }).catch(() => {})
      const body = await page.$eval("body", (b) => (b as HTMLElement).innerText)
      assert.ok(
        body.includes("Reading the tier table") || body.includes("Transcript unavailable"),
        `${label} must open a resolved (or plainly unavailable) sub-agent drawer`,
      )
      await closeAll()
    }

    // ---- 2b. the DRAWER keeps the peer-message CARD, body and all ----
    // This is the other half of the divider change, not an inconsistency. The divider's whole contract
    // is "click the title and read it there": the child's own upward `SendMessage` record is where an
    // upward report's text actually lives, so hollowing this one out too would leave the message
    // unreadable on every surface. It must therefore stay a bordered card with an expandable body.
    assert.ok(await mouseClick("[data-after] [data-subagent-steer-open]"))
    await page.waitForFunction(() => document.body.innerText.includes("Reading the tier table"), { timeout: 5000 })
    assert.equal(
      await page.$$eval('[data-wake-divider="agent-steer"]', (n) => n.length),
      2,
      "the drawer draws no steer divider — only the two in the thread panel",
    )
    const reported = await page.evaluate(() => {
      const h = [...document.querySelectorAll<HTMLElement>(".frizz-bash-header")].find((n) => n.textContent?.startsWith("Reported"))
      if (!h) return null
      h.click()
      return h.parentElement!.innerText.replace(/\s+/g, " ").trim()
    })
    assert.ok(reported, "the child's own upward SendMessage keeps its bordered card in the drawer")
    // Same rule as above: the disclosure was just clicked open, so wait for the body it reveals rather
    // than for a fixed 400ms.
    await page.waitForFunction(() => {
      const h = [...document.querySelectorAll<HTMLElement>(".frizz-bash-header")].find((n) => n.textContent?.startsWith("Reported"))
      return /rounds half-away-from-zero, not half-even/.test(h?.parentElement?.innerText ?? "")
    }, { timeout: 5000 }).catch(() => {})
    const openedBody = await page.evaluate(() => {
      const h = [...document.querySelectorAll<HTMLElement>(".frizz-bash-header")].find((n) => n.textContent?.startsWith("Reported"))
      return h!.parentElement!.innerText.replace(/\s+/g, " ").trim()
    })
    assert.match(openedBody, /rounds half-away-from-zero, not half-even/, "…and its body is still readable there")
    await closeAll()

    // A dispatch NESTED inside the sub-agent drawer — the scenario that was dead text before, because
    // the drawer provides no ThreadSlugContext. Both its card and its own completion divider must link.
    assert.ok(await mouseClick("[data-after] [data-subagent-completion-open]"))
    await page.waitForSelector('[aria-label="Close"]', { timeout: 5000 })
    // The drawer defers its transcript body a frame past the slide-in, so wait for the child's content.
    await page.waitForFunction(() => document.body.innerText.includes("Reading the tier table"), { timeout: 5000 })
    const nested = await page.$$eval("[data-subagent-completion-open]", (n) => n.map((e) => (e as HTMLElement).innerText))
    assert.ok(nested.some((t) => t.includes("Write property tests")), "the child's own completion divider links too")
    const nestedCard = await page.$$eval('button[aria-label^="Open sub-agent transcript"]', (n) => n.map((e) => e.getAttribute("aria-label")))
    assert.ok(nestedCard.some((t) => t?.includes("Write property tests")), "the child's own dispatch card links too")

    // A grandchild id the tailer cannot resolve degrades to the stated unavailable state, never a
    // dead link and never a blank drawer.
    // The drawer's text arrives about 5ms after the drawer mounts, and the drawer then slides in for
    // 200ms. Until it has, this link is past the window's right edge and cannot be pressed ("Node is
    // either not clickable"). The read above used to take long enough by accident; on 2026-11-10 it
    // stopped doing so, 4 runs of 4. Wait for the link to come to rest inside the window.
    await page.waitForFunction(() => {
      const link = [...document.querySelectorAll("[data-subagent-completion-open]")].at(-1)
      if (!link) return false
      const { left, right } = link.getBoundingClientRect()
      const seen = window as unknown as { nestedLinkLeft?: number }
      const atRest = seen.nestedLinkLeft === left
      seen.nestedLinkLeft = left
      return atRest && right <= innerWidth
    }, { timeout: 5000, polling: 50 })
    const nestedLink = (await page.$$("[data-subagent-completion-open]")).at(-1)
    await nestedLink!.click()
    await new Promise((r) => setTimeout(r, 900))
    const afterNested = await page.$eval("body", (b) => (b as HTMLElement).innerText)
    assert.match(afterNested, /Transcript unavailable/)

    assert.deepEqual(errors, [])
    assert.deepEqual(notFound.filter((p) => p !== "/favicon.ico"), [])
  } finally {
    await browser.close()
  }
})
