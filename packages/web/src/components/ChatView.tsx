import { createContext, Fragment, memo, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react"
import { createPortal } from "react-dom"
import { useSnapshot } from "valtio"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useVirtualizer } from "@tanstack/react-virtual"
import { AlertTriangle, ArrowDown, ArrowUp, Bot, Check, ChevronRight, FileText, HelpCircle, Hourglass, KeyRound, ListChecks, Loader2, Radar, TerminalSquare, X, type LucideIcon } from "lucide-react"
import { awaitingFenceTitle, parseRecurringPrompt } from "@frizz/shared"
import type { AskQuestion, AwaitingHint, BgShellView, PendingAsk, RegisteredQuestionView, SubAgentView, ThreadView as ThreadViewData, TranscriptEdit, TranscriptMessage, TranscriptPart, TranscriptTodo, TranscriptToolCall } from "@frizz/shared"
import { store, threadBySlug, pushDrawer, pushSubAgentDrawer, pushBackgroundShellDrawer, showToast } from "../store.ts"
import { useBackgroundShellLines, useBoard, useProjectDir, useTranscript, type ChatMessage, type TranscriptData } from "../hooks.ts"
import { rpc } from "../api/rpc.ts"
import { displayTitle, lastActiveLabelAt } from "../groups.ts"
import { stripFrontmatter } from "../lib/markdown.ts"
import { useMarkdownHtml, useInlineMarkdownHtml } from "../lib/useMarkdown.ts"
import { splitComposerValue, splitProseAttachments } from "../lib/imagePaths.ts"
import { localImageUrl } from "../lib/markdownTargets.ts"
import { apiBase } from "../lib/base-path.ts"
import { DiffBlock, PathLink } from "./DiffBlock.tsx"
import { LinkedHtml } from "./LinkedHtml.tsx"
import { CodeBody } from "./CodeBody.tsx"
import { resolveFileLanguage } from "../lib/syntaxHighlight.ts"
import { TodoBlock } from "./TodoBlock.tsx"
import { splitQuestionBlocks, parseQuestionBlock, type QuestionKind, type BlockAnswer, type MessageAnswering } from "../lib/questionBlocks.ts"
import { splitFenceBlocks, type FenceKind } from "../lib/fenceBlocks.ts"
import { showsRegisteredDoneCard } from "../lib/registeredDone.ts"
import { RestedCard, showsRestedCard } from "./RestedCard.tsx"
import { parseAnswersCard, pairAllAnswers, unrenderedAnswers, type PairedAnswer } from "../lib/answersMessage.ts"
import { questionsByAnchor } from "../lib/questionAnchor.ts"
import { fenceStandsFor, registeredStandingAt } from "../lib/questionShadow.ts"
import { FrizzWake } from "./FrizzWake.tsx"
import { RecurringPromptLine } from "./RecurringPromptLine.tsx"
import { LinkifiedText } from "./LinkifiedText.tsx"
import { parseSentContext, splitProseByTokens, tokenLabel, type SentContextItem } from "../lib/composerContext.ts"
import { AnswersCard } from "./AnswersCard.tsx"
import { WakeDivider } from "./WakeDivider.tsx"
import { useLiveAnswering, type LiveAnswering } from "../lib/answering.ts"
import { useIsMobile } from "../lib/mobile.ts"
import { MobileAnswerSheet } from "./MobileAnswerSheet.tsx"
import { sendEagerFollowUp } from "../lib/eagerComposerSubmission.ts"
import { limitResumeClock } from "../lib/activityTime.ts"
import { useUnqueueFollowUp, useUnqueueSupported } from "../lib/unqueueFollowUp.ts"
import { useDeliverQueuedNow, useDeliverQueuedNowSupported } from "../lib/deliverQueuedNow.ts"
import { useInnerHtml } from "../lib/innerHtml.ts"
import { useLocalFileCodeLinks } from "../lib/localFileCode.ts"
import { shouldSubmitStagedEnter } from "../lib/composerKeyboard.ts"
import { lastAskIndex, messagePresentationText } from "../lib/messagePresentation.ts"
import { stampHostFor } from "../lib/stampHost.ts"
import { snoozePresetInstant, formatSnoozeWake } from "../lib/snooze.ts"
import { noteGithubRefs } from "../lib/githubHovercards.ts"
import { ICON_LABEL_NUDGE } from "../lib/iconAlign.ts"
import { prefs } from "../lib/prefs.ts"
import { canAdoptThread } from "../lib/adoption.ts"
import { THREAD_TITLE_MAX_LENGTH, manualThreadTitleSeed, threadTitleToCommit } from "../lib/threadTitle.ts"
import { THREAD_HEADER_CLASS, THREAD_HEADER_CONTROLS_CLASS, THREAD_HEADER_TITLE_CLASS } from "../lib/threadHeaderLayout.ts"
import { ThreadActionBar } from "./ThreadActionBar.tsx"
import { HeaderActions } from "./HeaderActions.tsx"
import { ThreadLifecycleFooter, StateButton } from "./ThreadLifecycleFooter.tsx"
import { AiRenameButton } from "./AiRenameButton.tsx"
import { threadLifecycleAvailability } from "../lib/threadLifecycle.ts"
import { ToolDisclosureHeader } from "./ToolDisclosureHeader.ts"
import { subAgentProfileCell } from "../lib/subAgentProfile.ts"
import { FOREGROUND_MARK_AFTER_MS, foregroundToolIsRunning, hasRunningToolIndicator, isPendingForegroundTool, liveBackgroundOperationState } from "../lib/operationIndicators.ts"
import { formatRuntimeElapsed, formatToolDuration } from "../lib/durationLabels.ts"
import { githubRefUrl } from "../lib/githubRef.ts"
import { useNowMs } from "../lib/liveClock.ts"
import { CHILD_OPEN_TITLE, CHILD_QUIET_SHELL_TITLE, CHILD_RESTED_DOT_CLASS, CHILD_RESTED_TITLE, CHILD_STALE_DOT_CLASS, CHILD_STALE_TITLE, checksCounterLabel, childOpSubtree, mergeBackgroundShells, shellLinesLabel, visibleChildOps, type TranscriptShellRecord } from "../lib/childOps.ts"
import { childOpDismisser } from "../lib/dismissChildOp.ts"
import { agentCompletionCall, subAgentCompletionOutcome } from "../lib/subAgentCompletion.ts"
import { agentReading } from "../lib/agentReading.ts"
import { ChildOpRow } from "./ChildOpRow.tsx"
import { MessageRow, MessageStamp } from "./MessageTimestamp.tsx"
import { TRANSCRIPT_META_LABEL_CLASS, transcriptMetaChevronClass } from "../lib/transcriptMetaLabels.ts"
import { InteractionStack } from "./InteractionCards.tsx"
import { RegisteredQuestionStack } from "./RegisteredQuestionCards.tsx"
// The shared card chrome and THE question card both live in their own modules now, so every
// surface can render them without importing the thread view. QuestionBlockCard in particular is
// shared with the native-AskUserQuestion path, which reaches it through InteractionCards.tsx —
// a file THIS one imports, so the card could not have stayed here without a module cycle.
import { BLOCK_RADIUS, CARD_ACTION_EXPLAINER, CARD_ACTION_RADIUS, CARD_BODY, CARD_LINK, CARD_PRIMARY_ACTION, CARD_PRIMARY_BUTTON, CardActions, CardContent, CardHead, QUEUE_WRAP, TranscriptCard } from "./TranscriptCard.tsx"
import { QuestionBlockCard } from "./QuestionBlockCard.tsx"
import { settledAskView } from "../lib/interactionQuestion.ts"
// ONE frame for every image the chat renders — border, inset mat, centered picture. See its module
// header for why it spans the message width rather than shrink-wrapping each picture.
import { FRAMED_IMAGE, ImageFrame } from "./ImageFrame.tsx"
// The resting card, shared with the queue (TodosView passes it the event-Snooze; these two surfaces
// deliberately pass no action — see the module header).
import { AwaitingBackgroundCard, AwaitingWaitTable, hasAwaitingWaitRows, showsRestingCard, watchStatusLine } from "./AwaitingBackgroundCard.tsx"
import { lastRest } from "../lib/restAnchor.ts"
import { SnoozeCard, showsSnoozeCard } from "./SnoozeCard.tsx"
// Re-exported from their new homes so existing importers (TodosView, the fixtures) keep one
// import path while the definitions live where both question producers can reach them.
export { CARD_BODY, CARD_PRIMARY_BUTTON, CardActions, TranscriptCard } from "./TranscriptCard.tsx"
export { QuestionBlockCard } from "./QuestionBlockCard.tsx"
import { LastActive } from "./LastActive.tsx"
import { CopyTerminalCommandButton, useCopyTerminalCommand } from "./ExternalTerminalCommand.tsx"
import { SignInModal } from "./SignInModal.tsx"
import { PROVIDER_LABEL } from "../lib/signIn.ts"
import { ExpandThreadLink } from "./ExpandThreadLink.tsx"
import { takeFullscreenEnterAnchor } from "../lib/fullscreenHandoff.ts"
import { prependEarlierPage } from "../lib/transcriptPagination.ts"
import { buildVirtualTranscriptMessageRows, earlierLoadGate, nextTailFollow, TAIL_FOLLOW_PX, type VirtualTranscriptMessageRow } from "../lib/virtualTranscript.ts"
import { withoutRedundantRestDividers } from "../lib/restDividers.ts"
import { coalesceToolActivityMessages, editedFileCount, historicalToolActivityMessages, isPictureTool, isSettledAsk, isToolActivityException, liveRuntimeStartedAt, liveToolActivityRun, liveToolActivityTail, settledToolActivityLabel, thinkingToolActivityLabel, toolActivityLabel, toolActivityStampAt } from "../lib/toolActivity.ts"
import { CodexDirectiveCard, MermaidDiagram } from "./CodexRichOutput.tsx"
import { META_CARD_STEP, PICTURE_STEP, STEP, USER_TAIL_EXTRA, VSpace } from "./rhythm.tsx"

// Answer types moved to lib/questionBlocks.ts (shared by the queue card, the thread view, and the
// answering controller). Re-exported here so existing importers keep working.
export type { BlockAnswer, MessageAnswering }

// The thread slug the current message tree belongs to — set by ChatView so a nested AgentBlock can
// resolve its live tracked sub-agent (for the "running Nm" header + drill-in drawer) without threading
// the slug through every intermediate. Null in surfaces that don't provide it (the queue card, a
// sub-agent's own transcript) → AgentBlocks there render as plain (non-live) prompt cards. The QUEUE
// card also provides this now (maintainer 2026-07-15): its sub-agent blocks go live (spinner +
// drill-in) AND its done/awaiting fence cards resolve their thread to show the confirm button.
export const ThreadSlugContext = createContext<string | null>(null)

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

// A QUEUE card provides this so any in-transcript dismissal control — the ```done fence's Mark-as-done
// button, the ```awaiting fence's park button — routes its OWN card through the queue's user-initiated
// exit (fade → auto-scroll the next card to the viewport top) instead of the passive board-departure
// "hold a neighbour in place" path. `dismiss` is exactly the card's `onResolve(slug)`; `cancel` reinstates
// an OPTIMISTICALLY dismissed card (its `onUnresolve(slug)`) when the completion RPC declines — reached
// without threading either through the fence renderer. Null off the queue (the thread drawer), where there
// is no queue to scroll — there the fence buttons behave as before (archive/snooze, no scroll).
export const QueueDismissContext = createContext<{ dismiss: () => void; cancel: () => void } | null>(null)

function isLiveTranscriptBackgroundTool(tool: TranscriptToolCall): boolean {
  return tool.status === "pending" && tool.backgroundState === "background"
}

// Codex's deliberate `yield_control()` shell lifecycle is transcript-native, while the older board
// telemetry still reports bgShells:[]. Present those calls through the EXISTING anchored ops strip and
// remove only their live copy from the conversation. Once a shell resolves, its completed historical
// card returns at its canonical transcript position.
export function transcriptBackgroundShells(messages: readonly ChatMessage[]): (BgShellView & TranscriptShellRecord)[] {
  const shells: (BgShellView & TranscriptShellRecord)[] = []
  for (const message of messages) {
    for (const tool of message.tools) {
      if (!isLiveTranscriptBackgroundTool(tool)) continue
      if (!message.at) continue
      shells.push({
        label: tool.desc ?? tool.detail ?? tool.command ?? "Background command",
        // The projected MESSAGE's instant, which is the only one this side has — and is NOT the launch
        // record's, so it can never be reconciled against the board's row. `launchId` is what does that.
        startedAt: message.at,
        state: "running",
        ...(tool.shellId ? { launchId: tool.shellId } : {}),
        // The reconciliation key for a CODEX shell, whose board row and transcript row share nothing
        // else (see mergeBackgroundShells). Carried separately from `label`, which for a codex row is
        // the model's description of the step rather than the command it ran.
        ...(tool.command ? { command: tool.command } : {}),
      })
    }
  }
  return shells
}

