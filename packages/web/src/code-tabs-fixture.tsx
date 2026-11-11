import { useState } from "react"
import { createRoot } from "react-dom/client"
import "./styles.css"
import { WRAP_ANYWHERE } from "./components/TranscriptCard.tsx"
import { installCodeCopyInterceptor } from "./lib/copy-code.ts"
import { installCodeTabInterceptor } from "./lib/switch-code-tab.ts"
import { mdToHtml } from "./lib/markdown.ts"
import { setThemePreference } from "./lib/theme.ts"

// Code tabs on the REAL transcript path — mdToHtml, its sanitizer, styles.css and the two delegated
// listeners — in both themes (`?theme=light`) and at the three prose scales a fence renders at: the
// transcript's 14px, a card's 13px (`.card-md`) and an answer chip. Each case is a shape an agent
// actually writes. lib/codeTabs.e2e.test.ts reads it back.
const params = new URLSearchParams(location.search)
setThemePreference(params.get("theme") === "light" ? "light" : "dark")

const fence = (info: string, body: string) => `\`\`\`${info}\n${body}\n\`\`\``

const install = [
  fence("bash npm", "npm install frizz\nnpx frizz"),
  fence("bash pnpm", "pnpm add frizz\npnpm dlx frizz"),
  fence("bash yarn", "yarn add frizz"),
].join("\n\n")

export const CASES: [string, string][] = [
  ["install", `Install it with whichever package manager the repo uses:\n\n${install}\n\nThen open the board.`],
  ["files", [
    fence(`ts title="src/server.ts"`, `import { createServer } from "node:http"\n\nexport const server = createServer((req, res) => {\n  res.end("ok")\n})`),
    fence(`ts title="src/client.ts"`, `const res = await fetch("http://localhost:3000")\nconsole.log(await res.text())`),
    fence(`json title="package.json"`, `{\n  "name": "demo",\n  "type": "module"\n}`),
  ].join("\n\n")],
  ["languages", [
    fence("bash curl", `curl -s https://api.example.com/v1/threads -H "authorization: Bearer $TOKEN"`),
    fence("python Python", `import requests\n\nthreads = requests.get("https://api.example.com/v1/threads", headers=auth).json()`),
    fence("ts TypeScript", `const threads = await fetch("https://api.example.com/v1/threads", { headers: auth }).then((r) => r.json())`),
  ].join("\n")],
  ["titled", `One labelled fence is a title, not a tab:\n\n${fence("ts packages/web/src/lib/codeTabs.ts", "export const CODE_TABS_CLASS = \"md-code-tabs\"")}`],
  ["overflow", Array.from({ length: 9 }, (_, i) =>
    fence(`ts title="packages/web/src/components/Panel${i + 1}.tsx"`, `export const panel = ${i + 1}`)).join("\n\n")],
  ["long-label", [
    fence(`ts title="packages/server/src/a/very/deep/directory/tree/that/keeps/going/handler.ts"`, "export {}"),
    fence("ts b.ts", "export {}"),
  ].join("\n\n")],
  ["wide", [
    fence("bash one-liner", `curl -fsSL https://example.com/install.sh | FRIZZ_HOME=/opt/frizz FRIZZ_CHANNEL=stable FRIZZ_TELEMETRY=off bash -s -- --yes --no-modify-path --quiet`),
    fence("ansi Output", "\\e[32m✔\\e[0m installed frizz 0.13.12"),
  ].join("\n\n")],
  ["list", `1. Install it:\n\n   ${fence("bash npm", "npm install frizz").replace(/\n/g, "\n   ")}\n\n   ${fence("bash pnpm", "pnpm add frizz").replace(/\n/g, "\n   ")}\n2. Run \`npx frizz\`.`],
  ["plain", `Unlabelled neighbours stay two blocks — a command and its output:\n\n${fence("bash", "nub run test")}\n\n${fence("text", "ℹ pass 63\nℹ fail 0")}`],
]

installCodeCopyInterceptor()
installCodeTabInterceptor()

const Case = ({ id, md }: { id: string; md: string }) => (
  <section data-case={id} dangerouslySetInnerHTML={{ __html: mdToHtml(md) }} />
)

// "Render again" rebuilds every block from its markdown, the way a streaming delta or a virtualized
// remount does: the inline `{ __html }` literals here are deliberately NOT lib/innerHtml's memoized
// ones, so React rewrites each one. It is how the test shows a chosen tab surviving a rebuild.
function Fixture() {
  const [renders, setRenders] = useState(0)
  return (
  <main className="bg-bg p-6 text-fg" data-renders={renders}>
    <button type="button" data-rerender className="mb-4 text-muted underline" onClick={() => setRenders((n) => n + 1)}>
      Render again
    </button>
    <div className="md-body flex max-w-3xl flex-col gap-6 text-[14px]">
      {CASES.map(([id, md]) => <Case key={id} id={id} md={md} />)}
    </div>
    {/* A card's markdown: 13px, on the card's own panel-2 fill. */}
    <div className="card-md mt-6 max-w-xl rounded-[12px] bg-panel-2 p-4">
      <div className="md-body" data-case="card" dangerouslySetInnerHTML={{ __html: mdToHtml(install) }} />
    </div>
    {/* An answer chip: translucent block chrome under the chip's stretched button. */}
    <div data-question-option className="relative mt-6 max-w-md rounded-md bg-panel-2 p-3">
      <button type="button" data-chip-hit className="absolute inset-0" aria-label="Pick this option" />
      <div className="md-body" data-case="chip" dangerouslySetInnerHTML={{ __html: mdToHtml(install) }} />
    </div>
    {/* A narrow card column (TranscriptCard WRAP_ANYWHERE): 300px for a block to wrap in, or to scroll inside with Wrap code off. */}
    <div className={`md-body mt-6 w-[300px] text-[14px] ${WRAP_ANYWHERE}`}
      data-case="narrow" dangerouslySetInnerHTML={{ __html: mdToHtml(CASES[1][1]) }} />
  </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
