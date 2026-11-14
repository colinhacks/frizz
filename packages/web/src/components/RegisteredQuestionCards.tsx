// The surface a REGISTERED question renders on — a question a worker created with the `ask` tool, which
// is a row in `thread_question` rather than a fence in a message. That is the whole difference, and it
// is the reason this file exists at all: a fenced question lives and dies with the message carrying it,
// so it vanishes from view the moment the transcript scrolls or the context is compacted, while a
// registration is still owed an answer tomorrow. So these cards do NOT ride the transcript on their own:
// they render at the rest they belong to (lib/questionAnchor), and — since 2026-09-11 — in the slot of an
// empty ```question qst_… marker the worker wrote into its handoff (lib/questionShadow PLACEMENT).
//
// The CARD is the shared one (QuestionBlockCard); only the plumbing is new. What a registration adds
// over the other two producers is the STATIC TREE: an option may carry follow-ups that become live only
// once that option is picked, so one registration renders as a stack of cards that grows as it is
// answered. lib/registeredQuestion.ts performs that walk; nothing here decides which nodes are live.
//
// ONE ANSWERING STATE PER THREAD, however many mounts. The `answerQuestions` RPC takes every staged
// answer in ONE call (a per-question send would half-wake the worker), and placement scatters a rest's
// cards through the prose — a placed card inside one message, its sibling at the tail — so the staged
// picks cannot live in the card that draws them. `useRegisteredAnswering` holds them for the whole
// thread; the surface mounts it ONCE (RegisteredAnsweringProvider) and every card and every stack on
// that surface reads it through context. Picks and text are shared through the tab's draft store
// across providers and remounts; secrets, errors and send state remain per hook instance. A stack
// mounted with no provider above it (a surface that never places) owns its own hook instance.
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { X } from "lucide-react"
import { nameQuestionAnswer } from "@frizz/shared"
import type { AskedQuestion, ClosedQuestionSpecView, ClosedQuestionView, NamedQuestionAnswer, QuestionAnswer, RegisteredQuestionView, SettledQuestionView, ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { draftKey, draftStore, useDraftValues, useProjectDir } from "../lib/drafts.ts"
import { clearSteered, markAnswered, markSteered } from "../lib/steering.ts"
import { SendScopeContext, usePromptBoxSends } from "../lib/sendScope.tsx"
import type { BlockAnswer } from "../lib/questionBlocks.ts"
import { arrivedQuestions, type ArrivalMessage } from "../lib/questionArrival.ts"
import { questionFaultsKey, refusalSummary, withRefusedFences, type FaultMessage } from "../lib/questionFaults.ts"
import { withQuestionOwners, type OwnerMessage } from "../lib/questionOwners.ts"
import { useInlineMarkdownHtml } from "../lib/useMarkdown.ts"
import { LinkedHtml } from "./LinkedHtml.tsx"
import type { PairedAnswer } from "../lib/answersMessage.ts"
import { ROOT_PATH, liveQuestionNodes, nodeAnswered, questionNeedsMachine, registeredAnswer, settledQuestionNodes, toParsedQuestion } from "../lib/registeredQuestion.ts"
import { useReadAndAnswerHost } from "../api/supervisorStatus.ts"
import { decodeQuestionPick, encodeQuestionPick, questionSpecAt } from "../lib/registeredPicks.ts"
import { AnswersCard } from "./AnswersCard.tsx"
import { QueueDismissContext } from "../lib/threadContexts.ts"
import { QuestionBlockCard } from "./QuestionBlockCard.tsx"
import { CompactQuestionList, usePhoneQuestions } from "./PhoneQuestionCards.tsx"
import { ReadAndAnswerCardNote } from "./ReadAndAnswerNote.tsx"

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "The answer could not be sent."
  return message.length > 240 ? `${message.slice(0, 239)}…` : message
}

/** The thread's whole answering state: what is staged on every open question, and the one send. */
export interface RegisteredAnswering {
  slug: string | undefined
  answerFor: (q: RegisteredQuestionView, path: string) => BlockAnswer
  answersOf: (q: RegisteredQuestionView) => ReadonlyMap<string, BlockAnswer>
  onChip: (q: RegisteredQuestionView, path: string, isMulti: boolean, optIdx: number) => void
  onText: (q: RegisteredQuestionView, path: string, isMulti: boolean, text: string) => void
  dismiss: (id: string) => void
  dismissing: boolean
  /** Send EVERY staged answer on the thread — placed or at an anchor, this rest's or an older one.
   *  Through the surface's prompt box when it has one (lib/sendScope), so whatever is typed there goes
   *  with them; on its own otherwise. */
  submit: () => void
  /** Hand every staged answer to the prompt box's send, which carries them in its own follow-up. Null
   *  when nothing is staged. */
  take: () => RegisteredTake | null
  staged: number
  sending: boolean
  error: string | undefined
  /** The machine's name on a read-and-answer session, which picks listed options and types nothing. */
  readAndAnswerHost?: string | null
}

/** The staged answers as the prompt box's send needs them, with the three edges of that send. */
export interface RegisteredTake {
  answers: QuestionAnswer[]
  /** The same answers as the human may read them back — a secret's value never reaches a bubble —
   *  each named by the id its question was asked under, as the server names it in the message it
   *  composes (shared nameQuestionAnswer; the id is read off the spec, which is all the board's view
   *  of a question carries). The optimistic bubble is drawn from these, and the in-flight card stands
   *  down for a row the transcript already draws only when the two agree on that id. */
  display: NamedQuestionAnswer[]
  /** The send has committed locally: the cards grey in place. */
  onOptimistic: () => void
  onSuccess: () => void
  /** The send was refused. `kept`: the server holds it as a failed send, answers settled and all. */
  onRollback: (kept: boolean) => void
}

export const RegisteredAnsweringContext = createContext<RegisteredAnswering | null>(null)

