import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react"
import type { ThreadSkill } from "@frizz/shared"
import { AnchoredLayer, aboveAnchor, belowAnchor, type Placement } from "./ui/AnchoredLayer.tsx"
import { acceptSlashToken, slashTokenAt } from "../lib/slashToken.ts"

// THE SKILLS TYPEAHEAD: the `/` menu, for every box whose text reaches an agent as a prompt (the
// Composer, on every surface that draws one, and the Goal's text). One implementation, so the boxes
// cannot drift: it lived inside the Composer until 2026-11-23, when the Goal box needed it too.
//
// WHERE IT OPENS: on the `/` token at the caret (lib/slashToken.ts), at the start of the draft or after
// any whitespace, the way Notion's `/` menu and Claude Code's do. It used to open only while the whole
// draft was one `/` token, which missed "run /review-local first" — and the agent acts on a mid-text
// name too (slashToken.ts has the measurement).

// Where a `/` suggestion came FROM, in this repo's own vocabulary rather than either harness's. Claude
// says `projectSettings`/`userSettings`, codex says `repo`/`user`; the server normalizes both to the
// shared enum and this names them the way the docs and the maintainer do — a skill in the checkout is
// "project", one in the home directory is "global" (see CLAUDE.md § project-local skills). Rendered in
// petite caps: a metadata tag the eye can skip, not more description to read.
const SKILL_SOURCE_LABEL: Record<NonNullable<ThreadSkill["source"]>, string> = {
  project: "project",
  user: "global",
  builtin: "built-in",
  plugin: "plugin",
}

// The menu's placements: from the anchor's left edge, a share of its width, 6px above it (below when the
// top has no room), or for a box whose text runs down a page, 6px below the line being typed.
const ABOVE = aboveAnchor(6)
export const BELOW_LINE = belowAnchor(6)

export type SlashTypeahead = {
  /** The menu, portaled; render it inside the element it should hang off. Null while closed. */
  menu: ReactNode
  /** Whether the menu is showing, so the box's own key handling can step aside. */
  open: boolean
  /** Offset of the `/` the menu is completing, for a caller that anchors the menu at its line. */
  tokenStart: number | null
  /** Run first in the box's keydown: true when the menu took the key, and the box must ignore it. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean
  /** Call from the textarea's onSelect and onChange, so the menu follows the caret. */
  noteCaret: (el: HTMLTextAreaElement) => void
}

/**
 * `suggest` is the list's source. A NEW FUNCTION MEANS A NEW LIST: the next `/` asks it again, so a
 * caller memoizes it on what the list depends on (a thread's box on its slug, the new-thread box on its
 * project and agent). Undefined, the whole affordance is inert.
 */
