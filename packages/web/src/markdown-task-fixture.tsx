import { createRoot } from "react-dom/client"
import "./styles.css"
import { mdToHtml } from "./lib/markdown.ts"

// Drives the REAL render path (mdToHtml → marked → the DOM sanitizer) over the five Obsidian task
// states agents write in their own markdown — `[ ]` pending, `[/]` in progress, `[x]` complete,
// `[-]` cancelled, `[?]` blocked. The glyphs are pure CSS (`.md-task*` in styles.css) because the
// sanitizer drops `<svg>` with its subtree, so this fixture is the only place they can be JUDGED.
//
// Panels mirror the three real hosts at their real type sizes: a transcript message (14px), the
// thread doc drawer, and a queue-wrapped question card (12px), so a correction that only
// works at one size shows up here.

const LIST = `- [x] Confine reads on Windows — unconfined is fatal
- [/] Fix the coarse network grant on Linux and Windows
- [ ] Drop per-host on macOS and delete \`$downloads\`
- [-] Ship the restricted-token fallback
- [?] Reconcile the five parallel sandbox branches into \`sandbox/integration\`, then re-run the per-OS jail measurements on each host before the release cut`

const NESTED = `- [/] Land the sandbox jail
  - [x] Measure AppContainer on Windows
  - [/] Port the deny-by-default read policy
  - [ ] Re-run the per-OS measurements
- [-] Ship the restricted-token fallback
  - [ ] A live child under a CANCELLED parent must not inherit the strike
- [?] Cut the release`

const LEGEND = `> Status legend: \`[ ]\` pending · \`[/]\` in progress · \`[x]\` complete · \`[-]\` cancelled · \`[?]\` blocked / needs input`

const MIXED = `Here is where things stand.

- [x] **Bold** task with \`code\` and a [link](https://example.com)
- [ ] Plain bullet neighbours below

* An ordinary bullet, for the gutter comparison
* Another ordinary bullet

1. A numbered item
2. Another numbered item`

// An agent filling in a task list leaves a BARE `- [ ]`, so the empty item is a real shape.
const EMPTY = `## Task list

- [ ]
- [x]`

const LOOSE = `- [x] A loose item — the span lands inside a paragraph

- [/] So the \`li > p > .md-task\` rule has to catch it

- [?] And this one`

const CASES: { id: string; label: string; md: string }[] = [
  { id: "states", label: "All five states", md: LIST },
  { id: "nested", label: "Nested", md: NESTED },
  { id: "legend", label: "The legend as authored (inline code, not task items)", md: LEGEND },
  { id: "mixed", label: "Beside ordinary bullets and numbers", md: MIXED },
  { id: "loose", label: "Loose list", md: LOOSE },
  { id: "empty", label: "Empty items (an unfilled task list)", md: EMPTY },
]

const Panel = ({ title, className, style }: { title: string; className?: string; style?: React.CSSProperties }) => (
  <section data-panel={title} className="flex flex-col gap-3" style={style}>
    <p className="text-[11px] uppercase tracking-wide text-muted">{title}</p>
    {CASES.map(({ id, label, md }) => (
      <div key={id} data-case={id} className="flex flex-col gap-1">
        <code className="text-[10px] text-muted-70">{label}</code>
        <div className={`md-body ${className ?? ""}`} dangerouslySetInnerHTML={{ __html: mdToHtml(md) }} />
      </div>
    ))}
  </section>
)

createRoot(document.getElementById("root")!).render(
  <main className="mx-auto flex max-w-5xl flex-col gap-8 p-8">
    <p className="text-sm text-muted">Markdown task-list fixture — the five Obsidian states</p>
    <div className="grid grid-cols-2 gap-10">
      <Panel title="Transcript (14px)" />
      <Panel title="Question card (12px)" style={{ fontSize: 12 }} className="text-[12px]" />
    </div>
    {/* A single big row, so the glyph shapes are judgeable at a scale a 14px shot can't show. */}
    <section data-panel="zoom" className="flex flex-col gap-3">
      <p className="text-[11px] uppercase tracking-wide text-muted">Zoom (28px) — judge the glyph shapes</p>
      <div className="md-body" style={{ fontSize: 28 }} dangerouslySetInnerHTML={{ __html: mdToHtml(LIST) }} />
    </section>
  </main>,
)
