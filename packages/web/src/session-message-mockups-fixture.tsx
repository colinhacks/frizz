// MOCKUP SHEET — a MESSAGE FROM ANOTHER THREAD (SessionMessageLine), redesigned five ways.
//
// Not a test and not shipped UI: a design surface. The maintainer, 2026-11-07, over a screenshot of the
// expanded line (a reylo thread told to stop building on a branch): "redesign this. give options."
//
// What that screenshot shows going wrong, which every option below answers in its own way:
//   - the label spends its width on chrome. "Message from «…» · Click to collapse · just now" truncated
//     the one thing the line is for — the sender's title — to "ONE-FILE MIGRATI…", while "Click to
//     collapse" survived whole;
//   - the title is petite caps, underlined AND quoted: three marks on one name;
//   - the label is centred and the body is flush left under a faint rule, so the body hangs off nothing;
//   - collapsed, the line says a message arrived and nothing about what it says — a "STOP" reads the same
//     as "rebased, you're clear".
//
// Each option is drawn in a real transcript (the real tool digest and agent prose above and below it),
// collapsed and expanded, in a thread column and a phone column. The static export of this page is what
// the maintainer reviews, so nothing here depends on script: both states are drawn side by side.
//
//   nubx vite --port 5481 --strictPort      (from packages/web)
//   http://localhost:5481/session-message-mockups-fixture.html
import { createRoot } from "react-dom/client"
import { useEffect, useMemo, useRef, type ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ChevronRight, MessagesSquare } from "lucide-react"
import type { ChatMessage } from "./hooks.ts"
import { Message, withMessageSpacers } from "./components/ChatView.tsx"
import { DIVIDER_LINK } from "./components/FrizzWake.tsx"
import { SessionMessageLine } from "./components/SessionMessageLine.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import { WAKE_DIVIDER_RULE, WAKE_DIVIDER_WIDE_ONLY } from "./components/WakeDivider.tsx"
import { mdToHtml } from "./lib/markdown.ts"
import { coalesceToolActivityMessages } from "./lib/toolActivity.ts"
import { TRANSCRIPT_META_LABEL_CLASS, transcriptMetaChevronClass } from "./lib/transcriptMetaLabels.ts"
import "./styles.css"

document.documentElement.dataset.font = "sans"
document.documentElement.dataset.theme = new URLSearchParams(location.search).get("theme") === "light" ? "light" : "dark"

// ---- the message, verbatim from the screenshot ---------------------------------------------------
const TITLE = "One-file migration history"
const AGE = "4m ago"
const BODY = [
  "STOP: don't build the one-file design on `reylo-migrate` or [colinhacks/reylo#179](https://github.com/colinhacks/reylo/pull/179). Colin, just now in [One-file migration history](#): \"DO NOT REBUILD against the existing reylo migrate branch! this is a different proposal\".",
  "",
  "So Colin's three answers from this thread (`create` from the development database, one plain `migrations.sql`, transactions owned by the migration) are decisions inside a separate proposal. They are not changes to [colinhacks/reylo#179](https://github.com/colinhacks/reylo/pull/179). If you've started building any of them on the branch, stop, and don't push. Tell Colin on your thread what you'd already changed, so he can say what happens to it.",
  "",
  "The design notes you asked for are at /Users/colin/Documents/reylo/.frizz/threads/b6731fd4-f51f-4104-9a0b-e0544829e240/one-file-design.md. I've marked them as a separate proposal, not a build spec for the branch.",
].join("\n")
const BODY_HTML = mdToHtml(BODY)
// The first paragraph alone, for the options that preview the message while it is collapsed. Shipped,
// this is the body's first block rendered the same way — not a second copy of the text.
const LEAD_HTML = mdToHtml(BODY.split("\n\n")[0])

const AT = new Date(Date.now() - 4 * 60_000).toISOString()

