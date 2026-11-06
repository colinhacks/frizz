import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent as DragEvent_, type KeyboardEvent as KeyboardEvent_, type MouseEvent as MouseEvent_, type PointerEvent as PointerEvent_, type ReactNode } from "react"
import { House, Plus } from "lucide-react"
import { Link, useLocation, useNavigate } from "react-router"
import type { ProjectCard, ProjectRailCounts } from "@frizz/shared"
import { activeBandThread, boardAskThread, boardQueuedThread, PROJECT_ICON_EXTENSIONS } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { useBoardLoaded, useBoardThreads } from "../hooks.ts"
import { showToast } from "../store.ts"
import { projectHref, projectSlug } from "../lib/base-path.ts"
import { PROJECTS_HREF } from "../lib/homeView.ts"
import { useDevicePixelRatio } from "../lib/devicePixelRatio.ts"
import { projectIconKey, rememberProjectIcon, seenProjectIcon } from "../lib/projectIconSeen.ts"
import { useOptimisticallyArchived } from "../lib/optimisticArchive.ts"
import { useOptimisticallySteered } from "../lib/steering.ts"
import { dropIndex, edgeScrollVelocity, moveItem, shiftFor } from "../lib/railReorder.ts"
import { Tooltip } from "./Tooltip.tsx"
import { Z_CHROME } from "../lib/layers.ts"

// THE PROJECT RAIL — every project on this machine as one icon square, always on screen.
//
// Slack's and Discord's rail, and for their reason: once a person is working across a dozen
// workspaces, "which one am I in" and "take me to another" are constant questions, and a home page
// answers neither without a round trip. Frizz reached the same point when one server started serving
// every project — the grid at `/` is a fine front door and a poor switcher.
//
// It is FIXED to the viewport's left edge, outside App's centered sidebar+workpane pair, so it holds
// still while the page scrolls and never enters the measure of anything else. App reserves its width
// with a padding-left on the container rather than a margin on the pair, so the pair still centers in
// whatever space is left.
//
// HIDDEN BELOW 800px, where the sidebar already stacks above the workpane and a permanent 56px column
// would be a tenth of the viewport spent on navigation. The grid at `/` is the switcher there.

/**
 * The column's total painted width, and the inset every surface beside it reserves.
 *
 * 57 and not 56 because the rail is border-box and carries a 1px right border: at 56 the CONTENT box
 * is 55, and a 40px square centred in 55 sits half a pixel left of centre — measured at 7.5px on the
 * left against 8.5px on the right. 57 gives it a 56px content box and a true 8/8.
 *
 * Exported as a pair so the reserved space and the painted width cannot drift apart.
 */
export const RAIL_WIDTH_CLASS = "w-[57px]"
export const RAIL_INSET_CLASS = "max-[800px]:pl-0 pl-[57px]"
/** What a fixed-position surface must clear to sit beside the rail rather than under it. */
export const RAIL_WIDTH_PX = 57

/**
 * A stable hue per project, from its id.
 *
 * A monogram is what a project with no icon gets, and forty grey squares would defeat the point of a
 * rail entirely — colour is doing the identifying. The id is a UUID and never changes, so a project's
 * colour is stable across machines, renames and moves; hashing the NAME would reshuffle the rail
 * whenever someone renamed something.
 */
function monogramHue(id: string): number {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 360
  return hash
}

/**
 * One or two letters, from word boundaries rather than the first two characters.
 *
 * `standard-schema` reads as SS and `fray` as F. Two letters is the ceiling: three stops being a
 * monogram and starts being unreadable text at 40px.
 */
export function monogram(name: string): string {
  const words = name.split(/[\s\-_./]+/u).filter(Boolean)
  if (words.length === 0) return "?"
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase()
  return (words[0]![0]! + words[1]![0]!).toUpperCase()
}

/**
 * The icon URL for a project, versioned so a replaced icon is a different URL (see ProjectCard), and
 * sized: `px` asks for a copy that many device pixels across (server icon-renditions.ts).
 */
export function projectIconSrc(project: ProjectCard, px?: number): string {
  const version = project.iconVersion ? `&v=${encodeURIComponent(project.iconVersion)}` : ""
  const size = px ? `&s=${px}` : ""
  return `/_frizz/project-icon?id=${encodeURIComponent(project.id)}${version}${size}`
}

/**
 * The square itself: the project's icon, or its monogram until we know there isn't one.
 *
 * The monogram is what renders if the icon never loads. A picture arriving for the first time fades
 * in over the tile; one this browser has drawn before (lib/projectIconSeen.ts) is drawn at once, which
 * is what keeps opening the grid or reloading from replaying the fade on every square.
 */
