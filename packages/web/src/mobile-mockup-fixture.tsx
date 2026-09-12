// FRIZZ ON A PHONE — the whole product, mocked up for a 390pt viewport.
//
// Not a test and not shipped UI: a DESIGN SURFACE, in the shape `awaiting-mockups-fixture.tsx`
// established. Every screen renders in the app's REAL stylesheet on the app's REAL tokens, so a choice
// made here is a choice about the thing that would ship.
//
//   nubx vite --port 5477 --strictPort          (from packages/web)
//   http://localhost:5477/mobile-mockup-fixture.html                — the gallery, every screen
//                                              ?screen=board        — one screen, alone, at 1:1
//                                              ?font=mono           — the other font setting
//
// ── What is being designed ────────────────────────────────────────────────────────────────────────
// The desktop app is three standing surfaces at once: a project rail, a thread rail, and a workpane,
// with threads opening as right-hand drawers that stack. None of that survives 390pt. The phone gets
// the same INFORMATION MODEL — Rested / Active / Snoozed / Done, the accent meaning "awaiting you", the
// checkbox status family — expressed as a two-level drill-down where every drawer becomes a sheet at a
// detent, every rail row becomes a full-width list row, and the four bands become four tabs.
//
// THIS IS A WEBSITE, not an app-store submission (maintainer 2026-08-17: "This is a freaking website
// that people go to, not a mobile app at this point"). So there is no push notification, no lock
// screen and no install flow here: everything drawn is something a browser tab can do today.
//
// ── The rulings, and who made them ────────────────────────────────────────────────────────────────
// Round 2 rewrote most of round 1 against the maintainer's review. Each of these is theirs:
//
//   1. NO PROMPT BOX ON THE BOARD. A docked composer for a NEW thread is not the same kind of thing as
//      a reply box, and the liveness indicator round 1 parked above it belonged to a running thread,
//      not over a control that starts one. Creating a thread is the floating + in the bottom right;
//      live work is drawn on the running thread's own row.
//   2. NO PROJECT SWITCHER. The board already has a way back to Projects; a switcher in the title as
//      well is two doors to one room.
//   3. NO YELLOW CARD FOR A QUESTION. The rail marks an ask with the accent "?" and nothing else —
//      "it's clean and it's consistent and it's subtle" — so that mark is all an asking row gets here.
//   4. FULL WIDTH, NOT CARDS. A card spends side margins AND its own padding on every row.
//   5. THE BANDS ARE TABS along the bottom, in a tab bar whose icons are the status family itself.
//   6. NO ANSWERING FROM THE LIST. You open the thread, read the context that produced the question,
//      and answer it there.
//
// Round 3, same reviewer, same day:
//
//   7. THE DOTS WERE ALL RIDING LOW — measured at 3.32px below the cap band, because a measurement
//      wrapper had turned each one into a flex item and killed its `self-baseline`. See CAP_ALIGN.
//   8. RESTED + ACTIVE ARE ONE TAB, called QUEUE: "something is active until it's marked done".
//   9. NOTHING HERE ANIMATES FOREVER, and that ended up going further than the tab bar. A RUNNING ROW
//      wears the static play mark too, not the rail's travelling spinner: now that Queue holds running
//      and rested rows as neighbours, the difference between them has to survive a glance at arm's
//      length, and a 1px arc crawling round a 18px box does not. Liveness is still moving on that row —
//      the activity line shimmers and the child-op dots pulse — it is just not carried by the mark.
//  10. ONE QUESTION AT A TIME, in a sheet that slides up from the bottom rather than a pushed page,
//      and the verb is "Continue" rather than "Send".
//  11. NO SEARCH. The web UI has none.
//  12. NO INVENTED STARTER PROMPTS on an empty board.
//
// Kept from round 1: every drawer is a sheet at a detent with the parent scaled back behind it; the
// accent is spent only on the ask and on one primary verb per screen (so nav actions are neutral); and
// iOS's 17/15/13/11.5 type scale with a 44pt touch floor rather than the desktop's 13px-everything.
//
// Screens, in `?screen=` order: home · board · board-held · thread · answer · actions · dispatch ·
// snooze · settings · subagent · empty · kit
import { createRoot } from "react-dom/client"
import type { ReactNode } from "react"
import {
  Archive, ArrowUpRight, Bell, Check, ChevronRight, Clock, Copy, Ellipsis, FileText, Github, Hourglass,
  Image as ImageIcon, Info, Paperclip, Pencil, Plus, RotateCcw, Settings as SettingsIcon, Sparkles,
  SquareTerminal, Timer, Type as TypeIcon, Wrench, X, Zap,
} from "lucide-react"
import {
  AskBox, Button, CAP_ALIGN, Canvas, Chip, ComposerDock, DoneBox, Fab, Group, GroupHeader,
  INK, Keyboard, LargeTitle, LiveDot, NavAction, NavBar, ON_CAP, Phone, PlayBox, Row, RowRule,
  Segmented, SheetHeader, SheetOver, StatusBox, TabBar, Toggle, capAlign,
} from "./mobile-mockup-kit.tsx"
import "./styles.css"

const params = new URLSearchParams(location.search)
// THIS APP RENDERS IN TWO FONTS and a fixture that sets neither silently takes the MONO default —
// which is how a glyph measured at a 0.00px residual once rode visibly high in the maintainer's sans
// window. Sans is the shipped default, so it is this fixture's default too.
document.documentElement.dataset.font = params.get("font") === "mono" ? "mono" : "sans"
const only = params.get("screen")?.toLowerCase() ?? null

// ══ shared pieces ═══════════════════════════════════════════════════════════════════════════════

/** A project's square mark — the rail's own square, at the sizes a phone needs. */
function ProjectSquare({ label, tint, size = 44 }: { label: string; tint: string; size?: number }) {
  return (
    <span
      className={`flex shrink-0 items-center justify-center font-semibold ${tint}`}
      style={{ width: size, height: size, borderRadius: Math.round(size * 0.28), fontSize: Math.round(size * 0.42) }}
    >
      {label}
    </span>
  )
}

/**
 * The provider mark that trails a thread title on every surface in the app.
 *
 * The left margin is not decoration: the mark carries no whitespace of its own, so without one it reads
 * as a colour bleeding out of the title's last letter. See TitleWithMark for the other half of the
 * problem — where the line is allowed to break.
 */
function ProviderMark({ kind }: { kind: "claude" | "codex" }) {
  return (
    <span
      aria-hidden
      className={`${ON_CAP} ml-1.5 inline-block size-[8px] rounded-[2px] ${kind === "claude" ? "bg-[#d97757]" : "bg-muted/60"}`}
    />
  )
}

/**
 * A title with its provider mark glued to the last word.
 *
 * The mark is an ATOMIC inline box and the line breaker is free to break right before it even though no
 * whitespace separates the two — which strands the mark alone on a second line under a wrapping title.
 * The desktop rail solved this exact bug the same way (Sidebar's TitleWithTrailers); a phone's title
 * column hits it far more often.
 */
