// THE MACHINE'S HOME PAGE: every project Frizz knows about as one icon, and a way to add another.
//
// It renders at `/` and nothing else; a project's own board lives at `/project/<slug>`, which is what
// freed the root. The tooltip provider is NOT here — it belongs to the layout route that stays mounted
// across a navigation (routes.tsx), as does the rail, which that layout hides on this page because the
// grid is the rail drawn larger.
//
// A HOME SCREEN, not a list of cards (maintainer 2026-11-03, choosing it from six mockups): the project's
// square at 64px with its badge, and its name. The cards it replaced also showed each project's path, slug
// and when it was last opened; the path is the tile's tooltip now, and the rest is in the rename dialog or
// nowhere. A Projects | Console pill headed the page until 2026-11-10 (maintainer: "we just drop the entire
// tab switcher between console and the projects page"); the way to the Console is the All projects tile
// beside "Add a project" (AllProjectsTile), once there is more than one project for it to gather.
//
// It draws from the registry index and the rail's counts — one file read and one cheap poll, no
// databases opened. Answering a list request by opening forty projects is exactly the cost lazy
// activation exists to avoid. (The server does open them all in the background about a second after
// boot — server/tenant-prime.ts — but on its own clock, never on a request's.)
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react"
import { Ellipsis, ImagePlus, Loader2, Pencil, Plus, RotateCcw, Settings as SettingsIcon, Trash2 } from "lucide-react"
import { Link, useNavigate } from "react-router"
import { useSnapshot } from "valtio"
import { slugify, type ProjectCard, type ProjectRailCounts } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { CONSOLE_PATH, projectHref } from "../lib/base-path.ts"
import { useIsMobile } from "../lib/mobile.ts"
import { showToast, store } from "../store.ts"
import { AddProjectDialog } from "./AddProjectDialog.tsx"
import { Dialog } from "./ui/Dialog.tsx"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "./ui/Menu.tsx"
import { ProjectSquare, projectSquareLabel, railCountsLabel, useProjectIconChange, warmProjectPicker } from "./ProjectRail.tsx"
import { Tooltip } from "./Tooltip.tsx"
import { SettingsDrawer } from "./SettingsDrawer.tsx"

/**
 * The mark, at the size where it is legible AS a mark.
 *
 * Measured against the shipped favicon at 40 / 56 / 76 / 96: it is five fibers pulling loose from a
 * wrapped bundle, and below ~70px the strands collapse into a silhouette that reads as a HAND. 76 is
 * the first size where the bundle's wrap and the gaps between strands both survive.
 */
const MARK_PX = 76