export function ProjectSquare({ project, size }: { project: ProjectCard; size: number }) {
  const iconKey = projectIconKey(project)
  const seen = seenProjectIcon(iconKey)
  const [loaded, setLoaded] = useState(seen !== undefined)
  // A near-square mark fills the tile; a genuinely letterboxed one is contained and padded. Measured:
  // a 372x368 screenshot is 1.1% off square and looked WRONG contained — object-contain letterboxed
  // it and the 6% padding inset it again, so a full-bleed square read as a stamp with a gap around it.
  // A real logo (.github/logo.webp, 300x331) is 9.4% off, so 5% separates the two cleanly.
  const [fills, setFills] = useState(seen ?? false)
  const hue = monogramHue(project.id)
  // Draw the image unless we KNOW there is nothing to draw. Skipping it for a project that has simply
  // never been scanned deadlocks the feature — the image request is what triggers the lazy scan, so
  // no request means no scan means never any icon. `iconVersion` cannot decide this on its own: it is
  // stamped whenever a scan RAN, found or not. See ProjectCard.iconStatus.
  const hasIcon = project.iconStatus !== "none"
  // Its EXACT size in device pixels — 80 for the rail at 2x — so the copy the server sends is drawn
  // pixel for pixel. A copy any bigger is resampled again in the browser, and that softened the
  // pixel-art marks. Not `srcset`: it offers a fixed list of densities, and a zoomed page (2.2x at
  // 110%) falls between them.
  const src = projectIconSrc(project, Math.round(size * useDevicePixelRatio()))
  // The URL that failed, not a flag. A flag outlived the failure: once one request 404'd, the square
  // rendered no image for the rest of the page's life, so a later rescan, an upload or a found icon
  // never showed until a reload. A new `iconVersion` is a new URL, and gets its own request.
  const [failedSrc, setFailedSrc] = useState<string>()
  const failed = failedSrc === src
  const showMonogram = !hasIcon || failed
  // Below ~22px two letters at 0.4em are 6–8px type, which is noise, not a monogram. A small square —
  // the Console's 16px row mark — carries the first letter alone, larger, the way Slack's do.
  const small = size < 22
  return (
    <span
      className="relative block overflow-hidden rounded-[30%] bg-elevated"
      style={{
        width: size,
        height: size,
        // Low saturation and lightness: these sit against a near-black rail and must read as a
        // surface with a letter on it, not as a colour chip. The letter carries the same hue at full
        // brightness so the pairing stays legible at any hue.
        background: hasIcon && !failed ? undefined : `hsl(${hue} 32% 24%)`,
      }}
    >
      {showMonogram && (
        <span
          aria-hidden
          className="absolute inset-0 flex items-center justify-center font-semibold leading-none"
          // 0.4em of the square: the same proportion Slack's initials use, and small enough that two
          // letters still clear the rounded corners.
          style={{ fontSize: size * (small ? 0.56 : 0.4), color: `hsl(${hue} 55% 78%)` }}
        >
          {/*
            `items-center` centres the LINE BOX, and a line box is half-leading plus a descender the
            monogram never uses — so where the ink lands depends entirely on the font's metrics. THIS
            APP RENDERS IN TWO (html[data-font]), and measured on this tile the same two letters sat
            0.50px BELOW centre in the sans stack and 1.02px ABOVE it in mono: a 1.5px spread, and no
            single constant is right in both.

            `text-box: trim-both cap alphabetic` makes the box the CAP BAND itself — baseline to cap
            height, which for A-Z is exactly the ink — so the browser recomputes it per font and the
            centring is correct in both with nothing to re-measure. Where it is unsupported the line
            box is used as before, which is the ≤1px placement this replaced rather than a broken one.
          */}
          <span style={{ textBox: "trim-both cap alphabetic" } as CSSProperties}>
            {small ? monogram(project.name).slice(0, 1) : monogram(project.name)}
          </span>
        </span>
      )}
      {hasIcon && !failed && (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        // Not lazy: a rail is a handful of squares, all of them on screen, and deferring them is
        // half of what the swap looked like.
        loading="eager"
        decoding="async"
        onLoad={(event) => {
          const img = event.currentTarget
          // A sized copy keeps the original's proportions, so the ratio is the original's.
          const filling = img.naturalWidth > 0 && img.naturalHeight > 0 ? Math.abs(img.naturalWidth / img.naturalHeight - 1) <= 0.05 : fills
          setFills(filling)
          setLoaded(true)
          rememberProjectIcon(iconKey, filling)
        }}
        onError={() => setFailedSrc(src)}
        // object-contain, never cover: a logo cropped to fill its square is a mangled logo, and the
        // scan admits some non-square marks (a 300×331 `.github/logo.webp` is a real case). The
        // padding keeps a full-bleed icon off the rounded corners without shrinking a letterboxed one
        // into a stamp.
        className={`relative h-full w-full transition-opacity ${
          fills ? "object-cover" : "object-contain p-[6%]"
        } ${loaded ? "opacity-100" : "opacity-0"}`}
      />
      )}
    </span>
  )
}

