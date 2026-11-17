import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { useState } from "react"
import type { ChatMessage } from "./hooks.ts"
import { Message } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { mdToHtml } from "./lib/markdown.ts"
import "./styles.css"

// MOCKUP SHEET — A BETTER DRAWING FOR `> [!WARNING]` AND ITS FOUR SIBLINGS.
//
// Not shipped UI and not a test. The maintainer, 2026-10-19, on a shot of a "Broken today" warning in a
// transcript: "Why does this look so saturated? I really don't like it", then: "I think these
// GitHub-flavored Markdown callouts need a better UI in general. Why don't you mock up some options?"
//
// PICKED: G, the header bar, with the calm ink, 2026-10-20 ("header bar."). Shipped as styles.css
// § Callouts with the inks as theme.css `--frizz-callout-*`. The sheet stays as the record of what was
// weighed, but every shape here is drawn OVER the base styles, and the base is now G — so the other
// sections no longer show what they showed then. Check out 0fafff76 to see them as they were.
//
// SUPERSEDED 2026-11-16: the header bar gave way to a tinted panel with no border and no strip, picked
// from five edges mocked as one self-contained page over the compiled stylesheet. styles.css § Callouts
// has the history; every shape below is now drawn over that panel.
//
// WHY IT IS SO LOUD (read from the code and the shot on 2026-10-19): the warning's rule, icon and title
// all paint `--color-attention`, which in dark is Tailwind's `amber-400`, oklch(0.828 0.189 84). That is
// the brightest colour in the callout set (the other four sit at L 0.69-0.75) and it lies OUTSIDE sRGB,
// so a Display P3 screen draws it more vivid than any hex could: the shot's bar reads P3 #ffb900.
// `red-400` for caution is the same story by a hair. The other three are the app's own sRGB hexes.
//
// TWO SWITCHES, because those are two questions. INK picks the five colours: today's status tokens, a
// calm set (every type at one OKLCH lightness and chroma, all inside sRGB), or a quieter muted set.
// SHAPE is each section: today's rule-and-title, then seven other drawings. Every shape is CSS over the
// REAL markup — mdToHtml's `blockquote.md-callout > p.md-callout-title` and styles.css's icon mask — so
// the one picked moves into styles.css as written. The left frame is the REAL Message on the thread
// drawer's panel; the right is a queue card's 13px markdown on its panel-2.
//
//   nubx vite --port 5947 --strictPort   (from packages/web), then
//   http://localhost:5947/callout-mockup-fixture.html
document.documentElement.dataset.font = "sans"
const params = new URLSearchParams(location.search)
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark"

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  // location.href, not origin: the page also ships as one file:// document, whose origin is "null".
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.href)
  if (url.pathname.includes("/_frizz/")) return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  return originalFetch(input, init)
}

const quote = (md: string) => md.split("\n").map((line) => (line ? `> ${line}` : ">")).join("\n")

// The maintainer's own shot, as near as it can be rebuilt: a paragraph, the warning with its own title
// and two code spans, a bold-led paragraph, a list, and a code block for the callout to stand beside.
const EXCERPT = [
  "Previews now read the bot identity from run-context. One fidelity cost: `pullfrogdev` already has the reduced permission set, so previews would test that set rather than production's until the production App is flipped.",
  quote("[!WARNING] Broken today\n`better-gnat-45` still holds a revoked GitHub client secret. Every token refresh fails with `incorrect_client_credentials`. GitHub sign-in on previews, and on local dev with preview credentials, is broken until it gets a new secret."),
  "**Preview hardening, keeping the production fork.** These entries are still shared between Preview and Production:",
  "- the R2 bucket keys: preview code can read and write production's buckets, including uploads\n- the webhook secret, so a preview can verify production's deliveries",
  "```sh\nwrangler secret put GITHUB_CLIENT_SECRET --env preview\n```",
].join("\n\n")

const FIVE = [
  quote("[!NOTE]\nThe suite last ran on this exact commit."),
  quote("[!TIP]\nRun `nub run test` before you push."),
  quote("[!IMPORTANT]\nBoth packages must be published together, or a fresh install has no server behind it."),
  quote("[!WARNING]\nThis rewrites history on `main`."),
  quote("[!CAUTION]\nDeleting the registry cannot be undone."),
  quote("[!NOTE] Two blocks\nA callout can hold more than one paragraph:\n\n- the first item\n- the second item"),
].join("\n\n")

