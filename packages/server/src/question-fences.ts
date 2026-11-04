// THE QUESTION REGISTRAR — turns the ```question fences a worker writes into `thread_question` rows.
//
// The grammar and its reasons live with the parser (packages/shared/src/question-fence.ts). This is the
// half that touches storage: the tailer notes every assistant message carrying a fence
// (FoldState.questionSightings), and the scheduler hands those sightings here on every tick — mid-turn
// included, because asking does not end the turn. A router call that must see the worker's newest fence
// (`done`, `unask`) catches the tailer up and calls here first.
//
// AN ID NAMES ONE OPEN QUESTION AT A TIME. A new id registers; the same fence seen again (a refold after
// a restart, a worker restating its question) finds its row and is a no-op; a DIFFERENT question on the id
// of one still open is refused. Once a question is answered, withdrawn or dismissed its id is free again
// (QUESTION_IDS_REUSABLE_FROM): a later message asking under it registers a NEW row, and the old row keeps
// its own history. So the same id can name several rows over a thread's life, and every message resolves
// its fences against the rows as they stood when it was WRITTEN (handleIndex's `upTo`) — the message that
// asked the first question still names the first question, whatever has been asked under its id since.
// Replaying any amount of transcript therefore never mints a second row for one message, and an answer the
// human gave is never re-opened: a re-ask is a new question with a new card. The check is a lookup rather
// than a constraint: Node is single-threaded and the storage calls are synchronous, so nothing can
// interleave between the lookup and the insert.
//
// NOTHING IS INFERRED FROM PROSE. The id is explicit, the row is the lifecycle, and the row outlives the
// message — which is the line between this and the two designs declined before it (plans/
// rest-by-registration.md: PR #33 guessed at settlement; the 2026-08-28 gate dropped a live question
// whenever a reference was forgotten).

import { randomUUID } from "node:crypto"
import {
  ASK_MAX_DEPTH,
  askedQuestionDepth,
  askedQuestionFaults,
  assembleQuestionFences,
  awaitingQuestions,
  followUpMultiFault,
  followUpOption,
  followUpOptionFault,
  followUpRiderFault,
  questionFenceBlocks,
  questionFencesLive,
  questionHandles,
  QUESTION_FENCE_CORRECTION_LEAD,
  type AskedOption,
  type AskedQuestion,
} from "@frizz/shared"
import type { QuestionSighting } from "./backend/types.ts"
import type { FenceView } from "./tailer.ts"
import type { Storage, ThreadQuestionRow } from "./storage.ts"

/** No fence written before this instant registers or is corrected. Before it a ```question fence with a
 *  body was prose on every thread dispatched after QUESTION_FENCE_RETIRED_AT, so a refold of an old
 *  transcript must not turn one into a question, or bump a worker that has been idle for a week. */
export const QUESTION_FENCES_REGISTER_FROM = "2026-10-13T20:00:00Z"
const REGISTER_FROM_MS = Date.parse(QUESTION_FENCES_REGISTER_FROM)

/** From this instant on, a settled question's id is free: a fence asking under the id of a question that
 *  was answered, withdrawn or dismissed before it was written registers a new question. Before it an id was
 *  spent for good — the contract said so, and a fence reusing one was refused and its worker corrected,
 *  after which it typically asked again under a new id (`byo-store-next`, refused 2026-11-03, re-asked
 *  4s later as `byo-store-after-d1`). Without this cutover a refold of such a transcript would register the
 *  refused fence now, and put a second copy of an already re-asked question on the human's board. */
export const QUESTION_IDS_REUSABLE_FROM = "2026-11-04T21:30:00Z"
const IDS_REUSABLE_FROM_MS = Date.parse(QUESTION_IDS_REUSABLE_FROM)

/** A refused fence written from this instant on is owed its correction until one reaches the worker,
 *  however much the human has typed since (scheduler SOURCE 14). One written before it keeps the old
 *  boundary, under which the human's next typed message dropped it untold: without this cutover the first
 *  tick after the change shipped would wake every resting thread with an old untold fault in its fold. */
export const QUESTION_FAULTS_OUTLIVE_HUMAN_FROM = "2026-10-21T22:00:00Z"

/** A fence that could not register, with the instant of the message that carried it. */
export interface QuestionFenceFault {
  at: string
  id?: string
  faults: string[]
}

/**
 * THE FAULTS OF EACH THREAD'S LATEST SYNC — the one place the board reads a refused fence from.
 *
 * Three callers sync a thread's fences: the registrar on the tailer's clock, the scheduler on every tick
 * (evalQuestionFences) and the router before a call that reads the questions (catchUpQuestionFences). All
 * three hand syncQuestionFences this book, which records what that pass refused, so the board can never
 * show a refusal the scheduler is not also correcting, or miss one it is. The list is the whole sync's —
 * every fault in the fold's ring of sightings, not only the current rest's — because the transcript still
 * draws the older messages, and a fence refused three rests ago is as refused as one written just now.
 *
 * WHY THE BOARD CARRIES IT. A refused fence registers no row, and the web draws a fence with no row as the
 * question it will become (a read-only card, for the second before the registrar reaches it). Without this
 * the two were indistinguishable: a fence reusing an open question's id, a follow-up written after its
 * parent was answered, an `id:` naming nothing — each sat on the page as a card that looked askable for
 * good, and a reused id's fence moved the OLD question's card under the new prose (reported 2026-10-13).
 *
 * In memory on purpose: a restart refolds the transcript and the first sync rebuilds it.
 */
