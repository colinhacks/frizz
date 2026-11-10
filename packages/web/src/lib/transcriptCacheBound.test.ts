import { test, type TestContext } from "node:test"
import assert from "node:assert/strict"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import { boundTranscriptCache } from "./transcriptCacheBound.ts"

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

// A client the test lets go of when it ends. Each transcript left in a cache holds its half-hour
// garbage-collection timer, and eleven of them kept this file's process alive after its tests had
// finished (run-tests.mjs fails a file that does not exit).
function newClient(t: TestContext): QueryClient {
  const client = new QueryClient()
  t.after(() => client.clear())
  return client
}

// A surface showing a thread: an observer on its transcript, as useTranscript holds one, with the same
// half-hour gcTime. Returns the unmount.
async function show(client: QueryClient, slug: string): Promise<() => void> {
  const observer = new QueryObserver(client, { queryKey: ["transcript", slug], queryFn: async () => ({ messages: [{ text: slug }] }), gcTime: 30 * 60_000 })
  const unsubscribe = observer.subscribe(() => {})
  await settle()
  return unsubscribe
}

const cachedTranscripts = (client: QueryClient) =>
  client.getQueryCache().getAll().filter((q) => q.queryKey[0] === "transcript").map((q) => q.queryKey[1] as string)

test("walking past more threads than the bound keeps only the most recently seen ones", async (t) => {
  const client = newClient(t)
  boundTranscriptCache(client, 3)
  for (const slug of ["a", "b", "c", "d", "e"]) (await show(client, slug))()
  await settle()
  assert.deepEqual(cachedTranscripts(client).sort(), ["c", "d", "e"])
})

test("a transcript on screen is never removed, however long ago it opened", async (t) => {
  const client = newClient(t)
  boundTranscriptCache(client, 2)
  const stillShown = await show(client, "pinned")
  for (const slug of ["a", "b", "c", "d"]) (await show(client, slug))()
  await settle()
  assert.deepEqual(cachedTranscripts(client).sort(), ["c", "d", "pinned"])
  stillShown()
})

test("revisiting a thread makes it the most recent again", async (t) => {
  const client = newClient(t)
  boundTranscriptCache(client, 2)
  for (const slug of ["a", "b"]) (await show(client, slug))()
  ;(await show(client, "a"))()
  ;(await show(client, "c"))()
  await settle()
  assert.deepEqual(cachedTranscripts(client).sort(), ["a", "c"])
})

test("other queries are not counted or removed", async (t) => {
  const client = newClient(t)
  boundTranscriptCache(client, 1)
  for (const key of ["x", "y", "z"]) {
    const observer = new QueryObserver(client, { queryKey: ["settledQuestions", key], queryFn: async () => [], gcTime: 30 * 60_000 })
    observer.subscribe(() => {})()
  }
  for (const slug of ["a", "b"]) (await show(client, slug))()
  await settle()
  assert.equal(client.getQueryCache().getAll().filter((q) => q.queryKey[0] === "settledQuestions").length, 3)
  assert.deepEqual(cachedTranscripts(client), ["b"])
})
