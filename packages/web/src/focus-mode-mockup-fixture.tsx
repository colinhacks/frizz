// FOCUS MODE — a running thread as the page, mocked up for the desktop board.
//
// Not a test and not shipped UI: a DESIGN SURFACE in the `awaiting-mockups-fixture.tsx` shape. Every
// frame renders on the app's REAL stylesheet and tokens, so a choice made here is a choice about the
// thing that would ship.
//
//   nubx vite --port 5478 --strictPort          (from packages/web)
//   http://localhost:5478/focus-mode-mockup-fixture.html            — the gallery, every frame
//                                               ?screen=focus       — one frame, alone, at 1:1
//                                               ?font=mono          — the other font setting
//
// ── What is being designed ────────────────────────────────────────────────────────────────────────
// Today a RUNNING sidebar row opens the thread as a right-hand sheet OVER the queue. The idea under
// test (maintainer 2026-08-28): clicking a running chat instead slides the SIDEBAR off the left edge
// and slides the chat in, left-aligned — and the freed width becomes an operational rail beside the
// transcript: the live sub-agents, the background shells, the files the worker has edited, what it is
// watching. Clicking a file opens it in a right panel (the /full split viewer's machinery), where a
// selection can be copied or pulled into the composer as ⌘I context.
//
// Everything drawn in the rail is data the app already holds or can derive: sub-agents and shells are
// the board's child ops; watches are thread_watch rows; EDITED FILES are derivable from the
// transcript's Edit/Write tool calls (a git-status cross-check could mark still-uncommitted ones).
//
// Frames, in `?screen=` order:
//   board          — reference: today's board; the running row is the click target
//   focus          — after the click: sidebar gone, thread left-aligned, the rail beside it
//   focus-file     — a file clicked in the rail: the viewer opens as a third column
//   focus-context  — a selection in the viewer pulled into the composer as a context chip
//   focus-collapsed— the rail folded to an icon strip once the viewer is open (width variant)
import { createRoot } from "react-dom/client"
import type { ReactNode } from "react"
import {
  ArrowLeft, ArrowUp, Bot, Check, ChevronRight, Circle, CircleCheck, Copy, ExternalLink, Eye,
  FileDiff, GitPullRequest, Loader2, MessageSquare, Paperclip, Plus, TerminalSquare, Timer, X,
} from "lucide-react"
import "./styles.css"

const params = new URLSearchParams(location.search)
// THIS APP RENDERS IN TWO FONTS and a fixture that sets neither silently takes the MONO default.
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"
const only = params.get("screen")?.toLowerCase() ?? null

// ── shared vocabulary ─────────────────────────────────────────────────────────────────────────────
const spinner = <Loader2 size={12} className="animate-spin text-accent" aria-hidden />
const petite = "petite-caps text-[10px] tracking-wide text-muted-60"

function SectionLabel({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div className="flex items-baseline gap-1.5 px-4 pt-4 pb-1.5">
      <span className={petite}>{children}</span>
      {count !== undefined && <span className="text-[10px] tabular-nums text-muted-40">{count}</span>}
    </div>
  )
}

function RailRow({ icon, label, meta, sub, active }: { icon: ReactNode; label: ReactNode; meta?: ReactNode; sub?: ReactNode; active?: boolean }) {
  return (
    <button type="button" className={`group flex w-full items-start gap-2 px-4 py-1.5 text-left transition-colors hover:bg-white/[0.04] ${active ? "bg-white/[0.05]" : ""}`}>
      <span className="mt-[2px] flex h-[16px] w-4 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate text-[12px] leading-[17px] text-fg/85">{label}</span>
          {meta && <span className="shrink-0 text-[10.5px] tabular-nums text-muted-60">{meta}</span>}
        </span>
        {sub && <span className="block truncate text-[10.5px] leading-[15px] text-muted-60">{sub}</span>}
      </span>
    </button>
  )
}

