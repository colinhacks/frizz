// WHICH MESSAGES A THREAD SIGNED OFF ON (sign-offs.ts → TranscriptMessage.signOff), driven through the real
// Claude projection so the `rest` dividers, wake flags and coalesced tool calls are the ones a page carries.
import { test } from "node:test"
import assert from "node:assert/strict"
import { BURIED_ANSWERS_HEADER, SIGNOFF_NUDGE_MARKER, wakeDeliveryToken, type TranscriptMessage } from "@frizz/shared"

// The retired sign-off reminder (scheduler SOURCE 9) as transcripts written while it ran still carry it.
const SIGNOFF_NUDGE_MESSAGE = `${SIGNOFF_NUDGE_MARKER} Nothing about your task has changed, and no new work is being asked of you.\n\nYou rested without a fence, so this thread cannot be triaged.`
import { parseTranscript } from "./transcript.ts"
import { projectSignOffs, readRestMessage, signOffIndices } from "./sign-offs.ts"

let clock = 0
const at = () => new Date(Date.UTC(2026, 10, 6, 12, 0, clock++)).toISOString()
const human = (text: string) => JSON.stringify({ type: "user", timestamp: at(), message: { role: "user", content: text } })
let wakes = 0
const wake = (text: string) => human(`${text}\n\n${wakeDeliveryToken(`w${wakes++}`)}`)
let ids = 0
// One whole turn the agent RESTED on: its final message, written with `stop_reason: "end_turn"`.
const rest = (text: string) => JSON.stringify({ type: "assistant", timestamp: at(), message: { id: `m${ids++}`, stop_reason: "end_turn", content: [{ type: "text", text }] } })
// Mid-turn narration with a shell call batched after it.
const narrate = (text: string, command = "ls") => JSON.stringify({ type: "assistant", timestamp: at(), message: { id: `m${ids++}`, stop_reason: "tool_use", content: [{ type: "text", text }, { type: "tool_use", id: `t${ids}`, name: "Bash", input: { command } }] } })
const toolResult = (id: string) => JSON.stringify({ type: "user", timestamp: at(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } })

const fence = (kind: "done" | "awaiting", body: string) => `\`\`\`${kind}\n${body}\n\`\`\``
const NEEDS_INPUT = `The fix is on acme/app#391 and CI is green; the merge is yours.\n\n${fence("awaiting", "prs: [acme/app#391]\nstatus: needs_input\nfor: 180d\n---\nReady at 0251203e.")}`
const QUIET = fence("awaiting", "prs: [acme/app#391]\nstatus: watching\nfor: 180d")
const WORKING = `Kicked off the bench.\n\n${fence("awaiting", "shells: [b1]\nstatus: working\nfor: 2h")}`

const project = (...lines: string[]) => parseTranscript(lines.join("\n"))
const marked = (msgs: TranscriptMessage[]) => signOffIndices(msgs).map((i) => msgs[i].text.split("\n")[0])

test("a rest is a sign-off unless it is a quiet park", () => {
  assert.equal(readRestMessage({ text: NEEDS_INPUT }), "signOff")
  assert.equal(readRestMessage({ text: fence("done", "- Landed it.") }), "signOff")
  assert.equal(readRestMessage({ text: `Which one?\n\n\`\`\`question\nid: pick\nkind: choice\nquestion: Which one?\noptions:\n  - A\n  - B\n\`\`\`` }), "signOff")
  // A reference to an earlier question puts it back in the queue: the rest is for the human.
  assert.equal(readRestMessage({ text: `Still need this.\n\n\`\`\`question\nid: pick\n\`\`\`` }), "signOff")
  // Steps name the human whatever the status line says.
  assert.equal(readRestMessage({ text: fence("awaiting", "status: watching\nsteps:\n  - Approve the sign-in.") }), "signOff")
  // A fence that gives no answer queues the thread, so it is read as one for the human too.
  assert.equal(readRestMessage({ text: fence("awaiting", "shells: [b1]\nfor: 2h") }), "signOff")
  assert.equal(readRestMessage({ text: QUIET }), "quiet")
  assert.equal(readRestMessage({ text: WORKING }), "quiet")
  assert.equal(readRestMessage({ text: "Pushed the fix." }), "bare")
  // A fence QUOTED mid-message is not the rest's fence (parseSignalFence's end anchor).
  assert.equal(readRestMessage({ text: `${QUIET}\n\nThat park was wrong; here is the write-up.` }), "bare")
  assert.equal(readRestMessage({ text: "   " }), undefined)
})

