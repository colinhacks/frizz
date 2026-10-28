import { createContext, Fragment, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ComponentPropsWithoutRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useSnapshot } from "valtio"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual"
import { AlertTriangle, ArrowDown, Bot, Check, ChevronRight, FileText, HelpCircle, Hourglass, KeyRound, ListChecks, Loader2, Radar, TerminalSquare, type LucideIcon } from "lucide-react"
import { awaitingFenceTitle, awaitingSteps, RETRY_FOLLOW_UP } from "@frizz/shared"
import type { AskQuestion, AwaitingHint, BgShellView, PendingAsk, RegisteredQuestionView, SubAgentView, ThreadView as ThreadViewData, TranscriptEdit, TranscriptMessage, TranscriptPart, TranscriptTodo, TranscriptToolCall } from "@frizz/shared"
import { store, pushDrawer, pushSubAgentDrawer, pushBackgroundShellDrawer, showToast } from "../store.ts"
import { useBackgroundShellLines, useProjectDir, useThreadSnapshot, useTranscript, type ChatMessage, type TranscriptData } from "../hooks.ts"
import { rpc } from "../api/rpc.ts"
import { stripFrontmatter } from "../lib/markdown.ts"
import { useMarkdownHtml, useInlineMarkdownHtml } from "../lib/useMarkdown.ts"
import { splitComposerValue, splitProseAttachments } from "../lib/imagePaths.ts"
import { localImageUrl } from "../lib/markdownTargets.ts"
import { basename } from "../lib/paths.ts"
import { apiBase, projectApiBase } from "../lib/base-path.ts"
import { splitThreadKey } from "../lib/threadKey.ts"
import { DiffBlock, PathLink } from "./DiffBlock.tsx"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { CodeBody } from "./CodeBody.tsx"
import { resolveFileLanguage } from "../lib/syntaxHighlight.ts"
import { TodoBlock } from "./TodoBlock.tsx"
import { followUpParentsIn, splitMessageQuestions, parseQuestionBlock, type QuestionKind, type BlockAnswer, type MessageAnswering } from "../lib/questionBlocks.ts"
import { splitFenceBlocks, type FenceKind } from "../lib/fenceBlocks.ts"
import { showsRegisteredDoneCard } from "../lib/registeredDone.ts"
import { RestedCard, showsRestedCard } from "./RestedCard.tsx"
import { ProviderErrorCard, providerErrorVisible } from "./ProviderErrorCard.tsx"
import { answersNote, isAnswersMessage, parseAnswersCard, type PairedAnswer } from "../lib/answersMessage.ts"
import { questionsByAnchor } from "../lib/questionAnchor.ts"
import { fenceStandsFor, placedRestEnds, resolveQuestionName } from "../lib/questionShadow.ts"
import { FrizzWake } from "./FrizzWake.tsx"
import { LinkifiedText } from "./LinkifiedText.tsx"
import { parseSentContext, splitProseByTokens, tokenLabel, type SentContextItem } from "../lib/composerContext.ts"
import { AnswersCard } from "./AnswersCard.tsx"
import { DividerQuotedTitle, WAKE_DIVIDER_WIDE_ONLY, WakeDivider } from "./WakeDivider.tsx"
import { usePromptBoxSends } from "../lib/sendScope.tsx"
import { QueueDismissContext, QueuedRunContext, ThreadSlugContext } from "../lib/threadContexts.ts"
import { lastAssistantIndex } from "../lib/lastAssistant.ts"
import { ThreadSurface, useThreadMessages, useThreadSurface, useThreadTranscript, type ThreadTranscript } from "./ThreadSurface.tsx"
import { useIsMobile } from "../lib/mobile.ts"
import { MobileAnswerSheet } from "./MobileAnswerSheet.tsx"
import { PhoneAnswerBar, PhoneQuestionsContext, type PhoneQuestions } from "./PhoneQuestionCards.tsx"
import { RegisteredAnswerSheet } from "./RegisteredAnswerSheet.tsx"
import { sendEagerFollowUp } from "../lib/eagerComposerSubmission.ts"
import { limitResumeClock } from "../lib/activityTime.ts"
import { dayAndTime, messageStamp, restGapAt } from "../lib/messageTime.ts"
import { useUnqueueFollowUp, useUnqueueSupported } from "../lib/unqueueFollowUp.ts"
import { useFailedDeliveryActions } from "../lib/failedDelivery.ts"
import { pressSendNow, sendNowStep, useDeliverQueuedNowSupported, useSendNowPending } from "../lib/deliverQueuedNow.ts"
import { SessionMessageLine } from "./SessionMessageLine.tsx"
import { lastAskIndex, messagePresentationText } from "../lib/messagePresentation.ts"
import { inQueuedTail, withRestReplyInline } from "../lib/restReply.ts"
import { steeredSinceRest, useSteeredAt, useTurnHeldForTranscript } from "../lib/steering.ts"
import { snoozePresetInstant, formatSnoozeWake } from "../lib/snooze.ts"
import { noteGithubRefs } from "../lib/githubHovercards.ts"
import { ICON_LABEL_NUDGE } from "../lib/iconAlign.ts"
import { prefs } from "../lib/prefs.ts"
import { getThemeSnapshot, subscribeTheme } from "../lib/theme.ts"
import { isVisualizationThemeAck, visualizationThemeMessage } from "../lib/visualizationThemeProtocol.ts"
import { canAdoptThread } from "../lib/adoption.ts"
import { THREAD_HEADER_CLASS, THREAD_HEADER_CONTROLS_CLASS, THREAD_HEADER_TITLE_CLASS } from "../lib/threadHeaderLayout.ts"
import { SheetClose } from "./ui/SheetHeader.tsx"
import { ThreadActionBar } from "./ThreadActionBar.tsx"
import { QueueOpsSummary } from "./QueueOpsSummary.tsx"
import type { QueueOpsKind } from "../lib/queueOpsCounts.ts"
import { SHELL_WATCHED_NOTE, shellWatched, threadOps } from "../lib/threadOps.ts"
import { MobileThreadHeader } from "./MobileThreadHeader.tsx"
import { HeaderActions } from "./HeaderActions.tsx"
import { ThreadLifecycleActions, StateButton } from "./ThreadLifecycle.tsx"
import { ThreadHeaderFacts } from "./ThreadHeaderFacts.tsx"
import { ThreadTitle } from "./ThreadTitle.tsx"
import { threadLifecycleAvailability } from "../lib/threadLifecycle.ts"
import { ToolDisclosureHeader } from "./ToolDisclosureHeader.ts"
import { subAgentProfileCell } from "../lib/subAgentProfile.ts"
import { FOREGROUND_MARK_AFTER_MS, foregroundToolIsRunning, hasRunningToolIndicator, isPendingForegroundTool, liveBackgroundOperationState } from "../lib/operationIndicators.ts"
import { formatRuntimeElapsed, formatToolDuration } from "../lib/durationLabels.ts"
import { githubRefUrl } from "../lib/githubRef.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { CHILD_OPEN_TITLE, CHILD_RESTED_DOT_CLASS, CHILD_RESTED_TITLE, CHILD_STALE_DOT_CLASS, CHILD_STALE_SHELL_TITLE, CHILD_STALE_TITLE, checksCounterLabel, childOpSubtree, issueCounterLabel, shellLinesLabel, visibleChildOps, type TranscriptShellRecord } from "../lib/childOps.ts"
import { childOpDismisser } from "../lib/dismissChildOp.ts"
import { agentCompletionCall, subAgentCompletionOutcome } from "../lib/subAgentCompletion.ts"
import { agentReading } from "../lib/agentReading.ts"
import { awaitingDefersToQuestions, awaitingProseBlock } from "../lib/awaitingPresentation.ts"
import { ChildOpRow } from "./ChildOpRow.tsx"
import { ThreadLinks } from "./ThreadLinks.tsx"
import { TRANSCRIPT_META_LABEL_CLASS, transcriptMetaChevronClass } from "../lib/transcriptMetaLabels.ts"
import { InteractionStack } from "./InteractionCards.tsx"
import { ClosedQuestionCard, RefusedQuestionReference, RegisteredQuestionCard, RegisteredQuestionStack, SettledQuestionCard, SettledQuestionStack, UnregisteredQuestionCard, type FenceQuestionRow, type SettledQuestion } from "./RegisteredQuestionCards.tsx"
// The shared card chrome and THE question card both live in their own modules now, so every
// surface can render them without importing the thread view. QuestionBlockCard in particular is
// shared with the native-AskUserQuestion path, which reaches it through InteractionCards.tsx —
// a file THIS one imports, so the card could not have stayed here without a module cycle.
import { BLOCK_RADIUS, CARD_ACTION_EXPLAINER, CARD_ACTION_RADIUS, CARD_BODY, CARD_LINK, CARD_PRIMARY_ACTION, CARD_PRIMARY_BUTTON, CardActions, CardContent, CardHead, QUEUE_WRAP, TranscriptCard } from "./TranscriptCard.tsx"
import { QuestionBlockCard } from "./QuestionBlockCard.tsx"
import { settledAskView } from "../lib/interactionQuestion.ts"
// ONE frame for every image the chat renders — border, inset mat, centered picture. See its module
// header for why it spans the message width rather than shrink-wrapping each picture.
import { FRAMED_IMAGE, IMAGE_FRAME_MAT, ImageFrame } from "./ImageFrame.tsx"
// The resting card, shared with the queue (TodosView passes it the event-Snooze; these two surfaces
// deliberately pass no action — see the module header).
import { AwaitingBackgroundCard, AwaitingWaitTable, issueStatusLine, showsRestingCard, watchStatusLine } from "./AwaitingBackgroundCard.tsx"
import { SnoozeCard, showsSnoozeCard } from "./SnoozeCard.tsx"
import { drawsWorking, frozenPendingAsk } from "../lib/operatorBlock.ts"
// Re-exported from their new homes so existing importers (TodosView, the fixtures) keep one
// import path while the definitions live where both question producers can reach them.
export { CARD_BODY, CARD_PRIMARY_BUTTON, CardActions, TranscriptCard } from "./TranscriptCard.tsx"
export { QuestionBlockCard } from "./QuestionBlockCard.tsx"
import { SignInModal } from "./SignInModal.tsx"
import { PROVIDER_LABEL } from "../lib/signIn.ts"
import { takeFullscreenEnterAnchor } from "../lib/fullscreenHandoff.ts"
import { fetchEarlierPage } from "../lib/loadEarlier.ts"
import { buildVirtualTranscriptMessageRows, earlierLoadGate, nextTailFollow, TAIL_FOLLOW_PX, type VirtualTranscriptMessageRow } from "../lib/virtualTranscript.ts"
import { withoutRedundantRestDividers } from "../lib/restDividers.ts"
import { coalesceToolActivityMessages, editedFileCount, historicalToolActivityMessages, isPictureTool, isSettledAsk, isToolActivityException, liveRuntimeStartedAt, liveToolActivityRun, liveToolActivityTail, settledToolActivityLabel, thinkingToolActivityLabel, toolActivityLabel, type ToolActivityMessage } from "../lib/toolActivity.ts"
import { CodexDirectiveCard, MermaidDiagram } from "./CodexRichOutput.tsx"
import { LightboxGallery } from "./Lightbox.tsx"
import { HUMAN_RUN_STEP, META_CARD_STEP, PICTURE_STEP, STEP, USER_TAIL_EXTRA, VSpace } from "./rhythm.tsx"

// Answer types moved to lib/questionBlocks.ts (shared by the queue card, the thread view, and the
// answering controller). Re-exported here so existing importers keep working.
export type { BlockAnswer, MessageAnswering }

// ThreadSlugContext and QueueDismissContext are the thread surface's (components/ThreadSurface.tsx
// provides both). Re-exported here so existing importers keep working.
export { ThreadSlugContext, QueueDismissContext }

// The slug a rendered SUB-AGENT REFERENCE resolves its drill-in against, for message trees that are
// NOT the thread's own transcript. Only the sub-agent drawer sets it (with the PARENT thread's slug),
// so an Agent card or completion divider nested inside a child's transcript is still a live link
// instead of dead text — the maintainer's "some scenarios where that's not the case".
//
// Deliberately SEPARATE from ThreadSlugContext rather than reusing it: that context also authorizes
// whole-thread lifecycle actions (FenceCard's Mark-as-done / park buttons resolve their thread from
// it). Handing the sub-agent drawer the parent's ThreadSlugContext would have put a button on a
// ```done fence inside a CHILD's transcript that archives the PARENT thread. Drill-in is a read; the
// fence buttons are writes, and only the thread's own surfaces may offer them.
export const ChildDrillSlugContext = createContext<string | null>(null)

// The slug to resolve a sub-agent id against, from either surface. ThreadSlugContext wins: on a thread
// or queue surface it is both the drill root and the live-lookup root.
function useChildDrillSlug(): string | null {
  const threadSlug = useContext(ThreadSlugContext)
  const drillSlug = useContext(ChildDrillSlugContext)
  return threadSlug ?? drillSlug
}

// The default thread surface: the session transcript (parsed server-side from the JSONL) rendered
// as a conversation — assistant prose as markdown, tool calls as compact one-liners, a spinner
// while the turn is in flight. The raw terminal is the ⌘T power-user toggle.
//
// LAYOUT: the whole thing is ONE scroll container (the work column itself scrolls) — the chat has NO
// inner overflow region. Content flows at its natural height; the header STICKS to the top and the
// composer STICKS to the bottom (both opaque, so content scrolls cleanly under/over them and replying
// never means scrolling to the end). The scrollbar is hidden. Auto-scroll drives THIS container.
// A thread's full view — the shared composition used BOTH by the main workpane (App, terminal driven by
// the focus machine) and the Open-thread side drawer (ThreadSheet, terminal driven by its own local
// state). Chat is a single scroll column (sticky header + composer); terminal is a fixed-box pane.
// ONE SURFACE. There was a Chat|Doc toggle here until 2026-08-06, where Doc rendered the thread's
// canonical `scratch.md`. That document is gone (see dispatch.ts), and a tab strip whose only job was
// to reach it is a control that now points at nothing — so the toggle, the Radix tab shell it needed,
// and the per-thread persisted tab preference all go with it. The thread is its conversation.
//
// ON A PHONE (below 700px, in the drawer — the only way a phone opens a thread) the chrome is the phone's
// own (mockup v2 §2): a 56px MobileThreadHeader in place of the two-row header and its icon strip —
// Snooze, Goal, the context reading and Restart worker live in the header's ⋯ sheet, and the one
// lifecycle verb that matters at rest belongs to the bottom bar. The /full page (no `onClose`) keeps the
// desktop chrome on every width; a phone never links to it. (Desktop had a lifecycle footer under the
// prompt box until 2026-10-05; its verbs and the context reading moved into ThreadHeader, and the Goal
// into the prompt box's rail.)
export function ThreadView({ slug, onStatusApplied, onClose, showReturnToQueue = false }: { slug: string; onStatusApplied?: () => void; onClose?: () => void; showReturnToQueue?: boolean }) {
  const thread = useThreadSnapshot(slug)
  const phone = useIsMobile() && onClose !== undefined
  // THE RAIL IS BESIDE THIS THREAD — the /full page's own column (`showReturnToQueue` is passed by
  // StandaloneThreadPage alone), at a width that draws its side pane. `splitFileViewer` is that width:
  // the page sets it off the same SPLIT_MIN_PX the `split:` variant shows the pane at. A thread opened
  // in a drawer over /full is not the rail's thread, so it keeps its own ops strip.
  const { splitFileViewer } = useSnapshot(store)
  // The header is handed to ChatView, which owns the thread's surface (ThreadSurface): the surface is
  // the whole thread, header included, as the queue card's is.
  return (
    <ChatView
      slug={slug}
      phone={phone}
      railBeside={showReturnToQueue && splitFileViewer}
      header={phone ? (
        <MobileThreadHeader slug={slug} onClose={onClose} />
      ) : (
        <ThreadHeader slug={slug} onStatusApplied={onStatusApplied} onClose={onClose} showReturnToQueue={showReturnToQueue} />
      )}
    />
  )
}

