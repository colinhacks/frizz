import * as RadixDialog from "@radix-ui/react-dialog"
import { ChevronLeft, ChevronRight, Download, ExternalLink, Play, X, ZoomIn, ZoomOut } from "lucide-react"
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent, type ReactNode, type RefObject } from "react"
import { createPortal } from "react-dom"
import { useSnapshot } from "valtio"
import { closeLightbox, openLightbox, stepLightbox, store } from "../store.ts"
import { useFenceIslands } from "../lib/fenceIslands.ts"
import { justifyRows } from "../lib/justifiedRows.ts"
import { isLightboxVideo, lightboxFileName, lightboxImage, lightboxLabel, parseLightboxBody, resolveLightboxPath, type LightboxEntry, type LightboxImage } from "../lib/lightbox.ts"
import { useBackClosesLayer } from "../lib/backDismiss.ts"
import { HEADER_ICON_SQUARE } from "../lib/headerIcon.ts"
import { openLocalPath } from "../lib/local-file-links.ts"
import { localImageUrl } from "../lib/markdownTargets.ts"
import { useIsMobile } from "../lib/mobile.ts"
import { handleDialogEscape } from "../lib/selectOverlay.ts"
import { useLocalPathBase } from "../lib/useMarkdown.ts"
import { FIT, clampZoom, detailScale, maxScale, panBy, pinch, zoomAbout, type ZoomBounds, type ZoomState } from "../lib/viewerZoom.ts"
import { IMAGE_FRAME_MAT, ImageFrame } from "./ImageFrame.tsx"
import { Tooltip, TooltipProvider } from "./Tooltip.tsx"
import { Z_DIALOG } from "../lib/layers.ts"

// A ```lightbox fence (lib/lightbox.ts for the grammar): the pictures and videos a worker listed, laid out
// as ONE gallery inside the same frame every rendered picture in the transcript sits in (ImageFrame), and
// a full-screen viewer that pages through them — zooming into a picture, playing a video — when one is
// clicked.
//
// The gallery is JUSTIFIED ROWS (lib/justifiedRows.ts) — every picture in a row at one height, each at
// its own aspect ratio — so a phone shot and a desktop shot sit side by side at their real shapes, with
// nothing cropped. The gutter between two pictures is the mat's own padding, so the air between them is
// the air around them.

// = the mat's `p-1.5`.
const GAP = 6
// FRAMED_IMAGE's `max-h-[420px]`: one picture alone is exactly as tall as the same picture framed bare.
const MAX_ROW_HEIGHT = 420
// Until a picture loads its shape is unknown; a screenshot is the likeliest thing it is.
const DEFAULT_RATIO = 16 / 10
// The layout's range of shapes. A full-page capture (1440×9000) would otherwise be a sliver one row of
// its neighbours could not see; past these bounds the picture is contained inside its tile instead.
const MIN_RATIO = 0.4
const MAX_RATIO = 3

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max)

// The row height a gallery aims for at this width: a quarter of it, within reason. At the transcript's
// usual ~700px that is ~180px, which lays 2 shots as one row, 4 as two rows of 2 and 6 as two rows of 3.
const targetRowHeight = (width: number) => clamp(width / 4, 112, 180)

interface Tile {
  entry: LightboxEntry
  /** The resolved absolute path, or null when the line names nothing the image proxy can serve. */
  path: string | null
  label: string
}

/**
 * `baseDir` is the directory a relative path resolves against when it is not the project root — the
 * `.md` reader passes the document's own, the way its links resolve. `framed={false}` draws the mat
 * without the frame's border, for a card whose own border already is the frame (ImageFrame).
 */
export function LightboxGallery({ entries, baseDir, framed = true }: { entries: LightboxEntry[]; baseDir?: string; framed?: boolean }) {
  const projectBase = useLocalPathBase()
  const base = useMemo(() => (baseDir ? { ...projectBase, dir: baseDir } : projectBase), [projectBase, baseDir])
  const tiles = useMemo<Tile[]>(
    () => entries.map((entry) => {
      const path = resolveLightboxPath(entry.target, base)
      return { entry, path, label: lightboxLabel(entry, path) }
    }),
    [entries, base],
  )
  // Keyed by path: a picture's shape is a fact about the file, wherever it sits in the list.
  const [ratios, setRatios] = useState<Record<string, number>>({})
  const [broken, setBroken] = useState<Record<string, true>>({})
  const [rowsEl, setRowsEl] = useState<HTMLDivElement | null>(null)
  const width = useContentWidth(rowsEl)

  // Only the pictures that are there take a place in the rows. A line that names nothing the proxy can
  // serve, or a file that failed to load, is listed under them as its plain path — the fallback BlockImage
  // gives a single picture — rather than as a tile, where an empty box drew the eye harder than any
  // picture beside it.
  const shown = tiles.filter((tile) => tile.path !== null && !broken[tile.path])
  const missing = tiles.filter((tile) => !shown.includes(tile))
  const ratioOf = (tile: Tile) => clamp(ratios[tile.path!] || DEFAULT_RATIO, MIN_RATIO, MAX_RATIO)
  const rows = justifyRows(shown.map(ratioOf), width, {
    gap: GAP,
    target: targetRowHeight(width),
    maxHeight: MAX_ROW_HEIGHT,
    maxPerRow: 8,
  })
  // A gallery is labelled only when the worker captioned it: a bare list of files reads as pictures, and
  // the viewer names each one. Once any picture has a caption every tile carries a label line, in one
  // register, so the rows stay level.
  const labelled = tiles.some((tile) => tile.entry.caption)
  const images: LightboxImage[] = shown.map((tile) => lightboxImage(tile.entry, tile.path!))

  if (shown.length === 0) {
    return (
      <div data-lightbox-gallery className="flex flex-col gap-1">
        {missing.map((tile, i) => <MissingPath key={i} tile={tile} />)}
      </div>
    )
  }
  const gallery = (
    <div ref={setRowsEl} data-lightbox-gallery className="flex w-full min-w-0 flex-col gap-1.5">
      {rows.map((row) => (
        // A row capped at MAX_ROW_HEIGHT is narrower than the mat, and centers in it the way a lone
        // framed picture does.
        <div key={row.start} data-lightbox-row className="mx-auto flex max-w-full gap-1.5" style={{ width: row.width }}>
          {shown.slice(row.start, row.end).map((tile, offset) => (
            <GalleryPicture
              key={row.start + offset}
              tile={tile}
              ratio={ratioOf(tile)}
              labelled={labelled}
              onOpen={() => openLightbox(images, row.start + offset)}
              onShape={(ratio) => setRatios((prev) => (prev[tile.path!] === ratio ? prev : { ...prev, [tile.path!]: ratio }))}
              onBroken={() => setBroken((prev) => ({ ...prev, [tile.path!]: true }))}
            />
          ))}
        </div>
      ))}
      {missing.map((tile, i) => <MissingPath key={i} tile={tile} />)}
    </div>
  )
  return framed ? <ImageFrame>{gallery}</ImageFrame> : <div className={IMAGE_FRAME_MAT}>{gallery}</div>
}