export function withoutLiveTranscriptBackgroundTools(messages: readonly ChatMessage[]): ChatMessage[] {
  return messages.map((message) => {
    if (!message.tools.some(isLiveTranscriptBackgroundTool)) return message
    const tools = message.tools.filter((tool) => !isLiveTranscriptBackgroundTool(tool))
    const parts = message.parts?.map((part) =>
      part.kind === "tools"
        ? { ...part, tools: part.tools.filter((tool) => !isLiveTranscriptBackgroundTool(tool)) }
        : part,
    ).filter((part) => part.kind !== "tools" || part.tools.length > 0)
    return { ...message, tools, parts }
  })
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
export function ThreadView({ slug, onStatusApplied, onClose, virtualized = false, showReturnToQueue = false }: { slug: string; onStatusApplied?: () => void; onClose?: () => void; virtualized?: boolean; showReturnToQueue?: boolean }) {
  const board = useBoard()
  const thread = threadBySlug(board, slug)
  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <ThreadHeader slug={slug} onStatusApplied={onStatusApplied} onClose={onClose} showReturnToQueue={showReturnToQueue} />
      <ChatView slug={slug} virtualized={virtualized} />
      {thread && <ThreadLifecycleFooter thread={thread} sticky safeArea onArchived={onStatusApplied} />}
    </div>
  )
}

function ChatView({ slug, virtualized }: { slug: string; virtualized: boolean }) {
  const board = useBoard()
  const thread = threadBySlug(board, slug)
  const running = thread?.runtime === "running" || thread?.runtime === "spawning"
  const copyTerminalCommand = useCopyTerminalCommand(slug)

  // Freshness is centrally managed (transcript-live.ts keeps every observed transcript live); `poll`
  // only gates the SSE-fallback interval for a running thread.
  const q = useTranscript(slug, { poll: running })
  const queryClient = useQueryClient()
  const loadingEarlierRef = useRef(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [earlierError, setEarlierError] = useState<string | null>(null)
  // Raw server order — each message renders its `parts` in block order (fidelity). Memoized so
  // useLiveAnswering's `liveMsg` identity check compares objects from THIS same list.
  const messages = useMemo(() => q.data?.messages ?? [], [q.data])
  const liveTranscriptShells = useMemo(() => transcriptBackgroundShells(messages), [messages])
  const presentationMessages = useMemo(() => withoutLiveTranscriptBackgroundTools(messages), [messages])
  // Cut over presentationMessages, not messages: the coalesced entries below carry a messageIndex into
  // THIS list, and comparing the two index spaces is how a live fence gets marked settled.
  const lastAgentIdx = useMemo(() => lastAssistantIndex(presentationMessages), [presentationMessages])
  // WHERE THE AWAITING CARD LIVES: at the last REST, not under the last message (lib/restAnchor). While
  // the worker is running past a rest — the human bumped it, or the shell it named woke it — the fence
  // it rested on stays live and a fenceless rest keeps its card, until it rests again. At rest the two
  // cuts agree, and the message one is kept because the resting card at the tail keys on lastAgentIdx —
  // as it is when the rest anchors above the loaded window (index -1): nothing in the window is the
  // message the worker rested on, so nothing in it holds the card either.
  const rest = useMemo(() => (running ? lastRest(presentationMessages) : undefined), [running, presentationMessages])
  const awaitingCut = rest && rest.index >= 0 ? rest.index : lastAgentIdx
  // Presentation-only coalescing: provider batching must not mint one loader per pure tool turn.
  // Original indices ride beside the display message so paired answers continue to
  // address server truth, never the compacted array.
  const coalescedActivityMessages = useMemo(() => coalesceToolActivityMessages(presentationMessages), [presentationMessages])
  // The run the shimmer stands for, and its newest call (the one it NAMES). The run is what expanding
  // the shimmer opens — the same calls history is withholding.
  const liveToolRun = running ? liveToolActivityRun(coalescedActivityMessages) : undefined
  const liveToolActivity = running ? liveToolActivityTail(coalescedActivityMessages) : undefined
  const liveActivityLabel = liveToolActivity ? toolActivityLabel(liveToolActivity, board?.projectDir) : undefined
  // What the runtime slot's clock counts from — this stretch of work, not the turn. See liveRuntimeStartedAt.
  const liveRuntimeStart = running ? liveRuntimeStartedAt(coalescedActivityMessages) : undefined
  // A live tool run belongs in the existing bottom runtime slot, never in transcript history. Once
  // it settles, the whole coalesced run returns as one `Ran N tool calls` disclosure.
  //
  // …and the rest hairlines that only restate their own surroundings drop out here — see
  // isRedundantRestDivider. It runs LAST, on the coalesced list, so "the next thing the reader sees"
  // means the next thing this surface will actually draw.
  //
  // `restingShown` is the third reason a fence draws nothing (see rendersNothingIn): the resting card at
  // the tail states the last message's wait, so that message's fence block is skipped — and a message
  // that was ONLY the fence renders nothing, which the spacer walk has to know.
  const restingShown = showsRestingCard(thread)
  const activityMessages = useMemo(() => {
    const entries = running ? historicalToolActivityMessages(coalescedActivityMessages) : coalescedActivityMessages
    return withoutRedundantRestDividers(entries, rendersNothingIn(entries, awaitingCut, restingShown))
  }, [coalescedActivityMessages, running, awaitingCut, restingShown])
  const showWorking = running
  // Question↔answer pairing for "Answers:" user messages, precomputed at the LIST level (the lookback
  // needs the whole list; Message renders per-message). null — a stable primitive — at every ordinary
  // index, so the memoized Message only sees a `paired` prop change on actual answers-messages.
  const paired = useMemo(() => pairAllAnswers(messages), [messages])
  // What the human's in-flight answer still has to SAY — the rows of it no message above is already
  // drawing, so the pinned card stands down instead of doubling one the transcript now carries itself.
  const inFlightAnswers = useMemo(() => unrenderedAnswers(messages, thread?.answersInFlight), [messages, thread?.answersInFlight])
  // The CURRENT ASK — the human's most recent landed turn (see lastAskIndex for what is excluded and
  // why); it supplies the retry text after a provider fault. -1 when the transcript has no human turn yet.
  const lastUserIdx = useMemo(() => lastAskIndex(messages), [messages])
  // A completion the worker REGISTERED rather than fenced: the last rung of the ladder below, drawn here
  // because no message carries it (lib/registeredDone). Keyed on the final assistant message so a worker
  // that also wrote the fence gets one card, from the message, not two.
  const registeredDone = showsRegisteredDoneCard(thread, lastAgentIdx >= 0 ? presentationMessages[lastAgentIdx]?.text : undefined)
  // The RESIDUAL rung: a rest that carries no other card at all (RestedCard). Same final-message key.
  const restedCard = showsRestedCard(thread, lastAgentIdx >= 0 ? presentationMessages[lastAgentIdx]?.text : undefined)
  // Everything the runtime-status ladder needs that it cannot work out itself — see runtimeStatusRung.
  const runtimeStatus: RuntimeStatusState = { thread, showWorking, registeredDone, restedCard }
  // Question-block interactivity in the thread view: EVERY ask stays answerable, wherever it sits —
  // scroll back to a question a sub-agent return / the agent's own continuation buried and answer it in
  // place. answeringForMessage wires each ask's chips AND its own bottom Send button (scoped to just
  // that message's blocks). The queue card runs the identical scope through the same controller.
  const { answeringForMessage } = useLiveAnswering(slug, messages)
  // The registered questions standing at each message — its rest and every later one — so a fence
  // restating or naming one folds into its card.
  const shadowedByMessage = useMemo(() => registeredStandingAt(messages, thread?.questions ?? []), [messages, thread?.questions])
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
  // The thread view's tail is held until the transcript window has loaded — see the eager branch below.
  const tailReady = !q.isLoading
  // The EAGER (non-virtualized) fallback's own tail follow. No production surface reaches it — both
  // ThreadView callers virtualize, and this branch only renders when `count === 0` besides — but it shares
  // the SAME `[overflow-anchor:none]` scroller, so its band must not disagree with the virtualized path's:
  // at the 240px it used to carry, a third of a pane, a reader who scrolled up to re-read was hauled back
  // to the bottom by the next append. One constant, one meaning of "at the tail".
  useEffect(() => {
    if (virtualized) return
    const scroller = transcriptRef.current
    if (scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= TAIL_FOLLOW_PX) scroller.scrollTop = scroller.scrollHeight
  }, [count, running, virtualized])

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
      const earlier = await rpc.threadTranscriptEarlier({ slug, cursor })
      const latest = queryClient.getQueryData<TranscriptData>(["transcript", slug])
      if (!latest?.transcriptKey || latest.transcriptKey !== expectedKey || earlier.transcriptKey !== expectedKey) {
        await q.refetch()
        showToast("Transcript changed while loading history; refreshed the current session")
        return
      }
      queryClient.setQueryData(["transcript", slug], prependEarlierPage(latest as Parameters<typeof prependEarlierPage>[0], earlier))
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load earlier transcript history"
      setEarlierError(message)
    } finally {
      loadingEarlierRef.current = false
      setLoadingEarlier(false)
    }
  }, [q, queryClient, slug])

  return (
    <ThreadSlugContext.Provider value={slug}>
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
        data-virtualized-transcript-scroll={virtualized || undefined}
        tabIndex={virtualized ? 0 : undefined}
        role={virtualized ? "region" : undefined}
        aria-label={virtualized ? "Thread conversation" : undefined}
        aria-busy={virtualized && loadingEarlier ? true : undefined}
        // pb-3 is the transcript viewport's OWN bottom air, on the scroller rather than on either
        // content path: the virtualized transcript sizes its content div to the virtualizer's exact
        // totalSize (no room for a trailing pad there), and the eager path's column already carries
        // py-5, so putting it here is the one place both paths end up with the same gap to the
        // non-scrolling composer footer. 20px of trailing space read as the last row crowding the
        // prompt box; 32px reads as an ending.
        className="relative min-h-0 flex-1 overflow-y-auto pb-3 outline-none [overflow-anchor:none] focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-fg/60"
      >
      {virtualized && count > 0 ? (
        <VirtualizedThreadTranscript
          slug={slug}
          transcriptRef={transcriptRef}
          transcriptKey={q.data?.transcriptKey}
          messages={presentationMessages}
          paired={paired}
          inFlightAnswers={inFlightAnswers}
          answeringForMessage={answeringForMessage}
          thread={thread}
          running={running}
          copyTerminalCommand={copyTerminalCommand}
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
        <div
          data-transcript-sync-fallback
          className={`mx-6 mt-3 flex flex-wrap items-center gap-2.5 ${BLOCK_RADIUS} border border-border-strong bg-panel-2 px-4 py-2.5 text-[12px]`}
          title={q.transportFallback.kind === "payload-too-large"
            ? `Live payload ${q.transportFallback.actualBytes} bytes; socket limit ${q.transportFallback.maxBytes} bytes`
            : `Transcript read budget reached (${q.transportFallback.scope}); retry after about ${q.transportFallback.retryAfterMs}ms`}
        >
          <AlertTriangle size={13} className="shrink-0 text-muted" />
          <div className="min-w-[180px] flex-1 leading-snug text-fg/85">
            <span className="font-medium">Live transcript updates paused.</span>{" "}
            {q.transportFallback.kind === "payload-too-large"
              ? "The transcript is too large for push; the last complete HTTP-loaded copy remains visible."
              : "The live read budget was reached; the last complete copy remains visible. Retry in a moment."}
          </div>
          <button
            type="button"
            disabled={q.isFetching}
            onClick={() => void q.refetch()}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-fg/90 transition-colors hover:bg-panel disabled:opacity-40"
          >
            {q.isFetching ? "Refreshing…" : "Refresh once"}
          </button>
          <button
            type="button"
            onClick={q.retryLiveUpdates}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-fg/90 transition-colors hover:bg-panel"
          >
            Retry live
          </button>
        </div>
      )}
      {/* No flex GAP: between-message spacing is adjacency-based explicit spacers (two tool-only
          messages → the tight 6px run; anything involving prose/a bubble/an event → STEP 14px), so a
          tool-card column reads uniformly no matter how the turns were chunked. */}
      {/* data-transcript-column marks a stack of messages whose rhythm comes from withMessageSpacers.
          Every such column is gap-less by construction; the marker is what the spacing e2e measures. */}
      <div data-transcript-column className="flex min-h-full flex-col px-6 py-5">
        {count === 0 ? (
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
        ) : (
          <>
            {withMessageSpacers(
              activityMessages.map((entry) => entry.message),
              (m, i) => {
                const messageIndex = activityMessages[i].messageIndex
                return (
                  <Message
                    key={i}
                    m={m}
                    answering={answeringForMessage(m)}
                    showSendButton
                    paired={paired[messageIndex]}
                    staleAwaiting={awaitingCut >= 0 && messageIndex < awaitingCut}
                    restingCardShown={messageIndex === lastAgentIdx && restingShown}
                    restedAt={rest && messageIndex === rest.index ? rest.at ?? "" : undefined}
                    shadowedBy={shadowedByMessage.get(messageIndex)}
                    thread={thread}
                  />
                )
              },
              // QUEUED (optimistic, not-yet-in-the-log) messages are pinned to the very BOTTOM
              // (rendered after the working/pending indicators, below) — not interleaved here.
              (m) => !!m.queued,
            )}
            {/* THE RUNTIME-STATUS SLOT, through the one ladder the virtualized path draws too — see
                runtimeStatusRung. The gate, the spacing and the rungs are all that one answer, so this
                path cannot disagree with the other about which card a thread gets.
                NOT BEFORE THE TRANSCRIPT, though: this branch is what renders while the window is still
                loading (count === 0 on both production callers), so without the hold it drew the whole
                ladder — the resting card above all — alone at the top of an empty pane and then replaced
                it with the transcript a beat later. The tail describes the END of the transcript and
                mounts with it, exactly as the queue card holds its tail (TodosView). */}
            {tailReady && runtimeStatusRung(runtimeStatus) !== null && (
              <VSpace h={runtimeStatusGapFor(runtimeStatus, activityMessages.map((entry) => entry.message))} />
            )}
            {tailReady && (
              <RuntimeStatusLadder
                state={runtimeStatus}
                slug={slug}
                retryText={lastUserIdx >= 0 ? messages[lastUserIdx]?.text : undefined}
                onTerminal={copyTerminalCommand}
                liveRuntimeStart={liveRuntimeStart}
                liveActivityLabel={liveActivityLabel}
                liveToolRun={liveToolRun}
              />
            )}
            {/* SIBLING of the chain above, not a branch in it. Those are mutually exclusive because they
                all describe the ONE thing currently blocking; a policy denial already happened and
                blocks nobody now, so it can coexist and must not compete for the same slot. */}
            {thread?.permPolicy ? (
              <div className="mt-3">
                <PermPolicyDenialCard policy={thread.permPolicy} denies={thread.permDenies} />
              </div>
            ) : null}
            {/* No thread-level Send button anymore: each question-bearing message renders its OWN bottom
                Send button (Message's showSendButton), scoped to just that message's blocks (each block's
                Enter also submits that message). Answering is now one message at a time by design. */}
            {/* QUEUED (optimistic) messages pinned to the VERY BOTTOM — below the working/pending
                indicators — until the server echoes them into the transcript (maintainer 2026-07-09:
                "queued messages render underneath everything until they become un-queued and show up
                in the logs"). mergeOptimistic keeps them at the tail of `messages`; here they render
                as a group after everything. Once confirmed, the optimistic copy is consumed and the
                real message renders in its natural place above. */}
            {messages.some((m) => m.queued) && <VSpace />}
            {/* flex flex-col MIRRORS the parent scroll container (line ~162) so each Message root's
                `self-end` engages here exactly as it does for a landed message. Without it this group
                is a plain block, self-end is inert, and a multi-line bubble stretches to 85% and floats
                center-right — the center-then-snap-right jump on materialize.
                gap-3.5 = 14px = STEP (Tailwind can't reference the JS const — keep it in sync by hand):
                successive queued sends carry the same rhythm as any other pair. The gap is STRUCTURAL
                rather than an `mt` keyed off `messages[i-1].queued` — that adjacency test failed
                whenever a message this pass SKIPS (an event, anything messageRendersNothing) sat
                between two queued sends, butting the two bubbles together. */}
            <div className="flex flex-col gap-3.5">
              {messages.map((m, i) => (m.queued ? <Message key={`q${i}`} m={m} paired={paired[i]} /> : null))}
            </div>
          </>
        )}
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
      {/* Prompt box FIRST, then the background-ops strip UNDERNEATH it at the very bottom (maintainer
          2026-07-09): running sub-agents / shells / monitors sit below the composer, not above it. */}
      {/* ONE hairline, at the queue card's weight. `border-border/60` is exactly the rule the queue
          card draws under its header (TodosView); the chat footer used to draw full-strength
          `border-border` AND have ThreadActionBar draw a second one under it, which stacked into a
          2px rule. Keep the separator on THIS wrapper only — the bar inside is padding-only. */}
      <div data-thread-chat-footer className="z-10 shrink-0 border-t border-border/60 bg-panel">
        <ThreadActionBar
          slug={slug}
          onTerminal={copyTerminalCommand}
          ops={<BackgroundOpsStrip slug={slug} transcriptShells={liveTranscriptShells} className="px-1 pt-1.5" />}
        />
      </div>
    </div>
    </ThreadSlugContext.Provider>
  )
}