function TitleWithMark({ title, provider }: { title: string; provider?: "claude" | "codex" }) {
  if (!provider) return <>{title}</>
  const cut = title.lastIndexOf(" ")
  const head = cut === -1 ? "" : title.slice(0, cut + 1)
  const tail = cut === -1 ? title : title.slice(cut + 1)
  return (
    <>
      {head}
      <span className="whitespace-nowrap">
        {tail}
        <ProviderMark kind={provider} />
      </span>
    </>
  )
}

/**
 * A THREAD ROW — the phone's unit of board information, and what a rail row becomes.
 *
 * Full width, hairline-separated, no card. The anatomy is the rail's: the status glyph keeps its own
 * column so the marks read as a stripe down the list, the title wraps rather than truncating (the
 * rail's own rule), and the rest time is a right-justified column, because a title's length must not
 * decide where its timestamp sits. An asking thread is marked by the accent "?" in that glyph column
 * and by NOTHING else — no border, no tint, no rail.
 *
 * The separator is drawn by the row so it can be INSET to the text column (16 + 18 + 12 = 46), which is
 * what tells the eye the glyph column is a gutter rather than the first cell of a table.
 */
function ThreadRow({
  glyph,
  title,
  provider,
  age,
  gloss,
  activity,
  children,
  dim,
  last,
}: {
  glyph: ReactNode
  title: string
  provider?: "claude" | "codex"
  age?: string
  gloss?: ReactNode
  activity?: ReactNode
  children?: ReactNode
  dim?: boolean
  last?: boolean
}) {
  return (
    <div className={dim ? "opacity-60" : ""}>
      <div className="flex items-start gap-3 px-4 pb-2.5 pt-2.5">
        <span data-ink="row-glyph" className="flex h-[21px] shrink-0 items-center justify-center">{glyph}</span>
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <div className="flex min-w-0 items-baseline gap-3">
            <span data-ink="row-title" className="min-w-0 flex-1 text-[15px] font-medium leading-[21px] tracking-[-0.01em] text-fg">
              <TitleWithMark title={title} provider={provider} />
            </span>
            {age ? <span className="shrink-0 text-[11.5px] leading-[21px] tabular-nums text-muted-60">{age}</span> : null}
          </div>
          {gloss ? <span className="min-w-0 truncate text-[13px] leading-[18px] text-muted">{gloss}</span> : null}
          {activity ? <span className="min-w-0 truncate text-[13px] leading-[18px] text-muted-85">{activity}</span> : null}
        </div>
      </div>
      {children}
      {last ? null : <div className="ml-[46px] h-px bg-border/70" />}
    </div>
  )
}

/**
 * An indented child-op row — the rail's ⤷ line.
 *
 * THIS is where a liveness dot belongs: under the thread that owns the work, never over a control that
 * starts a new one.
 */
function ChildOp({ kind, label, elapsed }: { kind: "agent" | "shell"; label: string; elapsed: string }) {
  return (
    <div className="flex items-baseline gap-2 pb-1.5 pl-[46px] pr-4">
      <LiveDot kind={kind} ink="op-dot" />
      <span data-ink="op-label" className="min-w-0 flex-1 truncate text-[12.5px] leading-[19px] text-muted">{label}</span>
      <span className="shrink-0 text-[11.5px] leading-[19px] tabular-nums text-muted-55">{elapsed}</span>
    </div>
  )
}

// ══ 1 · home ════════════════════════════════════════════════════════════════════════════════════
// EVERY PROJECT ON THE MACHINE, and what each of them wants from you. The desktop grid shows a name, a
// path and a last-opened date, because opening forty databases to draw forty cards is exactly what lazy
// activation exists to avoid. A phone is the surface you check away from your desk, so the one thing
// worth paying for is the answer to "does anything need me": a per-board state summary, and the accent
// count of asks. Sorted by that count, so the answer is the top of the screen.
const PROJECTS = [
  { slug: "nub", label: "nubjs/nub", tint: "bg-[#e8b923] text-bg", initial: "N", path: "~/code/nub", asks: 2, active: 2, snoozed: 1, when: "now" },
  { slug: "zod", label: "colinhacks/zod", tint: "bg-[#4a9eff] text-bg", initial: "Z", path: "~/code/zod", asks: 1, active: 0, snoozed: 2, when: "2h" },
  { slug: "frizz", label: "colinhacks/frizz", tint: "bg-[#b47feb] text-bg", initial: "F", path: "~/Documents/projects/frizz", asks: 0, active: 3, snoozed: 0, when: "12m" },
  { slug: "acme-app", label: "acme/app", tint: "bg-[#4ac97e] text-bg", initial: "A", path: "~/work/acme/app", asks: 0, active: 0, snoozed: 1, when: "yesterday" },
  { slug: "pullfrog", label: "pullfrog/web", tint: "bg-[#6b7280] text-bg", initial: "P", path: "~/code/pullfrog", asks: 0, active: 0, snoozed: 0, when: "3d" },
  { slug: "sonner", label: "emilkowal/sonner", tint: "bg-[#33363c] text-fg", initial: "S", path: "~/code/sonner", asks: 0, active: 0, snoozed: 0, when: "1w" },
]

function ProjectRow({ p, last }: { p: (typeof PROJECTS)[number]; last?: boolean }) {
  const quiet = p.asks === 0 && p.active === 0 && p.snoozed === 0
  return (
    <div>
      <div className="flex items-center gap-3 py-2.5 pl-4 pr-3">
        <ProjectSquare label={p.initial} tint={p.tint} />
        <div className="flex min-w-0 flex-1 flex-col gap-[3px]">
          <span className="truncate text-[16px] font-medium leading-[21px] tracking-[-0.01em] text-fg">{p.label}</span>
          {quiet ? (
            <span className="truncate font-mono-keep text-[12.5px] leading-[16px] text-muted-70">{p.path}</span>
          ) : (
            <span className="flex min-w-0 items-baseline gap-2.5 text-[12.5px] leading-[16px] text-muted">
              {p.active > 0 && (
                <span className="flex shrink-0 items-baseline gap-1.5">
                  <LiveDot kind="agent" ink="meta-dot" />
                  <span data-ink="meta-active">{p.active} active</span>
                </span>
              )}
              {p.snoozed > 0 && (
                <span className="flex shrink-0 items-baseline gap-1.5">
                  <Hourglass data-ink="meta-glass" size={11} style={capAlign(11)} className={`${CAP_ALIGN} ${INK.hourglass} text-muted-70`} />
                  <span data-ink="meta-snoozed">{p.snoozed} snoozed</span>
                </span>
              )}
              <span className="min-w-0 truncate text-muted-55">{p.when}</span>
            </span>
          )}
        </div>
        {p.asks > 0 ? (
          <span className="flex h-[22px] min-w-[22px] shrink-0 items-center justify-center rounded-full bg-accent px-1.5 text-[12.5px] font-semibold text-bg">
            {p.asks}
          </span>
        ) : null}
        <ChevronRight size={17} className="shrink-0 text-muted-45" />
      </div>
      {last ? null : <div className="ml-[72px] h-px bg-border/70" />}
    </div>
  )
}

