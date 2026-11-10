import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import {
  appendCrashRecord,
  createLogger,
  defaultLogRoot,
  formatFeedLine,
  isLogDayLine,
  latestLogPath,
  logEnvironment,
  pruneRunLogs,
  runLogPath,
} from "./logging.ts"
import { frizzPaths } from "./frizz-paths.ts"

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "frizz-logging-"))
}

test("the run log lives beside the project's own state, wherever that project's state lives", () => {
  const stateDir = "/home/someone/.frizz/projects/abcd"
  assert.equal(defaultLogRoot(stateDir), join(stateDir, "logs"))

  // No project yet — a failure before the workspace resolves — falls back to the machine-level STATE
  // root. This test used to assert `<home>/.frizz/logs` unconditionally, under a rule that frizz keeps
  // one dotdir on every platform; the root is now resolved by frizz-paths.ts, so an install that HAS
  // `~/.frizz` still gets exactly that path and a new machine gets the platform's own.
  const legacyHome = mkdtempSync(join(tmpdir(), "frizz-logroot-legacy-"))
  try {
    mkdirSync(join(legacyHome, ".frizz"))
    assert.equal(defaultLogRoot(undefined, legacyHome), join(legacyHome, ".frizz", "logs"))
  } finally {
    rmSync(legacyHome, { recursive: true, force: true })
  }

  const freshHome = mkdtempSync(join(tmpdir(), "frizz-logroot-fresh-"))
  try {
    assert.equal(defaultLogRoot(undefined, freshHome), join(frizzPaths({ home: freshHome }).state, "logs"))
    assert.notEqual(defaultLogRoot(undefined, freshHome), join(freshHome, ".frizz", "logs"))
  } finally {
    rmSync(freshHome, { recursive: true, force: true })
  }
})

test("a run log is named for its instant and pid so a crash points at one exact file", () => {
  const path = runLogPath("/state", new Date(2026, 6, 31, 16, 42, 11), 4242, "/home/x", {})
  assert.equal(path, join("/state", "logs", "frizz-2026-07-31T16-42-11-4242.log"))
})

test("FRIZZ_LOG_PATH accepts either a directory or an exact file", () => {
  const at = new Date(2026, 6, 31, 16, 42, 11)
  assert.equal(
    runLogPath("/state", at, 7, "/home/x", { FRIZZ_LOG_PATH: "/tmp/logs" }),
    join("/tmp/logs", "frizz-2026-07-31T16-42-11-7.log"),
  )
  assert.equal(
    runLogPath("/state", at, 7, "/home/x", { FRIZZ_LOG_PATH: "/tmp/exact.log" }),
    "/tmp/exact.log",
  )
})

/** A run log's records, without the date lines each process writes between them. */
const recordsIn = (file: string) => readFileSync(file, "utf8").split("\n").filter((line) => line && !isLogDayLine(line))