export interface QuestionFaultBook {
  /** Replace this thread's faults with one sync's. An empty list forgets the thread. */
  note(slug: string, faults: readonly QuestionFenceFault[]): void
  /** The thread's faults as of its latest sync, or undefined when that sync refused nothing. */
  of(slug: string): readonly QuestionFenceFault[] | undefined
}

export function createQuestionFaultBook(): QuestionFaultBook {
  const bySlug = new Map<string, readonly QuestionFenceFault[]>()
  return {
    note(slug, faults) {
      if (faults.length === 0) bySlug.delete(slug)
      else bySlug.set(slug, faults.map((f) => ({ ...f, faults: [...f.faults] })))
    },
    of: (slug) => bySlug.get(slug),
  }
}

export interface QuestionFenceSync {
  registered: ThreadQuestionRow[]
  /** Questions an AUTONOMOUS thread wrote: recorded and cancelled at once, never put to the human. The
   *  worker is told by the cancellation wake the scheduler sends for any question dismissed under a Goal. */
  cancelled: ThreadQuestionRow[]
  /** Follow-ups a LATER message hung under an option of a question that was still open: the row whose
   *  tree grew, and the ids it gained. */
  attached: { at: string; rowId: string; handles: string[] }[]
  faults: QuestionFenceFault[]
  /** Questions a message named at an instant — a reference fence, or a fence restating its own ask. */
  refs: { at: string; rowId: string }[]
}

/** Every name a row answers to, lowercased: its minted id (so a `qst_…` reference resolves), its root
 *  handle and every handle in its tree. Read through `cache`, keyed by the stored spec, so a pass that
 *  indexes the same rows once per message parses each spec once (and a tree that grew is read afresh). */
function rowNames(row: ThreadQuestionRow, cache: Map<string, string[]>): string[] {
  let handles = cache.get(row.spec)
  if (!handles) {
    const spec = parseSpec(row.spec)
    handles = spec ? questionHandles(spec).map((h) => h.toLowerCase()) : []
    cache.set(row.spec, handles)
  }
  return [row.id.toLowerCase(), ...(row.handle ? [row.handle.toLowerCase()] : []), ...handles]
}

/** Every name the thread's rows answer to, each pointing at the ROOT row carrying it — as of `upTo`: only
 *  rows asked at or before that instant, and where several carry one name (an id asked again once its
 *  question settled), the one asked LAST. */
function handleIndex(rows: readonly ThreadQuestionRow[], upTo = Number.POSITIVE_INFINITY, cache = new Map<string, string[]>()): Map<string, ThreadQuestionRow> {
  const index = new Map<string, ThreadQuestionRow>()
  for (const row of rows) {
    if (row.asked_at > upTo) continue
    for (const name of rowNames(row, cache)) {
      const known = index.get(name)
      if (!known || known.asked_at <= row.asked_at) index.set(name, row)
    }
  }
  return index
}

function parseSpec(spec: string): AskedQuestion | undefined {
  try {
    return JSON.parse(spec) as AskedQuestion
  } catch {
    return undefined
  }
}

/** One node of a tree WITHOUT its follow-ups — what a fence itself says, whatever hangs under it. */
const bare = (q: AskedQuestion) => JSON.stringify({ ...q, options: q.options?.map(({ followUps: _followUps, ...o }) => o) })

/** Is a fence the SAME question as a stored node? Compared without follow-ups: a worker restating its
 *  question in a later message writes the parent fence and rarely its branches again, so a restatement
 *  can place the card and ADD a branch (see `grow` below), never change what a node asks. */
function sameNode(stored: AskedQuestion, spec: AskedQuestion): boolean {
  return bare(stored) === bare(spec)
}

/** The node of a tree carrying `handle`, and how deep it sits (the root is level 1). */
function nodeByHandle(spec: AskedQuestion, handle: string, level = 1): { node: AskedQuestion; level: number } | undefined {
  if (spec.handle?.toLowerCase() === handle) return { node: spec, level }
  for (const o of spec.options ?? []) {
    for (const child of o.followUps ?? []) {
      const hit = nodeByHandle(child, handle, level + 1)
      if (hit) return hit
    }
  }
  return undefined
}

const SETTLED_WORD: Record<ThreadQuestionRow["state"], string> = {
  open: "open",
  answered: "answered",
  withdrawn: "withdrawn",
  dismissed: "dismissed by the human",
}

/**
 * Register every new question the sightings carry and report what could not register. Pure apart from
 * the writes: a thread on the legacy contract, an archived thread and a sighting older than
 * QUESTION_FENCES_REGISTER_FROM are skipped before anything is read.
 *
 * EVERY FENCE IS ACCOUNTED FOR. Each one in a message registers a question, attaches under an open one,
 * references one, or is refused BY ID with its reason — none is dropped without a word, because a worker
 * corrects only what the correction names (the dead end of 2026-10-13: a follow-up whose `when:` label
 * was wrong on the first try could not be asked again in any shape, and one shape of the retry vanished).
 *
 * A FOLLOW-UP MAY ARRIVE LATER, while its parent is still open. Written beside its parent it registers
 * as part of the parent's tree; written in a later message — alone, beside a reference to its parent, or
 * under a restatement of it — it is attached into the open row's stored tree (`grow`), and the row
 * counts as referenced at that message. Once the parent is settled there is nothing to hang it from.
 */
