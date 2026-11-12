// THE WORKER SAYS WHETHER A REST NEEDS THE HUMAN (maintainer 2026-10-01) — the queue rule for a thread
// dispatched under the `needs_input:` contract, and the grammar that carries the answer. See
// NEEDS_INPUT_REQUIRED_AT in @frizz/shared for the decision, board.needsInputQueues for the rule, and
// declared-park.test.ts for the scheduler's correction of a fence that gives no answer.
import { test } from "node:test"
import assert from "node:assert/strict"
import { AWAITING_QUESTIONS_MAX, AWAITING_STEP_BODY_MAX, AWAITING_STEP_VALUE_MAX, AWAITING_STEPS_MAX, awaitingNeedsInput, awaitingQuestions, awaitingStepItems, awaitingSteps, NEEDS_INPUT_REQUIRED_AT, needsInputRequired, RETIRED_AWAITING_REPLACEMENT, splitAwaitingFrontmatter, type AwaitingHint } from "@frizz/shared"
import { deriveAwaitingBackground, deriveNeedsYou, hasDeclaredWait, type RegisteredWatch } from "./board.ts"
import type { GithubStatusBook } from "./awaiting.ts"
import type { SessionRow } from "./storage.ts"
import type { SessionTelemetry } from "./tailer.ts"

const CUT = Date.parse(NEEDS_INPUT_REQUIRED_AT)
const NEW_SPAWN = new Date(CUT + 60_000).toISOString()
const LEGACY_SPAWN = new Date(CUT - 86_400_000).toISOString()
const AT = new Date(CUT + 3_600_000).toISOString() // the rest
const NOW = Date.parse(AT) + 5 * 60_000

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    slug: "t", session_id: "s", thread_name: "frizz-t", spawned_at: NEW_SPAWN, last_read_at: null,
    unread: 0, exited: 0, archived: 0, rested_at: AT, title_auto: 0, title: null,
    state: "open", meta: null, seen_at: null, transcript_id: null, ...over,
  }
}
const LIVE_AGENT = { id: "toolu_agent", taskId: "a01b2d20", label: "audit the auth module", startedAt: AT, state: "running" as const }
const LIVE_SHELL = { id: "toolu_shell", taskId: "bzvtnt3ig", label: "nub run test", startedAt: AT, state: "running" as const }
function tele(over: Partial<SessionTelemetry> = {}): SessionTelemetry {
  return { turn: "idle", permPrompt: false, subAgents: [], bgShells: [], pendingQuestion: false, lastAssistantAt: AT, ...over } as SessionTelemetry
}
const awaiting = (...hints: AwaitingHint[]) => ({ lastFence: { kind: "awaiting" as const, body: "", hints } })
const agentPark = (answer?: string, forValue = "2h") => awaiting(
  { kind: "agent", value: "a01b2d20" },
  { kind: "for", value: forValue },
  ...(answer === undefined ? [] : [{ kind: "needs_input" as const, value: answer }]),
)

// deriveNeedsYou's positional tail, named — so each case reads as the fact it changes.
function needsYou(r: SessionRow, t: SessionTelemetry, extra: { now?: number; github?: GithubStatusBook; prs?: string[]; watches?: RegisteredWatch[]; questions?: number; runtime?: "turn-idle" | "exited" } = {}) {
  return deriveNeedsYou(r, t, extra.runtime ?? "turn-idle", false, extra.now ?? NOW, undefined, true, false, extra.github ?? {}, new Set(extra.prs ?? []), new Set(), extra.watches ?? [], extra.questions ?? 0)
}

// ---- THE GRAMMAR ---------------------------------------------------------------------------------

test("the fence carries the answer as structure, never as prose", () => {
  const { hints, body } = splitAwaitingFrontmatter("agents: [a01b2d20]\nneeds_input: false\nfor: 1h")
  assert.deepEqual(hints, [{ kind: "agent", value: "a01b2d20" }, { kind: "needs_input", value: "false" }, { kind: "for", value: "1h" }])
  assert.equal(body, "", "a quiet park is the fence alone")
  assert.equal(awaitingNeedsInput(hints), false)

  const loud = splitAwaitingFrontmatter("agents: [a01b2d20]\nneeds_input: true\nfor: 1h\n---\nThree audits are ready to read.")
  assert.equal(awaitingNeedsInput(loud.hints), true)
  assert.equal(loud.body, "Three audits are ready to read.")
  // The underscore is what the key regex used to refuse: the line fell to the BODY as a sentence and the
  // fence carried no answer at all.
  assert.doesNotMatch(loud.body, /needs_input/)
})

