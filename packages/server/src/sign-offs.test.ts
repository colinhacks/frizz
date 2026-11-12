// WHICH MESSAGES A THREAD SIGNED OFF ON (sign-offs.ts → TranscriptMessage.signOff), driven through the real
// Claude projection so the `rest` dividers, wake flags and coalesced tool calls are the ones a page carries.
import { test } from "node:test"
import assert from "node:assert/strict"
import { BURIED_ANSWERS_HEADER, SIGNOFF_NUDGE_MESSAGE, wakeDeliveryToken, type TranscriptMessage } from "@frizz/shared"
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

test("a `frizzctl done` signs its turn off, though a pointer follows it", () => {
  const msgs = project(
    human("Write the report."),
    narrate("The report is written to `report.md`: three findings, all fixed.", "frizzctl done --body-file - <<'EOF'\n- Wrote the report.\nEOF"),
    toolResult(`t${ids}`),
    rest("The write-up is in the message above."),
  )
  assert.deepEqual(marked(msgs), ["The write-up is in the message above."])
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