// How long after a wheel/touch/key gesture the reader still owns the scroller. Long enough to cover
// trackpad momentum between discrete events, short enough that it never outlives the gesture itself.
const READER_GESTURE_MS = 700

// How long an anchor restore (a pin move, a head trim) owns the scroller while the rows it disturbed
// settle. The settling lands on a ResizeObserver pass one or more frames after the commit, so the restore
// has to outlive the commit — but it must stay far under READER_GESTURE_MS, since a reader who scrolls
// during it should win the moment it ends.
const ANCHOR_RESTORE_MS = 250

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
type VirtualThreadRow =
  // A zero-height sentinel that is ALWAYS row 0, so `getItemKey(0)` is a constant for the list's whole
  // life. That is load-bearing, not decoration — see the head-trim realignment below, which is only
  // correct while TanStack's own `anchorTo:"end"` preservation stays dormant. It renders nothing.
  | { key: "head-anchor"; kind: "head-anchor" }
  | { key: "interactions"; kind: "interactions" }
  // A REGISTERED question, dropped at the REST IT WAS ASKED AT rather than at the tail — see
  // lib/questionAnchor. Its own row because it belongs BETWEEN two messages, which the tail cannot be.
  | { key: string; kind: "questions"; questions: RegisteredQuestionView[] }
  | { key: "transport-fallback"; kind: "transport-fallback" }
  | { key: string; kind: "earlier-history" }
  | ({ kind: "message"; stampAt: string | undefined } & VirtualTranscriptMessageRow)
  | { key: "runtime-status"; kind: "runtime-status" }
  | { key: string; kind: "queued"; message: ChatMessage; messageIndex: number; gap: number }

// THE RUNTIME-STATUS LADDER — ONE slot at the transcript's end, nine mutually exclusive rungs, hardest
// reading first, and ONE renderer for all of it.
//
// The transcript draws this slot from two places: the virtualized path's `runtime-status` row, and the
// eager path in ChatView (reachable at count === 0, where there is no virtualizer to hang a row on).
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
type RuntimeStatusRung = "provider-fault" | "limit-pause" | "pending-ask" | "perm-prompt" | "working" | "snooze" | "resting" | "registered-done" | "rested"

/** What each caller knows that the ladder cannot work out for itself. `registeredDone`/`restedCard` are
 *  keyed on the final assistant message, which each path computes off its own list. */
interface RuntimeStatusState {
  thread: ThreadViewData | undefined
  showWorking: boolean
  registeredDone: boolean
  restedCard: boolean
}

/** The safety-net readout for a session frozen at a native AskUserQuestion — "answer it in your external
 *  terminal". That is the WRONG thing to say once frizz OWNS the question: the broker path journals the
 *  same tool call as an answerable interaction, which renders as a question card in the transcript, and
 *  pointing the operator at a terminal while an answerable copy sits on screen is worse than saying
 *  nothing. So the net stands down whenever this thread has a pending interaction, and still covers the
 *  sessions it exists for — pre-contract, adopted, or foreign threads that reach the tool with no broker
 *  to intercept it. */
function frozenPendingAsk(thread: ThreadViewData | undefined): PendingAsk | undefined {
  return thread?.pendingInteraction ? undefined : thread?.pendingAsk
}

/** WHICH RUNG WINS, or null when the slot draws nothing at all. The order is the ladder: a provider auth
 *  fault outranks everything (nothing in the thread can make progress until the credential is restored),
 *  a frozen ask outranks the generic perm banner and the Working… spinner, the human's own park outranks
 *  the benign resting card, and `rested` is the residual. Background sub-agents and shells are NOT here:
 *  they live in the anchored ops strip, which stays visible mid-turn. */
