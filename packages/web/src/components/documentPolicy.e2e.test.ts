import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

// The BUILT dashboard document is served with a policy naming the scripts that may run in it
// (packages/server/src/local-origin.ts documentScriptPolicy). Two things have to stay true of it, and
// only a browser on a built bundle can say either:
//
//   1. the app needs nothing the policy refuses, on any of a thread's surfaces, with everything a
//      message can draw on screen;
//   2. what the policy exists to stop is stopped: an inline handler, an injected script, `eval`, a
//      `javascript:` link, a script from elsewhere, a `<base>`.
//
// The Vite dev server sends no such policy, so a dependency that starts to need `eval`, an inline script
// or a worker from a blob works in every other test here and breaks only once built. This is the test
// that finds it. It needs a `--prod` stack; the worker is the scripted one, so nothing signs in:
//   (cd packages/web && nub run build)
//   nub scripts/adhoc-stack.mjs --port=<port> --prod --project=<a throwaway git repo> --claude-bin=$PWD/scripts/scripted-claude.mjs
//   FRIZZ_DOCUMENT_POLICY_E2E_URL=http://127.0.0.1:<port> nub run test <this file>
const baseUrl = process.env.FRIZZ_DOCUMENT_POLICY_E2E_URL

const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

// One message with every block the renderer has, and three things in it that must never run.
const richMessage = (picture: string) => `# Everything a message can draw

A paragraph with **bold**, *emphasis*, \`inline code\` and a [link](https://example.com/).

<img src="x" onerror="window.__ranFromMessage=1"> <a href="javascript:window.__ranFromMessage=2">a link that must not run</a>

<script>window.__ranFromMessage=3</script>

| Store | Survives a crash |
|---|---|
| SQLite | yes |
| JSON file | no |

> [!WARNING] Before you merge
> The migration cannot be rolled back.

<details>
<summary>The full log</summary>

A line most readers skip, with <kbd>K</kbd> and <mark>marked</mark> text.

</details>

\`\`\`ts title="src/server.ts" {2}
export function add(a: number, b: number): number {
  return a + b
}
\`\`\`

\`\`\`ts-diff
-  await sleep(100)
+  await sleep(2 ** attempt * 100)
\`\`\`

\`\`\`mermaid
graph TD
  A[Dispatch] --> B{Rested?}
  B -->|yes| C[Queue]
  B -->|no| D[Active]
\`\`\`

\`\`\`lightbox
${picture}  A capture
\`\`\`

DOCUMENT-POLICY-END

\`\`\`question
id: document-policy-store
kind: choice
question: Which store should the probe use?
options:
  - label: SQLite
    description: Transactional
    recommended: true
  - label: JSON file
    description: Hand-editable
\`\`\`
`

interface Refusal { via: "event" | "console"; stage: string; directive?: string; text?: string }

