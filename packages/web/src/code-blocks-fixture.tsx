import { useState } from "react"
import { createRoot } from "react-dom/client"
import "./styles.css"
import { DiffBlock } from "./components/DiffBlock.tsx"
import { WRAP_ANYWHERE } from "./components/TranscriptCard.tsx"
import { initCodeWrap } from "./lib/codeWrap.ts"
import { installCodeCopyInterceptor } from "./lib/copy-code.ts"
import { installCodeExpandInterceptor } from "./lib/expand-code.ts"
import { prefs } from "./lib/prefs.ts"
import { installCodeTabInterceptor } from "./lib/switch-code-tab.ts"
import { mdToHtml } from "./lib/markdown.ts"
import { setThemePreference } from "./lib/theme.ts"

// What lib/codeBlock.ts adds to a fence — marked lines, a rendered diff, the clamp on a long block —
// on the REAL transcript path: mdToHtml, its sanitizer, styles.css and the delegated listeners, in both
// themes (`?theme=light`) and at the prose scales a fence renders at. Each case is a shape an agent
// actually writes. lib/codeBlocks.e2e.test.ts reads it back; code-tabs-fixture covers titles and tabs.
const params = new URLSearchParams(location.search)
setThemePreference(params.get("theme") === "light" ? "light" : "dark")

const fence = (info: string, body: string) => `\`\`\`${info}\n${body}\n\`\`\``

const retry = [
  "export async function retry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {",
  "  let last: unknown",
  "  for (let attempt = 0; attempt < attempts; attempt++) {",
  "    try {",
  "      return await run()",
  "    } catch (error) {",
  "      last = error",
  "      await sleep(2 ** attempt * 100)",
  "    }",
  "  }",
  "  throw last",
  "}",
].join("\n")

const change = [
  " export async function retry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {",
  "   let last: unknown",
  "   for (let attempt = 0; attempt < attempts; attempt++) {",
  "     try {",
  "       return await run()",
  "     } catch (error) {",
  "       last = error",
  "-      await sleep(100)",
  "+      // Back off: 100ms, 200ms, 400ms.",
  "+      await sleep(2 ** attempt * 100)",
  "     }",
  "   }",
].join("\n")

const gitDiff = [
  "diff --git a/packages/server/src/retry.ts b/packages/server/src/retry.ts",
  "index 3f1c2aa..9b04e17 100644",
  "--- a/packages/server/src/retry.ts",
  "+++ b/packages/server/src/retry.ts",
  "@@ -96,9 +96,10 @@ export async function retry<T>(run: () => Promise<T>, attempts = 3): Promise<T> {",
  change.split("\n").slice(1, 11).join("\n"),
  "@@ -1204,4 +1205,4 @@ export function sleep(ms: number) {",
  "   return new Promise((resolve) => {",
  "-    setTimeout(resolve, ms)",
  "+    setTimeout(resolve, Math.max(0, ms))",
  "   })",
].join("\n")

const long = (n: number) => Array.from({ length: n }, (_, i) =>
  i % 9 === 0 ? `// section ${i / 9 + 1}` : `export const value${i + 1} = compute(${i + 1}, "${"x".repeat(i % 7)}")`).join("\n")

export const CASES: [string, string][] = [
  ["marked", `The backoff is the two marked lines:\n\n${fence("ts {7-8}", retry)}\n\nNothing else changed.`],
  ["marked-titled", fence(`ts title="packages/server/src/retry.ts" {3,8}`, retry)],
  ["marked-wide", fence("bash {2}", `nub run build\ncurl -fsSL https://example.com/install.sh | FRIZZ_HOME=/opt/frizz FRIZZ_CHANNEL=stable FRIZZ_TELEMETRY=off bash -s -- --yes --no-modify-path --quiet\nnub run test`)],
  ["diff", `A diff with no language named:\n\n${fence("diff", change)}`],
  ["diff-ts", `The same change as \`ts-diff\`:\n\n${fence("ts-diff", change)}`],
  ["diff-loose", fence("py-diff", `def retry(run, attempts=3):\n    for attempt in range(attempts):\n-        time.sleep(0.1)\n+        time.sleep(2 ** attempt / 10)\n    raise last`)],
  ["diff-git", fence("diff", gitDiff)],
  ["diff-titled", fence(`diff title="packages/server/src/retry.ts"`, change)],
  ["diff-tabs", [fence(`diff retry.ts`, change), fence(`diff sleep.ts`, ` export function sleep(ms: number) {\n-  return new Promise((resolve) => setTimeout(resolve, ms))\n+  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))\n }`)].join("\n\n")],
  ["diff-wide", fence("ts-diff", `-const url = "https://api.example.com/v1/threads?limit=100&cursor=" + encodeURIComponent(cursor) + "&include=messages,attachments,reactions"\n+const url = threadsUrl({ limit: 100, cursor, include: ["messages", "attachments", "reactions"] })`)],
  ["long", `A whole file:\n\n${fence("ts", long(64))}\n\nAnd prose after it.`],
  ["long-titled", fence(`ts title="packages/web/src/lib/values.ts"`, long(48))],
  ["long-tabs", [fence("ts values.ts", long(52)), fence("ts short.ts", "export const short = true"), fence("ts more.ts", long(44))].join("\n\n")],
  ["long-diff", fence("ts-diff", Array.from({ length: 50 }, (_, i) => `${i % 5 === 0 ? "-" : i % 5 === 1 ? "+" : " "}export const value${i} = ${i}`).join("\n"))],
  ["at-limit", fence("ts", long(40))],
  ["plain", fence("ts", retry)],
]

