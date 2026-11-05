import assert from "node:assert/strict"
import test from "node:test"

const baseUrl = process.env.FRIZZ_AGENT_ROW_INDICATORS_E2E_URL

// An agent row is the ONE card family with two independent status sources — its own state reading (which
// carries its own mark) and the shared right-hand meta slot — so it is the only one that can render the
// same fact twice. It shipped doing exactly that: a live child read "running 3 min ●" AND "● running",
// and a quiet child read the self-contradicting "stale ●running". Pin both halves of that rule here:
// a resolved child owns the row's status alone, and a dispatch with NO child record must still surface
// its terminal status/duration through the meta slot (the suppression must never eat that).
//
// Since 2026-07-29 this also pins the row's SHAPE, which mirrors the sub-agent lines under the prompt box:
// the liveness MARK first (in the rail's node since 2026-11-05), then "Agent", then the title, then the
// READING right-justified at the far edge, then the chevron. The facts that shape asserts — order, no RAW
// `frizz:` slug or bracketed tag, one flush right-hand column, and "Agent" on one edge whichever state the
// child is in — are each a thing the header used to get wrong.
test("an agent row mirrors the child-line shape and shows exactly one running indicator", {
  skip: !baseUrl,
  timeout: 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  const errors: string[] = []
  // The bare fixture page serves no favicon, so Chrome logs a 404 whose console text carries no URL.
  // Track the failing RESPONSE urls separately and exclude that one by path — precise enough to still
  // fail on any other missing resource, rather than blanket-ignoring every 404.
  const notFound: string[] = []
  page.on("response", (response) => { if (response.status() === 404) notFound.push(new URL(response.url()).pathname) })
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text()) })
  page.on("pageerror", (error) => errors.push(String(error)))

  try {
    await page.setViewport({ width: 1000, height: 1500, deviceScaleFactor: 1 })
    await page.goto(`${baseUrl}/operation-indicators-fixture.html`, { waitUntil: "networkidle0" })
    const rows = await page.$$eval("[data-agent-rows] .frizz-bash", (cards) =>
      cards.map((card) => {
        const header = card.querySelector<HTMLElement>(".frizz-bash-header")!
        const [left, right] = Array.from(header.children) as HTMLElement[]
        const marks = card.querySelectorAll("[title='stale — no recent output'], [title^='rested —']")
        // THE STATE READING is the element naming itself, not the first thing in the group: since
        // 2026-08-27 the group leads with the resolved profile (`sonnet › medium`), which is neutral by
        // design on every row. Sampling "whatever is first" therefore read the profile's gray and would
        // have reported the failure red as missing while it was sitting one span over, untouched.
        // The untracked row reports nothing at all, so its group is the chevron alone — sample that, as
        // the old probe did, and let `hasReading` keep it out of the typography and tone assertions.
        const stateEl = right.querySelector<HTMLElement>("[aria-label]:not([data-tool-disclosure])") ?? (right.firstElementChild as HTMLElement)
        return {
          text: header.innerText.replace(/\s+/g, " ").trim(),
          indicators: card.querySelectorAll("[data-running-indicator]").length,
          // The STATIC finished dot. Deliberately a different attribute from `data-running-indicator`,
          // whose count above is the one-indicator-per-row rule — a finished op is marked, not live.
          doneMarks: card.querySelectorAll("[data-done-indicator]").length,
          // The left group's element order IS the mirrored shape: the mark slot (when the child has a
          // liveness reading at all), the kind label, then the title. `-1` for the slot means no slot
          // exists in the DOM — which is REQUIRED of a resolved child and a failure for a live one.
          markSlotIndex: Array.from(left.children).findIndex((child) => child.classList.contains("frizz-tool-mark")),
          labelIndex: Array.from(left.children).findIndex((child) => child.classList.contains("frizz-bash-label")),
          // How far "Agent" sits from the header's own left edge. An empty reserved slot once pushed it out
          // ~13px on a card whose child had finished. The mark sits in the rail's node now, outside the
          // header's flow, so every row is flush at 0 whatever its mark.
          labelOffset: Math.round(left.querySelector(".frizz-bash-label")!.getBoundingClientRect().left - left.getBoundingClientRect().left),
          quietMark: marks.length > 0 ? marks[0].getAttribute("title") : null,
          // The right-hand group holds the reading AND the chevron, in that order, flush to one edge —
          // except on a row with NOTHING honest to report, where the chevron stands alone. The typography
          // and tone samples below therefore read the reading's own element, not "whatever is first".
          rightText: right.innerText.replace(/\s+/g, " ").trim(),
          hasReading: !right.firstElementChild!.matches("[data-tool-disclosure]"),
          // The reading's TYPOGRAPHY, resolved. Every row must report the same three values: the slot
          // shipped with two competing treatments (lowercase sans vs petite-caps, one of them 1px off
          // the row's optical line) and a text assertion cannot see that.
          readingType: ((cs: CSSStyleDeclaration) => [cs.fontSize, cs.fontVariantCaps, cs.letterSpacing].join("/"))(
            getComputedStyle(stateEl),
          ),
          // The reading's own COLOUR, composited over black and sampled as sRGB bytes. This is how the
          // tone split between a stopped child and a failed one is pinned — the two read the same shape,
          // so only the colour tells them apart, and a regression there is invisible to a text
          // assertion. Sampled through a canvas rather than parsed out of `getComputedStyle`, because
          // Tailwind's `/55` alpha modifier serialises as `oklab(… / 0.55)` — digits a naive rgb() parse
          // reads as a wildly non-neutral colour.
          readingRgb: ((color: string) => {
            const canvas = document.createElement("canvas")
            canvas.width = canvas.height = 1
            const ctx = canvas.getContext("2d")!
            ctx.fillStyle = "#000"
            ctx.fillRect(0, 0, 1, 1)
            ctx.fillStyle = color
            ctx.fillRect(0, 0, 1, 1)
            const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
            return [r, g, b]
          })(getComputedStyle(stateEl).color),
          rightEdge: Math.round(right.getBoundingClientRect().right * 10) / 10,
          chevronIsLast: right.lastElementChild!.matches("[data-tool-disclosure]"),
        }
      }),
    )
    assert.equal(rows.length, 9, "the fixture must cover live/stale/rested/finished/stopped/failed agent rows, plus the three with no child record")

    // THE SHAPE. A child with a LIVE record leads with its mark, then "Agent"; every other row — resolved,
    // or pending with no record frizz can point at — has no mark, so "Agent" leads. Either way "Agent" sits
    // flush at the header's left edge: an empty reservation was a real, reported defect ("a weird gap … to
    // the left of the word Agent"), so the absence is pinned as hard as the presence.
    //
    // A static "finished" glyph filled that slot for exactly one commit and was removed (maintainer
    // 2026-08-01: "remove the status indicator entirely for a sub-agent or background shell that has
    // completed"). Worth keeping straight, because it is the obvious thing to reach for again: the whole
    // column means "something is alive behind this row", so marking finished rows put a glyph on nearly
    // every row of a scrolled transcript while saying nothing the runtime reading did not already say.
    // The chevron is last on the right on every row.
    const MARKED = 3 // rows 0-2 are the live / stale / rested children; 3-8 have no live record.
    for (const [index, row] of rows.entries()) {
      const marked = index < MARKED
      assert.equal(row.markSlotIndex, marked ? 0 : -1, `row ${index}: ${marked ? "the liveness mark must lead the header" : "a row with no live child record renders no mark slot at all"}`)
      assert.equal(row.labelIndex, marked ? 1 : 0, `row ${index}: "Agent" must ${marked ? "follow the mark" : "lead the header"}`)
      assert.equal(row.labelOffset, 0, `row ${index}: "Agent" sits ${row.labelOffset}px from the left edge`)
      assert.ok(row.chevronIsLast, `row ${index}: the chevron must be the last thing on the row`)
    }
    // Right-justified means ONE column: every row's right-hand group ends at the same x, so a stack of
    // dispatch cards reads its runtimes down a single edge instead of at each label's ragged end.
    assert.equal(new Set(rows.map((row) => row.rightEdge)).size, 1, "every row's reading must end at the same right edge")

    // The profile LEADS the reading on every row that has a child record, resolved to model+effort
    // (`opus › high`) — the maintainer put it back on 2026-08-27 after `subagent_type` stopped carrying
    // the model: "subagent dispatch cards should always show effort & model visible" (8b819995). What is
    // still banned is the RAW shape it used to wear: the `frizz:opus-high` slug, and the bracketed tag.
    for (const row of rows) assert.doesNotMatch(row.text, /frizz:|\[.*\]/)

    // ONE READING, EIGHT ROWS. The slot is a single renderer (ChatView's ToolMetaReading, fed by
    // lib/agentReading.ts), so every row reports identical type metrics and the whole column draws from a
    // palette of exactly TWO tones — quiet for every nominal or interrupted outcome, the failure red for a
    // real failure. It shipped as two renderers picked by whether a live child record survived, which put
    // two typographic systems, four saturations, two duration formatters and two separators in one column
    // of eight (maintainer 2026-07-29: "a bizarre mix of font sizes, color saturations, and
    // capitalization"). These two assertions are that complaint, made mechanical.
    // Over the rows that HAVE a reading — a row reporting nothing has no treatment to be consistent with.
    const readingRows = rows.filter((row) => row.hasReading)
    assert.equal(readingRows.length, rows.length - 1, "exactly one row (the untracked pending dispatch) reports nothing")
    assert.equal(new Set(readingRows.map((row) => row.readingType)).size, 1, `one typography for the slot, found: ${[...new Set(readingRows.map((r) => r.readingType))].join(" | ")}`)
    assert.equal(new Set(readingRows.map((row) => row.readingRgb.join(","))).size, 2, `two tones for the slot, found: ${[...new Set(readingRows.map((r) => r.readingRgb.join(",")))].join(" | ")}`)
    // Plain sentence-case type, like the row's own kind label on the left.
    assert.match(rows[0].readingType, /^11\.5px\/normal\//)

    // A LIVE child: exactly one dot, and the runtime is a BARE duration — no "running" verb, never
    // doubled by the meta badge.
    assert.equal(rows[0].indicators, 1)
    assert.doesNotMatch(rows[0].text, /running/)
    assert.match(rows[0].rightText, /^opus › high (\d+m|<1m|\d+h( \d+m)?)$/)

    // A quiet child: the flat stale mark carries the state (its tooltip says so), with no dot and no
    // "running" badge to contradict it.
    assert.equal(rows[1].indicators, 0)
    assert.equal(rows[1].quietMark, "stale — no recent output")
    assert.doesNotMatch(rows[1].text, /running/)

    // A RESTED child — it stopped, the fan-out it launched has not — draws the hollow mark, not the
    // stale one, and still reads its runtime.
    assert.equal(rows[2].indicators, 0)
    assert.match(String(rows[2].quietMark), /^rested — /)
    assert.match(rows[2].rightText, /^opus › high (\d+m|<1m|\d+h( \d+m)?)$/)

    // A completed child: no mark, no slot, just the bare runtime. A card that reports a runtime and shows
    // no liveness mark already says "it ran and stopped", so the verb is deliberately absent.
    assert.equal(rows[3].indicators, 0)
    assert.equal(rows[3].doneMarks, 0)
    assert.equal(rows[3].rightText, "opus › high 3m")
    assert.doesNotMatch(rows[3].text, /finished/)

    // A NON-nominal outcome keeps its verb — no mark can say it — but the WORD is the shared vocabulary,
    // never the harness's raw `agentStatus` enum, and the two outcomes are TONED APART:
    //   • a STOPPED child (interrupted / timed out) is not an error, so it reads at the quiet weight of
    //     every other reading on the row. It shipped in blood-red as "killed 10m" beside its neighbours'
    //     "done · 9ms" (maintainer: "this is way too scary looking") — hence both halves are pinned;
    //   • a FAILED child keeps the red the tool cards use for a real failure.
    assert.equal(rows[4].indicators, 0)
    assert.equal(rows[4].rightText, "sonnet › medium stopped · 41m")
    assert.doesNotMatch(rows[4].text, /killed/)
    assert.equal(rows[5].indicators, 0)
    assert.equal(rows[5].rightText, "sonnet › medium failed · 12m")
    // The tones, sampled: the stop must be a NEUTRAL gray (r≈g≈b), the failure the red the tool cards own.
    const spread = (rgb: number[]) => Math.max(...rgb) - Math.min(...rgb)
    assert.ok(spread(rows[4].readingRgb) <= 24, `a stopped child must read neutral, not rgb(${rows[4].readingRgb})`)
    assert.deepEqual(rows[5].readingRgb, [229, 83, 75], "a failed child keeps the tool cards' failure red")

    // NO CHILD RECORD — the reading is the only status surface, so terminal state + duration must still
    // render (the regression the one-indicator rule must never cause). And it must be INDISTINGUISHABLE
    // from the tracked equivalent above: losing the correlation to a child is frizz's problem, not the
    // reader's, so an interrupted dispatch says "stopped" here too — never the raw "cancelled", and never
    // in amber, which was saying "caution" about something somebody deliberately stopped.
    assert.equal(rows[6].indicators, 0)
    assert.equal(rows[6].rightText, "stopped")
    assert.doesNotMatch(rows[6].text, /cancelled/)
    assert.deepEqual(rows[6].readingRgb, rows[4].readingRgb, "one interruption, one tone, child record or not")
    assert.equal(rows[7].indicators, 0)
    assert.match(rows[7].rightText, /^failed · /)
    assert.deepEqual(rows[7].readingRgb, rows[5].readingRgb, "one failure, one tone, child record or not")
    // NOT ONE ROW in the column carries a finished glyph — the state is read off the runtime and the
    // absent mark, never off a second indicator. Asserted across every row rather than on the resolved
    // ones alone, because the regression is a glyph coming back ANYWHERE in this family.
    for (const [index, row] of rows.entries()) assert.equal(row.doneMarks, 0, `row ${index}: no finished glyph may exist`)

    // AN UNTRACKED PENDING DISPATCH CLAIMS NOTHING. It used to render "running" beside a spinner here,
    // which is the one reading in this matrix that could be flatly FALSE: the server holds an Agent launch
    // `pending` until a task-notification correlates, so a dispatch whose terminal signal never arrived
    // spun forever over a child that was long dead (maintainer 2026-08-01: it "should not show up under
    // any circumstances"). Now the row states its title and stops.
    assert.equal(rows[8].indicators, 0, "an untracked pending dispatch must not spin")
    assert.equal(rows[8].rightText, "", "…nor claim 'running' in the reading")
    assert.doesNotMatch(rows[8].text, /running/i)

    assert.deepEqual(errors, [])
    assert.deepEqual(notFound.filter((path) => path !== "/favicon.ico"), [])
  } finally {
    await browser.close()
  }
})