// The reylo shape (2026-11-17): the worker asks with four backticks, as the contract says to once a question
// holds a code block, and parks `status: working` on the PR still in CI. The ask makes it a sign-off, in
// every opener the registrar reads; the legacy pending-question flag knew only three backticks, and read
// as that flag the rest was its quiet park, so the stretch kept no sign-off and the board folded none of it.
test("a question in any opener the registrar reads is a sign-off, whatever park follows it", () => {
  const t4 = "`".repeat(4)
  const ask = (open: string, close = open) => `CI is still running on acme/app#391, and one call is yours.\n\n${open}question\nid: publish\nkind: choice\nquestion: Publish the crates with 0.8.0?\noptions:\n  - Yes\n  - No\n---\nThe publish runs:\n\n\`\`\`sh\ncargo publish -p reylo\n\`\`\`\n${close}\n\n${WORKING.split("\n\n")[1]}`
  assert.equal(readRestMessage({ text: ask(t4) }), "signOff")
  assert.equal(readRestMessage({ text: ask("~~~") }), "signOff")
  assert.equal(readRestMessage({ text: `Still need this one.\n\n${t4}question\nid: publish\n${t4}\n\n${fence("awaiting", "prs: [acme/app#391]\nstatus: watching\nfor: 7d")}` }), "signOff")
  // A sample QUOTED inside an outer fence asks nothing: the park is still quiet.
  assert.equal(readRestMessage({ text: `The grammar:\n\n${t4}md\n\`\`\`question\nid: x\n\`\`\`\n${t4}\n\n${fence("awaiting", "shells: [b1]\nstatus: working\nfor: 2h")}` }), "quiet")
  const msgs = project(
    human("Answers to earlier questions:\n1. Merge them."),
    narrate("Both answers are in. Merging the crates."),
    rest(QUIET),
    wake("❌ CI FAILED on acme/app#391"),
    rest(ask(t4)),
  )
  assert.deepEqual(marked(msgs), ["CI is still running on acme/app#391, and one call is yours."])
  // And a fence after it is no rest on the fence alone: the question is new.
  const after = project(human("Go."), rest(NEEDS_INPUT), wake("✅"), rest(`${fence("awaiting", "prs: [acme/app#391]\nstatus: needs_input\nfor: 1d")}\n\n${t4}question\nid: publish\nkind: text\nquestion: Which version?\n${t4}`))
  assert.equal(marked(after).length, 2)
})

test("the hand-off stays marked when PR-review wakes end in quiet parks after it", () => {
  const msgs = project(
    human("Fix the flaky upload and open a PR."),
    narrate("Reading the upload path."),
    rest(NEEDS_INPUT),
    wake("💬 New review on acme/app#391"),
    narrate("Addressing the nit."),
    rest(QUIET),
    wake("✅ CI PASSED on acme/app#391"),
    rest(QUIET),
  )
  assert.deepEqual(marked(msgs), ["The fix is on acme/app#391 and CI is green; the merge is yours."])
  // Narration is never a sign-off, whatever it says.
  assert.ok(msgs.filter((m) => m.text.startsWith("Reading") || m.text.startsWith("Addressing")).length === 2)
  const projected = projectSignOffs([...msgs])
  assert.deepEqual(projected.filter((m) => m.signOff).map((m) => m.text), [NEEDS_INPUT])
})