test("the hyphenated spelling is the same key; anything but true or false is no answer", () => {
  assert.equal(awaitingNeedsInput(splitAwaitingFrontmatter("shells: [x]\nneeds-input: true\nfor: 1h").hints), true)
  const yes = splitAwaitingFrontmatter("shells: [x]\nneeds_input: yes\nfor: 1h").hints
  assert.deepEqual(yes.find((h) => h.kind === "needs_input"), { kind: "needs_input", value: "yes" }, "kept as written, so the correction can quote it")
  assert.equal(awaitingNeedsInput(yes), null)
  assert.equal(awaitingNeedsInput(splitAwaitingFrontmatter("shells: [x]\nfor: 1h").hints), null)
})

test("the contract is by dispatch instant, and an unknown instant is legacy", () => {
  assert.equal(needsInputRequired(NEW_SPAWN), true)
  assert.equal(needsInputRequired(NEEDS_INPUT_REQUIRED_AT), true, "the cut instant itself is the new contract")
  assert.equal(needsInputRequired(LEGACY_SPAWN), false)
  assert.equal(needsInputRequired(undefined), false)
  assert.equal(needsInputRequired("not a date"), false)
})

// ---- THE QUEUE RULE ------------------------------------------------------------------------------

test("false on a park frizz can honour keeps the thread out of the queue — and the card still states the wait", () => {
  const t = tele({ subAgents: [LIVE_AGENT], ...agentPark("false") })
  assert.equal(needsYou(row(), t), false)
  // The FACT survives the excusal: the drawer and the full-screen page still say what it waits on.
  assert.equal(deriveAwaitingBackground(row(), t, "turn-idle", false, NOW), true)
})

test("true queues it while the work keeps running, and the card's event-snooze still hides it for this rest", () => {
  const t = tele({ subAgents: [LIVE_AGENT], ...agentPark("true") })
  assert.equal(needsYou(row(), t), true)
  assert.equal(deriveAwaitingBackground(row(), t, "turn-idle", false, NOW), true, "it cards as the wait, with the live work listed")
  assert.equal(needsYou(row({ bg_snooze_rested_at: AT }), t), false, "the human's snooze for this rest")
  assert.equal(needsYou(row({ bg_snooze_rested_at: "2026-01-01T00:00:00.000Z" }), t), true, "a snooze from an earlier rest has expired")
})

test("no answer, or one that is neither true nor false, queues — it is never a park", () => {
  assert.equal(needsYou(row(), tele({ subAgents: [LIVE_AGENT], ...agentPark() })), true)
  assert.equal(needsYou(row(), tele({ subAgents: [LIVE_AGENT], ...agentPark("yes") })), true)
})

test("a false frizz cannot honour queues: a dead name, a run-out for:, no for:, a dead worker", () => {
  const dead = tele({ subAgents: [], ...agentPark("false") })
  assert.equal(needsYou(row(), dead), true, "the sub-agent it names is not running")
  const live = tele({ subAgents: [LIVE_AGENT], ...agentPark("false", "2h") })
  assert.equal(needsYou(row(), live, { now: Date.parse(AT) + 3 * 3_600_000 }), true, "its 2h ran out an hour ago")
  const noFor = tele({ subAgents: [LIVE_AGENT], ...awaiting({ kind: "agent", value: "a01b2d20" }, { kind: "needs_input", value: "false" }) })
  assert.equal(needsYou(row(), noFor), true, "no for: is no park — nothing would ever re-check it")
  assert.equal(needsYou(row(), live, { runtime: "exited" }), true, "a worker that is gone is waiting on nothing")
})