const AGENT: ChatMessage = {
  sourceId: "callout-excerpt",
  role: "assistant",
  text: EXCERPT,
  tools: [],
  parts: [{ kind: "text", text: EXCERPT }],
  at: new Date(Date.now() - 4 * 60_000).toISOString(),
} as ChatMessage

// ── ink ────────────────────────────────────────────────────────────────────────────────────────────────
// Calm: OKLCH L 0.76 / C 0.115 in dark, L 0.52 / C 0.105 in light. Muted: C 0.075 and 0.07. Hues are the
// status tokens' own (254 blue, 154 green, 303 violet, 80 gold, 24 red). Every value is inside sRGB.
const INK_CSS = `
.co-sheet[data-ink="calm"] { --ink-note: #7db5f9; --ink-tip: #72c78f; --ink-important: #c09fed; --ink-warning: #d7a955; --ink-caution: #f1938d; }
.co-sheet[data-ink="muted"] { --ink-note: #8aaeda; --ink-tip: #86b995; --ink-important: #b4a0d2; --ink-warning: #c4a674; --ink-caution: #d69994; }
:root[data-theme="light"] .co-sheet[data-ink="calm"] { --ink-note: #3b6ba4; --ink-tip: #2d7a4c; --ink-important: #75599a; --ink-warning: #886108; --ink-caution: #9c4e4b; }
:root[data-theme="light"] .co-sheet[data-ink="muted"] { --ink-note: #4c6b91; --ink-tip: #477556; --ink-important: #715f8a; --ink-warning: #7e6438; --ink-caution: #8d5955; }
${["note", "tip", "important", "warning", "caution"].map((t) => `.co-sheet:not([data-ink="today"]) .md-body .md-callout-${t} { --md-callout-ink: var(--ink-${t}); }`).join("\n")}
`

// ── shapes ─────────────────────────────────────────────────────────────────────────────────────────────
// Each is scoped to its section. The icon is today's mask (`.md-callout-title::before`), which paints
// `currentColor`; a shape whose title is in the prose colour hands the icon the ink explicitly.
const ICON_INK = (s: string) => `
[data-shape="${s}"] .md-body .md-callout > .md-callout-title { color: var(--color-fg); }
[data-shape="${s}"] .md-body .md-callout-title::before { background-color: var(--md-callout-ink); }`

// The title's text start, per type, for shapes that indent the whole body to it (see styles.css: the
// glyph's ink width plus the 0.42em gap). Tip's bulb and Important's bubble ink narrower than the rest.
const GUTTER = (trim: number) => `calc(1em - ${2 * trim}em + 0.42em)`

const SHAPE_CSS = `
${ICON_INK("mark")}
[data-shape="mark"] .md-body .md-callout { border-left-color: color-mix(in oklab, var(--md-callout-ink) 45%, var(--color-border-strong)); }

[data-shape="tint"] .md-body .md-callout {
  border-left: 0;
  padding: 0.75em 1em;
  border-radius: var(--block-radius);
  background: color-mix(in oklab, var(--md-callout-ink) 7%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--md-callout-ink) 22%, transparent);
}

${ICON_INK("block")}
[data-shape="block"] .md-body .md-callout {
  border: 1px solid var(--color-border);
  border-radius: var(--block-radius);
  background: var(--color-bg);
  padding: 0.75em 1em;
}

${ICON_INK("accent")}
[data-shape="accent"] .md-body .md-callout {
  border: 1px solid var(--color-border);
  border-radius: var(--block-radius);
  background: var(--color-bg);
  padding: 0.75em 1em 0.75em calc(1em + 1px);
  box-shadow: inset 2px 0 0 var(--md-callout-ink);
}

[data-shape="runin"] .md-body .md-callout { border-left: 0; padding-left: ${GUTTER(0.042)}; }
[data-shape="runin"] .md-body .md-callout-tip { padding-left: ${GUTTER(0.208)}; }
[data-shape="runin"] .md-body .md-callout-important { padding-left: ${GUTTER(0.083)}; }
[data-shape="runin"] .md-body .md-callout > .md-callout-title { display: inline; padding-left: 0; margin-right: 0.3em; }
[data-shape="runin"] .md-body .md-callout > .md-callout-title + p { display: inline; }

[data-shape="chip"] .md-body .md-callout { border-left-color: var(--color-border-strong); }
[data-shape="chip"] .md-body .md-callout > .md-callout-title {
  width: fit-content;
  font-size: 0.857em;
  line-height: 1.6;
  padding: 0 0.7em 0 calc(0.6em + var(--md-callout-gutter));
  border-radius: 999px;
  background: color-mix(in oklab, var(--md-callout-ink) 13%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--md-callout-ink) 28%, transparent);
}
[data-shape="chip"] .md-body .md-callout > .md-callout-title + * { margin-top: 0.45em; }

[data-shape="header"] .md-body .md-callout {
  border: 1px solid var(--color-border);
  border-radius: var(--block-radius);
  background: var(--color-bg);
  padding: 0 1em 0.75em;
  overflow: hidden;
}
[data-shape="header"] .md-body .md-callout > .md-callout-title {
  margin: 0 -1em 0.65em;
  padding: 0.4em 1em 0.4em calc(1em + var(--md-callout-gutter));
  background: color-mix(in oklab, var(--md-callout-ink) 9%, transparent);
  border-bottom: 1px solid color-mix(in oklab, var(--md-callout-ink) 18%, transparent);
}
`