/** The state behind every registered card on a surface. `thread` undefined (a stack that found a
 *  provider above it) yields an inert state nobody reads — hooks cannot be conditional. */
export function useRegisteredAnswering(thread: ThreadView | undefined): RegisteredAnswering {
  const slug = thread?.id
  const questions = thread?.questions ?? []
  const projectDir = useProjectDir()
  const readAndAnswerHost = useReadAndAnswerHost()
  // A SECRET's typed value, keyed by question id. In React state and nowhere else: the draft store
  // mirrors into localStorage, which every tab reads and which outlives the browser, and a pasted
  // credential must not outlive the tab in a cache (lib/drafts says so for the typed interaction cards
  // too). The cost is that a reload loses a half-pasted code, which is the right way round for a
  // one-time code.
  const [secrets, setSecrets] = useState<ReadonlyMap<string, string>>(() => new Map())
  const [error, setError] = useState<string>()
  // THE QUEUE CARD DISSOLVES ON SEND, like every other action on it. Answering is the same commitment as
  // a fenced Send answers or a composer steer — both of which take the card out of the queue the instant
  // the human commits, without waiting on the round-trip (see useLiveAnswering's onSent) — and this was
  // the one send that did not, so a card answered on a loaded machine sat there for the seconds it took
  // the board to catch up, which is the window its answer rendered twice in (2026-09-01). Null on the
  // thread page, where there is no card to dismiss.
  const queueDismiss = useContext(QueueDismissContext)
  const sendScope = useContext(SendScopeContext)

  // Picks and text share the draft store, so queue, drawer, fullscreen (in this tab or another) and
  // project remounts all see the same staged answer. Secrets stay strictly in memory outside this
  // subscription.
  const textKeys = useMemo(
    () => (slug ? questions.flatMap((q) => (q.spec.secret ? [] : allPaths(q).flatMap((path) => [
      draftKey.question(projectDir, slug, q.id, path), draftKey.questionPick(projectDir, slug, q.id, path),
    ]))) : []),
    [projectDir, slug, questions],
  )
  const persistedText = useDraftValues(textKeys)
  const answerFor = (q: RegisteredQuestionView, path: string): BlockAnswer => {
    if (q.spec.secret) return { chosen: null, chosenSet: [], text: secrets.get(q.id) ?? "" }
    const spec = questionSpecAt(q.spec, path)
    const pick = spec ? decodeQuestionPick(spec, slug ? persistedText.get(draftKey.questionPick(projectDir, slug, q.id, path)) ?? "" : "") : undefined
    return {
      chosen: pick?.chosen ?? null,
      chosenSet: pick?.chosenSet ?? [],
      text: (slug ? persistedText.get(draftKey.question(projectDir, slug, q.id, path)) : undefined) ?? "",
    }
  }
  const answersOf = (q: RegisteredQuestionView): ReadonlyMap<string, BlockAnswer> =>
    new Map(allPaths(q).map((path) => [path, answerFor(q, path)]))

  // EVERY answered question goes in ONE call. A per-question send would half-wake the turn: the worker
  // would come back to a payload it cannot act on and would have to ask for the rest again.
  const stagedPairs = questions.flatMap((q) => {
    const built = registeredAnswer(q, answersOf(q))
    return built ? [{ q, answer: built }] : []
  })
  const staged: QuestionAnswer[] = stagedPairs.map((pair) => pair.answer)
  const queryClient = useQueryClient()

  const send = useMutation({
    mutationFn: async (submission: { answers: QuestionAnswer[]; drafts: Array<{ id: string; keys: string[] }> }) =>
      rpc.answerQuestions({ slug: slug!, answers: submission.answers }),
    onSuccess: (result, submission) => {
      // The board push removes these rows, so the staged state for them is dead weight. Left behind, it
      // would sit in the tab's draft store, whose reload snapshot keeps only the most recent entries
      // (lib/drafts MAX_ENTRIES), and could push an older, still-live draft out of it. A re-ask is not
      // the reason: it mints a fresh `qst_` id, so it can never match these keys.
      for (const id of result.answered) {
        setSecrets((prev) => {
          if (!prev.has(id)) return prev
          const next = new Map(prev)
          next.delete(id)
          return next
        })
        // The board push may remove the question before the HTTP reply arrives. Clear the keys
        // captured at send, not the current board's questions (which may already be empty).
        for (const key of submission.drafts.find((entry) => entry.id === id)?.keys ?? []) draftStore.clear(key)
      }
    },
    onError: (cause) => {
      // The card faded on click; the answer did not land, so put it back rather than leaving the human
      // looking at a queue that quietly swallowed their reply. Same reversal an optimistic Mark-as-done
      // makes when the server declines it.
      queueDismiss?.cancel()
      if (slug) clearSteered(slug)
      setError(errorText(cause))
    },
    // Server truth replaces the optimistic settled cards either way: on success it carries the real
    // `settledAt`, and on failure it no longer holds them, which brings the open card back.
    onSettled: () => {
      if (slug) void queryClient.invalidateQueries({ queryKey: settledQuestionsKey(slug) })
    },
  })
  const dismiss = useMutation({
    mutationFn: async (id: string) => rpc.dismissQuestions({ slug: slug!, ids: [id] }),
    onError: (cause) => setError(errorText(cause)),
  })

  // A secret's settled card never draws the value, not even for the beat before the server's own
  // stored text (where the file went) replaces this.
  const displayed = (pairs: typeof stagedPairs): QuestionAnswer[] =>
    pairs.map(({ q, answer }) => (q.spec.secret ? { ...answer, text: "(secret sent)" } : answer))
  // THE CARD GREYS IN PLACE ON SEND, before the round-trip: the answered question joins the settled
  // list now, and the surface stops drawing the open card for any id that list holds (see
  // withoutSettledQuestions). Waiting for the server instead left a beat where the open card had gone
  // with the board push and the settled one had not arrived — the card blinking out and back.
  const settleOptimistically = (owner: string, pairs: typeof stagedPairs) => {
    const key = settledQuestionsKey(owner)
    void queryClient.cancelQueries({ queryKey: key })
    const settledAt = new Date().toISOString()
    const ids = new Set(pairs.map((pair) => pair.q.id))
    // …and the rail's steer overlay stops counting them as open, so the row does not go to Running
    // wearing the "?" of a question that was just answered (lib/steering markAnswered).
    markAnswered(owner, [...ids])
    const shown = displayed(pairs)
    queryClient.setQueryData<SettledQuestionsData>(key, (prev) => ({
      closed: prev?.closed ?? [],
      questions: [
        ...(prev?.questions ?? []).filter((s) => !ids.has(s.id)),
        ...pairs.map(({ q }, i): SettledQuestion => ({ id: q.id, spec: q.spec, askedAt: q.askedAt, settledAt, pending: true, answer: shown[i] })),
      ],
    }))
  }
  const draftKeysOf = (owner: string, pairs: typeof stagedPairs) =>
    pairs.map(({ q }) => ({ id: q.id, keys: q.spec.secret ? [] : allPaths(q).flatMap((path) => [
      draftKey.question(projectDir, owner, q.id, path), draftKey.questionPick(projectDir, owner, q.id, path),
    ]) }))

  const sendAlone = () => {
    if (!slug || staged.length === 0 || send.isPending) return
    setError(undefined)
    // Local truth FIRST, then the network — the ordering every other send on this card obeys, and the
    // whole of what "the card goes away when I answer it" means on a machine under load.
    ;(queueDismiss?.sent ?? queueDismiss?.dismiss)?.()
    // …AND THE RAIL ROW GOES TO WORK WITH IT. Every answer wakes the worker (the scheduler delivers the
    // batch), so this is a steer in all but name, and it takes the steer's overlay: without it the row
    // dropped its question mark on the board push, sat in the queue wearing the at-rest ellipsis, and only
    // moved to the running band once the delivery landed (lib/steering.ts).
    markSteered(slug)
    settleOptimistically(slug, stagedPairs)
    send.mutate({ answers: staged, drafts: draftKeysOf(slug, stagedPairs) })
  }
  // THE PROMPT BOX'S SEND TAKES THEM (lib/sendScope). The same local truth as `sendAlone`, minus what
  // that send already does for itself: it dissolves the queue card and marks the row steered, and its
  // own failure toast says why a refused send came back.
  const take = (): RegisteredTake | null => {
    if (!slug || staged.length === 0) return null
    const pairs = stagedPairs
    const drafts = draftKeysOf(slug, pairs)
    const settle = () => void queryClient.invalidateQueries({ queryKey: settledQuestionsKey(slug) })
    const forget = () => {
      setSecrets((prev) => {
        if (!pairs.some(({ q }) => prev.has(q.id))) return prev
        const next = new Map(prev)
        for (const { q } of pairs) next.delete(q.id)
        return next
      })
      for (const entry of drafts) for (const key of entry.keys) draftStore.clear(key)
    }
    return {
      answers: staged,
      display: displayed(pairs).map((answer, i) => nameQuestionAnswer(answer, pairs[i].q.spec, pairs[i].q.handle)),
      onOptimistic: () => {
        setError(undefined)
        settleOptimistically(slug, pairs)
      },
      onSuccess: () => { forget(); settle() },
      // Server truth replaces the optimistic settled cards either way. Refused outright, the questions
      // are still open there and the cards come back with their staged answers intact; kept as a
      // failed send, the questions ARE settled and the failed bubble carries the words.
      onRollback: (kept) => { if (kept) forget(); settle() },
    }
  }
  const submit = () => {
    if (sendScope?.composer.run()) return
    sendAlone()
  }

  return {
    slug,
    answerFor,
    answersOf,
    onChip: (q, path, isMulti, optIdx) => {
      // SINGLE: picking a chip makes it the answer; re-picking toggles off — mirroring both other
      // producers. The typed draft is never cleared (maintainer 2026-09-02): it stays in the box as an
      // unselected draft, and registeredAnswer submits the chip while one is chosen (the box taking
      // focus clears it via onText below).
      const spec = questionSpecAt(q.spec, path)
      if (!slug || !spec || q.spec.secret || !spec.options?.[optIdx]) return
      const key = draftKey.questionPick(projectDir, slug, q.id, path)
      // Read the store at the event, not the last render: rapid toggles must compose, including
      // when another mounted copy of this question just staged a pick.
      const pick = decodeQuestionPick(spec, draftStore.get(key))
      const next = isMulti
        ? { ...pick, chosenSet: pick.chosenSet.includes(optIdx) ? pick.chosenSet.filter((v) => v !== optIdx) : [...pick.chosenSet, optIdx] }
        : { ...pick, chosen: pick.chosen === optIdx ? null : optIdx }
      draftStore.set(key, encodeQuestionPick(spec, next))
    },
    onText: (q, path, isMulti, text) => {
      if (!slug || readAndAnswerHost) return
      if (q.spec.secret) {
        setSecrets((prev) => (prev.get(q.id) === text ? prev : new Map(prev).set(q.id, text)))
        return
      }
      draftStore.set(draftKey.question(projectDir, slug, q.id, path), text)
      // SINGLE: the free-text box taking over — a keystroke OR just focusing it — drops the chosen chip,
      // as the fence producer does. The card's onFocus calls this with the text unchanged for exactly
      // that reason, so writing the draft alone left the chip lit beside a focused box (2026-08-28).
      if (!isMulti) draftStore.clear(draftKey.questionPick(projectDir, slug, q.id, path))
    },
    dismiss: (id) => dismiss.mutate(id),
    dismissing: dismiss.isPending,
    submit: () => submit(),
    take,
    staged: staged.length,
    sending: send.isPending,
    error,
    readAndAnswerHost,
  }
}

