import assert from "node:assert/strict"
import { test } from "node:test"
import { adhocProjectRefusal } from "./lib/adhoc-project.mjs"

test("a stack serves the folder it was pointed at, and says nothing", () => {
  assert.equal(adhocProjectRefusal({ given: "/work/repo", served: "/work/repo", explicit: true }), undefined)
})

test("a --project that would serve the folder above it is refused, naming both", () => {
  const refusal = adhocProjectRefusal({ given: "/work/repo/scratch", served: "/work/repo", explicit: true })
  assert.match(refusal, /^--project=\/work\/repo\/scratch is not a project of its own\./)
  assert.match(refusal, /would serve \/work\/repo instead/)
  assert.match(refusal, /`git init` in \/work\/repo\/scratch/)
})

test("the default, the directory the stack was started in, still resolves upward", () => {
  assert.equal(adhocProjectRefusal({ given: "/work/repo/scripts", served: "/work/repo", explicit: false }), undefined)
})
