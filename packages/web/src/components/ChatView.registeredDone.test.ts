import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const chat = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")

// A completion registered with `mcp__frizz__done` is in no message, so the transcript's fence parser
// never draws it — and until 2026-08-27 nothing else did either: the thread rested on a prose handoff
// with no card at its end, on the thread page, on /full and on the queue card alike. These pin the
// wiring: the card is the LAST rung of the runtime-status ladder, above the residual rung.
//
// They used to pin it once per transcript path, and each path's own gate beside it, because the ladder was
// written out in every surface and a rung without its gate is a card that never renders (a gate without its
// rung is the empty slot of 2026-08-25, one surface over). The ladder is ONE function (runtimeStatusRung),
// its inputs ONE model (useRuntimeTail) and its drawing ONE component (RuntimeStatusSlot) for every surface
// since 2026-10-14, so what is left to pin is the ORDER of the rungs, and that nothing derives them twice.

test("the slot's model computes the predicate once, off the final assistant message", () => {
  const model = chat.match(/export function useRuntimeTail\([\s\S]*?\n}/)?.[0]
  assert.ok(model, "useRuntimeTail must exist")
  assert.match(model, /const last = lastAgentIdx >= 0 \? messages\[lastAgentIdx\] : undefined/)
  assert.match(model, /registeredDone: showsRegisteredDoneCard\(thread, last\?\.text\)/)
  assert.match(model, /restedCard: showsRestedCard\(thread, last\?\.text, last\?\.refusedFences\)/)
  for (const derive of ["showsRegisteredDoneCard(", "showsRestedCard(", "providerErrorVisible("]) {
    assert.equal(chat.split(derive).length - 1, 1, `${derive} is the model's call, and nothing else's`)
  }
})

test("the card is the last rung of the one ladder, after the resting card", () => {
  const ladder = chat.match(/function runtimeStatusRung\([\s\S]*?\n}/)?.[0]
  assert.ok(ladder, "runtimeStatusRung must exist")
  assert.match(
    ladder,
    /if \(showsRestingCard\(thread\)\) return "resting"\n\s*if \(registeredDone\) return "registered-done"\n\s*if \(restedCard\) return "rested"\n\s*return null/,
    "the resting card, then the registered done, then the residual rung, then nothing",
  )
  // …and each of those rungs draws its own card, in the one renderer every surface calls.
  // The fence's HINTS ride along: a registered done carries the worker's `title:` there (2026-10-13). The
  // BODY is the whole one: an archived thread's board view carries only its head (lib/registeredDoneBody),
  // so the card draws what that hook reads, and nothing until it has it.
  assert.match(chat, /case "registered-done":\n\s*return <RegisteredDoneCard thread=\{thread!\} \/>/)
  const card = chat.match(/function RegisteredDoneCard\([\s\S]*?\n}/)?.[0]
  assert.ok(card, "RegisteredDoneCard must exist")
  assert.match(card, /const body = useRegisteredDoneBody\(thread\)\n\s*if \(body === undefined\) return null\n\s*return <FenceCard fenceKind="done" body=\{body\} hints=\{thread\.lastFence!\.hints\} \/>/)
  assert.match(chat, /case "rested":\n\s*return <RestedCard thread=\{thread!\} \/>/)
})

test("every gate is the ladder's own answer, so the slot opens exactly when a rung renders", () => {
  assert.match(chat, /const rung = runtimeStatusRung\(state\)\n/, "the model asks the ladder once")
  assert.match(chat, /shown: rung !== null \|\| Boolean\(thread\?\.permPolicy\)/, "the slot draws for a rung, or for the denial beside it")
  assert.match(chat, /const hasRuntimeRow = runtimeTail\.shown/, "the virtualized row exists exactly when the slot draws")
  // The spacing is the same answer again: only the Working… rung is a meta line rather than a card.
  assert.match(chat, /runtimeStatusRung\(state\) === "working" \? workingIndicatorGap\(messages\) : STEP/)
  // Nothing may re-derive the ladder by hand beside it. Three calls decide it, and no fourth spelling.
  assert.equal(chat.match(/showsSnoozeCard\(thread\)/g)?.length, 1, "the ladder is the only place a rung is tested")
})

// The queue card drew its own copy of this chain until 2026-10-09, and fed the same model into the same
// slot until the one-thread pane replaced it (2026-11-09). Nothing may draw a rung by hand beside the slot.
test("every surface draws the slot through the one component", () => {
  assert.match(chat, /<RuntimeStatusSlot tail=\{runtimeTail\} \/>/, "the thread view's row draws the slot")
  assert.equal(chat.match(/<RuntimeStatusSlot\b/g)?.length, 1, "the thread view's row is the slot's one site")
  assert.equal(chat.match(/<RuntimeStatusLadder\b/g)?.length, 1, "the slot is the ladder's one caller")
})