// ---- ANSWERED questions: the card stays where it stood, greyed, showing only the answer ----

/** An answered registration as the transcript draws it. `pending` marks one this tab just sent and has
 *  not yet read back — see lib/settledQuestions. */
export type SettledQuestion = SettledQuestionView & { pending?: true }
const NO_SETTLED: readonly SettledQuestion[] = []
export const settledQuestionsKey = (slug: string) => ["settledQuestions", slug] as const
/** What the one per-thread read caches: the answered questions, and what each fence-asked question that
 *  closed unanswered asked (shared ClosedQuestionSpecView). Two hooks select from it, one fetch. */
interface SettledQuestionsData {
  questions: SettledQuestion[]
  closed: ClosedQuestionSpecView[]
}
const NO_CLOSED_SPECS: readonly ClosedQuestionSpecView[] = []
const selectSettled = (data: SettledQuestionsData) => data.questions
const selectClosed = (data: SettledQuestionsData) => data.closed

function useSettledQuestionsQuery<T>(slug: string | undefined, select: (data: SettledQuestionsData) => T) {
  return useQuery({
    queryKey: settledQuestionsKey(slug ?? ""),
    queryFn: async (): Promise<SettledQuestionsData> => {
      const result = await rpc.threadSettledQuestions({ slug: slug! })
      // `closed` is absent from a server older than this tab's code.
      return { questions: result.questions, closed: result.closed ?? [] }
    },
    enabled: Boolean(slug),
    refetchOnWindowFocus: false,
    select,
  })
}

