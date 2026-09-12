import { FileDiff, Folder } from "lucide-react"
import { useQueryClient } from "@tanstack/react-query"
import { useSnapshot } from "valtio"
import type { EditedFile, ThreadView } from "@frizz/shared"
import { useProjectDir, useTranscript } from "../hooks.ts"
import { editedFileTree, flattenEditedFileTree } from "../lib/editedFileTree.ts"
import { openLocalPath } from "../lib/local-file-links.ts"
import { prewarmLocalFile } from "../lib/localFileQuery.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { prefs } from "../lib/prefs.ts"
import { PRIMER } from "../lib/primer.ts"
import { AgentRow, BgShellRow, GithubWatchRow, ON_CAP, TimerRow, WaitGrid, WaitRow, liveAgents, type WaitGroup } from "./AwaitingBackgroundCard.tsx"

// THE FULLSCREEN PAGE'S OPERATIONAL RAIL — what is going on in this thread, listed beside the transcript
// (maintainer 2026-08-28): its live sub-agents, its running background shells, the pull requests and
// timers it is watching, and the files its worker has edited.
//
// IT IS THE AWAITING CARD'S TABLE, one surface over. Every row here is the card's own row component —
// AgentRow, BgShellRow, GithubWatchRow, TimerRow, the same WaitRow for a file — in the card's own
// WaitGrid, so a watched PR reads here exactly as it reads on the card: the same checks glyph (a
// spinner while CI runs, green/red when it settles), the same count line, the same link to GitHub.
// The first cut of this rail drew its own rows with its own icons and threw the CI state away, and
// the maintainer met a PR he could not click beside a timer wearing a different clock (2026-08-28:
// "Please just spend a bare minimum amount of time trying to understand visual consistency").
//
// The one row the card does not have is a FILE: the same shape (mark · name · status · chevron),
// opening the file in the page's viewer. The list arrives on the transcript page, derived by the
// server over the whole projection — the latest window the page renders rarely holds an Edit at all,
// because a worker edits mid-effort and verifies at the end (server/edited-files.ts).
//
// THE FILES ARE A TREE (maintainer 2026-09-03), not a list: a directory row above the files it
// holds, a small indent per level, and a chain of single-child directories folded into one row the
// way GitHub's tree draws `packages/web/src` (lib/editedFileTree.ts). The flat list showed basenames
// alone and twenty-two of them read as twenty-two names from nowhere. The tree's rows lay out by FLEX
// inside one cell of the shared grid rather than as subgrid rows, because a subgrid cannot indent —
// see ROW_FLEX in AwaitingBackgroundCard — and the file rows are still the card's own WaitRow.
//
// It floats on the page background and is VERTICALLY CENTERED like the sidebar, rather than pinned to
// the top — the maintainer's call on the mockup's top-anchored version. The liveness readouts that
// mockup led with (activity line, profile chips, context meter) were dropped on the same review: the
// thread header already says what the worker is doing, and the composer's own footer carries the
// profile.

// The rail's width, in px — the side pane on /full is exactly this wide while nothing covers it. 340
// rather than the mockup's 300: the card's rows were fitted at a 368px card, and at 300 a PR row
// truncated to "colinhacks/zod#…" — the one part of the ref that names the PR (2026-08-28).
export const RAIL_WIDTH = 340

// One level of the tree, in px. Tiny by request: at 12px type a level is well under an em, enough to
// read as nesting beside a 12px mark without walking a deep path off the rail's right edge.
const TREE_INDENT = 10

function DirRow({ name, depth }: { name: string; depth: number }) {
  return (
    <div
      data-file-dir={name}
      className="flex items-baseline text-[12px] leading-5 text-muted-70"
      style={{ paddingLeft: depth * TREE_INDENT }}
    >
      <span className="flex shrink-0"><Folder size={12} className={`${ON_CAP} text-muted-45`} /></span>
      {/* ml-[5px], not the row's ml-1.5: lucide's folder inks 11 of its 12 box px, so 6px of box read
          as 7.33px of ink (ink-gaps, dsf 6) against the card rows' 6.5 — and the file rows below it
          are trimmed to the same 6.33 (see FileRow), so the tree's two glyph→name gaps agree. */}
      <span className="ml-[5px] min-w-0 truncate" title={name}>{name}</span>
    </div>
  )
}

function EditedFileTree({ files }: { files: readonly EditedFile[] }) {
  const projectDir = useProjectDir()
  const rows = flattenEditedFileTree(editedFileTree(files, projectDir))
  return (
    // ONE cell of the shared grid, holding its own column of rows: the tree's rows must not share the
    // grid's tracks (the indent is the whole point), and a `gap-y-px` between them keeps the rhythm
    // WaitGrid draws between its own rows.
    <div data-edited-file-tree className="col-span-4 flex flex-col gap-y-px">
      {rows.map((node) =>
        node.kind === "dir"
          ? <DirRow key={`d:${node.depth}:${node.name}`} name={node.name} depth={node.depth} />
          : <FileRow key={node.file.path} file={node.file} name={node.name} depth={node.depth} />,
      )}
    </div>
  )
}

