import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useProjectDir, useSubAgentTranscript } from "../hooks.ts"
import { rpc } from "../api/rpc.ts"
import { showToast } from "../store.ts"
import { formatFixedDuration } from "../lib/durationLabels.ts"
import { PANE_HEADER_HEIGHT_CLASS } from "../lib/paneHeaderHeight.ts"
import { PROMPT_CONTROL_TYPOGRAPHY_CLASS } from "../lib/promptControlTypography.ts"
import { AGENT_OUTCOME_VERB } from "../lib/subAgentCompletion.ts"
import { subAgentProfileParts, subAgentProfileText } from "../lib/subAgentProfile.ts"
import { coalesceToolActivityMessages, historicalToolActivityMessages, liveRuntimeStartedAt, liveToolActivityRun, liveToolActivityTail, toolActivityLabel } from "../lib/toolActivity.ts"
import { BackgroundOpsStrip, ChildDrillSlugContext, Message, VSpace, WorkingIndicator, withMessageSpacers, workingIndicatorGap } from "./ChatView.tsx"
import { transcriptBackgroundShells, withoutLiveTranscriptBackgroundTools } from "../lib/transcriptShells.ts"
import { Composer } from "./Composer.tsx"
import { ContextReading } from "./ContextMeter.tsx"
import { DrawerStopCheck } from "./DrawerStopCheck.tsx"
import { HeaderFacts } from "./ThreadHeaderFacts.tsx"
import { LifecycleReadout } from "./ThreadLifecycle.tsx"
import { Sheet } from "./ui/Sheet.tsx"
import { SheetClose } from "./ui/SheetHeader.tsx"

