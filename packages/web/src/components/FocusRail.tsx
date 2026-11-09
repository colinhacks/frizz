import { ExternalLink, FileDiff, FileText, Folder } from "lucide-react"
import { useEffect, useMemo, useRef } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useSnapshot } from "valtio"
import { isDirectSubAgent, type EditedFile, type ThreadLinkView, type ThreadView } from "@frizz/shared"
import { useChildThreads, useHomeDir, useProjectDir, useTranscript } from "../hooks.ts"
import { shellWatched, threadOps } from "../lib/threadOps.ts"
import { childOpDismisser } from "../lib/dismissChildOp.ts"
import { editedFileTree, flattenEditedFileTree } from "../lib/editedFileTree.ts"
import { newestFileChangeKey } from "../lib/editedFilesRefresh.ts"
import { openLocalPath } from "../lib/local-file-links.ts"
import { prewarmLocalFile } from "../lib/localFileQuery.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { tildePath } from "../lib/paths.ts"
import { prefs } from "../lib/prefs.ts"
import { PRIMER } from "../lib/primer.ts"
import { AgentRow, BgShellRow, ChildThreadRow, CommandWatchRow, GithubWatchRow, ON_CAP, ROW_INSET, TimerRow, WaitGrid, WaitRow, type WaitGroup } from "./AwaitingBackgroundCard.tsx"
import { HumanTodoList } from "./AwaitingSteps.tsx"
import { transcriptBackgroundShells } from "../lib/transcriptShells.ts"

// THE FULLSCREEN PAGE'S OPERATIONAL RAIL — what is going on in this thread, listed beside the transcript
// (maintainer 2026-08-28): its sub-agents and background shells (live, or stale and saying so), the
// pull requests and timers it is watching, and the files its worker has edited.
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
// alone and twenty-two of them read as twenty-two names from nowhere. The file rows are still the
// card's own WaitRow, indented through its `indent`.
//
// IT REPLACES THE OPS STRIP UNDER THE PROMPT BOX while it is on screen (maintainer 2026-10-02: "it's
// already showing up in the sidebar to the right"), so it has to carry every row that strip did — or
// hiding the strip hides the row. Two had been the strip's alone: the files and links the worker SAVED
// for the human (`thread.links`, the same list the phone's ⋯ sheet calls "Files and links"), and a
// Codex thread's background execs, which reach the page through its transcript rather than the board's
// shell telemetry — both read off lib/threadOps, the one list the strip and the line of counts read too.
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
      className="flex items-baseline pr-2 text-[12px] leading-5 text-muted-70"
      style={{ paddingLeft: ROW_INSET + depth * TREE_INDENT }}
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
  const homeDir = useHomeDir()
  const rows = flattenEditedFileTree(editedFileTree(files, projectDir, homeDir))
  return (
    // One entry of the table, holding its own column of rows; a `gap-y-px` between them keeps the
    // rhythm WaitGrid draws between its own rows.
    <div data-edited-file-tree className="flex flex-col gap-y-px">
      {rows.map((node) =>
        node.kind === "dir"
          ? <DirRow key={`d:${node.path}`} name={node.name} depth={node.depth} />
          : <FileRow key={node.file.path} file={node.file} name={node.name} depth={node.depth} homeDir={homeDir} />,
      )}
    </div>
  )
}