// THE GUESSES THIS REPLACES. Each pair is one wait the legacy rule excused on frizz's own inference; a
// new-contract thread that rests on it without saying so is a bare rest, and the sign-off nudge teaches
// the fence that would have kept it out.
test("the per-wait guesses are gone for a new-contract thread, and unchanged for a legacy one", () => {
  const subAgentRest = tele({ subAgents: [LIVE_AGENT] })
  assert.equal(needsYou(row(), subAgentRest), true, "a live sub-agent alone no longer keeps it out")
  assert.equal(needsYou(row({ spawned_at: LEGACY_SPAWN }), subAgentRest), false, "legacy: still excused")

  const watched = tele({ bgShells: [LIVE_SHELL] })
  const watch: RegisteredWatch = { id: "wch_1", kind: "shell", target: "bzvtnt3ig", createdAt: AT, expiresAt: new Date(NOW + 3_600_000).toISOString() }
  assert.equal(needsYou(row(), watched, { watches: [watch] }), true, "a registered watch alone no longer keeps it out")
  assert.equal(needsYou(row({ spawned_at: LEGACY_SPAWN }), watched, { watches: [watch] }), false, "legacy: still excused")

  const ci: GithubStatusBook = { "acme/app#1": { state: "open", checks: "running", running: 1, passed: 0, failed: 0 } as GithubStatusBook[string] }
  assert.equal(needsYou(row(), tele(), { github: ci, prs: ["acme/app#1"] }), true, "CI still running no longer keeps it out")
  assert.equal(needsYou(row({ spawned_at: LEGACY_SPAWN }), tele(), { github: ci, prs: ["acme/app#1"] }), false, "legacy: still held")
})

test("a PR-only false park holds whatever CI is doing — the worker said the human has nothing to do", () => {
  const prPark = tele(awaiting({ kind: "pr", value: "acme/app#1" }, { kind: "for", value: "30d" }, { kind: "needs_input", value: "false" }))
  const green: GithubStatusBook = { "acme/app#1": { state: "open", checks: "passing", running: 0, passed: 2, failed: 0 } as GithubStatusBook[string] }
  assert.equal(needsYou(row(), prPark, { github: green, prs: ["acme/app#1"] }), false)
  assert.equal(needsYou(row(), prPark, { github: green, prs: [] }), true, "an unregistered PR is nothing that will wake it")
})

// A COLD RESUME RE-APPLIES THE CURRENT PROMPT, so a thread dispatched before the cut can learn the key
// after an upgrade. Its `true` must queue it, where the legacy park rule would have excused it.
test("an explicit answer is honoured from a legacy thread too", () => {
  const legacy = row({ spawned_at: LEGACY_SPAWN })
  assert.equal(needsYou(legacy, tele({ subAgents: [LIVE_AGENT], ...agentPark("true") })), true)
  assert.equal(needsYou(legacy, tele({ subAgents: [LIVE_AGENT], ...agentPark("false") })), false)
  // …and a legacy fence that never mentions the key keeps the legacy reading.
  assert.equal(needsYou(legacy, tele({ subAgents: [LIVE_AGENT], ...agentPark() })), false)
})

test("the hard gates still outrank a false: an open question, a done handoff", () => {
  const t = tele({ subAgents: [LIVE_AGENT], ...agentPark("false") })
  assert.equal(needsYou(row(), t, { questions: 1 }), true, "a question waits on a person, whatever the fence says")
  const done = tele({ subAgents: [LIVE_AGENT], lastFence: { kind: "done", body: "- **Shipped** it", hints: [] } })
  assert.equal(needsYou(row(), done), true, "a done card queues even with a child still running")
})

// ---- STEPS FOR THE HUMAN (2026-10-03) --------------------------------------------------------------
// A fence can hand the human steps only they can perform. They ride the fence rather than a registered
// row (maintainer 2026-10-03: "I don't think this requires persistently registering it"), and they are
// PROSE inside the frontmatter, which is exactly what YAML cannot hold — so they are read verbatim.

test("steps are read verbatim: code, colons and #refs survive, and the lookups beside them still parse", () => {
  const { hints, body } = splitAwaitingFrontmatter([
    "title: Sign in to npm",
    "steps:",
    "  - Run `npm login --auth-type=web` in a terminal",
    "  - Approve it: use the maintainer account, as in #482",
    "    (the 2FA prompt can take a minute)",
    "prs: [acme/app#391]",
    "for: 2d",
    "---",
    "The publish step runs as the maintainer.",
  ].join("\n"))
  assert.deepEqual(awaitingSteps(hints), [
    "Run `npm login --auth-type=web` in a terminal",
    "Approve it: use the maintainer account, as in #482 (the 2FA prompt can take a minute)",
  ])
  // A backtick opening a step is a YAML parse error, and it must not cost the fence its lookups.
  assert.deepEqual(hints.filter((h) => h.kind === "pr"), [{ kind: "pr", value: "acme/app#391" }])
  assert.deepEqual(hints.filter((h) => h.kind === "for"), [{ kind: "for", value: "2d" }])
  assert.equal(body, "The publish step runs as the maintainer.")
})