// One SUB-AGENT layer of the side-drawer stack: a right sheet (same slide/backdrop family as the
// thread sheet — via the shared <Sheet>) showing a live/stale sub-agent's OWN transcript. It overlays
// whatever thread it was drilled into; closing reveals the thread beneath. `depth`/`widthDepth` inset
// each successive layer so the stack reads as one.
//
// IT IS NO LONGER READ-ONLY, and it no longer reads as a log:
//
//  · LIVENESS (always). A running child gets the same tail treatment as a top-level transcript:
//    the latest pending tool replaces "Working…" in the bottom runtime row; generic "Working…"
//    remains the fallback. It belongs INSIDE the scroller, not in a special fixed strip above the
//    conversation.
//  · STEERING (only where it is real). A user message addressed with the child's dispatch tool_use id
//    is routed by the CLI INTO that child's own conversation. Measured live against claude 2.1.220 /
//    SDK 0.3.207 and re-measured on 2.1.251: the child acted on it and only the CHILD's transcript
//    carried the token, while the same session's unaddressed control reached only the main thread.
//    It is also the ONLY channel — It works for a broker-backed Claude thread's OWN Agent-tool
//    children, and not for a codex child or a grandchild. Two failure modes MISDELIVER rather than
//    fail, and both land the operator's text on the parent's main thread as an instruction nobody
//    aimed there: addressing a child that has already FINISHED, and addressing anything while the
//    PARENT'S OWN TURN is in flight — there the CLI enqueues the frame on the main input queue and
//    absorbs it into the running turn, addressing dropped (measured on 2.1.251,
//    _live_broker_steer_busy.mts; hit live 2026-09-02). So the SERVER decides steerability — child
//    running, direct, broker, parent's turn idle — the box is rendered only off that answer, and
//    where it is absent the drawer states the reason instead of offering an input that cannot
//    deliver. The mid-turn refusal is the transient one: the box returns by itself when the thread
//    rests, because this transcript query re-runs on every board push.
//  · STOPPING (where the provider has a control API). Claude's SDK exposes `stopTask(taskId)`, and its
//    task registry is session-wide, so the drawer can stop direct children and descendants for a
//    broker thread. This is deliberately separate from the × on a child row: × retires stale tracking;
//    Stop sub-agent terminates real work and waits for the daemon/provider to confirm the request.
//
// THE HEADER IS A THREAD HEADER (2026-10-14). It was a bare title — "runtime/profile details live on
// the dispatch row that opens this drawer" — with the stop as a labelled button in a footer of its own,
// which made the one drawer that overlays a thread the one agent panel that did not read like one
// (maintainer: "why is the Stop Subagent button at the bottom instead of there being another checkmark
// icon in the upper right, as with the other agent panels? Why not include things like the context and
// the last active stuff in the header"). So it takes the thread header's layout and its split of the
// two edges (ThreadLifecycle.tsx): the TOP manages the agent — its name, "Last active · ◔ context" read
// off the child's own transcript, and at the far right the check that ends it, in the slot and glyph of
// the thread's Mark as done, which ends a live thread's run the same way; once it has ended the slot
// states how (Finished / Stopped / Failed), as a done thread's says Done. The BOTTOM steers the run.
//
// INSTANT OPEN: the frame + header + spinner mount and paint IMMEDIATELY; the heavy transcript body is
// deferred one frame (bodyReady) so the click→sheet-visible latency isn't gated on parsing/rendering a
// large transcript. The spinner covers the gap.
export function SubAgentSheet({
  id,
  slug,
  subId,
  label,
  subagentType,
  startedAt,
  depth,
  widthDepth,
}: {
  id: number
  slug: string
  subId: string
  label: string
  subagentType?: string
  startedAt?: string
  depth: number
  widthDepth: number
}) {
  // Deferred heavy body — mount the shell first, render the transcript one frame later (see header).
  const [bodyReady, setBodyReady] = useState(false)
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [stopping, setStopping] = useState(false)
  const qc = useQueryClient()

  const q = useSubAgentTranscript(slug, subId)
  const projectDir = useProjectDir()
  const messages = useMemo(() => q.data?.messages ?? [], [q.data])
  const state = q.data?.state
  const running = state === "running"
  // A sub-agent's own background shells, exactly as the thread view derives its own: the board's
  // `bgShells` telemetry is read off the SESSION's JSONL, so it never holds a child's shells — this
  // child's transcript is the only place they exist. Lifted out of the conversation into the ops strip
  // for the same reason the thread does it (one live row, anchored, instead of a card that scrolls away).
  const liveTranscriptShells = useMemo(() => transcriptBackgroundShells(messages), [messages])
  const presentationMessages = useMemo(() => withoutLiveTranscriptBackgroundTools(messages), [messages])
  const coalescedActivityMessages = useMemo(() => coalesceToolActivityMessages(presentationMessages), [presentationMessages])
  // The run backs the shimmer's expansion; its newest call names it. See lib/toolActivity.
  const liveToolRun = running ? liveToolActivityRun(coalescedActivityMessages) : undefined
  const liveToolActivity = running ? liveToolActivityTail(coalescedActivityMessages) : undefined
  const liveActivityLabel = liveToolActivity ? toolActivityLabel(liveToolActivity, projectDir) : undefined
  // The child's runtime clock times its current stretch too; the child's own launch instant is the fallback.
  const liveRuntimeStart = running ? liveRuntimeStartedAt(coalescedActivityMessages) : undefined
  const activityMessages = useMemo(
    () => running ? historicalToolActivityMessages(coalescedActivityMessages) : coalescedActivityMessages,
    [coalescedActivityMessages, running],
  )
  const showWorking = running
  // Unavailable = the RPC errored (e.g. a pre-restart server without this endpoint), the id is unknown
  // ("gone"), or a settled child (done/stale) whose transcript file is empty/cleaned. A RUNNING child
  // with no messages yet is just starting → a spinner, not "unavailable".
  const unavailable = q.isError || state === "gone" || (messages.length === 0 && (state === "done" || state === "stale"))

  // Defer the transcript body one frame past the shell's own slide-in (the shared <Sheet> flips `shown`
  // on the first frame; this lands bodyReady on the next) so the sheet paints instantly.
  useEffect(() => {
    let raf2 = 0
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setBodyReady(true))
    })
    return () => {
      cancelAnimationFrame(raf1)
      if (raf2) cancelAnimationFrame(raf2)
    }
  }, [])

  // Open at the BOTTOM (the child's latest activity) and stick there as new content streams in while
  // the user is already near the bottom — scoped to the sheet's OWN scroller (never the page).
  //
  // KEYED ON THE COLUMN ITSELF, and run before paint. This was an effect on `bodyReady` that observed
  // whatever children the scroller had at that moment — and when the transcript query had not answered
  // yet, that was the spinner. The column that replaced it was never observed, so a drawer opened on a
  // running child stayed wherever the browser put it: at the TOP of a transcript taller than the pane,
  // and still there as the child wrote more (sheet open: st 0 of 289 and growing, 2026-10-14). And as a
  // passive effect, when it did run it painted one frame at the top before scrolling down. A callback
  // ref hands the column over the moment it mounts, the layout effect lands the tail before that frame
  // paints, and the observer watches the column (its content) and the scroller (the steer box under it
  // coming and going).
  //
  // And on EVERY COMMIT as well, while pinned: a child's new step arrives as a render, and the observer
  // answers it only at the next frame's layout, so the frame the commit lands in had the content grown
  // under a scroller that had not moved (+120px for 29ms, recorded). The ChatView transcript follows in
  // a layout effect on every commit for the same reason.
  const [column, setColumn] = useState<HTMLDivElement | null>(null)
  const pinnedRef = useRef(true)
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (el && column && pinnedRef.current && el.scrollHeight - el.scrollTop - el.clientHeight > 0.5) el.scrollTop = el.scrollHeight
  })
  useLayoutEffect(() => {
    const el = scrollerRef.current
    if (!el || !column) return
    pinnedRef.current = true
    const toBottom = () => {
      if (pinnedRef.current) el.scrollTop = el.scrollHeight
    }
    const onScroll = () => {
      pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 160
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    const ro = new ResizeObserver(toBottom)
    ro.observe(column)
    ro.observe(el)
    toBottom()
    return () => {
      el.removeEventListener("scroll", onScroll)
      ro.disconnect()
    }
  }, [column])

  function stop() {
    if (stopping) return
    setStopping(true)
    rpc.subAgentStop({ slug, id: subId })
      .then(({ descendantsStopped, note: subtree }) => {
        // The subtree is the part the drawer cannot show: this sheet renders ONE child's transcript,
        // so its own fan-out ending is only ever visible here. A descendant frizz could not stop is
        // live work and gets the longer toast.
        if (subtree) showToast(`Sub-agent stopped. ${subtree}`, { duration: 7000 })
        else showToast(descendantsStopped > 0 ? `Sub-agent and ${descendantsStopped} descendant${descendantsStopped === 1 ? "" : "s"} stopped` : "Sub-agent stopped")
        void qc.invalidateQueries({ queryKey: ["subAgentTranscript", slug, subId] })
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Could not stop this sub-agent")
      })
      .finally(() => setStopping(false))
  }

  const lifecycle = q.data?.stoppable
    ? <DrawerStopCheck data-stop-subagent="" label="Stop sub-agent" stopping={stopping} onStop={stop} />
    : q.data?.outcome
      ? <SubAgentOutcome outcome={q.data.outcome} startedAt={q.data.startedAt ?? startedAt} finishedAt={q.data.finishedAt} />
      : null

  return (
    <Sheet id={id} depth={depth} widthDepth={widthDepth}>
      {(close) => (
        <>
          {/* Header shell paints immediately (part of the instant-open shell); its facts and its
              lifecycle slot fill in when the transcript query lands. The thread header's geometry —
              height, `px-3`, the title group's `pl-1` — WITHOUT its narrow-width wrap: that rule gives
              a strip of icons a row of its own below 640px, and one check alone there sat on an empty
              line under the close button. The title truncates instead. */}
          <header data-subagent-header className={`flex ${PANE_HEADER_HEIGHT_CLASS} min-w-0 shrink-0 items-center gap-2.5 border-b border-border bg-panel px-3`}>
            <div className="flex min-w-0 flex-1 items-center gap-2.5 pl-1">
              <SheetClose onClose={close} />
              <div className="min-w-0 flex-1 leading-tight">
                {/* ThreadTitle's read-only shape: a sub-agent's name is its dispatch description,
                    which nothing here can rename. */}
                <div className="flex min-w-0 items-center">
                  <div className="min-w-0 max-w-full shrink truncate px-0.5 -mx-0.5 font-semibold text-[15px]" title={label}>
                    {label}
                  </div>
                </div>
                <HeaderFacts
                  data-subagent-header-facts=""
                  lastActiveAt={q.data?.lastActivityAt}
                  fallbackAt={q.data?.startedAt ?? startedAt}
                  reading={q.data?.context ? <ContextReading context={q.data.context} /> : null}
                />
              </div>
            </div>
            {lifecycle && <div className="flex shrink-0 items-center">{lifecycle}</div>}
          </header>

          <div ref={scrollerRef} className="flex-1 min-h-0 overflow-y-auto">
            {unavailable ? (
              <div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-muted">
                Transcript unavailable (agent completed or cleaned up).
              </div>
            ) : !bodyReady || q.isLoading || messages.length === 0 ? (
              <div className="flex h-full items-center justify-center">
                <span className="block h-5 w-5 rounded-full border-2 border-muted/50 border-t-transparent animate-spin" />
              </div>
            ) : (
              // A child that dispatched children of its OWN renders Agent cards and completion
              // dividers in here. Without a slug those titles were dead text — the maintainer's "some
              // scenarios where that's not the case". The PARENT thread's slug is the drill root (the
              // tailer keys every sub-agent lookup by it); a grandchild it can no longer resolve comes
              // back "gone", which the drawer states plainly. This is deliberately NOT
              // ThreadSlugContext — see the note on ChildDrillSlugContext for why.
              <ChildDrillSlugContext.Provider value={slug}>
                {/* GAP-LESS on purpose: the between-message rhythm is withMessageSpacers' explicit
                    spacers, the same ones the thread transcript uses. A flat container `gap` here put
                    14px between two successive tool-only turns while a batch inside ONE turn stayed at
                    6px — and a child's transcript is nearly all tool calls, so the chunking the tailer
                    happens to have chosen was the most visible thing on the surface. */}
                <div ref={setColumn} data-transcript-column className="flex flex-col px-6 py-5">
                  {withMessageSpacers(activityMessages.map((entry) => entry.message), (m, i) => <Message key={i} m={m} />)}
                  {/* Exactly the regular transcript's tail treatment: the status follows the latest
                      message inside the scroller, rather than occupying a special fixed strip above
                      the conversation. A sub-agent drawer is a conversation, not a log dashboard. */}
                  {showWorking && <>
                    {/* The shimmer joins the tight meta run when the child's last rendered row is a
                        tool band or a thought label — the same rule the thread transcript uses. */}
                    <VSpace h={workingIndicatorGap(activityMessages.map((entry) => entry.message))} />
                    <WorkingIndicator since={startedAt} startedAt={liveRuntimeStart} activityLabel={liveActivityLabel} run={liveToolRun} />
                  </>}
                </div>
              </ChildDrillSlugContext.Provider>
            )}
          </div>

          <SubAgentSteerFooter
            slug={slug}
            subId={subId}
            subagentType={subagentType}
            observedModel={q.data?.model}
            steerable={q.data?.steerable === true}
            note={q.data?.steerNote ?? null}
            stoppable={q.data?.stoppable === true}
            stopNote={q.data?.stopNote ?? null}
            stopping={stopping}
            // The ops strip, scoped to THIS child's own subtree, as rows under its box — the thread's
            // drawer counts its ops on one line instead (QueueOpsSummary), but a scoped reading has no
            // counts of its own, and a child's subtree is short. Without it a sub-agent that fanned out read as idle in its own drawer while its
            // grandchildren were still working — the one surface where that fan-out is the whole story.
            ops={(className) => (
              <BackgroundOpsStrip slug={slug} parentAgentId={subId} transcriptShells={liveTranscriptShells} className={className} />
            )}
          />
        </>
      )}
    </Sheet>
  )
}

