import assert from "node:assert/strict"
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  backgroundShellLineCount,
  isTaskOutputPath,
  readableTaskOutput,
  readBackgroundShellOutput,
  resetBackgroundShellLineCounts,
} from "./background-shell-output.ts"

test("background shell output reads a bounded, presentation-safe tail", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-shell-output-"))
  try {
    const path = join(dir, "task.output")
    writeFileSync(path, `discard-me\n12345\u001b[31mred\u001b[0m\rprogress`)
    assert.deepEqual(readBackgroundShellOutput(path, 24), {
      output: "345red\nprogress",
      truncated: true,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("background shell output degrades safely when the task file is unavailable", () => {
  assert.deepEqual(readBackgroundShellOutput("/definitely/missing/frizz-shell-output"), { output: "", truncated: false })
})

// ── WHICH file may be read at all ────────────────────────────────────────────────────────────────
// The path comes out of a transcript record, so the reader checks it again: only a harness task's own
// output file, and only a regular one.

test("only a harness task's own output file is a task output path", () => {
  const real = "/private/tmp/claude-501/-Users-someone-repo/0b1c2d3e/tasks/bq7k2m9xa.output"
  assert.equal(isTaskOutputPath(real), true)
  assert.equal(isTaskOutputPath(real, "bq7k2m9xa"), true)
  assert.equal(isTaskOutputPath(real, "another"), false, "a named task reads its own file")
  assert.equal(isTaskOutputPath("C:\\Temp\\claude\\tasks\\bq7k2m9xa.output"), true)
  for (const path of ["/Users/someone/.ssh/id_ed25519", "/etc/passwd", "/tmp/tasks/notes.txt", "/tmp/tasks/../secret.output", "/tmp/bq7k2m9xa.output", "/tmp/tasks/a/b.output"]) {
    assert.equal(isTaskOutputPath(path), false, path)
  }
})

test("a task output path is read only when it is a regular file: never a link to somewhere else", () => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-shell-readable-"))
  try {
    mkdirSync(join(dir, "tasks"))
    const secret = join(dir, "identity.key")
    writeFileSync(secret, "not for the drawer")
    const real = join(dir, "tasks", "breal0001.output")
    writeFileSync(real, "built\n")
    const link = join(dir, "tasks", "blink0001.output")
    symlinkSync(secret, link)
    assert.equal(readableTaskOutput(real), real)
    assert.equal(readableTaskOutput(link), undefined, "a link in the tasks folder names another file")
    assert.equal(readableTaskOutput(secret), undefined)
    assert.equal(readableTaskOutput(join(dir, "tasks", "bgone0001.output")), undefined, "a file not written yet")
    assert.equal(readableTaskOutput(undefined), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── THE LIVE COUNTER on a shell row ──────────────────────────────────────────────────────────────

function withOutputFile(run: (path: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "frizz-shell-lines-"))
  resetBackgroundShellLineCounts()
  try {
    run(join(dir, "task.output"))
  } finally {
    resetBackgroundShellLineCounts()
    rmSync(dir, { recursive: true, force: true })
  }
}

test("the line counter counts what the drawer shows — terminators, a trailing partial line, and bare \\r", () => {
  withOutputFile((path) => {
    writeFileSync(path, "")
    assert.equal(backgroundShellLineCount(path), 0, "a shell that has printed nothing reads as 0, not as absent")
    writeFileSync(path, "one\n")
    resetBackgroundShellLineCounts()
    assert.equal(backgroundShellLineCount(path), 1)
    writeFileSync(path, "one\ntwo")
    resetBackgroundShellLineCounts()
    assert.equal(backgroundShellLineCount(path), 2, "output ending mid-line still shows that line")
    // readBackgroundShellOutput rewrites a bare \r to \n, so an overprinting progress bar renders as
    // several lines in the drawer — the counter beside it has to agree.
    writeFileSync(path, "10%\r20%\r30%")
    resetBackgroundShellLineCounts()
    assert.equal(backgroundShellLineCount(path), 3)
    writeFileSync(path, "a\r\nb\r\n")
    resetBackgroundShellLineCounts()
    assert.equal(backgroundShellLineCount(path), 2, "CRLF is ONE break, not two")
  })
})

test("the line counter advances incrementally as a live shell appends", () => {
  withOutputFile((path) => {
    writeFileSync(path, "first\nsecond\n")
    assert.equal(backgroundShellLineCount(path), 2)
    appendFileSync(path, "third\n")
    assert.equal(backgroundShellLineCount(path), 3, "the second call must read only the delta and still total correctly")
    assert.equal(backgroundShellLineCount(path), 3, "a poll with no new bytes re-reports the same total")
    appendFileSync(path, "partial")
    assert.equal(backgroundShellLineCount(path), 4)
    appendFileSync(path, " more\n")
    assert.equal(backgroundShellLineCount(path), 4, "finishing the partial line does not add a second one")
  })
})

// The delta boundary landing between the \r and the \n of one CRLF is the one way an incremental
// counter double-counts, and it needs two separate appends to reproduce at all.
test("the line counter does not double-count a CRLF split across two polls", () => {
  withOutputFile((path) => {
    writeFileSync(path, "alpha\r")
    assert.equal(backgroundShellLineCount(path), 1)
    appendFileSync(path, "\nbeta\r")
    assert.equal(backgroundShellLineCount(path), 2, "the \\n closing a counted \\r is not a break of its own")
    appendFileSync(path, "\ngamma")
    assert.equal(backgroundShellLineCount(path), 3)
  })
})

test("the line counter recovers when the output file is truncated or rotated under it", () => {
  withOutputFile((path) => {
    writeFileSync(path, "one\ntwo\nthree\n")
    assert.equal(backgroundShellLineCount(path), 3)
    writeFileSync(path, "fresh\n")
    assert.equal(backgroundShellLineCount(path), 1, "a shrunk file is re-counted rather than reported off the stale total")
  })
})

// The rotation a size check alone cannot see: the replacement file is LARGER than what it replaced.
test("the line counter re-counts when a LARGER file replaces the one at that path", () => {
  withOutputFile((path) => {
    writeFileSync(path, "one\ntwo\n")
    assert.equal(backgroundShellLineCount(path), 2)
    rmSync(path)
    writeFileSync(path, "a\nb\nc\nd\ne\n")
    assert.equal(backgroundShellLineCount(path), 5, "a new inode at the same path is a new file, whatever its size")
  })
})

test("the line counter reports nothing — never zero — for a file it cannot read", () => {
  assert.equal(backgroundShellLineCount("/definitely/missing/frizz-shell-output"), undefined)
})
