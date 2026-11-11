import { useState } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import "./styles.css"
import type { BlockAnswer, ParsedQuestion } from "./lib/questionBlocks.ts"
import { setThemePreference, type ThemePreference } from "./lib/theme.ts"
import { FenceCard } from "./components/ChatView.tsx"
import { FileViewerPanel } from "./components/FileViewerPanel.tsx"
import { FrizzWake } from "./components/FrizzWake.tsx"
import { MarkdownDrawer } from "./components/MarkdownDrawer.tsx"
import { QuestionBlockCard } from "./components/QuestionBlockCard.tsx"
import { SessionMessageLine } from "./components/SessionMessageLine.tsx"
import { ThreadDrawer } from "./components/ThreadDrawer.tsx"

// The ```mermaid fence on every surface that renders a worker's Markdown as ONE string of HTML, each
// through its REAL component: a done card (FenceCard), a question's context and options
// (QuestionBlockCard), the two transcript asides (SessionMessageLine, FrizzWake) and the readers
// (FileViewerPanel inline; MarkdownDrawer and ThreadDrawer, which are sheets, under `?mode=`). The
// diagrams are drawn by the real mermaid, loaded the way the app loads it. Driven by
// components/mermaid.e2e.test.ts.
//
// The transcript's own diagram — pulled out of the prose by the splitter — is attachment-render-fixture's.
//
// `?mode=plain` is a card with no fence in it, for the check that mermaid is not loaded until one is.
// `?theme=light` starts the page light; `__setTheme` flips it under a mounted diagram. `__setDoc`
// rewrites the file the readers show, which they pick up on their next poll, as they would a save.
declare global {
  interface Window { __chips?: number[]; __setTheme?: (theme: ThemePreference) => void; __setDoc?: (markdown: string) => void; __doc?: string }
}

const params = new URLSearchParams(location.search)
const mode = params.get("mode") ?? "cards"
setThemePreference(params.get("theme") === "light" ? "light" : "dark")
window.__setTheme = setThemePreference
window.__chips = []

const fence = (lines: string[], info = "mermaid") => ["```" + info, ...lines, "```"].join("\n")

const FLOW = fence(["flowchart LR", "  A[Prompt] --> B{Queue}", "  B -->|rested| C[Card]", "  B -->|active| D[Worker]"])
const WIDE = fence(["flowchart LR", "  A[Read the prompt] --> B[Split the fences] --> C[Render the Markdown] --> D[Sanitize the HTML] --> E[Swap the islands] --> F[Draw the diagram]"])
const TALL = fence(["flowchart TD", "  A[Dispatch] --> B[Spawn the broker]", "  B --> C[Attach the bridge]", "  C --> D[Stream the turn]", "  D --> E[Parse the fence]", "  E --> F[Rest the thread]", "  F --> G[Queue the card]", "  G --> H[Wake on answer]"])
const SEQUENCE = fence(["sequenceDiagram", "  participant W as Worker", "  participant F as Frizz", "  participant H as Human", "  W->>F: ask(question)", "  F->>H: question card", "  H-->>F: answer", "  F-->>W: wake"])
const INVALID = fence(["flowchart LR", "  A --> --> ]["])
// A fence being SHOWN, not drawn: nested in a longer fence it is that block's text.
const QUOTED = ["````markdown", "```mermaid", "flowchart LR", "  Q --> R", "```", "````"].join("\n")
// Only the bare name is the diagram's; an info string that says more is some other tool's fence.
const TITLED = fence(["flowchart LR", "  T --> U"], "mermaid title=flow")

const DONE_BODY = ["Reworked how a prompt reaches a worker.", "", FLOW, "", "The queue decides which band a thread lands in."].join("\n")
const BROKEN_BODY = ["A source mermaid cannot parse:", "", INVALID, "", "A quoted fence:", "", QUOTED, "", "And a fence with a longer info string:", "", TITLED].join("\n")
const NARROW_BODY = ["The render path, end to end:", "", WIDE].join("\n")
const UPPERCASE_BODY = fence(["flowchart LR", "  U[Upper] --> V[Case]"], "Mermaid")