type Shape = { key: string; letter: string; name: string; says: string }

// Lettered in the order the question card offers them, so a letter means the same shape on both; today's
// shape is the card's last option, H, and is drawn first here as the baseline.
const SHAPES: Shape[] = [
  { key: "today", letter: "H", name: "Today's shape", says: "A 2px rule in the type's colour, the icon, and a bold title in the same colour. Under the calm ink this is the smallest fix: nothing moves, the colours come down." },
  { key: "accent", letter: "A", name: "Neutral block with an accent edge", says: "Drawn as a code block is, with the same fill, border, corner and inset, and today's rule moved inside the box as a 2px edge in the type's colour that curves with the corner. The title takes the prose colour." },
  { key: "block", letter: "B", name: "Neutral block", says: "A without the edge: colour only on the icon. It joins the transcript's family of blocks rather than standing apart from it." },
  { key: "tint", letter: "C", name: "Tinted panel", says: "A rounded box with a 7% wash and a 22% hairline of the type's colour, no rule. The clearest boundary for a multi-block callout, and the loudest of the boxed shapes." },
  { key: "mark", letter: "D", name: "Colour on the icon only", says: "Today's rule, keeping only a hint of the type's colour, and the title in the prose colour, so the only saturated thing is the 1em icon. The type still reads at a glance." },
  { key: "runin", letter: "E", name: "Run-in title, icon in the gutter", says: "No rule and no box. The icon hangs on the column's left edge, the title runs into the first line in bold, and the body hangs under the title. The way MDN writes “Note:”, one line shorter than every other shape." },
  { key: "chip", letter: "F", name: "Title as a label", says: "The title becomes a small tinted pill above the body, drawn like the app's GitHub labels, and the rule goes neutral. Colour is confined to the pill." },
  { key: "header", letter: "G", name: "Header bar", says: "B's neutral block with the title in a lightly tinted strip across its top. The most structured, and the heaviest." },
]

function ExcerptFrame({ shape }: { shape: string }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-60">Thread</div>
      <div data-shape={shape} className="rounded-xl border border-border bg-panel px-6 pb-5 pt-5">
        <Message m={AGENT} />
      </div>
    </div>
  )
}

function CardFrame({ shape }: { shape: string }) {
  return (
    <div className="w-[400px] shrink-0 max-[1000px]:w-full">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-60">Queue card, every type</div>
      <div data-shape={shape} className="card-md rounded-xl border border-border bg-panel-2 p-4">
        <div className="md-body text-[13px]" dangerouslySetInnerHTML={{ __html: mdToHtml(FIVE) }} />
      </div>
    </div>
  )
}