function HomeScreen() {
  return (
    <Canvas>
      {/* At the top of the scroll the nav bar carries no inline title — the large title below IS the
          title. Scrolled, the two swap. */}
      {/* NO SEARCH. The web UI has none, and a mockup that invents one is designing a feature rather
          than a phone layout for the product that exists. */}
      <NavBar border={false} trailing={<NavAction label="Settings"><SettingsIcon size={20} /></NavAction>} />
      <div className="min-h-0 flex-1 overflow-hidden pb-[34px]">
        <LargeTitle>Projects</LargeTitle>

        <GroupHeader trailing="3 asks">Needs you</GroupHeader>
        <Group>
          <ProjectRow p={PROJECTS[0]} />
          <ProjectRow p={PROJECTS[1]} last />
        </Group>

        <GroupHeader>All projects</GroupHeader>
        <Group>
          {PROJECTS.slice(2).map((p, i, all) => (
            <ProjectRow key={p.slug} p={p} last={i === all.length - 1} />
          ))}
        </Group>

        <div className="px-4 pt-4">
          {/* Dashed and never filled: an affordance, not a project — the desktop grid's own ruling. */}
          <button className="flex h-[48px] w-full items-center justify-center gap-2 rounded-[12px] border border-dashed border-border-strong text-[15px] text-muted active:border-accent active:text-fg">
            <Plus size={17} style={capAlign(17)} className={CAP_ALIGN} />
            Add a project
          </button>
        </div>
      </div>
    </Canvas>
  )
}

// ══ 2–4 · the board ═════════════════════════════════════════════════════════════════════════════
// THE PROJECT PAGE, as a tab view. The bands are the app's own, in the app's own words: Rested (the
// cue) → Active (spinning, and nothing else) → Snoozed → Done. On a phone they are four tabs rather than
// four stacked sections, so the band you are reading gets the whole screen instead of a quarter of it.
//
// The tab bar's icons ARE the status family, which makes it the legend for the list above it. The +
// starts a thread. Nothing on this screen is a composer.

const TAB_ICON = 21

/**
 * THREE TABS, NOT FOUR — Rested and Active are one band called QUEUE (maintainer 2026-08-17: "perhaps
 * we should just unify rested and active into one tab… something is active until it's marked done. I
 * know that's a bit of a redefinition of the word active, but still, I think it makes sense").
 *
 * It is a redefinition, and it is the right one for this surface. On the desktop the Rested/Active
 * split answers "which of these is spinning right now", which matters when forty rows are in front of
 * you and you are choosing where to look. On a phone you are looking at one screen with a handful of
 * rows, and the split costs you a tab switch to see work you already own. What survives the merge is
 * the ROW's own state — its mark, its activity line and its live children — so nothing is lost except
 * the partition itself.
 *
 * The Queue's tab icon is a STATIC PLAY, never the running spinner: a tab bar is permanent chrome, and
 * permanent motion in the corner of the eye is noise.
 */
function boardTabs() {
  return [
    // The badge is the ASK count in accent when there is one, and the band count in muted otherwise —
    // see the note on TabBar. Yellow here always means "this many want you".
    { id: "queue", label: "Queue", icon: <PlayBox size={TAB_ICON} />, count: 3, asks: true },
    { id: "snoozed", label: "Snoozed", icon: <StatusBox size={TAB_ICON}><Hourglass size={13} className="text-muted-75" /></StatusBox>, count: 2 },
    { id: "done", label: "Done", icon: <DoneBox size={TAB_ICON} />, count: 6 },
  ]
}

function BoardTopBar() {
  return (
    <NavBar
      back="Projects"
      // No switcher. The way to another project is the way you came (maintainer 2026-08-17: "Kind of
      // weird to have that and the projects, like the ability to go back to a project… I think we
      // should probably just drop the switcher").
      title={
        <span className="flex items-center gap-1.5">
          <ProjectSquare label="N" tint="bg-[#e8b923] text-bg" size={17} />
          <span className="font-mono-keep text-[15px]">nubjs/nub</span>
        </span>
      }
      trailing={<NavAction label="Board actions"><Ellipsis size={20} /></NavAction>}
    />
  )
}

/**
 * A row mid-swipe.
 *
 * Full-width rows are what make this read right: the row slides under the SCREEN edge, exactly as a
 * Mail cell does, instead of sliding out of a floating card and looking broken. A swipe caught in a
 * still always cuts a word in half — that is the gesture, not a rendering fault.
 */
function SwipedRow() {
  return (
    <div className="relative overflow-hidden">
      <div className="absolute inset-y-0 right-0 flex">
        <div className="flex w-[76px] flex-col items-center justify-center gap-1 bg-elevated text-muted">
          <Clock size={19} />
          <span className="text-[11.5px]">Snooze</span>
        </div>
        <div className="flex w-[76px] flex-col items-center justify-center gap-1 bg-live/85 text-bg">
          <Check size={19} strokeWidth={2.6} />
          <span className="text-[11.5px] font-medium">Done</span>
        </div>
      </div>
      <div className="relative -translate-x-[152px]">
        <ThreadRow
          glyph={<StatusBox />}
          title="Rewrite the release notes for 0.4"
          provider="codex"
          age="3d"
          gloss="Rested — nothing running"
        />
      </div>
    </div>
  )
}

function BoardShell({ tab, children }: { tab: string; children: ReactNode }) {
  return (
    <Canvas>
      <BoardTopBar />
      {/* 83pt of tab bar + safe area, and the + floats clear of both. */}
      <div className="min-h-0 flex-1 overflow-hidden pb-[83px]">{children}</div>
      <Fab />
      <TabBar tabs={boardTabs()} active={tab} />
    </Canvas>
  )
}

/**
 * THE QUEUE — everything that is neither held nor done, in one list.
 *
 * ORDERED BY WHAT IT WANTS FROM YOU: the threads asking a question first, then the ones running, then
 * the ones at rest. The desktop rail orders the cue by rest time, which is right for a column you scan
 * with a mouse beside a workpane; on the one screen a phone has, "what needs me" earns the top.
 *
 * Three marks, one family, and the row is the only place any of them animates: accent "?" asks,
 * spinner runs, empty box rests. A running row shows what it is doing and its live children instead of
 * a rest time — a thread that is still going has not made a handoff, so it has nothing to date.
 */
