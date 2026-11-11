import { useCallback, useMemo, useRef, useState } from "react"
import { BURIED_ANSWERS_HEADER, indentAnswerContinuation } from "@frizz/shared"
import { type ChatMessage } from "../hooks.ts"
import { draftKey, draftStore, useDraftValues, useProjectDir, useThreadSessionId } from "./drafts.ts"
import { useEagerFollowUp, type EagerFollowUpCallbacks } from "./eagerComposerSubmission.ts"
import type { ComposerSendHandle, FencedTake } from "./sendScope.tsx"
import {
  splitQuestionBlocks,
  parseQuestionBlock,
  composeBlockAnswer,
  type ParsedQuestion,
  type BlockAnswer,
  type MessageAnswering,
} from "./questionBlocks.ts"

export interface LiveAnswering {
  liveMsg: ChatMessage | undefined // the LAST substantive assistant message (its blocks get chips)
  answering: MessageAnswering | undefined // undefined when there's nothing answerable (bound to liveMsg)
  // Per-message answering view — the open-tail generalization. Returns the interactive controller for
  // ANY question-bearing assistant message, wherever it sits in the transcript, or undefined for an
  // ordinary message. undefined is a stable primitive, so a memoized Message bails out unchanged for
  // the (many) rows that carry no question.
  answeringForMessage: (m: ChatMessage) => MessageAnswering | undefined
  anyAnswered: boolean
  sending: boolean
  // Compose the filled per-block answers into one eager reply. With no argument every open ask is
  // gathered. Pass a message identity to scope the send to JUST that message's blocks — the thread
  // view's per-message Send button, which
  // deliberately answers one message at a time so its state never bleeds into another open ask.
  sendAnswers: (scopeIdentity?: string) => void
  sendMessage: (text: string, callbacks?: EagerFollowUpCallbacks) => void // freeform eager reply (same path as an answer)
  // THE PROMPT BOX'S HALF OF THE ONE SEND (lib/sendScope): how many blocks carry an answer — which
  // turns its button white with the box still empty — and the answers themselves, composed, with the
  // two edges that clear them on send and put them back on a refusal. Null when nothing is staged.
  stagedCount: number
  takeAnswers: () => FencedTake | null
}

// One question-bearing assistant message that is still OPEN (unanswered) — its parsed blocks, its stable
// identity (for draft/answer keys), and whether it is the LIVE (last substantive assistant) message. A
// buried ask (something the agent said after it, without a human turn in between) has isLive=false.
export interface OpenAsk {
  idx: number
  identity: string
  blocks: ParsedQuestion[]
  isLive: boolean
}

// The minimal message shape the open-ask walk needs — role/kind/text plus the stable server sourceId.
// Kept structural (not ChatMessage) so selectOpenAsks stays pure and unit-testable without the schema.
export interface AskMsgLike {
  role: string
  kind?: string
  text: string
  sourceId?: string
}

// A question block's identity, mirrored from the draft layer: the transcript's stable server sourceId,
// or a deterministic content identity for legacy lines without one (never a list index, so a
// prepend/reorder can't attach text to another question).
function messageIdentityOf(m: AskMsgLike): string {
  return m.sourceId ?? `legacy-${stableTextIdentity(m.text)}`
}

// Last substantive assistant message (skipping event/reasoning punctuation) — the positional `isLive`
// anchor shared by both walks below. -1 when the transcript has no assistant prose yet.
function lastSubstantiveAssistantIdx(messages: readonly AskMsgLike[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.kind === "event" || m.kind === "reasoning") continue // punctuation (completion / codex reasoning)
    if (m.role === "assistant" && m.text.trim()) return i
  }
  return -1
}

const parseAskBlocks = (text: string): ParsedQuestion[] =>
  splitQuestionBlocks(text)
    .filter((s) => s.kind === "question")
    .map((s) => (s.kind === "question" ? parseQuestionBlock(s.text, s.questionKind, s.danger) : parseQuestionBlock("", "question")))

// Two identical-text asks with NO sourceId (legacy transcripts only) hash to the same identity; suffix
// the collided one with its index so their answer state / draft keys never bleed together. Unique
// identities (the norm — sourceId is populated post-upgrade) are untouched. The dedupe walks FORWARD
// over the whole transcript so an identity never depends on where a caller started reading.
function identityAssigner(): (m: AskMsgLike, i: number) => string {
  const seen = new Set<string>()
  return (m, i) => {
    let id = messageIdentityOf(m)
    if (seen.has(id)) id = `${id}#${i}`
    seen.add(id)
    return id
  }
}