/** `/Users/me/code/nub` → `~/code/nub`. The home prefix is noise on every row. */
function shortPath(path: string, home: string | undefined): string {
  return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

// The empty page's "Add a project" card: the one card left on this page, drawn only on an empty machine.
const CARD_BASE =
  "flex flex-col gap-1 rounded-lg border px-3 py-2.5 outline-none transition-colors focus-visible:ring-1 focus-visible:ring-focus-ink-60"

/** The phone list's icon, the rail's square at list-row size. */
const CARD_ICON = 34

/** A tile's square: the rail's square at the size where a project's own logo reads as one. */
const TILE_ICON = 64

/**
 * A tile's width. The name row inside it keeps 18px a side for the ⋯ trigger and its counterweight
 * (TileName), so a name truncates at 76px — "pullfrog-app" fits. Eight tiles and their 8px gaps fill the
 * grid's 952px cap; the mockup's 104px tiles left a name 60px, which cut "frizz-cloud" short.
 */
const TILE_PX = 112

/** The tile badge's width per digit count, a whole-pixel pill: round at one digit, 6px longer per digit after. */
function tileBadgeWidth(count: number): number {
  return count < 10 ? 20 : count < 100 ? 26 : 32
}

/**
 * The project's badge: how many of its threads are in play — waiting on the human (the queue) PLUS in
 * flight — with a spinner lapping it while any are in flight.
 *
 * ON THE SQUARE'S BOTTOM-RIGHT CORNER, overlapping it — Discord's placement, and the rail's (maintainer
 * 2026-11-03: "It should be in the bottom-right corner, like in the project sidebar"). It sat top-right,
 * the phone home screen's corner, until then. 6px past the square's edges, the rail's 5px of a 16px
 * badge scaled to this 20px one, so the same share of the badge hangs off the square.
 *
 * ONE MARK FOR BOTH, issue #41's badge (maintainer 2026-09-24: "the number inside the yellow dot should
 * be the sum"), which the rail wore until 2026-10-11, when it went back to the queue alone. The home
 * screen drew the queue here and a "N working" line under the name until the maintainer asked for this
 * badge instead (2026-11-03: "I don't know why that would exist in addition to the badge … We should
 * just have that same thing again"). A badge with no ring is purely a queue count; the ring is what tells
 * work in flight from work waiting at a glance. The tile's tooltip splits the sum.
 *
 * THE CUT-OUT AND THE RING. The face's 2px `ring-bg` box-shadow is the cut-out that makes it read as
 * sitting ON the square, and it is also the gap to the running ring: `.frizz-tile-badge-ring` is a disc
 * 4px outside the face, under it, so the face and its cut-out cover all but its outer 2px — a circle
 * round one digit, a pill round two. Whole pixels throughout, so nothing here lands on the half-pixel
 * Chrome snaps box edges to; the rail's version (1.25px of ring at 16px) needed a scale and a 0.5px
 * shadow to get its fractions (629d4f76 has it). The wrapper sizes to the face, so the ring follows a
 * two-digit badge into a pill without measuring anything.
 */
function TileBadge({ queued, running }: { queued: number; running: number }) {
  const count = queued + running
  return (
    <span
      aria-label={railCountsLabel(queued, running)}
      data-home-tile-count={count}
      data-home-tile-running={running || undefined}
      className="pointer-events-none absolute -bottom-1.5 -right-1.5 flex"
    >
      {running ? <span aria-hidden className="frizz-tile-badge-ring absolute -inset-1 rounded-full text-accent-fill" /> : null}
      <span
        className="relative flex h-5 items-center justify-center rounded-full bg-accent-fill text-[12px] font-semibold leading-none proportional-nums text-on-accent ring-2 ring-bg"
        style={{ width: tileBadgeWidth(count) }}
      >
        {/* The cap band, not the line box, for the reason the rail's badge gives. */}
        <span style={{ textBox: "trim-both cap alphabetic" } as CSSProperties}>{count}</span>
      </span>
    </span>
  )
}

/**
 * One project on the home screen.
 *
 * THE NAME IS THE LINK, AND ITS `::after` IS THE TILE: an absolutely-placed pseudo-element covering the
 * whole cell, so the square and the name are one click target — while the ⋯ trigger,
 * which cannot sit inside an <a> (a button nested in a link is invalid, and a click on it would
 * navigate), is a sibling lifted above that cover. The link's `truncate` does not clip the cover: an
 * absolute box is clipped only by an overflow on its containing block's side of the tree, and the cover's
 * containing block is the cell.
 */
function ProjectTile({ project, counts, home }: { project: ProjectCard; counts: ProjectRailCounts | undefined; home: string | undefined }) {
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const icon = useProjectIconChange(project)
  const queued = counts?.queued ?? 0
  const running = counts?.running ?? 0
  return (
    <div data-home-tile={project.slug} className="group/tile relative flex flex-col items-center pb-1 pt-1.5" style={{ width: TILE_PX }}>
      {/* THE SQUARE CARRIES THE RAIL'S TOOLTIP (projectSquareLabel): the project's name and what it has in
          play, open the moment the pointer is on it, as on the rail. So the square is a link of its OWN,
          lifted above the name's cover (TileName), because a tooltip opens on the element under the
          pointer and the cover would otherwise be that element. Kept out of the tab order and from
          assistive tech: the name is the tile's one link, and the badge says its count in words. */}
      <Tooltip side="top" label={projectSquareLabel(project, queued, running)}>
        <Link
          to={projectHref(project.slug)}
          tabIndex={-1}
          aria-hidden
          data-home-tile-square
          className="relative z-[1] block outline-none"
        >
          {/* The lift is the hover, not a fill: a fill behind the square would show around the badge's
              cut-out in a colour the ring is not. */}
          <span className="relative block transition-transform duration-150 ease-out group-hover/tile:-translate-y-[3px]">
            <span
              className={`block rounded-[30%] shadow-[0_6px_18px_-6px] shadow-shadow-ink/70 group-has-[a:focus-visible]/tile:ring-2 group-has-[a:focus-visible]/tile:ring-focus-ink-60 group-has-[a:focus-visible]/tile:ring-offset-2 group-has-[a:focus-visible]/tile:ring-offset-bg ${
                project.stale ? "opacity-60 grayscale" : ""
              }`}
            >
              <ProjectSquare project={project} size={TILE_ICON} />
            </span>
            {queued + running > 0 ? <TileBadge queued={queued} running={running} /> : null}
          </span>
        </Link>
      </Tooltip>
      <TileName
        project={project}
        // The square has the rail's tooltip; the name's native one, after the browser's delay, is for a
        // name cut short and for where the project lives.
        title={`${project.name}\n${shortPath(project.path, home)}`}
        menu={
          <Menu onOpenChange={(open) => { if (open) icon.warm() }}>
            <MenuTrigger asChild>
              <button
                type="button"
                aria-label={`More actions for ${project.name}`}
                // 14px of layout, 24px of target: the `before` box reaches 5px past each edge, so the
                // trigger is easy to hit without widening the gutter the name gives up for it.
                // `-mt-1`: standing on the baseline, the box reaches 14px above it and the name's line
                // only ~11.8px, so the row grew 2px and every name sat 2px below "Add a project". The
                // margin takes the box out of the row's height without moving it, since baseline
                // alignment places its border box, not its margin box.
                className="icon-focus-outline relative z-[1] -mt-1 flex size-3.5 shrink-0 translate-y-[calc(7px_-_0.5ex)] items-center justify-center rounded text-muted opacity-0 outline-none transition-opacity before:absolute before:-inset-[5px] before:content-[''] hover:bg-hover-strong hover:text-fg focus-visible:opacity-100 group-hover/tile:opacity-100 data-[state=open]:bg-hover-strong data-[state=open]:text-fg data-[state=open]:opacity-100"
              >
                <Ellipsis size={14} className="block" />
              </button>
            </MenuTrigger>
            <MenuContent align="start">
              <MenuItem icon={<ImagePlus size={13} />} onSelect={icon.choose}>
                {icon.uploading ? "Uploading…" : "Choose an icon…"}
              </MenuItem>
              <MenuItem icon={<RotateCcw size={13} />} onSelect={icon.reset}>
                {icon.resetLabel}
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={<Pencil size={13} />} onSelect={() => setRenaming(true)}>
                Rename…
              </MenuItem>
              <MenuItem icon={<Trash2 size={13} />} danger onSelect={() => setConfirmingDelete(true)}>
                Delete project…
              </MenuItem>
            </MenuContent>
          </Menu>
        }
      />
      {/* Only a missing folder takes a line here; every other state is the badge's. */}
      {project.stale ? <span className="mt-1 max-w-full truncate text-[11px] leading-[13px] text-muted">Folder is missing</span> : null}
      {icon.fileInput}
      {renaming ? <RenameProjectDialog project={project} home={home} onClose={() => setRenaming(false)} /> : null}
      {confirmingDelete ? <DeleteProjectDialog project={project} home={home} onClose={() => setConfirmingDelete(false)} /> : null}
    </div>
  )
}

/**
 * The name, with the project's menu to its LEFT (maintainer 2026-11-03: "put a three-dot menu to the
 * left of each project name").
 *
 * THE NAME STAYS CENTRED UNDER ITS SQUARE: the trigger takes 14px of the row and an empty span the same
 * 14px on the other side, so the pair balances and the name's centre is the square's (0.25px off,
 * measured 2026-11-03). The trigger is revealed by the TILE's hover, and stays lit while its menu is open
 * or it holds keyboard focus; the space is reserved either way, because a name that slid sideways as the
 * pointer arrived would read as the tile flinching.
 *
 * THE GAP IS 4px OF BOX. The ellipsis paints 9.33px of its 14px, so that is ~6.7px of ink to the name, and
 * the trigger's fill, lit while its menu is open, stops 4px short of the first letter. At 2px of box the
 * fill all but touched the name.
 *
 * THE DOTS SIT ON THE NAME'S X-HEIGHT CENTRE, not its cap band: they are a midline ellipsis, drawn where a
 * typeset `⋯` sits, and the names beside them are lowercase repository names far more often than not
 * (at the cap band's centre they rode 1px high of "frizz"). `items-baseline` stands the trigger on the
 * name's baseline — the SVG is its only content and a replaced element's baseline is its bottom edge, so
 * the 14px box's bottom is the baseline — and `translate-y-[calc(7px_-_0.5ex)]` drops the box's centre,
 * where the dots are drawn, onto the x-height's. The browser computes `ex` from the font, so it holds at
 * any size.
 */
function TileName({ project, title, menu }: { project: ProjectCard; title: string; menu: ReactNode }) {
  return (
    // `mt-3`: the badge hangs off the square's bottom-right corner, 6px below it and its running ring 10px,
    // over the right of a long name. At `mt-2` the ring came 1.1px from the name's ascenders (measured
    // 2026-11-03); 12px leaves it ~5px, and the face ~9px.
    <span className="mt-3 flex max-w-full items-baseline gap-1 text-[12px] leading-[15px]">
      {menu}
      <Link
        to={projectHref(project.slug)}
        title={title}
        className="min-w-0 truncate text-fg/90 outline-none after:absolute after:inset-0 after:rounded-2xl after:content-[''] group-hover/tile:text-fg"
      >
        {project.name}
      </Link>
      <span aria-hidden className="w-3.5 shrink-0" />
    </span>
  )
}

/** The first tile: a dashed square that opens the folder picker. FIRST, so it is always in the upper-left
 *  cell — after the projects it sat wherever the list happened to end (maintainer 2026-10-10: "move the
 *  Add a project card to the upper left"). */
function AddTile({ pending, onClick }: { pending: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      data-home-add
      // The picker is built while the pointer is on its way to the click — see warmProjectPicker.
      onPointerEnter={warmProjectPicker}
      onFocus={warmProjectPicker}
      onClick={onClick}
      disabled={pending}
      className="group/tile flex flex-col items-center pb-1 pt-1.5 outline-none"
      style={{ width: TILE_PX }}
    >
      <span
        className="flex items-center justify-center rounded-[30%] border border-dashed border-border-strong text-muted-70 transition-[colors,transform] duration-150 ease-out group-hover/tile:-translate-y-[3px] group-hover/tile:border-accent group-hover/tile:text-fg group-focus-visible/tile:ring-2 group-focus-visible/tile:ring-focus-ink-60 group-focus-visible/tile:ring-offset-2 group-focus-visible/tile:ring-offset-bg"
        style={{ width: TILE_ICON, height: TILE_ICON }}
      >
        {pending ? <Loader2 size={20} className="animate-spin" /> : <Plus size={22} strokeWidth={1.6} />}
      </span>
      <span className="mt-3 max-w-full truncate text-[12px] leading-[15px] text-muted group-hover/tile:text-fg">
        {pending ? "Choosing a folder…" : "Add a project"}
      </span>
    </button>
  )
}

/** How many projects the All projects folder shows, two by two. */
const FOLDER_PROJECTS = 4

/**
 * The folder's insides: a 1px border, 6px in from it, and 22px icons 6px apart — 1 + 6 + 22 + 6 + 22 + 6 + 1
 * is the 64px square, so the gap between icons matches the margin round them.
 */
const FOLDER_ICON = 22
const FOLDER_INSET = 6
const FOLDER_GAP = 6

/**
 * THE WAY TO THE CONSOLE: a tile of its own, second after "Add a project", named "All projects"
 * (maintainer 2026-11-11, choosing it from five mockups; the line it replaced, "Console · every project's
 * queue on one page", "doesn't even really look like a button"). It sits in the first row however many
 * projects follow, and it reads as clickable for the reason its neighbours do: same square, same lift,
 * same badge.
 *
 * THE SQUARE IS A FOLDER of the busiest projects' own icons, a phone home screen's folder: the projects it
 * gathers, so it is never mistaken for one of them. Busiest by what the badge counts; a tie keeps the
 * grid's order, and a missing folder is left out, since its greyed square is not one to open.
 *
 * THE BADGE IS THE SUM OF THE BADGES AROUND IT, waiting plus running, with the ring while anything runs —
 * the tile badge's own rule, so it reads as the total of what the eye has just added up. The line counted
 * the queue alone; the tooltip still splits the two.
 *
 * Drawn only with two projects or more: with one, the Console is that project's board again. No ⋯ menu,
 * since there is nothing to rename or delete, so the name is centred on its own.
 */
function AllProjectsTile({ projects, counts }: { projects: readonly ProjectCard[]; counts: Record<string, ProjectRailCounts> | undefined }) {
  let queued = 0
  let running = 0
  for (const c of Object.values(counts ?? {})) {
    queued += c.queued
    running += c.running
  }
  const inPlay = (p: ProjectCard) => (counts?.[p.id]?.queued ?? 0) + (counts?.[p.id]?.running ?? 0)
  const shown = projects.filter((p) => !p.stale).sort((a, b) => inPlay(b) - inPlay(a)).slice(0, FOLDER_PROJECTS)
  const split = railCountsLabel(queued, running)
  return (
    <Tooltip side="top" label={split ? `All projects — ${split}` : "All projects"}>
      <Link
        to={CONSOLE_PATH}
        data-home-console
        className="group/tile flex flex-col items-center pb-1 pt-1.5 outline-none"
        style={{ width: TILE_PX }}
      >
        <span className="relative block transition-transform duration-150 ease-out group-hover/tile:-translate-y-[3px]">
          <span
            aria-hidden
            data-home-console-folder
            className="grid content-start rounded-[30%] border border-border bg-elevated shadow-[0_6px_18px_-6px] shadow-shadow-ink/70 group-focus-visible/tile:ring-2 group-focus-visible/tile:ring-focus-ink-60 group-focus-visible/tile:ring-offset-2 group-focus-visible/tile:ring-offset-bg"
            style={{ width: TILE_ICON, height: TILE_ICON, padding: FOLDER_INSET, gap: FOLDER_GAP, gridTemplateColumns: `repeat(2, ${FOLDER_ICON}px)` }}
          >
            {shown.map((project) => (
              <ProjectSquare key={project.id} project={project} size={FOLDER_ICON} />
            ))}
          </span>
          {queued + running > 0 ? <TileBadge queued={queued} running={running} /> : null}
        </span>
        <span data-home-console-name className="mt-3 max-w-full truncate text-[12px] leading-[15px] text-fg/90 group-hover/tile:text-fg">
          All projects
        </span>
      </Link>
    </Tooltip>
  )
}

/** The last path segment, on either separator: the registry stores native paths and Windows uses `\\`. */
function folderName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).pop() ?? path
}

