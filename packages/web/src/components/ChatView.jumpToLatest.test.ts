import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

// "Jump to latest" on a virtualized transcript must:
// 1. Cancel any active opening landing (openHoldFrameRef / openLandRef / anchorRestoreUntilRef) when
//    clicked — the pill is portalled into a sibling of the scroller and is a <button> that
//    onTranscriptControl filters out, so an active 900ms openAtRest hold otherwise overwrote the jump back
//    to the landing offset on the very next frame and left the click dead.
// 2. Re-attach tail-follow immediately and jump with `behavior: "instant"` rather than `"smooth"`: across
//    unmeasured virtual rows, a smooth scroll passes through every intermediate row in the transcript, and
//    each row that mounts and resizes from its 108px estimate changes scrollHeight, causing virtual-core's
//    reconcileScroll to re-issue scrollTo({ behavior: "smooth" }) and reset the browser's ease-in velocity
//    to zero on every row (measured on a 183-message thread: 46 scrollTo restarts over 4.1s).

const chatView = readFileSync(new URL("./ChatView.tsx", import.meta.url), "utf8")

test("Jump to latest cancels any active open-landing hold and jumps to the tail immediately", () => {
  const jumpIdx = chatView.indexOf("<JumpToLatest")
  assert.ok(jumpIdx >= 0, "VirtualizedThreadTranscript renders JumpToLatest")
  const block = chatView.slice(jumpIdx, jumpIdx + 1600)
  assert.match(block, /cancelAnimationFrame\(openHoldFrameRef\.current\)/)
  assert.match(block, /openLandRef\.current = null/)
  assert.match(block, /anchorRestoreUntilRef\.current = 0/)
  assert.match(block, /setOpening\(false\)/)
  assert.match(block, /followingTailRef\.current = true/)
  assert.match(block, /tailHeightRef\.current = -1/)
  assert.match(block, /setAtEnd\(true\)/)
  assert.match(block, /virtualizer\.scrollToEnd\(\{ behavior: "instant" \}\)/)
  assert.doesNotMatch(block, /scrollToEnd\(\{ behavior: "smooth" \}\)/)
})
