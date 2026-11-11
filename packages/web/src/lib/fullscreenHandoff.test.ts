import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { anchorCandidates, type MessageBand } from "./fullscreenHandoff.ts"

// A 900px window whose reading area starts at the top of the screen.
const WINDOW = { top: 0, bottom: 900 }

function band(sourceId: string | undefined, top: number, height = 200): MessageBand {
  return { sourceId, top, bottom: top + height }
}

test("the reader's own place is carried, topmost first", () => {
  const candidates = anchorCandidates([
    band("a", -600), // scrolled well past
    band("b", -150), // running off the top — this is where the reader's screen begins
    band("c", 60),
    band("d", 280),
    band("e", 2000), // below the fold
  ], WINDOW)
  assert.deepEqual(candidates.map((c) => c.sourceId), ["b", "c", "d"])
  // The screen Y is carried verbatim, negative included: restoring the top message to where it actually
  // was is what leaves every line below it at the height it already had.
  assert.equal(candidates[0].screenTop, -150)
})

test("a reader who can already see the end gets no hand-off — the tail is what they want", () => {
  assert.deepEqual(anchorCandidates([band("a", 100), band("b", 400, 300)], WINDOW), [])
  // One pixel of the last message past the fold is enough to mean they are NOT at the end.
  assert.equal(anchorCandidates([band("a", 100), band("b", 400, 501)], WINDOW).length, 2)
})

test("nothing on screen, nothing to carry", () => {
  assert.deepEqual(anchorCandidates([], WINDOW), [])
  // Every band above the reading area, and the last one below it: no visible message, so no anchor.
  assert.deepEqual(anchorCandidates([band("a", -900), band("b", -400, 300)], WINDOW), [])
})

test("a message with no id is skipped, not carried as a blank", () => {
  const candidates = anchorCandidates([band(undefined, 10), band("b", 220), band("c", 3000)], WINDOW)
  assert.deepEqual(candidates.map((c) => c.sourceId), ["b"])
})

test("the reading box is the drawer's pane, not the window", () => {
  // Same bands, read through a pane that starts at 120: the message ending at 100 is behind the drawer's
  // header and must not be the anchor, even though its rect is on screen.
  const bands = [band("a", -20, 120), band("b", 140), band("c", 3000)]
  assert.deepEqual(anchorCandidates(bands, { top: 120, bottom: 880 }).map((c) => c.sourceId), ["b"])
  assert.deepEqual(anchorCandidates(bands, WINDOW).map((c) => c.sourceId), ["a", "b"])
})

test("the candidate list is bounded", () => {
  const bands = Array.from({ length: 40 }, (_, i) => band(`m${i}`, i * 20))
  assert.equal(anchorCandidates(bands, WINDOW).length, 6)
})

// The two ends find each other by ONE identifier, which every surface's transcript rows stamp.
test("the transcript rows stamp the source id the hand-off looks messages up by", () => {
  const chat = readFileSync(new URL("../components/ChatView.tsx", import.meta.url), "utf8")
  const door = readFileSync(new URL("../components/ExpandThreadLink.tsx", import.meta.url), "utf8")
  assert.match(chat, /data-transcript-source-id=\{row\.kind === "message" \? row\.message\.sourceId : undefined\}/)
  // The door reads the surface and captures unconditionally — a reader on reduced motion needs the
  // place kept MORE than one watching an animation, so the capture must not sit behind the animate gate.
  assert.match(door, /captureFullscreenEnterAnchor\(surface, slug\)/)
  assert.ok(
    door.indexOf("captureFullscreenEnterAnchor(surface, slug)") < door.indexOf("if (animate && surface)"),
    "the capture must run before, and outside, the animation branch",
  )
})
