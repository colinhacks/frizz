import assert from "node:assert/strict"
import { test } from "node:test"
import { splitFrontmatter } from "./frontmatter.ts"

test("a leading frontmatter block is split off verbatim, and the body starts after it", () => {
  const md = "---\ntitle: Zod 4.5\n\ndate: 2026-08-25\n---\n# Post\n\nBody.\n"
  assert.deepEqual(splitFrontmatter(md), { front: "title: Zod 4.5\n\ndate: 2026-08-25", body: "# Post\n\nBody.\n" })
})

test("a document with no frontmatter — or a rule that is not on line one — is returned whole", () => {
  for (const md of ["# Title\n\n---\n\nbelow a rule\n", "\n---\nnot first line\n---\n", "", "---\nunterminated\n"])
    assert.deepEqual(splitFrontmatter(md), { front: null, body: md })
})

test("a frontmatter-only file leaves an empty body", () => {
  assert.deepEqual(splitFrontmatter("---\nname: x\n---"), { front: "name: x", body: "" })
})
