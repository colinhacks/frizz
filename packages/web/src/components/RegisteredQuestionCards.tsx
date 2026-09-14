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
// that surface reads it through context. A stack mounted with no provider above it (a surface that
// never places) owns a state of its own, exactly as it did before.
import { createContext, useContext, useMemo, useState, type ReactNode } from "react"
import { useMutation } from "@tanstack/react-query"
import { X } from "lucide-react"
import type { QuestionAnswer, RegisteredQuestionView, ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { draftKey, draftStore, useDraftValues, useProjectDir } from "../lib/drafts.ts"
import type { BlockAnswer } from "../lib/questionBlocks.ts"
import type { PairedAnswer } from "../lib/answersMessage.ts"
import { ROOT_PATH, liveQuestionNodes, nodeAnswered, registeredAnswer } from "../lib/registeredQuestion.ts"
import { AnswersCard } from "./AnswersCard.tsx"
import { QueueDismissContext } from "./ChatView.tsx"
import { QuestionBlockCard } from "./QuestionBlockCard.tsx"

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : "The answer could not be sent."
  return message.length > 240 ? `${message.slice(0, 239)}…` : message
}

/** The chip/toggle half of a staged answer, keyed by `<question id>|<node path>`. The free-text half
 *  lives in the draft store instead, so a half-typed answer survives a remount and a worker restart. */
type Picks = Map<string, { chosen: number | null; chosenSet: number[] }>
const pickKey = (id: string, path: string) => `${id}|${path}`

/** The thread's whole answering state: what is staged on every open question, and the one send. */
export interface RegisteredAnswering {
  slug: string | undefined
  answerFor: (q: RegisteredQuestionView, path: string) => BlockAnswer
  answersOf: (q: RegisteredQuestionView) => ReadonlyMap<string, BlockAnswer>
  onChip: (q: RegisteredQuestionView, path: string, isMulti: boolean, optIdx: number) => void
  onText: (q: RegisteredQuestionView, path: string, isMulti: boolean, text: string) => void
  dismiss: (id: string) => void
  dismissing: boolean
  /** Send EVERY staged answer on the thread — placed or at an anchor, this rest's or an older one. */
  submit: () => void
  staged: number
  sending: boolean
  error: string | undefined
}

export const RegisteredAnsweringContext = createContext<RegisteredAnswering | null>(null)

/** The state behind every registered card on a surface. `thread` undefined (a stack that found a
 *  provider above it) yields an inert state nobody reads — hooks cannot be conditional. */