/** The thread's answered questions. Read per thread rather than off the board (see the shared
 *  SettledQuestionView), and re-read on the one board event that can add to it: a question leaving the
 *  OPEN list — answered here, in another tab, or on the queue card. A withdrawal or a dismissal re-reads
 *  too, and finds nothing new; that costs one indexed SELECT. */
export function useSettledQuestions(thread: ThreadView | undefined): readonly SettledQuestion[] {
  const slug = thread?.id
  const queryClient = useQueryClient()
  const query = useSettledQuestionsQuery(slug, selectSettled)
  const openIds = (thread?.questions ?? []).map((q) => q.id).join(" ")
  const previous = useRef(openIds)
  useEffect(() => {
    const before = previous.current
    previous.current = openIds
    if (!slug || before === openIds) return
    const now = new Set(openIds.split(" "))
    if (before.split(" ").some((id) => id && !now.has(id))) void queryClient.invalidateQueries({ queryKey: settledQuestionsKey(slug) })
  }, [openIds, queryClient, slug])
  return query.data ?? NO_SETTLED
}

/** What each fence-asked question of the thread that closed WITHOUT an answer asked — read beside the
 *  answered ones, and re-read on the same event (useSettledQuestions, which every surface mounts first). */
export function useClosedQuestionSpecs(thread: ThreadView | undefined): readonly ClosedQuestionSpecView[] {
  return useSettledQuestionsQuery(thread?.id, selectClosed).data ?? NO_CLOSED_SPECS
}

const NO_OPEN: readonly RegisteredQuestionView[] = []

/** The thread's OPEN questions minus every one the settled list already holds, so one question never
 *  draws twice: in the beat between Send and the board push the row is still open on the board while
 *  its settled card is already drawn. For the question cards ONLY — everything else keeps reading the
 *  board's own `thread.questions`, because the rows are still open there until that push, and the push
 *  is what also brings `answersInFlight`: a surface that saw no questions AND nothing in flight in that
 *  beat would draw the "Rested without a sign-off" card in the hole. The board's own array when nothing
 *  is taken, so a memo keyed on it does not churn. */
export function openQuestionsOf(thread: ThreadView | undefined, settled: readonly SettledQuestion[]): readonly RegisteredQuestionView[] {
  const open = thread?.questions ?? NO_OPEN
  if (settled.length === 0 || open.length === 0) return open
  const ids = new Set(settled.map((s) => s.id))
  return open.some((q) => ids.has(q.id)) ? open.filter((q) => !ids.has(q.id)) : open
}

/** ONE answered registration, in the slot its open card filled: the same card, the same branch rule,
 *  greyed, and carrying only what was picked or typed. Read-only — the answer has been sent. */
export function SettledQuestionCard({ s, copy }: { s: SettledQuestion; copy?: boolean }) {
  const nodes = useMemo(() => settledQuestionNodes(s.spec, s.answer), [s.spec, s.answer])
  const card = (node: (typeof nodes)[number]) => (
    <QuestionBlockCard
      key={node.path}
      question={node.question}
      // THE KIND THE LIVE CARD NAMED — "Question", "Select multiple" or "Secret", the card's own default —
      // so answering a question does not rename it. A settled `multi` read "Question" until 2026-10-13, on
      // the reasoning that "Select multiple" is an instruction nobody can act on any more; but the line
      // is the card's KIND, it sits over the same checked boxes, and a card that changed its name as it
      // greyed read as a different question.
      label={node.depth > 1 ? "Follow-up" : undefined}
      settled={node.settled}
    />
  )
  const branch = nodes.slice(1)
  return (
    <article {...(copy ? { "data-question-copy": s.id } : { "data-question-id": s.id })} data-settled-question aria-label="Answered question" className="flex min-w-0 flex-col gap-2 opacity-60">
      {card(nodes[0])}
      {branch.length > 0 && (
        <div className="ml-3 flex flex-col gap-2 border-l border-border pl-3">
          {branch.map((node) => (
            <div key={node.path} className={node.depth > 2 ? "ml-3 border-l border-border pl-3" : undefined}>
              {card(node)}
            </div>
          ))}
        </div>
      )}
    </article>
  )
}

/** Several answered registrations anchored after one message. */
export function SettledQuestionStack({ questions, className = "" }: { questions: readonly SettledQuestion[]; className?: string }) {
  if (questions.length === 0) return null
  return (
    <section data-settled-questions aria-label={`${questions.length} answered question${questions.length === 1 ? "" : "s"}`} className={`flex min-w-0 flex-col gap-3 ${className}`}>
      {questions.map((s) => <SettledQuestionCard key={s.id} s={s} />)}
    </section>
  )
}

