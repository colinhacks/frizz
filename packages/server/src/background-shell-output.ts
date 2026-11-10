import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs"

const OUTPUT_TAIL_BYTES = 512 * 1024
// One delta read. Sized so a chatty dev server (tens of KB between 1.5s polls) is one syscall.
const SCAN_CHUNK_BYTES = 256 * 1024
// The most this will ever scan for ONE file, across its whole life. A first sight of an already-huge
// log is the only place this bites; past it the shell simply reports no counter, which is honest —
// a row with no reading is what every shell showed before this existed.
const SCAN_CEILING_BYTES = 128 * 1024 * 1024
// Cache entries are per output FILE and a machine accumulates them one per background shell ever run.
// Bounded by insertion order: the oldest entry is the least likely to still be polled.
const SCAN_CACHE_LIMIT = 512
// Identity bytes held from the file's head. ino+birthtime alone cannot prove identity on Linux: ext4
// reuses a freed inode immediately and the timestamp clock ticks coarsely (1–4ms), so an
// unlink-and-recreate inside one tick can collide on BOTH. The head bytes settle it for any
// replacement whose content differs, at the cost of one extra 64-byte pread per poll.
const FINGERPRINT_BYTES = 64
const ANSI_ESCAPE_RE = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g

export interface BackgroundShellOutput {
  output: string
  truncated: boolean
}

/**
 * Is `path` shaped like a background task's output file, `…/tasks/<task id>.output`? With `taskId`, that
 * task's and no other. Shape only: nothing is read. The tailer asks this before it keeps a path a tool
 * result named, because that text is the command's own output (tailer.ts launchOutputFile).
 */
export function isTaskOutputPath(path: string, taskId?: string): boolean {
  const match = /[\\/]tasks[\\/]([\w-]+)\.output$/.exec(path)
  return match !== null && (taskId === undefined || match[1] === taskId)
}

/**
 * The path a shell's output may be READ from, or undefined. The shape again, because a path kept by an
 * older build sits in the tail cache and was never asked, and a regular file that is not a symbolic
 * link: a repository can ship `tasks/x.output` pointing anywhere, and this file's bytes go to the page.
 */
export function readableTaskOutput(path: string | undefined): string | undefined {
  if (!path || !isTaskOutputPath(path)) return undefined
  try {
    return lstatSync(path).isFile() ? path : undefined
  } catch {
    return undefined
  }
}

