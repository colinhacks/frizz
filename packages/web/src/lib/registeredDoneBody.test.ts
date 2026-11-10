import { test } from "node:test"
import assert from "node:assert/strict"
import { elideArchivedDoneFence } from "@frizz/shared"
import { isWholeOf, needsRegisteredDoneBody, registeredDoneKey } from "./registeredDoneBody.ts"

const LEDGER = "**Fixed** the cache.\n\n- one\n- two"

test("only a registered done the board cut is read per thread", () => {
  assert.equal(needsRegisteredDoneBody(elideArchivedDoneFence({ kind: "done", body: LEDGER, hints: [], registered: true })), true)
  assert.equal(needsRegisteredDoneBody({ kind: "done", body: LEDGER, hints: [], registered: true }), false, "whole already")
  assert.equal(needsRegisteredDoneBody(elideArchivedDoneFence({ kind: "done", body: LEDGER, hints: [] })), false, "a fenced done is drawn from its message")
  assert.equal(needsRegisteredDoneBody(undefined), false)
})

test("a body the surface saw whole stands in for the read only when it is the one the board cut", () => {
  const cut = elideArchivedDoneFence({ kind: "done" as const, body: LEDGER, hints: [], registered: true as const })
  assert.equal(isWholeOf(LEDGER, cut), true)
  assert.equal(isWholeOf(LEDGER + "\n- three", cut), false, "a longer body is a later completion")
  assert.equal(isWholeOf("**Fixed** the resolver.\n\n- one\n- two", cut), false, "another head")
  assert.equal(isWholeOf(undefined, cut), false)
})

test("the cache key names the cut it is for, so a new completion is a new read", () => {
  const a = elideArchivedDoneFence({ kind: "done" as const, body: LEDGER, hints: [], registered: true as const })
  const b = elideArchivedDoneFence({ kind: "done" as const, body: LEDGER + "\n- three", hints: [], registered: true as const })
  assert.notDeepEqual(registeredDoneKey("p:t", a), registeredDoneKey("p:t", b))
})
