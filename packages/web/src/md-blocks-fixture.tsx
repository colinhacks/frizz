import { useState } from "react"
import { createRoot } from "react-dom/client"
import "./styles.css"
import { QuestionBlockCard } from "./components/QuestionBlockCard.tsx"
import { WRAP_ANYWHERE } from "./components/TranscriptCard.tsx"
import { installCodeCopyInterceptor } from "./lib/copy-code.ts"
import { installCodeTabInterceptor } from "./lib/switch-code-tab.ts"
import { installDisclosureInterceptor } from "./lib/toggle-disclosure.ts"
import { mdInlineToHtml, mdToHtml } from "./lib/markdown.ts"
import type { BlockAnswer, ParsedQuestion } from "./lib/questionBlocks.ts"
import { setThemePreference } from "./lib/theme.ts"

// Callouts, `<details>` sections and the inline `<kbd>` / `<sub>` / `<sup>` / `<mark>` on the REAL
// transcript path — mdToHtml, its sanitizer, styles.css and the delegated listeners — in both themes
// (`?theme=light`) and at the three prose scales they render at: the transcript's 14px, a card's 13px
// (`.card-md`) and an answer chip. Each case is a shape an agent actually writes.
// lib/mdBlocks.e2e.test.ts reads it back.
const params = new URLSearchParams(location.search)
setThemePreference(params.get("theme") === "light" ? "light" : "dark")

const fence = (info: string, body: string) => `\`\`\`${info}\n${body}\n\`\`\``
const quote = (md: string) => md.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n")
const details = (summary: string, body: string, open = false) =>
  `<details${open ? " open" : ""}>\n<summary>${summary}</summary>\n\n${body}\n\n</details>`

const TYPES = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"] as const
const BODY: Record<(typeof TYPES)[number], string> = {
  NOTE: "The board reads this from `~/.frizz/config.json` on every boot.",
  TIP: "Press <kbd>⌘</kbd> <kbd>K</kbd> to open the palette from anywhere.",
  IMPORTANT: "Both packages must be published together, or a fresh install has no server behind it.",
  WARNING: "This rewrites history on `main`.",
  CAUTION: "Deleting the registry cannot be undone, and every project on the machine goes with it.",
}

const OUTPUT = details("Full test output", [
  "Everything under `packages/web` passed:",
  fence("text", "ℹ tests 63\nℹ pass 63\nℹ fail 0"),
  "- the sanitizer battery\n- the tab strip\n- the copy button",
  [fence("bash npm", "npm test"), fence("bash pnpm", "pnpm test")].join("\n\n"),
].join("\n\n"))

const INLINE = "Press <kbd>Ctrl</kbd> + <kbd>C</kbd> to stop it. The area is πr<sup>2</sup>, water is H<sub>2</sub>O, and <mark>this part</mark> is what changed."

// One paragraph, five lines: a plain line above and below each line that carries an inline box, so the
// test can read every line box's height off the distance to the next line.
const LINES = [
  "A plain line of prose with nothing in it at all.",
  "A line with a key in it: press <kbd>Esc</kbd> to leave.",
  "A line with scripts in it: E = mc<sup>2</sup> and CO<sub>2</sub>.",
  "A line with <mark>a highlight</mark> in it.",
  "A plain line to close on.",
].join("\n")