// ONE LIVENESS COLUMN. A background SHELL card says the same thing a dispatch card says — something is
// alive behind this row — so it must say it in the same PLACE: the mark leading the header, not stranded
// in the right-hand reading at the opposite edge of an otherwise identical card (maintainer 2026-07-30:
// "the blue indicator for a background bash tool is still on the right instead of on the left … its
// rendering should align with the agent tool call component"). The geometry is asserted AGAINST the agent
// rows rather than against literals, because "aligned" is a relationship: if either card's slot moves,
// the two must move together or this fails.
// The fixture starts the fresh call 15s in the FUTURE (`?freshAgeMs=-15000`) and
// FOREGROUND_MARK_AFTER_MS is 2s, so the mark is due ~17s after the page loads. The wait below used to
// allow 30s — 13s of slack over that 17s — and on a loaded machine the page load, the React mount and
// the component's own `setTimeout` ate it: measured 2026-08-24 at load average 83, this timed out at
// 30s inside an otherwise green 52/53 run. Deriving the budget from the two numbers it actually depends
// on, with ~3x slack, is what stops it being re-guessed the next time the box is busy.
const MARK_DUE_MS = 15_000 + 2_000
const MARK_WAIT_MS = MARK_DUE_MS * 3

test("a background shell card marks its liveness in the same slot as a dispatch card", {
  skip: !baseUrl,
  // The wait above is the long pole, and it does not start until the rest of the assertions have run.
  timeout: MARK_WAIT_MS + 60_000,
}, async () => {
  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  const page = await browser.newPage()
  const errors: string[] = []
  page.on("console", (message) => { if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text()) })
  page.on("pageerror", (error) => errors.push(String(error)))

  try {
    await page.setViewport({ width: 1000, height: 1800, deviceScaleFactor: 1 })
    // freshAgeMs NEGATIVE = the last shell row's call starts 15s in the FUTURE, so it is unmarked at load
    // with a 15s margin no matter how slow the render — the threshold is pinned without racing the clock.
    await page.goto(`${baseUrl}/operation-indicators-fixture.html?freshAgeMs=-15000`, { waitUntil: "networkidle0" })
    const read = (selector: string) =>
      page.$$eval(selector, (cards) =>
        cards.map((card) => {
          const header = card.querySelector<HTMLElement>(".frizz-bash-header")!
          const [left, right] = Array.from(header.children) as HTMLElement[]
          const slot = left.querySelector<HTMLElement>(".frizz-tool-mark")
          const dot = slot?.firstElementChild
          const headerBox = header.getBoundingClientRect()
          const slotBox = slot?.getBoundingClientRect()
          return {
            label: left.querySelector<HTMLElement>(".frizz-bash-label")!.innerText.trim(),
            markSlotIndex: Array.from(left.children).findIndex((child) => child.classList.contains("frizz-tool-mark")),
            labelIndex: Array.from(left.children).findIndex((child) => child.classList.contains("frizz-bash-label")),
            labelOffset: Math.round(left.querySelector(".frizz-bash-label")!.getBoundingClientRect().left - left.getBoundingClientRect().left),
            // The slot's own geometry inside the header, to a tenth of a pixel: this is what "the same
            // slot" means, and it is the number that a stray margin or a lost ink correction would move.
            markLeft: slotBox ? Math.round((slotBox.left - headerBox.left) * 10) / 10 : null,
            markMidY: slotBox ? Math.round((slotBox.top + slotBox.height / 2 - headerBox.top) * 10) / 10 : null,
            markClass: dot ? dot.className : null,
            // The dot's hue, composited over black — the ONE axis on which the two families differ.
            markRgb: dot
              ? ((color: string) => {
                  const canvas = document.createElement("canvas")
                  canvas.width = canvas.height = 1
                  const ctx = canvas.getContext("2d")!
                  ctx.fillStyle = "#000"
                  ctx.fillRect(0, 0, 1, 1)
                  ctx.fillStyle = color
                  ctx.fillRect(0, 0, 1, 1)
                  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
                  return [r, g, b]
                })(getComputedStyle(dot).backgroundColor)
              : null,
            indicators: card.querySelectorAll("[data-running-indicator]").length,
            doneMarks: card.querySelectorAll("[data-done-indicator]").length,
            rightText: right.innerText.replace(/\s+/g, " ").trim(),
          }
        }),
      )
    const shells = await read("[data-shell-rows] .frizz-bash")
    const agents = await read("[data-agent-rows] .frizz-bash")
    assert.equal(shells.length, 8, "the fixture must cover live / gone / untracked-detached / long-foreground / fresh-foreground / done / failed foreground rows, plus a RESOLVED background task")

    // THE SHAPE, row by row. Rows 0-3 carry the mark: row 1 is a tracked shell whose process the OS has
    // confirmed gone (the flat stale dot, which is not a RUNNING indicator), and the other three are
    // running — two detached, plus the FOREGROUND command that has been going long enough to earn the
    // mark. Rows 4-7 have nothing LIVE to show (a call issued a moment ago, two resolved foreground ones,
    // and a resolved BACKGROUND task) and render NO slot: this column means "something is alive behind
    // this row", so a finished op belongs out of it entirely (maintainer 2026-08-01: "remove the status
    // indicator entirely for a sub-agent or background shell that has completed"). Detachment does not
    // earn a mark; being ALIVE does. An empty reservation is the defect the dispatch card already had to
    // unlearn, and it stays unlearned here.
    const MARKED = 4
    const GONE = 1
    const RESOLVED_BACKGROUND = 7
    for (const [index, row] of shells.entries()) {
      const marked = index < MARKED
      assert.equal(row.markSlotIndex, marked ? 0 : -1, `shell row ${index}: ${marked ? "the mark must lead the header" : "a row with nothing live behind it renders no mark slot"}`)
      assert.equal(row.labelIndex, marked ? 1 : 0, `shell row ${index}: the tool label must ${marked ? "follow the mark" : "lead the header"}`)
      assert.equal(row.labelOffset, 0, `shell row ${index}: the label sits ${row.labelOffset}px from the left edge`)
      // Exactly one glyph per row, and it is ALWAYS the leading mark: this family draws nothing in the
      // right-hand reading any more. A `tool-pending` spinner reappearing here is the regression.
      assert.equal(row.indicators, marked && index !== GONE ? 1 : 0, `shell row ${index}: one running indicator at most, and only in the mark slot`)
      assert.equal(row.doneMarks, 0, `shell row ${index}: no finished glyph may exist`)
    }

    // A RESOLVED BACKGROUND task is the row that most invites a finished glyph — its row is permanent in
    // the transcript, so it is tempting to keep marking it. It reads its runtime like any finished call.
    assert.equal(shells[RESOLVED_BACKGROUND].markClass, null, "a finished background task draws no mark")
    assert.equal(shells[RESOLVED_BACKGROUND].rightText, "1m 36s")
    // The spinner is gone from this card family entirely — it now belongs only to a dispatch with no
    // child record, which elapsed time cannot speak for.
    assert.equal(await page.$$eval("[data-shell-rows] [data-running-indicator]", (n) => n.map((e) => e.getAttribute("data-running-indicator"))).then((k) => k.filter((v) => v === "tool-pending").length), 0, "no shell row may spin")

    // A LONG-RUNNING FOREGROUND command marks itself exactly like a detached one — same slot, same hue.
    // This is the row the whole 2026-07-30 change is about, so it is asserted against the detached row
    // beside it rather than on its own.
    assert.equal(shells[3].markLeft, shells[0].markLeft, "a foreground shell marks itself in the detached shell's slot")
    assert.match(String(shells[3].markClass), /frizz-live-dot--shell/)
    assert.deepEqual(shells[3].markRgb, shells[0].markRgb, "…in the same blue")
    // A LIVE duration, not a bare verb: a pending foreground Bash ticks from the call's own timestamp
    // (useBashDuration), and this fixture row starts 42s in the past. The literal "running" this pinned
    // could only ever have held for a row with no `startedAt` — it was red before the ejection work and
    // is corrected here rather than left asserting something the card has never done. The unit is the
    // house grammar's `s` (durationLabels.ts), never ` sec`.
    assert.match(shells[3].rightText, /^running · \d+s$/)

    // ALIGNED, measured against the dispatch card: same slot position, same optical line, same class —
    // agents[0] is the live child, shells[0] the live shell.
    assert.equal(shells[0].markLeft, agents[0].markLeft, "the shell mark must start where the dispatch mark starts")
    assert.equal(shells[0].markMidY, agents[0].markMidY, "the two marks must sit on one optical line")
    assert.equal(shells[0].labelOffset, agents[0].labelOffset, "both labels must sit on one edge")

    // …and differ on exactly ONE axis: the hue. Blue is the shell's, and it is not the dispatch accent.
    assert.match(String(shells[0].markClass), /frizz-live-dot--shell/)
    assert.match(String(agents[0].markClass), /frizz-live-dot--agent/)
    const [r, g, b] = shells[0].markRgb!
    assert.ok(b > r && b > g, `a live shell marks itself blue, got rgb(${shells[0].markRgb})`)
    assert.notDeepEqual(shells[0].markRgb, agents[0].markRgb, "the two runtimes keep their two hues")

    // A tracked shell whose process is GONE draws the flat stale dot beside its own word "stale" — the
    // same mark, in the same place, as the stale child on the dispatch card. It shipped drawing the
    // full-brightness live dot there, and then, until 2026-10-05, a breathing one titled "running — no
    // recent output": a dead process drawn as a live one either way.
    assert.equal(shells[GONE].markClass, agents[1].markClass, "the gone shell's mark is the stale child's mark")
    assert.doesNotMatch(String(shells[GONE].markClass), /frizz-live-dot/)
    assert.equal(shells[GONE].markLeft, agents[1].markLeft, "…in the same slot")
    assert.equal(shells[GONE].markMidY, agents[1].markMidY, "…on the same optical line")
    assert.equal(shells[GONE].rightText, "stale")
    // The two detached-and-live readings: correlated to a live op, and merely flagged background.
    assert.equal(shells[0].rightText, "running")
    assert.equal(shells[2].rightText, "running")

    // …AND IT MARKS ITSELF. Row 4 (`git status --short`) was issued moments ago: unmarked above, and it
    // must cross the threshold on its OWN timer, with no reload, no interaction and no data push. That
    // timer is the only part of the rule a pure unit test cannot reach.
    assert.equal(shells[4].markSlotIndex, -1, "the fresh call starts unmarked")
    // The wait asserts the row EXISTS and carries the mark, in that order. It used to read
    // `rows[4]?.querySelector(".frizz-tool-mark") !== null`, and optional chaining made an ABSENT row
    // satisfy it: `undefined !== null` is true, so a poll that landed while the list was momentarily
    // not there resolved the wait instantly, and the assertion below then read -1 off a row that had
    // never been given the chance to mark itself. Under a machine loaded enough to matter — several
    // browser e2e files in flight at once — that is what this test failed on, while passing 3/3 alone
    // (2026-08-24). A guard that cannot tell "not ready" from "done" turns load into a wrong answer
    // instead of an honest timeout, which is the one thing a wait must never do.
    await page.waitForFunction(
      () => {
        const row = document.querySelectorAll("[data-shell-rows] .frizz-bash")[4]
        return row !== undefined && row.querySelector(".frizz-tool-mark") !== null
      },
      { timeout: MARK_WAIT_MS, polling: 250 },
    )
    const late = await read("[data-shell-rows] .frizz-bash")
    assert.equal(late[4].markSlotIndex, 0, "a call that keeps running marks itself once it passes the threshold")
    assert.equal(late[4].markLeft, shells[0].markLeft, "…into the same slot as every other mark")
    assert.equal(late[5].markSlotIndex, -1, "and a RESOLVED row never grows a mark, however long the page is open")

    assert.deepEqual(errors, [])
  } finally {
    await browser.close()
  }
})
