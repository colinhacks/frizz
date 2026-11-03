import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { createRoot } from "react-dom/client"
import { useState, type ReactNode } from "react"
import {
  ArrowDownNarrowWide,
  ArrowDownUp,
  ArrowDownWideNarrow,
  Check,
  ChevronDown,
  ClockArrowDown,
  ClockArrowUp,
  Folders,
  Rows3,
  SlidersHorizontal,
} from "lucide-react"
import type { ProjectCard, ThreadView } from "@frizz/shared"
import { SectionHeader, ThreadRow } from "./components/Sidebar.tsx"
import { ProjectSquare } from "./components/ProjectRail.tsx"
import { Tooltip, TooltipProvider } from "./components/Tooltip.tsx"
import { OPAQUE_SURFACE_BASE } from "./lib/overlaySurface.ts"
import "./styles.css"

// MOCKUP SHEET — THE QUEUE'S ORDER AND THE CONSOLE'S GROUPING AS ONE CONTROL ABOVE THE SIDEBAR'S BANDS.
//
// Not shipped UI and not a test. The maintainer, 2026-11-03, of the Settings sheet's "Queue order"
// field: "I don't care about this, so we should just move the queue ordering to be an icon … right-
// justified … far right of the queue label. Actually, maybe there's something here for a bit of a
// control bar that combines the sorting and the grouping in some kind of clean bar that just shows up
// above all of the different rails. Let's mock up different options there."
//
// Every row is the REAL ThreadRow and every band label the REAL SectionHeader; the project header is
// ConsoleSidebar.tsx's, copied because it is not exported. Each option draws three columns: All
// projects grouped by status, All projects grouped by project, and one project's board (which has
// nothing to group, so only the order applies). The controls WORK — each column keeps its own state —
// so a click re-sorts that column's queue or regroups it.
//
//   nubx vite --port 5952 --strictPort   (from packages/web), then
//   http://localhost:5952/queue-controls-mockup-fixture.html
document.documentElement.dataset.font = "sans"
document.documentElement.dataset.theme = "dark"

const originalFetch = window.fetch
window.fetch = async (input, init) => {
  // location.href, not origin: the page also ships as one file:// document, whose origin is "null".
  const url = new URL(typeof input === "string" ? input : (input as Request).url ?? input.toString(), location.href)
  if (url.pathname.includes("/_frizz/")) return new Response(JSON.stringify({ result: null }), { headers: { "content-type": "application/json" } })
  return originalFetch(input, init)
}

type Order = "fifo" | "lifo"
type Group = "status" | "project"

const project = (id: string, name: string) =>
  ({ id, slug: id, name, path: `/fixture/${id}`, lastOpenedAt: "2026-11-03T00:00:00.000Z", stale: false, iconStatus: "none" }) as unknown as ProjectCard
const FRIZZ = project("frizz", "frizz")
const PULLFROG = project("pullfrog", "pullfrog")
const ZOD = project("zod", "zod")
const PROJECTS = [FRIZZ, PULLFROG, ZOD]

const now = Date.now()
const ago = (min: number) => new Date(now - min * 60_000).toISOString()
const base = {
  kind: "session",
  backend: "claude",
  model: "opus",
  titleAuto: false,
  humanBlocked: false,
  pendingAsk: false,
  pendingQuestion: false,
  archived: false,
  foreign: false,
  state: "open",
  status: "active",
  crashed: false,
  subAgents: [],
  agents: [],
  bgShells: [],
  dependsOn: [],
  externalDeps: [],
  errors: [],
  warnings: [],
  spawnedAt: ago(600),
}
interface Row {
  project: ProjectCard
  t: ThreadView
  min: number
}
const queued = (p: ProjectCard, id: string, title: string, min: number): Row => ({
  project: p,
  min,
  t: { ...base, id, title, runtime: "turn-idle", needsYou: true, lastAssistantAt: ago(min), lastActivityAt: ago(min) } as unknown as ThreadView,
})
const running = (p: ProjectCard, id: string, title: string, min: number): Row => ({
  project: p,
  min,
  t: { ...base, id, title, runtime: "running", needsYou: false, lastActivityAt: ago(min) } as unknown as ThreadView,
})