function runtimeStatusRung({ thread, showWorking, registeredDone, restedCard }: RuntimeStatusState): RuntimeStatusRung | null {
  if (thread?.providerFault && !thread.foreign) return "provider-fault"
  if (thread?.limitPause && !thread.foreign) return "limit-pause"
  if (frozenPendingAsk(thread)) return "pending-ask"
  if (thread?.runtime === "perm-prompt") return "perm-prompt"
  if (showWorking) return "working"
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
function runtimeStatusGapFor(state: RuntimeStatusState, messages: readonly ChatMessage[]): number {
  return runtimeStatusRung(state) === "working" ? workingIndicatorGap(messages) : STEP
}

function RuntimeStatusLadder({
  state,
  slug,
  retryText,
  onTerminal,
  liveRuntimeStart,
  liveActivityLabel,
  liveToolRun,
}: {
  state: RuntimeStatusState
  slug: string
  /** The human's last ask, for the fault card's retry. */
  retryText: string | undefined
  onTerminal: () => void
  liveRuntimeStart: string | undefined
  liveActivityLabel: string | undefined
  liveToolRun: { tools: readonly TranscriptToolCall[]; at?: string } | undefined
}) {
  const thread = state.thread
  switch (runtimeStatusRung(state)) {
    case "provider-fault":
      return <ProviderFaultCard slug={slug} sessionId={thread!.sessionId} fault={thread!.providerFault!} retryText={retryText} />
    case "limit-pause":
      return <LimitPauseCard slug={slug} sessionId={thread!.sessionId} pause={thread!.limitPause!} />
    case "pending-ask":
      return <PendingAskCard ask={frozenPendingAsk(thread)!} onTerminal={onTerminal} />
    case "perm-prompt":
      return <PermPromptBanner onTerminal={onTerminal} />
    case "working":
      return <WorkingIndicator since={thread?.lastUserAt} startedAt={liveRuntimeStart} activityLabel={liveActivityLabel} run={liveToolRun} />
    case "snooze":
      return <SnoozeCard thread={thread!} />
    case "resting":
      return <AwaitingBackgroundCard thread={thread!} />
    // THE THREAD'S OWN ENDING, for a sign-off that came in as a tool call rather than a fence: the same
    // card the fence draws, in the slot the fence would have occupied at the transcript's end. Below
    // everything because `done` refuses while anything above could still be true — an open question or an
    // armed watch blocks the verb — so a thread showing this is at rest with nothing left to wait on.
    case "registered-done":
      return <FenceCard fenceKind="done" body={thread!.lastFence!.body} hints={[]} />
    // NOTHING ELSE APPLIES, and the bottom of the thread still has to say so — see RestedCard.
    case "rested":
      return <RestedCard thread={thread!} />
    default:
      return null
  }
}

function VirtualizedThreadTranscript({
  slug,
  transcriptRef,
  transcriptKey,
  messages,
  paired,
  inFlightAnswers,
  answeringForMessage,
  thread,
  running,
  copyTerminalCommand,
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
}: {
  slug: string
  transcriptRef: React.RefObject<HTMLDivElement | null>
  transcriptKey?: string
  messages: ChatMessage[]
  paired: (PairedAnswer[] | null)[]
  // Computed by the parent off the SAME list — the in-flight answer's rows this transcript is not
  // already drawing. See unrenderedAnswers.
  inFlightAnswers: PairedAnswer[] | null
  answeringForMessage: LiveAnswering["answeringForMessage"]
  thread: ThreadViewData | undefined
  running: boolean
  copyTerminalCommand: () => void
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
}) {
  const projectDir = useProjectDir()
  const coalescedActivityMessages = useMemo(() => coalesceToolActivityMessages(messages), [messages])
  // See the drawer's copy above: the run backs the shimmer's expansion, its newest call names it.
  const liveToolRun = running ? liveToolActivityRun(coalescedActivityMessages) : undefined
  const liveToolActivity = running ? liveToolActivityTail(coalescedActivityMessages) : undefined
  const liveActivityLabel = liveToolActivity ? toolActivityLabel(liveToolActivity, projectDir) : undefined
  const liveRuntimeStart = running ? liveRuntimeStartedAt(coalescedActivityMessages) : undefined
  const lastAgentIdx = useMemo(() => lastAssistantIndex(messages), [messages])
  // The rest the awaiting card belongs to — see the drawer's copy above.
  const rest = useMemo(() => (running ? lastRest(messages) : undefined), [running, messages])
  const awaitingCut = rest && rest.index >= 0 ? rest.index : lastAgentIdx
  // Redundant rest hairlines dropped exactly as in the drawer's copy above, with the same third
  // draws-nothing reason (the resting card stating the last message's fence).
  const restingShown = showsRestingCard(thread)
  const activityMessages = useMemo(() => {
    const entries = running ? historicalToolActivityMessages(coalescedActivityMessages) : coalescedActivityMessages
    return withoutRedundantRestDividers(entries, rendersNothingIn(entries, awaitingCut, restingShown))
  }, [coalescedActivityMessages, running, awaitingCut, restingShown])
  const showWorking = running
  const messageRows = useMemo(() => {
    return buildVirtualTranscriptMessageRows(
      activityMessages.map((entry) => entry.message),
      rendersNothingIn(activityMessages, awaitingCut, restingShown),
      messageGap,
    ).map((row) => {
      const entry = activityMessages[row.messageIndex]
      return { ...row, messageIndex: entry.messageIndex, stampAt: toolActivityStampAt(entry) }
    })
  }, [activityMessages, awaitingCut, restingShown])
  const lastUserIdx = useMemo(() => lastAskIndex(messages), [messages])
  // A completion the worker REGISTERED rather than fenced: the last rung of the ladder below, drawn here
  // because no message carries it (lib/registeredDone). Keyed on the final assistant message so a worker
  // that also wrote the fence gets one card, from the message, not two.
  const registeredDone = showsRegisteredDoneCard(thread, lastAgentIdx >= 0 ? messages[lastAgentIdx]?.text : undefined)
  // The RESIDUAL rung: a rest that carries no other card at all (RestedCard). Same final-message key.
  const restedCard = showsRestedCard(thread, lastAgentIdx >= 0 ? messages[lastAgentIdx]?.text : undefined)
  // Everything the runtime-status ladder needs that it cannot work out itself — see runtimeStatusRung.
  // The row EXISTS when some rung wins, and its own gap is that same answer: the eager path derives both
  // from the identical call, so the two cannot disagree about which card this thread gets.
  const runtimeStatus: RuntimeStatusState = { thread, showWorking, registeredDone, restedCard }
  const hasRuntimeStatus = runtimeStatusRung(runtimeStatus) !== null
  // The deps are runtimeStatus's FIELDS, not the object: it is a fresh literal every render.
  const runtimeStatusGap = useMemo(
    () => runtimeStatusGapFor({ thread, showWorking, registeredDone, restedCard }, activityMessages.map((entry) => entry.message)),
    [activityMessages, showWorking, thread, registeredDone, restedCard],
  )
  // EVERY OPEN QUESTION, at the thread's CURRENT rest while it is at rest, and at the rest it was asked
  // at while it is mid-flight (mid-prose placement is retired — see lib/questionShadow). Passing
  // `atRest` is what keeps a question the human replied PAST from stranding above their reply while the
  // worker's newest handoff reads as a bare stop: at rest the tail is the rest that owes them the ask.
  // `byRow` keys into
  // `messageRows` (the coalesced list actually rendered, which drops messages the transcript does not
  // draw), so the group hangs off the last row at or before its anchor; -1 means the rest is older than
  // the loaded window and it goes above everything rather than back at the bottom, lying about being
  // current. `tail` is the ordinary case — the worker asked and rested — and keeps the placement this
  // had before.
  const questionGroups = useMemo(() => {
    const tail: RegisteredQuestionView[] = []
    const byRow = new Map<number, RegisteredQuestionView[]>()
    const tailAnchor = messages.length - 1
    for (const [anchor, group] of questionsByAnchor(messages, thread?.questions ?? [], { atRest: !running })) {
      if (anchor >= tailAnchor) { tail.push(...group); continue }
      let rowIdx = -1
      for (let i = 0; i < messageRows.length; i++) {
        if (messageRows[i].messageIndex > anchor) break
        rowIdx = i
      }
      const at = byRow.get(rowIdx)
      if (at) at.push(...group)
      else byRow.set(rowIdx, [...group])
    }
    return { byRow, tail }
  }, [messageRows, messages, running, thread?.questions])
  // The same rows, keyed by message index, for the fold: a fence restating or naming a registration
  // standing at that message draws nothing of its own (lib/questionShadow).
  const shadowedByMessage = useMemo(() => registeredStandingAt(messages, thread?.questions ?? []), [messages, thread?.questions])

  const rows = useMemo<VirtualThreadRow[]>(() => {
    const next: VirtualThreadRow[] = [{ key: "head-anchor", kind: "head-anchor" }]
    if (transportFallback) next.push({ key: "transport-fallback", kind: "transport-fallback" })
    if (hasEarlier || loadingEarlier || earlierError) {
      next.push({ key: `earlier-history:${beforeCursor ?? "complete"}`, kind: "earlier-history" })
    }
    const before = questionGroups.byRow.get(-1)
    if (before) next.push({ key: "questions:head", kind: "questions", questions: before })
    messageRows.forEach((row, i) => {
      next.push({ ...row, kind: "message" as const })
      const group = questionGroups.byRow.get(i)
      if (group) next.push({ key: `questions:${row.key}`, kind: "questions", questions: group })
    })
    // THE ASK GOES AT THE TAIL. It was row 0 until 2026-08-02, which put an answerable card ABOVE the
    // operator's own first message — a transcript scrolled to its end (this list anchors there) left it
    // 5,000px up and unmounted by the virtualizer, so a thread blocked on a question rendered as nothing
    // but a tool call that never finished. It belongs where the block actually happened: after the last
    // message, above the runtime status and the queued sends that are stuck behind it.
    next.push({ key: "interactions", kind: "interactions" })
    if (hasRuntimeStatus) next.push({ key: "runtime-status", kind: "runtime-status" })
    let queuedGap = hasRuntimeStatus || messageRows.length > 0 ? STEP : 0
    messages.forEach((message, messageIndex) => {
      if (!message.queued) return
      const key = `queued:${message.deliveryId ?? message.sourceId ?? messageIndex}`
      next.push({ key, kind: "queued", message, messageIndex, gap: queuedGap })
      queuedGap = STEP
    })
    return next
  }, [beforeCursor, earlierError, hasEarlier, hasRuntimeStatus, loadingEarlier, messageRows, messages, questionGroups, transportFallback])

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => transcriptRef.current,
    getItemKey: (index) => rows[index]?.key ?? index,
    estimateSize: (index) => {
      const row = rows[index]
      if (!row) return 80
      if (row.kind === "head-anchor" || row.kind === "interactions") return 1
      if (row.kind === "earlier-history") return 42
      if (row.kind === "transport-fallback") return 76
      if (row.kind === "runtime-status") return 54
      if (row.kind === "questions") return 220
      return row.kind === "message" ? 108 + row.gap : 82 + row.gap
    },
    overscan: 8,
    paddingStart: 20,
    paddingEnd: 20,
    anchorTo: "end",
    followOnAppend: true,
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
  const readerScrollUntilRef = useRef(0)
  // The virtualizer's total-size box. Its height IS getTotalSize(), so observing it catches every way
  // the transcript can grow: a row inserted at its estimate, and each later measurement correction.
  const contentRef = useRef<HTMLDivElement>(null)
  const tailReadyRef = useRef(false)
  const readerMovedRef = useRef(false)
  const nearTopLoadArmedRef = useRef(true)
  const pendingPrependAnchorRef = useRef<{ rowKey: string; viewportTop: number } | null>(null)
  const initialTranscriptKeyRef = useRef<string | undefined>(undefined)
  // THE HEAD TRIM (see the layout effect below). `readerAnchorRef` is refreshed at the END of every
  // tail-follow pass, so a layout effect that runs BEFORE that pass still reads the PREVIOUS commit's
  // position — which is exactly the place a head trim has to put the reader back.
  const readerAnchorRef = useRef<{ rowKey: string; viewportTop: number } | null>(null)
  const firstMessageKeyRef = useRef<string | undefined>(undefined)
  const anchorRestoreUntilRef = useRef(0)

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
    let frame = requestAnimationFrame(() => {
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

  useLayoutEffect(() => {
    const anchor = pendingPrependAnchorRef.current
    const scroller = transcriptRef.current
    if (!anchor || !scroller || loadingEarlier) return
    const alignAnchor = () => {
      const anchoredRow = Array.from(scroller.querySelectorAll<HTMLElement>("[data-transcript-row-key]"))
        .find((element) => element.dataset.transcriptRowKey === anchor.rowKey)
      if (!anchoredRow) return
      const nextTop = anchoredRow.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      scroller.scrollTop += nextTop - anchor.viewportTop
    }
    // Dynamic markdown/tool rows settle after TanStack's ResizeObserver measurement. Correct once
    // synchronously and across the next two frames so the same message stays under the reader's eye.
    alignAnchor()
    let secondFrame = 0
    const firstFrame = requestAnimationFrame(() => {
      alignAnchor()
      secondFrame = requestAnimationFrame(() => {
        alignAnchor()
        if (pendingPrependAnchorRef.current === anchor) pendingPrependAnchorRef.current = null
      })
    })
    return () => {
      cancelAnimationFrame(firstFrame)
      cancelAnimationFrame(secondFrame)
    }
  }, [loadingEarlier, messageRows.length, transcriptRef])

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
      following: followingTailRef.current,
      readerMoved: performance.now() < readerScrollUntilRef.current,
    })
    followingTailRef.current = next.following
    if (next.scrollTop !== null) scroller.scrollTop = next.scrollTop
    tailHeightRef.current = scroller.scrollHeight
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
    return () => observer.disconnect()
  }, [syncTailFollow])

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
      if (!["ArrowUp", "PageUp", "Home", " "].includes(event.key)) return
      if (scroller.scrollTop <= 480) nearTopLoadArmedRef.current = true
      markReaderIntent()
    }
    const markWheelIntent = (event: WheelEvent) => {
      if (event.deltaY < 0 && scroller.scrollTop <= 480) nearTopLoadArmedRef.current = true
      markReaderIntent()
    }
    const markTouchIntent = () => {
      if (scroller.scrollTop <= 480) nearTopLoadArmedRef.current = true
      markReaderIntent()
    }
    scroller.addEventListener("scroll", inspect, { passive: true })
    scroller.addEventListener("wheel", markWheelIntent, { passive: true })
    scroller.addEventListener("touchstart", markTouchIntent, { passive: true })
    scroller.addEventListener("touchmove", markTouchIntent, { passive: true })
    scroller.addEventListener("pointerdown", markReaderIntent, { passive: true })
    scroller.addEventListener("keydown", markKeyboardIntent)
    const frame = requestAnimationFrame(inspect)
    return () => {
      cancelAnimationFrame(frame)
      scroller.removeEventListener("scroll", inspect)
      scroller.removeEventListener("wheel", markWheelIntent)
      scroller.removeEventListener("touchstart", markTouchIntent)
      scroller.removeEventListener("touchmove", markTouchIntent)
      scroller.removeEventListener("pointerdown", markReaderIntent)
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
            // `hover:z-[1]` is what lets a row's hover-revealed timestamp (MessageRow) survive being
            // drawn past this row's own bottom edge. Every row here is transform-positioned, so each
            // is its OWN stacking context and a z-index INSIDE one cannot lift anything above the
            // next row — among siblings at z-auto, the later one always wins. The reveal sits in the
            // gap below its message, and that gap is as little as META_CARD_STEP (6px) against a
            // 16px reading, so without this the reading is painted under the following row exactly
            // on the tight rows where it overflows most.
            //
            // ONE, not the 20 this first shipped with. The pinned current-ask row thirty lines up is a
            // SIBLING in this same container at `z-[9]`, and that 9 is the only thing holding it above
            // the scrolling transcript. At 20 a hovered row painted OVER the pinned card — and since the
            // band is click-through everywhere except its bubble, a pointer resting in its transparent
            // strip hovered the row behind it, which then covered the bubble's own rectangle and
            // swallowed hover-to-expand. 1 is both sufficient and 9-safe: a transform-positioned sibling
            // participates in the parent as if `z-index: 0` whatever its DOM order, so any positive
            // value beats it.
            className="absolute left-0 top-0 w-full hover:z-[1]"
            style={{ transform: `translateY(${virtualRow.start}px)` }}
          >
            {row.kind === "head-anchor" ? null
            : row.kind === "interactions" ? (
              <>
                <InteractionStack thread={thread} className="px-6 pt-5" autoFocusFirst />
                {/* The TAIL group only — questions asked at an older rest render up there, in place. The
                    in-flight answer stays here whatever the questions do: it is the human's newest turn,
                    and the delivered copy of it lands at the tail a second later. */}
                <RegisteredQuestionStack thread={thread} questions={questionGroups.tail} inFlight={inFlightAnswers} className="px-6 pt-5" />
              </>
            )
            : row.kind === "questions" ? (
              <RegisteredQuestionStack thread={thread} questions={row.questions} className="px-6 pt-5" />
            ) : row.kind === "transport-fallback" ? (
              transportFallback ? <div className="px-6 pt-3"><div
                data-transcript-sync-fallback
                className={`flex flex-wrap items-center gap-2.5 ${BLOCK_RADIUS} border border-border-strong bg-panel-2 px-4 py-2.5 text-[12px]`}
                title={transportFallback.kind === "payload-too-large"
                  ? `Live payload ${transportFallback.actualBytes} bytes; socket limit ${transportFallback.maxBytes} bytes`
                  : `Transcript read budget reached (${transportFallback.scope}); retry after about ${transportFallback.retryAfterMs}ms`}
              >
                <AlertTriangle size={13} className="shrink-0 text-muted" />
                <div className="min-w-[180px] flex-1 leading-snug text-fg/85">
                  <span className="font-medium">Live transcript updates paused.</span>{" "}
                  {transportFallback.kind === "payload-too-large"
                    ? "The transcript is too large for push; the last complete HTTP-loaded copy remains visible."
                    : "The live read budget was reached; the last complete copy remains visible. Retry in a moment."}
                </div>
                <button type="button" disabled={isFetching} onClick={refresh} className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-fg/90 transition-colors hover:bg-panel disabled:opacity-40">
                  {isFetching ? "Refreshing…" : "Refresh once"}
                </button>
                <button type="button" onClick={retryLiveUpdates} className="shrink-0 rounded-md border border-border px-2 py-1 text-[11px] text-fg/90 transition-colors hover:bg-panel">
                  Retry live
                </button>
              </div></div> : null
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
                  <button type="button" onClick={requestEarlier} className="rounded-md px-2 py-1 outline-none hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60">
                    Load earlier messages
                  </button>
                )}
              </div>
            ) : row.kind === "message" ? (
              // `stampHostFor`, NOT `role === "user"`. The role records which SIDE of the conversation
              // a turn was recorded on, and three shapes recorded as the human's end on text ink
              // rather than a bubble: a frizz wake, a recurring-prompt line and a sub-agent's report,
              // all three hairline dividers. See lib/stampHost.ts.
              <MessageRow at={row.stampAt} host={stampHostFor(row.message, paired[row.messageIndex])} gap={row.gap}>
                <Message
                  m={row.message}
                  answering={answeringForMessage(row.message)}
                  showSendButton
                  paired={paired[row.messageIndex]}
                  staleAwaiting={awaitingCut >= 0 && row.messageIndex < awaitingCut}
                  restingCardShown={row.messageIndex === lastAgentIdx && restingShown}
                  restedAt={rest && row.messageIndex === rest.index ? rest.at ?? "" : undefined}
                  shadowedBy={shadowedByMessage.get(row.messageIndex)}
                  thread={thread}
                />
              </MessageRow>
            ) : row.kind === "runtime-status" ? (
              <div className="px-6" style={{ paddingTop: runtimeStatusGap }}>
                <RuntimeStatusLadder
                  state={runtimeStatus}
                  slug={slug}
                  retryText={lastUserIdx >= 0 ? messages[lastUserIdx]?.text : undefined}
                  onTerminal={copyTerminalCommand}
                  liveRuntimeStart={liveRuntimeStart}
                  liveActivityLabel={liveActivityLabel}
                  liveToolRun={liveToolRun}
                />
                {/* SIBLING of the ladder, not a rung in it. Those are mutually exclusive because they all
                    describe the ONE thing currently blocking; a policy denial already happened and blocks
                    nobody now, so it can coexist and must not compete for the same slot. */}
                {thread?.permPolicy ? (
                  <div className="mt-3">
                    <PermPolicyDenialCard policy={thread.permPolicy} denies={thread.permDenies} />
                  </div>
                ) : null}
              </div>
            ) : (
              // The QUEUED branch. Its rows are built straight from `messages`, never through the
              // tool-activity coalescer, so no run can have walked `at` forward and the message's own
              // instant is the only reading there is.
              //
              // The host went unstated until 2026-08-31, so the reading fell back to the PROSE offset
              // and its cap tops landed on the device row directly under the bubble's bottom edge —
              // zero clearance against a hard filled edge, measured off the maintainer's own
              // screenshot. It takes the same `stampHostFor` as the branch above rather than a flat
              // "bubble": a queued send is the human's, but answering a question composes one of these
              // too, and that lands as an answers card.
              <MessageRow at={row.message.at} host={stampHostFor(row.message, paired[row.messageIndex])} gap={row.gap}>
                <Message m={row.message} paired={paired[row.messageIndex]} />
              </MessageRow>
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
      className="flex items-center gap-1.5 rounded-full border border-border-strong bg-elevated px-3 py-1.5 text-[11px] font-medium text-fg shadow-lg shadow-black/30 hover:bg-panel-2"
    >
      <ArrowDown size={12} />
      Jump to latest
    </button>,
    overlay,
  )
}

