import { createContext, useContext, useEffect, useMemo, useRef, type ComponentPropsWithRef, type ReactElement, type RefObject } from "react"
import { questionFencesLive } from "@frizz/shared"
import type { BgShellView, RegisteredQuestionView, ThreadView } from "@frizz/shared"
import type { ChatMessage } from "../hooks.ts"
import { useLiveAnswering, type LiveAnswering } from "../lib/answering.ts"
import { pairAllAnswers, unrenderedAnswers, type PairedAnswer } from "../lib/answersMessage.ts"
import type { TranscriptShellRecord } from "../lib/childOps.ts"
import { heldHandoffIndex } from "../lib/fenceBlocks.ts"
import { useFileDropZone, useFileIntakeHandle, type FileDropZone, type SurfaceFileDrop } from "../lib/fileDrop.ts"
import { lastAssistantIndex } from "../lib/lastAssistant.ts"
import { useOpsHeldForTranscript } from "../lib/opsAhead.ts"
import { placeQuestions, registeredStandingAt, type QuestionPlacement } from "../lib/questionShadow.ts"
import { useTranscriptHeldForBoard } from "../lib/restAhead.ts"
import { queuedRunOf, type QueuedRun } from "../lib/restReply.ts"
import { useSendNowKey } from "../lib/sendNowKey.ts"
import { SendScopeContext, useComposerSendHandle, useComposerSendPresent, useSendScope, type SendScope } from "../lib/sendScope.tsx"
import { settledQuestionPositions, type SettledPlacement } from "../lib/settledQuestions.ts"
import { stepsDoneReplies } from "../lib/stepsAnswer.ts"
import { QueueDismissContext, QueuedRunContext, ThreadSlugContext, type SurfaceExit } from "../lib/threadContexts.ts"
import { transcriptBackgroundShells, withoutLiveTranscriptBackgroundTools } from "../lib/transcriptShells.ts"
import { showsRestingCard } from "./AwaitingBackgroundCard.tsx"
import { RegisteredAnsweringProvider, openQuestionsOf, useArrivedQuestions, useFenceQuestions, useRefusedFences, useSettledQuestions, type FenceQuestionRow, type SettledQuestion } from "./RegisteredQuestionCards.tsx"

// THE THREAD SURFACE — the one shell around a thread, wherever it is drawn. A thread is drawn in three
// places: its queue card (TodosView's QueueCard), its drawer and its full-screen page (both ChatView).
// Each of those lays its transcript out its own way — the card folds a turn's middle and lets the page
// scroll, the other two window a long transcript inside their own scroller — and that is ALL a surface
// decides. Everything that is true of THE THREAD rather than of a layout is wired here, once:
//
//   · the file drop zone: a file dropped anywhere on the surface goes into its prompt box (lib/fileDrop).
//     On a page that IS one thread — the full-screen page — "anywhere" is the whole page (ThreadPageZone),
//   · the one send: the prompt box's handle and the scope its Send gathers answers through (lib/sendScope),
//   · the fenced-question controller (lib/answering useLiveAnswering) and the registered questions'
//     shared answering state (RegisteredAnsweringProvider),
//   · WHAT EACH MESSAGE MEANS (ThreadTranscript, below): which fences are settled, which registered
//     question a message carries or restates, which answers it pairs with. A surface draws a message as
//     `<ThreadMessage m index>` (ChatView.tsx), which reads all of it from here,
//   · the thread's slug, for everything in the transcript that acts on its thread (ThreadSlugContext),
//   · how the surface leaves the page when its thread is handed back, where it does (QueueDismissContext),
//   · ⌘⏎ with nothing typed pressing Send now under the queued messages, from anywhere in the surface
//     (lib/sendNowKey).
//
// It exists because those were wired by hand in each shell, so a feature built in one was simply absent
// from the other and nothing said so: a file dropped anywhere on a queue card went into its prompt box
// from 2026-10-12, and the same drop on the drawer or the full-screen page opened the file in place of
// the app (maintainer 2026-10-13: "Why is there so much … stuff we accidentally implemented just for
// the cue card, or just for the sidebar drawer, or just for the full screen view? This shouldn't even be
// structurally possible"). The `/login` alias, the status ladder, the gap rule and the box's placeholder
// had each drifted the same way before it and each been pulled into a shared piece; this is the shell
// those pieces are assembled in.
//
// SO A NEW THREAD BEHAVIOUR GOES HERE, not into a surface's own component. The prompt box and a
// transcript message both refuse to mount outside this shell (useThreadSurfaceBox, useThreadTranscript),
// and ThreadSurface.guard.test.ts fails when a surface wires one of these for itself.