export function syncQuestionFences(storage: QuestionFenceStorage, input: QuestionFenceSyncInput): QuestionFenceSync {
  const out = readQuestionFences(storage, input)
  // Recorded on EVERY return, the empty ones too: a thread whose worker fixed its fence stops being faulted
  // on the board in the same pass that stops correcting it.
  input.faultBook?.note(input.slug, out.faults)
  return out
}

type QuestionFenceStorage = Pick<Storage, "listThreadQuestions" | "askThreadQuestion" | "dismissThreadQuestion" | "growThreadQuestionSpec" | "clearThreadDone" | "resetParkBumps">

interface QuestionFenceSyncInput {
  slug: string
  spawnedAt: string | number | null | undefined
  sightings: readonly QuestionSighting[] | undefined
  /** The thread's armed Goal, when it runs autonomously — a question there is refused (secrets aside). */
  autonomousGoal?: string
  /** CHILD THREADS: the parent this thread reports to — a question there is refused (secrets aside), because
   *  the parent decides it or takes it to the human. Refused by a FAULT rather than a cancelled row: the
   *  link never lifts the way a Goal does, so the same fence reads the same way on every tick. */
  childOf?: { slug: string; title: string }
  /** Where this pass's faults are recorded for the board (QuestionFaultBook). Every production caller
   *  passes its context's one book. */
  faultBook?: QuestionFaultBook
}