const CONSOLE_QUEUE = [
  queued(FRIZZ, "c-q1", "Console pins for the By status view", 14),
  queued(PULLFROG, "c-q2", "Rotate the preview client secret", 42),
  queued(ZOD, "c-q3", "Triage the discriminated-union regression in 4.2", 95),
  queued(FRIZZ, "c-q4", "Audit the quota read path", 130),
  queued(PULLFROG, "c-q5", "Webhook retries double-count deliveries", 260),
]
const CONSOLE_RUNNING = [running(PULLFROG, "c-r1", "Migrate the webhook verifier", 1), running(ZOD, "c-r2", "Draft the changelog", 2)]
const BOARD_QUEUE = [
  queued(FRIZZ, "b-q1", "Lightbox arrows skip the last image", 9),
  queued(FRIZZ, "b-q2", "Snooze menu remembers the wrong preset", 51),
  queued(FRIZZ, "b-q3", "Quota chip reads 0% after a restart", 180),
]
const BOARD_RUNNING = [running(FRIZZ, "b-r1", "Light-mode audit of the settings sheet", 1)]

// Oldest first is the most minutes ago first (groups.ts orderQueue's FIFO).
const sorted = (rows: Row[], order: Order) => [...rows].sort((a, b) => (order === "fifo" ? b.min - a.min : a.min - b.min))

const ORDER_WORD: Record<Order, string> = { fifo: "Oldest first", lifo: "Newest first" }
const GROUP_WORD: Record<Group, string> = { status: "By status", project: "By project" }
const flip = (order: Order): Order => (order === "fifo" ? "lifo" : "fifo")

interface State {
  group: Group
  order: Order
  setGroup: (g: Group) => void
  setOrder: (o: Order) => void
  /** Which of the option's menus is open, if any. */
  menu: "group" | "order" | null
  setMenu: (open: "group" | "order" | null) => void
}

/** Where a panel is drawn: All projects by status or by project, or a single project's board. */
type Where = "status" | "project" | "board"

// ─── Shared pieces ──────────────────────────────────────────────────────────────────────────────────

function SortGlyph({ order, size = 13 }: { order: Order; size?: number }) {
  return order === "fifo" ? <ArrowDownNarrowWide size={size} aria-hidden /> : <ArrowDownWideNarrow size={size} aria-hidden />
}
function GroupGlyph({ group, size = 13 }: { group: Group; size?: number }) {
  return group === "status" ? <Rows3 size={size} aria-hidden /> : <Folders size={size} aria-hidden />
}

/** A bare icon in a hover square, the rail's own icon-button idiom. */
function IconButton({ label, onClick, children, size = 22 }: { label: string; onClick: () => void; children: ReactNode; size?: number }) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        style={{ width: size, height: size }}
        className="flex shrink-0 items-center justify-center rounded-md text-muted-70 outline-none transition-colors hover:bg-hover hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
      >
        {children}
      </button>
    </Tooltip>
  )
}

function SortButton({ s, size }: { s: State; size?: number }) {
  return (
    <IconButton label={`${ORDER_WORD[s.order]} — click for ${ORDER_WORD[flip(s.order)].toLowerCase()}`} onClick={() => s.setOrder(flip(s.order))} size={size}>
      <SortGlyph order={s.order} />
    </IconButton>
  )
}

/** A band or project label with something right-justified on its line. */
function HeaderLine({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center">
      <div className="min-w-0 flex-1">{children}</div>
      {right ? <div className="flex shrink-0 items-center gap-0.5">{right}</div> : null}
    </div>
  )
}