/** What a surface has loaded of its thread. The shell derives the rest. */
export interface ThreadSurfaceSource {
  slug: string
  /** The thread as this surface draws it. */
  thread: ThreadView | undefined
  /** The list this surface renders. Every index the transcript model answers is an index into it, and a
   *  question's controller is found by the identity of the message it sits in. */
  messages: ChatMessage[]
  /** The open registered questions this surface draws (useArrivedQuestions)… */
  openQuestions: readonly RegisteredQuestionView[]
  /** …and the answered ones it keeps where their cards stood (useSettledQuestions). */
  settledQuestions: readonly SettledQuestion[]
}

/** WHAT A SURFACE DRAWS OF THE TRANSCRIPT IT LOADED — the `messages`, `openQuestions` and
 *  `settledQuestions` of its ThreadSurfaceSource, and the shells the line of counts over its prompt box
 *  lists. The queue card and the thread view each built this list until 2026-10-14, from the same steps
 *  in two orders, so the thread view's model read the running background calls the card's had taken out.
 *  In order, every step keeping the indices, so an index into `messages` addresses the server's list:
 *
 *   1. less a rest the board has not reached yet (lib/restAhead), so the reply and the Working row's
 *      departure land in one render;
 *   2. less every background call still running, which leaves the conversation for the line of counts —
 *      read off first, as `transcriptShells` (lib/transcriptShells);
 *   3. the registered questions it draws: an open one once the message that asked it has arrived
 *      (useArrivedQuestions), an answered one where its card stood (useSettledQuestions);
 *   4. with every question fence the server refused marked on its message (useRefusedFences).
 *
 *  What a surface does on top of this is its own: the queue card freezes the list it loaded while it
 *  leaves (before this), and the thread view draws a send that ends a rest where it will land (after). */
export interface ThreadMessages {
  messages: ChatMessage[]
  openQuestions: readonly RegisteredQuestionView[]
  settledQuestions: readonly SettledQuestion[]
  transcriptShells: readonly (BgShellView & TranscriptShellRecord)[]
}

export function useThreadMessages(thread: ThreadView | undefined, loaded: ChatMessage[]): ThreadMessages {
  const settledQuestions = useSettledQuestions(thread)
  const boardQuestions = useMemo(() => openQuestionsOf(thread, settledQuestions), [thread, settledQuestions])
  const held = useTranscriptHeldForBoard(thread, loaded)
  const transcriptShells = useMemo(() => transcriptBackgroundShells(held), [held])
  const shown = useMemo(() => withoutLiveTranscriptBackgroundTools(held), [held])
  const openQuestions = useArrivedQuestions(boardQuestions, held)
  const messages = useRefusedFences(shown, thread, openQuestions, settledQuestions)
  return { messages, openQuestions, settledQuestions, transcriptShells }
}

export interface ThreadSurfaceOptions {
  /** THE SURFACE LEAVES THE PAGE WHEN ITS THREAD IS HANDED BACK — the queue card, which dissolves on a
   *  reply, an answer, Mark as done or a snooze, and comes back when the server declines. Absent on a
   *  surface that stays (the drawer, the full-screen page). */
  exit?: SurfaceExit
  /** A file landed on the surface. For a surface whose prompt box may not be mounted — a collapsed queue
   *  card opens itself here, and the box takes the file as it mounts. */
  onFilesDropped?: () => void
}

/** WHAT THE THREAD SAYS ABOUT EACH MESSAGE — one answer for every surface, keyed by the message's index
 *  in the surface's own list. These were derived three times (the queue card and both of the thread
 *  view's columns), from the same functions in the same order, and held together by tests that grepped
 *  each copy for the same line. */
