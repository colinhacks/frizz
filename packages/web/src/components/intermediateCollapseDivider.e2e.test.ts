import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync, mkdirSync } from "node:fs"
import { projectCodexTranscript } from "../../../server/src/transcript.ts"

const baseUrl = process.env.FRIZZ_INTERMEDIATE_COLLAPSE_E2E_URL

// The queue card's collapsed intermediate run is a HAIRLINE DIVIDER, not a bordered bar (maintainer
// 2026-07-31: "turn this into a hairline divider … the expand icon, followed by the number of tool
// calls, then something that just says 'Click to expand'. We can drop the step count."). All three
// halves of that are RENDERING facts, so they are pinned in a real browser against the real components
// rather than in string assertions:
//
//   1. It wears the transcript's shared WakeDivider chrome — two hairlines flanking a centred label —
//      and paints no border or panel fill of its own. A box here reads as a card competing with the
//      messages it sits between, which is what it used to be.
//   2. The label is `N tool calls · Click to expand`, and carries NO step count anywhere.
//   3. The whole ROW is the affordance, and expanding is still ONE-WAY: a real mouse press anywhere on
//      it restores every hidden tool disclosure and unmounts the divider.
//
// Run it against a plain vite over packages/web:
//   nubx vite --port 5247 --strictPort --host 127.0.0.1
//   FRIZZ_INTERMEDIATE_COLLAPSE_E2E_URL=http://127.0.0.1:5247 nub --test …
const SEL = '[data-wake-divider="intermediate-summary"]'

const launch = async () => {
  const { default: puppeteer } = await import("puppeteer")
  const browser = await puppeteer.launch({ headless: "new", args: ["--no-sandbox", "--force-color-profile=srgb"] })
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("console", (m) => { if (m.type() === "error" && !m.text().includes("404")) errors.push(m.text()) })
  page.on("pageerror", (e) => errors.push(String(e)))
  await page.setViewport({ width: 1440, height: 1100, deviceScaleFactor: 1 })
  return { browser, page, errors }
}

const variant = (v: string) => new URL(`/intermediate-collapse-fixture.html?variant=${v}`, baseUrl).href

test("Codex narrated tool batches collapse between the opening and final answer, and expand losslessly", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const raw = readFileSync(process.env.FRIZZ_CODEX_REPLAY ?? new URL("../../../server/src/backend/codex.fixtures/exec-two-turn.jsonl", import.meta.url), "utf8")
  const messages = projectCodexTranscript(raw)
  const lastUser = messages.findLastIndex((m) => m.role === "user")
  const prose = messages.slice(lastUser + 1).filter((m) => m.role === "assistant" && !m.kind && m.text)
  assert.ok(prose.length >= 3, "the projector must preserve intermediate prose as separate collapse candidates")
  const middle = prose.slice(1, -1)
  const { browser, page, errors } = await launch()
  try {
    await page.setRequestInterception(true)
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/codex-replay.json") void request.respond({ contentType: "application/json", body: JSON.stringify({ messages }) })
      else void request.continue()
    })
    for (const font of ["sans", "mono"]) {
      for (const width of [1100, 390]) {
        await page.setViewport({ width, height: 1000, deviceScaleFactor: 2 })
        await page.goto(new URL("/intermediate-collapse-fixture.html?src=/codex-replay.json", baseUrl).href, { waitUntil: "networkidle0" })
        await page.evaluate((font) => { document.documentElement.dataset.font = font }, font)
        await page.waitForSelector(SEL, { timeout: 5000 }).catch(async (error) => {
          console.error({ font, width, errors, body: await page.$eval("body", (el) => el.innerText) })
          throw error
        })
        for (const message of middle) {
          assert.equal(await page.$(`[data-transcript-source-id="${message.sourceId}"]`), null, `intermediate narration leaked: ${message.text.slice(0, 70)}`)
        }
        for (const anchor of [prose[0], prose.at(-1)!]) {
          assert.ok(await page.$(`[data-transcript-source-id="${anchor.sourceId}"]`), "opening and closing prose remain visible")
        }
        if (process.env.FRIZZ_CODEX_SHOTS) {
          mkdirSync(process.env.FRIZZ_CODEX_SHOTS, { recursive: true })
          await page.screenshot({ path: `${process.env.FRIZZ_CODEX_SHOTS}/${font}-${width}.png`, fullPage: true })
          const bottom = await page.$eval(`[data-transcript-source-id="${prose.at(-1)!.sourceId}"]`, (el) => (el.querySelector("p") ?? el).getBoundingClientRect().bottom)
          await page.screenshot({ path: `${process.env.FRIZZ_CODEX_SHOTS}/${font}-${width}-collapse.png`, clip: { x: 0, y: 0, width, height: Math.ceil(bottom + 16) } })
        }
        await page.click(SEL)
        await page.waitForFunction((sel) => !document.querySelector(sel), {}, SEL)
        const expandedIds = await page.$$eval("[data-transcript-source-id]", (els) => els.map((el) => el.getAttribute("data-transcript-source-id")))
        for (const message of prose) assert.ok(expandedIds.includes(message.sourceId!), "expansion restores every prose message")
      }
    }
    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
    assert.equal(browser.process()?.exitCode, 0, "the owned browser exited")
  }
})

