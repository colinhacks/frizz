import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { parseCodexModelsCache, readCodexModels, CODEX_MODELS_FALLBACK } from "./codex-models.ts"
import { CODEX_MODELS_FALLBACK_VERSION } from "@frizz/shared"
import { CODEX_APP_SERVER_SUPPORTED_VERSION } from "./codex-app-server.ts"

// A REAL snippet of ~/.codex/models_cache.json (codex-cli 0.144.1, fields verbatim; the gpt-6-astra
// entry is the codex-cli 0.153.2 bundled shape, 2026-09-04, and gpt-6-sol the 0.155.1 one, 2026-09-22).
// Deliberately includes: per-model effort
// sets (astra/sol → …/ultra, luna → …/max, 5.5 → …/xhigh), OUT-OF-ORDER priorities (5.5 before sol,
// astra LAST in the array but priority 1) to prove the ascending sort, a hidden model (codex-auto-review)
// to prove the visibility filter drops it, an api=false-but-listed model (spark) to prove it is KEPT
// (frizz spawns the TUI, not the Responses API), and the newer sidecar fields astra ships with
// (`minimal_client_version`, `service_tiers`, `additional_speed_tiers`) to prove the parser ignores
// them rather than tripping on them. Otherwise trimmed of the fat sidecar fields the parser ignores.
//
// gpt-6-sol carries the two sidecars the GPT-6 generation added on top of astra's — `availability_nux`
// and `model_messages` (trimmed here; the live one is a multi-KB instruction blob) — plus `upgrade:
// null`, for the same reason: the parser must ignore a growing sidecar set, not trip on it. Its
// priority 2 is the live number, which is why gpt-5.6-sol moved to its own live 4: the GPT-6 trio
// pushed the 5.6 trio down the catalogue rather than replacing it.
const REAL_CACHE = JSON.stringify({
  fetched_at: "2026-07-12T16:21:05.012098Z",
  etag: 'W/"db2a6dc50b1d003969cdc236274e488a"',
  client_version: "0.144.1",
  models: [
    {
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "" },
        { effort: "medium", description: "" },
        { effort: "high", description: "" },
        { effort: "xhigh", description: "" },
      ],
      visibility: "list",
      supported_in_api: true,
      priority: 7,
    },
    {
      slug: "gpt-5.6-sol",
      display_name: "GPT-5.6-Sol",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "" },
        { effort: "medium", description: "" },
        { effort: "high", description: "" },
        { effort: "xhigh", description: "" },
        { effort: "max", description: "" },
        { effort: "ultra", description: "" },
      ],
      visibility: "list",
      supported_in_api: true,
      priority: 4,
    },
    {
      slug: "gpt-5.6-luna",
      display_name: "GPT-5.6-Luna",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "" },
        { effort: "medium", description: "" },
        { effort: "high", description: "" },
        { effort: "xhigh", description: "" },
        { effort: "max", description: "" },
      ],
      visibility: "list",
      supported_in_api: true,
      priority: 3,
    },
    {
      slug: "gpt-5.3-codex-spark",
      display_name: "GPT-5.3-Codex-Spark",
      default_reasoning_level: "high",
      supported_reasoning_levels: [
        { effort: "low", description: "" },
        { effort: "medium", description: "" },
        { effort: "high", description: "" },
        { effort: "xhigh", description: "" },
      ],
      visibility: "list",
      supported_in_api: false,
      priority: 26,
    },
    {
      slug: "codex-auto-review",
      display_name: "Codex Auto Review",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "low", description: "" }],
      visibility: "hide",
      supported_in_api: true,
      priority: 43,
    },
    {
      slug: "gpt-6-astra",
      display_name: "GPT-6-Astra",
      description: "Our most capable model for complex, demanding work.",
      default_reasoning_level: "low",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast responses with lighter reasoning" },
        { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
        { effort: "high", description: "Greater reasoning depth for complex problems" },
        { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
        { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
        { effort: "ultra", description: "Maximum reasoning with automatic task delegation" },
      ],
      visibility: "list",
      minimal_client_version: "0.153.0",
      supported_in_api: true,
      priority: 1,
      default_service_tier: null,
      service_tiers: [{ id: "priority", name: "Fast", description: "2x speed, increased usage" }],
      additional_speed_tiers: ["fast"],
    },
    {
      slug: "gpt-6-sol",
      display_name: "GPT-6-Sol",
      description: "Fast, capable model for everyday coding.",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "low", description: "Fast responses with lighter reasoning" },
        { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
        { effort: "high", description: "Greater reasoning depth for complex problems" },
        { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
        { effort: "max", description: "Maximum reasoning depth for the hardest problems" },
        { effort: "ultra", description: "Maximum reasoning with automatic task delegation" },
      ],
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: 2,
      context_window: 272_000,
      max_context_window: 872_000,
      additional_speed_tiers: ["fast"],
      availability_nux: { message: "This is GPT-6, a new generation of intelligence." },
      upgrade: null,
      model_messages: { persistent_instructions: "## Overview\nYou are now in persistent mode…" },
    },
  ],
})