// ── the operational rail (the whole point) ────────────────────────────────────────────────────────
function MetaRail({ collapsed, fileOpen }: { collapsed?: boolean; fileOpen?: string }) {
  if (collapsed) {
    return (
      <aside className="flex h-full w-11 shrink-0 flex-col items-center gap-4 pt-4" aria-label="Thread activity, collapsed">
        <ChevronRight size={13} className="rotate-180 text-muted-60" />
        <span className="relative"><Bot size={14} className="text-muted" /><span className="absolute -right-1.5 -top-1 rounded-full bg-accent px-[3px] text-[8px] font-semibold leading-[11px] text-bg">2</span></span>
        <span className="relative"><TerminalSquare size={14} className="text-muted" /><span className="absolute -right-1.5 -top-1 rounded-full bg-panel-2 px-[3px] text-[8px] font-semibold leading-[11px] text-muted">1</span></span>
        <span className="relative"><FileDiff size={14} className="text-muted" /><span className="absolute -right-1.5 -top-1 rounded-full bg-panel-2 px-[3px] text-[8px] font-semibold leading-[11px] text-muted">4</span></span>
        <Eye size={14} className="text-muted" />
      </aside>
    )
  }
  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col overflow-y-auto" aria-label="Thread activity">
      {/* liveness header: what the worker is doing RIGHT NOW, and on what budget */}
      <div className="border-b border-border/40 px-4 pb-3 pt-3.5">
        <div className="flex items-center gap-2">
          {spinner}
          <span className="min-w-0 flex-1 truncate text-[12px] text-fg/90">Running focused tests</span>
          <span className="shrink-0 text-[10.5px] tabular-nums text-muted-60">14m</span>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <span className="petite-caps rounded border border-border/60 px-1 text-[9.5px] leading-[14px] text-muted-55">opus › high</span>
          <span className="petite-caps rounded border border-border/60 px-1 text-[9.5px] leading-[14px] text-muted-55">auto</span>
          <span className="ml-auto flex items-center gap-1.5">
            <span className="h-1 w-16 overflow-hidden rounded-full bg-panel-2"><span className="block h-full w-[62%] rounded-full bg-muted/50" /></span>
            <span className="text-[10px] tabular-nums text-muted-50">62%</span>
          </span>
        </div>
      </div>

      <SectionLabel count={3}>Sub-agents</SectionLabel>
      <RailRow icon={spinner} label="Verifying the resolver fix against a live stack" meta="6m" sub="claude · frizz:high" />
      <RailRow icon={spinner} label="Sweeping call sites of normalizeId" meta="2m" sub="claude · frizz:medium" />
      <RailRow icon={<CircleCheck size={12} className="text-muted-70" />} label="Traced the cache-collision repro" meta="11m" sub="returned · 1.2k tokens" />

      <SectionLabel count={1}>Background shells</SectionLabel>
      <RailRow icon={<TerminalSquare size={12} className="text-muted" />} label={<span className="font-mono-keep">nub run dev</span>} meta="42m" sub="serving on :5175 · 312 lines" />

      <SectionLabel count={4}>Edited files</SectionLabel>
      <RailRow active={fileOpen === "resolver"} icon={<FileDiff size={12} className={fileOpen === "resolver" ? "text-accent" : "text-muted"} />} label={<span className="font-mono-keep">src/resolver.ts</span>} meta={<span><span className="text-emerald-500/80">+24</span> <span className="text-danger-70">−9</span></span>} />
      <RailRow icon={<FileDiff size={12} className="text-muted" />} label={<span className="font-mono-keep">src/resolver.test.ts</span>} meta={<span><span className="text-emerald-500/80">+61</span> <span className="text-danger-70">−0</span></span>} />
      <RailRow icon={<FileDiff size={12} className="text-muted" />} label={<span className="font-mono-keep">lib/cache.ts</span>} meta={<span><span className="text-emerald-500/80">+3</span> <span className="text-danger-70">−3</span></span>} />
      <RailRow icon={<FileDiff size={12} className="text-muted" />} label={<span className="font-mono-keep">ARCHITECTURE.md</span>} meta={<span><span className="text-emerald-500/80">+12</span> <span className="text-danger-70">−1</span></span>} />

      <SectionLabel count={2}>Watching</SectionLabel>
      <RailRow icon={<GitPullRequest size={12} className="text-muted" />} label="acme/app#491" meta="checks 3/5" sub="2 running · none failed" />
      <RailRow icon={<Timer size={12} className="text-muted" />} label="Re-check the nightly bench" meta="in 2h" />
      <div className="mt-auto border-t border-border/60 px-4 py-2.5 text-[10.5px] text-muted-50">Click a file to open it beside the thread</div>
    </aside>
  )
}