const SQUARE = 40

/**
 * The tail of a square's tooltip: `1 running, 2 in the queue`. The two words are the sidebar's own band
 * headings (RUNNING, QUEUE), so the rail names what it counts the way the rows it counts are labelled.
 * The badge draws the queue alone (see RailLink), so this is where the rail still says that a project
 * has work in flight.
 */
export function railCountsLabel(queued: number, running: number): string {
  const parts: string[] = []
  if (running) parts.push(`${running} running`)
  if (queued) parts.push(`${queued} in the queue`)
  return parts.join(", ")
}

/**
 * A project square's tooltip, `zod — 1 running, 2 in the queue`: the rail's, and the home screen's tile
 * (ProjectGrid), so the two say a project's state in one sentence.
 */
export function projectSquareLabel(project: ProjectCard, queued: number, running: number): string {
  const inPlay = railCountsLabel(queued, running)
  return project.stale ? `${project.name} — directory is missing` : inPlay ? `${project.name} — ${inPlay}` : project.name
}

/**
 * The badge's width, a WHOLE pixel per digit count rather than sized to its text.
 *
 * Content-sized, a two-digit badge came out ~20.4px wide, and Chrome paints that box on whole pixels
 * (measured 2026-09-24, when a ring drawn round the badge sat 0.48px off a "12" because of it). A
 * whole-pixel width has the face painted where layout put it. 16 is the circle; 22 and 28 hold the
 * widest two and three digits ("88", "888") with the same side room a single digit gets.
 */
function badgeWidth(count: number): string {
  return count < 10 ? "w-[16px]" : count < 100 ? "w-[22px]" : "w-[28px]"
}

/**
 * A queue count on the rail's bottom-right corner of a project's square.
 *
 * Proportional figures, not tabular: a badge centres ONE number, it aligns no column, and a tabular "1"
 * carries a fixed cell's worth of side-bearing that put the ink of "12" 1.02px left of the pill's centre.
 * Measured 2026-08-24 at 10px/600 in the sans UI font. The width is fixed per digit count (badgeWidth),
 * so the pill centres the digits itself.
 *
 * The cut-out is a WHOLE 1px. It was `border-[1.5px]`, and Chrome floors a fractional border to whole
 * CSS pixels at every scale (computed `1px` at dsf 1, 2 and 3, 2026-09-24), so the face painted 14px
 * where the numbers said 13. 1px is what Chrome was already drawing, so nothing moved there; it makes
 * every browser draw the same.
 */
function QueueBadge({ count, className, ...data }: { count: number; className: string; "data-rail-queue-count"?: number }) {
  return (
    <span
      aria-label={`${count} in the queue`}
      {...data}
      className={`pointer-events-none absolute flex h-[16px] ${badgeWidth(count)} items-center justify-center rounded-full border border-bg bg-accent-fill text-[10px] font-semibold leading-none proportional-nums text-on-accent ${className}`}
    >
      {/* The cap band, not the line box — the same fix the monogram above uses, for the same reason:
          `items-center` centred the digits' LINE BOX and their ink rode 0.4–0.5px low in the sans
          UI font (measured 2026-08-24). Trimming the box to baseline→cap height makes the box the
          ink, so the browser centres it with nothing to re-measure when the type scale moves. */}
      <span style={{ textBox: "trim-both cap alphabetic" } as CSSProperties}>{count}</span>
    </span>
  )
}

/**
 * The current project's square grows a pill on the rail's left edge.
 *
 * Discord's indicator, because the alternative — marking the square itself — competes with the icon
 * it is drawn on top of. The pill lives in the gutter, where nothing else does.
 */
