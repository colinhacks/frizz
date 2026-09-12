import { createRoot } from "react-dom/client"
import type { ReactNode } from "react"
import {
  ArrowUp, Check, ChevronDown, ChevronRight, Clock, Ellipsis, FileText, GitPullRequest, Hourglass,
  Maximize2, Paperclip, Pause, Play, RefreshCw, TerminalSquare, Timer, X,
} from "lucide-react"
import { BoxSpinner, STATUS_BOX } from "./components/BoxSpinner.tsx"
import { TranscriptCard, CardActions, CARD_BODY, CARD_PRIMARY_ACTION, CARD_ACTION_EXPLAINER } from "./components/TranscriptCard.tsx"
import { WakeDivider } from "./components/WakeDivider.tsx"
import { CHILD_ARROW, CHILD_ARROW_CLASS } from "./lib/childOps.ts"
import { HEADER_ICON_CLASS } from "./lib/headerIcon.ts"
import "./styles.css"

// MOCKUP SHEET — PAUSE: a thread the human has frozen.
//
// Not shipped UI and not a test: a design surface, in the shape pin-mockup-fixture.tsx established.
// The ask (maintainer 2026-09-03): "add a Pause feature — mock up the UIs and behavior".
//
// WHAT A PAUSE IS, and what it is not. Frizz already has two ways to take a thread out of your way, and
// neither stops the worker:
//   • SNOOZE parks the CARD until an instant. The agent keeps running, its watchers keep waking it, and
//     the card comes back on the clock. It is about the human's queue.
//   • MARK AS DONE ends the session and files the thread away.
// PAUSE is the missing third: the AGENT stops, and nothing Frizz would otherwise send it — the goal, a
// fired timer, a shell ending, a PR going green, a snooze bump — reaches it until the human presses play.
// Everything that would have woken it is HELD, listed, and delivered in order on resume. Your own
// messages queue (the queued-bubble mechanism that already exists). A pause has no clock: it ends when
// you end it.
//
// Frames, in `?screen=` order (omit it for the whole gallery):
//   verb     — WHERE the verb lives: the lifecycle footer beside Snooze (A) vs a header-strip icon (B)
//   menu     — the split button's caret: pause now / pause at next rest
//   dialog   — pausing a RUNNING turn asks first, naming what it interrupts
//   thread   — a paused thread's drawer: the pause card with its held wakes, the composer, a queued send
//   rail     — where a paused row sits: inside Snoozed with a pause mark (A) vs its own PAUSED band (B)
//   resume   — the transcript after play: a hairline, then the one wake carrying every held item
//   board    — PAUSE ALL, a board-level switch (drawn to ask whether it is in scope, not to propose it)
//
//   http://localhost:5478/pause-mockup-fixture.html?font=sans   — ?font=mono for the other
//
// Row, footer and dialog markup is COPIED from Sidebar / ThreadLifecycleFooter / ui/Dialog rather than
// imported, because most of the sheet is states those components cannot draw yet. The transcript card,
// the wake divider and the child-row tokens ARE imported — a pause card should be exactly one more
// member of that family, and using the real one is how the sheet proves it fits.
const params = new URLSearchParams(location.search)
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"
const only = params.get("screen")?.toLowerCase() ?? null

// ── shared atoms ──────────────────────────────────────────────────────────────────────────────────

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString()

// The lifecycle footer's pills, verbatim from SnoozeButton / StateButton.
const PILL = "rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] text-fg/80 hover:bg-panel-2 hover:text-fg"
const SPLIT = "inline-flex items-stretch rounded-md border border-border-strong bg-panel-2/60"
const SPLIT_MAIN = "flex items-center gap-1.5 rounded-l-md px-2.5 py-1 text-[12px] font-medium text-fg/75 hover:bg-panel-2 hover:text-fg"
const SPLIT_CARET = "flex items-center justify-center rounded-r-md px-2 text-fg/75 hover:bg-panel-2 hover:text-fg"
// The header's Retry chrome — the one ACCENT pill in the app, worn by the verb that brings a thread
// back. Resume is the same verb in the same situation, so it wears the same chrome.
const ACCENT_PILL = "flex items-center gap-1.5 rounded-md border border-accent/45 bg-accent/10 px-2.5 py-1 text-[12px] font-medium text-accent hover:border-accent/70 hover:bg-accent/15"

