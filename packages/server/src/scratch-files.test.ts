import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { scratchFiles } from "./scratch-files.ts"

function project(): { dir: string; scratch: string; cleanup: () => void } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "frizz-scratch-files-")))
  const scratch = join(dir, ".frizz", "threads", "sid-1")
  mkdirSync(scratch, { recursive: true })
  return { dir, scratch, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

const paths = (listing: ReturnType<typeof scratchFiles>) => listing?.files.map((f) => f.path).sort()

test("the listing is every file in the folder, at any depth, and nothing that is not the thread's file", () => {
  const { dir, scratch, cleanup } = project()
  try {
    assert.equal(scratchFiles(dir, "sid-1"), undefined, "an empty folder is no group")
    mkdirSync(join(scratch, "shots", "narrow"), { recursive: true })
    writeFileSync(join(scratch, "notes.md"), "n")
    writeFileSync(join(scratch, "shots", "narrow", "a.png"), "p")
    // Finder's state, and a link to a file that is not the thread's.
    writeFileSync(join(scratch, ".DS_Store"), "")
    writeFileSync(join(dir, "outside.txt"), "o")
    symlinkSync(join(dir, "outside.txt"), join(scratch, "link.txt"))
    symlinkSync(dir, join(scratch, "project"))
    assert.equal(scratchFiles(dir, "sid-1")?.root, scratch)
    assert.equal(scratchFiles(dir, "sid-1")?.truncated, undefined)
    assert.deepEqual(paths(scratchFiles(dir, "sid-1")), [join(scratch, "notes.md"), join(scratch, "shots", "narrow", "a.png")])
  } finally {
    cleanup()
  }
})

test("another thread's folder, a missing one, a symlinked one and a malformed id list nothing", () => {
  const { dir, scratch, cleanup } = project()
  try {
    writeFileSync(join(scratch, "notes.md"), "n")
    assert.equal(scratchFiles(dir, "sid-2"), undefined, "no such folder")
    assert.equal(scratchFiles(dir, "../sid-1"), undefined, "an id that walks out of threads/")
    assert.equal(scratchFiles(dir, ""), undefined)
    // A folder in its place that Frizz did not make: a link to somewhere else.
    symlinkSync(scratch, join(dir, ".frizz", "threads", "sid-3"))
    assert.equal(scratchFiles(dir, "sid-3"), undefined)
  } finally {
    cleanup()
  }
})

test("a folder past the cap says it is truncated", () => {
  const { dir, scratch, cleanup } = project()
  try {
    for (let i = 0; i < 501; i++) writeFileSync(join(scratch, `f${i}.txt`), "")
    const listing = scratchFiles(dir, "sid-1")
    assert.equal(listing?.files.length, 500)
    assert.equal(listing?.truncated, true)
    rmSync(join(scratch, "f500.txt"))
    assert.equal(scratchFiles(dir, "sid-1")?.truncated, undefined, "exactly the cap is the whole folder")
  } finally {
    cleanup()
  }
})
