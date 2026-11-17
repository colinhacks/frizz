import { test } from "node:test"
import assert from "node:assert/strict"
import { SIGNOFF_NUDGE_MESSAGE } from "@frizz/shared"
import { latestSignOffs, restingDoneIndex, type SignOffMsgLike } from "./signOffs.ts"

const human = (text: string): SignOffMsgLike => ({ role: "user", text })
const wake = (text: string): SignOffMsgLike => ({ role: "user", text, wake: true })
const say = (text: string, signOff?: true): SignOffMsgLike => ({ role: "assistant", text, signOff })
const rest: SignOffMsgLike = { role: "assistant", text: "Agent rested" }
const nudge = wake(SIGNOFF_NUDGE_MESSAGE)

test("the newest sign-off after the human's turn, past the quiet rounds behind it", () => {
  const messages = [
    human("Fix it."), say("Reading."), say("Fixed on acme/app#391; the merge is yours.", true), rest,
    wake("New review"), say("```awaiting\nstatus: watching\n```"), rest,
    wake("CI passed"), say("```awaiting\nstatus: watching\n```"), rest,
  ]
  assert.deepEqual(latestSignOffs(messages, 0), [2])
  // Nothing at or before the human's turn counts: they have answered it.
  assert.deepEqual(latestSignOffs([say("Old hand-off.", true), rest, human("Now this."), say("Working.")], 2), [])
  assert.deepEqual(latestSignOffs([], 0), [])
})

test("a sign-off written in answer to frizz's reminder keeps the write-up it was about", () => {
  const messages = [human("Fix it."), say("The whole write-up.", true), rest, nudge, say("```done\n- Fixed.\n```", true), rest]
  assert.deepEqual(latestSignOffs(messages, 0), [1, 4])
  // Reminded twice: the chain reads back through both.
  const twice = [human("Fix it."), say("The whole write-up.", true), rest, nudge, say("See above.", true), rest, nudge, say("```done\n```", true), rest]
  assert.deepEqual(latestSignOffs(twice, 0), [1, 4, 7])
  // Any other wake breaks the chain, and so does a write-up the server did not mark (a quiet answer).
  assert.deepEqual(latestSignOffs([human("Go."), say("Earlier hand-off.", true), rest, wake("CI passed"), say("```done\n```", true), rest], 0), [4])
  assert.deepEqual(latestSignOffs([human("Go."), say("Status line."), rest, nudge, say("```done\n```", true), rest], 0), [4])
  // A send still queued is not what opened the run.
  assert.deepEqual(latestSignOffs([human("Go."), say("Write-up.", true), rest, nudge, say("```done\n```", true), { role: "user", text: "and also", queued: true }], 0), [1, 4])
})

// The reylo shape (2026-11-16): a done sign-off, then two rests on the same fence again, each woken by
// another thread's note. The server marks only the first (sign-offs.ts), so the fold keeps it in view.
const done = "```done\ntitle: Kyber built\n---\n- Landed on `next`.\n```"
const note = (text: string): SignOffMsgLike => ({ role: "user", text, peerFrom: "other-thread" } as SignOffMsgLike)

test("Mark as done rides on the done sign-off a later rest only repeated", () => {
  const messages = [human("Ship it."), say("Working."), say(done, true), rest, note("FYI"), say(done), rest, note("FYI again"), say(done), rest]
  assert.equal(restingDoneIndex(messages, 8, 0), 2)
  // An empty done fence after it leaves it standing the same way.
  assert.equal(restingDoneIndex([human("Ship it."), say(done, true), rest, wake("CI passed"), say("```done\n\n```"), rest], 4, 0), 1)
})

test("otherwise the verb stays on the last thing the agent said, or nowhere", () => {
  // A done rest the server marked is its own sign-off.
  assert.equal(restingDoneIndex([human("Go."), say("Earlier hand-off.", true), rest, wake("CI"), say(done, true), rest], 4, 0), 4)
  // An empty done after a sign-off of another kind: the done card is the last message's.
  assert.equal(restingDoneIndex([human("Go."), say("```awaiting\nstatus: needs_input\n---\nRead this.\n```", true), rest, wake("CI"), say("```done\n\n```"), rest], 4, 0), 4)
  // A thread that rests on anything but a done fence draws no verb on any done card.
  assert.equal(restingDoneIndex([human("Go."), say(done, true), rest, wake("CI"), say("```awaiting\nstatus: watching\nfor: 1d\n```"), rest], 4, 0), -1)
  assert.equal(restingDoneIndex([], -1, 0), -1)
  // A done sign-off from before the human's last turn is theirs answered, not one the thread stands on.
  assert.equal(restingDoneIndex([say(done, true), rest, human("One more thing."), say(done), rest], 3, 2), 3)
})