function BoardQueueScreen() {
  return (
    <BoardShell tab="queue">
      <Group className="border-t-0">
        <ThreadRow
          glyph={<AskBox />}
          title="Fix the cache collision in the resolver"
          provider="claude"
          age="4m"
          gloss="Should the settings store use SQLite or a JSON file?"
        />
        <ThreadRow
          glyph={<AskBox />}
          title="Pick the retry policy for the socket reconnect"
          provider="codex"
          age="5h"
          gloss="Two options, both reversible"
        />
        <ThreadRow
          glyph={<AskBox />}
          title="Decide what a restart does to a live turn"
          provider="claude"
          age="3d"
          gloss="Needs a call before the next release"
        />
        <ThreadRow
          glyph={<PlayBox />}
          title="Migrate the board store to valtio 2"
          provider="claude"
          activity={<span className="shimmer-text">Running the focused tests</span>}
        >
          <div className="flex flex-col">
            <ChildOp kind="agent" label="Audit the parser for edge cases" elapsed="2m" />
            <ChildOp kind="shell" label="gh run watch 1842" elapsed="4m" />
          </div>
        </ThreadRow>
        <ThreadRow
          glyph={<PlayBox />}
          title="Draft the changelog for 0.4"
          provider="codex"
          activity={<span className="shimmer-text">Reading packages/server/src/router.ts</span>}
        >
          <div className="flex flex-col">
            <ChildOp kind="shell" label="vite dev --host" elapsed="18m" />
          </div>
        </ThreadRow>
        <ThreadRow
          glyph={<PlayBox />}
          title="Chase the socket reconnect flake"
          provider="claude"
          activity={<span className="shimmer-text">Inspecting the broker handshake</span>}
        />
        <SwipedRow />
        <ThreadRow
          glyph={<StatusBox />}
          title="Audit the parser for edge cases"
          provider="claude"
          age="1h"
          gloss="Waiting on your call about the tokenizer"
        />
        <ThreadRow
          glyph={<StatusBox />}
          title="Port the v2 drivers to the new host API"
          provider="claude"
          age="2d"
          gloss="Rested — nothing running"
        />
        <ThreadRow
          glyph={<StatusBox />}
          title="Compress the board payload on the wire"
          provider="claude"
          age="2d"
          gloss="780KB → 137KB, landed on main"
        />
        <ThreadRow
          glyph={<StatusBox />}
          title="Pin the batch-local result memo"
          provider="codex"
          age="4d"
          gloss="Rested — nothing running"
          last
        />
      </Group>
    </BoardShell>
  )
}

/** Snoozed — dimmed, and every row says what it is waiting for. */
function BoardHeldScreen() {
  return (
    <BoardShell tab="snoozed">
      <Group className="border-t-0">
        <ThreadRow
          dim
          glyph={<StatusBox><Hourglass size={11} className="text-muted-75" /></StatusBox>}
          title="Land the tenant routing fix"
          provider="claude"
          age="2h"
          gloss={
            <span className="flex items-baseline gap-1.5">
              <LiveDot kind="github" quiet />
              Waiting on acme/app#391 — checks running
            </span>
          }
        />
        <ThreadRow
          dim
          glyph={<StatusBox><Timer size={11} className="text-muted-75" /></StatusBox>}
          title="Retry the flaky socket test"
          provider="claude"
          age="20m"
          gloss="Wakes at 5:00 PM"
          last
        />
      </Group>
    </BoardShell>
  )
}

// ══ 5 · thread ══════════════════════════════════════════════════════════════════════════════════
// THE TRANSCRIPT, full screen — and the only place a composer belongs, because here there is a
// conversation to add to. Everything the desktop draws in a stacked right-hand drawer, in the one place
// a phone has.

/** A tool call, at reading density: the glyph, the target, the elapsed, and a chevron that expands it. */
function ToolCard({ icon, label, detail, elapsed }: { icon: ReactNode; label: string; detail?: string; elapsed?: string }) {
  return (
    <div className="flex items-center gap-2.5 rounded-[10px] border border-border/70 bg-panel px-3 py-2.5">
      <span className="shrink-0 text-muted-70">{icon}</span>
      <span className="min-w-0 flex-1 truncate font-mono-keep text-[12.5px] leading-[17px] text-fg/80">
        {label}
        {detail ? <span className="text-muted-70"> {detail}</span> : null}
      </span>
      {elapsed ? <span className="shrink-0 text-[11.5px] tabular-nums text-muted-55">{elapsed}</span> : null}
      <ChevronRight size={15} className="shrink-0 text-muted-45" />
    </div>
  )
}

function ThreadScreen() {
  return (
    <Canvas>
      <NavBar
        back="Board"
        title="Fix the cache collision"
        subtitle="rested 4m · opus · high"
        trailing={<NavAction label="Thread actions"><Ellipsis size={20} /></NavAction>}
      />
      <div className="min-h-0 flex-1 overflow-hidden px-4 pb-[104px] pt-4">
        <div className="flex flex-col gap-3.5">
          {/* The human's own words, in the app's user-bubble fill. Right-INSET rather than
              right-aligned: a full-width bubble would read as a system banner. */}
          <div className="self-end rounded-[16px] rounded-br-[6px] bg-user-bubble px-3.5 py-2.5 text-[15px] leading-[21px] text-bg" style={{ maxWidth: "78%" }}>
            the resolver keys on the raw id — fix it and pin it with a test
          </div>

          <p className="m-0 text-[15px] leading-[22px] text-fg/90">
            The lookup builds its key from the raw id, so two ids that normalize to the same value share
            a cache entry. I will key on the normalized id and pin it with a test at the resolver level.
          </p>

          <div className="flex flex-col gap-1.5">
            <ToolCard icon={<FileText size={14} />} label="src/resolver.ts" detail="· 214 lines" elapsed="0.2s" />
            <ToolCard icon={<Pencil size={14} />} label="src/resolver.ts" detail="+7 −3" elapsed="0.4s" />
            <ToolCard icon={<SquareTerminal size={14} />} label="nub --test packages/server" elapsed="8.1s" />
          </div>

          {/* THE ASK, in the one place it is answerable: inside the thread, under the context that
              produced it (maintainer 2026-08-17: "you should just be clicking into the thread in order
              to review the rest of the message and the full context, and then answer the questions that
              way"). The card wears the app's ordinary chrome — the "?" carries the state, not a colour. */}
          <div className="rounded-[12px] border border-border-strong bg-panel p-3.5">
            <div className="flex items-baseline gap-2">
              <span className={CAP_ALIGN} style={capAlign(15)}><AskBox size={15} /></span>
              <span className="text-[11.5px] font-semibold uppercase tracking-[0.06em] text-muted">Question</span>
            </div>
            <p className="m-0 mt-2 text-[15px] leading-[21px] text-fg">
              Should the settings store use SQLite or a JSON file?
            </p>
            <p className="m-0 mt-1 text-[13px] leading-[18px] text-muted">And one more after this one.</p>
            <div className="mt-3 flex items-center gap-2">
              <Button kind="accent" size="sm">Answer</Button>
              <Button kind="tinted" size="sm">Ask something back</Button>
            </div>
          </div>

          <div className="flex items-center gap-3 py-1">
            <span className="h-px flex-1 bg-border/60" />
            <span className="shrink-0 text-[11.5px] text-muted-60">rested 4m</span>
            <span className="h-px flex-1 bg-border/60" />
          </div>
        </div>
      </div>
      <ComposerDock />
    </Canvas>
  )
}

