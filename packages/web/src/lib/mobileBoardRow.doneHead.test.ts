// The board carries an archived thread's ```done body as its HEAD only (shared fence-head.ts), and the
// phone's Done tab draws that body's first line (rowSecondLine → handoffLine). The line must be the same
// from the head as from the whole body, for any body — so this throws a few thousand at it.
import { test } from "node:test"
import assert from "node:assert/strict"
import { doneFenceBodyHead, elideArchivedDoneFence, type ThreadView } from "@frizz/shared"
import { handoffLine, rowSecondLine } from "./mobileBoardRow.ts"

// A seeded generator, so a failure names a body that reproduces.
function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0
    return seed / 2 ** 32
  }
}
const PIECES = ["```", "```done", "```ts", "#", "## ", "### ", ">", "> ", "- ", "* ", "+ ", "1. ", "2) ", "**Fixed**", "__Bold__", " ", "  ", "\n", "\n\n", "\t", "word", "Shipped it", "`code`", "[link](https://x.y)", "*em*", "-", "1.", "#hash", ">quote", "—", "é", "title: x", "---"]
function body(next: () => number): string {
  let s = ""
  const n = 1 + Math.floor(next() * 14)
  for (let i = 0; i < n; i++) s += PIECES[Math.floor(next() * PIECES.length)]
  return s
}

test("the first line the phone draws is the same from the head as from the whole body", () => {
  const next = rng(Number(process.env.SEED ?? 20261110))
  for (let i = 0; i < 20_000; i++) {
    const b = body(next)
    assert.deepEqual(handoffLine(doneFenceBodyHead(b)), handoffLine(b), `body ${JSON.stringify(b)}`)
  }
})

test("a phone Done row reads the same line from an elided fence as from the whole one", () => {
  const whole = { kind: "done" as const, body: "## Landed\n\nThe cache fix, and **more**.\n\n- one\n- two", hints: [] }
  const base = { id: "t", title: "T", runtime: "exited", lastAssistant: "```done ## Landed The cache fix", watches: [], questions: [], subAgents: [] } as unknown as ThreadView
  const elided = elideArchivedDoneFence(whole)
  assert.notEqual(elided.body, whole.body)
  assert.deepEqual(rowSecondLine({ ...base, lastFence: elided }, "done" as never, false), rowSecondLine({ ...base, lastFence: whole }, "done" as never, false))
  assert.deepEqual(rowSecondLine({ ...base, lastFence: elided }, "done" as never, false), { text: "Landed" })
})
