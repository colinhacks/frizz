import assert from "node:assert/strict"
import test from "node:test"
import type { BgShellView } from "@frizz/shared"
import { mergeBackgroundShells } from "./childOps.ts"

// ONE background shell, TWO reporters. The board's tracked telemetry knows the launching tool_use id;
// the transcript projection knows only what the rendered message carries. The ops strip lists both and
// must draw ONE row.
//
// The regression these pin (maintainer, 2026-07-31, screenshot of two identical "Building release
// candidate and launcher" rows — "One background shell is clickable. The other is not"): the old key was
// label + startedAt, and the two sources DO NOT SHARE AN INSTANT. The board's is the tool_use record's
// timestamp; the transcript's is the projected message's, and a turn whose thinking and prose land before
// its call splits them by seconds. Real bytes from that launch (nub session ccc520d9): one message id
// spanning 19:11:27.256 / 19:11:28.190 / 19:11:32.200, the last being the Bash call.

const board: BgShellView = { id: "toolu_01Voy", label: "Building release candidate and launcher", startedAt: "2026-07-31T19:11:32.200Z", state: "running" }

test("the same shell reported by both sources collapses onto its launch id, however far the instants drift", () => {
  const merged = mergeBackgroundShells<BgShellView>([board], [
    { label: "Building release candidate and launcher", startedAt: "2026-07-31T19:11:28.190Z", state: "running", launchId: "toolu_01Voy" },
  ])
  assert.equal(merged.length, 1, "two reporters, one process, one row")
  assert.equal(merged[0], board, "and the surviving row is the BOARD's — the one carrying the drill-in id")
})

test("a transcript-only shell still gets its row — this is codex's whole path", () => {
  const merged = mergeBackgroundShells<BgShellView>([], [{ label: "Watching CI", startedAt: "2026-07-31T19:00:00.000Z", state: "running" }])
  assert.equal(merged.length, 1)
  assert.equal(merged[0].id, undefined, "no id ⇒ the row renders non-interactive, never dropped")
})

test("label+startedAt survives as the fallback for a transcript with no launch id", () => {
  // A pre-restart server ships no `shellId`. Matching on the old key is still better than the duplicate.
  const merged = mergeBackgroundShells<BgShellView>([board], [
    { label: "Building release candidate and launcher", startedAt: "2026-07-31T19:11:32.200Z", state: "running" },
  ])
  assert.equal(merged.length, 1)
})

test("two genuinely distinct shells the model described identically both keep their row", () => {
  const merged = mergeBackgroundShells<BgShellView>(
    [board, { id: "toolu_02Zzz", label: "Building release candidate and launcher", startedAt: "2026-07-31T19:20:00.000Z", state: "running" }],
    [],
  )
  assert.equal(merged.length, 2, "the id is the identity — a shared label is not a collision")
})

test("a transcript row whose launch id is unknown to the board is not swallowed by a same-label board row", () => {
  const merged = mergeBackgroundShells<BgShellView>([board], [
    { label: "Building release candidate and launcher", startedAt: "2026-07-31T19:40:00.000Z", state: "running", launchId: "toolu_03Qqq" },
  ])
  assert.equal(merged.length, 2)
})

// ── CODEX: one process, two sources that share no identifier ────────────────────────────────────
//
// A codex shell reaches the strip twice over, from sources with nothing in common. The BOARD row is
// folded from the app-server's item stream (its id is the `processId`, its label is the command); the
// TRANSCRIPT row is projected from the rollout (no launch id at all — the processId never reaches the
// rollout — and its label is the model's description of the step). Before the `cmd:` key they drew as
// two rows for one process, and only one of them carried the ×.

test("a codex shell reported by both sources collapses on its COMMAND", () => {
  const merged = mergeBackgroundShells<BgShellView>(
    [{ id: "24573", label: "sleep 900", command: "sleep 900", startedAt: "2026-08-01T19:00:00.000Z", state: "running", stoppable: true }],
    [{ label: "Designing async exec command flow", command: "sleep 900", startedAt: "2026-08-01T19:00:04.000Z", state: "running" }],
  )
  assert.equal(merged.length, 1, "the labels differ and the instants differ; the command is the identity")
  assert.equal(merged[0]!.stoppable, true, "and the surviving row is the one that can actually be stopped")
})

test("the command key never fires off a bare label — two same-named shells stay two rows", () => {
  // The guard on the clause above. `command` is set ONLY where frizz really knows it (a codex row);
  // falling back to the label would make two shells the model described identically collide, which is
  // the exact regression the id-is-the-identity test above exists to prevent.
  const merged = mergeBackgroundShells<BgShellView>(
    [{ id: "toolu_a", label: "Watching CI", startedAt: "2026-08-01T19:00:00.000Z", state: "running" },
     { id: "toolu_b", label: "Watching CI", startedAt: "2026-08-01T19:10:00.000Z", state: "running" }],
    [],
  )
  assert.equal(merged.length, 2)
})
