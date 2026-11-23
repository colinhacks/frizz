import assert from "node:assert/strict"
import test from "node:test"
import type { RemoteSetupAnswer, RemoteSetupConfig, RemoteSetupContext, RemoteSetupEvent } from "../remote-setup-protocol.ts"
import { createRemoteSetupRoute, type RemoteSetupRouteOptions } from "./route.ts"

// The route between the shell and the server's R menu (route.ts): sessions, the effects the menu asks the
// shell for, and the wait a screen drawn later rides on. The menu itself is pane.test.ts's; the shell's
// end is src/remote-setup-client.test.ts's, which drives this same route.

delete process.env.FRIZZ_CUSTOM_NAMES

const plain = (screen: string) => screen.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")

function shell(options: RemoteSetupRouteOptions = {}) {
  const route = createRemoteSetupRoute({
    probes: { cloudflared: async () => ({ version: "2025.8.1" }), tailscale: async () => ({ installed: true, dnsName: "mac.ts.net" }) },
    githubLogin: () => null,
    ...options,
  })
  const context: RemoteSetupContext = { port: 9393, columns: 80, rows: 40, current: null, devices: [], sandbox: false }
  let session: string | undefined
  const send = async (event: RemoteSetupEvent) => {
    const { status, body } = await route.handle({ protocol: 1, ...(session ? { session } : {}), event, context })
    assert.equal(status, 200, JSON.stringify(body))
    const answer = body as RemoteSetupAnswer
    session = answer.session
    return answer
  }
  const keys = async (...pressed: string[]) => {
    let last!: RemoteSetupAnswer
    for (const key of pressed) last = await send({ type: "key", key })
    return last
  }
  return { route, context, send, keys, session: () => session }
}

test("a menu opens, moves, and closes on escape, after which its session is gone", async () => {
  const { route, send, keys, session } = shell()
  const opened = await send({ type: "open" })
  assert.match(plain(opened.screen), /❯ ✓ Off/)
  const moved = await keys("\x1b[B")
  assert.ok(moved.frame > opened.frame)
  assert.match(plain(moved.screen), /❯ {3}frizz\.sh subdomain/)
  const closed = await keys("\x1b")
  assert.equal(closed.close, true)
  assert.equal(route.size(), 0)
  const after = await route.handle({ protocol: 1, session: session(), event: { type: "key", key: "x" }, context: { port: 9393, columns: 80, rows: 40, current: null, devices: [], sandbox: false } })
  assert.deepEqual(after, { status: 404, body: { error: "unknown-session" } })
})

test("an origin typed into a form becomes an apply the shell runs, then a sign-in link the done screen draws", async () => {
  const { context, send, keys } = shell()
  await send({ type: "open" })
  await keys("6", "\r")
  const submitted = await keys(..."https://board.example.com/", "\r")
  assert.match(plain(submitted.screen), /serving board\.example\.com…/)
  assert.deepEqual(submitted.effect, { id: 1, kind: "apply", config: { hostname: "board.example.com", serve: "external", provider: "other" } })
  // Answered effects are not asked again, and the next one comes with the answer.
  context.current = { hostname: "board.example.com", serve: "external", provider: "other" }
  const applied = await send({ type: "effect", id: 1, ok: true })
  assert.deepEqual(applied.effect, { id: 2, kind: "issue-link" })
  const linked = await send({ type: "effect", id: 2, ok: true, value: { code: "c0de", url: "https://board.example.com/?frizz_code=c0de", expiresAt: Date.now() + 300_000 } })
  assert.equal(linked.effect, undefined)
  assert.match(plain(linked.screen), /Serving https:\/\/board\.example\.com \(your proxy\)\./)
  assert.match(plain(linked.screen), /frizz_code=c0de/)
  assert.equal((await keys("x")).close, true, "any key leaves the done screen")
})

test("an act the shell could not do is said on the menu, and a link that is not one is refused", async () => {
  const { send, keys } = shell()
  await send({ type: "open" })
  await keys("1")
  const off = await keys("\r")
  assert.deepEqual(off.effect, { id: 1, kind: "apply", config: null })
  const refused = await send({ type: "effect", id: 1, ok: false, error: "the disk is full" })
  assert.match(plain(refused.screen), /Could not apply that: the disk is full/)

  await keys("x", "6", "\r", ..."board.example.com", "\r")
  await send({ type: "effect", id: 2, ok: true })
  const nonsense = await send({ type: "effect", id: 3, ok: true, value: { url: 42 } })
  assert.match(plain(nonsense.screen), /something that is not a link/)
})