function ChatView({ slug, phone = false, railBeside = false, header }: { slug: string; phone?: boolean; railBeside?: boolean; header: ReactNode }) {
  const boardThread = useThreadSnapshot(slug)
  // Freshness is centrally managed (transcript-live.ts keeps every observed transcript live); `poll`
  // only gates the SSE-fallback interval for a running thread.
  const q = useTranscript(slug, { poll: boardThread?.runtime === "running" || boardThread?.runtime === "spawning" })
  const queryClient = useQueryClient()
  const loadingEarlierRef = useRef(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [earlierError, setEarlierError] = useState<string | null>(null)
  // Raw server order — each message renders its `parts` in block order (fidelity). Memoized so
  // useLiveAnswering's `liveMsg` identity check compares objects from THIS same list.
  const liveMessages = useMemo(() => q.data?.messages ?? [], [q.data])
  // What this surface draws of it, built by the same pipeline the queue card's is (ThreadSurface
  // useThreadMessages): the rest the board has not reached held back, the running background calls moved
  // to the line of counts, the registered questions that have arrived, the refused fences marked.
  const { messages, openQuestions, settledQuestions, transcriptShells } = useThreadMessages(boardThread, liveMessages)
  // ON A PHONE the registered cards are read-only and answering is a sheet (PhoneQuestionCards,
  // RegisteredAnswerSheet), opened from the bottom bar's "Answer". Null off the phone page. A card is
  // numbered by its place among the questions the sheet steps through, which are the ones drawn.
  const phoneQuestions = useMemo<PhoneQuestions | null>(
    () => (phone ? { numberOf: (id) => openQuestions.findIndex((q) => q.id === id) + 1 } : null),
    [phone, openQuestions],
  )
  const [answerSheetOpen, setAnswerSheetOpen] = useState(false)
  const steerStamp = useSteeredAt()[slug]
  // The send that ends a rest draws where it will land, stamped with the instant this tab sent it — see
  // lib/restReply. The thread view's own stage: the queue card leaves on a send, so it never draws one.
  const presentationMessages = useMemo(
    () => withRestReplyInline(messages, steerStamp === undefined ? undefined : new Date(steerStamp).toISOString()),
    [messages, steerStamp],
  )
  // Cut over presentationMessages, not messages: the coalesced entries below carry a messageIndex into
  // THIS list, and comparing the two index spaces is how a live fence gets marked settled.
  const lastAgentIdx = useMemo(() => lastAssistantIndex(presentationMessages), [presentationMessages])
  // A SEND ENDS THE REST IN THE RENDER THAT DRAWS ITS GHOST BUBBLE — not seconds later, when the board
  // reports the turn (lib/steering.ts steeredSinceRest). Everything below reads this thread, so the
  // resting card, the awaiting fence and the sign-off rung all give way to Working… in that same render.
  const steered = useMemo(
    () => steeredSinceRest(boardThread, presentationMessages, lastAgentIdx, steerStamp),
    [boardThread, presentationMessages, lastAgentIdx, steerStamp],
  )
  // …and at the turn's other end, a rest the board reports before the transcript carries the reply leaves
  // the turn on screen until it does, so the Working row and the reply trade places in one render
  // (lib/steering.ts useTurnHeldForTranscript).
  const thread = useTurnHeldForTranscript(steered, presentationMessages)
  const running = thread?.runtime === "running" || thread?.runtime === "spawning"
  // …and the Working line's clock starts at that send. Until the turn lands, the newest landed message
  // is the rest's own, which would caption the fresh run with the hours since the agent last spoke.
  const steerSince = steered !== boardThread ? steered?.lastUserAt : undefined
  // THE SURFACE (ThreadSurface) owns everything that is the thread's rather than this layout's: the
  // fenced-question controller, the send scope, the drop zone, every context the transcript reads, and
  // what each message MEANS (surface.transcript) — which fence is settled, which registered question a
  // message carries, which answers it pairs with. This component decides only how the drawer and the
  // full-screen page lay those out. `messages` and `presentationMessages` share their indices, so the
  // model's answers address the rows below directly.
  const surface = useThreadSurface({ slug, thread, messages, openQuestions, settledQuestions })
  const { inFlightAnswers } = surface.transcript
  // Question-block interactivity in the thread view: EVERY ask stays answerable, wherever it sits —
  // scroll back to a question a sub-agent return / the agent's own continuation buried and answer it in
  // place. The surface's controller wires each ask's chips AND its own bottom Send button (scoped to just
  // that message's blocks); the queue card runs the identical scope through the same controller.
  // THE PROMPT BOX SENDS THEM (lib/sendScope): with the thread's prompt box mounted under this
  // transcript, Enter in a block is that box's send, and no message draws a Send answers of its own.
  // (The SSE-mode lastActivityAt refetch effect that lived here moved into transcript-live.ts: the
  // manager applies the same activity-edge pull to EVERY observed transcript that the push channel
  // doesn't cover, so no surface has to wire its own.)

  // The drawer transcript is the only scrolling region. The composer, selectors, and running
  // operation rows are siblings, so a long draft cannot push any footer control under a boundary.
  const transcriptRef = useRef<HTMLDivElement>(null)
  // The "Jump to latest" affordance floats in the OUTER frame — a sibling of the scroller, not a
  // child of it — so it is genuinely stationary while the transcript scrolls underneath. Held as
  // state (not a ref) so the portal renders as soon as the node mounts.
  const [jumpOverlay, setJumpOverlay] = useState<HTMLDivElement | null>(null)
  const count = q.data?.messages.length ?? 0

  const loadEarlier = useCallback(async () => {
    if (loadingEarlierRef.current) return
    const current = queryClient.getQueryData<TranscriptData>(["transcript", slug])
    const cursor = current?.beforeCursor
    const expectedKey = current?.transcriptKey
    if (!current?.hasEarlier || !cursor || !expectedKey) return
    loadingEarlierRef.current = true
    setLoadingEarlier(true)
    setEarlierError(null)
    try {
      await fetchEarlierPage({ slug, cursor, expectedKey, queryClient, refetch: () => q.refetch() })
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load earlier transcript history"
      setEarlierError(message)
    } finally {
      loadingEarlierRef.current = false
      setLoadingEarlier(false)
    }
  }, [q, queryClient, slug])

  return (
    <ThreadSurface surface={surface} className="flex-1 min-h-0 flex flex-col">
    {header}
    <PhoneQuestionsContext.Provider value={phoneQuestions}>
    <div
      data-drawer-scroll-ready={q.isPending ? "false" : "true"}
      className="flex-1 min-h-0 flex flex-col overflow-hidden outline-none"
    >
      {/* The scroll viewport's own coordinate frame: `relative` here (rather than on the scroller) is
          what lets the floating "Jump to latest" overlay below sit still while the transcript scrolls.
          The scroller itself carries data-virtualized-transcript-scroll — the drawer virtualizes now
          too, so the old "standalone" name would be a lie.

          `[overflow-anchor:none]` on the scroller below leaves ONE authority over its offset. The
          virtualizer already corrects scrollTop itself every time a row above the reader is re-measured;
          Chrome's native scroll anchoring corrects it too, off its own anchor node, and neither knows
          about the other — so both firing on one layout change moves the reader by that correction
          TWICE. TodosView suspends native anchoring around exactly this hazard for the queue
          (suspendNativeAnchoring, "THE one owner"); the drawer transcript is the same hazard and was
          simply never given the same treatment. */}
      <div className="relative min-h-0 flex-1 flex flex-col">
      <div
        ref={transcriptRef}
        data-drawer-transcript-scroll
        data-virtualized-transcript-scroll
        tabIndex={0}
        role="region"
        aria-label="Thread conversation"
        aria-busy={loadingEarlier ? true : undefined}
        // pb-3 is the transcript viewport's OWN bottom air, on the scroller rather than on the content:
        // the virtualized transcript sizes its content div to the virtualizer's exact totalSize (no room
        // for a trailing pad there). 20px of trailing space read as the last row crowding the prompt
        // box; 32px reads as an ending.
        className="relative min-h-0 flex-1 overflow-y-auto pb-3 outline-none [overflow-anchor:none] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ink-60"
      >
      {count > 0 ? (
        <VirtualizedThreadTranscript
          slug={slug}
          transcriptRef={transcriptRef}
          transcriptKey={q.data?.transcriptKey}
          messages={presentationMessages}
          steerSince={steerSince}
          transportFallback={q.transportFallback}
          isFetching={q.isFetching}
          refresh={() => void q.refetch()}
          retryLiveUpdates={q.retryLiveUpdates}
          hasEarlier={q.data?.hasEarlier === true}
          beforeCursor={q.data?.beforeCursor}
          loadingEarlier={loadingEarlier}
          earlierError={earlierError}
          loadEarlier={() => void loadEarlier()}
          jumpOverlay={jumpOverlay}
          openAtLastMessage={phone && !running}
        />
      ) : (
      <>
      <InteractionStack
        thread={thread}
        className="px-6 pt-5"
        autoFocusFirst
      />
      {/* A REGISTERED question sits with the pending interactions rather than in the transcript: both are
          things the human still owes an answer to, and neither may scroll out of reach. */}
      <RegisteredQuestionStack thread={thread} inFlight={inFlightAnswers} className="px-6 pt-5" />
      {q.transportFallback && (
        <TranscriptSyncFallbackBanner fallback={q.transportFallback} isFetching={q.isFetching} onRefresh={() => void q.refetch()} onRetryLive={q.retryLiveUpdates} className="mx-6 mt-3" />
      )}
      {/* AN EMPTY TRANSCRIPT, the one thing this branch draws: VirtualizedThreadTranscript draws every
          message the thread has, and it needs at least one to hang its rows on. The thread view drew the
          whole transcript a second way here until 2026-10-14, a non-virtualized column no production
          surface reached once the drawer and the full-screen page both virtualized. */}
      <div className="flex min-h-full flex-col px-6 py-5">
        <div className="flex-1 flex items-center justify-center text-sm text-muted">
          {q.isPending ? (
            // The transcript hasn't loaded YET — `count` is 0 only because `q.data` is still
            // undefined, not because the session is empty. For a long-running chat the initial
            // fetch/parse of a large transcript can take a beat, and claiming "Session starting…"
            // there is wrong (it may have been running for hours). Show a neutral load state until
            // the query resolves and we actually know whether there are messages.
            <span className="flex items-center gap-2"><Dots /> Loading…</span>
          ) : running ? (
            <span className="flex items-center gap-2"><Dots /> Session starting…</span>
          ) : canAdoptThread(thread) ? (
            // A thread frizz never originated (pre-existing .frizz board): no session, no
            // transcript. Cold-adopt it — a fresh worker reads the thread FILE and continues;
            // per the frizz contract the doc, not the conversation, is the durable context.
            // (Session language, not "agent": the thing that attaches IS an agent process, but the
            // UI's thread/session vocabulary keeps "agent" for genuine child sub-agents only.)
            <div className="text-center">
              <p className="mb-3">No session is attached to this thread yet.</p>
              <button
                className="btn-ghost border border-border text-[12px]"
                onClick={() => rpc.adoptThread({ slug }).catch(() => {})}
              >
                Start a session on this thread
              </button>
            </div>
          ) : (
            "No conversation yet."
          )}
        </div>
      </div>
      </>
      )}
      </div>
      {/* Floating-affordance layer, pinned to the bottom-right of the scroll VIEWPORT. It is a
          sibling of the scroller, so nothing here moves when the transcript scrolls; the layer
          itself is click-through and only its children take pointer events. */}
      <div
        ref={setJumpOverlay}
        data-transcript-overlay
        className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex justify-end p-4 [&>*]:pointer-events-auto"
      />
      </div>
      {/* This entire footer is deliberately non-scrolling: transcript history alone overflows. */}
      {/* ONE hairline, at the queue card's weight. `border-border/60` is exactly the rule the queue
          card draws under its header (TodosView); the chat footer used to draw full-strength
          `border-border` AND have ThreadActionBar draw a second one under it, which stacked into a
          2px rule. Keep the separator on THIS wrapper only — the bar inside is padding-only. */}
      {/* The device's bottom inset is the LAST thing in the column, under the prompt box — the drawer
          reaches the physical bottom edge of a tablet or a notched screen. The lifecycle footer used to
          sit under this and carried it, until the footer went on 2026-10-05. Not on a phone: its bar
          (Composer's phone layout) pads itself for the inset and the keyboard together. */}
      <div data-thread-chat-footer className={`z-10 shrink-0 border-t border-border/60 bg-panel ${phone ? "" : "pb-[env(safe-area-inset-bottom)]"}`}>
        <ThreadActionBar
          slug={slug}
          // THE LIVE OPS AS ONE LINE OF COUNTS over the prompt box, their rows one hover away — the
          // queue card's line (QueueOpsSummary), so a thread reads the same in its drawer as on its card
          // (maintainer 2026-10-09). The rows hung under the prompt box until then (2026-07-09).
          // The phone draws no ops at all (mockup v2 §2): a sub-agent is already a row in the transcript
          // and on the board, and the registered files and links are the ⋯ sheet's. Nor does /full while
          // its rail stands beside the column (maintainer 2026-10-02: "in the full screen view we don't
          // need to show … the active shells and subagents and all of that beneath the prompt box anymore
          // 'cause it's already showing up in the sidebar to the right"). The rail (FocusRail) lists every
          // row the line counts, its saved links and Codex shells included.
          above={phone || railBeside || !thread ? undefined : <QueueOpsSummary thread={thread} transcriptShells={transcriptShells} />}
          phoneBarOverride={phone && openQuestions.length > 0
            ? (api) => <PhoneAnswerBar count={openQuestions.length} onAnswer={() => setAnswerSheetOpen(true)} onReply={api.editReply} />
            : undefined}
          // The box matches the header above it: the phone bar under the phone's chrome, the desktop box
          // (and its rail's Goal) under the desktop header — which /full keeps at every width.
          phoneChrome={phone}
        />
      </div>
      {phone && answerSheetOpen && <RegisteredAnswerSheet questions={openQuestions} onClose={() => setAnswerSheetOpen(false)} />}
    </div>
    </PhoneQuestionsContext.Provider>
    </ThreadSurface>
  )
}

// How long after a wheel/touch/key gesture the reader still owns the scroller. Long enough to cover
// trackpad momentum between discrete events, short enough that it never outlives the gesture itself.
const READER_GESTURE_MS = 700

// …and a press or a key ON A CONTROL in the transcript is not one. Done, Send answers, an option, a
// question's text box: each starts the very changes the tail follow exists to absorb — the card folding
// into its message, the bubble, the Working row — and a click read as the reader taking the scroller
// left all of them to land inside the 700ms gesture window, where any distance from the bottom counts as
// the reader's own choice. A reader at the tail who pressed Done was detached by the first transient
// frame and shown "Jump to latest" (measured on a real worker, 2026-10-12). A press on the scrollbar
// targets the scroller itself, and a drag that starts on a control still arrives as touchmove/wheel.
const TRANSCRIPT_CONTROL = "button, a[href], input, textarea, select, summary, label, [role='button'], [role='checkbox'], [role='radio'], [contenteditable='true']"
function onTranscriptControl(event: Event): boolean {
  return event.target instanceof Element && event.target.closest(TRANSCRIPT_CONTROL) !== null
}

// How long an anchor restore (a pin move, a head trim) owns the scroller while the rows it disturbed
// settle. The settling lands on a ResizeObserver pass one or more frames after the commit, so the restore
// has to outlive the commit — but it must stay far under READER_GESTURE_MS, since a reader who scrolls
// during it should win the moment it ends.
const ANCHOR_RESTORE_MS = 250

// How long the phone's open-at-the-last-message landing holds its row at the pane top while the rows
// around it measure (see VirtualizedThreadTranscript's initial scroll). A cold open measures every row
// from its estimate, and markdown, code and images keep settling for several frames after mount.
const OPEN_AT_MESSAGE_HOLD_MS = 900

// Opt-in drift diagnostic: `localStorage["frizz.debugScroll"] = "1"`, then reload.
//
// The mid-scroll drift this file works to prevent does NOT reproduce headlessly — a scripted wheel has
// no momentum, and a seeded transcript has no images or async-settling cards — so a harness that goes
// green proves only that it did not reproduce, not that the reader is safe. This is the way to catch a
// real occurrence on the machine where it happens: it warns whenever the row under the reader's eye
// moves while the reader is not touching the scroller, and names the pin at that moment, so a live
// sighting comes with its size and its trigger instead of "it jumped again".
const DEBUG_SCROLL = (() => {
  try { return localStorage.getItem("frizz.debugScroll") === "1" } catch { return false }
})()

type TranscriptTransportFallback = ReturnType<typeof useTranscript>["transportFallback"]

// LIVE UPDATES PAUSED — the transcript fell back from push to HTTP, so what is on screen may lag. ONE
// banner for every surface that draws a transcript: the drawer's two paths and the queue card, which drew
// none until 2026-10-09 and so went quietly stale with no way to refresh (maintainer: "Queue card gets
// the 'Live transcript updates paused' banner"). `className` is the caller's placement.
export function TranscriptSyncFallbackBanner({ fallback, isFetching, onRefresh, onRetryLive, className = "" }: {
  fallback: NonNullable<TranscriptTransportFallback>
  isFetching: boolean
  onRefresh: () => void
  onRetryLive: () => void
  className?: string
}) {
  return (
    <div
      data-transcript-sync-fallback
      className={`flex flex-wrap items-center gap-2.5 ${BLOCK_RADIUS} border border-border-strong bg-panel-2 px-4 py-2.5 text-[12px] ${className}`}
      title={fallback.kind === "payload-too-large"
        ? `Live payload ${fallback.actualBytes} bytes; socket limit ${fallback.maxBytes} bytes`
        : `Transcript read budget reached (${fallback.scope}); retry after about ${fallback.retryAfterMs}ms`}
    >
      <AlertTriangle size={13} className="shrink-0 text-muted" />
      <div className="min-w-[180px] flex-1 leading-snug text-fg/85">
        <span className="font-medium">Live transcript updates paused.</span>{" "}
        {fallback.kind === "payload-too-large"
          ? "The transcript is too large for push; it refreshes over HTTP each time the thread moves."
          : "The live read budget was reached; the last complete copy remains visible. Retry in a moment."}
      </div>
      <button type="button" disabled={isFetching} onClick={onRefresh} className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-fg/90 transition-colors hover:bg-panel disabled:opacity-40">
        {isFetching ? "Refreshing…" : "Refresh once"}
      </button>
      <button type="button" onClick={onRetryLive} className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-fg/90 transition-colors hover:bg-panel">
        Retry live
      </button>
    </div>
  )
}
type VirtualThreadRow =
  // A zero-height sentinel that is ALWAYS row 0, so `getItemKey(0)` is a constant for the list's whole
  // life. That is load-bearing, not decoration — see the head-trim realignment below, which is only
  // correct while TanStack's own `anchorTo:"end"` preservation stays dormant. It renders nothing.
  | { key: "head-anchor"; kind: "head-anchor" }
  | { key: "interactions"; kind: "interactions" }
  // A REGISTERED question, dropped at the REST IT WAS ASKED AT rather than at the tail — see
  // lib/questionAnchor. Its own row because it belongs BETWEEN two messages, which the tail cannot be.
  | { key: string; kind: "questions"; questions: RegisteredQuestionView[]; send?: boolean }
  // ANSWERED registered questions, greyed, in the slot the open card filled when it was answered — see
  // lib/settledQuestions. Its own row for the same reason: it sits between two messages.
  | { key: string; kind: "settled-questions"; questions: SettledQuestion[] }
  | { key: "transport-fallback"; kind: "transport-fallback" }
  | { key: string; kind: "earlier-history" }
  | ({ kind: "message"; restGap: string | null } & VirtualTranscriptMessageRow)
  | { key: "runtime-status"; kind: "runtime-status" }
  | { key: string; kind: "queued"; message: ChatMessage; messageIndex: number; gap: number }
  | { key: "queued-send-now"; kind: "queued-send-now" }

// THE RUNTIME-STATUS LADDER — ONE slot at the transcript's end, nine mutually exclusive rungs, hardest
// reading first, and ONE renderer for all of it.
//
// The transcript draws this slot in two places — the thread view's `runtime-status` row and the queue
// card's tail (TodosView) — and both draw it as RuntimeStatusSlot, off one model (useRuntimeTail, below).
// The queue card kept a seventh, hand-rolled copy until 2026-10-09,
// and it had drifted exactly the way this comment predicts: no provider-failure cards at all (so a
// failed Codex thread sat in the queue reading as an ordinary rest), several rungs able to draw at once,
// and the policy-denial card on the other side of the ending card.
// Both drew their own copy of the ladder, and each ALSO carried its own copy of two derived facts — is
// any rung showing (the slot's gate), and is `working` the rung that won (the spacing above it, which is
// a quiet meta line for that rung and a card's STEP for every other). Six hand-mirrored copies of one
// ladder, and the rung order repeated inside four of them.
//
// That is the awaiting card's own bug (2026-09-04: "it'll re-render the awaiting card in a totally
// different fucking way") one level up: the SAME slot, drawn by more than one piece of code, so which
// one you get depends on the thread's state rather than on anything the reader did. Nothing had drifted
// yet — the copies still agreed, rung for rung — but every one of them had to be edited in lockstep
// forever, and that is not a property to rely on. So the ladder is stated ONCE, here: `runtimeStatusRung`
// decides which rung wins, and everything else is derived from that answer rather than re-deriving it.
export type RuntimeStatusRung = "provider-fault" | "provider-error" | "limit-pause" | "pending-ask" | "working" | "snooze" | "resting" | "registered-done" | "rested"

/** What each caller knows that the ladder cannot work out for itself. `registeredDone`/`restedCard` are
 *  keyed on the final assistant message, which each path computes off its own list. */
export interface RuntimeStatusState {
  thread: ThreadViewData | undefined
  showWorking: boolean
  registeredDone: boolean
  restedCard: boolean
  errorVisible?: boolean
}

/** WHICH RUNG WINS, or null when the slot draws nothing at all. The order is the ladder: a provider auth
 *  fault outranks everything (nothing in the thread can make progress until the credential is restored),
 *  a foreign session's frozen ask outranks the Working… spinner, the human's own park outranks the benign
 *  resting card, and `rested` is the residual. Background sub-agents and shells are NOT here: they live
 *  in the anchored ops strip, which stays visible mid-turn. There is no permission-prompt rung: a prompt
 *  is the ask row's own card, and what this slot may say around one is lib/operatorBlock.ts. */
export function runtimeStatusRung({ thread, showWorking, registeredDone, restedCard, errorVisible }: RuntimeStatusState): RuntimeStatusRung | null {
  if (thread?.providerError?.retrying) return "provider-error"
  if (thread?.providerFault && !thread.foreign) return "provider-fault"
  if (thread?.limitPause && !thread.foreign) return "limit-pause"
  if (frozenPendingAsk(thread)) return "pending-ask"
  if (drawsWorking(thread, showWorking)) return "working"
  if (thread?.providerError) return errorVisible ? null : "provider-error"
  if (showsSnoozeCard(thread)) return "snooze"
  // showsRestingCard, NOT the raw awaitingBackground flag: gating on the bare flag opened the slot for a
  // bg-snoozed thread, every rung then drew null, and the slot was an empty gap at the transcript's end
  // (the gate-vs-renderer mismatch of 2026-08-25 — which is exactly what one predicate for both prevents).
  if (showsRestingCard(thread)) return "resting"
  if (registeredDone) return "registered-done"
  if (restedCard) return "rested"
  return null
}

/** The SPACE above the slot. Only the Working… rung is a quiet meta line rather than a card, so only it
 *  joins the tight run under a meta tail; every card rung keeps STEP. */
export function runtimeStatusGapFor(state: RuntimeStatusState, messages: readonly ChatMessage[]): number {
  return runtimeStatusRung(state) === "working" ? workingIndicatorGap(messages) : STEP
}

export function RuntimeStatusLadder({
  state,
  slug,
  retryText,
  liveRuntimeStart,
  liveActivityLabel,
  liveToolRun,
  onRestingExit,
  onRestingExitFailed,
  wrap,
}: {
  state: RuntimeStatusState
  slug: string
  /** The human's last ask, for the fault card's retry. */
  retryText: string | undefined
  liveRuntimeStart: string | undefined
  liveActivityLabel: string | undefined
  liveToolRun: { tools: readonly TranscriptToolCall[]; at?: string } | undefined
  /** THE QUEUE'S optimistic card exit, and the only thing the queue card adds to the ladder: the resting
   *  card's snooze and its steps reply fade the card the instant they are sent, and put it back if the
   *  server declines. RuntimeStatusSlot passes the surface's exit; off the queue there is none. */
  onRestingExit?: () => void
  onRestingExitFailed?: () => void
  /** The queue card's narrower column: the done card wraps its prose there (FenceCard `wrap`). */
  wrap?: boolean
}) {
  const thread = state.thread
  switch (runtimeStatusRung(state)) {
    case "provider-fault":
      return <ProviderFaultCard slug={slug} sessionId={thread!.sessionId} fault={thread!.providerFault!} retryText={retryText} />
    case "provider-error":
      return <ProviderErrorCard error={thread!.providerError!} />
    case "limit-pause":
      return <LimitPauseCard slug={slug} sessionId={thread!.sessionId} pause={thread!.limitPause!} />
    case "pending-ask":
      return <PendingAskCard ask={frozenPendingAsk(thread)!} />
    case "working":
      return <WorkingIndicator since={thread?.lastUserAt} startedAt={liveRuntimeStart} activityLabel={liveActivityLabel} run={liveToolRun} />
    case "snooze":
      return <SnoozeCard thread={thread!} />
    case "resting":
      return <AwaitingBackgroundCard thread={thread!} onSnooze={onRestingExit} onSnoozeFailed={onRestingExitFailed} onReplied={onRestingExit} onReplyFailed={onRestingExitFailed} />
    // THE THREAD'S OWN ENDING, for a sign-off that came in as a tool call rather than a fence: the same
    // card the fence draws, in the slot the fence would have occupied at the transcript's end. Below
    // everything because `done` refuses while anything above could still be true — an open question or an
    // armed watch blocks the verb — so a thread showing this is at rest with nothing left to wait on.
    case "registered-done":
      return <FenceCard fenceKind="done" body={thread!.lastFence!.body} hints={thread!.lastFence!.hints} wrap={wrap} />
    // NOTHING ELSE APPLIES, and the bottom of the thread still has to say so — see RestedCard.
    case "rested":
      return <RestedCard thread={thread!} />
    default:
      return null
  }
}

/** WHAT THE SLOT DRAWS, worked out once for every surface: which rung wins, whether the slot draws at
 *  all, the space above it, and what its Working… line reads. The queue card and the thread view each
 *  derived all of this from the same predicates, in the same order, until 2026-10-14 — and the thread
 *  view twice, once per transcript column. */
export interface RuntimeTail {
  state: RuntimeStatusState
  rung: RuntimeStatusRung | null
  /** A rung won, or the policy-denial card stands without one. A surface whose slot is a row of its own
   *  (the virtualized transcript) adds that row on this. */
  shown: boolean
  /** The space above the slot (runtimeStatusGapFor). */
  gap: number
  /** The human's last ask, which the provider-fault card's Retry resends. */
  retryText: string | undefined
  liveRuntimeStart: string | undefined
  liveActivityLabel: string | undefined
  liveToolRun: { tools: readonly TranscriptToolCall[]; at?: string } | undefined
}

/** The slot's model, from the surface's transcript model (useThreadSurface's `transcript`) and the two
 *  lists only the surface has: `coalesced`, the messages it draws through coalesceToolActivityMessages,
 *  and `drawn`, that list as it finally draws it, whose last row decides the space above a Working… line.
 *  `steerSince` is the send that opened a turn the board has not reported yet — the thread view's; a
 *  queue card leaves on its own send. */
export function useRuntimeTail(
  transcript: ThreadTranscript,
  coalesced: readonly ToolActivityMessage[],
  drawn: readonly ToolActivityMessage[],
  steerSince?: string,
): RuntimeTail {
  const { thread, messages, running, lastAgentIdx } = transcript
  const projectDir = useProjectDir()
  const lastAskIdx = useMemo(() => lastAskIndex(messages), [messages])
  return useMemo(() => {
    // A completion the worker REGISTERED rather than fenced, and the residual rested card, are both keyed
    // on the final assistant message (lib/registeredDone, RestedCard): a worker that also wrote the fence
    // gets one card, from the message, not two — and a rest whose only fence the server refused is a bare
    // one (lib/questionFaults).
    const last = lastAgentIdx >= 0 ? messages[lastAgentIdx] : undefined
    // `errorVisible` reads what the surface draws, where a provider-error row survives every fold, so the
    // row and the ladder's card never double up.
    const state: RuntimeStatusState = {
      thread,
      showWorking: running,
      registeredDone: showsRegisteredDoneCard(thread, last?.text),
      restedCard: showsRestedCard(thread, last?.text, last?.refusedFences),
      errorVisible: providerErrorVisible(coalesced.map((entry) => entry.message), thread?.providerError),
    }
    const rung = runtimeStatusRung(state)
    // The run the shimmer stands for, and its newest call (the one it NAMES): the run is what expanding
    // the shimmer opens — the same calls history is withholding. The clock counts this stretch of work,
    // not the turn (liveRuntimeStartedAt).
    const liveToolActivity = running ? liveToolActivityTail(coalesced) : undefined
    return {
      state,
      rung,
      shown: rung !== null || Boolean(thread?.permPolicy),
      gap: runtimeStatusGapFor(state, drawn.map((entry) => entry.message)),
      retryText: lastAskIdx >= 0 ? messages[lastAskIdx]?.text : undefined,
      liveRuntimeStart: running ? laterInstant(liveRuntimeStartedAt(coalesced), steerSince) : undefined,
      liveActivityLabel: liveToolActivity ? toolActivityLabel(liveToolActivity, projectDir) : undefined,
      liveToolRun: running ? liveToolActivityRun(coalesced) : undefined,
    }
  }, [thread, messages, running, lastAgentIdx, lastAskIdx, coalesced, drawn, steerSince, projectDir])
}

/** THE SLOT, as every surface draws it: the space above it, the one rung that won, and the policy-denial
 *  card. The denial is the ladder's SIBLING, not a rung: the rungs are mutually exclusive because each
 *  describes the one thing blocking now, while a denial already happened and blocks nobody, so it sits
 *  under whatever card won and stands alone without one. The resting card's snooze and steps reply take
 *  the surface's exit (QueueDismissContext): a queue card fades the instant they are sent and comes back
 *  if the server declines; a surface that stays has no exit. `wrap` is the queue card's narrower column. */
export function RuntimeStatusSlot({ tail, wrap }: { tail: RuntimeTail; wrap?: boolean }) {
  const slug = useContext(ThreadSlugContext)
  const exit = useContext(QueueDismissContext)
  const thread = tail.state.thread
  if (!tail.shown || !slug) return null
  return (
    <>
      <VSpace h={tail.gap} />
      <RuntimeStatusLadder
        state={tail.state}
        slug={slug}
        retryText={tail.retryText}
        liveRuntimeStart={tail.liveRuntimeStart}
        liveActivityLabel={tail.liveActivityLabel}
        liveToolRun={tail.liveToolRun}
        onRestingExit={exit?.dismiss}
        onRestingExitFailed={exit?.cancel}
        wrap={wrap}
      />
      {thread?.permPolicy ? (
        <div className={tail.rung !== null ? "mt-3" : ""}>
          <PermPolicyDenialCard policy={thread.permPolicy} denies={thread.permDenies} />
        </div>
      ) : null}
    </>
  )
}

function VirtualizedThreadTranscript({
  slug,
  transcriptRef,
  transcriptKey,
  messages,
  steerSince,
  transportFallback,
  isFetching,
  refresh,
  retryLiveUpdates,
  hasEarlier,
  beforeCursor,
  loadingEarlier,
  earlierError,
  loadEarlier,
  jumpOverlay,
  openAtLastMessage = false,
}: {
  slug: string
  transcriptRef: React.RefObject<HTMLDivElement | null>
  transcriptKey?: string
  messages: ChatMessage[]
  // The send that ended the rest, while the board has yet to report its turn — the parent's copy says why.
  steerSince?: string
  transportFallback: TranscriptTransportFallback
  isFetching: boolean
  refresh: () => void
  retryLiveUpdates: () => void
  hasEarlier: boolean
  beforeCursor?: string | null
  loadingEarlier: boolean
  earlierError: string | null
  loadEarlier: () => void
  jumpOverlay: HTMLElement | null
  // The phone opens a thread at rest on the START of its last message rather than the end of it — see
  // the initial-scroll effect below. Read once, when the transcript first lands.
  openAtLastMessage?: boolean
}) {
  // What the thread says about each message, from the surface this transcript is drawn in — the same
  // model the queue card reads. `messages` here is the presentation list, which shares its indices with
  // the list the model was built over.
  const transcript = useThreadTranscript()
  const { thread, running, lastAgentIdx, awaitingCut, restingShown, heldIdx, paired, inFlightAnswers, placement, settledPlacement, openQuestions } = transcript
  // Presentation-only coalescing: provider batching must not mint one loader per pure tool turn. Original
  // indices ride beside the display message, so paired answers keep addressing server truth.
  const coalescedActivityMessages = useMemo(() => coalesceToolActivityMessages(messages), [messages])
  // A live tool run belongs to the runtime slot, never to history; once it settles the whole run returns
  // as one `Ran N tool calls` disclosure. Then the rest hairlines that only restate their surroundings
  // drop out (isRedundantRestDivider) — LAST, so "the next thing the reader sees" is what this list
  // draws — with the resting card as the third reason a fence draws nothing (rendersNothingIn).
  const activityMessages = useMemo(() => {
    const entries = running ? historicalToolActivityMessages(coalescedActivityMessages) : coalescedActivityMessages
    return withoutRedundantRestDividers(entries, rendersNothingIn(entries, awaitingCut, restingShown, heldIdx))
  }, [coalescedActivityMessages, running, awaitingCut, restingShown, heldIdx])
  const messageRows = useMemo(() => {
    const rows = buildVirtualTranscriptMessageRows(
      activityMessages.map((entry) => entry.message),
      rendersNothingIn(activityMessages, awaitingCut, restingShown, heldIdx),
      messageGap,
    )
    // A rest the human came back to after a long wait draws as the instant they came back (restGapOf).
    // The next ROW is the next thing drawn, which is what the redundancy filter above already measured.
    return rows.map((row, i) => ({
      ...row,
      messageIndex: activityMessages[row.messageIndex].messageIndex,
      restGap: restGapOf(row.message, rows[i + 1]?.message),
    }))
  }, [activityMessages, awaitingCut, restingShown, heldIdx])
  // The slot at the end, off the model the queue card draws its own from (useRuntimeTail). Its ROW exists
  // whenever the slot draws anything — a rung, or the policy-denial card a rest with no rung still owes.
  const runtimeTail = useRuntimeTail(transcript, coalescedActivityMessages, activityMessages, steerSince)
  const hasRuntimeRow = runtimeTail.shown
  // EVERY OPEN QUESTION, at the newest rest that CLAIMS it — the rest that asked it, or a later one whose
  // ```awaiting fence names it under `questions:` (lib/questionAnchor) — minus the ones a marker PLACED
  // inside a message (placeQuestions). Never pulled under a newer handoff that says nothing about it: that
  // was the 2026-08-31..2026-10-05 rule, and it let a stale ask supersede the worker's own sign-off.
  // `byRow` keys into `messageRows` (the coalesced list actually rendered, which drops messages the
  // transcript does not draw), so the group hangs off the last row at or before its anchor; -1 means the
  // rest is older than the loaded window and it goes above everything rather than back at the bottom,
  // lying about being current. `tail` is the ordinary case — the worker asked and rested.
  const questionGroups = useMemo(() => {
    const tail: RegisteredQuestionView[] = []
    const byRow = new Map<number, RegisteredQuestionView[]>()
    const tailAnchor = messages.length - 1
    const rowOf = (anchor: number) => {
      let rowIdx = -1
      for (let i = 0; i < messageRows.length; i++) {
        if (messageRows[i].messageIndex > anchor) break
        rowIdx = i
      }
      return rowIdx
    }
    const unplaced = openQuestions.filter((q) => !placement.placedIds.has(q.id))
    // `from: 0`: a question the human has typed past, asked above the loaded window, is not hoisted over
    // everything — it draws where its message is once that is loaded (lib/questionAnchor questionsByAnchor).
    for (const [anchor, group] of questionsByAnchor(messages, unplaced, { from: 0 })) {
      if (anchor >= tailAnchor) { tail.push(...group); continue }
      const rowIdx = rowOf(anchor)
      const at = byRow.get(rowIdx)
      if (at) at.push(...group)
      else byRow.set(rowIdx, [...group])
    }
    // A question a marker PLACED renders inside its message and leaves its anchor group, but its REST
    // still needs a Send: the stack at that rest's end draws one even with no card of its own. Only at a
    // rest that holds a placed card — a Send at the tail with nothing above it is the 2026-09-13 report.
    let tailSend = false
    const sendRows = new Set<number>()
    for (const end of placedRestEnds(messages, placement)) {
      if (end >= tailAnchor) { tailSend = true; continue }
      const rowIdx = rowOf(end)
      sendRows.add(rowIdx)
      if (!byRow.has(rowIdx)) byRow.set(rowIdx, [])
    }
    return { byRow, tail, tailSend, sendRows }
  }, [messageRows, messages, openQuestions, placement])
  // The ANSWERED questions' anchors, keyed into `messageRows` the same way: the last row at or before
  // the anchor. No tail special case — a settled card is not an ask, so it never rides the
  // interactions row; anchored at the last message it simply follows that message's row.
  const settledByRow = useMemo(() => {
    const byRow = new Map<number, SettledQuestion[]>()
    for (const [anchor, group] of settledPlacement.anchored) {
      let rowIdx = -1
      for (let i = 0; i < messageRows.length; i++) {
        if (messageRows[i].messageIndex > anchor) break
        rowIdx = i
      }
      if (rowIdx < 0) continue
      const at = byRow.get(rowIdx)
      if (at) at.push(...group)
      else byRow.set(rowIdx, [...group])
    }
    return byRow
  }, [messageRows, settledPlacement.anchored])
  const rows = useMemo<VirtualThreadRow[]>(() => {
    const next: VirtualThreadRow[] = [{ key: "head-anchor", kind: "head-anchor" }]
    if (transportFallback) next.push({ key: "transport-fallback", kind: "transport-fallback" })
    if (hasEarlier || loadingEarlier || earlierError) {
      next.push({ key: `earlier-history:${beforeCursor ?? "complete"}`, kind: "earlier-history" })
    }
    const before = questionGroups.byRow.get(-1)
    if (before) next.push({ key: "questions:head", kind: "questions", questions: before, send: questionGroups.sendRows.has(-1) })
    messageRows.forEach((row, i) => {
      next.push({ ...row, kind: "message" as const })
      // Answered before anything still open at the same slot was, so drawn above it.
      const settledGroup = settledByRow.get(i)
      if (settledGroup) next.push({ key: `settled-questions:${row.key}`, kind: "settled-questions", questions: settledGroup })
      const group = questionGroups.byRow.get(i)
      if (group) next.push({ key: `questions:${row.key}`, kind: "questions", questions: group, send: questionGroups.sendRows.has(i) })
    })
    // THE ASK GOES AT THE TAIL. It was row 0 until 2026-08-02, which put an answerable card ABOVE the
    // operator's own first message — a transcript scrolled to its end (this list anchors there) left it
    // 5,000px up and unmounted by the virtualizer, so a thread blocked on a question rendered as nothing
    // but a tool call that never finished. It belongs where the block actually happened: after the last
    // message, above the runtime status and the queued sends that are stuck behind it.
    next.push({ key: "interactions", kind: "interactions" })
    if (hasRuntimeRow) next.push({ key: "runtime-status", kind: "runtime-status" })
    let previousQueued: ChatMessage | null = null
    messages.forEach((message, messageIndex) => {
      if (!inQueuedTail(message)) return
      const key = `queued:${message.deliveryId ?? message.sourceId ?? messageIndex}`
      // The first one clears whatever stands above the tail; each after it takes the pitch of the
      // run it continues (messageGap — the human's own sends stack at HUMAN_RUN_STEP).
      const gap = previousQueued ? messageGap(previousQueued, message) : hasRuntimeRow || messageRows.length > 0 ? STEP : 0
      next.push({ key, kind: "queued", message, messageIndex, gap })
      previousQueued = message
    })
    if (previousQueued) next.push({ key: "queued-send-now", kind: "queued-send-now" })
    return next
  }, [beforeCursor, earlierError, hasEarlier, hasRuntimeRow, loadingEarlier, messageRows, messages, questionGroups, settledByRow, transportFallback])

  // The row a "load earlier" must keep under the reader's eye, from the moment it is asked for until the
  // prepend's layout effect has put it back (see rangeExtractor below and the effect that consumes it).
  const pendingPrependAnchorRef = useRef<{ rowKey: string; viewportTop: number } | null>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => transcriptRef.current,
    getItemKey: (index) => rows[index]?.key ?? index,
    estimateSize: (index) => {
      const row = rows[index]
      if (!row) return 80
      if (row.kind === "head-anchor" || row.kind === "interactions") return 1
      if (row.kind === "queued-send-now") return 22
      if (row.kind === "earlier-history") return 42
      if (row.kind === "transport-fallback") return 76
      if (row.kind === "runtime-status") return 54
      if (row.kind === "questions") return 220
      if (row.kind === "settled-questions") return 140
      return row.kind === "message" ? 108 + row.gap : 82 + row.gap
    },
    overscan: 8,
    // A PREPEND KEEPS THE READER'S ROW MOUNTED. "Load earlier" inserts a whole page above the row the
    // reader is looking at, so in the commit that lands it the visible range (still computed for the old
    // offset, near 0) holds the new page's first rows and not theirs. Rendering the anchored row and the
    // rows under it as well lets the prepend's layout effect find it in the DOM and put it back under
    // the reader's eye before that commit paints — instead of a frame of the wrong page, or of nothing.
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range)
      const anchorKey = pendingPrependAnchorRef.current?.rowKey
      const anchor = anchorKey ? rows.findIndex((row) => row.key === anchorKey) : -1
      if (anchor < 0) return indexes
      const extra: number[] = []
      for (let i = Math.max(0, anchor - 2); i <= Math.min(rows.length - 1, anchor + 24); i++) extra.push(i)
      return [...new Set([...indexes, ...extra])].sort((a, b) => a - b)
    },
    paddingStart: 20,
    paddingEnd: 20,
    anchorTo: "end",
    // NO `followOnAppend`. The tail follow is syncTailFollow's, below, on every commit; the library's own
    // follow fired on exactly one event here — the runtime-status row (or a queued bubble) being APPENDED,
    // the only time the last row's key changes — and it follows by `scrollToEnd`, which is
    // `scrollToIndex(count - 1)` plus a reconcile loop that re-aims at THAT INDEX on each frame until the
    // offset holds still. A turn that starts outside this tab appends the Working row on the board's
    // `running` delta and inserts its "Agent rested" hairline and the human's bubble ABOVE that row on the
    // transcript push ~25ms later, so on a run where the loop was still alive the index it held now
    // named the hairline: it scrolled a reader at the tail up to that row's end — 69px, the hairline's
    // 108px estimate less its 39px — and left them detached under "Jump to latest" for the whole turn,
    // reply included. 4 of 180 scripted turn starts on a tall thread at 820x900 and 17 of 40 on a short
    // one at 1400x900 (2026-10-13), every one written by `reconcileScroll`; 0 of 180 without it.
    // syncTailFollow follows by the scroller's own height, so it has no index to go stale. (The option
    // came with the virtualized view, 2026-07-21, three days before syncTailFollow replaced what it was
    // for; it had been a second, redundant follower ever since.)
    scrollEndThreshold: TAIL_FOLLOW_PX,
    // THE SWALLOWED WHEEL NOTCH — why scrolling back through a long thread stutters.
    //
    // A row above the reader that has never been measured mounts at its ESTIMATE and then corrects to
    // its real height, which on this transcript is routinely 300-750px against a 108px estimate. Every
    // one of those corrections makes the virtualizer compensate, and its compensation is written as
    // `scrollTo(getScrollOffset() + delta)` — where `getScrollOffset()` is the virtualizer's own CACHED
    // offset, refreshed only when a scroll EVENT runs. The event fires at the top of the frame and the
    // ResizeObserver that triggers the correction fires at the bottom of it, so anything the reader
    // scrolled in between — every compositor-driven wheel notch — is simply not in that cached value.
    // The correction therefore lands at (where the reader WAS) + delta and throws their scroll away.
    // Measured by replaying a real transcript (verify-full-scroll-jitter.mjs): 34 of 196 upward frames
    // moved the content 0px instead of the 40px asked for, and a wrapped `scrollTo` caught writes
    // landing 84px BEHIND the live offset while every correction in flight was positive.
    //
    // So apply a correction as what it actually is — a RELATIVE nudge against wherever the reader has
    // got to — and leave real destinations (`scrollToEnd`, `scrollToIndex`) absolute. `adjustments` is
    // set only on the correction path, and is a per-call delta: virtual-core folds it into its cached
    // offset and resets it to 0 immediately after each call, so it never accumulates across calls.
    scrollToFn: (offset, { adjustments, behavior }, instance) => {
      const element = instance.scrollElement
      if (!element) return
      element.scrollTo({ top: adjustments === undefined ? offset : element.scrollTop + adjustments, behavior })
    },
  })
  const [atEnd, setAtEnd] = useState(true)
  // Tail-follow state, in refs because syncTailFollow runs from layout/observer/listener callbacks that
  // must read CURRENT values, not ones closed over from the render that scheduled them.
  const followingTailRef = useRef(true)
  const tailHeightRef = useRef(-1)
  const tailViewportRef = useRef(-1)
  const readerScrollUntilRef = useRef(0)
  // The virtualizer's total-size box. Its height IS getTotalSize(), so observing it catches every way
  // the transcript can grow: a row inserted at its estimate, and each later measurement correction.
  const contentRef = useRef<HTMLDivElement>(null)
  const tailReadyRef = useRef(false)
  const readerMovedRef = useRef(false)
  const nearTopLoadArmedRef = useRef(true)
  const initialTranscriptKeyRef = useRef<string | undefined>(undefined)
  // THE HEAD TRIM (see the layout effect below). `readerAnchorRef` is refreshed at the END of every
  // tail-follow pass, so a layout effect that runs BEFORE that pass still reads the PREVIOUS commit's
  // position — which is exactly the place a head trim has to put the reader back.
  const readerAnchorRef = useRef<{ rowKey: string; viewportTop: number } | null>(null)
  const firstMessageKeyRef = useRef<string | undefined>(undefined)
  const anchorRestoreUntilRef = useRef(0)
  const openHoldFrameRef = useRef(0)

  const requestEarlier = useCallback(() => {
    const scroller = transcriptRef.current
    if (scroller) {
      const scrollerTop = scroller.getBoundingClientRect().top
      const firstVisible = Array.from(scroller.querySelectorAll<HTMLElement>("[data-transcript-source-id]"))
        .find((element) => element.getBoundingClientRect().bottom > scrollerTop + 1)
      const rowKey = firstVisible?.dataset.transcriptRowKey
      if (firstVisible && rowKey) {
        pendingPrependAnchorRef.current = {
          rowKey,
          viewportTop: firstVisible.getBoundingClientRect().top - scrollerTop,
        }
      }
    }
    loadEarlier()
  }, [loadEarlier, transcriptRef])

  // Put a message back at a given HEIGHT ON SCREEN — window coordinates, not an offset within the
  // scroller, because the hand-off measured the reader's place in a surface whose scroller starts
  // somewhere else entirely.
  //
  // Deliberately NOT clamped into the pane. The anchor is the topmost message the reader could see, so
  // it is usually running off the top of their view with the thing they are actually reading below it;
  // pinning its top edge to the pane instead pushed the whole screen down by however much of it was
  // already scrolled past — measured at 226px on a 900px window, which is the layout shift this is
  // here to remove. Landing it exactly where it was leaves every line at the height it already had,
  // and the part above the pane is clipped here exactly as it was clipped there.
  const alignToScreenTop = useCallback((sourceId: string, screenTop: number) => {
    const scroller = transcriptRef.current
    if (!scroller) return
    const node = Array.from(scroller.querySelectorAll<HTMLElement>("[data-transcript-source-id]"))
      .find((element) => element.dataset.transcriptSourceId === sourceId)
    if (!node) return
    scroller.scrollTop += node.getBoundingClientRect().top - screenTop
  }, [transcriptRef])

  useLayoutEffect(() => {
    if (!transcriptKey || rows.length === 0 || initialTranscriptKeyRef.current === transcriptKey) return
    initialTranscriptKeyRef.current = transcriptKey
    tailReadyRef.current = false
    readerMovedRef.current = false
    nearTopLoadArmedRef.current = true
    // THE FULLSCREEN HAND-OFF. The door records which message the reader had at the top of the card or
    // drawer it was pressed in (lib/fullscreenHandoff); land on THAT instead of the tail, so expanding a
    // thread reads as the same page getting bigger rather than a jump to the end of a conversation the
    // reader was deliberately not at. Absent, stale, or aimed at a message this window does not hold,
    // the tail is still the answer — and it always is when the reader could already see the end, which
    // the capture side refuses to anchor on.
    const handoff = takeFullscreenEnterAnchor(slug)
    // The topmost message the reader had that THIS window can place. Anything above it is a row the
    // board surface drew and this one does not.
    const anchor = handoff?.candidates
      .map((candidate) => ({ candidate, index: rows.findIndex((row) => row.kind === "message" && row.message.sourceId === candidate.sourceId) }))
      .find((hit) => hit.index >= 0)
    // THE PHONE OPENS A RESTED THREAD AT THE TOP OF ITS LAST MESSAGE (mockup v2, "Behaviour a still frame
    // cannot show"). A handoff is written verdict-first, and on a 390pt screen a 40-line one opened at the
    // tail puts the reader on its last bullet with the verdict 30 lines up. So at rest the phone lands the
    // top of the newest thing the agent SAID at the top of the pane; a running thread still opens on the
    // tail, where the live line is. `lastAgentIdx` is that message (lastAssistantIndex skips frizz's own
    // event rows); if it draws no row of its own — a fence-only rest the resting card states — the last
    // assistant row before it stands in, and with none the tail is still the answer. The fullscreen
    // hand-off above outranks this: it is the reader's own place, carried over.
    const lastMessageRow = !anchor && openAtLastMessage && lastAgentIdx >= 0
      ? rows.reduce((found, row, index) => (row.kind === "message" && row.messageIndex <= lastAgentIdx && row.message.role === "assistant" && row.message.kind !== "event" ? index : found), -1)
      : -1
    let frame = requestAnimationFrame(() => {
      if (!anchor && lastMessageRow >= 0) {
        // The fullscreen hand-off's two steps and its hold, aimed at a row's top instead of a remembered
        // screen height: mount the row, release tail-follow, then re-align every frame while the rows
        // around it correct from their estimates. The hold is longer than the hand-off's because nothing
        // above this row has ever been measured on a cold open; a touch on the scroller ends it at once.
        const rowKey = rows[lastMessageRow].key
        virtualizer.scrollToIndex(lastMessageRow, { align: "start", behavior: "instant" })
        followingTailRef.current = false
        setAtEnd(false)
        tailReadyRef.current = true
        const until = performance.now() + OPEN_AT_MESSAGE_HOLD_MS
        anchorRestoreUntilRef.current = until
        // Its own frame chain, NOT `frame`: this effect re-runs (and cancels `frame`) whenever the row
        // count moves, which on a cold open it does while the hold is still needed. Only unmount ends it.
        const hold = () => {
          const scroller = transcriptRef.current
          if (!scroller || performance.now() >= until || performance.now() < readerScrollUntilRef.current) {
            anchorRestoreUntilRef.current = 0
            openHoldFrameRef.current = 0
            // A last message shorter than the pane cannot reach its top: the landing clamps at the
            // bottom, which IS the tail — so say so, or "Jump to latest" would sit over a reader who is
            // already there until something else happened to re-run the tail reconciliation.
            if (scroller && scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= TAIL_FOLLOW_PX) {
              followingTailRef.current = true
              tailHeightRef.current = scroller.scrollHeight
              setAtEnd(true)
            }
            return
          }
          const row = scroller.querySelector<HTMLElement>(`[data-transcript-row-key="${CSS.escape(rowKey)}"]`)
          if (row) scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
          openHoldFrameRef.current = requestAnimationFrame(hold)
        }
        hold()
        return
      }
      if (!anchor) {
        virtualizer.scrollToEnd({ behavior: "instant" })
        setAtEnd(true)
        tailReadyRef.current = true
        return
      }
      // Two steps, because the row is VIRTUAL: `scrollToIndex` gets it mounted (it may be thousands of
      // estimated pixels away), then the align puts it at the exact height it had on the board. Release
      // tail-follow first — `nextTailFollow` starts attached, so the settling growth below would
      // otherwise read as content arriving under a reader at the bottom and haul the page back there.
      virtualizer.scrollToIndex(anchor.index, { align: "start", behavior: "instant" })
      followingTailRef.current = false
      setAtEnd(false)
      tailReadyRef.current = true
      // HOLD IT THERE WHILE THE TRANSCRIPT MEASURES. Every row above the anchor mounts at its 108px
      // estimate and corrects to its real height — routinely 300-750px on this transcript — and each
      // correction moves the anchor under the reader's eye. One align lands on estimates; re-aligning
      // every frame through the restore window lands on the truth. Claim the scroller for the same
      // span so syncTailFollow reconciles against a settled height rather than one in transit, and
      // stop the moment the reader touches it — their gesture outranks the restore.
      const until = performance.now() + ANCHOR_RESTORE_MS
      anchorRestoreUntilRef.current = until
      const hold = () => {
        if (performance.now() >= until || performance.now() < readerScrollUntilRef.current) return
        alignToScreenTop(anchor.candidate.sourceId, anchor.candidate.screenTop)
        frame = requestAnimationFrame(hold)
      }
      hold()
    })
    return () => cancelAnimationFrame(frame)
  }, [alignToScreenTop, rows.length, slug, transcriptKey, virtualizer])
  useEffect(() => () => cancelAnimationFrame(openHoldFrameRef.current), [])

  // Where the reader is actually looking: the first row whose box reaches the pane top, and the offset
  // it sits at.
  const captureReaderAnchor = useCallback((): { rowKey: string; viewportTop: number } | null => {
    const scroller = transcriptRef.current
    if (!scroller) return null
    const scrollerTop = scroller.getBoundingClientRect().top
    const first = Array.from(scroller.querySelectorAll<HTMLElement>("[data-transcript-row-key]"))
      .find((element) => element.getBoundingClientRect().bottom > scrollerTop + 1)
    const rowKey = first?.dataset.transcriptRowKey
    if (!first || !rowKey) return null
    return { rowKey, viewportTop: first.getBoundingClientRect().top - scrollerTop }
  }, [transcriptRef])

  // Put a remembered anchor back under the reader's eye. ABSOLUTE, not a delta: it scrolls to wherever
  // that row now is, so running it after some other corrector already got it right is a no-op rather
  // than a second correction.
  const alignToAnchor = useCallback((anchor: { rowKey: string; viewportTop: number }) => {
    const scroller = transcriptRef.current
    if (!scroller) return
    const row = Array.from(scroller.querySelectorAll<HTMLElement>("[data-transcript-row-key]"))
      .find((element) => element.dataset.transcriptRowKey === anchor.rowKey)
    if (!row) return
    const nextTop = row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    scroller.scrollTop += nextTop - anchor.viewportTop
  }, [transcriptRef])

  // THE HEAD TRIM — the other event that moves content ABOVE a reader parked mid-thread, and the one the
  // virtualizer is structurally unable to see.
  //
  // The server projects at most MAX_MESSAGES (300), so on any thread past that cap every new message also
  // pushes one off the HEAD of the live window. Those rows vanish from above the reader, the content above
  // them shrinks by exactly their height, and scrollTop is left untouched — so the whole transcript slides
  // UP past their eye, which is indistinguishable from being scrolled down. Measured on a real saturated
  // thread at 62-185px per append, cumulative: -975px over 25 appends (verify-full-window-slide.mjs).
  //
  // TanStack cannot compensate it. Its `anchorTo: "end"` preservation is gated on `didEdgeKeysChange` —
  // `count changed || getItemKey(0) changed || getItemKey(count - 1) changed` — and on THIS list row 0 is
  // always the fixed-key `head-anchor` row, the last row is always the runtime-status row, and `count` is
  // pinned by the cap. A trim is therefore entirely interior to the key list, so the library sees nothing,
  // rebuilds no measurements and adjusts no offset. Every other surface that changes the rows above the
  // reader (a prepend, a pin move) already restores the reader explicitly; this one simply never was.
  //
  // That head sentinel exists FOR this invariant. Row 0 used to be the interactions row, which happened to
  // be a constant key; when the ask moved to the tail (2026-08-02) row 0 would otherwise have become
  // `earlier-history:${beforeCursor}` — a key that CHANGES on exactly this trim — waking TanStack's
  // correction to fire alongside the one below, the same double-correction hazard `[overflow-anchor:none]`
  // exists to prevent. So the sentinel keeps row 0's key constant and renders nothing.
  //
  // The trim has already landed by the time this runs, so realign synchronously — then again across the
  // next frames, because the rows below the removed ones re-measure on later ResizeObserver passes.
  const firstMessageKey = messageRows[0]?.key
  useLayoutEffect(() => {
    const previousKey = firstMessageKeyRef.current
    firstMessageKeyRef.current = firstMessageKey
    // First commit establishes the baseline. A reader AT the tail is tail-follow's to move; a prepend owns
    // the scroller through its own anchor; and the initial scroll-to-end must not be fought.
    if (previousKey === undefined || previousKey === firstMessageKey) return
    if (!tailReadyRef.current || followingTailRef.current || pendingPrependAnchorRef.current) return
    const anchor = readerAnchorRef.current
    if (!anchor) return
    // Deliberately NO scroller claim here, unlike the pin move. A trim lands on EVERY append once the
    // window is full — several times a second on a live turn — and a 250ms claim that often would keep
    // syncTailFollow from refreshing the reader anchor at all, so a reader who scrolled mid-stream would be
    // realigned to where they were BEFORE they moved: their own scroll undone by the next append. Letting
    // the anchor refresh on every pass instead makes this restore a fixed point, and the follow-ups below
    // re-read it, so the reader's live intent always wins.
    alignToAnchor(anchor)
    // The rows below the removed ones re-measure on later ResizeObserver passes, so hold once more across
    // the next frames — against the reader's CURRENT anchor, and never while their own gesture is in flight.
    const holdStill = () => {
      if (performance.now() < readerScrollUntilRef.current) return
      const current = readerAnchorRef.current
      if (current) alignToAnchor(current)
    }
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      holdStill()
      secondFrame = requestAnimationFrame(holdStill)
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }, [alignToAnchor, firstMessageKey])

  // TAIL FOLLOW — keep a reader who is AT the bottom at the bottom as the conversation grows.
  //
  // TanStack's own `followOnAppend` cannot do this job here: it only fires when the count grows AND the
  // LAST row's key changes (virtual-core setOptions). A live thread's last row is almost never a
  // message — it's the runtime-status row (Working…) or a queued bubble — so a landing reply is
  // INSERTED ABOVE a tail whose key never changes and the follow silently no-ops. `resizeItem` then
  // PRESERVES the distance from the end while the row measures, so the gap that opened at insert time
  // is held forever: the reader is left exactly one row ESTIMATE short of the bottom (122px for a
  // message; ~50-70px for a queued→landed flip, which leaves the row count unchanged and so cannot
  // trigger the library follow at all) — the "it auto-scrolled but stopped 50px short" bug.
  //
  // So own it. Reconciled by nextTailFollow (which decides reader-moved vs content-grew) and driven
  // from three places, because content settles across several frames: the scroll listener, every
  // commit, and every resize of the virtualizer's total-size box.
  const syncTailFollow = useCallback(() => {
    const scroller = transcriptRef.current
    // A prepend in flight owns the scroller: "load earlier" grows the content by a whole page and
    // restores the reader's anchor across the next two frames. Following that growth would race it.
    if (!scroller || pendingPrependAnchorRef.current) return
    // Same for an anchor restore (a pin move, a head trim): the rows above the reader are mid-settle, so
    // the scroll height this would reconcile against is a value in transit. Let the restore land, then
    // resume — and do NOT refresh the reader anchor from a position it is still correcting.
    if (performance.now() < anchorRestoreUntilRef.current) return
    const next = nextTailFollow({
      scrollTop: scroller.scrollTop,
      scrollHeight: scroller.scrollHeight,
      clientHeight: scroller.clientHeight,
      previousScrollHeight: tailHeightRef.current,
      previousClientHeight: tailViewportRef.current,
      following: followingTailRef.current,
      readerMoved: performance.now() < readerScrollUntilRef.current,
    })
    followingTailRef.current = next.following
    if (next.scrollTop !== null) scroller.scrollTop = next.scrollTop
    tailHeightRef.current = scroller.scrollHeight
    tailViewportRef.current = scroller.clientHeight
    // "Jump to latest" is exactly the negation of attachment, so the affordance can never disagree
    // with the behavior — and it no longer flickers for one frame while a message lands.
    setAtEnd((current) => current === next.following ? current : next.following)
    // Did the row under the reader's eye move while they weren't touching anything? (see DEBUG_SCROLL)
    if (DEBUG_SCROLL && !next.following && performance.now() >= readerScrollUntilRef.current) {
      const previous = readerAnchorRef.current
      const row = previous && Array.from(scroller.querySelectorAll<HTMLElement>("[data-transcript-row-key]"))
        .find((element) => element.dataset.transcriptRowKey === previous.rowKey)
      if (previous && row) {
        const drift = Math.round(row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - previous.viewportTop)
        if (Math.abs(drift) > 2) console.warn(`[frizz] transcript moved ${drift}px under a still reader — row=${previous.rowKey}`)
      }
    }
    // LAST: refresh where the reader is looking. This runs on every commit, every settle and every
    // scroll, so the pin-move effect above — which is declared EARLIER and therefore runs before this
    // pass — always reads the position from before the pin moved.
    readerAnchorRef.current = captureReaderAnchor() ?? readerAnchorRef.current
  }, [captureReaderAnchor, transcriptRef])

  // THE STALE FRAME. A row that is already mounted and changes height in a commit — the resting card
  // folding into its message the moment the worker picks up a Done, an answered question greying in
  // place — is otherwise measured only by the virtualizer's ResizeObserver. That runs after this commit
  // has laid out, and the re-render its measurement asks for goes to React's scheduler, so the browser
  // paints one frame with every row below at its OLD offset: the "Done" bubble drawn over the corner of
  // the card it answers, the tail 64-147px off the bottom (measured on a real worker, 2026-10-12).
  // Measuring the mounted rows here instead puts the new sizes in before paint — a state update
  // scheduled from a layout effect renders synchronously — and the tail follow below then reconciles
  // against the true height in that same frame. A row that changes on its own (an image decoding, a
  // child's own state) still reaches the virtualizer through the observer, as before.
  //
  // `resizeItem` with a height read here, NOT `measureElement(row)`: without an observer entry the
  // library's measurement answers from its own cache for any row it has sized before — exactly the rows
  // this is for — and it skips measuring altogether while it thinks the list is scrolling, which the
  // tail follow's own write makes it think for 150ms after every append. The reading is the observer's
  // (border-box height, rounded), so when the observer then reports the same row it finds nothing to do.
  //
  // And the content box is set to the height those sizes add up to BEFORE they are handed over:
  // `resizeItem` corrects the scroll offset itself (a row above the reader, or a reader at the end), and
  // it writes that correction against whatever box the DOM has — still the old height until the
  // re-render — so a growth at the tail was clamped away and a reader at the bottom was left 90-400px
  // above it, with the library believing otherwise.
  //
  // The same stale frame is what scripts/verify-full-scroll-flash.mjs counts while a reader scrolls back
  // through rows correcting from their estimates: 70 of 300 frames painted the correction with the rows
  // not yet moved, and 0 with this pass (2026-10-12, same stack, same seed).
  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    const known = new Map(virtualizer.getVirtualItems().map((item) => [item.index, item.size]))
    const changed: { index: number; size: number }[] = []
    let delta = 0
    for (const row of content.querySelectorAll<HTMLElement>(":scope > [data-index]")) {
      const index = virtualizer.indexFromElement(row)
      const size = Math.round(row.getBoundingClientRect().height)
      const was = known.get(index)
      if (index < 0 || was === undefined || was === size) continue
      changed.push({ index, size })
      delta += size - was
    }
    if (changed.length === 0) return
    content.style.height = `${virtualizer.getTotalSize() + delta}px`
    for (const { index, size } of changed) virtualizer.resizeItem(index, size)
  })

  // THE PREPEND RESTORE: "load earlier" put a page above the reader, so put the row they were reading
  // back where it was. On EVERY commit while one is pending, and declared after the measuring pass
  // above, because that pass resizes the new rows and re-renders before paint — an alignment made in
  // the first commit, against rows still at their estimates, was undone by the second, and the reader
  // was shown a frame ~1,800px further down the page (a 250-step transcript, 2026-10-14). The frames
  // after paint then hold it while rows measured by the ResizeObserver settle.
  const prependSettleRef = useRef<{ anchor: { rowKey: string; viewportTop: number }; frame: number } | null>(null)
  useLayoutEffect(() => {
    const anchor = pendingPrependAnchorRef.current
    const scroller = transcriptRef.current
    if (!anchor || !scroller || loadingEarlier) return
    // Whether the anchored row was on screen and needed no correction.
    const alignAnchor = (): boolean => {
      const anchoredRow = Array.from(scroller.querySelectorAll<HTMLElement>("[data-transcript-row-key]"))
        .find((element) => element.dataset.transcriptRowKey === anchor.rowKey)
      if (!anchoredRow) {
        // The row is virtual and not mounted (rangeExtractor keeps it mounted, so this is a fallback):
        // scroll to where the virtualizer places it, which mounts it, and align it on the next frame.
        const index = rows.findIndex((row) => row.key === anchor.rowKey)
        const offset = index >= 0 ? virtualizer.getOffsetForIndex(index, "start")?.[0] : undefined
        if (offset !== undefined) scroller.scrollTop = offset - anchor.viewportTop
        return false
      }
      const drift = anchoredRow.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.viewportTop
      if (Math.abs(drift) < 0.5) return true
      scroller.scrollTop += drift
      return false
    }
    alignAnchor()
    if (prependSettleRef.current?.anchor === anchor) return
    // Then every frame until the row has held still for two frames running (at most ten).
    let steady = 0
    let frames = 0
    const settle = () => {
      steady = alignAnchor() ? steady + 1 : 0
      frames++
      if (steady >= 2 || frames >= 10) {
        if (pendingPrependAnchorRef.current === anchor) pendingPrependAnchorRef.current = null
        prependSettleRef.current = null
        return
      }
      if (prependSettleRef.current) prependSettleRef.current.frame = requestAnimationFrame(settle)
    }
    prependSettleRef.current = { anchor, frame: requestAnimationFrame(settle) }
  })
  useEffect(() => () => { if (prependSettleRef.current) cancelAnimationFrame(prependSettleRef.current.frame) }, [])

  // Every commit: a row that just mounted at its ESTIMATED height has already pushed the bottom away.
  // A layout effect (not an effect) so the correction lands in the same frame — no visible slip.
  useLayoutEffect(syncTailFollow)

  // Every settle after that: TanStack measures the real DOM one or more frames later, and a big
  // markdown/tool row can keep growing for several. The observed box's height IS getTotalSize().
  useEffect(() => {
    const content = contentRef.current
    if (!content) return
    const observer = new ResizeObserver(syncTailFollow)
    observer.observe(content)
    // …and the scroller's own box: the footer under it grows and shrinks (the op counts over the prompt
    // box, a question card's answer bar), and that moves the tail without the content changing at all.
    const scroller = transcriptRef.current
    if (scroller) observer.observe(scroller)
    return () => observer.disconnect()
  }, [syncTailFollow, transcriptRef])

  useEffect(() => {
    const scroller = transcriptRef.current
    if (!scroller) return
    const inspect = () => {
      syncTailFollow()
      const gate = earlierLoadGate({
        armed: nearTopLoadArmedRef.current,
        scrollTop: scroller.scrollTop,
        readerMoved: tailReadyRef.current && readerMovedRef.current,
        hasEarlier,
        loading: loadingEarlier,
      })
      nearTopLoadArmedRef.current = gate.armed
      if (gate.shouldLoad) requestEarlier()
    }
    // A gesture is in flight: for the next beat, treat every scroll as the READER's, so a transcript
    // that happens to be growing at that moment can't claim the movement and haul them back down.
    const markReaderIntent = () => {
      readerMovedRef.current = true
      readerScrollUntilRef.current = performance.now() + READER_GESTURE_MS
      requestAnimationFrame(inspect)
    }
    const markKeyboardIntent = (event: KeyboardEvent) => {
      if (!["ArrowUp", "PageUp", "Home", " "].includes(event.key) || onTranscriptControl(event)) return
      if (scroller.scrollTop <= 480) nearTopLoadArmedRef.current = true
      markReaderIntent()
    }
    const markWheelIntent = (event: WheelEvent) => {
      if (event.deltaY < 0 && scroller.scrollTop <= 480) nearTopLoadArmedRef.current = true
      markReaderIntent()
    }
    const markTouchIntent = (event: TouchEvent) => {
      if (event.type === "touchstart" && onTranscriptControl(event)) return
      if (scroller.scrollTop <= 480) nearTopLoadArmedRef.current = true
      markReaderIntent()
    }
    const markPointerIntent = (event: PointerEvent) => {
      if (!onTranscriptControl(event)) markReaderIntent()
    }
    scroller.addEventListener("scroll", inspect, { passive: true })
    scroller.addEventListener("wheel", markWheelIntent, { passive: true })
    scroller.addEventListener("touchstart", markTouchIntent, { passive: true })
    scroller.addEventListener("touchmove", markTouchIntent, { passive: true })
    scroller.addEventListener("pointerdown", markPointerIntent, { passive: true })
    scroller.addEventListener("keydown", markKeyboardIntent)
    const frame = requestAnimationFrame(inspect)
    return () => {
      cancelAnimationFrame(frame)
      scroller.removeEventListener("scroll", inspect)
      scroller.removeEventListener("wheel", markWheelIntent)
      scroller.removeEventListener("touchstart", markTouchIntent)
      scroller.removeEventListener("touchmove", markTouchIntent)
      scroller.removeEventListener("pointerdown", markPointerIntent)
      scroller.removeEventListener("keydown", markKeyboardIntent)
    }
  }, [hasEarlier, loadingEarlier, requestEarlier, syncTailFollow, transcriptRef])

  const virtualItems = virtualizer.getVirtualItems()
  const totalSize = virtualizer.getTotalSize()

  return (
    <div
      ref={contentRef}
      data-virtualized-transcript
      data-virtual-row-count={virtualItems.length}
      className="relative w-full"
      style={{ height: totalSize }}
    >
      {virtualItems.map((virtualRow) => {
        const row = rows[virtualRow.index]
        if (!row) return null
        return (
          <div
            key={row.key}
            ref={virtualizer.measureElement}
            data-index={virtualRow.index}
            data-transcript-row-key={row.key}
            data-transcript-source-id={row.kind === "message" ? row.message.sourceId : undefined}
            className="absolute left-0 top-0 w-full"
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >
            {row.kind === "head-anchor" ? null
            : row.kind === "interactions" ? (
              <>
                <InteractionStack thread={thread} className="px-6 pt-5" autoFocusFirst />
                {/* The TAIL group only — questions asked at an older rest render up there, in place. The
                    in-flight answer stays here whatever the questions do: it is the human's newest turn,
                    and the delivered copy of it lands at the tail a second later. */}
                <RegisteredQuestionStack thread={thread} questions={questionGroups.tail} inFlight={inFlightAnswers} showSend={questionGroups.tailSend} className="px-6 pt-5" />
              </>
            )
            : row.kind === "questions" ? (
              <RegisteredQuestionStack thread={thread} questions={row.questions} showSend={row.send} className="px-6 pt-5" />
            )
            : row.kind === "settled-questions" ? (
              <SettledQuestionStack questions={row.questions} className="px-6 pt-5" />
            ) : row.kind === "transport-fallback" ? (
              transportFallback ? (
                <div className="px-6 pt-3">
                  <TranscriptSyncFallbackBanner fallback={transportFallback} isFetching={isFetching} onRefresh={refresh} onRetryLive={retryLiveUpdates} />
                </div>
              ) : null
            ) : row.kind === "earlier-history" ? (
              <div className="flex min-h-10 items-center justify-center px-6 text-[11px] text-muted" role="status">
                {earlierError ? (
                  <span className="flex flex-wrap items-center justify-center gap-2 text-center">
                    <span>{earlierError}</span>
                    <button type="button" onClick={requestEarlier} className="rounded-md border border-border px-2 py-1 text-fg/90 hover:bg-panel-2">Retry</button>
                  </span>
                ) : loadingEarlier ? (
                  <span className="flex items-center gap-2"><Loader2 size={12} className="animate-spin" /> Loading earlier messages…</span>
                ) : (
                  <button type="button" onClick={requestEarlier} className="button-outline rounded-md px-2 py-1 outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60">
                    Load earlier messages
                  </button>
                )}
              </div>
            ) : row.kind === "message" ? (
              <div className="relative flex flex-col px-6" style={{ paddingTop: row.gap }}>
                {row.restGap
                  ? <RestGapLine rest={row.message} at={row.restGap} />
                  : <ThreadMessage m={row.message} index={row.messageIndex} showSendButton />}
              </div>
            ) : row.kind === "runtime-status" ? (
              <div className="px-6">
                <RuntimeStatusSlot tail={runtimeTail} />
              </div>
            ) : row.kind === "queued-send-now" ? (
              <div className="flex flex-col px-6">
                <QueuedSendNow />
              </div>
            ) : (
              // The QUEUED branch: built straight from `messages`, never through the tool-activity coalescer.
              <div className="relative flex flex-col px-6" style={{ paddingTop: row.gap }}>
                <Message m={row.message} paired={paired[row.messageIndex]} />
              </div>
            )}
          </div>
        )
      })}
      <JumpToLatest overlay={jumpOverlay} hidden={atEnd} onJump={() => virtualizer.scrollToEnd({ behavior: "smooth" })} />
    </div>
  )
}