function FileRow({ file, name, depth }: { file: EditedFile; name: string; depth: number }) {
  // EAGER READ ON HOVER (maintainer 2026-09-01): the pointer resting on a row is the earliest honest
  // signal that this file is the next one to open, and it buys the whole server round trip plus the
  // highlight pass before the click. The viewer then mounts against a warm cache and paints on the
  // first frame of its slide instead of a frame or two into it.
  const client = useQueryClient()
  // The status is the file's DIFFSTAT, GitHub-green and GitHub-red — the edit count and the
  // last-edited clock both came off on review (maintainer 2026-08-31: "hide the 2×…", the age
  // "seems useless to me"). A zero side stays quiet; a file with no counted lines (an
  // unreconstructed apply_patch) carries no status at all rather than a fabricated 0.
  //
  // "GitHub-green" is now literally GitHub's green (`lib/primer.ts`), which is what the comment
  // already claimed: it read `emerald-500`, which renders `#00bc7d` — a teal 32° off the `#3fb950`
  // the hovercard's own `+316` is drawn in, on a rail that sits beside it.
  return (
    <WaitRow
      testKind="file"
      testId={file.path}
      // -mr-[2px]: this glyph inks only 9 of its 12 box px (1.5px dead each side), so the row's ml-1.5
      // drew 8.33px of ink to the name where the card's rows draw ~6.5 (ink-gaps, dsf 6). The trim
      // lands it at 6.33, the same reading as the directory row above it.
      mark={<FileDiff size={12} className={`${ON_CAP} -mr-[2px] text-muted-60`} />}
      // The basename is the name and the directory row above it says where; the full path is the
      // tooltip. A 340px rail truncates from the end, and a repo path truncated from the end lost
      // exactly the part that names the file.
      name={name}
      indent={depth * TREE_INDENT}
      onOpen={() => openLocalPath(file.path)}
      onPrewarm={() => prewarmLocalFile(client, file.path)}
      title={file.path}
      status={
        <>
          {(file.added ?? 0) > 0 && <span style={{ color: PRIMER.fgSuccess }}>+{file.added}</span>}
          {(file.added ?? 0) > 0 && (file.removed ?? 0) > 0 && " "}
          {(file.removed ?? 0) > 0 && <span style={{ color: PRIMER.fgDanger }}>−{file.removed}</span>}
        </>
      }
    />
  )
}

export function FocusRail({ thread }: { thread: ThreadView }) {
  const now = useNowMs()
  // Shared with ChatView's own subscription (same key), so this adds no request and no poll.
  const transcript = useTranscript(thread.id, { poll: false })
  const files = transcript.data?.editedFiles ?? []
  const agents = liveAgents(thread)
  const shells = (thread.bgShells ?? []).filter((s) => s.state === "running")
  const prs = (thread.watches ?? []).filter((w) => w.kind === "github" && w.state === "armed")
  const timers = (thread.watches ?? []).filter((w) => w.kind === "timer" && w.state === "armed")
  const { railFilesCollapsed } = useSnapshot(prefs)
  // The card's order — most-alive first — then the files, which are not a wait at all. The files are
  // also the one group that FOLDS (maintainer 2026-09-03): a worker that touched 22 files fills the
  // rail with them, and the wait rows above are what the reader came for. The fold is a saved view
  // preference (lib/prefs.ts), so it holds across threads and reloads.
  const groups: WaitGroup[] = [
    { head: "Sub-agents", rows: agents.map((a) => <AgentRow key={a.id ?? a.label} agent={a} slug={thread.id} now={now} />) },
    { head: "Background shells", rows: shells.map((s) => <BgShellRow key={s.id ?? s.label} shell={s} slug={thread.id} now={now} />) },
    { head: "Pull requests", rows: prs.map((w) => <GithubWatchRow key={w.id} watch={w} />) },
    { head: "Timers", rows: timers.map((w) => <TimerRow key={w.id} watch={w} now={now} />) },
    {
      head: "Edited files",
      // One row of the grid, holding the whole tree (its own column, its own indents).
      rows: files.length > 0 ? [<EditedFileTree key="tree" files={files} />] : [],
      count: files.length,
      collapsed: railFilesCollapsed,
      onToggle: () => (prefs.railFilesCollapsed = !prefs.railFilesCollapsed),
    },
  ].filter((g) => g.rows.length > 0)
  return (
    // `thread-rail` exists only on this page, so on the fullscreen door's view transition it has no
    // old counterpart and plays the enter animation in styles.css (slides in from the right).
    //
    // The vertical centering is the CHILD's `my-auto`, never `justify-center` on this scroll container:
    // centering the flex line clips whatever overflows it ABOVE the scroll origin, so a rail taller
    // than the window lost its top padding and its first rows to pixels no scrollbar could reach
    // (maintainer 2026-09-02, a 22-file list opening flush at the window edge). Auto margins center
    // identically while there is room and collapse to zero when there is not.
    <aside data-focus-rail aria-label="Thread activity" className="flex h-full shrink-0 flex-col overflow-y-auto px-4 [view-transition-name:thread-rail]" style={{ width: RAIL_WIDTH }}>
      <div className="my-auto py-6">
        {groups.length === 0
          ? <div className="text-[11.5px] text-muted-50">Nothing running, watched or edited yet.</div>
          : <WaitGrid groups={groups} divider={false} />}
      </div>
    </aside>
  )
}