function SplitButton({ label, icon, accent }: { label: string; icon?: ReactNode; accent?: boolean }) {
  return (
    <span className={accent ? "inline-flex items-stretch rounded-md border border-accent/45 bg-accent/10" : SPLIT}>
      <span className={accent ? "flex items-center gap-1.5 rounded-l-md px-2.5 py-1 text-[12px] font-medium text-accent" : SPLIT_MAIN}>{icon}{label}</span>
      <span aria-hidden className={`my-1 w-px ${accent ? "bg-accent/35" : "bg-border"}`} />
      <span className={accent ? "flex items-center justify-center rounded-r-md px-2 text-accent" : SPLIT_CARET}><ChevronDown size={12} /></span>
    </span>
  )
}

// Tabler's target-arrow, the goal mark (RecurringPromptControl.tsx keeps the provenance).
function GoalMark({ live }: { live?: boolean }) {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={live ? "text-accent" : "text-muted-60"} aria-hidden>
      <path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0" />
      <path d="M12 7a5 5 0 1 0 5 5" />
      <path d="M13 3.055a9 9 0 1 0 7.941 7.945" />
      <path d="M15 6v3h3l3 -3h-3v-3l-3 3" />
      <path d="M15 9l-3 3" />
    </svg>
  )
}

// A stand-in for the ContextMeter ring: same em sizing, same currentColor arcs.
function ContextRing() {
  return (
    <svg width="1em" height="1em" viewBox="0 0 16 16" className="text-muted-60" aria-hidden>
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2.5" />
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="14 38" transform="rotate(-90 8 8)" />
    </svg>
  )
}

// ThreadLifecycleFooter's strip: the left readouts cluster, then the verbs. `state` picks the right side.
function Footer({ state, pauseVerb }: { state: "today" | "pausable" | "paused"; pauseVerb?: boolean }) {
  return (
    <footer className="flex min-h-10 items-center justify-end gap-3 border-t border-border/70 bg-panel/95 px-3 pb-2 pt-2 text-[12px]">
      <span className="mr-auto flex items-center gap-3">
        <ContextRing />
        {state === "paused" ? null : <span className="-mx-1 px-0.5 text-muted-60"><Hourglass size={12} /></span>}
        <span className="-mx-[3px]"><GoalMark live={state !== "paused"} /></span>
      </span>
      {state === "paused" ? (
        <>
          <SplitButton accent icon={<Play size={12} fill="currentColor" />} label="Resume" />
          <span className={`flex items-center gap-1 font-medium ${PILL}`}><Check size={12} />Mark as done</span>
        </>
      ) : (
        <>
          {(state === "pausable" || pauseVerb) && <SplitButton icon={<Pause size={12} fill="currentColor" />} label="Pause" />}
          <SplitButton label="Snooze 1d" />
          <span className={`flex items-center gap-1 font-medium ${PILL}`}><Check size={12} />Mark as done</span>
        </>
      )}
    </footer>
  )
}

// The header action strip (HeaderActions): uniform 28px squares on gap-0.5, least→most important.
function HeaderStrip({ pauseIcon, paused }: { pauseIcon?: boolean; paused?: boolean }) {
  return (
    <div className="flex h-12 items-center justify-between border-b border-border/70 px-3">
      <span className="min-w-0 truncate text-[13px] font-medium text-fg/90">Port the v2 drivers to the new broker socket</span>
      <div className="flex shrink-0 items-center gap-0.5">
        <span className={`${HEADER_ICON_CLASS} mx-[2px]`}><RefreshCw size={14} strokeWidth={2} /></span>
        {pauseIcon && (
          <span className={`${HEADER_ICON_CLASS} ${paused ? "text-accent" : ""}`}>
            {paused ? <Play size={14} fill="currentColor" strokeWidth={2} /> : <Pause size={14} fill="currentColor" strokeWidth={2} />}
          </span>
        )}
        <span className={HEADER_ICON_CLASS}><FileText size={14} strokeWidth={2} /></span>
        <span className={HEADER_ICON_CLASS}><Maximize2 size={13} strokeWidth={2} /></span>
      </div>
    </div>
  )
}