// EVERY answerable ask, in transcript order — the pure core of the controller, and the SAME scope on
// every surface. A question is answerable wherever it sits: an ask the
// agent buried under its own later work, an ask a newer ask stacked on top of, an ask a human turn
// already replied past. This is the whole "answer a question that is no longer the last thing said"
// feature, and it is best-effort by design — there is no "closing" and NOTHING tracks whether a
// question was answered. An already-answered question stays clickable (its AnswersCard renders right
// below it, so nobody re-answers by accident), and Send only gathers the blocks the human actually
// filled, so untouched questions contribute nothing.
// `isLive` marks the last substantive assistant message so composeAnswerWire can keep the historic wire
// format for the trailing ask and switch to the self-describing (question-quoting) form for an earlier
// one — a purely POSITIONAL check, not answered-tracking.
export function selectOpenAsks(messages: readonly AskMsgLike[]): OpenAsk[] {
  const lastSubstantiveAssistant = lastSubstantiveAssistantIdx(messages)
  const identityOf = identityAssigner()
  const found: OpenAsk[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.kind === "event" || m.kind === "reasoning" || m.role !== "assistant" || !m.text.trim()) continue
    // Cheap membership test before the real splitter: this walk now covers the WHOLE transcript on
    // every surface, and the vast majority of assistant turns carry no fence at all.
    if (!m.text.includes("```question")) continue
    const blocks = parseAskBlocks(m.text)
    if (blocks.length > 0) found.push({ idx: i, identity: identityOf(m, i), blocks, isLive: i === lastSubstantiveAssistant })
  }
  return found
}

// Choose the wire form for a batch of answers. When every answer belongs to the LIVE ask, emit the
// numbered form ("Answers:\n1. …", numbered by ORIGINAL block position) — INCLUDING a one-block ask,
// which used to send its answer as bare text. The bare form had no marker for the renderer to key on,
// so a single answer landed as a flat run-on bubble while every other shape of the same action got the
// structured Answers card (maintainer 2026-08-03: "always render using the answers component"). One
// header line is the whole cost, and the resuming worker reads "Answers:\n1. B. Yes" as plainly as it
// read the bare line. If ANY answer targets a BURIED ask, the numbered form is ambiguous (which turn's
// question?), so emit a self-describing form that quotes each question — readable to both the human and
// the resuming worker, whose recent context is no longer the ask.
export function composeAnswerWire(input: {
  answered: readonly { isLive: boolean; question: string; answer: string }[] // all answered, transcript order
  live?: { numbered: readonly { n: number; a: string }[] } // the live ask's answered blocks, by original position
}): string {
  const { answered, live } = input
  if (answered.length > 0 && answered.every((x) => x.isLive) && live) {
    // Continuation lines of a typed answer are indented so a typed numbered list cannot open a row of
    // its own (see indentAnswerContinuation).
    return `Answers:\n${live.numbered.map(({ n, a }) => `${n}. ${indentAnswerContinuation(a)}`).join("\n")}`
  }
  return `${BURIED_ANSWERS_HEADER}\n${answered.map((x, k) => `${k + 1}. “${x.question}” → ${indentAnswerContinuation(x.answer)}`).join("\n")}`
}