// ---- the transcript around it --------------------------------------------------------------------
const call = (over: Record<string, unknown>) => ({ name: "Bash", status: "completed", durationMs: 1200, ...over })
const before: ChatMessage = {
  sourceId: "before",
  role: "assistant",
  text: "",
  tools: [],
  parts: [{ kind: "tools", tools: [call({ command: "git -C ~/Documents/reylo status --short", desc: "Checking the reylo branch" })] }],
} as unknown as ChatMessage
const peer: ChatMessage = {
  sourceId: "peer",
  role: "user",
  text: BODY,
  tools: [],
  parts: [],
  at: AT,
  sessionPeer: { name: "frizz-11", thread: { project: "reylo", slug: "one-file-migration-history", title: TITLE } },
} as unknown as ChatMessage
const after: ChatMessage = {
  sourceId: "after",
  role: "assistant",
  text: "",
  tools: [],
  parts: [
    { kind: "text", text: "Stopping. Nothing from the one-file proposal is on `reylo-migrate` yet, and nothing was pushed. I'll tell Colin what the branch holds so he can decide what happens to it." },
    { kind: "tools", tools: [call({ command: "git -C ~/Documents/reylo log --oneline -3", desc: "Listing the branch's last commits" })] },
  ],
} as unknown as ChatMessage

function Transcript({ children }: { children: ReactNode }) {
  const messages = useMemo(() => coalesceToolActivityMessages([before, peer, after]).map((e) => e.message), [])
  return (
    <div className="flex flex-col">
      {withMessageSpacers(messages, (m, i) => (m.sourceId === "peer" ? <div key={i}>{children}</div> : <Message key={i} m={m} />))}
    </div>
  )
}

// ---- shared pieces ---------------------------------------------------------------------------------
function Body({ className = "", html = BODY_HTML }: { className?: string; html?: string }) {
  return (
    <div className={`card-md ${className}`}>
      <div className="md-body [overflow-wrap:anywhere]" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}

// The divider family's chrome, restated here so the label can change without touching WakeDivider.
function Rule() {
  return <span aria-hidden="true" className={WAKE_DIVIDER_RULE} />
}

// The hairline label options A and B share: the title in its own case (it is a name, not a frame word),
// one underline and no quotes; a chevron where "Click to expand" stood; the age last.
function HairlineLabel({ open }: { open: boolean }) {
  return (
    <span className="petite-caps flex min-w-0 items-center gap-1 text-[12px] text-muted-70">
      <MessagesSquare aria-hidden="true" size={12} className="shrink-0 translate-y-[0.04em]" />
      <span className={`shrink-0 ${WAKE_DIVIDER_WIDE_ONLY}`}>Message from</span>
      <a href="#" onClick={(e) => e.preventDefault()} className={`min-w-0 truncate text-muted [font-variant-caps:normal] ${DIVIDER_LINK}`}>{TITLE}</a>
      <span aria-hidden="true" className="shrink-0 opacity-50">·</span>
      <span className="shrink-0 tabular-nums">{AGE}</span>
      <ChevronRight aria-hidden="true" size={12} className={`shrink-0 translate-y-[0.04em] transition-transform ${open ? "rotate-90" : ""}`} />
    </span>
  )
}

function Hairline({ open }: { open: boolean }) {
  return (
    <div className="@container/wake my-1 flex items-center gap-3">
      <Rule />
      <HairlineLabel open={open} />
      <Rule />
    </div>
  )
}

// ---- 0 · what ships -----------------------------------------------------------------------------------
// The real component. Its open state is its own, so the expanded copy clicks its own toggle once.
function Current({ open }: { open: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLButtonElement>("[data-session-message-toggle]")?.click()
  }, [open])
  return (
    <div ref={ref}>
      <SessionMessageLine peer={peer.sessionPeer!} text={BODY} at={AT} />
    </div>
  )
}

// ---- A · bracketed by hairlines ------------------------------------------------------------------
function OptionA({ open }: { open: boolean }) {
  if (!open) return <Hairline open={false} />
  return (
    <div className="flex flex-col">
      <Hairline open />
      <Body className="mt-2 text-muted" />
      <span aria-hidden="true" className="mt-3.5 h-px bg-border/70" />
    </div>
  )
}

// ---- B · the hairline opens into a frame ---------------------------------------------------------
// A real <fieldset>: the legend cuts the top border itself, so the label sits ON the rule exactly as it
// does collapsed, on any background, with nothing painted behind it.
function OptionB({ open }: { open: boolean }) {
  if (!open) return <Hairline open={false} />
  return (
    <fieldset className="@container/wake m-0 min-w-0 rounded-xl border border-border/70 px-4 pb-3.5 pt-1">
      <legend className="mx-auto max-w-[calc(100%-100px)] px-2.5">
        <HairlineLabel open />
      </legend>
      <Body className="text-fg/85" />
    </fieldset>
  )
}

