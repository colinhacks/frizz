import assert from "node:assert/strict"
import test from "node:test"
import { AGENT_MARKS, composerRail, GAUGE_GLYPH, GAUGE_MARK, GOAL_GLYPH, markGlyph, MIC_GLYPH, PAPERCLIP_GLYPH, PLUG_GLYPH, PLUG_MARK, SEND_SPLIT_WIDTH } from "./iconRhythm.ts"

// Measured with scripts/ink-gaps.mjs (the table's comment in iconRhythm.ts).
test("without a microphone the rail keeps its measured offsets", () => {
  assert.deepEqual(composerRail({}), { right: { send: 8, paperclip: 42 }, reserve: 78 })
  assert.deepEqual(composerRail({ lead: true }), { right: { send: 8, paperclip: 42, lead: 67 }, reserve: 103 })
})

// Painted px = strokeWidth x (rendered px per viewBox unit). A viewBox or size change that leaves the raw
// `strokeWidth` alone still changes what the eye reads, so the painted width is what is pinned.
const painted = (glyph: { size: number; strokeWidth: number; viewBox?: string }) =>
  glyph.strokeWidth * (glyph.size / (glyph.viewBox ? Number(glyph.viewBox.split(" ")[2]) : 24))

test("every bare mark in the prompt box paints one pen", () => {
  const row14 = 2 * (14 / 24)
  for (const glyph of [PAPERCLIP_GLYPH, GOAL_GLYPH, MIC_GLYPH, PLUG_GLYPH, GAUGE_GLYPH]) {
    assert.ok(Math.abs(painted(glyph) - row14) < 1e-9, `${JSON.stringify(glyph)} paints ${painted(glyph)}`)
  }
})

// The gauge and the plug each keep their fill while their panel is open, so both can be lit at once, and two lit
// squares that overlap paint the overlap twice (maintainer 2026-11-07: "The fact that these overlap is weird").
// Each square reaches its trim past the footprint the row's gap is measured between.
test("the agent's marks' squares stand apart, so two lit at once never overlap", () => {
  const px = (classes: string, utility: string) => Number(new RegExp(`(?:^| )${utility}\\[([\\d.]+)px\\]`).exec(classes)![1])
  const between = px(AGENT_MARKS, "gap-") - px(GAUGE_MARK, "-mx-") - px(PLUG_MARK, "-mx-")
  assert.ok(between >= 2, `the gauge's and the plug's squares stand ${between}px apart`)
})

test("a scaled glyph keeps an even box and its ink centred in it", () => {
  const glyph = markGlyph(12.5)
  assert.equal(glyph.size % 2, 0, "an even box centres on a whole pixel in the 28px square")
  const [x, y, w, h] = glyph.viewBox.split(" ").map(Number)
  assert.equal(x, y)
  assert.equal(w, h)
  assert.ok(Math.abs(x! + w! / 2 - 12) < 1e-9, "the 24-unit grid's centre stays the box's centre")
  assert.ok(Math.abs((24 * glyph.size) / w! - 12.5) < 1e-9, "the 24-unit grid draws at the asked scale")
})

test("the microphone sits beside send and the marks to its left close up behind it", () => {
  const plain = composerRail({ mic: true })
  assert.ok(plain.right.mic! > 8 && plain.right.paperclip! > plain.right.mic!)
  const all = composerRail({ mic: true, lead: true })
  const order = (["send", "mic", "paperclip", "lead"] as const).map((m) => all.right[m]!)
  assert.deepEqual([...order].sort((a, b) => a - b), order, "right to left: send, mic, paperclip, lead")
  assert.equal(all.reserve, all.right.lead! + 28 + 8)
})

// The thread composer's Send is the split button (word, hairline, caret). It is wider than the square
// and nothing else about the rail changes: the same gaps, measured from its left edge instead.
test("a wider Send moves every mark to its left by exactly the extra width, on whole pixels", () => {
  assert.equal(SEND_SPLIT_WIDTH, 69.5)
  const extra = Math.ceil(SEND_SPLIT_WIDTH) - 28
  for (const present of [{}, { lead: true }, { mic: true, lead: true }]) {
    const square = composerRail(present)
    const split = composerRail({ ...present, sendWidth: SEND_SPLIT_WIDTH })
    assert.equal(split.right.send, square.right.send, "Send keeps its inset from the box's right edge")
    for (const mark of ["mic", "paperclip", "lead"] as const) {
      if (square.right[mark] === undefined) continue
      assert.equal(split.right[mark], square.right[mark]! + extra, mark)
      assert.ok(Number.isInteger(split.right[mark]), `${mark} sits on a whole pixel`)
    }
    assert.equal(split.reserve, square.reserve + extra)
  }
})