// A static copy of ui/Menu's content surface, drawn OPEN.
function MenuSheet({ children }: { children: ReactNode }) {
  return <div className="w-[268px] rounded-lg border border-border bg-panel p-1 shadow-lg shadow-black/40">{children}</div>
}
function MenuRow({ icon, children, detail, highlighted }: { icon?: ReactNode; children: ReactNode; detail?: string; highlighted?: boolean }) {
  return (
    <div className={`flex items-center gap-2 rounded-md px-2.5 py-1.5 text-[12px] ${highlighted ? "bg-panel-2" : ""}`}>
      {icon && <span className="flex w-3.5 shrink-0 items-center justify-center text-muted">{icon}</span>}
      <span className="flex min-w-0 flex-1 items-center justify-between gap-4">
        <span className="whitespace-nowrap">{children}</span>
        {detail && <span className="whitespace-nowrap text-[10px] text-muted-55">{detail}</span>}
      </span>
    </div>
  )
}
function MenuRule() {
  return <div className="my-1 h-px bg-border" />
}

// ── the rail's atoms (copies of ThreadRow / StatusBox / SectionHeader, Sidebar.tsx) ──────────────

function StatusBox({ children }: { children?: ReactNode }) {
  return (
    <span className="inline-flex items-center justify-center rounded-[4px] border border-muted/45" style={{ width: STATUS_BOX, height: STATUS_BOX }}>
      {children}
    </span>
  )
}
const spinner = <BoxSpinner />
const atRest = <StatusBox><Ellipsis size={10} className="text-muted-70" /></StatusBox>
const snoozedMark = <StatusBox><Hourglass size={9} className="text-muted-70" /></StatusBox>
// THE PAUSE MARK: lucide's two bars, FILLED, at the hourglass's 9px. Outlined, two 4×16 rects at 9px
// are four hairlines; filled they are the ⏸ every media player taught the eye.
const pausedMark = <StatusBox><Pause size={9} fill="currentColor" className="text-muted-70" /></StatusBox>

function Row({ indicator, title, restedAge, dim }: { indicator: ReactNode; title: string; restedAge?: string; dim?: boolean }) {
  return (
    <div className={`group relative flex min-w-0 items-start rounded-md hover:bg-white/[0.04] ${dim ? "opacity-65 hover:opacity-90" : ""}`}>
      <div className="min-w-0 flex-1 flex items-start gap-2 pb-1 pl-5 pr-1.5 pt-1">
        <span className="w-4 h-[19px] shrink-0 flex items-center justify-center">{indicator}</span>
        <span className="min-w-0 flex-1 flex flex-col">
          <span className="flex min-w-0 items-baseline gap-3">
            <span className={`min-w-0 flex-1 break-words text-[13px] leading-[19px] ${dim ? "text-fg/75" : "text-fg/90"}`}>{title}</span>
            {restedAge && <span className="shrink-0 tabular-nums text-[10.5px] leading-[19px] text-muted-55">{restedAge}</span>}
          </span>
        </span>
      </div>
    </div>
  )
}
function Header({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex w-full items-center gap-1 px-1.5 py-1 text-[11px] uppercase tracking-wide text-muted-70">
      <ChevronRight size={11} className="rotate-90" />
      <span>{label}</span>
      <span className="ml-1.5 tabular-nums text-muted-60">{count}</span>
    </div>
  )
}
function Rule() {
  return <hr className="my-3 border-border/50" />
}
function PromptBoxGhost({ children }: { children?: ReactNode }) {
  return (
    <div className="mb-5">
      <div className="rounded-lg border border-border/60 bg-panel px-3 py-2.5 text-[13px] text-muted-40">Dispatch a new thread…</div>
      {children}
    </div>
  )
}
function RailTop() {
  return (
    <>
      <Row indicator={atRest} title="Fix the cache collision in the resolver" restedAge="2h 10m" />
      <Row indicator={atRest} title="Triage the dependabot queue" restedAge="1d 3h" />
      <Rule />
      <Row indicator={spinner} title="Verify the relay pin mechanics on staging" />
      <Rule />
    </>
  )
}

