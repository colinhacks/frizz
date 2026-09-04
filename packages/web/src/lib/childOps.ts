// ── THE CHILD-OPERATION ROW VOCABULARY ───────────────────────────────────────────────────────────
//
// Four surfaces list a thread's CHILD operations — the sidebar rail's sub-agent rows, a queue card's
// live child lines, the drawer's background-ops strip, and the completion-hold dialog. All four render
// the SAME row (an arrow, a liveness mark, a label), and all four were written independently. They
// drifted exactly as duplicated layout always does: two arrow alphas (/45 and /40 — six pixels apart
// on a single queue card, which is how the maintainer caught it), two stale-dot alphas (/30 and /25 at
// the same size with the same tooltip), and three different answers for an id-less child.
//
// These tokens are the ONE source for that vocabulary and `components/ChildOpRow.tsx` is the ONE
// renderer. Nothing else in the web sources may spell the glyph out again — `subAgentArrow.test.ts`
// fails the build if any rendered literal escapes this file.

// U+2937 ARROW POINTING DOWNWARDS THEN CURVING RIGHTWARDS — the one "branches from its parent" glyph,
// established by the sidebar's sub-agent rows and now shared verbatim by every child surface.
export const CHILD_ARROW = "⤷"

// /45, not /40. Two alphas were live at once; the rail (which established the glyph) and the queue card
// used /45, the ops strip and the completion dialog /40. The arrow is the row's STRUCTURAL marker — the
// thing that says "this line hangs off the one above it" — so it takes the brighter of the two rather
// than sitting below the muted label it introduces.
export const CHILD_ARROW_CLASS = "shrink-0 text-[11px] leading-none text-muted/45"

// The flat dot for a child with no recent output. /30 (the rail's value); the ops strip's /25 was the
// outlier and read as a smudge next to the same dot one surface over.
export const CHILD_STALE_DOT_CLASS = "block h-1.5 w-1.5 rounded-full bg-muted/30"
export const CHILD_STALE_TITLE = "stale — no recent output"

// A RESTED child: its run ended (the harness reported completed/failed) while the fan-out IT dispatched
// is still running. A HOLLOW dot of the same 1.5-unit geometry as the stale one — same box, same
// baseline, so nothing on the row shifts — because the reading is "this one stopped" while the rows
// indented beneath it are still pulsing. It is deliberately not the stale dot: stale means "probably
// still working, just quiet", and the action here is the opposite one (steer it, or its children's work
// is stranded).
export const CHILD_RESTED_DOT_CLASS = "block h-1.5 w-1.5 rounded-full border border-muted/45"
export const CHILD_RESTED_TITLE = "rested — it stopped, but the work it launched is still running"

// A tracked background shell/Monitor is a LIVE process even when quiet (its entry only clears on a
// terminal notification), so it breathes rather than showing the flat stale dot — and says so.
export const CHILD_QUIET_SHELL_TITLE = "running — no recent output"

// There is deliberately NO "finished" glyph in this vocabulary. Every mark here means the child is in
// some state of being ALIVE — running, quiet, or stopped-with-live-descendants — so a completed one is
// marked by the ABSENCE of a mark (maintainer 2026-08-01: "remove the status indicator entirely for a
// sub-agent or background shell that has completed"). A static done-dot existed for one commit and was
// removed: it put a mark on nearly every row of a settled transcript while saying nothing the row's own
// runtime reading did not already say.

export const CHILD_OPEN_TITLE = { AGENT: "Open sub-agent transcript", SHELL: "Open background shell output", GITHUB: "Open this pull request on GitHub" } as const

// ── HOW MUCH the child has done — the quiet counter beside its current step ──────────────────────
//
// A live sub-agent used to be a name and a spinner. `activityDetail` (the provider's per-tool-call
// sentence) says what it is doing RIGHT NOW; this says how far it has got. Both come off the Claude
// Agent SDK's typed task stream, so both are absent for a codex child or an older CLI
// — the row must read fine without them, never leave a gap where one would have been.
//
// `toolUses` rides the board signature (it pushes promptly); `tokens` deliberately does NOT (it would
// churn), so it is a slow, secondary reading and must never be styled as something that ticks.
export function childProgressLabel(toolUses?: number, tokens?: number): string | undefined {
  const parts: string[] = []
  if (typeof toolUses === "number" && toolUses > 0) parts.push(`${toolUses} ${toolUses === 1 ? "tool" : "tools"}`)
  const compact = compactCount(tokens)
  if (compact) parts.push(`${compact} tok`)
  return parts.length > 0 ? parts.join(" · ") : undefined
}