test("the built app runs under its document's script policy, and what the policy exists to stop does not run", { skip: !baseUrl, timeout: 180_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "document-policy-"))
  const picture = join(dir, "capture.png")
  writeFileSync(picture, Buffer.from(PIXEL, "base64"))
  writeFileSync(join(dir, "rich.md"), richMessage(picture))
  writeFileSync(join(dir, "turns.json"), JSON.stringify({ think: 50, turns: [{ on: "DOCUMENT-POLICY", tools: [{ command: "printf 'one\\ntwo\\n'", description: "Printing two lines" }], textFile: join(dir, "rich.md") }], otherwise: { tools: [], text: "ok" } }))

  const { createRpcClient } = await import("../../../../scripts/lib/rpc-client.mjs")
  const api = createRpcClient(`${baseUrl}/`)
  await api.waitForHealth()
  const { slug } = await api.mutate("dispatch", { prompt: `[script file=${join(dir, "turns.json")}] DOCUMENT-POLICY draw everything`, backend: "claude", model: "haiku", effort: "low" }) as { slug: string }
  let projectSlug = ""
  for (let i = 0; i < 160 && !projectSlug; i++) {
    const board = await api.query("board") as { projectSlug: string; threads: { id: string; runtime: string }[] }
    if (board.threads.find((t) => t.id === slug)?.runtime === "turn-idle") projectSlug = board.projectSlug
    else await new Promise((r) => setTimeout(r, 250))
  }
  assert.ok(projectSlug, "the scripted thread came to rest")

  const { launchHeadless } = await import("../../../../scripts/lib/headless-browser.mjs")
  const browser = await launchHeadless()
  try {
    const refusals: Refusal[] = []
    const errors: string[] = []
    let stage = "board"
    const watch = async (page: Awaited<ReturnType<typeof browser.newPage>>) => {
      await page.exposeFunction("__policyRefused", (directive: string) => { refusals.push({ via: "event", stage, directive }) })
      await page.evaluateOnNewDocument(() => {
        document.addEventListener("securitypolicyviolation", (event) => (window as unknown as { __policyRefused: (d: string) => void }).__policyRefused(event.effectiveDirective))
      })
      page.on("console", (m) => { if (/Content Security Policy/i.test(m.text())) refusals.push({ via: "console", stage, text: m.text().slice(0, 200) }) })
      page.on("pageerror", (e) => errors.push(`${stage}: ${String(e)}`))
    }
    const drawn = (page: Awaited<ReturnType<typeof browser.newPage>>) => page.waitForFunction(
      () => document.body.innerText.includes("DOCUMENT-POLICY-END") && !!document.querySelector("[data-mermaid-state='ready'] svg"),
      { timeout: 30_000 },
    )

    // ── the board's pane ──────────────────────────────────────────────────────────────────────────────
    const page = await browser.newPage()
    await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 })
    await watch(page)
    const board = await page.goto(`${baseUrl}/project/${projectSlug}?thread=${slug}`, { waitUntil: "networkidle2" })
    const policy = board?.headers()["content-security-policy"] ?? ""
    assert.match(policy, /^frame-ancestors 'none'; script-src 'self'( 'sha256-[A-Za-z0-9+/]+=*')+; object-src 'none'; base-uri 'none'$/, "the document names its scripts. A stack without --prod sends no such policy: this test needs a built bundle")
    await drawn(page)
    const pane = await page.evaluate(() => ({
      tables: document.querySelectorAll("table").length,
      code: document.querySelectorAll("pre").length,
      pictures: [...document.querySelectorAll("img")].filter((img) => img.src.includes("local-image")).map((img) => img.complete && img.naturalWidth > 0),
      question: document.body.innerText.includes("Which store should the probe use?"),
      ranFromMessage: (window as unknown as { __ranFromMessage?: number }).__ranFromMessage ?? null,
    }))
    assert.ok(pane.tables >= 1 && pane.code >= 2 && pane.question, JSON.stringify(pane))
    assert.deepEqual(pane.pictures, [true], "the gallery's picture loaded")
    assert.equal(pane.ranFromMessage, null, "nothing in the message ran")

    // The layers a person opens over it: the lightbox, the palette, Settings.
    stage = "layers"
    await page.click("img[src*='local-image']")
    await page.waitForSelector("[role='dialog']", { timeout: 10_000 })
    await page.keyboard.press("Escape")
    await page.keyboard.down("Meta")
    await page.keyboard.press("k")
    await page.keyboard.up("Meta")
    await page.waitForSelector("[role='dialog']", { timeout: 10_000 })
    await page.keyboard.press("Escape")
    await page.click("[aria-label='Settings']")
    await page.waitForSelector("[data-settings-panel]", { timeout: 10_000 })
    await page.keyboard.press("Escape")

    // ── the full-screen page, then the same document revalidated ──────────────────────────────────────
    stage = "thread page"
    const full = await page.goto(`${baseUrl}/project/${projectSlug}/thread/${slug}`, { waitUntil: "networkidle2" })
    assert.equal(full?.headers()["content-security-policy"], policy, "a deep link is the same document")
    await drawn(page)
    stage = "reload"
    const again = await page.reload({ waitUntil: "networkidle2" })
    assert.equal(again?.headers()["content-security-policy"], policy, "a revalidated copy carries the policy too")
    await drawn(page)

    // ── a phone, where the thread opens as a drawer ───────────────────────────────────────────────────
    stage = "phone"
    const phone = await browser.newPage()
    await phone.setViewport({ width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true })
    await watch(phone)
    await phone.goto(`${baseUrl}/project/${projectSlug}?thread=${slug}`, { waitUntil: "networkidle2" })
    await drawn(phone)
    await phone.close()

    // Typed, or the assertion narrows `refusals` to an empty list for the rest of the test.
    assert.deepEqual(refusals, [] as Refusal[], "the app needed nothing the policy refuses")
    assert.deepEqual(errors, [], "no page error")

    // ── what the policy exists to stop ────────────────────────────────────────────────────────────────
    // From a task of the page's own. Code the debugger calls is let past `eval`'s check, so these lines
    // called straight from `page.evaluate` would run and prove nothing.
    stage = "control"
    await page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>
      w.__control = null
      setTimeout(async () => {
        const out: Record<string, unknown> = {}
        const holder = document.createElement("div")
        holder.innerHTML = '<img src="data:image/png;base64,AAAA" onerror="window.__ran1=1">'
        document.body.append(holder)
        const inline = document.createElement("script")
        inline.textContent = "window.__ran2=1"
        document.body.append(inline)
        try { (0, eval)("window.__ran3=1"); out.eval = "ran" } catch (error) { out.eval = (error as Error).name }
        try { new Function("window.__ran4=1")(); out.fn = "ran" } catch (error) { out.fn = (error as Error).name }
        const link = document.createElement("a")
        link.href = "javascript:window.__ran5=1"
        document.body.append(link)
        link.click()
        const remote = document.createElement("script")
        remote.src = "http://127.0.0.1:9/x.js"
        document.body.append(remote)
        const base = document.createElement("base")
        base.href = "http://127.0.0.1:9/"
        document.head.append(base)
        out.baseTook = document.baseURI.startsWith("http://127.0.0.1:9/")
        base.remove()
        await new Promise((r) => setTimeout(r, 1000))
        out.ran = [1, 2, 3, 4, 5].map((i) => w[`__ran${i}`] ?? null)
        w.__control = out
      }, 0)
    })
    await page.waitForFunction(() => (window as unknown as { __control: unknown }).__control !== null, { timeout: 15_000 })
    const control = await page.evaluate(() => (window as unknown as { __control: { eval: string; fn: string; baseTook: boolean; ran: unknown[] } }).__control)
    assert.deepEqual(control.ran, [null, null, null, null, null], "none of the five ran")
    assert.deepEqual([control.eval, control.fn], ["EvalError", "EvalError"])
    assert.equal(control.baseTook, false)
    const reported = new Set(refusals.filter((r) => r.via === "event" && r.stage === "control").map((r) => r.directive))
    for (const directive of ["script-src-attr", "script-src-elem", "script-src", "base-uri"]) assert.ok(reported.has(directive), `${directive} was reported (saw ${[...reported].join(", ")})`)
    assert.ok(await page.evaluate(() => document.body.innerText.includes("DOCUMENT-POLICY-END")), "and the app is still running")
  } finally {
    await browser.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