function FileRow({ file, name, depth, homeDir }: { file: EditedFile; name: string; depth: number; homeDir: string | undefined }) {
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
      // tooltip, its home written as `~` the way the tree writes it. A 340px rail truncates from the
      // end, and a repo path truncated from the end lost exactly the part that names the file.
      name={name}
      indent={depth * TREE_INDENT}
      onOpen={() => openLocalPath(file.path)}
      onPrewarm={() => prewarmLocalFile(client, file.path)}
      title={tildePath(file.path, homeDir)}
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

// A file or link the worker SAVED for the human (`frizzctl link`). The card's row shape again: the
// label it was saved under is the name, and the full target is the tooltip (a file's home written as
// `~`, as the edited-files tree writes it). A URL's status is its host, the one thing its label may not
// say; a FILE has none (maintainer 2026-10-08: "I don't think the file name is super important") — its
// basename restated the label and took the width the label needed to stop wrapping. Never the whole URL
// or path: the status track is shared by every row in the grid, so one long target there would squeeze
// every name above it (see WaitGrid's `fit-content(50%)`). A file opens in the page's viewer, a link in
// a new tab.
function SavedLinkRow({ link }: { link: ThreadLinkView }) {
  const client = useQueryClient()
  const homeDir = useHomeDir()
  if (link.kind === "link") {
    return (
      <WaitRow
        testKind="link"
        testId={link.id}
        mark={<ExternalLink size={12} className={`${ON_CAP} text-muted-60`} />}
        name={link.label}
        href={link.target}
        title={link.target}
        status={urlHost(link.target)}
      />
    )
  }
  return (
    <WaitRow
      testKind="link"
      testId={link.id}
      // No ink trim, unlike FileRow's: that one matches the directory rows of its tree, and this one
      // matches the rows around it, whose names all start one 12px mark box in. Measured (ink-gaps,
      // dsf 6): mark→name 8.00px, the shell row's own 8.00; the URL row's 7.67.
      mark={<FileText size={12} className={`${ON_CAP} text-muted-60`} />}
      name={link.label}
      onOpen={() => openLocalPath(link.target)}
      onPrewarm={() => prewarmLocalFile(client, link.target)}
      title={tildePath(link.target, homeDir)}
      status={null}
    />
  )
}

function urlHost(target: string): string {
  try {
    return new URL(target).host || target
  } catch {
    return target
  }
}

// How long the rail waits after a file-changing edge before it re-reads: a worker's edits come in bursts,
// and one read after the burst is the whole point.
const FILES_REFRESH_DEBOUNCE_MS = 1500

// Re-reads the transcript page — the only carrier of `editedFiles` — on the two edges
// lib/editedFilesRefresh.ts describes: a newer file-changing tool call, and the turn ending. Neither
// fires on mount, nor when the first page lands: that read is already fresh.
function useEditedFilesRefresh(slug: string, loaded: boolean, changeKey: string | undefined, turnLive: boolean) {
  const client = useQueryClient()
  const seen = useRef({ slug, loaded, changeKey, turnLive })
  // The pending read lives in a ref, not in the edge effect's cleanup: that cleanup runs on EVERY dep
  // change, so a turn starting inside the debounce would cancel the read a write had just scheduled.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [slug])
  useEffect(() => {
    const prev = seen.current
    seen.current = { slug, loaded, changeKey, turnLive }
    if (prev.slug !== slug || !prev.loaded) return
    const wrote = changeKey !== undefined && changeKey !== prev.changeKey
    const rested = prev.turnLive && !turnLive
    if (!wrote && !rested) return
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      void client.refetchQueries({ queryKey: ["transcript", slug], exact: true, type: "active" })
    }, FILES_REFRESH_DEBOUNCE_MS)
  }, [client, slug, loaded, changeKey, turnLive])
}

