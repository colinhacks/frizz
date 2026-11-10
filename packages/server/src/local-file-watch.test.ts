import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, renameSync, rmSync, unlinkSync, watch, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { watchLocalFile, watchedLocalFileCount } from "./local-file-watch.ts"

// A REAL directory and a real OS watch, because the property under test is the one a fake cannot
// carry: an editor's atomic save (write beside, rename over) reaches a watch on the DIRECTORY and
// misses a watch on the file's inode. The sibling case is the negative control — a watch that fired
// on everything in the directory would pass the positive cases and re-read on every unrelated save.
//
// NOTHING HERE WAITS A FIXED TIME FOR THE OS. Each test used to sleep 150ms "for the watch to arm" and
// then write once. An OS watch reports nothing that predates it, and macOS starts its event stream on
// another thread, so on a Mac at load 90 the one write landed first and four tests timed out waiting
// for a change the watch never saw. Two things replace the sleeps:
//
// - A listener here does what the product's reader does: it reads the file. So a wait names the
//   CONTENT the reader must end up seeing, not a count of calls, and an event that arrives late can
//   neither satisfy a wait early nor be mistaken for a second save.
// - `armed` asks the watch itself whether it is up, by saving the file until a save is reported.

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await delay(10)
  }
}

const GONE = "<gone>"

/** A reader: every call reads the file, as the viewer does when it is told to read again. */
function reader(file: string): { seen: string[]; onChange: () => void } {
  const seen: string[] = []
  return {
    seen,
    onChange: () => {
      try {
        seen.push(readFileSync(file, "utf8"))
      } catch {
        seen.push(GONE)
      }
    },
  }
}

/**
 * Resolves once the watch has reported a save and the reader holds the file as it now is. From there
 * on the watch's own stamp matches the file, so nothing more is reported until the test writes again:
 * an event still on its way from these saves finds the file unchanged.
 */
async function armed(file: string, seen: string[]): Promise<void> {
  const deadline = Date.now() + 30_000
  for (let n = 0; ; n++) {
    const save = `arming ${n}\n`
    writeFileSync(file, save)
    const until = Date.now() + 250
    while (Date.now() < until) {
      if (seen.at(-1) === save) return
      await delay(10)
    }
    if (Date.now() > deadline) throw new Error("the watch reported no save in 30s: it never armed")
  }
}

function scratch(): { dir: string; file: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "frizz-file-watch-"))
  const file = join(dir, "doc.md")
  writeFileSync(file, "one\n")
  return { dir, file, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test("an in-place write reaches the listener once per settled burst", async () => {
  const { file, cleanup } = scratch()
  const { seen, onChange } = reader(file)
  const release = watchLocalFile(file, onChange)
  try {
    await armed(file, seen)
    writeFileSync(file, "two\n")
    await waitFor(() => seen.at(-1) === "two\n", "the first change")
    // Several writes inside the settle window are one save from the reader's point of view.
    const before = seen.length
    writeFileSync(file, "three\n")
    writeFileSync(file, "four\n")
    writeFileSync(file, "five\n")
    await waitFor(() => seen.at(-1) === "five\n", "the coalesced burst")
    await delay(200)
    assert.deepEqual(seen.slice(before), ["five\n"], "three writes in one burst re-read once")
  } finally {
    release()
    cleanup()
  }
})

test("an atomic replace — write beside, rename over — reaches the listener", async () => {
  const { dir, file, cleanup } = scratch()
  const { seen, onChange } = reader(file)
  const release = watchLocalFile(file, onChange)
  try {
    await armed(file, seen)
    const temp = join(dir, ".doc.md.tmp")
    writeFileSync(temp, "replaced\n")
    renameSync(temp, file)
    await waitFor(() => seen.at(-1) === "replaced\n", "the rename to land")
    // And the file is still watched afterwards: the watch never followed the old inode.
    writeFileSync(file, "after the replace\n")
    await waitFor(() => seen.at(-1) === "after the replace\n", "a write after the replace")
  } finally {
    release()
    cleanup()
  }
})

test("a sibling's save is not this file's change", async () => {
  const { dir, file, cleanup } = scratch()
  const { seen, onChange } = reader(file)
  // The test's own eyes on the directory, so "nothing fired" is read after the sibling's events have
  // arrived and not merely after some time has passed.
  const named: string[] = []
  const observer = watch(dir, { persistent: false }, (_event, name) => void (name && named.push(String(name))))
  const release = watchLocalFile(file, onChange)
  try {
    await armed(file, seen)
    const before = seen.length
    writeFileSync(join(dir, "other.md"), "not ours\n")
    await waitFor(() => named.includes("other.md"), "the sibling's save to be reported to the directory")
    await delay(300)
    assert.deepEqual(seen.slice(before), [], "a sibling write must not fire")
    // The control's control: the same watch still sees its own file.
    writeFileSync(file, "ours\n")
    await waitFor(() => seen.at(-1) === "ours\n", "our own write")
    assert.deepEqual(seen.slice(before), ["ours\n"], "and it is the only thing the reader was told about")
  } finally {
    release()
    observer.close()
    cleanup()
  }
})

test("a deleted file comes back onto the same watch", async () => {
  const { file, cleanup } = scratch()
  const { seen, onChange } = reader(file)
  const release = watchLocalFile(file, onChange)
  try {
    await armed(file, seen)
    unlinkSync(file)
    await waitFor(() => seen.at(-1) === GONE, "the delete")
    writeFileSync(file, "recreated\n")
    await waitFor(() => seen.at(-1) === "recreated\n", "the recreate")
  } finally {
    release()
    cleanup()
  }
})

test("readers share one watch per path, and the last release closes it", async () => {
  const { file, cleanup } = scratch()
  const base = watchedLocalFileCount()
  const a = reader(file)
  const b = reader(file)
  const releaseA = watchLocalFile(file, a.onChange)
  const releaseB = watchLocalFile(file, b.onChange)
  try {
    assert.equal(watchedLocalFileCount(), base + 1, "two readers, one OS watch")
    await armed(file, b.seen)
    writeFileSync(file, "both\n")
    await waitFor(() => a.seen.at(-1) === "both\n" && b.seen.at(-1) === "both\n", "both listeners")
    releaseA()
    assert.equal(watchedLocalFileCount(), base + 1, "the first release leaves the watch for the other reader")
    const aBefore = a.seen.length
    writeFileSync(file, "only b\n")
    await waitFor(() => b.seen.at(-1) === "only b\n", "the remaining listener")
    // One settled burst calls every listener in the same turn, so `a` would have heard this by now.
    assert.equal(a.seen.length, aBefore, "a released listener hears nothing")
  } finally {
    releaseB()
    cleanup()
  }
  assert.equal(watchedLocalFileCount(), base, "the last release closes the watch")
})

test("a directory that does not exist cannot be watched, and leaves nothing behind", () => {
  const base = watchedLocalFileCount()
  assert.throws(() => watchLocalFile(join(tmpdir(), "frizz-no-such-dir-" + process.pid, "x.md"), () => {}))
  assert.equal(watchedLocalFileCount(), base)
})
