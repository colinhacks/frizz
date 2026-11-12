import { test } from "node:test"
import assert from "node:assert/strict"
import { signalFenceOf } from "./signal-fence.ts"

// Which fence a message signals with. The server's fold and the web's renderer both read this, so these
// shapes are where the two used to disagree (2026-11-11): the web drew a card for every one the server
// ignored, and the server read a fence the web knew to be quoted.
const kind = (text: string) => signalFenceOf(text)?.kind ?? "none"
const T4 = "`".repeat(4)

test("the last fence signals when it closes the message", () => {
  assert.equal(kind("Shipped.\n\n```done\n- Fixed it.\n```"), "done")
  assert.equal(kind("Shipped.\n\n```done\n- Fixed it.\n```\n\n   \n"), "done", "trailing whitespace")
  assert.equal(kind("```done\r\n- Fixed it.\r\n```\r\n"), "done", "CRLF")
  assert.equal(kind("```awaiting\nhold\n```\nlater\n```done\nfinished\n```"), "done", "the last of several")
})

test("prose after the last fence means it was explanatory", () => {
  assert.equal(kind("```done\n- Fixed it.\n```\n\nAnything else?"), "none")
  assert.equal(signalFenceOf("```done\n- Fixed it.\n```\n\nAnything else?"), undefined)
})

test("```question fences may follow it, and nothing else may", () => {
  const park = "```awaiting\nshells: [b1]\nstatus: working\nfor: 1h\n```"
  assert.equal(kind(`${park}\n\n\`\`\`question\nid: settings-store\n\`\`\`\n`), "awaiting", "a reference")
  assert.equal(kind(`${park}\n\n\`\`\`question\nid: a\n\`\`\`\n\n\`\`\`question\nid: b\n\`\`\``), "awaiting", "two")
  assert.equal(kind(`${park}\n\n\`\`\`question\nid: a\n\`\`\`\n\nOne more thing.`), "none", "prose after them")
  assert.equal(kind(`${park}\n\n\`\`\`bash\nls\n\`\`\``), "none", "a code block is not a question")
})

test("a fence quoted inside another code block is not a fence", () => {
  assert.equal(kind(`Write it like this:\n\n${T4}\n\`\`\`done\n- Landed the fix.\n\`\`\`\n${T4}`), "none")
  assert.equal(kind(`Write it like this:\n\n${T4}\n\`\`\`done\n- Landed.\n\`\`\`\n${T4}\n\n\`\`\`done\n- Real.\n\`\`\``), "done")
  // An unclosed code block earlier runs to the end of the message, the way a renderer draws it.
  assert.equal(kind("Here:\n\n```ts\nconst x = 1\n\n```awaiting\nsteps:\n  - Sign in\n```"), "none")
})

test("a code block that closes the fence early leaves no signal", () => {
  assert.equal(kind("```awaiting\nsteps:\n  - Paste the email below\n---\n```\nHi Ana,\n```\n\nThanks.\n```"), "none")
  // …and a fence opened with four backticks holds one.
  assert.equal(kind(`${T4}awaiting\nsteps:\n  - Paste the email below\n---\n\`\`\`\nHi Ana,\n\`\`\`\n${T4}`), "awaiting")
})