// A file covers a launcher's whole run, which is days, and a record carries a clock and no date. The
// instants are built from LOCAL date parts, because the date written is the local one.
test("each process dates the file before its first record, and again at each midnight it writes past", () => {
  const dir = scratch()
  try {
    const file = join(dir, "run.log")
    let at = new Date(2026, 10, 6, 23, 59, 58).getTime()
    const supervisor = createLogger({ file, now: () => at })
    const child = createLogger({ file, owner: false, now: () => at })
    supervisor.info("launcher", "starting")
    child.info("server", "listening")
    supervisor.info("launcher", "still the sixth")
    at = new Date(2026, 10, 7, 0, 0, 1).getTime()
    child.warn("server", "first of the seventh")
    child.info("server", "second of the seventh")
    at = new Date(2026, 10, 9, 8, 0, 0).getTime() // two quiet days later
    supervisor.info("launcher", "the ninth")
    const lines = readFileSync(file, "utf8").split("\n").filter(Boolean)
    const shape = lines.map((line) => (isLogDayLine(line) ? line : line.replace(/^\S+\s+\S+\s+\S+\s+/u, "")))
    assert.deepEqual(shape, [
      "--- 2026-11-06 ---", "starting",
      "--- 2026-11-06 ---", "listening", // the child's own first record: a restarted server is always dated
      "still the sixth",
      "--- 2026-11-07 ---", "first of the seventh", "second of the seventh",
      "--- 2026-11-09 ---", "the ninth",
    ])
    // A record is the line it always was, so the terminal feed still matches the file.
    assert.match(lines[1]!, /^23:59:58\.000 {2}INFO {3}launcher {6}starting$/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a date line counts against the cap like any other byte", () => {
  const dir = scratch()
  try {
    const file = join(dir, "run.log")
    // The record alone is 40 bytes and would fit; its date line is 19 more.
    const logger = createLogger({ file, maxBytes: 50 })
    logger.info("tailer", "tick")
    const written = readFileSync(file, "utf8")
    assert.equal(written, "--- log truncated at 50 bytes ---\n", "the date line and the record together are past it, so neither is written")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("records land on disk in a human-readable, aligned form", () => {
  const dir = scratch()
  try {
    const file = join(dir, "run.log")
    const logger = createLogger({ file, now: () => Date.UTC(2026, 6, 31, 12, 0, 0) })
    logger.info("launcher", "workspace frizz")
    logger.error("supervisor", "child exited")
    const written = recordsIn(file)
    assert.equal(written.length, 2)
    assert.match(written[0]!, /INFO {2}\s+launcher\s+workspace frizz$/)
    assert.match(written[1]!, /ERROR\s+supervisor\s+child exited$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the level threshold drops quieter records everywhere, including on disk", () => {
  const dir = scratch()
  try {
    const file = join(dir, "run.log")
    const logger = createLogger({ file, level: "warn" })
    const seen: string[] = []
    logger.onRecord((record) => seen.push(record.message))
    logger.debug("tailer", "a debug record")
    logger.info("tailer", "an info record")
    logger.warn("tailer", "a warning record")
    assert.deepEqual(seen, ["a warning record"])
    const written = readFileSync(file, "utf8")
    assert.equal(written.includes("a debug record"), false)
    assert.equal(written.includes("an info record"), false)
    assert.equal(written.includes("a warning record"), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an owner sweeps retention and repoints latest.log; an adopting child does neither", () => {
  const dir = scratch()
  try {
    const logs = join(dir, "logs")
    mkdirSync(logs, { recursive: true })
    for (let index = 0; index < 25; index++) {
      const path = join(logs, `frizz-old-${index}.log`)
      writeFileSync(path, "x")
      // Distinct mtimes so "newest N" is well defined.
      const when = new Date(2026, 0, 1 + index)
      utimesSync(path, when, when)
    }
    const owner = createLogger({ file: join(logs, "frizz-new.log") })
    owner.info("launcher", "hello")
    const remaining = readdirSync(logs).filter((name) => name !== "latest.log")
    assert.equal(remaining.length <= 21, true, `expected retention to sweep, saw ${remaining.length}`)
    assert.equal(existsSync(latestLogPath(logs)), true, "the owner publishes a latest.log pointer")
    // The pointer resolves to this run's content.
    assert.equal(readFileSync(latestLogPath(logs), "utf8").includes("hello"), true)

    const before = readdirSync(logs).length
    const child = createLogger({ file: join(logs, "frizz-new.log"), owner: false })
    child.info("dev-child", "adopted")
    assert.equal(readdirSync(logs).length, before, "an adopting child must not prune its parent's history")
    assert.equal(readFileSync(join(logs, "frizz-new.log"), "utf8").includes("adopted"), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("retention drops anything past the count OR older than the age bound", () => {
  const dir = scratch()
  try {
    const fresh = join(dir, "frizz-fresh.log")
    const ancient = join(dir, "frizz-ancient.log")
    writeFileSync(fresh, "x")
    writeFileSync(ancient, "x")
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1_000)
    utimesSync(ancient, old, old)
    pruneRunLogs(dir, 20, 14)
    assert.equal(existsSync(fresh), true, "a recent log within the count survives")
    assert.equal(existsSync(ancient), false, "an old log is swept even though the count allows it")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a wedged subsystem cannot fill the disk", () => {
  const dir = scratch()
  try {
    const file = join(dir, "run.log")
    const logger = createLogger({ file, maxBytes: 400 })
    for (let index = 0; index < 200; index++) logger.info("tailer", `tick ${index}`)
    const written = readFileSync(file, "utf8")
    assert.equal(written.length < 600, true, `expected the cap to hold, saw ${written.length} bytes`)
    assert.match(written, /log truncated at 400 bytes/)
    assert.equal(logger.file, null, "a capped logger reports no usable file")
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("two processes appending to one file interleave without losing a record", () => {
  const dir = scratch()
  try {
    const file = join(dir, "run.log")
    // Exactly the supervisor/child arrangement: separate loggers, same path, O_APPEND.
    const supervisor = createLogger({ file })
    const child = createLogger({ file, owner: false })
    for (let index = 0; index < 50; index++) {
      supervisor.info("supervisor", `s${index}`)
      child.info("dev-child", `c${index}`)
    }
    const lines = recordsIn(file)
    assert.equal(lines.length, 100, "every record from both writers survives")
    assert.equal(lines.filter((line) => line.includes("dev-child")).length, 50)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the child environment carries the parent's file so its records are never lost", () => {
  const dir = scratch()
  try {
    const file = join(dir, "run.log")
    const logger = createLogger({ file })
    assert.deepEqual(logEnvironment(logger, "info"), {
      FRIZZ_LOG_FILE: file,
      FRIZZ_LOG_LEVEL: "info",
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a crash record can be written without owning a logger", () => {
  const dir = scratch()
  try {
    const file = join(dir, "nested", "run.log")
    appendCrashRecord(file, "workspace resolution failed: not a git repository")
    assert.match(readFileSync(file, "utf8"), /ERROR\s+crash\s+workspace resolution failed/)
    // Always under its own date: a crash is read a day later, by someone who was not there.
    assert.match(readFileSync(file, "utf8"), /^--- \d{4}-\d\d-\d\d ---\n\d\d:\d\d:\d\d\.\d{3} {2}ERROR/u)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("logging never throws when its directory is unusable", () => {
  const dir = scratch()
  try {
    // A path whose parent is a FILE cannot be created; the launch must still proceed.
    const blocker = join(dir, "blocker")
    writeFileSync(blocker, "not a directory")
    const logger = createLogger({ file: join(blocker, "run.log") })
    assert.equal(logger.file, null)
    assert.doesNotThrow(() => logger.error("launcher", "still alive"))
    assert.doesNotThrow(() => appendCrashRecord(join(blocker, "run.log"), "boom"))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("the terminal feed and the disk log agree, character for character", () => {
  const dir = scratch()
  try {
    // Asserted against the disk line rather than a literal clock, because both render LOCAL time and
    // a hard-coded string would only pass in the timezone it was written in. What matters is that the
    // two agree: they are the first two things compared when something goes wrong, and while the feed
    // used toISOString() they disagreed by the operator's whole UTC offset.
    const file = join(dir, "run.log")
    const record = { at: Date.now(), level: "warn" as const, scope: "tailer", message: "slow tick" }
    const logger = createLogger({ file, now: () => record.at })
    logger.warn(record.scope, record.message)
    assert.deepEqual(recordsIn(file), [formatFeedLine(record)])
    assert.match(formatFeedLine(record), /^\d\d:\d\d:\d\d\.\d\d\d {2}WARN {3}tailer {8}slow tick$/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