/** ConsoleSidebar.tsx ProjectHeader. */
function ProjectHeader({ p }: { p: ProjectCard }) {
  return (
    <div className="flex min-w-0 items-start gap-2 pb-[3px] pl-5 pr-1.5 pt-1">
      <span className="mt-[1.5px] shrink-0">
        <ProjectSquare project={p} size={16} />
      </span>
      <span className="min-w-0 truncate text-[12.5px] font-semibold leading-[19px] text-fg/85">{p.name}</span>
    </div>
  )
}

/** ConsoleSidebar.tsx RowSquare. */
function RowSquare({ p }: { p: ProjectCard }) {
  return (
    <span className="-mr-1 mt-[1.5px] shrink-0" title={p.name}>
      <ProjectSquare project={p} size={16} />
    </span>
  )
}

const Rule = () => <hr className="my-3 border-border/50" />

/** The bands under the control: Queue and Running by status, a block per project by project. */
function Bands({ where, s, first }: { where: Where; s: State; first?: ReactNode }) {
  const consoleRows = where !== "board"
  const queue = sorted(consoleRows ? CONSOLE_QUEUE : BOARD_QUEUE, s.order)
  const run = consoleRows ? CONSOLE_RUNNING : BOARD_RUNNING
  const row = (r: Row, waiting: boolean, square: boolean) => (
    <ThreadRow key={r.t.id} t={r.t} restedAge={waiting} shelf={consoleRows ? "console" : "board"} leading={square ? <RowSquare p={r.project} /> : undefined} />
  )
  if (where === "board" || s.group === "status") {
    return (
      <>
        <HeaderLine right={first}>
          <SectionHeader label="Queue" count={queue.length} />
        </HeaderLine>
        {queue.map((r) => row(r, true, consoleRows))}
        <Rule />
        <SectionHeader label="Running" count={run.length} />
        {run.map((r) => row(r, false, consoleRows))}
      </>
    )
  }
  const blocks = PROJECTS.map((p) => ({ p, waiting: queue.filter((r) => r.project === p), running: run.filter((r) => r.project === p) })).filter(
    (b) => b.waiting.length + b.running.length > 0,
  )
  return (
    <>
      {blocks.map((b, i) => (
        <section key={b.p.id}>
          {i > 0 && <Rule />}
          <HeaderLine right={i === 0 ? first : undefined}>
            <ProjectHeader p={b.p} />
          </HeaderLine>
          {b.waiting.map((r) => row(r, true, false))}
          {b.running.map((r) => row(r, false, false))}
        </section>
      ))}
    </>
  )
}

/** The prompt box's lower half, so each control is seen at its real distance under it. */
function PromptStandIn({ where }: { where: Where }) {
  return (
    <div className="flex h-[70px] flex-col justify-between rounded-xl border border-border bg-fg/[0.025] px-3 pb-2 pt-2.5">
      <span className="text-[13px] text-muted-50">Start a thread…</span>
      <span className="flex items-center gap-1.5">
        <span className="inline-flex items-center gap-1.5 rounded-md border border-border/50 py-[3px] pl-[5px] pr-2 text-[11.5px] leading-4 text-fg/80">
          <ProjectSquare project={FRIZZ} size={13} />
          frizz
        </span>
        <span className="text-[11.5px] text-muted-50">{where === "board" ? "Opus 5.5 · high" : "Opus 5.5"}</span>
      </span>
    </div>
  )
}

