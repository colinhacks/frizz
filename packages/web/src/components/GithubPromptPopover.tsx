import { useState, type ReactNode, type RefObject } from "react"
import { Settings as SettingsIcon } from "lucide-react"
import { useEscapeToClose } from "../hooks/useEscapeToClose.ts"
import { SaveStatus, useSettingsDraft } from "../hooks/useSettingsAutosave.tsx"
import { GithubPromptEditor } from "./GithubPromptField.tsx"
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "./ui/Popover.tsx"

// The gear in the GitHub picker's footer, left of the button that starts the batch, and the panel it
// opens: what every thread this picker dispatches will be, its model and effort (`children`, the selector
// the picker owns) and its triage prompt, editable right beside the act that sends it. The selector stood
// beside this gear in the footer until 2026-11-09. This is the prompt's ONLY editor: it lived in the
// Settings drawer until 2026-09-19, and moving a setting to its context means it no longer lives there at
// all. The glyph is the app's own settings gear (lucide `Settings`).
//
// MODAL for the same reason the model picker's agent-settings panel is (see AgentSettingsPopover): a
// panel with a textarea in it must not be dismissable by anything short of a pointer-down outside,
// Escape, or its own controls. Closing it flushes a debounced edit at once, and the picker's dispatch
// button waits on that write (useIsMutating on SETTINGS_WRITE_KEY), so a prompt edited and dispatched
// in the same breath is the prompt the workers get.
//
// `anchor` is the picker's footer row. The panel hangs off it rather than off the gear, so its right edge
// is the Start button's and it can never run past the picker's left edge: anchored to the gear, a 560px
// panel stood 22px outside the modal (2026-11-10).
export function GithubPromptPopover({ anchor, children }: { anchor: RefObject<HTMLElement | null>; children: ReactNode }) {
  const [open, setOpen] = useState(false)
  useEscapeToClose(open, () => setOpen(false))
  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverAnchor virtualRef={anchor as RefObject<HTMLElement>} />
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Investigation settings"
          title="The model and prompt for every thread this picker starts"
          onMouseDown={(e) => e.preventDefault()}
          // A 15px glyph in a 30px hover square — the Start button's own height, so the two stand on
          // one line as a pair on the footer's `items-center` row.
          className="github-prompt-trigger icon-focus-outline inline-flex size-[30px] shrink-0 items-center justify-center rounded-md text-muted outline-none transition-[color,background-color] hover:bg-hover-strong hover:text-fg aria-expanded:bg-hover-strong aria-expanded:text-fg"
        >
          <SettingsIcon aria-hidden="true" size={15} />
        </button>
      </PopoverTrigger>
      {/* Opens UPWARD over the list. The footer row spans the modal, padding included: the 20px align
          offset is that padding (`px-5`), so the panel's right edge lands on the Start button's, and the
          width never exceeds the content box between the two paddings. */}
      <PopoverContent
        side="top"
        align="end"
        alignOffset={20}
        sideOffset={8}
        className="w-[min(560px,calc(var(--radix-popover-trigger-width)_-_40px))] max-w-[calc(100vw-1rem)] overflow-hidden p-0"
        data-github-prompt-menu=""
        // Focus lands on the panel, not its first control, so opening it draws no focus ring on the model
        // selector. Tab still starts there.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          ;(event.currentTarget as HTMLElement).focus()
        }}
      >
        <GithubPromptForm>{children}</GithubPromptForm>
      </PopoverContent>
    </Popover>
  )
}

// A header with a rule under it, as the picker's own, then the two settings with no labels: a model
// selector and a prompt box need no caption to say what they are. They had a label and a caption each
// from 2026-11-10 until the same evening, and before that uppercase labels with `?` glyphs.
function GithubPromptForm({ children }: { children: ReactNode }) {
  const { draft, update, saveState } = useSettingsDraft()
  return (
    <div className="flex flex-col">
      <div className="flex min-h-[44px] items-center justify-between gap-3 border-b border-border/60 px-4">
        <span className="text-[13px] font-medium text-fg">Investigation settings</span>
        <SaveStatus state={saveState} />
      </div>
      <div className="flex flex-col gap-3 p-4">
        <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
        {!draft ? <div className="text-[12px] text-muted">Loading…</div> : <GithubPromptEditor draft={draft} onChange={update} rows={14} />}
      </div>
    </div>
  )
}
