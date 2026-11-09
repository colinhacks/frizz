// A MONITOR's wakes (`frizzctl monitor add --persistent`, 2026-11-02), composed and read back. The chat draws each as a
// hairline from what parseMonitorWake returns, so every composer is pinned against its parser here — the
// command watch's wakes reached the chat as raw prose for three days because one had no caller.
import { test } from "node:test"
import assert from "node:assert/strict"
import { splitAwaitingFrontmatter } from "./index.ts"
import {
  mergedWakeMessage,
  monitorCancelledWakeMessage,
  monitorEventWakeMessage,
  monitorExitedWakeMessage,
  monitorExpiredWakeMessage,
  monitorLabel,
  MONITOR_FLOOD_REASON,
  MONITOR_STOPPED_BY_HUMAN_REASON,
  parseCommandWatchWake,
  parseMergedWake,
  parseMonitorWake,
} from "./index.ts"

const ID = "cmw_0a1b2c3d4e5f"
const SCRIPT = "tail -F /var/log/app.log | grep --line-buffered -E 'ERROR|FATAL'"

test("an event reads back as its lines, its label and its number — never the trailer", () => {
  const text = monitorEventWakeMessage({ id: ID, label: "errors in app.log", lines: ["ERROR disk full", "FATAL shutting down"], event: 7 })
  assert.match(text, /^📟 Your monitor `cmw_0a1b2c3d4e5f` printed 2 lines \(event 7\) — errors in app\.log\n/)
  assert.match(text, /frizzctl monitor drop cmw_0a1b2c3d4e5f/, "the worker is told how to stop it")
  assert.deepEqual(parseMonitorWake(text), {
    kind: "event", id: ID, label: "errors in app.log", count: 2,
    output: "ERROR disk full\nFATAL shutting down", summary: "Event 7: 2 lines.",
  })
})

test("an event that carried more lines than it shows says so, and the lines that hold backticks stay fenced", () => {
  const text = monitorEventWakeMessage({ id: ID, label: "x", lines: ["```", "one"], more: 12, event: 1 })
  const parsed = parseMonitorWake(text)!
  assert.equal(parsed.count, 14)
  assert.equal(parsed.output, "```\none")
  assert.equal(parsed.summary, "Event 1: 14 lines, 12 not shown.")
})

test("an exit reads back with its code, its event count and the tail it printed", () => {
  const text = monitorExitedWakeMessage({ id: ID, label: "CI on acme/app#62", command: SCRIPT, events: 3, run: { outcome: "exit", exitCode: 1, output: "gh: HTTP 502\n" } })
  assert.deepEqual(parseMonitorWake(text), {
    kind: "exited", id: ID, label: "CI on acme/app#62", count: 3, command: SCRIPT,
    output: "gh: HTTP 502", summary: "The script exited 1 after 3 events.",
  })
  const single = parseMonitorWake(monitorExitedWakeMessage({ id: ID, label: "l", command: "true", events: 1, run: { outcome: "signal", exitCode: null, output: "" } }))!
  assert.equal(single.summary, "The script was killed by a signal after 1 event.")
  assert.equal(single.output, undefined)
})

