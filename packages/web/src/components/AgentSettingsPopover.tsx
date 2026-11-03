import * as RadixMenu from "@radix-ui/react-dropdown-menu"
import { useQuery } from "@tanstack/react-query"
import { Settings as SettingsIcon } from "lucide-react"
import { useId, useState } from "react"
import { parseLaunchPrefix, type Settings } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { useEscapeToClose } from "../hooks/useEscapeToClose.ts"
import { SaveStatus, useSettingsDraft } from "../hooks/useSettingsAutosave.tsx"
import { CODEX_CONTEXT_WINDOW_DEFAULT, codexContextWindowOptions, formatTokens } from "../lib/codexContextWindow.ts"
import { AUTO_COMPACT_WINDOW_OPTIONS, CONTEXT_WINDOW_HELP, DEFAULT_AUTO_COMPACT_WINDOW } from "../lib/contextWindows.ts"
import { launchPrefixPreview, withLaunchPrefix, type LaunchPrefixRuntime } from "../lib/launchPrefixField.ts"
import { CLAUDE_DISPATCH_PERMISSION_OPTIONS } from "../lib/options.ts"
import { OPAQUE_PORTAL_SURFACE_ABOVE_POPOVER_Z } from "../lib/overlaySurface.ts"
import { SETTINGS_HELP } from "../lib/settingsHelp.ts"
import { SettingsField } from "./SettingsField.tsx"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover.tsx"
import { Select } from "./ui/Select.tsx"

// The prompt-cache tiers Claude Code understands (CLAUDE_CODE_PROMPT_CACHE_TTL). "auto" passes nothing
// and the CLI picks for itself — 1 hour on a subscription — so it is the server default (settings.ts).
const PROMPT_CACHE_TTL_OPTIONS = [
  { value: "auto", label: "Automatic (default)" },
  { value: "5m", label: "5 minutes" },
  { value: "1h", label: "1 hour" },
]

const PROVIDER_LABEL = { claude: "Claude Code", codex: "Codex" } as const

// The gear on a runtime's band in the model picker, and the panel it opens: every setting that belongs
// to THAT runtime's new threads in this project — Claude's permission mode, prompt-cache tier and
// compaction window; Codex's context window; and each runtime's launch prefix. They lived in the
// Settings drawer under a "Claude" band until 2026-09-19, a drawer away from the picker where the
// operator is actually choosing a worker (maintainer: "we want settings to appear in the context where
// they are relevant").
//
// MODAL, and that is the whole reason this panel cannot vanish. Its predecessor — a plain context
// dropdown on the same header row — was a NON-modal popover whose trigger was a menu item, and Radix
// Menu focuses its own content the moment the pointer LEAVES an item (`onItemLeave`), which is a
// focus-outside for a non-modal popover, which dismisses it: moving the mouse off the trigger toward
// the panel closed the panel (maintainer 2026-09-19: "unacceptable and should not be structurally
// possible"). A modal popover ignores focus leaving it, traps focus inside, and disables pointer
// events everywhere else while it is open — so no hover, no focus wander and no menu bookkeeping can
// close it. Only a pointer-down outside, Escape, or a control inside can.
//
// The trigger stays a RadixMenu.Item so the keyboard reaches it (Tab is swallowed inside a Radix
// menu; the arrow keys are the only way to a control in one), with `onSelect` prevented so opening the
// panel never closes the picker beneath it.
export function AgentSettingsPopover({ backend, open, onOpenChange }: {
  backend: "claude" | "codex"
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const provider = PROVIDER_LABEL[backend]
  useEscapeToClose(open, () => onOpenChange(false))
  return (
    <Popover modal open={open} onOpenChange={onOpenChange}>
      <RadixMenu.Item asChild onSelect={(event) => event.preventDefault()}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`${provider} settings`}
            title={`${provider} settings for new threads in this project`}
            // The app's own settings gear (lucide `Settings`, the glyph the status row and the mobile
            // board already use — a sliders glyph stood here for a few hours and read as a different
            // control), 14px in a 20px hover square, MEASURED into place on the band's header row:
            //  - VERTICAL. The row is `items-baseline`, and a flex button with only an SVG in it hands
            //    the row its SVG's bottom edge as a baseline, so the glyph's centre landed 7px above
            //    the label's baseline — ~3px above the label's cap band, by a different amount per font. The
            //    translate moves it down by exactly the difference between half the 14px glyph and
            //    half the resolved cap height, so it tracks the type scale with nothing to re-fit
            //    (measured after: 0.0px in both fonts).
            //  - HORIZONTAL. The gear paints 11.7 of its 14px, so the square carries ~4px of dead
            //    space a side; `-mr-3` pulls the box out so the glyph's INK ends 12.7px from the menu's
            //    right edge, against the 13px the label's ink starts from on the left.
            //  - `-my-1` keeps the square from stretching the header row.
            className="agent-settings-trigger -my-1 -mr-3 inline-flex size-5 shrink-0 translate-y-[calc(7px_-_0.5cap)] items-center justify-center rounded-[5px] text-muted-70 outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:bg-panel-2 focus-visible:text-fg data-[state=open]:bg-panel-2 data-[state=open]:text-fg"
          >
            <SettingsIcon aria-hidden="true" size={14} />
          </button>
        </PopoverTrigger>
      </RadixMenu.Item>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        className="w-[272px] max-w-[calc(100vw-1rem)] p-4"
        style={{ fontVariantCaps: "normal", letterSpacing: "normal" }}
        data-agent-settings-menu={backend}
        // The panel is a React descendant of the picker's menu (portals keep the React tree), so its
        // keystrokes would bubble into the menu's typeahead and roving focus. They stop here.
        onKeyDown={(event) => event.stopPropagation()}
      >
        <AgentSettingsForm backend={backend} />
      </PopoverContent>
    </Popover>
  )
}

