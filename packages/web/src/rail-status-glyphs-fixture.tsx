import { createRoot } from "react-dom/client"
import type { ThreadView } from "@frizz/shared"
import { ThreadIndicator } from "./components/Sidebar.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import "./styles.css"

// THIS APP RENDERS IN TWO FONTS and every TEXT mark here (the "?" and the "!") carries a different ink
// position in each — a fixture that never sets `data-font` silently measures the MONO default, which is
// how the "?" came to ship with a nudge fitted in a font the maintainer does not use. `?font=sans`
// measures the other one; both readings live beside the constant in Sidebar.tsx.
document.documentElement.dataset.font = new URLSearchParams(location.search).get("font") === "sans" ? "sans" : "mono"

// EVERY RAIL STATUS MARK, side by side, drawn by the REAL <ThreadIndicator/> — the measuring surface for
// scripts/verify-rail-status-glyphs.mjs. The rail is a checkbox family (one 15px rounded box, a
// different mark inside per state), and a family only reads as one when the marks carry comparable
// optical WEIGHT. That is a pixel question no DOM measurement can answer, so the marks have to render
// somewhere a screenshot can reach them, isolated from row titles and hover affordances.
//
// It renders the shipped component rather than a mock-up on purpose: a reconstruction drifts from the
// thing that ships, and this exists precisely to catch a mark that is wrong in the app.

const base = {
  kind: "session",
  state: "open",
  status: "active",
  mechanism: null,
  backend: "claude",
  permissionMode: "default",
  humanBlocked: false,
  pendingQuestion: false,
  crashed: false,
  archived: false,
  foreign: false,
  ready: false,
  unread: false,
  hasPlan: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  subAgents: [],
  bgShells: [],
  spawnedAt: "2026-08-01T09:00:00.000Z",
} as const

const liveChild = [{ id: "a1", label: "c", startedAt: "2026-08-01T09:05:00.000Z", state: "running" as const }]

const monitorWatch = {
  id: "command:monitor:cmw_0123456789ab", kind: "command", target: "cmw_0123456789ab", state: "armed", createdAt: "2026-11-03T09:00:00.000Z",
  command: { command: "tail -n0 -F app.log | grep --line-buffered ERROR", every: "0s", expiresAt: "2099-11-04T09:00:00.000Z", runs: 0, monitor: { description: "Errors in app.log", events: 3 } },
}