test("every sign-off is marked, newest last, and a turn's narration is not", () => {
  const msgs = project(
    human("Audit the three packages."),
    narrate("Starting with core."),
    rest(`Core is clean.\n\n${fence("awaiting", "agents: [a1]\nstatus: needs_input\nfor: 1h\n---\nTwo more to go.")}`),
    wake("Sub-agent finished"),
    rest(fence("done", "- Wrote the audit to `audits/`.")),
  )
  assert.deepEqual(marked(msgs), ["Core is clean.", "```done"])
})

test("a `frizzctl done` signs its turn off, though a pointer follows it, and the write-up stays marked", () => {
  const msgs = project(
    human("Write the report."),
    narrate("The report is written to `report.md`: three findings, all fixed.", "frizzctl done --body-file - <<'EOF'\n- Wrote the report.\nEOF"),
    toolResult(`t${ids}`),
    rest("The write-up is above."),
  )
  assert.deepEqual(marked(msgs), ["The report is written to `report.md`: three findings, all fixed.", "The write-up is above."])
})

// The frizz Console-chip shape (2026-11-16): the write-up, one more command, and a line about that command.
test("an afterword keeps the write-up before it marked; a sign-off longer than the narration before it does not", () => {
  const writeUp = "**Fixed.** The project chip now sits inside the prompt box, first in the row along the bottom. It is on `main` as `92337310d`, and the status row above the box is back to one line."
  const afterword = project(human("Move the chip."), narrate(writeUp, "kill 4242"), toolResult(`t${ids}`), rest("The test stacks are removed."))
  assert.deepEqual(marked(afterword), ["**Fixed.** The project chip now sits inside the prompt box, first in the row along the bottom. It is on `main` as `92337310d`, and the status row above the box is back to one line.", "The test stacks are removed."])
  // A fence's body counts as words, its keys do not: a one-line body under a longer write-up is its afterword.
  const fenced = project(human("Ship it."), narrate("The release is staged and the approval card is up on your phone.", "stager ask x"), toolResult(`t${ids}`), rest(fence("awaiting", "shells: [b1]\nstatus: needs_input\nfor: 1h\n---\nApprove it.")))
  assert.deepEqual(marked(fenced), ["The release is staged and the approval card is up on your phone.", "```awaiting"])
  // A fence ALONE marks nothing, as before: the sign-off before it stands, and a status line written
  // ahead of it stays narration.
  const alone = project(human("Ship it."), rest(NEEDS_INPUT), wake("CI passed"), narrate("CI is still green; parking."), toolResult(`t${ids}`), rest(fence("awaiting", "prs: [acme/app#391]\nstatus: needs_input\nfor: 180d")))
  assert.deepEqual(marked(alone), ["The fix is on acme/app#391 and CI is green; the merge is yours."])
  // A question is what its message says: one ask under a line of prose is no afterword to the status line
  // before it (the seeded fold-withdrawn thread kept that status line in view until questions counted).
  const asks = project(human("Move the settings."), narrate("Geometry columns arrive as WKB buffers and fall through to the hex branch."), toolResult(`t${ids}`), rest("One call is left: where they live.\n\n```question\nid: store\nkind: choice\nquestion: Should the settings store use SQLite or a JSON file?\noptions:\n  - SQLite\n  - JSON file\n```"))
  assert.deepEqual(marked(asks), ["One call is left: where they live."])
  // The usual shape: a status line, then the write-up. Only the write-up.
  const narrated = project(human("Fix it."), narrate("Committing, then stopping my stack."), toolResult(`t${ids}`), rest(writeUp))
  assert.deepEqual(marked(narrated), [writeUp])
  // Never past a delivery: the words before a wake belong to the rest before it, here a quiet park.
  const woken = project(human("Run the bench."), narrate("Starting the bench run."), rest(QUIET), wake("Bench finished"), rest("Done."))
  assert.deepEqual(marked(woken), ["Done."])
})

