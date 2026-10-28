import { test } from "node:test"
import assert from "node:assert/strict"
import { AWAITING_TITLE_MAX, isAwaitingItemKind } from "@frizz/shared"
import { splitFenceBlocks, parseFenceBody, hasFence, heldHandoffIndex } from "./fenceBlocks.ts"

// ---- splitFenceBlocks ----

test("no fences → a single prose segment", () => {
  assert.deepEqual(splitFenceBlocks("just some prose\n\nmore prose"), [
    { kind: "prose", text: "just some prose\n\nmore prose" },
  ])
})

test("empty / whitespace-only text → no segments", () => {
  assert.deepEqual(splitFenceBlocks(""), [])
  assert.deepEqual(splitFenceBlocks("   \n  "), [])
})

test("a done fence with surrounding prose", () => {
  const text = "Shipped the fix.\n\n```done\nMerged PR and cleaned up the branch.\n```\n\nAnything else?"
  assert.deepEqual(splitFenceBlocks(text), [
    { kind: "prose", text: "Shipped the fix.\n\n" },
    { kind: "fence", fenceKind: "done", body: "Merged PR and cleaned up the branch.", hints: [] },
    { kind: "prose", text: "\n\nAnything else?" },
  ])
})

// THE YAML KEYS, and this parser IS the server's — one `splitAwaitingFrontmatter` in @frizz/shared, called
// by both. It was two implementations with a comment on each asking the reader to keep them in step, and
// on 2026-08-24 the cutover moved one and not the other: a correct fence parked correctly and rendered its
// own raw frontmatter at the human. These cases pin the shared behaviour from the CLIENT's side.
test("an awaiting fence: the YAML frontmatter parses, and prose stays prose", () => {
  const text = "```awaiting\nWaiting on a named maintainer at a scheduled checkpoint.\nshells: [bzvtnt3ig]\nprs: [owner/repo#12]\ntimers: [tmr_a1b2c3]\n```"
  assert.deepEqual(splitFenceBlocks(text), [
    {
      kind: "fence",
      fenceKind: "awaiting",
      body: "Waiting on a named maintainer at a scheduled checkpoint.",
      hints: [
        { kind: "shell", value: "bzvtnt3ig" },
        { kind: "pr", value: "owner/repo#12" },
        { kind: "timer", value: "tmr_a1b2c3" },
      ],
    },
  ])
})

// CASE-INSENSITIVE on the keys, and a RETIRED key is prose — not a hint under another name. `human:`,
// `ci:` and `session:` went with the 2026-08-15 grammar; the SINGULAR item keys and `reason:` went with
// the 2026-08-24 YAML cutover. A worker still writing any of them must have it fall to the body, where a
// human reads it, rather than silently minting a wait.
test("awaiting keys are case-insensitive, and a retired key is just prose", () => {
  const { hints, body } = parseFenceBody("Shells: [bzvtnt3ig]\nTimers: [tmr_a1b2c3]\nFor: 2h\nprose tail", "awaiting")
  assert.deepEqual(hints, [
    { kind: "shell", value: "bzvtnt3ig" },
    { kind: "timer", value: "tmr_a1b2c3" },
    { kind: "for", value: "2h" },
  ])
  assert.equal(body, "prose tail")

  const legacy = parseFenceBody("human: Alice approves\nci: build 9\nsession: sub-123\nstill here", "awaiting")
  assert.deepEqual(legacy.hints, [], "a deleted kind mints no hint")
  assert.match(legacy.body, /Alice approves/, "…and stays readable in the body")

  // The keys retired by the cutover behave identically — including `reason:`, whose prose is the whole
  // reason the frontmatter could not be YAML until it left.
  const singular = parseFenceBody("shell: bzvtnt3ig\npr: owner/repo#1\nreason: waiting on your merge: the revert", "awaiting")
  assert.deepEqual(singular.hints, [], "a singular item key mints no hint after the cutover")
  assert.match(singular.body, /waiting on your merge: the revert/, "…and its colon cannot break the parse")
})

test("a done fence parks nothing — hint-looking lines stay in the body", () => {
  const { hints, body } = parseFenceBody("all set\npr: owner/repo#7", "done")
  assert.deepEqual(hints, [])
  assert.equal(body, "all set\npr: owner/repo#7")
})