// ══ 6 · answer ══════════════════════════════════════════════════════════════════════════════════
// ANSWERING — ONE QUESTION AT A TIME, IN A SHEET THAT SLIDES UP FROM THE BOTTOM.
//
// Round 2 got this wrong in a way that was worth being called out for (maintainer 2026-08-17): the
// thread showed a single question card with its own Answer button, and tapping it pushed a PAGE
// rendering every question at once with one "Send" at the bottom. Two contradictory promises — a
// per-question button that submits nothing, and a batch page you never asked for.
//
// So: one question per view, and the view is a MODAL rather than a page, because that is what it is —
// a thing you deal with and dismiss, not a place you navigate to. It slides up, the thread stays
// visible and receded behind it, and a flick down abandons it.
//
// THE VERB IS "CONTINUE", NOT "SEND". With one question in front of you, "Send" would claim the whole
// ask went back when only this answer did; Continue says what actually happens — this answer is kept
// and the next question comes up. The LAST question is the only one that submits, and only that one
// says so.

function OptionRow({
  letter,
  label,
  why,
  chosen,
  rec,
}: {
  letter: string
  label: string
  why: string
  chosen?: boolean
  rec?: boolean
}) {
  return (
    <button className={`flex min-h-[56px] w-full items-start gap-3 px-4 py-3 text-left ${chosen ? "bg-accent/[0.09]" : ""}`}>
      <span
        className={`mt-[1px] flex size-[20px] shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${
          chosen ? "border-accent bg-accent text-bg" : "border-border-strong text-muted"
        }`}
      >
        {chosen ? <Check size={13} strokeWidth={3} /> : letter}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[15px] font-medium leading-[20px] text-fg">
          {label}
          {rec ? <span className="ml-1.5 text-[12px] font-normal text-accent">recommended</span> : null}
        </span>
        <span className="text-[13px] leading-[17px] text-muted">{why}</span>
      </span>
    </button>
  )
}

function AnswerScreen() {
  return (
    <Canvas>
      <SheetOver detent={0.6} behind={<ThreadScreen />}>
        <SheetHeader
          title="Question 1 of 2"
          leading={<button className="px-2 text-[16px] text-fg/85">Cancel</button>}
        />
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="px-4 pb-3 pt-3.5">
            <p className="m-0 text-[17px] leading-[23px] text-fg">
              Should the settings store use SQLite or a JSON file?
            </p>
          </div>
          <Group>
            <OptionRow
              letter="A"
              label="SQLite"
              why="Transactional, and it matches how sessions are already stored"
              chosen
              rec
            />
            <div className="ml-4 h-px bg-border/70" />
            <OptionRow letter="B" label="JSON file" why="Zero deps and human-editable, but racy under concurrent writes" />
            <div className="ml-4 h-px bg-border/70" />
            <OptionRow letter="C" label="Something else" why="Type your own answer" />
          </Group>

          {/* The progress the header states, drawn — two questions, the first one live. It rides with
              the button rather than under the options, so the pair reads as one footer. */}
          <div className="mt-auto flex flex-col items-center gap-3 border-t border-border/70 px-4 pb-[30px] pt-3">
            <div className="flex items-center gap-1.5">
              <span className="size-[6px] rounded-full bg-accent" />
              <span className="size-[6px] rounded-full bg-muted/35" />
            </div>
            <Button kind="accent" size="lg" full>Continue</Button>
          </div>
        </div>
      </SheetOver>
    </Canvas>
  )
}

// ══ 7 · actions ═════════════════════════════════════════════════════════════════════════════════
// THE THREAD-ACTIONS SHEET, over a receded board. Everything the desktop scatters across a row hover, a
// header cluster and a footer, in one list at the bottom of the screen where the thumb is.

function ActionsScreen() {
  return (
    <Canvas>
      <SheetOver detent={0.68} behind={<BoardQueueScreen />}>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden pt-2">
          <div className="flex items-start gap-3 px-4 pb-3 pt-1">
            <span className="pt-[2px]"><AskBox /></span>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[16px] font-semibold tracking-[-0.01em] text-fg">
                Fix the cache collision in the resolver
              </span>
              <span className="truncate text-[12.5px] text-muted">Rested 4m · claude · opus · high</span>
            </div>
          </div>

          <div className="flex flex-col gap-4 overflow-hidden pb-[34px]">
            <Group>
              <Row icon={<Check size={16} className="text-live" />} label="Mark as done" />
              <RowRule inset={53} />
              <Row icon={<Clock size={16} className="text-muted" />} label="Snooze…" value="until 5:00 PM" chevron />
              <RowRule inset={53} />
              <Row icon={<RotateCcw size={16} className="text-muted" />} label="Retry this session" detail="Resume where it left off" />
            </Group>

            <Group>
              <Row icon={<Pencil size={16} className="text-muted" />} label="Rename thread" />
              <RowRule inset={53} />
              <Row icon={<Copy size={16} className="text-muted" />} label="Copy resume command" detail="Open this session in your own terminal" />
              <RowRule inset={53} />
              <Row icon={<FileText size={16} className="text-muted" />} label="Frizz document" chevron />
              <RowRule inset={53} />
              <Row icon={<ArrowUpRight size={16} className="text-muted" />} label="Open full page" chevron />
            </Group>

            <Group>
              <Row icon={<Archive size={16} className="text-danger" />} label="Archive thread" tone="text-danger-soft" />
            </Group>
          </div>
        </div>
      </SheetOver>
    </Canvas>
  )
}

// ══ 8 · dispatch ════════════════════════════════════════════════════════════════════════════════
// NEW THREAD, WITH THE KEYBOARD UP — the only honest way to draw a composer. The + opens this: a real
// writing surface with the dispatch controls under it, in the 553 points that survive once the keyboard
// is showing. Everything below that line has to be reached by scrolling the form, so nothing lives
// there that you need WHILE typing; what you do need mid-sentence rides the accessory bar.
//
// The verb is SUBMIT (maintainer 2026-08-17). "Dispatch" is what the system does with the thread;
// "Submit" is what the person at the keyboard is doing.

