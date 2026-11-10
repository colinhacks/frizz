import assert from "node:assert/strict"
import test from "node:test"
import { nextSidebarPresence, type SidebarPresence } from "./lib/sidebarPresence.ts"

function board(projectDir: string, options: { owned?: boolean } = {}) {
  return {
    projectDir,
    // One thread (a foreign or an owned one) or none: the presence counts threads of any origin.
    threadCount: options.owned === undefined ? 0 : 1,
  }
}

test("desktop sidebar persists through empty live keyframes, drawer lifecycle, routes, reconnects, and viewport changes", () => {
  let presence: SidebarPresence = { projectDir: null, hasBeenVisible: false }

  // First populated keyframe mounts the rail. The remaining transitions intentionally do not alter
  // the board's project identity, so none may unmount it merely because a snapshot is temporarily empty.
  presence = nextSidebarPresence(presence, board("/work/frizz", { owned: true }))
  assert.deepEqual(presence, { projectDir: "/work/frizz", hasBeenVisible: true })
  for (const transition of ["board delta", "drawer open", "drawer close/reopen", "route change", "reconnect", "desktop/mobile media change"]) {
    presence = nextSidebarPresence(presence, board("/work/frizz"))
    assert.equal(presence.hasBeenVisible, true, transition)
  }
})

// 2026-08-19, reversing the earlier rule. A repo you have only ever worked in from the terminal is the
// project where the External band has the most to show, and discounting those rows here hid
// the one surface that could show them. Only a board with nothing of ANY origin is still "fresh".
test("a board holding only external sessions mounts the rail; a board holding nothing does not", () => {
  const foreignOnly = nextSidebarPresence({ projectDir: null, hasBeenVisible: false }, board("/work/terminal-only", { owned: false }))
  assert.deepEqual(foreignOnly, { projectDir: "/work/terminal-only", hasBeenVisible: true })

  const empty = nextSidebarPresence({ projectDir: null, hasBeenVisible: false }, board("/work/brand-new"))
  assert.deepEqual(empty, { projectDir: "/work/brand-new", hasBeenVisible: false })
})

test("a different project still receives the intentional fresh-workspace shell", () => {
  const populated = nextSidebarPresence({ projectDir: null, hasBeenVisible: false }, board("/work/old", { owned: true }))
  const fresh = nextSidebarPresence(populated, board("/work/new"))

  assert.deepEqual(fresh, { projectDir: "/work/new", hasBeenVisible: false })
})
