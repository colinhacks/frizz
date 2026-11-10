import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join } from "node:path"

// The image cache is one directory per install under the OS temp dir, and this file fills it past its
// cap. So the temp dir is redirected BEFORE transcript.ts is loaded (the cache's path is fixed at import):
// what is pruned here is this test's own, never a picture the running Frizz on this machine is showing.
const realTmp = tmpdir()
const sandboxTmp = mkdtempSync(join(realTmp, "frizz-image-restore-"))
process.env.TMPDIR = sandboxTmp
const { __clearTranscriptCacheForTests, readTranscript, restoreToolImage } = await import("./transcript.ts")
const { resolveLocalImage } = await import("./local-image.ts")
const { createApp } = await import("./app.ts")
type Project = import("./project.ts").Project
type AppContext = import("./context.ts").AppContext

// A PNG's eight signature bytes and a tail that says which picture it is.
const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(`picture ${n}`)])
const shot = (n: number) => [
  JSON.stringify({ type: "assistant", timestamp: "2026-07-01T00:00:00.000Z", message: { id: `m-${n}`, content: [{ type: "tool_use", id: `toolu_shot_${n}`, name: "mcp__chrome-devtools__take_screenshot", input: {} }] } }),
  JSON.stringify({ type: "user", timestamp: "2026-07-01T00:00:01.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_shot_${n}`, content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: png(n).toString("base64") } }] }] } }),
]

function harness(t: { after: (fn: () => void) => void }) {
  const slug = `-tmp-frizz-image-restore-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const logDir = join(homedir(), ".claude", "projects", slug)
  mkdirSync(logDir, { recursive: true })
  const sid = `image-restore-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  t.after(() => {
    __clearTranscriptCacheForTests()
    rmSync(logDir, { recursive: true, force: true })
  })
  return { project: { cwdSlug: slug } as unknown as Project, sid, path: join(logDir, `${sid}.jsonl`) }
}

test.after(() => rmSync(sandboxTmp, { recursive: true, force: true }))

test("a screenshot the cache has dropped is written back from its transcript record when it is asked for", (t) => {
  const h = harness(t)
  // 250 screenshots in one thread: the cache keeps 200, so the thread's own fold pushes out its first 50.
  // They are 250 messages, inside the latest window of 300, so the page names every one of them.
  const total = 250
  writeFileSync(h.path, Array.from({ length: total }, (_, n) => shot(n)).flat().map((line) => line + "\n").join(""))
  const images = readTranscript(h.project, h.sid).flatMap((message) => message.tools.map((tool) => tool.outputImage)).filter((path): path is string => Boolean(path))
  assert.equal(images.length, total, "every screenshot card names a picture")
  const cacheDir = dirname(images[0]!)
  assert.ok(cacheDir.startsWith(sandboxTmp), "the cache under test is this test's own")
  assert.equal(readdirSync(cacheDir).filter((name) => !name.startsWith(".")).length, 200)
  assert.equal(existsSync(images[0]!), false, "the first screenshot's file is gone by the time the fold ends")

  // Asked for with no way to restore it, it is what it was before: a 404 behind a card that names it.
  assert.deepEqual(resolveLocalImage(images[0]!), { status: 404 })

  const served = resolveLocalImage(images[0]!, null, restoreToolImage)
  assert.equal(served.status, 200)
  assert.deepEqual(readFileSync(images[0]!), png(0), "the picture that screenshot took, not a neighbour's")
  assert.equal(readdirSync(cacheDir).filter((name) => !name.startsWith(".")).length, 200, "and the cache is still its size")

  // Every one of them can be had, in any order, though the cache never holds more than 200.
  for (const n of [249, 17, 49, 50, 0, 123]) {
    const result = resolveLocalImage(images[n]!, null, restoreToolImage)
    assert.equal(result.status, 200, `screenshot ${n}`)
    assert.deepEqual(readFileSync(images[n]!), png(n), `screenshot ${n}`)
  }
})

test("the /local-image route serves a dropped screenshot: the card's own request brings the picture back", async (t) => {
  const h = harness(t)
  writeFileSync(h.path, shot(7).map((line) => line + "\n").join(""))
  const image = readTranscript(h.project, h.sid).flatMap((message) => message.tools.map((tool) => tool.outputImage)).find(Boolean)!
  rmSync(image) // what the cache does to it once 200 newer pictures have been written

  const port = 49_377
  const inert = new Proxy({}, { get: () => () => {} })
  const app = createApp({
    bootId: "image-restore-boot",
    project: { id: "image-restore", dir: sandboxTmp, stateDir: join(sandboxTmp, "state"), cwdSlug: h.project.cwdSlug, name: "image-restore", label: "local/image-restore" },
    bus: inert, transcriptChange: inert, storage: inert, interactions: inert, board: inert, tailer: inert, dispatcher: inert,
    backendFor: () => inert, scheduler: inert, permissionController: inert,
    getSettings: () => ({}), setSettings: (settings: unknown) => settings, resetSettings: () => ({}),
  } as unknown as AppContext, { port })
  const served = await app.request(`http://127.0.0.1:${port}/_frizz/local-image?path=${encodeURIComponent(image)}`, {
    headers: { host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" },
  })
  assert.equal(served.status, 200)
  assert.equal(served.headers.get("content-type"), "image/png")
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), png(7))

  // A path that names nothing this server decoded is still a 404.
  const absent = await app.request(`http://127.0.0.1:${port}/_frizz/local-image?path=${encodeURIComponent(join(dirname(image), `${"0".repeat(32)}.png`))}`, {
    headers: { host: `127.0.0.1:${port}`, "sec-fetch-site": "same-origin" },
  })
  assert.equal(absent.status, 404)
})

test("only a picture this server handed out is restored, and only from the record that carried it", (t) => {
  const h = harness(t)
  writeFileSync(h.path, shot(1).map((line) => line + "\n").join(""))
  const image = readTranscript(h.project, h.sid).flatMap((message) => message.tools.map((tool) => tool.outputImage)).find(Boolean)!
  assert.ok(existsSync(image))

  // A name nobody was given, in the cache directory and out of it.
  assert.equal(restoreToolImage(join(dirname(image), `${"0".repeat(32)}.png`)), false)
  assert.equal(restoreToolImage(join(sandboxTmp, "elsewhere", image.split("/").pop()!)), false, "the same name in another directory is not the cache's file")

  // The transcript changes under the offset the picture was read at: the record there is another call's.
  rmSync(image)
  writeFileSync(h.path, shot(2).map((line) => line + "\n").join(""))
  assert.equal(restoreToolImage(image), false, "a record that is not that call's result restores nothing")
  assert.equal(existsSync(image), false)

  // And a transcript that is gone.
  rmSync(h.path)
  assert.equal(restoreToolImage(image), false)
})