// The one hint a done fence carries (2026-10-13): a leading `title:`, the card's heading. Through the
// same shared splitter the tailer uses, so the card never prints the raw `title:` line the server lifted.
test("a done fence's leading title: is its heading hint, and the ledger is the body", () => {
  const text = "Landed.\n\n```done\ntitle: Resolver cache keyed on the normalized id\n---\n- **Fixed** the lookup.\n```"
  assert.deepEqual(splitFenceBlocks(text), [
    { kind: "prose", text: "Landed.\n\n" },
    { kind: "fence", fenceKind: "done", body: "- **Fixed** the lookup.", hints: [{ kind: "title", value: "Resolver cache keyed on the normalized id" }] },
  ])
  // …and a done fence with a rule and no title is left exactly as written.
  assert.deepEqual(parseFenceBody("Shipped.\n\n---\n\n- Fixed.", "done"), { body: "Shipped.\n\n---\n\n- Fixed.", hints: [] })
})

test("an awaiting fence with no hints → empty hints, whole body prose", () => {
  const segs = splitFenceBlocks("```awaiting\nJust waiting a bit.\n```")
  assert.deepEqual(segs, [{ kind: "fence", fenceKind: "awaiting", body: "Just waiting a bit.", hints: [] }])
})

test("multiple fences in order", () => {
  const text = "```awaiting\nhold\ntimers: [10m]\n```\nlater\n```done\nfinished\n```"
  assert.deepEqual(splitFenceBlocks(text), [
    { kind: "fence", fenceKind: "awaiting", body: "hold", hints: [{ kind: "timer", value: "10m" }] },
    { kind: "prose", text: "\nlater\n" },
    { kind: "fence", fenceKind: "done", body: "finished", hints: [] },
  ])
})

test("a ```question fence is NOT a signal fence — left in prose", () => {
  const text = "```question\nWhich default?\nA. one\nB. two\n```"
  assert.deepEqual(splitFenceBlocks(text), [{ kind: "prose", text }])
  assert.equal(hasFence(text), false)
})

test("a plain code fence is left in prose", () => {
  const text = "run this:\n\n```bash\nnpm test\n```"
  assert.deepEqual(splitFenceBlocks(text), [{ kind: "prose", text }])
})

test("unterminated fence degrades to plain prose (no fence segment)", () => {
  const text = "prose\n\n```done\nnever closed…\nstill going"
  const segs = splitFenceBlocks(text)
  assert.equal(segs.length, 1)
  assert.equal(segs[0].kind, "prose")
  assert.equal(segs[0].text, text)
})

test("CRLF line endings are handled", () => {
  const segs = splitFenceBlocks("```awaiting\r\nhold on\r\nshells: [bzvtnt3ig]\r\n```")
  assert.deepEqual(segs, [{ kind: "fence", fenceKind: "awaiting", body: "hold on", hints: [{ kind: "shell", value: "bzvtnt3ig" }] }])
})

test("hasFence detects done and awaiting, ignores question/plain", () => {
  assert.equal(hasFence("```done\nx\n```"), true)
  assert.equal(hasFence("```awaiting\nx\n```"), true)
  assert.equal(hasFence("```question\nx\n```"), false)
  assert.equal(hasFence("no fences here"), false)
})

test("a signal fence QUOTED inside a code fence is prose, not a card", () => {
  // A worker explaining the protocol wraps its sample in a ```` fence; hoisting the sample into a card
  // also orphans the enclosing delimiters, whose unterminated fence swallows the rest of the message.
  const t4 = "`".repeat(4)
  const text = `Write it like this:\n\n${t4}\n\`\`\`done\n- Landed the fix.\n\`\`\`\n${t4}\n\nThat's the whole grammar.`
  assert.deepEqual(splitFenceBlocks(text).map((s) => s.kind), ["prose"])
  assert.equal(hasFence(text), false)
  // …but a real fence after the quoted sample still lands.
  assert.equal(hasFence(`${text}\n\n\`\`\`done\n- Actually landed it.\n\`\`\``), true)
})

test("an empty done body is allowed (body may be '')", () => {
  const segs = splitFenceBlocks("```done\n\n```")
  assert.deepEqual(segs, [{ kind: "fence", fenceKind: "done", body: "", hints: [] }])
})

