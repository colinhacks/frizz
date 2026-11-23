import assert from "node:assert/strict"
import { once } from "node:events"
import { createServer, type Server } from "node:http"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { claimFrizzName, claimIdentityPath } from "./claim.ts"
import { createRemoteSetupPane } from "./pane.ts"
import { type CloudConfig, CUSTOM_NAMES_OFFERED, CUSTOM_NAMES_PAUSED, customNamesOffered } from "./setup.ts"

/**
 * Custom frizz.sh names WITHDRAWN, on the server's R menu: src/custom-names-paused.test.ts pins the same for
 * the shell's frozen copy. `FRIZZ_CUSTOM_NAMES=0` holds for this file's whole process, which runs alone.
 */
for (const name of ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"]) delete process.env[name]
process.env.FRIZZ_CUSTOM_NAMES = "0"

const CLEAR = "\x1b[2J\x1b[H"

function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function buildPane(initial: CloudConfig | null) {
  const chunks: string[] = []
  let current = initial
  const applied: Array<CloudConfig | null> = []
  const pane = createRemoteSetupPane({
    context: () => ({ port: 9393, columns: 80, rows: 1000, current, devices: [], sandbox: false }),
    act: {
      apply: async (next) => { applied.push(next); current = next },
      setRelayAccess: async (relayAccess) => { current = { ...current!, relayAccess } },
      issueLink: async () => (current ? { code: "c0de", url: `https://${current.hostname}/?frizz_code=c0de`, expiresAt: Date.now() + 300_000 } : null),
      signOut: async () => false,
      signOutAll: async () => 0,
    },
    claim: async () => { throw new Error("nothing may be claimed here") },
    probes: {
      cloudflared: async () => ({ version: "2025.8.1" }),
      tailscale: async () => ({ installed: true, dnsName: "mac-mini.corgi-alpha.ts.net" }),
    },
    draw: (screen) => { chunks.push(CLEAR + screen) },
  })
  return { pane, out: { text: () => chunks.join("") }, applied }
}

/** The menu rows of the last paint, without escape codes. */
function menuRows(text: string): string[] {
  const screen = text.split(CLEAR).pop()!.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
  return screen.split("\n").filter((row) => /^ {2}[❯ ] [✓ ] \S/.test(row))
}

test("the switch is the environment's, and a word is refused before a key is minted or the registrar hears anything", async (t) => {
  assert.equal(CUSTOM_NAMES_OFFERED, true, "they ship offered; this file withdraws them")
  assert.equal(customNamesOffered(), false)
  const home = mkdtempSync(join(tmpdir(), "frizz-remote-setup-paused-"))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  let heard = 0
  const server: Server = createServer((_req, res) => { heard += 1; res.writeHead(500); res.end() })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  t.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  await assert.rejects(claimFrizzName("colin", 9393, { home, origin }), (error: Error) => error.message === CUSTOM_NAMES_PAUSED)
  assert.equal(heard, 0)
  assert.equal(existsSync(claimIdentityPath(home)), false, "no claim key was minted")
})

test("while custom names are paused, the R menu does not offer one, and every number still lands", async () => {
  const { pane, out, applied } = buildPane(null)
  pane.open()
  assert.doesNotMatch(out.text(), /Custom subdomain/)
  assert.doesNotMatch(out.text(), /GitHub/, "no row mentions a GitHub account")
  const rows = menuRows(out.text())
  assert.deepEqual(
    rows.map((row) => row.slice(6, 26).trim()),
    ["Off", "frizz.sh subdomain", "Cloudflare Tunnel", "Tailscale", "Something else"],
  )
  assert.match(rows[0]!, /^ {2}❯ ✓ Off/, "Off is first and current, and the cursor is on it")
  // A number past the end is ignored rather than selecting a row that is not there.
  pane.key("5")
  pane.key("6")
  assert.match(menuRows(out.text())[4]!, /^ {2}❯ {3}Something else/)
  pane.key("1")
  pane.key("\r")
  await settle()
  assert.deepEqual(applied, [null], "1 is Off, with or without the custom row")
})

test("while custom names are paused, a board already on a custom name shows it, and choosing it renews without a claim", async () => {
  // The claim fake throws, so reaching it would fail the test: serving the saved name again goes
  // through apply, whose renewal is the keypair-only call every launch makes.
  const saved: CloudConfig = { hostname: "colin.frizz.sh", claim: "colin", serve: "relay" }
  const { pane, out, applied } = buildPane(saved)
  pane.open()
  const rows = menuRows(out.text())
  assert.equal(rows.length, 7, "the custom row stays while it is the current setup, and what a device may do is the last")
  assert.match(rows[6]!, /^ {6}Signed-in devices\s+Full control/)
  assert.match(rows[2]!, /^ {2}❯ ✓ Custom subdomain\s+colin\.frizz\.sh — kept and renewed;/)
  // The blurb wraps at 80 columns, its continuation hanging under the blurb column.
  const screen = out.text().split("\x1b[2J\x1b[H").pop()!.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
  assert.match(screen, /kept and renewed; new custom\n {26}subdomains are paused\n/)
  assert.doesNotMatch(out.text(), /needs a GitHub account/)
  pane.key("\r")
  await settle()
  assert.deepEqual(applied, [saved], "the saved claim is applied as it is")
  assert.doesNotMatch(out.text(), /Custom frizz\.sh subdomain|github\.com\/login\/device/, "no claim form, no sign-in")
  assert.match(out.text(), /Serving https:\/\/colin\.frizz\.sh \(frizz\.sh\)/)
  assert.match(out.text(), /frizz_code=c0de/)
})

test("while custom names are paused, leaving a custom name says the menu cannot bring it back, and asks first", async () => {
  const saved: CloudConfig = { hostname: "colin.frizz.sh", claim: "colin", serve: "relay" }
  const { pane, out, applied } = buildPane(saved)
  pane.open()
  pane.key("2")
  pane.key("\r")
  await settle()
  assert.deepEqual(applied, [], "a random name was claimed before anyone was asked")
  assert.match(out.text(), /Leave colin\.frizz\.sh\?/)
  assert.match(out.text(), /cannot bring\s+colin\.frizz\.sh\s+back/)
  pane.key("\x1b")
  assert.equal(menuRows(out.text()).length, 7, "escape goes back to the menu")
  assert.match(menuRows(out.text())[1]!, /^ {2}❯ {3}frizz\.sh subdomain/)

  pane.key("1")
  pane.key("\r")
  assert.match(out.text(), /Leave colin\.frizz\.sh\?/)
  assert.deepEqual(applied, [])
  pane.key("\r")
  await settle()
  assert.deepEqual(applied, [null], "enter goes ahead with the switch")
  assert.match(out.text(), /Back to localhost only/)
})

test("a board on a random name switches without being asked", async () => {
  const { pane, applied } = buildPane({ hostname: "h2cioy5ilpwjdwptl7yz.frizz.sh", claim: "h2cioy5ilpwjdwptl7yz", serve: "relay" })
  pane.open()
  pane.key("1")
  pane.key("\r")
  await settle()
  assert.deepEqual(applied, [null])
})