function readQuestionFences(storage: QuestionFenceStorage, input: QuestionFenceSyncInput): QuestionFenceSync {
  const out: QuestionFenceSync = { registered: [], cancelled: [], attached: [], faults: [], refs: [] }
  if (!input.sightings?.length || questionFencesLive(input.spawnedAt)) return out
  const rows = storage.listThreadQuestions(input.slug)
  const names = new Map<string, string[]>()
  // The newest instant each id was written as a question that HELD — registered, attached, or restated
  // as it stands. A fault on that id from an earlier message has been fixed by the worker itself.
  const heldAt = new Map<string, number>()
  const autonomousFault = input.autonomousGoal
    ? "this thread is running autonomously, so the question was not asked — decide it yourself and proceed, and say which way you went in your write-up. " +
      `Its standing instruction is: ${input.autonomousGoal.replace(/\s+/g, " ").slice(0, 400)}`
    : undefined
  const childFault = input.childOf
    ? `this is a child thread of «${input.childOf.title}» (\`${input.childOf.slug}\`), so the question was not asked — ` +
      "a decision goes to your PARENT, not the human: write it in your handoff's prose and rest with an ```awaiting fence " +
      "carrying `status: needs_input`. Frizz hands that handoff to the parent, which answers you or takes it to the human. " +
      "Only a `kind: secret` question still reaches the human directly"
    : undefined
  for (const sighting of input.sightings) {
    const atMs = Date.parse(sighting.at)
    if (!Number.isFinite(atMs) || atMs < REGISTER_FROM_MS) continue
    const at = sighting.at
    // THE ROWS AS THIS MESSAGE SAW THEM: an id resolves to the newest question asked under it at or before
    // this instant, never one asked under it since (see the header). Rebuilt per message from `rows`, which
    // this pass extends as it registers, so a later message sees what an earlier one asked.
    const index = handleIndex(rows, atMs, names)
    const reusable = atMs >= IDS_REUSABLE_FROM_MS
    const assembled = assembleQuestionFences(questionFenceBlocks(sighting.text).map((b) => b.read))
    const fault = (id: string, text: string) => out.faults.push({ at, id, faults: [text] })
    /** Refuse a fence and name every fence riding under it, so none is missing from the correction. */
    const refuse = (spec: AskedQuestion, id: string, text: string) => {
      fault(id, text)
      for (const h of questionHandles(spec)) if (h !== id) fault(h, followUpRiderFault(id))
    }
    const held = (spec: AskedQuestion) => {
      for (const h of questionHandles(spec)) heldAt.set(h, Math.max(heldAt.get(h) ?? 0, atMs))
    }
    // Was the row settled BEFORE this message was written? A message from while it was still open is a
    // restatement of an open question whatever has happened since — a refold after the human answered
    // must not turn it into a re-ask and correct the worker for it.
    // (Never the message that ASKED it: nothing is settled before it exists, whatever two clocks say.)
    const settledBefore = (row: ThreadQuestionRow) => row.state !== "open" && row.asked_at !== atMs && (row.settled_at ?? 0) < atMs
    /** Is this id taken at this message: by a question still open when it was written — or, in a message
     *  from before settled ids were reusable, by any question at all? */
    const taken = (handle: string): boolean => {
      const row = index.get(handle.toLowerCase())
      return row !== undefined && (!reusable || !settledBefore(row))
    }
    const usedFault = (handle: string) => {
      const row = index.get(handle.toLowerCase())
      return row && settledBefore(row)
        ? `\`id: ${handle}\` was already used by a different question on this thread — this fence was written before a settled question's id could be asked again; ask it again in a new message if you still need an answer`
        : `\`id: ${handle}\` is already used by a different question on this thread that is still open — choose a new id, or reference that one with \`id: ${handle}\` alone (an id is free again once its question is answered, withdrawn or dismissed)`
    }
    const ref = (row: ThreadQuestionRow) => out.refs.push({ at, rowId: row.id })

    // THE MESSAGE THAT REGISTERED A QUESTION IS NEVER JUDGED AGAINST IT AGAIN. A row's `asked_at` is its
    // message's own instant, so a sighting at exactly that instant IS that message — replayed by a refold,
    // or by the next tick. Whatever its fence reads as NOW is beside the point: the parser has changed
    // since rows were written (a quoted `"a\nb"` value, a bare `- Label` over a `description:`, a fence
    // indented in a list item), and comparing the stored spec with today's reading of the same bytes
    // earned the registering message "id already used by a different question" — a correction for a
    // fence that had worked. `registeredHere` is the id's row when this message is the one that made it.
    const registeredHere = (id: string): ThreadQuestionRow | undefined => {
      const row = index.get(id)
      return row && row.asked_at === atMs ? row : undefined
    }
    const readable = new Set([...assembled.asks.map((a) => a.id), ...assembled.followUps.map((f) => f.id)])
    for (const f of assembled.faults) {
      // …including a fence today's parser refuses outright. (With a readable fence of the same id beside
      // it, the fault is about something else — two different questions on one id — and stands.)
      if (f.id && registeredHere(f.id) && !readable.has(f.id)) continue
      out.faults.push({ at, ...f })
    }

    // ── growing an open row ──
    // Every follow-up this message adds to one row is collected on a COPY of its tree and written once.
    const growing = new Map<string, { row: ThreadQuestionRow; root: AskedQuestion; added: string[] }>()
    const treeOf = (row: ThreadQuestionRow): { row: ThreadQuestionRow; root: AskedQuestion; added: string[] } | undefined => {
      const known = growing.get(row.id)
      if (known) return known
      const root = parseSpec(row.spec)
      if (!root) return undefined
      const entry = { row, root, added: [] as string[] }
      growing.set(row.id, entry)
      return entry
    }
    /** A new subtree with every node whose id is already spent cut out of it (and named). */
    const pruned = (node: AskedQuestion): AskedQuestion => ({
      ...node,
      ...(node.options ? {
        options: node.options.map((o): AskedOption => {
          const kept = (o.followUps ?? []).filter((child) => {
            if (!child.handle || !taken(child.handle)) return true
            refuse(child, child.handle, usedFault(child.handle))
            return false
          }).map(pruned)
          const { followUps: _followUps, ...rest } = o
          return kept.length > 0 ? { ...rest, followUps: kept } : rest
        }),
      } : {}),
    })
    /** Hang `child` under `option` of a node at `level` of an OPEN row's tree — or find it already there. */
    const grow = (entry: { row: ThreadQuestionRow; root: AskedQuestion; added: string[] }, option: AskedOption, level: number, child: AskedQuestion): void => {
      const id = child.handle ?? ""
      const existing = option.followUps?.find((f) => f.handle === child.handle)
      if (existing) {
        // (The registering message's own reading of a branch is never compared — see `registeredHere`.)
        if (!sameNode(existing, child) && entry.row.asked_at !== atMs) return void refuse(child, id, usedFault(id))
        // Already in the tree, as written: a restatement — and any NEW branch it carries grows the tree too.
        heldAt.set(id, Math.max(heldAt.get(id) ?? 0, atMs))
        for (const o of child.options ?? []) {
          const under = existing.options?.find((x) => x.label === o.label)
          for (const grandchild of o.followUps ?? []) if (under) grow(entry, under, level + 1, grandchild)
        }
        return
      }
      if (taken(id)) return void refuse(child, id, usedFault(id))
      const subtree = pruned(child)
      if (level + askedQuestionDepth(subtree) > ASK_MAX_DEPTH) {
        return void refuse(child, id, `it would reach level ${level + askedQuestionDepth(subtree)} under \`${entry.row.handle ?? entry.row.id}\`, and follow-ups go ${ASK_MAX_DEPTH} levels deep at most — past that you are asking the human to fill in a form; ask it as its own question, without the \`when:\` line, or decide it yourself`)
      }
      option.followUps = [...(option.followUps ?? []), subtree]
      entry.added.push(...questionHandles(subtree))
      for (const h of questionHandles(subtree)) index.set(h.toLowerCase(), entry.row)
      held(subtree)
    }

    for (const ask of assembled.asks) {
      const spent = questionHandles(ask.spec).some((h) => h !== ask.id && taken(h))
      // A SETTLED QUESTION'S ID IS FREE AGAIN. Answered, withdrawn or dismissed before this message was
      // written, the old row keeps its history — its own fence still draws it, answered or closed — and
      // this fence asks a NEW question under the id, whether it words the old one again or asks another.
      const named = index.get(ask.id)
      const rootRow = named && reusable && settledBefore(named) ? undefined : named
      if (rootRow) {
        const entry = treeOf(rootRow)
        const same = rootRow.handle === ask.id && entry !== undefined && (sameNode(entry.root, ask.spec) || rootRow.asked_at === atMs)
        if (!same) {
          refuse(ask.spec, ask.id, usedFault(ask.id))
        } else if (settledBefore(rootRow)) {
          // (Only a message from before QUESTION_IDS_REUSABLE_FROM gets here: from then on a settled id is free.)
          fault(ask.id, `\`${ask.id}\` was already asked and ${SETTLED_WORD[rootRow.state]} — this fence was written before a settled question's id could be asked again; ask it again in a new message if you still need an answer`)
          // …and a branch written under it has nothing to hang from, which is its own news.
          for (const o of ask.spec.options ?? []) {
            for (const child of o.followUps ?? []) {
              if (child.handle && !nodeByHandle(entry.root, child.handle)) refuse(child, child.handle, settledParentFault(ask.id, rootRow.state))
            }
          }
        } else {
          // THE SAME FENCE AGAIN: the message that asked it, replayed by a refold, or the worker restating
          // its own open question — which places the card again, exactly as a reference does. A branch it
          // carries that the tree does not have yet is a follow-up arriving late.
          ref(rootRow)
          heldAt.set(ask.id, Math.max(heldAt.get(ask.id) ?? 0, atMs))
          for (const o of ask.spec.options ?? []) {
            const under = entry.root.options?.find((x) => x.label === o.label)
            for (const child of o.followUps ?? []) {
              if (!under) continue
              if (rootRow.state === "open") {
                if (autonomousFault && !nodeByHandle(entry.root, child.handle ?? "")) refuse(child, child.handle ?? "", autonomousFault)
                else grow(entry, under, 1, child)
              } else if (child.handle && nodeByHandle(entry.root, child.handle)) heldAt.set(child.handle, Math.max(heldAt.get(child.handle) ?? 0, atMs))
            }
          }
        }
        continue
      }
      if (spent) {
        // The root is new and something UNDER it is not. A follow-up never takes its parent down, so the
        // spent branches are cut out (each named) and the rest registers.
        ask.spec = pruned(ask.spec)
      }
      // AUTONOMOUS MODE DECLINES THE ASK — the rule `ask` enforced at the moment of temptation, kept for
      // the fence: the thread was told to decide for itself. A secret is exempt, as it was there: a
      // credential is a value only the human holds, not a call the worker can make.
      //
      // DECLINED ON THE RECORD, not by a fault. The row is written and cancelled in the same breath, the
      // way arming a Goal cancels the questions already open (router cancelQuestionsForAutonomy), and the
      // worker hears of it through that path's own wake: "CANCELLED without an answer. Decide it yourself",
      // naming its id, exactly once. A fault left no trace, so the refusal lasted only as long as the Goal
      // did: the tick after the human disarmed it, the old fence read as new and became an open question —
      // one the worker had been told was not asked and had since decided, now on the human's board and
      // blocking `done`. The row also gives the web something true to draw in the fence's slot, where a
      // refusal it could not see stayed a card that looked askable.
      if (childFault && !ask.spec.secret) {
        refuse(ask.spec, ask.id, childFault)
        continue
      }
      if (autonomousFault && !ask.spec.secret) {
        const row = storage.askThreadQuestion({
          id: `qst_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
          slug: input.slug,
          spec: JSON.stringify(ask.spec),
          askedAtMs: atMs,
          handle: ask.id,
        })
        const cancelledAtMs = Math.max(Date.now(), atMs)
        storage.dismissThreadQuestion(row.id, cancelledAtMs)
        const cancelled: ThreadQuestionRow = { ...row, state: "dismissed", settled_at: cancelledAtMs }
        for (const h of questionHandles(ask.spec)) index.set(h.toLowerCase(), cancelled)
        index.set(row.id.toLowerCase(), cancelled)
        rows.push(cancelled)
        held(ask.spec)
        out.cancelled.push(cancelled)
        continue
      }
      const row = storage.askThreadQuestion({
        id: `qst_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
        slug: input.slug,
        spec: JSON.stringify(ask.spec),
        // The MESSAGE's instant, not the registrar's: it is what places the card at the rest that asked it.
        askedAtMs: atMs,
        handle: ask.id,
      })
      // A question trumps a done (router `ask`, setOwnThreadTimer) — and a fence that worked gives the
      // correction allowance back, the way an honoured park does.
      storage.clearThreadDone(input.slug)
      storage.resetParkBumps(input.slug)
      for (const h of questionHandles(ask.spec)) index.set(h.toLowerCase(), row)
      index.set(row.id.toLowerCase(), row)
      rows.push(row)
      held(ask.spec)
      out.registered.push(row)
    }

    // ── follow-ups whose parent is not asked in this message ──
    for (const f of assembled.followUps) {
      const when = { parent: f.parent, option: f.option }
      // Registered by this very message as part of a tree (and read as a late follow-up only by a parser
      // newer than the row): the row stands as it is.
      const own = registeredHere(f.id)
      if (own) {
        ref(own)
        continue
      }
      const row = index.get(f.parent)
      if (!row) {
        refuse(f.spec, f.id, taken(f.id) ? usedFault(f.id) : `\`when: ${f.parent} = ${f.option}\` names \`${f.parent}\`, which is neither a question in this message nor an open question of this thread — a follow-up hangs off a question that is still waiting for its answer; to ask this on its own, drop the \`when:\` line`)
        continue
      }
      const entry = treeOf(row)
      const target = entry ? nodeByHandle(entry.root, f.parent) ?? { node: entry.root, level: 1 } : undefined
      const option = target ? followUpOption(target.node, f.option) : undefined
      const already = entry ? nodeByHandle(entry.root, f.id) : undefined
      if (already) {
        // Its id is in this tree. Under the option it names and worded the same, it is the follow-up
        // itself written again; anything else is a second question on a spent id.
        const inPlace = option?.followUps?.some((x) => x === already.node) && sameNode(already.node, f.spec)
        if (!inPlace) refuse(f.spec, f.id, usedFault(f.id))
        else if (settledBefore(row)) refuse(f.spec, f.id, `\`${f.id}\` was already asked and ${SETTLED_WORD[row.state]} with the question it follows, so there is no open question to hang it from — ask it as its own question, without the \`when:\` line, if you still need an answer`)
        else {
          ref(row)
          if (row.state === "open" && entry && option && target) grow(entry, option, target.level, f.spec)
          else heldAt.set(f.id, Math.max(heldAt.get(f.id) ?? 0, atMs))
        }
        continue
      }
      if (taken(f.id)) {
        refuse(f.spec, f.id, usedFault(f.id))
        continue
      }
      if (row.state !== "open") {
        refuse(f.spec, f.id, settledParentFault(f.parent, row.state))
        continue
      }
      if (!entry || !target) {
        refuse(f.spec, f.id, `\`when: ${f.parent} = ${f.option}\` names \`${f.parent}\`, whose stored question could not be read — ask this as its own question, without the \`when:\` line`)
        continue
      }
      if (autonomousFault ?? childFault) {
        refuse(f.spec, f.id, (autonomousFault ?? childFault)!)
        continue
      }
      if (target.node.kind === "multi") {
        refuse(f.spec, f.id, followUpMultiFault(f.parent))
        continue
      }
      if (!option) {
        refuse(f.spec, f.id, followUpOptionFault(when, target.node))
        continue
      }
      const before = entry.added.length
      grow(entry, option, target.level, f.spec)
      // The parent is named by this message as surely as an `id:` fence names it: it stands at this rest.
      if (entry.added.length > before) ref(row)
    }

    // Write each tree that grew, once. The shared validator has the last word on the whole tree: a shape
    // it refuses is not stored, and every fence that would have joined it is told why.
    for (const entry of growing.values()) {
      if (entry.added.length === 0) continue
      const treeFaults = askedQuestionFaults(entry.root)
      const grown = treeFaults.length === 0 && storage.growThreadQuestionSpec(input.slug, entry.row.id, JSON.stringify(entry.root))
      if (!grown) {
        for (const h of entry.added) {
          index.delete(h.toLowerCase())
          heldAt.delete(h)
          fault(h, treeFaults.length > 0 ? treeFaults.join("; ") : settledParentFault(entry.row.handle ?? entry.row.id, "answered"))
        }
        continue
      }
      entry.row.spec = JSON.stringify(entry.root)
      // A question newly put to the human trumps a done and gives the correction allowance back, exactly
      // as a registration does.
      storage.clearThreadDone(input.slug)
      storage.resetParkBumps(input.slug)
      out.attached.push({ at, rowId: entry.row.id, handles: entry.added })
    }

    // References last, so an `id:` fence written beside the ask it names finds the row that ask made.
    for (const id of assembled.refs) {
      const row = index.get(id)
      if (!row) {
        // NAMED AS WHAT IT IS: a question the human was never asked. A worker writes this from a belief —
        // a compaction summary listing "open" questions it never fenced, a card it meant to post — and
        // the belief outlives the turn: on 2026-10-21 one wrote "signing in waits on the two cards I
        // posted earlier" over two ids no fence had ever asked, and kept waiting on them.
        fault(id, `\`id: ${id}\` alone references a question, and no question of yours uses that id, so the human was never asked it and no answer is coming — \`frizzctl activity\` lists the questions you have open; to ask this one, write the whole fence, with a \`kind:\` and a \`question:\``)
      } else if (!settledBefore(row)) ref(row)
      // AN ANSWERED QUESTION REFERENCED AGAIN IS NOT A MISTAKE WORTH A TURN. Its answer reaches the worker
      // as its own message (or already did), so the reference simply places nothing — where a fault here
      // bumped a thread that had already signed off done, to tell it something it was about to be told.
      else if (row.state === "answered") continue
      // One the worker WITHDREW, or the human DISMISSED, is different: the worker is still waiting on an
      // answer nobody is going to give, and has to be told.
      else if (row.state === "withdrawn") {
        fault(id, `\`${id}\` is a question you withdrew, so there is nothing left to reference and the human is not being asked — if you still need it answered, ask it again: write the whole fence, under this id or a new one`)
      } else {
        fault(id, `\`${id}\` was dismissed by the human without an answer, so there is nothing left to reference and no answer is coming — decide it yourself, or ask it again with the whole fence if the work cannot go on without one`)
      }
    }
  }
  // A fault the worker has since FIXED is not news: the same id, written again later as a question that
  // held. (The scheduler's own check reads a row's root handle; a follow-up's id lives inside the tree.)
  out.faults = out.faults.filter((f) => !(f.id && (heldAt.get(f.id) ?? 0) > Date.parse(f.at)))
  return out
}

/** A follow-up cannot hang from a question the human has finished with — and the fault names the way out. */
function settledParentFault(parent: string, state: ThreadQuestionRow["state"]): string {
  return `it follows \`${parent}\`, which was already ${SETTLED_WORD[state]}, so there is no open question to hang it from — ask it as its own question, without the \`when:\` line`
}

/**
 * The open questions that STAND — the ones that queue the thread, mark its row and sign its rest off.
 *
 * A question stands from when it was ASKED, or last REFERENCED, until the HUMAN TYPES A MESSAGE to the
 * thread after that. A reference is an `id:` fence, the worker restating its fence, or (for a worker
 * whose contract predates the fence) an ```awaiting fence naming it under `questions:`. Once the human
 * has typed past it, the question FADES: still open, still answerable in the message that asked it, but
 * no longer what the thread is waiting on (maintainer 2026-10-13: questions "may get registered and
 * never answered, and then they just sort of fade away. I think it's probably fine") — until the worker
 * references it again.
 *
 * ONLY A MESSAGE THE HUMAN WROTE MOVES THE BOUNDARY (`restFromAt`, the fold's reading of shared
 * isHumanTypedMessage). Nothing Frizz delivers does: no wake of any kind, no correction, no sign-off
 * reminder, no Goal prompt, no timer or watch wake, no limit resume, no other thread's steer, and not
 * the delivery of an ANSWER to a different question — answering one of two is not replying past the
 * other, and the human has the card's × for that. The first cut of this rule (2026-10-13, same day)
 * read every user record as the boundary, the way the rest rules around it do, and a question asked
 * beside a `status: working` park left the queue the moment its shell finished and the worker re-parked
 * with the fence alone — which is exactly what the contract tells a worker a quiet park is. The human
 * had not seen the question yet. A machine event is not a reply.
 *
 * `lastUserAt` is the fallback for a tail folded before `restFromAt` existed.
 *
 * A FENCE THE SYNC REFUSED IS NOT A REFERENCE (`faults`, the thread's entry in the QuestionFaultBook). A
 * fence that reuses an open question's id for a DIFFERENT question names that row by id and nothing else:
 * read as a reference, it made the old question stand again at a rest the human had already typed past —
 * the thread queued on a question its newest message never mentions, and the rest that had actually asked
 * nothing (its one fence was refused) read as signed off (seen on a stack, 2026-10-13). A fence is
 * matched to its fault by the sighting's instant and its id, which is exactly how the sync wrote it.
 */
export function standingQuestions(
  rows: readonly ThreadQuestionRow[],
  tele: { lastUserAt?: string; restFromAt?: string; questionSightings?: readonly QuestionSighting[]; lastFence?: FenceView } | undefined,
  faults?: readonly QuestionFenceFault[],
): ThreadQuestionRow[] {
  const open = rows.filter((q) => q.state === "open")
  if (open.length === 0) return []
  const from = tele?.restFromAt ?? tele?.lastUserAt
  const restFrom = from ? Date.parse(from) : Number.NEGATIVE_INFINITY
  const named = new Set<string>()
  const cache = new Map<string, string[]>()
  const refused = new Set((faults ?? []).flatMap((f) => (f.id ? [`${f.at}\n${f.id.toLowerCase()}`] : [])))
  for (const sighting of tele?.questionSightings ?? []) {
    const atMs = Date.parse(sighting.at)
    if (!(atMs > restFrom)) continue
    // A fence names the question its id meant WHEN IT WAS WRITTEN — an id asked again since names a newer one.
    const index = handleIndex(rows, atMs, cache)
    for (const b of questionFenceBlocks(sighting.text)) {
      if (b.read.form === "invalid") continue
      if (refused.has(`${sighting.at}\n${b.read.id.toLowerCase()}`)) continue
      const row = index.get(b.read.id)
      if (row) named.add(row.id)
    }
  }
  if (tele?.lastFence?.kind === "awaiting") {
    // The newest rest's own fence: each name it lists means the newest question under it.
    const index = handleIndex(rows, Number.POSITIVE_INFINITY, cache)
    for (const id of awaitingQuestions(tele.lastFence.hints)) {
      const row = index.get(id)
      if (row) named.add(row.id)
    }
  }
  return open.filter((q) => q.asked_at > restFrom || named.has(q.id))
}

/** The correction a worker gets when a fence of its current rest could not register. Its lead folds it out
 *  of the chat like every other fence correction (isParkCorrection).
 *
 *  `closedOnDone`: the rest signed off with a ```done fence and no question of the thread is open yet.
 *  The worker's natural fix is the same message with the fence repaired — and the done fence still under
 *  it, which the scheduler then corrects at the next rest (SOURCE 15): two turns for one message's worth of
 *  news. One sentence here saves the second. Every other rest gets the text as it has always read. */
export function questionFenceCorrection(faults: readonly QuestionFenceFault[], opts: { closedOnDone?: boolean; typedPast?: boolean } = {}): string {
  // Only a reference to a question that WAS asked and has since closed "placed nothing": a reference to an
  // id nothing ever asked is a question the human has not been asked, and the lead says so.
  const asks = faults.some((f) => f.faults.some((x) => !/nothing left to reference/.test(x)))
  const lines = [
    `${QUESTION_FENCE_CORRECTION_LEAD}could not register, so ${asks ? "the human has NOT been asked" : "it placed nothing"}:`,
    "",
    ...faults.flatMap((f) => f.faults.map((x) => `- ${f.id ? `\`${f.id}\` — ` : ""}${x}`)),
    "",
    "Fix the fence and write it again in your next message; a fence that registers needs nothing else.",
    "The shape: `id:` (a slug of your own), `kind:` (`choice`, `multi`, `text` or `secret`), a one-line",
    "`question:`, and for `choice`/`multi` two or more `options:` — each `- label: …`, with optional",
    "`description:`, `recommended: true` and an indented `detail: |` block. Anything else the human needs",
    "goes below a `---` line as markdown. A fence with `id:` alone references a question you already asked.",
  ]
  if (opts.typedPast) lines.push("", QUESTION_FENCE_TYPED_PAST_HINT)
  if (opts.closedOnDone) lines.push("", QUESTION_FENCE_UNDER_DONE_HINT)
  return lines.join("\n")
}

/** The sentence SOURCE 14's correction gains when a fence it names is older than the human's last typed
 *  message: what they wrote may already settle it, and the worker should not ask it again for nothing. */
export const QUESTION_FENCE_TYPED_PAST_HINT =
  "The human has written to you since the message that carried this fence; if what they wrote already settles it, there is nothing to ask again."

/** The sentence SOURCE 14's correction gains when the rest it corrects closed on a ```done fence. */
export const QUESTION_FENCE_UNDER_DONE_HINT =
  "This rest also closed on a ```done fence, and a done fence cannot stand beside a question once it registers: " +
  "the message that carries the fixed fence carries no ```done fence, and the sign-off as done comes once the question is answered."

/** CHILD THREADS: the parent a thread reports to, while that parent exists — what refuses its questions. */
export function childOfRow(
  storage: { getSession(slug: string): { slug: string; title?: string | null } | undefined },
  row: { parent_slug?: string | null },
): { slug: string; title: string } | undefined {
  if (!row.parent_slug) return undefined
  const parent = storage.getSession(row.parent_slug)
  return parent ? { slug: parent.slug, title: parent.title || parent.slug } : undefined
}

/** The thread's armed Goal when it runs autonomously — the same reading the router's `ask` refused on. */
export function autonomousGoalOf(row: { recurring_on_rest?: number | null; recurring_prompt?: string | null }): string | undefined {
  if (row.recurring_on_rest !== 1) return undefined
  const prompt = row.recurring_prompt?.trim()
  return prompt ? prompt : undefined
}

/**
 * Registration on the TAILER's clock rather than the scheduler's. The scheduler ticks every 10s; the
 * tailer polls about once a second and calls `onChange` when anything it folded moved, and the board
 * rebuilds right after. Sweeping here, before that rebuild, is what lets a question the worker just wrote
 * reach the board as an answerable card on the same refresh that draws the message carrying it.
 *
 * Only a thread whose sightings CHANGED is read — the signature is the ring's length and its newest entry
 * — so a quiet board costs one map lookup per thread with a fenced message on record. Returns whether
 * anything registered, though the caller refreshes the board either way.
 */
export function createQuestionRegistrar(deps: {
  // `getSession` finds a child's parent (childOfRow); optional so a registrar test about questions alone
  // need not spell it, and absent reads as "no parent".
  storage: Pick<Storage, "allSessions" | "listThreadQuestions" | "askThreadQuestion" | "dismissThreadQuestion" | "growThreadQuestionSpec" | "clearThreadDone" | "resetParkBumps"> & Partial<Pick<Storage, "getSession">>
  tailer: { get(slug: string): { questionSightings?: QuestionSighting[] } | undefined }
  log?: (message: string) => void
  /** The board's reading of what each thread's latest sync refused (QuestionFaultBook). */
  faultBook?: QuestionFaultBook
}): { sweep(): boolean } {
  const seen = new Map<string, string>()
  return {
    sweep() {
      let registered = false
      for (const row of deps.storage.allSessions()) {
        // An archived thread is never synced again, and its book entry is left as its last sync wrote it:
        // the Done transcript still draws the fence that was refused. (A restart loses that entry, since
        // nothing folds an archived thread to rebuild it from.)
        if (row.state === "archived" || row.archived === 1) continue
        const sightings = deps.tailer.get(row.slug)?.questionSightings
        if (!sightings?.length) {
          // No fence in the fold any more (a new session): nothing below will sync it, so forget here.
          deps.faultBook?.note(row.slug, [])
          continue
        }
        const newest = sightings[sightings.length - 1]
        const signature = `${row.session_id}|${sightings.length}|${newest.at}|${newest.text.length}`
        if (seen.get(row.slug) === signature) continue
        seen.set(row.slug, signature)
        // ONE THREAD'S FAILURE IS ITS OWN. A throw here used to leave the loop, so every thread after
        // this one in the registry waited for the next change to reach it. The signature is recorded
        // first on purpose: a failure that repeats is logged once per change rather than on every poll,
        // and the scheduler's own pass (evalQuestionFences, every tick, no memo) is the retry.
        let sync: QuestionFenceSync
        try {
          sync = syncQuestionFences(deps.storage, {
            slug: row.slug,
            spawnedAt: row.spawned_at,
            sightings,
            autonomousGoal: autonomousGoalOf(row),
            childOf: deps.storage.getSession ? childOfRow({ getSession: deps.storage.getSession }, row) : undefined,
            faultBook: deps.faultBook,
          })
        } catch (err) {
          deps.log?.(`questions: ${row.slug} sweep failed: ${err instanceof Error ? err.message : String(err)}`)
          continue
        }
        if (sync.registered.length > 0) {
          registered = true
          deps.log?.(`questions: ${row.slug} registered ${sync.registered.map((q) => q.handle).join(", ")}`)
        }
        if (sync.attached.length > 0) {
          registered = true
          deps.log?.(`questions: ${row.slug} attached follow-up(s) ${sync.attached.flatMap((a) => a.handles).join(", ")}`)
        }
        if (sync.cancelled.length > 0) {
          registered = true
          deps.log?.(`questions: ${row.slug} cancelled ${sync.cancelled.map((q) => q.handle).join(", ")} — the thread runs autonomously`)
        }
      }
      return registered
    },
  }
}