// ── HOW MUCH a background SHELL has printed — its live counter ───────────────────────────────────
//
// The row already says how LONG the shell has been running, and for a watcher that is the wrong
// question: "12m" reads identically whether the thing is tailing a build or wedged on a dead socket.
// Lines of output is the reading that separates the two, and it is the one that moves.
//
// ZERO is a real reading here and renders as "0 lines", never as nothing. A shell that has printed
// nothing in twelve minutes is exactly the case this counter exists to expose, and an absent counter
// would be indistinguishable from "frizz cannot read this shell's output" (a codex exec), which is the
// one situation that genuinely has no number. Compare `childProgressLabel`, where zero really does mean
// "the provider has not reported yet".
export function shellLinesLabel(lines: number | undefined): string | undefined {
  if (typeof lines !== "number" || !Number.isFinite(lines) || lines < 0) return undefined
  if (lines === 1) return "1 line"
  return `${compactCount(lines) ?? "0"} lines`
}

// THE SAME COUNTER, FOR A WATCHED PR — what its CI says, in the width the shell row's line count gets.
//
// It exists because the full reading had only one home. `checkCountLine` renders "1 failing, 2 in
// progress, 31 successful" on the AWAITING CARD, which is drawn for a thread at REST — so a thread that
// was working showed nothing at all about a PR it was watching, and the operator had to ask (2026-09-04:
// "It does not appear to me that the PR watcher is working well here"). This strip runs under the prompt
// box on the queue card AND the thread drawer, spinning or not, so the row was already on screen; it
// just had nothing to say.
//
// ONE NUMBER, not the breakdown. The counter column is a glance — it answers "should I look?" and the
// full sentence rides its tooltip. The order is the same severity order the card's line uses, so the two
// surfaces can never lead on different numbers: what is red first, then what is waiting on a human, then
// what is still moving, then what passed.
export function checksCounterLabel(status: {
  checks: string; failed: number; gated: number; running: number; passed: number; state: string
} | undefined): string | undefined {
  // Not polled yet is not a reading. The row's own liveness mark already says the watcher is armed.
  if (!status) return undefined
  if (status.state !== "open") return status.state
  if (status.failed > 0) return `${status.failed} failed`
  // "held" rather than "gated": the row has ~10 characters, and the operator's question is whether
  // something is stuck, not which GitHub noun describes it.
  if (status.gated > 0) return `${status.gated} held`
  if (status.running > 0) return `${status.running} running`
  if (status.passed > 0) return `${status.passed} green`
  return undefined // a PR with no CI at all — nothing to count, and "0" would imply otherwise
}

// 947 → "947", 13476 → "13.5k", 132000 → "132k", 2400000 → "2.4M". A raw six-digit token count next to
// a truncated label is noise; the magnitude is the whole reading. The decimal survives up to three
// significant figures and is dropped past them, where it would only be adding width.
function compactCount(n: number | undefined): string | undefined {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return undefined
  const scale = (value: number, suffix: string) => `${value < 100 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)}${suffix}`
  if (n < 1_000) return String(Math.round(n))
  if (n < 1_000_000) return scale(n / 1_000, "k")
  return scale(n / 1_000_000, "M")
}
// The × on a child row — on EVERY surface that lists children, since 2026-07-30 (maintainer: "the X
// button to stop a sub-agent should show up everywhere sub-agents are listed"). It was an ops-strip-only
// affordance, which meant the rail and the queue card showed the same phantom child and offered no way
// to retire it. WHICH rows may carry it is a property of the ROW (a direct child with an id — see
// lib/dismissChildOp.ts), never of the surface it happens to be rendered on.
//
// The copy is per-STATE, because the × does two different honest things and must claim only the one it
// will actually do. This is the second half of the maintainer's 2026-07-30 ruling — first "the X button
// didn't actually kill the sub-agent", then, when a shell's × cleared the row and confessed in a toast
// that the work was probably still going: "We shouldn't show the X if it doesn't fucking work."
//
//   RUNNING  — the row is only given a × when the server says the child is STOPPABLE
//              (lib/dismissChildOp.ts), so here the word can be "stop" and mean it. It now names the
//              SUBTREE, because that is what the click ends: a stop that reached only the named agent
//              left its own fan-out running and reporting back into this thread, so the server walks
//              the descendants too (router.ts stopSubAgentSubtree). Under-claiming a destructive scope
//              is the same failure as over-claiming one — the operator has to know what the × takes.
//   STALE / RESTED — nothing is running to stop. The × retires a finished op from tracking, which is
//              the phantom escape hatch it was built for, so it says "clear" and promises nothing more.
//
// A running row that cannot be stopped carries no × at all, so no wording is needed for it — the
// absence IS the honesty.
export const CHILD_DISMISS_TITLE = {
  running: "Stop — end this operation and everything it spawned, then clear the row",
  settled: "Clear — stop tracking this finished operation",
} as const
export const CHILD_DISMISS_VERB = { running: "Stop", settled: "Clear" } as const
export const CHILD_DISMISS_NOUN = { AGENT: "sub-agent", SHELL: "background shell", GITHUB: "PR watcher" } as const