const DOC = (extra = "") => ["# Ask flow", "", "How a question reaches the human and comes back.", "", SEQUENCE, "", "The same flow as code:", "", "```ts", "await ask({ question })", "```", "", QUOTED, extra].join("\n")
window.__doc = DOC()
window.__setDoc = (markdown) => { window.__doc = markdown }

const json = (result: unknown) => new Response(JSON.stringify({ result }), { headers: { "content-type": "application/json" } })
const nativeFetch = window.fetch.bind(window)
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href)
  if (!url.pathname.startsWith("/_frizz/rpc/")) return nativeFetch(input, init)
  const method = url.pathname.split("/").at(-1)
  if (method === "resolveLocalPaths") return json({ resolved: [] })
  if (method === "localMarkdown") return json({ path: "/fixture/ask-flow.md", markdown: window.__doc, truncated: false })
  if (method === "threadBody") return json({ markdown: ["---", "title: Ask flow", "---", "## Goal", "", "Draw the ask flow.", "", FLOW].join("\n") })
  return json({})
}

const QUESTION: ParsedQuestion = {
  kind: "question",
  danger: false,
  contextMd: ["Which shape should the dispatch path take?", "", FLOW].join("\n"),
  options: ["A. Fan out", "B. One long chain", "C. Leave it alone"],
  optionBodies: [
    ["Three workers, one per package.", "", fence(["flowchart LR", "  P[Plan] --> W1[web]", "  P --> W2[server]", "  P --> W3[shared]"])].join("\n"),
    TALL,
    "No diagram here.",
  ],
  recommendedIdxs: [0],
}

function Question() {
  const [answer, setAnswer] = useState<BlockAnswer>({ chosen: null, chosenSet: [], text: "" })
  return (
    <QuestionBlockCard
      question={QUESTION}
      interactive={{
        answer,
        onChip: (i) => {
          window.__chips!.push(i)
          setAnswer((a) => ({ ...a, chosen: a.chosen === i ? null : i }))
        },
        onText: (text) => setAnswer(() => ({ chosen: null, text })),
        onSubmit: () => {},
      }}
    />
  )
}

const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={client}>
    {mode === "markdown" ? (
      <MarkdownDrawer id={1} path="/fixture/ask-flow.md" title="ask-flow.md" depth={0} widthDepth={0} />
    ) : mode === "thread" ? (
      <ThreadDrawer id={1} slug="ask-flow" title="Ask flow" depth={0} widthDepth={0} />
    ) : mode === "plain" ? (
      // No fence anywhere: the page the lazy-loading check reads.
      <main className="mx-auto max-w-[700px] p-8">
        <section data-fixture-plain>
          <FenceCard fenceKind="done" body={"Nothing to draw here.\n\n```ts\nconst plain = true\n```"} hints={[]} />
        </section>
      </main>
    ) : (
      <main className="mx-auto max-w-[700px] p-8">
        <section data-fixture-done className="mb-8">
          <FenceCard fenceKind="done" body={DONE_BODY} hints={[]} />
        </section>
        <section data-fixture-broken className="mb-8">
          <FenceCard fenceKind="done" body={BROKEN_BODY} hints={[]} />
        </section>
        <section data-fixture-question className="mb-8">
          <Question />
        </section>
        {/* The queue rail's width: the narrowest a card is drawn on a desktop. */}
        <section data-fixture-narrow className="mb-8 w-[320px]">
          <FenceCard fenceKind="done" body={NARROW_BODY} hints={[]} />
        </section>
        <section data-fixture-uppercase className="mb-8">
          <FenceCard fenceKind="done" body={UPPERCASE_BODY} hints={[]} />
        </section>
        <section data-fixture-session className="mb-8 flex flex-col text-[13px]">
          <SessionMessageLine peer={{ name: "docs" }} text={["Here is the flow I mean:", "", FLOW].join("\n")} />
        </section>
        <section data-fixture-wake className="mb-8">
          <FrizzWake text={["A review comment landed:", "", FLOW].join("\n")} />
        </section>
        <section data-fixture-reader className="mb-8 h-[720px] border border-border">
          <FileViewerPanel slug="fixture" path="/fixture/ask-flow.md" active />
        </section>
      </main>
    )}
  </QueryClientProvider>,
)