// "Jump to latest" belongs to the transcript's scroll STATE but not to its scroll CONTENT: it is
// portalled into ChatView's viewport-anchored overlay so it simply floats, motionless, over the
// scrolling column. (It used to render inside the virtualized content and chase the viewport by
// recomputing a content-space `top` every render — which meant it drifted with the content on every
// scroll and snapped back a frame later.)
function JumpToLatest({ overlay, hidden, onJump }: { overlay: HTMLElement | null; hidden: boolean; onJump: () => void }) {
  if (!overlay || hidden) return null
  return createPortal(
    <button
      type="button"
      data-jump-to-latest
      onClick={onJump}
      className="flex items-center gap-1.5 rounded-full border border-border-strong bg-elevated px-3 py-1.5 text-[11px] font-medium text-fg shadow-lg shadow-shadow-ink/30 hover:bg-panel-2"
    >
      <ArrowDown size={12} />
      Jump to latest
    </button>,
    overlay,
  )
}

// The thread's top bar: title, then "Last active · context" (ThreadHeaderFacts), and at the far right the
// shared HeaderActions closed by the two lifecycle verbs, snooze and mark as done (ThreadLifecycleActions)
// — the same strip the queue card's header draws. It carried a Chat|Doc tab strip until 2026-08-06; see
// ThreadView for why that went.
export function ThreadHeader({ slug, onStatusApplied, onClose, showReturnToQueue = false }: { slug: string; onStatusApplied?: () => void; onClose?: () => void; showReturnToQueue?: boolean }) {
  const thread = useThreadSnapshot(slug)
  const markComplete = useMutation({ mutationFn: () => rpc.markComplete({ slug }) })
  // The "Frizz document" header affordance opens .frizz/<slug>.md (threadBody). Many session threads have
  // no such file — a session thread's working files are its own business — so it would dead-end on
  // "No thread file found". Gate it on the doc actually having body content (same stripFrontmatter the
  // drawer renders through), so it shows iff there's a real doc to open. Shares the drawer's cached query
  // (identical key), so opening the drawer adds no extra round-trip.
  const docQ = useQuery({ queryKey: ["threadBody", slug], queryFn: () => rpc.threadBody({ slug }) })
  const hasDoc = stripFrontmatter(docQ.data?.markdown ?? "").trim().length > 0
  if (!thread) return null
  return (
    <header
      data-thread-header
      className={THREAD_HEADER_CLASS}
    >
      <div className={THREAD_HEADER_TITLE_CLASS}>
        {/* NO THREAD VERB BEFORE THE TITLE. The way out of /full used to be an ArrowLeft standing here,
            which put a whole-thread verb at the one end of the header no other verb lives at, and said
            "previous page" about a control whose job is to change how this thread is SHOWN. It is now
            the closing half of the fullscreen door, in the door's own slot in the action strip below
            (HeaderActions `collapse`).
            The drawer's close is the one thing that does stand here, because it is not a thread verb:
            it is the sheet's own chrome, the same SheetClose every drawer's SheetHeader leads with (see
            there for why it leads, and for its spacing). Wired to the SAME animated close() as the
            backdrop/Esc path (markDrawerClosing + the 210ms slide-out), never an instant unmount.
            Absent in the main workpane (no onClose → no drawer to close). Inside the title group, so
            the ≤640px wrap keeps it on the title's line. */}
        {onClose && <SheetClose onClose={onClose} />}
        <div className="min-w-0 flex-1 leading-tight">
          {/* The name and both rename verbs — click to type, hover for the Claude refresh — are the
              shared ThreadTitle, the same element the queue card's header renders. */}
          <ThreadTitle thread={thread} />
          <ThreadHeaderFacts thread={thread} />
        </div>
      </div>
      {/* At constrained drawer widths, controls get their own deliberate row. This keeps the
          clickable title and its activity stamp readable instead of competing with fixed-width
          tabs/actions, while the control row itself remains a single unbroken cluster. */}
      <div className={THREAD_HEADER_CONTROLS_CLASS}>
        {/* `gap-0.5` — the action strip's own distance (HeaderActions spaces its icons on the same one),
            so the lifecycle verbs that close the strip stand in the row's rhythm. */}
        <div className="flex shrink-0 items-center gap-0.5">
          <HeaderActions
            thread={thread}
            // The /full page is the one surface with a fullscreen to LEAVE, and it leaves through the
            // same slot it was entered by.
            collapse={showReturnToQueue}
            // The fullscreen door, in the slot the queue card's sits in (before Retry) — only where there
            // is a drawer to leave, since the /full page is already there. The drawer mounted its own
            // after the whole strip until 2026-10-09, so the icon sat on the other side of Retry here.
            expand={Boolean(onClose)}
            onDoc={hasDoc ? () => pushDrawer("doc", thread.id) : undefined}
            onDone={() => markComplete.mutate(undefined, { onSuccess: onStatusApplied })}
            doneBusy={markComplete.isPending}
            onStatusApplied={onStatusApplied}
          />
          {/* Snooze leaves the drawer the way Mark as done does — both take the thread off the reader's
              plate, and the queue card leaves on both (maintainer 2026-10-09). The snooze left the drawer
              open until then. */}
          <ThreadLifecycleActions thread={thread} onArchived={onStatusApplied} onSnoozed={onStatusApplied} />
        </div>
      </div>
    </header>
  )
}

// The transcript's between-block RHYTHM — STEP, the tight run, the picture gap, and the VSpace element
// that draws them — lives in ./rhythm.tsx, and is re-exported here because every caller already reaches
// for it through ChatView. It moved out so the frizz wake renderer can charge the same STEP between the
// two hairlines of a two-part delivery: ChatView imports that renderer, so it cannot import ChatView.
export { STEP, META_CARD_STEP, PICTURE_STEP, USER_TAIL_EXTRA, HUMAN_RUN_STEP, VSpace } from "./rhythm.tsx"
// Adjacent tool activity must read at the SAME tight run whether it's batched in one message or split
// across messages (the tailer chunks a burst of tool calls arbitrarily). The boundary between two
// messages joins that run iff the FIRST ends with a tool band AND the SECOND begins with one (tool-tail
// → tool-head) — so a "let me check:" text-then-tool message sits at the run pitch above the next
// message's leading tool, exactly like two batched tools. Any prose at the boundary keeps STEP (14px).
// …and whether that boundary is a tight run at all, or the ordinary step, is the label question below.
// messageTailIsTool / messageHeadIsTool inspect the LAST / FIRST rendered block; the legacy (no-parts)
// path renders the tool band FIRST then prose, so its head is tools-if-any and its tail is
// tools-only-if-no-prose.
// A sub-agent COMPLETION MARKER message (see lib/subAgentCompletion.ts) is transcript punctuation, not
// a tool band: Message renders it as a wake divider, so every spacing predicate must treat it like the
// boundary event it is now a peer of — never as a tool card.
// The tools this message ENDS / BEGINS with, or null when the rendered edge is prose (or nothing at
// all). Returning the calls rather than a boolean is what lets the label predicates below ask the one
// further question the gap depends on: does that edge draw a one-line digest or a bordered card?
function messageTailTools(m: ChatMessage): TranscriptToolCall[] | null {
  if (m.kind === "event" || m.kind === "reasoning" || m.role === "user") return null
  if (agentCompletionCall(m)) return null
  if (m.parts && m.parts.length > 0) {
    for (let i = m.parts.length - 1; i >= 0; i--) {
      const p = m.parts[i]
      if (p.kind === "tools" ? p.tools.length > 0 : p.text.trim()) return p.kind === "tools" ? p.tools : null
    }
    return null
  }
  return (m.tools?.length ?? 0) > 0 && !m.text.trim() ? m.tools : null
}
function messageHeadTools(m: ChatMessage): TranscriptToolCall[] | null {
  if (m.kind === "event" || m.kind === "reasoning" || m.role === "user") return null
  if (agentCompletionCall(m)) return null
  if (m.parts && m.parts.length > 0) {
    for (const p of m.parts) {
      if (p.kind === "tools" ? p.tools.length > 0 : p.text.trim()) return p.kind === "tools" ? p.tools : null
    }
    return null
  }
  return (m.tools?.length ?? 0) > 0 ? m.tools : null
}
export function messageTailIsTool(m: ChatMessage): boolean {
  return messageTailTools(m) !== null
}
export function messageHeadIsTool(m: ChatMessage): boolean {
  return messageHeadTools(m) !== null
}
// A lightweight single-line META label — an "Agent … finished"/compaction event or a collapsed Codex
// reasoning row. Thoughts and the minimal tool disclosure share one regular light-grey treatment
// (TRANSCRIPT_META_LABEL_CLASS); all remain subordinate transcript activity and therefore join the tight
// run instead of forcing a full STEP break on both sides. A BOUNDARY event is a section-break divider,
// not a quiet label.
function isMetaLabelMessage(m: ChatMessage): boolean {
  return (m.kind === "event" && !m.boundary) || m.kind === "reasoning"
}
// Tail/head predicates for the tight-run spacer: a tool band OR a meta label. An event/reasoning
// message is a single row, so its head and tail are the same meta label.
export function messageTailIsMeta(m: ChatMessage): boolean {
  return isMetaLabelMessage(m) || messageTailIsTool(m)
}
export function messageHeadIsMeta(m: ChatMessage): boolean {
  return isMetaLabelMessage(m) || messageHeadIsTool(m)
}
// The narrower question the tight run turns on: does this edge draw a bare one-line LABEL, or a bordered
// card? A tools part renders as alternating runs (ToolCalls) — ordinary calls collapse into one
// `Ran N tool calls` digest, while a dispatch / background op keeps its own card
// (isToolActivityException) — so the edge's OWN call decides, not the run as a whole.
export function messageTailIsLabel(m: ChatMessage): boolean {
  if (isMetaLabelMessage(m)) return true
  const tools = messageTailTools(m)
  return tools !== null && !isToolActivityException(tools[tools.length - 1])
}
export function messageHeadIsLabel(m: ChatMessage): boolean {
  if (isMetaLabelMessage(m)) return true
  const tools = messageHeadTools(m)
  return tools !== null && !isToolActivityException(tools[0])
}
// …and the OTHER thing an edge can be: a rendered PICTURE, which outweighs both the label and the
// compact card and therefore sets its own gap (PICTURE_STEP) against whatever it neighbours.
export function messageTailIsPicture(m: ChatMessage): boolean {
  const tools = messageTailTools(m)
  return tools !== null && isPictureTool(tools[tools.length - 1])
}
export function messageHeadIsPicture(m: ChatMessage): boolean {
  const tools = messageHeadTools(m)
  return tools !== null && isPictureTool(tools[0])
}
// THE WAIT, DATED (lib/messageTime). A rest the human came back to REST_GAP_MS or more later draws as
// the instant they came back — `Today · 8:33 AM` — in place of "Agent rested · 3d ago": the same hairline
// at the same seam, saying when the new stretch began rather than how long ago the old one ended. Only a
// rest whose next drawn row is the human's own send: one above a wake has already been dropped as a
// restatement (lib/restDividers), and the next row is what both surfaces pass as `next`.
export function restGapOf(rest: ChatMessage, next: ChatMessage | undefined): string | null {
  if (rest.kind !== "event" || rest.boundary !== "rest" || !next || !humanSend(next)) return null
  return restGapAt(rest.at, next.at)
}
// Both surfaces draw it through this. The hover names the END of the wait the label no longer shows; the
// `·` is DividerAge's, so the day and the clock sit the same 4px either side of it as an age does.
export function RestGapLine({ rest, at }: { rest: ChatMessage; at: string }) {
  const { day, time } = dayAndTime(at)
  const wentQuiet = messageStamp(rest.at)?.replace(/^(Today|Yesterday)/, (word) => word.toLowerCase())
  return (
    <div title={wentQuiet ? `Agent rested ${wentQuiet}` : undefined} className="contents">
      <WakeDivider sourceId={rest.sourceId} marker="rest-gap" ariaLabel={`${day}, ${time}`}>
        <time dateTime={at} className="flex shrink-0 items-center gap-1 tabular-nums">
          <span>{day}</span>
          <span aria-hidden="true" className="opacity-50">·</span>
          <span>{time}</span>
        </time>
      </WakeDivider>
    </div>
  )
}

// THE between-message gap, in one function. Both spacing implementations (this file's plain column and
// the virtualized row builder) call it, so neither can drift from the other.
export function messageGap(previous: ChatMessage, next: ChatMessage): number {
  // Two things the human sent in a row stack as one utterance — see HUMAN_RUN_STEP.
  if (humanSend(previous) && humanSend(next)) return HUMAN_RUN_STEP
  // The tight run needs a CARD on at least one side of the seam — that is the whole of it. Two bare
  // label rows fall through to the ordinary STEP, which is what stops a `Ran N tool calls` / thought /
  // shimmer column from painting as one block of grey. See META_CARD_STEP.
  // A picture on either side outranks both of those: it is neither a compact card (so the tight run's
  // premise fails) nor an ordinary block (so STEP under-spaces it). See PICTURE_STEP.
  const picture = messageTailIsPicture(previous) || messageHeadIsPicture(next)
  const tightRun = !picture
    && messageTailIsMeta(previous)
    && messageHeadIsMeta(next)
    && !(messageTailIsLabel(previous) && messageHeadIsLabel(next))
  const base = picture ? PICTURE_STEP : tightRun ? META_CARD_STEP : STEP
  // ...and a little extra under the human's own words, but only where the run of them ENDS — see
  // USER_TAIL_EXTRA. Measured against the NEXT rendered message, so a user message followed by another
  // user message keeps the plain step between them.
  return base + (previous.role === "user" && next.role !== "user" ? USER_TAIL_EXTRA : 0)
}
// Did the HUMAN send this, as the transcript draws it — their bubble or their answers card? `role` alone
// does not say: a Frizz wake, another thread's message and a sub-agent's report all ride in as user
// turns and draw as hairlines (Message's user branch). A wake that carries answers is the exception,
// because Message draws it as the human's answers card.
function humanSend(m: ChatMessage): boolean {
  if (m.role !== "user" || m.kind === "event" || m.kind === "reasoning" || m.providerError) return false
  if (m.sessionPeer || m.peerFrom || m.agentInstruction) return false
  return !m.wake || isAnswersMessage(m)
}
// Matches exactly when Message returns null (an empty/thinking-only assistant turn) — such a message
// takes no slot, so the adjacency-spacer walk must SKIP it (else two spacers stack into a double gap).
export function messageRendersNothing(m: ChatMessage, staleAwaiting?: boolean, restingCardShown?: boolean): boolean {
  if (m.kind === "event" || m.kind === "reasoning" || m.role === "user") return false
  if (m.parts && m.parts.length > 0) return m.parts.every((p) => (p.kind === "tools" ? p.tools.length === 0 : blankText(m, p.text, staleAwaiting, restingCardShown)))
  return (m.tools?.length ?? 0) === 0 && blankText(m, m.text, staleAwaiting, restingCardShown)
}