// Background task files are an undifferentiated process stream: Claude does not preserve stdout vs
// stderr channel identity. Read only the newest bounded tail so a long-lived server cannot make one
// drawer allocate or render an unbounded log. ANSI/OSC controls are presentation noise in a plain DOM
// surface; carriage-return progress updates become readable lines instead of overprinting.
export function readBackgroundShellOutput(path: string, maxBytes = OUTPUT_TAIL_BYTES): BackgroundShellOutput {
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const size = fstatSync(fd).size
    const length = Math.min(size, maxBytes)
    const offset = Math.max(0, size - length)
    const buffer = Buffer.alloc(length)
    let read = 0
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, offset + read)
      if (count === 0) break
      read += count
    }
    const output = buffer.subarray(0, read).toString("utf8").replace(ANSI_ESCAPE_RE, "").replace(/\r(?!\n)/g, "\n")
    return { output, truncated: offset > 0 }
  } catch {
    return { output: "", truncated: false }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// How far this file has been counted, so the next poll scans only what arrived since. `breaks` counts
// LINE TERMINATORS, not lines — the displayed count adds the trailing partial line back on, and only a
// running total of terminators composes across chunk boundaries.
interface ScanState {
  // The FILE these totals describe. A rotated log (same path, new file) can be larger than the totals
  // it replaced, so a size comparison alone would silently keep counting on top of a stranger's bytes.
  // The inode alone is not identity either: ext4 reuses a freed inode number immediately, so a
  // replacement written right after an unlink routinely lands on the SAME ino (measured on Ubuntu
  // 24.04, 2026-08-24 — the rotation test failed there 3 !== 5). Birth time disambiguates: an append
  // never changes it, a new file gets a new one, and a filesystem without birth times reports a
  // constant (0), which merely degrades to the old ino-only check.
  ino: number
  birthtimeMs: number
  // The first min(64, size-at-first-scan) bytes, latin1 — see FINGERPRINT_BYTES for why ino+birthtime
  // are not enough. Empty when the file was empty at first scan, which is safe: there were no counted
  // bytes for a replacement to inherit.
  fingerprint: string
  bytes: number
  breaks: number
  // The delta boundary can fall between the \r and the \n of one CRLF. Without this the \n opens the
  // next scan looking like a break of its own and every CRLF line gets counted twice.
  pendingCR: boolean
  // Output ends mid-line ⇒ that partial line is still a line you can see, so it counts.
  trailing: boolean
  // The file passed SCAN_CEILING_BYTES. Sticky: re-deciding per poll would re-scan a huge file forever.
  overflowed: boolean
}
const scans = new Map<string, ScanState>()

// Latin1 keeps the comparison byte-exact without utf8 replacement-character collisions.
function readHead(fd: number, length: number): string {
  if (length <= 0) return ""
  const buffer = Buffer.alloc(length)
  let read = 0
  while (read < length) {
    const count = readSync(fd, buffer, read, length - read, read)
    if (count === 0) break
    read += count
  }
  return buffer.subarray(0, read).toString("latin1")
}

// LINES OF OUTPUT this background shell has produced — the row's live counter, and the one reading that
// separates "this watcher is alive and printing" from "this watcher is wedged". Undefined when the file
// cannot be read or is past the scan ceiling; the row then shows no counter rather than a made-up one.
//
// Counted INCREMENTALLY. A dev server that has written 40 MB is scanned once; every poll after that
// reads only the bytes that arrived since, so an open thread with three live shells costs three stats
// and three short reads per poll — not three full-file scans.
//
// A bare \r counts as a break, matching `readBackgroundShellOutput`'s `\r → \n` rewrite: a progress bar
// that overprints one line reads as many lines in the drawer, and the counter beside it must agree with
// what opening that drawer shows.
export function backgroundShellLineCount(path: string): number | undefined {
  let fd: number | undefined
  try {
    fd = openSync(path, "r")
    const stat = fstatSync(fd)
    const size = stat.size
    let state = scans.get(path)
    // Truncated (shrunk) or rotated (a different file at the same path): the old totals describe bytes
    // that are gone, so start over rather than counting on top of them.
    if (state && (state.bytes > size || state.ino !== stat.ino || state.birthtimeMs !== stat.birthtimeMs)) state = undefined
    if (state && state.fingerprint !== readHead(fd, state.fingerprint.length)) state = undefined
    if (state?.overflowed) return undefined
    if (!state) {
      state = {
        ino: stat.ino,
        birthtimeMs: stat.birthtimeMs,
        fingerprint: readHead(fd, Math.min(FINGERPRINT_BYTES, size)),
        bytes: 0,
        breaks: 0,
        pendingCR: false,
        trailing: false,
        overflowed: false,
      }
    }
    if (size - state.bytes > SCAN_CEILING_BYTES) {
      scans.set(path, { ...state, overflowed: true })
      return undefined
    }

    const buffer = size > state.bytes ? Buffer.alloc(Math.min(SCAN_CHUNK_BYTES, size - state.bytes)) : undefined
    while (buffer && state.bytes < size) {
      const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - state.bytes), state.bytes)
      if (count === 0) break
      for (let i = 0; i < count; i++) {
        const byte = buffer[i]
        if (byte === 0x0d) {
          state.breaks++
          state.pendingCR = true
        } else if (byte === 0x0a) {
          // The \n of a CRLF closes a break already counted by its \r.
          if (!state.pendingCR) state.breaks++
          state.pendingCR = false
        } else {
          state.pendingCR = false
        }
      }
      state.bytes += count
      state.trailing = buffer[count - 1] !== 0x0a && buffer[count - 1] !== 0x0d
    }

    if (scans.size >= SCAN_CACHE_LIMIT && !scans.has(path)) {
      const oldest = scans.keys().next()
      if (!oldest.done) scans.delete(oldest.value)
    }
    scans.set(path, state)
    return state.breaks + (state.trailing ? 1 : 0)
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// Test seam only: the scan cache is process-lifetime state keyed by path, and a test that writes two
// different files to the same temp path would otherwise inherit the previous one's totals.
export function resetBackgroundShellLineCounts(): void {
  scans.clear()
}
