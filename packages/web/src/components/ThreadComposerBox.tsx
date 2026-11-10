import { useContext, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react"
import { useSnapshot } from "valtio"
import type { AccountBackend, ThreadSkill, ThreadView } from "@frizz/shared"
import { awaitingSteps, hasStandingQuestion, questionAnswerMessage, withAnswersNote } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { restoreContextItems, showToast, store, takeContextItems } from "../store.ts"
import { useThreadSnapshot } from "../hooks.ts"
import { buildMessageWithContext, hasToken } from "../lib/composerContext.ts"
import { splitComposerValue } from "../lib/imagePaths.ts"
import { useThreadComposerControls } from "../hooks/useThreadComposerControls.tsx"
import { Composer } from "./Composer.tsx"
import { ReadAndAnswerNote } from "./ReadAndAnswerNote.tsx"
import { useReadAndAnswerHost } from "../api/supervisorStatus.ts"
import { LogoutConfirmModal, SignInModal } from "./SignInModal.tsx"
import { draftKey, mergeIntoDraft, useDraft, useProjectDir } from "../lib/drafts.ts"
import { noteFailedDraftOrigin, takeSupersededFailure } from "../lib/failedDelivery.ts"
import { parseAccountAlias } from "../lib/signIn.ts"
import { useEagerFollowUp, type EagerFollowUpCallbacks } from "../lib/eagerComposerSubmission.ts"
import { backendFollowUps } from "@frizz/shared"
import { canInterruptAndSend } from "../lib/composerKeyboard.ts"
import { useIsMobile } from "../lib/mobile.ts"
import { threadLifecycleAvailability } from "../lib/threadLifecycle.ts"
import { PhoneDoneButton } from "./PhoneDoneButton.tsx"
import { RecurringPromptControl } from "./RecurringPromptControl.tsx"
import type { PhoneBarApi } from "./Composer.tsx"
import { RegisteredAnsweringContext } from "./RegisteredQuestionCards.tsx"
import { SendScopeContext } from "../lib/sendScope.tsx"
import { useStepsAnswer } from "../lib/stepsAnswer.ts"
import { sendPlaceholder, setSendMode, useSendMode } from "../lib/sendMode.ts"
import { QueueDismissContext } from "../lib/threadContexts.ts"
import { QueuedRunContext } from "../lib/threadContexts.ts"
import { useThreadSurfaceBox } from "./ThreadSurface.tsx"

// THE prompt box for a registered thread — the single block every "steer this thread" surface renders.
// The <Composer> leaf was already shared; the ~14 lines AROUND it were not, and the queue card's copy had
// silently drifted: it never intercepted the `/login` / `/logout` aliases, so typing `/login` into a cue
// card injected the literal string into the running worker's stdin while the same keystroke in the drawer
// opened the sign-in modal. Everything that must not diverge now lives here exactly once:
//
//   · the follow-up DRAFT key (so the queue card, the drawer and /full are the same textarea, and a
//     draft typed in one is present in the others — in any tab — and survives a reload),
//   · the `/login` | `/logout` alias intercept + its SignInModal / LogoutConfirmModal,
//   · useThreadComposerControls (the model/effort footer and the backend busy fence),
//   · the {controls.status} line under the box.
//
// The two call sites keep their DELIBERATE differences as props, never as a forked tree: the padding
// wrapper (`className`), whether the running-operations reading (`above` the box, the one line of
// counts) is drawn at all, and the send itself (`submitOverride`). Everything else is identical by construction, the Goal in the rail included.
// The skills typeahead's per-thread cache, shared by BOTH composer surfaces (the drawer and the queue
// card render the same thread) so opening either only ever asks the harness once. A failure is NOT
// cached: the common failure is "the session is not running yet", and the next `/` should ask again
// once it is. Module scope on purpose — the cache outlives any one composer mount.
const threadSkillsCache = new Map<string, Promise<ThreadSkill[]>>()
function fetchThreadSkills(slug: string): Promise<ThreadSkill[]> {
  const cached = threadSkillsCache.get(slug)
  if (cached) return cached
  const fetched = rpc.threadSkills({ slug }).then(
    (result) => result.skills,
    () => {
      threadSkillsCache.delete(slug)
      return []
    },
  )
  threadSkillsCache.set(slug, fetched)
  return fetched
}

/**
 * The prompt box on a read-and-answer session: nothing to type in, and the one line saying where typing happens.
 * The answers staged on the cards still leave from here, since this is where the Send they use lives.
 */
function ReadAndAnswerComposerBox({ surface, className, above, phoneBarOverride, phoneChrome, readAndAnswerHost }: {
  surface: "queueComposer" | "chatComposer"
  className?: string
  above?: ReactNode
  phoneBarOverride?: (api: PhoneBarApi) => ReactNode
  phoneChrome?: boolean
  readAndAnswerHost: string
}): ReactElement {
  const registered = useContext(RegisteredAnsweringContext)
  const isMobile = useIsMobile()
  const phoneBar = (phoneChrome ?? isMobile) && surface === "chatComposer"
  return (
    <div
      data-thread-composer-box={surface}
      data-remote-composer
      {...(surface === "chatComposer" ? { "data-thread-action-bar": "" } : {})}
      className={phoneBar ? "flex flex-col gap-2 px-3 py-2.5" : className}
    >
      {above}
      {phoneBar && phoneBarOverride && <div className="flex items-center gap-2">{phoneBarOverride({ editReply: () => {} })}</div>}
      <div className={`flex items-center justify-between gap-3 ${phoneBar ? "" : "px-3 py-2"}`}>
        <ReadAndAnswerNote host={readAndAnswerHost} />
        {!phoneBar && (registered?.staged ?? 0) > 0 && (
          <button
            type="button"
            data-remote-send-answers
            disabled={registered!.sending}
            onClick={registered!.submit}
            className="shrink-0 rounded-md bg-fg px-3 py-1.5 text-[13px] font-medium text-bg outline-none disabled:opacity-40"
          >
            {registered!.sending ? "Sending…" : "Send answers"}
          </button>
        )}
      </div>
    </div>
  )
}

type ThreadComposerBoxProps = Parameters<typeof LocalThreadComposerBox>[0]

export function ThreadComposerBox(props: ThreadComposerBoxProps): ReactElement {
  const readAndAnswerHost = useReadAndAnswerHost()
  if (readAndAnswerHost) return <ReadAndAnswerComposerBox {...props} readAndAnswerHost={readAndAnswerHost} />
  return <LocalThreadComposerBox {...props} />
}

function LocalThreadComposerBox({
  slug,
  surface,
  className,
  id,
  above,
  submitOverride,
  phoneBarOverride,
  phoneChrome,
}: {
  slug: string
  // Pure data- tag forwarded to the textarea. Also the two surfaces' only behavioral fork inside
  // <Composer> itself (queueComposer owns Option-Enter); see lib/queueComposerKeyboard.ts.
  surface: "queueComposer" | "chatComposer"
  // The ONLY padding/chrome difference between the call sites — the drawer's bordered panel footer vs the
  // queue card's flush bottom block.
  className?: string
  // DOM id for the textarea. The drawer's is "followup-input".
  id?: string
  // Rendered INSIDE the padded box ABOVE the prompt: the line of live-op counts (QueueOpsSummary) the
  // queue card's docked box and the drawer's both carry, rather than rows hanging beneath it. Composed
  // by the caller — this component does not decide which ops a surface shows.
  above?: ReactNode
  // Replaces the default eager follow-up send. The queue card passes its useLiveAnswering `sendMessage`,
  // so the card's free-form reply and a reply that carries answers are literally the same send — one
  // controller, one optimistic card dissolve. Callers WITHOUT an answering controller (the drawer) omit
  // it and get the plain eager follow-up. Deliberately not split into a separate `onSent` prop: the
  // override already carries it, and a second copy here could only ever disagree.
  submitOverride?: (text: string, callbacks: EagerFollowUpCallbacks) => void
  // THE PHONE BAR'S THIRD STATE. While set, the drawer's resting phone bar renders this in place of
  // its row — a thread with open registered questions shows [keyboard] + "Answer N questions" there.
  // `api.editReply()` (the keyboard button) switches back to the prompt and focuses it inside the same
  // tap; the override returns once the field is empty and blurred. Ignored above the phone breakpoint
  // and on the queue card. See PhoneComposerLayout in Composer.tsx.
  phoneBarOverride?: (api: PhoneBarApi) => ReactNode
  // Whether the thread around this box wears the PHONE's chrome (MobileThreadHeader and its ⋯ sheet),
  // which is what the phone bar is built to sit under. ChatView knows: a drawer below the breakpoint
  // does, and /full never does — it keeps the desktop header at every width. Absent, the breakpoint
  // alone decides, as it did before the caller could say.
  phoneChrome?: boolean
}): ReactElement {
  // THE SURFACE this box sits in (ThreadSurface) — a required parent, not an optional one. It is the
  // file drop zone: a file dropped anywhere on the queue card, the drawer or the full-screen page comes
  // to this box, which draws the drop hint and owns the intake (see Composer's `fileDrop`).
  const { fileDrop } = useThreadSurfaceBox()
  const snap = useSnapshot(store)
  const thread = useThreadSnapshot(slug)
  // THE ONE SEND (lib/sendScope). Everything staged on the surface's question cards leaves through
  // this box: the registered questions' answers (shared through their own context) and the fenced
  // ones (through the surface's scope). Either context may be absent — a box mounted with no question
  // surface around it simply has nothing staged.
  const registered = useContext(RegisteredAnsweringContext)
  const scope = useContext(SendScopeContext)
  const surfaceExit = useContext(QueueDismissContext)
  // …and the ticks on the human's to-do list, which are answered the same way (lib/stepsAnswer). It reads
  // the thread rather than a context: the list is the thread's, whichever surface drew the box.
  const stepsAnswer = useStepsAnswer(thread)
  const staged = (registered?.staged ?? 0) + (scope?.fencedCount ?? 0) + (stepsAnswer.staged ? 1 : 0)
  // "A turn is in flight" — the only time sending as a steer and sending to the queue differ…
  const running = thread?.runtime === "running"
  // …or messages already queued, which a new one waits behind even with the agent at rest: the queue
  // goes out one message per turn, and the agent rests for a moment between two of them.
  const held = useContext(QueuedRunContext)?.held ?? 0
  const behind = running || held > 0
  // A backend with no steer has one way to send, whichever row the operator keeps ticked for the others.
  const { steer: steerable } = backendFollowUps(thread?.backend)
  const pickedMode = useSendMode()
  const mode = steerable ? pickedMode : "queue"
  // ONE placeholder for both surfaces, decided here from the thread — the queue card said "Reply to the
  // agent…" and the drawer "Follow up…" until 2026-10-09, and only the card said when the box was the
  // way AROUND an open question. An external session keeps its own sentence: it says what sending does,
  // which is to take the session over (see ThreadActionBar). An open question is a registered one or a
  // fence the worker's last message still asks — a registered one only while it STANDS (the server's
  // word, shared hasStandingQuestion): one the human has already typed past is no longer what this box
  // goes around, and the queue card no longer draws it. With an answer staged the box is a note on it,
  // and with the menu shut this line is also what says how the button will send (sendPlaceholder).
  const placeholder = thread?.foreign
    ? "Send a message to take over this session…"
    : sendPlaceholder({ staged, openQuestions: Boolean(thread?.pendingQuestion) || (thread ? hasStandingQuestion(thread) : false), running: behind, mode, steerable })
  const projectDir = useProjectDir()
  const key = draftKey.followUp(projectDir, slug, thread?.sessionId)
  const [message, setMessage, clearMessage] = useDraft(key)
  const controls = useThreadComposerControls(slug)
  const followUp = useEagerFollowUp(slug)
  const [signInFor, setSignInFor] = useState<AccountBackend | null>(null)
  const slashSuggest = useMemo(() => () => fetchThreadSkills(slug), [slug])
  const [logoutFor, setLogoutFor] = useState<AccountBackend | null>(null)

  // The ⌘I roster and its tokens. DELETING A TOKEN IS THE REMOVAL GESTURE: whenever the draft or
  // the roster changes, any staged item whose `@` token no longer appears in the prose is dropped —
  // so backspacing a reference out of the text retires its chip, exactly as the chip's × strips the
  // reference out of the text. Terminates: the write only fires when something is actually dropped.
  const stagedContext = snap.composerContext[slug]
  const contextTokens = useMemo(() => stagedContext?.map((item) => item.token) ?? [], [stagedContext])
  useEffect(() => {
    const items = store.composerContext[slug]
    if (!items?.length) return
    const { prose } = splitComposerValue(message)
    const kept = items.filter((item) => hasToken(prose, item.token))
    if (kept.length !== items.length) store.composerContext[slug] = kept
  }, [slug, message, stagedContext])

  // INTERRUPT AND SEND is offered only when there is something to interrupt AND a runtime that can be
  // preempted — `runtime === "running"` is exactly "process alive, turn in flight". The backend policy
  // (Claude only; Codex steers, ACP queues) lives in canInterruptAndSend, pinned by its test.
  const canInterrupt = canInterruptAndSend(thread, submitOverride !== undefined)
  // THE PHONE BAR — the drawer's composer below the phone breakpoint (the queue card never renders
  // on a phone). Its right-hand verb follows the thread: Done while it rests and can be completed,
  // Send once there is text, a dimmed ↑ while a turn runs.
  const isMobile = useIsMobile()
  // NOT on /full at a narrow width: that page keeps the desktop header, so its box is the desktop box
  // too — the Goal rides this rail and nowhere else on desktop chrome, and the phone bar has no rail.
  const phoneBar = (phoneChrome ?? isMobile) && surface === "chatComposer"
  const turnRunning = thread?.runtime === "running" || thread?.runtime === "spawning"
  // NOT WHILE THE THREAD WAITS ON STEPS (`steps:` in its last fence). The list above is ticked to say
  // "I did this"; a check beside it would mean "archive the thread", and on a phone the two read as one.
  const stepsOpen = thread?.lastFence?.kind === "awaiting" && awaitingSteps(thread.lastFence.hints).length > 0
  const canComplete = thread ? threadLifecycleAvailability(thread).archive && !turnRunning && !stepsOpen : false
  // THE GOAL rides the rail on every desktop surface that steers a Frizz-owned session — the same
  // threads the lifecycle verbs in the header serve. The phone reaches it from the header's ⋯ sheet.
  const goal = thread && thread.kind === "session" && thread.foreign !== true ? <RecurringPromptControl thread={thread as ThreadView} /> : undefined

  function send(interrupt = false) {
    const text = message.trim()
    // The answers staged on the cards ride this send, on the desktop box only: the phone bar's answers
    // go through its own sheet (PhoneQuestionCards), which this bar never registered a send for.
    const answers = phoneBar ? null : registered?.take() ?? null
    const fenced = phoneBar ? null : scope?.takeFenced() ?? null
    // On the phone the list keeps its own Send, as the questions keep their sheet.
    const steps = phoneBar ? null : stepsAnswer.take()
    if (!text && !answers && !fenced && !steps) return
    // `/login` / `/logout` are frizz-owned account actions for THIS thread's backend — invoked
    // locally, never delivered to the worker as a prompt (a leading slash is not a stable provider
    // command transport across the live-paste vs dead-resume lifecycles).
    const alias = parseAccountAlias(text)
    if (alias) {
      clearMessage()
      if (thread?.backend === "acp") {
        showToast("An ACP agent signs in through its own CLI — Frizz holds no account for it")
        return
      }
      if (thread?.backend === "opencode") {
        showToast("OpenCode signs in through its own CLI: run `opencode auth login`")
        return
      }
      const backend: AccountBackend = thread?.backend === "codex" ? "codex" : "claude"
      if (alias === "login") setSignInFor(backend)
      else setLogoutFor(backend)
      return
    }
    // Staged ⌘I context items ride the send: serialized into the text (before any trailing
    // attachment paths) and cleared with it — restored on a rejected send exactly like the draft.
    const context = takeContextItems(slug)
    const typed = text ? buildMessageWithContext(text, context, projectDir) : ""
    // Ticks on the list open the reply, with the typed words under them.
    const note = steps ? steps.compose(typed) : typed
    // ONE TURN. Fenced answers are composed here and the typed words go under them as the note; the
    // registered ones are settled and composed by the server, above all of it (FollowUpInput.answers),
    // so `outgoing` may be empty when only those ride. `shown` is what the optimistic bubble draws
    // until the server's own copy replaces it.
    const outgoing = fenced ? withAnswersNote(fenced.wire, note) : note
    const shown = answers ? withAnswersNote(questionAnswerMessage(answers.display), outgoing) : outgoing
    const callbacks: EagerFollowUpCallbacks = {
      onOptimistic: () => {
        clearMessage()
        answers?.onOptimistic()
        fenced?.onOptimistic()
        steps?.onOptimistic()
      },
      onSuccess: () => answers?.onSuccess(),
      ...(answers ? { answers: answers.answers, displayText: shown } : {}),
      ...(steps ? { todos: steps.todos } : {}),
      // "Send to queue" is the ticked row AND there is something to queue behind. The forced send never
      // queues: ⌘/Ctrl-Enter means now. A message already handed over whose turn has not started (the
      // board's delivery in flight) counts too, since the queue gives each message a turn of its own;
      // the server is the judge of that one, and sends at once if nothing is ahead after all.
      ...(mode === "queue" && !interrupt && (behind || thread?.deliveryInFlight === true) ? { hold: true } : {}),
      ...(steerable ? {} : { failureToast: (error: string) => `Send failed — ${error.slice(0, 160)}` }),
      // Re-sending words an earlier failure handed back replaces that failure's bubble — see
      // lib/failedDelivery.ts.
      supersedes: takeSupersededFailure(key, outgoing),
      // Never clobber a newer draft typed while the request was in flight — and never DROP the failed
      // message for it either. This used to restore only into an empty box, so a failed send was
      // silently discarded whenever the operator had typed anything since; the words now go above
      // whatever is there (mergeIntoDraft). The server keeps its own copy too when it can (`kept`),
      // because this draft lives in ONE browser's localStorage: clearing site data loses it, and no
      // other browser or device ever sees it.
      onRollback: (failure) => {
        mergeIntoDraft(key, message)
        restoreContextItems(slug, context)
        noteFailedDraftOrigin(key, { ...failure, text: message })
        answers?.onRollback(failure.kept)
        fenced?.onRollback()
        steps?.onRollback()
      },
    }
    if (submitOverride) submitOverride(outgoing, callbacks)
    else {
      followUp.submit(outgoing, { ...callbacks, interrupt })
      surfaceExit?.sent?.()
    }
  }

  // Register this box as its surface's send, so Enter in a question card's own text box — and the
  // queue card's card-level Enter — is this same send, typed words included. Through a ref: `send`
  // closes over the current draft and staged answers, and is a new function every render.
  const sendRef = useRef(send)
  sendRef.current = send
  const composerHandle = phoneBar ? undefined : scope?.composer
  useEffect(() => {
    if (!composerHandle) return
    const run = () => sendRef.current()
    composerHandle.set(run)
    return () => composerHandle.set(null)
  }, [composerHandle])

  if (phoneBar) {
    return (
      <div data-thread-composer-box={surface} data-thread-action-bar="" data-phone-thread-bar="">
        <Composer
          contextTokens={contextTokens}
          id={id}
          surface={surface}
          value={message}
          onChange={setMessage}
          onSubmit={() => send()}
          onInterruptSubmit={canInterrupt ? () => send(true) : undefined}
          slashSuggest={slashSuggest}
          // An external session keeps its own sentence (it says what sending does); otherwise the verb
          // is the thread's state: steering a turn in flight, or replying to one at rest.
          placeholder={thread?.foreign ? placeholder : turnRunning ? (steerable ? "Steer…" : "Queue…") : "Reply…"}
          busy={controls.busy}
          fileDrop={fileDrop}
          phone={{
            layout: "bar",
            tools: controls.phoneTools,
            idlePrimary: canComplete && thread ? (compact) => <PhoneDoneButton thread={thread as ThreadView} compact={compact} /> : undefined,
            override: phoneBarOverride,
            onLongPressSend: canInterrupt ? () => send(true) : undefined,
          }}
        />
        {controls.status}
        {signInFor && <SignInModal backend={signInFor} onClose={() => setSignInFor(null)} onAuthed={() => setSignInFor(null)} />}
        {logoutFor && <LogoutConfirmModal backend={logoutFor} onClose={() => setLogoutFor(null)} />}
      </div>
    )
  }

  return (
    // `data-thread-action-bar` stays the drawer footer's stable anchor (fixtures/QA scripts measure the
    // prompt-box inset from it); `data-thread-composer-box` addresses either surface's block.
    <div
      data-thread-composer-box={surface}
      {...(surface === "chatComposer" ? { "data-thread-action-bar": "" } : {})}
      className={className}
    >
      {above}
      <Composer
        contextTokens={contextTokens}
        id={id}
        surface={surface}
        value={message}
        onChange={setMessage}
        onSubmit={() => send()}
        onInterruptSubmit={canInterrupt ? () => send(true) : undefined}
        slashSuggest={slashSuggest}
        placeholder={placeholder}
        // NOT `|| followUp.pending`. The send is already committed locally (draft cleared, bubble
        // appended, and in the queue the card has already begun dissolving), so gating the textarea on
        // its round-trip only made the box go dead — and, because the browser blurs a disabled element,
        // cost the caret — for the ~½s the injection takes. What remains is a genuine backend
        // fence: a permission/profile change owning the runtime.
        busy={controls.busy}
        footer={controls.footer}
        railLead={goal}
        fileDrop={fileDrop}
        // An external session keeps the ↑: sending there takes the session over, and there is no turn
        // of Frizz's to steer or queue behind until it has.
        send={thread?.foreign ? undefined : { mode, onMode: setSendMode, running: behind, staged, steerable }}
      />
      {controls.status}
      {signInFor && <SignInModal backend={signInFor} onClose={() => setSignInFor(null)} onAuthed={() => setSignInFor(null)} />}
      {logoutFor && <LogoutConfirmModal backend={logoutFor} onClose={() => setLogoutFor(null)} />}
    </div>
  )
}