// ── the thread column ─────────────────────────────────────────────────────────────────────────────
function ThreadColumn({ narrow, contextChip }: { narrow?: boolean; contextChip?: boolean }) {
  return (
    <main className={`flex h-full min-w-0 flex-col border-x border-border bg-panel ${narrow ? "flex-1" : "w-[880px] shrink-0"}`}>
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
        <button type="button" className="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[12px] text-muted transition-colors hover:bg-panel-2 hover:text-fg"><ArrowLeft size={13} /> Board</button>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">fix the resolver cache collision</div>
          <div className="truncate text-[10px] text-muted-60">running · last active just now</div>
        </div>
        <button type="button" className="rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] font-medium text-fg/80">Interrupt</button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="ml-auto max-w-[80%] rounded-lg bg-panel-2 px-3.5 py-2.5 text-[13px] text-fg/90">The resolver returns the wrong entry when two ids normalize to the same key — fix it and pin it with a test.</div>
        <div className="mt-5 space-y-3 text-[13px] leading-relaxed text-fg/90">
          <p><strong>Found it</strong> — <span className="font-mono-keep text-[12px]">resolveEntry</span> keys its memo on the RAW id, so <span className="font-mono-keep text-[12px]">User-7</span> and <span className="font-mono-keep text-[12px]">user_7</span> collide after normalization. Fixing the memo key and adding the regression test now.</p>
          <div className="rounded-md border border-border/60 bg-panel-2/40 px-3 py-2 text-[12px] text-muted">Ran 4 tool calls <ChevronRight size={11} className="ml-0.5 inline-block align-[-1px]" /></div>
        </div>
        <div className="mt-5 flex items-center gap-2 text-[12.5px] text-muted">
          {spinner}
          <span className="shimmer-text">Running focused tests</span>
          <span className="tabular-nums text-muted-50">3m</span>
        </div>
      </div>
      <div className="shrink-0 px-6 pb-4">
        <div className="rounded-xl border border-border bg-bg">
          {contextChip && (
            <div className="px-3.5 pt-2.5 -mb-1">
              <span className="inline-flex items-center gap-1 rounded-md border border-accent/60 bg-panel-2 px-1.5 py-0.5 text-[11px] text-fg">
                <span className="font-mono-keep">resolver.ts:24-31</span>
                <MessageSquare size={10} className="text-muted" />
                <X size={10} className="text-muted" strokeWidth={2.5} />
              </span>
            </div>
          )}
          <div className={`px-3.5 pb-8 text-[13px] ${contextChip ? "pt-2.5 text-fg" : "pt-2.5 text-muted"}`}>{contextChip ? "Is the fallback branch here still reachable?" : "Follow up…"}</div>
          <div className="pointer-events-none relative">
            <span className="absolute bottom-2 right-2 flex h-7 w-7 items-center justify-center rounded-lg bg-panel-2 text-muted"><ArrowUp size={14} strokeWidth={2.5} /></span>
            <span className="absolute bottom-2 right-11 flex h-7 w-7 items-center justify-center rounded-lg text-muted"><Paperclip size={15} strokeWidth={2} /></span>
          </div>
        </div>
      </div>
    </main>
  )
}