// The later of two ISO instants, either of which may be missing or unparseable.
function laterInstant(a: string | undefined, b: string | undefined): string | undefined {
  const ta = Date.parse(a ?? "")
  const tb = Date.parse(b ?? "")
  if (!Number.isFinite(tb)) return a
  return Number.isFinite(ta) && ta >= tb ? a : b
}
// Whether a message renders is therefore POSITIONAL, and the row builders take a plain
// `(message) => boolean`. So the position is baked in here, over the very entries the builder is about to
// walk: same cut as the renderer's own `staleAwaiting`, and keyed on the message OBJECT each entry holds
// rather than on an index, because that is what the builder will hand back. It has to be the object from
// THIS list — coalescing REPLACES a message when it absorbs a tool tail (appendToolTail), so identity is
// stable only within one coalesced list, while the entry's `messageIndex` still points at the original.
//
// `restingCardShown` is the same cut from the other side: when the resting card at the tail states the
// LAST message's wait (showsRestingCard), that message's fence draws nothing either — the card owns it —
// so a fence-only last message is as empty as a settled one. Its own set rather than one more member of
// `stale`, because the two differ on one shape: a settled steps fence keeps its card, a stated one does not.
//
// `awaitingCut` is the index a fence goes stale BELOW — past every message while the thread is running,
// else the last assistant message (ChatView's `awaitingCut`).
export function rendersNothingIn<T extends { message: ChatMessage; messageIndex: number }>(
  entries: readonly T[],
  awaitingCut: number,
  restingCardShown = false,
  heldIdx = -1,
): (message: ChatMessage) => boolean {
  const stale = new WeakSet<ChatMessage>()
  const stated = new WeakSet<ChatMessage>()
  if (awaitingCut >= 0) for (const entry of entries) if (entry.messageIndex < awaitingCut && entry.messageIndex !== heldIdx) stale.add(entry.message)
  if (awaitingCut >= 0 && restingCardShown) for (const entry of entries) if (entry.messageIndex === awaitingCut) stated.add(entry.message)
  return (message) => messageRendersNothing(message, stale.has(message), stated.has(message))
}
// Does this text draw NOTHING? Ordinarily that is "is it blank", but an ```awaiting fence that is not a
// LIVE wait draws nothing either (see renderText) — and neither does a live one whose thread is at rest
// on it, because the resting card below states it; callers pass that case as `restingCardShown` —
// and the contract invites a worker to reply with the
// fence ALONE, so a whole message can be one such fence and no prose. Left un-stripped it reports as
// visible, which spends an adjacency spacer on an empty slot and saves a rest divider with nothing under
// it. That was already true of a REFUSED fence; it became true of a SETTLED one when the settled body
// stopped rendering, and 99 of the 6,999 awaiting fences in this machine's transcripts are fence-only,
// so the case is ordinary rather than theoretical.
// A LIVE fence that names questions with no prose of its own draws nothing as well (renderText, 2026-10-08):
// its card is gone and the question cards render after the message, not inside it.
//
// A SETTLED fence that handed the human `steps:` keeps its card (renderText), so it is not blank — unless
// the resting card states it, which is why that reason arrives as its own flag rather than folded in.
function blankText(m: ChatMessage, text: string, staleAwaiting?: boolean, restingCardShown?: boolean): boolean {
  if (!m.fenceRefused && !staleAwaiting && !restingCardShown) {
    if (!text.includes("```awaiting")) return !text.trim()
    return splitFenceBlocks(text).every((s) => s.kind === "fence" && s.fenceKind === "awaiting" && awaitingDefersToQuestions(s.hints) && !awaitingProseBlock(s.body))
  }
  // splitFenceBlocks already drops whitespace-only prose runs, so "every segment is an awaiting fence"
  // is the whole test. A ```done fence still draws its card and keeps the message visible.
  return splitFenceBlocks(text).every((s) => s.kind === "fence" && s.fenceKind === "awaiting" && (m.fenceRefused || restingCardShown || !settledFenceDraws(s.hints)))
}
// Does a SETTLED ```awaiting fence still draw its card? Only one that handed the human steps — they are a
// record of what the human did, not a wait (renderText).
function settledFenceDraws(hints: readonly AwaitingHint[]): boolean {
  return awaitingSteps(hints).length > 0
}
// Would this message render anything under `textOnly` (tool bands dropped)? Mirrors messageRendersNothing
// but counts ONLY text parts — the queue card uses it to decide whether a first/last agent message that
// is pure batched tool calls (no prose) contributes a visible row, or folds entirely into the bar.
export function messageHasRenderableText(m: ChatMessage, staleAwaiting?: boolean, restingCardShown?: boolean): boolean {
  if (m.kind === "event" || m.kind === "reasoning" || m.role === "user") return false
  if (m.parts && m.parts.length > 0) return m.parts.some((p) => p.kind === "text" && !blankText(m, p.text, staleAwaiting, restingCardShown))
  return typeof m.text === "string" && !blankText(m, m.text, staleAwaiting, restingCardShown)
}

// The leading gap for the shimmer that tails a live transcript. The shimmer is a quiet single-line row
// — the LIVE continuation of the very meta column that the reasoning rows and tool bands form above
// it — so it joins their tight run rather than breaking to STEP whenever the last rendered message ends
// in a CARD. (Maintainer 2026-07-31: "there's more space above the working shimmer than there is below
// the 'Thought for 37 seconds'" — the shimmer sat at STEP under a pair of agent cards that were
// themselves at the run pitch under the thought label.) It is itself a bare LABEL, so under ANOTHER
// label it takes the ordinary step instead, exactly as messageGap charges that pair. Prose above it
// still gets the full break, and every other occupant of the runtime-status slot is a card, which
// keeps STEP.
// Returns 0 when nothing rendered above — a leading spacer would then indent the whole column.
export function workingIndicatorGap(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (inQueuedTail(m) || messageRendersNothing(m)) continue
    // Under a PICTURE it takes the picture's own gap — the pair the maintainer reported (a picture card
    // with the shimmer under it; an image `Read` then, a delivery now). See PICTURE_STEP.
    if (messageTailIsPicture(m)) return PICTURE_STEP
    // The shimmer is itself a bare LABEL, so it joins the tight run only under a CARD — under another
    // label it takes the ordinary step, exactly as messageGap charges that pair.
    if (messageTailIsMeta(m) && !messageTailIsLabel(m)) return META_CARD_STEP
    return STEP + (m.role === "user" ? USER_TAIL_EXTRA : 0)
  }
  return 0
}

// USER_TAIL_EXTRA (the extra air under the last user message of a run) lives in ./rhythm.tsx with the
// rest of them — the VIRTUALIZED row builder is the production path, and both spacing implementations
// have to charge the same number.

// The plain (non-virtualized) message column — the sub-agent drawer. Every surface that stacks messages
// charges its gaps through messageGap, so no surface can invent its own rhythm. That is the whole
// point: the sub-agent drawer used to lay its messages out with a flat `gap-3.5`, which gave a child's
// transcript 14px between successive tool-only turns and 6px inside a batch, i.e. exactly the batch
// seam the tight run exists to erase (maintainer 2026-07-27: "there's a bigger gap between independent
// batches as opposed to within a batch"). A container `gap` CANNOT express this rule — the gap depends
// on the two rows it sits between — so the spacing is explicit VSpace elements and the container must
// stay gap-less.
//
// Messages that render nothing are SKIPPED (no orphan or doubled spacer); `skip` drops messages the
// caller renders elsewhere (the queued tail). Nothing rendered yet → no leading spacer.
export function withMessageSpacers(
  messages: readonly ChatMessage[],
  render: (m: ChatMessage, i: number) => ReactNode,
  skip?: (m: ChatMessage, i: number) => boolean,
): ReactNode[] {
  const out: ReactNode[] = []
  let prev: ChatMessage | null = null
  messages.forEach((m, i) => {
    if (skip?.(m, i)) return
    if (messageRendersNothing(m)) return
    if (prev !== null) out.push(<VSpace key={`s${i}`} h={messageGap(prev, m)} />)
    out.push(render(m, i))
    prev = m
  })
  return out
}

// Drop parts that render nothing and re-coalesce the contiguous tool runs they were splitting, so a
// message's block list matches what the reader actually sees. Mirrors the server's own part-coalescing
// rule (transcript.ts pushToolPart) for the one case it can't catch: a blank text block BETWEEN two
// tool_use blocks starts a fresh tools part server-side, and the client would then draw two bands.
export function normalizeParts(parts: readonly TranscriptPart[]): TranscriptPart[] {
  const out: TranscriptPart[] = []
  for (const p of parts) {
    if (p.kind === "text") {
      if (!p.text.trim()) continue
      out.push(p)
      continue
    }
    if (p.tools.length === 0) continue
    const last = out[out.length - 1]
    if (last && last.kind === "tools") out[out.length - 1] = { kind: "tools", tools: [...last.tools, ...p.tools] }
    else out.push(p)
  }
  return out
}

// Interleave a list of block-level nodes with explicit spacers. Nullish entries (e.g. an empty prose
// run) are dropped BEFORE interleaving so a spacer never leads, trails, or doubles.
//
// `h` may be a FUNCTION of the seam — it receives the index of the block BELOW it — for the one rhythm
// a single number cannot express: a picture takes PICTURE_STEP against whatever it neighbours while its
// neighbours keep their own pitch with each other. A caller passing the function form is therefore
// keying on positions the filter above must not shift, so it must pass real nodes only.
function withSpacers(blocks: ReactNode[], h: number | ((index: number) => number) = STEP): ReactNode[] {
  const real = blocks.filter((b) => b !== null && b !== undefined && b !== false)
  const out: ReactNode[] = []
  real.forEach((b, i) => {
    if (i > 0) out.push(<VSpace key={`vs${i}`} h={typeof h === "number" ? h : h(i)} />)
    out.push(b)
  })
  return out
}
// The seam between two stacked blocks: a picture's own gap where either side of it IS a picture, the
// caller's ordinary pitch otherwise. `edges` runs parallel to the block list. See PICTURE_STEP.
type PictureEdges = { head: boolean; tail: boolean }
const NO_PICTURE: PictureEdges = { head: false, tail: false }
function pictureAwareGap(edges: readonly PictureEdges[], ordinary: number): (index: number) => number {
  return (i) => (edges[i - 1]?.tail || edges[i]?.head ? PICTURE_STEP : ordinary)
}
// A tool BAND's outer edges: the first and last card it draws. Same question messageHeadIsPicture /
// messageTailIsPicture ask across a message boundary, asked inside one message instead.
function toolBandEdges(tools: readonly CollapsedTool[]): PictureEdges {
  return { head: isPictureTool(tools[0]), tail: isPictureTool(tools[tools.length - 1]) }
}

export interface CollapsedTool {
  name: string
  detail?: string
  // Set for Edit/Write/MultiEdit entries: the (same-file) edits merged into one diff block. Distinct
  // files never merge; a plain tool call has no edits.
  edits?: TranscriptEdit[]
  // Set for a multi-line / long Bash call: the raw command, rendered as its own code block. Like
  // edits, a command entry stands alone (never folds into a repeat count).
  command?: string
  // The model-authored one-line description for a Bash command block (the collapsed block's header).
  // Falls back to `detail` (the command's first line) when the model gave no description.
  desc?: string
  // A shell command's captured stdout/stderr (codex's exec_command/shell ships its result in the
  // rollout; Claude Bash results aren't recorded). Rendered as a second pane below the command in the
  // BashBlock. Absent for Claude Bash calls → the command shows alone (the prior behavior).
  output?: string
  // Set for a tool whose result carried an image (e.g. chrome-devtools `take_screenshot`): the absolute
  // path to the decoded screenshot, shown via /local-image once its collapsed ToolImageCard is opened.
  // Like the read/command entries it stands alone — never folds into a ×N repeat count.
  outputImage?: string
  // Generic tool input/source plus terminal result metadata. These fields also retain failure context
  // for specialized cards such as Edit, which normally renders only its diff.
  input?: string
  status?: TranscriptToolCall["status"]
  backgroundState?: TranscriptToolCall["backgroundState"]
  exitCode?: number
  cwd?: string
  sessionId?: string | number
  durationMs?: number
  // Set for a Read call whose result shipped an excerpt: the (capped) file content, rendered as its
  // own collapsed card. Like edits/command, a read entry stands alone (never folds into a repeat
  // count). Absent pre-restart / for older transcripts → the Read renders as a header-only card.
  read?: string
  // Set for an Agent dispatch that shipped a prompt: the AgentBlock card (expands to the dispatch
  // prompt; live/finished state + drill-in in the header). Stands alone — never folds into a ×N count.
  prompt?: string
  subagentType?: string
  agentId?: string
  agentStatus?: "completed" | "failed" | "killed"
  agentElapsedMs?: number
  // Set for a SendMessage (peer/agent-to-agent) call: the SendMessageCard. Like the prompt/read/command
  // entries it stands alone — never folds into a ×N count.
  sendTo?: string
  sendSummary?: string
  sendBody?: string
  sendType?: string
  sendDispatchId?: string
  sendTargetLabel?: string
  // Set for a SendUserFile (file delivery) call: the SentFilesCard renders the delivered files inline —
  // `sentImages` are servable cache paths shown as pictures, `sentFiles` non-image basenames as openable
  // chips, `caption` the label. Stands alone — never folds into a ×N count.
  sentImages?: string[]
  sentFiles?: string[]
  caption?: string
  // Set for a call that carries the whole to-do list (see TranscriptTodo). Renders as a TodoBlock and,
  // like the prompt/read/command entries, stands alone — two consecutive lists are two different list
  // states and must never fold into a ×2 count.
  todos?: TranscriptTodo[]
  // Set for a native AskUserQuestion carrying its structured questions (see TranscriptToolCall.ask).
  // A SETTLED ask renders as read-only question cards — the durable record of a question the human saw,
  // answered or not — and stands alone; a pending one folds like any generic call (the interaction
  // stack owns the answerable copy while it is live).
  ask?: AskQuestion[]
  askAnswers?: (string | null)[]
  count: number
}

// Fold runs of identical (name, detail) tool calls into one entry carrying a repeat count, so a
// burst of e.g. 5 identical Reads renders as one line with a ×5 suffix rather than five rows. Edit
// calls don't fold that way; instead, consecutive edits to the SAME file merge into one entry so a
// MultiEdit fan-out (or adjacent Edits to one file) renders as a single diff block, not a stack of
// near-touching ones. A different file breaks the run.
function collapseTools(tools: TranscriptMessage["tools"]): CollapsedTool[] {
  const out: CollapsedTool[] = []
  for (const t of tools) {
    const last = out[out.length - 1]
    if (t.edit) {
      const hasResultContext = Boolean(t.input || t.output || t.status || t.exitCode !== undefined)
      if (last && last.edits && !hasResultContext && !last.input && !last.output && !last.status && last.edits[0].file === t.edit.file) last.edits.push(t.edit)
      else out.push({ name: t.name, detail: t.detail, edits: [t.edit], input: t.input, output: t.output, status: t.status, backgroundState: t.backgroundState, exitCode: t.exitCode, cwd: t.cwd, sessionId: t.sessionId, durationMs: t.durationMs, count: 1 })
    } else if (t.command) {
      out.push({ name: t.name, detail: t.detail, command: t.command, desc: t.desc, input: t.input, output: t.output, status: t.status, backgroundState: t.backgroundState, exitCode: t.exitCode, cwd: t.cwd, sessionId: t.sessionId, durationMs: t.durationMs, count: 1 })
    } else if (t.outputImage) {
      // A tool whose result carried a PICTURE (an image `Read`, chrome-devtools `take_screenshot`) renders
      // as its own ToolImageCard, the picture one click in — never folds into a ×N run. Ahead of the
      // `read` branch on purpose: a Read of a `.png` is an image first and an excerpt second, so if a
      // result ever ships both, the picture wins and the text rides along in the card's body rather than
      // replacing it.
      out.push({ name: t.name, detail: t.detail, outputImage: t.outputImage, output: t.output ?? t.read, status: t.status, durationMs: t.durationMs, count: 1 })
    } else if (t.read) {
      // A Read that shipped an excerpt renders as its own expandable card — never folds into a ×N run.
      out.push({ name: t.name, detail: t.detail, read: t.read, status: t.status, durationMs: t.durationMs, count: 1 })
    } else if (t.prompt || t.agentId) {
      // An Agent dispatch renders as its own expandable card — never folds into a ×N run. Keyed on
      // EITHER signal, the same pair ToolCardRouter renders on: a Claude dispatch brings a prompt, a
      // codex one brings only the correlation id (its dispatch message is encrypted) and carries the
      // call's own `input` as the expandable body. Keying on the prompt alone dropped agentId here,
      // silently demoting every codex dispatch to a generic card even after the router accepted it.
      out.push({ name: t.name, detail: t.detail, prompt: t.prompt, input: t.input, subagentType: t.subagentType, agentId: t.agentId, agentStatus: t.agentStatus, agentElapsedMs: t.agentElapsedMs, output: t.output, status: t.status, durationMs: t.durationMs, count: 1 })
    } else if (t.sendTo !== undefined || t.sendBody !== undefined) {
      // A SendMessage (peer message) renders as its own SendMessageCard — never folds into a ×N run.
      out.push({ name: t.name, detail: t.detail, sendTo: t.sendTo, sendSummary: t.sendSummary, sendBody: t.sendBody, sendType: t.sendType, sendDispatchId: t.sendDispatchId, sendTargetLabel: t.sendTargetLabel, status: t.status, durationMs: t.durationMs, count: 1 })
    } else if (t.todos) {
      // A to-do list renders as its own TodoBlock — never folds into a ×N run. Checked BEFORE the
      // input/output branch below, which would otherwise claim a codex plan (its `explanation` rides
      // `input`) and render it as a generic card.
      out.push({ name: t.name, detail: t.detail, todos: t.todos, input: t.input, status: t.status, durationMs: t.durationMs, count: 1 })
    } else if (isSettledAsk(t)) {
      // A settled native ask renders as its own read-only question card(s) — never folds into a ×N
      // run. A PENDING ask deliberately falls through to the generic branches: while it is live the
      // interaction stack draws the answerable copy, and history must not draw it twice.
      out.push({ name: t.name, detail: t.detail, ask: t.ask, askAnswers: t.askAnswers, status: t.status, durationMs: t.durationMs, count: 1 })
    } else if (t.sentImages || t.sentFiles) {
      // A SendUserFile delivery renders as its own SentFilesCard (images inline + caption) — never folds.
      out.push({ name: t.name, detail: t.detail, sentImages: t.sentImages, sentFiles: t.sentFiles, caption: t.caption, status: t.status, durationMs: t.durationMs, count: 1 })
    } else if (t.input || t.output) {
      out.push({ name: t.name, detail: t.detail, input: t.input, output: t.output, status: t.status, backgroundState: t.backgroundState, exitCode: t.exitCode, cwd: t.cwd, sessionId: t.sessionId, durationMs: t.durationMs, count: 1 })
    } else if (
      last &&
      !last.edits && !last.command && !last.input && !last.output && !last.read && !last.prompt &&
      !last.outputImage && !last.sentImages && !last.sentFiles &&
      last.sendTo === undefined && last.sendBody === undefined &&
      last.name === t.name && last.detail === t.detail &&
      last.status === t.status && last.backgroundState === t.backgroundState && last.exitCode === t.exitCode && last.cwd === t.cwd &&
      last.sessionId === t.sessionId && last.durationMs === t.durationMs
    ) {
      last.count++
    } else {
      out.push({ name: t.name, detail: t.detail, status: t.status, backgroundState: t.backgroundState, exitCode: t.exitCode, cwd: t.cwd, sessionId: t.sessionId, durationMs: t.durationMs, count: 1 })
    }
  }
  return out
}

// Prettify the raw tool name: MCP tools arrive as `mcp__Server__do_thing` — show the last segment.
function prettyToolName(name: string): string {
  const seg = name.split("__").pop() || name
  return seg
}

// Shorten a target for the one-liner: absolute paths collapse to their last two segments (full path
// stays in the title tooltip); commands / patterns / queries pass through (already ≤80 chars from the
// server). Keeps the line scannable without dumping a 60-char absolute path inline.
// Repo-relative display: strip the project prefix (pure noise — every path shares it) but keep the
// REST intact; the line has the card's full width and CSS-ellipsizes only when genuinely too long.
function shortenTarget(detail: string): string {
  const root = store.board?.projectDir
  if (root && detail.startsWith(root + "/")) return detail.slice(root.length + 1)
  return detail
}

// `at` is the emitting assistant message's ISO timestamp — the moment the model issued this batch of
// calls, and therefore the clock a pending FOREGROUND card times itself against. Optional: a pre-restart
// server projects messages without it, and a card with no clock marks itself immediately.
function MinimalToolActivity({ tools, at }: { tools: CollapsedTool[]; at?: string }) {
  const [expanded, setExpanded] = useState(false)
  const cardsId = useId()
  const total = tools.reduce((n, t) => n + t.count, 0)
  const label = settledToolActivityLabel(total, editedFileCount(tools))
  return (
    <div data-tool-activity data-tool-activity-state="settled" className="flex min-w-0 flex-col">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        aria-controls={cardsId}
        aria-expanded={expanded}
        aria-label={`${expanded ? "Collapse" : "Expand"} ${total} tool ${total === 1 ? "call" : "calls"}: ${label}`}
        // Shares TRANSCRIPT_META_LABEL_CLASS rather than restating its type scale — this row and
        // the reasoning label alternate in one column, and the two drifted apart while the size was
        // copied here by hand. Its `py-0.5` (the focus ring's room) is cancelled in layout by
        // `-my-0.5`, so the row is the same 20px line as the reasoning label and as the live Working row
        // it replaces when a run settles — with the padding counted, the settle grew the tail 3px and
        // moved this label 2px below where the shimmer had it (measured on real workers, 2026-10-13).
        className={`group flex w-full min-w-0 items-baseline gap-1.5 rounded -my-0.5 py-0.5 text-left outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${TRANSCRIPT_META_LABEL_CLASS}`}
      >
        <span
          data-tool-activity-label
          title={label}
          className="min-w-0 truncate text-muted"
        >
          {label}
        </span>
        <ChevronRight data-tool-activity-chevron aria-hidden="true" size={13} className={transcriptMetaChevronClass(expanded)} />
      </button>
      {expanded && (
        <div id={cardsId} className="mt-1.5 flex flex-col">
          {withSpacers(tools.map((tool, i) => <ToolCardRouter key={i} t={tool} startedAt={at} />), 6)}
        </div>
      )}
      {!expanded && <div id={cardsId} hidden />}
    </div>
  )
}

// Default-minimal tool rendering. Ordinary calls become one gerund disclosure regardless of provider
// batching. Dedicated block tools split the run and remain visible: sub-agent and send cards, and — as
// of 2026-08-01 — every LIVE background/detached lifecycle; a finished one folds back in as of
// 2026-09-13 (see lib/toolActivity.isToolActivityException).
function ToolCalls({ tools, at }: { tools: CollapsedTool[]; dense?: boolean; at?: string }) {
  const runs: { exceptional: boolean; tools: CollapsedTool[] }[] = []
  for (const tool of tools) {
    const exceptional = isToolActivityException(tool)
    const previous = runs[runs.length - 1]
    if (previous?.exceptional === exceptional) previous.tools.push(tool)
    else runs.push({ exceptional, tools: [tool] })
  }

  // A PICTURE card sets its own gap against both its neighbours here — the cards batched beside it and
  // the digest below the batch alike — while the compact cards around it keep the tight run between
  // themselves. See PICTURE_STEP.
  return (
    <div className="flex flex-col">
      {withSpacers(runs.map((run, runIndex) => (
        run.exceptional
          ? (
              <div key={`exceptions-${runIndex}`} className="flex flex-col">
                {withSpacers(
                  run.tools.map((tool, i) => <ToolCardRouter key={i} t={tool} startedAt={at} />),
                  pictureAwareGap(run.tools.map((tool) => toolBandEdges([tool])), META_CARD_STEP),
                )}
              </div>
            )
          : <MinimalToolActivity key={`activity-${runIndex}`} tools={run.tools} at={at} />
      )), pictureAwareGap(runs.map((run) => toolBandEdges(run.tools)), META_CARD_STEP))}
    </div>
  )
}

// Route a collapsed tool entry to its card. Edit/Bash/Read/Agent get expandable bodies (chevron);
// everything else (Grep, Glob, Read-without-excerpt, MCP, Monitor, a pre-restart Bash with no command)
// is a header-only card. All share the same bordered card family so no call ever reads as bare text.
export function ToolCardRouter({ t, startedAt }: { t: CollapsedTool; startedAt?: string }) {
  const slug = useContext(ThreadSlugContext)
  const thread = useThreadSnapshot(slug)
  const liveBackgroundState = liveBackgroundOperationState(t, thread?.bgShells ?? [])
  if (t.edits && t.status !== "failed" && t.status !== "cancelled") {
    return <DiffBlock edits={t.edits} meta={<ToolStatusMeta status={t.status} backgroundState={t.backgroundState} liveBackgroundState={liveBackgroundState} exitCode={t.exitCode} durationMs={t.durationMs} />} />
  }
  if (t.command) {
    return <BashBlock command={t.command} desc={t.desc ?? t.detail} output={t.output} status={t.status} backgroundState={t.backgroundState} liveBackgroundState={liveBackgroundState} exitCode={t.exitCode} sessionId={t.sessionId} durationMs={t.durationMs} startedAt={startedAt} />
  }
  // The picture comes BEFORE the excerpt: a Read of a `.png` is an image first (see collapseTools).
  if (t.outputImage) return <ToolImageCard name={t.name} detail={t.detail} outputImage={t.outputImage} output={t.output} status={t.status} durationMs={t.durationMs} />
  if (t.read) return <ReadBlock detail={t.detail} read={t.read} status={t.status} durationMs={t.durationMs} />
  // A dispatch renders as an AgentBlock on EITHER signal: a prompt (Claude) or just the correlation id
  // (codex — it encrypts the dispatch message, so there is no prompt to show, but the child is still
  // tracked and drillable). Gating on the prompt alone left every codex sub-agent as a mute generic card.
  if (t.prompt || t.agentId) return <AgentBlock detail={t.detail} prompt={t.prompt} subagentType={t.subagentType} agentId={t.agentId} agentStatus={t.agentStatus} agentElapsedMs={t.agentElapsedMs} status={t.status} durationMs={t.durationMs} />
  if (t.sendTo !== undefined || t.sendBody !== undefined) return <SendMessageBlock to={t.sendTo} summary={t.sendSummary} body={t.sendBody ?? ""} type={t.sendType} dispatchId={t.sendDispatchId} targetLabel={t.sendTargetLabel} status={t.status} durationMs={t.durationMs} at={startedAt} />
  if (t.sentImages || t.sentFiles) return <SentFilesCard images={t.sentImages ?? []} files={t.sentFiles ?? []} caption={t.caption} status={t.status} durationMs={t.durationMs} />
  // The built-in to-do list, ahead of the generic input/output card (a codex plan's `explanation` rides
  // `input`, which that branch would claim first).
  if (t.todos) return <TodoBlock todos={t.todos} note={t.input} meta={<ToolStatusMeta status={t.status} durationMs={t.durationMs} />} />
  // A settled native ask: the read-only question card(s), answered or not — see SettledAskBlock.
  if (isSettledAsk(t)) return <SettledAskBlock ask={t.ask ?? []} askAnswers={t.askAnswers} />
  if (t.input || t.output) {
    return <BashBlock name={t.name} command={t.input ?? ""} desc={t.detail} output={t.output} status={t.status} backgroundState={t.backgroundState} liveBackgroundState={liveBackgroundState} exitCode={t.exitCode} sessionId={t.sessionId} durationMs={t.durationMs} inputLabel="input" startedAt={startedAt} />
  }
  return <ToolCard name={t.name} detail={t.detail} count={t.count} status={t.status} backgroundState={t.backgroundState} liveBackgroundState={liveBackgroundState} exitCode={t.exitCode} cwd={t.cwd} sessionId={t.sessionId} durationMs={t.durationMs} startedAt={startedAt} />
}

// A SETTLED native AskUserQuestion, read back out of the transcript: the same question card the
// interaction stack drew while the ask was answerable, now read-only at the place the call happened.
// This is what keeps a question the human saw from vanishing — a follow-up sent instead of an answer
// retires the pending card, and until 2026-08-30 the transcript then held only a generic tool line
// inside a "Ran N tool calls" disclosure (maintainer: "the questions should continue to render as they
// were from earlier in the transcript, even if they weren't answered"). An answered ask renders its
// recorded choice in the AnswersCard's quiet settled treatment; an unanswered one says "Not answered".
function SettledAskBlock({ ask, askAnswers }: { ask: AskQuestion[]; askAnswers?: (string | null)[] }) {
  return (
    <div data-settled-ask className="flex flex-col gap-1.5">
      {ask.map((q, i) => {
        const view = settledAskView(q, askAnswers?.[i])
        return (
          <QuestionBlockCard
            key={i}
            question={view.question}
            settled={{ chosenIdxs: view.chosenIdxs, text: view.text }}
          />
        )
      })}
    </div>
  )
}

type ToolStatus = NonNullable<TranscriptToolCall["status"]>

// THE TRANSCRIPT'S RIGHT-HAND READING — one renderer for every card's meta slot.
//
// It exists because the slot had TWO of them and they diverged on every axis at once. A column of
// dispatch cards read "3m", "stopped 41m", "failed 12m" in lowercase sans at three alphas, directly
// above "CANCELLED" in amber petite-caps and "FAILED · 12 SEC" in red petite-caps — two typographic
// systems, four saturations, two duration formatters and two separators, for eight readings of the same
// kind (maintainer 2026-07-29: "a bizarre mix of font sizes, color saturations, and capitalization").
// Worse, the lowercase half also sat 1.0px BELOW the title's cap band, because only the petite-caps half
// carried `frizz-tool-header-caps`'s optical lift.
//
// So the typography, the `·` separator and the optical correction now live HERE, once, and a caller may
// only choose its WORDS and its TONE. Consistency by construction: a new reading cannot invent a second
// treatment without editing this function.
function ToolMetaReading({ tone, indicator, label, duration, title }: {
  tone: string
  indicator?: ReactNode
  label?: string
  duration?: string
  title: string
}) {
  return (
    <span className={`petite-caps frizz-tool-header-caps flex shrink-0 items-center gap-1 whitespace-nowrap text-[11.5px] leading-none ${tone}`} title={title} aria-label={title}>
      {indicator}
      <span>{[label, duration].filter(Boolean).join(" · ")}</span>
    </span>
  )
}

// A foreground call crosses the "long enough to mark" threshold while it is ON SCREEN, so the card has
// to reach that moment ITSELF: it is not a data change, nothing pushes, and the shared 30s liveClock is
// far too coarse to land a 2s edge. One timer per pending card, armed for exactly the remaining time and
// cleared on resolve/unmount — so a batch of fast Reads arms and drops its timers without ever painting,
// and a `sleep 30` lights up 2s in and stays lit.
function useForegroundRunning(status: ToolStatus | undefined, backgroundState: TranscriptToolCall["backgroundState"], startedAt: string | undefined): boolean {
  const [now, setNow] = useState(() => Date.now())
  const pending = isPendingForegroundTool(status, backgroundState)
  const running = foregroundToolIsRunning(status, backgroundState, startedAt, now)
  useEffect(() => {
    // Already marked, or nothing to mark: no timer at all. `running` is what makes this terminate —
    // once it flips true the effect re-runs and returns without arming again.
    if (!pending || running) return
    const started = startedAt ? Date.parse(startedAt) : Number.NaN
    if (!Number.isFinite(started)) return
    const timer = setTimeout(() => setNow(Date.now()), Math.max(FOREGROUND_MARK_AFTER_MS - (Date.now() - started), 0))
    return () => clearTimeout(timer)
  }, [pending, running, startedAt])
  return running
}

// THE LIVENESS MARK, LEADING THE ROW — the same slot, the same width, the same ink correction the
// dispatch card uses (AgentBlock, below), because it is the same statement: something is alive behind
// this card. It sat in the RIGHT-hand reading instead, which put a shell card's blue dot at the
// opposite edge from a sub-agent card's accent one for no reason a reader could name (maintainer
// 2026-07-30: "the blue indicator for a background bash tool is still on the right instead of on the
// left … its rendering should align with the agent tool call component").
//
// The glyphs are the shared child-op vocabulary (lib/childOps.ts + BackgroundOpsStrip), so a detached
// shell is marked the SAME way on its transcript card, in the drawer's ops strip and on the queue card:
// pulsing blue = running, breathing muted blue = alive but quiet. A card with nothing live behind it
// renders NO SLOT at all — an empty reservation reads as a layout bug, which is exactly what the
// dispatch card had to unlearn (see AgentBlock's `mark`).
//
// A pending FOREGROUND command marks itself here too, on elapsed time (lib/operationIndicators.ts) —
// the spinner it used to get at the far right is gone. Detached or not, a shell that is running right
// now is the same fact to a reader, and splitting it across two glyphs at two edges meant the LONGEST
// commands — the ones you actually wait on — were the least visible thing on screen.
//
// A FINISHED op — detached or not — draws NOTHING here, and no slot for it either (maintainer
// 2026-08-01: "remove the status indicator entirely for a sub-agent or background shell that has
// completed"). This column states ONE fact, "something is alive behind this row", so a finished op has
// nothing to say in it; the right-hand reading already carries the outcome and the runtime. A briefly
// shipped static "done" dot is what that ruling overturned: marking every settled card meant the column
// was occupied on nearly every row in a scrolled transcript, which is noise wearing the costume of
// information — and a still frame cannot show a pulse, so the finished mark had to be muted to avoid
// reading as live, i.e. it was already conceding it had no business being there.
function ToolLiveMark({ status, backgroundState, liveBackgroundState, startedAt }: { status?: ToolStatus; backgroundState?: TranscriptToolCall["backgroundState"]; liveBackgroundState?: "running" | "stale"; startedAt?: string }) {
  const foregroundRunning = useForegroundRunning(status, backgroundState, startedAt)
  // Precedence follows the READING beside it, exactly: a tracked op's own observed state outranks the
  // call's pending-ness, so a shell whose process the OS has confirmed gone draws the flat stale dot next
  // to the word "stale" — the same mark the dispatch card gives a stale child — even while its call still
  // reads pending. The old right-hand indicator tested `running || pending-background` first and so
  // pulsed at full brightness beside its own "stale" — the same self-contradiction the agent rows had
  // to unlearn. `pending && background` is the fallback: detached, but no live op correlated to it.
  const mark =
    liveBackgroundState === "running" ? (
      <span aria-hidden className="frizz-live-dot frizz-live-dot--shell" data-running-indicator="tool-disclosure" />
    ) : liveBackgroundState === "stale" ? (
      <span className={CHILD_STALE_DOT_CLASS} title={CHILD_STALE_SHELL_TITLE} />
    ) : hasRunningToolIndicator(status, backgroundState) || foregroundRunning ? (
      <span aria-hidden className="frizz-live-dot frizz-live-dot--shell" data-running-indicator="tool-disclosure" />
    ) : null
  if (!mark) return null
  // `-mr-1` pulls the label back to roughly the dot↔label gap the child lines use: the header's own
  // gap-2 is tuned for a petite-caps label beside a path, and at full width a 6px dot floated away from
  // the word it qualifies.
  return <span className="frizz-tool-mark -mr-1 flex w-[9px] shrink-0 justify-center">{mark}</span>
}

export function ToolStatusMeta({ status, backgroundState, liveBackgroundState, exitCode, durationMs }: { status?: ToolStatus; backgroundState?: TranscriptToolCall["backgroundState"]; liveBackgroundState?: "running" | "stale"; exitCode?: number; durationMs?: number }) {
  if (!status && durationMs === undefined) return null
  // The GLYPH carries "background", so the words no longer have to. "BACKGROUND RUNNING" in petite-caps
  // beside a dot that already says background was the longest string in the header and pushed the command
  // it annotates into truncation for a fact it was stating twice (maintainer 2026-07-29: "it is way too
  // long of a label to put into that card"). The drawn label is the short form; `longLabel` keeps the
  // explicit phrasing for the tooltip and the accessible name, where length costs nothing.
  const [label, longLabel] =
    liveBackgroundState === "running"
      ? ["running", "background running"]
      : liveBackgroundState === "stale"
        ? ["stale", "background stale"]
        : status === "pending"
      ? backgroundState === "unknown"
        ? ["unknown", "background / unknown"]
        : ["running", backgroundState === "background" ? "background running" : "running"]
      : status === "failed"
        ? exitCode !== undefined
          ? [`exit ${exitCode}`, `exit ${exitCode}`]
          : ["failed", "failed"]
        : status === "cancelled"
          ? ["cancelled", "cancelled"]
          : status === "completed"
            ? ["done", "done"]
            : [undefined, undefined]
  const duration = durationMs !== undefined ? formatToolDuration(durationMs) : undefined
  const title = [longLabel, duration].filter(Boolean).join(" · ")
  const tone = status === "failed" ? "frizz-tool-failed" : status === "cancelled" ? "text-attention" : "text-muted-55"
  return (
    <ToolMetaReading
      tone={tone}
      title={title}
      label={label}
      duration={duration}
      // NO indicator: every liveness glyph this family draws now leads the row (ToolLiveMark), the
      // detached and the foreground alike. The reading is words only. (The dispatch card still spins
      // here, for the one thing elapsed time cannot say — see AgentBlock: no child record at all.)
    />
  )
}

// A yielded command's result reports how long the INITIAL tool budget ran before yielding. That is
// not the command's duration: rendering it on a still-RUNNING Bash card froze the readout at values
// such as "11 sec" for hours. Pending Bash cards measure from their original transcript timestamp and
// tick live; completed cards keep the provider-derived fixed duration.
function useBashDuration(status: ToolStatus | undefined, startedAt: string | undefined, fixedDurationMs: number | undefined): number | undefined {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN
  const live = status === "pending" && Number.isFinite(started)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const tick = () => setNow(Date.now())
    let interval: ReturnType<typeof setInterval> | undefined
    const first = setTimeout(() => {
      tick()
      interval = setInterval(tick, 1_000)
    }, 1_000 - (Date.now() % 1_000))
    return () => {
      clearTimeout(first)
      if (interval) clearInterval(interval)
    }
  }, [live, startedAt])
  return live ? Math.max(now - started, 0) : fixedDurationMs
}