// The tile's share of its row is its aspect ratio (`flex-grow`), and its picture box carries the same
// ratio, so every tile in a row comes out at one height without the row being measured twice.
function tileStyle(ratio: number) {
  return { flex: `${ratio} 1 0%` }
}

function GalleryPicture({ tile, ratio, labelled, onOpen, onShape, onBroken }: {
  tile: Tile
  ratio: number
  labelled: boolean
  onOpen: () => void
  onShape: (ratio: number) => void
  onBroken: () => void
}) {
  const video = isLightboxVideo(tile.path!)
  const shape = (width: number, height: number) => {
    if (width > 0 && height > 0) onShape(width / height)
  }
  return (
    <button
      type="button"
      data-lightbox-tile
      data-lightbox-video={video || undefined}
      onClick={onOpen}
      aria-label={`${video ? "Play" : "View"} ${tile.label}`}
      className={`group flex min-w-0 flex-col gap-1 rounded-md text-left outline-none focus-visible:ring-1 focus-visible:ring-focus-ink-60 focus-visible:ring-offset-2 focus-visible:ring-offset-panel-2 ${video ? "cursor-pointer" : "cursor-zoom-in"}`}
      style={tileStyle(ratio)}
    >
      <span className="relative block w-full overflow-hidden rounded-md" style={{ aspectRatio: ratio }}>
        {video ? (
          <>
            {/* The tile is the video's first frame, never a player: it loads only the metadata (its
                shape) and that frame, and plays in the viewer. `#t=0.001` is what makes iOS Safari
                paint the frame at all — with only metadata it otherwise draws an empty box. Inert to
                the pointer, so the click is the tile's. */}
            <video
              src={`${localImageUrl(tile.path!)}#t=0.001`}
              preload="metadata"
              muted
              playsInline
              disablePictureInPicture
              tabIndex={-1}
              aria-hidden
              onLoadedMetadata={(e) => shape(e.currentTarget.videoWidth, e.currentTarget.videoHeight)}
              onError={onBroken}
              className="pointer-events-none block h-full w-full object-contain transition-[filter] group-hover:brightness-110"
            />
            <PlayBadge />
          </>
        ) : (
          <img
            src={localImageUrl(tile.path!)}
            alt={tile.label}
            draggable={false}
            onLoad={(e) => shape(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
            onError={onBroken}
            className="block h-full w-full object-contain transition-[filter] group-hover:brightness-110"
          />
        )}
      </span>
      {labelled && (
        <span title={tile.label} className="block truncate font-sans text-[11px] leading-4 text-muted">
          {tile.label}
        </span>
      )}
    </button>
  )
}

// What says a tile is a video: the play mark on a dark chip, centred — the viewer's own paging chip, so it
// reads on any frame. A play triangle carries its mass on its flat left side, so centring its BOX leaves
// it looking pushed left and centring its mass leaves it looking pushed right; the eye settles between
// the two. Lucide's own triangle already sits a twelfth of its box right of centre, which lands there:
// measured on the rendered chip at dsf 8, the painted triangle's box centre is 0.56px right of the chip's
// and its luminance centroid 0.84px left, so their midpoint is 0.14px off — under the device grid, so no
// nudge of ours.
function PlayBadge() {
  return (
    <span
      data-lightbox-play
      aria-hidden
      className="pointer-events-none absolute left-1/2 top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white/90 ring-1 ring-white/15 backdrop-blur-sm transition-colors group-hover:bg-black/70 group-hover:text-white"
    >
      <Play size={14} strokeWidth={CHIP_PEN} absoluteStrokeWidth fill="currentColor" />
    </span>
  )
}

// A line that names no picture the proxy can serve, or a file that failed to load: its plain path, in the
// muted mono BlockImage falls back to — nothing silently dropped.
function MissingPath({ tile }: { tile: Tile }) {
  return (
    <div data-lightbox-missing className="break-all font-mono-keep text-[12px] text-muted-70">
      {tile.path ?? tile.entry.target}
    </div>
  )
}

// The rows' content width, read before paint so the first frame is already laid out at the real width.
// Keyed on the ELEMENT, not a ref object: the rows mount late whenever every path starts unresolved (a
// relative path before the board names the project root), and a ref's identity never changes to say so.
function useContentWidth(el: HTMLElement | null): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    if (!el) return
    setWidth(el.clientWidth)
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])
  return width
}

// An element's height, read before paint and kept current; 0 while there is no element.
function useBoxHeight(el: HTMLElement | null): number {
  const [height, setHeight] = useState(0)
  useLayoutEffect(() => {
    if (!el) {
      setHeight(0)
      return
    }
    const read = () => setHeight(el.getBoundingClientRect().height)
    read()
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])
  return height
}