// THE CLIENT'S SPLIT IS THE TAILER'S — literally the same function since 2026-08-24. The server decides
// whether a fence parks and the client decides how it reads, and a disagreement about where the structure
// ends is a fence that renders one way and behaves another: the class of bug that had `pr-watch:` printing
// at the human while frizz treated the fence as naming nothing, and that the cutover reproduced within the
// hour by moving one parser and not the other.
test("a `---` line ends the frontmatter here too, and the prose survives intact", () => {
  const { hints, body } = parseFenceBody("shells: [bb4sns0ye]\nfor: 20m\n---\nKnown-answer control.\n\n- angular clean\n- puppeteer flagged", "awaiting")
  assert.deepEqual(hints, [{ kind: "shell", value: "bb4sns0ye" }, { kind: "for", value: "20m" }])
  assert.equal(body, "Known-answer control.\n\n- angular clean\n- puppeteer flagged")
})

test("no `---` means the whole fence is frontmatter, and a retired `reason:` falls to the body", () => {
  const { hints, body } = parseFenceBody("shells: [bb4sns0ye]\nfor: 20m\nreason: one line", "awaiting")
  assert.deepEqual(hints, [
    { kind: "shell", value: "bb4sns0ye" },
    { kind: "for", value: "20m" },
  ])
  assert.equal(body, "reason: one line")
})

test("a structural line AFTER the delimiter is prose, so quoting the grammar cannot arm a wait", () => {
  const { hints, body } = parseFenceBody("for: 2h\n---\nI considered `shell: bnope` but it had finished.", "awaiting")
  assert.deepEqual(hints, [{ kind: "for", value: "2h" }])
  assert.match(body, /shell: bnope/)
})

// ---- `title:` — the card's heading, in the worker's own words (2026-08-26) ----
// A SCALAR beside `for:`, not an item: it names nothing frizz can look up, so it never counts toward the
// park (readAwaitingPark ignores it) and a fence carrying only a title still queues. It is capped at
// PARSE time so the hint on the wire is already the string the card draws, and no consumer can render a
// longer one (maintainer 2026-08-26: "let's let the agent specify its own title for these awaiting
// cards … make sure to limit the character count appropriately").
test("an awaiting fence carries a title: hint beside its items", () => {
  const { hints, body } = parseFenceBody("agents: [toolu_01A]\nfor: 2h\ntitle: Three-platform CI run\n---\nThe macOS leg is the flaky one.", "awaiting")
  assert.deepEqual(hints, [
    { kind: "agent", value: "toolu_01A" },
    { kind: "for", value: "2h" },
    { kind: "title", value: "Three-platform CI run" },
  ])
  assert.equal(body, "The macOS leg is the flaky one.", "the title never lands in the prose")
})

// THE CAP IS DEFENSIVE, NOT A FIT. It was 40 until 2026-09-19 — sized to one line on the narrowest
// card — and cut "Spread ask and soundness issue on two TypeScript issues" to "Spread ask and soundness
// issue on…" (maintainer: "We are truncating this title way too aggressively. It should wrap if need
// be."). A heading-length title now survives whole and wraps at the card; only a paragraph is trimmed.
test("a heading-length title survives the parse whole; only a paragraph is trimmed", () => {
  const whole = "Waiting on the three-platform CI run before porting the v2 drivers"
  assert.equal(parseFenceBody(`for: 2h\ntitle: ${whole}`, "awaiting").hints.find((h) => h.kind === "title")?.value, whole)
  const paragraph = "Waiting on the three-platform CI run before porting the v2 drivers, then on the macOS leg which has been flaky for a week, then on the review of the second driver"
  assert.ok(paragraph.length > AWAITING_TITLE_MAX)
  const { hints } = parseFenceBody(`for: 2h\ntitle: ${paragraph}`, "awaiting")
  const title = hints.find((h) => h.kind === "title")!.value
  assert.equal(title, "Waiting on the three-platform CI run before porting the v2 drivers, then on the macOS leg which has been flaky for a…")
  assert.ok(title.length <= AWAITING_TITLE_MAX + 1, "…and never exceeds the cap plus its ellipsis")
  // A worker that hard-wraps its title in the YAML gets ONE line: a heading with a newline in it draws
  // as a broken card rather than as two lines.
  assert.equal(parseFenceBody("title: one\n  two\n  three", "awaiting").hints[0]?.value, "one two three")
})

