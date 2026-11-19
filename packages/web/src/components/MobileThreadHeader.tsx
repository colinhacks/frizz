import { useMemo, useState } from "react"
import { ArrowLeft, MoreHorizontal } from "lucide-react"
import { useThreadSnapshot, useTranscript } from "../hooks.ts"
import { useConsoleProjectList } from "../lib/consoleProjects.ts"
import { keyProject } from "../lib/threadKey.ts"
import { ProjectSquare } from "./ProjectRail.tsx"
import { appPushedCurrentEntry } from "../lib/router.ts"
import { leaveFiledThread } from "../lib/mobileTriage.ts"
import { useShownTitle } from "../lib/pendingRename.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { MOBILE_STATE_WORD, mobileThreadAge, mobileThreadState, turnStartedAt } from "../lib/mobileThread.ts"
import { ThreadActionsSheet, useModelEffortLabel } from "./MobileThreadActionsSheet.tsx"

// THE PHONE THREAD HEADER (mockup v2 §2). The desktop drawer's header is two rows — title and "Last
// active", then an icon strip and a bordered × — and at 390pt it spent 91.5px on controls a phone either
// cannot use (open fullscreen) or reaches more easily from a list. This is one 56px row: ← back, the
// title, a subtitle that says where the thread stands, and ⋯ for everything else.
//
// ← IS THE PLATFORM'S BACK. When the app pushed the thread's history entry (it was opened from the
// board, or anywhere else in this session) it pops that entry — `history.back()` — and the router's
// popstate unwinds the drawer exactly as the browser's own Back or Android's edge swipe would. So ←
// returns to whatever was under the thread, like Back does, and that is not always the board: a thread
// reached by a link inside another thread returns to that thread first, and one reached through the
// fullscreen page's collapse (a desktop door, so only a window narrowed past the breakpoint) returns
// into the fullscreen page. A reload keeps this true, because main.tsx steps off any history entry a
// sheet left behind (lib/backDismiss `stepOffStaleLayerEntries`). Reusing
// the desktop ×'s close here instead REPLACED the thread's entry with the board, which left two board
// entries in a row, so the next Back did nothing visible. Only a thread that arrived by a cold link (the
// entry the document loaded on — nothing of ours below it) closes the ×'s way and lands on the board.
// See `appPushedCurrentEntry` in lib/router.
//
// It does NOT take the drawer's initial focus the way × did (`data-dialog-initial-focus`): a
// programmatically focused button matches :focus-visible, so the page opened with a lit circle around ←.
// Focus falls back to the sheet itself, which draws nothing.
//
// The subtitle leads with the STATE because that is what a phone reader opens a thread to learn:
// "Needs you" in the accent (the one thing the accent is for), "Working" in the live green while a turn
// runs, otherwise "Rested" — then the age, then the model and effort. See lib/mobileThread.ts.
//
// ON THE ALL-PROJECTS BOARD the subtitle also names the thread's PROJECT, its square and its name, after
// the age: the one fact a thread there has that a project's own board never needs (the desktop header
// leads its facts line with it, ThreadHeaderFacts). The phone's drew none until 2026-11-19, so a thread
// opened from that board said nowhere whose it was. Before the model and effort, which is what gives way
// when the line runs out.
//
// Everything the desktop header and the prompt box's rail hold — Snooze, Goal, the registered files,
// Rename, Copy link, and Retry / Restart worker where the header offers them — is in the ⋯ sheet
// (ThreadActionsSheet).
export function MobileThreadHeader({ slug, onClose }: { slug: string; onClose: () => void }) {
  const thread = useThreadSnapshot(slug)
  const title = useShownTitle(thread)
  const [sheetOpen, setSheetOpen] = useState(false)
  const now = useNowMs()
  const running = thread?.runtime === "running" || thread?.runtime === "spawning"
  // The same transcript query the conversation below already holds (one observer more, no extra read):
  // a running turn's age counts from the message that started it.
  const transcript = useTranscript(slug, { poll: running })
  const turnStart = useMemo(() => turnStartedAt(transcript.data?.messages ?? []), [transcript.data])
  const modelEffort = useModelEffortLabel(thread)
  // A keyed id is the Console's (lib/threadKey.ts); a project's own board names none, and reads nothing.
  const projectSlug = thread ? keyProject(thread.id) : undefined
  const project = useConsoleProjectList(projectSlug !== undefined).bySlug.get(projectSlug ?? "")
  if (!thread) return null
  const state = mobileThreadState(thread)
  const age = mobileThreadAge(thread, state, turnStart, now)
  const stateClass = state === "needs-you" ? "font-semibold text-accent" : state === "working" ? "font-semibold text-live" : ""
  return (
    <header
      data-thread-header
      data-mobile-thread-header
      // `pl-1` / `pr-[5px]` are measured: the ← paints 14.5px of its 21px glyph and the ⋯ 16px, so the
      // mockup's 4px / 6px put their ink 18.75px and 20px from the screen edges; 5px on the right brings
      // the pair within a pixel of each other (scripts/ink-gaps.mjs, dsf 4, sans).
      className="flex min-h-14 shrink-0 items-center gap-0.5 border-b border-border bg-panel py-1 pl-1 pr-[5px]"
    >
      <button
        type="button"
        aria-label="Back"
        data-mobile-thread-back
        onClick={() => {
          if (appPushedCurrentEntry()) history.back()
          else onClose()
        }}
        className="flex size-11 shrink-0 items-center justify-center rounded-full text-fg/90 outline-none active:bg-hover focus-visible:bg-hover"
      >
        <ArrowLeft size={21} strokeWidth={2.1} />
      </button>
      <div className="min-w-0 flex-1 pl-0.5 leading-[1.25]">
        <div data-mobile-thread-title className="truncate text-[16.5px] font-semibold tracking-[-0.01em]" title={title}>{title}</div>
        <div data-mobile-thread-subtitle data-state={state} className="truncate text-[13px] text-muted">
          <span className={stateClass}>{MOBILE_STATE_WORD[state]}</span>
          {age && <> · {age}</>}
          {projectSlug && (
            <>
              {" · "}
              <span data-mobile-thread-project={projectSlug} className="font-medium text-fg/80">
                {project ? (
                  // Centred on the 13px line's cap band: the square is a 13px box, and `-0.14em` under the
                  // baseline stands its middle where a capital's is.
                  <span className="mr-[5px] inline-block align-[-0.14em]"><ProjectSquare project={project} size={13} /></span>
                ) : null}
                {project?.name ?? projectSlug}
              </span>
            </>
          )}
          {modelEffort && <> · {modelEffort}</>}
        </div>
      </div>
      <button
        type="button"
        aria-label="Thread actions"
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
        data-mobile-thread-more
        onClick={() => setSheetOpen(true)}
        className="flex size-11 shrink-0 items-center justify-center rounded-full text-fg/90 outline-none active:bg-hover focus-visible:bg-hover"
      >
        <MoreHorizontal size={21} strokeWidth={2.1} />
      </button>
      {/* Mark as done from the sheet leaves the thread the way the bottom bar's Done does — the next
          thread that needs you, or back to the board — not the desktop close (lib/mobileTriage). */}
      {sheetOpen && <ThreadActionsSheet slug={slug} onClose={() => setSheetOpen(false)} onArchived={() => leaveFiledThread(slug)} />}
    </header>
  )
}
