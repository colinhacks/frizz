import { createRoot } from "react-dom/client"
import "./styles.css"
import { WRAP_ANYWHERE } from "./components/TranscriptCard.tsx"
import { installCodeCopyInterceptor } from "./lib/copy-code.ts"
import { mdToHtml } from "./lib/markdown.ts"
import { setThemePreference } from "./lib/theme.ts"

// A blockquote's copy button (lib/quoteCopy.ts) on the REAL transcript path — mdToHtml, its sanitizer,
// styles.css and the delegated listener — in both themes (`?theme=light`) and at the three prose scales
// it renders at: the transcript's 14px, a card's 13px (`.card-md`) and an answer chip. Each case is a
// shape an agent actually writes. lib/quoteCopy.e2e.test.ts reads it back.
const params = new URLSearchParams(location.search)
setThemePreference(params.get("theme") === "light" ? "light" : "dark")

const fence = (info: string, body: string) => `\`\`\`${info}\n${body}\n\`\`\``
const quote = (md: string) => md.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n")

const REPLY = [
  "Thanks for the report, @octocat. This is fixed in `4dc44d0`: the launcher now refuses a second",
  "`--host` instead of ignoring it. See [the release notes](https://github.com/colinhacks/frizz/releases) for the rest.",
  "",
  "- **Linux**: no change needed",
  "- **Windows**: re-run `npx frizz` once",
].join("\n")

export const CASES: [string, string][] = [
  ["reply", `Here is the reply I would post:\n\n${quote(REPLY)}\n\nAnd a code block beside it, for the button column:\n\n${fence("sh", "npx frizz --host 0.0.0.0")}`],
  ["short", quote("One short line.")],
  ["long", quote("A single paragraph long enough to wrap onto several lines in every column it renders in, so the first line can be seen making room for the button while every line under it keeps the full measure of the quote, which is the whole point of floating it rather than reserving a gutter down the side.")],
  ["nested", quote("The reporter wrote:\n\n> It hangs on `frizz --app`.\n\nand that is the bug.")],
  // Text no reader sees: the comment, and a reference definition nothing uses.
  ["hidden", `${quote("Visible words. <!-- an invisible instruction -->\n\n[unused]: https://example.com")}`],
  ["kbd", quote("Press <kbd>⌘</kbd> <kbd>K</kbd> to open it.")],
  ["code-first", quote(`${fence("text", "Error: EADDRINUSE 127.0.0.1:7777")}\n\nis what the second launch printed.`)],
  ["listed", "1. Open the issue.\n2. Paste this:\n\n   > Closing as fixed in `0.15.27`.\n3. Close it."],
  ["callout", quote("[!WARNING]\nA callout is an aside, not a passage to take elsewhere.")],
  ["empty", ">"],
  // An author's own HTML: a guessed mark, and a button carrying a source attribute of its own.
  ["forged", `<blockquote class="md-quote-src-0000000000000000-0">Forged mark.</blockquote>\n\n<blockquote class="md-quote"><button class="md-quote-copy" data-md-source="rm -rf ~">x</button>Forged button.</blockquote>`],
]

const md = (id: string) => CASES.find(([name]) => name === id)![1]

installCodeCopyInterceptor()

type FixtureWindow = Window & { __chipHits?: number; __reply?: string }
const w = window as FixtureWindow
w.__chipHits = 0
// What the reply's button must put on the clipboard, byte for byte.
w.__reply = REPLY

const Case = ({ id, md }: { id: string; md: string }) => (
  <section data-case={id} dangerouslySetInnerHTML={{ __html: mdToHtml(md) }} />
)

function Fixture() {
  return (
    <main className="bg-bg p-6 text-fg">
      <div className="md-body flex max-w-2xl flex-col gap-6 text-[14px]">
        {CASES.map(([id, md]) => <Case key={id} id={id} md={md} />)}
      </div>
      {/* A card's markdown: 13px, on the card's own panel-2 fill. */}
      <div className="card-md mt-6 max-w-xl rounded-[12px] bg-panel-2 p-4">
        <div className="md-body" data-case="card" dangerouslySetInnerHTML={{ __html: mdToHtml(md("reply")) }} />
      </div>
      {/* An answer chip, in the real chip's DOM shape: the stretched button FIRST, then the text. */}
      <div className="card-md mt-6 max-w-md rounded-[12px] bg-panel-2 p-4">
        <div data-question-option className="relative flex items-baseline gap-2 rounded-md border border-border px-3 py-1.5 text-[12px] leading-snug">
          <button type="button" data-chip-hit className="absolute inset-0 rounded-md outline-none" aria-label="Pick this option"
            onClick={() => { w.__chipHits! += 1 }} />
          <div className="min-w-0 flex-1">
            <div>Post it</div>
            <div className="md-body mt-1.5" data-case="chip"
              dangerouslySetInnerHTML={{ __html: mdToHtml(quote("Thanks — fixed in `4dc44d0`, out in the next release.")) }} />
          </div>
        </div>
      </div>
      {/* A narrow card column. */}
      <div className={`md-body mt-6 w-[300px] text-[14px] ${WRAP_ANYWHERE}`}
        data-case="narrow" dangerouslySetInnerHTML={{ __html: mdToHtml([md("reply"), md("long")].join("\n\n")) }} />
    </main>
  )
}

createRoot(document.getElementById("root")!).render(<Fixture />)