export function RailLink({
  project,
  current,
  counts,
  index,
  drag,
  onPointerDown,
  onKeyDown,
}: {
  project: ProjectCard
  current: boolean
  /** This project's queue and Active band, or undefined when this server has not opened the project. */
  counts: ProjectRailCounts | undefined
  index: number
  drag: DragState | null
  onPointerDown: (event: PointerEvent_<HTMLAnchorElement>, index: number) => void
  onKeyDown: (event: KeyboardEvent_<HTMLAnchorElement>, index: number) => void
}) {
  const held = drag?.fromIndex === index
  const queued = counts?.queued ?? 0
  // The held square follows the pointer; everything between its old slot and its new one slides one
  // step to open the gap. `shiftFor` owns which is which — see lib/railReorder.ts.
  const offset = drag
    ? held
      ? drag.deltaY
      : shiftFor(index, drag.fromIndex, drag.toIndex)
    : 0
  return (
    // Suppressed while ANY square is held: the pointer is necessarily inside the square it is
    // dragging, so a delayDuration-0 tooltip would open on grab and then chase the square down the
    // rail. Passing a prop rather than unmounting the wrapper — remounting mid-drag would destroy the
    // element holding pointer capture.
    <Tooltip
      side="right"
      disabled={drag !== null}
      label={projectSquareLabel(project, queued, counts?.running ?? 0)}
    >
      <Link
        to={projectHref(project.slug)}
        aria-current={current ? "page" : undefined}
        // The rail is a reorderable list, and a link is not one. `listitem` + `aria-grabbed` is the
        // most a native anchor can say about it; the keyboard path below is what makes it true.
        aria-grabbed={held || undefined}
        onPointerDown={(event: PointerEvent_<HTMLAnchorElement>) => onPointerDown(event, index)}
        onKeyDown={(event: KeyboardEvent_<HTMLAnchorElement>) => onKeyDown(event, index)}
        onClick={(event: MouseEvent_<HTMLAnchorElement>) => {
          // A drag ENDS over a link, so the browser fires a click on release. Without this, every
          // reorder also navigated to whatever square you dropped on — and under a real router that
          // navigation is instant, so the wrong board would already be mounting.
          if (drag || justDragged()) event.preventDefault()
        }}
        // Native image-drag would fight the pointer drag.
        onDragStart={(event: DragEvent_<HTMLAnchorElement>) => event.preventDefault()}
        className={`group relative flex h-10 w-full items-center justify-center outline-none ${
          held ? "z-10 cursor-grabbing" : ""
        }`}
        style={{
          transform: offset ? `translateY(${offset}px)` : undefined,
          // The held square must track the pointer exactly; its neighbours are the ones that animate.
          transition: held ? "none" : "transform 160ms ease",
        }}
      >
        {/* 28 of the square's 40px — 70%. Discord runs 40 of 48 (83%) and 24 of 40 read as a stub
            against the square beside it; 28 is the same confident mark at this size. The hover stub
            is deliberately short: it says "this one" without pretending to be the current page. */}
        <span
          aria-hidden
          className={`absolute left-0 w-[3px] rounded-r-full bg-fg transition-all duration-150 ${
            current ? "h-7 opacity-100" : "h-2.5 opacity-0 group-hover:opacity-60"
          }`}
        />
        <span
          className={`rounded-[30%] transition-[transform,opacity,box-shadow] duration-150 group-focus-visible:ring-1 group-focus-visible:ring-focus-ink-60 ${
            held
              ? "scale-[1.12] opacity-100 shadow-lg shadow-shadow-ink/50"
              : `group-hover:scale-[1.06] ${current ? "" : "opacity-75 group-hover:opacity-100"}`
          } ${project.stale ? "grayscale" : ""}`}
        >
          <ProjectSquare project={project} size={SQUARE} />
        </span>
        {queued ? (
          // THE QUEUE BADGE — how many threads in this project are waiting on the human, and nothing
          // else. From 2026-09-24 the number was the queue PLUS the threads in flight, with a spinner
          // lapping the badge while any were (issue #41); the maintainer took both back out on
          // 2026-10-11 ("showing just the number of threads in the queue is probably more useful for
          // what the average person needs"). Work in flight is named in the square's tooltip instead.
          //
          // THE PLACEMENT is Discord's: on the square's bottom-right corner, overlapping it, with a cut-out
          // border in the rail's own colour so it reads as sitting ON the square rather than beside it.
          // Accent, because the badge answers the queue's question: "go there". A SIBLING of the opacity
          // wrapper, not a child: a non-current square is dimmed to 75%, and a signal must not dim with
          // the surface it is reporting on. Positioned against the LINK (56px wide, the 40px square
          // centred in it), so `right-[3px]` puts the badge 5px past the square's right edge and
          // `-bottom-[5px]` 5px past its bottom — into the 8px gap, clear of the next square, and
          // inside the band's bottom padding for the last one.
          <QueueBadge count={queued} className="-bottom-[5px] right-[3px]" data-rail-queue-count={queued} />
        ) : null}
      </Link>
    </Tooltip>
  )
}

