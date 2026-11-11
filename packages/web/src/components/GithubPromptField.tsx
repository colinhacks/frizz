import { useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { type Settings } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { Tooltip } from "./Tooltip.tsx"

// The 6 substitution tokens the server fills in a GitHub batch-dispatch template, each with what it
// becomes. Kept in lockstep with PROMPT_TOKENS in server/github.ts (there is no shared const; this is a
// display hint only), and the glosses with what `renderGithubPrompt` substitutes: labels joined with
// commas, the body cut by `truncateBody`.
const GH_PROMPT_TOKENS: { token: string; gloss: string }[] = [
  { token: "repo", gloss: "The repository, as owner/name" },
  { token: "n", gloss: "The issue or PR number" },
  { token: "title", gloss: "Its title" },
  { token: "url", gloss: "Its link on GitHub" },
  { token: "labels", gloss: "Its labels, comma-separated" },
  { token: "body", gloss: "Its description, shortened if long" },
]

// The GitHub-picker triage template's editor, rendered by the picker's own settings popover
// (GithubPromptPopover) — the one place the prompt is edited. It PREFILLS with the shipped default (fetched
// from the server, the single source of truth) so the user edits from the real prompt; a stored
// override supersedes it. Empty override = default.
//
// ONE editor, not two. Issue and PR had a box each until 2026-08-15; the two prompts said much the same
// thing, so "make triage more skeptical" meant the same edit twice and a pair that drifted apart.
export function GithubPromptEditor({
  draft,
  onChange,
  rows,
}: {
  draft: Settings
  onChange: (next: Settings, opts?: { debounce?: boolean }) => void
  rows?: number
}) {
  const defaults = useQuery({ queryKey: ["githubPromptDefaults"], queryFn: () => rpc.githubPromptDefaults() })
  if (!defaults.data) return <div className="text-[12px] text-muted">Loading defaults…</div>
  return (
    <GithubPromptField
      value={draft.githubPrompt}
      fallback={defaults.data.prompt}
      rows={rows}
      onChange={(v, opts) => onChange({ ...draft, githubPrompt: v }, opts)}
    />
  )
}

// One prompt editor. `value` is the stored override (undefined = "use default"); `fallback` is the
// shipped default shown when there is no override, so the box always renders the effective prompt.
// Typing sets a concrete override; "Reset to default" clears it back to undefined (server default).
// Typing is the one input that DEBOUNCES its write — a keystroke is not an intent, a pause is;
// "Reset to default" is a click, so it saves at once like every other control.
//
// The tokens are a row of chips under the box, each one inserting itself at the caret, with what it
// becomes on hover. Until 2026-11-10 they were a read-only list behind a "Tokens" text button, which
// meant opening a second popover over the first to read a token and then typing it out by hand.
export function GithubPromptField({
  value,
  fallback,
  rows = 10,
  onChange,
}: {
  value: string | undefined
  fallback: string
  rows?: number
  onChange: (v: string | undefined, opts?: { debounce?: boolean }) => void
}) {
  const customized = value != null
  const box = useRef<HTMLTextAreaElement>(null)
  // Whether the caret was ever placed in the box. A token picked before that goes at the end of the
  // prompt, not at offset 0 where an untouched textarea's selection sits.
  const caretPlaced = useRef(false)

  function insertToken(token: string) {
    const el = box.current
    if (!el) return
    const text = `{${token}}`
    if (!caretPlaced.current) el.setSelectionRange(el.value.length, el.value.length)
    el.focus()
    // `insertText` edits the way a keystroke does: it lands on the box's own undo stack, scrolls the caret
    // into view, and fires the input event that the onChange below reads, so the write debounces like typing.
    if (document.execCommand("insertText", false, text)) return
    const start = el.selectionStart
    onChange(el.value.slice(0, start) + text + el.value.slice(el.selectionEnd), { debounce: true })
    requestAnimationFrame(() => el.setSelectionRange(start + text.length, start + text.length))
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-end justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-[12.5px] text-fg/90">Prompt</span>
          <span className="text-[11.5px] text-muted-70">Each thread's first message, filled in from its issue or PR</span>
        </div>
        {customized && (
          <button
            type="button"
            className="shrink-0 rounded text-[11.5px] text-muted-70 outline-none transition-colors hover:text-fg focus-visible:text-fg"
            onClick={() => onChange(undefined)}
          >
            Reset to default
          </button>
        )}
      </div>
      {/* The frame carries the border and the vertical padding, and the textarea inside it has none, so
          its height is exactly `rows` lines of 20px. A textarea's own padding scrolls with its text: at
          rest the next line showed through the bottom padding cut in half, and scrolled to the end the
          last line sat on the border. A press on the frame's padding still places the caret. */}
      <div
        className="input mt-1 flex px-0 py-2 focus-within:border-input-focus"
        onMouseDown={(e) => {
          if (e.target !== e.currentTarget) return
          e.preventDefault()
          box.current?.focus()
        }}
      >
        <textarea
          ref={box}
          data-1p-ignore
          value={value ?? fallback}
          onFocus={() => { caretPlaced.current = true }}
          // Emptying the box clears the override (→ undefined), so it snaps back to showing the default
          // and drops the "Reset" affordance — matching the server's blank-means-default semantics
          // instead of leaving a confusing empty box that still reads as "customized".
          onChange={(e) => onChange(e.target.value === "" ? undefined : e.target.value, { debounce: true })}
          rows={rows}
          // Prose, so the body face, not the mono it was set in until 2026-11-10.
          className="block w-full resize-none bg-transparent px-3 py-0 text-[13px] leading-[20px] text-fg outline-none"
          spellCheck={false}
        />
      </div>
      {/* Baseline, not center: the label is sans and the chips mono, whose braces reach below the
          baseline, so centred boxes set the label's text visibly lower than the tokens'. */}
      <div className="flex flex-wrap items-baseline gap-1" data-github-prompt-tokens="">
        <span className="mr-1 text-[11.5px] text-muted-70">Insert</span>
        {GH_PROMPT_TOKENS.map(({ token, gloss }) => (
          <Tooltip key={token} label={gloss}>
            <button
              type="button"
              aria-label={`Insert {${token}}: ${gloss}`}
              // The box keeps its focus and its caret, so the token lands where the caret was.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => insertToken(token)}
              className="font-mono-keep rounded-[5px] bg-fg/7 px-1.5 text-[11px] leading-[20px] text-fg/75 outline-none transition-colors hover:bg-fg/12 hover:text-fg focus-visible:bg-fg/12 focus-visible:text-fg"
            >
              {`{${token}}`}
            </button>
          </Tooltip>
        ))}
      </div>
    </div>
  )
}
