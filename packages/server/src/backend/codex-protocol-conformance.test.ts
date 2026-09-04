// Conformance gate for the Codex app-server WIRE CONTRACT.
//
// frizz hand-writes the params it sends to `codex app-server`. The existing version pin
// (CODEX_APP_SERVER_SUPPORTED_VERSION, enforced at connect) proves we are talking to the RIGHT
// BINARY — it says nothing about whether the FIELD NAMES we send are the ones that binary reads.
// That gap is dangerous specifically because the app-server has no `deny_unknown_fields`: an unknown
// key is SILENTLY IGNORED. A misspelled or moved field returns a perfectly successful `{}` and does
// nothing at all, which is indistinguishable from working until a human notices the setting never
// took (verified live, 2026-07-23).
//
// The binary describes itself — `codex app-server generate-json-schema` emits the real protocol — so
// this compares what frizz sends against that generated truth instead of against someone's memory.
// Same disease as the hand-mirrored web/router contract (see server/src/rpc-contract.ts); same cure.
//
// SKIPS when codex is absent or is not the pinned version: the generated schema is only authoritative
// for the version we pin, and a skew would make this assert against the wrong protocol. Skipping is
// deliberate and announced — it must never silently "pass" on the wrong binary.
import assert from "node:assert/strict"
import { test } from "node:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CODEX_APP_SERVER_SUPPORTED_VERSION } from "./codex-app-server.ts"
import { provisionedBinary, runtimesRoot } from "../runtimes.ts"

// The binary Frizz actually runs: its own provisioned pin when this machine has one (runtimes.ts),
// else whatever PATH offers. The pin IS the audited version by construction, so on a provisioned
// machine this test no longer skips merely because the operator's own `codex` has moved on.
const codexBin = provisionedBinary("codex", runtimesRoot(), CODEX_APP_SERVER_SUPPORTED_VERSION) ?? "codex"

/** Every request frizz issues, and the exact param keys it puts on the wire. Kept beside the call
 *  sites it mirrors: thread/start :1653, thread/resume :1707 :1748 :2346, turn/start :1803,
 *  turn/steer :1849, turn/interrupt :1875, thread/settings/update :2526 in codex-app-server.ts. This
 *  table is not a second source of truth — it is the CLAIM, and the generated schema is what judges it. */
const FRIZZ_SENDS: Record<string, readonly string[]> = {
  "thread/start": [
    "cwd", "model", "approvalPolicy", "approvalsReviewer", "sandbox", "permissions",
    "baseInstructions", "developerInstructions", "config", "ephemeral",
  ],
  // `sandbox` + `approvalPolicy` ride every resume so a sandbox the operator changed while the thread
  // was detached actually takes effect. They go TOGETHER on purpose: on a cold resume the app-server
  // couples them, and passing one alone resets the other to the config.toml default.
  "thread/resume": ["threadId", "excludeTurns", "approvalsReviewer", "sandbox", "approvalPolicy"],
  "turn/start": ["threadId", "clientUserMessageId", "input", "model", "effort"],
  "turn/steer": ["threadId", "clientUserMessageId", "expectedTurnId", "input"],
  "turn/interrupt": ["threadId", "turnId"],
  // The eager per-thread sandbox change. Note the OTHER spelling — `sandboxPolicy`, a tagged object;
  // the test below pins that asymmetry in both directions.
  "thread/settings/update": ["threadId", "sandboxPolicy"],
}

function installedCodexVersion(): string | null {
  try {
    return execFileSync(codexBin, ["--version"], { encoding: "utf8", timeout: 20_000 }).trim().split(/\s+/).pop() ?? null
  } catch {
    return null
  }
}

/** method -> the set of param keys the installed app-server actually accepts. */
function protocolParams(): Map<string, Set<string>> {
  const dir = mkdtempSync(join(tmpdir(), "frizz-codex-schema-"))
  try {
    execFileSync(codexBin, ["app-server", "generate-json-schema", "--experimental", "--out", dir], {
      encoding: "utf8",
      timeout: 120_000,
    })
    const schema = JSON.parse(readFileSync(join(dir, "ClientRequest.json"), "utf8")) as {
      oneOf: { properties: { method: { enum: string[] }; params?: { $ref?: string } } }[]
      definitions: Record<string, { properties?: Record<string, unknown> }>
    }
    const byMethod = new Map<string, Set<string>>()
    for (const variant of schema.oneOf) {
      const method = variant.properties.method.enum[0]
      const ref = variant.properties.params?.$ref
      const name = ref?.split("/").pop()
      const properties = name ? schema.definitions[name]?.properties : undefined
      byMethod.set(method, new Set(Object.keys(properties ?? {})))
    }
    return byMethod
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const installed = installedCodexVersion()
const pinned = installed === CODEX_APP_SERVER_SUPPORTED_VERSION
const skip = installed === null
  ? "codex is not installed; the generated protocol is unavailable"
  : !pinned
    ? `installed codex ${installed} is not the pinned ${CODEX_APP_SERVER_SUPPORTED_VERSION}; its schema would judge the wrong protocol`
    : false

test("every param frizz sends exists in the pinned app-server's own generated protocol", { skip }, () => {
  const protocol = protocolParams()
  for (const [method, fields] of Object.entries(FRIZZ_SENDS)) {
    const accepted = protocol.get(method)
    assert.ok(accepted, `the app-server no longer has a '${method}' request — frizz calls it`)
    for (const field of fields) {
      assert.ok(
        accepted.has(field),
        `${method} does not accept '${field}' (frizz sends it, and an unknown field is SILENTLY IGNORED). ` +
          `Accepted: ${[...accepted].sort().join(", ")}`,
      )
    }
  }
})

// The specific trap that cost a day: the SAME concept is spelled two different ways depending on the
// method, and using the wrong one is a silent no-op rather than an error. `thread/start`/`thread/resume`
// take `sandbox` (the plain SandboxMode string); `turn/start`/`thread/settings/update` take
// `sandboxPolicy` (a tagged object). Pin both directions so a future "fix" that reaches for the
// familiar spelling fails here instead of quietly doing nothing in production.
test("the sandbox param keeps its two distinct spellings", { skip }, () => {
  const protocol = protocolParams()
  const has = (method: string, field: string) => protocol.get(method)?.has(field) ?? false

  for (const method of ["thread/start", "thread/resume"]) {
    assert.ok(has(method, "sandbox"), `${method} takes 'sandbox'`)
    assert.ok(!has(method, "sandboxPolicy"), `${method} does NOT take 'sandboxPolicy' — sending it would be ignored`)
  }
  for (const method of ["turn/start", "thread/settings/update"]) {
    assert.ok(has(method, "sandboxPolicy"), `${method} takes 'sandboxPolicy'`)
    assert.ok(!has(method, "sandbox"), `${method} does NOT take 'sandbox' — sending it would be ignored`)
  }
})

// Live per-thread permission changes depend on this method existing; it is experimental-gated, so a
// codex release that drops or renames it must fail loudly here rather than degrade to a silent no-op.
test("thread/settings/update still exists for live permission changes", { skip }, () => {
  const protocol = protocolParams()
  const accepted = protocol.get("thread/settings/update")
  assert.ok(accepted, "thread/settings/update is gone — live sandbox changes would silently stop applying")
  for (const field of ["threadId", "sandboxPolicy", "approvalPolicy"]) {
    assert.ok(accepted.has(field), `thread/settings/update accepts '${field}'`)
  }
})