// A step is a Markdown list item (2026-11-09): its first paragraph is the title, and what follows a blank
// line, indented under it, is a Markdown body drawn beneath it.
test("a step's first paragraph is its title, and what is indented under it after a blank line is its body", () => {
  const { hints, body } = splitAwaitingFrontmatter([
    "title: Publish the release",
    "steps:",
    "  - Sign in to npm",
    "    with the maintainer account",
    "",
    "    Run this in a terminal on **this** machine:",
    "",
    "    ```sh",
    "    npm login --auth-type=web",
    "",
    "    npm whoami",
    "    ```",
    "",
    "    ---",
    "",
    "    - If the page says the code expired, request a new one.",
    "      - Then approve again.",
    "  - Publish the [draft release](https://github.com/acme/app/releases)",
    "  - Reply here",
    "    ```",
    "    Done",
    "    ```",
    "prs: [acme/app#391]",
    "---",
    "The publish waits on the sign-in.",
  ].join("\n"))
  assert.deepEqual(awaitingStepItems(hints), [
    {
      text: "Sign in to npm with the maintainer account",
      body: "Run this in a terminal on **this** machine:\n\n```sh\nnpm login --auth-type=web\n\nnpm whoami\n```\n\n---\n\n- If the page says the code expired, request a new one.\n  - Then approve again.",
    },
    { text: "Publish the [draft release](https://github.com/acme/app/releases)" },
    { text: "Reply here", body: "```\nDone\n```" },
  ], "a `---` and a list inside a body are the body's own, and a code block can open one straight under its title")
  assert.deepEqual(awaitingSteps(hints), ["Sign in to npm with the maintainer account", "Publish the [draft release](https://github.com/acme/app/releases)", "Reply here"], "the titles alone")
  assert.deepEqual(hints.filter((h) => h.kind === "pr"), [{ kind: "pr", value: "acme/app#391" }], "the keys after the steps still read")
  assert.equal(body, "The publish waits on the sign-in.", "and the `---` after them still ends the frontmatter")
})

test("a body cannot swallow the fence: a `---` at the item's own indent ends the frontmatter, and a runaway body is cut", () => {
  const { hints, body } = splitAwaitingFrontmatter(["steps:", "  - Sign in", "", "    Use the bot account.", "  ---", "The handoff."].join("\n"))
  assert.deepEqual(awaitingStepItems(hints), [{ text: "Sign in", body: "Use the bot account." }])
  assert.equal(body, "The handoff.")
  const long = awaitingStepItems(splitAwaitingFrontmatter(`steps:\n  - Sign in\n\n    ${"z".repeat(AWAITING_STEP_BODY_MAX + 50)}`).hints)[0]
  assert.equal(long.body, `${"z".repeat(AWAITING_STEP_BODY_MAX)}…`)
  assert.deepEqual(awaitingStepItems(splitAwaitingFrontmatter("steps:\n  - Sign in\n\n\n  - Approve").hints), [{ text: "Sign in" }, { text: "Approve" }], "blank lines alone are no body")
})

test("a step on the key line is one step; a flow list YAML can read is a list, and one it cannot stays one step", () => {
  assert.deepEqual(awaitingSteps(splitAwaitingFrontmatter("steps: Merge acme/app#391").hints), ["Merge acme/app#391"])
  assert.deepEqual(awaitingSteps(splitAwaitingFrontmatter("steps: [Sign in, Approve the prompt]").hints), ["Sign in", "Approve the prompt"])
  assert.deepEqual(awaitingSteps(splitAwaitingFrontmatter("steps: [Run `npm login`, Approve]").hints), ["Run `npm login`", "Approve"], "a backtick INSIDE a step is fine")
  // A step OPENING on a backtick, or carrying ` #`, is a flow list YAML cannot read: every word kept, brackets off.
  assert.deepEqual(awaitingSteps(splitAwaitingFrontmatter("steps: [`npm login` first, Approve]").hints), ["`npm login` first, Approve"])
  assert.deepEqual(awaitingSteps(splitAwaitingFrontmatter("steps: [Run x, see #4]").hints), ["Run x, see #4"])
  assert.deepEqual(awaitingSteps(splitAwaitingFrontmatter("agents: [a01b2d20]\nfor: 1h").hints), [], "no steps is the ordinary fence")
})