export function useRegisteredAnswering(thread: ThreadView | undefined): RegisteredAnswering {
  const slug = thread?.id
  const questions = thread?.questions ?? []
  const projectDir = useProjectDir()
  const [picks, setPicks] = useState<Picks>(() => new Map())
  const [error, setError] = useState<string>()
  // THE QUEUE CARD DISSOLVES ON SEND, like every other action on it. Answering is the same commitment as
  // a fenced Send answers or a composer steer — both of which take the card out of the queue the instant
  // the human commits, without waiting on the round-trip (see useLiveAnswering's onSent) — and this was
  // the one send that did not, so a card answered on a loaded machine sat there for the seconds it took
  // the board to catch up, which is the window its answer rendered twice in (2026-09-01). Null on the
  // thread page, where there is no card to dismiss.
  const queueDismiss = useContext(QueueDismissContext)

  // Every free-text box of every question, subscribed as one batch — the draft store's own hook takes a
  // key list, and the set only changes when a question is registered or settled.
  const textKeys = useMemo(
    () => (slug ? questions.flatMap((q) => allPaths(q).map((path) => draftKey.question(projectDir, slug, q.id, path))) : []),
    [projectDir, slug, questions],
  )
  const persistedText = useDraftValues(textKeys)
  const answerFor = (q: RegisteredQuestionView, path: string): BlockAnswer => {
    const pick = picks.get(pickKey(q.id, path))
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
  const staged: QuestionAnswer[] = questions.flatMap((q) => {
    const built = registeredAnswer(q, answersOf(q))
    return built ? [built] : []
  })

  const send = useMutation({
    mutationFn: async (answers: QuestionAnswer[]) => rpc.answerQuestions({ slug: slug!, answers }),
    onSuccess: (result) => {
      // The rows are gone from the board push that follows, so the staged state for them is dead weight;
      // dropping the drafts too keeps a re-asked question from opening pre-filled with a stale answer.
      for (const id of result.answered) {
        setPicks((prev) => {
          const next = new Map(prev)
          for (const key of [...next.keys()]) if (key.startsWith(`${id}|`)) next.delete(key)
          return next
        })
        const q = questions.find((entry) => entry.id === id)
        if (q && slug) for (const path of allPaths(q)) draftStore.set(draftKey.question(projectDir, slug, q.id, path), "")
      }
    },
    onError: (cause) => {
      // The card faded on click; the answer did not land, so put it back rather than leaving the human
      // looking at a queue that quietly swallowed their reply. Same reversal an optimistic Mark-as-done
      // makes when the server declines it.
      queueDismiss?.cancel()
      setError(errorText(cause))
    },
  })
  const dismiss = useMutation({
    mutationFn: async (id: string) => rpc.dismissQuestions({ slug: slug!, ids: [id] }),
    onError: (cause) => setError(errorText(cause)),
  })

  const submit = () => {
    if (!slug || staged.length === 0 || send.isPending) return
    setError(undefined)
    // Local truth FIRST, then the network — the ordering every other send on this card obeys, and the
    // whole of what "the card goes away when I answer it" means on a machine under load.
    queueDismiss?.dismiss()
    send.mutate(staged)
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
      setPicks((prev) => {
        const next = new Map(prev)
        const key = pickKey(q.id, path)
        const pick = next.get(key) ?? { chosen: null, chosenSet: [] }
        if (isMulti) {
          const set = pick.chosenSet.includes(optIdx)
            ? pick.chosenSet.filter((v) => v !== optIdx)
            : [...pick.chosenSet, optIdx]
          next.set(key, { ...pick, chosenSet: set })
        } else {
          next.set(key, { ...pick, chosen: pick.chosen === optIdx ? null : optIdx })
        }
        return next
      })
    },
    onText: (q, path, isMulti, text) => {
      if (!slug) return
      draftStore.set(draftKey.question(projectDir, slug, q.id, path), text)
      // SINGLE: the free-text box taking over — a keystroke OR just focusing it — drops the chosen chip,
      // as the fence producer does. The card's onFocus calls this with the text unchanged for exactly
      // that reason, so writing the draft alone left the chip lit beside a focused box (2026-08-28).
      if (!isMulti) setPicks((prev) => {
        const key = pickKey(q.id, path)
        const pick = prev.get(key)
        if (!pick || pick.chosen === null) return prev
        return new Map(prev).set(key, { ...pick, chosen: null })
      })
    },
    dismiss: (id) => dismiss.mutate(id),
    dismissing: dismiss.isPending,
    submit,
    staged: staged.length,
    sending: send.isPending,
    error,
  }
}

/** Mount ONCE per surface that draws registered cards in more than one place. Must sit INSIDE the
 *  surface's QueueDismissContext, which the send reads. */
export function RegisteredAnsweringProvider({ thread, children }: { thread: ThreadView | undefined; children: ReactNode }) {
  const answering = useRegisteredAnswering(thread)
  return <RegisteredAnsweringContext.Provider value={answering}>{children}</RegisteredAnsweringContext.Provider>
}

/** ONE registered question: its root card and the follow-up branch the staged answer opens. Reads the
 *  surface's shared state through context, or the one a stack hands it. */
export function RegisteredQuestionCard({ q, answering: given }: { q: RegisteredQuestionView; answering?: RegisteredAnswering }) {
  const shared = useContext(RegisteredAnsweringContext)
  const a = given ?? shared
  if (!a || !a.slug) return null
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
      aside={node.depth === 1 && !q.spec.danger ? (
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
          // title's cap block in BOTH fonts, with nothing to re-measure when the setting flips.
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
          className="card-icon-offset -mx-2 -my-1 flex rounded-md p-1 text-muted-70 outline-none transition-colors hover:bg-elevated hover:text-fg disabled:opacity-40"
        >
          <X size={16} />
        </button>
      ) : undefined}
      interactive={{
        answer: a.answerFor(q, node.path),
        onChip: (optIdx) => a.onChip(q, node.path, node.spec.kind === "multi", optIdx),
        onText: (text) => a.onText(q, node.path, node.spec.kind === "multi", text),
        onSubmit: a.submit,
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
  if (!slug || (questions.length === 0 && !showSend)) {
    if (!slug || !inFlight?.length) return null
    return (
      <section data-answers-in-flight aria-label="Your answer, on its way to the worker" className={`flex min-w-0 flex-col items-end ${className}`}>
        <AnswersCard answers={inFlight} queued />
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
      <div className="flex justify-start">
        <button
          type="button"
          data-send-answers
          disabled={a.staged === 0 || a.sending}
          onClick={a.submit}
          onMouseDown={(e) => e.preventDefault()}
          className="rounded-md bg-fg px-3 py-1.5 text-[12px] font-medium text-bg outline-none transition-all hover:opacity-90 active:scale-95 disabled:opacity-30 disabled:hover:opacity-30"
        >
          Send answers
        </button>
      </div>
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
