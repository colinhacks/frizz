import { test } from "node:test"
import assert from "node:assert/strict"
import { showsPicture } from "./messagePictures.ts"

const say = (text: string, tools?: { sentImages?: string[] }[]) => ({ role: "assistant", text, tools })

test("a lightbox gallery, a bare image line and a Markdown image each show a picture", () => {
  assert.equal(showsPicture(say("The fix renders:\n\n```lightbox\n/abs/after.png  After the fix\n```\n\nNext I'll run the suite.")), true)
  assert.equal(showsPicture(say("Before:\n\n/Users/me/shots/before.png\n\nand after.")), true)
  assert.equal(showsPicture(say("Here it is: ![the rail](/abs/rail.png)")), true)
  assert.equal(showsPicture(say("A recording:\n\n~~~lightbox\n/abs/flow.webm\n~~~")), true)
})

test("a picture in a signal fence's body or a collapsed section still shows", () => {
  assert.equal(showsPicture(say("Landed.\n\n````done\n- **Fixed** the rail.\n\n```lightbox\n/abs/rail.png\n```\n````")), true)
  assert.equal(showsPicture(say("<details>\n<summary>Shots</summary>\n\n```lightbox\n/abs/a.png\n```\n\n</details>")), true)
})

test("a SendUserFile delivery carrying images shows a picture; one carrying only files does not", () => {
  assert.equal(showsPicture(say("", [{}, { sentImages: ["/abs/a.png"] }])), true)
  assert.equal(showsPicture(say("Sent.", [{ sentImages: [] }, {}])), false)
})

test("words about pictures, quoted fences and code spans show none", () => {
  assert.equal(showsPicture(say("Took a screenshot at /abs/shot.png and it looks right.")), false)
  assert.equal(showsPicture(say("The contract's sample:\n\n````md\n```lightbox\n/abs/a.png\n```\n````")), false)
  assert.equal(showsPicture(say("Write `![caption](/abs/shot.png)` to show one.")), false)
  assert.equal(showsPicture(say("```lightbox\n```")), false)
  assert.equal(showsPicture(say("```md\n![x](/abs/x.png)\n```")), false)
})

test("only an agent's own words count", () => {
  assert.equal(showsPicture({ role: "user", text: "![mine](/abs/mine.png)" }), false)
  assert.equal(showsPicture({ role: "assistant", kind: "event", text: "/abs/a.png" }), false)
})
