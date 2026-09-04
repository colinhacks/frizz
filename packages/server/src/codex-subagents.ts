import { closeSync, openSync, readSync, statSync } from "node:fs"
import { findRolloutsByIds, parseCodexLine, parseCodexSubAgentLine } from "./backend/codex.ts"
import type { CodexSubAgentSignal } from "./backend/codex.ts"

// ---- codex sub-agent tracking ----
// Codex threads spawn REAL sub-agents (`spawn_agent`) — the same "dispatched a child, now resting
// against it" shape Claude's Agent tool has — but every signal for them lives on a different axis than
// NormalizedEvent, so the tailer's codex fold used to drop all of it. The visible symptom: a codex
// worker running nine children reported them in prose while the board showed none, and the thread
// queued as idle. This module is the codex counterpart of the tailer's `trackDispatches`.
//
// It is deliberately a SEPARATE module writing through a narrow sink rather than more branches inside
// tailer.ts: the tailer owns turn state, the queue, and rest — the most safety-critical derivation in
// the server — and this needs its own multi-file cursor bookkeeping. The sink writes into the SAME
// `state.subAgents` / `state.retiredSubAgents` maps the Claude path fills, so every downstream
// consumer (board ops strip, `hasLiveOps`, the completion-hold dialog, the drill-in drawer, the
// sidebar) works on codex threads with no further change.
//
// LIVENESS IS THE HARD PART — it was, at least, before codex >=0.153 started reporting it. The FLAT
// `sub_agent_activity` record had no "completed" kind (corpus-verified: only started/interacted/
// interrupted), and `list_agents` — the one authoritative status snapshot — appears only when the model
// happens to call it. The `SubAgentActivity` ITEM that replaced it does emit "completed", which arrives
// here as a `finished` signal and retires the slot directly. Everything below still runs: it is the
// backstop for a child codex never reports on, and the ONLY liveness there is for the older rollouts
// still on disk. But each child is itself a codex thread with its own rollout
// that brackets turns with the very task_started/task_complete `parseCodexLine` already understands.
// So a child is LIVE while its own rollout's turn is open, and done when it brackets closed. That
// matches codex's own accounting exactly: a child observed completing its second turn at 21:35:25 was
// reported `{completed:…}` by the next `list_agents` eight seconds later.

// A tracked child's terminal outcome, in the vocabulary the tailer's retained ring already uses.
type RetireStatus = "completed" | "failed" | "killed"

// How the tracker publishes into the tailer's live/retired maps. Implemented by the tailer over its
// own private entry types, so this module never imports them (and can be tested with a plain double).
export interface CodexSubAgentSink {
  // Surface (or refresh) a live sub-agent under `id`. Called again on resurrection and once the
  // child's rollout resolves, so `outputFile` may arrive after the first call.
  setLive(id: string, entry: { label: string; startedAt: string; subagentType?: string; outputFile?: string }): void
  // Move `id` out of the live set into the retained ring. A no-op for an id that is not live.
  retire(id: string, finishedAt: string | undefined, status: RetireStatus): void
}

export interface CodexSubAgentDeps {
  sink: CodexSubAgentSink
  codexHome?: string
  // Batch id→rollout-path resolution. Injectable for tests; defaults to one capped sessions-tree walk.
  findRollouts?: (ids: readonly string[]) => Map<string, string>
  // Read everything appended to `path` after `offset`. Undefined = unreadable/not yet created (retry
  // next tick). A shrunken file (rotation) reports `restarted` so the cursor resets rather than
  // silently skipping records.
  readAppended?: (path: string, offset: number) => { text: string; offset: number; restarted: boolean } | undefined
}

// One tracked child. Keyed by its canonical agent path ("/root/linux_bwrap_review") — the id codex
// itself uses in `list_agents`, `send_message`, and every sub_agent_activity record. The dispatch
// `call_id` rides along as the DRAWER key, mirroring Claude's dispatch tool_use id.
interface Slot {
  callId: string
  path: string
  label: string
  threadId: string
  startedAt: string
  subagentType?: string
  rolloutPath?: string
  // Byte cursor into the CHILD's rollout (same discipline as the tailer's own `offset`/`partial`).
  offset: number
  partial: string
  live: boolean
  // Deadline for resolving `rolloutPath`. A child we can never locate must not read as forever-running.
  resolveDeadlineMs: number
}

