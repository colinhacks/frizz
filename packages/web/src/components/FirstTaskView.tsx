import { useMutation } from "@tanstack/react-query"
import { rpc } from "../api/rpc.ts"
import { useBoard } from "../hooks.ts"
import { showToast } from "../store.ts"
import { ProjectScope } from "../lib/projectScope.tsx"
import { useConsoleDispatchTarget } from "./ConsoleProjectChip.tsx"
import { DispatchForm } from "./NewThreadModal.tsx"
import { StatusRow } from "./StatusRow.tsx"

// A BRAND-NEW BOARD'S FIRST SCREEN: one that has never had a thread (lib/sidebarPresence). The prompt
// box IS the whole screen, centred, with no sidebar beside it (App hides it on the same predicate). The
// first dispatch adds a thread, the sidebar appears with this same box at its top, and the board becomes
// the one-thread pane (ThreadPane.tsx).
//
// The Console gets it too, on a machine that has never run a thread in any project (maintainer 2026-11-10).
// Its status row is the Console's — the house, then the chip naming the project a task goes to — so the
// one box still says where it sends.
//
// This was the queue's column (TodosView.tsx) until the one-thread pane replaced the queue's cards on
// 2026-11-09; the cards went on 2026-11-10 (maintainer: "Delete it"). Its empty-inbox state is the pane's
// own now (PaneEmpty).
export function FirstTaskView({ onConsole = false }: { onConsole?: boolean } = {}) {
  return (
    // `my-auto`, not justify-center on the column, whose top overflow would be unreachable.
    <div className="my-auto w-full min-w-0 flex flex-col py-8">
      {/* Source-of-truth failures are LOUD: a board that can't be read renders as this banner, never
          as a silently empty listing (a truncated shell-out once blanked a 700-thread board with the
          error hidden in an unrendered field). */}
      <BoardErrorsBanner />
      <div className="w-full flex flex-col gap-3">
        {/* `mb-4` on top of the column's 12px: the heading is this screen's title, and at one gap it stood as
            far from the status row as the row from the box, three lines of one stack. */}
        <h2 className="mb-4 text-center text-[17px] font-medium tracking-[-0.01em]">What should the agent do?</h2>
        {/* The status row rides the top of the PROMPT BOX, and on a brand-new project this is the
            prompt box — the sidebar that normally carries it is hidden here. Without this the one
            screen a fresh install starts on would have no project identity, no way to settings, no
            reload and no quota reading at all. It sits below the heading rather than above it: the
            heading is this screen's title, the row belongs to the composer under it. */}
        {onConsole ? (
          <ConsoleFirstDispatch />
        ) : (
          <>
            <StatusRow />
            {/* The "Starting thread…" card FLOATS under the form. This column is centred in the window, so a
                card in flow lifted the heading, the status row and the box 36-37px for the length of the
                dispatch call (recorded 2026-10-13, three runs). There is no rail here to draw the pending
                thread in, and the card is the only thing on this screen that still shows what was asked. */}
            <DispatchForm autoFocus pendingCard="float" />
          </>
        )}
      </div>
    </div>
  )
}

/** The Console's row and box: ConsoleSidebar's own pair, with the floating "Starting thread…" card this
 *  screen needs in place of the rail's starting row. */
function ConsoleFirstDispatch() {
  const { project, chip } = useConsoleDispatchTarget()
  return (
    <>
      <StatusRow onConsole projectChip={chip} />
      <ProjectScope project={project?.slug}>
        <DispatchForm autoFocus pendingCard="float" />
      </ProjectScope>
    </>
  )
}

// The board-errors banner: source-of-truth failures rendered LOUD (never a silently empty listing).
// A REPAIRABLE error (a thread .md with no YAML frontmatter — invisible to the queue/status system)
// gets a one-click Repair button that prepends minimal frontmatter and rebuilds the board; the entry
// clears on the next snapshot. Non-repairable errors render exactly as before. Falls back to the plain
// `errors` strings when the structured `errorItems` is absent (a pre-restart server).
// Its corner is BLOCK_RADIUS (TranscriptCard.tsx) written out: that module brings the markdown renderer
// with it, and this screen is in the board's first paint (entryChunk.guard.test.ts).
// It reads the board ITSELF and takes no prop. Handed the page's tracked board as a prop, it made React's
// development build diff that prop key by key on every render, each `in` check recorded by valtio as a
// read of this page's: 101,748 recorded paths on a board of 1,047 threads, re-walked after every render
// of the page (75ms of a send's click on the dev server, 2026-10-13). A production build never diffed.
function BoardErrorsBanner() {
  const board = useBoard()
  const items = board?.errorItems ?? []
  const legacy = board?.errors ?? []
  if (items.length === 0 && legacy.length === 0) return null
  return (
    <div className={`mb-6 rounded-xl border border-attention-fill/25 bg-attention-fill/[0.06] px-4 py-2.5 text-[12px] text-attention-detail-90`}>
      <div className="font-medium mb-0.5">Board errors</div>
      {items.length > 0
        ? items.slice(0, 6).map((it, i) => (
            <div key={i} className="flex items-center gap-2 py-0.5">
              <span className="min-w-0 flex-1 truncate" title={`${it.file ? `${it.file}: ` : ""}${it.message}`}>
                {it.file ? `${it.file}: ` : ""}
                {it.message}
              </span>
              {it.kind === "no-frontmatter" && <RepairButton file={it.file} />}
            </div>
          ))
        : legacy.slice(0, 3).map((e, i) => (
            <div key={i} className="truncate" title={e}>
              {e}
            </div>
          ))}
    </div>
  )
}

// The per-error Repair action. Each button owns its own mutation so its pending/disabled state is
// isolated. On success the fix has landed on disk + a board rebuild is in flight — the banner entry
// disappears on the next snapshot; a toast confirms. On refusal (server-side guard) the toast carries
// the reason.
function RepairButton({ file }: { file: string }) {
  const repair = useMutation({
    mutationFn: () => rpc.repairThread({ file }),
    onSuccess: ({ slug }) => showToast(`Repaired ${slug} — verify its status`),
    onError: (err) => showToast(err instanceof Error ? err.message : "Repair failed"),
  })
  return (
    <button
      onClick={() => repair.mutate()}
      disabled={repair.isPending}
      className="shrink-0 rounded border border-attention/50 bg-attention-fill/10 px-2 py-0.5 text-[11px] font-medium text-attention-soft transition-colors hover:bg-attention-fill/25 disabled:opacity-50"
      title="Prepend minimal frontmatter (title + status: active) so this thread becomes visible again"
    >
      {repair.isPending ? "Repairing…" : "Repair"}
    </button>
  )
}
