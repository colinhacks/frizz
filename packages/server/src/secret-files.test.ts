// The secret pipe against the REAL kernel: a real `mkfifo`, real `cat` readers, real timers. What these
// pin is the promise the worker is given — the value is read ONCE, from memory, and nothing of it is left.
import { test } from "node:test"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearSecrets, rearmSecretsIn, secretFilePath, serveSecret } from "./secret-files.ts"

const cat = (path: string, timeout = 5_000) => new Promise<string>((resolve, reject) =>
  execFile("cat", [path], { timeout }, (error, stdout) => (error ? reject(error) : resolve(stdout))))

const until = async (cond: () => boolean, ms = 3_000) => {
  const deadline = Date.now() + ms
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out")
    await new Promise((r) => setTimeout(r, 25))
  }
}

function stateDir(): string {
  return mkdtempSync(join(tmpdir(), "frizz-secret-"))
}

test("the value is read ONCE: the first reader gets it and the path is gone", async () => {
  const dir = stateDir()
  try {
    const path = serveSecret(dir, "t", "qst_once", "s3cr3t value")
    assert.equal(path, secretFilePath(dir, "t", "qst_once"))
    assert.ok(lstatSync(path).isFIFO())
    assert.equal(await cat(path), "s3cr3t value")
    await until(() => !existsSync(path))
    // A second read finds nothing to open, rather than a second copy.
    await assert.rejects(() => cat(path), /No such file/)
    assert.equal(existsSync(join(dir, "secrets", "t")), false, "the thread's directory goes with its last pipe")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("LOOKING at the path does not spend the value — only opening it does", async () => {
  const dir = stateDir()
  try {
    const path = serveSecret(dir, "t", "qst_look", "kept")
    // What a careful worker might run before using it: these stat the path and never open it.
    await new Promise<void>((resolve, reject) =>
      execFile("sh", ["-c", `ls -l '${path}' && test -p '${path}'`], (e) => (e ? reject(e) : resolve())))
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(await cat(path), "kept")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("an unread value expires, and removing the path discards it", async () => {
  const dir = stateDir()
  try {
    const expiring = serveSecret(dir, "t", "qst_ttl", "late", { ttlMs: 200 })
    await until(() => !existsSync(expiring))
    const discarded = serveSecret(dir, "t", "qst_rm", "unwanted")
    rmSync(discarded)
    // Re-creating the name as a plain file must not make the server start writing into it.
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(existsSync(discarded), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// The clock starts when the message naming the path reaches the worker: a held send or a held answer wake
// can sit for minutes after the human pasted (2026-11-11). A fake clock moves time; the poll reads it.
test("delivering the message that names a path restarts its clock; another path's is untouched", async () => {
  const dir = stateDir()
  try {
    let clock = 0
    const named = serveSecret(dir, "t", "qst_named", "v1", { ttlMs: 1_000, now: () => clock })
    const other = serveSecret(dir, "t", "qst_other", "v2", { ttlMs: 1_000, now: () => clock })
    clock = 900
    assert.equal(rearmSecretsIn(`Answers to earlier questions:\n1. “Token?” → secret ready at ${named}`), 1)
    clock = 1_200
    await until(() => !existsSync(other))
    assert.equal(existsSync(named), true, "restarted at 900, so it runs to 1,900")
    assert.equal(await cat(named), "v1")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a server start clears what a previous process left — pipes with no writer, and old plaintext files", async () => {
  const dir = stateDir()
  try {
    const thread = join(dir, "secrets", "old-thread")
    mkdirSync(thread, { recursive: true })
    writeFileSync(join(thread, "qst_plain"), "left by the plaintext version")
    await new Promise<void>((resolve, reject) => execFile("mkfifo", [join(thread, "qst_orphan")], (e) => (e ? reject(e) : resolve())))
    // …while a pipe THIS process serves is left alone.
    const live = serveSecret(dir, "live-thread", "qst_live", "still served")
    assert.equal(clearSecrets(dir), 2)
    assert.equal(existsSync(thread), false)
    assert.deepEqual(readdirSync(join(dir, "secrets")), ["live-thread"])
    assert.equal(await cat(live), "still served")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("on Windows, where there are no FIFOs, the value is a 0600 file removed at the TTL", async () => {
  const dir = stateDir()
  try {
    const path = serveSecret(dir, "t", "qst_win", "fallback", { platform: "win32", ttlMs: 200 })
    assert.ok(lstatSync(path).isFile())
    assert.equal(lstatSync(path).mode & 0o777, 0o600)
    await until(() => !existsSync(path), 4_000)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