// The ONE controller for answering ```question blocks — shared by every thread surface (ThreadSurface) so
// their behavior can never drift. EVERY question in the transcript stays answerable, wherever
// it sits: a question buried by a sub-agent return or the agent's own continuation, one a newer ask
// stacked on top of, one a human turn already replied past. That scope is the SAME on both surfaces
// (maintainer 2026-08-03: "question fences should be answerable, even if there's been a more recent
// message… possible in the full view, but not in the queue card view") — the queue card used to narrow
// it to the tail ask.
// Deliberately best-effort, TRACKING NOTHING: no answered/unanswered bookkeeping, no "closing" of asks.
// An already-answered question stays clickable (its AnswersCard renders right below it), and Send only
// gathers the blocks the human actually filled, so untouched questions contribute nothing. `onSent` runs
// the caller's tail after a send (the pane: move on, or stay on a reply; a drawer: nothing), and
// `opts.onSendFailed` is its REVERSAL — see there.
export function useLiveAnswering(
  slug: string,
  messages: ChatMessage[],
  onSent?: () => void,
  // `onSendFailed` UNDOES `onSent` when the send is refused. `onSent` fires the instant the human
  // commits — that optimism is the point — so something has to reverse it when the message provably did
  // not land, and until 2026-09-01 nothing did: the queue card stayed dismissed and only a toast said
  // otherwise, until resolve()'s 8s reappear guard happened to notice the board still wanted it
  // (measured on a refused steer: 8084ms of a card the human had no way to get back). The eager send
  // only reaches its failure path once retries are exhausted or the error is provably non-replayable —
  // the same evidence it deletes the optimistic bubble on — so restoring the thread here is exactly as
  // safe as removing that bubble. A drawer or the thread page passes nothing; it has nothing to reinstate.
  // `composer` is the surface's prompt box (lib/sendScope). While one is mounted, every "send these
  // answers" gesture — Enter in a block's text box — is the prompt box's send, which carries EVERY staged answer and whatever is typed in the box as one turn. With
  // none mounted (a phone thread page) `sendAnswers` sends on its own, scoped as it always was.
  opts: { onSendFailed?: () => void; composer?: ComposerSendHandle } = {},
): LiveAnswering {
  const followUp = useEagerFollowUp(slug)
  const [answers, setAnswers] = useState<Record<string, BlockAnswer>>({})

  // The OPEN asks, in transcript order (pure walk extracted to selectOpenAsks for unit tests).
  const openAsks = useMemo(() => selectOpenAsks(messages), [messages])

  const liveMsg = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].kind === "event" || messages[i].kind === "reasoning") continue // punctuation, not the substantive assistant turn
      if (messages[i].role === "assistant" && messages[i].text.trim()) return messages[i]
    }
    return undefined
  }, [messages])

  const projectDir = useProjectDir()
  const sessionId = useThreadSessionId(slug)
  const keyFor = useCallback(
    (identity: string, block: number) => draftKey.answer(projectDir, slug, sessionId, identity, block),
    [projectDir, slug, sessionId],
  )
  // Every open block's freetext draft key, across ALL open asks — so a buried ask's answer text persists
  // exactly like the live one's. Legacy lines get a deterministic content identity (see messageIdentityOf).
  const textKeys = useMemo(
    () => openAsks.flatMap((a) => a.blocks.map((_, block) => keyFor(a.identity, block))),
    [openAsks, keyFor],
  )
  const persistedText = useDraftValues(textKeys)

  // IDENTITY DISCIPLINE (the render-perf thread): the closed/ordinary messages get a stable `undefined`
  // from answeringForMessage, so the memoized Message bails out unchanged; only the (few) open asks build
  // a controller, and only they re-render on a chip click / keystroke. The caller's onSent tail rides a
  // latest-ref because the surface passes a fresh closure every render.
  const onSentRef = useRef(onSent)
  onSentRef.current = onSent
  // Same latest-ref discipline as onSent, and for the same reason: the surface passes a fresh closure
  // every render, and `sendMessage` must stay identity-stable.
  const onSendFailedRef = useRef(opts.onSendFailed)
  onSendFailedRef.current = opts.onSendFailed

  const answerFor = useCallback(
    (identity: string, bi: number): BlockAnswer => {
      const local = answers[`${identity}::${bi}`] ?? { chosen: null, text: "" }
      return { ...local, text: persistedText.get(keyFor(identity, bi)) ?? "" }
    },
    [answers, persistedText, keyFor],
  )
  // A stable lookup of an open ask by message identity, so onChip/onText can read the block's kind.
  const openByIdentity = useMemo(() => {
    const map = new Map<string, OpenAsk>()
    for (const a of openAsks) map.set(a.identity, a)
    return map
  }, [openAsks])
  // Chip click. MULTI: toggle this option in/out of the set (kept in option order); freetext COEXISTS,
  // so it's preserved. SINGLE: picking a chip makes it the answer; re-picking toggles off. The typed
  // draft is NEVER cleared (maintainer 2026-09-02 — a click used to destroy it): it stays in the box as
  // an unselected draft, and compose sends the chip while one is chosen (onText — which the card also
  // fires when the box takes focus — clears the chip, so the text wins only when touched last).
  const onChip = useCallback(
    (identity: string, bi: number, optIdx: number) => {
      const blk = openByIdentity.get(identity)?.blocks[bi]
      const stateKey = `${identity}::${bi}`
      setAnswers((a) => {
        const cur = a[stateKey] ?? { chosen: null, text: "" }
        if (blk?.kind === "multi") {
          const set = new Set(cur.chosenSet ?? [])
          if (set.has(optIdx)) set.delete(optIdx)
          else set.add(optIdx)
          return { ...a, [stateKey]: { chosen: null, text: cur.text, chosenSet: [...set].sort((x, y) => x - y) } }
        }
        return { ...a, [stateKey]: { chosen: cur.chosen === optIdx ? null : optIdx, text: cur.text } }
      })
    },
    [openByIdentity],
  )
  // Typing. MULTI: freetext appends color on top of the toggled set — keep the set. SINGLE: the box
  // taking over — a keystroke, or just focus (the card calls this with the text unchanged then) —
  // moves the selection to the text, clearing any chosen chip. The counterpart of onChip keeping the
  // text: whichever was touched last is the answer, and neither destroys the other.
  const onText = useCallback(
    (identity: string, bi: number, text: string) => {
      const blk = openByIdentity.get(identity)?.blocks[bi]
      draftStore.set(keyFor(identity, bi), text)
      setAnswers((a) => {
        const stateKey = `${identity}::${bi}`
        const cur = a[stateKey] ?? { chosen: null, text: "" }
        if (blk?.kind === "multi") return { ...a, [stateKey]: { chosen: null, text, chosenSet: cur.chosenSet ?? [] } }
        return { ...a, [stateKey]: { chosen: null, text } }
      })
    },
    [openByIdentity, keyFor],
  )

  const stagedCount = openAsks.reduce((n, a) => n + a.blocks.filter((blk, i) => composeBlockAnswer(blk, answerFor(a.identity, i)) !== "").length, 0)
  const anyAnswered = stagedCount > 0

  // ONE place both send verbs go through, so the exit and its reversal are wired once: `sendAnswers`
  // composes its wire and hands it here, and the free-form composer calls it directly via
  // `submitOverride`. The caller's own `onRollback` (sendAnswers restores its drafts with it) runs
  // first and the card is reinstated after, so a failed answer gets its text back AND its card back.
  const sendMessage = useCallback(
    (text: string, callbacks: EagerFollowUpCallbacks = {}) => {
      const submitted = followUp.submit(text, {
        ...callbacks,
        onRollback: (failure) => { callbacks.onRollback?.(failure); onSendFailedRef.current?.() },
      })
      if (submitted) onSentRef.current?.()
    },
    [followUp],
  )
  // The staged answers, composed, with the edges that clear them and put them back. `scope` narrows it
  // to one message's blocks (the fallback per-message send); the prompt box takes everything.
  const takeAnswers = useCallback((scope?: string): FencedTake | null => {
    const scopedAsks = scope ? openAsks.filter((a) => a.identity === scope) : openAsks
    // Only the scoped asks' draft keys are cleared/rolled back — a sibling open ask keeps its draft.
    const scopedKeys = scope ? scopedAsks.flatMap((a) => a.blocks.map((_, block) => keyFor(a.identity, block))) : textKeys
    const scopedStateKeys = scopedAsks.flatMap((a) => a.blocks.map((_, bi) => `${a.identity}::${bi}`))

    // One block's answer. Used for BOTH the answered-collection and the live numbering below, so the
    // two can never disagree.
    const answerAt = (a: OpenAsk, bi: number): string => composeBlockAnswer(a.blocks[bi], answerFor(a.identity, bi))

    // Collect every answered block across the scoped asks, in transcript order.
    const answered = scopedAsks.flatMap((a) =>
      a.blocks
        .map((blk, bi) => ({ ask: a, bi, question: questionLabel(blk), answer: answerAt(a, bi) }))
        .filter((x) => x.answer !== ""),
    )
    if (answered.length === 0) return null

    // The live ask's answered blocks, numbered by ORIGINAL block position (composeAnswerWire picks the
    // "Answers:" form when every answer is live, else a self-describing quoted form).
    const live = scopedAsks.find((a) => a.isLive)
    const composed = composeAnswerWire({
      answered: answered.map((x) => ({ isLive: x.ask.isLive, question: x.question, answer: x.answer })),
      live: live && {
        numbered: live.blocks
          .map((_blk, i) => ({ n: i + 1, a: answerAt(live, i) }))
          .filter(({ a }) => a !== ""),
      },
    })

    const answerSnapshot = answers
    const draftSnapshot = scopedKeys.map((key) => [key, draftStore.get(key)] as const)
    // Keep answers intact until the RPC actually lands. A rejected request must leave the visible
    // question draft available for retry rather than silently discarding the user's work.
    return {
      wire: composed,
      onOptimistic: () => {
        scopedKeys.forEach((key) => draftStore.clear(key))
        // Drop only the scoped message's answer state; a sibling open ask's in-progress selections stay.
        setAnswers((prev) => {
          const next = { ...prev }
          for (const key of scopedStateKeys) delete next[key]
          return next
        })
      },
      onRollback: () => {
        // Restore the scoped keys from the pre-send snapshot without clobbering edits to other asks.
        setAnswers((prev) => {
          const next = { ...prev }
          for (const key of scopedStateKeys) {
            if (answerSnapshot[key]) next[key] = answerSnapshot[key]
            else delete next[key]
          }
          return next
        })
        draftSnapshot.forEach(([key, value]) => {
          if (value && !draftStore.get(key)) draftStore.set(key, value)
        })
      },
    }
  }, [answers, openAsks, answerFor, textKeys, keyFor])
  const takeAllAnswers = useCallback(() => takeAnswers(), [takeAnswers])
  const composer = opts.composer
  const sendAnswers = useCallback((scopeIdentity?: string) => {
    // The surface's prompt box sends everything staged, with whatever is typed in it — see `composer`.
    if (composer?.run()) return
    // `scopeIdentity` is a message identity when the thread's per-message Send button (or an Enter from
    // one of its blocks) fires; guard `typeof` in case a button wires it as onClick={sendAnswers}, where
    // React would hand us a MouseEvent. Non-string → gather every open ask.
    const taken = takeAnswers(typeof scopeIdentity === "string" ? scopeIdentity : undefined)
    if (taken) sendMessage(taken.wire, { onOptimistic: taken.onOptimistic, onRollback: taken.onRollback })
  }, [composer, takeAnswers, sendMessage])

  const answeringForMessage = useCallback(
    (m: ChatMessage): MessageAnswering | undefined => {
      const ask = openByIdentity.get(messageIdentityOf(m))
      if (!ask) return undefined
      return {
        answerFor: (bi: number) => answerFor(ask.identity, bi),
        onChip: (bi: number, optIdx: number) => onChip(ask.identity, bi, optIdx),
        onText: (bi: number, text: string) => onText(ask.identity, bi, text),
        // Enter / the per-message Send button submits ONLY this message's blocks (scoped identity).
        onSubmit: () => sendAnswers(ask.identity),
        anyAnswered: ask.blocks.some((blk, i) => composeBlockAnswer(blk, answerFor(ask.identity, i)) !== ""),
        sending: followUp.pending,
      }
    },
    [openByIdentity, answerFor, onChip, onText, sendAnswers, followUp.pending],
  )
  const answering = useMemo<MessageAnswering | undefined>(
    () => (liveMsg ? answeringForMessage(liveMsg) : undefined),
    [liveMsg, answeringForMessage],
  )
  return { liveMsg, answering, answeringForMessage, anyAnswered, sending: followUp.pending, sendAnswers, sendMessage, stagedCount, takeAnswers: takeAllAnswers }
}

// The first non-empty line of a question's context prose, trimmed + length-capped — a compact label for
// the self-describing buried-answer form (never the whole multi-paragraph block).
function firstLine(contextMd: string): string {
  const line = contextMd.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? ""
  return line.length > 120 ? `${line.slice(0, 117)}…` : line
}

// A compact question label for the buried-answer form. Prefer the context prose; but a block that leads
// straight into its option run has an EMPTY contextMd — fall back to the options so the resuming worker
// still sees which question this answers (never an empty '""' quote).
function questionLabel(blk: ParsedQuestion): string {
  return firstLine(blk.contextMd) || firstLine(blk.options.join(" / ")) || "earlier question"
}

function stableTextIdentity(text: string): string {
  // FNV-1a is sufficient only to make legacy transcript identities deterministic; it is not a
  // security boundary and no server/private payload is persisted.
  let hash = 2166136261
  for (let index = 0; index < text.length; index++) hash = Math.imul(hash ^ text.charCodeAt(index), 16777619)
  return (hash >>> 0).toString(36)
}