// The drawer's bottom edge follows the full-thread composition exactly: transcript | prompt panel, the
// boundary a DIRECT full-width strip so its rule does not stop at the prompt panel's inset. The child
// profile belongs in the prompt box's normal footer slot, but it is a readout rather than a selector:
// changing the parent thread profile cannot mutate an already-running child's model. The stop is the
// header's (DrawerStopCheck); it had a lifecycle footer of its own under this panel until 2026-10-14.
function SubAgentSteerFooter({
  slug,
  subId,
  subagentType,
  observedModel,
  steerable,
  note,
  stoppable,
  stopNote,
  stopping,
  ops,
}: {
  slug: string
  subId: string
  subagentType?: string
  // The model the child's own transcript says it ran — see SubAgentProfileReadout.
  observedModel?: string
  steerable: boolean
  note: string | null
  stoppable: boolean
  stopNote: string | null
  // The header's stop is in flight: the box holds what it has rather than sending into a child that
  // is being ended.
  stopping: boolean
  // Rows for the work running UNDER this sub-agent. A RENDER PROP rather than a node, because this
  // footer has two shapes and the strip needs different chrome in each: inside the prompt panel it is
  // just padding under the box (the same composition ThreadComposerBox uses), and where there is no
  // panel at all it has to draw the panel's own top rule and background itself.
  //
  // The second shape is not an edge case — it is the reading that matters most. A child whose own run
  // has ENDED is neither steerable nor stoppable and carries no note, so it renders no footer; that is
  // exactly the `rested` state the board emits only when live grandchildren are still hanging off it.
  // Folding the strip into the panel alone would have hidden the fan-out in precisely the drawer that
  // exists to show it.
  ops?: (className: string) => ReactNode
}) {
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const qc = useQueryClient()

  function send() {
    const text = message.trim()
    if (!text || busy) return
    setBusy(true)
    // Cleared optimistically like every other composer here. A FAILED send re-fills the box rather
    // than losing what was typed — the one thing a dropped steer must never do, and the likeliest
    // failure is the honest one: the child settled between the render and the send.
    setMessage("")
    rpc.subAgentSteer({ slug, id: subId, message: text, deliveryId: crypto.randomUUID() })
      .then(() => {
        // The provider does not persist addressed input in the child's JSONL, so the server journals
        // accepted drawer steers and merges them into this transcript. Refetch that durable record;
        // do not fabricate an optimistic bubble before delivery succeeds.
        void qc.invalidateQueries({ queryKey: ["subAgentTranscript", slug, subId] })
        showToast("Steer sent")
      })
      .catch((error: unknown) => {
        setMessage(text)
        showToast(error instanceof Error ? error.message : "Could not steer this sub-agent")
      })
      .finally(() => setBusy(false))
  }

  if (!steerable) {
    // A child the header can stop needs no word about stopping; one it cannot gets the reason here,
    // under the steer note when there is one.
    const unavailableNote = note ?? (stoppable ? null : stopNote)
    // Nothing to steer and nothing to explain — the strip is the whole footer, so it carries the
    // panel's chrome. It still renders NOTHING when no work hangs off this child, so a settled drawer
    // keeps its bare bottom edge rather than gaining an empty bordered band.
    if (!unavailableNote) return <>{ops?.("w-full shrink-0 border-t border-border bg-panel px-4 pb-2 pt-3")}</>
    return (
      <div data-subagent-steer-note className="w-full shrink-0 border-t border-border bg-panel px-3 py-3">
        <div className="px-1 pb-2 text-[11.5px] text-muted-70">{unavailableNote}</div>
        <div className="pl-1.5">
          <SubAgentProfileReadout subagentType={subagentType} observedModel={observedModel} />
        </div>
        {/* Same optical bottom inset ThreadComposerBox gives the thread-level prompt box (styles.css).
            No `empty:hidden` wrapper needed — the strip itself renders nothing when it has no rows, so
            the class comes and goes with them. */}
        {ops?.("px-1 pt-1.5 ops-column-optical-inset")}
      </div>
    )
  }

  return (
    <div data-subagent-steer className="w-full shrink-0 border-t border-border bg-panel px-3 py-3">
      <Composer
        value={message}
        onChange={setMessage}
        onSubmit={send}
        surface="subAgentComposer"
        placeholder="Steer this sub-agent…"
        busy={busy || stopping}
        footer={<SubAgentProfileReadout subagentType={subagentType} observedModel={observedModel} />}
      />
      {!stoppable && stopNote && (
        <div className="mt-2 px-1 text-[11.5px] text-muted-70">{stopNote}</div>
      )}
      {/* Same optical bottom inset ThreadComposerBox gives the thread-level prompt box (styles.css).
          No `empty:hidden` wrapper needed — the strip itself renders nothing when it has no rows, so
          the class comes and goes with them. */}
      {ops?.("px-1 pt-1.5 ops-column-optical-inset")}
    </div>
  )
}