const EDIT_OLD = [
  "export function threadsUrl(cursor: string) {",
  `  const url = "https://api.example.com/v1/threads?limit=100&cursor=" + encodeURIComponent(cursor) + "&include=messages,attachments,reactions"`,
  "  return url",
  "}",
].join("\n")
const EDIT_NEW = EDIT_OLD.replace(/^ {2}const url = .*$/m, `  const url = build({ limit: 100, cursor, include: ["messages", "attachments", "reactions"] })`)

// The app does these in main.tsx.
initCodeWrap()
installCodeCopyInterceptor()
installCodeTabInterceptor()
installCodeExpandInterceptor()

const Case = ({ id, md }: { id: string; md: string }) => (
  <section data-case={id} dangerouslySetInnerHTML={{ __html: mdToHtml(md) }} />
)

const sample = [CASES[0][1], CASES[4][1], CASES[10][1]].join("\n\n")

// "Render again" rebuilds every block from its markdown, the way a streaming delta or a virtualized
// remount does — see code-tabs-fixture. It is how the test shows an opened block surviving a rebuild.
function Fixture() {
  const [renders, setRenders] = useState(0)
  return (
  <main className="bg-bg p-6 text-fg" data-renders={renders}>
    <button type="button" data-rerender className="mb-4 text-muted underline" onClick={() => setRenders((n) => n + 1)}>
      Render again
    </button>
    {/* The Settings drawer's "Wrap code" row writes this same preference; lib/codeWrap.ts and the
        stylesheet do the rest, on blocks that are already drawn. */}
    <button type="button" data-wrap-code className="mb-4 ml-4 text-muted underline" onClick={() => (prefs.wrapCode = !prefs.wrapCode)}>
      Flip wrap code
    </button>
    <div className="md-body flex max-w-3xl flex-col gap-6 text-[14px]">
      {CASES.map(([id, md]) => <Case key={id} id={id} md={md} />)}
    </div>
    {/* The file reader's rendering: long blocks are left open. */}
    <div className="md-body mt-6 max-w-3xl" data-case="document" dangerouslySetInnerHTML={{ __html: mdToHtml(CASES[10][1], { document: true }) }} />
    {/* A card's markdown: 13px, on the card's own panel-2 fill. */}
    <div className="card-md mt-6 max-w-xl rounded-[12px] bg-panel-2 p-4">
      <div className="md-body" data-case="card" dangerouslySetInnerHTML={{ __html: mdToHtml(sample) }} />
    </div>
    {/* An answer chip: translucent block chrome under the chip's stretched button. */}
    <div data-question-option className="relative mt-6 max-w-md rounded-md bg-panel-2 p-3">
      <button type="button" data-chip-hit className="absolute inset-0" aria-label="Pick this option" />
      <div className="md-body" data-case="chip" dangerouslySetInnerHTML={{ __html: mdToHtml(sample) }} />
    </div>
    {/* A narrow card column (TranscriptCard WRAP_ANYWHERE): 300px for a block to wrap in, or to scroll inside with Wrap code off. */}
    <div className={`md-body mt-6 w-[300px] text-[14px] ${WRAP_ANYWHERE}`}
      data-case="narrow" dangerouslySetInnerHTML={{ __html: mdToHtml(sample) }} />
    {/* The Edit card: the same rows drawn from a tool call rather than a fence, and wrapped the same way. */}
    <div className="mt-6 max-w-3xl" data-case="edit-card">
      <DiffBlock edits={[{ file: "/fixture/src/threads.ts", old: EDIT_OLD, new: EDIT_NEW }]} />
    </div>
  </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