test("the collapsed intermediate run is a hairline divider that names its tool calls and nothing else", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.goto(variant("heavy"), { waitUntil: "networkidle0" })
    await page.waitForSelector(SEL, { timeout: 10_000 })

    const divider = await page.$eval(SEL, (n) => {
      const el = n as HTMLElement
      const cs = getComputedStyle(el)
      return {
        tag: el.tagName,
        text: el.innerText.replace(/\s+/g, " ").trim(),
        aria: el.getAttribute("aria-label"),
        hairlines: el.querySelectorAll("span.h-px").length,
        icons: el.querySelectorAll("svg").length,
        borderWidth: cs.borderTopWidth,
        // A divider draws NO fill of its own. `rgba(…, 0)` and `transparent` both read as no paint.
        painted: !/^(transparent|rgba\(0, 0, 0, 0\))$/.test(cs.backgroundColor),
      }
    })

    // ---- 1. the shared divider chrome, and no box of its own ----
    assert.equal(divider.tag, "BUTTON", "the whole row is the affordance, so the root is the control")
    assert.equal(divider.hairlines, 2, "two hairlines flanking the label — the transcript's divider chrome")
    assert.equal(divider.icons, 1, "the stacked-chevron expand glyph leads the label")
    assert.equal(divider.borderWidth, "0px", "a hairline divider draws no border — that was the bordered bar")
    assert.equal(divider.painted, false, "…and no panel fill either")

    // The chrome must be the SAME one the wake dividers wear, not a look-alike. Compare against a real
    // one rendered by ChatView on another fixture rather than restating class names here.
    await page.goto(new URL("/subagent-completion-fixture.html", baseUrl).href, { waitUntil: "networkidle0" })
    await page.waitForSelector('[data-wake-divider="agent"]', { timeout: 10_000 })
    const wakeChrome = await page.$eval('[data-wake-divider="agent"]', (n) => ({
      label: (n.querySelector("span.petite-caps") as HTMLElement).className,
      hairline: (n.querySelector("span.h-px") as HTMLElement).className,
    }))
    await page.goto(variant("heavy"), { waitUntil: "networkidle0" })
    await page.waitForSelector(SEL, { timeout: 10_000 })
    const ourChrome = await page.$eval(SEL, (n) => ({
      label: (n.querySelector("span.petite-caps") as HTMLElement).className,
      hairline: (n.querySelector("span.h-px") as HTMLElement).className,
    }))
    assert.deepEqual(ourChrome, wakeChrome, "the collapse divider must reuse the wake divider's chrome verbatim")

    // ---- 2. the label: tool calls and the affordance, never a step count ----
    assert.equal(divider.text, "11 tool calls · Click to expand")
    assert.doesNotMatch(divider.text, /step/i, "the step count was dropped — it must not come back")
    assert.doesNotMatch(divider.text, /\bShow\b/, "the trailing Show chip went with the bar")
    assert.equal(divider.aria, "Expand 11 tool calls of intermediate agent activity")

    // ---- 3. a REAL mouse press on the row expands it, one-way ----
    // Not el.click(): a zero-height or covered row must fail here rather than pass through a synthetic
    // dispatch. The divider is an 18px rule, which is exactly the geometry worth proving hittable.
    const box = (await (await page.$(SEL))!.boundingBox())!
    assert.ok(box.height >= 12, `the row must be a real hit target, got ${box.height}px`)
    const hitsItself = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement
      const r = el.getBoundingClientRect()
      return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(sel) === el
    }, SEL)
    assert.ok(hitsItself, "nothing may cover the divider's own centre")

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 0, {}, SEL)

    // Every hidden call comes back, and they add up to exactly what the label promised.
    const restored = await page.$$eval("[data-tool-activity] button", (ns) =>
      ns.map((n) => (n as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
    )
    const restoredCalls = restored.reduce((sum, label) => sum + Number(/Ran (\d+) tool call/.exec(label)?.[1] ?? 0), 0)
    assert.equal(restoredCalls, 11, `the expansion must restore exactly the 11 calls the label counted, got ${restored.join(" | ")}`)

    // ---- 4. a run with no tool calls states only the affordance ----
    await page.goto(variant("notools"), { waitUntil: "networkidle0" })
    await page.waitForSelector(SEL, { timeout: 10_000 })
    const bare = await page.$eval(SEL, (n) => ({
      text: (n as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
      aria: n.getAttribute("aria-label"),
    }))
    assert.equal(bare.text, "Click to expand", "with nothing to count, the label is just the affordance")
    assert.equal(bare.aria, "Expand intermediate agent activity")

    // ---- 5. background tasks and sub-agent dispatches FOLD IN with everything else ----
    // They used to be lifted out as their own cards (maintainer 2026-08-01: "It's important that those
    // show up in the chat"), and that was reversed for the QUEUE CARD on 2026-08-12 — the card is a
    // triage surface whose shape is "the user's most recent message, some bit of text, then the click to
    // expand section followed by more text" ("I don't know why the bash calls weren't folded in to the
    // click to expand section that's kind of weird" … "Fold them in"). Nothing is lost: a task still
    // RUNNING is listed under the card's own prompt box from live board telemetry, and a finished one is
    // history the fold carries. The THREAD VIEW still gives every one its own card, with the mark and
    // flush rules this section used to pin here.
    await page.goto(variant("bgshells"), { waitUntil: "networkidle0" })
    await page.waitForSelector(SEL, { timeout: 10_000 })
    assert.deepEqual(
      await page.$$eval(".frizz-bash-header", (ns) => ns.map((n) => (n as HTMLElement).innerText.replace(/\s+/g, " ").trim())),
      [],
      "no background task keeps a card of its own on a queue card",
    )
    assert.deepEqual(
      await page.$$eval("[data-tool-activity] button", (ns) => ns.map((n) => (n as HTMLElement).innerText.trim())),
      [],
      "…and nothing escapes as a batched activity band either",
    )
    assert.equal(
      await page.$eval(SEL, (n) => (n as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
      "8 tool calls · Click to expand",
      "every launch is counted by the divider instead",
    )

    // ---- 6. sub-agent dispatches get exactly the same treatment ----
    await page.goto(variant("dispatches"), { waitUntil: "networkidle0" })
    await page.waitForSelector(SEL, { timeout: 10_000 })
    assert.deepEqual(
      await page.$$eval(".frizz-bash-header", (ns) => ns.map((n) => (n as HTMLElement).innerText.replace(/\s+/g, " ").trim())),
      [],
      "no dispatch keeps a card of its own on a queue card",
    )
    assert.equal(
      await page.$eval(SEL, (n) => (n as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
      "6 tool calls · Click to expand",
      "both dispatches are counted by the divider",
    )

    // ---- 7. an orphaned codex poll is chatter, and folds into the count ----
    // A codex long-poll gate emits `wait`/`write_stdin` calls the projector cannot pair with a launch, so
    // each reaches the client pending + `backgroundState: "unknown"` — which used to buy it a dedicated
    // card. A real rollout produced 888 of them, and the queue card was a wall of `Wait · cell 30 ·
    // unknown` rows counting up forever (maintainer 2026-08-09). Everything in the run folds now, polls
    // and the genuinely detached shell alike, so the count is the whole assertion.
    await page.goto(variant("codexpolls"), { waitUntil: "networkidle0" })
    await page.waitForSelector(SEL, { timeout: 10_000 })
    assert.deepEqual(
      await page.$$eval(".frizz-bash-header", (ns) => ns.map((n) => (n as HTMLElement).innerText.replace(/\s+/g, " ").trim())),
      [],
      "not even the detached shell keeps a card here",
    )
    assert.equal(
      await page.$eval(SEL, (n) => (n as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
      "13 tool calls · Click to expand",
      "the ten polls are counted by the divider rather than drawn",
    )

    // ---- 8. the REST is the cut: no rest RULE is drawn, but every rested message survives ----
    // "Agent rested" itself is never drawn — the card is a triage surface for the standing signal and
    // that hairline is its own premise (maintainer 2026-08-11: "you shoudl NOT render the hairline for
    // the rest/stop hook"). The rest still CUTS, which is a different claim and the one that matters:
    // each run gets its own fold, and the message the agent rested on is that run's closing prose, so it
    // renders in full (2026-08-16: "you should show all of the resting messages, but then all of the
    // stuff between them can be collapsed"). The WINDOW, meanwhile, reaches back to the human's last
    // message rather than to the previous rest, so the earlier turn renders too.
    await page.goto(variant("priorrest"), { waitUntil: "networkidle0" })
    await page.waitForSelector(SEL, { timeout: 10_000 })
    const card = await page.evaluate(() => document.body.innerText)
    assert.equal(
      await page.$$eval('[data-wake-divider="rest"]', (ns) => ns.length),
      0,
      "the rest/stop-hook hairline is never drawn on a queue card",
    )
    assert.doesNotMatch(card, /Agent rested/, "…and its label must not survive as any other row either")
    assert.match(card, /Kick off the release workflow/, "the human's own ask anchors the window")
    // TWO folds, because the rest between them cut — and the message the agent rested on stands between
    // them in full. Before the rest cut, this was one run whose fold swallowed that message whole.
    assert.equal(await page.$$eval(SEL, (ns) => ns.length), 2, "the rest cuts the two turns into their own folds")
    assert.match(card, /Fixed — the workflow is running/, "the message the agent RESTED on always renders")
    assert.match(card, /The watcher came back green/, "…and the resumed run opens on its own narration")
    // …WITH THE COMPLETION MARKER BETWEEN THEM, because here it is the WAKER: the agent was at rest and
    // this is what re-invoked it. It used to be dropped on the grounds that its LAUNCH card stood for it,
    // and that stopped being true when launches were folded into the count — so a run began with nothing
    // saying what began it. A completion MID-run still folds; only position distinguishes them.
    // Read in order: the marker must sit under the rested message and ABOVE its run's fold, never after.
    const restedLadder = await page.$$eval("[data-wake-divider]", (ns) =>
      ns.map((n) => (n as HTMLElement).innerText.replace(/\s+/g, " ").trim()),
    )
    assert.deepEqual(
      restedLadder,
      ["1 tool call · Click to expand", "Background task «Watching the release run» exited 0", "4 tool calls · Click to expand"],
      `the waker names the resumption between the two runs, got ${restedLadder.join(" | ")}`,
    )

    // ---- 9. ONE FOLD PER WAKE ----
    // The shape this collapse exists for (maintainer 2026-08-12): an agent parks on a PR watcher, the
    // watcher fires, it works, it rests, the watcher fires again. Each run folds SEPARATELY, and each
    // wake's hairline sits BETWEEN the run it ended and the run it caused — "multiple messages in their
    // complete form, with various collapsed tool call blocks between them, plus some hairline indicators
    // showing why they were reawoken". One global span produced the opposite: every hairline clustered
    // above a single fold, detached from the work it explained.
    await page.goto(variant("prwakes"), { waitUntil: "networkidle0" })
    await page.waitForSelector(SEL, { timeout: 10_000 })
    // Read the whole ladder IN DOCUMENT ORDER — the interleaving is the entire claim, and three folds in
    // the right count but the wrong places would pass a per-selector check.
    const ladder = await page.$$eval("[data-wake-divider]", (ns) =>
      ns.map((n) => `${n.getAttribute("data-wake-divider")}: ${(n as HTMLElement).innerText.replace(/\s+/g, " ").trim()}`),
    )
    // FIRST RUN, ONE LINE, LAST RUN — three runs is already enough to trigger it. `59627e8b` made
    // `collapseMiddleRuns` swallow everything between the first run and the last whole ("prose,
    // intermediate rests, wake hairlines and all"), from three runs up, precisely so a thread that
    // rested thirty times cannot paint thirty near-identical restatements. This fixture has three, so
    // the middle run AND the wake that opened it go behind one `middle-runs-summary` counting ROUNDS.
    //
    // This assertion used to spell the pre-`59627e8b` ladder — a fold and a wake per run — and it has
    // been wrong ever since without anyone seeing it: that commit reported "Full suite 3294 pass / 0
    // fail" because this file, like every e2e here, gates on a `FRIZZ_*_E2E_URL` no runner set, so it
    // reported `skipped` and counted as green (corrected 2026-08-24, when `nub run test:e2e` first ran
    // the suite).
    assert.deepEqual(
      ladder.map((row) => row.replace(/ · \d+m ago$/, "")),
      [
        "intermediate-summary: 6 tool calls · Click to expand",
        // The middle run, whole. THE FIRST PARK IS INSIDE IT — the watcher replays everything already
        // sitting on the PR, eleven items here and a hundred on a long-lived PR, and that used to
        // render one row each (maintainer 2026-08-13: "it's going to render like a hundred reviews, so
        // let's hide all of that on the initial watcher registration"). It collapsed to one honest
        // line, and now that line collapses too; the worker still gets the full list in the steer.
        "middle-runs-summary: 1 more round · 7 tool calls · Click to expand",
        // …and the wake that opens the FINAL run still draws, because resumed work with nothing above
        // it to explain the resumption has been reported here before.
        "github: New approval from @colinhacks on colinhacks/zod#6382",
        "intermediate-summary: 4 tool calls · Click to expand",
      ],
      `first run, one line, last run — each with its own fold, got ${ladder.join(" | ")}`,
    )
    const prCard = await page.evaluate(() => document.body.innerText)
    // NOT ONE ROW PER ITEM, at any count. This is the assertion that would catch the list coming back.
    assert.doesNotMatch(prCard, /@copilot-pull-request-reviewer/, "no per-item row survives the replay")
    assert.doesNotMatch(prCard, /@pullfrog/)
    // ONE CASE TREATMENT on the whole line — no run may escape the divider's petite-caps back to
    // ordinary case ("it's mixing small caps with regular font"). The ref is a LINK, and its underline
    // is what marks it; it needs no second signal in a different alphabet.
    const escapes = await page.$$eval('[data-wake-divider="github"] [class*="font-variant-caps"]', (ns) => ns.length)
    assert.equal(escapes, 0, "nothing on the GitHub hairline opts out of the divider's own casing")
    // The FIRST run's closing message and the LAST one stay in full — that pair is exactly what
    // `collapseMiddleRuns` promises to keep, because the first is the answer to whatever the human last
    // asked and the last is where the thread stands now. The middle run's restatement is what the fold
    // is FOR, so asserting it visible (as this did) asserts the bug back.
    assert.match(prCard, /PR #6382 is open against main/, "run 1's rest — the answer to the ask")
    assert.match(prCard, /#5178 is merged as/, "the last run's rest — where the thread stands")
    assert.doesNotMatch(prCard, /Both review findings are addressed/, "the middle run's restatement is inside the fold")
    // Expanding is still ONE-WAY and card-wide: one press restores every run's hidden log at once.
    await page.click(SEL)
    await page.waitForFunction((sel) => document.querySelectorAll(sel).length === 0, {}, SEL)
    assert.equal(
      await page.$$eval('[data-wake-divider="github"]', (ns) => ns.length),
      2,
      "…and the wake hairlines survive the expansion, still one per run",
    )

    // ---- 10. THE GOAL DRIVES MOST THREADS, and it must cut and be named like any other wake ----
    // The regression, from the maintainer's own zod thread on 2026-08-16: he asked a pointed question,
    // the agent answered it and rested, and the GOAL woke it twice more. The card exempted the Goal from
    // both halves of this — it cut nothing and it drew nothing — so the three turns merged into a single
    // run whose one fold hid everything but its first and last prose. The answer he had just asked for
    // was inside that fold ("the entire answer to that question was collapsed by default"), and the
    // resumed work appeared with nothing above it to explain the resumption ("there's not a hairline
    // notification rendered for that, which is also weird to me" — he read it as a PR watcher).
    //
    // Read the ladder IN DOCUMENT ORDER: the interleaving is the whole claim. Three folds and two Goal
    // hairlines in the right count but the wrong places would pass a per-selector check.
    await page.goto(variant("goalwakes"), { waitUntil: "networkidle0" })
    await page.waitForSelector(SEL, { timeout: 10_000 })
    const goalLadder = await page.$$eval("[data-wake-divider]", (ns) =>
      ns.map((n) => `${n.getAttribute("data-wake-divider")}: ${(n as HTMLElement).innerText.replace(/\s+/g, " ").trim()}`),
    )
    // Three Goal-driven runs, so the same first/one-line/last shape as the PR-watcher ladder above: the
    // middle run and the Goal bump that opened it fold together, and the bump above the LAST run still
    // draws. The pre-`59627e8b` spelling — a fold and a bump per run — is what this used to assert.
    assert.deepEqual(
      goalLadder,
      [
        "intermediate-summary: 4 tool calls · Click to expand",
        "middle-runs-summary: 1 more round · 3 tool calls · Click to expand",
        "rest: Goal · at rest",
        "intermediate-summary: 2 tool calls · Click to expand",
      ],
      `each Goal-driven run folds, under the hairline naming what resumed it, got ${goalLadder.join(" | ")}`,
    )
    const goalCard = await page.evaluate(() => document.body.innerText)
    // THE ROW THIS WHOLE CHANGE EXISTS FOR: the answer to the question, which the single-run fold ate.
    assert.match(goalCard, /You were right on both counts/, "the answer the agent rested on renders in full")
    // …and the LAST run's rest, which is where the thread stands. The one between them is inside the
    // middle fold by design — this used to assert "every later rested message" survives, which is the
    // invariant `59627e8b` deliberately traded away to stop a thirty-rest thread painting thirty times.
    assert.match(goalCard, /That review predates my rewrite/, "the last run's rest")
    assert.doesNotMatch(goalCard, /All six real CI checks are green/, "the middle run's restatement is folded")
    // The bump's own PARAGRAPH never renders — the hairline is the whole notification. Rendering it in
    // full is what the 2026-08-12 call was actually against, and it must not come back with the rule.
    assert.doesNotMatch(goalCard, /If further work towards the original task/, "the Goal's body stays out; only its hairline shows")
    assert.doesNotMatch(goalCard, /Agent rested/, "the rest divider is still never drawn")

    // ---- 11. THE MIDDLE COLLAPSES EVEN WHEN NO KEPT RUN FOLDS, and its divider survives a rest-cut ----
    // The 2026-09-02 regression (nub `investigate-divergences-fix-this-and-all`): a first run that
    // answered in ONE message (deliberately never folds) and a one-line final run left the collapse
    // gate counting zero folding segments — so it concluded there was nothing to collapse while twelve
    // rounds and 149 tool calls sat in the middle, and the card painted fifteen hours of work raw at
    // 15,756px. And separately: this middle's first hidden run is cut by a REST, which puts the rest
    // record at the span's first index; the render loop drops rest records before the middle branch,
    // so a divider emission keyed on that exact index never fired and the rounds vanished with no line
    // standing in for them. Both defects reproduce on this one variant.
    await page.goto(variant("loneanswer"), { waitUntil: "networkidle0" })
    await page.waitForSelector('[data-wake-divider="middle-runs-summary"]', { timeout: 10_000 })
    const loneLadder = await page.$$eval("[data-wake-divider]", (ns) =>
      ns.map((n) => `${n.getAttribute("data-wake-divider")}: ${(n as HTMLElement).innerText.replace(/\s+/g, " ").trim()}`),
    )
    assert.deepEqual(
      loneLadder.map((row) => row.replace(/ · \d+m ago$/, "")),
      [
        "event: Background task «Building and testing the fix» finished",
        "middle-runs-summary: 2 more rounds · 5 tool calls · Click to expand",
        "github: New approval from @colinhacks on nubjs/nub#837",
      ],
      `the middle folds on its own strength, with no intermediate-summary anywhere, got ${loneLadder.join(" | ")}`,
    )
    const loneCard = await page.evaluate(() => document.body.innerText)
    assert.match(loneCard, /Fix pushed — the lockfile drift is gone/, "the one-message first answer renders in full")
    assert.match(loneCard, /the merge is yours/, "the last run's status line renders in full")
    assert.doesNotMatch(loneCard, /The full suite is green on the new head/, "the middle rounds are folded")
    assert.doesNotMatch(loneCard, /Still green — nothing new to act on/)

    // ---- 12. control: nothing intermediate, so no divider at all ----
    await page.goto(variant("single"), { waitUntil: "networkidle0" })
    await page.waitForFunction(() => document.querySelectorAll("[data-frizz-msg]").length > 0, { timeout: 10_000 })
    assert.equal(
      await page.$$eval(SEL, (n) => n.length),
      0,
      "a single agent turn hides nothing, so it must not draw an anchorless divider",
    )

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})

// THREE SUCCESSIVE HAIRLINES STAND AT ONE PITCH — measured in the browser, because the number is not
// written anywhere in the tree. A divider's own `my-1` draws 4px of air on each side, and the STEP
// between two messages is charged on top of it by whatever surface is stacking them, so a pair of
// adjacent rules is 22px apart everywhere in the app. The exception was a delivery that carries BOTH a
// CI verdict and a review comment: `FrizzWake` returned the two hairlines as a bare fragment, so the
// queue card's gap-less column put nothing between them and they collapsed to the 8px their margins
// leave — a fold, a CI line and a comment line drawn one under the other at two different pitches
// (maintainer 2026-08-19: "inconsistent heights on three successive airlines"). One delivery or two is
// an accident of when the watcher polled, and it must not be visible.
test("successive wake hairlines stand at one pitch, however many deliveries carried them", {
  skip: !baseUrl,
  timeout: 120_000,
}, async () => {
  const { browser, page, errors } = await launch()
  try {
    await page.goto(variant("stackedwakes"), { waitUntil: "networkidle0" })
    await page.waitForSelector('[data-wake-divider="github"]', { timeout: 10_000 })
    const ladder = await page.$$eval("[data-wake-divider]", (ns) =>
      ns.map((n) => {
        const r = (n as HTMLElement).getBoundingClientRect()
        return { label: `${n.getAttribute("data-wake-divider")}: ${(n as HTMLElement).innerText.replace(/\s+/g, " ").trim()}`, top: r.top, bottom: r.bottom }
      }),
    )
    assert.deepEqual(
      ladder.map((r) => r.label),
      [
        "intermediate-summary: 2 tool calls · Click to expand",
        "middle-runs-summary: 3 more rounds · 6 tool calls · Click to expand",
        "github: CI passed on colinhacks/zod#6440 · 10 checks green",
        "github: New review comment from @pullfrog on colinhacks/zod#6440 · 16m ago",
      ],
      `the card draws the fold and both halves of the combined delivery, got ${ladder.map((r) => r.label).join(" | ")}`,
    )
    // The two gaps under test: fold → CI verdict (two messages) and CI verdict → review comment (ONE
    // message). Sub-pixel tolerance, like every other measured pitch here.
    const gaps = ladder.slice(2).map((r, i) => r.top - ladder[i + 1].bottom)
    for (const [i, gap] of gaps.entries()) {
      assert.ok(Math.abs(gap - 22) < 0.5, `hairline gap ${i + 1}: expected ~22px, got ${gap}px`)
    }

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
