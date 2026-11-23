import { test } from "node:test"
import assert from "node:assert/strict"
import { acceptSlashToken, slashTokenAt } from "./slashToken.ts"

test("a `/` at the start of the draft, or after whitespace, opens a token at the caret", () => {
  assert.deepEqual(slashTokenAt("/", 1), { start: 0, end: 1, query: "" })
  assert.deepEqual(slashTokenAt("/rev", 4), { start: 0, end: 4, query: "rev" })
  assert.deepEqual(slashTokenAt("please run /rev", 15), { start: 11, end: 15, query: "rev" })
  assert.deepEqual(slashTokenAt("first line\n/rev", 15), { start: 11, end: 15, query: "rev" })
  // A caret inside the name filters on what precedes it and replaces the whole name.
  assert.deepEqual(slashTokenAt("run /review now", 8), { start: 4, end: 11, query: "rev" })
  assert.deepEqual(slashTokenAt("/frizz:gh", 9), { start: 0, end: 9, query: "frizz:gh" })
})

test("a `/` inside a word, a path, or a caret that has left the token opens nothing", () => {
  assert.equal(slashTokenAt("src/foo", 7), null)
  assert.equal(slashTokenAt("and/or", 6), null)
  assert.equal(slashTokenAt("/Users/colin", 12), null)
  assert.equal(slashTokenAt("/review now", 11), null, "arguments have begun")
  assert.equal(slashTokenAt("/review ", 8), null)
  assert.equal(slashTokenAt("/review", 0), null, "the caret sits before the `/`")
  assert.equal(slashTokenAt("", 0), null)
  assert.equal(slashTokenAt("plain text", 10), null)
})

test("accepting replaces the token and leaves the caret one space past the name", () => {
  assert.deepEqual(acceptSlashToken("/rev", { start: 0, end: 4, query: "rev" }, "review-local"), { text: "/review-local ", caret: 14 })
  assert.deepEqual(
    acceptSlashToken("please run /rev", { start: 11, end: 15, query: "rev" }, "review-local"),
    { text: "please run /review-local ", caret: 25 },
  )
  // Text after the token keeps its own whitespace; no second space is typed.
  assert.deepEqual(
    acceptSlashToken("run /rev now", { start: 4, end: 8, query: "rev" }, "review-local"),
    { text: "run /review-local now", caret: 18 },
  )
  // A newline is not a space to reuse: the caret would land on the next line.
  assert.deepEqual(
    acceptSlashToken("run /revi\nnext", { start: 4, end: 9, query: "rev" }, "review-local"),
    { text: "run /review-local \nnext", caret: 18 },
  )
})