/**
 * The ```lightbox fences inside one block of rendered Markdown, drawn as galleries — for every surface
 * that renders a worker's Markdown as ONE string of sanitized HTML rather than through the transcript's
 * splitter: the done and awaiting cards, a question's options, the `.md` reader (LinkedHtml,
 * MarkdownDrawer, FileViewerPanel). The finding and swapping is lib/fenceIslands.ts, shared with the
 * ```mermaid fence (useMermaidIslands); this names the fence and portals a LightboxGallery into each host.
 *
 * Returns the portals; render them anywhere in the host component.
 */
export function useLightboxIslands(ref: RefObject<HTMLElement | null>, html: string, baseDir?: string): ReactNode {
  const islands = useFenceIslands(ref, html, "lightbox", "md-lightbox", parseLightboxBody)
  return islands.map(({ key, host, value }) => createPortal(<LightboxGallery entries={value} baseDir={baseDir} />, host, key))
}

/**
 * The viewer, hosted ONCE per page shell beside the Toaster (routes.tsx) and driven by `store.lightbox`.
 * Mounted means open.
 */
export function LightboxHost() {
  const { lightbox } = useSnapshot(store)
  if (!lightbox) return null
  // Its own provider for the header buttons' tooltips: the /full page hosts this outside every other.
  return (
    <TooltipProvider>
      <LightboxViewer images={lightbox.images} index={lightbox.index} />
    </TooltipProvider>
  )
}

type Point = { x: number; y: number }
const ORIGIN: Point = { x: 0, y: 0 }

// What the viewer draws for the picture on screen. Keyed by its path, so paging always lands on the
// next picture at fit (`viewFor`). `pull` is a swipe in progress at fit — the picture follows the finger
// before the release pages or closes; `animate` eases a DISCRETE change (a click, a key, a button, a
// release) and is off for a live gesture, which must track the input frame for frame; `max` is the
// picture's zoom limit, known once a zoom has measured it; `panning` is a drag in progress, for the cursor.
interface ViewState {
  path: string
  zoom: ZoomState
  pull: Point
  animate: boolean
  max: number
  panning: boolean
}

const viewFor = (path: string): ViewState => ({ path, zoom: FIT, pull: ORIGIN, animate: false, max: Infinity, panning: false })

// One gesture on the stage at a time. A `press` becomes a `pan` (magnified), a `swipe` (a finger at fit)
// or nothing (a mouse at fit) once it moves; a second finger turns anything into a `pinch`.
type Gesture =
  | { kind: "press"; id: number; x: number; y: number }
  | { kind: "pan"; id: number; x: number; y: number }
  | { kind: "swipe"; id: number; x: number; y: number; axis: "x" | "y" }
  | { kind: "pinch"; start: ZoomState; mid: Point; distance: number }

// How far a press travels before it is a drag rather than a click or a tap. A finger wobbles more than a
// mouse.
const DRAG_SLOP = { mouse: 4, touch: 10 }
// A horizontal swipe this long pages; a vertical one this long closes, as it does in a phone's photos.
const PAGE_SWIPE = 48
const CLOSE_SWIPE = 96
// Two taps closer than this in time and space are a double tap.
const DOUBLE_TAP_MS = 300
const DOUBLE_TAP_PX = 40
// One press of + / − or a zoom button.
const ZOOM_STEP = 1.5
// A pinch released this close to fit settles AT fit, so a swipe pages again rather than panning 2px.
const FIT_SNAP = 1.1
const SETTLE = "transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1)"

const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

