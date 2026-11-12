import { proxy, subscribe } from "valtio"
import type { QueueDirection } from "../groups.ts"
import { DEFAULT_SNOOZE_PRESET, isSnoozePreset, type SnoozePreset } from "./snooze.ts"

// Client-only VIEW preferences — persisted in localStorage, never in the server Settings schema
// (that's operator dispatch config; this is how one browser likes to render). Seeded synchronously
// from localStorage so the first paint already reflects the saved choice, then mirrored back on
// every change. Components read via useSnapshot(prefs).
const KEY = "frizz.prefs.v1"

export interface Prefs {
  // The PHONE's snooze length: the duration the board's swipe snoozes for, set in Settings and by a pick
  // in the ⋯ sheet. The desktop snooze menu neither reads nor writes it — every click there lists every
  // preset (SnoozeMenu.tsx), because a remembered default made one click mean different spans on
  // different days. A custom date is deliberately one-off and never overwrites this reusable preset.
  snoozePreset: SnoozePreset
  // Direction the Needs-you queue + the sidebar's rested band order by. FIFO (default) surfaces the
  // longest-waiting item first so the human cycles through everything; LIFO surfaces the most recently
  // active first. See groups.ts orderQueue.
  queueOrder: QueueDirection
  // The fullscreen rail's "Edited files" group folded to its heading (maintainer 2026-09-03: "make
  // Edited Files collapsible"). Open by default — the list is the rail's one non-wait group and the
  // reason the page has a rail at all — and remembered here rather than in the store because a
  // 22-file list a human folded once should stay folded on the next thread and the next reload.
  railFilesCollapsed: boolean
  // The prompt box's on-device dictation microphone (lib/dictation.ts). On by default; off for an
  // operator who dictates with a system-wide tool and does not want a second microphone in the box
  // (maintainer 2026-10-10, using Wispr Flow).
  dictation: boolean
  // Long lines in code blocks and Edit diffs wrap (the default, maintainer 2026-10-13: "code blocks
  // should auto-wrap, just like the prompt box") or keep to one line and scroll their block sideways.
  // lib/codeWrap.ts mirrors it onto <html>, where the stylesheet reads it.
  wrapCode: boolean
  // MCP servers the operator told the prompt box's plug menu to IGNORE: `<backend>:<server>` → the state
  // it was in when ignored. An ignored server keeps its row (dimmed, last) but no longer puts the dot on
  // the plug — until its state changes, when the entry is dropped (components/McpPlug.tsx). Per browser,
  // like the rest of this file: it decides what this window draws, not what the agent mounts.
  mcpIgnored: Record<string, string>
  // What Mark as done does to a PINNED thread: keep the pin (the default, maintainer 2026-10-26: "I often
  // have a lot of things pinned intentionally, and I mark them as done. I want them to stay visible") or
  // take it off the pinned list too. Ticked in the done card's split button (ThreadLifecycle
  // DonePinChoice), and read by every completion in this browser (lib/completionPins.ts).
  doneUnpins: boolean
}

function stringRecord(v: unknown): Record<string, string> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return {}
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"))
}

function coerceQueueOrder(v: unknown, fallback: QueueDirection): QueueDirection {
  return v === "fifo" || v === "lifo" ? v : fallback
}

// Keys a retired setting left behind in stored blobs, dropped on read so the spread below does not
// carry them into the proxy and back out to localStorage forever. `compactDiffs` was the Settings
// "Density" switch (retired 2026-10-20 — diffs always open collapsed now, see DiffBlock) and
// `diffsRedefaulted` the marker of its one-time 2026-07-09 migration.
const RETIRED_KEYS = ["compactDiffs", "diffsRedefaulted"]

export function parseStoredPrefs(raw: string | null): Prefs {
  const fallback: Prefs = {
    snoozePreset: DEFAULT_SNOOZE_PRESET,
    queueOrder: "fifo",
    railFilesCollapsed: false,
    dictation: true,
    wrapCode: true,
    mcpIgnored: {},
    doneUnpins: false,
  }
  try {
    if (!raw) return fallback
    const stored = JSON.parse(raw) as Partial<Prefs> & Record<string, unknown>
    for (const key of RETIRED_KEYS) delete stored[key]
    return {
      ...fallback,
      ...stored,
      snoozePreset: isSnoozePreset(stored.snoozePreset) ? stored.snoozePreset : fallback.snoozePreset,
      queueOrder: coerceQueueOrder(stored.queueOrder, fallback.queueOrder),
      railFilesCollapsed: typeof stored.railFilesCollapsed === "boolean" ? stored.railFilesCollapsed : fallback.railFilesCollapsed,
      dictation: typeof stored.dictation === "boolean" ? stored.dictation : fallback.dictation,
      wrapCode: typeof stored.wrapCode === "boolean" ? stored.wrapCode : fallback.wrapCode,
      mcpIgnored: stringRecord(stored.mcpIgnored),
      doneUnpins: typeof stored.doneUnpins === "boolean" ? stored.doneUnpins : fallback.doneUnpins,
    }
  } catch {
    return fallback
  }
}

function seed(): Prefs {
  try {
    return parseStoredPrefs(typeof localStorage === "undefined" ? null : localStorage.getItem(KEY))
  } catch {
    return parseStoredPrefs(null)
  }
}

export const prefs = proxy<Prefs>(seed())

subscribe(prefs, () => {
  try {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(prefs))
  } catch {
    /* private mode / quota — the in-memory proxy still drives this session */
  }
})