// THE TITLE IS PROSE, AND PROSE IS NOT YAML. On 2026-09-10 a worker wrote `title: De-slop rewrite of the
// #64172 comment` — naming its PR, as every resting message must — and the card drew "De-slop rewrite of
// the": YAML had read ` #64172 comment` as a comment. A `: ` would have failed the whole document instead,
// and a fence naming a live sub-agent and a PR would have parked nothing. The title is lifted out before
// the YAML parse, so what the worker wrote is what the card draws — items and `for:` still go through YAML.
test("a `#` in the title is the worker's PR number, not a YAML comment", () => {
  const { hints, body } = parseFenceBody("agents: [a314e585bf9f8987a]\nprs: [microsoft/TypeScript#64172]\nfor: 180d\ntitle: De-slop rewrite of the #64172 comment\n---\nWaiting on the rewrite.", "awaiting")
  assert.deepEqual(hints, [
    { kind: "agent", value: "a314e585bf9f8987a" },
    { kind: "pr", value: "microsoft/TypeScript#64172" },
    { kind: "for", value: "180d" },
    { kind: "title", value: "De-slop rewrite of the #64172 comment" },
  ])
  assert.equal(body, "Waiting on the rewrite.")
})

test("a colon or a quote in the title neither fails the frontmatter nor loses the park", () => {
  const colon = parseFenceBody("shells: [bzvtnt3ig]\nfor: 20m\ntitle: Held at CI gate: body fix drafted", "awaiting")
  assert.deepEqual(colon.hints, [
    { kind: "shell", value: "bzvtnt3ig" },
    { kind: "for", value: "20m" },
    { kind: "title", value: "Held at CI gate: body fix drafted" },
  ])
  assert.equal(colon.body, "", "nothing fell to the body")
  const quote = parseFenceBody('title: "Quoted" then more\nfor: 5m', "awaiting")
  assert.deepEqual(quote.hints, [
    { kind: "for", value: "5m" },
    { kind: "title", value: '"Quoted" then more' },
  ])
})

test("a title alone names no wait — it is a heading, not an item", () => {
  const { hints } = parseFenceBody("title: Nightly bench", "awaiting")
  assert.deepEqual(hints, [{ kind: "title", value: "Nightly bench" }])
  assert.equal(isAwaitingItemKind("title"), false, "nothing to look up, so nothing parks (see readAwaitingPark)")
})

// ---- heldHandoffIndex ----

test("the held handoff is the newest needs_input fence before the cut, wherever the quiet parks fall", () => {
  const say = (text: string) => ({ role: "assistant" as const, text })
  const handoff = say("Ready.\n\n```awaiting\nprs: [acme/app#391]\nstatus: needs_input\nfor: 180d\ntitle: Ready, unmerged\n---\nThe merge is yours.\n```")
  const quiet = say("```awaiting\nprs: [acme/app#391]\nstatus: watching\nfor: 180d\n```")
  const steps = say("```awaiting\ntitle: Approve the sign-in\nsteps:\n  - Approve it.\n```")
  const wake = { role: "user" as const, text: "✅ CI PASSED on acme/app#391" }
  const rested = { role: "assistant" as const, kind: "event" as const, text: "```awaiting\nstatus: needs_input\nfor: 1h\n---\nquoted\n```" }
  const messages = [handoff, wake, quiet, rested, wake, quiet]
  assert.equal(heldHandoffIndex(messages, 5), 0, "the quiet parks and the event row are passed over")
  assert.equal(heldHandoffIndex([steps, wake, quiet], 2), 0, "a steps: fence hands the rest to the human too")
  assert.equal(heldHandoffIndex([handoff, wake, steps, wake, quiet], 4), 2, "the newest handoff, as the fold's handoffAt is")
  assert.equal(heldHandoffIndex(messages, 0), -1, "nothing before the cut")
  assert.equal(heldHandoffIndex([say("```md\n" + handoff.text + "\n```"), quiet], 1), -1, "a fence quoted inside a code block is no handoff")
})