// ---- C · byline and a two-line preview -----------------------------------------------------------
function Byline() {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5 text-[13px] leading-5 text-muted">
      <MessagesSquare aria-hidden="true" size={13} className="shrink-0 translate-y-[0.14em] self-baseline text-muted-70" />
      <span className="shrink-0">From</span>
      <a href="#" onClick={(e) => e.preventDefault()} className="min-w-0 truncate font-medium text-fg/90 underline decoration-transparent underline-offset-2 hover:decoration-fg/60">{TITLE}</a>
      <span aria-hidden="true" className="shrink-0 opacity-50">·</span>
      <span className="shrink-0 tabular-nums text-muted-70">{AGE}</span>
    </div>
  )
}

function OptionC({ open }: { open: boolean }) {
  return (
    <div className="flex flex-col">
      <Byline />
      <div className="mt-1.5 ml-[5px] border-l-2 border-border pl-[13px]">
        {open ? <Body className="text-muted" /> : <Body className="text-muted [&_.md-body]:line-clamp-2" html={LEAD_HTML} />}
        <button type="button" className="mt-1 flex items-center gap-0.5 text-[12px] leading-5 text-muted-70 hover:text-fg">
          {open ? "Show less" : "Show all"}
        </button>
      </div>
    </div>
  )
}

// ---- D · an inbound bubble -----------------------------------------------------------------------
// The human's bubble, mirrored: left-aligned, dark where theirs is light, and captioned with who sent it.
function OptionD({ open }: { open: boolean }) {
  return (
    <div className="flex flex-col items-start">
      <div className="mb-1 ml-1 flex min-w-0 max-w-full items-center gap-1.5 text-[12px] leading-4 text-muted-70">
        <MessagesSquare aria-hidden="true" size={12} className="shrink-0" />
        <a href="#" onClick={(e) => e.preventDefault()} className={`min-w-0 truncate text-muted ${DIVIDER_LINK}`}>{TITLE}</a>
        <span aria-hidden="true" className="shrink-0 opacity-50">·</span>
        <span className="shrink-0 tabular-nums">{AGE}</span>
      </div>
      <div className="max-w-[88%] rounded-xl rounded-tl-sm border border-border/60 bg-panel-2 px-3.5 py-3">
        <div className={open ? "" : "max-h-[100px] overflow-hidden [mask-image:linear-gradient(to_bottom,black_55%,transparent)]"}>
          <Body className="text-fg/90" />
        </div>
        <button type="button" className="mt-1.5 text-[12px] leading-4 text-muted hover:text-fg">{open ? "Show less" : "Show more"}</button>
      </div>
    </div>
  )
}

// ---- E · the transcript's own disclosure row -----------------------------------------------------
// The row "Ran 1 tool call ›" already is: same type, same chevron, same rail when open.
function OptionE({ open }: { open: boolean }) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className={`flex w-full min-w-0 items-baseline gap-1.5 ${TRANSCRIPT_META_LABEL_CLASS}`}>
        <span className="min-w-0 truncate text-muted">
          Message from{" "}
          <a href="#" onClick={(e) => e.preventDefault()} className="underline decoration-muted/30 underline-offset-2 hover:text-fg hover:decoration-fg/60">{TITLE}</a>
        </span>
        <ChevronRight aria-hidden="true" size={13} className={transcriptMetaChevronClass(open)} />
      </div>
      {open && <Body className="mt-1.5 border-l border-border/70 pl-3 text-muted" />}
    </div>
  )
}

// ---- the sheet -----------------------------------------------------------------------------------
type Option = { key: string; letter: string; name: string; recommended?: boolean; render: (open: boolean) => ReactNode; notes: ReactNode[] }

