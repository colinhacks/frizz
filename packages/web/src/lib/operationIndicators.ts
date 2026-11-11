// Keep the visual live cue tied to the exact operation record, never to a thread-wide aggregate.
// The tailer currently projects background children as running or stale; accepting a string here
// makes terminal/future states safely non-live by default.
export function isRunningOperation(state: string | undefined): boolean {
  return state === "running"
}

// THE DOT MEANS "A SHELL IS ALIVE RIGHT NOW" — not "a shell was detached".
//
// It briefly meant the narrower thing. The dot was worn by any pending call, so an ordinary Bash that
// was simply taking a while read as a detached job; that was corrected (2026-07-29) by reserving the dot
// for `run_in_background` and giving a pending foreground call a neutral spinner instead. The spinner is
// what did not survive contact: once the mark moved to the head of the row, a long-running foreground
// command was the ONE live thing on screen with no mark in the liveness column, announcing itself
// through a small grey ring at the far edge instead (maintainer 2026-07-30: "we should use the blue dot
// even for non-backgrounded bash scripts that are running for more than like a second or two … instead
// of the spinner").
//
// So detachment is no longer what the hue encodes — RUNTIME KIND is: blue for a shell, accent-yellow for
// a sub-agent, whichever way the shell was launched. What detachment still decides is the reading beside
// the dot ("running" vs "background running" in the tooltip) and, for a tracked op, whether frizz can
// observe it going quiet at all.
//
// `run_in_background` is read straight off the tool input at parse time (transcript.ts — Bash
// `run_in_background: true`, and Monitor, which is always detached), so a detached op is known
// definitively and marks itself the instant it starts: frizz has a real process to point at.
export function hasRunningToolIndicator(status: "pending" | "completed" | "failed" | "cancelled" | undefined, backgroundState?: "background" | "unknown"): boolean {
  return status === "pending" && backgroundState === "background"
}

// A FOREGROUND call has no such process record, so it earns the mark on ELAPSED TIME instead — the
// threshold exists purely to keep the column quiet. Nearly every tool call resolves in well under a
// second, and marking those would strobe a dot on and off for every Read and Grep in a batch, which
// reads as noise rather than as liveness. Two seconds is the point past which a command is one you are
// actually waiting on.
export const FOREGROUND_MARK_AFTER_MS = 2_000

// In progress inside the turn that is running it, with no detached process behind it. "unknown" is
// deliberately excluded: an orphaned poll is a process frizz cannot place, and marking it live would
// assert something nobody has observed.
export function isPendingForegroundTool(status: "pending" | "completed" | "failed" | "cancelled" | undefined, backgroundState?: "background" | "unknown"): boolean {
  return status === "pending" && backgroundState === undefined
}

// …and has it been running long enough to earn the mark? `startedAt` is the emitting assistant message's
// timestamp — the moment the model issued the call.
//
// NO timestamp (a pre-restart server / an older transcript projects messages without `at`) marks the call
// immediately. The threshold is a noise filter, not a liveness claim, so when it cannot be evaluated the
// safe default is the one that still shows a running command — silently hiding live work would be the
// worse failure, and it is exactly what the spinner did NOT do.
export function foregroundToolIsRunning(
  status: "pending" | "completed" | "failed" | "cancelled" | undefined,
  backgroundState: "background" | "unknown" | undefined,
  startedAt: string | undefined,
  nowMs: number,
): boolean {
  if (!isPendingForegroundTool(status, backgroundState)) return false
  const started = startedAt ? Date.parse(startedAt) : Number.NaN
  if (!Number.isFinite(started)) return true
  return nowMs - started >= FOREGROUND_MARK_AFTER_MS
}

type BackgroundTool = {
  name?: string
  status?: "pending" | "completed" | "failed" | "cancelled"
  backgroundState?: "background" | "unknown"
  detail?: string
  desc?: string
  command?: string
}

type LiveBackgroundOperation = {
  label: string
  state: "running" | "stale"
}

// Transcript results describe the launch wrapper, while the board independently tracks the detached
// shell. Match only the stable display labels that both paths derive from the same provider input: a
// model supplied description, or the command's first non-blank line. This lets a still-live watcher
// remain visibly live even if its launch wrapper has already returned "completed".
function operationLabel(value: string | undefined): string | undefined {
  const label = value?.split("\n").find((line) => line.trim())?.trim().replace(/\s+/g, " ")
  return label || undefined
}

export function liveBackgroundOperationState(tool: BackgroundTool, operations: readonly LiveBackgroundOperation[]): "running" | "stale" | undefined {
  // An interrupt receipt may carry the target session id, but it is a completed control action and
  // must never borrow the target's live background telemetry.
  if (tool.name === "Interrupt process") return undefined
  // A shell the operator RETIRED with the × is cancelled, and it must stay dead. Matching is by display
  // LABEL, so a relaunched shell carrying the same `desc` would otherwise hand its liveness back to the
  // killed card — the "it came back reading RUNNING · 3433 MIN" failure, re-entered through the front
  // door. `completed` is deliberately still eligible: a launch wrapper returns long before the watcher
  // it detached stops running, which is the whole reason this correlation exists.
  if (tool.status === "cancelled") return undefined
  if (tool.backgroundState !== "background") return undefined
  const candidates = new Set([operationLabel(tool.desc), operationLabel(tool.detail), operationLabel(tool.command)].filter((value): value is string => Boolean(value)))
  if (candidates.size === 0) return undefined
  const matches = operations.filter((operation) => candidates.has(operationLabel(operation.label) ?? ""))
  if (matches.some((operation) => operation.state === "running")) return "running"
  return matches.some((operation) => operation.state === "stale") ? "stale" : undefined
}