// Mounted only while the panel is open: the draft seeds from the settings cache each time it opens,
// so a change made elsewhere (the drawer, another tab) is what the panel shows next time.
function AgentSettingsForm({ backend }: { backend: "claude" | "codex" }) {
  const { draft, update, saveState } = useSettingsDraft()
  const models = useQuery({ queryKey: ["codexModels"], queryFn: () => rpc.codexModels(), enabled: backend === "codex" })
  return (
    <div className="flex flex-col gap-4 text-[12px]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] font-medium text-fg">{PROVIDER_LABEL[backend]} settings</span>
        <SaveStatus state={saveState} />
      </div>
      {!draft ? (
        <div className="text-[12px] text-muted">Loading…</div>
      ) : backend === "claude" ? (
        <>
          {/* Only the two modes a headless worker can actually run in are offered (see
              CLAUDE_DISPATCH_PERMISSION_OPTIONS); the server's workerDispatchPermission enforces the
              same floor, so a restrictive value left in an old DB can never reach a spawn. A stored
              mode outside the two reads as the "Auto" floor — which is exactly what would be
              dispatched — rather than rendering the select blank. */}
          <SettingsField label="Permissions" help={SETTINGS_HELP.permissionMode}>
            <Select
              variant="bordered"
              value={draft.permissionMode === "bypassPermissions" ? "bypassPermissions" : "auto"}
              onValueChange={(v) => update({ ...draft, permissionMode: v as Settings["permissionMode"] })}
              options={CLAUDE_DISPATCH_PERMISSION_OPTIONS}
              indicatorPosition="right"
              menuZClass={OPAQUE_PORTAL_SURFACE_ABOVE_POPOVER_Z}
              ariaLabel="Claude permission mode"
            />
          </SettingsField>
          <SettingsField label="Prompt cache tier" help={SETTINGS_HELP.promptCacheTtl}>
            <Select
              variant="bordered"
              value={draft.promptCacheTtl ?? "auto"}
              onValueChange={(v) => update({ ...draft, promptCacheTtl: v as Settings["promptCacheTtl"] })}
              options={PROMPT_CACHE_TTL_OPTIONS}
              indicatorPosition="right"
              menuZClass={OPAQUE_PORTAL_SURFACE_ABOVE_POPOVER_Z}
              ariaLabel="Claude prompt cache tier"
            />
          </SettingsField>
          <CompactionWindowField draft={draft} update={update} />
          <LaunchPrefixField runtime="claude" draft={draft} update={update} />
        </>
      ) : (
        <>
          <SettingsField label="Context window" help={CONTEXT_WINDOW_HELP.codex}>
            <Select
              variant="bordered"
              value={draft.codexContextWindow === undefined ? CODEX_CONTEXT_WINDOW_DEFAULT : String(draft.codexContextWindow)}
              onValueChange={(v) => update({ ...draft, codexContextWindow: v === CODEX_CONTEXT_WINDOW_DEFAULT ? undefined : Number(v) })}
              options={codexContextWindowOptions(models.data, draft.codexContextWindow)}
              indicatorPosition="right"
              menuZClass={OPAQUE_PORTAL_SURFACE_ABOVE_POPOVER_Z}
              ariaLabel="Codex context window"
            />
          </SettingsField>
          <LaunchPrefixField runtime="codex" draft={draft} update={update} />
        </>
      )}
    </div>
  )
}

