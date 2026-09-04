// Conformance gate for the two vendors' TRANSCRIPT FORMATS — the logs Frizz folds to build the board.
//
// This is the sibling of codex-protocol-conformance.test.ts, aimed at the other half of the seam. That
// one asks "do the fields we SEND still exist?"; this one asks "do the fields we READ still exist?" —
// and the second question is the one that has actually cost the product.
//
// WHAT WENT WRONG, and what this would have caught. Codex 0.153 respelled its rollout: every semantic
// event moved onto ONE `event_msg/item_completed` envelope carrying a typed `item`, and the flat
// `agent_message` / `user_message` / `sub_agent_activity` payloads Frizz read were no longer written at
// all. Nothing threw. The fold simply returned EMPTY — zero assistant text, zero user turns, zero
// sub-agents — while the turn brackets, which did not move, kept working. So a thread went in-flight
// and came to rest perfectly, with no title, no preview, no fences and no children on the board. A
// silent-empty failure of exactly this kind cannot be caught by a fixture test: the fixtures were
// captured from the OLD binary and kept passing.
//
// The evidence that DOES catch it is already on the machine. Both vendors stamp their own build into
// the transcript they write — Codex in `session_meta.payload.cli_version`, Claude on every record's
// `version` — so a real transcript written by the PINNED build is a free, unfaked sample of the format
// that build emits. This test finds the newest such transcript and folds it through the production
// path, then asserts the things that went to zero are not zero.
//
// It asserts PRESENCE, never content: that the fold saw records, that it recovered the human's turn and
// the agent's reply, that tools and turn brackets registered. Those are the board's inputs. Nothing
// read here is ever printed — a failure message names a field and a count, never a transcript, a path,
// or a byte of what the operator or the model said.
//
// SKIPS, loudly, when this machine has no transcript from the pinned build: a fresh checkout, CI, or a
// pin that was bumped before anything has run on it. A skip is honest — it says the format is UNPROVEN
// for that pin, which is exactly the state a bump leaves behind until a worker has run. It must never
// read as a pass, so the skip reason names the pin it could not find.
import assert from "node:assert/strict"
import { test } from "node:test"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { CLAUDE_CODE_VERSION } from "../runtimes.ts"
import { newTailState } from "../tailer.ts"
import { createClaudeBackend } from "./claude.ts"
import { CODEX_APP_SERVER_SUPPORTED_VERSION } from "./codex-app-server.ts"
import { createCodexBackend, defaultCodexHome, parseCodexLine } from "./codex.ts"

// How many recent transcripts to look through before giving up. A machine that runs Frizz writes these
// constantly, so the pinned build's samples are near the front; this bound keeps the test off the
// operator's whole history (which reaches back a year here) and keeps its runtime flat.
const CANDIDATES = 60
// Below this a transcript is a warm-up, a probe or an aborted boot — real vendor output, but not a
// SESSION, so it would assert nothing about the format and would fail for the wrong reason.
const MIN_RECORDS = 12
// A transcript still being appended to may legitimately have no CLOSED turn yet, which would fail the
// turn-bracket assertion for a reason that is not a format change. Settled means the session stopped
// writing long enough ago that its brackets are whatever they are going to be.
const SETTLED_MS = 10 * 60 * 1000

interface Sample {
  path: string
  lines: string[]
}

// HOW A SAMPLE IS CHOSEN, and the one thing that must not creep into it: the selection may only read
// STABLE SESSION METADATA (the build stamp, whether the session has a parent, how big it is, how long
// ago it stopped). It must never select on the records the assertions are about — "find a rollout
// containing a user message, then assert the fold finds a user message" is a test that can only pass.
// The corollary is that a change to the metadata itself lands as a SKIP rather than a failure, which
// is why the skip reason says the format is unproven rather than saying nothing.
//
// Among the qualifying candidates it takes the LARGEST, not the newest. A short session is real vendor
// output that happens to exercise two record types; the biggest recent one exercises all of them, and
// picking it is what stops the verdict depending on which thread the operator last ran.
function largest(samples: Sample[]): Sample | undefined {
  return samples.sort((a, b) => b.lines.length - a.lines.length)[0]
}