// A child rollout is written the instant codex starts the child, so resolution normally succeeds on
// the first poll. Keep trying for a couple of minutes to absorb a slow fs / clock skew, then give up
// and retire: an unobservable child held live forever would pin its thread out of the queue.
const RESOLVE_GRACE_MS = 2 * 60_000
// At most one sessions-tree walk per this interval per thread, however many children are unresolved.
const RESOLVE_INTERVAL_MS = 3_000
// A rejected `spawn_agent` never produces a `started`, so pending dispatches are bounded and evicted
// oldest-first rather than trusted to always be consumed.
const PENDING_SPAWNS_MAX = 32
// Retired slots keep their cursor so a resurrected child resumes mid-file instead of re-folding. Bound
// the map so a long orchestration session cannot grow it without limit.
const SLOTS_MAX = 64

export interface CodexSubAgentTracker {
  // Fold one line of the PARENT's rollout. Wired to the tailer's existing `consume(..., onLine)` seam.
  onLine(line: string): void
  // Resolve pending child rollouts and fold their turn brackets. Called once per tailer tick.
  poll(nowMs: number): void
  // Live child count — lets the tailer skip the poll entirely for the (common) childless codex thread.
  liveCount(): number
}

export function createCodexSubAgentTracker(deps: CodexSubAgentDeps): CodexSubAgentTracker {
  const findRollouts = deps.findRollouts ?? ((ids: readonly string[]) => findRolloutsByIds(ids, deps.codexHome))
  const readAppended = deps.readAppended ?? defaultReadAppended
  const slots = new Map<string, Slot>()
  const pendingSpawns = new Map<string, { taskName?: string; subagentType?: string; at?: string }>()
  // call_id → tool name, so a `function_call_output` (which carries no name) can be attributed. Only
  // the two names whose OUTPUT we read are recorded; everything else is never inserted.
  const toolNames = new Map<string, string>()
  let nextResolveMs = 0

  function retire(slot: Slot, at: string | undefined, status: RetireStatus): void {
    if (!slot.live) return
    slot.live = false
    deps.sink.retire(slot.callId, at, status)
  }

  function publish(slot: Slot): void {
    deps.sink.setLive(slot.callId, { label: slot.label, startedAt: slot.startedAt, subagentType: slot.subagentType, outputFile: slot.rolloutPath })
  }

  function evictOldestRetired(): void {
    if (slots.size <= SLOTS_MAX) return
    for (const [path, slot] of slots) {
      if (slot.live) continue
      slots.delete(path)
      if (slots.size <= SLOTS_MAX) return
    }
  }

  function apply(sig: CodexSubAgentSignal): void {
    switch (sig.kind) {
      case "roster-call":
        return // recorded in onLine; the roster arrives on its OUTPUT record
      case "spawn": {
        pendingSpawns.set(sig.callId, { taskName: sig.taskName, subagentType: describeCell(sig.agentType, sig.model, sig.effort), at: sig.at })
        while (pendingSpawns.size > PENDING_SPAWNS_MAX) {
          const oldest = pendingSpawns.keys().next().value
          if (oldest === undefined) break
          pendingSpawns.delete(oldest)
        }
        return
      }
      case "spawn-result": {
        // Only a REJECTED dispatch matters here: it means no child exists and no `started` is coming,
        // so the pending metadata must not linger to be misjoined onto a later call_id collision.
        if (!sig.ok) pendingSpawns.delete(sig.callId)
        return
      }
      case "started": {
        const pending = pendingSpawns.get(sig.callId)
        pendingSpawns.delete(sig.callId)
        // Replacing an existing slot for the same path is correct: codex reuses a task name only once
        // the previous holder is gone, and the new child has a different rollout.
        const previous = slots.get(sig.path)
        if (previous) retire(previous, sig.at, "completed")
        const startedAt = sig.at ?? pending?.at ?? ""
        const slot: Slot = {
          callId: sig.callId,
          path: sig.path,
          label: pending?.taskName ?? agentLabel(sig.path),
          threadId: sig.threadId,
          startedAt,
          subagentType: pending?.subagentType,
          offset: 0,
          partial: "",
          live: true,
          resolveDeadlineMs: 0, // stamped on the first poll, which is the first time we know `now`
        }
        slots.set(sig.path, slot)
        evictOldestRetired()
        publish(slot)
        return
      }
      case "interacted": {
        // The parent sent the child more work. A child that had bracketed closed is working again —
        // resurrect it under its ORIGINAL dispatch id so the drawer/transcript correlation survives.
        const slot = slots.get(sig.path)
        if (!slot || slot.live) return
        slot.live = true
        publish(slot)
        return
      }
      case "interrupted": {
        const slot = slots.get(sig.path)
        if (slot) retire(slot, sig.at, "killed")
        return
      }
      case "finished": {
        // Codex said the child is done. Authoritative, and it lands a beat before folding the child's
        // own rollout could reach the same verdict — but it does NOT replace that fold: a child codex
        // never reports on still has to retire, and every pre-0.153 rollout on disk carries no such
        // record at all. Retiring is idempotent (`retire` no-ops on a slot that is not live), so the
        // two paths racing on the same child is the ordinary case, not a conflict.
        const slot = slots.get(sig.path)
        if (slot) retire(slot, sig.at, "completed")
        return
      }
      case "roster": {
        // An authoritative snapshot. It may only RETIRE or resurrect slots we already know: inventing a
        // slot from a name alone would give us a child with no rollout to observe, which could never be
        // retired and would pin the thread Active forever.
        for (const agent of sig.agents) {
          const slot = slots.get(agent.path)
          if (!slot) continue
          if (agent.status === "completed") retire(slot, sig.at, "completed")
          else if (agent.status === "errored") retire(slot, sig.at, "failed")
          else if (agent.status === "interrupted") retire(slot, sig.at, "killed")
          else if (!slot.live) {
            slot.live = true
            publish(slot)
          }
        }
        return
      }
    }
  }

  return {
    onLine(line: string): void {
      const sig = parseCodexSubAgentLine(line, (id) => toolNames.get(id))
      if (!sig) return
      // A codex tool RESULT names no tool, so remember which call_id each of the two tools we read
      // results from was — per-session state the pure parser can't hold. Bounded by the same eviction
      // as pendingSpawns: only spawn/list calls are ever inserted.
      if (sig.kind === "spawn" || sig.kind === "roster-call") {
        toolNames.set(sig.callId, sig.kind === "spawn" ? "spawn_agent" : "list_agents")
        while (toolNames.size > PENDING_SPAWNS_MAX) {
          const oldest = toolNames.keys().next().value
          if (oldest === undefined) break
          toolNames.delete(oldest)
        }
      }
      apply(sig)
    },

    poll(nowMs: number): void {
      let unresolved: string[] | undefined
      for (const slot of slots.values()) {
        if (!slot.live) continue
        if (!slot.resolveDeadlineMs) slot.resolveDeadlineMs = nowMs + RESOLVE_GRACE_MS
        if (!slot.rolloutPath) {
          if (nowMs > slot.resolveDeadlineMs) {
            // Never located the child's rollout. We cannot observe it, so report it finished rather
            // than leaving an unfalsifiable "running" that would keep the thread out of the queue.
            retire(slot, new Date(nowMs).toISOString(), "completed")
            continue
          }
          ;(unresolved ??= []).push(slot.threadId)
          continue
        }
        foldChild(slot, nowMs)
      }
      if (unresolved?.length && nowMs >= nextResolveMs) {
        nextResolveMs = nowMs + RESOLVE_INTERVAL_MS
        const found = findRollouts(unresolved)
        if (found.size) {
          for (const slot of slots.values()) {
            if (!slot.live || slot.rolloutPath) continue
            const path = found.get(slot.threadId)
            if (!path) continue
            slot.rolloutPath = path
            publish(slot) // re-publish so the entry gains its outputFile (staleness + drawer)
            foldChild(slot, nowMs)
          }
        }
      }
    },

    liveCount(): number {
      let n = 0
      for (const slot of slots.values()) if (slot.live) n++
      return n
    },
  }

  // Fold whatever the child appended since our cursor, watching ONLY its turn brackets. A child whose
  // last bracket is closed has finished the work it was dispatched for (it may still be addressable —
  // `interacted` resurrects it — but it is not work in flight, and must not hold the parent Active).
  function foldChild(slot: Slot, nowMs: number): void {
    const path = slot.rolloutPath
    if (!path) return
    const read = readAppended(path, slot.offset)
    if (!read) return
    if (read.restarted) slot.partial = ""
    slot.offset = read.offset
    if (!read.text) return
    const lines = (slot.partial + read.text).split("\n")
    slot.partial = lines.pop() ?? ""
    let closedAt: string | undefined
    let open = false
    for (const line of lines) {
      for (const ev of parseCodexLine(line)) {
        if (ev.kind === "turn-start") {
          open = true
          closedAt = undefined
        } else if (ev.kind === "turn-end") {
          open = false
          closedAt = ev.at
        }
      }
    }
    if (!open && closedAt !== undefined) retire(slot, closedAt ?? new Date(nowMs).toISOString(), "completed")
  }
}