const OPTIONS: Option[] = [
  {
    key: "current",
    letter: "Shipped",
    name: "What ships now",
    render: (open) => <Current open={open} />,
    notes: [
      <>The live component, so it can be held against its mockup. Option B was chosen on 2026-11-07; before that this line cut the title to “One-file migrati…” while “Click to collapse” survived whole, and hung a flush-left body under a centred label.</>,
    ],
  },
  {
    key: "a",
    letter: "A",
    name: "Bracketed by hairlines",
    render: (open) => <OptionA open={open} />,
    notes: [
      <>The smallest change. The label loses its quotes and “Click to expand”, and the title keeps its own case, so it fits.</>,
      <>Expanded, a second hairline closes the message, so the body sits between two rules instead of under one.</>,
      <>Collapsed, it still says nothing about what the message is about.</>,
    ],
  },
  {
    key: "b",
    letter: "B",
    name: "The hairline opens into a frame",
    recommended: true,
    render: (open) => <OptionB open={open} />,
    notes: [
      <>Collapsed, it is A’s hairline. Expanded, the rules turn down into a box and the label stays on the top edge, so the body belongs to the label.</>,
      <>The body can be full-strength text, because the frame already separates it from the agent’s own prose.</>,
      <>Collapsed, it still says nothing about what the message is about.</>,
    ],
  },
  {
    key: "c",
    letter: "C",
    name: "Byline with a two-line preview",
    render: (open) => <OptionC open={open} />,
    notes: [
      <>Left-aligned like a quoted reply: who sent it, then the message’s first two lines on a rail. “Stop: don’t build…” is readable without a click.</>,
      <>Header and body share one left edge, so nothing hangs.</>,
      <>No longer a hairline, and it takes three lines collapsed where the hairline takes one.</>,
    ],
  },
  {
    key: "d",
    letter: "D",
    name: "An inbound bubble",
    render: (open) => <OptionD open={open} />,
    notes: [
      <>Treated as a message from a third participant: the human’s bubble mirrored to the left, dark, captioned with the sender.</>,
      <>Collapsed, it shows the first lines and fades out.</>,
      <>The loudest option. A long message is a big block in the transcript, and it reads as a chat message rather than as an event.</>,
    ],
  },
  {
    key: "e",
    letter: "E",
    name: "A disclosure row, like “Ran 1 tool call”",
    render: (open) => <OptionE open={open} />,
    notes: [
      <>The same type, chevron and rail as the tool digest beside it, so it reads as one more thing the worker received.</>,
      <>The quietest option. It says nothing about the content and has no age.</>,
      <>Nothing marks it out from the tool rows, so a “STOP” from another thread is easy to scroll past.</>,
    ],
  },
]

function Pane({ label, width, children }: { label: string; width: number; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5" style={{ width }}>
      <div className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-70">{label}</div>
      <div className="rounded-lg border border-border bg-bg px-5 py-5">{children}</div>
    </div>
  )
}

function OptionSection({ option }: { option: Option }) {
  return (
    <section id={option.key} className="flex flex-col gap-4 border-t border-border pt-8">
      <header className="flex flex-col gap-2">
        <h2 className="flex items-baseline gap-2.5 text-[18px] font-semibold text-fg">
          <span className="rounded-md bg-panel-2 px-2 py-0.5 text-[13px] font-semibold text-muted">{option.letter}</span>
          {option.name}
          {option.recommended && <span className="rounded-full border border-accent/50 px-2 py-px text-[11px] font-medium text-accent">Recommended</span>}
        </h2>
        <ul className="ml-4 list-disc space-y-0.5 text-[13px] leading-5 text-muted marker:text-muted-50">
          {option.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      </header>
      <div className="flex flex-wrap items-start gap-6">
        <div className="flex flex-col gap-5">
          <Pane label="Thread column · collapsed" width={720}><Transcript>{option.render(false)}</Transcript></Pane>
          <Pane label="Thread column · expanded" width={720}><Transcript>{option.render(true)}</Transcript></Pane>
        </div>
        <div className="flex flex-col gap-5">
          <Pane label="Phone · collapsed" width={390}><Transcript>{option.render(false)}</Transcript></Pane>
          <Pane label="Phone · expanded" width={390}><Transcript>{option.render(true)}</Transcript></Pane>
        </div>
      </div>
    </section>
  )
}

function Sheet() {
  return (
    <main className="min-h-screen bg-panel px-8 py-10 text-fg">
      <div className="mx-auto flex max-w-[1160px] flex-col gap-10">
        <header className="flex flex-col gap-2">
          <h1 className="text-[22px] font-semibold">A message from another thread: five redesigns</h1>
          <p className="max-w-[760px] text-[14px] leading-6 text-muted">
            The line a thread’s transcript draws when another thread sends it a message, here a reylo thread told to stop building on a branch. Each option is shown collapsed and expanded, between the real tool rows and agent prose, at thread-column and phone width.
          </p>
          <nav className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            {OPTIONS.map((o) => (
              <a key={o.key} href={`#${o.key}`} className="text-muted underline decoration-muted/30 underline-offset-2 hover:text-fg">
                {o.letter === "Shipped" ? "Shipped" : `${o.letter} · ${o.name}`}
              </a>
            ))}
          </nav>
        </header>
        {OPTIONS.map((o) => <OptionSection key={o.key} option={o} />)}
      </div>
    </main>
  )
}

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Sheet />
    </TooltipProvider>
  </QueryClientProvider>,
)
