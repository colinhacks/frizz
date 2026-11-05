import { useId, useState, type ReactNode } from "react"
import { Square, SquareCheckBig, SquareDot } from "lucide-react"
import type { TranscriptTodo } from "@frizz/shared"
import { TOOL_ROW_LEAD, TOOL_ROW_TAIL, type ToolRailNode } from "../lib/toolRow.ts"
import { ToolRowChevron } from "./ToolRow.tsx"

// THE TO-DO LIST ROW — for the calls that actually list the whole thing out.
//
// Claude Code's `TaskList` (its result enumerates every task), codex's `update_plan` and the legacy
// `TodoWrite` (both pass the entire list on every call). Their siblings TaskCreate/TaskUpdate are
// per-task deltas that carry no list, and the projector deliberately does not accumulate one for them
// (see transcript.ts) — they stay ordinary tool cards, just with an honest title instead of the
// paragraph-long `description` the generic detail fallback used to promote.
//
// COLLAPSED by default, like every other card in this family: the header carries the reading —
//
//   Todos  ⊙ Inspect the PR context and the full diff        1/3   11ms  ▸
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

// Sized in `1em`, NOT in px, and that is what makes the vertical correction in diff.css legitimate: it
// is written in terms of the text's own font. A px-pinned glyph breaks that promise silently: with
// `size={12}` the glyph stayed 12px while doubling the row's type doubled everything around it (caught by
// the scale gate in scripts/verify-todo-render.mjs, which read a 6px residual at 2x). At 1em the glyph and
// its text scale together.
function TodoMark({ status }: { status: TranscriptTodo["status"] }) {
  const { Icon, className } = TODO_GLYPH[status]
  return <Icon aria-hidden="true" size="1em" strokeWidth={2} className={`frizz-todo-mark shrink-0 ${className}`} />
}

const STATUS_WORD = { pending: "to do", in_progress: "in progress", completed: "done" } as const

export function TodoBlock({
  todos,
  note,
  meta,
  node,
}: {
  todos: readonly TranscriptTodo[]
  // The model's own commentary on the call — a codex plan `explanation`.
  note?: string
  meta?: ReactNode
  node?: ToolRailNode
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
    <div className="frizz-bash" data-todo-card data-tool-node={node}>
      <button
        type="button"
        onClick={() => expandable && setOpen((v) => !v)}
        onMouseDown={(e) => e.preventDefault()}
        aria-controls={expandable ? bodyId : undefined}
        aria-expanded={expandable ? open : undefined}
        aria-label={`${expandable ? `${open ? "Collapse" : "Expand"} ` : ""}${TODO_LABEL}${summary ? `: ${summary}` : ""}${counter ? ` — ${done} of ${todos.length} done` : ""}`}
        className="frizz-bash-header w-full text-left outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-focus-ink-60"
      >
        <span className={TOOL_ROW_LEAD}>
          <span className="frizz-bash-label shrink-0">{TODO_LABEL}</span>
          {summary && (
            <span className="flex min-w-0 items-baseline gap-1.5" title={summary} data-todo-headline>
              {current && <TodoMark status="in_progress" />}
              <span className="frizz-tool-detail">{summary}</span>
            </span>
          )}
        </span>
        <span className={TOOL_ROW_TAIL}>
          {counter && (
            <span className="tabular-nums text-[11.5px] leading-none text-faint" title={`${done} of ${todos.length} done`}>
              {counter}
            </span>
          )}
          {meta}
          <ToolRowChevron shown={expandable} open={open} />
        </span>
      </button>
      {expandable && (
        <div id={bodyId} className="frizz-tool-body" hidden={!open}>
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
              <div className="frizz-bash-output-label">Note</div>
              <pre className="frizz-bash-body frizz-bash-output-body">{note}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}
