#!/usr/bin/env node
// Does CODEX_MODELS_FALLBACK still match what the pinned Codex reports? Parses a copied
// `models_cache.json` with Frizz's own parser and compares it against the fallback in this checkout.
//
//   nub scripts/pin-bump/codex-catalogue.mjs <models_cache.json>
//
// A `codex exec` turn on the new pin writes `~/.codex/models_cache.json` stamped with its
// `client_version`. Copy it the moment the turn ends: every Codex on the machine rewrites that one
// file. The cache is parsed for this checkout's pinned version, and the parse fails closed when the
// copy was written by another build. Prints each parsed model, whether slugs, order, default effort and
// effort lists match the fallback (packages/shared/src/index.ts), and the raw visibility and priority of
// every model in the cache. A mismatch means CODEX_MODELS_FALLBACK moves with the pin; either way
// CODEX_MODELS_FALLBACK_VERSION does, or `codex-models.test.ts` fails.
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const cache = process.argv[2]
if (!cache) {
  console.error("usage: nub scripts/pin-bump/codex-catalogue.mjs <models_cache.json>")
  process.exit(1)
}
const root = fileURLToPath(new URL("../..", import.meta.url))
const source = (path) => import(pathToFileURL(join(root, path)).href)
const { parseCodexModelsCache } = await source("packages/server/src/backend/codex-models.ts")
const { CODEX_MODELS_FALLBACK, CODEX_MODELS_FALLBACK_VERSION } = await source("packages/shared/src/index.ts")
const { CODEX_VERSION } = await source("packages/server/src/runtimes.ts")

const text = readFileSync(cache, "utf8")
const raw = JSON.parse(text)
console.log(`cache client_version ${raw.client_version} · pin ${CODEX_VERSION} · fallback version ${CODEX_MODELS_FALLBACK_VERSION}`)
const parsed = parseCodexModelsCache(text, CODEX_VERSION, [])
const essentials = (model) => ({ slug: model.slug, defaultEffort: model.defaultEffort, efforts: model.efforts })
console.log(`parsed ${parsed.length} models · fallback ${CODEX_MODELS_FALLBACK.length}`)
for (const model of parsed) console.log(JSON.stringify(model))
const same = JSON.stringify(parsed.map(essentials)) === JSON.stringify(CODEX_MODELS_FALLBACK.map(essentials))
console.log(same ? "the fallback matches: slugs, order, default efforts and efforts" : "THE FALLBACK DIFFERS from what this build reports")
for (const model of raw.models ?? []) console.log(`raw: ${model.slug} visibility ${model.visibility} priority ${model.priority}`)
process.exit(same ? 0 : 10)
