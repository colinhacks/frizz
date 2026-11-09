import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./SettingsDrawer.tsx", import.meta.url), "utf8")
const helpSource = readFileSync(new URL("../lib/settingsHelp.ts", import.meta.url), "utf8")
const autosaveSource = readFileSync(new URL("../hooks/useSettingsAutosave.tsx", import.meta.url), "utf8")
const fieldSource = readFileSync(new URL("./SettingsField.tsx", import.meta.url), "utf8")
const agentSource = readFileSync(new URL("./AgentSettingsPopover.tsx", import.meta.url), "utf8")
const promptFieldSource = readFileSync(new URL("./GithubPromptField.tsx", import.meta.url), "utf8")
const promptPopoverSource = readFileSync(new URL("./GithubPromptPopover.tsx", import.meta.url), "utf8")
const pickerSource = readFileSync(new URL("./GithubPickerModal.tsx", import.meta.url), "utf8")
const tooltipSource = readFileSync(new URL("./Tooltip.tsx", import.meta.url), "utf8")

test("settings maps each contextual explanation to a help control", () => {
  // `subagentInstructions` is gone: the settings preamble was retired in favour of FRIZZ.md, so there
  // is exactly one operator-authored surface for project conventions.
  for (const key of ["permissionMode", "promptCacheTtl", "appearance", "notifications", "githubPrompt"]) {
    assert.match(helpSource, new RegExp(`\\b${key}:`), `missing settings help mapping: ${key}`)
  }
  assert.match(source, /label="Desktop notifications" help=\{SETTINGS_HELP\.notifications\}/)
  // The runtime fields read the same table from their own surface.
  assert.match(agentSource, /label="Permissions" help=\{SETTINGS_HELP\.permissionMode\}/)
  assert.match(agentSource, /label="Prompt cache tier" help=\{SETTINGS_HELP\.promptCacheTtl\}/)
  assert.match(promptFieldSource, /help=\{SETTINGS_HELP\.githubPrompt\}/)
  // The redundant "GitHub picker prompts" group label is gone; each field carries its own label.
  assert.doesNotMatch(source, /label="GitHub picker prompts"/)
})

// The BEHAVIOUR of the autosave — one write per click, one write per typing burst, and a flush on
// close — is pinned in a real browser by settingsAutosave.e2e.test.ts. This test guards the shape it
// depends on: nothing here may reintroduce a button that the operator has to press.
test("settings save themselves — no Save button, no Cancel, no unsaved marker", () => {
  assert.doesNotMatch(source, />\s*Save\s*</)
  assert.doesNotMatch(source, />\s*Cancel\s*</)
  assert.doesNotMatch(source, /● unsaved/)
  // The footer those two buttons lived in went with them; the sheet is header + scroll body.
  assert.doesNotMatch(source, /<footer/)
  // Every control routes through the one updater, and only free text debounces.
  assert.match(source, /const \{ draft, update, saveState, flush \} = useSettingsDraft\(\)/)
  assert.match(promptFieldSource, /onChange=\{\(e\) => onChange\(e\.target\.value === "" \? undefined : e\.target\.value, \{ debounce: true \}\)\}/)
  // Closing must not strand the keystrokes still sitting in the debounce.
  const close = source.slice(source.indexOf("function close()"), source.indexOf("async function toggleNotifications"))
  assert.match(close, /flush\(\)/)
  // Writes are serialized: a whole-object payload delivered out of order silently reverts settings.
  // And every write is a react-query mutation under one key, so a dispatch surface can wait on it.
  assert.match(autosaveSource, /chain\.current = chain\.current\s*\n\s*\.then\(\(\) => writeRef\.current\.mutateAsync\(next\)\)/)
  assert.match(autosaveSource, /export const SETTINGS_WRITE_KEY = \["settingsSet"\] as const/)
  assert.match(autosaveSource, /mutationKey: \[\.\.\.SETTINGS_WRITE_KEY\], mutationFn: writeSettings \}\)/)
  // And each write goes to the project it was queued for (hooks/useSettingsAutosave.test.ts).
  assert.match(autosaveSource, /pending\.current = \{ project, settings \}/)
})

test("the drawer no longer duplicates the composer's controls or offers vestigial toggles", () => {
  // Model and effort are chosen per-dispatch in the prompt box (DispatchPreferences), so a second,
  // divergent copy of them here was only ever a way to confuse which one applied.
  assert.doesNotMatch(source, /label="Model"/)
  assert.doesNotMatch(source, /label="Effort"/)
  // The Runtime QA gate setting is gone entirely — browser-QA policy is a project's own FRIZZ.md
  // concern, not a global Frizz switch.
  assert.doesNotMatch(source, /Runtime QA gate/)
  assert.doesNotMatch(source, /runtimeGate/)
  // Auto-resume after a usage limit is unconditional now: nothing to turn off.
  assert.doesNotMatch(source, /autoResumeOnLimit/)
  assert.doesNotMatch(source, /Auto-resume after usage limits/)
})