// The model chip's 24px and 6px corner, so it sits in the prompt box's corner as the chip does (lib/iconRhythm.ts).
//
// It reads as the thread's own model chip reads — "OPUS 5.5 › XHIGH", the edition in the edition ink —
// because the two sit in the same corner of the same prompt box one drawer apart, and a child chip that
// said only "OPUS" read as a vaguer kind of fact (maintainer 2026-11-09: "In some places, we include a
// version number, and in others, we don't"). The edition comes from the dispatch cell when the parent's
// record stated it, and from `observedModel` — the child's own transcript — always when it has one,
// which is the only source for a child dispatched on another family than its parent's.
function SubAgentProfileReadout({ subagentType, observedModel }: { subagentType?: string; observedModel?: string }) {
  const parts = subAgentProfileParts(subagentType, observedModel)
  const label = parts ? subAgentProfileText(parts) : "Profile unknown"
  return (
    <span
      data-subagent-profile
      aria-label={`Sub-agent profile: ${label}`}
      title={parts ? label : "The provider did not report this sub-agent's model and effort"}
      className={`inline-flex h-6 min-w-0 max-w-[min(72%,20rem)] items-center rounded-md border border-border/50 bg-transparent px-1.5 text-muted ${PROMPT_CONTROL_TYPOGRAPHY_CLASS}`}
    >
      <span className="profile-grid-value relative -top-px min-w-0 truncate">
        {parts && parts.verbatim === undefined ? (
          <>
            {parts.role && `${parts.role} · `}
            {parts.model}
            {parts.edition && <> <span className="profile-grid-edition text-edition">{parts.edition}</span></>}
            {parts.effort && `${parts.model ? " › " : ""}${parts.effort}`}
          </>
        ) : label}
      </span>
    </span>
  )
}

// A settled child states how its run ended where the check stood, in the words every other surface
// reports a finished child with (AGENT_OUTCOME_VERB), with the thread's Done check on a clean finish
// only — a stop or a failure is not a success to tick. How long it ran is one hover away.
function SubAgentOutcome({ outcome, startedAt, finishedAt }: { outcome: "completed" | "failed" | "killed"; startedAt?: string; finishedAt?: string }) {
  const verb = AGENT_OUTCOME_VERB[outcome]
  const word = `${verb[0].toUpperCase()}${verb.slice(1)}`
  const ranMs = startedAt && finishedAt ? Date.parse(finishedAt) - Date.parse(startedAt) : Number.NaN
  const tooltip = Number.isFinite(ranMs) && ranMs >= 0 ? `${word} after ${formatFixedDuration(ranMs)}` : word
  return (
    <LifecycleReadout data-subagent-outcome={outcome} check={outcome === "completed"} tooltip={tooltip}>
      {word}
    </LifecycleReadout>
  )
}
