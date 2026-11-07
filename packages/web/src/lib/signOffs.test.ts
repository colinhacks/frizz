import { test } from "node:test"
import assert from "node:assert/strict"
import { SIGNOFF_NUDGE_MESSAGE } from "@frizz/shared"
import { latestSignOffs, type SignOffMsgLike } from "./signOffs.ts"

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
