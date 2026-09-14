import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const source = readFileSync(new URL("./SettingsDrawer.tsx", import.meta.url), "utf8")
const tooltipSource = readFileSync(new URL("./Tooltip.tsx", import.meta.url), "utf8")

test("settings maps each contextual explanation to a help control", () => {
  // `subagentInstructions` is gone: the settings preamble was retired in favour of FRIZZ.md, so there
  // is exactly one operator-authored surface for project conventions.
  for (const key of ["permissionMode", "font", "density", "notifications", "autoCompactWindow", "codexContextWindow"]) {
    assert.match(source, new RegExp(`\\b${key}:`), `missing settings help mapping: ${key}`)
  }
  assert.match(source, /label="Permissions" help=\{SETTINGS_HELP\.permissionMode\}/)
  // The two compaction-shaped dials live under their own vendor band and keep distinct names: a Claude
  // thread is launched at 1M and capped DOWN, a Codex thread is launched at its stock window and raised
  // UP, so "Compaction window" and "Context window" are different controls, never one shared setting.
  assert.match(source, /<DividerLabel label="Claude" \/>/)
  assert.match(source, /<DividerLabel label="Codex" \/>/)
  assert.match(source, /label="Compaction window" help=\{SETTINGS_HELP\.autoCompactWindow\}/)
  assert.match(source, /label="Context window" help=\{SETTINGS_HELP\.codexContextWindow\}/)
  // "Model default" stores NOTHING (the key is unset), so an untouched install sends codex no override.
  assert.match(source, /codexContextWindow: v === CODEX_CONTEXT_WINDOW_DEFAULT \? undefined : Number\(v\)/)
  assert.match(source, /label="Density" help=\{SETTINGS_HELP\.density\}/)
  assert.match(source, /label="Desktop notifications" help=\{SETTINGS_HELP\.notifications\}/)
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
  assert.match(source, /const \{ state: saveState, queue, flush \} = useAutosave\(\)/)
  assert.match(source, /onChange=\{\(e\) => onChange\(e\.target\.value === "" \? undefined : e\.target\.value, \{ debounce: true \}\)\}/)
  // Closing must not strand the keystrokes still sitting in the debounce.
  const close = source.slice(source.indexOf("function close()"), source.indexOf("async function toggleNotifications"))
  assert.match(close, /flush\(\)/)
  // Writes are serialized: a whole-object payload delivered out of order silently reverts settings.
  assert.match(source, /chain\.current = chain\.current\s*\n\s*\.then\(\(\) => rpc\.settingsSet\(next\)\)/)
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

test("the Claude permission control offers only the two headless-safe modes, with no caption under it", () => {
  // The select is fed the shared two-option set, not the full PermissionMode enum, and an out-of-range
  // stored value displays as the "auto" floor the server would actually dispatch with.
  assert.match(source, /options=\{CLAUDE_DISPATCH_PERMISSION_OPTIONS\}/)
  assert.match(source, /value=\{draft\.permissionMode === "bypassPermissions" \? "bypassPermissions" : "auto"\}/)
  // The bypass caption ("New Claude threads will run every command … without asking you first") is
  // gone: the help tooltip already says what bypass means, and the line under the control only
  // repeated it (maintainer 2026-09-11: "I really don't think we need the little explanatory caption").
  assert.doesNotMatch(source, /BypassHint/)
  assert.doesNotMatch(source, /without asking you first/)
  // The old "Permission is NOT a setting" note described the world before this control existed.
  assert.doesNotMatch(source, /Permission is NOT a setting/)
})

test("the Codex context window presets come from the catalogue, not a hand-typed ladder", () => {
  // The same query the composer uses, so the presets track codex's own catalogue refreshes.
  assert.match(source, /useQuery\(\{ queryKey: \["codexModels"\], queryFn: \(\) => rpc\.codexModels\(\) \}\)/)
  assert.match(source, /codexContextWindowOptions\(models\.data, stored\)/)
  // No round-number ladder survives in the Codex band: those were never numbers codex runs at. (The
  // Claude band's own ladder is a different contract — a CAP on a 1M launch — and keeps its 1M row.)
  const codex = source.slice(source.indexOf("function CodexSection"), source.indexOf("function PromptsSection"))
  assert.doesNotMatch(codex, /"400000"|"600000"|"800000"|"1000000"/)
})

test("notification recovery aligns with its control and keeps recovery instructions visible", () => {
  const denied = source.slice(source.indexOf("function NotifDeniedHelp"), source.indexOf("function hostOf"))
  assert.match(denied, /className="flex flex-col gap-1 text-\[11px\] text-muted-70"/)
  assert.doesNotMatch(denied, /pl-6/)
  assert.match(denied, /Notifications are blocked for this site/)
  assert.match(denied, /Paste this into a new tab, set Notifications/)
})

// The drawer opens on what every operator looks at — the interface — and anything that belongs to one
// runtime sits under a band naming it. Until 2026-08-24 the Claude permission picker was the FIRST
// field in the form, so the drawer led with one vendor's CLI (maintainer: "weird that the very first
// setting in the settings panel is Claude-specific").
test("the form leads with interface preferences and keeps the Claude field under its own band", () => {
  const form = source.slice(source.indexOf('className="flex-1 overflow-y-auto p-5'), source.indexOf("function SaveStatus"))
  const fields = [...form.matchAll(/<SettingsField label="([^"]+)"/g)].map((m) => m[1])
  assert.equal(fields[0], "Appearance")
  assert.equal(fields[1], "Font")
  assert.match(source, /Applies to this browser across all projects\. System follows the device appearance\./)
  assert.ok(!fields.includes("Permissions"), "the Claude field is not loose in the general list")
  // The band precedes its field, and the field's label no longer repeats the band's name.
  const claude = source.slice(source.indexOf("function ClaudeSection"), source.indexOf("function PromptsSection"))
  assert.ok(claude.indexOf('<DividerLabel label="Claude" />') < claude.indexOf('<SettingsField label="Permissions"'))
  assert.doesNotMatch(source, /label="Claude permissions"/)
  // The band comes after the general fields and before Prompts.
  assert.ok(form.indexOf("<ClaudeSection") > form.lastIndexOf("<SettingsField"))
  assert.ok(form.indexOf("<ClaudeSection") < form.indexOf("<PromptsSection"))
})

// "Compact mode" Off|On told the operator what Off was NOT. A density pair names both states.
test("diff density is a Comfortable|Compact pair, densest on the right, compact by default", () => {
  const toggle = source.slice(source.indexOf("function DensityToggle"), source.indexOf("function StickyMessageControl"))
  assert.match(toggle, /\{ v: false, label: "Comfortable" \},\s*\{ v: true, label: "Compact" \}/)
  assert.match(toggle, /prefs\.compactDiffs = o\.v/)
  assert.doesNotMatch(source, /label="Compact mode"/)
  assert.doesNotMatch(source, /function CompactToggle/)
})

test("Prompts uses one centered divider without a duplicate section rule", () => {
  const prompts = source.slice(source.indexOf("function PromptsSection"), source.indexOf("function DividerLabel"))
  assert.match(prompts, /<DividerLabel label="Prompts"/)
  assert.doesNotMatch(prompts, /border-t border-border/)
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
  assert.match(source, /<Tooltip label=\{help\} side="right" clickable>/)
  assert.match(source, /inline-flex size-4 items-center justify-center/)
  assert.doesNotMatch(source.slice(source.indexOf("function CopyableAddress")), /title="Copy address"/)
})