export const CASES: [string, string][] = [
  ...TYPES.map((type): [string, string] => [`callout-${type.toLowerCase()}`, quote(`[!${type}]\n${BODY[type]}`)]),
  ["callout-title", quote("[!WARNING] Before you merge `md-blocks`\nRebase first: the fence renderer moved on `main` while this branch was open.")],
  ["callout-blocks", `A callout carries any blocks:\n\n${quote([
    "[!CAUTION]",
    "The migration is one-way.",
    "",
    "- [x] Back up `frizz.db`",
    "- [ ] Stop every worker",
    "",
    fence("sh", "nub run migrate -- --to=41"),
    "",
    "Then restart the server.",
  ].join("\n"))}\n\nAnd the prose carries on below it.`],
  ["callout-empty", quote("[!IMPORTANT] Read the release notes before you update")],
  ["callout-alias", quote("[!danger]\nAn alias takes its type's title and colour.")],
  ["callout-list", `1. Rebase onto \`main\`.\n\n   ${quote("[!TIP]\nRun the suite before you push.").replace(/\n/g, "\n   ")}\n2. Push.`],
  ["callout-unknown", quote("[!sic]\nAn unknown word leaves the quote alone, beside a plain one:") + "\n\n" + quote("A plain blockquote, for comparison.")],
  ["callout-long-title", quote("[!NOTE] A title long enough that it has to wrap onto a second line in a narrow column hangs under its own first word\nBody.")],
  ["details", `Ran the suite.\n\n${OUTPUT}\n\nNothing else changed.`],
  ["details-open", details("Why this order", "The server has to be published before the shell, because the shell fetches its pinned server on first boot.", true)],
  ["details-twin", details("Why this order", "A second section with the same summary, written closed.")],
  ["details-inline", details("Output of <code>nub run typecheck</code>, <em>trimmed</em>", fence("text", "packages/web: ok\npackages/server: ok"))],
  ["details-tight", "<details>\n<summary>Written without blank lines</summary>\nThe body is **not** parsed as Markdown here,\nso it reads as plain text.\n</details>"],
  ["details-nested", details("Outer section", `Some context.\n\n${details("Inner section", "The innermost text.")}\n\n${quote("[!NOTE]\nA callout inside a section.")}`)],
  ["details-long", details("packages/web/src/components/QuestionBlockCard.tsx and a summary long enough to wrap onto a second line of a narrow column", "Body.")],
  ["details-abuse", `<details open="yes" onclick="window.__pwned='details'" data-rendered-open data-x="1" style="color:red"><summary onclick="window.__pwned='summary'" tabindex="5"><span class="md-summary-label evil">Abused</span></summary>\n\nBody survives.\n\n</details>`],
  // A `data-rendered-open` an author wrote is not the sanitizer's mark, and must not survive as one.
  ["details-forged", `<details data-rendered-open><summary>Forged</summary>\n\nWritten closed.\n\n</details>`],
  ["inline", INLINE],
  ["inline-lines", LINES],
  ["inline-abuse", `<kbd onclick="window.__pwned='kbd'" style="position:fixed">K</kbd> <sup class="x" id="y">2</sup> <mark onmouseover="window.__pwned='mark'">m</mark> <sub data-z>s</sub>`],
]

const md = (id: string) => CASES.find(([name]) => name === id)![1]

// One option's body, at the chip scale: a callout, a section and the inline tags together.
const CHIP = [
  "Publishes both packages. Press <kbd>⏎</kbd> to confirm; the footprint is 2<sup>10</sup> KB.",
  quote("[!WARNING]\nThis cannot be rolled back once npm serves it."),
  details("What ships", `- \`frizz\` 0.14.0\n- \`frizz-server\` 0.14.0\n\n${fence("sh", "gh workflow run release.yml --ref release")}`),
].join("\n\n")

const QUESTION: ParsedQuestion = {
  kind: "question",
  danger: false,
  contextMd: `Cut the release now?\n\n${quote("[!NOTE]\nThe suite last ran on this exact commit.")}`,
  options: ["A. Cut it — press <kbd>1</kbd>", "B. Hold"],
  optionBodies: [CHIP, undefined],
  recommendedIdxs: [0],
}

type FixtureWindow = Window & { __chipHits?: number; __picked?: number[]; __toggles?: string[] }
const w = window as FixtureWindow
w.__chipHits = 0
w.__picked = []
w.__toggles = []
// Every `toggle` the page sees, the browser's own echo of an inserted `<details open>` included.
document.addEventListener("toggle", (event) => {
  const el = event.target as HTMLDetailsElement
  w.__toggles!.push(`${el.closest("[data-case]")?.getAttribute("data-case")}:${el.open ? "open" : "closed"}`)
}, true)

