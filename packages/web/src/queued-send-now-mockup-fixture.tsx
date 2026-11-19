import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { useState, type ReactNode } from "react"
import { ArrowUp } from "lucide-react"
import type { ChatMessage } from "./hooks.ts"
import { Message, WorkingIndicator } from "./components/ChatView.tsx"
import { HUMAN_RUN_STEP, STEP, VSpace } from "./components/rhythm.tsx"
import { TooltipProvider } from "./components/Tooltip.tsx"
import "./styles.css"

// MOCKUP SHEET — ONE SMALLER "SEND NOW" ARROW UNDER THE QUEUED MESSAGES.
//
// Not shipped UI and not a test. The maintainer, 2026-10-15: "I think that the Send Now arrow should
// actually be smaller, and it should probably be visible at all times underneath the set of queued
// messages. Let's mock that up."
//
// PICKED: B, the same day, without the status words in either mode ("I don't think we need the little
// message that says 'Queued until the agent rests'") — shipped as ChatView QueuedSendNow. The sheet
// stays as the record of what was weighed; its "today" frame went with the control it drew.
//
// WHAT IS TRUE TODAY (read from the code on 2026-10-15):
//   · Every queued bubble grows its own ↑ on hover, 28×28 with a 15px glyph, to the LEFT of the bubble,
//     bottom-aligned. It calls deliverQueuedNow, which acts on the WHOLE queue, not the bubble under the
//     pointer — so three bubbles carried three copies of one control.
//   · A message sent TO THE QUEUE (the Send menu's second row) is held by Frizz until the agent rests;
//     the run carries one line, "Queued until the agent rests · Send now", whose Send now releases them
//     to the agent's next step without interrupting it.
//
// Every candidate keeps ONE send-now for the run, always visible, and lets it mean "stop waiting" in
// the mode it is in: a steer waiting for the agent's next step is pushed through now (today's ↑), and a
// message held for the rest is handed to the agent's next step (today's line). Click one in a frame to
// see it: a held run becomes an ordinary queued run, and a queued run lands.
//
// The bubbles, prose and Thinking row are the REAL Message and WorkingIndicator; the footers are drawn
// here. Nothing is sent anywhere.
//
//   nubx vite --port 5437 --strictPort   (from packages/web), then
//   http://localhost:5437/queued-send-now-mockup-fixture.html
const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = "sans"
document.documentElement.dataset.theme = params.get("theme") === "light" ? "light" : "dark"

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  // location.href, not origin: the page also ships as one file:// document, whose origin is "null".
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.href)
  if (url.pathname.includes("/_frizz/")) return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  return originalFetch(input, init)
}

const MIN = 60_000
const at = (min: number) => new Date(Date.now() - min * MIN).toISOString()

const AGENT: ChatMessage = {
  sourceId: "a1",
  role: "assistant",
  text: "Reproducing the spacing on the queue card now — I'll measure both surfaces before changing anything.",
  tools: [],
  parts: [{ kind: "text", text: "Reproducing the spacing on the queue card now — I'll measure both surfaces before changing anything." }],
  at: at(3),
} as ChatMessage

const WORDS = [
  "also check the drawer",
  "and the full page",
  "actually the card matters most, start there — the drawer can wait until the card is right",
]

type Mode = "steer" | "held"
type Stage = Mode | "sent"

function bubbles(stage: Stage, extra?: Partial<ChatMessage>): ChatMessage[] {
  return WORDS.map((text, i) => ({
    sourceId: `q${i}`,
    role: "user",
    text,
    tools: [],
    parts: [],
    ...(stage === "sent" ? {} : { queued: true }),
    ...extra,
  }) as ChatMessage)
}

// ── the frame: a transcript's tail, as the drawer draws it ────────────────────────────────────────────

function Frame({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 flex-1">
      <div className="mb-2 text-[11px] font-medium uppercase tracking-[0.06em] text-muted-60">{label}</div>
      <div data-mock-frame className="rounded-xl border border-border bg-bg py-5">
        <div className="flex flex-col px-6">{children}</div>
      </div>
    </div>
  )
}

function Tail({ stage, footer, renderBubble }: { stage: Stage; footer: ReactNode; renderBubble?: (m: ChatMessage, i: number) => ReactNode }) {
  const list = bubbles(stage)
  return (
    <>
      <Message m={AGENT} />
      {stage !== "sent" && (
        <>
          <VSpace h={STEP} />
          <WorkingIndicator since={at(2)} />
        </>
      )}
      {list.map((m, i) => (
        <div key={m.sourceId} className="flex flex-col">
          <VSpace h={i === 0 ? STEP : HUMAN_RUN_STEP} />
          {renderBubble ? renderBubble(m, i) : <Message m={m} />}
        </div>
      ))}
      {stage !== "sent" && footer}
    </>
  )
}