export function useSlashTypeahead({ text, setText, textareaRef, suggest, active, place = ABOVE }: {
  text: string
  setText: (next: string) => void
  textareaRef: RefObject<HTMLTextAreaElement | null>
  suggest: (() => Promise<ThreadSkill[]>) | undefined
  /** Whether the box has focus. The menu is portaled out of its surface, so it closes with focus. */
  active: boolean
  place?: Placement
}): SlashTypeahead {
  // The caret, with the text it was read against: a caret from before an edit means nothing in the new
  // text, so it counts only while the text is the same.
  const [caretFor, setCaretFor] = useState<{ text: string; caret: number } | null>(null)
  const caret = caretFor && caretFor.text === text ? caretFor.caret : null
  const noteCaret = (el: HTMLTextAreaElement) => {
    // A selection is not a caret: dragging across `/rev` must not open the menu.
    setCaretFor(el.selectionStart === el.selectionEnd ? { text: el.value, caret: el.selectionStart } : null)
  }
  const token = suggest && caret !== null ? slashTokenAt(text, caret) : null
  // `position` names one token in one draft: the key a highlight and an Escape belong to.
  const position = token ? `${token.start}:${caret}\u0000${text}` : ""

  // `skillsFetched` is the harness's list, fetched once on the first `/` trigger (null = not asked yet;
  // [] = asked, nothing to offer — including a fetch that failed, which must read as "no suggestions",
  // never as an error the operator has to dismiss). It belongs to the `suggest` that fetched it: the
  // new-thread box hands over a new one when its model chip moves to another agent, whose skills differ,
  // and a list fetched for the old one must read as "not asked yet".
  const [skillsFetched, setSkillsFetched] = useState<{ from: typeof suggest; items: ThreadSkill[] } | null>(null)
  const skillItems = skillsFetched && skillsFetched.from === suggest ? skillsFetched.items : null
  // The highlighted row, REMEMBERED WITH THE TOKEN IT WAS CHOSEN OVER: the filtered list under it
  // changes with every keystroke, so a highlight belongs to one draft and reads as row 0 for any
  // other. Derived, not reset by an effect — `useEffect(() => setSel(0), [text])` looked free (same
  // value, no re-render) but it was not: once the fiber carries any pending lane React skips the
  // same-value bailout, so every keystroke's effect enqueued a DefaultLane update that a fast burst of
  // keystrokes starved; the root then ended every sync commit with that lane still pending, React's
  // nested-update counter climbed one per keystroke, and a 50-keystroke burst (a multi-line draft on
  // /full, 2026-08-28) threw "Maximum update depth exceeded" twice per run.
  const [selFor, setSelFor] = useState<{ position: string; index: number }>({ position: "", index: 0 })
  const sel = selFor.position === position ? selFor.index : 0
  const setSel = (next: number | ((current: number) => number)) =>
    setSelFor({ position, index: typeof next === "function" ? next(sel) : next })
  // The exact token an Escape closed the menu over, so it stays closed until the draft or the caret
  // CHANGES — without it the menu would reopen on the very next render.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null)
  // Once the draft or the caret has moved on, the dismissal is spent: coming back to the same text
  // (Backspace, then the same letter again) is a new attempt, and the menu opens for it. Cleared during
  // render rather than in an effect, React's pattern for state that follows other state — an effect
  // here would be the keystroke-starved update the highlight's comment above describes.
  if (dismissedFor !== null && dismissedFor !== position) setDismissedFor(null)

  const asking = token !== null
  useEffect(() => {
    if (!asking || skillItems !== null) return
    let live = true
    const from = suggest
    // Errors resolve to "asked, nothing to offer": the caller decides whether to retry on a later
    // trigger by handing this a fresh mount (drawer reopen) or a new function — a typeahead never toasts.
    void from!().then(
      (items) => { if (live) setSkillsFetched({ from, items }) },
      () => { if (live) setSkillsFetched({ from, items: [] }) },
    )
    return () => { live = false }
  }, [asking, skillItems, suggest])

  const query = token?.query.toLowerCase() ?? ""
  const suggestions = useMemo(() => {
    if (!token || !skillItems || dismissedFor === position) return []
    // Prefix matches first (what completion usually wants), then substring matches — those are what
    // surface a namespaced skill (`frizz:gh`) from its bare name.
    const starts = skillItems.filter((s) => s.name.toLowerCase().startsWith(query))
    const contains = skillItems.filter((s) => !s.name.toLowerCase().startsWith(query) && s.name.toLowerCase().includes(query))
    return [...starts, ...contains]
    // `token` is read through `position` and `query`, which change whenever it does.
  }, [position, query, skillItems, dismissedFor])
  const open = suggestions.length > 0 && active
  // The DISTINCT source labels in the list on screen, which every row then reserves room for (see the
  // sizer in the menu below). Empty when no visible suggestion reports a source — a harness that says
  // nothing must not cost the descriptions a column of width.
  const sourceLabels = useMemo(() => {
    const labels = new Set<string>()
    for (const s of suggestions) if (s.source) labels.add(SKILL_SOURCE_LABEL[s.source])
    return [...labels]
  }, [suggestions])
  // Keep the highlighted row in view when arrowing through a list taller than the menu.
  const listRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    listRef.current?.querySelector(`[data-suggest-index="${sel}"]`)?.scrollIntoView({ block: "nearest" })
  }, [sel])

  function accept(item: { name: string }) {
    if (!token) return
    const next = acceptSlashToken(text, token, item.name)
    setText(next.text)
    setCaretFor({ text: next.text, caret: next.caret })
    requestAnimationFrame(() => textareaRef.current?.setSelectionRange(next.caret, next.caret))
  }

  // The open menu claims its keys FIRST — above all Enter (accept, not send) and Escape (close the menu,
  // not blur; the box's own Escape must not see this keypress). Modified Enter deliberately falls
  // through: ⌘-Enter mid-name is the operator overriding the menu, not using it.
  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open || e.nativeEvent.isComposing) return false
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault()
      setSel((current) => {
        const delta = e.key === "ArrowDown" ? 1 : -1
        return (current + delta + suggestions.length) % suggestions.length
      })
      return true
    }
    if ((e.key === "Enter" || e.key === "Tab") && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault()
      e.stopPropagation()
      accept(suggestions[sel] ?? suggestions[0]!)
      return true
    }
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      setDismissedFor(position)
      return true
    }
    return false
  }

  // Rows are text-only — a name and its one-line description — which keeps this out of icon-ink
  // territory entirely. Mousedown is prevented on the list for the same reason as a send button:
  // choosing a suggestion must never blur the textarea.
  //
  // PORTALED, and shown only while the box has focus. It was `absolute bottom-full z-20` inside the box
  // until 2026-11-01, where its z ranked only inside the composer's surface — a card footer is sticky
  // z-10, a drawer footer z-10 — so the drawer's jump-to-latest pill (z-20 over the transcript) painted
  // across its rows, and a box near the window's top opened it off the screen (lib/layers.ts rule 2).
  // Out of the surface it outranks anything opened after it, so it has to close when the textarea lets
  // go of focus, as every popover does; its keys only ever reached it with focus anyway.
  const menu = open ? (
    <AnchoredLayer place={place}>
      <div
        ref={listRef}
        data-slash-menu
        // On the list, not each row: a press on its padding or its scrollbar would blur the box too,
        // and the menu closes with focus.
        onMouseDown={(e) => e.preventDefault()}
        className="max-h-56 overflow-y-auto rounded-lg border border-border bg-bg py-1 shadow-lg"
      >
        {suggestions.map((s, i) => (
          <button
            key={s.name}
            type="button"
            data-suggest-index={i}
            onClick={() => accept(s)}
            onMouseEnter={() => setSel(i)}
            // px-3.5 matches the composer's own text inset, so the completed `/name` lands exactly
            // under the row that offered it.
            className={`flex w-full items-baseline gap-2 px-3.5 py-1.5 text-left ${i === sel ? "bg-panel-2" : ""}`}
          >
            <span className="shrink-0 text-[12px] font-medium text-fg">/{s.name}</span>
            {s.description && <span className="min-w-0 truncate text-[11px] text-muted">{s.description}</span>}
            {/* The source column. One WIDTH for every row, including the rows with no source to show —
                otherwise an unlabelled row's description truncates 50px further right than its
                neighbours' and the list reads ragged. The width is reserved by stacking every label in
                the list invisibly under the real one, so the BROWSER measures it: a hand-fitted px
                constant would be right in one of this app's two fonts and wrong in the other
                (AGENTS.md). Measured ink gap from the truncated description ahead of it: 13.16px against
                8.87px between a name and its own description — the tag reads as a separate column,
                which is what it is. */}
            {sourceLabels.length > 0 && (
              <span className="ml-auto grid shrink-0 text-[10px]">
                {sourceLabels.map((label) => (
                  <span key={label} aria-hidden className="petite-caps invisible col-start-1 row-start-1">{label}</span>
                ))}
                <span className="petite-caps col-start-1 row-start-1 text-right text-muted-70">
                  {s.source ? SKILL_SOURCE_LABEL[s.source] : ""}
                </span>
              </span>
            )}
          </button>
        ))}
      </div>
    </AnchoredLayer>
  ) : null

  return { menu, open, tokenStart: open && token ? token.start : null, onKeyDown, noteCaret }
}