test("an expiry and a cancellation read back as what ended them", () => {
  assert.deepEqual(parseMonitorWake(monitorExpiredWakeMessage({ id: ID, label: "l", command: SCRIPT, events: 0 })), {
    kind: "expired", id: ID, label: "l", count: 0, command: SCRIPT, summary: "Expired after 0 events; Frizz stopped the script.",
  })
  const floodText = monitorCancelledWakeMessage({ id: ID, label: "errors in app.log", command: SCRIPT, events: 30, reason: MONITOR_FLOOD_REASON })
  assert.match(floodText, /^⚠️ Frizz stopped your monitor `cmw_0a1b2c3d4e5f` after 30 events — errors in app\.log\n\nIt printed 30 events inside 10m/)
  const flood = parseMonitorWake(floodText)!
  assert.deepEqual([flood.kind, flood.by, flood.label, flood.count, flood.command], ["cancelled", "frizz", "errors in app.log", 30, SCRIPT])
  assert.match(flood.summary, /^Frizz stopped it after 30 events\. It printed 30 events inside 10m, .* never raw logs\.$/)
  assert.doesNotMatch(flood.summary, /`/, "the reason reads as prose, its code spans unwrapped")
  // THE HUMAN'S STOP says so, to the worker in the wake and to the reader in the divider.
  const human = parseMonitorWake(monitorCancelledWakeMessage({ id: ID, label: "l", command: SCRIPT, events: 1, reason: MONITOR_STOPPED_BY_HUMAN_REASON, by: "human" }))!
  assert.deepEqual([human.kind, human.by, human.label, human.summary], ["cancelled", "human", "l", "You stopped it from the board after 1 event."])
})

// frizz-server 0.15.42 shipped monitors with an unnamed cancellation, and its wakes stay in transcripts.
test("a cancellation 0.15.42 wrote still reads back", () => {
  const old = `⚠️ Frizz stopped your monitor \`${ID}\` after 2 events: this thread runs in \`default\` permission mode.\n\n\`\`\`sh\n${SCRIPT}\n\`\`\`\n\nNothing about it will wake you now.`
  assert.deepEqual(parseMonitorWake(old), {
    kind: "cancelled", id: ID, by: "frizz", count: 2, command: SCRIPT, summary: "Frizz stopped it after 2 events: this thread runs in default permission mode.",
  })
})

// For an hour on 2026-11-06 every wake said "command watch". Those stay in transcripts, and the chat still draws them.
test("a wake that says command watch still reads back", () => {
  const swap = (text: string) => text.replace("your monitor", "your command watch").replace("Your monitor", "Your command watch")
  const event = monitorEventWakeMessage({ id: ID, label: "l", lines: ["a"], event: 1 })
  const expired = monitorExpiredWakeMessage({ id: ID, label: "l", command: SCRIPT, events: 2 })
  const human = monitorCancelledWakeMessage({ id: ID, label: "l", command: SCRIPT, events: 1, reason: MONITOR_STOPPED_BY_HUMAN_REASON, by: "human" })
  assert.match(swap(event), /^📟 Your command watch /)
  assert.deepEqual(parseMonitorWake(swap(event)), parseMonitorWake(event))
  assert.deepEqual(parseMonitorWake(swap(expired)), parseMonitorWake(expired))
  assert.deepEqual(parseMonitorWake(swap(human)), parseMonitorWake(human))
})

test("a merged delivery of a monitor's wakes splits back into each one", () => {
  const event = monitorEventWakeMessage({ id: ID, label: "l", lines: ["ERROR a"], event: 4 })
  const exited = monitorExitedWakeMessage({ id: ID, label: "l", command: SCRIPT, events: 4, run: { outcome: "exit", exitCode: 0, output: "" } })
  const merged = mergedWakeMessage([{ reason: "monitor event 4", message: event }, { reason: "monitor ended", message: exited }], Date.now())
  assert.deepEqual(parseMergedWake(merged)!.map((p) => parseMonitorWake(p.body)?.kind), ["event", "exited"])
})

test("a monitor's wakes and a command watch's never parse as each other", () => {
  const event = monitorEventWakeMessage({ id: ID, label: "l", lines: ["x"], event: 1 })
  assert.equal(parseCommandWatchWake(event), null)
  assert.equal(parseMonitorWake("✅ Your command watch `cmw_0a1b2c3d4e5f` PASSED — its command exited 0 on check 1 (1 check over 1m):"), null)
  assert.equal(parseMonitorWake(`quoting: ${event}`), null, "only a wake that OPENS with the head")
})

test("a monitor is labelled by its description, else its squeezed command", () => {
  assert.equal(monitorLabel({ command: SCRIPT, description: "  errors\n in app.log " }), "errors in app.log")
  assert.equal(monitorLabel({ command: "  echo   hi  " }), "echo hi")
  assert.equal(monitorLabel({ command: "x".repeat(200) }).length, 80)
})

// The fence key became `monitors:` with the name (2026-11-06). A resumed worker keeps the contract it started
// with, which taught `commands:`, so both name the same registration.
test("`monitors:` and the older `commands:` both name a monitor in a fence", () => {
  const { hints, body } = splitAwaitingFrontmatter("monitors: [cmw_0a1b2c3d4e5f]\ncommands: [cmw_6197f27a1cb0]\nstatus: watching\nfor: 1d\n---\nWaiting on the log.")
  assert.deepEqual(hints.filter((h) => h.kind === "command").map((h) => h.value), ["cmw_0a1b2c3d4e5f", "cmw_6197f27a1cb0"])
  assert.equal(body, "Waiting on the log.")
})
