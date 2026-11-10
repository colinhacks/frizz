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
import { fileURLToPath } from "node:url"
import { z } from "zod"
import { CODEX_APP_SERVER_SUPPORTED_VERSION, CODEX_READS } from "./codex-app-server.ts"
import { readProblemLine, readSideProblems } from "./codex.fixtures/read-conformance.ts"
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
  // `cwd` rides a resume whose recorded cwd no longer exists (a project directory rename) — see
  // resumeCwdOverride in codex-app-server.ts.
  // `config` is the thread's whole per-thread bag (threadConfig): a resume that rebuilds the thread
  // builds it from this and nothing else, so a field the app-server stopped reading here would strip
  // every resumed thread of its MCP mount and hooks without an error.
  "thread/resume": ["threadId", "excludeTurns", "approvalsReviewer", "sandbox", "approvalPolicy", "cwd", "config"],
  // Sent before the resume that is meant to REBUILD an idle thread (rebindOwnedSession): the app-server
  // ignores a resume's bag for as long as it counts a subscriber.
  "thread/unsubscribe": ["threadId"],
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

/** The installed binary's own description of its protocol, generated once for the whole file. */
let generatedDir: string | undefined
function generatedSchema<T>(file: string): T {
  if (!generatedDir) {
    const dir = mkdtempSync(join(tmpdir(), "frizz-codex-schema-"))
    // At exit, not in an `after` hook: the first test to ask is the one that generates, and a hook
    // registered inside it would take the directory away from every test that follows.
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }))
    execFileSync(codexBin, ["app-server", "generate-json-schema", "--experimental", "--out", dir], {
      encoding: "utf8",
      timeout: 120_000,
    })
    generatedDir = dir
  }
  return JSON.parse(readFileSync(join(generatedDir, file), "utf8")) as T
}