function LightboxViewer({ images, index }: { images: readonly LightboxImage[]; index: number }) {
  // On a phone the viewer takes a history entry of its own, so Back closes it and not the thread under
  // it (lib/backDismiss) — the same rule every sheet over a phone thread follows.
  useBackClosesLayer(useIsMobile(), false, closeLightbox)
  // Frizz opens this by writing store state, not through a Radix Trigger, so Radix has no element to
  // hand focus back to on close. Remember the thumbnail that opened it, as NewThreadDialog does.
  const opener = useRef(document.activeElement instanceof HTMLElement ? document.activeElement : null)
  const contentRef = useRef<HTMLDivElement>(null)
  // The stage is held in STATE as well as in a ref, because the effect that wires its native listeners
  // has to run again once it exists: Radix's portal mounts the dialog's content a render AFTER this
  // component, so on the first pass there is no stage yet, and an effect keyed on anything else never
  // learned that it had arrived — the first picture opened took no wheel at all.
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [stage, setStage] = useState<HTMLDivElement | null>(null)
  const attachStage = useCallback((el: HTMLDivElement | null) => {
    stageRef.current = el
    setStage(el)
  }, [])
  const pictureRef = useRef<HTMLImageElement>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const image = images[index]
  const path = image?.path ?? ""
  // A video plays rather than zooms: it has no picture element for the zoom to measure, so every zoom
  // path below is a no-op on one, and its gestures are the player's own (see onPointerDown).
  const video = isLightboxVideo(path)
  // A caption is drawn UNDER the picture, as it is under the picture's tile, and the picture gives up the
  // room it takes: it may be as tall as the stage less the caption, measured, so a caption that wraps to
  // a second line on a phone still sits just below the picture and never over it.
  const captionId = useId()
  const [captionEl, setCaptionEl] = useState<HTMLElement | null>(null)
  const captionHeight = useBoxHeight(captionEl)
  const reserve = image?.caption ? captionHeight : 0

  // The view lives in a ref as well as in state: pointer and wheel events arrive faster than React
  // renders, and each must build on the one before it, not on the last render's copy.
  const viewRef = useRef<ViewState>(viewFor(path))
  const [view, setViewState] = useState<ViewState>(viewRef.current)
  const current = () => (viewRef.current.path === path ? viewRef.current : viewFor(path))
  const commit = (patch: Partial<Omit<ViewState, "path">>) => {
    const next = { ...current(), ...patch }
    viewRef.current = next
    setViewState(next)
  }
  const shown = view.path === path ? view : viewFor(path)

  const pointers = useRef(new Map<number, Point>())
  const pointerType = useRef("mouse")
  const gesture = useRef<Gesture | null>(null)
  // Set when a press turned into a drag, a pinch or a double tap, so the `click` the browser fires after
  // it is not ALSO read as a click (which would zoom, or close the viewer).
  const suppressClick = useRef(false)
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null)

  // The picture's geometry, read from the DOM when a gesture needs it. Coordinates are relative to the
  // centre of the picture's FITTED layout box, which a transform does not move (lib/viewerZoom.ts).
  //
  // That box is recovered from the DRAWN box by undoing the transform the picture wears at this instant
  // — mid-ease included, since the computed transform is the animated one — rather than read from
  // `offsetWidth`/`offsetLeft`, which round to whole pixels: at 2× a rounded centre moved the pixel
  // under the cursor by up to a pixel, and further at higher magnifications.
  const geometry = (): { bounds: ZoomBounds; centre: Point; detail: number } | null => {
    const img = pictureRef.current
    const stage = stageRef.current
    if (!img || !stage || !img.naturalWidth) return null
    const drawn = img.getBoundingClientRect()
    const m = new DOMMatrixReadOnly(getComputedStyle(img).transform)
    const width = drawn.width / m.a
    const height = drawn.height / m.d
    if (!width || !height) return null
    const centre = { x: drawn.left + drawn.width / 2 - m.e, y: drawn.top + drawn.height / 2 - m.f }
    const box = stage.getBoundingClientRect()
    return {
      centre,
      bounds: {
        width,
        height,
        left: box.left - centre.x,
        right: box.right - centre.x,
        top: box.top - centre.y,
        bottom: box.bottom - centre.y,
        max: maxScale(width, img.naturalWidth),
      },
      detail: detailScale(width, img.naturalWidth),
    }
  }
  const local = (client: Point, centre: Point): Point => ({ x: client.x - centre.x, y: client.y - centre.y })

  const setZoom = (zoom: (z: ZoomState, g: NonNullable<ReturnType<typeof geometry>>) => ZoomState, animate: boolean) => {
    const g = geometry()
    if (!g) return
    commit({ zoom: zoom(current().zoom, g), animate, max: g.bounds.max })
  }
  // Fit ⇄ the picture's actual pixels, about the point that was clicked or tapped.
  const toggleZoom = (client: Point) =>
    setZoom((z, g) => (z.scale > 1 ? FIT : zoomAbout(FIT, g.detail, local(client, g.centre), g.bounds)), true)
  // A key or a button zooms about the middle of the stage, which is where the eye already is.
  const zoomBy = (factor: number) =>
    setZoom((z, g) => zoomAbout(z, factor, { x: (g.bounds.left + g.bounds.right) / 2, y: (g.bounds.top + g.bounds.bottom) / 2 }, g.bounds), true)

  // The wheel is a NATIVE listener because it must be able to preventDefault, and React registers wheel
  // listeners passive. A trackpad pinch arrives as a wheel with ctrlKey set (Chrome, Firefox, Edge), so
  // ctrl/⌘ + wheel zooms about the cursor — and without the preventDefault the browser would zoom the
  // whole page. A plain wheel or two-finger scroll moves a magnified picture.
  useEffect(() => {
    if (!stage) return
    const onWheel = (e: WheelEvent) => {
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? stage.clientHeight : 1
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        // A trackpad pinch sends a stream of small deltas and a wheel notch one large one; the clamp
        // keeps a notch to one comfortable step (×1.65) rather than a jump straight to the limit.
        const factor = Math.exp(clamp(-e.deltaY * unit * 0.01, -0.5, 0.5))
        setZoom((z, g) => zoomAbout(z, factor, local({ x: e.clientX, y: e.clientY }, g.centre), g.bounds), false)
      } else if (current().zoom.scale > 1) {
        e.preventDefault()
        setZoom((z, g) => panBy(z, -e.deltaX * unit, -e.deltaY * unit, g.bounds), false)
      }
    }
    // Safari reports a trackpad pinch as its own gesture events instead. Mobile Safari fires them too,
    // alongside the touches the pointer handlers already pinch with, so they are only read with no
    // finger down; they are always prevented, which is what stops the page zooming under the viewer.
    let gestureStart: ZoomState | null = null
    const onGesture = (e: Event) => {
      e.preventDefault()
      const g = e as Event & { scale: number; clientX: number; clientY: number }
      if (e.type === "gesturestart") gestureStart = current().zoom
      else if (e.type === "gesturechange" && gestureStart && pointers.current.size === 0) {
        const start = gestureStart
        setZoom((_, geo) => zoomAbout(start, g.scale, local({ x: g.clientX, y: g.clientY }, geo.centre), geo.bounds), false)
      }
    }
    // A stage that changes size (a phone rotated, a window resized) re-fits the picture under the zoom.
    const resized = new ResizeObserver(() => {
      if (current().zoom.scale > 1) setZoom((z, g) => clampZoom(z, g.bounds), false)
    })
    stage.addEventListener("wheel", onWheel, { passive: false })
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) stage.addEventListener(type, onGesture)
    resized.observe(stage)
    return () => {
      stage.removeEventListener("wheel", onWheel)
      for (const type of ["gesturestart", "gesturechange", "gestureend"]) stage.removeEventListener(type, onGesture)
      resized.disconnect()
    }
    // The stage and `path` are the only inputs the handlers close over that a later render can change:
    // everything else they read through refs.
  }, [stage, path])

  if (!image) return null
  const many = images.length > 1
  const zoomed = shown.zoom.scale > 1

  const onKeyDown = (e: KeyboardEvent) => {
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey
    if (e.key === "ArrowLeft") stepLightbox(-1)
    else if (e.key === "ArrowRight") stepLightbox(1)
    else if (e.key === "Home") stepLightbox(-images.length)
    else if (e.key === "End") stepLightbox(images.length)
    // Unmodified only: ⌘ + / ⌘ − stay the browser's own page zoom.
    else if (plain && (e.key === "+" || e.key === "=")) zoomBy(ZOOM_STEP)
    else if (plain && (e.key === "-" || e.key === "_")) zoomBy(1 / ZOOM_STEP)
    else if (plain && e.key === "0") commit({ zoom: FIT, animate: true })
    // Space plays and pauses wherever focus is in the viewer. On the player itself the player does that.
    else if (plain && e.key === " " && video && e.target !== videoRef.current) {
      const player = videoRef.current
      if (player?.paused) void player.play().catch(() => undefined)
      else player?.pause()
    }
    // Escape does not normally get this far: the dialog claims it on the way down and closes. But a
    // header button's open tooltip is a layer ABOVE the dialog, and then the key closes only the tooltip
    // and travels on to the page, which would unwind a drawer under a viewer that is still open.
    else if (e.key === "Escape") closeLightbox()
    else return
    e.preventDefault()
    e.stopPropagation()
  }
  // A click on the header's empty bar closes the viewer, as a click outside any dialog does.
  const dismissOnSelf = (e: MouseEvent) => {
    if (e.target === e.currentTarget) closeLightbox()
  }

  // ── the stage's gestures ──────────────────────────────────────────────────────────────────────────
  // Pointer events, so one set of handlers serves a mouse, a pen and a finger. The stage is
  // `touch-action: none`: the browser claims no pan, pinch or double-tap zoom of its own over it, so
  // every touch reaches these handlers — which is what lets a pinch zoom the PICTURE rather than the page.
  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === "mouse" && e.button !== 0) return
    // A press on a control (the paging arrows) is the control's, and so is one on a video: its timeline,
    // volume and play button are the player's, and a scrub must never turn into a swipe that pages away.
    if ((e.target as Element).closest("button, video")) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.current.size === 1) {
      pointerType.current = e.pointerType
      suppressClick.current = false
      gesture.current = { kind: "press", id: e.pointerId, x: e.clientX, y: e.clientY }
    } else if (pointers.current.size === 2) {
      const g = geometry()
      const [a, b] = [...pointers.current.values()]
      suppressClick.current = true
      lastTap.current = null
      gesture.current = g ? { kind: "pinch", start: current().zoom, mid: local(midpoint(a, b), g.centre), distance: distance(a, b) } : null
      if (current().pull !== ORIGIN) commit({ pull: ORIGIN, animate: true })
    }
  }

  const onPointerMove = (e: PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    let active = gesture.current
    if (active?.kind === "pinch") {
      const start = active
      const [a, b] = [...pointers.current.values()]
      setZoom((_, g) => pinch(start.start, start.mid, start.distance, local(midpoint(a, b), g.centre), distance(a, b), g.bounds), false)
      return
    }
    if (!active || active.id !== e.pointerId) return
    if (active.kind === "press") {
      const moved = Math.hypot(e.clientX - active.x, e.clientY - active.y)
      if (moved < (e.pointerType === "mouse" ? DRAG_SLOP.mouse : DRAG_SLOP.touch)) return
      suppressClick.current = true
      lastTap.current = null
      if (current().zoom.scale > 1) active = { kind: "pan", id: active.id, x: active.x, y: active.y }
      else if (e.pointerType !== "mouse") {
        const dx = e.clientX - active.x
        const dy = e.clientY - active.y
        active = { kind: "swipe", id: active.id, x: active.x, y: active.y, axis: Math.abs(dx) > Math.abs(dy) ? "x" : "y" }
      } else active = null // a mouse drag at fit has nothing to move
      gesture.current = active
      if (!active) return
      stageRef.current?.setPointerCapture(e.pointerId)
      if (active.kind === "pan") commit({ panning: true })
    }
    if (active.kind === "pan") {
      const dx = e.clientX - active.x
      const dy = e.clientY - active.y
      active.x = e.clientX
      active.y = e.clientY
      setZoom((z, g) => panBy(z, dx, dy, g.bounds), false)
    } else if (active.kind === "swipe") {
      const dx = e.clientX - active.x
      const dy = e.clientY - active.y
      // Past either end the picture still follows the finger, at a quarter of its travel, so a swipe
      // into the wall is answered rather than ignored.
      const edge = (dx > 0 && index === 0) || (dx < 0 && index === images.length - 1)
      commit({ pull: active.axis === "x" ? { x: edge ? dx / 4 : dx, y: 0 } : { x: 0, y: dy }, animate: false })
    }
  }

  const onPointerEnd = (e: PointerEvent) => {
    if (!pointers.current.delete(e.pointerId)) return
    const active = gesture.current
    if (active?.kind === "pinch") {
      // One finger still down carries on as a pan from where it is now; none settles the picture.
      const [rest] = [...pointers.current.entries()]
      if (current().zoom.scale < FIT_SNAP) commit({ zoom: FIT, animate: true })
      gesture.current = rest && current().zoom.scale > 1 ? { kind: "pan", id: rest[0], x: rest[1].x, y: rest[1].y } : null
      return
    }
    if (!active || active.id !== e.pointerId) return
    gesture.current = null
    const cancelled = e.type === "pointercancel"
    if (active.kind === "pan") commit({ panning: false })
    if (active.kind === "swipe") {
      const dx = e.clientX - active.x
      const dy = e.clientY - active.y
      commit({ pull: ORIGIN, animate: true })
      if (cancelled) return
      if (active.axis === "x" && Math.abs(dx) > PAGE_SWIPE) stepLightbox(dx < 0 ? 1 : -1)
      else if (active.axis === "y" && Math.abs(dy) > CLOSE_SWIPE) closeLightbox()
      return
    }
    // A finger's tap: a second one hard on the first toggles the zoom about it, the way a phone's own
    // photo viewer does. (A mouse zooms on a single click; see onStageClick.)
    if (active.kind === "press" && !cancelled && e.pointerType !== "mouse") {
      const prev = lastTap.current
      if (prev && e.timeStamp - prev.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - prev.x, e.clientY - prev.y) < DOUBLE_TAP_PX) {
        lastTap.current = null
        suppressClick.current = true
        toggleZoom({ x: e.clientX, y: e.clientY })
      } else lastTap.current = { t: e.timeStamp, x: e.clientX, y: e.clientY }
    }
  }

  // A mouse click on the picture zooms in about the cursor, and back out. Off the picture — the backdrop
  // — it closes the viewer at fit, as a click outside any dialog does, and first returns a magnified
  // picture to fit. A finger's single tap on the backdrop closes at fit too; on the picture it waits to
  // see whether it is the first of a double tap.
  const onStageClick = (e: MouseEvent) => {
    if (suppressClick.current) {
      suppressClick.current = false
      return
    }
    // The caption is the picture's, not the backdrop: a click on it, or the one that ends selecting it,
    // closes nothing.
    if ((e.target as Element).closest("button, video, [data-lightbox-caption]")) return
    const mouse = pointerType.current === "mouse"
    if (e.target === pictureRef.current) {
      if (mouse) toggleZoom({ x: e.clientX, y: e.clientY })
    } else if (current().zoom.scale > 1) {
      if (mouse) commit({ zoom: FIT, animate: true })
    } else closeLightbox()
  }

  // A vertical swipe dims the viewer as it goes, so the release that closes it is already half done.
  const fade = 1 - Math.min(Math.abs(shown.pull.y) / (CLOSE_SWIPE * 3), 0.6)

  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open) closeLightbox() }}>
      <RadixDialog.Portal>
        {/* Near-black in BOTH themes: a lightbox exists to put the picture on a neutral dark field, and
            a light-mode scrim would wash a dark screenshot out. 95% and blurred: at 90% the transcript's
            own text still read through around a narrow picture, and a light page came through as a
            muddy grey with its dark screenshots floating in it as blobs. */}
        <RadixDialog.Overlay className={`overlay-in fixed inset-0 ${Z_DIALOG} bg-black/95 backdrop-blur-md`} style={{ opacity: fade }} />
        <RadixDialog.Content
          ref={contentRef}
          data-lightbox
          aria-modal="true"
          aria-describedby={image.caption ? captionId : undefined}
          onEscapeKeyDown={handleDialogEscape}
          onOpenAutoFocus={(e) => {
            e.preventDefault()
            contentRef.current?.focus({ preventScroll: true })
          }}
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            if (opener.current?.isConnected) opener.current.focus({ preventScroll: true })
          }}
          onKeyDown={onKeyDown}
          className={`overlay-in fixed inset-0 ${Z_DIALOG} flex flex-col text-white outline-none`}
        >
          {/* The side padding clears a phone's rounded corners and notch in landscape. */}
          <header
            onClick={dismissOnSelf}
            className="flex shrink-0 items-center gap-3 pb-2 pl-[max(env(safe-area-inset-left),16px)] pr-[max(env(safe-area-inset-right),16px)] pt-[max(env(safe-area-inset-top),12px)]"
            style={{ opacity: fade }}
          >
            {/* The header names the FILE — or a picture's title, where its file name is a hash — and a
                caption is drawn under the picture instead, so nothing is said twice. */}
            <div className="min-w-0 flex-1">
              <RadixDialog.Title className={`truncate text-[13px] font-medium leading-5 text-white/90 ${image.titled ? "" : "font-mono-keep"}`}>
                {image.label}
              </RadixDialog.Title>
              <div className="truncate font-mono-keep text-[11px] leading-4 text-white/45">{image.path}</div>
            </div>
            {/* THE THREAD HEADER'S ACTION STRIP, on the viewer's field (HeaderActions; ViewerButton below):
                the same squares on the same `gap-0.5`, so the marks stand at that strip's ink rhythm.
                The negative margin pulls the last square into the header's padding, which leaves the
                close glyph's ink where a sheet's close stands from its own edge (SheetClose). */}
            <div data-lightbox-actions className="-mr-1 flex shrink-0 items-center gap-0.5 pointer-coarse:-mr-3">
              {many && (
                <span data-lightbox-counter className="mr-2.5 text-[12px] tabular-nums text-[#787a7d]">
                  {index + 1} / {images.length}
                </span>
              )}
              {/* A mouse's only way to zoom without knowing the click or the keys. A touch screen pinches
                  and double-taps, and its header has no room to spare, so a coarse pointer drops them.
                  A video does not zoom, so it has none. */}
              {!video && (
                <>
                  <ViewerButton label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)} disabled={!zoomed} className="pointer-coarse:hidden">
                    <ZoomOut size={14} strokeWidth={2} />
                  </ViewerButton>
                  <ViewerButton label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)} disabled={shown.zoom.scale >= shown.max - 1e-6} className="pointer-coarse:hidden">
                    <ZoomIn size={14} strokeWidth={2} />
                  </ViewerButton>
                </>
              )}
              <ViewerButton label="Download" onClick={() => download(image)}>
                <Download size={14} strokeWidth={2} className={TOUCH_GLYPH} />
              </ViewerButton>
              <ViewerButton label={video ? "Open in default player" : "Open in default viewer"} onClick={() => openLocalPath(image.path, true)}>
                <ExternalLink size={14} strokeWidth={2} className={TOUCH_GLYPH} />
              </ViewerButton>
              <ViewerButton label="Close" onClick={closeLightbox}>
                <X size={15} strokeWidth={2} className={TOUCH_GLYPH} />
              </ViewerButton>
            </div>
          </header>
          {/* `overflow-hidden`: a magnified picture is clipped to the stage rather than painted over the
              header, and it may fill the stage's padding too — the padding only frames the picture at fit.
              A COLUMN, so the caption stacks under the picture and the two centre as one. */}
          <div
            ref={attachStage}
            data-lightbox-stage
            onClick={onStageClick}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerEnd}
            onPointerCancel={onPointerEnd}
            // Magnified, the whole stage offers the drag — on the STAGE rather than the picture because a
            // drag captures the pointer to the stage, and a captured pointer wears its captor's cursor.
            className={`relative flex min-h-0 flex-1 flex-col items-center justify-center overflow-hidden px-3 pb-[max(env(safe-area-inset-bottom),16px)] sm:px-16 ${zoomed ? (shown.panning ? "cursor-grabbing" : "cursor-grab") : ""}`}
            style={{ touchAction: "none" }}
          >
            {video
              ? <ViewerVideo key={image.path} image={image} view={shown} reserve={reserve} videoRef={videoRef} />
              : <ViewerPicture key={image.path} image={image} view={shown} reserve={reserve} pictureRef={pictureRef} />}
            {/* It follows a swipe's pull with the picture and fades with the header; magnified, it
                steps aside, since the picture then owns the whole stage. `pt-3` is its gap from the
                picture, inside the box that is measured, so the reserve carries it too. */}
            {image.caption && (
              <p
                ref={setCaptionEl}
                id={captionId}
                data-lightbox-caption
                className={`max-w-2xl shrink-0 text-balance pt-3 text-center text-[13px] leading-5 text-white/75 ${zoomed ? "pointer-events-none" : ""}`}
                style={{
                  transform: `translate(${shown.pull.x}px, ${shown.pull.y}px)`,
                  transition: `${shown.animate ? SETTLE : "transform 0s"}, opacity 150ms ease-out`,
                  opacity: zoomed ? 0 : fade,
                }}
              >
                {image.caption}
              </p>
            )}
            {many && index > 0 && (
              <PageButton side="left" onClick={() => stepLightbox(-1)} />
            )}
            {many && index < images.length - 1 && (
              <PageButton side="right" onClick={() => stepLightbox(1)} />
            )}
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