// The thread's top bar: title and — at the far right — the shared non-lifecycle HeaderActions. Snooze
// and Archive stay in the persistent thread footer. Owned sessions expose a command-copy icon; foreign
// rows do not. It carried a Chat|Doc tab strip until 2026-08-06; see ThreadView for why that went.
export function ThreadHeader({ slug, onStatusApplied, onClose, showReturnToQueue = false }: { slug: string; onStatusApplied?: () => void; onClose?: () => void; showReturnToQueue?: boolean }) {
  const board = useBoard()
  const thread = threadBySlug(board, slug)
  const markComplete = useMutation({ mutationFn: () => rpc.markComplete({ slug }) })
  const renameTitle = useMutation({ mutationFn: (title: string) => rpc.renameThread({ slug, title }) })
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState("")
  const titleInputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!editingTitle) return
    const frame = requestAnimationFrame(() => {
      titleInputRef.current?.focus()
      titleInputRef.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [editingTitle])
  // A drawer can switch slugs without remounting this header. Never carry a half-entered title into
  // another thread; changing selection has the same semantics as cancelling with Escape.
  useEffect(() => {
    setEditingTitle(false)
    setTitleDraft("")
  }, [slug])
  // The "Frizz document" header affordance opens .frizz/<slug>.md (threadBody). Many session threads have
  // no such file — a session thread's working files are its own business — so it would dead-end on
  // "No thread file found". Gate it on the doc actually having body content (same stripFrontmatter the
  // drawer renders through), so it shows iff there's a real doc to open. Shares the drawer's cached query
  // (identical key), so opening the drawer adds no extra round-trip.
  const docQ = useQuery({ queryKey: ["threadBody", slug], queryFn: () => rpc.threadBody({ slug }) })
  const hasDoc = stripFrontmatter(docQ.data?.markdown ?? "").trim().length > 0
  if (!thread) return null
  const showTerminalCommand = thread.kind === "session" && thread.foreign !== true
  // Manual rename is registry metadata for either backend. Claude additionally owns a native AI
  // rename; Codex has no equivalent and must never be shown a fake slash-command affordance.
  const isForeign = thread.foreign === true
  const canRename = thread.kind === "session" && !isForeign
  const shownTitle = displayTitle(thread)
  function cancelRename(): void {
    setEditingTitle(false)
    setTitleDraft("")
  }
  function commitRename(): void {
    const title = threadTitleToCommit(titleDraft, shownTitle)
    setEditingTitle(false)
    if (!title) {
      setTitleDraft("")
      return
    }
    renameTitle.mutate(title, {
      onSuccess: () => {
        setTitleDraft("")
        showToast("Thread renamed")
      },
      onError: (error) => {
        setTitleDraft(title)
        setEditingTitle(true)
        showToast(error instanceof Error ? error.message : "Could not rename thread")
      },
    })
  }
  return (
    <header
      data-thread-header
      className={THREAD_HEADER_CLASS}
    >
      <div className={THREAD_HEADER_TITLE_CLASS}>
        {/* NOTHING BEFORE THE TITLE. The way out of /full used to be an ArrowLeft standing here, which
            put a whole-thread verb at the one end of the header no other verb lives at, and said
            "previous page" about a control whose job is to change how this thread is SHOWN. It is now
            the closing half of the fullscreen door, in the door's own slot in the action strip below
            (HeaderActions `collapse`). */}
        <div className="min-w-0 leading-tight">
          {/* Keep the title's display wrapper content-sized. Long names still truncate inside the
              remaining header width, but short names do not claim the whole row as a click target. */}
          <div className="group/thread-title flex min-w-0 items-center gap-2">
            {editingTitle ? (
              <input
                ref={titleInputRef}
                aria-label="Thread title"
                value={titleDraft}
                maxLength={THREAD_TITLE_MAX_LENGTH}
                onChange={(event) => setTitleDraft(event.target.value)}
                onBlur={commitRename}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    commitRename()
                  } else if (event.key === "Escape") {
                    event.preventDefault()
                    cancelRename()
                  }
                }}
                className="min-w-0 flex-1 rounded-md border border-border bg-elevated px-1.5 py-1 font-semibold text-[15px] text-fg outline-none focus:border-accent"
              />
            ) : canRename ? (
              <button
                type="button"
                title="Edit title"
                aria-label={`Edit thread title: ${shownTitle}`}
                disabled={renameTitle.isPending}
                onClick={() => {
                  setTitleDraft(manualThreadTitleSeed(shownTitle, thread.id))
                  setEditingTitle(true)
                }}
                className="min-w-0 max-w-full shrink truncate rounded px-0.5 -mx-0.5 font-semibold text-[15px] text-left outline-none transition-colors hover:bg-panel-2 focus-visible:ring-1 focus-visible:ring-fg/60 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {shownTitle}
              </button>
            ) : (
              <div className="min-w-0 max-w-full shrink truncate px-0.5 -mx-0.5 font-semibold text-[15px]" title={shownTitle}>
                {shownTitle}
              </div>
            )}
            <AiRenameButton thread={thread} hidden={editingTitle} />
          </div>
          <LastActive at={lastActiveLabelAt(thread)} fallbackAt={thread.spawnedAt} className="mt-0.5 block truncate text-[11px] leading-tight text-muted/75" />
        </div>
      </div>
      {/* At constrained drawer widths, controls get their own deliberate row. This keeps the
          clickable title and its activity stamp readable instead of competing with fixed-width
          tabs/actions, while the control row itself remains a single unbroken cluster. */}
      <div className={THREAD_HEADER_CONTROLS_CLASS}>
        {/* `gap-0.5` — the action strip's own distance, so the copy button and HeaderActions' icons
            read as one row. With no gap at all this button sat 17.75px of ink from its neighbour where
            the rest of the strip kept 20.25 and 21.5 (`scripts/ink-gaps.mjs` --dsf=4, real drawer). */}
        <div className="flex shrink-0 items-center gap-0.5">
          {showTerminalCommand && <CopyTerminalCommandButton slug={slug} />}
          <HeaderActions
            thread={thread}
            // The /full page is the one surface with a fullscreen to LEAVE, and it leaves through the
            // same slot it was entered by.
            collapse={showReturnToQueue}
            onDoc={hasDoc ? () => pushDrawer("doc", thread.id) : undefined}
            onDone={() => markComplete.mutate(undefined, { onSuccess: onStatusApplied })}
            doneBusy={markComplete.isPending}
            onStatusApplied={onStatusApplied}
          />
          {/* The fullscreen door, drawer header edition — same component as the queue card's, so the two
              cannot drift. Only where there is a drawer to leave: the /full page is already there. */}
          {onClose && <ExpandThreadLink slug={slug} />}
        </div>
        {/* Close-X for the DRAWER context (onClose passed by ThreadSheet) — parity with the Settings,
            sub-agent, and Doc drawers, all of which carry a corner "Close". Wired to the SAME animated
            close() as the backdrop/Esc path (markDrawerClosing + the 210ms slide-out), never an instant
            unmount. Absent in the main workpane (no onClose → no drawer to close). */}
        {onClose && (
          <button
            type="button"
            aria-label="Close"
            data-dialog-initial-focus
            onClick={onClose}
            className="ml-0.5 shrink-0 rounded-md p-1.5 text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg"
          >
            <X size={15} />
          </button>
        )}
      </div>
    </header>
  )
}