/**
 * Rename a project.
 *
 * ONE FIELD, AND IT RENAMES TWO THINGS: the name on the card and the slug in the URL, because a project
 * whose card says one thing and whose address says another is what this dialog exists to fix (a
 * checkout renamed in the terminal keeps its old slug — `deriveSlug` never re-derives, by design — so
 * `porg` was still answering on `/project/hypergres`). The URL it will get is shown before saving.
 *
 * THE FOLDER IS NOT TOUCHED BY DEFAULT. The checkbox appears only when the folder is already named
 * after the project, so the offer reads "keep these in step" and never "move your directory": a folder
 * called something else was named deliberately, and this is not the place to second-guess it.
 */
function RenameProjectDialog({
  project,
  home,
  onClose,
}: {
  project: ProjectCard
  home: string | undefined
  onClose: () => void
}) {
  const [name, setName] = useState(project.name)
  const [renameDirectory, setRenameDirectory] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const queryClient = useQueryClient()
  const rename = useMutation({
    mutationFn: () => rpc.projectRename({ id: project.id, name: name.trim(), renameDirectory }),
    onSuccess: (updated) => {
      void queryClient.invalidateQueries({ queryKey: ["projectsList"] })
      showToast(`Renamed ${project.name} to ${updated.name}`)
      onClose()
    },
  })
  const error = rename.error instanceof Error ? rename.error.message : rename.error ? String(rename.error) : null
  const trimmed = name.trim()
  const folder = folderName(project.path)
  const parent = project.path.slice(0, project.path.length - folder.length)
  // Offered only when the folder already tracks the name AND the new name would leave it behind.
  const offerFolder = folder === project.name && trimmed.length > 0 && trimmed !== folder
  const slug = slugify(trimmed)

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open && !rename.isPending) onClose() }}
      title={`Rename ${project.name}`}
      className="w-[440px] max-w-[92vw]"
      // The field, selected, so typing replaces the name — the header's Close button is what Radix
      // would focus otherwise, and a rename dialog that opens with nothing to type into is a click short.
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
      }}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={rename.isPending}
            className="button-outline rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
          >
            Cancel
          </button>
          <button
            type="submit"
            form="rename-project"
            disabled={rename.isPending || trimmed.length === 0}
            className="flex items-center gap-1.5 rounded-md border border-accent-fill bg-accent-fill px-3 py-1.5 text-[12.5px] font-medium text-on-accent outline-none hover:brightness-110 focus-visible:ring-1 focus-visible:ring-focus-accent-60 disabled:opacity-50"
          >
            {rename.isPending && <Loader2 size={12} className="animate-spin" />}
            {offerFolder && renameDirectory ? "Rename project and folder" : "Rename project"}
          </button>
        </>
      }
    >
      <form
        id="rename-project"
        onSubmit={(event) => {
          event.preventDefault()
          if (!rename.isPending && trimmed.length > 0) rename.mutate()
        }}
        className="flex flex-col gap-3 p-4 text-[12.5px] leading-relaxed text-muted"
      >
        <input
          ref={inputRef}
          value={name}
          onChange={(event) => setName(event.target.value)}
          spellCheck={false}
          aria-label="Project name"
          className={`w-full rounded-md border bg-bg px-2.5 py-2 text-[12.5px] text-fg outline-none placeholder:text-muted-50 focus-visible:ring-1 focus-visible:ring-focus-accent-60 ${
            error ? "border-danger-fill/60" : "border-border-strong"
          }`}
        />
        <p>
          Its address becomes{" "}
          <span className="font-mono text-[11.5px] text-fg/80">/project/{slug}</span>
          {slug !== project.slug ? <> — links to <span className="font-mono text-[11.5px]">/project/{project.slug}</span> stop working.</> : "."}
        </p>
        {offerFolder ? (
          <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-bg/30 px-2.5 py-2 text-fg/85">
            <input
              type="checkbox"
              checked={renameDirectory}
              onChange={(event) => setRenameDirectory(event.target.checked)}
              // Same cap-band correction as the delete dialog's checkbox — see the readings there.
              className="mt-[3px] accent-[var(--color-accent)]"
            />
            <span className="flex flex-col gap-0.5">
              <span>Also rename the folder</span>
              <span className="text-[11.5px] text-muted-80">
                {renameDirectory
                  ? <><span className="font-mono text-[11px]">{shortPath(project.path, home)}</span> becomes <span className="font-mono text-[11px]">{shortPath(parent + trimmed, home)}</span>. Running workers keep going.</>
                  : "Left off, the folder keeps its name and only what Frizz calls it changes."}
              </span>
            </span>
          </label>
        ) : null}
        {error ? <p className="text-[11.5px] text-danger">{error}</p> : null}
      </form>
    </Dialog>
  )
}