// The drawer holds only machine and browser preferences. A setting that belongs to a project or to
// one runtime is edited where it applies, and nowhere else: the runtime fields behind the gear on
// their band in the model picker, the triage prompt behind the gear in the GitHub picker's header
// (maintainer 2026-09-19: "the whole point of moving these settings to other places is that we don't
// need to have them in the drawer anymore, so yeah, you can drop the tab switcher").
test("the drawer is one untabbed list of interface preferences, with no project or runtime settings", () => {
  // (The note above the component NAMES the retired tab in prose; what must be gone is the markup.)
  assert.doesNotMatch(source, /role="tab(?:list)?"|SettingsTabs|label: "(?:Project|Frizz) settings"/)
  const fields = [...source.matchAll(/<SettingsField label="([^"]+)"/g)].map((m) => m[1])
  // GitHub leads, and above the draft gate, so a slow settings read cannot hold the sign-in back.
  assert.deepEqual(fields, ["GitHub", "Appearance", "Project sidebar", "Wrap code", "Dictation", "Desktop notifications", "Child threads", "Local file links"])
  assert.ok(source.indexOf('<SettingsField label="GitHub"') < source.indexOf("{!draft ? ("), "the GitHub row renders without the draft")
  // Child threads is the one experiment, and says so beside its name.
  assert.deepEqual([...source.matchAll(/<SettingsField label="([^"]+)" experimental\b/g)].map((m) => m[1]), ["Child threads"])
  assert.match(fieldSource, /normal-case[^"]*tracking-normal[^"]*">\s*Experimental\s*</)
  // The triage prompt has exactly one editor, and it is the picker's.
  assert.doesNotMatch(source, /GithubPromptEditor|githubPrompt|<textarea/)
  assert.match(promptPopoverSource, /<GithubPromptEditor draft=\{draft\} onChange=\{update\} rows=\{14\} \/>/)
  // Nothing Claude- or Codex-specific is left in the drawer.
  assert.doesNotMatch(source, /ClaudeSection|CodexSection|DividerLabel|permissionMode|promptCacheTtl|autoCompactWindow|codexContextWindow/)
  assert.doesNotMatch(source, /label="(?:Permissions|Prompt cache tier|Compaction|Context window)"/)
})

// Both in-context panels open off THE APP'S settings gear — lucide `Settings`, the glyph the status
// row and the mobile board use — never a second "settings" glyph (a sliders icon stood here briefly;
// maintainer 2026-09-19: "it should be a gear icon for settings. That's the one we use everywhere else").
test("every settings affordance wears the same gear", () => {
  for (const src of [agentSource, promptPopoverSource, readFileSync(new URL("./StatusRow.tsx", import.meta.url), "utf8")]) {
    assert.match(src, /Settings as SettingsIcon[^\n]*from "lucide-react"/)
    assert.match(src, /<SettingsIcon\b/)
    assert.doesNotMatch(src, /Settings2|SlidersHorizontal/)
  }
})

// The runtime settings live on the model picker's band header, behind a gear, in a MODAL popover.
// Its predecessor (a non-modal context dropdown) closed the moment the pointer left its trigger,
// because Radix Menu focuses its own content on item leave and a non-modal popover reads that as a
// focus-outside. The modal flag is what makes that structurally impossible; this pins it.
test("the agent settings panel is modal, keyboard-reachable, and holds exactly the runtime's fields", () => {
  assert.match(agentSource, /<Popover modal open=\{open\} onOpenChange=\{onOpenChange\}>/)
  assert.match(agentSource, /<RadixMenu\.Item asChild onSelect=\{\(event\) => event\.preventDefault\(\)\}>/)
  assert.match(agentSource, /useEscapeToClose\(open, \(\) => onOpenChange\(false\)\)/)
  assert.match(agentSource, /onKeyDown=\{\(event\) => event\.stopPropagation\(\)\}/)
  // The Claude panel offers only the two headless-safe modes, and an out-of-range stored value
  // displays as the "auto" floor the server would actually dispatch with.
  assert.match(agentSource, /options=\{CLAUDE_DISPATCH_PERMISSION_OPTIONS\}/)
  assert.match(agentSource, /value=\{draft\.permissionMode === "bypassPermissions" \? "bypassPermissions" : "auto"\}/)
  assert.match(agentSource, /ariaLabel="Claude Code compaction window"/)
  assert.match(agentSource, /ariaLabel="Codex context window"/)
  // Every Select inside the panel portals ABOVE the panel, never at its own tier.
  const selects = agentSource.match(/<Select\b/g) ?? []
  const raised = agentSource.match(/menuZClass=\{OPAQUE_PORTAL_SURFACE_ABOVE_POPOVER_Z\}/g) ?? []
  assert.equal(raised.length, selects.length)
  // The dispatch surfaces carry the gear; a live thread's own picker does not.
  for (const file of ["NewThreadModal.tsx", "GithubPickerModal.tsx"]) {
    assert.match(readFileSync(new URL(file, import.meta.url), "utf8"), /agentSettings/)
  }
  assert.doesNotMatch(readFileSync(new URL("../hooks/useThreadComposerControls.tsx", import.meta.url), "utf8"), /agentSettings|contextWindows/)
  // The retired control and its patch RPC are gone for good.
  assert.doesNotMatch(readFileSync(new URL("./ProfileGridSelector.tsx", import.meta.url), "utf8"), /ContextWindowControl|contextWindows|data-context-window-menu/)
  assert.doesNotMatch(readFileSync(new URL("../api/contract.ts", import.meta.url), "utf8"), /contextWindowSet/)
})

// The GitHub picker's header: the slug is a right-justified link out to the repo with the external
// arrow. Its footer: the gear that opens the triage prompt stands beside the model chip, the two halves
// of what every started thread will be, and the Start button stands alone.
test("the GitHub picker carries the repo link in its header, the prompt gear beside its model chip, and waits on settings writes", () => {
  const header = pickerSource.slice(pickerSource.indexOf("{/* Header"), pickerSource.indexOf("{/* Controls"))
  // The row is baseline-aligned so its two glyphs can take the browser-computed cap-band correction
  // (half the glyph's box minus half the resolved cap height); the numbers behind it are in the
  // component's comments.
  assert.match(header, /<h2 className="-mx-5 -mt-1\.5 mb-4 flex items-baseline gap-2 border-b border-border\/60/)
  assert.match(header, /className="ml-auto flex shrink-0 items-baseline"/)
  assert.match(agentSource, /self-baseline|items-baseline/)
  assert.match(agentSource, /-mr-3 inline-flex size-5 shrink-0 translate-y-\[calc\(7px_-_0\.5cap\)\]/)
  assert.match(header, /<RepoLink nameWithOwner=\{status\.data\.nameWithOwner\} \/>/)
  assert.match(header, /\{GITHUB_PICKER_TITLE\}/)
  // The gear lives in the footer, right of the model chip as the composer's agent marks are
  // (maintainer 2026-11-07), and its panel opens upward and rightward off the modal's bottom-left corner.
  assert.doesNotMatch(header, /<GithubPromptPopover \/>/)
  const footer = pickerSource.slice(pickerSource.indexOf("{/* Footer"))
  assert.match(footer, /<\/PromptControlGroup>[\s\S]*?<div className=\{AGENT_MARKS\}>\s*<GithubPromptPopover \/>\s*<\/div>\s*<\/div>\s*<button\s+disabled=\{n === 0/)
  assert.match(promptPopoverSource, /<PopoverContent side="top" align="start"/)
  assert.match(promptPopoverSource, /className=\{`github-prompt-trigger \$\{SETTINGS_MARK\}`\}/)
  // The slug is no longer an em-dashed suffix of the title (the dash must be gone from the MARKUP;
  // the comments above it are prose and may carry one).
  assert.doesNotMatch(header.slice(header.indexOf("<h2")), /—/)
  const link = pickerSource.slice(pickerSource.indexOf("function RepoLink"), pickerSource.indexOf("function Segmented"))
  assert.match(link, /href=\{`https:\/\/github\.com\/\$\{nameWithOwner\}`\}/)
  assert.match(link, /target="_blank"/)
  assert.match(link, /<ArrowUpRight aria-hidden="true" className="-mx-\[0\.29em\] size-\[1em\] shrink-0 self-baseline translate-y-\[calc\(0\.5em_-_0\.5cap\)\]"/)
  // Text in the fg tone with the GitHub mark, and no box: a chip stacked on the sort control is what
  // the maintainer rejected (2026-11-09).
  assert.match(link, /<Github aria-hidden="true" className="mr-0\.5 size-\[13px\] shrink-0 self-baseline translate-y-\[calc\(6\.5px_-_0\.5cap\)\]"/)
  assert.match(link, /text-fg\/85/)
  assert.doesNotMatch(link, /\bborder\b|bg-panel-2/)
  assert.match(promptPopoverSource, /<Popover modal open=\{open\} onOpenChange=\{setOpen\}>/)
  assert.match(promptPopoverSource, /<GithubPromptEditor draft=\{draft\} onChange=\{update\} rows=\{14\} \/>/)
  // A prompt edit flushed by closing the popover is still in flight when the button is pressed.
  assert.match(pickerSource, /useIsMutating\(\{ mutationKey: \[\.\.\.SETTINGS_WRITE_KEY\] \}\)/)
  assert.match(readFileSync(new URL("./NewThreadModal.tsx", import.meta.url), "utf8"), /useIsMutating\(\{ mutationKey: \[\.\.\.SETTINGS_WRITE_KEY\] \}\)/)
})

test("notification recovery aligns with its control and keeps recovery instructions visible", () => {
  const denied = source.slice(source.indexOf("function NotifDeniedHelp"), source.indexOf("function hostOf"))
  assert.match(denied, /className="flex flex-col gap-1 text-\[11px\] text-muted-70"/)
  assert.doesNotMatch(denied, /pl-6/)
  assert.match(denied, /Notifications are blocked for this site/)
  assert.match(denied, /Paste this into a new tab, set Notifications/)
})

// The Density switch (Comfortable|Compact) only decided whether an Edit diff opened expanded, and an
// Edit card only appears once its folded tool row is opened — so it decided almost nothing. It was
// retired 2026-10-20 (maintainer: "it should just always be compact"); every diff opens collapsed.
test("there is no diff density setting — diffs always open collapsed", () => {
  assert.doesNotMatch(source, /label="(?:Density|Compact mode)"|DensityToggle|CompactToggle|compactDiffs/)
  assert.doesNotMatch(helpSource, /\bdensity:/)
  const diffBlock = readFileSync(new URL("./DiffBlock.tsx", import.meta.url), "utf8")
  assert.doesNotMatch(diffBlock, /prefs|compactDiffs/)
  assert.match(diffBlock, /const \[open, setOpen\] = useState\(false\)/)
})

// What the row DOES — the preference reaching <html>, surviving a reload and never touching the server —
// is pinned in a real browser by settingsAutosave.e2e.test.ts, and what the stylesheet then does to a
// block by lib/codeBlocks.e2e.test.ts. This guards the wiring those two depend on.
test("wrap code is an Off|On browser preference with its own explanation, mirrored onto the page at boot", () => {
  assert.match(source, /label="Wrap code" help=\{SETTINGS_HELP\.wrapCode\}/)
  const toggle = source.slice(source.indexOf("function WrapCodeToggle"), source.indexOf("function PermHint"))
  assert.match(toggle, /<OnOffToggle value=\{wrapCode\} onChange=\{\(on\) => \(prefs\.wrapCode = on\)\} \/>/)
  assert.match(helpSource, /\bwrapCode:/)
  // Client-only: it must not have grown a key in the server's settings draft.
  assert.doesNotMatch(source, /draft\.wrapCode/)
  const main = readFileSync(new URL("../main.tsx", import.meta.url), "utf8")
  assert.match(main, /import \{ initCodeWrap \} from "\.\/lib\/codeWrap\.ts"/)
  assert.match(main, /\n  initCodeWrap\(\)\n/)
})

test("help tooltip uses custom accessible, touch-capable paragraph layout", () => {
  // `&& !disabled` is the project rail's drag suppression: the pointer is necessarily inside the
  // square it is dragging, so a delayDuration-0 tooltip would open on grab and chase it down the
  // rail. It forces the tooltip SHUT without unmounting the trigger, which mid-drag would destroy
  // the element holding pointer capture. Hover behaviour is unchanged whenever nothing is dragging.
  assert.match(tooltipSource, /<RT\.Root open=\{open && !disabled\} onOpenChange=\{setOpen\}>/)
  assert.match(tooltipSource, /clickable = false/)
  assert.match(tooltipSource, /cloneElement\(clickableChild, \{ "aria-describedby": contentId \}\)/)
  assert.match(tooltipSource, /onClick=\{\(\) => setOpen\(\(wasOpen\) => !wasOpen\)\}/)
  assert.match(tooltipSource, /onKeyDown=\{onKeyDown\}/)
  assert.match(tooltipSource, /createPortal\(/)
  assert.match(tooltipSource, /collisionPadding=\{12\}/)
  assert.match(tooltipSource, /max-w-\[min\(22rem,calc\(100vw-1\.5rem\)\)\]/)
  assert.match(tooltipSource, /leading-relaxed/)
  // Wrapping and whitespace behavior are composed independently, so keep this
  // contract resilient to Tailwind class ordering and the computed mode value.
  assert.match(tooltipSource, /\bbreak-words\b/)
  assert.match(tooltipSource, /\$\{whitespace\}/)
  assert.match(tooltipSource, /\bwhitespace-normal\b/)
  assert.match(tooltipSource, /\bwhitespace-pre-line\b/)
  assert.doesNotMatch(tooltipSource, /title=/)
  assert.match(fieldSource, /<Tooltip label=\{help\} side="right" clickable>/)
  assert.match(fieldSource, /inline-flex size-4 items-center justify-center/)
  assert.doesNotMatch(source.slice(source.indexOf("function CopyableAddress")), /title="Copy address"/)
})