// ── LIVENESS FILTERS — the surfaces' policies, in ONE place ──────────────────────────────────────
//
// A child is worth showing while it is live OR stale — "stale" is not "gone", it is "running, but we
// have not seen output in a while", still unresolved work hanging off the thread. The card USED to show
// running-only, so a stale sub-agent vanished from its handoff card while the rail still dimmed it and
// the drawer still listed it — the same cross-surface inconsistency the shared row was built to end
// (maintainer ruling 2026-07-24: unify the card onto the rail's policy). Now:
//
//   card  — running OR stale OR rested. Same set as the rail, minus the rail's id requirement: an
//           id-less child still renders (non-interactive), never silently dropped.
//   rail  — the same set, and only children carrying an `id` (its rows are always drill-in targets;
//           an id-less child from an old snapshot shape has nothing to open, so the rail omits it).
//   sheet — no filter at all. Everything the board reports gets a row.
//
// `rested` joins the visible set for the same reason `stale` did, only more so: the server emits it ONLY
// for a child that still has running work under it (see anchorRoots in tailer.ts), so hiding it would
// hide the live grandchildren indented beneath it — which is exactly the disappearance this vocabulary
// keeps having to fix.

export type ChildOpRecord = { readonly state: string; readonly id?: string }

// ── THE SUBTREE UNDER ONE SUB-AGENT — what a sub-agent DRAWER's ops strip lists ──────────────────
//
// The strip under a THREAD's prompt box lists the thread's whole child forest. The same strip under a
// SUB-AGENT drawer's prompt box has to list only what hangs off THAT child — otherwise a drawer opened
// on one branch would advertise its siblings' work as its own.
//
// The board already carries the tree: every descendant row names its dispatcher in `parentId` (absent
// at depth 1, where the thread itself is the parent). This walks it from `rootId` down, depth-first, so
// the rows come out in the reading order the flat list already uses.
//
// `displayDepth` is a SEPARATE reading from `depth`, and the distinction is load-bearing. `depth` stays
// the row's true distance from the THREAD — `childOpDismisser` keys the × off it (a descendant's
// dispatch lives in an ancestor's transcript, so retiring it by id is a no-op) and re-basing it would
// hand every direct child of this sub-agent an × that silently does nothing. `displayDepth` is purely
// the indent: 1 for a child this sub-agent dispatched itself, so the drawer's column starts flush the
// way the thread's does instead of inheriting a two-step indent from its position in the thread's tree.
export function childOpSubtree<T extends { readonly id?: string; readonly parentId?: string }>(
  ops: readonly T[],
  rootId: string,
): (T & { readonly displayDepth: number })[] {
  const kids = new Map<string, T[]>()
  for (const op of ops) {
    if (!op.parentId) continue
    const list = kids.get(op.parentId)
    if (list) list.push(op)
    else kids.set(op.parentId, [op])
  }
  const out: (T & { displayDepth: number })[] = []
  // A cycle cannot arise from the tailer's own derivation, but this list is foreign data by the time it
  // reaches the client and a self-parented row would spin here forever.
  const seen = new Set<string>([rootId])
  const walk = (parentId: string, displayDepth: number): void => {
    for (const op of kids.get(parentId) ?? []) {
      if (op.id && seen.has(op.id)) continue
      if (op.id) seen.add(op.id)
      out.push({ ...op, displayDepth })
      if (op.id) walk(op.id, displayDepth + 1)
    }
  }
  walk(rootId, 1)
  return out
}