export interface ThreadTranscript {
  thread: ThreadView | undefined
  /** The list every index below addresses: the surface's own (ThreadSurfaceSource.messages). */
  messages: readonly ChatMessage[]
  running: boolean
  /** The last thing the agent SAID (lib/lastAssistant), or -1. */
  lastAgentIdx: number
  /** NO AWAITING CARD WHILE THE THREAD RUNS. An awaiting card states a REST, and a spinning thread is not
   *  at rest on anything, so the cut sits past the last message and every fence in the window is stale.
   *  At rest it is the last thing the agent said, which the resting card at the tail keys on too
   *  (maintainer 2026-09-24: "When the agent is running, an awaiting card should never be shown at all"). */
  awaitingCut: number
  /** The one message before the cut whose fence is NOT stale: the `needs_input` handoff the board is holding
   *  the thread in the queue for (ThreadView.heldHandoff, lib/fenceBlocks heldHandoffIndex), or -1. */
  heldIdx: number
  /** The resting card at the tail states the last message's wait, so that message's fence draws nothing. */
  restingShown: boolean
  /** The two reasons the awaiting fence in the message at `index` draws nothing: the worker has spoken
   *  since (stale), or the resting card states it (stated). Message takes them as separate props, and so
   *  do the emptiness predicates — a settled fence that handed the human steps keeps its card, a stated
   *  one does not. */
  hidesAwaiting: (index: number) => readonly [stale: boolean, stated: boolean]
  /** The messages whose rest on steps the human answered with the "I have completed this" box
   *  (lib/stepsAnswer stepsDoneReplies), so their settled steps card keeps the box, ticked. */
  stepsDone: ReadonlySet<number>
  openQuestions: readonly RegisteredQuestionView[]
  /** A thread dispatched after the free-form fence was retired never gets a fence controller: a
   *  ```question with a body is prose there, and the registered card is the only answerable thing
   *  (shared QUESTION_FENCE_RETIRED_AT). A legacy thread keeps the whole fence path. */
  fencesLive: boolean
  /** Every row the thread knows, when it speaks the question fence (useFenceQuestions); else undefined. */
  fenceQuestions: readonly FenceQuestionRow[] | undefined
  /** The registered questions standing at each message — its rest and every later one — so a fence
   *  restating or naming one folds into its card (lib/questionShadow). */
  shadowedByMessage: Map<number, RegisteredQuestionView[]>
  /** Where the worker PLACED its registered questions: the message whose empty ```question qst_… marker
   *  names each one. A placed card renders in that slot and leaves its anchor group. Over the whole
   *  list — a surface that draws only a window of it narrows this with `placedFrom`. */
  placement: QuestionPlacement<RegisteredQuestionView>
  /** Where each ANSWERED question's card stood when it was answered (lib/settledQuestions). */
  settledPlacement: SettledPlacement<SettledQuestion>
  /** Question↔answer pairing for "Answers:" user messages, over the whole list because the lookback
   *  needs it. null — a stable primitive — at every ordinary index, so the memoized Message only sees a
   *  `paired` prop change on an actual answers-message. */
  paired: (PairedAnswer[] | null)[]
  /** What the human's in-flight answer still has to SAY: the rows of it no message is already drawing. */
  inFlightAnswers: PairedAnswer[] | null
  /** The fenced-question controller for the message, or undefined for an ordinary one. */
  answeringForMessage: LiveAnswering["answeringForMessage"]
  /** The thread as the op counts over the prompt box present it: the board's sub-agents, each launch and
   *  finish held until the transcript draws it (lib/opsAhead), so the counts and the Agent rows move in
   *  one frame. Read through useSurfaceOpsThread. */
  opsThread: ThreadView | undefined
}

export interface ThreadSurfaceState {
  slug: string
  /** The fenced-question controller for this surface's transcript. */
  answering: LiveAnswering
  /** What the thread says about each message this surface draws. */
  transcript: ThreadTranscript
  /** Is this surface's prompt box mounted, so that its Send carries the staged answers? */
  promptBoxSends: boolean
  /** A file is being dragged over the surface right now. */
  fileOver: boolean
  /** The queued tail, as the one Send now under it reads it (QueuedRunContext). */
  queuedRun: QueuedRun
  /** The rest is `<ThreadSurface>`'s wiring, not a caller's. */
  exit: SurfaceExit | null
  sendScope: SendScope
  zone: FileDropZone["handlers"]
  box: ThreadSurfaceBox
}

/** What the surface hands its prompt box. */
export interface ThreadSurfaceBox {
  fileDrop: SurfaceFileDrop
}

const ThreadSurfaceBoxContext = createContext<ThreadSurfaceBox | null>(null)
const ThreadTranscriptContext = createContext<ThreadTranscript | null>(null)
type ZoneHandlers = FileDropZone["handlers"]
const ThreadPageZoneContext = createContext<RefObject<ZoneHandlers | null> | null>(null)