test("a bare rest is read by the answer to frizz's reminder about it", () => {
  const writeUp = "Everything is fixed: the cache keys on the normalized id now, and `npm test` is green."
  // Answered with a sign-off: the bare write-up was for the human, and both stay marked.
  const answered = project(human("Fix the cache."), rest(writeUp), wake(SIGNOFF_NUDGE_MESSAGE), rest(fence("done", "- Fixed the cache.")))
  assert.ok(answered.some((m) => m.wake && m.text.startsWith("**This message is from frizz")), "the reminder projects as a wake")
  assert.deepEqual(marked(answered), [writeUp, "```done"])
  // Answered with a quiet park: it was a status line, and nothing is marked.
  const parked = project(human("Fix the cache."), rest("Pushed; CI is running."), wake(SIGNOFF_NUDGE_MESSAGE), rest(WORKING))
  assert.deepEqual(marked(parked), [])
  // Reminded twice before the answer: the chain reads back through both.
  const twice = project(human("Fix the cache."), rest(writeUp), wake(SIGNOFF_NUDGE_MESSAGE), rest("Sorry, see above."), wake(SIGNOFF_NUDGE_MESSAGE), rest(fence("done", "- Fixed.")))
  assert.deepEqual(marked(twice), [writeUp, "Sorry, see above.", "```done"])
  // Not answered yet: the board queued it as the handoff, so it is one.
  assert.deepEqual(marked(project(human("Fix the cache."), rest(writeUp))), [writeUp])
  // A wake that is NOT the reminder says nothing about the bare rest before it.
  assert.deepEqual(marked(project(human("Fix the cache."), rest(writeUp), wake("💬 New review on acme/app#391"), rest(QUIET))), [writeUp])
})

test("a rest on the fence alone leaves the sign-off before it standing", () => {
  const bareNeeds = fence("awaiting", "prs: [acme/app#391]\nstatus: needs_input\nfor: 180d")
  // Woken by CI with nothing new: the hand-off before is still the one to read.
  const woken = project(human("Fix the flaky upload."), rest(NEEDS_INPUT), wake("✅ CI PASSED on acme/app#391"), narrate("Checking the run."), rest(bareNeeds))
  assert.deepEqual(marked(woken), ["The fix is on acme/app#391 and CI is green; the merge is yours."])
  // A bare `done` fence over nothing is the same: the write-up it closes is the sign-off.
  assert.deepEqual(marked(project(human("Fix it."), rest(NEEDS_INPUT), wake("✅ merged"), rest(fence("done", "")))), ["The fix is on acme/app#391 and CI is green; the merge is yours."])
  // Anything in or around the fence is a new sign-off: a body, steps, a question, or prose.
  assert.deepEqual(marked(project(human("Go."), rest(NEEDS_INPUT), wake("✅"), rest(fence("awaiting", "status: needs_input\nfor: 1h\n---\nNow merged.")))).length, 2)
  assert.deepEqual(marked(project(human("Go."), rest(NEEDS_INPUT), wake("✅"), rest(fence("awaiting", "status: needs_input\nsteps:\n  - Approve it.")))).length, 2)
  assert.deepEqual(marked(project(human("Go."), rest(NEEDS_INPUT), wake("✅"), rest(`Merged.\n\n${bareNeeds}`))).length, 2)
  // It still answers a reminder as a sign-off, so the bare write-up it answered stays marked.
  const writeUp = "Everything is fixed: the cache keys on the normalized id now, and `npm test` is green."
  assert.deepEqual(marked(project(human("Fix the cache."), rest(writeUp), wake(SIGNOFF_NUDGE_MESSAGE), rest(bareNeeds))), [writeUp])
})