// One thread per state the rail can resolve, named by the kind sessionIndicatorKind returns for it.
const STATES: { kind: string; t: ThreadView }[] = [
  // OWN TURN RUNNING: the empty spinner. Until 2026-09-20 this slot was a turn-idle parent with a live
  // child, which resolves to the same kind — but that shape now draws the ellipsis INSIDE the spinner
  // (Sidebar.tsx, the `working` arm reading groups.restingOnSubAgents), so it has its own slot below.
  { kind: "working", t: { ...base, id: "working", runtime: "running", needsYou: false } as unknown as ThreadView },
  // A PARENT AT REST WITH ITS SUB-AGENTS OUT: the spinner around the ellipsis. `needsYou: false` because
  // the server excuses a rest on live own work from the queue, so the row sits in the Running band.
  { kind: "children", t: { ...base, id: "children", runtime: "turn-idle", needsYou: false, subAgents: liveChild } as unknown as ThreadView },
  // A RUNNING THREAD WITH AN OPEN REGISTERED QUESTION (2026-10-08): the static "?" inside the spinner.
  // The worker kept going after it asked, so the server holds it out of the queue (`needsYou: false`).
  { kind: "working-asking", t: { ...base, id: "working-asking", runtime: "running", needsYou: false, questions: [{ id: "qst_ab12cd34", spec: { question: "Merge it?", kind: "question" }, askedAt: "2026-10-08T09:00:00.000Z" }] } as unknown as ThreadView },
  // Shell-only, deliberately: a live sub-agent resolves to `working`, not to this mark. `needsYou: false`
  // because the server excuses a rest on live own work from the queue outright.
  { kind: "background", t: { ...base, id: "background", runtime: "turn-idle", needsYou: false, awaitingBackground: true, bgShells: [{ label: "nub run dev", startedAt: "2026-08-01T09:02:00.000Z", state: "running" }] } as unknown as ThreadView },
  // No background shell on this one, deliberately: the blue dot outranks the heart since 2026-08-02, so
  // a thread carrying both resolves to `background` and the heart would never render here to be measured.
  { kind: "rest", t: { ...base, id: "rest", runtime: "turn-idle", needsYou: true } as unknown as ThreadView },
  { kind: "needs-input", t: { ...base, id: "needs-input", runtime: "turn-idle", needsYou: true, pendingQuestion: true } as unknown as ThreadView },
  { kind: "stalled", t: { ...base, id: "stalled", runtime: "exited", needsYou: true, sessionId: "s" } as unknown as ThreadView },
  // Killed by a usage limit, auto-resume promised: the accent hourglass (2026-08-31) — same box weight
  // family as the [!] beside it, same hourglass ink as the muted snoozed mark two over.
  { kind: "limit", t: { ...base, id: "limit", runtime: "exited", needsYou: true, sessionId: "s", limitPause: { backend: "claude", window: "session", at: "2026-08-01T00:00:00.000Z", autoResume: true } } as unknown as ThreadView },
  { kind: "done", t: { ...base, id: "done", runtime: "turn-idle", needsYou: true, lastFence: { kind: "done", body: "shipped", hints: [] } } as unknown as ThreadView },
  // A TIMER park, deliberately: this slot measures the Snoozed band's GLYPH, and since 2026-08-31 a park
  // on a shell or a sub-agent draws the blue dot instead (Sidebar.tsx shellDot — one mark for "a shell is
  // alive behind this", whichever band the row sits in). A `shell` hint here would therefore render a
  // second copy of the `background` dot two entries up and leave the park glyph unmeasured.
  { kind: "snoozed", t: { ...base, id: "snoozed", runtime: "turn-idle", needsYou: false, lastFence: { kind: "awaiting", body: "", hints: [{ kind: "timer", value: "tmr_a1b2c3d4e5f6" }] } } as unknown as ThreadView },
  // THE HUMAN'S OWN SNOOZE (2026-09-19): a wall-clock park the operator set, no fence. It resolves to the
  // same `snoozed` kind as the slot above but draws the alarm clock (Sidebar.tsx alarmMark) rather than
  // the worker's hourglass, so it needs its own slot to be measured at all.
  { kind: "user-snoozed", t: { ...base, id: "user-snoozed", runtime: "turn-idle", needsYou: false, snoozedUntil: "2099-09-19T16:00:00.000Z" } as unknown as ThreadView },
  // AWAITING A TIMER, IN THE QUEUE (2026-09-07). A REGISTERED armed timer, queued, no fence — the shape
  // a worker that armed `frizzctl timer` and rested leaves behind, and the row that wore the blue dot.
  // It draws the same hourglass as the `snoozed` slot (Sidebar.tsx hourglassMark), so the two measure
  // identically by construction; the slot exists so the QUEUED arm is what gets measured.
  { kind: "timer", t: { ...base, id: "timer", runtime: "turn-idle", needsYou: true, awaitingBackground: true, watches: [{ id: "timer:t:tmr_1", kind: "timer", target: "tmr_1", state: "armed", createdAt: "2026-09-07T09:00:00.000Z", timer: { fireAt: "2099-09-07T16:00:00.000Z", prompt: "re-check the deploy" } }] } as unknown as ThreadView },
  // AWAITING A MONITOR (2026-11-03): the radio (Sidebar.tsx monitorMark). Queued — a `needs_input` rest
  // beside a REGISTERED armed monitor, no fence — and parked `watching` with the fence naming it, which is
  // where the board files most monitor parks; both draw the same mark, so both arms are measured.
  { kind: "monitor", t: { ...base, id: "monitor", runtime: "turn-idle", needsYou: true, awaitingBackground: true, watches: [monitorWatch] } as unknown as ThreadView },
  { kind: "monitor-snoozed", t: { ...base, id: "monitor-snoozed", runtime: "turn-idle", needsYou: false, awaitingBackground: true, waitStatus: "watching", watches: [monitorWatch], lastFence: { kind: "awaiting", body: "", hints: [{ kind: "command", value: "cmw_0123456789ab" }, { kind: "status", value: "watching" }] } } as unknown as ThreadView },
  { kind: "archived", t: { ...base, id: "archived", state: "archived", runtime: "exited", needsYou: false } as unknown as ThreadView },
  // AWAITING A PR (2026-09-04). A REGISTERED watch and no fence, deliberately: that is the shape the
  // worker contract now steers workers toward, and it is the one the rail used to miss entirely. The
  // octocat is the only mark here whose ink is not symmetric about its own viewBox centre, so it is the
  // one that needs a measured nudge rather than an odd size — see PR_MARK_NUDGE in Sidebar.tsx.
  { kind: "pr", t: { ...base, id: "pr", runtime: "turn-idle", needsYou: true, watches: [{ id: "wch_1", kind: "github", target: "colinhacks/frizz#1", state: "armed", createdAt: "2026-09-04T09:00:00.000Z" }] } as unknown as ThreadView },
  // AWAITING A PR WHOSE CHECKS ARE RUNNING (2026-09-20): the same octocat inside the spinner. The server
  // holds this thread in the Running band (board.heldByRunningChecks), so `needsYou: false`.
  { kind: "pr-running", t: { ...base, id: "pr-running", runtime: "turn-idle", needsYou: false, awaitingBackground: true, watches: [{ id: "wch_2", kind: "github", target: "colinhacks/frizz#2", state: "armed", createdAt: "2026-09-20T09:00:00.000Z", github: { checks: "running", running: 2, passed: 1, failed: 0, skipped: 0, gated: 0, gating: [], failing: [], merge: "unknown", state: "open", polledAt: "2026-09-20T09:01:00.000Z" } }] } as unknown as ThreadView },
  // GATED CI READS `running` BUT DOES NOT SPIN: nothing moves until a maintainer approves the workflows,
  // so the row wears the static octocat (groups.prChecksRunning refuses `running === 0 && gated > 0`).
  { kind: "pr-gated", t: { ...base, id: "pr-gated", runtime: "turn-idle", needsYou: true, watches: [{ id: "wch_3", kind: "github", target: "colinhacks/frizz#3", state: "armed", createdAt: "2026-09-20T09:00:00.000Z", github: { checks: "running", running: 0, passed: 0, failed: 0, skipped: 0, gated: 3, gating: ["Test Linux", "Test macOS", "Linters"], failing: [], merge: "unknown", state: "open", polledAt: "2026-09-20T09:01:00.000Z" } }] } as unknown as ThreadView },
]

createRoot(document.getElementById("root")!).render(
  <TooltipProvider>
    {/* Flat panel background, matching the rail's own surface — the ink probe reads "anything that
        differs from the corner pixel", so the surface behind every mark must be one flat colour. */}
    <div data-rail-glyphs className="flex items-center gap-6 bg-bg p-6">
      {STATES.map(({ kind, t }) => (
        <span key={kind} className="flex items-center justify-center" title={kind}>
          <ThreadIndicator t={t} />
        </span>
      ))}
    </div>
  </TooltipProvider>,
)
