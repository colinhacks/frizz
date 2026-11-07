import { useState } from "react"
import { Settings as SettingsIcon } from "lucide-react"
import { useEscapeToClose } from "../hooks/useEscapeToClose.ts"
import { SaveStatus, useSettingsDraft } from "../hooks/useSettingsAutosave.tsx"
import { SETTINGS_GLYPH, SETTINGS_MARK } from "../lib/iconRhythm.ts"
import { GithubPromptEditor } from "./GithubPromptField.tsx"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover.tsx"

// The gear in the GitHub picker's footer, right of the model chip, and the panel it opens: the triage
// prompt every thread this picker dispatches will run, beside the model those threads run on (it sat
// left of the Start button from 2026-10-26 to 2026-11-07, and in the header's far corner before that).
// This is its ONLY editor: it lived in the Settings drawer until 2026-09-19, and moving a setting to its
// context means it no longer lives there at all. The glyph is the app's own settings gear (lucide
// `Settings`), drawn as one of the agent's marks the composer keeps beside its own model chip.
//
// MODAL for the same reason the model picker's agent-settings panel is (see AgentSettingsPopover): a
// panel with a textarea in it must not be dismissable by anything short of a pointer-down outside,
// Escape, or its own controls. Closing it flushes a debounced edit at once, and the picker's dispatch
// button waits on that write (useIsMutating on SETTINGS_WRITE_KEY), so a prompt edited and dispatched
// in the same breath is the prompt the workers get.
export function GithubPromptPopover() {
  const [open, setOpen] = useState(false)
  useEscapeToClose(open, () => setOpen(false))
  return (
    <Popover modal open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Triage prompt settings"
          title="Edit the prompt every thread this picker starts will run"
          onMouseDown={(e) => e.preventDefault()}
          className={`github-prompt-trigger ${SETTINGS_MARK}`}
        >
          <SettingsIcon aria-hidden="true" {...SETTINGS_GLYPH} />
        </button>
      </PopoverTrigger>
      {/* Opens UPWARD and RIGHTWARD: the gear sits on the modal's bottom edge, at its left, like the model
          selector beside it. */}
      <PopoverContent side="top" align="start" sideOffset={6} className="w-[560px] max-w-[calc(100vw-1rem)] p-4" data-github-prompt-menu="">
        <GithubPromptForm />
      </PopoverContent>
    </Popover>
  )
}

function GithubPromptForm() {
  const { draft, update, saveState } = useSettingsDraft()
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] font-medium text-fg">Picker settings</span>
        <SaveStatus state={saveState} />
      </div>
      {!draft ? <div className="text-[12px] text-muted">Loading…</div> : <GithubPromptEditor draft={draft} onChange={update} rows={14} />}
    </div>
  )
}
