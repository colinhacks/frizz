import assert from "node:assert/strict"
import { globSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"

// The hosts every page needs — the toaster, the image viewer, the GitHub reference cards — are mounted
// by PageHosts and by nothing else, and the router's layout mounts it, around every page. Each shell mounted
// them by hand until 2026-10-13, and they had drifted both ways: the full-screen thread page had no reference
// cards and two toasters. That page sat outside the layout, with a PageHosts of its own, until 2026-11-11.
// Fixtures are exempt: a fixture page is its own shell.

const src = fileURLToPath(new URL("../", import.meta.url))
const sources = new Map(
  globSync("**/*.{ts,tsx}", { cwd: src })
    .map((file) => file.split("\\").join("/"))
    .filter((file) => !/\.test\.tsx?$/.test(file) && !/-fixture\.tsx$/.test(file))
    .map((file) => [file, readFileSync(`${src}/${file}`, "utf8")] as const),
)
// A mount is the tag on a line of code; a comment may name a host anywhere.
const isComment = (line: string) => /^\s*(?:\/\/|\/?\*|\{\/\*)/.test(line)
const filesWith = (needle: string) => [...sources].filter(([, text]) => text.split("\n").some((line) => line.includes(needle) && !isComment(line))).map(([file]) => file).sort()

test("the page-level hosts are mounted by PageHosts alone, and once, by the router's layout", () => {
  for (const host of ["<Toaster", "<LightboxHost", "<GithubHovercards"]) {
    assert.deepEqual(filesWith(host), ["components/PageHosts.tsx"], `${host} is PageHosts' to mount`)
  }
  assert.deepEqual(filesWith("<PageHosts"), ["routes.tsx"])
  // One, in the layout around the grid, the boards and a phone's full-screen thread page.
  assert.equal((sources.get("routes.tsx")!.match(/<PageHosts \/>/g) ?? []).length, 1)
})