// ── the paused thread's pieces ────────────────────────────────────────────────────────────────────

// One HELD WAKE: the thing that would have woken the worker, and when. Lives inside the pause card, in
// the completion-hold dialog's list idiom (the ⤷ token, a label, nothing interactive but the ×).
function HeldWake({ icon, children, age, count }: { icon: ReactNode; children: ReactNode; age: string; count?: string }) {
  return (
    <li className="group/held flex min-w-0 items-center gap-1.5 text-[12px]">
      <span aria-hidden className={CHILD_ARROW_CLASS}>{CHILD_ARROW}</span>
      <span className="flex w-3.5 shrink-0 items-center justify-center text-muted-70">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-fg/80">{children}</span>
      {count && <span className="shrink-0 text-[11px] text-muted-60">{count}</span>}
      <span className="shrink-0 tabular-nums text-[11px] text-muted-50">{age}</span>
      <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-40 opacity-0 transition-opacity hover:bg-panel hover:text-fg group-hover/held:opacity-100"><X size={11} /></span>
    </li>
  )
}

const heldWakes = (
  <ul className="mt-2 flex flex-col gap-1">
    <HeldWake icon={<GoalMark live />} age="38m" count="fired 3×">Goal — stop hook: “Keep porting drivers until the three-platform run is green”</HeldWake>
    <HeldWake icon={<Timer size={12} />} age="24m">Timer — “re-check the macOS leg”</HeldWake>
    <HeldWake icon={<TerminalSquare size={12} />} age="12m">Shell ended — <code className="rounded bg-panel px-1 text-[11px]">Watch CI</code> · exit 0</HeldWake>
    <HeldWake icon={<GitPullRequest size={12} />} age="5m">acme/app#391 — checks green, 1 new review comment</HeldWake>
  </ul>
)

function PauseCard({ held }: { held?: boolean }) {
  return (
    <TranscriptCard tone="caution" icon={Pause} label="Paused by you" data-pause-card>
      <span className={CARD_BODY}>
        {held
          ? "Nothing reaches this worker until you resume. Four wakes are held below, in the order they arrived; your messages queue."
          : "Nothing reaches this worker until you resume. Anything that would have woken it is held here; your messages queue."}
      </span>
      {held && heldWakes}
      <CardActions>
        <span className={CARD_PRIMARY_ACTION}><Play size={11} fill="currentColor" />Resume</span>
        <span className={CARD_ACTION_EXPLAINER}>Delivers the held wakes as one message, then any queued sends.</span>
      </CardActions>
    </TranscriptCard>
  )
}

function ComposerGhost({ paused }: { paused?: boolean }) {
  return (
    <div className="px-3 py-3">
      <div className="relative rounded-xl border border-border bg-bg">
        <div className="px-3 pb-10 pt-3 text-[14px] text-muted-40">{paused ? "Paused — your message queues until you resume…" : "Follow up…"}</div>
        <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1">
          <span className="rounded-md bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted-70">Opus 5</span>
          <span className="rounded-md bg-panel-2 px-1.5 py-0.5 text-[10px] text-muted-70">high</span>
        </div>
        <span className="absolute bottom-2 right-[44px] flex h-7 w-7 items-center justify-center rounded-lg text-muted"><Paperclip size={14} /></span>
        <span className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-bg"><ArrowUp size={14} strokeWidth={2.5} /></span>
      </div>
      {paused && (
        <div className="px-1 pt-1 text-[9.5px] leading-tight text-muted-65">Paused · Enter queues · ⌘⏎ resumes and sends</div>
      )}
    </div>
  )
}