test("a rest on the sign-off's own fence again, word for word, leaves that sign-off standing", () => {
  const steps = fence("awaiting", "title: Add Lubos's company in Justworks\nsteps:\n  - In Justworks, add Lubos Venntures Limited as an international contractor.\n\n    The values it asks for are in the offer letter.\n---\nJustworks emails Lubos for his payment details.")
  const writeUp = "Justworks stays. The one thing left is getting the two contractors set up."
  // pullfrog-app 2026-11-12: a message from another thread woke it, it looked, and it pasted the fence back.
  const pasted = project(human("Stay on Justworks?"), narrate("Reading the offer letter."), rest(`${writeUp}\n\n${steps}`), wake("Done, from the Tommy contract thread."), narrate("Checking the notes."), rest(steps))
  assert.deepEqual(marked(pasted), [writeUp])
  // Pasted twice, still the same: each copy holds against the sign-off it repeats.
  assert.deepEqual(marked(project(human("Stay on Justworks?"), rest(`${writeUp}\n\n${steps}`), wake("✅"), rest(steps), wake("✅"), rest(`\n${steps}\n`))), [writeUp])
  // A reworded fence is something new, though its steps are the same.
  const reworded = steps.replace("Add Lubos's company in Justworks", "Lubos is next")
  assert.equal(marked(project(human("Stay on Justworks?"), rest(`${writeUp}\n\n${steps}`), wake("✅"), rest(reworded))).length, 2)
  // And so is the same fence with words around it.
  assert.equal(marked(project(human("Stay on Justworks?"), rest(`${writeUp}\n\n${steps}`), wake("✅"), rest(`Still waiting on this.\n\n${steps}`))).length, 2)
  // Once the human comes in — typing, or answering a question — the fence again is a reply to them.
  assert.equal(marked(project(human("Stay on Justworks?"), rest(`${writeUp}\n\n${steps}`), human("Which screen is it on?"), rest(steps))).length, 2)
  assert.equal(marked(project(human("Stay on Justworks?"), rest(`${writeUp}\n\n${steps}`), wake(`${BURIED_ANSWERS_HEADER}\n1. \`keep-justworks\` → Stay on Justworks`), rest(steps))).length, 2)
})

test("projectSignOffs copies what it marks and clears a stale mark", () => {
  const msgs = project(human("Go."), rest("Pushed; CI is running."), wake(SIGNOFF_NUDGE_MESSAGE), rest(WORKING))
  const bare = msgs.findIndex((m) => m.text === "Pushed; CI is running.")
  // As if an earlier read had marked it, before the answer to the reminder arrived.
  const stale = { ...msgs[bare], signOff: true as const }
  const input = [...msgs]
  input[bare] = stale
  const out = projectSignOffs(input)
  assert.equal(out[bare].signOff, undefined)
  assert.equal(stale.signOff, true, "the message object handed in is never edited")
  const fresh = project(human("Go."), rest(NEEDS_INPUT))
  const original = fresh[1]
  const projected = projectSignOffs([...fresh])
  assert.equal(projected[1].signOff, true)
  assert.notEqual(projected[1], original)
  assert.equal(original.signOff, undefined, "a retained fold's message stays as the fold left it")
})

// Found by running every transcript on the maintainer's Mac through this pass (2026-11-17): a reply that
// parked `status: working` on a sub-agent folded under the status line before it.
test("a quiet park keeps its words in view when they answer the human or run to a write-up, and signs nothing off", () => {
  const reply = `You're right, and the drift is mine. The plot is this: inline \`query!\` works on all three databases.\n\n${fence("awaiting", "agents: [a1]\nstatus: working\nfor: 2h")}`
  const msgs = project(human("I feel like you've lost the plot."), narrate("Spawning the reviewer now."), rest(reply))
  assert.deepEqual(marked(msgs), ["You're right, and the drift is mine. The plot is this: inline `query!` works on all three databases."])
  // After a wake, a one-liner is the rest a wake with nothing new gets: it folds. A write-up's worth stays.
  const news = `${"The run is back and the numbers moved: ".padEnd(420, "x")}\n\n${fence("awaiting", "prs: [acme/app#391]\nstatus: watching\nfor: 7d")}`
  const later = project(human("Babysit acme/app#391."), rest(QUIET), wake("❌ CI FAILED on acme/app#391"), rest(`That review is my own reply.\n\n${QUIET}`), wake("✅ CI PASSED on acme/app#391"), rest(news))
  assert.deepEqual(marked(later), ["The run is back and the numbers moved: " + "x".repeat(420 - 39)])
  // The afterword rule does not reach past a quiet park: the status line before a reply stays narration.
  const afterword = project(human("Run the bench."), narrate("Starting the bench run across all three arms now.", "bench"), toolResult(`t${ids}`), rest(WORKING))
  assert.deepEqual(marked(afterword), ["Kicked off the bench."])
  // Kept is not signed off: as the answer to a reminder, a quiet park still takes the bare rest back.
  const taken = project(human("Fix the cache."), rest("Pushed; CI is running."), wake(SIGNOFF_NUDGE_MESSAGE), rest(news))
  assert.deepEqual(marked(taken).map((t) => t.slice(0, 12)), ["The run is b"])
})