/**
 * Choose, or stop choosing, this project's picture — the two icon items of the home grid's project menu
 * (ProjectGrid), as actions that menu draws among its own.
 *
 * The server's native picker, opened standing in the project's own directory (`pick` below), with a
 * browser file input as the fallback where the machine has none. `warm` is for the menu's opening: the
 * server builds that picker then, so the click on "Choose an icon…" only has to show it. `fileInput` must
 * be rendered by the caller, outside the menu, so it outlives the menu closing on the click.
 *
 * It was a menu of its own until 2026-11-03, opened from an overlay on the old project card's square.
 * The home grid's icons are links with nothing laid over them, so the items moved into the one menu.
 */
export function useProjectIconChange(project: ProjectCard): {
  fileInput: ReactNode
  choose: () => void
  reset: () => void
  warm: () => void
  uploading: boolean
  resetLabel: string
} {
  const input = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["projectsList"] })
  // A toast, not an inline line: the menu has closed by the time a pick or an upload fails, and the
  // project's icon cell has no room for a paragraph.
  const report = (cause: unknown) => showToast(cause instanceof Error ? cause.message : String(cause), { duration: 7000 })
  const set = useMutation({
    mutationFn: async (file: File) => {
      const bytes = new Uint8Array(await file.arrayBuffer())
      // Chunked: `String.fromCharCode(...bytes)` on a 4 MB icon blows the argument limit and throws
      // a RangeError that reads like a network failure.
      let binary = ""
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
      }
      return rpc.projectIconSet({ id: project.id, name: file.name, data: btoa(binary) })
    },
    onSuccess: () => void invalidate(),
    onError: report,
  })
  const clear = useMutation({
    mutationFn: () => rpc.projectIconClear({ id: project.id }),
    onSuccess: () => void invalidate(),
    onError: report,
  })
  /**
   * The NATIVE picker, opened standing in the project's own directory.
   *
   * A browser file input cannot be aimed anywhere — the OS decides, and it lands wherever you last
   * were, which for an icon that almost always lives inside the project means navigating back to a
   * path Frizz already knows. The hidden input below stays as the fallback for a platform with no
   * native dialog, so the menu item never becomes a dead end.
   */
  const pick = useMutation({
    mutationFn: () => rpc.projectIconPick({ id: project.id }),
    onSuccess: (result) => {
      if (result.kind === "cancelled") return
      if (result.kind === "unavailable") { input.current?.click(); return }
      void invalidate()
    },
    onError: () => input.current?.click(),
  })

  return {
    fileInput: (
      <input
        ref={input}
        type="file"
        accept={PROJECT_ICON_EXTENSIONS.map((extension) => `.${extension}`).join(",")}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          // Reset first: picking the same file twice in a row fires no change event otherwise, so a
          // failed upload could not be retried with the same file.
          event.target.value = ""
          if (file) set.mutate(file)
        }}
      />
    ),
    choose: () => pick.mutate(),
    reset: () => clear.mutate(),
    // Opening the menu is the cue: "Choose an icon…" is one move away, and on macOS a panel built at the
    // click took most of a second to draw (server/directory-picker.ts). Speculative, so a failed request
    // is dropped — the click builds its own panel.
    warm: () => void rpc.projectIconPickWarm({ id: project.id }).catch(() => {}),
    uploading: set.isPending,
    resetLabel: project.iconIsCustom ? "Use the detected icon" : "Look for an icon again",
  }
}

/** A drag in flight. `toIndex` is derived from `deltaY` every move — see lib/railReorder.ts. */
interface DragState {
  id: string
  fromIndex: number
  toIndex: number
  deltaY: number
  /**
   * The list the drag STARTED on, which the rail draws for as long as the square is held.
   *
   * `fromIndex` and `toIndex` are positions in this list and no other. The server now pushes a new
   * order the moment another tab makes one (api/board-stream.ts `refreshProjectList`), and drawing
   * that under a live drag would put a different project in the held slot and slide the wrong
   * neighbours aside. The drop still writes this list with the one move applied — the last
   * arrangement anyone made wins, which is what a whole-list write already means.
   */
  list: readonly ProjectCard[]
}

/**
 * A pointer-down that has not yet travelled far enough to BE a drag.
 *
 * The threshold is the whole reason this is separate state: a rail square is a link first, and
 * starting a drag on contact would mean every click landed a reorder before it navigated.
 */
const DRAG_THRESHOLD_PX = 4

/**
 * A click fires on the element a drag ENDED over, after pointerup. This flag swallows exactly that
 * one, and nothing later — a module-scoped stamp rather than state, so it survives the re-render the
 * drop causes without adding one of its own.
 */
let lastDragEndedAt = 0
function justDragged(): boolean {
  return Date.now() - lastDragEndedAt < 250
}