// The transcript's between-block RHYTHM — STEP, the tight run, the picture gap, and the VSpace element
// that draws them — lives in ./rhythm.tsx, and is re-exported here because every caller already reaches
// for it through ChatView. It moved out so the frizz wake renderer can charge the same STEP between the
// two hairlines of a two-part delivery: ChatView imports that renderer, so it cannot import ChatView.
export { STEP, META_CARD_STEP, PICTURE_STEP, USER_TAIL_EXTRA, VSpace } from "./rhythm.tsx"
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
// THE between-message gap, in one function. Both spacing implementations (this file's plain column and
// the virtualized row builder) call it, so neither can drift from the other.
export function messageGap(previous: ChatMessage, next: ChatMessage): number {
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
// Matches exactly when Message returns null (an empty/thinking-only assistant turn) — such a message
// takes no slot, so the adjacency-spacer walk must SKIP it (else two spacers stack into a double gap).
export function messageRendersNothing(m: ChatMessage, staleAwaiting?: boolean): boolean {
  if (m.kind === "event" || m.kind === "reasoning" || m.role === "user") return false
  if (m.parts && m.parts.length > 0) return m.parts.every((p) => (p.kind === "tools" ? p.tools.length === 0 : blankText(m, p.text, staleAwaiting)))
  return (m.tools?.length ?? 0) === 0 && blankText(m, m.text, staleAwaiting)
}
// THE LAST THING THE AGENT SAID. Any ```awaiting fence above it states a wait that has already resolved —
// the worker spoke again, so whatever it named came back or was given up on — and draws nothing at all
// (see renderText). All three transcript surfaces cut at this index, so it lives in one place: when they
// disagree, one of them either strands a live fence or keeps drawing a settled one.
//
// SAID, NOT "IS THE LAST ASSISTANT ROW". A `kind:"event"` line carries `role:"assistant"` but nothing the
// agent uttered — it is frizz's own synthetic marker for a rest, a wake, a compaction or a sub-agent
// completion. Counting one made the cut land AFTER the fence it was supposed to protect, and every rested
// thread ends with exactly such a row ("Agent rested"), so EVERY live fence read as settled: the card and
// its hourglass came off the one wait that was still open, and its body dropped to free-standing prose.
// That is the "light gray lines" the maintainer kept reporting on threads whose wait had not resolved at
// all (2026-08-20), and it survived being restyled twice because the tone was never the defect. Reasoning
// is the model's OWN output and still counts: a worker that wakes and thinks has resumed.
export function lastAssistantIndex(messages: readonly ChatMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant" && messages[i].kind !== "event") return i
  return -1
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
// so a fence-only last message is as empty as a settled one. Same set, one more member.
//
// `awaitingCut` is the index a fence goes stale BELOW — the message the thread last rested on while it is
// running past that rest, else the last assistant message (ChatView's `awaitingCut`; lib/restAnchor).
export function rendersNothingIn<T extends { message: ChatMessage; messageIndex: number }>(
  entries: readonly T[],
  awaitingCut: number,
  restingCardShown = false,
): (message: ChatMessage) => boolean {
  const stale = new WeakSet<ChatMessage>()
  if (awaitingCut >= 0) for (const entry of entries) if (entry.messageIndex < awaitingCut) stale.add(entry.message)
  if (awaitingCut >= 0 && restingCardShown) for (const entry of entries) if (entry.messageIndex === awaitingCut) stale.add(entry.message)
  return (message) => messageRendersNothing(message, stale.has(message))
}
// Does this text draw NOTHING? Ordinarily that is "is it blank", but an ```awaiting fence that is not a
// LIVE wait draws nothing either (see renderText) — and neither does a live one whose thread is at rest
// on it, because the resting card below states it; callers fold that case into `staleAwaiting` too —
// and the contract invites a worker to reply with the
// fence ALONE, so a whole message can be one such fence and no prose. Left un-stripped it reports as
// visible, which spends an adjacency spacer on an empty slot and saves a rest divider with nothing under
// it. That was already true of a REFUSED fence; it became true of a SETTLED one when the settled body
// stopped rendering, and 99 of the 6,999 awaiting fences in this machine's transcripts are fence-only,
// so the case is ordinary rather than theoretical.
function blankText(m: ChatMessage, text: string, staleAwaiting?: boolean): boolean {
  if (!m.fenceRefused && !staleAwaiting) return !text.trim()
  // splitFenceBlocks already drops whitespace-only prose runs, so "every segment is an awaiting fence"
  // is the whole test. A ```done fence still draws its card and keeps the message visible.
  return splitFenceBlocks(text).every((s) => s.kind === "fence" && s.fenceKind === "awaiting")
}
// Would this message render anything under `textOnly` (tool bands dropped)? Mirrors messageRendersNothing
// but counts ONLY text parts — the queue card uses it to decide whether a first/last agent message that
// is pure batched tool calls (no prose) contributes a visible row, or folds entirely into the bar.
export function messageHasRenderableText(m: ChatMessage, staleAwaiting?: boolean): boolean {
  if (m.kind === "event" || m.kind === "reasoning" || m.role === "user") return false
  if (m.parts && m.parts.length > 0) return m.parts.some((p) => p.kind === "text" && !blankText(m, p.text, staleAwaiting))
  return typeof m.text === "string" && !blankText(m, m.text, staleAwaiting)
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
    if (m.queued || messageRendersNothing(m)) continue
    // Under a PICTURE it takes the picture's own gap — this is the exact pair the maintainer reported
    // (an image `Read` with the shimmer under it). See PICTURE_STEP.
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
  // path to the decoded screenshot, rendered inline via /local-image inside a ToolImageCard. Like the
  // read/command entries it stands alone — never folds into a ×N repeat count.
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
      // as its own ToolImageCard showing it inline — never folds into a ×N run. Ahead of the `read` branch
      // on purpose: a Read of a `.png` is an image first and an excerpt second, so if a result ever ships
      // both, the picture wins and the text rides along in the card's body rather than replacing it.
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
        // copied here by hand.
        className={`group flex w-full min-w-0 items-baseline gap-1.5 rounded py-0.5 text-left outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60 ${TRANSCRIPT_META_LABEL_CLASS}`}
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
// of 2026-08-01 — every background/detached lifecycle (see lib/toolActivity.isToolActivityException).
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
  const board = useBoard()
  const thread = slug ? threadBySlug(board, slug) : undefined
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
  if (t.prompt || t.agentId) return <AgentBlock detail={t.detail} prompt={t.prompt} input={t.input} subagentType={t.subagentType} agentId={t.agentId} agentStatus={t.agentStatus} agentElapsedMs={t.agentElapsedMs} status={t.status} durationMs={t.durationMs} output={t.output} />
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
  // call's pending-ness, so a shell frizz watches and finds quiet draws the breathing mark next to the
  // word "stale". The old right-hand indicator tested `running || pending-background` first and so
  // pulsed at full brightness beside its own "stale" — the same self-contradiction the agent rows had
  // to unlearn. `pending && background` is the fallback: detached, but no live op correlated to it.
  const mark =
    liveBackgroundState === "running" ? (
      <span aria-hidden className="frizz-live-dot frizz-live-dot--shell" data-running-indicator="tool-disclosure" />
    ) : liveBackgroundState === "stale" ? (
      <span aria-hidden className="frizz-live-dot-quiet frizz-live-dot-quiet--shell" data-running-indicator="tool-quiet" title={CHILD_QUIET_SHELL_TITLE} />
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
  const tone = status === "failed" ? "frizz-tool-failed" : status === "cancelled" ? "text-amber-400" : "text-muted/55"
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
          {count > 1 && <span className="tabular-nums text-[11px] text-muted/45">×{count}</span>}
        </span>
      </div>
    </div>
  )
}

// A tool whose result carried an image (chrome-devtools `take_screenshot`, a Read of a `.png`) rendered
// as the picture itself, always — the maintainer's whole point is that a screenshot in the transcript
// should just BE there (2026-08-02: "those should just be rendered … automatically"). The one Read the
// server does NOT hand a picture is a Read of the human's own prompt attachment, whose bubble already
// shows it (server/frizz-paths.ts isPromptAttachmentPath); that call keeps its plain header. So the frame IS
// the card: the shared ImageFrame draws the outer border, the label bar (petite-caps tool name + target +
// status, in the Bash/Read header language) rides inside it, and the picture sits centered in the mat.
// No collapse — a picture is the one card body whose whole value is being visible without a click; the
// call is also lifted out of the `Ran N tool calls` digest for the same reason
// (lib/toolActivity.isToolActivityException). Any accompanying text result prints below the picture.
function ToolImageCard({ name, detail, outputImage, output, status, durationMs }: { name: string; detail?: string; outputImage: string; output?: string; status?: ToolStatus; durationMs?: number }) {
  const short = detail ? shortenTarget(detail) : undefined
  const header = (
    <div className="frizz-bash-header">
      <span className="flex min-w-0 items-center gap-2">
        <span className="petite-caps frizz-bash-label shrink-0">{prettyToolName(name)}</span>
        {short && <span className="min-w-0 truncate text-[11.5px] text-muted" title={detail}>{short}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        <ToolStatusMeta status={status} durationMs={durationMs} />
      </span>
    </div>
  )
  return (
    <div>
      {/* `outputImage` is ALWAYS a hash-named copy in the screenshot cache, so BlockImage's basename
          caption would read "9f2c…c1.png" — noise directly under a header that already names the real
          file. Drop it and give the picture the real target as its alt. */}
      <BlockImage path={outputImage} hideCaption altText={short ? `${prettyToolName(name)}: ${short}` : prettyToolName(name)} header={header} />
      {output && <pre className="frizz-bash frizz-bash-body frizz-bash-output-body mt-1.5">{output}</pre>}
    </div>
  )
}

// A SendUserFile delivery — the worker surfacing files to the human. Same card family (`frizz-bash`) and
// header as ToolImageCard so it reads as one of the tool cards, but OPEN by default: seeing the delivered
// images IS the point. Body: images inline (stacked, via the gated /local-image route), non-image files as
// openable chips (BlockFile → the gated opener), and the `caption` below in muted prose (capped ~65% wide
// so long captions stay readable against the wide card, not one edge-to-edge line).
function SentFilesCard({ images, files, caption, status, durationMs }: { images: string[]; files: string[]; caption?: string; status?: ToolStatus; durationMs?: number }) {
  const [open, setOpen] = useState(true)
  const bodyId = useId()
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
        className="frizz-bash-header w-full text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-fg/60"
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
          <div className="flex flex-col gap-1.5 px-2.5 pb-2.5 pt-1.5">
            {images.map((path, i) => <BlockImage key={`i${i}`} path={path} hideCaption altText={caption ?? "delivered image"} />)}
            {files.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {files.map((f, i) => <BlockFile key={`f${i}`} path={f} />)}
              </div>
            )}
            {caption && <div className="max-w-[65%] text-[12px] leading-snug text-muted">{caption}</div>}
          </div>
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
        className="frizz-bash-header w-full text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-fg/60"
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
  input,
  subagentType,
  agentId,
  agentStatus,
  agentElapsedMs,
  status,
  durationMs,
  output,
}: {
  detail?: string
  // The dispatch prompt — absent for a CODEX dispatch, whose message the provider encrypts. The card
  // then falls back to the call's own input (fork/agent-type details); the header, the live state, and
  // the drill-in all work identically either way.
  prompt?: string
  input?: string
  subagentType?: string
  agentId?: string
  agentStatus?: "completed" | "failed" | "killed"
  agentElapsedMs?: number
  status?: ToolStatus
  durationMs?: number
  output?: string
}) {
  const [open, setOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const bodyId = useId()
  const body = prompt ?? input
  const lineCount = useMemo(() => (body ? body.split("\n").length : 0), [body])
  const long = lineCount > AGENT_MAX_LINES
  // Thread surface OR sub-agent drawer (a nested dispatch inside a child's own transcript still drills
  // in — the router maps an id it can no longer resolve to "gone", which the drawer states plainly).
  const slug = useChildDrillSlug()
  const board = useBoard()
  const thread = slug ? threadBySlug(board, slug) : undefined
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
                  className="petite-caps frizz-tool-header-caps shrink-0 whitespace-nowrap text-[11.5px] leading-none text-muted/55"
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
              {profile && reading && <span aria-hidden className="petite-caps frizz-tool-header-caps -mx-[2px] shrink-0 text-[11.5px] leading-none text-muted/55">·</span>}
              {reading && (
                <ToolMetaReading
                  tone={reading.tone === "failed" ? "frizz-tool-failed" : "text-muted/55"}
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
            {output && (
              <>
                <div className="frizz-bash-output-label petite-caps">output</div>
                <pre className="frizz-bash-body frizz-bash-output-body">{output}</pre>
              </>
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
  const inner = useInnerHtml(html)
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
        className="frizz-bash-header w-full text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-fg/60"
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
                  dump. The clamp caps a long body at ~320px until "Show all" expands it. */}
              <div className={`border-t border-border px-2.5 py-2${long && !expanded ? " frizz-bash-clamp" : ""}`}>
                <div className="md-body" dangerouslySetInnerHTML={inner} />
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
          <span className="block truncate font-mono-keep text-[11px] text-bg/60">{openItem.display}{openItem.startLine !== undefined ? ` · ${openItem.startLine === openItem.endLine ? `line ${openItem.startLine}` : `lines ${openItem.startLine}-${openItem.endLine}`}` : ""}</span>
          <span className="mt-1 block max-h-40 overflow-y-auto whitespace-pre-wrap break-words font-mono-keep text-[11.5px] leading-4 text-bg/80">{openItem.text}</span>
        </span>
      )}
    </>
  )
}

function UserBubble({ text, rawText, queued, deliveryUnconfirmed, deliveryId, sourceId }: { text: string; rawText?: string; queued?: boolean; deliveryUnconfirmed?: boolean; deliveryId?: string; sourceId?: string }) {
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
  const unqueueable = Boolean(queued && deliveryId && unqueueSlug && unqueueSupported)
  // PUSH IT THROUGH. The other half of what you can do to a message that hasn't been read yet: instead
  // of taking it back, stop waiting for it. A ↑ appears left of the bubble on hover and preempts the
  // turn standing in front of the queue (see lib/deliverQueuedNow.ts). It replaces the composer's ⚡,
  // which asked for the same decision at the wrong moment — before the operator knew how long the
  // worker would take — and pictured it as a lightning bolt, which meant nothing.
  //
  // Gated on `queued` and a running turn, NOT on deliveryId: this addresses the thread's turn, not one
  // message, so it works for a queued bubble frizz did not itself send.
  // `queued ? slug : null` is a PERF gate, not a correctness one. Unlike unqueue's scalar (backend,
  // which effectively never changes) this one tracks `runtime`, which flips on every turn boundary —
  // subscribed unconditionally it would re-render every user bubble in the transcript each time a turn
  // starts or ends. Passing null makes the snapshot a constant `false` for the historical bubbles, so
  // they never see a change to re-render for.
  const pushNowSupported = useDeliverQueuedNowSupported(queued ? unqueueSlug : null)
  const { deliverNow, pending: pushNowPending } = useDeliverQueuedNow(unqueueSlug)
  const pushable = Boolean(queued && unqueueSlug && pushNowSupported)
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
        // The bubble's own positioning context, and the hover GROUP the ↑ rides on. It has to be the
        // group rather than the bubble, or moving the pointer off the bubble toward the button would
        // hide the button before it could be clicked — and would drop the queued bubble back to 50%
        // while its own control is under the cursor.
        <div className="group relative">
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
          className={`relative ${BLOCK_RADIUS} rounded-br-sm bg-user-bubble px-3.5 py-3 text-[14px] whitespace-pre-wrap [overflow-wrap:anywhere] text-bg ${queued ? "opacity-50" : ""} ${unqueueable ? "cursor-pointer transition-opacity group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg" : ""} ${unqueuePending ? "!opacity-30" : ""}`}
        >
          {/* Verbatim bytes, but link-shaped runs (a pasted URL, `#123`, a commit hash) render as the
              anchors they would be in agent prose — see LinkifiedText. The anchors stop their own
              click/keydown propagation, so a link inside a QUEUED bubble opens instead of unqueueing.
              A message carrying ⌘I context renders its references as chips instead (SentContextBody);
              the unqueue payload above stays the whole serialized text either way. */}
          {sentContext ? <SentContextBody body={sentContext.body} items={sentContext.items} /> : <LinkifiedText text={prose} />}
        </div>
        {/* SEND IT NOW — icon only, no fill until the pointer is on it, and ABSOLUTE so it costs the
            bubble no width. Laying it out as a flex sibling would narrow every queued bubble by 36px
            and re-wrap the text the moment the send landed, which is the class of reflow this file
            spends most of its comments avoiding.
            `bottom-0` aligns it with the bubble's BOTTOM edge (maintainer's call), which is also where
            the composer keeps its send arrow, so the two reads as the same gesture. */}
        {pushable && (
          <button
            type="button"
            // Same as every submit affordance beside a live input: never blur on the click path.
            onMouseDown={(e) => e.preventDefault()}
            onClick={deliverNow}
            disabled={pushNowPending}
            title="Send now — interrupts what the worker is doing so it reads the queue immediately"
            aria-label="Send now"
            className="absolute bottom-0 right-full mr-2 flex h-7 w-7 items-center justify-center rounded-lg text-muted opacity-0 outline-none transition-[opacity,color,background-color] group-hover:opacity-100 enabled:hover:bg-panel-2/70 enabled:hover:text-fg enabled:focus-visible:opacity-100 enabled:focus-visible:bg-panel-2/70 enabled:focus-visible:ring-1 enabled:focus-visible:ring-muted/80 enabled:focus-visible:ring-offset-1 enabled:focus-visible:ring-offset-bg enabled:active:bg-elevated"
          >
            {pushNowPending ? <Loader2 size={15} strokeWidth={2.2} className="animate-spin" /> : <ArrowUp size={15} strokeWidth={2.2} />}
          </button>
        )}
        </div>
      )}
      {/* Below the words, mirroring the composer (prose in the textarea, chips along its bottom edge) —
          and OUTSIDE the bubble, on the dark page, so BlockImage/BlockFile carry their normal styling
          instead of a light-bubble fork, and so the delegated open-local-file click can't collide with a
          queued bubble's click-to-unqueue. No basename caption: an upload's hash-prefixed filename is
          noise the human already knows, and a failed load falls back to the path text anyway. */}
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
        <div className="text-[11px] text-amber-400/80">Delivery unconfirmed — no receipt from the worker</div>
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
// `restedAt` — THIS is the message the thread last rested on, and the thread is running past that rest
// (lib/restAnchor): the human bumped it, or the shell it named woke it. The value is the rest's own
// instant ("" when the event carried none). The message then holds the rest's awaiting card in the
// transcript: its own ```awaiting fence card, with the rows cut at that instant, or — when it wrote no
// fence and rested on registered rows alone — the resting card itself, drawn here because a rest with
// no fence left NOTHING behind once the tail moved on (maintainer 2026-08-28: the hairline stayed and
// the card was gone). Only that one message ever carries it, so the memo boundary holds.
export const Message = memo(function Message({ m, answering, dense, paired, textOnly, showSendButton, staleAwaiting, shadowedBy, thread, restingCardShown, restedAt }: { m: ChatMessage; answering?: MessageAnswering; dense?: boolean; paired?: PairedAnswer[] | null; textOnly?: boolean; showSendButton?: boolean; staleAwaiting?: boolean; shadowedBy?: readonly RegisteredQuestionView[]; thread?: ThreadViewData; restingCardShown?: boolean; restedAt?: string }) {
  // ANSWERING ON A PHONE happens in a sheet, one question at a time (MobileAnswerSheet) — the cards in
  // the transcript stay READ-ONLY there, so the questions are still visible in the context that
  // produced them but a 44pt-thumb answer never has to land on a 24pt chip inside a scrolling message.
  const isMobile = useIsMobile()
  const [answerSheetOpen, setAnswerSheetOpen] = useState(false)
  // An event line (a sub-agent completion) is transcript PUNCTUATION — a quiet full-width line, not a
  // bubble or a tool band. Rendered before the role branches (its role field is nominal).
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
    if (answers) return <AnswersCard answers={answers} queued={m.queued} sourceId={m.sourceId} />
    // A scheduler wake is recorded as a user turn because it is pasted into the worker's composer —
    // but FRIZZ wrote it, not the human, so it must not wear the human's off-white right-justified
    // bubble. `m.wake` is the server's own tell (the delivery token it stripped), never a text guess.
    // A recurring prompt (either trigger) is a wake too, but it REPEATS by design — the same
    // paragraph every few minutes on a thread being driven by one — so it collapses to a single line
    // rather than restating itself in full down the transcript. Parsed from frizz's own trailer, defined
    // beside the composer that writes it; a non-match falls through to the divider below, so no wake
    // can lose its text to this.
    const recurring = m.wake ? parseRecurringPrompt(text) : undefined
    if (recurring) return <RecurringPromptLine bump={recurring} sourceId={m.sourceId} at={m.at} />
    if (m.wake) return <FrizzWake steer={m.wakeSteer} text={text} sourceId={m.sourceId} at={m.at} wrap={dense} />
    // …and the same correction for the OTHER writer of a user turn the human didn't type: a background
    // sub-agent pushing a report up to its parent through `SendMessage({to:"main"})`. `m.peerFrom` is the
    // server's own tell (it parsed the <agent-message> wrapper and put the body in displayText, which
    // `text` above already carries), never a text guess made here. It renders as a wake divider rather
    // than any kind of bubble — see SubAgentReportLine.
    if (m.peerFrom) return <SubAgentReportLine from={m.peerFrom} unnamed={m.peerUnnamed} dispatchId={m.peerDispatchId} sourceId={m.sourceId} at={m.at} />
    // `rawText` rides alongside the presentation text because the two differ: the bubble shows the
    // stripped/normalized copy, while the optimistic cache entry an unqueue has to evict is keyed on
    // the message's own raw text.
    return <UserBubble text={text} rawText={m.text} queued={m.queued} deliveryUnconfirmed={m.deliveryState === "unconfirmed"} deliveryId={m.deliveryId} sourceId={m.sourceId} />
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
  // Whether one of this message's ```awaiting fences drew its card — the card that already states the
  // rest's waits, so the rested-on card below (see `restedAt`) is not drawn beside it.
  const liveAwaitingFence = { drawn: false }
  // THIS message's open question blocks, in the order the answering controller numbers them. Only
  // populated when the message actually has a controller (i.e. its ask is still open).
  const askBlocks: { raw: string; kind: QuestionKind; danger: boolean; bi: number }[] = []
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
        if (fseg.fenceKind === "awaiting" && (m.fenceRefused || staleAwaiting || restingCardShown)) continue
        if (fseg.fenceKind === "awaiting") liveAwaitingFence.drawn = true
        push(
          <FenceCard
            key={`${keyBase}-f${fi}`}
            fenceKind={fseg.fenceKind}
            body={fseg.body}
            hints={fseg.hints}
            wrap={dense}
            notAfter={restedAt}
          />,
        )
        continue
      }
      for (const [si, seg] of splitQuestionBlocks(fseg.text).entries()) {
        if (seg.kind === "prose") {
          for (const [j, p] of splitProseAttachments(seg.text).entries()) {
            const partKey = `${keyBase}-${fi}-p${si}-${j}`
            push(
              p.kind === "image" ? <BlockImage key={partKey} path={p.path} />
              : p.kind === "file" ? <BlockFile key={partKey} path={p.path} />
              : p.kind === "visualization" ? <InlineVisualization key={partKey} file={p.file} />
              : p.kind === "directive" ? <CodexDirectiveCard key={partKey} directive={p.directive} />
              : p.kind === "mermaid" ? <MermaidDiagram key={partKey} source={p.source} />
              : <ProseHtml key={partKey} md={p.text} wrap={dense} />,
            )
          }
          continue
        }
        qi.n += 1
        const bi = qi.n
        // A fence STANDING FOR a registered question still open at this message — asked at this rest or
        // an earlier one — draws NOTHING: the registered card at the rest is the one the human answers,
        // and mid-prose placement is retired (lib/questionShadow), so the fence no longer moves that card
        // into its own slot. The index still advances — the controller numbers every fence in the flat
        // text — so the blocks that do render keep their answer state.
        if (shadowedBy && fenceStandsFor(seg, shadowedBy) !== undefined) continue
        // A LEGACY placement marker whose row is not standing here — answered, withdrawn, or a mistyped
        // id — has nothing to draw either: its body is empty by construction.
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

  // THE REST'S CARD, when the worker rested here on registered rows and wrote no fence to leave one
  // behind. At rest the resting card at the tail stated it (showsRestingCard, off the same registries);
  // the bump took that card with the tail, and the "Agent rested" hairline under this message was left
  // pointing at nothing. So the same card is drawn here — same heading, same rows, no queue action —
  // until the worker rests again and the tail takes it back. Gated on there being a row to draw at the
  // rest's instant, and skipped entirely (never pushed as null) when this message's own fence card
  // already draws the table, so the block list never spends a spacer on an empty slot.
  if (restedAt !== undefined && thread && !liveAwaitingFence.drawn && !m.fenceRefused && hasAwaitingWaitRows(thread, { notAfter: restedAt })) {
    push(<AwaitingBackgroundCard key="rested-on" thread={thread} notAfter={restedAt} />)
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
          className="flex h-[40px] items-center justify-center rounded-[12px] bg-accent px-4 text-[15px] font-semibold text-bg active:brightness-90"
        >
          {askBlocks.length > 1 ? `Answer ${askBlocks.length} questions` : "Answer"}
        </button>
      </div>,
    )
  } else if (showSendButton && answering && askBlocks.length > 0) {
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
          className="rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-all hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:hover:opacity-30"
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
})

// A user's composed multi-block answer, rendered as a structured card that MIRRORS the question
// component's answered state — so it wears the SAME anatomy as every other transcript card
// (TranscriptCard's CardHead + CardContent): "Answers" as a real sentence-case title flush with the
// card's left padding, the glyph parked top-right, and the rows starting on that same left edge.
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
  const inner = useInnerHtml(html)
  const ref = useRef<HTMLDivElement>(null)
  // Make inline-code file references clickable (opens in the user's editor/default app) once the server
  // confirms each resolves to a real file. Runs after render; a no-op when the prose has no such paths.
  useLocalFileCodeLinks(ref, html)
  if (!html) return null
  return <div ref={ref} className={`md-body${wrap ? ` ${QUEUE_WRAP}` : ""}`} dangerouslySetInnerHTML={inner} />
}