// The at-a-glance row: each shape's warning alone, side by side.
function Strip() {
  const warning = mdToHtml(quote("[!WARNING] Broken today\n`better-gnat-45` still holds a revoked GitHub client secret, so GitHub sign-in on previews is broken until it gets a new one."))
  return (
    <div className="mb-12 grid grid-cols-4 gap-3 max-[1100px]:grid-cols-2">
      {SHAPES.map((s) => (
        <a key={s.key} href={`#${s.key}`} data-shape={s.key} className="block rounded-xl border border-border bg-panel px-4 pb-4 pt-3 hover:border-border-strong">
          <div className="mb-2 text-[12px] text-muted"><span className="font-semibold text-fg">{s.letter}</span> · {s.name}</div>
          <div className="md-body text-[14px]" dangerouslySetInnerHTML={{ __html: warning }} />
        </a>
      ))}
    </div>
  )
}

type Ink = "calm" | "muted" | "today"
const INKS: [Ink, string][] = [["calm", "Calm"], ["muted", "Muted"], ["today", "Today's colours"]]

function Switch<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: [T, string][]; onChange: (v: T) => void }) {
  return (
    <div className="flex items-center gap-2 text-[12px]">
      <span className="text-muted">{label}</span>
      <div className="flex rounded-md border border-border p-0.5">
        {options.map(([v, name]) => (
          <button key={v} type="button" data-switch={`${label}:${v}`} onClick={() => onChange(v)}
            className={`rounded px-2 py-0.5 transition-colors ${value === v ? "bg-panel-2 text-fg" : "text-muted hover:text-fg"}`}>
            {name}
          </button>
        ))}
      </div>
    </div>
  )
}

function Sheet() {
  const [ink, setInk] = useState<Ink>((params.get("ink") as Ink) || "calm")
  const [theme, setTheme] = useState<"dark" | "light">(document.documentElement.dataset.theme as "dark" | "light")
  const pickTheme = (t: "dark" | "light") => {
    document.documentElement.dataset.theme = t
    setTheme(t)
  }
  return (
    <TooltipProvider>
      <style>{INK_CSS + SHAPE_CSS}</style>
      <div className="co-sheet min-h-screen bg-bg px-10 py-10 text-sm text-fg max-[700px]:px-4" data-ink={ink}>
        <div className="mx-auto max-w-[1180px]">
          <h1 className="mb-2 text-[20px] font-semibold">Callouts</h1>
          <p className="mb-3 max-w-[760px] text-[13px] leading-[20px] text-muted">
            Today a <code>{"> [!WARNING]"}</code> draws its rule, icon and title in Tailwind&rsquo;s <code>amber-400</code>. It is the brightest
            colour of the five, and it lies outside sRGB, so a Mac&rsquo;s P3 screen paints it more vivid than any ordinary web colour: the
            bar in the screenshot reads P3 <code>#ffb900</code>. Caution&rsquo;s <code>red-400</code> has the same problem to a lesser degree.
          </p>
          <p className="mb-6 max-w-[760px] text-[13px] leading-[20px] text-muted">
            The colours and the shape are separate choices. <b className="font-semibold text-fg">Ink</b> swaps the five colours on every
            shape: calm and muted put all five types at one lightness and saturation, inside sRGB. Each section below is one{" "}
            <b className="font-semibold text-fg">shape</b>, on the real transcript message and on a queue card.
          </p>
          <div className="sticky top-0 z-10 -mx-3 mb-8 flex flex-wrap items-center gap-5 bg-bg/90 px-3 py-2 backdrop-blur">
            <Switch label="Ink" value={ink} options={INKS} onChange={setInk} />
            <Switch label="Theme" value={theme} options={[["dark", "Dark"], ["light", "Light"]]} onChange={pickTheme} />
          </div>
          <Strip />
          {SHAPES.map((s) => (
            <section key={s.key} id={s.key} data-section={s.key} className="mb-14 scroll-mt-14">
              <h2 className="mb-1 text-[17px] font-semibold">{`${s.letter}. ${s.name}`}</h2>
              <p className="mb-5 max-w-[760px] text-[13px] leading-[20px] text-muted">{s.says}</p>
              <div className="flex items-start gap-6 max-[1000px]:flex-col">
                <ExcerptFrame shape={s.key} />
                <CardFrame shape={s.key} />
              </div>
            </section>
          ))}
        </div>
      </div>
    </TooltipProvider>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <Sheet />
  </QueryClientProvider>,
)