/**
 * The confirmation, and the one place the two levels of "delete" are spelled out.
 *
 * THE FOLDER IS NEVER TOUCHED, and saying so is the dialog's first job: "delete" beside a card that
 * shows a path reads as "delete that directory" until something says otherwise. The second job is the
 * checkbox, which is the whole difference between an act that is undone by adding the folder again and
 * one that is not undone at all.
 */
function DeleteProjectDialog({
  project,
  home,
  onClose,
}: {
  project: ProjectCard
  home: string | undefined
  onClose: () => void
}) {
  const [deleteData, setDeleteData] = useState(false)
  const queryClient = useQueryClient()
  const remove = useMutation({
    mutationFn: () => rpc.projectRemove({ id: project.id, deleteData }),
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: ["projectsList"] })
      // The worker count is the part the operator could not have known they were asking for, so it is
      // reported rather than folded into a generic success.
      showToast(
        result.stoppedWorkers > 0
          ? `Deleted ${project.name} — ${result.stoppedWorkers} ${result.stoppedWorkers === 1 ? "worker" : "workers"} stopped`
          : `Deleted ${project.name}`,
      )
      onClose()
    },
  })
  const error = remove.error instanceof Error ? remove.error.message : remove.error ? String(remove.error) : null

  return (
    <Dialog
      open
      onOpenChange={(open) => { if (!open && !remove.isPending) onClose() }}
      title={`Delete ${project.name}?`}
      className="w-[440px] max-w-[92vw]"
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={remove.isPending}
            className="button-outline rounded-md px-3 py-1.5 text-[12px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg disabled:opacity-45"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => remove.mutate()}
            disabled={remove.isPending}
            className="button-outline flex items-center gap-1.5 rounded-md bg-danger-button/90 px-3 py-1.5 text-[12.5px] font-medium text-white outline-none transition-opacity hover:opacity-90 disabled:opacity-60"
          >
            {remove.isPending && <Loader2 size={12} className="animate-spin" />}
            {deleteData ? "Delete project and threads" : "Delete project"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-4 text-[12.5px] leading-relaxed text-muted">
        <p>
          Frizz forgets this project. The folder itself is not touched — nothing inside{" "}
          <span className="font-mono text-[11.5px] text-fg/80">{shortPath(project.path, home)}</span> is
          changed or removed.
        </p>
        <label className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-bg/30 px-2.5 py-2 text-fg/85">
          <input
            type="checkbox"
            checked={deleteData}
            onChange={(event) => setDeleteData(event.target.checked)}
            // `mt-[3px]` sets the 13px box on the first line's CAP BAND rather than its line box — the
            // same ink-over-box correction every mark beside text here gets. Measured 2026-08-26
            // against a `1cap` probe on the label's own baseline, with the inline body font cleared so
            // both settings are really exercised: 0.48px low in mono, 0.10px high in sans. Both are
            // inside the instrument's ±0.75px floor, so there is nothing left to correct.
            className="mt-[3px] accent-[var(--color-accent)]"
          />
          <span className="flex flex-col gap-0.5">
            <span>Also delete its threads and history</span>
            <span className="text-[11.5px] text-muted-80">
              {deleteData
                ? "Everything Frizz has stored for this project, and any workers still running are stopped. This cannot be undone."
                : "Left off, its threads are kept — adding the folder again brings the board back."}
            </span>
          </span>
        </label>
        {error ? <p className="text-[11.5px] text-danger">{error}</p> : null}
      </div>
    </Dialog>
  )
}