// The file itself, from the route already showing it, through a same-origin `download` anchor, named
// for the file (lightboxFileName). It is the one way to KEEP a picture from a phone or from any browser
// but the computer's own: "Open in default viewer" opens it on the computer Frizz runs on. The anchor
// carries no `data-local-path`, so the delegated link handlers let its click through.
function download(image: LightboxImage): void {
  const anchor = document.createElement("a")
  anchor.href = localImageUrl(image.path)
  anchor.download = lightboxFileName(image)
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
}

function Unavailable({ what, path }: { what: string; path: string }) {
  return (
    <div className="pointer-events-none max-w-md text-center">
      <div className="text-[13px] text-white/70">{what} unavailable</div>
      <div className="mt-1 break-all font-mono-keep text-[11px] text-white/45">{path}</div>
    </div>
  )
}

// `reserve` is the caption's height under the picture, which the fitted picture leaves free.
const fitHeight = (reserve: number) => (reserve ? `calc(100% - ${reserve}px)` : undefined)

function ViewerPicture({ image, view, reserve, pictureRef }: { image: LightboxImage; view: ViewState; reserve: number; pictureRef: RefObject<HTMLImageElement | null> }) {
  const [broken, setBroken] = useState(false)
  if (broken) return <Unavailable what="Image" path={image.path} />
  const { scale, x, y } = view.zoom
  return (
    <img
      ref={pictureRef}
      src={localImageUrl(image.path)}
      alt={image.label}
      draggable={false}
      onError={() => setBroken(true)}
      // At fit the cursor offers the zoom; magnified, it inherits the stage's drag.
      className={`block max-h-full max-w-full select-none object-contain ${scale > 1 ? "" : "cursor-zoom-in"}`}
      style={{
        maxHeight: fitHeight(reserve),
        transform: `translate(${x + view.pull.x}px, ${y + view.pull.y}px) scale(${scale})`,
        transition: view.animate ? SETTLE : "none",
        // The hairline is the picture's edge: agent screenshots are overwhelmingly dark UI, which on a
        // near-black field has none of its own (the mat does this job in the transcript's frame). Both it
        // and the corner are drawn at 1/scale so the transform paints them at the same 1px and 6px at
        // every magnification, instead of a 4px rule and a 24px corner at 4×.
        borderRadius: 6 / scale,
        boxShadow: `0 0 0 ${1 / scale}px rgb(255 255 255 / 0.1)`,
      }}
    />
  )
}