/**
 * The rail's counts: each project's queue (its badge) and Active band (its tooltip), keyed by project id.
 *
 * TWO SOURCES, one per kind of project. The project on screen has a live board in the store — the
 * same rows the sidebar is drawing a few hundred pixels to the right — so its badge is counted from
 * that, with the same two predicates, and can never lag the rail it sits beside. Every OTHER project is
 * a poll of the server's cached snapshots (`projectsRailCounts`, machine-wide, see
 * lib/queryKeyScope.ts), because the live feed is one socket per project and a rail that opened a
 * socket per square would be forty boards' worth of push for a number. Five seconds: a badge for a
 * project you are not looking at is a "go there" cue, not a live readout. A project with no board on the
 * server has no count — it draws no badge, which is honest, rather than a zero, which is not. That is
 * now a transient state: the server opens every registered project within about a second of boot
 * (server/tenant-prime.ts), which is what ended having to click into each square before its badge
 * would appear.
 */
function useRailCounts(currentSlug: string | undefined, projects: readonly ProjectCard[]): (project: ProjectCard) => ProjectRailCounts | undefined {
  const polled = useQuery({
    queryKey: ["projectsRailCounts"],
    queryFn: () => rpc.projectsRailCounts(),
    refetchInterval: 5_000,
  })
  // Plain snapshots (hooks.ts § The board's threads, read without tracking): three filters over every
  // thread, Done ones included, are three walks nothing needs recorded.
  const board = useBoardLoaded()
  const all = useBoardThreads()
  // THE SAME TWO OVERLAYS THE SIDEBAR FOLDS IN (Sidebar.tsx), so the square's counts and the rows beside
  // it change on the same click: a just-sent steer leaves Queue for Running, a just-clicked Mark as done
  // leaves both. Read off the raw board instead, the badge kept the old count for the whole round-trip
  // while the sidebar had already moved. Hooks cannot be conditional, hence the empty list.
  const overlaid = useOptimisticallyArchived(useOptimisticallySteered(all))
  const threads = currentSlug !== undefined && board ? overlaid : undefined
  const live = threads && { queued: threads.filter(boardQueuedThread).length, running: threads.filter(activeBandThread).length, asks: threads.filter(boardAskThread).length }
  const currentId = currentSlug === undefined ? undefined : projects.find((project) => project.slug === currentSlug)?.id
  return (project) => (project.id === currentId && live ? live : polled.data?.[project.id])
}

/**
 * Have the server build the folder picker NOW, because the pointer or keyboard focus has reached an
 * "Add a project" control and the click is a moment behind it. On macOS a panel built at the click
 * took 0.8-1.0s to draw — the whole delay the operator saw after pressing the button — and a panel
 * built ahead draws in ~0.09s (server/directory-picker.ts). Shared with the grid's phantom card.
 *
 * At most once every 10s: the server keeps a built panel for a minute and answers a repeat by keeping
 * it, so asking more often only adds requests. A failed ask clears the stamp, so the next hover retries.
 */
let pickerWarmedAt = 0
export function warmProjectPicker(): void {
  const now = Date.now()
  if (now - pickerWarmedAt < 10_000) return
  pickerWarmedAt = now
  rpc.projectPickWarm({}).catch(() => { pickerWarmedAt = 0 })
}