/**
 * The empty machine's one card: what the page is for, before there is a project to show.
 *
 * Dashed and never filled, like the home screen's Add tile, because it is an affordance, not a project.
 */
function PhantomCard({
  hero,
  pending,
  onClick,
}: {
  hero?: boolean
  pending?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      // The picker is built while the pointer is on its way to the click — see warmProjectPicker.
      onPointerEnter={warmProjectPicker}
      onFocus={warmProjectPicker}
      onClick={onClick}
      disabled={pending}
      className={`${CARD_BASE} items-center justify-center gap-1.5 border-dashed border-border-strong bg-transparent text-muted hover:border-accent hover:text-fg ${
        hero ? "min-h-[118px]" : "min-h-[74px]"
      }`}
    >
      <span className="text-[17px] leading-none text-muted-70">+</span>
      <span className="text-[12.5px]">{pending ? "Choosing a folder…" : "Add a project"}</span>
      {hero ? (
        <span className="text-[11px] text-muted-70">Point Frizz at a folder on this machine</span>
      ) : null}
    </button>
  )
}

/**
 * THE PHONE'S PROJECTS PAGE — a plain list, one row per project (phone design 2026-09-30, § 6).
 *
 * The board's ← comes here, so each row answers "where should I go": the project's own square (the
 * grid's icon, a monogram when it has none), its name, its path, and at the right the project's queue in
 * the accent and its Active band in muted. Adding, renaming and removing a project stay on the desktop —
 * the list has no menus, and the phantom "Add a project" card does not render.
 *
 * THE COUNTS RIDE THE DESKTOP RAIL'S QUERY (`projectsRailCounts`, the same key the rail polls), but the
 * accent number is `asks`, not the rail's `queued`: the threads waiting on a human answer, counted with
 * `boardAskThread` — the rule behind the board header's "3 need you" — so tapping a row lands on a board
 * whose header repeats it. `queued` would also count rested handoffs that ask nothing, and the accent
 * means "awaiting you". `running` is the Active band, as on the rail.
 *
 * The gear opens Settings, which is mounted HERE on this page: the board's <App/> is what normally hosts
 * it, and <App/> does not render on `/`.
 */
