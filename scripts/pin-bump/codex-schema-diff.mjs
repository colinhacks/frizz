#!/usr/bin/env node
// Diff two Codex app-server protocol schema bundles, in both directions of the wire.
//
//   nub scripts/pin-bump/codex-schema-diff.mjs <old-dir> <new-dir>             a report
//   nub scripts/pin-bump/codex-schema-diff.mjs <old-dir> <new-dir> --json      the same, as JSON
//   nub scripts/pin-bump/codex-schema-diff.mjs <old-dir> <new-dir> --control   prove the differ can see
//
// Generate each bundle with that build's own binary (provision.mjs prints its path), in a throwaway
// CODEX_HOME so nothing touches the real one:
//
//   CODEX_HOME=$(mktemp -d) <codex> app-server generate-json-schema --experimental --out <dir>
//
// Part 1, the variants: ClientRequest (what Frizz SENDS) and ServerNotification, ServerRequest and
// ClientNotification (what Frizz READS). For each, the method set, and per method the param keys
// (resolved through the file's own definitions) and required keys. A request-only audit passed a break
// shaped like 0.153's, so the read direction is not optional.
// Part 2, the definitions: every definition in the v2 bundle and the top-level bundle, added, removed
// or changed; for a changed one, the property keys, enum values (tagged-union discriminators included)
// and required keys that moved, the properties present on both sides whose schema changed (`~props`),
// and `other` when only the body moved.
// A REMOVED method, field or enum value is the finding; additions are ordinarily harmless, though a
// new field on a schema Frizz parses `.strict()` is not (0.166's lifecycle stamps on `fileChange` items
// broke file approvals that way). Run it OLD NEW and again NEW OLD, so "removed" reads both ways.
//
// --control deletes a real member from copies of the NEW bundle — a method from each variant file,
// `turn/start`'s `effort`, the `TurnStatus` definition, MessagePhase's `final_answer`, `Turn.status` —
// and requires the differ to report exactly that. Each target is one Frizz depends on and one present
// on both sides, so the control cannot go blind when the data moves under it.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { isDeepStrictEqual } from "node:util"

const VARIANT_FILES = ["ClientRequest", "ServerNotification", "ServerRequest", "ClientNotification"]
const DEF_BUNDLES = ["codex_app_server_protocol.v2.schemas.json", "codex_app_server_protocol.schemas.json"]

const [oldDir, newDir] = process.argv.slice(2)
if (!oldDir || !newDir) {
  console.error("usage: nub scripts/pin-bump/codex-schema-diff.mjs <old-dir> <new-dir> [--json | --control]")
  process.exit(1)
}
const load = (dir, name) => JSON.parse(readFileSync(join(dir, name), "utf8"))
const sorted = (values) => [...values].sort()
const minus = (a, b) => sorted([...a].filter((value) => !b.has(value)))

// method -> { keys, required }
function variants(doc) {
  const out = new Map()
  const defs = doc.definitions ?? {}
  for (const variant of doc.oneOf ?? []) {
    const method = variant.properties.method.enum[0]
    const params = variant.properties.params ?? {}
    const body = params.$ref ? defs[params.$ref.split("/").at(-1)] ?? {} : params
    out.set(method, { keys: new Set(Object.keys(body.properties ?? {})), required: new Set(body.required ?? []) })
  }
  return out
}

function diffVariants(oldDoc, newDoc) {
  const a = variants(oldDoc), b = variants(newDoc)
  const result = { old: a.size, new: b.size, added: minus(b.keys(), a), removed: minus(a.keys(), b), keys: {} }
  for (const method of sorted([...a.keys()].filter((m) => b.has(m)))) {
    const x = a.get(method), y = b.get(method)
    const delta = {}
    if (minus(y.keys, x.keys).length) delta["+keys"] = minus(y.keys, x.keys)
    if (minus(x.keys, y.keys).length) delta["-keys"] = minus(x.keys, y.keys)
    if (minus(y.required, x.required).length) delta["+required"] = minus(y.required, x.required)
    if (minus(x.required, y.required).length) delta["-required"] = minus(x.required, y.required)
    if (Object.keys(delta).length) result.keys[method] = delta
  }
  return result
}

function enumValues(body) {
  const values = new Set()
  for (const value of body.enum ?? []) values.add(String(value))
  for (const alt of [...(body.oneOf ?? []), ...(body.anyOf ?? [])]) {
    if (!alt || typeof alt !== "object") continue
    for (const value of alt.enum ?? []) values.add(String(value))
    if ("const" in alt) values.add(String(alt.const))
    // A tagged union's members carry their discriminator as a single-value enum.
    for (const [key, prop] of Object.entries(alt.properties ?? {})) {
      if (prop && Array.isArray(prop.enum) && prop.enum.length === 1) values.add(`${key}=${prop.enum[0]}`)
    }
  }
  return values
}

