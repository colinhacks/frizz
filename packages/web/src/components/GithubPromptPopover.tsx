import { useState, type ReactNode } from "react"
import { Settings as SettingsIcon } from "lucide-react"
import { useEscapeToClose } from "../hooks/useEscapeToClose.ts"
import { SaveStatus, useSettingsDraft } from "../hooks/useSettingsAutosave.tsx"
import { SETTINGS_HELP } from "../lib/settingsHelp.ts"
import { GithubPromptEditor } from "./GithubPromptField.tsx"
import { SettingsField } from "./SettingsField.tsx"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover.tsx"

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
export function GithubPromptPopover({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false)
  useEscapeToClose(open, () => setOpen(false))
  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Picker settings"
          title="The model and prompt for every thread this picker starts"
          onMouseDown={(e) => e.preventDefault()}
          // A 15px glyph in a 30px hover square — the Start button's own height, so the two stand on
          // one line as a pair on the footer's `items-center` row.
          className="github-prompt-trigger icon-focus-outline inline-flex size-[30px] shrink-0 items-center justify-center rounded-md text-muted outline-none transition-[color,background-color] hover:bg-hover-strong hover:text-fg aria-expanded:bg-hover-strong aria-expanded:text-fg"
        >
          <SettingsIcon aria-hidden="true" size={15} />
        </button>
      </PopoverTrigger>
      {/* Opens UPWARD and back across the picker: the gear sits at the modal's bottom-right corner. */}
      <PopoverContent
        side="top"
        align="end"
        sideOffset={6}
        className="w-[560px] max-w-[calc(100vw-1rem)] p-4"
        data-github-prompt-menu=""
        // Focus lands on the panel, not its first control: that control is a help glyph, and a focused help
        // glyph opens its tooltip, which covered the prompt every time the panel opened. Tab still starts there.
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

function GithubPromptForm({ children }: { children: ReactNode }) {
  const { draft, update, saveState } = useSettingsDraft()
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] font-medium text-fg">Picker settings</span>
        <SaveStatus state={saveState} />
      </div>
      <SettingsField label="Model and effort" help={SETTINGS_HELP.githubProfile}>
        <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
      </SettingsField>
      {!draft ? <div className="text-[12px] text-muted">Loading…</div> : <GithubPromptEditor draft={draft} onChange={update} rows={14} />}
    </div>
  )
}