// The dispatch's model+effort cell, the codex analogue of Claude's `subagent_type` tag
// ("explorer gpt-5.6-terra/high"). Rendered verbatim; absent parts are simply omitted.
function describeCell(agentType?: string, model?: string, effort?: string): string | undefined {
  const cell = model && effort ? `${model}/${effort}` : (model ?? effort)
  const out = [agentType, cell].filter(Boolean).join(" ")
  return out || undefined
}

// "/root/linux_bwrap_review" → "linux_bwrap_review". Only a fallback: the spawn's own `task_name` is
// the label whenever we saw the dispatch (we lose it only when the tail joined mid-file).
function agentLabel(path: string): string {
  const tail = path.split("/").filter(Boolean).pop()
  return tail || path
}

/** Bytes read per call. Well under Node's ~512MB string cap, and a whole rollout in one go. */
const ROLLOUT_READ_WINDOW = 16 * 1024 * 1024

// Read everything appended after `offset`, mirroring the tailer's own `consume`: ENOENT/unreadable →
// undefined (retry next tick), a shrunken file → re-read from the top.
function defaultReadAppended(path: string, offset: number): { text: string; offset: number; restarted: boolean } | undefined {
  let size: number
  try {
    size = statSync(path).size
  } catch {
    return undefined
  }
  const restarted = size < offset
  const from = restarted ? 0 : offset
  if (size <= from) return { text: "", offset: from, restarted }
  try {
    const fd = openSync(path, "r")
    try {
      // BOUNDED PER CALL. This used to read `size - from` and stringify it whole — the exact shape
      // that cost the tailer (4a920a6) and both transcript readers (c71cb4d) their rows: Node caps a
      // string at ~512MB, so a large enough rollout would throw ERR_STRING_TOO_LONG into the
      // `catch { return undefined }` below, whose "retry next tick" is a lie for a permanent error.
      // The largest rollout on this machine is 129MB, so it does not fire today — this is the same
      // defect with headroom, fixed while the pattern is fresh rather than when it reaches the cap.
      //
      // Returning a WINDOW rather than everything is safe without any caller change: the offset comes
      // back advanced by exactly what was returned, and this reader is already called every tick until it
      // catches up. Cutting at the last newline keeps whole records, so a caller that does not buffer
      // a trailing partial cannot see a torn one; a window with no newline at all (a single record
      // longer than the window) yields the whole window, which is what guarantees forward progress.
      const want = Math.min(ROLLOUT_READ_WINDOW, size - from)
      const buf = Buffer.allocUnsafe(want)
      const read = readSync(fd, buf, 0, want, from)
      const lastNl = buf.lastIndexOf(0x0a, read - 1)
      const end = read < size - from && lastNl >= 0 ? lastNl + 1 : read
      return { text: buf.toString("utf8", 0, end), offset: from + end, restarted }
    } finally {
      closeSync(fd)
    }
  } catch {
    return undefined
  }
}