/** A PAGE THAT IS ONE THREAD takes a dropped file anywhere on it. The full-screen page draws its thread
 *  in a column with a gutter on one side and a rail on the other, and at a desktop width the column is
 *  about half of what the reader sees. A file dropped on the other half missed the thread's surface, so
 *  the browser opened it in place of the app — on the one page where "drop it anywhere" can only mean
 *  this thread. So that page's root is this element: it is the drop zone, and the thread surface drawn
 *  inside it hands its zone up here instead of binding it on its own root (one zone, so a drop in the
 *  column is not taken twice). A sheet opened over the page is not inside this element, so a file
 *  dropped on a drawer still goes to that drawer's own thread. */
export function ThreadPageZone({ children, ...root }: Omit<ComponentPropsWithRef<"div">, "onDragOver" | "onDragLeave" | "onDrop">): ReactElement {
  const zone = useRef<ZoneHandlers | null>(null)
  return (
    <ThreadPageZoneContext.Provider value={zone}>
      <div
        {...root}
        data-thread-page-zone
        onDragOver={(e) => zone.current?.onDragOver(e)}
        onDragLeave={(e) => zone.current?.onDragLeave(e)}
        onDrop={(e) => zone.current?.onDrop(e)}
      >
        {children}
      </div>
    </ThreadPageZoneContext.Provider>
  )
}

/** The thread's prompt box reads its surface here. It throws rather than degrade: a prompt box mounted
 *  outside the shell would silently lack whatever the shell wires, which is the defect this exists to end. */
export function useThreadSurfaceBox(): ThreadSurfaceBox {
  const box = useContext(ThreadSurfaceBoxContext)
  if (!box) throw new Error("A thread's prompt box must be rendered inside a <ThreadSurface>")
  return box
}

/** A transcript message reads what its thread says about it here, and throws outside the shell for the
 *  same reason the prompt box does. */
export function useThreadTranscript(): ThreadTranscript {
  const transcript = useContext(ThreadTranscriptContext)
  if (!transcript) throw new Error("A thread's transcript must be rendered inside a <ThreadSurface>")
  return transcript
}

/** The thread the op counts over a prompt box should draw (ThreadTranscript.opsThread): inside a thread's
 *  surface, the surface's — on the queue card, in the drawer and on the full page alike — and outside one
 *  (a fixture, a mockup), the thread as given. */
export function useSurfaceOpsThread(thread: ThreadView): ThreadView {
  const transcript = useContext(ThreadTranscriptContext)
  const held = transcript?.opsThread
  return held && held.id === thread.id ? held : thread
}

