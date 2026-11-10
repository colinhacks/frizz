import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import test from "node:test"

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")

// Both page shells must mount the SAME drawer stack. The standalone `/thread/<slug>/full` page did
// not, and because every drill-in affordance simply pushes onto `store.drawers`, the sub-agent rows,
// the background-shell rows, the frizz-doc action and `[…](/thread/<slug>)` links were all DEAD CLICKS
// there — state changed, nothing rendered. Pin the invariant so the two shells can't drift again.
test("the queue shell and the standalone /full page both mount the drawer stack", () => {
  for (const shell of ["../App.tsx", "./StandaloneThreadPage.tsx"]) {
    const source = read(shell)
    assert.match(source, /<DrawerStack\b[\s\S]*?\/>/, `${shell} must mount <DrawerStack />`)
    assert.match(source, /import \{ DrawerStack \}/, `${shell} must import DrawerStack`)
  }
})

// The Escape chain lives WITH the stack for the same reason: /full needs the identical unwinding, and
// two window-level listeners racing over one physical Escape would close two layers at once. App keeps
// only the ⌘K/⌘I chords.
test("the overlay Escape chain lives in DrawerStack, not in the queue shell", () => {
  const stack = read("./DrawerStack.tsx")
  assert.match(stack, /e\.key !== "Escape"/, "DrawerStack owns the Escape handler")
  for (const guard of ["dismissOpenSelect", "showPalette", "showNewThread", "showGithubPicker", "closeSettingsAnimated", "closeDrawerAnimated"]) {
    assert.ok(stack.includes(guard), `DrawerStack must keep the ${guard} step of the overlay precedence chain`)
  }
  assert.ok(!read("../App.tsx").includes("closeSettingsAnimated"), "App must not run a second Escape chain")
})

// Escape on /full exits fullscreen once nothing above the page is left to close — the chain's last
// step, which only /full supplies (the queue has nothing to leave). fullscreenEscape.e2e.test.ts drives it.
// Escape at rest leaves a full-screen view and nothing else: /full's page, and on the board the one-thread
// pane's full screen, which puts the sidebar back. The board never navigates away on an Escape.
test("the Escape chain's way out leaves full screen, on /full and in the board's pane", () => {
  assert.match(read("./StandaloneThreadPage.tsx"), /<DrawerStack onEscapeAtRest=\{\(\) => exitFullscreen\(slug\)\} \/>/)
  assert.match(read("../App.tsx"), /<DrawerStack onEscapeAtRest=\{\(\) => \{ if \(store\.paneSlug\) setPaneFolded\(false\) \}\} \/>/)
})