function DispatchScreen() {
  return (
    <Canvas>
      <NavBar
        title="New thread"
        subtitle="nubjs/nub"
        leading={<button className="px-2 text-[17px] text-fg/85">Cancel</button>}
        trailing={<button className="px-2 text-[17px] font-semibold text-accent">Submit</button>}
      />
      <div className="min-h-0 flex-1 overflow-hidden pb-[347px]">
        <div className="px-4 pb-1 pt-4">
          <p className="m-0 text-[17px] leading-[23px] text-fg">
            Port the v2 drivers to the new host API, then land it on main.
            <span className="ml-[1px] inline-block h-[19px] w-[2px] translate-y-[3px] bg-accent" />
          </p>
        </div>

        <GroupHeader>Worker</GroupHeader>
        <Group>
          <Row
            icon={<span className="size-[13px] rounded-[3px] bg-[#d97757]" />}
            iconTint="bg-[#d97757]/15"
            label="Agent"
            value="Claude"
            chevron
          />
          <RowRule inset={57} />
          <Row icon={<Sparkles size={15} className="text-fg" />} iconTint="bg-[#b47feb]/20" label="Model" value="Opus 5" chevron />
          <RowRule inset={57} />
          {/* EFFORT IS FIVE CELLS, so it takes its own full-width row rather than sharing one with its
              label — squeezed beside "Effort" the segmented control had 37pt per cell and "xhigh" had to
              be dropped, which quietly misrepresents what the product offers. */}
          <div className="flex flex-col gap-2 px-4 py-2.5">
            <div className="flex items-center gap-3">
              <span className="flex size-[29px] shrink-0 items-center justify-center rounded-[7px] bg-[#e8b923]/18">
                <Zap size={15} className="text-accent" />
              </span>
              <span className="text-[16px] tracking-[-0.01em] text-fg">Effort</span>
            </div>
            <Segmented options={["low", "med", "high", "xhigh", "max"]} value="high" />
          </div>
          <RowRule inset={57} />
          <Row icon={<Wrench size={15} className="text-fg" />} iconTint="bg-[#4a9eff]/18" label="Permissions" value="Ask" chevron />
        </Group>

        <GroupHeader>Context</GroupHeader>
        <Group>
          <Row icon={<Github size={15} className="text-fg" />} iconTint="bg-elevated" label="From a GitHub issue or PR" chevron />
          <RowRule inset={57} />
          <Row icon={<FileText size={15} className="text-fg" />} iconTint="bg-elevated" label="From a plan" value="none" chevron />
          <RowRule inset={57} />
          <Row
            icon={<SquareTerminal size={15} className="text-fg" />}
            iconTint="bg-elevated"
            label="Run in a worktree"
            detail="An isolated branch, merged when it lands"
            trailing={<Toggle on />}
          />
        </Group>
      </div>

      <Keyboard
        accessory={
          <div className="flex h-[48px] items-center gap-1 border-t border-border/70 bg-panel-2/95 px-2 backdrop-blur-xl">
            <NavAction label="Attach a file" tone="text-muted"><Paperclip size={19} /></NavAction>
            <NavAction label="Attach an image" tone="text-muted"><ImageIcon size={19} /></NavAction>
            <div className="ml-auto flex items-center gap-1.5 pr-1">
              <Chip tone="text-fg/80">opus · high</Chip>
              <Chip>ask</Chip>
            </div>
          </div>
        }
      />
    </Canvas>
  )
}

// ══ 9 · snooze ══════════════════════════════════════════════════════════════════════════════════
// A SMALL-DETENT SHEET, and the argument for detents at all: this is a five-second decision, so it takes
// half the screen and leaves the board visible behind it. Every option resolves its own wall clock on
// the right — "this evening" is not an instruction the reader should have to convert.

function SnoozeScreen() {
  return (
    <Canvas>
      <SheetOver detent={0.5} behind={<BoardQueueScreen />}>
        {/* NO confirm button. Every row here IS the choice, so a Done would be a second tap that can
            only ever mean "yes, the thing I just tapped" — and a permanently-dim one, until then. */}
        <SheetHeader title="Snooze" leading={<button className="px-2 text-[16px] text-fg/85">Cancel</button>} />
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden pt-3">
          <Group>
            <Row icon={<Clock size={16} className="text-muted" />} label="In 30m" value="10:11 AM" />
            <RowRule inset={53} />
            <Row icon={<Clock size={16} className="text-muted" />} label="In 2h" value="11:41 AM" />
            <RowRule inset={53} />
            <Row icon={<Clock size={16} className="text-muted" />} label="This evening" value="6:00 PM" />
            <RowRule inset={53} />
            <Row icon={<Clock size={16} className="text-muted" />} label="Tomorrow morning" value="9:00 AM" />
          </Group>
          <Group>
            <Row icon={<Timer size={16} className="text-muted" />} label="Pick a date and time…" chevron />
          </Group>
          <p className="m-0 px-4 text-[12.5px] leading-[17px] text-muted-70">
            A snoozed thread moves to Snoozed and wakes itself at the time you pick. Nothing stops running.
          </p>
        </div>
      </SheetOver>
    </Canvas>
  )
}

// ══ 10 · settings ═══════════════════════════════════════════════════════════════════════════════
// THE SETTINGS DRAWER, as full-width rows. The desktop drawer is a scrolling form; this is the same
// content in the shape a phone reader already knows how to skim.

function SettingsScreen() {
  return (
    <Canvas>
      <NavBar
        title="Settings"
        leading={<span className="w-[44px]" />}
        trailing={<button className="px-2 text-[17px] font-semibold text-accent">Done</button>}
      />
      <div className="min-h-0 flex-1 overflow-hidden pb-[34px]">
        <GroupHeader>Appearance</GroupHeader>
        <Group>
          <div className="flex min-h-[48px] items-center gap-3 pl-4 pr-3.5">
            <span className="flex size-[29px] shrink-0 items-center justify-center rounded-[7px] bg-elevated">
              <TypeIcon size={15} className="text-fg" />
            </span>
            <span className="shrink-0 text-[16px] tracking-[-0.01em] text-fg">Font</span>
            <Segmented className="ml-auto w-[150px]" options={["Sans", "Mono"]} value="Sans" />
          </div>
          <RowRule inset={57} />
          <Row icon={<Sparkles size={15} className="text-fg" />} iconTint="bg-elevated" label="Compact rows" detail="One line per thread on the board" trailing={<Toggle />} />
        </Group>

        <GroupHeader>Dispatch defaults</GroupHeader>
        <Group>
          <Row icon={<Sparkles size={15} className="text-fg" />} iconTint="bg-elevated" label="Model" value="Opus 5" chevron />
          <RowRule inset={57} />
          <Row icon={<Zap size={15} className="text-fg" />} iconTint="bg-elevated" label="Effort" value="High" chevron />
          <RowRule inset={57} />
          <Row icon={<Wrench size={15} className="text-fg" />} iconTint="bg-elevated" label="Permissions" value="Ask" chevron />
        </Group>

        <GroupHeader>Alerts</GroupHeader>
        <Group>
          {/* BROWSER notifications, not push. This is a website, so what it can offer is the tab's own
              Notification permission and a title badge — there is no APNs and no lock screen here. */}
          <Row
            icon={<Bell size={15} className="text-fg" />}
            iconTint="bg-[#e8b923]/18"
            label="Alert me when a thread needs me"
            detail="Uses this browser's notifications"
            trailing={<Toggle on />}
          />
          <RowRule inset={57} />
          <Row icon={<Check size={15} className="text-fg" />} iconTint="bg-[#4ac97e]/18" label="Alert me when a thread finishes" trailing={<Toggle />} />
        </Group>

        <GroupHeader>Frizz</GroupHeader>
        <Group>
          <Row icon={<Info size={15} className="text-fg" />} iconTint="bg-elevated" label="Version" value="0.4.2" />
          <RowRule inset={57} />
          <Row icon={<RotateCcw size={15} className="text-fg" />} iconTint="bg-elevated" label="Update and restart" detail="Frizz keeps the previous version if the build fails" />
        </Group>
      </div>
    </Canvas>
  )
}

