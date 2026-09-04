import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const chat = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")
const queue = readFileSync(new URL("./TodosView.tsx", import.meta.url), "utf8")

// A completion registered with `mcp__frizz__done` is in no message, so the transcript's fence parser
// never draws it — and until 2026-08-27 nothing else did either: the thread rested on a prose handoff
// with no card at its end, on the thread page, on /full and on the queue card alike. These pin the
// wiring: the card is the LAST rung of the runtime-status ladder, above the residual rung.
//
// They used to pin it TWICE — once per transcript path — and pin each path's own gate beside it, because
// the ladder was written out in both and a rung without its gate is a card that never renders (a gate
// without its rung is the empty slot of 2026-08-25, one surface over). The ladder is ONE function now
// (runtimeStatusRung) and both gates are that one call, so there is no second copy to keep honest and no
// gate that can disagree with it: what is left to pin is the ORDER of the rungs, and that the gate is
// derived rather than restated.

test("both transcript paths compute the predicate off the final assistant message", () => {
  const sites = chat.match(/const registeredDone = showsRegisteredDoneCard\(thread, lastAgentIdx >= 0 \? \w+\[lastAgentIdx\]\?\.text : undefined\)/g) ?? []
  assert.equal(sites.length, 2, "one per transcript path (plain and virtualized)")
})

test("the card is the last rung of the one ladder, after the resting card", () => {
  const ladder = chat.match(/function runtimeStatusRung\([\s\S]*?\n}/)?.[0]
  assert.ok(ladder, "runtimeStatusRung must exist")
  assert.match(
    ladder,
    /if \(showsRestingCard\(thread\)\) return "resting"\n\s*if \(registeredDone\) return "registered-done"\n\s*if \(restedCard\) return "rested"\n\s*return null/,
    "the resting card, then the registered done, then the residual rung, then nothing",
  )
  // …and each of those rungs draws its own card, in the one renderer both paths call.
  assert.match(chat, /case "registered-done":\n\s*return <FenceCard fenceKind="done" body=\{thread!\.lastFence!\.body\} hints=\{\[\]\} \/>/)
  assert.match(chat, /case "rested":\n\s*return <RestedCard thread=\{thread!\} \/>/)
})

test("every gate is the ladder's own answer, so the slot opens exactly when a rung renders", () => {
  assert.match(chat, /\{tailReady && runtimeStatusRung\(runtimeStatus\) !== null && \(/, "the plain path's spacer gate")
  assert.match(chat, /const hasRuntimeStatus = runtimeStatusRung\(runtimeStatus\) !== null/, "the virtualized path's row gate")
  // The spacing is the same answer again: only the Working… rung is a meta line rather than a card.
  assert.match(chat, /runtimeStatusRung\(state\) === "working" \? workingIndicatorGap\(messages\) : STEP/)
  // Nothing may re-derive the ladder by hand beside it. Three calls decide it, and no fourth spelling.
  assert.equal(chat.match(/showsSnoozeCard\(thread\)/g)?.length, 1, "the ladder is the only place a rung is tested")
})

test("the queue card draws the same card off the same predicate", () => {
  assert.match(queue, /showsRegisteredDoneCard\(thread, lastAgentIdx >= 0 \? messages\[lastAgentIdx\]\?\.text : undefined\) && \(/)
  assert.match(queue, /<FenceCard fenceKind="done" body=\{thread\.lastFence!\.body\} hints=\{\[\]\} wrap \/>/)
  assert.match(queue, /showsRestedCard\(thread, lastAgentIdx >= 0 \? messages\[lastAgentIdx\]\?\.text : undefined\) && \(/)
})