/** A static open menu in the app's surface (ui/Menu.tsx MenuContent). */
function MenuSurface({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`${OPAQUE_SURFACE_BASE} min-w-[184px] overflow-hidden rounded-lg p-1 ${className}`}>{children}</div>
}
function MenuLabel({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 pt-1.5 text-[10.5px] uppercase tracking-wide text-muted-60">{children}</div>
}
function MenuChoice({ checked, onClick, icon, children }: { checked: boolean; onClick: () => void; icon?: ReactNode; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[12px] outline-none transition-colors hover:bg-panel-2 hover:text-fg ${checked ? "text-fg" : "text-muted"}`}
    >
      {icon ? <span className="flex w-3.5 shrink-0 items-center justify-center text-muted-70">{icon}</span> : null}
      <span className="min-w-0 flex-1">{children}</span>
      <Check aria-hidden size={13} className={checked ? "shrink-0 text-fg/70" : "invisible shrink-0"} />
    </button>
  )
}

/** The prompt box's chip (ConsoleProjectChip.tsx DESKTOP_CHIP), with a leading glyph. */
function Chip({ icon, children, open, onClick }: { icon: ReactNode; children: ReactNode; open: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-state={open ? "open" : "closed"}
      className="group inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md border border-border/50 bg-transparent py-1 pl-[6px] pr-2 text-left text-[12px] leading-4 text-fg/90 outline-none transition-colors hover:bg-hover-strong data-[state=open]:bg-hover-strong"
    >
      <span className="flex shrink-0 items-center text-muted-70">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
      <ChevronDown aria-hidden size={13} className="-ml-[1.5px] shrink-0 text-fg/65 transition-transform group-data-[state=open]:rotate-180" />
    </button>
  )
}

// ─── The options ────────────────────────────────────────────────────────────────────────────────────

/** Today's full-width segmented "By status" | "By project" (ConsoleSidebar.tsx GroupSwitch). */
function TodaySwitch({ s, children }: { s: State; children?: ReactNode }) {
  const option = (value: Group) => (
    <button
      type="button"
      aria-pressed={s.group === value}
      onClick={() => s.setGroup(value)}
      className={`h-[26px] min-w-0 flex-1 truncate rounded-md px-2 text-[12.5px] font-medium leading-none outline-none transition-colors ${
        s.group === value ? "bg-elevated text-fg shadow-sm shadow-shadow-ink/30" : "text-muted-70 hover:text-fg"
      }`}
    >
      {GROUP_WORD[value]}
    </button>
  )
  return (
    <div role="group" className="mx-0.5 mb-3 flex shrink-0 gap-[3px] rounded-[10px] border border-border bg-fg/[0.03] p-[3px]">
      {option("status")}
      {option("project")}
      {children}
    </div>
  )
}

interface Option {
  key: string
  title: string
  pitch: string
  notes: string[]
  recommended?: boolean
  /** What stands above the bands. */
  bar?: (where: Where, s: State) => ReactNode
  /** What rides the right end of the list's first label. */
  first?: (where: Where, s: State) => ReactNode
  /** The option has a menu: draw a fourth column with it open. */
  menu?: boolean
}

/** The menus, shared by D and E: what each choice lists. */
function GroupChoices({ s }: { s: State }) {
  return (
    <>
      <MenuChoice checked={s.group === "status"} onClick={() => s.setGroup("status")} icon={<Rows3 size={13} />}>
        By status
      </MenuChoice>
      <MenuChoice checked={s.group === "project"} onClick={() => s.setGroup("project")} icon={<Folders size={13} />}>
        By project
      </MenuChoice>
    </>
  )
}
function OrderChoices({ s }: { s: State }) {
  return (
    <>
      <MenuChoice checked={s.order === "fifo"} onClick={() => s.setOrder("fifo")} icon={<ArrowDownNarrowWide size={13} />}>
        Oldest first
      </MenuChoice>
      <MenuChoice checked={s.order === "lifo"} onClick={() => s.setOrder("lifo")} icon={<ArrowDownWideNarrow size={13} />}>
        Newest first
      </MenuChoice>
    </>
  )
}

const OPTIONS: Option[] = [
  {
    key: "A",
    title: "An icon on the Queue label",
    pitch: "The smallest change. The grouping switch stays as it is; the order becomes one icon at the far right of the Queue label, over the column of rest times it reorders.",
    notes: [
      "The order only ever applied to the queue (Running is always newest first, Pinned is hand-arranged), so the icon sits on the one band it changes.",
      "By project there is no Queue label, so the icon rides the first project's name instead.",
      "Two controls in two places, and the switch still costs a full row.",
    ],
    bar: (where, s) => (where === "board" ? null : <TodaySwitch s={s} />),
    first: (_where, s) => <SortButton s={s} />,
  },
  {
    key: "B",
    title: "One bar: a compact switch and the order icon",
    pitch: "The switch shrinks to its two words and shares one line with the order icon, right-justified over the rest times. One quiet bar where the full-width switch is today.",
    notes: [
      "Both choices stay one click, and the grouping is still read off the switch at a glance.",
      "A project's board has nothing to group, so its bar would hold the icon alone; it rides the Queue label there instead, at the same right edge.",
    ],
    recommended: true,
    bar: (where, s) =>
      where === "board" ? null : (
        <div className="mx-0.5 mb-3 flex items-center justify-between gap-2">
          <div role="group" className="flex shrink-0 gap-[2px] rounded-[8px] border border-border bg-fg/[0.03] p-[2px]">
            {(["status", "project"] as const).map((g) => (
              <button
                key={g}
                type="button"
                aria-pressed={s.group === g}
                onClick={() => s.setGroup(g)}
                className={`h-[22px] rounded-[5px] px-2.5 text-[12px] font-medium leading-none outline-none transition-colors ${
                  s.group === g ? "bg-elevated text-fg shadow-sm shadow-shadow-ink/30" : "text-muted-70 hover:text-fg"
                }`}
              >
                {g === "status" ? "Status" : "Project"}
              </button>
            ))}
          </div>
          <span className="-mr-[3px]">
            <SortButton s={s} size={24} />
          </span>
        </div>
      ),
    first: (where, s) => (where === "board" ? <SortButton s={s} /> : null),
  },
  {
    key: "C",
    title: "Today's switch, with an order cell",
    pitch: "Keeps the full-width segmented control chosen on 2026-10-13 and gives the order its own square cell at the end of the same track, behind a hairline.",
    notes: [
      "Reads as one control for 'how is this list arranged', and changes the least about what is already there.",
      "The order cell looks like a third grouping until it is hovered; it is a toggle, not a segment.",
      "A project's board takes A's icon on the Queue label.",
    ],
    bar: (where, s) =>
      where === "board" ? null : (
        <TodaySwitch s={s}>
          <span aria-hidden className="my-[5px] w-px shrink-0 bg-border" />
          <Tooltip label={`${ORDER_WORD[s.order]} — click for ${ORDER_WORD[flip(s.order)].toLowerCase()}`}>
            <button
              type="button"
              aria-label={ORDER_WORD[s.order]}
              onClick={() => s.setOrder(flip(s.order))}
              className="flex h-[26px] w-[30px] shrink-0 items-center justify-center rounded-md text-muted-70 outline-none transition-colors hover:bg-hover hover:text-fg"
            >
              <SortGlyph order={s.order} size={14} />
            </button>
          </Tooltip>
        </TodaySwitch>
      ),
    first: (where, s) => (where === "board" ? <SortButton s={s} /> : null),
  },
  {
    key: "D",
    title: "Two chips",
    pitch: "Grouping and order as two small chips in the prompt box's own chip style, each naming its current choice and opening a short menu.",
    notes: [
      "The state is spelled out in words, so nothing needs a hover to read.",
      "Every change is two clicks instead of one, and a project's board keeps a lone order chip.",
    ],
    menu: true,
    bar: (where, s) => (
      <div className="relative mx-0.5 mb-3 flex items-center gap-1.5">
        {where !== "board" && (
          <Chip icon={<GroupGlyph group={s.group} />} open={s.menu === "group"} onClick={() => s.setMenu(s.menu === "group" ? null : "group")}>
            {GROUP_WORD[s.group]}
          </Chip>
        )}
        <Chip icon={<SortGlyph order={s.order} />} open={s.menu === "order"} onClick={() => s.setMenu(s.menu === "order" ? null : "order")}>
          {ORDER_WORD[s.order]}
        </Chip>
        {s.menu === "group" && (
          <MenuSurface className="absolute left-0 top-[calc(100%+6px)] z-10">
            <GroupChoices s={s} />
          </MenuSurface>
        )}
        {s.menu === "order" && (
          <MenuSurface className={`absolute top-[calc(100%+6px)] z-10 ${where === "board" ? "left-0" : "left-[106px]"}`}>
            <OrderChoices s={s} />
          </MenuSurface>
        )}
      </div>
    ),
  },
  {
    key: "E",
    title: "One view menu",
    pitch: "A single chip names the whole arrangement — 'By status · Oldest first' — and opens one menu holding both choices. The quietest at rest.",
    notes: [
      "One place for every way of arranging the list, and room to grow if a third choice ever arrives.",
      "Two clicks for anything, and the order hides inside a menu on a project's board too.",
    ],
    menu: true,
    bar: (where, s) => (
      <div className="relative mx-0.5 mb-3 flex items-center">
        <Chip icon={<SlidersHorizontal size={13} aria-hidden />} open={s.menu !== null} onClick={() => s.setMenu(s.menu ? null : "order")}>
          {where === "board" ? ORDER_WORD[s.order] : `${GROUP_WORD[s.group]} · ${ORDER_WORD[s.order]}`}
        </Chip>
        {s.menu !== null && (
          <MenuSurface className="absolute left-0 top-[calc(100%+6px)] z-10">
            {where !== "board" && (
              <>
                <MenuLabel>Group</MenuLabel>
                <GroupChoices s={s} />
                <div className="my-1 h-px bg-border" />
              </>
            )}
            <MenuLabel>Queue order</MenuLabel>
            <OrderChoices s={s} />
          </MenuSurface>
        )}
      </div>
    ),
  },
  {
    key: "F",
    title: "Two icons on the first label, no bar",
    pitch: "No bar at all: the grouping and the order are two icons at the far right of the list's first label. The rows move up by the height of today's switch.",
    notes: [
      "The cleanest column, and the order icon sits exactly where A puts it.",
      "The grouping is only readable from its glyph or its tooltip, and it sits on the Queue label although it rearranges every band.",
    ],
    first: (where, s) => (
      <>
        {where !== "board" && (
          <IconButton label={`${GROUP_WORD[s.group]} — click to group ${s.group === "status" ? "by project" : "by status"}`} onClick={() => s.setGroup(s.group === "status" ? "project" : "status")}>
            <GroupGlyph group={s.group} />
          </IconButton>
        )}
        <SortButton s={s} />
      </>
    ),
  },
]

// ─── The sheet ──────────────────────────────────────────────────────────────────────────────────────

const PANEL_CAPTION: Record<Where, string> = { status: "All projects · by status", project: "All projects · by project", board: "A project's board" }

function Panel({ option, where, menuOpen = false, caption }: { option: Option; where: Where; menuOpen?: boolean; caption?: string }) {
  const [group, setGroup] = useState<Group>(where === "project" ? "project" : "status")
  const [order, setOrder] = useState<Order>("fifo")
  const [menu, setMenu] = useState<"group" | "order" | null>(menuOpen ? "order" : null)
  const s: State = { group, order, setGroup, setOrder, menu, setMenu }
  return (
    <figure className="m-0 w-[350px] shrink-0" data-panel={`${option.key}-${where}${menuOpen ? "-menu" : ""}`}>
      <figcaption className="mb-2 text-[11.5px] text-muted-60">{caption ?? PANEL_CAPTION[where]}</figcaption>
      <div className="rounded-xl border border-border/60 bg-bg px-3 pb-4 pt-3">
        <PromptStandIn where={where} />
        <div className="pt-5" data-list>
          {option.bar?.(where, s)}
          <Bands where={where} s={s} first={option.first?.(where, s)} />
        </div>
      </div>
    </figure>
  )
}

function OptionRow({ option }: { option: Option }) {
  return (
    <section className="border-t border-border/60 py-8" data-option={option.key}>
      <header className="mb-1.5 flex items-baseline gap-2.5">
        <span className="text-[17px] font-semibold text-fg">
          {option.key} · {option.title}
        </span>
        {option.recommended && <span className="rounded border border-border px-1.5 text-[11px] leading-[18px] text-muted-70">recommended</span>}
      </header>
      <p className="mb-2 max-w-[860px] text-[13.5px] leading-[20px] text-fg/85">{option.pitch}</p>
      <ul className="mb-5 max-w-[860px] list-disc pl-5 text-[12.5px] leading-[19px] text-muted-70">
        {option.notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      <div className="flex flex-wrap items-start gap-6">
        <Panel option={option} where="status" />
        <Panel option={option} where="project" />
        <Panel option={option} where="board" />
        {option.menu && <Panel option={option} where="status" menuOpen caption="All projects · its menu open" />}
      </div>
    </section>
  )
}

/** The candidate glyphs for the order, both directions, at the size they would ship. */
function IconCandidates() {
  const pairs: { name: string; fifo: ReactNode; lifo: ReactNode; used?: boolean }[] = [
    { name: "Sort arrows (used below)", fifo: <ArrowDownNarrowWide size={14} />, lifo: <ArrowDownWideNarrow size={14} />, used: true },
    { name: "Clock arrows", fifo: <ClockArrowUp size={14} />, lifo: <ClockArrowDown size={14} /> },
    { name: "One swap glyph, direction in the tooltip", fifo: <ArrowDownUp size={14} />, lifo: <ArrowDownUp size={14} /> },
  ]
  return (
    <div className="mt-5 flex flex-wrap gap-3">
      {pairs.map((p) => (
        <div key={p.name} className={`rounded-lg border px-3 py-2 ${p.used ? "border-border" : "border-border/50"}`}>
          <div className="mb-1.5 text-[11.5px] text-muted-60">{p.name}</div>
          <div className="flex items-center gap-4 text-[12px] text-fg/85">
            <span className="flex items-center gap-1.5">
              <span className="text-muted-70">{p.fifo}</span>Oldest first
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-muted-70">{p.lifo}</span>Newest first
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

function Sheet() {
  const [light, setLight] = useState(false)
  return (
    <div className="min-h-screen bg-bg px-10 py-9 text-fg">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h1 className="text-[22px] font-semibold">Sorting and grouping above the sidebar's bands</h1>
          <p className="mt-1.5 max-w-[860px] text-[13.5px] leading-[20px] text-muted-70">
            Queue order leaves Settings in every option and lives on the sidebar instead. On All projects it joins the By status / By project switch;
            a project's board has nothing to group, so only the order applies there. The rows are the real sidebar rows. Everything works: each
            column keeps its own state, so the icons, switches, chips and menu items re-sort or regroup it.
          </p>
        </div>
        <button
          type="button"
          className="shrink-0 rounded-md border border-border px-2.5 py-1 text-[12.5px] text-fg/85 hover:bg-hover"
          onClick={() => {
            document.documentElement.dataset.theme = light ? "dark" : "light"
            setLight(!light)
          }}
        >
          {light ? "Dark theme" : "Light theme"}
        </button>
      </div>
      <IconCandidates />
      <div className="mt-8">
        {OPTIONS.map((option) => (
          <OptionRow key={option.key} option={option} />
        ))}
      </div>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <TooltipProvider>
      <Sheet />
    </TooltipProvider>
  </QueryClientProvider>,
)
