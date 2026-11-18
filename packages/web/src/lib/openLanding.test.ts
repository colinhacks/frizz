import assert from "node:assert/strict"
import test from "node:test"
import { landingOffset, landingRows, opensAtRest, SIGN_OFF_LEAD_MAX_PX, type LandingMsgLike, type LandingRowLike } from "./openLanding.ts"

const human = (text = "do it"): LandingMsgLike => ({ role: "user", text })
const said = (text = "working"): LandingMsgLike => ({ role: "assistant", text })
const signed = (text = "done"): LandingMsgLike => ({ role: "assistant", text, signOff: true })
const wake = (): LandingMsgLike => ({ role: "user", text: "CI passed", wake: true })
const row = (messageIndex: number): LandingRowLike => ({ kind: "message", messageIndex })
const HEAD: LandingRowLike = { kind: "head-anchor" }
const FOLD: LandingRowLike = { kind: "fold" }
const TAIL: LandingRowLike = { kind: "interactions" }

test("a thread opens on the landing at rest, and on its tail while its turn is in flight", () => {
  for (const runtime of ["turn-idle", "exited", "none"]) assert.equal(opensAtRest({ runtime }), true, runtime)
  assert.equal(opensAtRest(undefined), true, "a thread the board has not loaded yet")
  // Parked on a permission prompt, the prompt is the tail's…
  for (const runtime of ["running", "spawning", "perm-prompt"]) assert.equal(opensAtRest({ runtime }), false, runtime)
  // …and so is the card of a typed request the human still owes an answer, whatever the process is doing.
  assert.equal(opensAtRest({ runtime: "turn-idle", actionableInteraction: true }), false)
  assert.equal(opensAtRest({ runtime: "turn-idle", actionableInteraction: false }), true)
})

test("a stretch with several sign-offs opens on the human's message and the FIRST of them", () => {
  // An earlier stretch, then: steer, lead, [folded work], sign-off, [wake + work folded], sign-off, [park folded].
  const messages = [human("earlier"), signed("earlier answer"), human("steer"), said("lead"), said("work"), signed("write-up"), wake(), said("more"), signed("CI is green"), wake(), said("parked")]
  const rows = [HEAD, row(0), row(1), row(2), row(3), FOLD, row(5), FOLD, row(8), FOLD, TAIL]
  const landing = landingRows(rows, messages, 10)
  assert.equal(landing.steer, 3, "the human's latest message, not Frizz's wakes after it")
  assert.equal(landing.signOff, 6, "the first sign-off after it, not the newest and not the earlier stretch's")
  assert.equal(landing.fallback, -1)
  assert.equal(landing.steerLeads, false)
})

test("in the queue's window the steer is the list's first message, and the list opens at its top", () => {
  const messages = [human("earlier"), signed("earlier answer"), human("steer"), said("lead"), signed("write-up")]
  // The window cut everything above the steer: its rows start at the steer, under "Load earlier".
  const rows = [HEAD, { kind: "earlier-history" }, row(2), row(3), row(4), TAIL]
  const landing = landingRows(rows, messages, 4)
  assert.deepEqual([landing.steer, landing.signOff, landing.steerLeads], [2, 4, true])
})

test("a page that opens mid-stretch has no steer to show: its first sign-off stands in", () => {
  const messages = [said("work"), said("more"), signed("write-up"), wake(), signed("afterword")]
  const rows = [HEAD, FOLD, row(2), FOLD, row(4), TAIL]
  const landing = landingRows(rows, messages, 4)
  assert.deepEqual([landing.steer, landing.signOff, landing.fallback], [-1, 2, -1])
})

test("a stretch with no sign-off opens on the steer alone, and one with neither on the agent's last words", () => {
  const unsigned = [human("steer"), said("lead"), said("work")]
  assert.deepEqual(landingRows([HEAD, row(0), row(1), row(2), TAIL], unsigned, 2), { steer: 1, signOff: -1, fallback: -1, steerLeads: true })
  const noSteer = [said("work"), { role: "assistant", kind: "event", text: "rested" }, said("last words")]
  assert.equal(landingRows([HEAD, row(0), row(1), row(2), TAIL], noSteer, 2).fallback, 3)
})

test("a sign-off that draws no row of its own is passed over for the next that does", () => {
  const messages = [human("steer"), said("lead"), signed("stated by the resting card"), wake(), signed("drawn")]
  const rows = [HEAD, row(0), row(1), FOLD, row(4), TAIL]
  assert.equal(landingRows(rows, messages, 4).signOff, 4)
})

test("the steer lands at the top when the sign-off starts in the upper part of the pane", () => {
  assert.deepEqual(landingOffset({ steer: 4000, signOff: 4300, fallback: undefined, paneHeight: 800 }), { top: 4000 })
  // Exactly at the line still fits.
  assert.deepEqual(landingOffset({ steer: 4000, signOff: 4480, fallback: undefined, paneHeight: 800 }), { top: 4000 })
})

test("a long steer gives way: the sign-off lands a quarter of the pane down, 160px at most", () => {
  assert.deepEqual(landingOffset({ steer: 4000, signOff: 6500, fallback: undefined, paneHeight: 800 }), { top: 6500 - SIGN_OFF_LEAD_MAX_PX })
  assert.deepEqual(landingOffset({ steer: 4000, signOff: 6500, fallback: undefined, paneHeight: 400 }), { top: 6400 })
  // Never above the steer itself: a pane so short that the lead would overshoot it.
  assert.deepEqual(landingOffset({ steer: 4000, signOff: 4100, fallback: undefined, paneHeight: 100 }), { top: 4075 })
})

test("a row that is not mounted is brought into reach before anything is measured against it", () => {
  assert.deepEqual(landingOffset({ steer: null, signOff: null, fallback: undefined, paneHeight: 800 }), { reach: "steer" })
  // The steer is on screen and the sign-off is not, so they are more than a pane apart.
  assert.deepEqual(landingOffset({ steer: 4000, signOff: null, fallback: undefined, paneHeight: 800 }), { reach: "signOff" })
  assert.deepEqual(landingOffset({ steer: null, signOff: 9000, fallback: undefined, paneHeight: 800 }), { top: 9000 - SIGN_OFF_LEAD_MAX_PX })
  assert.deepEqual(landingOffset({ steer: null, signOff: undefined, fallback: undefined, paneHeight: 800 }), { reach: "steer" })
  assert.deepEqual(landingOffset({ steer: undefined, signOff: null, fallback: undefined, paneHeight: 800 }), { reach: "signOff" })
  assert.deepEqual(landingOffset({ steer: undefined, signOff: undefined, fallback: null, paneHeight: 800 }), { reach: "fallback" })
})

test("with one row of the pair, the landing is that row's", () => {
  assert.deepEqual(landingOffset({ steer: 1200, signOff: undefined, fallback: undefined, paneHeight: 800 }), { top: 1200 })
  assert.deepEqual(landingOffset({ steer: undefined, signOff: 100, fallback: undefined, paneHeight: 800 }), { top: 0 })
  assert.deepEqual(landingOffset({ steer: undefined, signOff: undefined, fallback: 700, paneHeight: 800 }), { top: 700 })
})