test("the degraded catalogue is re-read whenever Frizz's pinned Codex runtime moves", () => {
  assert.equal(CODEX_MODELS_FALLBACK_VERSION, CODEX_APP_SERVER_SUPPORTED_VERSION)
})

test("parseCodexModelsCache: lists visible models priority-ASC with EXACT per-model effort sets", () => {
  const models = parseCodexModelsCache(REAL_CACHE)
  // codex-auto-review (visibility:hide) is dropped; the rest are priority-ascending (astra=1, gpt-6-sol=2,
  // 5.6-luna=3, 5.6-sol=4, 5.5=7, spark=26) — note gpt-6-sol is LAST in the array and second out.
  assert.deepEqual(models.map((m) => m.slug), ["gpt-6-astra", "gpt-6-sol", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.5", "gpt-5.3-codex-spark"])
  const bySlug = Object.fromEntries(models.map((m) => [m.slug, m]))
  // Per-model efforts are the crux of the fix: astra and sol go to ultra, luna to max, 5.5 stops at xhigh.
  assert.deepEqual(bySlug["gpt-6-astra"]!.efforts, ["low", "medium", "high", "xhigh", "max", "ultra"])
  // Astra's catalogue default is `low`, and the parser mirrors it rather than assuming `medium`.
  assert.equal(bySlug["gpt-6-astra"]!.defaultEffort, "low")
  assert.equal(bySlug["gpt-6-astra"]!.displayName, "GPT-6-Astra")
  assert.deepEqual(bySlug["gpt-5.6-sol"]!.efforts, ["low", "medium", "high", "xhigh", "max", "ultra"])
  assert.deepEqual(bySlug["gpt-5.6-luna"]!.efforts, ["low", "medium", "high", "xhigh", "max"])
  assert.deepEqual(bySlug["gpt-5.5"]!.efforts, ["low", "medium", "high", "xhigh"])
  assert.equal(bySlug["gpt-5.6-sol"]!.displayName, "GPT-5.6-Sol")
  assert.equal(bySlug["gpt-5.6-sol"]!.defaultEffort, "medium")
  // GPT-6 Sol: the same ultra-capable effort set as Astra, its own `medium` default, and the sidecars
  // the generation added (availability_nux / model_messages / upgrade) ignored rather than tripped on.
  assert.deepEqual(bySlug["gpt-6-sol"]!.efforts, ["low", "medium", "high", "xhigh", "max", "ultra"])
  assert.equal(bySlug["gpt-6-sol"]!.defaultEffort, "medium")
  assert.equal(bySlug["gpt-6-sol"]!.displayName, "GPT-6-Sol")
  assert.equal(bySlug["gpt-6-sol"]!.contextWindow, 272_000)
  assert.equal(bySlug["gpt-6-sol"]!.maxContextWindow, 872_000)
  // An api=false model is TUI-selectable (frizz spawns the TUI) — kept, not filtered.
  assert.ok(bySlug["gpt-5.3-codex-spark"])
})

test("parseCodexModelsCache: default effort falls back to the first supported level when absent/unsupported", () => {
  const raw = JSON.stringify({
    models: [
      // No default_reasoning_level → first supported (low).
      { slug: "m1", display_name: "M1", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }], visibility: "list", priority: 1 },
      // default not in the supported set → first supported (medium), not the bogus value.
      { slug: "m2", display_name: "M2", default_reasoning_level: "bogus", supported_reasoning_levels: [{ effort: "medium" }], visibility: "list", priority: 2 },
    ],
  })
  const models = parseCodexModelsCache(raw)
  assert.equal(models.find((m) => m.slug === "m1")!.defaultEffort, "low")
  assert.equal(models.find((m) => m.slug === "m2")!.defaultEffort, "medium")
})

test("parseCodexModelsCache: malformed JSON, no models array, or all-dropped entries → the fallback", () => {
  assert.deepEqual(parseCodexModelsCache("{not json"), CODEX_MODELS_FALLBACK)
  assert.deepEqual(parseCodexModelsCache(JSON.stringify({ etag: "x" })), CODEX_MODELS_FALLBACK) // no models array
  assert.deepEqual(parseCodexModelsCache(JSON.stringify({ models: "nope" })), CODEX_MODELS_FALLBACK)
  // Every entry is unusable (hidden / no slug / no efforts) → nothing survives → fallback (never empty).
  const allBad = JSON.stringify({
    models: [
      { slug: "hidden", visibility: "hide", supported_reasoning_levels: [{ effort: "low" }] },
      { display_name: "no slug", visibility: "list", supported_reasoning_levels: [{ effort: "low" }] },
      { slug: "no-efforts", visibility: "list", supported_reasoning_levels: [] },
    ],
  })
  assert.deepEqual(parseCodexModelsCache(allBad), CODEX_MODELS_FALLBACK)
})