// A stored window off the ladder (an older default, a hand-edited value) still has to render as
// itself rather than as a blank select, so it joins the options under its own label.
function CompactionWindowField({ draft, update }: { draft: Settings; update: (next: Settings) => void }) {
  const stored = draft.autoCompactWindow ?? DEFAULT_AUTO_COMPACT_WINDOW
  const value = String(stored)
  const options = AUTO_COMPACT_WINDOW_OPTIONS.some((o) => o.value === value)
    ? AUTO_COMPACT_WINDOW_OPTIONS
    : [...AUTO_COMPACT_WINDOW_OPTIONS, { value, label: formatTokens(stored) }]
  return (
    <SettingsField label="Compaction window" help={CONTEXT_WINDOW_HELP.claude}>
      <Select
        variant="bordered"
        value={value}
        onValueChange={(v) => update({ ...draft, autoCompactWindow: Number(v) })}
        options={options}
        indicatorPosition="right"
        menuZClass={OPAQUE_PORTAL_SURFACE_ABOVE_POPOVER_Z}
        ariaLabel="Claude Code compaction window"
      />
    </SettingsField>
  )
}

// The command a runtime's workers start THROUGH (shared/launch-prefix.ts). Free text, so it keeps its
// OWN text state rather than rendering `draft.launchPrefix` back into the box:
//  - AN INVALID PREFIX IS NEVER SAVED. Every keystroke is parsed by the same `parseLaunchPrefix` the
//    server spawns with; one that fails shows the parser's sentence under the box and queues nothing,
//    so the stored value stays the last one that parsed (and a half-typed `"op run` never reaches a
//    worker). The draft seeds the box once, when the panel opens, so reopening it shows what is stored.
//  - NOTHING ROUND-TRIPS INTO THE BOX. The input's value is this local string alone, and an autosave
//    that lands republishes the settings cache, never this state — so a save mid-word cannot rewrite
//    the text or move the cursor.
//  - DEBOUNCED like every free-text setting (useSettingsDraft), so a prefix is one write, not one per
//    character; closing the panel flushes it.
// Under a valid prefix, the command it produces in muted mono: the box is one line that scrolls, so
// this is the only place a long wrapper reads whole, and it shows the split the parser made.
function LaunchPrefixField({ runtime, draft, update }: {
  runtime: LaunchPrefixRuntime
  draft: Settings
  update: (next: Settings, opts?: { debounce?: boolean }) => void
}) {
  const [text, setText] = useState(() => draft.launchPrefix?.[runtime] ?? "")
  const parsed = parseLaunchPrefix(text)
  const errorId = useId()
  return (
    <SettingsField label="Launch prefix" help={runtime === "claude" ? SETTINGS_HELP.launchPrefixClaude : SETTINGS_HELP.launchPrefixCodex}>
      <input
        type="text"
        data-1p-ignore
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        value={text}
        placeholder="op run --"
        aria-label={`${PROVIDER_LABEL[runtime]} launch prefix`}
        aria-invalid={parsed.ok ? undefined : true}
        aria-describedby={parsed.ok ? undefined : errorId}
        onChange={(event) => {
          const next = event.target.value
          setText(next)
          if (parseLaunchPrefix(next).ok) update(withLaunchPrefix(draft, runtime, next), { debounce: true })
        }}
        // The Select triggers' own box (border, `px-2 py-1`, 28px tall), so the input lines up with the
        // fields above it. 11.5px, not their 12px: the mono face is drawn larger on the same size —
        // measured in sans, 12px mono's cap/x-height is 8.75/6.56px against the selects' 8.46/6.32px,
        // and 11.5px mono's 8.39/6.29px matches them.
        className="input px-2 py-1 text-[11.5px] leading-[18px] font-mono-keep"
      />
      {!parsed.ok ? (
        <div id={errorId} role="alert" className="break-words text-[11px] leading-snug text-danger-soft">{withInlineCode(parsed.error)}</div>
      ) : parsed.argv.length > 0 ? (
        <div className="text-[11px] leading-snug text-muted font-mono-keep [overflow-wrap:anywhere]" data-launch-prefix-preview="">
          {launchPrefixPreview(parsed.argv, runtime)}
        </div>
      ) : null}
    </SettingsField>
  )
}

// The parser's sentences mark code with backticks (`|`, `sh -c`), so those spans render as code rather
// than as literal backticks.
function withInlineCode(sentence: string) {
  return sentence.split("`").map((part, i) => (i % 2 === 1 ? <code key={i} className="font-mono-keep">{part}</code> : part))
}