function QueuedBubble({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[78%] rounded-xl rounded-br-sm bg-user-bubble px-3.5 py-3 text-[14px] text-bg opacity-50">{children}</div>
    </div>
  )
}

function AssistantProse({ children }: { children: ReactNode }) {
  return <p className="text-[14px] leading-6 text-fg/85">{children}</p>
}

// A static copy of ui/Dialog, drawn open and in flow (no portal, no overlay).
function DialogSheet({ title, children, footer }: { title: string; children: ReactNode; footer: ReactNode }) {
  return (
    <div className="flex w-[390px] flex-col overflow-hidden rounded-xl border border-border bg-panel shadow-2xl shadow-black/50">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{title}</span>
        <span className="rounded-md p-1 text-muted"><X size={14} /></span>
      </header>
      <div>{children}</div>
      <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-4 py-3">{footer}</footer>
    </div>
  )
}

// ── the sheet ─────────────────────────────────────────────────────────────────────────────────────

function Frame({ id, title, note, children, width }: { id: string; title: string; note: ReactNode; children: ReactNode; width?: number }) {
  if (only && only !== id) return null
  return (
    <section className="mb-12" data-screen={id}>
      <h2 className="mb-1 text-[13px] font-semibold text-fg/90">{title}</h2>
      <p className="mb-4 max-w-[760px] text-[11.5px] leading-[16px] text-muted-60">{note}</p>
      <div className="flex flex-wrap items-start gap-8" style={width ? { maxWidth: width } : undefined}>{children}</div>
    </section>
  )
}
function Panel({ title, note, children, width = 340 }: { title: string; note?: string; children: ReactNode; width?: number }) {
  return (
    <section className="shrink-0" style={{ width }}>
      <h3 className="mb-1 text-[12px] font-medium text-fg/80">{title}</h3>
      {note && <p className="mb-3 min-h-[30px] text-[11px] leading-[15px] text-muted-60">{note}</p>}
      <div className="overflow-hidden rounded-xl border border-border/40">{children}</div>
    </section>
  )
}