test("parseCodexModelsCache: a malformed entry is SKIPPED but good siblings survive", () => {
  const raw = JSON.stringify({
    models: [
      { slug: "good", display_name: "Good", supported_reasoning_levels: [{ effort: "low" }], visibility: "list", priority: 5 },
      { slug: 42, visibility: "list", supported_reasoning_levels: [{ effort: "low" }] }, // slug not a string → skipped
      "junk",
      null,
    ],
  })
  assert.deepEqual(parseCodexModelsCache(raw).map((m) => m.slug), ["good"])
})

test("readCodexModels: reads a real cache from CODEX_HOME; a MISSING cache degrades to the fallback", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-models-"))
  try {
    // Missing cache file → fallback (never throws).
    assert.deepEqual(readCodexModels(home), CODEX_MODELS_FALLBACK)
    // Write the real cache; a DISTINCT home dodges the module-level TTL memo (keyed on path).
    const home2 = mkdtempSync(join(tmpdir(), "codex-models-"))
    mkdirSync(home2, { recursive: true })
    writeFileSync(join(home2, "models_cache.json"), REAL_CACHE)
    assert.deepEqual(readCodexModels(home2, "0.144.1").map((m) => m.slug), ["gpt-6-astra", "gpt-6-sol", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.5", "gpt-5.3-codex-spark"])
    rmSync(home2, { recursive: true, force: true })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a foreign Codex client's cache cannot make the pinned runtime's models disappear", () => {
  const pinned = parseCodexModelsCache(REAL_CACHE)
  const foreign = JSON.stringify({
    client_version: "0.154.0",
    models: [{
      slug: "gpt-5.5",
      display_name: "GPT-5.5",
      default_reasoning_level: "medium",
      supported_reasoning_levels: [{ effort: "medium" }],
      visibility: "list",
      priority: 1,
    }],
  })
  assert.deepEqual(
    parseCodexModelsCache(foreign, "0.156.1", pinned),
    pinned,
    "an older writer retains the last catalogue read from Frizz's pinned runtime",
  )
  assert.deepEqual(
    parseCodexModelsCache(foreign, "0.156.1"),
    CODEX_MODELS_FALLBACK,
    "a cold server degrades to the shared catalogue rather than the foreign writer's partial list",
  )
  assert.ok(CODEX_MODELS_FALLBACK.some((model) => model.slug === "gpt-6.1-sol"))
})

test("readCodexModels: retains the last compatible catalogue after a foreign writer replaces the cache", () => {
  const home = mkdtempSync(join(tmpdir(), "codex-models-trusted-"))
  const path = join(home, "models_cache.json")
  try {
    writeFileSync(path, REAL_CACHE)
    const compatible = readCodexModels(home, "0.144.1", 0)
    writeFileSync(path, JSON.stringify({
      client_version: "0.154.0",
      models: [{
        slug: "gpt-5.5",
        display_name: "GPT-5.5",
        default_reasoning_level: "medium",
        supported_reasoning_levels: [{ effort: "medium" }],
        visibility: "list",
        priority: 1,
      }],
    }))
    assert.deepEqual(
      readCodexModels(home, "0.144.1", 5_001),
      compatible,
      "the live reader, not only the pure parser, carries the trusted list across a foreign write",
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("the window pair rides each model when the cache carries it, and is simply absent when it does not", () => {
  // Real shape from ~/.codex/models_cache.json on codex-cli 0.153.2 (2026-09-11): GPT-5.6 lists a 272K
  // stock window and an 872K maximum; Spark's two numbers coincide at 128K.
  const entry = (slug: string, extra: Record<string, unknown>) => ({
    slug, display_name: slug, visibility: "list", priority: 1, default_reasoning_level: "medium",
    supported_reasoning_levels: [{ effort: "medium", description: "" }], ...extra,
  })
  const models = parseCodexModelsCache(JSON.stringify({ models: [
    entry("gpt-5.6-sol", { context_window: 272_000, max_context_window: 872_000 }),
    entry("gpt-5.3-codex-spark", { context_window: 128_000, max_context_window: 128_000 }),
    entry("old-cache-shape", {}),
    entry("junk", { context_window: "272000", max_context_window: 0 }),
  ] }))
  const by = Object.fromEntries(models.map((m) => [m.slug, m]))
  assert.equal(by["gpt-5.6-sol"]!.contextWindow, 272_000)
  assert.equal(by["gpt-5.6-sol"]!.maxContextWindow, 872_000)
  assert.equal(by["gpt-5.3-codex-spark"]!.maxContextWindow, 128_000)
  // Neither key is present at all, so a consumer can tell "unknown" from a number.
  assert.ok(!("contextWindow" in by["old-cache-shape"]!) && !("maxContextWindow" in by["old-cache-shape"]!))
  assert.ok(!("contextWindow" in by["junk"]!) && !("maxContextWindow" in by["junk"]!), "a string or a 0 is not a window")
})