/** Every file matching `match` under `dir`, newest first, capped. Missing directories read as empty. */
function newestFiles(dir: string, match: (name: string) => boolean, depth = 4): { path: string; mtimeMs: number }[] {
  const found: { path: string; mtimeMs: number }[] = []
  const walk = (at: string, left: number) => {
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(at, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(at, entry.name)
      if (entry.isDirectory()) {
        if (left > 0) walk(full, left - 1)
        continue
      }
      if (!entry.isFile() || !match(entry.name)) continue
      try {
        found.push({ path: full, mtimeMs: statSync(full).mtimeMs })
      } catch {}
    }
  }
  walk(dir, depth)
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs)
}

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0)
  } catch {
    return []
  }
}

/** The best Codex rollout this machine holds that the PINNED codex wrote, or undefined. */
function pinnedCodexRollout(): Sample | undefined {
  const sessions = join(defaultCodexHome(), "sessions")
  const settledBefore = Date.now() - SETTLED_MS
  const qualifying: Sample[] = []
  for (const { path, mtimeMs } of newestFiles(sessions, (n) => n.startsWith("rollout-") && n.endsWith(".jsonl")).slice(0, CANDIDATES)) {
    if (mtimeMs > settledBefore) continue
    const lines = readLines(path)
    if (lines.length < MIN_RECORDS) continue
    // `session_meta` is the rollout's first record and the only one that names the build.
    let meta: { type?: string; payload?: { cli_version?: unknown; parent_thread_id?: unknown; agent_path?: unknown } } | undefined
    try {
      meta = JSON.parse(lines[0]!) as typeof meta
    } catch {
      continue
    }
    if (meta?.type !== "session_meta") continue
    if (meta.payload?.cli_version !== CODEX_APP_SERVER_SUPPORTED_VERSION) continue
    // A SUB-AGENT's rollout is not a session: a child is handed its task as developer instructions and
    // never receives a human turn, so it legitimately carries no UserMessage and would fail the user
    // assertion for a reason that has nothing to do with the format. Codex names a child twice over in
    // its own session_meta — the thread it hangs off, and the agent path it was spawned as.
    if (meta.payload.parent_thread_id != null || meta.payload.agent_path != null) continue
    qualifying.push({ path, lines })
  }
  return largest(qualifying)
}

/** The best Claude transcript this machine holds that the PINNED Claude Code wrote, or undefined. */
function pinnedClaudeTranscript(): Sample | undefined {
  const projects = join(homedir(), ".claude", "projects")
  const settledBefore = Date.now() - SETTLED_MS
  const qualifying: Sample[] = []
  for (const { path, mtimeMs } of newestFiles(projects, (n) => n.endsWith(".jsonl"), 2).slice(0, CANDIDATES)) {
    if (mtimeMs > settledBefore) continue
    const lines = readLines(path)
    if (lines.length < MIN_RECORDS) continue
    // Claude stamps `version` on every substantive record (the sidecar bookkeeping rows carry none), so
    // a transcript belongs to the pinned build when a stamped record says so and none disagrees. A
    // session that spanned an upgrade names both; that one is not a clean sample, so it is passed over.
    const stamps = new Set<string>()
    for (const line of lines) {
      try {
        const version = (JSON.parse(line) as { version?: unknown }).version
        if (typeof version === "string") stamps.add(version)
      } catch {}
    }
    if (stamps.size !== 1 || !stamps.has(CLAUDE_CODE_VERSION)) continue
    qualifying.push({ path, lines })
  }
  return largest(qualifying)
}

// ---- codex -----------------------------------------------------------------------------------------

const codexSample = pinnedCodexRollout()
const codexSkip = codexSample
  ? false
  : `no rollout written by the pinned codex ${CODEX_APP_SERVER_SUPPORTED_VERSION} is on this machine, so its rollout format is UNPROVEN — run a codex thread, or re-check after the next dispatch`