test("steps have caps of their own, after the hints' cap, so a long list never crowds out a lookup", () => {
  const many = Array.from({ length: AWAITING_STEPS_MAX + 2 }, (_, i) => `  - step ${i + 1}`)
  const shells = Array.from({ length: 6 }, (_, i) => `id${i}`).join(", ")
  const { hints } = splitAwaitingFrontmatter([`shells: [${shells}]`, "needs_input: true", "for: 1h", "steps:", ...many, `  - ${"x".repeat(900)}`].join("\n"))
  assert.equal(hints.filter((h) => h.kind === "shell").length, 6)
  assert.ok(hints.some((h) => h.kind === "needs_input"), "the answer survives a long list")
  assert.ok(hints.some((h) => h.kind === "for"), "so does for:")
  const steps = awaitingSteps(hints)
  assert.equal(steps.length, AWAITING_STEPS_MAX)
  assert.deepEqual(steps.slice(0, 2), ["step 1", "step 2"])
  const long = awaitingSteps(splitAwaitingFrontmatter(`steps:\n  - ${"y".repeat(AWAITING_STEP_VALUE_MAX + 400)}`).hints)[0]
  assert.equal(long, `${"y".repeat(AWAITING_STEP_VALUE_MAX)}…`, "a runaway step is cut where the cut shows")
})

// A real rest on 2026-11-11 wrote 14 steps and the cap of 12 cut the last two, "Paste the message" and
// "Send the document", with nothing on the card to say so. Real rests had written 19 and 30.
test("a long real-world list survives whole", () => {
  const thirty = Array.from({ length: 30 }, (_, i) => `  - step ${i + 1}`)
  const steps = awaitingSteps(splitAwaitingFrontmatter(["steps:", ...thirty].join("\n")).hints)
  assert.equal(steps.length, 30)
  assert.equal(steps.at(-1), "step 30")
})

test("a real step that names its ids and its link is never cut", () => {
  // The shape of the step that ended mid-sentence under the old 500 cap (2026-10-12): three 32-character
  // key ids beside a dashboard link, ~720 characters as written. The ids here are made up.
  const step = "Open [Cloudflare → R2 → API tokens](https://dash.cloudflare.com/0123456789abcdef0123456789abcdef/r2/api-tokens) and delete the three old tokens with these Access Key IDs: `aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` (acme-uploads-prod, the old production uploads key), `bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb` (acme-private-prod, the old production webhook-archive key), and `cccccccccccccccccccccccccccccccc` (acme-uploads-dev, the old dev key). If the list shows names rather than IDs, open each token to see its ID. Keep the two new tokens, whose names end in `-2026-10-12`, and anything else you don't recognise from this list. Press Done when the three are gone."
  assert.ok(step.length > 500)
  assert.deepEqual(awaitingSteps(splitAwaitingFrontmatter(`steps:\n  - ${step}`).hints), [step])
})

test("a step written as a YAML quoted scalar renders without its quotes", () => {
  const read = (fence: string) => awaitingSteps(splitAwaitingFrontmatter(fence).hints)
  assert.deepEqual(read('steps:\n  - "Delete the token: `aaaa1111`, then press Done."'), ["Delete the token: `aaaa1111`, then press Done."])
  assert.deepEqual(read("steps:\n  - 'Approve the **GitHub CLI** request, it''s the newest'"), ["Approve the **GitHub CLI** request, it's the newest"])
  assert.deepEqual(read('steps:\n  - "Open the list\n    and delete the old key."'), ["Open the list and delete the old key."], "a quoted step continued on the next line")
  // Quotes that open and close a step without wrapping it whole are the worker's prose.
  assert.deepEqual(read('steps:\n  - "Done" means the key is gone, so type "Done"'), ['"Done" means the key is gone, so type "Done"'])
  assert.deepEqual(read('steps:\n  - "'), ['"'])
})

