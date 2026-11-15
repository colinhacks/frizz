import assert from "node:assert/strict"
import test from "node:test"
import { localFileDragPayload } from "./localFileDrag.ts"

const ORIGIN = "http://127.0.0.1:9393/status/frizz"

// Chrome splits `DownloadURL` into `<mime>:<name>:<url>` on its first two colons, so each case pins the
// three fields apart rather than one opaque string.
function fields(path: string) {
  const { text, downloadUrl } = localFileDragPayload(path, ORIGIN)
  if (!downloadUrl) return { text, downloadUrl }
  const [mime, name, ...url] = downloadUrl.split(":")
  return { text, mime, name, url: url.join(":") }
}

test("a file drags out as its path and as a promise Chrome downloads from /local-file", () => {
  assert.deepEqual(fields("/Users/me/repo/notes.md"), {
    text: "/Users/me/repo/notes.md",
    mime: "text/markdown",
    name: "notes.md",
    url: "http://127.0.0.1:9393/_frizz/local-file?path=%2FUsers%2Fme%2Frepo%2Fnotes.md",
  })
})

test("a picture or a video comes from the route that draws it", () => {
  assert.deepEqual(fields("/tmp/shots/after.png"), {
    text: "/tmp/shots/after.png",
    mime: "image/png",
    name: "after.png",
    url: "http://127.0.0.1:9393/_frizz/local-image?path=%2Ftmp%2Fshots%2Fafter.png",
  })
  assert.equal(fields("/tmp/flow.webm").mime, "video/webm")
})

test("an unknown extension is octet-stream, so Chrome adds no extension to the name", () => {
  assert.deepEqual(fields("/repo/Makefile"), {
    text: "/repo/Makefile",
    mime: "application/octet-stream",
    name: "Makefile",
    url: "http://127.0.0.1:9393/_frizz/local-file?path=%2Frepo%2FMakefile",
  })
})

test("an editor cursor stays in the text and leaves the file alone", () => {
  const out = fields("/repo/README.md:12:3")
  assert.equal(out.text, "/repo/README.md:12:3")
  assert.equal(out.name, "README.md")
  assert.equal(out.url, "http://127.0.0.1:9393/_frizz/local-file?path=%2Frepo%2FREADME.md")
})

test("a colon in the name cannot cut the promise short", () => {
  const out = fields("/tmp/12:30 notes.txt")
  assert.equal(out.mime, "text/plain")
  assert.equal(out.name, "12_30 notes.txt")
  // The URL still names the real file.
  assert.equal(out.url, "http://127.0.0.1:9393/_frizz/local-file?path=%2Ftmp%2F12%3A30%20notes.txt")
})

test("a Windows path names its own file", () => {
  assert.equal(fields("C:\\Users\\me\\shot.png").name, "shot.png")
})

test("a directory goes out as text only, since no route serves one", () => {
  assert.deepEqual(localFileDragPayload("/repo/docs/", ORIGIN), { text: "/repo/docs/", downloadUrl: null })
})