// The contract tells a worker to ask the moment it finds a question and keep working, so the ask is often not
// what its turn rests on (sql-server-support…, 2026-11-16: four questions at message 81, three quiet parks,
// and 143 unfolded messages under them).
test("a handoff written mid-turn is kept, so a stretch that then parks quietly still folds around it", () => {
  const ask = `Four calls are yours before the loader can take SQL Server.\n\n\`\`\`question\nid: url-scheme\nkind: choice\nquestion: Which URL scheme?\noptions:\n  - sqlserver://\n  - mssql://\n\`\`\``
  const msgs = project(human("Add SQL Server support."), narrate("Mapping the dialect branches."), narrate(ask), toolResult(`t${ids}`), narrate("While those wait, reading the loader."), rest(QUIET), wake("Background task finished"), rest(QUIET))
  assert.deepEqual(marked(msgs), ["Four calls are yours before the loader can take SQL Server."])
  // A needs_input or done fence the worker kept working past is a handoff too…
  const handed = project(human("Ship it."), narrate(NEEDS_INPUT), toolResult(`t${ids}`), rest(QUIET))
  assert.deepEqual(marked(handed), ["The fix is on acme/app#391 and CI is green; the merge is yours."])
  // …but a fence alone mid-turn, or the standing fence again, keeps nothing, as at a rest.
  const bareNeeds = fence("awaiting", "prs: [acme/app#391]\nstatus: needs_input\nfor: 180d")
  assert.deepEqual(marked(project(human("Ship it."), narrate(bareNeeds), toolResult(`t${ids}`), rest(QUIET))), [])
  assert.deepEqual(marked(project(human("Ship it."), rest(NEEDS_INPUT), wake("✅"), narrate(NEEDS_INPUT.split("\n\n")[1]), toolResult(`t${ids}`), rest(QUIET))), ["The fix is on acme/app#391 and CI is green; the merge is yours."])
  // A mid-turn sign-off sets the fence a rest repeating it leaves standing.
  const repeated = project(human("Ship it."), narrate(NEEDS_INPUT), toolResult(`t${ids}`), rest(NEEDS_INPUT.split("\n\n")[1]))
  assert.deepEqual(marked(repeated), ["The fix is on acme/app#391 and CI is green; the merge is yours."])
})

test("a `frizzctl done` quoted in a heredoc or in prose is no registration", () => {
  const notes = "cat >> notes.md <<'EOF'\n- signed off done (frizzctl done + fence)\n- servers stopped; frizzctl done recorded.\nEOF"
  const logged = project(human("Audit the drivers."), narrate("Now removing the upstream routes from the wiki.", notes), toolResult(`t${ids}`), rest(QUIET))
  assert.deepEqual(marked(logged), [])
  assert.deepEqual(marked(project(human("Go."), narrate("Done.", "git commit -m 'notes; frizzctl done recorded'"), toolResult(`t${ids}`), rest(QUIET))), [])
  // The real command, in every shape a worker writes it, still is.
  for (const command of ["frizzctl done --body-file - <<'EOF'\n- Fixed it.\nEOF", "cd /x && frizzctl done --title 'Fixed' --body-file body.md", "frizzctl done '{\"body\":\"- Fixed it.\"}'", "frizzctl done"]) {
    const run = project(human("Fix it."), narrate("The cache keys on the normalized id now; `npm test` is green.", command), toolResult(`t${ids}`), rest("The write-up is above."))
    assert.deepEqual(marked(run), ["The cache keys on the normalized id now; `npm test` is green.", "The write-up is above."], command)
  }
})