// A drawer-shaped stage: header strip, a transcript slice, the composer, the footer.
function Drawer({ header, children, composer, footer, width = 520 }: { header: ReactNode; children: ReactNode; composer?: ReactNode; footer: ReactNode; width?: number }) {
  return (
    <div className="flex flex-col bg-bg" style={{ width }}>
      {header}
      <div className="flex flex-col gap-3 px-4 pb-3 pt-4">{children}</div>
      {composer}
      {footer}
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-bg px-10 py-10 text-fg">
    {!only && (
      <>
        <h1 className="mb-1 text-[15px] font-semibold">Pause — a thread the human has frozen</h1>
        <p className="mb-10 max-w-[760px] text-[11.5px] leading-[16px] text-muted-60">
          Snooze parks the card and Mark as done ends the session; neither stops the worker. Pause does: the agent halts, and nothing Frizz would otherwise deliver — the goal, a timer, a shell ending, a PR going green, a snooze bump — reaches it until you press play. Every wake that arrives meanwhile is held and listed; your own messages queue. On resume, Frizz sends one message carrying every held wake in order, then the queued sends. A pause has no clock.
        </p>
      </>
    )}

    <Frame id="verb" title="1 · Where the verb lives" note={<>Two candidates. <b>A</b> puts Pause in the lifecycle footer as a split button beside Snooze — its sibling, since both park the thread and both belong to the strip that already holds every whole-thread lifecycle verb. Once paused, the footer swaps Pause and Snooze for one accent <b>Resume</b> (the header's Retry chrome: the same verb, bringing a thread back) and keeps Mark as done. <b>B</b> puts it in the header's icon strip beside Restart worker, an icon that flips to play — cheaper, but it files a lifecycle verb among the maintenance and navigation icons, and Resume becomes a 14px glyph for the one thing a paused thread wants you to do.</>}>
      <Panel title="A · footer, today" note="The strip as it ships: readouts left, Snooze and Mark as done right." width={520}>
        <Footer state="today" />
      </Panel>
      <Panel title="A · footer, with Pause" note="Pause leads the verbs — least→most important runs left→right, and Mark as done stays the terminal one." width={520}>
        <Footer state="pausable" />
      </Panel>
      <Panel title="A · footer, paused" note="Resume is the only accent pill in the strip; Snooze is gone (a pause outranks a park); the goal mark goes muted because it will not fire." width={520}>
        <Footer state="paused" />
      </Panel>
      <Panel title="B · header icon, both states" note="A ⏸ in the action strip beside Restart worker; paused, it becomes an accent ▶." width={520}>
        <HeaderStrip pauseIcon />
        <HeaderStrip pauseIcon paused />
      </Panel>
    </Frame>

    <Frame id="menu" title="2 · The split button's caret" note={<>Like Snooze, the caret ARMS a mode and the main segment applies it. A resting thread pauses instantly either way. The two modes only differ for a RUNNING turn: <b>now</b> interrupts it (the same SDK interrupt ⌘⏎ already uses, so the worker resumes exactly where it stopped), <b>at next rest</b> lets the turn and its sub-agents finish and holds the rest that follows. The Resume caret offers the one thing Resume itself does not: dropping the held wakes instead of delivering them.</>}>
      <Panel title="Pause ▾" width={300}>
        <div className="p-3">
          <MenuSheet>
            <MenuRow icon={<Pause size={12} fill="currentColor" />} highlighted detail="interrupts">Pause now</MenuRow>
            <MenuRow icon={<Clock size={12} />} detail="lets the turn finish">Pause at next rest</MenuRow>
          </MenuSheet>
        </div>
      </Panel>
      <Panel title="Resume ▾" width={300}>
        <div className="p-3">
          <MenuSheet>
            <MenuRow icon={<Play size={12} fill="currentColor" />} highlighted detail="4 held">Resume</MenuRow>
            <MenuRow icon={<X size={12} />} detail="nothing delivered">Resume, drop held</MenuRow>
          </MenuSheet>
        </div>
      </Panel>
    </Frame>

    <Frame id="dialog" title="3 · Pausing a running turn asks first" note={<>Mark as done already asks before killing live work, and this is the same dialog with a gentler verb: it names the turn and every live child the interrupt will stop. Background shells are NOT stopped — they are OS processes, and their exit becomes a held wake. A resting thread never sees this dialog.</>}>
      <DialogSheet
        title="Pause this thread now?"
        footer={
          <>
            <span className="rounded-md px-3 py-1.5 text-[12px] text-muted">Cancel</span>
            <span className="rounded-md border border-border-strong px-3 py-1.5 text-[12px] text-fg/80">Pause at next rest</span>
            <span className="flex items-center gap-1.5 rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg"><Pause size={12} fill="currentColor" />Pause now</span>
          </>
        }
      >
        <div className="flex flex-col gap-2 p-4 text-[12px] leading-relaxed text-muted">
          <p>The worker is mid-turn. Pausing now interrupts it — it stops at its next tool boundary and picks up exactly where it left off when you resume. This also stops:</p>
          <div className="flex flex-col gap-0.5">
            <div className="text-[11px] font-medium uppercase tracking-wide text-fg/70">2 sub-agents</div>
            <ul className="flex flex-col gap-0.5">
              <li className="flex min-w-0 items-baseline gap-1.5"><span aria-hidden className={CHILD_ARROW_CLASS}>{CHILD_ARROW}</span><span className="min-w-0 truncate text-fg/80">Review the driver diff</span></li>
              <li className="flex min-w-0 items-baseline gap-1.5"><span aria-hidden className={CHILD_ARROW_CLASS}>{CHILD_ARROW}</span><span className="min-w-0 truncate text-fg/80">Port the arm64 leg</span><span className="shrink-0 text-[11px] text-muted-60">no recent output</span></li>
            </ul>
          </div>
          <p>1 background shell (<code className="rounded bg-panel-2 px-1">Watch CI</code>) keeps running; its exit will be held for you.</p>
        </div>
      </DialogSheet>
    </Frame>

    <Frame id="thread" title="4 · A paused thread, opened" note={<>The pause card is one more member of the transcript-card family — the usage-limit pause already wears this caution tone and the same "Continue" shape, so the human pause reads as the same kind of thing with a different author. It sits at the transcript's tail, above the composer, and it is where the held wakes live: each names what would have woken the worker and how long ago, with a hover × to drop one. The goal collapses to a single line with a fire count (one text, re-sent three times, is one wake). The composer stays open: Enter queues (the existing dimmed queued bubble), ⌘⏎ resumes and sends.</>}>
      <Panel title="Drawer, paused with four held wakes" width={560}>
        <Drawer
          width={558}
          header={<HeaderStrip />}
          composer={<ComposerGhost paused />}
          footer={<Footer state="paused" />}
        >
          <AssistantProse>The v2 driver port is done for x86 and I have started on arm64. The macOS leg went red on the last run, which is why a re-check timer is armed.</AssistantProse>
          <PauseCard held />
          <QueuedBubble>Also port the Windows leg while you are at it.</QueuedBubble>
        </Drawer>
      </Panel>
      <Panel title="Just paused — nothing held yet" width={560}>
        <Drawer width={558} header={<HeaderStrip />} composer={<ComposerGhost paused />} footer={<Footer state="paused" />}>
          <AssistantProse>The v2 driver port is done for x86 and I have started on arm64.</AssistantProse>
          <PauseCard />
        </Drawer>
      </Panel>
    </Frame>

    <Frame id="rail" title="5 · Where a paused row sits" note={<>A paused thread has no queue card (a pause outranks an open question, exactly as a user snooze does) and no rest time. <b>A</b> files it in the existing Snoozed band, dimmed like its neighbours, wearing a filled ⏸ where they wear the hourglass, sorted first because it will never come back on its own. <b>B</b> gives it a PAUSED band of its own between Snoozed and Done, drawn only while something is paused. The tooltip on either reads "Paused 40m ago — 4 wakes held".</>}>
      <Panel title="A · inside Snoozed, pause-marked" note="One band for every park the human made; the mark says which kind.">
        <div className="p-3">
          <PromptBoxGhost />
          <RailTop />
          <Header label="Snoozed" count={4} />
          <Row indicator={pausedMark} title="Port the v2 drivers to the new broker socket" dim />
          <Row indicator={pausedMark} title="Sweep the stale tmux vocabulary out of the seed scripts" dim />
          <Row indicator={snoozedMark} title="Redesign the queue card actions" dim />
          <Row indicator={snoozedMark} title="Verify the Windows bring-up on nub-win" dim />
          <Rule />
          <Header label="Done" count={12} />
        </div>
      </Panel>
      <Panel title="B · its own PAUSED band" note="Snoozed keeps meaning “comes back on its own”; Paused means “waits for you”.">
        <div className="p-3">
          <PromptBoxGhost />
          <RailTop />
          <Header label="Snoozed" count={2} />
          <Row indicator={snoozedMark} title="Redesign the queue card actions" dim />
          <Row indicator={snoozedMark} title="Verify the Windows bring-up on nub-win" dim />
          <Rule />
          <Header label="Paused" count={2} />
          <Row indicator={pausedMark} title="Port the v2 drivers to the new broker socket" dim />
          <Row indicator={pausedMark} title="Sweep the stale tmux vocabulary out of the seed scripts" dim />
          <Rule />
          <Header label="Done" count={12} />
        </div>
      </Panel>
    </Frame>

    <Frame id="resume" title="6 · After play" note={<>Resume writes a hairline into the transcript — the wake-divider family every child event already uses, with the pause's duration on it — and then delivers ONE frizz wake carrying every held item in arrival order, so the worker reads what happened while it was stopped as a single briefing rather than four separate bumps. Queued sends follow as their own bubbles. The pause card itself stays in the transcript, collapsed to its title, as the record of the stop.</>}>
      <Panel title="Transcript tail, four minutes after resume" width={560}>
        <Drawer width={558} header={<HeaderStrip />} composer={<ComposerGhost />} footer={<Footer state="today" pauseVerb />}>
          <AssistantProse>The v2 driver port is done for x86 and I have started on arm64.</AssistantProse>
          <div className="rounded-xl border border-border/60 bg-panel-2 px-4 py-2.5 text-[12px] text-muted-70">
            <span className="flex items-center gap-2"><Pause size={12} className="text-muted-60" />Paused by you · 2h 35m</span>
          </div>
          <WakeDivider icon={Play} at={minutesAgo(4)}>Resumed — 4 held wakes delivered</WakeDivider>
          <div className="rounded-xl border border-border/60 bg-panel-2 p-4 text-[13px] leading-5 text-fg/75">
            <div className="petite-caps mb-1.5 text-[11px] tracking-wide text-muted-60">frizz</div>
            <p>▶ Resumed after being paused for <b className="font-medium text-fg/85">2h 35m</b>. While you were paused:</p>
            <ol className="mt-1.5 list-decimal space-y-0.5 pl-5">
              <li>Goal (stop hook), fired 3×: “Keep porting drivers until the three-platform run is green”</li>
              <li>Timer fired: “re-check the macOS leg”</li>
              <li>Shell <code className="rounded bg-panel px-1 text-[11px]">Watch CI</code> ended, exit 0</li>
              <li>acme/app#391: checks green, 1 new review comment</li>
            </ol>
            <p className="mt-1.5">Continue exactly where you left off.</p>
          </div>
          <QueuedBubble>Also port the Windows leg while you are at it.</QueuedBubble>
        </Drawer>
      </Panel>
    </Frame>

    <Frame id="board" title="7 · Pause all (scope question, not a proposal)" note={<>The same switch at board altitude: every open thread in this project pauses at once, and new dispatches start paused, until Resume all. Useful before a Frizz restart, a quota crunch, or a machine you are about to close. Drawn small because it is a second feature riding the first's mechanics — the question is whether it ships with Pause or later.</>}>
      <Panel title="Rail top while the board is paused" note="A caution strip under the prompt box; the ⏸ beside the project name is the switch.">
        <div className="p-3">
          <div className="mb-3 flex items-center justify-between px-1">
            <span className="text-[12px] font-medium text-fg/85">frizz</span>
            <span className="flex h-6 w-6 items-center justify-center rounded-md bg-accent/10 text-accent"><Pause size={12} fill="currentColor" /></span>
          </div>
          <PromptBoxGhost>
            <div className="mt-2 flex items-center gap-2 rounded-md border border-attention-fill/30 bg-attention-fill/10 px-2.5 py-1.5 text-[11px] text-attention-detail-90">
              <Pause size={11} fill="currentColor" />
              <span className="min-w-0 flex-1 truncate">Paused · 7 threads · 12m</span>
              <span className="flex shrink-0 items-center gap-1 rounded bg-fg px-2 py-0.5 text-[10.5px] font-medium text-bg"><Play size={10} fill="currentColor" />Resume all</span>
            </div>
          </PromptBoxGhost>
          <Header label="Paused" count={7} />
          <Row indicator={pausedMark} title="Port the v2 drivers to the new broker socket" dim />
          <Row indicator={pausedMark} title="Fix the cache collision in the resolver" dim />
          <Row indicator={pausedMark} title="Triage the dependabot queue" dim />
          <Row indicator={pausedMark} title="Verify the relay pin mechanics on staging" dim />
          <div className="px-5 pt-1 text-[10.5px] text-muted-45">+3 more</div>
          <Rule />
          <Header label="Done" count={12} />
        </div>
      </Panel>
    </Frame>
  </main>,
)