export function ProjectRail() {
  const queryClient = useQueryClient()
  const { data } = useQuery({ queryKey: ["projectsList"], queryFn: () => rpc.projectsList() })
  const current = projectSlug()
  const [adding, setAdding] = useState(false)
  const navigate = useNavigate()
  const [drag, setDrag] = useState<DragState | null>(null)
  /** The order the operator is looking at, which leads the server for the whole round trip. */
  const [optimistic, setOptimistic] = useState<ProjectCard[] | null>(null)
  const bandRef = useRef<HTMLDivElement>(null)
  const pick = useMutation({
    mutationFn: () => rpc.projectPick({}),
    onSuccess: (result) => {
      if (result.kind === "picked") {
        // The square for what was just added. Without this the rail kept drawing the list it loaded
        // before the pick — nothing else refetches it, since refetchOnWindowFocus is off app-wide — so
        // the project you were now looking at had no square, and nothing on the rail was current.
        void queryClient.invalidateQueries({ queryKey: ["projectsList"] })
        navigate(projectHref(result.project.slug))
      }
      // No picker on this machine, or it failed: the grid owns the typed-path fallback dialog, and
      // sending someone there is better than growing a second copy of it in a 57px column.
      else if (result.kind === "unavailable") navigate("/")
    },
    onSettled: () => setAdding(false),
  })
  const reorder = useMutation({
    mutationFn: (ids: string[]) => rpc.projectsReorder({ ids }),
    // Hold the operator's arrangement on screen until the refetch that CONFIRMS it has landed.
    // Clearing on success instead would drop back to the previous server order for the frame between
    // the mutation resolving and the query settling — a visible snap-back on every drop.
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["projectsList"] })
      setOptimistic(null)
    },
    onError: () => setOptimistic(null), // the server order is the truth if we could not write ours
  })

  // A held square outranks both: its indices are positions in the list it was picked up from.
  const projects = drag?.list ?? optimistic ?? data ?? []
  const countsFor = useRailCounts(current, projects)
  // The house always goes to the grid (lib/homeView.ts), so it is the current page only there — not on
  // the Console, and not on the launching project's unprefixed board, which names no slug either.
  const onGrid = useLocation().pathname === "/"

  /**
   * Fade the band's bottom edge ONLY while something is actually below it.
   *
   * An unconditional mask dims the LAST square once you have scrolled to the end — which is the same
   * artifact, at the other end, as the top fade that was mistaken for a shadow falling on the first
   * icon. A fade means "there is more"; against the true end of the list it is just a dimmed square.
   */
  const [overflowing, setOverflowing] = useState(false)
  useEffect(() => {
    const band = bandRef.current
    if (!band) return
    const sync = () => setOverflowing(band.scrollTop + band.clientHeight < band.scrollHeight - 1)
    sync()
    band.addEventListener("scroll", sync, { passive: true })
    // The list itself changes height as projects arrive, and the band changes with the window.
    const observer = new ResizeObserver(sync)
    observer.observe(band)
    window.addEventListener("resize", sync)
    return () => {
      band.removeEventListener("scroll", sync)
      observer.disconnect()
      window.removeEventListener("resize", sync)
    }
  }, [projects.length])

  const startDrag = useCallback((event: PointerEvent_<HTMLAnchorElement>, index: number) => {
    // Left button only, and never on a modified click — ⌘/ctrl-click opens a new tab and must not be
    // hijacked into a reorder.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const anchor = event.currentTarget
    const startY = event.clientY
    const list = projects
    let started = false
    let latest: DragState | null = null
    let frame = 0

    const apply = (clientY: number) => {
      const band = bandRef.current
      // Auto-scroll near the band's edges, and FOLD the scroll into the delta: without it, dragging
      // to the top of a 29-project rail is impossible, because the slot you want is never on screen
      // at the same time as the square you are holding.
      let scrolled = 0
      if (band) {
        const bounds = band.getBoundingClientRect()
        const velocity = edgeScrollVelocity(clientY, bounds)
        if (velocity) {
          const before = band.scrollTop
          band.scrollTop += velocity
          scrolled = band.scrollTop - before
        }
      }
      scrollAccumulated += scrolled
      const deltaY = clientY - startY + scrollAccumulated
      latest = { id: list[index]!.id, fromIndex: index, toIndex: dropIndex(index, deltaY, list.length), deltaY, list }
      setDrag(latest)
    }

    let scrollAccumulated = 0
    const onMove = (moveEvent: PointerEvent) => {
      if (!started) {
        if (Math.abs(moveEvent.clientY - startY) < DRAG_THRESHOLD_PX) return
        started = true
        anchor.setPointerCapture(moveEvent.pointerId)
      }
      moveEvent.preventDefault()
      const clientY = moveEvent.clientY
      // Coalesce to one update per frame: the edge auto-scroll must also keep running while the
      // pointer is HELD STILL inside the zone, which a move-driven loop alone would never do.
      cancelAnimationFrame(frame)
      const tick = () => {
        apply(clientY)
        if (bandRef.current && edgeScrollVelocity(clientY, bandRef.current.getBoundingClientRect())) {
          frame = requestAnimationFrame(tick)
        }
      }
      frame = requestAnimationFrame(tick)
    }

    const onUp = () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("pointermove", onMove)
      window.removeEventListener("pointerup", onUp)
      window.removeEventListener("pointercancel", onUp)
      setDrag(null)
      if (!started || !latest) return
      lastDragEndedAt = Date.now()
      const next = moveItem(list, latest.fromIndex, latest.toIndex)
      if (latest.fromIndex === latest.toIndex) return
      setOptimistic(next)
      reorder.mutate(next.map((project) => project.id))
    }

    window.addEventListener("pointermove", onMove, { passive: false })
    window.addEventListener("pointerup", onUp)
    window.addEventListener("pointercancel", onUp)
  }, [projects, reorder])

  /**
   * The keyboard path, because a drag-only reorder is no reorder at all for anyone not using a mouse.
   *
   * Alt+Arrow rather than bare arrows: a bare ArrowUp on a focused link is how you SCROLL, and taking
   * it would make the rail a trap to tab through.
   */
  const onKeyDown = useCallback((event: KeyboardEvent_<HTMLAnchorElement>, index: number) => {
    if (!event.altKey || (event.key !== "ArrowUp" && event.key !== "ArrowDown")) return
    const to = index + (event.key === "ArrowUp" ? -1 : 1)
    if (to < 0 || to >= projects.length) return
    event.preventDefault()
    const next = moveItem(projects, index, to)
    setOptimistic(next)
    reorder.mutate(next.map((project) => project.id))
    // Focus follows the square, not the slot — otherwise a second press moves whatever landed here.
    requestAnimationFrame(() => {
      bandRef.current?.querySelectorAll("a")[to]?.focus()
    })
  }, [projects, reorder])

  return (
    <nav
      aria-label="Projects"
      className={`fixed inset-y-0 left-0 ${Z_CHROME} flex flex-col items-center border-r border-border bg-panel/60 py-3 max-[800px]:hidden ${RAIL_WIDTH_CLASS}`}
    >
      {/* A HOME GLYPH, not the Frizz mark. Two reasons, and the second is why it stopped being the
          mark: this slot is a destination ("all projects"), and the wordmark said whose app you are
          in — which the rail's own presence already says. And `favicon.svg` carries an feDropShadow
          inside a 512 viewBox with 16px of bleed around a 480 tile, so at 26px it cast a soft shadow
          DOWN onto the first project square. A stroke glyph paints only its own strokes.
          The hover fill is the project squares' own shape — 40px at `rounded-[30%]`, like the add slot
          at the bottom. It was 36px with an 8px corner (22%) until 2026-10-11, a visibly different
          rounded rect at the head of a column of identical ones.
          ALWAYS THE GRID, through PROJECTS_HREF rather than `/`, which forwards to a kept Console. It
          followed the kept home until 2026-10-27, and wore the Console's queue count while that was the
          Console; the switcher's Console tab carries that count (HomeSwitcher.tsx). */}
      <Tooltip side="right" label="All projects">
        <Link
          to={PROJECTS_HREF}
          aria-label="All projects"
          aria-current={onGrid ? "page" : undefined}
          data-rail-home
          className="relative flex h-10 w-10 shrink-0 items-center justify-center rounded-[30%] text-muted-70 outline-none transition-colors hover:bg-elevated hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
        >
          <House size={17} />
        </Link>
      </Tooltip>
      <hr className="my-2.5 w-6 shrink-0 border-0 border-t border-border" />

      {/* The scrolling band. `min-h-0` is what lets it actually scroll inside a flex column, and the
          hidden scrollbar keeps a 57px column from spending 8px of itself on a track (the bottom fade
          in styles.css says "there is more" in its place). 8px between squares mirrors what Discord
          runs at 48px and Slack at 36px; 6 read tight at 40.
          `overflow-x` stays visible-ish via the mask rather than a clip so the held square's shadow
          and the current-page pill are not shaved off at the column's edge. */}
      <div
        ref={bandRef}
        data-overflowing={overflowing || undefined}
        // `pb-1.5` absorbs the last square's queue badge (5px below its square): without it the badge
        // extends the scroll height, which the bottom fade reads as "there is more" and dims the square.
        className="frizz-rail-scroll flex w-full min-h-0 flex-1 flex-col items-center gap-2 overflow-y-auto pb-1.5"
      >
        {projects.map((project, index) => (
          <RailLink
            key={project.id}
            project={project}
            index={index}
            current={project.slug === current}
            counts={countsFor(project)}
            drag={drag}
            onPointerDown={startDrag}
            onKeyDown={onKeyDown}
          />
        ))}
      </div>

      <Tooltip side="right" label="Add a project">
        <button
          type="button"
          disabled={adding}
          onPointerEnter={warmProjectPicker}
          onFocus={warmProjectPicker}
          onClick={() => { setAdding(true); pick.mutate() }}
          aria-label="Add a project"
          // A DOTTED squircle, matching the project squares' own `rounded-[30%]` so it reads as an empty
          // slot in the same list rather than a control bolted under it. Dotted and not dashed: at 40px
          // a dashed border resolves into four long strokes that read as a frame, where dots read as
          // "nothing here yet" — which is what it is.
          className="mt-3 flex h-10 w-10 shrink-0 items-center justify-center rounded-[30%] border-[1.5px] border-dotted border-border-strong text-muted-80 outline-none transition-colors hover:border-accent hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-50"
        >
          <Plus size={16} />
        </button>
      </Tooltip>
    </nav>
  )
}