test("a screen drawn later reaches a waiting shell, and a wait with nothing new is answered with the same screen", async () => {
  let release!: (probe: { version: string }) => void
  const { send, keys } = shell({ probes: { cloudflared: () => new Promise((resolve) => (release = resolve)), tailscale: async () => ({ installed: false, dnsName: null }) }, waitMs: 50 })
  await send({ type: "open" })
  const form = await keys("4", "\r")
  assert.match(plain(form.screen), /cloudflared {3}checking…/)
  const idle = await send({ type: "wait", after: form.frame })
  assert.equal(idle.frame, form.frame, "nothing changed, and the wait came back after its time")
  const waiting = send({ type: "wait", after: form.frame })
  release({ version: "2025.8.1" })
  const probed = await waiting
  assert.ok(probed.frame > form.frame)
  assert.match(plain(probed.screen), /cloudflared {3}found, 2025\.8\.1 ✓/)
})

test("a name claimed afresh signs out what was signed in under it before it is served", async () => {
  const progress: string[] = []
  const claimed: RemoteSetupConfig = { hostname: "abcdefghjkmnpqrstuvw.frizz.sh", claim: "abcdefghjkmnpqrstuvw", serve: "relay" }
  const { send, keys } = shell({
    claim: async (name, port, say) => {
      progress.push(`${name}:${port}`)
      say("  claiming a frizz.sh subdomain — no account needed")
      return { config: claimed, fresh: true }
    },
  })
  await send({ type: "open" })
  await keys("2", "\r", "\r")
  const asked = await keys("\r")
  await new Promise((resolve) => setImmediate(resolve))
  const waited = asked.effect ? asked : await send({ type: "wait", after: asked.frame })
  assert.deepEqual(progress, [":9393"], "an empty name, with the board's port")
  assert.deepEqual(waited.effect, { id: 1, kind: "forget-sessions", hostname: claimed.hostname })
  const forgotten = await send({ type: "effect", id: 1, ok: true })
  assert.deepEqual(forgotten.effect, { id: 2, kind: "apply", config: { ...claimed, relayAccess: "full" }, justClaimed: true })
})

test("an open past the limit closes the oldest menu, and its waiting shell is told", async () => {
  const route = createRemoteSetupRoute({ probes: { cloudflared: async () => ({ version: null }), tailscale: async () => ({ installed: false, dnsName: null }) }, githubLogin: () => null, waitMs: 5_000 })
  const context: RemoteSetupContext = { port: 9393, columns: 80, rows: 40, current: null, devices: [], sandbox: false }
  const open = async () => (await route.handle({ protocol: 1, event: { type: "open" }, context })).body as RemoteSetupAnswer
  const first = await open()
  const waiting = route.handle({ protocol: 1, session: first.session, event: { type: "wait", after: first.frame }, context })
  for (let i = 0; i < 4; i += 1) await open()
  assert.equal(((await waiting).body as RemoteSetupAnswer).close, true)
  assert.equal(route.size(), 4)
  route.dispose()
  assert.equal(route.size(), 0)
})

test("what the shell sends is checked before anything reads it", async () => {
  const route = createRemoteSetupRoute()
  const context = { port: 9393, columns: 80, rows: 24, current: null, devices: [], sandbox: false }
  for (const body of [
    null,
    { protocol: 2, event: { type: "open" }, context },
    { protocol: 1, event: { type: "dance" }, context },
    { protocol: 1, event: { type: "key", key: "" }, context },
    { protocol: 1, event: { type: "open" }, context: { ...context, port: 0 } },
    { protocol: 1, event: { type: "open" }, context: { ...context, current: { tunnel: "no-hostname" } } },
    { protocol: 1, event: { type: "open" }, context: { ...context, devices: [{ id: 1 }] } },
  ]) {
    assert.equal((await route.handle(body)).status, 400, JSON.stringify(body))
  }
  assert.equal(route.size(), 0)
})