function contextualDetail(detail?: string, cwd?: string, sessionId?: string | number): string | undefined {
  // "in <dir>" earns its space only when the command ran somewhere OTHER than the project root. codex
  // stamps every exec_command with an absolute `workdir`, which for the overwhelming majority of calls
  // IS the project root — and shortenTarget can't strip that, because it only strips the `root + "/"`
  // PREFIX and an exact match has no trailing slash. So every card carried the same absolute path, and
  // once codex cards gained a reasoning caption that redundant suffix was truncating the caption away.
  const where = cwd && cwd !== store.board?.projectDir ? `in ${shortenTarget(cwd)}` : undefined
  const context = cwd ? where : sessionId !== undefined && !detail?.includes(String(sessionId)) ? `session ${sessionId}` : undefined
  return [detail, context].filter(Boolean).join(" · ") || undefined
}

// A tool detail reads as a file path we can open in the editor when it's a single absolute-path
// token (starts with "/", no spaces, and not the server's 80-char "…" truncation). Commands like
// "git status" and truncated details stay plain text.
function isFilePath(detail: string): boolean {
  return detail.startsWith("/") && !detail.includes(" ") && !detail.includes("…")
}

// A header-only tool card: the IDENTICAL bordered card chrome as Bash/Read/Edit/Agent (same .frizz-bash
// container + .frizz-bash-header — border, bg, radius, padding, the label↔detail gap, 12.5px mono) but
// with NO expandable body, so it drops only the chevron. This is the fallback for every call without a
// payload — Grep, Glob, a pre-restart command-less Bash / excerpt-less Read, MCP tools, Monitor — the
// COMMON case pre-restart, so it must be indistinguishable from a real card header. petite-caps label
// left, repo-relative detail middle (an editor deep-link for a plain absolute path), ×N fold right. No
// call ever reads as bare `Name(detail)` text again.
function ToolCard({ name, detail, count, status, backgroundState, liveBackgroundState, exitCode, cwd, sessionId, durationMs, startedAt }: { name: string; detail?: string; count: number; status?: ToolStatus; backgroundState?: TranscriptToolCall["backgroundState"]; liveBackgroundState?: "running" | "stale"; exitCode?: number; cwd?: string; sessionId?: string | number; durationMs?: number; startedAt?: string }) {
  const shownDetail = contextualDetail(detail, cwd, sessionId)
  const short = shownDetail ? shortenTarget(shownDetail) : undefined
  const linkPath = detail && isFilePath(detail) ? detail : undefined
  return (
    <div className="frizz-bash" title={shownDetail}>
      <div className="frizz-bash-header">
        <span className="flex min-w-0 items-center gap-2">
          <ToolLiveMark status={status} backgroundState={backgroundState} liveBackgroundState={liveBackgroundState} startedAt={startedAt} />
          <span className="petite-caps frizz-bash-label shrink-0">{prettyToolName(name)}</span>
          {short &&
            (linkPath ? (
              // The path link swallows its own click so opening the file doesn't select the card.
              <span className="min-w-0 truncate" onClick={(e) => e.stopPropagation()}>
                <PathLink path={linkPath} className="text-[11.5px] text-muted">
                  {short}
                </PathLink>
              </span>
            ) : (
              <span className="min-w-0 truncate text-[11.5px] text-muted">{short}</span>
            ))}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <ToolStatusMeta status={status} backgroundState={backgroundState} liveBackgroundState={liveBackgroundState} exitCode={exitCode} durationMs={durationMs} />
          {count > 1 && <span className="tabular-nums text-[11px] text-muted-45">×{count}</span>}
        </span>
      </div>
    </div>
  )
}

// A tool whose result carried an image (chrome-devtools `take_screenshot`, a Read of a `.png`, codex's
// `view_image`): a card like ReadBlock, COLLAPSED by default, whose body is the picture. A worker takes
// these to check its own work, and the human sees a picture only where the worker chose to SHOW one, in
// a ```lightbox fence (maintainer 2026-10-03: "we should stop having special rendering where we display
// screenshots in the read tool … No images or screenshots are visible unless you make them visible to
// the user with the light box"). So the call folds into the `Ran N tool calls` digest like any other
// (lib/toolActivity.isToolActivityException), and the picture is one click further in. It reverses
// 2026-08-02 ("those should just be rendered … automatically"), which drew every one of them open.
//
// The one Read the server does NOT hand a picture is a Read of the human's own prompt attachment, whose
// bubble already shows it (server/frizz-paths.ts isPromptAttachmentPath); that call keeps its plain
// header. Opened, the picture sits in the shared frame's mat (ImageFrame) and clicks through to the
// lightbox viewer like any picture; any accompanying text result prints below it.
function ToolImageCard({ name, detail, outputImage, output, status, durationMs }: { name: string; detail?: string; outputImage: string; output?: string; status?: ToolStatus; durationMs?: number }) {
  const [open, setOpen] = useState(false)
  const [broken, setBroken] = useState(false)
  const bodyId = useId()
  const label = prettyToolName(name)
  const short = detail ? shortenTarget(detail) : undefined
  return (
    <div data-tool-image className="frizz-bash">
      <ToolDisclosureHeader
        className="frizz-bash-header"
        controls={bodyId}
        expanded={open}
        label={`${open ? "Collapse" : "Expand"} ${label}${detail ? `: ${detail}` : ""}`}
        onToggle={() => setOpen((v) => !v)}
        meta={<ToolStatusMeta status={status} durationMs={durationMs} />}
      >
        <span className="petite-caps frizz-bash-label shrink-0">{label}</span>
        {short && <span className="min-w-0 truncate text-[11.5px] text-muted" title={detail}>{short}</span>}
      </ToolDisclosureHeader>
      <div id={bodyId} hidden={!open}>
        {open && (
          <>
            {broken ? (
              <div className="frizz-bash-body break-all text-muted-70">{outputImage}</div>
            ) : (
              <div className={IMAGE_FRAME_MAT}>
                {/* `outputImage` is ALWAYS a hash-named copy in the screenshot cache, so its basename
                    would read "9f2c…c1.png". The alt names the real target instead, and the lightbox
                    viewer titles the picture from it (lib/lightbox.lightboxImageFor). */}
                <img
                  src={localImageUrl(outputImage)}
                  alt={short ? `${label}: ${short}` : label}
                  data-local-path={outputImage}
                  data-local-image="true"
                  onError={() => setBroken(true)}
                  className={`cursor-zoom-in ${FRAMED_IMAGE}`}
                />
              </div>
            )}
            {output && <pre className="frizz-bash-body frizz-bash-output-body">{output}</pre>}
          </>
        )}
      </div>
    </div>
  )
}

