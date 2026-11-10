import assert from "node:assert/strict"
import { test } from "node:test"
import { sameEntries, sameItems, sameWhileEqual, shareLists, shareMap } from "./sameWhileEqual.ts"

test("an equal value keeps the object it had, and a different one replaces it", () => {
  const before = new Map([["q1", 3]])
  // What a memo over the messages hands back on a push that moved nothing: a new map, the same content.
  assert.equal(sameWhileEqual(before, new Map([["q1", 3]]), sameEntries), before)
  const moved = new Map([["q1", 4]])
  assert.equal(sameWhileEqual(before, moved, sameEntries), moved)
  // The common case on a thread with no questions: empty before, empty after.
  const none = new Map<string, number>()
  assert.equal(sameWhileEqual(none, new Map<string, number>(), sameEntries), none)
})

test("two maps are the same only with the same keys holding the identical values", () => {
  assert.equal(sameEntries(new Map([["a", 1], ["b", 2]]), new Map([["b", 2], ["a", 1]])), true)
  assert.equal(sameEntries(new Map([["a", 1]]), new Map([["a", 1], ["b", 2]])), false)
  assert.equal(sameEntries(new Map([["a", 1]]), new Map([["b", 1]])), false)
  // A key held as undefined is not a missing key.
  assert.equal(sameEntries(new Map([["a", undefined]]), new Map([["b", undefined]])), false)
})

test("two lists are the same only with the identical items in the same order", () => {
  const row = { id: "q1" }
  const other = { id: "q2" }
  assert.equal(sameItems([row, other], [row, other]), true)
  assert.equal(sameItems([row, other], [other, row]), false)
  assert.equal(sameItems([row], [row, other]), false)
  // A row rebuilt with the same content is a different row: the message drawing it has to render.
  assert.equal(sameItems([row], [{ id: "q1" }]), false)
  assert.equal(sameItems([], []), true)
  // No list at all (a thread that speaks the older fence) is its own state.
  assert.equal(sameItems(undefined, undefined), true)
  assert.equal(sameItems(undefined, []), false)
})

test("a map of lists keeps each key's list while its items are the same, and itself while every key did", () => {
  const q1 = { id: "q1" }
  const q2 = { id: "q2" }
  const before = new Map([[3, [q1]], [7, [q1, q2]]])
  // A push that moved nothing: the same rows, in new lists, in a new map.
  assert.equal(shareLists(before, new Map([[3, [q1]], [7, [q1, q2]]])), before)

  // One message's list moved: that key gets the new list, and the other keeps the list it had.
  const next = new Map([[3, [q1]], [7, [q2]]])
  const shared = shareLists(before, next)
  assert.notEqual(shared, before)
  assert.equal(shared.get(3), before.get(3), "the message nothing happened to is handed the list it already had")
  assert.equal(shared.get(7), next.get(7))

  // A key that went away, and one that arrived, are both a move.
  assert.deepEqual([...shareLists(before, new Map([[3, [q1]]])).keys()], [3])
  assert.deepEqual([...shareLists(before, new Map([[3, [q1]], [7, [q1, q2]], [9, [q2]]])).keys()], [3, 7, 9])
})

test("a map shares by whatever its values are compared with", () => {
  const sameSet = (a: ReadonlySet<string>, b: ReadonlySet<string>) => a.size === b.size && [...a].every((x) => b.has(x))
  const before = new Map([[1, new Set(["a", "b"])]])
  assert.equal(shareMap(before, new Map([[1, new Set(["b", "a"])]]), sameSet), before)
  const moved = shareMap(before, new Map([[1, new Set(["a"])]]), sameSet)
  assert.deepEqual([...moved.get(1)!], ["a"])
  // An empty map before and after, the common case, is the one object.
  const none = new Map<number, ReadonlySet<string>>()
  assert.equal(shareMap(none, new Map<number, ReadonlySet<string>>(), sameSet), none)
})
