import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

// A file dropped ANYWHERE on a thread's surface goes into that surface's prompt box — in the board's pane,
// in its drawer and on its full-screen page alike, because the zone is the thread surface's
// (components/ThreadSurface.tsx) and not any one of them's. On the full-screen page, which is one
// thread's alone, that is the whole page: the gutter and the rail beside the column too (ThreadPageZone).
// The pane is the same block, so it is the same zone: the rail beside the thread in three columns, and
// the gutter and the rail when it is folded to full screen in place. Only the sidebar beside it is the
// board's, and a file dropped there is nobody's.
// It was the queue card's alone from 2026-10-12 to 2026-10-13, and the same drop on the drawer or on /full
// opened the file in place of the app. The one-thread pane replaced the queue card on 2026-11-09, so the
// board's surface is the pane now; this file is the shape AGENTS.md points at for "verify on every surface".
// The pane's rail and folded gutter took no file until 2026-11-10, when ThreadPane wrapped its block in
// ThreadPageZone.
//
// Real server, real broker, real /attach upload; the worker is the scripted one, so nothing signs in:
//   nub scripts/adhoc-stack.mjs --port=<port> --project=<a throwaway git repo> --claude-bin=$PWD/scripts/scripted-claude.mjs
//   FRIZZ_THREAD_SURFACE_FILE_DROP_E2E_URL=http://127.0.0.1:<port> nub run test <this file>
// The test dispatches its own two threads: one that comes to rest, for the pane and the full-screen page,
// and one that keeps working, for the drawers. On a desktop board every thread opens in the pane, so a
// drawer is found where one still opens: over a status list (`/status/<status>?thread=<slug>`). A desktop's
// full-screen view is the pane with its sidebar put away since 2026-11-11, where a thread link followed from
// it opens its thread in the pane; the drawer that link opened over the full-screen page is a phone's now. The second thread works for about two minutes;
// kill the stack's workers with the stack. The drags are Chrome's own drag pipeline (CDP
// Input.dispatchDragEvent with a real file path, the way a Finder drag arrives), so the browser decides
// which element is under the pointer. A thread's surfaces share one draft, so the file dropped in the
// pane is in the full-screen page's box before that page takes its own.
const baseUrl = process.env.FRIZZ_THREAD_SURFACE_FILE_DROP_E2E_URL

