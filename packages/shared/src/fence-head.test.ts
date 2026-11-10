import { test } from "node:test"
import assert from "node:assert/strict"
import { doneFenceBodyHead, elideArchivedDoneFence } from "./fence-head.ts"

test("the head runs through the first line of content after the block markers", () => {
  assert.equal(doneFenceBodyHead("Shipped.\n\n- one"), "Shipped.\n\n-")
  assert.equal(doneFenceBodyHead("  \n## Landed\nmore"), "## Landed\nm")
  // Markers can span blank lines; the head keeps them and the line after.
  assert.equal(doneFenceBodyHead("```\n\n> Fixed it\nrest"), "```\n\n> Fixed it\nr")
  assert.equal(doneFenceBodyHead("one line"), "one line")
  assert.equal(doneFenceBodyHead(""), "")
})

test("only a done fence whose body is longer than its head is cut, and it says how long the body was", () => {
  const done = { kind: "done" as const, body: "Shipped.\n\n- one\n- two", hints: [{ kind: "title" as const, value: "T" }], registered: true as const }
  const cut = elideArchivedDoneFence(done)
  assert.deepEqual(cut, { ...done, body: "Shipped.\n\n-", bodyElided: done.body.length })
  assert.equal(elideArchivedDoneFence(cut), cut, "a cut fence is not cut again")
  const short = { kind: "done" as const, body: "Shipped.\n\n-", hints: [] }
  assert.equal(elideArchivedDoneFence(short), short)
  const awaiting = { kind: "awaiting" as const, body: "Waiting.\n\nOn CI.", hints: [] }
  assert.equal(elideArchivedDoneFence(awaiting), awaiting)
  assert.equal(elideArchivedDoneFence(undefined), undefined)
})