test(`the pinned codex ${CODEX_APP_SERVER_SUPPORTED_VERSION} still writes a rollout the fold can read`, { skip: codexSkip }, () => {
  const backend = createCodexBackend()
  const state = newTailState("conformance", "session", "/nonexistent")
  for (const line of codexSample!.lines) backend.foldLine(state, line)

  // The four that went to zero on 0.153, stated as the board reads them.
  assert.equal(state.sawRecords, true, "the fold consumed no records at all — the rollout envelope moved")
  assert.ok(state.lastActivityAt, "no record carried a readable timestamp — every rest time and sort key comes from this")
  assert.ok(
    (state.firstUserText ?? "").length > 0,
    "the fold recovered NO human turn from a real session — an external thread would have no name and no first prompt",
  )
  assert.ok(
    (state.lastAssistant ?? "").length > 0,
    "the fold recovered NO assistant text from a real session — the board would show an empty preview and parse no fences",
  )
})

test(`the pinned codex ${CODEX_APP_SERVER_SUPPORTED_VERSION} still emits every event kind the derivation needs`, { skip: codexSkip }, () => {
  const kinds = new Map<string, number>()
  for (const line of codexSample!.lines) {
    for (const event of parseCodexLine(line)) kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1)
  }
  // Counted rather than merely present: a respelling that leaves ONE recognised record standing (which
  // is what "the turn brackets still worked" was) must not read as a healthy parse.
  const required: [string, string][] = [
    ["turn-start", "turns would never go in-flight — the spinner and the queue both hang off this bracket"],
    ["turn-end", "turns would never close — every thread would sit in-flight forever"],
    ["assistant-text", "no assistant output would reach the board: no preview, no title, no signal fence"],
    ["user-message", "no human turn would register — row order and external-session naming both read it"],
    ["tool-call", "no tool activity would render, and the sub-agent tracker reads its call ids"],
  ]
  for (const [kind, consequence] of required) {
    assert.ok((kinds.get(kind) ?? 0) > 0, `parseCodexLine found no '${kind}' in a real pinned-codex rollout — ${consequence}`)
  }
})

// ---- claude ----------------------------------------------------------------------------------------

const claudeSample = pinnedClaudeTranscript()
const claudeSkip = claudeSample
  ? false
  : `no transcript written by the pinned Claude Code ${CLAUDE_CODE_VERSION} is on this machine, so its transcript format is UNPROVEN — run a Claude thread, or re-check after the next dispatch`

test(`the pinned Claude Code ${CLAUDE_CODE_VERSION} still writes a transcript the fold can read`, { skip: claudeSkip }, () => {
  const backend = createClaudeBackend({ logDir: "/nonexistent" })
  const state = newTailState("conformance", "session", "/nonexistent")
  for (const line of claudeSample!.lines) backend.foldLine(state, line)

  assert.equal(state.sawRecords, true, "the fold consumed no records at all — the record envelope moved")
  assert.ok(state.lastActivityAt, "no record carried a readable timestamp — every rest time and sort key comes from this")
  assert.ok(
    (state.firstUserText ?? "").length > 0,
    "the fold recovered NO human turn from a real session — an external thread would have no name and no first prompt",
  )
  assert.ok(
    (state.lastAssistant ?? "").length > 0,
    "the fold recovered NO assistant text from a real session — the board would show an empty preview and parse no fences",
  )
  // Claude's turn model is inferred from the last record's kind + stop_reason rather than from explicit
  // brackets, so these two ARE the bracket: without them computeTurn falls back to a 5 s silence guess
  // on every thread.
  assert.ok(state.lastKind, "no record classified as assistant or user — the whole turn model reads these two kinds")
  assert.ok(
    state.ownedToolUseIds.size > 0,
    "no tool_use id was folded from a real session — completion-report ownership is keyed on this set, and an empty one re-attributes other threads' reports",
  )
  // Both vendors report their own context accounting, and the footer's fullness readout is a reading
  // rather than an estimate precisely because of that. A moved `usage` bag would blank it silently.
  assert.ok(
    typeof state.contextTokens === "number" && state.contextTokens > 0,
    "no context reading was folded — message.usage moved, and the footer's fullness readout would go blank",
  )
})
