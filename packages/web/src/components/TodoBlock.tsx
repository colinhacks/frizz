import { useId, useState, type ReactNode } from "react"
import { ChevronRight, Square, SquareCheckBig, SquareDot } from "lucide-react"
import type { TranscriptTodo } from "@frizz/shared"

// THE TO-DO LIST CARD — for the calls that actually list the whole thing out.
//
// Claude Code's `TaskList` (its result enumerates every task), codex's `update_plan` and the legacy
// `TodoWrite` (both pass the entire list on every call). Their siblings TaskCreate/TaskUpdate are
// per-task deltas that carry no list, and the projector deliberately does not accumulate one for them
// (see transcript.ts) — they stay ordinary tool cards, just with an honest title instead of the
// paragraph-long `description` the generic detail fallback used to promote.
//
// COLLAPSED by default, like every other card in this family: the header carries the reading —
//
//   TODOS  ⊙ Inspect the PR context and the full diff        1/3   done · 11ms  ▸
//
// the step IN PROGRESS plus the progress counter, since that is what a reader wants from a list at a
// glance. Expanding reveals the whole checklist, and the model's own explanation below it.
const TODO_LABEL = "Todos"

// Pending / current / done, as a checkbox family. Exactly ONE of them takes colour — the current row, in
// the app's accent — because a tool card is a subordinate activity band: twenty green checks would shout
// louder than the prose they belong to, while one amber row is the single fact worth scanning for.
//
// Done stays monochrome but is the BRIGHTEST of the two neutrals, and it is `SquareCheckBig` (whose check
// breaks the box edge) rather than `SquareCheck`. At /45 with the tucked-in check, a done row was
// distinguishable from a to-do row only by its dimmed text — reviewing the screenshot, "what is done" was
// not scannable from the glyphs at 12px, which is the one thing a checklist owes the reader.
const TODO_GLYPH = {
  pending: { Icon: Square, className: "text-muted-50" },
  in_progress: { Icon: SquareDot, className: "text-accent" },
  completed: { Icon: SquareCheckBig, className: "text-muted-75" },
} as const

const TODO_ROW_TEXT = {
  pending: "text-fg/75",
  in_progress: "text-fg",
  completed: "text-muted-70",
} as const

// Sized in `1em`, NOT in px, and that is what makes the vertical corrections in diff.css legitimate.
// An SVG's ink lands wherever its path falls in the viewBox, so each context's correction has to be
// measured — and it is written in `em` so it tracks the font size. A px-pinned glyph breaks that promise
// silently: with `size={12}` the glyph stayed 12px while doubling the card's type doubled everything
// around it, so the geometry the correction was derived from no longer held (caught by this change's own
// scale gate, which read a 6px residual at 2x). At 1em the glyph and its text scale together and the
// rows' residual stays 0px at 12px, 24px and 48px.
function TodoMark({ status }: { status: TranscriptTodo["status"] }) {
  const { Icon, className } = TODO_GLYPH[status]
  return <Icon aria-hidden="true" size="1em" strokeWidth={2} className={`frizz-todo-mark shrink-0 ${className}`} />
}

const STATUS_WORD = { pending: "to do", in_progress: "in progress", completed: "done" } as const

export function TodoBlock({
  todos,
  note,
  meta,
}: {
  todos: readonly TranscriptTodo[]
  // The model's own commentary on the call — a codex plan `explanation`.
  note?: string
  meta?: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  const done = todos.filter((t) => t.status === "completed").length
  // The step in progress is the headline. Derived here rather than flagged by the server: it is a
  // property of the list itself, and the list is all the card is given. An all-complete list headlines
  // nothing — its counter says everything.
  const current = todos.find((t) => t.status === "in_progress")
  const expandable = todos.length > 0 || Boolean(note)
  const counter = todos.length > 0 ? `${done}/${todos.length}` : undefined
  const summary = current ? current.text : todos.length === 0 ? "empty" : undefined
  return (
    <div className="frizz-bash" data-todo-card>
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        aria-controls={expandable ? bodyId : undefined}
        aria-expanded={expandable ? open : undefined}
        aria-label={`${expandable ? `${open ? "Collapse" : "Expand"} ` : ""}${TODO_LABEL}${summary ? `: ${summary}` : ""}${counter ? ` — ${done} of ${todos.length} done` : ""}`}
        className="frizz-bash-header w-full text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ink-60"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="petite-caps frizz-bash-label shrink-0">{TODO_LABEL}</span>
          {/* The 11.5px lives on the WRAPPER, not on the text span, so the 1em glyph and the text it sits
              beside derive from ONE font size. With it on the span the glyph silently inherited the card's
              12.5px instead — a 1px size mismatch, and an alignment correction tied to that accident
              rather than to the pair. */}
          {summary && (
            <span className="flex min-w-0 items-center gap-1.5 text-[11.5px]" title={summary} data-todo-headline>
              {current && <TodoMark status="in_progress" />}
              <span className="min-w-0 truncate text-muted">{summary}</span>
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {counter && (
            <span className="frizz-tool-header-caps tabular-nums text-[11px] text-muted-55" title={`${done} of ${todos.length} done`}>
              {counter}
            </span>
          )}
          {meta}
          {expandable && <ChevronRight aria-hidden="true" size={12} className={`shrink-0 text-muted transition-transform ${open ? "rotate-90" : ""}`} />}
        </span>
      </button>
      {expandable && (
        <div id={bodyId} hidden={!open}>
          {open && todos.length > 0 && (
            <ul className="frizz-todo-list">
              {todos.map((todo, i) => (
                <li key={i} className="frizz-todo-row" data-current={todo.status === "in_progress" ? "true" : undefined}>
                  <TodoMark status={todo.status} />
                  <span className={`min-w-0 ${TODO_ROW_TEXT[todo.status]}`}>{todo.text}</span>
                  <span className="sr-only">{` — ${STATUS_WORD[todo.status]}`}</span>
                </li>
              ))}
            </ul>
          )}
          {open && note && (
            <>
              <div className="frizz-bash-output-label petite-caps">note</div>
              <pre className="frizz-bash-body frizz-bash-output-body">{note}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}