// A SendUserFile delivery — the worker surfacing files to the human. Same card family (`frizz-bash`) and
// header as ToolImageCard so it reads as one of the tool cards, but OPEN by default: seeing the delivered
// images IS the point. Body: the images as ONE lightbox gallery — the same object a ```lightbox fence
// draws, because a delivery is the other way a worker SHOWS a picture (via the gated /local-image route)
// — non-image files as openable chips (BlockFile → the gated opener), and the `caption` below in muted
// prose (capped ~65% wide so long captions stay readable against the wide card, not one edge-to-edge line).
function SentFilesCard({ images, files, caption, status, durationMs }: { images: string[]; files: string[]; caption?: string; status?: ToolStatus; durationMs?: number }) {
  const [open, setOpen] = useState(true)
  const bodyId = useId()
  // Uncaptioned tiles: the one `caption` describes the delivery as a whole and prints once, below. It
  // still names each picture in the viewer, whose file is a hash-named cache copy.
  const galleryEntries = useMemo(() => images.map((target) => ({ target, title: caption ?? "Delivered image" })), [images, caption])
  const summary = [
    images.length ? `${images.length} image${images.length === 1 ? "" : "s"}` : "",
    files.length ? `${files.length} file${files.length === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" · ")
  return (
    <div className="frizz-bash">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        aria-controls={bodyId}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} files sent to you${summary ? `: ${summary}` : ""}`}
        className="frizz-bash-header w-full text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ink-60"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="petite-caps frizz-bash-label shrink-0">Sent to you</span>
          {summary && <span className="min-w-0 truncate text-[11.5px] text-muted">{summary}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <ToolStatusMeta status={status} durationMs={durationMs} />
          <ChevronRight aria-hidden="true" size={12} className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />
        </span>
      </button>
      <div id={bodyId} hidden={!open}>
        {open && (
          <>
            {/* The card's border is the gallery's frame, as ToolImageCard's is its picture's: a framed
                gallery in here drew a bordered box 10px inside the card's own. */}
            {images.length > 0 && <LightboxGallery entries={galleryEntries} framed={false} />}
            {(files.length > 0 || caption) && (
              <div className="flex flex-col gap-1.5 px-2.5 pb-2.5 pt-1.5">
                {files.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {files.map((f, i) => <BlockFile key={`f${i}`} path={f} />)}
                  </div>
                )}
                {caption && <div className="max-w-[65%] text-[12px] leading-snug text-muted">{caption}</div>}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// A multi-line / long Bash command rendered as its own block, COLLAPSED by default: the header is
// the model-authored `description` of the command (falling back to its first line), and clicking
// the header reveals the raw command in mono — pre-wrapped so long lines wrap (wide unbreakable
// content scrolls INSIDE the block, never the page). Past ~16 lines the open body clamps too.
const BASH_MAX_LINES = 16
function BashBlock({
  command,
  desc,
  output,
  name = "Bash",
  status,
  backgroundState,
  liveBackgroundState,
  exitCode,
  sessionId,
  durationMs,
  inputLabel,
  startedAt,
}: {
  command: string
  desc?: string
  output?: string
  name?: string
  status?: ToolStatus
  backgroundState?: TranscriptToolCall["backgroundState"]
  liveBackgroundState?: "running" | "stale"
  exitCode?: number
  sessionId?: string | number
  durationMs?: number
  inputLabel?: string
  startedAt?: string
}) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [outExpanded, setOutExpanded] = useState(false)
  const bodyId = useId()
  const shownDurationMs = useBashDuration(status, startedAt, durationMs)
  const lineCount = useMemo(() => command.split("\n").length, [command])
  const long = lineCount > BASH_MAX_LINES
  // Codex ships the command's stdout/stderr in the same rollout (Claude doesn't), so a codex Bash card
  // carries an `output` pane below the command — clamped + independently expandable like the command.
  const outLineCount = useMemo(() => (output ? output.split("\n").length : 0), [output])
  const outLong = outLineCount > BASH_MAX_LINES
  // A command's working directory is execution metadata, not useful header copy. Keep yielded-session
  // context when present, but let the authored description stand on its own for ordinary Bash calls.
  const shownDesc = contextualDetail(desc, undefined, sessionId)
  const expandable = Boolean(command || output)
  return (
    <div className="frizz-bash">
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        aria-controls={expandable ? bodyId : undefined}
        aria-expanded={expandable ? open : undefined}
        aria-label={`${expandable ? `${open ? "Collapse" : "Expand"} ` : ""}${prettyToolName(name)}${shownDesc ? `: ${shownDesc}` : ""}`}
        className="frizz-bash-header w-full text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ink-60"
      >
        <span className="flex min-w-0 items-center gap-2">
          <ToolLiveMark status={status} backgroundState={backgroundState} liveBackgroundState={liveBackgroundState} startedAt={startedAt} />
          <span className="petite-caps frizz-bash-label shrink-0">{prettyToolName(name)}</span>
          <span className="min-w-0 truncate text-[11.5px] text-muted" title={shownDesc}>{shownDesc ?? ""}</span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <ToolStatusMeta status={status} backgroundState={backgroundState} liveBackgroundState={liveBackgroundState} exitCode={exitCode} durationMs={shownDurationMs} />
          {expandable && <ChevronRight aria-hidden="true" size={12} className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />}
        </span>
      </button>
      {expandable && (
        <div id={bodyId} hidden={!open}>
          {open && command && (
            <>
              {inputLabel && <div className="frizz-bash-output-label petite-caps">{inputLabel}</div>}
              {/* A Bash card's body is a shell command, so it highlights as one. A card carrying an
                  `inputLabel` is NOT shell — that is codex's structured tool input reusing this card
                  family — and stays plaintext rather than being painted in a grammar it isn't. */}
              <CodeBody
                text={command}
                language={inputLabel ? "plaintext" : "bash"}
                className={`frizz-bash-body${inputLabel ? " frizz-bash-output-body" : ""}${long && !expanded ? " frizz-bash-clamp" : ""}`}
              />
              {long && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  onMouseDown={(e) => e.preventDefault()}
                  className="frizz-bash-expand petite-caps px-2.5 pb-1.5"
                >
                  {expanded ? "Collapse" : `Show all ${lineCount} lines`}
                </button>
              )}
            </>
          )}
          {open && output && (
            <>
              <div className="frizz-bash-output-label petite-caps">output</div>
              <pre className={`frizz-bash-body frizz-bash-output-body${outLong && !outExpanded ? " frizz-bash-clamp" : ""}`}>{output}</pre>
              {outLong && (
                <button
                  type="button"
                  onClick={() => setOutExpanded((v) => !v)}
                  onMouseDown={(e) => e.preventDefault()}
                  className="frizz-bash-expand petite-caps px-2.5 pb-1.5"
                >
                  {outExpanded ? "Collapse" : `Show all ${outLineCount} lines`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// A Read call rendered as a sibling of BashBlock/DiffBlock: a bordered card, COLLAPSED by default,
// whose header is the petite-caps "Read" label + the repo-relative path (an editor deep-link when the
// detail is a plain absolute path). Expanding reveals WHAT was read — the (server-capped) file excerpt
// in mono, with the same clamp + "Show all N lines" affordance as a long Bash body. Reuses the
// frizz-bash card classes so Bash / Edit / Read read as one system.
const READ_MAX_LINES = 16
function ReadBlock({ detail, read, status, durationMs }: { detail?: string; read: string; status?: ToolStatus; durationMs?: number }) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const lineCount = useMemo(() => read.split("\n").length, [read])
  const long = lineCount > READ_MAX_LINES
  const short = detail ? shortenTarget(detail) : undefined
  const linkPath = detail && isFilePath(detail) ? detail : undefined
  return (
    <div className="frizz-bash">
      <ToolDisclosureHeader
        className="frizz-bash-header"
        controls={bodyId}
        expanded={open}
        label={`${open ? "Collapse" : "Expand"} Read${detail ? `: ${detail}` : ""}`}
        onToggle={() => setOpen((v) => !v)}
        meta={<ToolStatusMeta status={status} durationMs={durationMs} />}
      >
        <span className="petite-caps frizz-bash-label shrink-0">Read</span>
        {short &&
          (linkPath ? (
            <span className="min-w-0 truncate">
              <PathLink path={linkPath} className="text-[11.5px] text-muted">
                {short}
              </PathLink>
            </span>
          ) : (
            <span className="min-w-0 truncate text-[11.5px] text-muted">{short}</span>
          ))}
      </ToolDisclosureHeader>
      <div id={bodyId} hidden={!open}>
        {open && (
          <>
            {/* The excerpt highlights in the grammar of the file that was READ — the same path the
                header links to. An unrecognized extension stays plaintext (no guessing), and the
                `cat -n` line numbers are separated out before the grammar sees them. */}
            <CodeBody
              text={read}
              language={resolveFileLanguage(detail)}
              className={`frizz-bash-body${long && !expanded ? " frizz-bash-clamp" : ""}`}
            />
            {long && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                onMouseDown={(e) => e.preventDefault()}
                className="frizz-bash-expand petite-caps px-2.5 pb-1.5"
              >
                {expanded ? "Collapse" : `Show all ${lineCount} lines`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// An Agent dispatch rendered as a sibling of BashBlock/ReadBlock: a bordered card COLLAPSED by default;
// the chevron expands the dispatch PROMPT. TWO affordances, kept distinct: the chevron toggles the
// prompt body, while the DESCRIPTION itself is an underlined link (PathLink treatment) that drills INTO
// that sub-agent's own transcript in a new drawer — for LIVE and COMPLETED children alike (the drawer
// resolves both; an aged-out one degrades to "unavailable").
//
// THE HEADER MIRRORS THE PROMPT-BOX CHILD LINES (maintainer 2026-07-29). A dispatch card and the
// `ChildOpRow` lines under the prompt box name the SAME running child, so they now read the same way,
// in the same order: the liveness MARK first, then the kind ("Agent"), then the title, then the RUNTIME
// right-justified at the far edge. What that cost, deliberately:
//   • the "[subagent_type]" tag went, on the same ruling as the child lines two days earlier — but it
//     came BACK on 2026-08-27, as a resolved model+effort CELL rather than a raw profile name
//     (maintainer: "subagent dispatch cards should always show effort & model visible"). The ruling it
//     overturns was about repeating the PARENT's profile: a dispatch card names a different runtime
//     from the one the prompt box is set to, and after the effort-only split (frizz:high, the model on
//     the Agent tool's own parameter) the model was on no surface at all. The cell is resolved server
//     side — see subagent-profile.ts — so the card, the drawer, the rail tooltip and the resting
//     card's child line all read the same pair;
//   • the state VERB is gone for the two nominal outcomes. A pulsing dot already says "running" and NO
//     mark at all already says "not running any more", so "running 3 min" / "finished 35m" became a
//     bare runtime. A NON-nominal outcome keeps its verb ("STOPPED · 4 MIN", "FAILED · 12 MIN"): a mark
//     cannot say that, and losing it would delete the one fact the reader most needs.
//
// The reading itself is `ToolMetaReading` — the transcript's shared right-hand slot — so this card's
// petite-caps reading, and the one on the Bash card under it, are the same treatment by construction.
// The MIRROR with the child lines is about order and content, not typography: those lines live in the
// rail, the queue card and the ops strip, where the compact "41m" form earns its horizontal budget;
// this card sits in a column of tool cards and speaks their language. See lib/agentReading.ts.
// Exported for operation-indicators-fixture.tsx: the agent row is the one card family with TWO
// independent status sources (its own state reading + the shared meta slot), so it needs live fixture
// coverage — the double-indicator bug shipped precisely because the fixture skipped it.
const AGENT_MAX_LINES = 16
export function AgentBlock({
  detail,
  prompt,
  subagentType,
  agentId,
  agentStatus,
  agentElapsedMs,
  status,
  durationMs,
}: {
  detail?: string
  // Only the initial instruction belongs in this disclosure, never fork settings or the spawn ACK.
  // Codex may encrypt it; an unavailable prompt must not be replaced by unrelated tool metadata.
  prompt?: string
  subagentType?: string
  agentId?: string
  agentStatus?: "completed" | "failed" | "killed"
  agentElapsedMs?: number
  status?: ToolStatus
  durationMs?: number
}) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const body = prompt || "Initial prompt unavailable."
  const lineCount = useMemo(() => (body ? body.split("\n").length : 0), [body])
  const long = lineCount > AGENT_MAX_LINES
  // Thread surface OR sub-agent drawer (a nested dispatch inside a child's own transcript still drills
  // in — the router maps an id it can no longer resolve to "gone", which the drawer states plainly).
  const slug = useChildDrillSlug()
  const thread = useThreadSnapshot(slug)
  // The live tracked sub-agent for this dispatch (matched by tool_use id) — drives the "running Nm"
  // header + spinner. Only present before the transcript records a completion (a finished child has
  // left the live set). The DRAWER, though, resolves live AND completed children, so the title links
  // regardless — it just needs the correlation id + a slug to resolve against.
  const live = !agentStatus && agentId ? (thread?.subAgents ?? []).find((s) => s.id === agentId) : undefined
  // Only "running" animates. Tested positively rather than as "not stale": a RESTED child (its run over,
  // its own fan-out still going — see the shared SubAgentView) is a third reading, and the old negative
  // test would have spun a header for an agent that has stopped.
  const running = live?.state === "running"
  const canDrill = !!(slug && agentId)
  const title = detail ?? "sub-agent"
  // The child's runtime, in the same words the drawer's readout uses. Absent only when the provider
  // recorded nothing at all about it — a legacy transcript, where the column silently collapses.
  const profile = subAgentProfileCell(subagentType)
  // Drives the live runtime, on the same shared 30s tick the child rows use — so the dispatch card's
  // reading and the prompt-box line naming the same child never disagree about how long it has been up.
  const now = useNowMs()

  // THE READING — one derivation for every case (lib/agentReading.ts), so a dispatch card says the same
  // thing in the same words, tone and typography whether or not the client still holds a live record for
  // the child. Two renderers used to split that by data availability and diverged on every visible axis;
  // that module's header documents what each of them got wrong.
  //
  // ONE running indicator per row (maintainer 2026-07-18) still holds, now trivially: the reading never
  // claims liveness at all. A tracked child is marked on the LEFT and reads a bare runtime; an untracked
  // dispatch reads its terminal outcome or nothing. AT MOST one, in every branch, and never a second
  // opinion about whether the child is alive.
  const reading = agentReading({
    agentStatus,
    agentElapsedMs,
    liveState: live?.state,
    liveElapsedMs: live?.startedAt ? Math.max(now - Date.parse(live.startedAt), 0) : undefined,
    status,
    durationMs,
  })

  // The liveness MARK. Every glyph is the shared child-op vocabulary (lib/childOps.ts), so this card and
  // the line under the prompt box mark the same child the same way: pulsing accent = running, flat gray =
  // stale, hollow = rested (its run over, its own fan-out still going). A background SHELL card leads
  // with the same slot in the same position (ToolLiveMark), in shell blue — one liveness column for the
  // whole transcript, whichever kind of thing is alive behind the card.
  //
  // A RESOLVED child gets no mark AND NO SLOT (maintainer 2026-07-29: "there's a weird gap now to the
  // left of the word 'Agent'"; re-affirmed 2026-08-01: "remove the status indicator entirely for a
  // sub-agent or background shell that has completed"). The slot used to be reserved whether or not it
  // drew anything, so a run of cards would align its labels down one edge — but a finished card is the
  // COMMON case in a scrolled transcript, and an empty 13px reservation there reads as a layout bug, not
  // as "not running any more".
  //
  // A static "finished" glyph was tried for exactly one commit and removed: filling the slot on every
  // settled card put a mark on nearly every row, and because a still frame cannot show a pulse it had to
  // be muted to avoid reading as live — which is the tell that it was carrying no information. With the
  // slot gone a resolved dispatch card leads with its petite-caps label exactly like every other tool
  // card in the transcript, and the runtime in the right-hand column is what says it ran and stopped.
  const mark =
    running ? (
      <span aria-hidden className="frizz-live-dot frizz-live-dot--agent" data-running-indicator="subagent-disclosure" />
    ) : live?.state === "stale" ? (
      <span className={CHILD_STALE_DOT_CLASS} title={CHILD_STALE_TITLE} />
    ) : live?.state === "rested" ? (
      <span className={CHILD_RESTED_DOT_CLASS} title={CHILD_RESTED_TITLE} />
    ) : null

  function openDrawer() {
    if (!slug || !agentId) return
    pushSubAgentDrawer(slug, agentId, { label: title, subagentType, startedAt: live?.startedAt })
  }

  return (
    <div className="frizz-bash">
      <ToolDisclosureHeader
        className="frizz-bash-header"
        controls={bodyId}
        expanded={open}
        label={`${open ? "Collapse" : "Expand"} Agent dispatch: ${title}`}
        onToggle={() => setOpen((v) => !v)}
        meta={
          // THE READOUT: the child's PROFILE, then its RUNTIME — the order and the separator the resting
          // card's own child line already uses ("opus-high · 23m", AwaitingBackgroundCard). Two spans and
          // not one string, because only the runtime half changes tone: a failed child turns that half
          // red, and the model it ran at did not fail.
          //
          // The profile sits HERE rather than beside the "Agent" label, where it was first put. Every
          // tool card in the transcript — Bash, Read, Edit — starts its detail immediately after the kind
          // label, so a variable-width cell in that position made the Agent card the one row whose title
          // began somewhere else: `opus › high`, `sonnet › medium` and a legacy card with no cell at all
          // each pushed it to a different x, and a column of them read with a ragged left edge. The
          // right-hand slot already varies card to card, so it absorbs a second reading without moving
          // anything the eye scans down.
          (profile || reading) && (
            <>
              {profile && (
                <span
                  data-subagent-profile
                  className="petite-caps frizz-tool-header-caps shrink-0 whitespace-nowrap text-[11.5px] leading-none text-muted-55"
                  title={`Sub-agent profile: ${profile}`}
                >
                  {profile}
                </span>
              )}
              {/* The separator sits at the PROFILE's tone, not a dimmer one of its own: it closes that
                  segment, and drawn fainter than the reading's own "·" it read as the weaker break when
                  it is the stronger one. `-mx-[2px]` is the OPTICAL trim: this dot is spaced by the
                  row's flex gap while the reading's identical dot ("stopped · 41 min") is spaced by two
                  text spaces, and the two rhythms did not agree — measured 8.91/8.26px of ink against
                  the text one's 6.51/7.01. Trimmed, they read as one chain (6.9/6.3). */}
              {profile && reading && <span aria-hidden className="petite-caps frizz-tool-header-caps -mx-[2px] shrink-0 text-[11.5px] leading-none text-muted-55">·</span>}
              {reading && (
                <ToolMetaReading
                  tone={reading.tone === "failed" ? "frizz-tool-failed" : "text-muted-55"}
                  title={reading.title}
                  label={reading.label}
                  duration={reading.duration}
                  // No indicator, ever. This slot is words only: the liveness mark leads the row and is
                  // the one place the card may claim a child is alive.
                />
              )}
            </>
          )
        }
      >
        {/* The mark leads the row, as it does on the prompt-box lines — and only when there IS one, so a
            resolved card starts flush at its label instead of behind an empty reservation. `-mr-1` pulls
            the label back to roughly the dot↔label gap those lines use: the header's own gap-2 is tuned
            for a petite-caps label beside a path, and at full width a 6px dot floated away from the word
            it qualifies. Same slot, same class, same numbers as a background shell card's mark. */}
        {mark && <span className="frizz-tool-mark -mr-1 flex w-[9px] shrink-0 justify-center">{mark}</span>}
        <span className="petite-caps frizz-bash-label shrink-0">Agent</span>
        {canDrill ? (
          <button
            type="button"
            aria-label={`Open sub-agent transcript: ${title}`}
            // The profile renders in the header now, so this tooltip is back to naming its own action.
            title="Open sub-agent transcript"
            onClick={openDrawer}
            className="min-w-[4rem] flex-1 truncate text-left text-[11.5px] text-muted outline-none hover:underline hover:text-fg/80 focus-visible:underline focus-visible:text-fg/80"
          >
            {title}
          </button>
        ) : (
          <span className="min-w-[4rem] flex-1 truncate text-[11.5px] text-muted" title={title}>{title}</span>
        )}
      </ToolDisclosureHeader>
      <div id={bodyId} hidden={!open}>
        {open && (
          <>
            {body && <pre className={`frizz-bash-body${long && !expanded ? " frizz-bash-clamp" : ""}`}>{body}</pre>}
            {long && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                onMouseDown={(e) => e.preventDefault()}
                className="frizz-bash-expand petite-caps px-2.5 pb-1.5"
              >
                {expanded ? "Collapse" : `Show all ${lineCount} lines`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}

// THE VERB A PEER MESSAGE READS AS — one authority, because two surfaces render it (the parent's
// divider and the drawer's card) and a drift between them would report the same event two ways.
//
// "Steered", not "Sent → <recipient>" (maintainer 2026-07-28). The recipient was rendered as the
// salient token, but a SendMessage to a background agent addresses it by raw agentId — so the most
// prominent thing on the card was a meaningless hash. What the reader needs is the VERB: this turn
// steered another agent.
//
// …except when the recipient is `main`, which INVERTS the direction: that is a background child
// reporting UP to the conversation that dispatched it, so the verb must not claim the child steered its
// own parent. Seen in a sub-agent's drawer, which is exactly where an upward report is read from (the
// chat's report line drills in here), the card read "Steered" for a message the child had sent to its
// dispatcher.
// …and a codex `followup_task` is neither: it QUEUES more work onto an existing sub-agent rather
// than steering the turn in flight, so it gets its own verb instead of borrowing "Steered".
function sendMessageVerb(to: string | undefined, type: string | undefined): string {
  if (type === "shutdown_request") return "Shutdown"
  if (type === "codex_followup") return "Followed up"
  return to === "main" ? "Reported" : "Steered"
}

// WHICH OF THE TWO PEER-MESSAGE RENDERINGS THIS SURFACE GETS.
//
// In a THREAD's chat the maintainer's ruling (2026-07-31) applies: "render 'Steered' or SendMessage
// using the same full width notifications, the horizontal rule style component that we render when an
// agent completes." A steer is the same class of event as a completion or an upward report — a child
// this turn touched reaching a notable state — so it draws the same divider and carries no body.
//
// In the SUB-AGENT DRAWER it must stay the CARD, and that is not an inconsistency — it is the other
// half of the same design. The divider's whole contract is "click the title and read it there": a
// steer's text lands in the child's transcript as an incoming message, and an upward report's text is
// read off the child's own `SendMessage` record, which is exactly this card. Hollowing the card out too
// would leave the message unreadable on every surface. `ThreadSlugContext` is set only on a real
// thread's chat (the drawer deliberately provides ChildDrillSlugContext instead), so it is the honest
// test for which surface this is.
function SendMessageBlock({ to, summary, body, type, dispatchId, targetLabel, status, durationMs, at }: { to?: string; summary?: string; body: string; type?: string; dispatchId?: string; targetLabel?: string; status?: ToolStatus; durationMs?: number; at?: string }) {
  const inThreadChat = useContext(ThreadSlugContext) !== null
  if (inThreadChat) return <SendMessageLine to={to} type={type} dispatchId={dispatchId} targetLabel={targetLabel} at={at} />
  return <SendMessageCard to={to} summary={summary} body={body} type={type} status={status} durationMs={durationMs} />
}

// A SendMessage (peer / agent-to-agent messaging) rendered as a sibling of AgentBlock/BashBlock: the
// SAME quiet bordered card family, but purpose-built to read as "this agent steered that one" rather
// than a generic SendMessage(...) tool line. The header leads with the petite-caps kind label
// ("Steered", or "Shutdown" for a shutdown_request), then the model's one-line `summary` (muted,
// truncated). The
// chevron expands the MESSAGE BODY, rendered as markdown in a quiet indented block (long bodies clamp
// with a "Show all N lines" affordance, exactly like the Bash/Read/Agent bodies). Default state mirrors
// AgentBlock: COLLAPSED when a summary already conveys the gist, OPEN when there's no summary so a
// bodied message isn't hidden behind a chevron showing nothing but the recipient.
//
// This is now the DRAWER-ONLY rendering — see SendMessageBlock for why the thread's own chat draws a
// divider instead, and why this one has to keep its body.
const SEND_MAX_LINES = 16
function SendMessageCard({ to, summary, body, type, status, durationMs }: { to?: string; summary?: string; body: string; type?: string; status?: ToolStatus; durationMs?: number }) {
  const [open, setOpen] = useState(!summary)
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const html = useMarkdownHtml(body)
  const lineCount = useMemo(() => body.split("\n").length, [body])
  const long = lineCount > SEND_MAX_LINES
  const hasBody = !!body.trim()
  const label = sendMessageVerb(to, type)
  return (
    <div className="frizz-bash">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        aria-controls={hasBody ? bodyId : undefined}
        aria-expanded={hasBody ? open : undefined}
        aria-label={`${hasBody ? `${open ? "Collapse" : "Expand"} ` : ""}${label}${to ? ` to ${to}` : ""}`}
        className="frizz-bash-header w-full text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ink-60"
        disabled={!hasBody}
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="petite-caps frizz-bash-label shrink-0">{label}</span>
          {summary && <span className="min-w-0 truncate text-[11.5px] text-muted">{summary}</span>}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <ToolStatusMeta status={status} durationMs={durationMs} />
          {hasBody && <ChevronRight aria-hidden="true" size={12} className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />}
        </span>
      </button>
      {hasBody && (
        <div id={bodyId} hidden={!open}>
          {open && (
            <>
              {/* Quiet indented body: the border-top + 10px/8px padding mirror .frizz-bash-body, but the
                  content is MARKDOWN (md-body — sans, 14px) so a peer message reads like prose, not a code
                  dump — through LinkedHtml, so a gallery or a diagram in it is drawn as one. The clamp caps
                  a long body at ~320px until "Show all" expands it. */}
              <div className={`border-t border-border px-2.5 py-2${long && !expanded ? " frizz-bash-clamp" : ""}`}>
                <LinkedHtml className="md-body" html={html} />
              </div>
              {long && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  onMouseDown={(e) => e.preventDefault()}
                  className="frizz-bash-expand petite-caps px-2.5 pb-1.5"
                >
                  {expanded ? "Collapse" : `Show all ${lineCount} lines`}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// The user chat bubble, right-justified — plain and uncapped. Its own component so the unqueue /
// deliver-now hooks stay out of memoized Message.
// A sent message that carries ⌘I selected context (lib/composerContext.ts — inline `@file:line`
// references over definitions) renders as the HUMAN COMPOSED IT: the prose with a chip at each
// reference, and the definitions dump hidden behind them. The serialized text underneath is untouched
// — this is presentation over the same bytes the worker read (maintainer 2026-09-02: "The chip should
// also render as a chip once I hit Enter"). Clicking a chip unfolds that item's quote (and comment)
// under the prose; clicking again, or another chip, folds it. Everything stops propagation because
// the QUEUED bubble is itself a click target (click-to-unqueue).
function SentContextBody({ body, items }: { body: string; items: SentContextItem[] }) {
  const [open, setOpen] = useState<string | null>(null)
  const byToken = useMemo(() => new Map(items.map((item) => [item.token, item])), [items])
  const openItem = open === null ? undefined : byToken.get(open)
  // The same splitter the composer's backdrop uses, over the DEFINED tokens only — a `@thing` with
  // no definition (one the human typed by hand) stays plain text.
  const runs = useMemo(() => splitProseByTokens(body, [...byToken.keys()]), [body, byToken])
  return (
    <>
      {runs.map((run, i) => {
        const item = run.token ? byToken.get(run.token) : undefined
        if (!item) return <LinkifiedText key={i} text={run.text} />
        const isOpen = open === item.token
        return (
          <button
            key={i}
            type="button"
            title={item.display}
            aria-expanded={isOpen}
            onClick={(e) => {
              e.stopPropagation()
              setOpen(isOpen ? null : item.token)
            }}
            onKeyDown={(e) => e.stopPropagation()}
            // Baseline-aligned so the chip reads as part of the sentence; the dark-on-light tints are
            // this bubble's own (the bubble is the one LIGHT surface in the transcript, so the
            // panel/border tokens the dark chips use elsewhere would vanish here).
            className={`inline-flex max-w-56 items-baseline rounded border px-1 align-baseline font-mono-keep text-[11px] leading-snug transition-colors ${
              isOpen ? "border-bg/40 bg-bg/15" : "border-bg/25 bg-bg/[0.08] hover:bg-bg/15"
            }`}
          >
            <span className="truncate">{tokenLabel(item.token)}</span>
          </button>
        )
      })}
      {openItem && (
        <span className="mt-2 block cursor-auto rounded-md border border-bg/20 bg-bg/[0.06] px-2 py-1.5" onClick={(e) => e.stopPropagation()}>
          <span className="block truncate font-mono-keep text-[11px] text-user-bubble-fg/60">{openItem.display}{openItem.startLine !== undefined ? ` · ${openItem.startLine === openItem.endLine ? `line ${openItem.startLine}` : `lines ${openItem.startLine}-${openItem.endLine}`}` : ""}</span>
          <span className="mt-1 block max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono-keep text-[11.5px] leading-4 text-user-bubble-fg/80">{openItem.text}</span>
        </span>
      )}
    </>
  )
}

// A FAILED SEND's row, under its bubble: why it failed, then the operator's three ways out (see
// lib/failedDelivery.ts for what each does and why none of them is automatic). Its own component so the
// hooks behind the actions — one of which reads the board snapshot — mount only for a failed bubble,
// never for every user bubble in the transcript.
//
// The actions need a thread to act on, so they render only inside ThreadSlugContext — the same
// authorization boundary unqueue uses. Without one (a sub-agent's transcript) the error still shows.
function FailedSendRow({ deliveryId, text, rawText, error }: { deliveryId: string; text: string; rawText: string; error?: string }) {
  const slug = useContext(ThreadSlugContext)
  const { retry, edit, dismiss, pending } = useFailedDeliveryActions(slug)
  const button = "rounded-md border border-border-strong bg-panel-2/60 px-2.5 py-1 text-[12px] font-medium text-fg/80 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60 disabled:opacity-45 disabled:hover:bg-panel-2/60 disabled:hover:text-fg/80"
  return (
    <div data-failed-send={deliveryId} className="mt-1 flex flex-col items-end gap-1.5">
      {/* LEFT-aligned inside a right-justified column: a short error hugs the bubble's right edge like
          any one-liner here, and a long one fills the bubble's width as an ordinary paragraph instead of
          a ragged-left block. */}
      <div role="alert" className="text-left text-[12px] leading-snug text-danger-soft [overflow-wrap:anywhere]">
        {/* The first line only: the server already trims, and this keeps an older row's stack trace off
            the screen too. */}
        Not delivered{error ? ` — ${error.split("\n", 1)[0]}` : ""}
      </div>
      {slug && (
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className={button}
            disabled={pending}
            title="Send this message again"
            onClick={() => retry({ deliveryId, text: rawText })}
          >
            Retry
          </button>
          <button
            type="button"
            className={button}
            disabled={pending}
            title="Put this message back in the prompt box"
            onClick={(e) => edit({ deliveryId, text, from: e.currentTarget })}
          >
            Edit
          </button>
          <button
            type="button"
            className={button}
            disabled={pending}
            title="Discard this message"
            onClick={() => dismiss({ deliveryId })}
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}

// SEND THE QUEUE NOW — one control under the queued messages, always visible, for all of them at once
// (maintainer 2026-10-15: "we definitely don't need the Send Now button under every one of the messages
// . it applies to all three"). It replaced two things: a ↑ that grew beside whichever queued bubble was
// under the pointer, though it always sent the whole queue, and the "Queued until the agent rests ·
// Send now · Take back" line under a message sent to the queue. The maintainer picked it from six drawn
// candidates (queued-send-now-mockup-fixture, B) and dropped the line's status words with it. A message
// still takes itself back on a click, which its hover lift offers.
//
// It means STOP WAITING, one step at a time. The next message Frizz is holding for the rest goes to the
// agent's next step without interrupting it (deliverQueuedNow `releaseOnly`) — ONE per press, as the
// queue goes out one message per turn (2026-10-20); once nothing is held, a press pushes the queue
// through now, and the runtime moves a running command to the background or cuts the turn (router
// deliverQueuedNow). So a held run takes a press per held message, and one more to interrupt.
//
// ⌘⏎ PRESSES IT whenever nothing is typed (lib/sendNowKey), and it wears that chord on a flat keycap to
// the left of its words, where an arrow stood until 2026-10-19. The maintainer chose the cap from
// fourteen drawn candidates over three rounds (send-now-shortcut-mockup-fixture, O): an outline cap,
// left of the words, whose glyphs turn white and hairline grey with the words on hover, on a 50ms fade
// ("the transition time needs to be much faster" than the 150ms default). The cap is `.send-now-key`
// (styles.css).
//
// It carries its own leading spacer and draws nothing when there is nothing it can do, so a surface
// mounts it under its queued tail unconditionally.
export function QueuedSendNow() {
  const slug = useContext(ThreadSlugContext)
  const run = useContext(QueuedRunContext)
  const interruptible = useDeliverQueuedNowSupported(slug)
  const pending = useSendNowPending(slug)
  if (!slug || !run) return null
  const step = sendNowStep(run, interruptible)
  if (!step) return null
  // A release hands over one held message, the next; with more held behind it the words say which.
  const releaseTitle = run.held > 1 ? "Send the next one now — the agent reads it at its next step" : "Send it now — the agent reads it at its next step"
  return (
    <>
      <VSpace h={HUMAN_RUN_STEP} />
      <div data-queued-send-now={step} className="flex items-baseline justify-end text-[11.5px] leading-[16px] text-muted">
        <button
          type="button"
          data-send-now
          // Same as every submit affordance beside a live input: never blur on the click path.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => pressSendNow(slug, run)}
          disabled={pending}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          title={`${step === "release"
            ? releaseTitle
            : "Send now — the worker reads the queue immediately, and a command it is running carries on in the background"} (⌘⏎)`}
          // THE HAND REACHES PAST THE INK. The button's box is its ink edge to edge — the keycap's left
          // border to the end of "now", on a 16px line of 11.5px words — so a pointer a hair off either
          // end read as the plain arrow (maintainer 2026-10-20: "Send now isn't cursor-pointer"). The
          // `before:` box is an invisible hit halo, 8px either side and 4px above and below (the run's
          // 6px pitch still separates it from the last bubble), and as a positioned pseudo-element it
          // moves nothing. The pointer is declared here as well as by the global button rule.
          className="relative flex cursor-pointer items-baseline outline-none transition-colors duration-50 before:absolute before:-inset-x-2 before:-inset-y-1 before:content-[''] hover:text-fg focus-visible:text-fg disabled:cursor-default disabled:opacity-50"
        >
          {pending ? (
            // The spinner takes the cap's place while the press is in flight, at the arrow's old 1em size
            // and cap-band lift, and the words keep their place.
            <Loader2 aria-hidden className="mr-1 size-[1em] shrink-0 self-baseline translate-y-[calc(0.5em_-_0.5cap)] animate-spin" strokeWidth={2.4} />
          ) : (
            // An INLINE <kbd> in a plain wrapper: a flex item is blockified, and a block ignores the
            // vertical-align that sets the cap on the words' cap band.
            <span aria-hidden className="mr-[0.44em] shrink-0">
              <kbd className="send-now-key">⌘⏎</kbd>
            </span>
          )}
          <span className="underline decoration-border underline-offset-2">Send now</span>
        </button>
      </div>
    </>
  )
}

// ANSWERS SENT WITH A NOTE — the prompt box's one Send (2026-10-11) carries the staged answers and the
// typed message as one turn, and it reads as one: the Answers card, and the human's words in their own
// bubble under it. The note of a message that answered both registered and fenced questions is itself
// an answers message (the fenced ones, composed in the browser), so it draws the same way, recursively.
function AnswersWithNote({ m, answers, note }: { m: ChatMessage; answers: PairedAnswer[]; note: string }) {
  const body = (noteText: string, depth: number): ReactNode => {
    if (!noteText) return null
    const inner = depth < 2 ? parseAnswersCard(noteText) : null
    if (inner) return <>{<AnswersCard answers={inner} queued={m.queued} />}{body(answersNote(noteText), depth + 1)}</>
    // No deliveryId: the bubble is half of a send, and taking back half of it is not a thing.
    return <UserBubble text={noteText} rawText={m.text} queued={m.queued} />
  }
  return (
    // Full width and a column, so each child's own `self-end` + 85% cap lands exactly where it would
    // as a direct child of the transcript column.
    <div data-frizz-msg={m.sourceId} data-answers-with-note className="flex w-full flex-col gap-2 self-end">
      <AnswersCard answers={answers} queued={m.queued} />
      {body(note, 0)}
    </div>
  )
}

function UserBubble({ text, rawText, queued, held, deliveryUnconfirmed, deliveryFailed, deliveryError, deliveryId, sourceId }: { text: string; rawText?: string; queued?: boolean; held?: boolean; deliveryUnconfirmed?: boolean; deliveryFailed?: boolean; deliveryError?: string; deliveryId?: string; sourceId?: string }) {
  // TAKE IT BACK. A still-queued send is the one bubble in the transcript that isn't history yet, so
  // it alone is clickable: the click unqueues it at the provider and hands the words back to the
  // prompt box (see lib/unqueueFollowUp.ts). Three gates, all of them load-bearing:
  //  · ThreadSlugContext — the same authorization boundary the fence-card buttons use. A queued bubble
  //    rendered inside a SUB-AGENT's transcript is not this surface's to retract.
  //  · deliveryId — the provider queued the message under that uuid; without it there is nothing to
  //    address, which is exactly the case for a bubble frizz did not send (one typed in the terminal).
  //  · the backend — a codex steer has no queue to take anything out of.
  const unqueueSlug = useContext(ThreadSlugContext)
  const unqueueSupported = useUnqueueSupported(unqueueSlug)
  const { unqueue, pending: unqueuePending } = useUnqueueFollowUp(unqueueSlug)
  // A HELD message (sent to the queue) is Frizz's alone to hand back, on every backend: no provider
  // has it.
  const unqueueable = Boolean(queued && deliveryId && unqueueSlug && (unqueueSupported || held))
  // The other half of what can be done to a message that hasn't been read yet — stop waiting for it —
  // is the queue's, not this bubble's: one Send now under the whole run (QueuedSendNow).
  // The composer parks attached files in the draft as TRAILING standalone absolute-path lines
  // (joinComposerValue) and presents them as chips — so a sent message carries those paths as text, and
  // this bubble reprinted the screenshot the human had just attached as a wall of mono path. Peel them
  // back off and render the picture. splitComposerValue is that append's exact inverse: it takes only
  // the trailing run, so a path typed mid-sentence stays the human's own words, and (unlike
  // splitProseAttachments, the agent-prose splitter) it never swallows a ::directive or mermaid line.
  // `text` itself stays whole for the unqueue payload below — restoreDraft must hand the paths back.
  const { prose, attachments } = useMemo(() => splitComposerValue(text), [text])
  // ⌘I selected context, recovered from the serialization the composer sent. Null for everything
  // else — including pre-footnote-era sends, which keep their plain-text rendering.
  const sentContext = useMemo(() => parseSentContext(prose), [prose])
  return (
    // `self-end` must stay on THIS node: the parent scroll container is a flex column and the bubble's
    // right-justification depends on being its direct child (see the group-container note above the
    // queued-message stack).
    <div data-frizz-msg={sourceId} className="self-end flex flex-col items-end gap-0.5 max-w-[85%]">
      {/* OFF-WHITE bubble, BLACK text — the human's words POP against the dark page + agent prose. bg-user-bubble
          is a tick less white than bg-fg so it reads as a card. whitespace-pre-wrap is load-bearing: user text
          is verbatim, so its line breaks must survive. Skipped entirely for an attachment-only send, so the
          picture stands on its own instead of hanging under an empty gray pill. */}
      {prose.trim() !== "" && (
        <div
          {...(unqueueable ? {
            role: "button",
            tabIndex: 0,
            "data-unqueue": deliveryId,
            "aria-label": "Unqueue this message and put it back in the prompt box",
            title: unqueuePending ? "Taking it back…" : undefined,
            onClick: (e: ReactMouseEvent<HTMLDivElement>) => unqueue({ deliveryId: deliveryId!, text, rawText: rawText ?? text, from: e.currentTarget }),
            onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
              if (e.key !== "Enter" && e.key !== " ") return
              e.preventDefault()
              unqueue({ deliveryId: deliveryId!, text, rawText: rawText ?? text, from: e.currentTarget })
            },
          } : {})}
          // A retractable bubble LIFTS to FULL opacity under the pointer — so the one message in the
          // transcript that is still yours to change says so on hover instead of needing a permanent
          // control that would clutter every send. Opacity alone carries it, because opacity is already
          // the channel encoding "queued" and coming back to solid is exactly the state being offered.
          // NO hover ring: an accent outline laid directly on this warm off-white card read as a muddy
          // olive (accent yellow at 60% blending into #d5d7da), and a hover ring is a shape nothing else
          // in the app uses. A KEYBOARD focus ring still has to exist, so it keeps the accent — but
          // OFFSET onto the near-black page, which is the only place this yellow reads clean and is how
          // every other focus ring in the app is drawn.
          className={`relative ${BLOCK_RADIUS} rounded-br-sm bg-user-bubble px-3.5 py-3 text-[14px] whitespace-pre-wrap [overflow-wrap:anywhere] text-user-bubble-fg ${queued || deliveryFailed ? "opacity-50" : ""} ${unqueueable ? "cursor-pointer transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg" : ""} ${unqueuePending ? "!opacity-30" : ""}`}
        >
          {/* Verbatim bytes, but link-shaped runs (a pasted URL, `#123`, a commit hash) render as the
              anchors they would be in agent prose — see LinkifiedText. The anchors stop their own
              click/keydown propagation, so a link inside a QUEUED bubble opens instead of unqueueing.
              A message carrying ⌘I context renders its references as chips instead (SentContextBody);
              the unqueue payload above stays the whole serialized text either way. */}
          {sentContext ? <SentContextBody body={sentContext.body} items={sentContext.items} /> : <LinkifiedText text={prose} />}
        </div>
      )}
      {/* Below the words, mirroring the composer (prose in the textarea, chips along its bottom edge) —
          and OUTSIDE the bubble, on the dark page, so BlockImage/BlockFile carry their normal styling
          instead of a light-bubble fork, and so the delegated open-local-file click can't collide with a
          queued bubble's click-to-unqueue. No basename caption under a picture: it is the name of the
          file the human just dropped, which they already know, and a failed load falls back to the path
          text anyway. */}
      {attachments.length > 0 && (
        <div className="mt-1 flex flex-col items-end gap-1.5">
          {attachments.filter((a) => a.kind === "image").map((a, i) => <BlockImage key={`i${i}-${a.path}`} path={a.path} hideCaption />)}
          {/* Docs share one WRAPPING row (mirroring SentFilesCard) — a column would spend a whole line
              on each pill. `justify-end` keeps the run flush with the bubble's right edge. */}
          {attachments.some((a) => a.kind === "file") && (
            <div className="flex flex-wrap justify-end gap-1.5">
              {attachments.filter((a) => a.kind === "file").map((a, i) => <BlockFile key={`f${i}-${a.path}`} path={a.path} />)}
            </div>
          )}
        </div>
      )}
      {/* Delivery-ledger verdict: no JSONL evidence within the confirmation window — the send likely
          mutated or never reached the agent. Quiet one-liner (not a modal): re-sending is the recovery,
          and the bubble stays gray so the send is still legible above it. This used to read "check the
          terminal", from when a worker sat in a pane an operator could open; there is no such surface
          now, so it states the fact and leaves the next move to them. */}
      {deliveryUnconfirmed && (
        <div className="text-[11px] text-attention-80">Delivery unconfirmed — no receipt from the worker</div>
      )}
      {deliveryFailed && deliveryId && (
        <FailedSendRow deliveryId={deliveryId} text={text} rawText={rawText ?? text} error={deliveryError} />
      )}
      {/* No "click to unqueue" hint: the hover lift above already says the bubble is live, and a
          label spelling that out is noise on every queued send. Only the IN-FLIGHT retraction gets a
          line, because "did my click land?" isn't something the hover state can answer. It reserves no
          layout of its own (`h-0` + overflow) — a line that appeared under the bubble would nudge every
          row below it, the same layout shift that got the old permanent "queued" tag deleted. */}
      {unqueueable && unqueuePending && (
        <div aria-hidden className="h-0 overflow-visible text-[11px] text-muted">Taking it back…</div>
      )}
    </div>
  )
}

// A TRANSCRIPT MESSAGE ON A THREAD SURFACE — `Message`, handed everything its thread says about it.
// The queue card and both of the thread view's columns draw a message through this, and it takes only
// what a LAYOUT decides (`dense`, `textOnly`, `showSendButton`) plus the message's index in the surface's
// list. Which fence is settled, which registered question the message carries or restates, which answers
// it pairs with and whether its fenced questions are answerable all come from the surface
// (ThreadSurface.tsx ThreadTranscript). Each of those was a prop every call site had to remember — four
// sites in two files, kept alike by tests that grepped each one for the same line — and a prop one site
// forgot was a behaviour one surface silently lacked.
//
// `Message` itself stays the component for a message that is NOT a thread's own transcript row: the
// sub-agent sheet's, and a queued bubble, which is the human's unsent words and carries none of this.
export function ThreadMessage({ m, index, dense, textOnly, showSendButton }: { m: ChatMessage; index: number; dense?: boolean; textOnly?: boolean; showSendButton?: boolean }) {
  const t = useThreadTranscript()
  const [staleAwaiting, restingCardShown] = t.hidesAwaiting(index)
  return (
    <Message
      m={m}
      dense={dense}
      textOnly={textOnly}
      showSendButton={showSendButton}
      answering={t.fencesLive ? t.answeringForMessage(m) : undefined}
      paired={t.paired[index]}
      staleAwaiting={staleAwaiting}
      restingCardShown={restingCardShown}
      stepsDone={t.stepsDone.has(index)}
      shadowedBy={t.shadowedByMessage.get(index)}
      placed={t.placement.placed.get(index)}
      settledPlaced={t.settledPlacement.placed.get(index)}
      fenceQuestions={t.fenceQuestions}
      thread={t.thread}
    />
  )
}

// Exported so the Queue card reuses the exact same message rendering (user bubble right, agent prose
// left, compact tool lines) — no duplicate renderer. `answering` (Queue-only, for the live message)
// makes each ```question block answerable in place; without it the blocks render read-only.
//
// MEMOIZED (the render-perf thread's chip-click fix): a queue card re-renders on EVERY chip click /
// composer keystroke (answer + draft state live at card level) and on every board delta (TodosView's
// snapshot scope), and each such render used to re-run every visible Message's whole subtree —
// markdown/diff/tool cards included. Props are memo-friendly by construction: `m` keeps identity for
// unchanged messages (TanStack Query's structural sharing on both the poll and socket write paths),
// `answering` is undefined for all but the live message (and identity-stable via useLiveAnswering's
// useMemo unless answers/blocks actually changed), `dense` is a constant. So only the message whose
// inputs really changed re-renders; everything else bails out at the memo boundary.
// `paired` is the precomputed question↔answer pairing for a composed-answer user message (see
// pairAllAnswers — computed at the LIST level because the lookback needs the whole message list, which
// a per-message component deliberately doesn't get). Memo-friendly by construction: it's null (a stable
// primitive) for every ordinary message, so only actual answers-messages ever see a prop change.
// undefined (a consumer that doesn't precompute, e.g. the sub-agent sheet) → internal unpaired fallback.
// Lifecycle controls never belong to a transcript message: every Done card stays presentation-only,
// while the owning thread surface renders one stable footer.
// `shadowedBy` is the registered questions standing at this message's REST (lib/questionShadow), so a
// ```question fence that merely restates one of them never draws its own card — the REGISTERED card is
// the one the human answers, because answering it settles the row. Undefined for every message at a rest
// with no registration, which keeps the memo boundary intact.
// `restingCardShown` — the resting card at the transcript's tail is stating THIS message's ```awaiting
// fence (showsRestingCard on the owning thread), so the fence block is skipped here exactly as a settled
// one is. It has to be a skip at this level and not a null from FenceCard: the block list is interleaved
// with explicit spacers, and a card that renders null still spent one — a 14px gap dangling under the
// prose, above the resting card (maintainer 2026-08-28, with a screenshot of the gap). Only the last
// agent message ever carries it, so the memo boundary holds for every other row.
// `fenceQuestions` — EVERY registered row the thread knows, open and answered — present exactly when the
// thread speaks THE QUESTION FENCE (dispatched after QUESTION_FENCE_RETIRED_AT; useFenceQuestions). Its
// presence switches the splitter to that grammar, and a fence's `id:` resolves against it: a row placed
// here draws in the fence's slot, a row drawn elsewhere draws nothing here, and an ask that names no row
// yet draws read-only from its own bytes. One array per surface, memoized, so the memo boundary holds.
// `stepsDone` — the human answered this message's rest on steps with the "I have completed this" box
// (lib/stepsAnswer stepsDoneReplies), so its settled steps card keeps the box, ticked. A boolean, false
// on every other row.
type MessageProps = { m: ChatMessage; answering?: MessageAnswering; dense?: boolean; paired?: PairedAnswer[] | null; textOnly?: boolean; showSendButton?: boolean; staleAwaiting?: boolean; shadowedBy?: readonly RegisteredQuestionView[]; placed?: readonly RegisteredQuestionView[]; settledPlaced?: readonly SettledQuestion[]; fenceQuestions?: readonly FenceQuestionRow[]; thread?: ThreadViewData; restingCardShown?: boolean; stepsDone?: boolean }
// EVERY MESSAGE SAYS WHEN IT WAS SAID ON HOVER — `Today at 8:33 AM` as the browser's own tooltip
// (lib/messageTime). Here, around every branch of the body, so a bubble, a prose turn, a tool run and a
// hairline all carry it on every surface, the sub-agent sheet's included. `contents` keeps the wrapper
// out of layout: the body's root is still the flex item its row lays out. A `title` on anything inside
// (a divider's quoted title, a link) is nearer the pointer and wins there. A queued bubble has not been
// said yet and carries none.
export const Message = memo(function Message(props: MessageProps) {
  const stamp = props.m.queued ? null : messageStamp(props.m.at)
  return (
    <div title={stamp ?? undefined} className="contents">
      <MessageBody {...props} />
    </div>
  )
})
function MessageBody({ m, answering, dense, paired, textOnly, showSendButton, staleAwaiting, shadowedBy, placed, settledPlaced, fenceQuestions, thread, restingCardShown, stepsDone }: MessageProps) {
  // ANSWERING ON A PHONE happens in a sheet, one question at a time (MobileAnswerSheet) — the cards in
  // the transcript stay READ-ONLY there, so the questions are still visible in the context that
  // produced them but a 44pt-thumb answer never has to land on a 24pt chip inside a scrolling message.
  const isMobile = useIsMobile()
  const [answerSheetOpen, setAnswerSheetOpen] = useState(false)
  // The surface's prompt box sends the staged answers (lib/sendScope), so this message draws no Send
  // of its own. False wherever no prompt box is mounted — a sub-agent's sheet, a phone thread page.
  const promptBoxSends = usePromptBoxSends()
  // An event line (a sub-agent completion) is transcript PUNCTUATION — a quiet full-width line, not a
  // bubble or a tool band. Rendered before the role branches (its role field is nominal).
  if (m.providerError) return <ProviderErrorCard error={m.providerError} />
  if (m.kind === "event") return <EventLine text={m.text} boundary={m.boundary} sourceId={m.sourceId} at={m.at} />
  // A model-reasoning summary (Codex) — quiet punctuation like an event line, but CLICKABLE to expand
  // the full reasoning. Rendered before the role branches (its role field is nominal, like an event).
  if (m.kind === "reasoning") return <ReasoningBlock text={m.text} sourceId={m.sourceId} />
  // A SUB-AGENT COMPLETION — the same class of event as the background-shell wake above, so it takes
  // the same divider (see AgentCompletionLine). Routed here, before the tool-band walk, so the marker
  // copy never renders as a second AgentBlock card. Ahead of `textOnly` for the same reason the event
  // line is: a queue card that hides tool bands still shows what came back underneath it.
  const completion = agentCompletionCall(m)
  if (completion) return <AgentCompletionLine call={completion} sourceId={m.sourceId} at={m.at} />
  // User messages: right-justified chat bubble; agent output stays left-aligned prose. A follow-up
  // that's been sent but not yet echoed by the transcript shows as a grayed-out bubble — the dimming
  // alone signals queued (a "queued" tag under the bubble caused layout shift when it cleared).
  if (m.role === "user") {
    // CR/CRLF → LF: a terminal-injected follow-up round-trips carriage-return-separated, and the pre-wrap
    // bubble honors \n but not a lone \r → the breaks collapse into a run-on. Normalize for BOTH render
    // paths (the server does this too, but this is the definitive per-surface guarantee for user text).
    const text = messagePresentationText(m).replace(/\r\n?/g, "\n")
    // OUR OWN composed multi-block answer — either wire form ("Answers:\n1. …\n2. …" for the live ask,
    // "Answers to earlier questions:\n1. “Q” → A" for a buried one, both from useLiveAnswering.sendAnswers)
    // renders as a structured answers card echoing the question component — not a flat run-on bubble.
    // Non-matching text (and a parse hiccup → null) falls back to the plain bubble; text is never lost.
    const answers = paired !== undefined ? paired : parseAnswersCard(text)
    // …unless it FAILED: the answers card has no failure row, and a failed send must always show its
    // Retry / Edit / Dismiss (lib/failedDelivery.ts). The plain bubble carries the same words.
    if (answers && m.deliveryState !== "failed") {
      const note = answersNote(text)
      if (!note && m.deliveryState !== "held") return <AnswersCard answers={answers} queued={m.queued} sourceId={m.sourceId} />
      return <AnswersWithNote m={m} answers={answers} note={note} />
    }
    // A scheduler wake is recorded as a user turn because it is pasted into the worker's composer —
    // but FRIZZ wrote it, not the human, so it must not wear the human's off-white right-justified
    // bubble. `m.wake` is the server's own tell (the delivery token it stripped), never a text guess.
    // FrizzWake routes every one of them, the Goal's repeating prompt included: that used to be picked
    // off here, ahead of it, and a delivery carrying SEVERAL wakes has to be cut apart before any single
    // wake's parser is allowed to read it.
    if (m.wake) return <FrizzWake steer={m.wakeSteer} text={text} sourceId={m.sourceId} at={m.at} wrap={dense} />
    // A SIDEWAYS writer of a user turn the human didn't type: another top-level thread messaging this
    // one. An expandable hairline naming and linking the sender — see SessionMessageLine.
    if (m.sessionPeer) return <SessionMessageLine peer={m.sessionPeer} text={text} queued={m.queued} sourceId={m.sourceId} at={m.at} wrap={dense} />
    // …and the same correction for the OTHER writer of a user turn the human didn't type: a background
    // sub-agent pushing a report up to its parent through `SendMessage({to:"main"})`. `m.peerFrom` is the
    // server's own tell (it parsed the <agent-message> wrapper and put the body in displayText, which
    // `text` above already carries), never a text guess made here. It renders as a wake divider rather
    // than any kind of bubble — see SubAgentReportLine.
    if (m.peerFrom) return <SubAgentReportLine from={m.peerFrom} unnamed={m.peerUnnamed} dispatchId={m.peerDispatchId} sourceId={m.sourceId} at={m.at} />
    // `rawText` rides alongside the presentation text because the two differ: the bubble shows the
    // stripped/normalized copy, while the optimistic cache entry an unqueue has to evict is keyed on
    // the message's own raw text.
    return <UserBubble text={text} rawText={m.text} queued={m.queued} held={m.deliveryState === "held"} deliveryUnconfirmed={m.deliveryState === "unconfirmed"} deliveryFailed={m.deliveryState === "failed"} deliveryError={m.deliveryError} deliveryId={m.deliveryId} sourceId={m.sourceId} />
  }

  // Build ONE ordered list of block-level children, then interleave with explicit spacers. The
  // FIDELITY invariant: visual order == turn order. We render `m.parts` in block order — a "Let me
  // draft the notes:" text lead-in sits directly above the tool band it introduces, never hoisted
  // above earlier prose. A question-block index (`qi`) threads across all text parts so the answering
  // controller (which numbers ```question blocks over the flat text, same order) lines up.
  const blocks: ReactNode[] = []
  // Runs PARALLEL to `blocks`: which of each block's own edges is a rendered PICTURE, so a tool band
  // that BEGINS or ENDS on one takes PICTURE_STEP against the block beside it rather than the STEP.
  //
  // Only a tool CARD counts. A picture a worker writes into its own prose — as a bare absolute path
  // (BlockImage, below) or as Markdown `![](…)` (inside ProseHtml, where the prose body's own
  // paragraph margin spaces it) — is part of the sentence that introduces it, and keeps the prose
  // rhythm. Those two spellings must render as ONE object (see ImageFrame), so neither may move alone:
  // the Markdown one lives in CSS and the bare path in this list, and giving the bare path the picture
  // step put 22px under one frame and 14px under the identical frame two paragraphs down.
  const pictureEdges: PictureEdges[] = []
  const push = (node: ReactNode, edges: PictureEdges = NO_PICTURE) => {
    blocks.push(node)
    pictureEdges.push(edges)
  }
  const qi = { n: -1 }
  // THIS message's open question blocks, in the order the answering controller numbers them. Only
  // populated when the message actually has a controller (i.e. its ask is still open).
  const askBlocks: { raw: string; kind: QuestionKind; danger: boolean; bi: number }[] = []
  // The placed registered cards this message has already drawn (one per id, see the marker branch).
  const placedDrawn = new Set<string>()
  // The parents this message's `when:` follow-ups claim from an earlier message — read over the WHOLE
  // message, as the placement is (lib/questionShadow placeQuestions), and only once a follow-up asks.
  let claimedParents: Set<string> | undefined
  const followUpParents = () => (claimedParents ??= new Set(followUpParentsIn(m.text, m.refusedFences)))
  const renderText = (text: string, keyBase: string) => {
    // Split SIGNAL fences (```done / ```awaiting) out first — each renders as a card in place of the
    // raw block — then run the remaining prose runs through the question/image pipeline. Fences never
    // contain a ```question block, so the question-block index (qi) still lines up with the answering
    // controller (which numbers ```question blocks over the flat text in the same order).
    for (const [fi, fseg] of splitFenceBlocks(text).entries()) {
      if (fseg.kind === "fence") {
        // AN ```awaiting FENCE THAT IS NOT A LIVE WAIT DRAWS NOTHING AT ALL — not the card, and not its
        // prose either. Skipped here rather than returned as null from the card, so the block list never
        // carries an empty slot and the spacer either side of it collapses with it.
        //
        // REFUSED — frizz declined to arm the park (see TranscriptMessage.fenceRefused), so a card would
        // assert a wait nothing is holding, and the body is a handoff the worker is about to write again
        // in its re-fence.
        //
        // SETTLED — the worker has spoken since, so whatever the fence named came back or was given up on
        // (maintainer 2026-08-17: "we should only render an awaiting card that is still being waited on at
        // the bottom of a chat"; a thread that rested thirty times had painted thirty live-looking waits).
        // The chrome came off then and the PROSE stayed, on the reasoning that it was the worker's handoff
        // rather than chrome. Free-standing it reads as an orphan — a paragraph mid-transcript with nothing
        // left to say what it was — and two passes at styling it only moved the complaint from "why is it
        // grey" to "why is it here". So the whole block goes (maintainer 2026-08-24, choosing that over a
        // past-tense card): by nature an awaiting card is never settled, and a wait that is over is not a
        // card and not a message either.
        //
        // `done` is neither: a finished thread stays finished, and its card is the thread's own outcome.
        //
        // STATED BY THE RESTING CARD — the third skip. A live fence whose thread is at rest on it is drawn
        // by the resting card at the tail (AwaitingBackgroundCard opens on this very body), so this block
        // goes too, for the spacer reason above: FenceCard returning null would still leave its slot's
        // spacer standing between the prose and that card.
        //
        // EXCEPT A SETTLED FENCE THAT HANDED THE HUMAN STEPS (2026-10-08, maintainer: "We need to continue
        // showing the to do instructions even after they are complete & the thread has moved on"). Its
        // steps are a record of what the human DID — the sign-in, the approval — not a wait, and its card
        // is the only place they were ever written down. So it keeps the card, stated with no thread: no
        // live rows, and no Done (nobody is waiting on these steps any more, and a later fence restating
        // the same steps must not grow a second verb). A refused fence still goes — its re-fence restates it.
        // When the human's reply was the box's, the box stays, ticked and inert (`stepsDone`).
        if (fseg.fenceKind === "awaiting" && staleAwaiting && !m.fenceRefused && !restingCardShown && settledFenceDraws(fseg.hints)) {
          push(<AwaitingBackgroundCard key={`${keyBase}-f${fi}`} fence={{ body: fseg.body, hints: fseg.hints }} stepsDone={stepsDone} />)
          continue
        }
        if (fseg.fenceKind === "awaiting" && (m.fenceRefused || staleAwaiting || restingCardShown)) continue
        // A FENCE THAT NAMES QUESTIONS DRAWS NO CARD — the question cards after this rest are its ending
        // (lib/awaitingPresentation awaitingDefersToQuestions). Its prose is the worker's handoff, so it
        // stays, as the message's own text.
        if (fseg.fenceKind === "awaiting" && awaitingDefersToQuestions(fseg.hints)) {
          const prose = awaitingProseBlock(fseg.body)
          if (prose) push(<ProseHtml key={`${keyBase}-f${fi}`} md={prose} wrap={dense} />)
          continue
        }
        push(
          <FenceCard
            key={`${keyBase}-f${fi}`}
            fenceKind={fseg.fenceKind}
            body={fseg.body}
            hints={fseg.hints}
            wrap={dense}
            pastRest={staleAwaiting}
          />,
        )
        continue
      }
      // A fence the server REFUSED comes back as prose here (`m.refusedFences`, lib/questionFaults): the
      // code block it is, never a card and never a claim on the card of the row its id happens to name.
      for (const [si, seg] of splitMessageQuestions(fseg.text, fenceQuestions !== undefined, m.refusedFences).entries()) {
        if (seg.kind === "prose") {
          for (const [j, p] of splitProseAttachments(seg.text).entries()) {
            const partKey = `${keyBase}-${fi}-p${si}-${j}`
            push(
              p.kind === "image" ? <BlockImage key={partKey} path={p.path} />
              : p.kind === "file" ? <BlockFile key={partKey} path={p.path} />
              : p.kind === "visualization" ? <InlineVisualization key={partKey} file={p.file} />
              : p.kind === "directive" ? <CodexDirectiveCard key={partKey} directive={p.directive} />
              : p.kind === "mermaid" ? <MermaidDiagram key={partKey} source={p.source} />
              : p.kind === "lightbox" ? <LightboxGallery key={partKey} entries={p.entries} />
              : <ProseHtml key={partKey} md={p.text} wrap={dense} />,
            )
          }
          continue
        }
        // …except a refused `id:`-only REFERENCE, which says what it pointed at instead.
        if (seg.kind === "refusedRef") {
          const closed = resolveQuestionName(seg.id, fenceQuestions ?? [])?.closed
          push(<RefusedQuestionReference key={`${keyBase}-${fi}-r${si}`} id={seg.id} closed={closed} />)
          continue
        }
        qi.n += 1
        const bi = qi.n
        // A QUESTION FENCE (lib/questionBlocks splitMessageQuestions) — its `id:` names a row, so it is a
        // placement exactly like the legacy marker below, resolved by the worker's id instead of a minted one.
        if (seg.fence) {
          // A FOLLOW-UP lives inside its parent's card, which opens it when its option is picked; its own
          // fence has nothing to draw — unless its parent was asked in an EARLIER message. Then this fence
          // is what names the parent here (lib/questionBlocks followUpParentsIn), so it is the slot the
          // parent's card moves to, exactly like an `id:`-only reference. Never a card of its own: until
          // the row carries the new branch, the parent's card simply draws here without it.
          const followsUp = seg.fence.form === "ask" ? seg.fence.when : undefined
          if (followsUp && !followUpParents().has(followsUp.parent.toLowerCase())) continue
          const row = resolveQuestionName(followsUp ? followsUp.parent : seg.fence.id, fenceQuestions ?? [])
          if (row?.closed) {
            // CLOSED WITHOUT AN ANSWER — dismissed or withdrawn. The fence that asked it draws the question
            // closed, saying which (ClosedQuestionCard); a follow-up or a reference to it draws nothing.
            if (seg.fence.form === "ask" && !followsUp && !placedDrawn.has(row.id)) {
              placedDrawn.add(row.id)
              push(<ClosedQuestionCard key={`${keyBase}-${fi}-q${si}`} spec={seg.fence.spec} state={row.closed} wrap={dense} />)
            }
            continue
          }
          if (row) {
            // Placed in THIS message (the newest one naming it from its claiming rest on): the live card,
            // once. Answered here: its settled card, once. Anywhere else, the card is drawn there.
            const placedHere = placed?.find((q) => q.id === row.id)
            if (placedHere && !placedDrawn.has(placedHere.id)) {
              placedDrawn.add(placedHere.id)
              push(<RegisteredQuestionCard key={`${keyBase}-${fi}-q${si}`} q={placedHere} />)
              continue
            }
            const settledHere = settledPlaced?.find((q) => q.id === row.id)
            if (settledHere && !placedDrawn.has(settledHere.id)) {
              placedDrawn.add(settledHere.id)
              push(<SettledQuestionCard key={`${keyBase}-${fi}-q${si}`} s={settledHere} wrap={dense} />)
            }
            continue
          }
          // AN ASK WITH NO ROW YET — the server registers a second or two behind the transcript, and never
          // registers a fence it refused. The human sees the question now, drawn READ-ONLY from the fence's
          // own spec; the board's row replaces it with the answerable card the moment it lands. A reference
          // to nothing has nothing to draw.
          if (seg.fence.form === "ask" && !followsUp && !placedDrawn.has(`fence:${seg.fence.id}`)) {
            placedDrawn.add(`fence:${seg.fence.id}`)
            push(<UnregisteredQuestionCard key={`${keyBase}-${fi}-q${si}`} spec={seg.fence.spec} wrap={dense} />)
          }
          continue
        }
        // AN EMPTY MARKER NAMING A QUESTION PLACED HERE DRAWS ITS CARD IN THIS SLOT (lib/questionShadow
        // placeQuestions) — once: a second marker for the same id in one message is inert. The card reads
        // the surface's shared answering state, so its picks send with the rest's one "Send answers".
        const placedHere = placed && seg.registeredId ? placed.find((q) => q.id.toLowerCase() === seg.registeredId) : undefined
        if (placedHere && !placedDrawn.has(placedHere.id)) {
          placedDrawn.add(placedHere.id)
          push(<RegisteredQuestionCard key={`${keyBase}-${fi}-q${si}`} q={placedHere} />)
          continue
        }
        // A fence STANDING FOR a registered question still open at this message — asked at this rest or
        // an earlier one — but not PLACED here draws NOTHING: the registered card at the rest (or in the
        // slot of the marker that did place it) is the one the human answers. The index still advances —
        // the controller numbers every fence in the flat text — so the blocks that do render keep their
        // answer state.
        if (shadowedBy && fenceStandsFor(seg, shadowedBy) !== undefined) continue
        // A marker whose question has been ANSWERED draws that question's settled card, greyed, in the
        // slot the open card filled (lib/settledQuestions) — once, like the open card.
        const settledHere = settledPlaced && seg.registeredId ? settledPlaced.find((q) => q.id.toLowerCase() === seg.registeredId) : undefined
        if (settledHere && !placedDrawn.has(settledHere.id)) {
          placedDrawn.add(settledHere.id)
          push(<SettledQuestionCard key={`${keyBase}-${fi}-q${si}`} s={settledHere} wrap={dense} />)
          continue
        }
        // A LEGACY placement marker whose row is not standing here — withdrawn, dismissed, answered at a
        // later rest's marker, or a mistyped id — has nothing to draw either: its body is empty by
        // construction.
        if (seg.registeredId && seg.text.trim() === "") continue
        if (answering) askBlocks.push({ raw: seg.text, kind: seg.questionKind, danger: seg.danger, bi })
        // On a phone the card is a READING surface and the sheet is the answering one, so it renders
        // without an interactive controller even though this message has one.
        const interactive = answering && !isMobile
          ? {
              answer: answering.answerFor(bi),
              onChip: (optIdx: number, optText: string) => answering.onChip(bi, optIdx, optText),
              onText: (text: string) => answering.onText(bi, text),
              onSubmit: answering.onSubmit,
            }
          : undefined
        push(<QuestionBlockCard key={`${keyBase}-${fi}-q${si}`} raw={seg.text} questionKind={seg.questionKind} danger={seg.danger} interactive={interactive} wrap={dense} />)
      }
    }
  }

  if (m.parts && m.parts.length > 0) {
    // Ordered walk (the fix): each part renders where it belongs. A tools part → a card band over its
    // CONTIGUOUS run (collapseTools folds ×N + merges same-file edits within the run); a text part →
    // its prose + question cards.
    // NORMALIZED FIRST: a text part that renders NOTHING (empty/whitespace — a provider emitting a
    // blank text block between two tool_use blocks) is dropped, and the tools parts it separated
    // re-merge into one band. Otherwise it splits one batch into two blocks, and the block rhythm
    // (STEP) would put 14px between two tool cards that the reader sees as adjacent — the same batch
    // seam withMessageSpacers erases across messages. Order is preserved; only invisible parts go.
    normalizeParts(m.parts).forEach((part, pi) => {
      if (part.kind === "tools") {
        // textOnly (the queue card's first/last agent message): the batched tool band is dropped so only
        // the agent's prose remains — its calls live inside the collapsed intermediate bar instead.
        if (textOnly) return
        const collapsed = collapseTools(part.tools)
        if (collapsed.length) push(<ToolCalls key={`t${pi}`} tools={collapsed} dense={dense} at={m.at} />, toolBandEdges(collapsed))
      } else {
        renderText(part.text, `x${pi}`)
      }
    })
  } else {
    // LEGACY fallback (a pre-restart server ships no `parts`): the old flat layout — tool band first,
    // then all prose. Degrades to today's (order-lossy) rendering until the server bounce.
    if (!textOnly) {
      const collapsed = collapseTools(m.tools)
      if (collapsed.length > 0) push(<ToolCalls key="tools" tools={collapsed} dense={dense} at={m.at} />, toolBandEdges(collapsed))
    }
    renderText(m.text, "leg")
  }

  // An assistant turn that produced no renderable block (empty/whitespace-only) contributes NOTHING —
  // a bare <div> would still take a slot in the parent's gap stack and double the surrounding gap.
  if (blocks.length === 0) return null
  // The per-message Send button sits at the bottom of THIS message, scoped to just its own question
  // block(s) (answering.onSubmit → sendAnswers(thisMessageIdentity)). `answering` is present only for a
  // message that still carries an open ask, so the button only appears where there's something to send;
  // the queue card leaves showSendButton unset (it owns a single card-level Send instead).
  if (showSendButton && answering && isMobile && askBlocks.length > 0) {
    // One verb, and it OPENS the sheet rather than sending: nothing on a phone is answered from the
    // transcript, so a "Send answers" here would be enabled by state the reader cannot see.
    push(
      <div key="answer-open" className="flex justify-start">
        <button
          type="button"
          data-mobile-answer-open
          onClick={() => setAnswerSheetOpen(true)}
          className="button-outline flex h-[40px] items-center justify-center rounded-[12px] bg-accent-fill px-4 text-[15px] font-semibold text-on-accent active:brightness-90"
        >
          {askBlocks.length > 1 ? `Answer ${askBlocks.length} questions` : "Answer"}
        </button>
      </div>,
    )
  } else if (showSendButton && answering && askBlocks.length > 0 && !promptBoxSends) {
    // `askBlocks` can be empty with a controller present: every fence of this message was folded into
    // a registered card, and that card carries its own Send answers.
    push(
      <div key="send-answers" className="flex justify-start">
        <button
          type="button"
          data-send-answers
          disabled={!answering.anyAnswered || answering.sending}
          onClick={answering.onSubmit}
          onMouseDown={(e) => e.preventDefault()}
          className="button-outline rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-all hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:hover:opacity-30"
        >
          Send answers
        </button>
      </div>,
    )
  }
  // No gap on the container — between-block spacing is entirely the explicit VSpace elements.
  // `data-frizz-msg` stamps this root with the message's own `sourceId`: a stable per-message handle for
  // an inspector or an e2e selector, distinct from the pagination-anchor attribute (see the anchor test).
  return (
    <div data-frizz-msg={m.sourceId} className="flex flex-col text-[13px] min-w-0">
      {withSpacers(blocks, pictureAwareGap(pictureEdges, STEP))}
      {answerSheetOpen && answering && askBlocks.length > 0 ? (
        <MobileAnswerSheet blocks={askBlocks} answering={answering} onClose={() => setAnswerSheetOpen(false)} />
      ) : null}
    </div>
  )
}

// A user's composed multi-block answer, rendered as a structured card that MIRRORS the question
// component's answered state — so it wears the SAME anatomy as every other transcript card
// (TranscriptCard's CardHead + CardContent): "Answers" as a real sentence-case title flush with the
// card's left padding beside its top-left glyph, and the rows starting on that same left edge.
//
// It composes those pieces instead of using TranscriptCard because it is the HUMAN's artifact and must
// keep the user bubble's identity: right-aligned, capped at 85%, the elevated fill and the
// rounded-br-sm corner. Only the shell differs; the anatomy inside is identical, which is the point.
// The header used to be a right-justified lowercase eyebrow, chasing that bubble alignment — but the
// card's own rows read left-to-right, so it was the one thing in the card fighting its own content.
// Each chosen answer sits in the same accent chip the option chips use when selected (border-accent
// bg-accent/10).
// Each row leads with ITS QUESTION (compact, muted, clamped to two lines — the full text rides the
// title tooltip) so the answers read in context, not as bare numbered rows; a row whose pairing failed
// (count mismatch / no question message found — `question` undefined) degrades to the numbered layout,
// where the number still points a scrolled-up reader at the right block. Answers keep
// whitespace-pre-wrap so a multi-line answer's breaks survive.
// The row number shows ONLY in that fallback. With the question ON the row the question IS the label,
// and a second number can only COMPETE with whatever numbering the worker used inside the question text:
// a batch answering a BURIED ask renumbers its rows from 1 (they may span several messages), so
// answering questions 9–11 of an earlier ask rendered "1" against a question that reads "9. …".
function ProseHtml({ md, wrap }: { md: string; wrap?: boolean }) {
  const html = useMarkdownHtml(md)
  if (!html) return null
  // Through LinkedHtml, as a card's prose is: inline-code file references become clickable once the
  // server confirms each resolves to a real file, and a ```lightbox or ```mermaid fence still IN the
  // prose is drawn where it stands. The splitter lifts those fences out when they are blocks of their
  // own (lib/imagePaths.ts splitProseAttachments); the ones it leaves are inside something — a
  // `<details>` section, a list item, a quote — where lifting would break the thing they are inside.
  return <LinkedHtml className={`md-body${wrap ? ` ${QUEUE_WRAP}` : ""}`} html={html} />
}

// A local absolute image path rendered inline via the gated /local-image route, inside the shared
// ImageFrame. A load failure (route 4xx, missing file) falls back to showing the plain path text so
// nothing is silently swallowed. `hideCaption` drops the basename line (an attachment's bubble names
// the file already); `altText` overrides the a11y alt (else the basename).
export function BlockImage({ path, hideCaption, altText }: { path: string; hideCaption?: boolean; altText?: string }) {
  const [broken, setBroken] = useState(false)
  if (broken) return <div className="font-mono-keep text-[12px] text-muted-70 break-all">{path}</div>
  const base = basename(path)
  return (
    <ImageFrame
      caption={hideCaption ? undefined : <figcaption className="bg-panel-2 px-2 pb-1.5 font-mono-keep text-[11px] text-muted-60 break-all">{base}</figcaption>}
    >
      <img
        src={localImageUrl(path)}
        alt={altText ?? base}
        data-local-path={path}
        data-local-image="true"
        onError={() => setBroken(true)}
        className={`cursor-zoom-in ${FRAMED_IMAGE}`}
      />
    </ImageFrame>
  )
}

// A standalone local NON-image attachment path (pdf/text/code/…): an openable file chip showing the
// basename, wired to the app-wide local-file click handler via `data-local-path` + the `local-file-
// action` class (the server realpath-gates the open against the attachments/project roots, same as a
// markdown file link). A bordered pill rather than the underlined inline treatment because it stands
// alone on its own line, mirroring BlockImage's block presentation.
export function BlockFile({ path }: { path: string }) {
  const base = basename(path)
  return (
    <button
      type="button"
      className={`local-file-action inline-flex max-w-full items-center gap-1.5 ${BLOCK_RADIUS} border border-border bg-panel-2 px-3 py-1.5 text-left align-top no-underline hover:border-accent`}
      data-local-path={path}
      title={path}
    >
      <FileText size={14} strokeWidth={2} className="shrink-0 text-muted" />
      <span className="font-mono-keep truncate text-[12px] text-fg">{base}</span>
    </button>
  )
}

const VIS_THEME_VARIABLES: Record<string, string> = {
  "--background": "--color-bg",
  "--foreground": "--color-fg",
  "--card": "--color-panel-2",
  "--card-foreground": "--color-fg",
  "--popover": "--color-elevated",
  "--popover-foreground": "--color-fg",
  "--primary": "--color-fg",
  "--primary-foreground": "--color-bg",
  "--secondary": "--color-panel-2",
  "--secondary-foreground": "--color-fg",
  "--muted": "--color-panel-2",
  "--muted-foreground": "--color-muted",
  "--accent": "--color-border-strong",
  "--accent-foreground": "--color-fg",
  "--border": "--color-border-strong",
  "--input": "--color-control-strong",
  "--ring": "--color-accent",
  "--destructive": "--viz-destructive",
  "--viz-series-1": "--viz-series-1",
  "--viz-series-2": "--viz-series-2",
  "--viz-series-3": "--viz-series-3",
  "--viz-series-4": "--viz-series-4",
  "--viz-series-5": "--viz-series-5",
  "--viz-series-6": "--viz-series-6",
}

function visualizationTheme(requestId: number) {
  const root = getComputedStyle(document.documentElement)
  const vars = Object.fromEntries(Object.entries(VIS_THEME_VARIABLES).map(([target, source]) => [target, root.getPropertyValue(source).trim()]))
  vars["--font-size-base"] = getComputedStyle(document.body).fontSize
  return visualizationThemeMessage(requestId, root.colorScheme === "light" ? "light" : "dark", vars)
}

// Codex Visualize emits a thread-local HTML fragment plus this directive. The server resolves the
// basename against the owning Frizz session and wraps it in a CSP; this iframe deliberately omits
// allow-same-origin, forms, popups, downloads, and navigation so fragment scripts never inherit the
// control plane's authority. A tiny postMessage bridge supplies theme tokens and natural height.
export function InlineVisualization({ file }: { file: string }) {
  const slug = useContext(ThreadSlugContext)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(360)
  const [available, setAvailable] = useState<boolean | null>(null)
  const [appliedSrc, setAppliedSrc] = useState<string | null>(null)
  const paletteTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const requestId = useRef(0)
  const loadedSrc = useRef<string | null>(null)
  const { resolved } = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeSnapshot)
  // A Console key names its project; the route is that project's, with the real slug.
  const keyed = slug ? splitThreadKey(slug) : null
  const src = slug ? `${keyed ? projectApiBase(keyed.project) : apiBase()}/local-visualization?slug=${encodeURIComponent(keyed?.slug ?? slug)}&file=${encodeURIComponent(file)}` : null

  useEffect(() => {
    if (!src) { setAvailable(false); return }
    const controller = new AbortController()
    setAvailable(null)
    setAppliedSrc(null)
    loadedSrc.current = null
    window.clearTimeout(paletteTimeout.current)
    // Probe before mounting so a missing fragment gets a useful fallback instead of a tiny iframe
    // containing a bare HTTP status. HEAD avoids downloading a potentially 2 MB fragment twice.
    void fetch(src, { method: "HEAD", signal: controller.signal }).then((response) => {
      if (!controller.signal.aborted) setAvailable(response.ok)
    }).catch(() => {
      if (!controller.signal.aborted) setAvailable(false)
    })
    return () => controller.abort()
  }, [src])

  const sendTheme = useCallback(() => {
    if (!src || loadedSrc.current !== src) return
    const nextRequest = ++requestId.current
    iframeRef.current?.contentWindow?.postMessage(visualizationTheme(nextRequest), "*")
  }, [src])

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return
      if (event.data?.type === "frizz-inline-vis-ready") {
        sendTheme()
        return
      }
      if (isVisualizationThemeAck(event.data, requestId.current) && src && loadedSrc.current === src) {
        window.clearTimeout(paletteTimeout.current)
        setAppliedSrc(src)
        return
      }
      if (event.data?.type !== "frizz-inline-vis-height") return
      const next = Number(event.data.height)
      if (Number.isFinite(next)) setHeight(Math.max(80, Math.min(2400, Math.ceil(next))))
    }
    window.addEventListener("message", receive)
    return () => window.removeEventListener("message", receive)
  }, [sendTheme, src])

  useEffect(() => {
    sendTheme()
  }, [resolved, sendTheme])

  useEffect(() => () => window.clearTimeout(paletteTimeout.current), [])

  if (available === false || !src) {
    return <div role="status" className={`${BLOCK_RADIUS} border border-border bg-panel-2 px-4 py-2.5 text-[12px] text-muted`}>Visualization unavailable: <span className="font-mono-keep break-all">{file}</span></div>
  }
  if (available === null) return <div role="status" className={`h-20 animate-pulse ${BLOCK_RADIUS} bg-panel-2`} aria-label={`Loading ${file}`} />
  return (
    <iframe
      ref={iframeRef}
      src={src}
      title={file.replace(/\.html$/, "").replaceAll("-", " ")}
      sandbox="allow-scripts"
      onLoad={() => {
        if (!src) return
        setAppliedSrc(null)
        loadedSrc.current = src
        sendTheme()
        window.clearTimeout(paletteTimeout.current)
        paletteTimeout.current = window.setTimeout(() => setAvailable(false), 5000)
      }}
      className="block w-full border-0 bg-transparent"
      style={{ height, visibility: appliedSrc === src ? "visible" : "hidden" }}
    />
  )
}




// A SIGNAL fence rendered as a card in place of the raw ```done / ```awaiting block (the fence
// language IS the state; the body is the message). `done` → a compact presentation-only success card;
// its thread's Archive is the header's check (ThreadLifecycleActions). `awaiting` → THE RESTING CARD ITSELF
// (AwaitingBackgroundCard), which is the whole point: one component draws that card on every surface and
// at every runtime, so steering a worker cannot re-shape it. See the branch below.
// Whether the thread's own last fence is this one, by content: a fence passed down from the transcript is
// a fresh object, never the board's.
function statesFence(fence: ThreadViewData["lastFence"], body: string, hints: readonly AwaitingHint[]): boolean {
  return fence?.kind === "awaiting" && fence.body === body && JSON.stringify(fence.hints) === JSON.stringify(hints)
}

export function FenceCard({ fenceKind, body, hints, wrap, pastRest }: { fenceKind: FenceKind; body: string; hints: AwaitingHint[]; wrap?: boolean; pastRest?: boolean }) {
  // BLOCK markdown, not inline. A fence's prose is arbitrary Markdown since frontmatter landed
  // (2026-08-17), and inline rendering flattened a worker's paragraphs and lists into one run — the shape
  // a handoff most often takes.
  //
  // AND THE CLASS HAS TO FOLLOW THE RENDERER. That change swapped the markdown call and left these
  // bodies on `md-inline`, which styles only code/strong/em/links — so a `<ul>` arrived with
  // Tailwind's preflight reset still on it and a handoff's bullet list came out as flat unmarked lines
  // that read as a run of labels (maintainer 2026-08-19: "renders as light gray labels?"). `md-body` is
  // the block sheet; inside a card `.card-md` pulls it to the card's own 13px and lets the colour inherit,
  // which is why no CARD_BODY rides alongside it.
  const html = useMarkdownHtml(body)
  // The owning thread's slug — set by the thread view AND the queue card — so the confirm button
  // resolves its thread and renders on both surfaces (null in a sub-agent's own transcript → no button).
  const slug = useContext(ThreadSlugContext)
  // On the queue this dismisses THIS card through the user-initiated auto-scroll exit; null in the
  // drawer. Wired into both fence actions so Mark-as-done / park scroll the next card up, exactly like
  // the header's Mark-as-done and Snooze do (maintainer 2026-07-21: every card-dismissing control must).
  const queueDismiss = useContext(QueueDismissContext)
  // Resolve the owning thread + whether whole-thread lifecycle actions are applicable (session, not
  // foreign). Shared by both branches: the done card's Mark-as-done button renders only for a real,
  // actionable session thread, and the awaiting card needs the thread for its rows (null in a sub-agent
  // transcript, where there's no ThreadSlugContext → the fence renders card-only).
  const fenceThread = useThreadSnapshot(slug)
  const lifecycle = fenceThread ? threadLifecycleAvailability(fenceThread) : undefined
  // Deliberately NOT `lifecycle`: that stays true on a done thread — whose header cluster renders as a
  // "Done" readout — and keying on it here would grow a live Mark-as-done button on the done fence of a
  // thread that is already archived.
  const canAct = !!(fenceThread && lifecycle?.archive)
  // Once the Mark-as-done button has appeared, KEEP it mounted through completion. Clicking it flips
  // the thread to archived (canAct → false); unmounting the button there shrank the card — a layout
  // shift, and in the queue that resize also fed the passive scroll-anchor churn. StateButton latches
  // disabled on click and never resets on success, so holding the last actionable thread keeps the
  // button in place (disabled) instead of vanishing mid-dissolve.
  const doneThreadRef = useRef<ThreadViewData | null>(null)
  if (canAct && fenceThread) doneThreadRef.current = fenceThread
  const doneThread = canAct && fenceThread ? fenceThread : doneThreadRef.current
  // ON A PHONE THE CARD CARRIES NO VERB. The button below exists to be redundant with the header's
  // check; the phone's header has none, and its bottom bar's Done (PhoneDoneButton) is that stable control —
  // so the card's copy would only draw the same verb twice, one above the other (the 2026-09-30 capture of
  // the phone thread flagged exactly that, and the approved design draws the card without it).
  const isMobile = useIsMobile()
  if (fenceKind === "done") {
    const doneTitle = awaitingFenceTitle(hints)
    // A white "Mark as done" button, deliberately redundant with the header's check — the same completion
    // mutation, styled as the primary (light-on-dark) verb. Only shown when the thread can actually take
    // the action, and never on a phone (see `isMobile` above).
    //
    // AND ONLY WHILE THE THREAD RESTS ON THIS CARD. `pastRest` is Message's `staleAwaiting`: the thread
    // is running, or the worker has spoken since. The verb belongs to the rest, as an awaiting card's
    // Snooze does ("the interactive elements obviously are no longer interactive", below), and it used to
    // outlive it: every earlier done card in a thread kept a live white button, and a reply to an ARCHIVED
    // thread grew one on the card being replied to. The thread un-archives a beat after the reply's bubble
    // is drawn, so that card gained 35px in a frame of its own — 3 geometry states for one send, measured
    // 2026-10-13 with scripts/layout-timeline.mjs; 2 now. A card the thread moves past under a live button
    // gives it up in the frame that draws the bubble, which is the frame a steps card folds in. The CARD
    // is untouched: it is the same record, without its button.
    const markDone = doneThread && !isMobile && !pastRest ? (
      <CardActions>
        <StateButton
          thread={doneThread}
          className={`${CARD_ACTION_RADIUS} text-[11px] ${CARD_PRIMARY_BUTTON}`}
          iconClassName={ICON_LABEL_NUDGE}
          onArchived={queueDismiss?.dismiss}
          onDismissCancel={queueDismiss?.cancel}
        />
      </CardActions>
    ) : null
    return (
      // NEUTRAL tone — the green splash stood out as the only saturated color in the UI (maintainer
      // 2026-07-10). The Check + "Done" carries the meaning; no color needed.
      //
      // HEADED BY ITS KIND OVER ITS TITLE, then a rule, as every block type is (2026-10-13, TranscriptCard's
      // KindLabel: "it's weird that the done blocks still don't have a visually separate header, the way
      // that the awaiting blocks do"). The title is the worker's own `title:` — on the fence, or on
      // `frizzctl done --title` — and with none the "Done" line alone heads the card: never the body's
      // first sentence (maintainer, same day). An empty body draws no rule — the band's own border is the
      // only seam left to draw — and nothing at all draws no body.
      <TranscriptCard icon={Check} kind="Done" label={doneTitle ? <span className="[overflow-wrap:anywhere]">{doneTitle}</span> : null} ruled={!!html}>
        {html || markDone ? (
          <>
            {html && <LinkedHtml className={`md-body${wrap ? ` ${QUEUE_WRAP}` : ""}`} html={html} />}
            {markDone}
          </>
        ) : null}
      </TranscriptCard>
    )
  }
  // AND THE ```awaiting FENCE IS THE RESTING CARD — one component, not a second card that agrees with it
  // by hand (AwaitingBackgroundCard). It rendered as its own card until 2026-09-04, with its own heading
  // rule, its own glyph rule, its own prose fallback, its own wrap rule and its own PR chips, so the SAME
  // fence drew one shape while the thread rested on it and a visibly different one the moment the human
  // steered the worker: "I'll steer an agent with a new message, and it'll re-render the awaiting card in
  // a totally different fucking way. This doesn't make any sense at all." The only thing that may differ
  // is the SNOOZE, which the card drops itself once there is no rest to park (maintainer, same message:
  // "you can remove the snooze button and stuff because the interactive elements obviously are no longer
  // interactive").
  //
  // The fence is passed in rather than read off the thread: the board holds `lastFence` only while the
  // fence is the worker's last word, and the two surfaces that reach here are exactly the ones where it
  // is not — a thread running past the rest, and one the human bg-snoozed.
  //
  // `fenceThread` is undefined in a sub-agent's own transcript, where the card has no rows and no verb.
  //
  // A FALLBACK GUARD, not the mechanism: when the thread IS at rest on this fence the transcript skips
  // the fence BLOCK before it reaches here (Message's `restingCardShown`), because a null returned from
  // this component still spends the block spacer above it. This only catches a caller that did not pass
  // the flag — and it must stay a null rather than a second card, or the tail's card and this one draw
  // the same wait twice. Only the fence the resting card STATES is that wait: a held handoff
  // (ThreadView.heldHandoff) is an earlier fence, drawn above the resting card of the quiet park that
  // could not take it back, so it gets its own card.
  if (fenceThread && showsRestingCard(fenceThread) && statesFence(fenceThread.lastFence, body, hints)) return null
  return <AwaitingBackgroundCard thread={fenceThread} fence={{ body, hints }} />
}

// Trusted provider-auth recovery card (claude-auth plan). Rendered ONLY from the server's TYPED
// providerFault field — never parsed from assistant-authored content — so a model cannot manufacture
// a sign-in affordance in Chat. "Sign in" opens the same modal as the dispatch gate (copyable
// `claude auth login` + re-check). "Retry" re-sends the thread's LAST user message through the
// ordinary follow-up path (resume already handles a dead worker); it exists only as an explicit user
// action — a prompt is never replayed automatically after login.
export function ProviderFaultCard({
  slug,
  sessionId,
  fault,
  retryText,
}: {
  slug: string
  sessionId: string | undefined
  fault: NonNullable<ThreadViewData["providerFault"]>
  retryText?: string
}) {
  const [signIn, setSignIn] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const queryClient = useQueryClient()
  const label = PROVIDER_LABEL[fault.backend]
  // Retry-after-sign-in is an ordinary follow-up like every other turn-starting action: eager so the
  // thread paints as working and its message appears as a queued bubble the instant it's clicked, on
  // the FIFO chain, and tracked by the delivery ledger. A retry sent while still signed out fails the
  // send, whose rollback clears the optimistic state at once — no false lingering spinner. The local
  // `retrying` flag only disables THIS button; the thread's feedback no longer waits on the round-trip.
  const retry = (message: string) => {
    setRetrying(true)
    // sendEagerFollowUp does nothing (fires no callback) for an empty message. retryText is guarded
    // truthy at the button, so today `started` is always true — but resetting on false keeps this card
    // self-contained instead of trusting that external invariant to hold through a later refactor.
    const started = sendEagerFollowUp(queryClient, slug, message, {
      onSuccess: () => { setRetrying(false); showToast("Retrying with the previous message…") },
      onRollback: () => setRetrying(false),
      failureToast: (m) => `Retry failed: ${m.slice(0, 80)}`,
    })
    if (!started) setRetrying(false)
  }
  return (
    <TranscriptCard data-provider-fault tone="danger" icon={KeyRound} label={`${label} sign-in required`}>
      <span className={CARD_BODY}>
        The provider rejected this session's credential. Sign in, then retry.
      </span>
      <CardActions>
        {retryText?.trim() && (
          <button
            onClick={() => retry(retryText)}
            disabled={retrying}
            onMouseDown={(e) => e.preventDefault()}
            // The secondary sibling departs from the primary on FILL only — it stays outlined so the
            // pair keeps a hierarchy — never on the corner, which is a property of sitting in a card's
            // action row rather than of being the card's verb.
            className={`shrink-0 ${CARD_ACTION_RADIUS} border border-border px-2 py-1 text-[11px] text-fg/90 transition-colors hover:bg-panel hover:border-border-strong disabled:opacity-60`}
          >
            Retry
          </button>
        )}
        {/* The card's verb, so it wears the same white fill as every other card action. The accent
            fill it used to have made it the one saturated button in the transcript — and the red kind
            header + red border already carry the alarm, so the button did not need to repeat it. */}
        <button
          onClick={() => setSignIn(true)}
          onMouseDown={(e) => e.preventDefault()}
          className={CARD_PRIMARY_ACTION}
        >
          Sign in
        </button>
      </CardActions>
      {signIn && (
        <SignInModal
          backend={fault.backend}
          onClose={() => setSignIn(false)}
          onAuthed={() => setSignIn(false)}
        />
      )}
    </TranscriptCard>
  )
}

// The usage-limit pause card. Rendered ONLY from the server's TYPED limitPause — the same trust rule
// as ProviderFaultCard, so an agent quoting a limit message into its own transcript can never
// fabricate a "paused, resuming later" affordance.
//
// Deliberately NOT the sign-in card's shape, even though both are provider faults: here the
// credential is fine and the recovery is TIME, not an action. So the card leads with information —
// when the window comes back, and that frizz will pick the thread up itself — and keeps a manual
// continue as the secondary, for the operator who has capacity elsewhere and doesn't want to wait.
export function LimitPauseCard({ slug, sessionId, pause }: { slug: string; sessionId: string | undefined; pause: NonNullable<ThreadViewData["limitPause"]> }) {
  // Only Claude and Codex report a limit window Frizz can read; an ACP agent's limits stay inside its
  // own CLI, so a pause attributed to one is labelled generically rather than crashing on the lookup.
  const label = pause.backend === "acp" ? "The agent" : PROVIDER_LABEL[pause.backend]
  // The window is keyed "session", but it is labelled the way the provider's line above the card names
  // it: Claude Code calls it the "5-hour limit" since 2.1.312 ("session limit" before).
  const which = pause.window === "weekly" ? "weekly limit" : pause.window === "session" ? "5-hour limit" : "usage limit"
  const [continuing, setContinuing] = useState(false)
  const queryClient = useQueryClient()
  // "Continue now" is a manual override of the auto-resume — a turn-starting action exactly like a
  // steer, so it takes the same eager path: the row leaves the queue for the Active band and its bubble
  // appears the instant it's clicked, rather than after the injection round-trip. `continuing` disables
  // only this button.
  const continueNow = () => {
    setContinuing(true)
    // The message is a non-empty constant, so `started` is always true here; the reset-on-false is a
    // belt-and-suspenders that keeps the button from sticking disabled if that ever changes.
    const started = sendEagerFollowUp(queryClient, slug, RETRY_FOLLOW_UP, {
      onSuccess: () => { setContinuing(false); showToast("Continuing…") },
      onRollback: () => setContinuing(false),
      failureToast: (m) => `Continue failed: ${m.slice(0, 80)}`,
    })
    if (!started) setContinuing(false)
  }
  return (
    <TranscriptCard data-limit-pause tone="caution" icon={Hourglass} label={`Paused by the ${label} ${which}`}>
      {/* The provider's own "You've hit your 5-hour limit · resets …" line sits directly above this
          card (unlike an auth error, it is informative, so transcript.ts keeps its bubble). So this
          card says only what THAT line cannot: what frizz is going to do about it. */}
      <span className={CARD_BODY}>
        {pause.autoResume
          ? pause.resumesAt
            ? `Continuing automatically at ${limitResumeClock(pause.resumesAt)}.`
            : "Continuing automatically once the window resets."
          : "Continue it whenever you have capacity again."}
      </span>
      <CardActions>
        <button
          onClick={continueNow}
          disabled={continuing}
          onMouseDown={(e) => e.preventDefault()}
          className={`disabled:opacity-45 ${CARD_PRIMARY_ACTION}`}
        >
          Continue now
        </button>
      </CardActions>
    </TranscriptCard>
  )
}

// What frizz's permission policy REFUSED on the worker's behalf (cc-worker/hooks/perm-policy.mjs).
//
// Denials only. A refusal is rare, changes what the worker can do, and is worth a card that stays put.
// Approvals used to render here too, as one quiet line — and that was a mistake: the state behind it
// never clears, so a single routine `git status` approval pinned itself to the bottom of the thread
// permanently, reading as a live condition of the thread rather than a thing that happened once
// (maintainer 2026-08-07: "it's fucking useless"). Nothing was blocked, nobody was waiting, and the
// line outlived every reason to look at it. The server no longer retains an approval at all.
export function PermPolicyDenialCard({ policy, denies }: { policy: NonNullable<ThreadViewData["permPolicy"]>; denies?: number }) {
  const what = [policy.tool, policy.command].filter(Boolean).join(": ")
  return (
    <TranscriptCard tone="caution" icon={AlertTriangle} label="Blocked by frizz's permission policy">
      {/* The refused command leads on its own line — it is the thing you actually need to see — and
          the reason follows as prose. The reason is the same text the WORKER was given, so it
          already opens with "Refused:"; prefixing it here too read as a stutter. */}
      {what ? <code className="mb-1.5 block min-w-0 break-all rounded bg-panel px-1.5 py-1 text-[11px] text-fg/85">{what}</code> : null}
      <span className={CARD_BODY}>{policy.reason}</span>
      <span className="mt-1.5 block text-[11px] text-muted">
        Rule <code className="rounded bg-panel px-1 py-0.5">{policy.rule}</code>
        {denies && denies > 1 ? ` · ${denies} denials this session` : ""}
      </span>
    </TranscriptCard>
  )
}

// The BACKGROUND-OPS strip: one quiet row per LIVE op the worker is running across rests — sub-agents
// (drill-in) and background shells (display-only) — so a worker that "launched a CI watcher then came
// to rest" never reads as idle, and a final message like "waiting for the watcher to complete" has a
// visible home. Visible whenever ops are live, INCLUDING mid-turn (it folds in the old at-rest
// SubAgentBanner — one surface beats two, and ambient status beside the composer reads as status
// rather than transcript content). A 30s tick keeps
// elapsed fresh even when no board push arrives (a steadily-running op changes nothing to re-push).
// Saved links/files follow their own divider; they keep the strip visible without starting that tick.
// Since 2026-10-09 the thread's own rows live in the hover panels of the op counts over its prompt box
// (QueueOpsSummary), one panel per kind of row (`only`), on the queue card and in the drawer alike; only
// the sub-agent drawer still hangs a scoped strip under its box. The /full page draws none of it while
// its rail is on screen.
export function BackgroundOpsStrip({
  slug,
  className = "px-4 pb-2 pt-1",
  includeAgents = true,
  only,
  transcriptShells = [],
  parentAgentId,
}: {
  slug: string
  className?: string
  // Queue cards render live sub-agents as compact child lines directly under their composer. They
  // still use this strip for unrelated background shells/Monitors, so suppress agent duplication.
  includeAgents?: boolean
  // ONE KIND OF ROW, and nothing else: the counts over a prompt box open a panel each (QueueOpsSummary),
  // so the shells' panel must not list the watched PRs and the files' must not list the links. The
  // kinds are the counts' own (lib/queueOpsCounts.ts), split by the same tests, so a count and the
  // panel it opens cannot disagree. Absent ⇒ every row, the reading the sub-agent drawer's strip wants.
  // The command watches' and timers' panels draw their rows themselves (QueueOpsSummary WaitPanelRows).
  only?: Exclude<QueueOpsKind, "agent" | "command" | "timer">
  // Codex deliberate background execs are transcript-native; its board telemetry is still empty. A
  // CLAUDE shell shows up here AND in the board's telemetry — `launchId` is what lets the two rows
  // reconcile into one (see mergeBackgroundShells).
  transcriptShells?: readonly (BgShellView & TranscriptShellRecord)[]
  // SCOPE the strip to one sub-agent's own subtree — the SubAgentSheet's prompt box, where "the ops
  // running underneath this" means the children THIS child dispatched, not the thread's whole forest.
  // Absent ⇒ the thread-wide reading every other surface wants.
  //
  // It also switches the SHELL source off the board. `bgShells` is derived from the SESSION's JSONL, so
  // every row in it belongs to the thread's own worker; a sub-agent's background shells live only in
  // that child's own transcript, which is what `transcriptShells` carries here. Merging the board list
  // in would credit this child with its parent's watchers.
  parentAgentId?: string
}) {
  const thread = useThreadSnapshot(slug)
  const allAgents = thread?.subAgents ?? []
  // `displayDepth` rides only the scoped rows (see childOpSubtree); the thread-wide reading indents off
  // `depth` as it always has, so the field is optional here rather than back-filled onto every row.
  const agents: readonly (SubAgentView & { displayDepth?: number })[] =
    !includeAgents ? [] : parentAgentId ? childOpSubtree(allAgents, parentAgentId) : allAgents
  // THE THREAD-WIDE ROWS are lib/threadOps' — the ones the counts over a prompt box and the full-screen
  // rail list, picked by the same rules. A single shell arrives through BOTH provider board telemetry and
  // transcript projection, and is reconciled there on the launch tool_use id (mergeBackgroundShells).
  const ops = thread && !parentAgentId ? threadOps(thread, transcriptShells) : undefined
  const shells = only && only !== "shell" ? [] : parentAgentId ? [...transcriptShells] : (ops?.shells ?? [])
  // PR WATCHERS the thread has parked on. Thread-wide only: a sub-agent cannot park on a fence, so the
  // drawer's scoped reading ("the ops running underneath THIS child") has none by construction, and
  // listing the parent's here would credit the child with its parent's wait.
  const watchers = !ops || (only && only !== "pr" && only !== "issue") ? [] : only === "pr" ? ops.prs : only === "issue" ? ops.issues : [...ops.prs, ...ops.issues]
  const links = !ops ? [] : only === "file" ? ops.files : only === "link" ? ops.links : only ? [] : (thread?.links ?? [])
  const total = agents.length + shells.length + watchers.length
  // IS A WATCHER ARMED ON THIS SHELL? A `shell` watch gets NO row of its own — it is not a second thing
  // running, it is a property of the row already here, and drawing both listed one object twice
  // (maintainer 2026-08-14: "we do not need to redundantly list out background shells inside of the
  // watcher icon menu"). So the fact rides the shell's own row, in its tooltip.
  //
  // It is worth saying at all because the runtime's own completion notification does NOT survive the
  // worker coming to rest: measured over ~/.claude/projects, 1601 background shells whose worker rested
  // before the shell finished, and 1191 of them never received a notification even though the session
  // provably kept working for minutes-to-days afterwards. An armed watcher is what closes that, so
  // "will this thread actually hear about this" is a real question about a shell row, with two answers.
  // The full-screen rail's shell rows say the same, off the same predicate (lib/threadOps shellWatched).
  const isWatched = shellWatched(thread)
  // This is intentionally independent of transcript cards: it sits immediately below the affected
  // prompt box so a resting worker that owns a live shell still reads as active at a glance. Do not
  // add a thread-wide “Running” marker here: a foreground turn and several independent children are
  // different operations, and only the row that owns a running state may advertise live work.
  const [, force] = useState(0)
  useEffect(() => {
    if (total === 0) return
    const id = setInterval(() => force((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [total])
  // THE LIVE COUNTER on each shell row. Polled here rather than pushed on the board: output growth is a
  // file fact the board's derived signature does not read, and the reading is wanted at seconds
  // granularity — pushing that for every thread on the machine is churn nobody asked for (the same
  // reason raw token counts are kept out of that signature). Scoped to the rows this strip is actually
  // rendering, so it costs nothing when the view is closed. Hooks run before the early return below.
  const shellLines = useBackgroundShellLines(slug, shells.flatMap((s) => (s.id && !s.outputUnavailable ? [s.id] : [])))
  if (total === 0 && links.length === 0) return null
  return (
    <div className={`flex flex-col gap-0.5 ${className}`} data-background-ops>
      {visibleChildOps(agents, "sheet").map((s, i) => (
        <ChildOpRow
          key={`a${i}`}
          kind="AGENT"
          label={s.label}
          state={s.state}
          density="sheet"
          // The INDENT reading (see childOpSubtree): inside a sub-agent drawer a row's distance is
          // measured from that sub-agent, while `s.depth` — the distance from the thread, which decides
          // whether the × is honest — stays untouched on the record childOpDismisser reads.
          depth={s.displayDepth ?? s.depth}
          startedAt={s.startedAt}
          // The ops strip is where the full live reading belongs: the child's current step plus how far
          // it has got. All three are absent for a codex child, which just reads as it did before.
          onOpen={s.id ? () => pushSubAgentDrawer(slug, s.id!, { label: s.label, subagentType: s.subagentType, startedAt: s.startedAt }) : undefined}
          onDismiss={childOpDismisser(slug, s)}
        />
      ))}
      {visibleChildOps(shells, "sheet").map((s, i) => (
        <ChildOpRow
          key={`s${i}`}
          kind="SHELL"
          label={s.label}
          state={s.state}
          density="sheet"
          startedAt={s.startedAt}
          // Absent until the first poll answers, and permanently absent for a shell whose output frizz
          // cannot read — never a fabricated 0 for a number we do not have.
          counter={s.id ? shellLinesLabel(shellLines.get(s.id)) : undefined}
          counterTitle="Lines of output so far — open the row to read them"
          // A codex shell has an id (its `processId`, which is what its × addresses) but no readable
          // output — codex keeps that inside its own session. So the two affordances part company
          // here: the row still stops, and it renders non-interactive rather than opening a drawer
          // that could only report "unavailable".
          onOpen={s.id && !s.outputUnavailable ? () => pushBackgroundShellDrawer(slug, s.id!, { label: s.label, startedAt: s.startedAt }) : undefined}
          onDismiss={childOpDismisser(slug, s, "SHELL")}
          // Overriding the row's default open-tooltip only when there IS a watcher: an unwatched shell
          // keeps exactly the row it has always had, so the marker is the exception rather than a new
          // reading every row has to carry.
          title={isWatched(s) ? `${s.label}\n${SHELL_WATCHED_NOTE}` : undefined}
        />
      ))}
      {/* THE PR WATCHERS, last, because they are the least likely to change while you are looking: a
          sub-agent and a shell are running RIGHT NOW, and a watcher is waiting on somebody else.
          They are always `running` — a parked watcher IS live, and the row vanishes the moment the
          fence stops standing (see board.githubWatchViews), so there is no settled state to draw.
          NO DISMISS ×: there is no registration to drop. The worker owns the fence, and the operator's
          control for "stop showing me this" is the snooze on the resting card. */}
      {watchers.map((w) => (
        <ChildOpRow
          key={w.id}
          kind="GITHUB"
          label={w.target}
          state="running"
          density="sheet"
          startedAt={w.createdAt}
          // WHAT ITS CI SAYS, in the same column a shell's line count takes — because this strip is on
          // screen while the thread WORKS, and the card that rendered the full reading is only drawn at
          // rest. A watcher row used to say a ref and an age, which is the one pair that cannot answer
          // "is anything wrong with it". Absent until the first poll answers, never a fabricated 0.
          // An ISSUE has no checks to count, so its counter is its conversation size — the one number
          // that says whether anybody has answered — and "closed" once it is.
          counter={w.subject === "issue" ? issueCounterLabel(w.issue) : checksCounterLabel(w.github)}
          counterTone={w.github?.checks === "failing" ? "danger" : undefined}
          counterTitle={w.subject === "issue"
            ? (w.issue ? `${w.target} — ${issueStatusLine(w.issue)}` : undefined)
            : (w.github ? `${w.target} — ${watchStatusLine(w.github)}` : undefined)}
          onOpen={() => window.open(githubRefUrl(w.target, w.subject === "issue" ? "issue" : "pull") ?? `https://github.com/${w.target.replace("#", w.subject === "issue" ? "/issues/" : "/pull/")}`, "_blank", "noreferrer,noopener")}
        />
      ))}
      <ThreadLinks links={links} />
    </div>
  )
}

// The read-only render of a PENDING native AskUserQuestion (the safety net for a session that bypassed
// the thread-file ask channel). Shows the REAL question(s) + options as NON-interactive rows —
// deliberately NOT answer-chips: answering a native TUI dialog by keystroke injection is too fragile.
// It carries NO action at all. It draws for a foreign session only (lib/operatorBlock.ts
// `frozenPendingAsk`), which the operator is already running in their own terminal: the label says
// where the answer goes, and Frizz has no session of its own there to hand them a command for.
export function PendingAskCard({ ask }: { ask: PendingAsk }) {
  return (
    <TranscriptCard tone="attention" icon={HelpCircle} label="Waiting on your answer — in your external terminal">
      <div className="flex flex-col gap-3">
        {ask.questions.map((q, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            {q.header && <div className="text-[10px] uppercase tracking-wide text-muted-55">{q.header}</div>}
            <div className="min-w-0 text-[12px] font-medium leading-5 text-fg">{q.question}</div>
            {q.options.length > 0 && (
              <div className="flex flex-col gap-1">
                {q.options.map((o, j) => (
                  // A non-interactive OPTION ROW (clearly display-only — no hover, no cursor-pointer).
                  // `bg-elevated`, one step above the card's own panel-2 fill — the same relationship the
                  // question card's chips have to their card, so a row reads as a row on every surface.
                  <div key={j} className="rounded-md border border-border bg-elevated px-3 py-1.5 text-[12px] text-fg/80">
                    <span className="font-medium text-fg/90">{o.label}</span>
                    {o.description && <span className="text-muted-70"> — {o.description}</span>}
                  </div>
                ))}
                {q.multiSelect && <div className="text-[10px] text-muted-50">select one or more</div>}
              </div>
            )}
          </div>
        ))}
      </div>
    </TranscriptCard>
  )
}

// A SUB-AGENT COMPLETION — emitted by the server as a standalone `agentCompletion` copy of the dispatch
// call at the position the completion notification landed. It renders in the SAME wake-divider idiom a
// background shell's completion uses, because that is the convergence the maintainer asked for: the two
// events mean the same thing to a reader, and the divider is the form that survives a long run of tool
// cards. It deliberately does NOT reuse the launch card's chrome — a second identical AgentBlock at the
// completion point was pure duplication, and it disappeared into the band around it.
//
// The TITLE is a drill-in link into the child's run log wherever a slug resolves — the launch card up
// thread is often hundreds of lines away, so this is usually the closest handle on the finished child.
// With no resolvable slug it degrades to plain text rather than a dead button.
function AgentCompletionLine({ call, sourceId, at }: { call: TranscriptToolCall; sourceId?: string; at?: string }) {
  const slug = useChildDrillSlug()
  const title = call.detail ?? "sub-agent"
  const { outcome, tail } = subAgentCompletionOutcome(call)
  // The run's own duration, as `tail` writes it after the outcome word (`· 35m`), or nothing.
  const ran = tail.slice(outcome.length).trim()
  const canDrill = !!(slug && call.agentId)
  // `at` is the instant the completion LANDED, and it sits after the run's own duration in `tail`
  // ("finished · 35 min · 2h ago"): how long it ran, then how long ago it came back.
  return (
    <WakeDivider icon={Bot} sourceId={sourceId} marker="agent" ariaLabel={canDrill ? undefined : `Sub-agent ${title} ${tail}`} at={at}>
      {/* WIDE ONLY, with the run's duration below (see WAKE_DIVIDER_WIDE_ONLY): on a narrow row the bot
          glyph says "sub-agent" and the room goes to the title, which is the only thing here that says
          WHICH one. The outcome word is the news and stays at every width. */}
      <span className={`shrink-0 ${WAKE_DIVIDER_WIDE_ONLY}`}>Sub-agent</span>
      {/* The guillemets sit OUTSIDE the truncating element (and inside a gap-less nested flex) so a
          title clipped at a narrow width still closes its quote — `«a long title…` reads as broken
          punctuation, not as a truncation. It also scopes the link underline to the title itself. */}
      <span className="flex min-w-0 items-center">
        <span className="shrink-0">«</span>
        {canDrill ? (
          <button
            type="button"
            data-subagent-completion-open
            title={CHILD_OPEN_TITLE.AGENT}
            aria-label={`${CHILD_OPEN_TITLE.AGENT}: ${title}`}
            onClick={() => pushSubAgentDrawer(slug!, call.agentId!, { label: title, subagentType: call.subagentType })}
            onMouseDown={(e) => e.preventDefault()}
            className="min-w-0 truncate rounded-sm underline decoration-muted/30 underline-offset-2 outline-none transition-colors hover:text-fg hover:decoration-fg/60 focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
          >
            {title}
          </button>
        ) : (
          <span className="min-w-0 truncate">{title}</span>
        )}
        <span className="shrink-0">»</span>
      </span>
      <span className="shrink-0">{outcome}</span>
      {ran && <span className={`shrink-0 ${WAKE_DIVIDER_WIDE_ONLY}`}>{ran}</span>}
    </WakeDivider>
  )
}

// A SUB-AGENT'S UPWARD REPORT — a background child calling `SendMessage({to:"main"})` mid-flight to tell
// its dispatcher something before it finishes. It rides the SAME wake-divider idiom as the completion
// above, and for the same reason: this is a child the worker launched reaching a notable state and
// re-invoking the agent, which is exactly the class the divider was converged on to carry.
//
// It is deliberately NOT a message and NOT a card (maintainer 2026-07-29: it "should look more like tool
// calls, or even more like the kind of full-width messages that show up whenever a subagent or a sub-shell
// complete… we don't need to render its full message in the chat like any other message"). The earlier
// TranscriptCard version rendered the child's whole markdown body inline, which read as a full peer turn
// and competed with the parent's own prose for the eye.
//
// It carries NO EXCERPT of the message either (maintainer, same day: "Do not include any piece of the
// message in that component. It is not useful to have 30 [...] characters of that message get rendered. I
// should just have to click on the title, then I can see the whole message if I want to. It should open up
// in a drawer."). A 30-character window onto a report is too little to act on and too much to ignore, so
// the line states only THAT a child reported, and the TITLE is the affordance: it opens the child's own
// drawer, where the message is rendered in full alongside the work it came out of.
function SubAgentReportLine({ from, unnamed, dispatchId, sourceId, at }: { from: string; unnamed?: boolean; dispatchId?: string; sourceId?: string; at?: string }) {
  const slug = useChildDrillSlug()
  // `dispatchId` is the child's Agent DISPATCH tool_use id, NOT its agentId — that is the only key
  // pushSubAgentDrawer/tailer.subAgent resolve against, and handing over the agentId (which is what the
  // report's delivery record actually names) opens an "unavailable" drawer. The server does the
  // translation; see peerDispatchId. No id ⇒ plain text, never a dead link.
  const canDrill = !!(slug && dispatchId)
  // A PROFILE IS NOT A NAME. When the parser could not resolve the sender's dispatch description, `from`
  // is only the subagent_type — identical across every child dispatched at that model+effort cell — and
  // the divider used to promote it to a title, so two siblings reporting read as the same agent and the
  // line named the MODEL where the reader expected the work (maintainer 2026-08-06: "I'm also still
  // occasionally seeing things like 'Agent <OPUS:HIGH> rested'. Sometimes these later resolve into the
  // actual title"). It resolves later because the description lives on the DISPATCH record, which the
  // window may not have reached yet — so the honest reading in the meantime is no name at all, not a
  // borrowed one. The cell stays in the tooltip, where it is a fact about the child rather than its
  // identity, and the drill-in survives: the word "Sub-agent" carries the link.
  const label = unnamed ? undefined : from
  const openTitle = unnamed && from ? `${CHILD_OPEN_TITLE.AGENT} — ${from}` : CHILD_OPEN_TITLE.AGENT
  // ONE element for the whole unnamed reading, never a "Sub-agent" span plus the shared trailing verb.
  // The divider's flex `gap` is 12px — a full em at its 12px petite-caps — because it was tuned to stand
  // either side of a QUOTED TITLE. With the title gone it would land between two words of one phrase, and
  // measured on the real page that is the difference between a word space and an em of air.
  if (label === undefined) {
    return (
      <WakeDivider icon={Bot} sourceId={sourceId} marker="agent-report" ariaLabel={canDrill ? undefined : "Sub-agent reported"} at={at}>
        {canDrill ? (
          <button
            type="button"
            data-subagent-report-open
            title={openTitle}
            aria-label={`${CHILD_OPEN_TITLE.AGENT}${from ? `: ${from}` : ""}`}
            onClick={() => pushSubAgentDrawer(slug!, dispatchId!, { label: "Sub-agent", subagentType: from })}
            onMouseDown={(e) => e.preventDefault()}
            className="shrink-0 rounded-sm underline decoration-muted/30 underline-offset-2 outline-none transition-colors hover:text-fg hover:decoration-fg/60 focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
          >
            Sub-agent reported
          </button>
        ) : (
          <span className="shrink-0" title={from || undefined}>Sub-agent reported</span>
        )}
      </WakeDivider>
    )
  }
  return (
    <WakeDivider icon={Bot} sourceId={sourceId} marker="agent-report" ariaLabel={canDrill ? undefined : `Sub-agent ${label} reported`} at={at}>
      <span className={`shrink-0 ${WAKE_DIVIDER_WIDE_ONLY}`}>Sub-agent</span>
      {/* Guillemets OUTSIDE the truncating element, per the completion line: a title clipped at a narrow
          width still closes its quote. The TITLE is the only part allowed to shrink (`min-w-0 truncate`
          on it and on its flex host) — a `shrink-0` wrapper here let a long name push the whole divider
          past the pane at 420px, losing its left hairline, while the completion line beside it clipped
          cleanly. Codex task names are long snake_case identifiers, so that is the common case, not the
          edge. `label` is the child's real title: its codex task name, or on Claude the dispatch
          description the parser resolved — the unnamed case returned above and never reaches here, so
          the quoted slot is either a real title or absent entirely, never the profile. */}
      <span className="flex min-w-0 items-center">
        <span className="shrink-0">«</span>
        {canDrill ? (
          <button
            type="button"
            data-subagent-report-open
            title={CHILD_OPEN_TITLE.AGENT}
            aria-label={`${CHILD_OPEN_TITLE.AGENT}: ${label}`}
            onClick={() => pushSubAgentDrawer(slug!, dispatchId!, { label, subagentType: from })}
            onMouseDown={(e) => e.preventDefault()}
            className="min-w-0 truncate rounded-sm underline decoration-muted/30 underline-offset-2 outline-none transition-colors hover:text-fg hover:decoration-fg/60 focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
          >
            {label}
          </button>
        ) : (
          <span className="min-w-0 truncate">{label}</span>
        )}
        <span className="shrink-0">»</span>
      </span>
      <span className="shrink-0">reported</span>
    </WakeDivider>
  )
}

// THE OUTGOING HALF of the pair above — this turn calling `SendMessage` to steer a child it dispatched
// (or `shutdown_request`/codex `followup_task`, which address the same class of recipient). Maintainer
// 2026-07-31: "render 'Steered' or SendMessage using the same full width notifications, the horizontal
// rule style component that we render when an agent completes. In the case of Claude Code, clicking on
// the title should open up the sub-agent in the drawer."
//
// So it drops the bordered SendMessageCard for the SAME divider the completion and report lines draw.
// The three now read as one family, which is the point: they are the three things that happen between a
// worker and its children, and a bordered card for one of them sat in the tool band the divider exists
// to stand out from.
//
// It carries NO summary and NO body — the same ruling the report line took ("Do not include any piece
// of the message in that component… I should just have to click on the title, then I can see the whole
// message if I want to"). The steer's text is not lost: it lands in the child's transcript as an
// incoming message, which is precisely what the title opens.
//
// The TITLE is the child's dispatch DESCRIPTION and the link target its DISPATCH tool_use id — both
// resolved server-side (sendTargetLabel/sendDispatchId), because the raw `to` is an agentId that reads
// as a hash and resolves to nothing. Codex peer calls name a target that was never dispatch-acked here,
// so they keep that target as plain text rather than becoming a dead link.
function SendMessageLine({ to, type, dispatchId, targetLabel, sourceId, at }: { to?: string; type?: string; dispatchId?: string; targetLabel?: string; sourceId?: string; at?: string }) {
  const slug = useChildDrillSlug()
  const verb = sendMessageVerb(to, type)
  // `to === "main"` is an upward report, whose recipient is the conversation itself — there is no title
  // worth showing and nothing to drill into, so the divider states the verb alone.
  const title = to === "main" ? undefined : (targetLabel ?? to)
  const canDrill = !!(slug && dispatchId)
  return (
    <WakeDivider icon={Bot} sourceId={sourceId} marker="agent-steer" ariaLabel={canDrill ? undefined : `${verb}${title ? ` ${title}` : ""}`} at={at}>
      <span className="shrink-0">{verb}</span>
      {/* Guillemets OUTSIDE the truncating title, and the title the only shrinkable part — the same
          construction the completion and report lines use, so a long child description clips cleanly at
          a narrow width instead of pushing the divider's hairline off the pane. */}
      {title && (
        <span className="flex min-w-0 items-center">
          <span className="shrink-0">«</span>
          {canDrill ? (
            <button
              type="button"
              data-subagent-steer-open
              title={CHILD_OPEN_TITLE.AGENT}
              aria-label={`${CHILD_OPEN_TITLE.AGENT}: ${title}`}
              onClick={() => pushSubAgentDrawer(slug!, dispatchId!, { label: title })}
              onMouseDown={(e) => e.preventDefault()}
              className="min-w-0 truncate rounded-sm underline decoration-muted/30 underline-offset-2 outline-none transition-colors hover:text-fg hover:decoration-fg/60 focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60"
            >
              {title}
            </button>
          ) : (
            <span className="min-w-0 truncate">{title}</span>
          )}
          <span className="shrink-0">»</span>
        </span>
      )}
    </WakeDivider>
  )
}

// A quiet transcript annotation (a context-compaction note, an "Agent … finished" line), or — with
// `boundary` — the wake divider a background task/shell completion emits. Muted, no bubble, no icon
// chrome, sitting at the same message rhythm as everything around it.
function EventLine({ text, boundary, sourceId, at }: { text: string; boundary?: TranscriptMessage["boundary"]; sourceId?: string; at?: string }) {
  // A turn BOUNDARY: a centered divider rule carrying the cause label ON it, so two consecutive
  // assistant turns don't read as one bubble. This IS the section break the plain event line
  // deliberately avoids.
  //
  // The glyph is why the server names the KIND rather than sending a bare flag. A `wake` is a
  // background shell/task coming back, and it takes the terminal glyph the rest of the app already uses
  // for a background shell (BackgroundShellSheet, AwaitingBackgroundCard). A `compaction` is not a
  // child returning at all — nothing ran, the provider just dropped the conversation above this line —
  // so it takes NO glyph rather than borrowing one that would misname it. Nor does a `rest`: it was the
  // most FREQUENT divider by far — one per turn — and a mark on every one of them is noise the quieter
  // bare rule does not make (maintainer 2026-08-02, on the ellipsis this shipped with). It is far rarer
  // now that lib/restDividers.ts drops the ones that only restate their neighbours, and the bare rule is
  // still right: what survives sits directly above the human's own next message, where a glyph would
  // compete with the bubble rather than quietly close the turn under it.
  if (boundary) {
    // `Lead «title» outcome (note)`, the shape `backgroundWakeLabel` writes. Greedy on the title, so a
    // description that itself contains a guillemet still ends at the LAST one.
    const quoted = boundary === "wake" ? /^([^«]+?) «(.+)» ([^»(]+?)(?: (\([^»]*\)))?$/.exec(text) : null
    return (
      <WakeDivider
        icon={boundary === "wake" ? TerminalSquare : undefined}
        sourceId={sourceId}
        marker={boundary === "rest" ? "rest" : "event"}
        ariaLabel={text}
        // The rest divider takes the age too, glyph-less as it is: the rests that survive
        // lib/restDividers.ts sit above a human reply, and "how long did it sit there before they
        // answered" is the one thing the bare rule could not say.
        at={at}
      >
        {/* TRUNCATES, like every sibling: as a bare text node the label was a wrapping flex item, and
            once the age joined it the runtime-reported shell line broke onto two lines at 420px while
            the frizz-reported twin beside it (ShellDoneDivider) clipped to one — the pair that must be
            pixel-identical. The age stays outside this span so it survives the clip.
            A line that QUOTES a title — `Background task «…» finished`, which is every shell and
            monitor the server labels — gives up the title and keeps its outcome, cut exactly as that
            twin cuts its own. */}
        {quoted
          ? <DividerQuotedTitle lead={quoted[1]} title={quoted[2]} tail={quoted[3]} note={quoted[4]} />
          : <span className="min-w-0 truncate">{text}</span>}
      </WakeDivider>
    )
  }
  // Transcript PUNCTUATION (a context-compaction note) — a quiet, left-justified regular light-grey
  // line. No flanking dividers: it reads as a subtle annotation, not a section break, and uses the same
  // type scale as the adjacent activity gerund/digest.
  return (
    <div data-frizz-msg={sourceId} className={TRANSCRIPT_META_LABEL_CLASS}>{text}</div>
  )
}

// A Codex model-reasoning SUMMARY — the coalesced `summary[]` steps of a turn's reasoning records
// (Claude's thinking is redacted at every seam, so this is Codex-only). Same regular light-grey line as
// the tool digest beside it (TRANSCRIPT_META_LABEL_CLASS), content-width, chevron flush-right of the
// label — so the quiet progress rows read as one family. Collapsed shows just the "Reasoning" label; the
// whole row toggles to reveal the train of thought as muted markdown in a ruled block. The `.frizz-reasoning`
// rule below quiets that body (12px/muted, and de-bolds codex's `**step header**` fragments) so an
// expanded turn reads as a soft aside, never a wall of bold headers competing with the real answer.
//
// The label names the CONTENT, not a duration. It used to read "Thought for N seconds", which made every
// codex turn leave behind a permanent row whose only payload was how long the model paused — the live
// shimmer already says `Thinking…` while that is happening, and afterwards it is not a fact worth a row
// (maintainer 2026-08-01: "it should never show up persistently like that"). The server still measures
// `durationMs`; nothing renders it.
function ReasoningBlock({ text, sourceId }: { text: string; sourceId?: string }) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  return (
    <div data-frizz-msg={sourceId} className="flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        aria-controls={bodyId}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} model reasoning`}
        className={`${TRANSCRIPT_META_LABEL_CLASS} flex items-baseline gap-1.5 self-start rounded outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60`}
      >
        <span>Reasoning</span>
        {/* One column, one chevron treatment — vertical correction, ink trim and tone all live in
            transcriptMetaChevronClass with the measurements that set them. */}
        <ChevronRight aria-hidden="true" size={13} className={transcriptMetaChevronClass(open)} />
      </button>
      {open && (
        <div id={bodyId} className="frizz-reasoning mt-1.5 ml-[5px] border-l border-border/70 pl-3">
          <ProseHtml md={text} wrap />
        </div>
      )}
    </div>
  )
}


function Dots() {
  return <span className="inline-block w-2.5 h-2.5 rounded-full border border-muted/70 border-t-transparent animate-spin" />
}

// The turn-in-flight banner: the latest tool's gerund replaces "Thinking…" in THIS same bottom slot
// and THIS same shimmer span. The baseline is `startedAt` — the start of the STRETCH this row is
// reporting (lib/toolActivity.liveRuntimeStartedAt), server-derived so it survives reloads — with
// `since` (the last real user interaction) as the fallback and mount time behind that. Ticks once a
// second — cheap, and unmounts with the banner.
//
// The generic reading is "Thinking…", not "Working…". It shows exactly when the turn is running and
// liveToolActivityTail names nothing — the model is generating and no tool is executing: the opening of
// a turn, the pause after it wrote prose, the step after a dispatch or background op (those keep their
// own card and are excluded from the run — see isToolActivityException), and the INTER-CALL GAP, where
// the last result has landed and the model is reasoning over it. That last one is the long one, and it
// used to keep showing the finished call's gerund, so a 20-second think read as a 20-second tool call
// (maintainer 2026-08-04: "it seems like a tool call is hanging for a long time, but it's only because
// the tool call has already completed and the agent is thinking about the results"). "Working" described
// the SESSION, which is the one thing the reader can already see from the thread being active; the
// model composing its next move is what the slot is actually reporting, and it is what every gerund
// beside it reports too (maintainer 2026-08-01: "Do you think it makes more sense to change it to
// 'thinking'?").
//
// In that gap the generic reading also STATES THE RUN — `Ran 23 tool calls. Thinking…` — because a bare
// `Thinking…` under a clock counting the whole turn reads as a thread that has been thinking for ten
// minutes rather than one that has just done twenty-three things (maintainer 2026-08-08). So the slot
// alternates `Ran 23 tool calls. Thinking…` → the next call's gerund → `Ran 24 tool calls. Thinking…`,
// and the count ticking up is the progress signal. See lib/toolActivity.thinkingToolActivityLabel; the
// number is `total`, the same run this row expands onto and the same one its digest will state — and,
// since the clock moved off the turn, the same run the clock beside it is timing.
export function WorkingIndicator({ since, startedAt, activityLabel, run }: { since?: string; startedAt?: string; activityLabel?: string; run?: { tools: readonly TranscriptToolCall[]; at?: string } }) {
  // The clock counts the STRETCH this row is reporting (lib/toolActivity.liveRuntimeStartedAt), not the
  // turn — so it re-baselines every time the run it stands for changes, and `since` is only the fallback
  // for a transcript that carries no usable instant at all. It used to latch the turn's start at mount,
  // which is how `Ran 3 tool calls` came to sit beside a two-hour reading.
  const [mountedAt] = useState(() => Date.now())
  const baseline = useMemo(() => {
    for (const at of [startedAt, since]) {
      const t = Date.parse(at ?? "")
      if (Number.isFinite(t) && t <= Date.now()) return t
    }
    return mountedAt
  }, [startedAt, since, mountedAt])
  const [now, setNow] = useState(() => Date.now())
  const [expanded, setExpanded] = useState(false)
  const cardsId = useId()
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])
  const durationLabel = formatRuntimeElapsed(Math.max(0, now - baseline))
  // The run the shimmer is standing in for (lib/toolActivity.liveToolActivityRun) — the calls history is
  // withholding until the run settles into its `Ran N tool calls` digest. Same collapse and same cards as
  // that digest, so drilling into a run mid-flight shows exactly what it will show afterwards.
  const collapsed = useMemo(() => collapseTools([...(run?.tools ?? [])]), [run])
  const total = collapsed.reduce((n, t) => n + t.count, 0)
  const expandable = total > 0
  // `leading-5` is the meta label's line box (TRANSCRIPT_META_LABEL_CLASS), not decoration: this row
  // is the LIVE member of that column, and a shorter line box put its ink 1px nearer the card above
  // than a settled "Thought for Ns" in the same slot. Sharing the box is what makes the alternation
  // between them read as one rhythm — the tone stays the shimmer's own.
  // The clock is RIGHT-JUSTIFIED against the column edge (maintainer 2026-08-09), so it holds one
  // position instead of sliding with the label. The label alternates between a call's gerund and
  // `Ran N tool calls. Thinking…` every step or two, and a readout hung off its right edge moved a
  // dozen characters on each swap — the one thing on the row whose whole job is to be read at a glance
  // was the one thing that never sat still. `justify-between` also makes `gap-3` a floor rather than
  // the distance, which it only ever was when the label happened to be short.
  //
  // `gap-1.5` INSIDE the label group stays what it was: the chevron is the label's handle, travels with
  // it, and reads as one cluster at ~6.4px of ink. See transcriptMetaChevronClass for why that number
  // is an ink distance and not the CSS one.
  //
  // ONE 20px LINE, the same box as the `Ran N tool calls` digest this row settles into (see
  // MinimalToolActivity). `leading-none` on the clock is what holds it there: at the inherited 20px
  // line height the 12px clock's baseline hung 1px below the label's line box, so this row was 21px,
  // and every settle shifted the tail — and everything above a reader pinned to the bottom — by the
  // difference (measured on real workers, 2026-10-13).
  const rowClass = `group flex min-w-0 items-baseline justify-between gap-3 rounded text-left outline-none focus-visible:ring-1 focus-visible:ring-focus-ink-60 ${TRANSCRIPT_META_LABEL_CLASS}`
  // ONE LINE, always — the row is a live status reading, and a status reading that changes height
  // as a path gets longer makes the whole tail jump. The label TRUNCATES (maintainer 2026-07-31:
  // "prevent the actual gerund from ever breaking onto two lines. It should get truncated
  // instead"); it used to wrap instead, on the argument that breaking a path mid-segment beat
  // clipping it. That trade no longer has to be made: the label is a project-relative path
  // now (see relativeToolPaths), so at any realistic width there is nothing left to clip.
  // The duration keeps `shrink-0 whitespace-nowrap` — it is one value and must never break at its
  // own space, which is exactly how the old `828m 49s` spelling used to put the minutes outside the
  // panel. Two units is now the ceiling (`13h 48m` for that same span; see formatRuntimeElapsed), so
  // the reading is short as well as unbreakable.
  const row = (
    <>
      {/* The chevron is the LABEL's control, so it rides in the label's own group and travels with it to
          the left edge, rather than being stranded beside the right-justified clock. `min-w-0` on both
          this group and the text inside it is what lets the label truncate instead of shoving the clock
          off the row. */}
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="min-w-0 truncate shimmer-text">{activityLabel ?? thinkingToolActivityLabel(total)}</span>
        {/* Only when there is a run to open. The glyph places ITSELF off the text baseline — see
            transcriptMetaChevronClass — so this row needs no alignment of its own. */}
        {expandable && (
          <ChevronRight
            data-working-chevron
            aria-hidden="true"
            size={13}
            className={transcriptMetaChevronClass(expanded)}
          />
        )}
      </span>
      <span className="shrink-0 whitespace-nowrap tabular-nums text-[12px] leading-none text-muted-60">{durationLabel}</span>
    </>
  )
  return (
    <div
      data-working-indicator
      data-working-activity={activityLabel ? "tool" : "generic"}
      className="flex min-w-0 flex-col"
    >
      {expandable
        ? (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              onMouseDown={(e) => e.preventDefault()}
              aria-controls={cardsId}
              aria-expanded={expanded}
              aria-label={`${expanded ? "Collapse" : "Expand"} ${total} tool ${total === 1 ? "call" : "calls"}${activityLabel ? `: ${activityLabel}` : ""}`}
              className={`${rowClass} w-full`}
            >
              {row}
            </button>
          )
        : <div className={rowClass}>{row}</div>}
      {expandable && expanded && (
        <div id={cardsId} className="mt-1.5 flex flex-col">
          {/* `at` is the emitting batch's timestamp — the clock a pending card times itself against, and
              every card in a LIVE run is pending, so it matters more here than in the settled digest. */}
          {withSpacers(collapsed.map((tool, i) => <ToolCardRouter key={i} t={tool} startedAt={run?.at} />), 6)}
        </div>
      )}
      {/* `aria-controls` must resolve even while collapsed — see MinimalToolActivity. */}
      {expandable && !expanded && <div id={cardsId} hidden />}
    </div>
  )
}
