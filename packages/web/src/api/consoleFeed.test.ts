import assert from "node:assert/strict"
import { test } from "node:test"
import type { BoardSnapshot, ThreadView } from "@frizz/shared"
import { dropProject, keyThread, mergeDelta, mergeKeyframe } from "./consoleFeed.ts"

const thread = (id: string, over: Partial<ThreadView> = {}): ThreadView => ({ id, title: id, dependsOn: [], ...over }) as ThreadView
const union = (): BoardSnapshot => ({ projectDir: "", projectName: "All projects", projectLabel: "All projects", threads: [], errors: [], warnings: [] })
const board = (threads: ThreadView[], over: Partial<BoardSnapshot> = {}): BoardSnapshot =>
  ({ projectDir: "/p", projectName: "p", threads, errors: [], warnings: [], ...over }) as BoardSnapshot

test("a thread joins the merged board under its key, and so do the threads it depends on", () => {
  const keyed = keyThread("nub", thread("fix-auth", { dependsOn: ["spike"] }))
  assert.equal(keyed.id, "nub~fix-auth")
  assert.deepEqual(keyed.dependsOn, ["nub~spike"])
})

test("one project's keyframe replaces that project's threads and no one else's", () => {
  const merged = union()
  mergeKeyframe(merged, "nub", board([thread("a"), thread("b")]))
  mergeKeyframe(merged, "frizz", board([thread("a")]))
  mergeKeyframe(merged, "nub", board([thread("c")]))
  assert.deepEqual(merged.threads.map((x) => x.id).sort(), ["frizz~a", "nub~c"])
})

test("the same slug in two projects is two threads", () => {
  const merged = union()
  mergeKeyframe(merged, "nub", board([thread("fix-auth", { title: "nub's" })]))
  mergeKeyframe(merged, "frizz", board([thread("fix-auth", { title: "frizz's" })]))
  assert.deepEqual(merged.threads.map((x) => [x.id, x.title]).sort(), [["frizz~fix-auth", "frizz's"], ["nub~fix-auth", "nub's"]])
})

test("a delta upserts and removes under its own project's keys", () => {
  const merged = union()
  mergeKeyframe(merged, "nub", board([thread("a"), thread("b")]))
  mergeKeyframe(merged, "frizz", board([thread("b")]))
  mergeDelta(merged, "nub", { type: "board-delta", seq: 2, upserts: [thread("a", { title: "renamed" }), thread("c")], removed: ["b"] } as never)
  assert.deepEqual(merged.threads.map((x) => [x.id, x.title]).sort(), [["frizz~b", "b"], ["nub~a", "renamed"], ["nub~c", "c"]])
})

test("a project that leaves the Console takes exactly its threads with it", () => {
  const merged = union()
  mergeKeyframe(merged, "nub", board([thread("a")]))
  mergeKeyframe(merged, "nub-tools", board([thread("a")]))
  dropProject(merged, "nub")
  assert.deepEqual(merged.threads.map((x) => x.id), ["nub-tools~a"])
})

test("a keyframe's board-level identity is not the merged board's", () => {
  const merged = union()
  mergeKeyframe(merged, "nub", board([], { projectName: "nub", projectSlug: "nub", homeDir: "/Users/x" }))
  assert.equal(merged.projectName, "All projects")
  assert.equal(merged.homeDir, "/Users/x", "the machine's home directory is the same whichever project says it")
})

// THE MERGED THREADS ARRAY IS A PLAIN VALUE (consoleFeed.ts, above mergeKeyframe), as a project page's is
// (store.plainThreads.test.ts): a change builds a new array and never writes the one a snapshot holds.

test("on the store, every change to the merged board replaces its threads array and never writes the old one", async () => {
  const { isPlainThreadArray, store } = await import("../store.ts")
  const { snapshot } = await import("valtio")
  store.board = union()
  const merged = store.board
  mergeKeyframe(merged, "nub", board([thread("a"), thread("b")]))
  mergeKeyframe(merged, "frizz", board([thread("a")]))
  const first = merged.threads
  assert.ok(isPlainThreadArray(first), "not a valtio proxy")
  assert.equal((snapshot(store).board as BoardSnapshot).threads, first, "a snapshot shares the array rather than copying it")
  mergeDelta(merged, "nub", { type: "board-delta", seq: 2, upserts: [thread("b", { title: "b2" })], removed: [] } as never)
  const second = merged.threads
  assert.ok(isPlainThreadArray(second))
  assert.notEqual(second, first, "a delta replaces the array")
  assert.equal(first.find((t) => t.id === "nub~b")!.title, "b", "and leaves the one an earlier snapshot holds as it was")
  assert.equal(second.find((t) => t.id === "nub~b")!.title, "b2")
  assert.equal(second.find((t) => t.id === "frizz~a"), first.find((t) => t.id === "frizz~a"), "a thread no delta named is the same object")
  mergeDelta(merged, "nub", { type: "board-delta", seq: 3, upserts: [], removed: [] } as never)
  assert.equal(merged.threads, second, "a delta with no threads in it leaves the array alone")
  dropProject(merged, "frizz")
  assert.ok(isPlainThreadArray(merged.threads))
  assert.deepEqual(second.map((t) => t.id), ["nub~a", "nub~b", "frizz~a"], "a drop copies too")
  assert.deepEqual(merged.threads.map((t) => t.id), ["nub~a", "nub~b"])
  store.board = null
})

test("the merged board after any run of keyframes, deltas and drops is the board a plain rebuild gives", () => {
  // The slot table rides from array to array (store.ts threadsWithDelta), and a keyframe or a drop
  // starts a new one. Every step is checked against a model that keeps each project's threads apart.
  let seed = 7
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed % n)
  const projects = ["nub", "frizz", "nub-tools"]
  const model = new Map<string, Map<string, string>>()
  const merged = union()
  for (let step = 0; step < 3000; step++) {
    const project = projects[rand(projects.length)]!
    const own = model.get(project) ?? new Map<string, string>()
    const r = rand(20)
    if (r === 0) {
      dropProject(merged, project)
      model.delete(project)
    } else if (r < 3 || !model.has(project)) {
      const threads = Array.from({ length: rand(8) }, (_, i) => thread(`t${i}`, { title: `k${step}` }))
      mergeKeyframe(merged, project, board(threads))
      model.set(project, new Map(threads.map((t) => [t.id, t.title])))
    } else {
      const upserts = Array.from({ length: rand(3) }, () => thread(`t${rand(10)}`, { title: `d${step}` }))
      const removed = Array.from({ length: rand(2) }, () => `t${rand(10)}`).filter((id) => !upserts.some((u) => u.id === id))
      mergeDelta(merged, project, { type: "board-delta", seq: step, upserts, removed } as never)
      for (const u of upserts) own.set(u.id, u.title)
      for (const id of removed) own.delete(id)
    }
    const want = [...model].flatMap(([p, threads]) => [...threads].map(([id, title]) => `${p}~${id}:${title}`)).sort()
    const got = merged.threads.map((t) => `${t.id}:${t.title}`)
    assert.equal(new Set(got).size, got.length, `no thread twice, step ${step}`)
    assert.deepEqual(got.sort(), want, `step ${step}`)
  }
})