// What the line and the arrow say in each mode.
const STATUS: Record<Mode, string> = {
  steer: "Waiting for the agent's next step",
  held: "Queued until the agent rests",
}
const TITLE: Record<Mode, string> = {
  steer: "Send now — the agent stops what it is doing and reads these",
  held: "Send now — the agent reads these at its next step",
}

// ── the candidates ────────────────────────────────────────────────────────────────────────────────────

type Footer = (props: { mode: Mode; onSend: () => void }) => ReactNode

const textLine = "flex items-baseline justify-end gap-2 text-[11.5px] leading-[16px] text-muted"
const link = "underline decoration-border underline-offset-2 outline-none transition-colors hover:text-fg focus-visible:text-fg"
const dot = <span aria-hidden className="text-muted-60">·</span>

// The arrow beside words: a 1em glyph laid on the words' baseline and lifted to the middle of their cap
// band, which the browser computes for whatever face and size is in force (`1cap`).
function InlineArrow() {
  return <ArrowUp aria-hidden className="size-[1em] shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)]" strokeWidth={2.4} />
}

// An icon button the size of a line of the held text, so a line can carry it without growing.
function SmallArrowButton({ mode, onSend, className = "" }: { mode: Mode; onSend: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onSend}
      title={TITLE[mode]}
      aria-label="Send now"
      className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-panel-2/70 hover:text-fg focus-visible:ring-1 focus-visible:ring-muted/80 active:bg-elevated ${className}`}
    >
      <ArrowUp size={12} strokeWidth={2.4} />
    </button>
  )
}

const CANDIDATES: { key: string; name: string; says: string; footer: Footer }[] = [
  {
    key: "A",
    name: "The arrow alone",
    says: "A 20px button with a 12px arrow, flush with the run's right edge. In held mode it ends the status line, in place of the words Send now.",
    footer: ({ mode, onSend }) => (
      <div className="mt-0.5 flex items-center justify-end gap-1">
        {mode === "held" && <span className="text-[11.5px] leading-[16px] text-muted">{STATUS.held}</span>}
        <SmallArrowButton mode={mode} onSend={onSend} className="-mr-1" />
      </div>
    ),
  },
  {
    key: "B",
    name: "Arrow and words",
    says: "↑ Send now as one quiet link in the held line's type, so the two modes differ only by whether a status leads it.",
    footer: ({ mode, onSend }) => (
      <div className={`mt-1.5 ${textLine}`}>
        {mode === "held" && <><span>{STATUS.held}</span>{dot}</>}
        <button type="button" onClick={onSend} title={TITLE[mode]} className="flex items-baseline gap-1 outline-none transition-colors hover:text-fg focus-visible:text-fg">
          <InlineArrow />
          <span className="underline decoration-border underline-offset-2">Send now</span>
        </button>
      </div>
    ),
  },
  {
    key: "C",
    name: "A small pill",
    says: "↑ Send now on a quiet filled pill, 22px tall. Reads as a button at a glance without the composer's weight.",
    footer: ({ mode, onSend }) => (
      <div className="mt-1.5 flex items-center justify-end gap-2">
        {mode === "held" && <span className="text-[11.5px] leading-[16px] text-muted">{STATUS.held}</span>}
        <button
          type="button"
          onClick={onSend}
          title={TITLE[mode]}
          className="flex h-[22px] items-center gap-1 rounded-md bg-panel-2 pl-1.5 pr-2 text-[11.5px] font-medium text-muted outline-none transition-colors hover:bg-elevated hover:text-fg focus-visible:ring-1 focus-visible:ring-muted/80"
        >
          <ArrowUp size={11} strokeWidth={2.6} />
          Send now
        </button>
      </div>
    ),
  },
  {
    key: "D",
    name: "A tiny send button",
    says: "A 20px round button in the bubbles' own off-white, dimmed with them, lifting to full on hover — a miniature of the prompt box's send.",
    footer: ({ mode, onSend }) => (
      <div className="mt-1.5 flex items-center justify-end gap-2">
        {mode === "held" && <span className="text-[11.5px] leading-[16px] text-muted">{STATUS.held}</span>}
        <button
          type="button"
          onClick={onSend}
          title={TITLE[mode]}
          aria-label="Send now"
          className="flex h-5 w-5 items-center justify-center rounded-full bg-user-bubble text-user-bubble-fg opacity-50 outline-none transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
        >
          <ArrowUp size={12} strokeWidth={2.6} />
        </button>
      </div>
    ),
  },
  {
    key: "E",
    name: "A status line in both modes",
    says: "Like B, but a queued steer says what it is waiting for too, so the two modes read as one sentence with a different wait.",
    footer: ({ mode, onSend }) => (
      <div className={`mt-1.5 ${textLine}`}>
        <span>{STATUS[mode]}</span>
        {dot}
        <button type="button" onClick={onSend} title={TITLE[mode]} className="flex items-baseline gap-1 outline-none transition-colors hover:text-fg focus-visible:text-fg">
          <InlineArrow />
          <span className="underline decoration-border underline-offset-2">Send now</span>
        </button>
      </div>
    ),
  },
  {
    key: "F",
    name: "Beside the last bubble",
    says: "Not underneath: one always-visible 20px arrow, left of the run's LAST bubble and level with its bottom, where today's hover arrow sits. Held mode keeps its line below.",
    footer: ({ mode }) => (mode === "held" ? <div className={`mt-1.5 ${textLine}`}><span>{STATUS.held}</span></div> : null),
  },
]

// F draws its arrow on the bubble rather than in the footer: the bubble's left edge is only known from
// inside its own positioning context, so the frame wraps the last bubble.
function BesideLast({ m, mode, onSend }: { m: ChatMessage; mode: Mode; onSend: () => void }) {
  return (
    <div className="flex items-end justify-end gap-1.5">
      {/* Lifted 12px off the bubble's bottom edge, which centres the arrow on the bubble's last line. */}
      <SmallArrowButton mode={mode} onSend={onSend} className="mb-3" />
      <div className="flex min-w-0 max-w-[85%] flex-col items-end [&>*]:max-w-full">
        <Message m={m} />
      </div>
    </div>
  )
}

function CandidateFrame({ candidate, mode }: { candidate: (typeof CANDIDATES)[number]; mode: Mode }) {
  const [stage, setStage] = useState<Stage>(mode)
  const send = () => setStage((s) => (s === "held" ? "steer" : "sent"))
  const live: Mode = stage === "held" ? "held" : "steer"
  const Footer = candidate.footer
  return (
    <Frame label={mode === "steer" ? "Sent as steer" : "Sent to queue"}>
      <Tail
        stage={stage}
        footer={<Footer mode={live} onSend={send} />}
        renderBubble={candidate.key === "F" && stage !== "sent" ? (m, i) => (i === WORDS.length - 1 ? <BesideLast m={m} mode={live} onSend={send} /> : <Message m={m} />) : undefined}
      />
      {stage !== mode && (
        <button type="button" onClick={() => setStage(mode)} className={`mt-4 self-start text-[11px] text-muted-60 ${link}`}>
          Reset
        </button>
      )}
    </Frame>
  )
}

function Section({ id, name, says, children }: { id: string; name: string; says: string; children: ReactNode }) {
  return (
    <section className="mb-14">
      <div className="mb-4 flex items-baseline gap-3">
        <span className="text-[13px] font-semibold text-muted-60">{id}</span>
        <h2 className="text-[15px] font-semibold text-fg">{name}</h2>
      </div>
      <p className="mb-5 max-w-[680px] text-[13px] leading-[20px] text-muted">{says}</p>
      <div className="flex gap-6 max-[900px]:flex-col">{children}</div>
    </section>
  )
}

function Sheet() {
  return (
    <TooltipProvider>
      <div className="min-h-screen bg-panel px-10 py-10 text-fg text-sm phone:px-4">
        <div className="mx-auto max-w-[1080px]">
          <h1 className="mb-2 text-[20px] font-semibold">One smaller “Send now” under the queued messages</h1>
          <p className="mb-3 max-w-[720px] text-[13px] leading-[20px] text-muted">
            Today every queued bubble grows its own 28px arrow on hover, but the arrow sends the whole queue. Each candidate
            keeps one arrow for the run, always visible, and lets it mean <em>stop waiting</em>: a steer waiting for the
            agent&rsquo;s next step goes in now, and a message held for the rest goes to the agent&rsquo;s next step. Click
            one to watch a run move along; Reset puts it back.
          </p>
          <p className="mb-10 max-w-[720px] text-[13px] leading-[20px] text-muted">
            The spacing fix is already on <code className="text-fg">main</code> in every frame: the bubbles sit 6px apart
            and a held run has one status line.
          </p>
          {CANDIDATES.map((c) => (
            <Section key={c.key} id={c.key} name={c.name} says={c.says}>
              <CandidateFrame candidate={c} mode="steer" />
              <CandidateFrame candidate={c} mode="held" />
            </Section>
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