// ── the file viewer column ────────────────────────────────────────────────────────────────────────
function FileColumn({ selection }: { selection?: boolean }) {
  const add = "bg-emerald-500/[0.08] text-emerald-200/90"
  const del = "bg-danger-fill/[0.08] text-danger-soft-80 line-through decoration-danger-soft/40"
  const sel = "bg-accent/20 text-emerald-100 rounded-[2px]"
  return (
    <section className="flex h-full min-w-0 flex-1 flex-col border-l border-border bg-panel">
      <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border px-4">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium">resolver.ts</div>
          <div className="truncate text-[10px] text-muted-60">src/resolver.ts · edited 2m ago</div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5 rounded-md border border-border-strong p-0.5 text-[11px] font-medium">
          <button type="button" className="rounded bg-panel-2 px-2 py-0.5 text-fg">Diff</button>
          <button type="button" className="rounded px-2 py-0.5 text-muted">File</button>
        </div>
        <button type="button" className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg"><X size={15} /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 font-mono-keep text-[12px] leading-5">
        <div className="mb-2 text-muted-50">@@ -18,9 +18,14 @@ export function resolveEntry(id: string)</div>
        {[
          ["  ", "const key = normalizeId(id)", ""],
          ["- ", "const hit = memo.get(id)", del],
          ["+ ", "const hit = memo.get(key)", add],
          ["  ", "if (hit) return hit", ""],
          ["  ", "", ""],
          ["+ ", "// Two raw ids can normalize to one key; the memo must key on the", selection ? sel : add],
          ["+ ", "// NORMALIZED id or the second spelling returns the first's entry.", selection ? sel : add],
          ["+ ", "const entry = lookup(key) ?? fallbackScan(key)", selection ? sel : add],
          ["- ", "const entry = lookup(id)", del],
          ["  ", "memo.set(key, entry)", ""],
          ["  ", "return entry", ""],
        ].map(([g, text, cls], i) => (
          <div key={i} className={`whitespace-pre px-1 ${cls}`}>{g}{text}</div>
        ))}
        {selection && (
          <div className="mt-3 inline-flex items-center gap-2 rounded-md border border-border bg-bg px-2 py-1 text-[11px] text-muted shadow-lg" style={{ fontFamily: "inherit" }}>
            <span className="flex items-center gap-1 text-fg/80"><Plus size={11} /> Add to context</span>
            <span className="text-muted-40">⌘I</span>
            <span className="mx-0.5 h-3 w-px bg-border" />
            <span className="flex items-center gap-1"><Copy size={11} /> Copy</span>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 border-t border-border/60 px-4 py-2.5">
        <span className="truncate text-[10.5px] text-muted-60">Select text and press ⌘I to add it to the chat</span>
        <span className="flex items-center gap-1.5">
          <button type="button" className="flex items-center gap-1.5 rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] font-medium text-fg/80"><Copy size={12} /> Copy</button>
          <button type="button" className="flex items-center gap-1.5 rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] font-medium text-fg/80"><ExternalLink size={12} /> Open</button>
        </span>
      </div>
    </section>
  )
}

// ── the board reference frame ─────────────────────────────────────────────────────────────────────
function BoardFrame() {
  const row = (mark: ReactNode, label: string, trailer?: ReactNode, dim?: boolean) => (
    <div className="flex items-start gap-2 rounded-md py-1 pl-5 pr-1.5 hover:bg-white/[0.04]">
      <span className="flex h-[19px] w-4 shrink-0 items-center justify-center">{mark}</span>
      <span className={`min-w-0 flex-1 text-[13px] leading-[19px] ${dim ? "text-fg/50" : "text-fg/90"}`}>{label}</span>
      {trailer}
    </div>
  )
  return (
    <div className="flex h-full items-start justify-center gap-8 bg-bg pt-4">
      <aside className="w-[240px] shrink-0 pt-2">
        <button type="button" className="mb-5 flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-[12px] text-fg/80"><Plus size={12} /> New thread</button>
        <div className={`${petite} mb-1 pl-5`}>Rested · 2</div>
        {row(<Circle size={7} className="fill-accent text-accent" />, "wire the settings export", <span className="pr-1 text-[10.5px] tabular-nums text-muted-50">3h</span>)}
        {row(<Circle size={7} className="fill-accent text-accent" />, "why is the tailer dropping frames?", <span className="pr-1 text-[10.5px] tabular-nums text-muted-50">1d</span>)}
        <hr className="my-3 border-border/50" />
        <div className="rounded-md ring-1 ring-accent/60">
          {row(spinner, "fix the resolver cache collision")}
        </div>
        <div className="pb-1 pl-5 pt-0.5 text-[11px] text-accent/90">↑ click a running thread</div>
        {row(spinner, "sweep the stale tmux comments")}
        <div className={`${petite} mt-4 pl-5`}>Snoozed · 3</div>
        <div className={`${petite} mt-1 pl-5`}>Done · 41</div>
      </aside>
      <main className="h-full w-[880px] rounded-t-lg border-x border-t border-border bg-panel px-6 pt-5">
        <div className="rounded-xl border border-border bg-bg px-3.5 py-2.5 text-[13px] text-muted">Describe a task to dispatch…</div>
        <div className="mt-6 space-y-4">
          <div className="rounded-lg border border-border bg-panel-2/30 px-4 py-3">
            <div className="text-[13px] font-medium">wire the settings export</div>
            <div className="mt-1 text-[12px] text-muted">Needs you — pick the export shape (2 options)</div>
          </div>
          <div className="rounded-lg border border-border bg-panel-2/30 px-4 py-3">
            <div className="text-[13px] font-medium">why is the tailer dropping frames?</div>
            <div className="mt-1 text-[12px] text-muted">Needs you — the repro needs a decision on sampling</div>
          </div>
        </div>
      </main>
    </div>
  )
}

// ── frames ────────────────────────────────────────────────────────────────────────────────────────
function FocusFrame({ file, collapsed, contextChip }: { file?: boolean; collapsed?: boolean; contextChip?: boolean }) {
  return (
    <div className="flex h-full bg-bg">
      {/* the sidebar's ghost: a 12px hot edge; hovering or ← Board slides it back over */}
      <div className="group relative h-full w-3 shrink-0 border-r border-border/40 bg-bg hover:bg-panel-2/40" title="Board">
        <ChevronRight size={11} className="absolute left-0.5 top-1/2 -translate-y-1/2 rotate-180 text-muted-40" />
      </div>
      <ThreadColumn narrow={file} contextChip={contextChip} />
      <MetaRail collapsed={collapsed} fileOpen={file ? "resolver" : undefined} />
      {file && <FileColumn selection={contextChip} />}
    </div>
  )
}

const SCREENS: [string, string, () => ReactNode][] = [
  ["board", "Today's board — the running row is the click target", () => <BoardFrame />],
  ["focus", "Focus: sidebar slid off, thread left-aligned, the operational rail beside it", () => <FocusFrame />],
  ["focus-file", "A file clicked in the rail opens the viewer as a third column", () => <FocusFrame file />],
  ["focus-context", "A selection in the viewer pulled into the composer as ⌘I context", () => <FocusFrame file contextChip />],
  ["focus-collapsed", "Width variant: the rail folds to an icon strip while the viewer is open", () => <FocusFrame file collapsed />],
]

function Gallery() {
  const shown = only ? SCREENS.filter(([key]) => key === only) : SCREENS
  if (only && shown.length === 1) return <div className="h-dvh w-screen overflow-hidden text-sm text-fg">{shown[0][2]()}</div>
  return (
    <div className="min-h-dvh bg-bg px-8 py-8 text-sm text-fg">
      <h1 className="text-[15px] font-medium">Focus mode — mockups</h1>
      <p className="mt-1 max-w-[720px] text-[12px] text-muted">Clicking a RUNNING thread slides the sidebar off and gives the thread the page, with an operational rail (sub-agents · shells · edited files · watches) beside it. Files open as a third column; selections pull into the composer as ⌘I context. <span className="font-mono-keep">?screen=&lt;key&gt;</span> renders one frame at 1:1.</p>
      <div className="mt-6 space-y-10">
        {shown.map(([key, caption, render]) => (
          <figure key={key}>
            <figcaption className="mb-2 text-[12px] text-muted"><span className="font-mono-keep text-fg/70">{key}</span> — {caption}</figcaption>
            <div className="overflow-hidden rounded-lg border border-border/60" style={{ width: 1680 * 0.78, height: 960 * 0.78 }}>
              <div style={{ width: 1680, height: 960, transform: "scale(0.78)", transformOrigin: "top left" }}>{render()}</div>
            </div>
          </figure>
        ))}
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Gallery />)