function MobileProjectList({ projects, home }: { projects: readonly ProjectCard[]; home: string | undefined }) {
  const { showSettings } = useSnapshot(store)
  const counts = useQuery({
    queryKey: ["projectsRailCounts"],
    queryFn: () => rpc.projectsRailCounts(),
    refetchInterval: 5_000,
  })
  return (
    <div data-mobile-projects-page className="min-h-dvh bg-bg">
      <header className="sticky top-0 z-10 border-b border-border/70 bg-bg pt-[env(safe-area-inset-top)]">
        <div className="flex h-[56px] items-center pl-[18px] pr-[5px]">
          <h1 className="m-0 min-w-0 flex-1 truncate text-[16.5px] font-semibold tracking-[-0.01em] text-fg">Projects</h1>
          <button
            aria-label="Settings"
            data-mobile-settings
            onClick={() => (store.showSettings = true)}
            className="flex size-[44px] shrink-0 items-center justify-center rounded-full text-fg/85 active:bg-hover-strong"
          >
            <SettingsIcon size={21} strokeWidth={1.9} />
          </button>
        </div>
      </header>
      {projects.length === 0 ? (
        <p className="m-0 px-10 pt-24 text-center text-[15px] text-muted">No projects yet. Add one from Frizz on a computer.</p>
      ) : (
        <ul className="m-0 list-none p-0 pb-[env(safe-area-inset-bottom)]">
          {projects.map((project) => {
            const c = counts.data?.[project.id]
            return (
              <li key={project.id}>
                <Link
                  to={projectHref(project.slug)}
                  data-mobile-project-row={project.slug}
                  className={`flex min-h-[62px] items-center gap-3 border-b border-border/70 px-[18px] py-2 active:bg-hover ${project.stale ? "opacity-60" : ""}`}
                >
                  <span className={`shrink-0 ${project.stale ? "grayscale" : ""}`}>
                    <ProjectSquare project={project} size={CARD_ICON} />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-[15.5px] font-medium leading-[20px] text-fg">{project.name}</span>
                    <span className="truncate font-mono-keep text-[12.5px] leading-[17px] text-muted" title={project.path}>
                      {project.stale ? "Directory is missing" : shortPath(project.path, home)}
                    </span>
                  </span>
                  {c && (c.asks > 0 || c.running > 0) ? (
                    <span data-mobile-project-counts className="flex shrink-0 items-baseline gap-2.5 whitespace-nowrap text-[13px] text-muted">
                      {c.asks > 0 ? <span className="font-bold tabular-nums text-accent">{c.asks}</span> : null}
                      {c.running > 0 ? <span className="tabular-nums">{c.running} working</span> : null}
                    </span>
                  ) : null}
                </Link>
              </li>
            )
          })}
        </ul>
      )}
      {showSettings ? <SettingsDrawer /> : null}
    </div>
  )
}

