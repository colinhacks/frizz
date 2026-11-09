import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

// A file dropped ANYWHERE on a thread's surface goes into that surface's prompt box — on its queue card,
// in its drawer and on its full-screen page alike, because the zone is the thread surface's
// (components/ThreadSurface.tsx) and not any one of them's. On the full-screen page, which is one
// thread's alone, that is the whole page: the gutter and the rail beside the column too (ThreadPageZone). It was the queue card's alone from 2026-10-12
// to 2026-10-13, and the same drop on the drawer or on /full opened the file in place of the app.
//
// Real server, real broker, real /attach upload; the worker is the scripted one, so nothing signs in:
//   nub scripts/adhoc-stack.mjs --port=<port> --project=<a throwaway git repo> --claude-bin=$PWD/scripts/scripted-claude.mjs
//   FRIZZ_THREAD_SURFACE_FILE_DROP_E2E_URL=http://127.0.0.1:<port> nub run test <this file>
// The test dispatches its own two threads: one that comes to rest, for the card and the full-screen page,
// and one that keeps working, for the drawer (a queued thread's link opens its card, never a drawer). The
// second works for about two minutes; kill the stack's workers with the stack. The drags are Chrome's own
// drag pipeline (CDP Input.dispatchDragEvent with a real file path, the way a Finder drag arrives), so
// the browser decides which element is under the pointer. A thread's surfaces share one draft, so the
// file dropped on the card is in the full-screen page's box before that page takes its own.
const baseUrl = process.env.FRIZZ_THREAD_SURFACE_FILE_DROP_E2E_URL

test("a file dropped anywhere on a thread's queue card, drawer or full-screen page attaches to its prompt box", { skip: !baseUrl, timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "thread-surface-file-drop-"))
  const file = (name: string) => {
    const path = join(dir, name)
    writeFileSync(path, `${name}\n`)
    return path
  }
  const onCard = file("On the card.txt")
  const onDrawer = file("on-drawer.txt")
  const onDrawerBox = file("on-drawer-box.txt")
  const onFull = file("on-full.txt")
  const onFullGutter = file("on-full-gutter.txt")
  const onFullRail = file("on-full-rail.txt")

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
    const errors: string[] = []
    page.on("pageerror", (e) => errors.push(String(e)))
    page.on("console", (m) => { if (m.type() === "error" && !/404|favicon/i.test(m.text())) errors.push(m.text()) })
    await page.setRequestInterception(true)
    page.on("request", (r) => {
      if (new URL(r.url()).pathname === "/_frizz/control/status") {
        void r.respond({ status: 200, contentType: "application/json", body: JSON.stringify({ protocol: 1, state: "ready", updateRestart: false }) })
      } else void r.continue()
    })

    const card = `[data-queue-card-root="${slug}"]`
    const drawer = `.frizz-sheet-panel [data-thread-surface="${working}"]`
    const full = `main[data-standalone-thread] [data-thread-surface="${slug}"]`
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

    // 1. THE QUEUE CARD.
    await page.goto(boardUrl, { waitUntil: "networkidle2" })
    await page.waitForSelector(`${card} [data-composer-box]`)
    // Other threads may be queued above it on a stack that has run before.
    await page.$eval(card, (el) => el.scrollIntoView({ block: "start" }))
    assert.equal(await page.$eval(card, (el) => el.getAttribute("data-thread-surface")), slug, "the card's root is its thread surface")
    // In its transcript, well above its docked prompt box (the card is taller than the window).
    await dropAt(await point(card, (r) => ({ x: r.left + r.width / 2, y: Math.min(r.top + r.height / 3, innerHeight / 2) })), card, onCard)
    await waitForChips(card, 1)
    assert.deepEqual(await chips(card), ["On the card.txt"])

    // 2. THE DRAWER, in the middle of its transcript and then on its header. The queue is still mounted
    // under it, so the hint has to say which SURFACE is under the pointer.
    await page.goto(`${boardUrl}?thread=${working}`, { waitUntil: "networkidle2" })
    await page.waitForSelector(`${drawer} [data-composer-box]`)
    await page.waitForSelector(`${drawer}[data-drawer-scroll-ready="true"], ${drawer} [data-drawer-scroll-ready="true"]`)
    const inTranscript = await point(`${drawer} [data-drawer-transcript-scroll]`, (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 3 }))
    await page.mouse.dragEnter(inTranscript, files([onDrawer]))
    await page.mouse.dragOver(inTranscript, files([onDrawer]))
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes("Drop file to attach"), { timeout: 5000 }, `${drawer} [data-composer-box]`)
    assert.deepEqual(await hinted(card), { hint: false, dashed: false }, "the card under the drawer does not claim the file")
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
    assert.deepEqual(await chips(card), ["On the card.txt"], "…and nothing went to the other thread's card")

    // 3. THE FULL-SCREEN PAGE of the rested thread, in the middle of its transcript.
    await page.goto(`${boardUrl}/thread/${slug}`, { waitUntil: "networkidle2" })
    await page.waitForSelector(`${full} [data-composer-box]`)
    await waitForChips(full, 1)
    await dropAt(await point(`${full} [data-drawer-transcript-scroll]`, (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 3 })), full, onFull)
    await waitForChips(full, 2)
    await new Promise((r) => setTimeout(r, 400))
    assert.deepEqual(await chips(full), ["On the card.txt", "on-full.txt"])
    assert.deepEqual(await hinted(full), { hint: false, dashed: false }, "the hint clears on drop")

    // 4. …AND ANYWHERE ELSE ON THAT PAGE. It is this one thread's page, and at this width its column is
    // half of it: the gutter beside the column and the rail on the other side are still "anywhere".
    const column = await page.$eval("main[data-standalone-thread]", (el) => { const r = el.getBoundingClientRect(); return { left: r.left, right: r.right } })
    assert.ok(column.left > 80, "there is a gutter beside the column at this width")
    await dropAt({ x: Math.round(column.left / 2), y: 450 }, full, onFullGutter)
    await waitForChips(full, 3)
    await dropAt(await point("[data-focus-rail]", (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 })), full, onFullRail)
    await waitForChips(full, 4)
    await new Promise((r) => setTimeout(r, 400))
    assert.deepEqual(await chips(full), ["On the card.txt", "on-full.txt", "on-full-gutter.txt", "on-full-rail.txt"], "each drop is one upload, wherever on the page it landed")
    // Off the window altogether: the hover ends, as it does when a drag leaves a card.
    await page.mouse.dragEnter({ x: Math.round(column.left / 2), y: 450 }, files([onFull]))
    await page.mouse.dragOver({ x: Math.round(column.left / 2), y: 450 }, files([onFull]))
    await page.waitForFunction((sel) => document.querySelector(sel)?.textContent?.includes("Drop file to attach"), { timeout: 5000 }, `${full} [data-composer-box]`)
    await page.$eval("[data-thread-page-zone]", (zone) => zone.dispatchEvent(new DragEvent("dragleave", { bubbles: true, relatedTarget: null })))
    await page.waitForFunction((sel) => !document.querySelector(sel)?.textContent?.includes("Drop file to attach"), { timeout: 5000 }, `${full} [data-composer-box]`)

    assert.deepEqual(errors, [], "no console/page errors during the flow")
  } finally {
    await browser.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