// ---- THE QUESTION FENCE: what a fence's `id:` resolves against ----

/** A registered row as a ```question fence's id resolves it: the open or answered row itself, whose id and
 *  tree carry its names and which an open fence draws live — or, for a question that CLOSED without an
 *  answer, its one handle and which way it closed (the board's compact `closedQuestions`; the fence itself
 *  carries what was asked). */
export type FenceQuestionRow =
  | (RegisteredQuestionView & { closed?: undefined })
  // `asked`: what it asked (useClosedQuestionSpecs), for the copy an `id:`-only fence draws. Not `spec`,
  // which would make every handle in its tree a name for it (lib/questionShadow questionNames).
  | { id: string; spec?: undefined; handle: string; closed: ClosedQuestionView["state"]; asked?: AskedQuestion }

/** The ANSWERED question a fence's row is, or undefined for an open or closed one: useFenceQuestions lists
 *  the settled rows as they are, answer and all. */
export function answeredRow(row: FenceQuestionRow): SettledQuestion | undefined {
  return "settledAt" in row ? (row as SettledQuestion) : undefined
}

/** Every row the thread knows — open, answered, and closed without an answer — when it speaks THE QUESTION
 *  FENCE (dispatched after QUESTION_FENCE_RETIRED_AT, so `fencesLive` is false), else undefined: the legacy
 *  free-form fence is that thread's grammar, and Message keeps reading it. One memoized array per surface,
 *  handed to every Message, so a message's memo boundary only moves when a row is added or settled. */
export function useFenceQuestions(
  fencesLive: boolean,
  open: readonly RegisteredQuestionView[],
  settled: readonly SettledQuestion[],
  thread?: Pick<ThreadView, "closedQuestions">,
  closedSpecs: readonly ClosedQuestionSpecView[] = NO_CLOSED_SPECS,
): readonly FenceQuestionRow[] | undefined {
  const pushed = thread?.closedQuestions
  // Keyed on content: the board re-sends the same closed rows on every push of this thread.
  const closedKey = pushed?.length ? pushed.map((q) => `${q.id}:${q.state}`).join(" ") : ""
  const closed = useMemo(
    () => {
      const asked = new Map(closedSpecs.map((c) => [c.id, c.spec]))
      return (pushed ?? []).map((q): FenceQuestionRow => ({ id: q.id, handle: q.handle, closed: q.state, asked: asked.get(q.id) }))
    },
    [closedKey, closedSpecs], // eslint-disable-line react-hooks/exhaustive-deps
  )
  return useMemo(() => (fencesLive ? undefined : [...open, ...settled, ...closed]), [fencesLive, open, settled, closed])
}

/** The open questions a surface draws NOW: the board's, minus a fence-asked row whose message the loaded
 *  transcript has not caught up with yet (lib/questionArrival — the board is a round trip ahead of the
 *  transcript, and a row drawn in that beat started at the tail and hopped into its message). Re-asks
 *  itself when the bounded wait runs out, so a row is never held for good. */
export function useArrivedQuestions(open: readonly RegisteredQuestionView[], messages: readonly ArrivalMessage[]): readonly RegisteredQuestionView[] {
  const firstSeen = useRef(new Map<string, number>())
  const [, recheck] = useState(0)
  const { shown, wakeAt } = arrivedQuestions(open, messages, firstSeen.current, Date.now())
  useEffect(() => {
    if (wakeAt === undefined) return
    const timer = setTimeout(() => recheck((n) => n + 1), Math.max(0, wakeAt - Date.now()))
    return () => clearTimeout(timer)
  }, [wakeAt])
  // One array per held set: `shown` is rebuilt on every render while something waits. (The key names what
  // is HELD, never what is shown: with one open question, "all held" and "none held" both show the same
  // ids-joined string, and the stale empty list then outlived the wait.)
  const held = shown === open ? "" : open.filter((q) => !shown.includes(q)).map((q) => q.id).join(" ")
  return useMemo(() => shown, [open, held]) // eslint-disable-line react-hooks/exhaustive-deps
}

/** The surface's messages with each REFUSED question fence marked on the message that wrote it
 *  (lib/questionFaults): the board's `questionFaults`, matched by id and by the message whose span holds
 *  the fault's instant. The same array comes back when nothing was refused. Keyed on the faults' content
 *  rather than their identity, so a board push carrying the same refusals re-renders no message. */
