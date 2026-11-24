import assert from "node:assert/strict"
import { test } from "node:test"
import { store } from "../store.ts"
import { settleCompletion } from "./completionPins.ts"

// Read through a function: an assertion on `store.toast?.text` narrows it, and the toast changes under it.
const toastText = (): string | undefined => store.toast?.text

// The desktop's Done asks whether to unpin a pinned thread and passes the answer: yes lifts the pin from
// each shelf the thread was on — and only those — and no keeps it with nothing more to offer. A surface
// that did not ask (the phone's swipe) keeps the pin and offers "Unpin" in the toast. An unpinned
// thread's toast is the plain one whatever was passed.

test("an unpinned thread's completion toast has no action", () => {
  settleCompletion("Done", { id: "loose", sessionId: "sid" })
  assert.equal(store.toast?.text, "Done")
  assert.equal(store.toast?.action, undefined)
})

test("a pinned thread nobody asked about keeps its pin, and its toast's Unpin unpins each shelf it was on", async () => {
  const calls: { name: string; body: unknown }[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ name: String(url).split("/rpc/")[1] ?? String(url), body: JSON.parse(String(init?.body ?? "null")) })
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }) as typeof fetch
  try {
    settleCompletion("Done", { id: "both", sessionId: "sid-both", pinnedAt: "2026-10-01T09:00:00.000Z", consolePinnedAt: "2026-10-02T09:00:00.000Z" })
    assert.equal(store.toast?.text, "Done")
    assert.equal(store.toast?.action?.label, "Unpin")
    store.toast?.action?.run()
    for (let i = 0; i < 50 && toastText() !== "Unpinned"; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(store.toast?.text, "Unpinned")
    assert.deepEqual(calls, [
      { name: "setThreadPinned", body: { slug: "both", sessionId: "sid-both", pinned: false } },
      { name: "setThreadConsolePinned", body: { slug: "both", sessionId: "sid-both", pinned: false } },
    ])

    calls.length = 0
    settleCompletion("Marked as done", { id: "console-only", sessionId: "sid-c", consolePinnedAt: "2026-10-02T09:00:00.000Z" })
    store.toast?.action?.run()
    for (let i = 0; i < 50 && toastText() !== "Unpinned"; i++) await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(calls.map((c) => c.name), ["setThreadConsolePinned"], "a shelf the thread was not on is left alone")
  } finally {
    globalThis.fetch = previousFetch
  }
})

test("answered Unpin, a pinned thread's completion lifts each pin it had and says so; answered Keep, it writes nothing", async () => {
  const calls: string[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url).split("/rpc/")[1] ?? String(url))
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }) as typeof fetch
  try {
    settleCompletion("Done", { id: "pinned", sessionId: "sid-p", pinnedAt: "2026-10-01T09:00:00.000Z" }, true)
    for (let i = 0; i < 50 && toastText() !== "Done · unpinned"; i++) await new Promise((r) => setTimeout(r, 10))
    assert.equal(store.toast?.text, "Done · unpinned")
    assert.equal(store.toast?.action, undefined, "nothing left to offer")
    assert.deepEqual(calls, ["setThreadPinned"], "only the shelf it was on")

    calls.length = 0
    settleCompletion("Done", { id: "kept", sessionId: "sid-k", pinnedAt: "2026-10-01T09:00:00.000Z" }, false)
    assert.equal(store.toast?.text, "Done")
    assert.equal(store.toast?.action, undefined, "the operator just chose to keep it, so Unpin is not offered again")
    assert.deepEqual(calls, [], "keeping the pin writes nothing")

    settleCompletion("Done", { id: "loose", sessionId: "sid" }, true)
    assert.equal(store.toast?.text, "Done")
    assert.deepEqual(calls, [], "an unpinned thread writes nothing more")
  } finally {
    globalThis.fetch = previousFetch
  }
})