const unresolved = (op: ChildOpRecord): boolean => op.state === "running" || op.state === "stale" || op.state === "rested"

export function visibleChildOps<T extends ChildOpRecord>(ops: readonly T[], surface: "rail"): readonly (T & { id: string })[]
export function visibleChildOps<T extends ChildOpRecord>(ops: readonly T[], surface: "card" | "sheet"): readonly T[]
export function visibleChildOps<T extends ChildOpRecord>(ops: readonly T[], surface: "rail" | "card" | "sheet"): readonly T[] {
  if (surface === "card") return ops.filter(unresolved)
  if (surface === "rail") return ops.filter((op): op is T & { id: string } => Boolean(op.id) && unresolved(op))
  return ops
}

// ── ONE background shell, reported by TWO sources — reconciling them ─────────────────────────────
//
// The ops strip lists a live shell from the board's tracked telemetry (which carries the launching
// tool_use id, so its row drills in) and from the transcript projection (Codex's background execs are
// transcript-native and the older board telemetry reports none for them). A Claude shell shows up in
// BOTH, so the strip has to recognize the two rows as one process.
//
// It used to reconcile on label + startedAt, and that key does not hold. The board's instant is the
// tool_use RECORD's timestamp; the transcript's is the projected MESSAGE's — and an assistant turn whose
// prose lands before its call makes them differ by seconds. Measured on the launch the maintainer caught
// (nub session ccc520d9, 2026-07-31): three records share one message id at 19:11:27.256 (thinking),
// 19:11:28.190 (text) and 19:11:32.200 (the Bash tool_use). The message keeps the FIRST rendered
// record's instant, so the two rows carried startedAt four seconds apart, rendered the identical label
// and identical "8m" duration, and the strip drew both — one clickable, one not.
//
// So the LAUNCH ID is the key: `shellId` off the transcript card is by construction the same tool_use id
// the tailer tracks the shell under. Label+startedAt survives only as the fallback for a transcript from
// a pre-restart server that ships no `shellId` — matching there is better than the duplicate.
export type ShellRecord = { readonly id?: string; readonly label: string; readonly startedAt?: string; readonly command?: string }

// Deliberately NOT folded into `id`: `id` is the drill-in handle, and a transcript row is drawn only
// because the board did NOT track that shell — so there is nothing for a drawer to open. The launch id
// identifies the row; it does not make it clickable.
export type TranscriptShellRecord = ShellRecord & { readonly launchId?: string }

// A CODEX shell is the case where neither key above can work, so it brings a third. Its board row comes
// off the app-server ITEM STREAM and its transcript row off the rollout, and those two sources share NO
// identifier: the stream's `processId` never reaches the rollout (measured in
// server/backend/_live_codex_bgterm_match.mts — the projected row carried no handle at all), and the
// transcript row's label is the model's description of the STEP ("Designing async exec command flow")
// while the board row's is the command. What they DO share is the COMMAND — `sleep 900` on both sides,
// once the launcher's `/bin/zsh -lc '…'` wrapper is stripped server-side (tailer.ts unwrapShellCommand).
//
// A codex BOARD row carries its `command` explicitly for exactly this reason. The key is emitted ONLY
// when a record really has one — never falling back to the label, which would turn two distinct shells
// the model happened to describe identically into one row (mergeBackgroundShells.test.ts guards it).
// A Claude row has no `command`, so it keys exactly as it always did.
const shellKeys = (shell: TranscriptShellRecord): string[] => {
  const launch = shell.launchId ?? shell.id
  return [...(launch ? [`id:${launch}`] : []), ...(shell.command ? [`cmd:${shell.command}`] : []), `launch:${shell.label}\u0000${shell.startedAt ?? ""}`]
}

export function mergeBackgroundShells<T extends ShellRecord>(board: readonly T[], transcript: readonly (T & TranscriptShellRecord)[]): T[] {
  const out = [...board]
  // Every board row is indexed under BOTH identities: keying on the id alone let a transcript row with
  // no `launchId` (a pre-restart server) through, which is the duplicate this whole function exists for.
  const seen = new Set(out.flatMap(shellKeys))
  for (const shell of transcript) {
    if (shellKeys(shell).some((key) => seen.has(key))) continue
    out.push(shell)
  }
  return out
}