export function ProjectGrid() {
  // The typed-path dialog is the FALLBACK, not the front door: it opens only when the machine has no
  // picker, or the picker failed to open and said why.
  // `?add=<dir>` is the LAUNCHER asking, not a registration: running `frizz` in an unknown folder
  // no longer adopts it, it sends you here to say yes. Read once — the answer belongs to this visit,
  // and leaving it in the URL would re-ask on every reload.
  const [proposed] = useState(() => {
    const value = new URLSearchParams(location.search).get("add") ?? undefined
    if (value) history.replaceState(null, "", location.pathname)
    return value
  })
  const [fallback, setFallback] = useState<{ reason?: string } | null>(proposed ? {} : null)
  // `?unknown=<slug>` is the SERVER saying it sent a page here rather than let it hang: `/project/<x>`
  // for a project nobody has used to render the app anyway, where every call came back 404, the board
  // never arrived, and the page sat on "connecting…" forever (index.ts `unknownProjectPage`). A URL
  // that silently turns into the picker reads as Frizz having swallowed it, so say what happened. Read
  // once and stripped, exactly like `?add=` above — it belongs to this arrival, not to the address.
  useEffect(() => {
    const slug = new URLSearchParams(location.search).get("unknown")
    if (!slug) return
    history.replaceState(null, "", location.pathname)
    showToast(`No project named ${slug} — showing all projects instead`, { duration: 7000 })
  }, [])
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const pick = useMutation({
    mutationFn: () => rpc.projectPick({}),
    onSuccess: (result) => {
      if (result.kind === "cancelled") return
      if (result.kind === "unavailable") {
        setFallback({ reason: result.reason })
        return
      }
      void queryClient.invalidateQueries({ queryKey: ["projectsList"] })
      navigate(projectHref(result.project.slug))
    },
    // A picker that throws is still a machine without a working picker.
    onError: (error) => setFallback({ reason: error instanceof Error ? error.message : String(error) }),
  })
  const { data, isPending, error } = useQuery({
    queryKey: ["projectsList"],
    queryFn: () => rpc.projectsList(),
  })
  // The rail's poll, under the rail's key: one request feeds the rail on a board, every tile here and the
  // All projects tile's total.
  const counts = useQuery({
    queryKey: ["projectsRailCounts"],
    queryFn: () => rpc.projectsRailCounts(),
    refetchInterval: 5_000,
  })
  // The home directory is only ever used to shorten a path for display, so a miss costs a longer row.
  const home = data?.[0]?.path.match(/^(\/(?:Users|home)\/[^/]+)\//u)?.[1]
  const empty = data !== undefined && data.length === 0
  const isMobile = useIsMobile()
  const fallbackDialog = fallback ? (
    <AddProjectDialog reason={fallback.reason} proposed={proposed} onClose={() => setFallback(null)} />
  ) : null

  // Below the phone breakpoint the page is a list, not a grid (MobileProjectList). The two one-shot
  // readers above still ran — `?add=` and `?unknown=` belong to this arrival on either shell — and the
  // typed-path dialog still mounts if a launcher asked for one.
  if (isMobile && data) {
    return (
      <>
        <MobileProjectList projects={data} home={home} />
        {fallbackDialog}
      </>
    )
  }

  // An empty machine has nothing to show in a grid: it gets the welcome, and the one card that does
  // something about it.
  if (empty) {
    return (
      <div className="flex min-h-dvh w-full flex-col px-6 py-14">
        <div className="m-auto flex w-full flex-col items-center">
          <div className="mb-6 flex flex-col items-center gap-2.5 text-center">
            <img src="/favicon.svg" width={MARK_PX} height={MARK_PX} alt="" className="rounded-[17px]" />
            <h1 className="text-[19px] font-semibold tracking-[-0.01em] text-fg">Welcome to Frizz</h1>
            <p className="max-w-[420px] text-[13px] leading-relaxed text-muted">
              A project is a folder on this machine. Frizz keeps one board of threads per project, and
              serves them all from here.
            </p>
          </div>
          <div className="grid w-full max-w-[360px] grid-cols-1">
            <PhantomCard hero pending={pick.isPending} onClick={() => pick.mutate()} />
          </div>
          <p className="mt-6 text-[11.5px] text-muted-70">
            {/* `npx frizz`, and a folder: whoever is reading this ran `npx frizz`, so no `frizz` is on
                their PATH, and a project does not have to be a repository. */}
            Or run{" "}
            <code className="rounded border border-border bg-panel px-1.5 py-0.5 font-mono text-muted">npx frizz</code>{" "}
            inside a folder, and this page offers to add it.
          </p>
        </div>
        {fallbackDialog}
      </div>
    )
  }

  return (
    // m-auto rather than justify-center: a centred flex column CLIPS its overflow at the top once
    // the content is taller than the viewport, and forty projects will be. Auto margins centre while
    // still letting the page scroll from its real top.
    <div data-home-grid-page className="flex min-h-dvh w-full flex-col px-10 py-16">
      <div className="m-auto flex w-full flex-col items-center">
        <h1 className="sr-only">Projects</h1>
        {error ? (
          <p className="text-[13px] text-muted">Could not read the project registry: {String(error)}</p>
        ) : isPending ? (
          <p className="text-[13px] text-muted">Loading…</p>
        ) : (
          <>
            {/* AS MANY ACROSS AS THE WINDOW HOLDS, EIGHT AT MOST: fixed-width tracks, so a tile is the same
                size in every window and the row centres rather than stretching its gaps. 952px is eight
                112px tiles and their seven 8px gaps. `auto-fit`, not `auto-fill`: the tracks no tile fills
                collapse, so two tiles stand in the middle of the page and not at the left of a row of
                eight empty cells, as they did under a centred pill. A last row that is not full starts at
                the left, as a home screen's does. */}
            <div
              data-home-grid
              className="grid w-full max-w-[952px] justify-center gap-x-2 gap-y-6"
              style={{ gridTemplateColumns: `repeat(auto-fit, ${TILE_PX}px)` }}
            >
              <AddTile pending={pick.isPending} onClick={() => pick.mutate()} />
              {data.length > 1 ? <AllProjectsTile projects={data} counts={counts.data} /> : null}
              {data.map((project) => (
                <ProjectTile key={project.id} project={project} counts={counts.data?.[project.id]} home={home} />
              ))}
            </div>
          </>
        )}
      </div>
      {fallbackDialog}
    </div>
  )
}
