import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import type { BoardSnapshot, ThreadView as ThreadViewModel, TranscriptMessage } from "@frizz/shared"
import { ThreadView } from "./components/ChatView.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { store } from "./store.ts"
import "./styles.css"

// Browser QA for Antigravity inline reasoning (`reasoningInline: true`) vs Codex collapsed reasoning:
// real reasoning summaries captured from session 0dd44a4b (the screenshot thread), covering short
// (unclamped), long multi-paragraph (clamped behind fade + Show more), interleaved tool digests, and
// a final full-strength reply so the hierarchy can be judged by eye in dark/light and desktop/narrow.
const SLUG = "antigravity-reasoning"
const PARAMS = new URLSearchParams(location.search)
if (PARAMS.get("theme") === "light") document.documentElement.dataset.theme = "light"
document.documentElement.dataset.font = PARAMS.get("font") === "mono" ? "mono" : "sans"
const AGO = (seconds: number) => new Date(Date.now() - seconds * 1000).toISOString()

const thread = {
  id: SLUG,
  title: "Audit docs for clarity and broken links",
  status: "done",
  statusText: "Done",
  mechanism: null,
  humanBlocked: false,
  needsYou: false,
  ready: false,
  dependsOn: [],
  externalDeps: [],
  agents: [],
  errors: [],
  warnings: [],
  runtime: "turn-idle",
  unread: false,
  archived: false,
  hasPlan: false,
  pendingQuestion: false,
  kind: "session",
  foreign: false,
  backend: "antigravity",
  permissionMode: "default",
  subAgents: [],
  bgShells: [],
  lastActivityAt: AGO(10),
  lastUserAt: AGO(300),
  spawnedAt: AGO(300),
} as unknown as ThreadViewModel

store.board = { projectDir: "/Users/colin/Documents/frizz", threads: [thread] } as BoardSnapshot

const edit = (file: string) => ({ name: "Edit", detail: file, status: "completed" as const, edit: { file, old: "a", new: "b" } })
const bash = (desc: string, command: string) => ({ name: "Bash", detail: command, command, desc, status: "completed" as const })

const LONG_REASONING = [
  "The extraneous conditional and import of `SHOW_RUST` in `llms.ts` appear redundant, as `pageGroups` already accounts for it. Removing the unused code to simplify the route file.",
  "Cleaning the route file completed. Updating the task status and preparing to update stale links in project documentation, including the README and several skill-specific reference files. Each link is being carefully checked and updated to the correct target URL within the new structure.",
  "Verifying and updating links in documentation. Several links now point to a new inference section, including those related to nullable parameters, dynamic filtering, list filtering, nested fetching, bulk inserts, and typed JSON. Other links are being updated to the typescript section, with a cross-check confirming the existence of the target anchor.",
].join("\n\n")

const MEDIUM_REASONING =
  "Investigating potential content inconsistencies across specific markdown files, focusing on sections flagged for review. The `usage.mdx` file's line 945 requires closer inspection, along with `faq-no-database` in `faq.mdx` and `migrate-cli.mdx`."

const SHORT_REASONING =
  "All automated checks completed successfully. Confirmed that all links, headings, and routes are valid and functioning as expected."

const messages: TranscriptMessage[] = [
  {
    sourceId: "u1",
    role: "user",
    text: "Review the docs for clarity, stale links, and structural issues, then verify the site build.",
    tools: [],
    parts: [],
    at: AGO(300),
  },
  {
    sourceId: "r-long",
    role: "assistant",
    kind: "reasoning",
    reasoningInline: true,
    text: LONG_REASONING,
    tools: [],
    parts: [],
    at: AGO(240),
  },
  {
    sourceId: "t1",
    role: "assistant",
    text: "",
    tools: [],
    parts: [{ kind: "tools", tools: [edit("src/llms.ts"), edit("docs/usage.mdx"), edit("docs/faq.mdx"), bash("Checking stale links", "rg 'old-anchor' docs/")] }],
    at: AGO(200),
  },
  {
    sourceId: "r-med",
    role: "assistant",
    kind: "reasoning",
    reasoningInline: true,
    text: MEDIUM_REASONING,
    tools: [],
    parts: [],
    at: AGO(150),
  },
  {
    sourceId: "t2",
    role: "assistant",
    text: "",
    tools: [],
    parts: [{ kind: "tools", tools: [edit("docs/migrate-cli.mdx"), bash("Building site and checking routes", "pnpm build && pnpm check-links")] }],
    at: AGO(120),
  },
  {
    sourceId: "r-short",
    role: "assistant",
    kind: "reasoning",
    reasoningInline: true,
    text: SHORT_REASONING,
    tools: [],
    parts: [],
    at: AGO(60),
  },
  {
    sourceId: "a1",
    role: "assistant",
    text: "Updated the stale documentation links, tightened the flagged prose sections in `usage.mdx` and `faq.mdx`, and confirmed the full site build and link check pass.",
    tools: [],
    parts: [{ kind: "text", text: "Updated the stale documentation links, tightened the flagged prose sections in `usage.mdx` and `faq.mdx`, and confirmed the full site build and link check pass." }],
    at: AGO(30),
  },
  ...(PARAMS.get("codex") === "1"
    ? ([{
        sourceId: "r-codex",
        role: "assistant",
        kind: "reasoning",
        text: "**Checking Codex collapsed control**\n\nCodex reasoning omits `reasoningInline` and stays behind the collapsed `Reasoning >` toggle.",
        tools: [],
        parts: [],
        at: AGO(15),
      }] as TranscriptMessage[])
    : []),
]

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" ? input : ((input as Request).url ?? input.toString()), location.origin)
  if (url.pathname === "/_frizz/rpc/threadTranscript" || url.pathname === "/_frizz/rpc/threadTranscriptEarlier") {
    return new Response(
      JSON.stringify({ result: { messages, transcriptKey: `${SLUG}-key`, hasEarlier: false, historyLoaded: true } }),
      { headers: { "content-type": "application/json" } },
    )
  }
  if (url.pathname === "/_frizz/rpc/threadSettledQuestions") {
    return new Response(JSON.stringify({ result: { questions: [] } }), { headers: { "content-type": "application/json" } })
  }
  if (url.pathname.startsWith("/_frizz/rpc/")) {
    return new Response(JSON.stringify({ result: {} }), { headers: { "content-type": "application/json" } })
  }
  return originalFetch(input, init)
}

function Fixture() {
  return (
    <div className="relative h-screen bg-bg text-fg text-sm">
      <div className="mx-auto flex h-screen w-full max-w-[780px] flex-col border-x border-border">
        <ThreadView slug={SLUG} />
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </QueryClientProvider>,
)
