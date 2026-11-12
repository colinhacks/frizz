import { test } from "node:test"
import assert from "node:assert/strict"
import { splitFenceBlocks } from "./fenceBlocks.ts"
import { restatedByRestingCard, restatesFence, type FenceLike } from "./restatedFences.ts"

const fence = (body: string) => `\`\`\`awaiting\n${body}\n\`\`\``
// The fence the resting card draws, parsed the way the transcript parses a message's.
const parsed = (body: string): FenceLike => {
  const seg = splitFenceBlocks(fence(body)).find((s) => s.kind === "fence")
  if (!seg || seg.kind !== "fence") throw new Error("no fence")
  return { body: seg.body, hints: seg.hints }
}
const STEPS = "title: Add Lubos's company in Justworks\nsteps:\n  - In Justworks, add Lubos Venntures Limited as an international contractor.\n\n    The values are in the offer letter.\n---\nJustworks emails Lubos for his payment details."
const human = (text: string) => ({ role: "user", text })
const wake = (text: string) => ({ role: "user", text, wake: true })
const say = (text: string) => ({ role: "assistant", text })

test("the resting card restates an earlier fence when it lists every one of that fence's steps", () => {
  assert.equal(restatesFence(parsed(STEPS), parsed(STEPS)), true)
  // The same steps under a new title and prose: the to-do list the earlier card showed is the same list.
  assert.equal(restatesFence(parsed(STEPS.replace("Add Lubos's company in Justworks", "Lubos is next")), parsed(STEPS)), true)
  // A step the resting card no longer lists keeps the earlier card: it is the only place that step is shown.
  assert.equal(restatesFence(parsed("steps:\n  - Something else entirely."), parsed(STEPS)), false)
  // A fence with no steps is restated only by the same title and prose.
  const needs = "title: Merge acme/app#391\nstatus: needs_input\nfor: 1h\n---\nCI is green."
  assert.equal(restatesFence(parsed(needs), parsed(needs)), true)
  assert.equal(restatesFence(parsed(needs.replace("CI is green.", "CI is green again.")), parsed(needs)), false)
  assert.equal(restatesFence(parsed(STEPS), parsed(needs)), false)
  // An empty fence says nothing a card would show.
  assert.equal(restatesFence(parsed("status: needs_input\nfor: 1h"), parsed("status: needs_input\nfor: 1h")), false)
})

test("the pullfrog-app shape: the write-up's card goes, since the resting card restates it", () => {
  const messages = [
    wake("Answers to earlier questions:\n1. `keep-justworks` → Stay on Justworks"),
    say(`Justworks stays.\n\n${fence(STEPS)}`),
    { role: "user", text: "Done, from the Tommy contract thread.", peerFrom: "tommy" },
    say(fence(STEPS)),
  ]
  assert.deepEqual([...restatedByRestingCard(messages, 3, parsed(STEPS))], [1])
  // No resting card, nothing restated.
  assert.deepEqual([...restatedByRestingCard(messages, 3, undefined)], [])
})

test("only since the human last came in", () => {
  const messages = [human("Set Lubos up."), say(`First try.\n\n${fence(STEPS)}`), human("That failed, try again."), say(`Second try.\n\n${fence(STEPS)}`), wake("✅"), say(fence(STEPS))]
  assert.deepEqual([...restatedByRestingCard(messages, 5, parsed(STEPS))], [3])
})

test("a message keeps its fences unless the resting card restates every one", () => {
  const two = `Two waits.\n\n${fence(STEPS)}\n\n${fence("title: Other\nsteps:\n  - Approve the deploy.")}`
  assert.deepEqual([...restatedByRestingCard([human("Go."), say(two), say(fence(STEPS))], 2, parsed(STEPS))], [])
})