test("steps ARE the needs_input answer: the line may be left out, and a false beside them reads true", () => {
  assert.equal(awaitingNeedsInput(splitAwaitingFrontmatter("steps:\n  - Sign in").hints), true)
  assert.equal(awaitingNeedsInput(splitAwaitingFrontmatter("needs_input: false\nsteps:\n  - Sign in").hints), true, "a thread waiting on its human never hides from them")
  // The retired `human:` gate now points at steps for an act, and at a question for a decision.
  assert.match(RETIRED_AWAITING_REPLACEMENT.human, /`steps:`/)
  assert.match(RETIRED_AWAITING_REPLACEMENT.human, /asked in a ```question fence/)
})

// `questions:` (2026-10-05): a fence beside open questions names every one the worker still needs. The
// ids are lookups, read like any other list, and they name the human the same way steps do.

test("questions are read as ids — flow or block list, case-blind, a gloss after the id ignored", () => {
  assert.deepEqual(awaitingQuestions(splitAwaitingFrontmatter("questions: [QST_ab12cd34, qst_0011]\nneeds_input: true").hints), ["qst_ab12cd34", "qst_0011"])
  assert.deepEqual(awaitingQuestions(splitAwaitingFrontmatter("questions:\n  - qst_ab12cd34 — the cache call\n  - qst_0011").hints), ["qst_ab12cd34", "qst_0011"])
  assert.deepEqual(awaitingQuestions(splitAwaitingFrontmatter("questions: qst_ab12cd34").hints), ["qst_ab12cd34"], "one bare item")
  assert.deepEqual(awaitingQuestions(splitAwaitingFrontmatter("agents: [a01b2d20]\nfor: 1h").hints), [], "no questions is the ordinary fence")
})

test("questions have a cap of their own, after the hints' cap, so they never crowd out a lookup", () => {
  const ids = Array.from({ length: AWAITING_QUESTIONS_MAX + 6 }, (_, i) => `qst_${i}`).join(", ")
  const shells = Array.from({ length: 6 }, (_, i) => `id${i}`).join(", ")
  const { hints } = splitAwaitingFrontmatter([`questions: [${ids}]`, `shells: [${shells}]`, "for: 1h"].join("\n"))
  assert.equal(hints.filter((h) => h.kind === "shell").length, 6)
  assert.ok(hints.some((h) => h.kind === "for"))
  assert.equal(awaitingQuestions(hints).length, AWAITING_QUESTIONS_MAX)
})

test("questions ARE the needs_input answer: the line may be left out, and a false beside them reads true", () => {
  assert.equal(awaitingNeedsInput(splitAwaitingFrontmatter("questions: [qst_ab12]").hints), true)
  assert.equal(awaitingNeedsInput(splitAwaitingFrontmatter("needs_input: false\nshells: [x]\nquestions: [qst_ab12]\nfor: 1h").hints), true)
})

const stepsFence = (...extra: AwaitingHint[]) => awaiting({ kind: "step", value: "Run `npm login`" }, { kind: "step", value: "Approve the prompt" }, ...extra)

test("a steps fence queues the thread — new contract, legacy, and with a false beside it — and the resting card states it", () => {
  assert.equal(needsYou(row(), tele(stepsFence())), true, "new contract, no needs_input line")
  assert.equal(needsYou(row({ spawned_at: LEGACY_SPAWN }), tele(stepsFence())), true, "legacy thread")
  assert.equal(needsYou(row(), tele({ subAgents: [LIVE_AGENT], ...stepsFence({ kind: "agent", value: "a01b2d20" }, { kind: "for", value: "2h" }, { kind: "needs_input", value: "false" }) })), true, "steps outrank a false on a live park")
  assert.equal(deriveAwaitingBackground(row(), tele(stepsFence()), "turn-idle", false, NOW), true, "the card is where the steps are performed from")
  assert.equal(hasDeclaredWait(tele(stepsFence()), NOW), true)
  // A question still outranks it, exactly as it outranks every awaiting card.
  assert.equal(deriveAwaitingBackground(row(), tele(stepsFence()), "turn-idle", false, NOW, undefined, false, {}, new Set(), new Set(), [], 1), false)
})
