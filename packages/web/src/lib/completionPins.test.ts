import assert from "node:assert/strict"
import { test } from "node:test"
import { store } from "../store.ts"
import { showCompletionToast } from "./completionPins.ts"

// Read through a function: an assertion on `store.toast?.text` narrows it, and the toast changes under it.
const toastText = (): string | undefined => store.toast?.text

// Mark as done KEEPS the pin; a pinned thread's completion toast offers "Unpin", which lifts the pin
// from each shelf the thread was on — and only those — while an unpinned thread's toast is the plain one.

test("an unpinned thread's completion toast has no action", () => {
  showCompletionToast("Done", { id: "loose", sessionId: "sid" })
  assert.equal(store.toast?.text, "Done")
  assert.equal(store.toast?.action, undefined)
})

test("a pinned thread's completion toast offers Unpin, which unpins each shelf it was on", async () => {
  const calls: { name: string; body: unknown }[] = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ name: String(url).split("/rpc/")[1] ?? String(url), body: JSON.parse(String(init?.body ?? "null")) })
    return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  }) as typeof fetch
  try {
    showCompletionToast("Done", { id: "both", sessionId: "sid-both", pinnedAt: "2026-10-01T09:00:00.000Z", consolePinnedAt: "2026-10-02T09:00:00.000Z" })
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
    showCompletionToast("Marked as done", { id: "console-only", sessionId: "sid-c", consolePinnedAt: "2026-10-02T09:00:00.000Z" })
    store.toast?.action?.run()
    for (let i = 0; i < 50 && toastText() !== "Unpinned"; i++) await new Promise((r) => setTimeout(r, 10))
    assert.deepEqual(calls.map((c) => c.name), ["setThreadConsolePinned"], "a shelf the thread was not on is left alone")
  } finally {
    globalThis.fetch = previousFetch
  }
})