// ══ 11 · subagent ═══════════════════════════════════════════════════════════════════════════════
// THE DRILL-IN SHEET, at the large detent, over its parent thread. This is the phone's answer to the
// desktop's STACKED drawers: a sub-agent opened from a thread opens over it, so the parent stays
// visible above it and a flick down returns to exactly where you were.

function SubAgentScreen() {
  return (
    <Canvas>
      <SheetOver detent={0.9} scrim="bg-black/30" behind={<ThreadScreen />}>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex items-start gap-2.5 px-4 pb-3 pt-3">
            <span className="pt-[7px]"><LiveDot kind="agent" /></span>
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="text-[16px] font-semibold leading-[21px] tracking-[-0.01em] text-fg">
                Audit the parser for edge cases
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip tone="text-fg/80">frizz:opus-high</Chip>
                <Chip>running 2m 14s</Chip>
              </div>
            </div>
            <NavAction label="Close" tone="text-muted"><X size={19} /></NavAction>
          </div>
          <div className="h-px bg-border/70" />

          <div className="min-h-0 flex-1 overflow-hidden px-4 pb-[84px] pt-3.5">
            <div className="flex flex-col gap-3">
              <p className="m-0 text-[14.5px] leading-[21px] text-fg/85">
                Walking the fixture corpus first, then the fuzz seeds. Two candidates so far, both in the
                escape handling.
              </p>
              <div className="flex flex-col gap-1.5">
                <ToolCard icon={<FileText size={14} />} label="src/parse/escape.ts" elapsed="0.3s" />
                <ToolCard icon={<SquareTerminal size={14} />} label="nub --test parser --fuzz" elapsed="41s" />
              </div>
              <div className="rounded-[10px] border border-border/70 bg-bg px-3 py-2.5">
                <pre className="m-0 overflow-hidden font-mono-keep text-[11.5px] leading-[17px] text-muted">{`✓ 214 passing
✗ escape/trailing-backslash
  expected "a\\\\" · got "a\\"`}</pre>
              </div>
              <p className="m-0 text-[14.5px] leading-[21px] text-fg/85">
                The first one is real: a trailing backslash at the end of a quoted run is consumed as an
                escape and the closing quote is swallowed. The second is the fuzzer feeding an unpaired
                surrogate, which the parser is entitled to reject.
              </p>
              <div className="flex flex-col gap-1.5">
                <ToolCard icon={<FileText size={14} />} label="src/parse/lexer.ts" detail="· 88 lines" elapsed="0.2s" />
                <ToolCard icon={<Pencil size={14} />} label="test/escape.spec.ts" detail="+18 −0" elapsed="0.6s" />
              </div>
            </div>
          </div>

          <div className="absolute inset-x-0 bottom-0 border-t border-border/70 bg-panel/90 px-3 pb-[26px] pt-2.5 backdrop-blur-xl">
            <div className="flex items-center gap-2">
              <div className="flex h-[42px] min-w-0 flex-1 items-center rounded-[21px] border border-border-strong bg-bg px-3.5 text-[15px] text-muted-70">
                Steer this sub-agent…
              </div>
              <button aria-label="Stop" className="flex size-[42px] shrink-0 items-center justify-center rounded-full bg-elevated text-muted">
                <X size={18} />
              </button>
            </div>
          </div>
        </div>
      </SheetOver>
    </Canvas>
  )
}

// ══ 13 · empty ══════════════════════════════════════════════════════════════════════════════════
// A PROJECT WITH NOTHING IN IT. The desktop's first-run state centres the prompt box as the whole
// screen. Here the + is the way in, so the empty space carries the invitation instead — three starters,
// because the hard part of a fresh board is not the composer, it is knowing what to type into it.

function EmptyScreen() {
  return (
    <Canvas>
      <NavBar
        back="Projects"
        title={
          <span className="flex items-center gap-1.5">
            <ProjectSquare label="P" tint="bg-[#6b7280] text-bg" size={17} />
            <span className="font-mono-keep text-[15px]">pullfrog/web</span>
          </span>
        }
        trailing={<NavAction label="Board actions"><Ellipsis size={20} /></NavAction>}
      />
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-10 pb-[83px]">
        {/* THE RASTER ICON, not `/favicon.svg`. That file is one 58KB path — the mark's loose fibers as a
            single mega-geometry — and Chrome re-tessellates it on every raster: the screens that drew it
            could not complete a 390×844 headless screenshot in TEN MINUTES, while every screen without
            it shot in sixteen seconds. */}
        <img src="/apple-touch-icon.png" width={64} height={64} alt="" className="rounded-[15px] opacity-90" />
        <h2 className="m-0 mt-4 text-[19px] font-semibold tracking-[-0.015em] text-fg">No threads yet</h2>
        {/* One line, and no invented starter prompts. The + is the way in and it is already on screen;
            a list of tasks Frizz made up for you is not an empty state, it is a suggestion nobody
            asked for. */}
        <p className="m-0 mt-1.5 text-center text-[14px] leading-[20px] text-muted">
          Describe a task and Frizz dispatches a worker for it. Everything it does lands back here.
        </p>
      </div>
      <Fab />
      <TabBar
        tabs={[
          { id: "queue", label: "Queue", icon: <PlayBox size={TAB_ICON} />, count: 0 },
          { id: "snoozed", label: "Snoozed", icon: <StatusBox size={TAB_ICON}><Hourglass size={13} className="text-muted-75" /></StatusBox>, count: 0 },
          { id: "done", label: "Done", icon: <DoneBox size={TAB_ICON} />, count: 0 },
        ]}
        active="queue"
      />
    </Canvas>
  )
}

// ══ 15 · kit ════════════════════════════════════════════════════════════════════════════════════
// THE CONTROL VOCABULARY on one screen, so the pieces can be judged against each other rather than one
// at a time inside a layout.

function KitSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="px-1 text-[11.5px] font-semibold uppercase tracking-[0.07em] text-muted-70">{title}</span>
      {children}
    </div>
  )
}

