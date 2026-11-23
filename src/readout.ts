// ── The launcher's terminal readout ────────────────────────────────────────────────────────────────
// What the operator sees while Frizz starts, and the block that stays on screen once it has.
//
// This replaces a single animated line that had to switch itself off (`beginConcurrentLogs`) as soon
// as the forked control-plane child began writing to the same TTY — the launcher cannot clear another
// process' output, so the interesting half of every boot degraded into interleaved `[frizz] …` rows.
// The child is silent on the terminal now (its records go to the run log; `--debug` opens the tap
// again), which leaves exactly one writer here and makes a real repaint safe.
//
// Repainting is deliberately confined to the boot. Once the final block prints, this stops touching
// the cursor for good, so a stray write from a dependency — or a crash stack — can never land on top
// of a region we are still redrawing.

import type { SupervisorActivity } from "@frizz/server/dev-supervisor"

export interface ReadoutOutput {
  isTTY?: boolean
  columns?: number
  write(chunk: string): boolean
}

export type StepState = "pending" | "active" | "done" | "skipped" | "failed"

/** How a post-boot lifecycle line reads: something is happening, it finished, it broke. */
export type NoticeTone = "progress" | "done" | "failed"

export interface Step {
  key: string
  label: string
  state: StepState
  /** The live sub-phase of an active step ("web UI", "waiting for health"). */
  detail?: string
  /** Wall time the step took, filled in when it settles. */
  ms?: number
}

export interface ReadoutOptions {
  output?: ReadoutOutput
  /** Full-feed mode: never repaint, print every record as its own line. */
  debug?: boolean
  /** Disable colour explicitly; otherwise inferred from the stream and NO_COLOR. */
  color?: boolean
  version?: string
  tickMs?: number
  now?: () => number
}

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

// DEC private mode 2026 — "synchronized output". A terminal that understands it buffers everything
// between the two markers and presents the frame at once, so a multi-row repaint cannot be caught
// half-drawn. Terminals that do not understand it ignore an unknown private mode, so this is free.
const SYNC_BEGIN = "\x1b[?2026h"
const SYNC_END = "\x1b[?2026l"

// Sentence case throughout, per the project's copy rule.
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
}

/** Wall-clock HH:MM:SS, the stamp on a beat that lands long after the boot block. */
export function clockTime(ms: number): string {
  const at = new Date(ms)
  return [at.getHours(), at.getMinutes(), at.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":")
}

