import { test } from "node:test"
import assert from "node:assert/strict"
import { queryPriority, assertMutationAllowedDuringControlPlaneTransition, CONTROL_PLANE_RESTARTING_MESSAGE, isKeptDeliveryError, isRetryableRpcError, parseRpcResponse, routeCall } from "./rpc.ts"
import { store } from "../store.ts"

test("RPC response: a stale server's plain-text missing route asks for a server restart", async () => {
  await assert.rejects(
    parseRpcResponse(new Response("404 Not Found", { status: 404 }), "setThreadPermission"),
    /Frizz server restart required/,
  )
})

test("RPC priority: a card's own reads yield to the board and the project poll", () => {
  for (const name of ["threadTranscript", "threadSettledQuestions", "threadProfileOptions", "mcpStatus", "resolveLocalPaths", "githubRefPreview"]) {
    assert.equal(queryPriority(name), "low", name)
  }
  for (const name of ["boardState", "projectsRailCounts", "projectsList"]) assert.equal(queryPriority(name), "auto", name)
})

test("RPC transition guard holds writes locally while preserving query access", () => {
  const previous = store.controlPlaneState
  try {
    store.controlPlaneState = "restarting"
    assert.throws(
      () => assertMutationAllowedDuringControlPlaneTransition("mutation"),
      new RegExp(CONTROL_PLANE_RESTARTING_MESSAGE),
    )
    assert.doesNotThrow(() => assertMutationAllowedDuringControlPlaneTransition("query"))
  } finally {
    store.controlPlaneState = previous
  }
})

test("RPC response: valid server errors and successful envelopes keep their normal semantics", async () => {
  await assert.rejects(
    parseRpcResponse(new Response(JSON.stringify({ error: "specific failure" }), { status: 500 }), "x"),
    /specific failure/,
  )
  assert.deepEqual(
    await parseRpcResponse(new Response(JSON.stringify({ result: { effect: "next-resume" } }), { status: 200 }), "x"),
    { effect: "next-resume" },
  )
})

// `kept`: the server holds a failed follow-up as a failed bubble (server/src/router.ts
// keepFailedFollowUp). It rides beside `retryable`, and neither implies the other.
test("a kept follow-up failure is readable on the thrown error", async () => {
  const kept = await parseRpcResponse(new Response(JSON.stringify({ error: "cold resume failed", kept: true }), { status: 500 }), "followUp").then(() => null, (e: unknown) => e)
  assert.equal(isKeptDeliveryError(kept), true)
  assert.equal(isRetryableRpcError(kept), false)
  assert.equal((kept as Error).message, "cold resume failed")
  const plain = await parseRpcResponse(new Response(JSON.stringify({ error: "stale tab" }), { status: 500 }), "followUp").then(() => null, (e: unknown) => e)
  assert.equal(isKeptDeliveryError(plain), false)
})

// ── THE CONSOLE'S ROUTING (routeCall) ─────────────────────────────────────────────────────────────
// The Console names no project, so every call must carry one: a thread procedure by its key, a project
// procedure through rpcFor. The negative cases are the point — on the Console a forgotten project used
// to mean the LAUNCHING project's `/_frizz`, which reads and writes a stranger's state and looks fine.

test("a thread key routes to its project with the real slug, from any page", () => {
  for (const page of ["/console", "/console/thread/nub~fix", "/project/frizz", "/"]) {
    assert.deepEqual(routeCall("threadTranscript", { slug: "nub~fix-auth", limit: 5 }, undefined, page), {
      base: "/_frizz/nub",
      input: { slug: "fix-auth", limit: 5 },
      project: "nub",
    }, page)
  }
})

test("a project procedure goes to the project rpcFor names", () => {
  assert.deepEqual(routeCall("dispatch", { prompt: "x" }, "reylo", "/console"), { base: "/_frizz/reylo", input: { prompt: "x" }, project: "reylo" })
  // A bare slug riding WITH a named project is that project's slug.
  assert.deepEqual(routeCall("dispatch", { prompt: "x", slug: "fix" }, "reylo", "/console"), { base: "/_frizz/reylo", input: { prompt: "x", slug: "fix" }, project: "reylo" })
  assert.throws(() => routeCall("followUp", { slug: "nub~fix" }, "reylo", "/console"), /not a thread of reylo/)
})

test("on the Console, a call that names no project is refused rather than sent to the launching project", () => {
  assert.throws(() => routeCall("threadTranscript", { slug: "fix-auth" }, undefined, "/console"), /names no project/)
  assert.throws(() => routeCall("dispatch", { prompt: "x" }, undefined, "/console"), /needs a project on the Console/)
  assert.throws(() => routeCall("localFile", { path: "/a" }, undefined, "/console/thread/nub~x"), /needs a project/)
})

test("machine-wide calls and project pages are unchanged", () => {
  assert.deepEqual(routeCall("projectsList", undefined, undefined, "/console"), { base: "/_frizz", input: undefined })
  // threadLocate searches every project for a REAL slug — machine-wide by design.
  assert.deepEqual(routeCall("threadLocate", { slug: "fix" }, undefined, "/console"), { base: "/_frizz", input: { slug: "fix" } })
  assert.deepEqual(routeCall("threadTranscript", { slug: "fix" }, undefined, "/project/nub/thread/fix"), { base: "/_frizz/nub", input: { slug: "fix" } })
  assert.deepEqual(routeCall("dispatch", { prompt: "x" }, undefined, "/"), { base: "/_frizz", input: { prompt: "x" } })
})

// ── THE CONSOLE'S RE-KEYING IS DECIDED WHEN THE CALL IS SENT ──────────────────────────────────────
// A dispatch can take seconds to answer (the server waits out session start), and the operator can
// leave the Console meanwhile. The answer's slug still names a thread in the project the call went to,
// so it must come back keyed: a bare `fix-auth` handed to the toast's "Open thread" on another project's
// page opens THAT project's same-named thread.
test("a Console call answered after the page left the Console still comes back keyed", async () => {
  const previousLocation = Object.getOwnPropertyDescriptor(globalThis, "location")
  const previousFetch = globalThis.fetch
  const page = { pathname: "/console", origin: "http://frizz.test" }
  Object.defineProperty(globalThis, "location", { configurable: true, writable: true, value: page })
  const sent: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    sent.push(String(url))
    // The operator moves to another project's board while the server is still answering.
    page.pathname = "/project/docs-site"
    return new Response(JSON.stringify({ result: { slug: "fix-auth", sessionId: "s" } }), { status: 200 })
  }) as typeof fetch
  try {
    const { rpcFor } = await import("./rpc.ts")
    const res = await rpcFor("billing").dispatch({ prompt: "x" } as never)
    assert.deepEqual(sent, ["/_frizz/billing/rpc/dispatch"])
    assert.equal(res.slug, "billing~fix-auth")
    // The negative control: the same call made from a project's page is that page's, and stays bare.
    page.pathname = "/project/billing"
    const own = await rpcFor("billing").dispatch({ prompt: "x" } as never)
    assert.equal(own.slug, "fix-auth")
  } finally {
    globalThis.fetch = previousFetch
    if (previousLocation) Object.defineProperty(globalThis, "location", previousLocation)
    else Reflect.deleteProperty(globalThis, "location")
  }
})