/** method -> the set of param keys the installed app-server actually accepts. */
function protocolParams(): Map<string, Set<string>> {
  const schema = generatedSchema<{
    oneOf: { properties: { method: { enum: string[] }; params?: { $ref?: string } } }[]
    definitions: Record<string, { properties?: Record<string, unknown> }>
  }>("ClientRequest.json")
  const byMethod = new Map<string, Set<string>>()
  for (const variant of schema.oneOf) {
    const method = variant.properties.method.enum[0]
    const ref = variant.properties.params?.$ref
    const name = ref?.split("/").pop()
    const properties = name ? schema.definitions[name]?.properties : undefined
    byMethod.set(method, new Set(Object.keys(properties ?? {})))
  }
  return byMethod
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

// ---- the read side ---------------------------------------------------------------------------------
// Everything above judges what Frizz SENDS. This judges what it READS: the schemas in CODEX_READS are
// the ones the bridge parses the app-server's requests and notifications with, most of them `.strict()`,
// and a strict schema refuses a whole message for one key it does not name. Nothing checked that until
// 2026-11-10. Two were refusing what the pinned binary sends, and had been since codex 0.150: `kind` on
// every command approval and `isBlocking` on every question. A refusal was also silent (`-32602` to
// codex, nothing logged), so nobody could have seen it: it stayed dormant only because every Frizz
// thread runs `approvalPolicy: "never"`. The same slip on `turn/completed` would leave every Codex turn
// looking in flight forever.

/** What Frizz refuses of what the pinned binary can send, ON PURPOSE, with the reason. The gate below
 *  fails on a refusal that is not here, and on an entry here that no longer happens. */
const REFUSED_ON_PURPOSE: Record<string, string> = {
  "item/commandExecution/requestApproval.availableDecisions[] refuses-value {acceptWithExecpolicyAmendment}":
    "Frizz has no decision that sends a policy amendment back, so commandDecisions refuses a menu that offers one rather than draw it short. " +
    "The pinned binary offers one on an ordinary untrusted command (captured 2026-11-07), so command approvals cannot be drawn for those yet.",
  "item/commandExecution/requestApproval.availableDecisions[] refuses-value {applyNetworkPolicyAmendment}":
    "The same, for a network policy amendment.",
  "mcpServer/elicitation/request refuses-variant openai/userVerification":
    "A device-authenticated approval, whose answer carries a proof Frizz cannot produce.",
  "mcpServer/elicitation/request refuses-variant openaiForm":
    "The vendor-extended form contract, which the bridge's initialize capabilities switch off (as `openai/form`, which is refused by name).",
}

interface GeneratedMessages { oneOf: { properties: { method: { enum: string[] }; params?: unknown } }[]; definitions: Record<string, unknown> }

test("the pinned app-server sends nothing a schema Frizz reads it with refuses, except by name", { skip }, () => {
  const found: string[] = []
  for (const [kind, file] of [["requests", "ServerRequest.json"], ["notifications", "ServerNotification.json"]] as const) {
    const generated = generatedSchema<GeneratedMessages>(file)
    const params = new Map(generated.oneOf.map((variant) => [variant.properties.method.enum[0], variant.properties.params]))
    for (const [method, schema] of Object.entries(CODEX_READS[kind])) {
      assert.ok(params.has(method), `the app-server no longer declares '${method}', which Frizz reads (${file})`)
      found.push(...readSideProblems(schema, params.get(method), generated.definitions, method).map(readProblemLine))
    }
  }
  const bundle = generatedSchema<{ definitions?: Record<string, unknown>; $defs?: Record<string, unknown> }>("codex_app_server_protocol.v2.schemas.json")
  const definitions = bundle.definitions ?? bundle.$defs ?? {}
  assert.ok(definitions.ThreadItem, "the generated bundle no longer defines ThreadItem, which item/started and item/completed carry")
  for (const [type, schema] of Object.entries(CODEX_READS.items)) {
    found.push(...readSideProblems(schema, definitions.ThreadItem, definitions, `ThreadItem<${type}>`).map(readProblemLine))
  }

  const unexpected = found.filter((line) => !(line in REFUSED_ON_PURPOSE))
  assert.deepEqual(
    unexpected,
    [],
    "the pinned app-server can send something a schema in codex-app-server.ts refuses, and the whole message is then dropped. " +
      "Name the key (or variant, or value) in that schema, or add the line to REFUSED_ON_PURPOSE with the reason it is refused.",
  )
  assert.deepEqual(
    Object.keys(REFUSED_ON_PURPOSE).filter((line) => !found.includes(line)),
    [],
    "REFUSED_ON_PURPOSE lists a refusal that no longer happens: the binary stopped declaring it, or the schema now reads it. Remove the entry.",
  )
})

// The walk itself, on shapes small enough to read, so the gate above is known to be able to fail on a
// machine where it skips (no pinned binary) and after a refactor of either side.
test("the read-side walk reports each way a schema can refuse what the wire declares", () => {
  const definitions = {
    Inner: { type: "object", properties: { a: { type: "string" }, grew: { type: "string" } } },
    Tagged: {
      properties: { shared: { type: "string" } },
      oneOf: [
        { type: "object", properties: { type: { enum: ["read"] }, path: { type: "string" } } },
        { type: "object", properties: { type: { enum: ["added"] } } },
      ],
    },
    Mode: { oneOf: [{ enum: ["read", "write"], type: "string" }, { type: "object", properties: { structured: {} } }] },
  }
  const wire = {
    type: "object",
    properties: {
      id: { type: "string" },
      inner: { anyOf: [{ $ref: "#/definitions/Inner" }, { type: "null" }] },
      list: { type: ["array", "null"], items: { $ref: "#/definitions/Tagged" } },
      mode: { allOf: [{ $ref: "#/definitions/Mode" }], default: "read" },
      loose: { type: "object", properties: { anything: {} } },
    },
  }
  const schema = z.object({
    id: z.string(),
    renamed: z.string(),
    forgiven: z.string().optional(),
    inner: z.object({ a: z.string() }).strict().nullable(),
    list: z.array(z.discriminatedUnion("type", [
      z.object({ type: z.literal("read"), path: z.string(), shared: z.string().optional() }).strict(),
      z.object({ type: z.literal("gone") }).strict(),
    ])).nullable().optional(),
    mode: z.enum(["read"]).optional(),
    loose: z.object({}).passthrough(),
  }).strict()
  assert.deepEqual(readSideProblems(schema, wire, definitions, "m").map(readProblemLine).sort(), [
    "m requires-undeclared-key renamed",
    "m.inner refuses-key grew",
    "m.list[] reads-undeclared-variant gone",
    "m.list[] refuses-variant added",
    "m.mode refuses-value write",
    "m.mode refuses-value {structured}",
  ])
  // One variant of a wire union read as a plain object, the way a ThreadItem is read as a fileChange.
  const variant = z.object({ type: z.literal("read") }).strict()
  assert.deepEqual(readSideProblems(variant, { $ref: "#/definitions/Tagged" }, definitions, "item").map(readProblemLine).sort(), [
    "item refuses-key path",
    "item refuses-key shared",
  ])
})

// CODEX_READS is only a gate if it lists every schema a handler applies. This reads the bridge's own
// source: a handler added for a new method, parsing with a schema the table does not name, fails here.
test("every schema the bridge parses an incoming message with is listed in CODEX_READS", () => {
  const source = readFileSync(fileURLToPath(new URL("./codex-app-server.ts", import.meta.url)), "utf8")
  const table = source.slice(source.indexOf("export const CODEX_READS = {"), source.indexOf("} as const", source.indexOf("export const CODEX_READS = {")))
  assert.ok(table.length > 0, "the CODEX_READS table is where this test expects it")
  const applied = [...source.matchAll(/\b([A-Z]\w*)\.safeParse\((?:rawParams|rawItem|envelope\.data\.item)\)/gu)].map((match) => match[1]!)
  assert.ok(applied.length >= 12, `the handlers' parse sites were found (${applied.length})`)
  assert.deepEqual([...new Set(applied)].filter((name) => !new RegExp(`\\b${name}\\b`, "u").test(table)), [])
})

/** `codex features list` read from a Codex home with no config.toml, so each flag's state is its DEFAULT. */
function featureStates(overrides: string[] = []): Map<string, string> {
  const home = mkdtempSync(join(tmpdir(), "frizz-codex-features-"))
  try {
    const out = execFileSync(codexBin, ["features", "list", ...overrides], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, CODEX_HOME: home },
    })
    const states = new Map<string, string>()
    // Three columns padded with two or more spaces: name, stage ("under development" has a single space), state.
    for (const line of out.split("\n")) {
      const m = line.match(/^(\S+)\s{2,}.+?\s{2,}(true|false)\s*$/)
      if (m) states.set(m[1], m[2])
    }
    return states
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

// Frizz reads a Codex thread's history from its plain `rollout-*.jsonl` (codex.ts, transcript.ts,
// codex-quota.ts) and has no zstd reader. Codex can compress a rollout untouched for 7 days into
// `.jsonl.zst` behind `local_thread_store_compression`, which is under development and off by default
// through 0.167.0 (codex-rs/rollout/src/compression.rs at the pinned commit, read 2026-10-23; unchanged
// since #55545 of 2026-10-20, re-checked 2026-10-27, 2026-10-29 and 2026-11-05). A release that turns it on would empty the
// transcript of every Codex thread older than a week, with no error, so the bump has to stop here first.
// The forced-on read proves the parse can see `true` at all, so a reworded listing cannot pass by
// matching nothing.
test("the pinned codex leaves cold-rollout compression off by default", { skip }, () => {
  const flag = "local_thread_store_compression"
  assert.equal(
    featureStates().get(flag),
    "false",
    `${flag} is on by default or no longer listed: Codex may now write cold rollouts as .jsonl.zst, ` +
      "which Frizz cannot read. Teach the rollout readers zstd (or switch the flag off for workers) before this pin lands.",
  )
  assert.equal(featureStates(["-c", `features.${flag}=true`]).get(flag), "true", "the listing parse reads a flag that is on")
})