function diffDefs(oldDoc, newDoc) {
  const a = oldDoc.definitions ?? {}, b = newDoc.definitions ?? {}
  const aNames = new Set(Object.keys(a)), bNames = new Set(Object.keys(b))
  const result = { old: aNames.size, new: bNames.size, added: minus(bNames, aNames), removed: minus(aNames, bNames), changed: {} }
  for (const name of sorted([...aNames].filter((n) => bNames.has(n)))) {
    const x = a[name], y = b[name]
    if (isDeepStrictEqual(x, y)) continue
    const delta = {}
    const px = new Set(Object.keys(x.properties ?? {})), py = new Set(Object.keys(y.properties ?? {}))
    if (minus(py, px).length) delta["+props"] = minus(py, px)
    if (minus(px, py).length) delta["-props"] = minus(px, py)
    const ex = enumValues(x), ey = enumValues(y)
    if (minus(ey, ex).length) delta["+enum"] = minus(ey, ex)
    if (minus(ex, ey).length) delta["-enum"] = minus(ex, ey)
    const rx = new Set(x.required ?? []), ry = new Set(y.required ?? [])
    if (minus(ry, rx).length) delta["+required"] = minus(ry, rx)
    if (minus(rx, ry).length) delta["-required"] = minus(rx, ry)
    const reshaped = sorted([...px].filter((p) => py.has(p) && !isDeepStrictEqual(x.properties[p], y.properties[p])))
    if (reshaped.length) delta["~props"] = reshaped
    if (!Object.keys(delta).length) delta.other = true
    result.changed[name] = delta
  }
  return result
}

function run(override = {}) {
  const out = { variants: {}, defs: {} }
  for (const file of VARIANT_FILES) out.variants[file] = diffVariants(load(oldDir, `${file}.json`), override[file] ?? load(newDir, `${file}.json`))
  for (const file of DEF_BUNDLES) out.defs[file] = diffDefs(load(oldDir, file), override[file] ?? load(newDir, file))
  return out
}

function report(result) {
  for (const [file, d] of Object.entries(result.variants)) {
    console.log(`== ${file}: ${d.old} -> ${d.new} variants; +${d.added.length} -${d.removed.length}; ${Object.keys(d.keys).length} with key changes`)
    for (const method of d.added) console.log(`   + method ${method}`)
    for (const method of d.removed) console.log(`   - METHOD REMOVED ${method}`)
    for (const [method, delta] of Object.entries(d.keys)) console.log(`   ~ ${method}: ${JSON.stringify(delta)}`)
  }
  for (const [file, d] of Object.entries(result.defs)) {
    console.log(`== defs ${file}: ${d.old} -> ${d.new}; +${d.added.length} -${d.removed.length} ~${Object.keys(d.changed).length}`)
    for (const name of d.added) console.log(`   + def ${name}`)
    for (const name of d.removed) console.log(`   - DEF REMOVED ${name}`)
    for (const [name, delta] of Object.entries(d.changed)) console.log(`   ~ ${name}: ${JSON.stringify(delta)}`)
  }
}

function control() {
  let ok = true
  const verdict = (hit) => { ok &&= hit; return hit ? "DETECTED" : "MISSED" }
  for (const file of VARIANT_FILES) {
    const oldDoc = load(oldDir, `${file}.json`)
    const doc = load(newDir, `${file}.json`)
    const target = sorted([...variants(oldDoc).keys()].filter((m) => variants(doc).has(m)))[0]
    doc.oneOf = doc.oneOf.filter((variant) => variant.properties.method.enum[0] !== target)
    const removed = diffVariants(oldDoc, doc).removed
    console.log(`control ${file}: delete method ${target} -> removed ${JSON.stringify(removed)} -> ${verdict(removed.includes(target))}`)
  }
  const request = load(newDir, "ClientRequest.json")
  delete request.definitions.TurnStartParams.properties.effort
  const keys = diffVariants(load(oldDir, "ClientRequest.json"), request).keys["turn/start"] ?? {}
  console.log(`control ClientRequest key: delete turn/start.effort -> ${JSON.stringify(keys)} -> ${verdict(isDeepStrictEqual(keys["-keys"], ["effort"]))}`)

  const v2 = DEF_BUNDLES[0]
  const baseOld = load(oldDir, v2)
  const baseline = diffDefs(baseOld, load(newDir, v2)).removed
  let doc = load(newDir, v2)
  delete doc.definitions.TurnStatus
  const removed = diffDefs(baseOld, doc).removed
  // The control must add exactly TurnStatus to whatever the unmutated pair already removes.
  const added = removed.filter((name) => !baseline.includes(name))
  console.log(`control defs: delete def TurnStatus -> removed ${JSON.stringify(removed)} -> ${verdict(isDeepStrictEqual(added, ["TurnStatus"]))}`)

  doc = load(newDir, v2)
  const strip = (node) => {
    if (!node || typeof node !== "object") return node
    if (Array.isArray(node.enum)) node.enum = node.enum.filter((value) => value !== "final_answer")
    for (const key of ["oneOf", "anyOf"]) {
      if (Array.isArray(node[key])) node[key] = node[key].filter((alt) => !(alt && typeof alt === "object" && (alt.const === "final_answer" || (Array.isArray(alt.enum) && alt.enum.length === 0)))).map(strip)
    }
    return node
  }
  strip(doc.definitions.MessagePhase)
  const phase = diffDefs(baseOld, doc).changed.MessagePhase ?? {}
  console.log(`control defs: drop MessagePhase final_answer -> ${JSON.stringify(phase)} -> ${verdict((phase["-enum"] ?? []).includes("final_answer"))}`)

  doc = load(newDir, v2)
  delete doc.definitions.Turn.properties.status
  const turn = diffDefs(baseOld, doc).changed.Turn ?? {}
  console.log(`control defs: delete Turn.status -> ${JSON.stringify(turn)} -> ${verdict((turn["-props"] ?? []).includes("status"))}`)
  console.log(ok ? "ALL CONTROLS DETECTED" : "A CONTROL MISSED")
  return ok
}

if (process.argv.includes("--control")) process.exit(control() ? 0 : 1)
else if (process.argv.includes("--json")) console.log(JSON.stringify(run(), null, 1))
else report(run())