test("a file dropped anywhere on a thread's pane, drawer or full-screen page attaches to its prompt box", { skip: !baseUrl, timeout: 240_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "thread-surface-file-drop-"))
  const file = (name: string) => {
    const path = join(dir, name)
    writeFileSync(path, `${name}\n`)
    return path
  }
  const inPane = file("In the pane.txt")
  const onPaneHeader = file("on-pane-header.txt")
  const onPaneRail = file("on-pane-rail.txt")
  const onSidebar = file("on-sidebar.txt")
  const onFoldedGutter = file("on-folded-gutter.txt")
  const onFoldedRail = file("on-folded-rail.txt")
  const onDrawer = file("on-drawer.txt")
  const onDrawerBox = file("on-drawer-box.txt")
  const onFull = file("on-full.txt")
  const onFullGutter = file("on-full-gutter.txt")
  const onFullRail = file("on-full-rail.txt")
  const onDrawerOverFull = file("on-drawer-over-full.txt")

  const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
  const api = createRpcClient(`${baseUrl}/`)
  await api.waitForHealth()
  const dispatch = (prompt: string) => api.mutate("dispatch", { prompt, backend: "claude", model: "haiku", effort: "low" }) as Promise<{ slug: string }>
  const { slug } = await dispatch("[script ending=needs paras=14] Check the upload path")
  const { slug: working } = await dispatch("[script ending=done paras=2 tools=40 toolms=3000] Keep working")
  let projectSlug = ""
  for (let i = 0; i < 120 && !projectSlug; i++) {
    const board = await api.query("board") as { projectSlug: string; threads: { id: string; runtime: string }[] }
    const runtime = (id: string) => board.threads.find((t) => t.id === id)?.runtime
    if (runtime(slug) === "turn-idle" && runtime(working) === "running") projectSlug = board.projectSlug
    else await new Promise((r) => setTimeout(r, 250))
  }
  assert.ok(projectSlug, "one scripted thread came to rest and the other is working")
  const boardUrl = `${baseUrl}/project/${projectSlug}`

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
    // The pane's layout (folded, rail hidden) persists per browser; start from the default three columns.
    await page.evaluateOnNewDocument(() => localStorage.removeItem("frizz.threadPanePrototype.v1"))
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    await page.setRequestInterception(true)
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/_frizz/control/status") {
        void r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 1, state: "ready", updateRestart: false }) })
      } else void r.continue()
    })

    const pane = `[data-pane-thread] [data-thread-surface="${slug}"]`
    const drawer = `.frizz-sheet-panel [data-thread-surface="${working}"]`
    const full = `[data-standalone-thread] [data-thread-surface="${slug}"]`
    const files = (paths: string[]) => ({ items: [], files: paths, dragOperationsMask: 1 })
    const hinted = (surface: string) => page.$eval(`${surface} [data-composer-box]`, (box) => ({
      hint: box.textContent?.includes("Drop file to attach") ?? false,
      dashed: getComputedStyle(box).borderTopStyle === "dashed",
    }))
    // The attached files' names, in order — exactly as dropped, spaces and case included: an upload
    // keeps its own name, in a folder of its own (server app.ts /attach).
    const chips = (surface: string) => page.$$eval(`${surface} [data-composer-box] button[aria-label^="Remove "]`, (els) => els.map((e) => (e.getAttribute("aria-label") ?? "").replace(/^Remove /, "")))
    const waitForChips = (surface: string, count: number) => page.waitForFunction(
      (sel, n) => document.querySelectorAll(sel).length === n,
      { timeout: 15_000 },
      `${surface} [data-composer-box] button[aria-label^="Remove "]`,
      count,
    )
    // A point inside `within`, as far from the surface's prompt box as `at` puts it.
    const point = (within: string, at: (r: DOMRect) => { x: number; y: number }) => page.$eval(within, (el, fn) => {
      const r = el.getBoundingClientRect()
      return (new Function("r", `return (${fn})(r)`) as (r: DOMRect) => { x: number; y: number })(r)
    }, at.toString())
    const dropAt = async (where: { x: number; y: number }, surface: string, path: string) => {
      const url = page.url()
      await page.mouse.dragEnter(where, files([path]))
      await page.mouse.dragOver(where, files([path]))
      await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes("Drop file to attach"), { timeout: 5000 }, `${surface} [data-composer-box]`)
      assert.deepEqual(await hinted(surface), { hint: true, dashed: true }, `${surface}: its prompt box shows where the file will go`)
      await page.mouse.drop(where, files([path]))
      assert.equal(page.url(), url, `${surface}: the browser did not open the dropped file in place of the app`)
    }

    // 1. THE PANE, the board's one thread: a queued thread opened by its address, as a sidebar row or a
    // link opens it.
    await page.goto(`${boardUrl}?thread=${slug}`, { waitUntil: "networkidle2" })
    await page.waitForSelector(`${pane} [data-composer-box]`, { timeout: 30_000 })
    await page.waitForSelector(`[data-pane-layout="wide"]`)
    // In its transcript, well above its docked prompt box.
    await dropAt(await point(`${pane} [data-drawer-transcript-scroll]`, (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 3 })), pane, inPane)
    await waitForChips(pane, 1)
    // …and on its header.
    await dropAt(await point(`${pane} [data-thread-header]`, (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })), pane, onPaneHeader)
    await waitForChips(pane, 2)
    await new Promise((r) => setTimeout(r, 400))
    assert.deepEqual(await chips(pane), ["In the pane.txt", "on-pane-header.txt"])
    assert.deepEqual(await hinted(pane), { hint: false, dashed: false }, "the hint clears on drop")
    // …and on the rail beside it, which is this thread's too.
    await dropAt(await point("[data-pane-layout='wide'] [data-focus-rail]", (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })), pane, onPaneRail)
    await waitForChips(pane, 3)

    // NOT on the board's sidebar: a drag over one of its rows wakes no prompt box, the pane's or the
    // sidebar's own, and the drop attaches nothing.
    const onRow = await point(`[data-pane-sidebar] [data-sidebar-item="${slug}"]`, (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 }))
    const anyHint = () => page.$$eval("[data-composer-box]", (boxes) => boxes.some((b) => b.textContent?.includes("Drop file to attach")))
    await page.mouse.dragEnter(onRow, files([onSidebar]))
    await page.mouse.dragOver(onRow, files([onSidebar]))
    await new Promise((r) => setTimeout(r, 500))
    assert.equal(await anyHint(), false, "a drag over the sidebar wakes no prompt box")
    const before = page.url()
    await page.mouse.drop(onRow, files([onSidebar]))
    await new Promise((r) => setTimeout(r, 1000))
    assert.equal(page.url(), before)
    assert.deepEqual(await chips(pane), ["In the pane.txt", "on-pane-header.txt", "on-pane-rail.txt"], "the sidebar's drop attached nothing")
    assert.equal(await page.$$eval('[data-composer-box] button[aria-label^="Remove "]', (els) => els.length), 3, "…to any box on the page")

    // FOLDED, full screen in place, with the rail beside the column at this width: the gutter and the rail.
    await page.click("[data-pane-edge-toggle='left']")
    await page.waitForSelector("[data-pane-layout='folded'] [data-focus-rail]")
    await page.waitForFunction(() => document.querySelector("[data-pane-thread]")!.getAnimations({ subtree: false }).length === 0)
    await new Promise((r) => setTimeout(r, 400))
    const folded = await page.$eval("[data-pane-thread]", (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right } })
    assert.ok(folded.left > 80, `there is a gutter beside the folded column at this width: ${JSON.stringify(folded)}`)
    await dropAt({ x: Math.round(folded.left / 2), y: 450 }, pane, onFoldedGutter)
    await waitForChips(pane, 4)
    await dropAt(await point("[data-pane-layout='folded'] [data-focus-rail]", (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })), pane, onFoldedRail)
    await waitForChips(pane, 5)
    await new Promise((r) => setTimeout(r, 400))
    const inThePane = ["In the pane.txt", "on-pane-header.txt", "on-pane-rail.txt", "on-folded-gutter.txt", "on-folded-rail.txt"]
    assert.deepEqual(await chips(pane), inThePane, "each drop is one upload, wherever on the pane it landed")

    // 2. THE DRAWER over a status list, where a desktop thread still opens in one: in the middle of its
    // transcript and then on its header.
    await page.goto(`${boardUrl}/status/active?thread=${working}`, { waitUntil: "networkidle2" })
    await page.waitForSelector(`${drawer} [data-composer-box]`, { timeout: 30_000 })
    await page.waitForSelector(`${drawer}[data-drawer-scroll-ready="true"], ${drawer} [data-drawer-scroll-ready="true"]`)
    const inTranscript = await point(`${drawer} [data-drawer-transcript-scroll]`, (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 3 }))
    await page.mouse.dragEnter(inTranscript, files([onDrawer]))
    await page.mouse.dragOver(inTranscript, files([onDrawer]))
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes("Drop file to attach"), { timeout: 5000 }, `${drawer} [data-composer-box]`)
    // Off the drawer: the hover ends.
    await page.mouse.dragOver({ x: 20, y: inTranscript.y }, files([onDrawer]))
    await page.waitForFunction((sel) => !document.querySelector(sel)?.textContent?.includes("Drop file to attach"), { timeout: 5000 }, `${drawer} [data-composer-box]`)
    await dropAt(await point(`${drawer} [data-thread-header]`, (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })), drawer, onDrawer)
    await waitForChips(drawer, 1)
    // A drop ON the prompt box is still one upload, not one from the box and another from the surface.
    await dropAt(await point(`${drawer} [data-composer-box]`, (r) => ({ x: r.left + r.width / 2, y: r.top + 16 })), drawer, onDrawerBox)
    await waitForChips(drawer, 2)
    await new Promise((r) => setTimeout(r, 400))
    assert.deepEqual(await chips(drawer), ["on-drawer.txt", "on-drawer-box.txt"])

    // 3. THE FULL-SCREEN PAGE of the rested thread, in the middle of its transcript. The pane's files are
    // already in its box, and nothing dropped on the other thread's drawer is.
    await page.goto(`${boardUrl}/thread/${slug}`, { waitUntil: "networkidle2" })
    await page.waitForSelector(`${full} [data-composer-box]`, { timeout: 30_000 })
    await waitForChips(full, 5)
    assert.deepEqual(await chips(full), inThePane, "the thread's own draft, and nothing from the other thread's drawer")
    await dropAt(await point(`${full} [data-drawer-transcript-scroll]`, (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 3 })), full, onFull)
    await waitForChips(full, 6)
    await new Promise((r) => setTimeout(r, 400))
    assert.deepEqual(await chips(full), [...inThePane, "on-full.txt"])
    assert.deepEqual(await hinted(full), { hint: false, dashed: false }, "the hint clears on drop")

    // 4. …AND ANYWHERE ELSE ON THAT PAGE. It is this one thread's page, and at this width its column is
    // half of it: the gutter beside the column and the rail on the other side are still "anywhere".
    const column = await page.$eval("[data-standalone-thread]", (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right } })
    assert.ok(column.left > 80, "there is a gutter beside the column at this width")
    await dropAt({ x: Math.round(column.left / 2), y: 450 }, full, onFullGutter)
    await waitForChips(full, 7)
    await dropAt(await point("[data-focus-rail]", (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })), full, onFullRail)
    await waitForChips(full, 8)
    await new Promise((r) => setTimeout(r, 400))
    assert.deepEqual(await chips(full), [...inThePane, "on-full.txt", "on-full-gutter.txt", "on-full-rail.txt"], "each drop is one upload, wherever on the page it landed")
    // Off the window altogether: the hover ends.
    await page.mouse.dragEnter({ x: Math.round(column.left / 2), y: 450 }, files([onFull]))
    await page.mouse.dragOver({ x: Math.round(column.left / 2), y: 450 }, files([onFull]))
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes("Drop file to attach"), { timeout: 5000 }, `${full} [data-composer-box]`)
    await page.$eval("[data-thread-page-zone]", (zone) => zone.dispatchEvent(new DragEvent("dragleave", { bubbles: true, relatedTarget: null })))
    await page.waitForFunction((sel) => !document.querySelector(sel)?.textContent?.includes("Drop file to attach"), { timeout: 5000 }, `${full} [data-composer-box]`)

    // 5. A THREAD LINK FOLLOWED FROM FULL SCREEN, the way a worker's `[…](/thread/<slug>)` is. On a desktop
    // the thread's path is the pane (lib/threadPane.ts), so the link opens its thread there, still full
    // screen, rather than in a drawer over the page as the full-screen page did until 2026-11-11 (a phone's
    // page still does, and a phone has no file drag). The zone follows the thread: a drop goes to the
    // linked thread's box, and the first thread's draft is as it was when Back returns to it.
    await page.evaluate((href) => {
      const a = document.createElement("a")
      a.href = href
      a.textContent = "the working thread"
      a.setAttribute("data-e2e-thread-link", "")
      document.querySelector("[data-standalone-thread] [data-thread-header]")!.append(a)
    }, `/project/${projectSlug}/thread/${working}`)
    await page.click("[data-e2e-thread-link]")
    const linked = `[data-standalone-thread] [data-thread-surface="${working}"]`
    await page.waitForSelector(`${linked} [data-composer-box]`, { timeout: 30_000 })
    assert.equal(new URL(page.url()).pathname, `/project/${projectSlug}/thread/${working}`, "the linked thread, full screen, at its own path")
    assert.equal(await page.$(".frizz-sheet-panel"), null, "in the pane, not a drawer")
    await waitForChips(linked, 2)
    await dropAt(await point(`${linked} [data-drawer-transcript-scroll]`, (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 3 })), linked, onDrawerOverFull)
    await waitForChips(linked, 3)
    await new Promise((r) => setTimeout(r, 400))
    assert.deepEqual(await chips(linked), ["on-drawer.txt", "on-drawer-box.txt", "on-drawer-over-full.txt"])
    await page.goBack()
    await page.waitForSelector(`${full} [data-composer-box]`, { timeout: 30_000 })
    await waitForChips(full, 8)
    assert.equal((await chips(full)).length, 8, "…and nothing went to the first thread")

    assert.deepEqual(errors, [], "no console/page errors during the flow")
  } finally {
    await browser.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