// A video in the viewer: the browser's own player, which plays as it opens — opening it was the click
// that asked for it — and inline on a phone rather than taking the screen over. It does not zoom, and a
// swipe only pages from the backdrop around it, so its scrubber is never mistaken for a swipe. It
// follows a swipe's pull like a picture does, and wears the picture's hairline edge for the same reason.
function ViewerVideo({ image, view, reserve, videoRef }: { image: LightboxImage; view: ViewState; reserve: number; videoRef: RefObject<HTMLVideoElement | null> }) {
  const [broken, setBroken] = useState(false)
  if (broken) return <Unavailable what="Video" path={image.path} />
  return (
    <video
      ref={videoRef}
      src={localImageUrl(image.path)}
      aria-label={image.label}
      controls
      autoPlay
      playsInline
      preload="auto"
      onError={() => setBroken(true)}
      className="block max-h-full max-w-full rounded-md bg-black"
      style={{
        maxHeight: fitHeight(reserve),
        transform: `translate(${view.pull.x}px, ${view.pull.y}px)`,
        transition: view.animate ? SETTLE : "none",
        boxShadow: "0 0 0 1px rgb(255 255 255 / 0.1)",
      }}
    />
  )
}

// THE HEADER BUTTONS ARE THE THREAD HEADER'S ICON CONTROLS (lib/headerIcon.ts, HeaderActions): the same
// 28px square and corner, the same glyphs — 14px at lucide's stock stroke, the X at the 15px every sheet
// closes with — the same hover edge and the same immediate tooltip. They were a family of their own
// until 2026-10-11 (16px and 18px glyphs on a pinned 1.5px pen in 36px squares, trimmed to 16px of ink
// apart), which a reader coming off a queue card met as a second, larger and heavier icon set
// (maintainer: "We need to have consistent visual language").
//
// Only the TONES are spelled here, because the viewer is near-black in both themes and the strip's are
// theme tokens. They are the dark palette's, moved onto black: at rest `muted` less the `panel` it sits
// on (#787a7d), so a glyph stands off the black field by exactly what it stands off a card; `fg` under
// the pointer, on the palette's own hover wash.
//
// OPAQUE, NEVER `text-white/50`. Lucide draws every stroke as its own path, so a translucent colour
// composites twice wherever two strokes cross: at 50% the X's centre and the magnifier's plus painted
// 75% white — a bright knot on each mark, a peak contrast of 572 against the card's 367 (2026-10-11).
//
// The focus ring stays the viewer's own: a key is how half of this dialog is driven, and the strip's
// hover edge is too quiet to say where focus is.
//
// Measured with scripts/ink-gaps.mjs on the real viewer (dsf 4, sans, 2026-10-11), counter to close:
// 20.28 / 18 / 18 / 20px of ink, inside the 18.25–20.75px the card's strip keeps, and the close glyph's
// ink 21px from the window edge, where a sheet's close stands 21.75px from its own (SheetClose). With
// Download added (2026-10-21), zoom out to close reads 18 / 18 / 18 / 20px, and Download's mean contrast
// 280 sits with its neighbours' 299.
const VIEWER_ICON_ON = "icon-focus-outline text-[#787a7d] transition-colors hover:bg-white/[0.04] hover:text-[#e6e7e9]"
// The strip's `disabled:opacity-40`, as a tone (40% of the rest tone's lift off black): an opacity
// would fade the focus ring with the glyph.
const VIEWER_ICON_OFF = "cursor-default text-[#303132]"
// A TOUCH SCREEN DRAWS THE PHONE HEADER'S MARKS, since that is the header it opens over
// (MobileThreadHeader): 21px glyphs at a 2.1 stroke, at its `fg/90`, in 44px round targets. Lucide
// sizes a glyph by attribute, which no media query can reach, so the class sizes it there instead.
const VIEWER_ICON_TOUCH = "pointer-coarse:size-11 pointer-coarse:rounded-full pointer-coarse:text-[#cfd0d2]"
const TOUCH_GLYPH = "pointer-coarse:size-[21px] pointer-coarse:[stroke-width:2.1]"