export function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`
  return `${Math.round(ms / 1_000)}s`
}

/** Shorten an absolute path under $HOME so the block stays narrow and scannable. The remainder may
 *  open with either separator — `C:\Users\op\…` on Windows — or the readout showed every Windows
 *  path in full (Windows audit 2026-09-11, finding 14). */
export function tildePath(path: string, home: string | undefined): string {
  if (!home || !path.startsWith(home)) return path
  const rest = path.slice(home.length)
  return rest === "" ? "~" : /^[\\/]/.test(rest) ? `~${rest}` : path
}

export class Readout {
  private readonly out: ReadoutOutput
  private readonly tty: boolean
  private readonly colorEnabled: boolean
  private readonly debug: boolean
  private readonly version: string | undefined
  private readonly now: () => number
  private readonly startedAt: number
  private readonly steps: Step[] = []
  private frame = 0
  private timer: ReturnType<typeof setInterval> | undefined
  /** Rows currently occupied by the repainting region, so the next paint knows what to erase. */
  private painted = 0
  private stepStartedAt = new Map<string, number>()
  private settled = false
  /** Non-TTY only: suppress repeating an identical status row. */
  private lastPlainLine = ""
  /** Has a post-boot notice printed yet? The first one leads with a blank line, the rest stack. */
  private noticed = false
  /** Lines kept off the screen while a pane has it (`hold`), in order, each stamped when it was noticed. */
  private held: string[] | null = null

  constructor(options: ReadoutOptions = {}) {
    this.out = options.output ?? process.stdout
    this.tty = this.out.isTTY === true
    this.debug = options.debug === true
    this.colorEnabled =
      options.color ?? (this.tty && !process.env.NO_COLOR && process.env.TERM !== "dumb")
    this.version = options.version
    this.now = options.now ?? Date.now
    this.startedAt = this.now()
    // Repainting is for an interactive terminal only. In debug mode the feed owns the screen, and in a
    // pipe there is no cursor to move.
    if (this.tty && !this.debug) {
      const timer = setInterval(() => this.paint(), options.tickMs ?? 80)
      timer.unref?.()
      this.timer = timer
    }
  }

  private c(code: string, text: string): string {
    return this.colorEnabled ? `${code}${text}${ANSI.reset}` : text
  }

  private get width(): number {
    return Math.max(40, this.out.columns ?? 80)
  }

  /** Truncate to the terminal width so a row can never wrap — wrapping desynchronizes the repaint. */
  private fit(line: string): string {
    const limit = this.width - 1
    if (visibleLength(line) <= limit) return line
    return `${sliceVisible(line, limit - 1)}…`
  }

  // ── Steps ────────────────────────────────────────────────────────────────────────────────────────

  /** Declare the boot's shape up front so the operator can see what is still ahead. */
  plan(steps: Array<{ key: string; label: string }>): void {
    for (const step of steps) {
      if (!this.steps.some((existing) => existing.key === step.key)) {
        this.steps.push({ ...step, state: "pending" })
      }
    }
    this.paint(true)
  }

  begin(key: string, detail?: string): void {
    const step = this.steps.find((candidate) => candidate.key === key)
    if (!step) return
    // A step that starts settles whatever came before it; boots do not run steps concurrently.
    for (const earlier of this.steps) {
      if (earlier === step) break
      if (earlier.state === "active") this.settle(earlier.key, "done")
    }
    step.state = "active"
    if (detail !== undefined) step.detail = detail
    this.stepStartedAt.set(key, this.now())
    this.emitPlain(step)
    this.paint(true)
  }

  /** Update the live sub-phase of the active step without changing which step is active. */
  detail(key: string, detail: string): void {
    const step = this.steps.find((candidate) => candidate.key === key)
    if (!step || step.state !== "active") return
    if (step.detail === detail) return
    step.detail = detail
    this.emitPlain(step)
    this.paint(true)
  }

  settle(key: string, state: "done" | "skipped" | "failed", detail?: string): void {
    const step = this.steps.find((candidate) => candidate.key === key)
    if (!step) return
    step.state = state
    // A settled step drops any leftover sub-phase: "starting" described work that is now finished, so
    // keeping it would leave the row reading "done server — starting".
    step.detail = detail
    const startedAt = this.stepStartedAt.get(key)
    if (startedAt !== undefined) step.ms = this.now() - startedAt
    this.emitPlain(step)
    this.paint(true)
  }

  /** The step currently doing work, for a failure message that can name where the boot stopped. */
  activeStep(): Step | undefined {
    return this.steps.find((step) => step.state === "active")
  }

  // ── Painting ─────────────────────────────────────────────────────────────────────────────────────

  private glyph(step: Step): string {
    switch (step.state) {
      case "done":
        return this.c(ANSI.green, "✓")
      case "failed":
        return this.c(ANSI.red, "✗")
      case "skipped":
        return this.c(ANSI.dim, "−")
      case "active":
        return this.c(ANSI.cyan, SPINNER[this.frame % SPINNER.length]!)
      default:
        return this.c(ANSI.dim, "·")
    }
  }

  private stepRow(step: Step): string {
    const elapsed =
      step.state === "active"
        ? formatDuration(this.now() - (this.stepStartedAt.get(step.key) ?? this.now()))
        : step.ms !== undefined && step.ms >= 1_000
        ? formatDuration(step.ms)
        : ""
    // Two spaces between the detail and the duration: a single one ran them together into one token
    // ("716d04203715 33s" read as a single field).
    const tail = [step.detail, elapsed].filter(Boolean).join("  ")
    // A row with nothing to say drops the label padding entirely rather than trailing 12 blanks.
    const label = tail ? step.label.padEnd(18) : step.label
    const styled = step.state === "pending" ? this.c(ANSI.dim, label) : label
    return this.fit(`  ${this.glyph(step)}  ${styled}${tail ? this.c(ANSI.dim, tail) : ""}`)
  }

  private header(): string[] {
    const name = this.c(`${ANSI.bold}${ANSI.magenta}`, "FRIZZ")
    const version = this.version ? ` ${this.c(ANSI.dim, `v${this.version}`)}` : ""
    return ["", `  ${name}${version}`, ""]
  }

  /** Return the cursor to the top of the painted region and clear everything below it. */
  private rewind(): string {
    return this.painted > 0 ? `\x1b[${this.painted}A\r\x1b[0J` : "\r\x1b[0J"
  }

  private paint(force = false): void {
    if (this.settled) return
    if (!this.tty || this.debug) return
    if (!force) this.frame++
    const lines = [...this.header(), ...this.steps.map((step) => this.stepRow(step))]
    this.out.write(`${SYNC_BEGIN}${this.rewind()}${lines.join("\n")}\n${SYNC_END}`)
    this.painted = lines.length
  }

  /**
   * Non-TTY transcript: one settled, parseable row per state change, so a pipe still sees progress.
   *
   * Silent under `--debug`, where the log feed is the authoritative account and these rows were
   * duplicating it in a second format ("frizz: ··· artifact — checking …" immediately beside
   * "INFO artifact Checking …"). The final ready/fail summary still prints in both modes.
   */
  private emitPlain(step: Step): void {
    if (this.tty || this.debug) return
    const mark =
      step.state === "done" ? "done" : step.state === "failed" ? "failed" : step.state === "skipped" ? "skipped" : "···"
    const detail = step.detail ? ` — ${step.detail}` : ""
    const line = `frizz: ${mark} ${step.label.toLowerCase()}${detail}`
    if (line === this.lastPlainLine) return
    this.lastPlainLine = line
    this.out.write(`${line}\n`)
  }

  /**
   * A lifecycle line printed AFTER the ready block — the board restarting, updating, or falling over.
   *
   * The block above it is a snapshot of one moment; these are a timeline, and they arrive minutes or
   * hours later because somebody clicked Restart in a browser or a control-plane child crashed. So
   * this row carries a wall-clock time, which no other row here does: without one, a beat found on
   * a scrolled-back terminal says what happened and gives no way to tell when.
   */
  notice(tone: NoticeTone, label: string, detail?: string): void {
    const glyph = tone === "done" ? this.c(ANSI.green, "✓") : tone === "failed" ? this.c(ANSI.red, "✗") : this.c(ANSI.cyan, "↻")
    if (!this.tty || this.debug) {
      this.out.write(`frizz: ${label.toLowerCase()}${detail ? ` — ${detail}` : ""}\n`)
      return
    }
    // One blank line separates the first beat from the ready block's hint; later beats stack against
    // each other, so a burst (restarting → ready) reads as one event rather than three paragraphs.
    const lead = this.noticed ? "" : "\n"
    this.noticed = true
    const time = this.c(ANSI.dim, clockTime(this.now()))
    const tail = detail ? this.c(ANSI.dim, detail) : ""
    this.write(`${lead}  ${glyph}  ${time}  ${tail ? label.padEnd(12) : label}${tail}`)
  }

  /** Print a line without disturbing the repaint region (used for the debug feed and warnings). */
  note(line: string): void {
    this.write(line)
  }

  /**
   * Keep lines off the terminal while a pane (L, R) has it, and print them once it closes. A pane draws in
   * the alternate screen, so a notice written meanwhile lands across the menu and is gone with it when the
   * pane closes: a restart during an open R menu printed "Restarted" over the menu and nowhere else.
   */
  hold(): void {
    this.held ??= []
  }

  /** Print what `hold` kept, in order, and write straight through again. */
  release(): void {
    const lines = this.held ?? []
    this.held = null
    for (const line of lines) this.write(line)
  }

  /** Put one line on screen, above the repaint region if there still is one. */
  private write(line: string): void {
    if (this.held) {
      this.held.push(line)
      return
    }
    if (this.settled || !this.tty || this.debug) {
      this.out.write(`${line}\n`)
      return
    }
    // Erase the region, print the line so it scrolls above, then repaint beneath it — the technique
    // ink uses, and the reason the repaint region is always the tail of the stream rather than a
    // fixed screen row (a fixed row needs DECSTBM, which survives an abnormal exit and wrecks the
    // operator's shell).
    this.out.write(`${SYNC_BEGIN}${this.rewind()}${this.fit(line)}\n${SYNC_END}`)
    this.painted = 0
    this.paint(true)
  }

  // ── The final block ──────────────────────────────────────────────────────────────────────────────

  /**
   * Replace the boot region with the block that stays on screen, then stop repainting for good.
   * `entries` are the label/value rows: the URL first, then project, source, log path.
   */
  ready(
    entries: Array<{ label: string; value: string; accent?: boolean }>,
    hint?: string,
    options: { status?: string; warning?: string; qr?: string[] } = {},
  ): void {
    for (const step of this.steps) if (step.state === "active") this.settle(step.key, "done")
    const elapsed = formatDuration(this.now() - this.startedAt)
    // A launch that only reopened an already-running server reports what it FOUND. Timing it as
    // "ready in 138ms" described a cold boot that never happened, which read as a suspiciously fast
    // start rather than as a reuse.
    const status = options.status ?? `ready in ${elapsed}`
    this.stop()
    if (!this.tty || this.debug) {
      this.out.write(`frizz: ${status}\n`)
      for (const entry of entries) this.out.write(`frizz: ${entry.label.toLowerCase()}: ${entry.value}\n`)
      if (options.warning) this.out.write(`frizz: warning: ${options.warning}\n`)
      return
    }
    const width = entries.reduce((max, entry) => Math.max(max, entry.label.length), 0) + 1
    const lines = [
      "",
      `  ${this.c(`${ANSI.bold}${ANSI.magenta}`, "FRIZZ")}${
        this.version ? ` ${this.c(ANSI.dim, `v${this.version}`)}` : ""
      }  ${this.c(ANSI.dim, status)}`,
      "",
      // Deliberately NOT truncated. These rows carry an address and a log path the operator has to
      // be able to copy, and a clipped path is worse than a wrapped one. Truncation exists to stop a
      // wrap desynchronizing the repaint region — and this is the last paint, so there is no region
      // left to protect.
      ...entries.map((entry) => {
        const arrow = this.c(ANSI.green, "➜")
        const label = this.c(ANSI.bold, `${entry.label}:`.padEnd(width + 1))
        const value = entry.accent ? this.c(ANSI.cyan, entry.value) : this.c(ANSI.dim, entry.value)
        return `  ${arrow}  ${label} ${value}`
      }),
      // Yellow, above the dim hint: exposing the board off loopback is the one launch outcome the
      // operator must not skim past, so it may not share the hint's low-contrast styling.
      ...(options.qr?.length ? ["", ...options.qr.map((row) => `  ${row}`)] : []),
      ...(options.warning ? ["", `  ${this.c(ANSI.yellow, options.warning)}`] : []),
      ...(hint ? ["", `  ${this.c(ANSI.dim, hint)}`] : []),
      "",
    ]
    // Erase the boot region and leave the final block in the scrollback.
    const rewind = this.painted > 0 ? `\x1b[${this.painted}A\r\x1b[0J` : "\r\x1b[0J"
    this.out.write(`${rewind}${lines.join("\n")}\n`)
    this.painted = 0
  }

  /** Terminal failure: settle the active step as failed, then print the reason and where to look. */
  fail(message: string, logPath?: string): void {
    const active = this.activeStep()
    if (active) this.settle(active.key, "failed")
    this.stop()
    if (!this.tty || this.debug) {
      this.out.write(`frizz: failed: ${message}\n`)
      if (logPath) this.out.write(`frizz: log: ${logPath}\n`)
      return
    }
    const lines = [
      "",
      `  ${this.c(ANSI.red, "✗")}  ${this.c(ANSI.bold, "Frizz could not start")}`,
      "",
      // Not truncated, for the same reason as `ready()`: the operator has to be able to read the whole
      // error and copy the whole path, and nothing repaints after this.
      ...message.split("\n").map((row) => `     ${this.c(ANSI.red, row)}`),
      ...(logPath ? ["", `     ${this.c(ANSI.dim, `Full log: ${logPath}`)}`] : []),
      "",
    ]
    const rewind = this.painted > 0 ? `\x1b[${this.painted}A\r\x1b[0J` : "\r\x1b[0J"
    this.out.write(`${rewind}${lines.join("\n")}\n`)
    this.painted = 0
  }

  /** Stop repainting without printing anything, e.g. before ordinary console output takes over. */
  stop(): void {
    if (this.settled) return
    this.settled = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}

// ── Width helpers ──────────────────────────────────────────────────────────────────────────────────
// Only SGR sequences are ever embedded here, so a simple stripper is enough; a full grapheme-aware
// width would be over-engineering for rows we already keep well inside the terminal.

const SGR = /\x1b\[[0-9;]*m/g

export function visibleLength(line: string): number {
  return line.replace(SGR, "").length
}

/** Take `limit` visible characters, preserving whatever colour codes were already open. */
export function sliceVisible(line: string, limit: number): string {
  let visible = 0
  let out = ""
  for (let index = 0; index < line.length; ) {
    SGR.lastIndex = index
    const match = /^\x1b\[[0-9;]*m/.exec(line.slice(index))
    if (match) {
      out += match[0]
      index += match[0].length
      continue
    }
    if (visible >= limit) break
    out += line[index]
    visible++
    index++
  }
  return `${out}${ANSI.reset}`
}

/**
 * A Readout that only ever prints notices, never a boot region.
 *
 * For a generation that inherited a live terminal mid-run — frizz-dev re-execs itself in place when
 * Update Frizz promotes a new artifact, so the successor owns the same tty with no boot to narrate.
 * Without one of these that successor is mute for the rest of its life, and every later restart it
 * performs is invisible again.
 */
export function noticeOnlyReadout(options: ReadoutOptions = {}): Readout {
  const readout = new Readout(options)
  readout.stop()
  return readout
}

/**
 * Put a supervisor lifecycle beat on the launcher's terminal.
 *
 * Both launchers render these identically, and both had exactly nothing here before: Restart Frizz
 * and Update Frizz are clicked in a browser and a control-plane crash is clicked by nobody, so the
 * foreground process took the board down and brought it back without ever saying so.
 */
export function renderSupervisorActivity(readout: Readout | undefined, event: SupervisorActivity): void {
  if (!readout) return
  switch (event.kind) {
    case "restarting":
      return readout.notice("progress", "Restarting", event.message)
    case "updating":
      return readout.notice("progress", "Updating", event.message)
    case "ready":
      // The duration is the whole point of this row — the message it replaces ("control plane ready")
      // only repeats the glyph. Keep the message for the rare beat that arrives without timing.
      return readout.notice("done", "Restarted", event.ms === undefined ? event.message : `in ${formatDuration(event.ms)}`)
    case "failed":
      return readout.notice("failed", "Failed", event.message)
  }
}
