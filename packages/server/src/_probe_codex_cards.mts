// Runs the REAL projectCodexTranscript over REAL rollout files and reports the tool cards it
// produces, so the "write_stdin renders as its own card" claim is measured, not inferred from
// reading the parser. Usage: nub packages/server/src/_probe_codex_cards.mts [days] [topN]
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs"
import { join } from "node:path"
import { homedir, tmpdir } from "node:os"

// The fold decodes a tool result's pictures into a cache under TMPDIR and prunes that cache at a cap.
// Give it a directory of this run's own BEFORE the fold is loaded, so reading real rollouts never
// writes into, or evicts from, the cache a running Frizz is serving.
const scratchTmp = mkdtempSync(join(tmpdir(), "probe-codex-cards-"))
process.env.TMPDIR = scratchTmp
const { projectCodexTranscript } = await import("./transcript.ts")

const days = Number(process.argv[2] ?? 14)
const topN = Number(process.argv[3] ?? 25)
const root = join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "sessions")
const cutoff = Date.now() - days * 86400_000
const files: string[] = []
;(function walk(dir: string) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else if (e.name.startsWith("rollout-") && e.name.endsWith(".jsonl") && statSync(p).mtimeMs >= cutoff) files.push(p)
  }
})(root)

const cardNames = new Map<string, number>()
let totalCards = 0
let reasoningBlocks = 0
let cardsWithDesc = 0
for (const f of files) {
  let msgs
  try { msgs = projectCodexTranscript(readFileSync(f, "utf8")) } catch { continue }
  for (const m of msgs) {
    if (m.kind === "reasoning") reasoningBlocks++
    for (const t of m.tools ?? []) {
      totalCards++
      if (t.desc) cardsWithDesc++
      cardNames.set(t.name, (cardNames.get(t.name) ?? 0) + 1)
    }
  }
}

console.log(`files: ${files.length}   tool cards rendered: ${totalCards}   reasoning blocks: ${reasoningBlocks}`)
console.log(`cards carrying a desc (the Bash-description caption): ${cardsWithDesc}`)
console.log(`\n--- rendered card names (top ${topN}) ---`)
for (const [n, c] of [...cardNames].sort((a, b) => b[1] - a[1]).slice(0, topN)) {
  console.log(String(c).padStart(7), JSON.stringify(n))
}
rmSync(scratchTmp, { recursive: true, force: true })