function KitScreen() {
  return (
    <Canvas>
      <NavBar title="Controls" leading={<span className="w-[44px]" />} />
      <div className="min-h-0 flex-1 overflow-hidden px-4 pb-[34px] pt-3">
        <div className="flex flex-col gap-4">
          <KitSection title="Buttons">
            <div className="flex flex-col gap-2">
              <div className="flex gap-2">
                <Button kind="accent" className="flex-1">Send answer</Button>
                <Button kind="filled" className="flex-1">Mark as done</Button>
              </div>
              <div className="flex gap-2">
                <Button kind="tinted" className="flex-1">Snooze</Button>
                <Button kind="destructive" className="flex-1">Archive</Button>
              </div>
              <div className="flex items-center gap-2">
                <Button kind="plain" size="sm">Load earlier</Button>
                <Button kind="tinted" size="sm">Retry</Button>
                <Button kind="filled" size="sm">Submit</Button>
              </div>
            </div>
          </KitSection>

          <KitSection title="Segments and switches">
            <Segmented options={["low", "med", "high", "xhigh", "max"]} value="high" />
            <div className="flex items-center gap-3">
              <Toggle on />
              <Toggle />
              <Segmented className="flex-1" options={["Sans", "Mono"]} value="Sans" />
            </div>
          </KitSection>

          <KitSection title="Status marks">
            <div className="flex items-center gap-4 rounded-[12px] border border-border/70 bg-panel px-4 py-3">
              {[
                { mark: <AskBox />, label: "asks" },
                { mark: <PlayBox />, label: "runs" },
                { mark: <StatusBox />, label: "rests" },
                { mark: <StatusBox><Hourglass size={11} className="text-muted-75" /></StatusBox>, label: "snoozed" },
                { mark: <DoneBox />, label: "done" },
              ].map((item) => (
                <div key={item.label} className="flex flex-1 flex-col items-center gap-1.5">
                  {item.mark}
                  <span className="text-[11px] text-muted-70">{item.label}</span>
                </div>
              ))}
            </div>
            <div className="flex items-baseline justify-between rounded-[12px] border border-border/70 bg-panel px-4 py-3 text-[12.5px] text-muted">
              <span className="flex items-baseline gap-2"><LiveDot kind="agent" />agent</span>
              <span className="flex items-baseline gap-2"><LiveDot kind="shell" />shell</span>
              <span className="flex items-baseline gap-2"><LiveDot kind="github" />PR watch</span>
              <span className="flex items-baseline gap-2"><LiveDot kind="shell" quiet />quiet</span>
            </div>
          </KitSection>

          <KitSection title="Toast">
            <div className="flex items-center gap-2.5 rounded-[14px] border border-border-strong bg-elevated px-3.5 py-3 shadow-lg shadow-black/50">
              <Check size={15} className="shrink-0 text-live" strokeWidth={2.6} />
              <span className="min-w-0 flex-1 text-[13.5px] leading-[18px] text-fg/90">Answer sent — the worker is running again</span>
              <span className="shrink-0 text-[13.5px] font-medium text-accent">Undo</span>
            </div>
          </KitSection>

          <KitSection title="Reply box">
            <div className="flex items-end gap-2">
              <div className="flex min-h-[44px] min-w-0 flex-1 items-center rounded-[22px] border border-border-strong bg-panel px-3.5 py-[11px]">
                <span className="text-[16px] leading-[21px] text-fg">Use SQLite</span>
              </div>
              <button aria-label="Send" className="flex size-[44px] shrink-0 items-center justify-center rounded-full bg-accent text-bg">
                <svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
              </button>
            </div>
          </KitSection>
        </div>
      </div>
    </Canvas>
  )
}

// ══ the gallery ═════════════════════════════════════════════════════════════════════════════════

const SCREENS: { id: string; title: string; note: string; render: () => ReactNode }[] = [
  { id: "home", title: "1 · Home", note: "Every project on the machine, sorted by what wants you. The accent count is the ask.", render: () => <HomeScreen /> },
  { id: "board", title: "2 · Board — Queue", note: "Everything not held or done, in one list, asks first. Full width; the accent ? is the only ask marking.", render: () => <BoardQueueScreen /> },
  { id: "board-snoozed", title: "3 · Board — Snoozed", note: "Dimmed, and every row says what it is waiting for.", render: () => <BoardHeldScreen /> },
  { id: "thread", title: "4 · Thread", note: "The transcript, and the only surface with a composer. The ask is answered here, in context.", render: () => <ThreadScreen /> },
  { id: "answer", title: "5 · Answering", note: "One question at a time, in a sheet that slides up over the thread. The verb is Continue, not Send.", render: () => <AnswerScreen /> },
  { id: "actions", title: "6 · Thread actions", note: "A medium-detent sheet over a receded board.", render: () => <ActionsScreen /> },
  { id: "dispatch", title: "7 · New thread", note: "What the + opens, drawn with the keyboard up because that is the real height.", render: () => <DispatchScreen /> },
  { id: "snooze", title: "8 · Snooze", note: "A five-second decision at a small detent, every option resolving its own clock.", render: () => <SnoozeScreen /> },
  { id: "settings", title: "9 · Settings", note: "Browser notifications, not push — this is a website.", render: () => <SettingsScreen /> },
  { id: "subagent", title: "10 · Sub-agent", note: "The drill-in, at the large detent over its parent — the desktop's stacked drawers.", render: () => <SubAgentScreen /> },
  { id: "empty", title: "11 · Empty board", note: "A project with nothing in it yet, and three ways to start.", render: () => <EmptyScreen /> },
  { id: "kit", title: "13 · Controls", note: "The whole vocabulary on one screen.", render: () => <KitScreen /> },
]

function Gallery() {
  const shown = only ? SCREENS.filter((s) => s.id === only) : SCREENS
  if (only && shown.length === 1) {
    const screen = shown[0]
    return (
      <div className="flex min-h-dvh items-start justify-start bg-bg">
        <Phone id={screen.id} title={screen.title} solo>{screen.render()}</Phone>
      </div>
    )
  }
  return (
    <div className="min-h-dvh bg-bg px-10 py-12">
      <header className="mb-10 flex max-w-[720px] flex-col gap-2.5">
        <h1 className="m-0 text-[24px] font-semibold tracking-[-0.02em] text-fg">Frizz on a phone</h1>
        <p className="m-0 text-[14px] leading-[21px] text-muted">
          Thirteen screens, drawn at 390×844 in the app's own stylesheet and tokens. Append{" "}
          <code className="rounded bg-panel-2 px-1 py-0.5 font-mono-keep text-[12.5px]">?screen=board</code> for one on
          its own at 1:1, or <code className="rounded bg-panel-2 px-1 py-0.5 font-mono-keep text-[12.5px]">?font=mono</code>{" "}
          for the other font setting.
        </p>
      </header>
      <div className="flex flex-wrap gap-x-12 gap-y-14">
        {shown.map((screen) => (
          <Phone key={screen.id} id={screen.id} title={screen.title} note={screen.note}>
            {screen.render()}
          </Phone>
        ))}
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(<Gallery />)