export function FocusRail({ thread }: { thread: ThreadView }) {
  const now = useNowMs()
  // Shared with ChatView's own subscription (same key), so this adds no request and no poll.
  const transcript = useTranscript(thread.id, { poll: false })
  const files = transcript.data?.editedFiles ?? []
  const changeKey = useMemo(() => newestFileChangeKey(transcript.data?.messages ?? []), [transcript.data?.messages])
  useEditedFilesRefresh(thread.id, transcript.data !== undefined, changeKey, thread.runtime === "running" || thread.runtime === "spawning")
  // THE ROWS ARE lib/threadOps' — what the line of counts over the prompt box and its panels list, by the
  // same rules, because on /full this rail is that line's replacement (ff185621) and a row it drops is
  // shown nowhere. The shells include the transcript's: a Codex background exec is transcript-native and
  // the board reports none for it (lib/transcriptShells). A STALE child — quiet past its
  // window — and a STALE shell — a process the OS confirmed gone — stay listed, and their rows say so
  // (AgentRow, BgShellRow). Each agent and shell row carries the strip's stop/clear ×, under its gate,
  // and a shell a watch names says so in its tooltip, as the strip's row does (shellWatched).
  const transcriptShells = useMemo(() => transcriptBackgroundShells(transcript.data?.messages ?? []), [transcript.data?.messages])
  // The thread's CHILD THREADS, the same list its rail rows and the counts over its prompt box draw.
  const childThreads = useChildThreads(thread.id)
  const { agents: unresolved, children, shells, prs, issues, commands, timers } = threadOps(thread, transcriptShells, childThreads)
  const isWatched = shellWatched(thread)
  // ONE LEVEL of children: the rail's rows are the awaiting card's table (AgentRow), which draws no tree,
  // where the panel over a prompt box indents a child's own children under it (ChildOpRow `depth`). A
  // RESTED child is one whose own run ended while sub-agents it dispatched are still working (the server
  // emits it only while that fan-out runs, tailer anchorRoots), so it stands for its branch here.
  const agents = unresolved.filter(isDirectSubAgent)
  const { railFilesCollapsed } = useSnapshot(prefs)
  // The card's order — most-alive first — then the files, which are not a wait at all. The files are
  // also the one group that FOLDS (maintainer 2026-09-03): a worker that touched 22 files fills the
  // rail with them, and the wait rows above are what the reader came for. The fold is a saved view
  // preference (lib/prefs.ts), so it holds across threads and reloads.
  const groups: WaitGroup[] = [
    // First, as on the counts over a prompt box (lib/queueOpsCounts): it is the one group that waits on the reader.
    { head: "To-do", rows: thread.humanTodos?.length ? [<div key="todos" className="px-2 text-[12px] leading-[18px]"><HumanTodoList thread={thread} /></div>] : [] },
    { head: "Sub-agents", rows: agents.map((a) => <AgentRow key={a.id ?? a.label} agent={a} slug={thread.id} now={now} onDismiss={childOpDismisser(thread.id, a)} />) },
    // Beside the sub-agents they resemble, as the counts over a prompt box order them (lib/queueOpsCounts).
    { head: "Child threads", rows: children.map((c) => <ChildThreadRow key={c.id} child={c} now={now} />) },
    { head: "Background shells", rows: shells.map((s) => <BgShellRow key={s.id ?? s.label} shell={s} slug={thread.id} now={now} onDismiss={childOpDismisser(thread.id, s, "SHELL")} watched={isWatched(s)} />) },
    { head: "Pull requests", rows: prs.map((w) => <GithubWatchRow key={w.id} watch={w} />) },
    { head: "Issues", rows: issues.map((w) => <GithubWatchRow key={w.id} watch={w} />) },
    { head: "Monitors", rows: commands.map((w) => <CommandWatchRow key={w.id} watch={w} slug={thread.id} now={now} />) },
    { head: "Timers", rows: timers.map((w) => <TimerRow key={w.id} watch={w} now={now} />) },
    // Saved references, not waits, so they follow every live row. Ahead of the edited files, though:
    // the worker chose these for the human to keep at hand, and the tree can run to dozens of rows.
    { head: "Files and links", rows: (thread.links ?? []).map((l) => <SavedLinkRow key={l.id} link={l} />) },
    {
      head: "Edited files",
      // One entry of the table, holding the whole tree (its own column, its own indents).
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
    // ANCHORED TO THE TOP whenever it lists anything, the rule the queue column and the sidebar follow
    // (maintainer 2026-10-13: "Anchor both to the top"; TodosView, Sidebar.tsx). It was centred in the
    // window, and a centred column turns every height change into a move of everything in it: a
    // background shell starting under a running sub-agent moved the Sub-agents group up 26px, and the
    // shell finishing moved it back (layout sweep, 2026-10-14). Top-anchored, a group coming or going
    // moves only the groups below it.
    //
    // ON THE LINE THE TRANSCRIPT OPENS ON: the first heading's top is the thread header's bottom edge
    // (48px) plus the transcript's own 20px top padding (ChatView paddingStart), 68px, which is the
    // queue's rule of starting a column level with its neighbour's first content (Sidebar.tsx, 52px).
    // `pt-14` is 56px, and the table's own `mt-3` (WaitGrid) is the other 12. Measured at 1400x900:
    // heading top 68, header bottom 48. The rail is hidden below the `split` width, so 1200px and
    // narrower have no reading to take.
    //
    // The EMPTY state keeps its centring, as the queue's do: one line of quiet text in the middle of an
    // empty pane, with nothing beside it to shove. That centring is the child's `my-auto`, never
    // `justify-center` on this scroll container: centering the flex line clips whatever overflows it
    // ABOVE the scroll origin (maintainer 2026-09-02, a 22-file list opening flush at the window edge),
    // where auto margins collapse to zero when there is no room.
    <aside data-focus-rail aria-label="Thread activity" className="flex h-full shrink-0 flex-col overflow-y-auto px-4 [view-transition-name:thread-rail]" style={{ width: RAIL_WIDTH }}>
      <div className={groups.length === 0 ? "my-auto py-6" : "pb-6 pt-14"}>
        {groups.length === 0
          ? <div className="text-[11.5px] text-muted-50">Nothing running, watched or edited yet.</div>
          : <WaitGrid groups={groups} divider={false} />}
      </div>
    </aside>
  )
}