// A local absolute image path rendered inline via the gated /local-image route, inside the shared
// ImageFrame. A load failure (route 4xx, missing file) falls back to showing the plain path text so
// nothing is silently swallowed. `hideCaption` drops the basename line (SendUserFile images are
// hash-named cache copies whose basename is meaningless, and the SentFilesCard carries its own caption);
// `altText` overrides the a11y alt (else the basename); `header` is the frame's label bar (ToolImageCard
// passes the tool name + target + status through it, so the card IS the frame — see ImageFrame).
export function BlockImage({ path, hideCaption, altText, header }: { path: string; hideCaption?: boolean; altText?: string; header?: ReactNode }) {
  const [broken, setBroken] = useState(false)
  if (broken) return <div className="font-mono-keep text-[12px] text-muted/70 break-all">{path}</div>
  const base = path.split("/").filter(Boolean).pop() || path
  return (
    <ImageFrame
      header={header}
      caption={hideCaption ? undefined : <figcaption className="bg-panel-2 px-2 pb-1.5 font-mono-keep text-[11px] text-muted/60 break-all">{base}</figcaption>}
    >
      <img
        src={localImageUrl(path)}
        alt={altText ?? base}
        data-local-path={path}
        data-local-image="true"
        onError={() => setBroken(true)}
        className={`cursor-pointer ${FRAMED_IMAGE}`}
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
  const base = path.split("/").filter(Boolean).pop() || path
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
  "--input": "--color-border-strong",
  "--ring": "--color-accent",
}

function visualizationTheme() {
  const root = getComputedStyle(document.documentElement)
  const vars = Object.fromEntries(Object.entries(VIS_THEME_VARIABLES).map(([target, source]) => [target, root.getPropertyValue(source).trim()]))
  vars["--font-size-base"] = getComputedStyle(document.body).fontSize
  return { type: "frizz-inline-vis-theme", colorScheme: root.colorScheme === "light" ? "light" : "dark", vars }
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
  const src = slug ? `${apiBase()}/local-visualization?slug=${encodeURIComponent(slug)}&file=${encodeURIComponent(file)}` : null

  useEffect(() => {
    if (!src) { setAvailable(false); return }
    const controller = new AbortController()
    setAvailable(null)
    // Probe before mounting so a missing fragment gets a useful fallback instead of a tiny iframe
    // containing a bare HTTP status. HEAD avoids downloading a potentially 2 MB fragment twice.
    void fetch(src, { method: "HEAD", signal: controller.signal }).then((response) => {
      if (!controller.signal.aborted) setAvailable(response.ok)
    }).catch(() => {
      if (!controller.signal.aborted) setAvailable(false)
    })
    return () => controller.abort()
  }, [src])

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow || event.data?.type !== "frizz-inline-vis-height") return
      const next = Number(event.data.height)
      if (Number.isFinite(next)) setHeight(Math.max(80, Math.min(2400, Math.ceil(next))))
    }
    window.addEventListener("message", receive)
    return () => window.removeEventListener("message", receive)
  }, [])

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
      onLoad={() => iframeRef.current?.contentWindow?.postMessage(visualizationTheme(), "*")}
      className="block w-full border-0 bg-transparent"
      style={{ height }}
    />
  )
}