installCodeCopyInterceptor()
installCodeTabInterceptor()
installDisclosureInterceptor()

const Case = ({ id, md }: { id: string; md: string }) => (
  <section data-case={id} dangerouslySetInnerHTML={{ __html: mdToHtml(md) }} />
)

function RealChip() {
  const [answer, setAnswer] = useState<BlockAnswer>({ chosen: null, chosenSet: [], text: "" })
  return (
    <QuestionBlockCard
      question={QUESTION}
      interactive={{
        answer,
        onChip: (i) => {
          w.__picked!.push(i)
          setAnswer((a) => ({ ...a, chosen: a.chosen === i ? null : i }))
        },
        onText: (text) => setAnswer(() => ({ chosen: null, text })),
        onSubmit: () => {},
      }}
    />
  )
}

// "Render again" rebuilds every block from its markdown, the way a streaming delta or a virtualized
// remount does: the inline `{ __html }` literals here are deliberately NOT lib/innerHtml's memoized
// ones, so React rewrites each one. It is how the test shows an opened section surviving a rebuild.
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
      {/* A document: soft wraps stay soft (`breaks: false`), and a callout must read the same. */}
      <div className="md-body mt-6 max-w-3xl" data-case="document"
        dangerouslySetInnerHTML={{ __html: mdToHtml(`${quote("[!TIP] In a document\nA hard-wrapped body\nstays one paragraph.")}\n\n${OUTPUT}`, { document: true }) }} />
      {/* A card's markdown: 13px, on the card's own panel-2 fill. */}
      <div className="card-md mt-6 max-w-xl rounded-[12px] bg-panel-2 p-4">
        <div className="md-body" data-case="card"
          dangerouslySetInnerHTML={{ __html: mdToHtml([md("callout-warning"), md("callout-tip"), OUTPUT, INLINE].join("\n\n")) }} />
        <div className="md-body mt-3" data-case="card-lines" dangerouslySetInnerHTML={{ __html: mdToHtml(LINES) }} />
      </div>
      {/* An answer chip, in the real chip's DOM shape: the stretched button FIRST, then the text. The
          card scale comes from `.card-md`, as it does around a real question card. The body does NOT
          wear the real chip's `opacity-90`: an element with opacity paints above the button whatever its
          children do, and this chip has to show that a summary is clickable by its own rule. The real
          card below keeps it. */}
      <div className="card-md mt-6 max-w-md rounded-[12px] bg-panel-2 p-4">
        <div data-question-option className="relative flex items-baseline gap-2 rounded-md border border-border px-3 py-1.5 text-[12px] leading-snug">
          <button type="button" data-chip-hit className="absolute inset-0 rounded-md outline-none" aria-label="Pick this option"
            onClick={() => { w.__chipHits! += 1 }} />
          <div className="min-w-0 flex-1">
            <div><span className="md-inline" data-case="chip-label" dangerouslySetInnerHTML={{ __html: mdInlineToHtml("Cut it — press <kbd>1</kbd>, 2<sup>10</sup> KB, <mark>now</mark>") }} /></div>
            <div className="md-body mt-1.5" data-case="chip" dangerouslySetInnerHTML={{ __html: mdToHtml(CHIP) }} />
          </div>
        </div>
        {/* A chip's LABEL is the inline path, at the chip's own 12px and snug leading. */}
        <div className="mt-3 text-[12px] leading-snug">
          <span className="md-inline" data-case="chip-lines" dangerouslySetInnerHTML={{ __html: mdInlineToHtml(LINES) }} />
        </div>
      </div>
      {/* The real card, so the chip's own click filter is what decides whether a summary picks. */}
      <div className="mt-6 max-w-xl" data-case="question">
        <RealChip />
      </div>
      {/* A narrow card column. */}
      <div className={`md-body mt-6 w-[300px] text-[14px] ${WRAP_ANYWHERE}`}
        data-case="narrow" dangerouslySetInnerHTML={{ __html: mdToHtml([md("callout-title"), md("callout-long-title"), INLINE, OUTPUT, md("details-long")].join("\n\n")) }} />
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