/** One per surface, called by the component that draws the transcript. */
export function useThreadSurface(source: ThreadSurfaceSource, options: ThreadSurfaceOptions = {}): ThreadSurfaceState {
  const { slug, thread, messages, openQuestions, settledQuestions } = source
  const { exit, onFilesDropped } = options
  // Created BEFORE the answering controller, which sends through it.
  const composer = useComposerSendHandle()
  const promptBoxSends = useComposerSendPresent(composer)
  // A send from a surface that leaves takes it out of the page in the same gesture, and a refused one
  // puts it back (useLiveAnswering's onSent / onSendFailed). The focused control goes with the surface.
  const answering = useLiveAnswering(
    slug,
    messages,
    exit
      ? () => {
          ;(document.activeElement as HTMLElement | null)?.blur()
          exit.dismiss()
        }
      : undefined,
    { onSendFailed: exit?.cancel, composer },
  )
  const { stagedCount, takeAnswers, answeringForMessage } = answering
  const sendScope = useSendScope(composer, { stagedCount, takeAnswers })

  const running = thread?.runtime === "running" || thread?.runtime === "spawning"
  const lastAgentIdx = useMemo(() => lastAssistantIndex(messages), [messages])
  const awaitingCut = running ? messages.length : lastAgentIdx
  // A handoff the board is holding the thread in the queue for stays drawn above the quiet park that
  // could not take it back (lib/fenceBlocks heldHandoffIndex); every other fence before the cut settles.
  const heldIdx = useMemo(() => (thread?.heldHandoff ? heldHandoffIndex(messages, awaitingCut) : -1), [thread?.heldHandoff, messages, awaitingCut])
  const restingShown = showsRestingCard(thread)
  const fencesLive = questionFencesLive(thread?.spawnedAt)
  const fenceQuestions = useFenceQuestions(fencesLive, openQuestions, settledQuestions, thread)
  const shadowedByMessage = useMemo(() => registeredStandingAt(messages, openQuestions), [messages, openQuestions])
  const placement = useMemo(() => placeQuestions(messages, openQuestions), [messages, openQuestions])
  const settledPlacement = useMemo(() => settledQuestionPositions(messages, settledQuestions), [messages, settledQuestions])
  const paired = useMemo(() => pairAllAnswers(messages), [messages])
  const stepsDone = useMemo(() => stepsDoneReplies(messages), [messages])
  const inFlightAnswers = useMemo(() => unrenderedAnswers(messages, thread?.answersInFlight), [messages, thread?.answersInFlight])
  const opsThread = useOpsHeldForTranscript(thread, messages)
  const run = useMemo(() => queuedRunOf(messages), [messages])
  const queuedRun = useMemo<QueuedRun>(() => ({ held: run.held, steered: run.steered }), [run.held, run.steered])
  const transcript = useMemo<ThreadTranscript>(
    () => ({
      thread,
      messages,
      running,
      lastAgentIdx,
      awaitingCut,
      heldIdx,
      restingShown,
      hidesAwaiting: (index) => [awaitingCut >= 0 && index < awaitingCut && index !== heldIdx, index === lastAgentIdx && restingShown] as const,
      stepsDone,
      openQuestions,
      fencesLive,
      fenceQuestions,
      shadowedByMessage,
      placement,
      settledPlacement,
      paired,
      inFlightAnswers,
      answeringForMessage,
      opsThread,
    }),
    [thread, messages, running, lastAgentIdx, awaitingCut, heldIdx, restingShown, stepsDone, openQuestions, fencesLive, fenceQuestions, shadowedByMessage, placement, settledPlacement, paired, inFlightAnswers, answeringForMessage, opsThread],
  )

  // The surface is the zone and its prompt box the intake (lib/fileDrop). Files given while no box is
  // mounted wait on the handle.
  const intake = useFileIntakeHandle()
  const drop = useFileDropZone((files) => {
    intake.give(files)
    onFilesDropped?.()
  })
  const box = useMemo<ThreadSurfaceBox>(() => ({ fileDrop: { over: drop.over, intake } }), [drop.over, intake])
  const dismiss = exit?.dismiss
  const cancel = exit?.cancel
  // Stable while the two callbacks are, so the fence buttons reading it do not re-render every frame.
  const stableExit = useMemo<SurfaceExit | null>(() => (dismiss && cancel ? { dismiss, cancel } : null), [dismiss, cancel])
  return { slug, answering, transcript, promptBoxSends, fileOver: drop.over, queuedRun, exit: stableExit, sendScope, zone: drop.handlers, box }
}

/** The surface's root element, inside everything the shell provides. Every other prop is the root
 *  `<div>`'s own; the drag handlers are the shell's. */
export function ThreadSurface({
  surface,
  children,
  ...root
}: {
  surface: ThreadSurfaceState
} & Omit<ComponentPropsWithRef<"div">, "onDragOver" | "onDragLeave" | "onDrop">): ReactElement {
  // Inside a page that is this thread's alone, the PAGE is the zone (ThreadPageZone): the handlers go
  // up to it, and this root binds none. Handed over after every render, since they close over it.
  const pageZone = useContext(ThreadPageZoneContext)
  // ⌘⏎ for Send now, after whatever the surface itself does with the key: the queue card's root sends
  // answers staged on its cards on the same chord, and those come first.
  const sendNowKey = useSendNowKey(surface.slug, surface.queuedRun)
  const zone = surface.zone
  useEffect(() => {
    if (!pageZone) return
    pageZone.current = zone
    return () => {
      if (pageZone.current === zone) pageZone.current = null
    }
  })
  return (
    <ThreadSlugContext.Provider value={surface.slug}>
      {/* OUTSIDE the answering provider, whose send reads it. */}
      <QueueDismissContext.Provider value={surface.exit}>
        <SendScopeContext.Provider value={surface.sendScope}>
          <RegisteredAnsweringProvider thread={surface.transcript.thread}>
            <ThreadTranscriptContext.Provider value={surface.transcript}>
              <QueuedRunContext.Provider value={surface.queuedRun}>
                <ThreadSurfaceBoxContext.Provider value={surface.box}>
                  <div {...root} {...(pageZone ? null : zone)} data-thread-surface={surface.slug} onKeyDown={(e) => { root.onKeyDown?.(e); sendNowKey(e) }}>
                    {children}
                  </div>
                </ThreadSurfaceBoxContext.Provider>
              </QueuedRunContext.Provider>
            </ThreadTranscriptContext.Provider>
          </RegisteredAnsweringProvider>
        </SendScopeContext.Provider>
      </QueueDismissContext.Provider>
    </ThreadSlugContext.Provider>
  )
}