// A SIGNAL fence rendered as a card in place of the raw ```done / ```awaiting block (the fence
// language IS the state; the body is the message). `done` → a compact presentation-only success card;
// its thread's Archive lives in the stable lifecycle footer. `awaiting` → THE RESTING CARD ITSELF
// (AwaitingBackgroundCard), which is the whole point: one component draws that card on every surface and
// at every runtime, so steering a worker cannot re-shape it. See the branch below.
// `notAfter` — the rest's instant, when this fence is drawn at a rest the thread is running past
// (Message's `restedAt`): the wait table then lists what the worker rested on, not what its reply has
// started since. Absent on every other surface, where the table reads the thread as it is.
export function FenceCard({ fenceKind, body, hints, wrap, notAfter }: { fenceKind: FenceKind; body: string; hints: AwaitingHint[]; wrap?: boolean; notAfter?: string }) {
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
  // the footer's Mark-as-done and Snooze do (maintainer 2026-07-21: every card-dismissing control must).
  const queueDismiss = useContext(QueueDismissContext)
  const board = useBoard()
  // Resolve the owning thread + whether whole-thread lifecycle actions are applicable (session, not
  // foreign). Shared by both branches: the done card's Mark-as-done button renders only for a real,
  // actionable session thread, and the awaiting card needs the thread for its rows (null in a sub-agent
  // transcript, where there's no ThreadSlugContext → the fence renders card-only).
  const fenceThread = slug ? threadBySlug(board, slug) : undefined
  const lifecycle = fenceThread ? threadLifecycleAvailability(fenceThread) : undefined
  // Deliberately NOT `footer`: that stays true on a done thread — whose strip now renders as a
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
  if (fenceKind === "done") {
    return (
      // NEUTRAL tone — the green splash stood out as the only saturated color in the UI (maintainer
      // 2026-07-10). The Check + "Done" label carries the meaning; no color needed.
      <TranscriptCard icon={Check} label="Done">
        {html && <LinkedHtml className={`md-body${wrap ? ` ${QUEUE_WRAP}` : ""}`} html={html} />}
        {/* A white "Mark as done" button, deliberately redundant with the stable lifecycle footer — the
            same completion mutation, styled as the primary (light-on-dark) verb. Only shown when the
            thread can actually take the action. */}
        {doneThread && (
          <CardActions>
            <StateButton
              thread={doneThread}
              className={`${CARD_ACTION_RADIUS} text-[11px] ${CARD_PRIMARY_BUTTON}`}
              iconClassName={ICON_LABEL_NUDGE}
              onArchived={queueDismiss?.dismiss}
              onDismissCancel={queueDismiss?.cancel}
            />
          </CardActions>
        )}
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
  // the same wait twice.
  if (fenceThread && showsRestingCard(fenceThread)) return null
  return <AwaitingBackgroundCard thread={fenceThread} fence={{ body, hints }} notAfter={notAfter} />
}

// A permission-blocked agent is INVISIBLE in the transcript (the turn is parked mid-tool_use, so no
// message exists yet) — without this banner the card looks like a quietly-working agent. Rendered by
// the queue card and the thread view whenever runtime is perm-prompt; the action lands the user in
// an external terminal, the only place the prompt can be answered.
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
  const label = PROVIDER_LABEL[pause.backend]
  const which = pause.window === "weekly" ? "weekly limit" : pause.window === "session" ? "session limit" : "usage limit"
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
    const started = sendEagerFollowUp(queryClient, slug, "Continue exactly where you left off.", {
      onSuccess: () => { setContinuing(false); showToast("Continuing…") },
      onRollback: () => setContinuing(false),
      failureToast: (m) => `Continue failed: ${m.slice(0, 80)}`,
    })
    if (!started) setContinuing(false)
  }
  return (
    <TranscriptCard data-limit-pause tone="caution" icon={Hourglass} label={`Paused by the ${label} ${which}`}>
      {/* The provider's own "You've hit your session limit · resets …" line sits directly above this
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

// ATTENTION tone, like the two native-input cards below it: all three mean the same thing — the agent
// is blocked on you and the only place to answer is your external terminal — and they used to wear
// three different treatments (neutral / accent+shadow / accent wash) for that one meaning.
export function PermPromptBanner({ onTerminal }: { onTerminal: () => void }) {
  return (
    <TranscriptCard tone="attention" icon={KeyRound} label="Permission approval">
      <span className={CARD_BODY}>
        The agent is waiting on your approval — respond in your external terminal.
      </span>
      <CardActions>
        <button
          onClick={() => onTerminal()}
          onMouseDown={(e) => e.preventDefault()}
          className={CARD_PRIMARY_ACTION}
        >
          Copy terminal command
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

// The persistent BACKGROUND-OPS strip, anchored above the composer: one quiet row per LIVE op the
// worker is running across rests — sub-agents (drill-in) and background shells (display-only) — so a
// worker that "launched a CI watcher then came to rest" never reads as idle, and a final message like
// "waiting for the watcher to complete" has a visible home. Visible whenever ops are live, INCLUDING
// mid-turn (it folds in the old at-rest SubAgentBanner — one surface beats two, and the anchored
// position under the composer reads as ambient status rather than transcript content). A 30s tick keeps
// elapsed fresh even when no board push arrives (a steadily-running op changes nothing to re-push).
export function BackgroundOpsStrip({
  slug,
  className = "px-4 pb-2 pt-1",
  includeAgents = true,
  transcriptShells = [],
  parentAgentId,
}: {
  slug: string
  className?: string
  // Queue cards render live sub-agents as compact child lines directly under their composer. They
  // still use this strip for unrelated background shells/Monitors, so suppress agent duplication.
  includeAgents?: boolean
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
  const board = useBoard()
  const thread = threadBySlug(board, slug)
  const allAgents = thread?.subAgents ?? []
  // `displayDepth` rides only the scoped rows (see childOpSubtree); the thread-wide reading indents off
  // `depth` as it always has, so the field is optional here rather than back-filled onto every row.
  const agents: readonly (SubAgentView & { displayDepth?: number })[] =
    !includeAgents ? [] : parentAgentId ? childOpSubtree(allAgents, parentAgentId) : allAgents
  // A single shell arrives through BOTH provider board telemetry and transcript projection; they are
  // reconciled on the launch tool_use id (see mergeBackgroundShells for why label+startedAt could not).
  const shells = parentAgentId ? [...transcriptShells] : mergeBackgroundShells(thread?.bgShells ?? [], transcriptShells)
  // PR WATCHERS the thread has parked on. Thread-wide only: a sub-agent cannot park on a fence, so the
  // drawer's scoped reading ("the ops running underneath THIS child") has none by construction, and
  // listing the parent's here would credit the child with its parent's wait.
  const watchers = parentAgentId ? [] : (thread?.watches ?? []).filter((w) => w.kind === "github")
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
  const watchedTargets = new Set(
    (thread?.watches ?? []).filter((w) => w.kind === "shell" && w.state === "armed").map((w) => w.target),
  )
  const isWatched = (s: { id?: string; taskId?: string; label: string }) =>
    watchedTargets.has(s.taskId ?? "") || watchedTargets.has(s.id ?? "") || watchedTargets.has(s.label)
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
  if (total === 0) return null
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
          title={isWatched(s) ? `${s.label}\nWatched — this thread wakes when it finishes` : undefined}
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
          counter={checksCounterLabel(w.github)}
          counterTone={w.github?.checks === "failing" ? "danger" : undefined}
          counterTitle={w.github ? `${w.target} — ${watchStatusLine(w.github)}` : undefined}
          onOpen={() => window.open(githubRefUrl(w.target) ?? `https://github.com/${w.target.replace("#", "/pull/")}`, "_blank", "noreferrer,noopener")}
        />
      ))}
    </div>
  )
}

// The read-only render of a PENDING native AskUserQuestion (the safety net for a session that bypassed
// the thread-file ask channel). Shows the REAL question(s) + options as NON-interactive rows —
// deliberately NOT answer-chips: answering a native TUI dialog by keystroke injection is too fragile, so
// the ONE affordance copies an external-terminal command, where the dialog can actually be answered.
export function PendingAskCard({ ask, onTerminal }: { ask: PendingAsk; onTerminal: () => void }) {
  return (
    <TranscriptCard tone="attention" icon={HelpCircle} label="Waiting on your answer — in your external terminal">
      <div className="flex flex-col gap-3">
        {ask.questions.map((q, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            {q.header && <div className="text-[10px] uppercase tracking-wide text-muted/55">{q.header}</div>}
            <div className="min-w-0 text-[12px] font-medium leading-5 text-fg">{q.question}</div>
            {q.options.length > 0 && (
              <div className="flex flex-col gap-1">
                {q.options.map((o, j) => (
                  // A non-interactive OPTION ROW (clearly display-only — no hover, no cursor-pointer).
                  // `bg-elevated`, one step above the card's own panel-2 fill — the same relationship the
                  // question card's chips have to their card, so a row reads as a row on every surface.
                  <div key={j} className="rounded-md border border-border bg-elevated px-3 py-1.5 text-[12px] text-fg/80">
                    <span className="font-medium text-fg/90">{o.label}</span>
                    {o.description && <span className="text-muted/70"> — {o.description}</span>}
                  </div>
                ))}
                {q.multiSelect && <div className="text-[10px] text-muted/50">select one or more</div>}
              </div>
            )}
          </div>
        ))}
      </div>
      <CardActions>
        <button
          onClick={() => onTerminal()}
          onMouseDown={(e) => e.preventDefault()}
          className={CARD_PRIMARY_ACTION}
        >
          {/* No literal space before the label — the flex `gap` IS the spacing. A JSX space here
              rendered as a real space character ON TOP of the gap and made this the widest icon/label
              gap on the page by ~3px. */}
          <KeyRound size={12} className={`shrink-0 ${ICON_LABEL_NUDGE}`} />
          Copy terminal command
        </button>
      </CardActions>
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
  const { tail } = subAgentCompletionOutcome(call)
  const canDrill = !!(slug && call.agentId)
  // `at` is the instant the completion LANDED, and it sits after the run's own duration in `tail`
  // ("finished · 35 min · 2h ago"): how long it ran, then how long ago it came back.
  return (
    <WakeDivider icon={Bot} sourceId={sourceId} marker="agent" ariaLabel={canDrill ? undefined : `Sub-agent ${title} ${tail}`} at={at}>
      <span className="shrink-0">Sub-agent</span>
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
            className="min-w-0 truncate rounded-sm underline decoration-muted/30 underline-offset-2 outline-none transition-colors hover:text-fg hover:decoration-fg/60 focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-fg/60"
          >
            {title}
          </button>
        ) : (
          <span className="min-w-0 truncate">{title}</span>
        )}
        <span className="shrink-0">»</span>
      </span>
      <span className="shrink-0">{tail}</span>
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
            className="shrink-0 rounded-sm underline decoration-muted/30 underline-offset-2 outline-none transition-colors hover:text-fg hover:decoration-fg/60 focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-fg/60"
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
      <span className="shrink-0">Sub-agent</span>
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
            className="min-w-0 truncate rounded-sm underline decoration-muted/30 underline-offset-2 outline-none transition-colors hover:text-fg hover:decoration-fg/60 focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-fg/60"
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
              className="min-w-0 truncate rounded-sm underline decoration-muted/30 underline-offset-2 outline-none transition-colors hover:text-fg hover:decoration-fg/60 focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-fg/60"
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
  // for a background shell (BackgroundShellSheet, ExternalTerminalCommand). A `compaction` is not a
  // child returning at all — nothing ran, the provider just dropped the conversation above this line —
  // so it takes NO glyph rather than borrowing one that would misname it. Nor does a `rest`: it was the
  // most FREQUENT divider by far — one per turn — and a mark on every one of them is noise the quieter
  // bare rule does not make (maintainer 2026-08-02, on the ellipsis this shipped with). It is far rarer
  // now that lib/restDividers.ts drops the ones that only restate their neighbours, and the bare rule is
  // still right: what survives sits directly above the human's own next message, where a glyph would
  // compete with the bubble rather than quietly close the turn under it.
  if (boundary) {
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
            pixel-identical. The age stays outside this span so it survives the clip. */}
        <span className="min-w-0 truncate">{text}</span>
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
        className={`${TRANSCRIPT_META_LABEL_CLASS} flex items-baseline gap-1.5 self-start rounded outline-none transition-colors hover:text-fg focus-visible:ring-1 focus-visible:ring-fg/60`}
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
  const rowClass = `group flex min-w-0 items-baseline justify-between gap-3 rounded text-left outline-none focus-visible:ring-1 focus-visible:ring-fg/60 ${TRANSCRIPT_META_LABEL_CLASS}`
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
      <span className="shrink-0 whitespace-nowrap tabular-nums text-[12px] text-muted/60">{durationLabel}</span>
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