// `disabled` is ARIA-only. A zoom button reaches its limit WHILE focused — the press that lands on 4×
// is the one that disables Zoom in — and a natively disabled button drops focus to the page body, out of
// the dialog, where the arrow and zoom keys no longer reach the viewer. So it stays focusable, says it
// is unavailable, and ignores the press.
function ViewerButton({ label, onClick, disabled, className = "", children }: {
  label: string
  onClick: () => void
  disabled?: boolean
  className?: string
  children: ReactNode
}) {
  return (
    // Under the header, never over it: the strip sits at the top of the window.
    <Tooltip label={label} side="bottom">
      <button
        type="button"
        aria-label={label}
        aria-disabled={disabled || undefined}
        onClick={() => { if (!disabled) onClick() }}
        className={`${HEADER_ICON_SQUARE} focus-visible:ring-1 focus-visible:ring-white/60 ${disabled ? VIEWER_ICON_OFF : VIEWER_ICON_ON} ${VIEWER_ICON_TOUCH} ${className}`}
      >
        {children}
      </button>
    </Tooltip>
  )
}

// The two marks that ride a dark chip over a picture — the paging arrows and a video tile's play mark —
// draw with one PAINTED pen. Lucide scales its stroke with the icon, so on its stock stroke the 20px
// arrow would paint 1.67px against the 14px play mark's 1.17px; `absoluteStrokeWidth` pins the painted
// width instead. The header's buttons are not part of this: they are the thread header's strip, and
// draw its stroke (ViewerButton).
const CHIP_PEN = 1.5

// The side arrows are for a mouse. On a touch screen the picture fills the width, so they would sit on
// top of it, and a swipe already pages (the stage's pointer handlers) — so a coarse pointer drops them.
// A DARK chip with a hairline: at fit an arrow sits on the near-black field, but a magnified picture
// fills the stage behind it, and the light chip it had vanished against a bright screenshot.
function PageButton({ side, onClick }: { side: "left" | "right"; onClick: () => void }) {
  const Icon = side === "left" ? ChevronLeft : ChevronRight
  return (
    <button
      type="button"
      data-lightbox-page={side}
      aria-label={side === "left" ? "Previous image" : "Next image"}
      onClick={onClick}
      className={`absolute top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full bg-black/55 text-white/85 outline-none ring-1 ring-white/15 backdrop-blur-sm transition-colors hover:bg-black/75 hover:text-white focus-visible:ring-white/60 pointer-coarse:hidden ${
        side === "left" ? "left-3" : "right-3"
      }`}
    >
      <Icon size={20} strokeWidth={CHIP_PEN} absoluteStrokeWidth />
    </button>
  )
}