export function useRefusedFences<M extends FaultMessage>(
  messages: readonly M[],
  thread: Pick<ThreadView, "questionFaults" | "closedQuestions"> | undefined,
  open: readonly RegisteredQuestionView[],
  settled: readonly SettledQuestion[],
): M[] {
  const pushed = thread?.questionFaults
  const key = questionFaultsKey(pushed)
  // `key` IS the list's content, so the copy from the first push that carried it stands in for the rest.
  const faults = useMemo(() => pushed, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  // Every row this tab knows was ASKED somewhere, for the rule that the message which registered a name is
  // never marked for it. Only read when there are faults, so the closed rows are taken as pushed.
  const closed = thread?.closedQuestions
  const rows = useMemo(() => (faults?.length ? [...open, ...settled, ...(closed ?? [])] : []), [faults, open, settled, closed])
  return useMemo(() => (faults?.length ? withRefusedFences(messages, faults, rows) : messages) as M[], [messages, faults, rows])
}

/** The surface's messages with each id the thread asked more than once — a settled question's id asked
 *  again — resolved to the row it meant in each message that mentions it (lib/questionOwners). The same
 *  array comes back on every thread that never reused an id. */
export function useQuestionOwners<M extends OwnerMessage>(
  messages: readonly M[],
  thread: Pick<ThreadView, "closedQuestions"> | undefined,
  open: readonly RegisteredQuestionView[],
  settled: readonly SettledQuestion[],
): M[] {
  const closed = thread?.closedQuestions
  const closedKey = closed?.length ? closed.map((q) => q.id).join(" ") : ""
  const rows = useMemo(() => [...open, ...settled, ...(closed ?? [])], [open, settled, closedKey]) // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => withQuestionOwners(messages, rows) as M[], [messages, rows])
}

/** A ```question fence's ask before its row exists: the same card, READ-ONLY, from the fence's own spec.
 *  The server registers the row a second or two after the transcript records the message (and never
 *  registers a fence it refused), so in that beat the question is visible but not yet answerable; the
 *  surface swaps in the registered card in this slot once the board carries the row. Only the root is
 *  drawn: a follow-up opens under a pick, and nothing can be picked here. */
export function UnregisteredQuestionCard({ spec }: { spec: AskedQuestion }) {
  const question = useMemo(() => toParsedQuestion(spec).question, [spec])
  return (
    <article data-question-fence={spec.handle} data-question-unregistered className="flex min-w-0 flex-col gap-2">
      {/* `pending`: the rows the answerable card will have, so the swap moves nothing below it. */}
      <QuestionBlockCard question={question} pending />
    </article>
  )
}

/** A fence-asked question that CLOSED WITHOUT AN ANSWER, in its fence's slot: dismissed (the human's ×, or
 *  Frizz cancelling a question an autonomous thread wrote the moment it wrote it) or withdrawn by the
 *  worker. Drawn from the fence's own spec — the board lists only that the row closed, and which way —
 *  greyed like an answered card and headed with what happened, so it cannot be read as a question still
 *  waiting: until 2026-10-13 it drew as the read-only card a question wears for the second before it
 *  becomes answerable, and stayed that way for good. Root only, like that card. */
export function ClosedQuestionCard({ spec, state, copyOf }: { spec: AskedQuestion; state: ClosedQuestionView["state"]; copyOf?: string }) {
  const question = useMemo(() => toParsedQuestion(spec).question, [spec])
  return (
    <article {...(copyOf ? { "data-question-copy": copyOf } : { "data-question-fence": spec.handle })} data-question-closed={state} aria-label={state === "dismissed" ? "Dismissed question" : "Withdrawn question"} className="flex min-w-0 flex-col gap-2 opacity-60">
      <QuestionBlockCard question={question} label={state === "dismissed" ? "Question dismissed" : "Question withdrawn"} settled={NOT_ANSWERED} />
    </article>
  )
}
const NOT_ANSWERED = { chosenIdxs: [] }

/** A ```question fence that asked nothing, drawn as the question it would have been: one the server
 *  REFUSED to register (lib/questionBlocks `refusedAsk`: its id was spent, its parent settled, the thread
 *  runs autonomously), or one that did not read (`invalidFence`, from its draft). The reason in one line,
 *  over the question read-only and greyed. Until 2026-11-04 both drew as the worker's YAML in a code
 *  block, and a well-formed question refused only for reusing an id read as a fence the parser could not
 *  read (maintainer, the same day: "I don't want questions to be showing up as plain YAML"). The reason
 *  sits OUTSIDE the greyed card: inside it, at the card's footnote size, it was the faintest text on the
 *  card while being the one line the reader came for. */
export function RefusedQuestionCard({ spec, reasons, unread }: { spec: AskedQuestion; reasons?: readonly string[]; unread?: boolean }) {
  const question = useMemo(() => toParsedQuestion(spec).question, [spec])
  const data = unread ? { "data-question-invalid": spec.handle } : { "data-question-refused-ask": spec.handle }
  return (
    <QuestionNotAsked reasons={reasons} {...data}>
      {/* No `data-question-fence`: that names the card a question's id draws, and this id's is elsewhere. */}
      <div className="opacity-60">
        <QuestionBlockCard question={question} />
      </div>
    </QuestionNotAsked>
  )
}

/** A fence that did not read and has no `question:` line to draw a card from (lib/questionBlocks
 *  `invalidFence` with no draft): the reader's reason in the same line, and the worker's bytes folded
 *  under it, never spread open on the page as front matter. */
export function InvalidQuestionFence({ faults, children }: { faults: readonly string[]; children: ReactNode }) {
  return (
    <QuestionNotAsked reasons={faults} data-question-invalid="">
      {children}
    </QuestionNotAsked>
  )
}

/** "Question not asked: <the first reason>." over what the worker wrote — the one wording for a fence
 *  Frizz refused and one it could not read, beside RefusedQuestionReference's line for a reference. */
function QuestionNotAsked({ reasons, children, ...data }: { reasons?: readonly string[]; children: ReactNode } & Record<`data-${string}`, string>) {
  const why = refusalSummary(reasons)
  const html = useInlineMarkdownHtml(why ? `Question not asked: ${why}.` : "Question not asked.")
  return (
    <div {...data} className="flex min-w-0 flex-col gap-1.5">
      <p data-question-not-asked className="text-[13px] leading-snug text-muted">
        <LinkedHtml as="span" className="md-inline" html={html} />
      </p>
      {children}
    </div>
  )
}

/** An `id:`-only fence the server REFUSED (lib/questionBlocks `refusedRef`): the worker pointed at a card
 *  that is not there. One muted line in the fence's slot, naming the id and why no card is drawn — where
 *  the bare code block `id: …` used to sit and read as a stray snippet. `closed` is the row's state when
 *  the id names a question that was asked and has since closed; absent, nothing ever asked it. */
export function RefusedQuestionReference({ id, closed }: { id: string; closed?: ClosedQuestionView["state"] }) {
  const why = closed === "withdrawn" ? "a question the worker withdrew"
    : closed === "dismissed" ? "a question that was dismissed"
    : "a question this thread never asked"
  return (
    <p data-question-refused={id} className="md-inline text-[13px] leading-snug text-muted">
      Refers to <code>{id}</code>, {why}.
    </p>
  )
}

/** Mounted ONCE per thread surface, by the surface's shell (ThreadSurface) — INSIDE its
 *  QueueDismissContext, which the send reads. */
export function RegisteredAnsweringProvider({ thread, children }: { thread: ThreadView | undefined; children: ReactNode }) {
  const answering = useRegisteredAnswering(thread)
  return <RegisteredAnsweringContext.Provider value={answering}>{children}</RegisteredAnsweringContext.Provider>
}

/** ONE registered question: its root card and the follow-up branch the staged answer opens. Reads the
 *  surface's shared state through context, or the one a stack hands it. */
export function RegisteredQuestionCard({ q, answering: given }: { q: RegisteredQuestionView; answering?: RegisteredAnswering }) {
  const shared = useContext(RegisteredAnsweringContext)
  const phone = usePhoneQuestions()
  const a = given ?? shared
  if (!a || !a.slug) return null
  // On the phone thread page the card is a reading surface; the sheet answers it (PhoneQuestionCards).
  if (phone) return <CompactQuestionList questions={[q]} />
  if (a.readAndAnswerHost && questionNeedsMachine(q.spec)) {
    return (
      <article data-question-id={q.id} className="flex min-w-0 flex-col gap-2">
        <QuestionBlockCard question={toParsedQuestion(q.spec).question} />
        <ReadAndAnswerCardNote className="text-[12px] text-muted">This question has to be answered on {a.readAndAnswerHost}.</ReadAndAnswerCardNote>
      </article>
    )
  }
  const nodes = liveQuestionNodes(q.spec, a.answersOf(q))
  const card = (node: (typeof nodes)[number]) => (
    <QuestionBlockCard
      key={node.path}
      question={node.question}
      // Named for what it IS, so the relationship survives even where the rule is subtle.
      label={node.depth > 1 ? "Follow-up" : undefined}
      // The ×, on the ROOT card's title row only — one registration is one thing to dismiss, and a
      // follow-up cannot be declined separately from the answer that opened it. It is NEVER offered on
      // a `danger` question: a generic close icon is not consent for something irreversible, and
      // declining is a real option INSIDE that question. The server refuses one too, so this is the
      // affordance and not the rule.
      aside={node.depth === 1 && !q.spec.danger && !a.readAndAnswerHost ? (
        <button
          type="button"
          data-dismiss-question
          aria-label="Dismiss this question"
          title="Dismiss — the worker decides it itself"
          disabled={a.dismissing}
          onClick={() => a.dismiss(q.id)}
          // PLACED BY CONSTRUCTION, not by a fitted constant. `p-1 -m-1` cancels exactly, so the
          // button's layout box is the bare 16px svg while its hit area stays 24px; at 16px lucide's X
          // paints 8px of ink centred in its box, and `card-icon-offset` centres that ink on the
          // title's cap block, with nothing to re-measure when the type scale moves.
          // Hand-placed at `-my-1` with a 13px glyph first: the x rode 2.40px above where the offset
          // now puts it. (It shared the corner with the card's HelpCircle kind glyph until 2026-08-31,
          // when the glyph was dropped — a full-strength decoration beside the muted control read as
          // the actionable thing — so the × is the corner mark now.)
          //
          // `flex` is load-bearing: a button is inline-block by default, so inside the head's
          // `leading-6` aside span it sits on that span's BASELINE — which moves with the font and put
          // the x 1.00px high under sans while reading 0.00 under mono. A block-level box has no
          // baseline to sit on, and both settings then measure 0.00.
          //
          // HORIZONTALLY the trim is DEEPER than the padding, because lucide's X paints only 8 of its
          // 16 box px: `-mx-2` collapses the padding AND that inset, so the layout box IS the ink box
          // — which now lands the ×'s ink flush on the card's right content edge (the p-4 inset),
          // where the dropped glyph's ink sat 1.33px shy of it.
          className="icon-focus-outline card-icon-offset -mx-2 -my-1 flex rounded-md p-1 text-muted-70 outline-none transition-colors hover:bg-hover-strong hover:text-fg disabled:opacity-40"
        >
          <X size={16} />
        </button>
      ) : undefined}
      interactive={{
        answer: a.answerFor(q, node.path),
        onChip: (optIdx) => a.onChip(q, node.path, node.spec.kind === "multi", optIdx),
        onText: (text) => a.onText(q, node.path, node.spec.kind === "multi", text),
        onSubmit: a.submit,
        ...(a.readAndAnswerHost ? { optionsOnly: true } : {}),
      }}
    />
  )
  // THE WHOLE BRANCH SITS BEHIND ONE CONTINUOUS RULE, opened by the first follow-up and closed by the
  // last — everything below the root belongs to the single option that was taken. A rule per card (the
  // first cut) drew that one branch as a stack of unrelated indents, because the article's own gap broke
  // the line between every pair. Depth 3 nests its own rule inside this one, which is where the tree
  // stops (ASK_MAX_DEPTH).
  const branch = nodes.slice(1)
  return (
    <article data-question-id={q.id} className="flex min-w-0 flex-col gap-2">
      {card(nodes[0])}
      {branch.length > 0 && (
        <div className="ml-3 flex flex-col gap-2 border-l border-border pl-3">
          {branch.map((node) => (
            <div key={node.path} className={node.depth > 2 ? "ml-3 border-l border-border pl-3" : undefined}>
              {card(node)}
            </div>
          ))}
        </div>
      )}
    </article>
  )
}

export function RegisteredQuestionStack({
  thread,
  questions: only,
  inFlight = null,
  showSend = false,
  className = "",
}: {
  thread: ThreadView | undefined
  // WHICH of the thread's open questions this mount draws. Every surface places a question at the REST
  // IT WAS ASKED AT rather than at the transcript's tail (lib/questionAnchor), so one thread can have
  // several of these mounted at different depths — each handed its own group, minus the questions a
  // marker placed inside a message (lib/questionShadow placeQuestions).
  questions?: readonly RegisteredQuestionView[]
  // THE ANSWER ALREADY SENT AND NOT YET ON SCREEN ANYWHERE ELSE — the rows of `thread.answersInFlight`
  // the transcript is not already drawing (lib/answersMessage.unrenderedAnswers). Passed IN rather than
  // read off the thread here, because deciding it needs the transcript this stack is pinned beside, and
  // because only ONE mount may draw it: the answer is the human's newest turn and belongs at the tail
  // however deep the questions themselves sit. An anchored mount simply omits it.
  inFlight?: PairedAnswer[] | null
  // Draw the "Send answers" verb even with NO card of its own: the rest's every question was placed
  // inside the prose above, and this — the rest's stack at its anchor — is still where the one Send
  // for all of them lives.
  showSend?: boolean
  className?: string
}) {
  const slug = thread?.id
  const questions = only ?? thread?.questions ?? []
  // A provider above this stack owns the state; without one, this stack does (a surface that never
  // places a card has no reason to mount the provider).
  const shared = useContext(RegisteredAnsweringContext)
  const own = useRegisteredAnswering(shared ? undefined : thread)
  const a = shared ?? own
  const phone = usePhoneQuestions()
  // The surface's prompt box sends these (lib/sendScope), so this stack draws no Send of its own —
  // and a stack with no card of its own, mounted only to carry that Send, has nothing left to draw.
  const promptBoxSends = usePromptBoxSends()
  const drawsSend = showSend && !promptBoxSends

  // THE ANSWER, ALREADY SENT AND NOT YET IN THE WORKER'S HANDS. Answering stores the row; a wake hands
  // it over a moment later (deliberately — an answer given while the worker's process is down has to
  // survive the gap). In between, the question card is gone and the delivered turn has not arrived, so
  // this slot went EMPTY and the thread — at rest, with nothing registered any more — drew the residual
  // "Rested without a sign-off" card in the hole (maintainer 2026-08-27: "a little card that, for like
  // 5+ seconds, just says that the thread rested without a sign-off before it shows up my answer").
  //
  // The board composes the bytes the delivery will carry, and the caller parses them with the reader the
  // chat uses on the landed turn — so the in-flight card and the real one are the SAME card and the swap
  // is invisible. Dimmed while it is in flight, exactly like an optimistic follow-up bubble. The caller
  // also decides when it has become a SECOND copy of a card the transcript is already drawing, which is
  // the whole reason the rows arrive as a prop rather than off the thread — see unrenderedAnswers.
  // ON THE PHONE THREAD PAGE there is no per-stack Send — the bottom bar's Answer opens the sheet that
  // sends — so a stack whose questions were all placed in the prose above has nothing of its own to draw.
  if (!slug || (questions.length === 0 && (!drawsSend || phone))) {
    if (!slug || !inFlight?.length) return null
    return (
      <section data-answers-in-flight aria-label="Your answer, on its way to the worker" className={`flex min-w-0 flex-col items-end ${className}`}>
        <AnswersCard answers={inFlight} queued />
      </section>
    )
  }

  if (phone) {
    return (
      <section
        data-registered-questions
        aria-label={`${questions.length} question${questions.length === 1 ? "" : "s"} waiting for an answer`}
        className={`flex min-w-0 flex-col gap-3 ${className}`}
      >
        <CompactQuestionList questions={questions} />
        {/* The sheet closes on Send, so a refusal has to surface HERE, beside the questions it restored. */}
        {a.error && <div role="alert" className="break-words text-[13px] leading-snug text-danger-soft">{a.error}</div>}
        {a.sending && <div role="status" aria-live="polite" className="text-[13px] leading-snug text-muted">Sending…</div>}
      </section>
    )
  }

  return (
    <section
      data-registered-questions
      aria-label={questions.length > 0 ? `${questions.length} question${questions.length === 1 ? "" : "s"} waiting for an answer` : "Send the answers above"}
      className={`flex min-w-0 flex-col gap-3 ${className}`}
    >
      {questions.map((q) => <RegisteredQuestionCard key={q.id} q={q} answering={a} />)}
      {a.error && <div role="alert" className="break-words text-[11px] leading-snug text-danger-soft">{a.error}</div>}
      {a.sending && (
        <div role="status" aria-live="polite" className="text-[11px] leading-snug text-muted">Sending…</div>
      )}
      {/* Only where no prompt box sends them: there, its Send button is the one send for every
          staged answer and the typed message together (maintainer 2026-10-11). */}
      {!promptBoxSends && (
        <div className="flex justify-start">
          <button
            type="button"
            data-send-answers
            disabled={a.staged === 0 || a.sending}
            onClick={a.submit}
            onMouseDown={(e) => e.preventDefault()}
            className="button-outline rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-all hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:hover:opacity-30"
          >
            Send answers
          </button>
        </div>
      )}
    </section>
  )
}

/** EVERY node path in a question's tree — live or not. The draft subscription and the clear-on-send both
 *  need the whole tree, not just what is currently on screen: text typed into a branch, abandoned, and
 *  returned to must still be there, and a settled question must leave nothing behind anywhere. */
function allPaths(q: RegisteredQuestionView): string[] {
  const out: string[] = []
  const walk = (node: RegisteredQuestionView["spec"], path: string) => {
    out.push(path)
    node.options?.forEach((option, optIdx) => {
      option.followUps?.forEach((child, fuIdx) => walk(child, `${path}/${optIdx}.${fuIdx}`))
    })
  }
  walk(q.spec, ROOT_PATH)
  return out
}

/** Is this question answered enough to send? Exported for the board card, which shows a count. */
export function questionIsStaged(q: RegisteredQuestionView, answers: ReadonlyMap<string, BlockAnswer>): boolean {
  return nodeAnswered(q.spec, answers.get(ROOT_PATH))
}
