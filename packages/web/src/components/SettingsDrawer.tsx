import { useEffect, useMemo, useState, useSyncExternalStore } from "react"
import { useSnapshot } from "valtio"
import { ArrowLeft, Check, ChevronRight, Copy } from "lucide-react"
import { type Settings } from "@frizz/shared"
import { store, type ConnectionState } from "../store.ts"
import { copyTextToClipboard } from "../lib/clipboard.ts"
import { prefs } from "../lib/prefs.ts"
import { getThemeSnapshot, setThemePreference, subscribeTheme, type ThemePreference } from "../lib/theme.ts"
import { registerSettingsClose } from "../lib/overlays.ts"
import { SETTINGS_HELP } from "../lib/settingsHelp.ts"
import { SHEET_CLOSE_MS, SHEET_PANEL_CLASS, SHEET_SCRIM_CLASS, prefersReducedMotion } from "../lib/sheet.ts"
import { SaveStatus, useSettingsDraft, type SaveState } from "../hooks/useSettingsAutosave.tsx"
import { useIsMobile } from "../lib/mobile.ts"
import { SNOOZE_PRESETS, isSnoozePreset } from "../lib/snooze.ts"
import { useSupervisorStatus } from "../api/supervisorStatus.ts"
import { isRemoteSession } from "../api/signOut.ts"
import { QuotaMeters } from "./QuotaBar.tsx"
import { RestartFailureNotice, useUpdateRestart } from "./RestartFrizzButton.tsx"
import { SignOutThisDeviceRow } from "./SignOutThisDeviceRow.tsx"
import { GithubAccountField } from "./GithubAccountField.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"
import { Select } from "./ui/Select.tsx"
import { SettingsField } from "./SettingsField.tsx"
import { Z_MODAL } from "../lib/layers.ts"
import { ModalSurface } from "./ui/ModalSurface.tsx"

type NotifPerm = "default" | "granted" | "denied" | "unsupported"
function currentPerm(): NotifPerm {
  if (typeof Notification === "undefined") return "unsupported"
  return Notification.permission as NotifPerm
}

// The drawer holds ONLY what belongs to the machine and this browser — appearance, the rail, how local
// links open, code wrapping, queue order, notifications. Everything that belongs to a project or to one
// runtime is edited where it applies: a runtime's launch settings behind the gear on its band in the
// model picker (AgentSettingsPopover), the GitHub triage prompt behind the gear in the GitHub picker's
// header (GithubPromptPopover). A "Project settings" tab stood here for a few hours on 2026-09-19
// carrying that prompt a second time; the maintainer's call was that moving a setting to its context
// means it no longer lives here at all, so the tab strip went with it.
export function SettingsDrawer({ offerUpdate = false }: {
  /**
   * Show the phone page's "Update Frizz" row. Only the board passes it: an update is finished by
   * PageFrame's supervisor monitor and RestartOverlay (PageFrame.tsx), which the board and the full-screen
   * thread page stand in and the Projects page (`/`) does not, so the same row there would raise no
   * overlay and never reload onto the new version.
   */
  offerUpdate?: boolean
} = {}) {
  const { draft, update, saveState, flush } = useSettingsDraft()
  const isMobile = useIsMobile()
  const [perm, setPerm] = useState<NotifPerm>(currentPerm())

  // Enter/exit animation. `shown` drives the slide (mount → next frame flips it true → slides in;
  // close flips it false → slides out). App renders <SettingsDrawer> only while showSettings is true,
  // so we keep ourselves mounted through the exit by delaying the store write until the slide ends.
  const [shown, setShown] = useState(false)
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(true))
    return () => cancelAnimationFrame(id)
  }, [])

  // Let App's window-level Esc handler trigger THIS animated close (slide-out) rather than flipping the
  // store flag and unmounting instantly. `close` is a hoisted declaration, so referencing it here is safe.
  useEffect(() => {
    registerSettingsClose(close)
    return () => registerSettingsClose(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function close() {
    if (closing) return
    // Send whatever is still sitting in the debounce before the drawer goes away.
    flush()
    setClosing(true)
    setShown(false)
    window.setTimeout(() => (store.showSettings = false), prefersReducedMotion() ? 0 : SHEET_CLOSE_MS)
  }

  // Turning notifications on requests browser permission if not yet decided; we keep the toggle
  // truthful about the OS-level grant so a green checkbox can't imply notifications that won't fire.
  async function toggleNotifications(on: boolean) {
    if (!draft) return
    if (on && typeof Notification !== "undefined" && Notification.permission === "default") {
      const result = (await Notification.requestPermission()) as NotifPerm
      setPerm(result)
    }
    update({ ...draft, notifications: on })
  }

  if (isMobile) {
    return (
      <MobileSettingsPage
        shown={shown}
        onClose={close}
        saveState={saveState}
        notifications={draft ? draft.notifications : null}
        onNotifications={toggleNotifications}
        perm={perm}
        offerUpdate={offerUpdate}
      />
    )
  }

  return (
    // A real modal dialog, not just a panel that looks like one: assistive tech reads it as one, and it
    // sits in Radix's layer stack (ui/ModalSurface), so a thread drawer under it defers its Escape, its
    // pointer and its focus to Settings. Opened from ⌘K over a drawer, Escape closed the drawer instead.
    <ModalSurface
      label="Settings"
      // `text-sm`: the app frame's type (App.tsx), which a portal to <body> leaves behind.
      className={`${SHEET_SCRIM_CLASS} ${Z_MODAL} flex justify-end text-sm ${shown ? "opacity-100" : "opacity-0"}`}
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div
        data-settings-panel
        className={`${SHEET_PANEL_CLASS} w-[560px] max-w-[94vw] ${shown ? "translate-x-0" : "translate-x-full"}`}
      >
        <SheetHeader title="Settings" actions={<SaveStatus state={saveState} />} onClose={close} />

        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-6">
          {/* Browser appearance remains usable even while server settings are unavailable. */}
          <SettingsField label="Appearance" help={SETTINGS_HELP.appearance}>
            <AppearanceControl />
          </SettingsField>
          {!draft ? (
            <div className="text-[13px] text-muted">Loading server settings…</div>
          ) : (
            <>
            <SettingsField label="Project sidebar" help={SETTINGS_HELP.projectRail}>
              <OnOffToggle value={draft.projectRail} onChange={(projectRail) => update({ ...draft, projectRail })} />
            </SettingsField>

            {/* Client-only (localStorage, not server Settings): whether a long line of code wraps or
                scrolls its block. It never travels to the server, so it's wired straight to the prefs
                proxy rather than the draft. */}
            <SettingsField label="Wrap code" help={SETTINGS_HELP.wrapCode}>
              <WrapCodeToggle />
            </SettingsField>

            {/* Client-only (localStorage): whether the prompt box offers its own microphone. */}
            <SettingsField label="Dictation" help={SETTINGS_HELP.dictation}>
              <DictationToggle />
            </SettingsField>

            {/* Same segmented Off/On control as every other row (the old bare checkbox matched
                nothing else in the form). Off left, On right — switch convention. */}
            <SettingsField label="Desktop notifications" help={SETTINGS_HELP.notifications}>
              <OnOffToggle value={draft.notifications} onChange={toggleNotifications} />
              {draft.notifications && <PermHint perm={perm} />}
            </SettingsField>

            {/* Frizz's OWN GitHub sign-in (machine-wide, read-only) — not a server Settings value, so it
                reads and writes through its own RPCs rather than the draft. */}
            <SettingsField label="GitHub" help={SETTINGS_HELP.github}>
              <GithubAccountField />
            </SettingsField>

            {/* An experiment, so it sits below every preference an operator ordinarily adjusts and
                above only the one power-user knob. Off by default (Settings.childThreads). */}
            <SettingsField label="Child threads" help={SETTINGS_HELP.childThreads}>
              <OnOffToggle value={draft.childThreads} onChange={(childThreads) => update({ ...draft, childThreads })} />
            </SettingsField>

            {/* LAST, on purpose: which editor a vetted local path opens in is the one power-user
                knob in the drawer, so it sits below everything an ordinary operator adjusts. */}
            <SettingsField label="Local file links" help={SETTINGS_HELP.localFileOpener}>
              <Select
                variant="bordered"
                value={draft.localFileOpener ?? "system"}
                onValueChange={(v) => update({ ...draft, localFileOpener: v as Settings["localFileOpener"] })}
                options={[
                  { value: "system", label: "System default" },
                  { value: "cursor", label: "Cursor" },
                  { value: "vscode", label: "VS Code" },
                  { value: "finder", label: "Reveal in Finder" },
                  { value: "copy", label: "Copy path" },
                ]}
                indicatorPosition="right"
                ariaLabel="Local file link opener"
              />
            </SettingsField>
            </>
          )}
        </div>
      </div>
    </ModalSurface>
  )
}

// ── THE PHONE'S SETTINGS PAGE ────────────────────────────────────────────────────────────────────────
//
// Below the phone breakpoint Settings is a full page, not a sheet beside a board (phone design
// 2026-09-30, scratch/mobile-simplify/v2.html § 6). Two things differ from the desktop drawer, and each
// is the design's call:
//
//   · IT LEADS WITH THE READINGS. The board's ⋯ sheet used to carry the connection dot and the quota
//     chips; that sheet is gone and its gear opens this page, so the readings arrive here first — they
//     are what a phone opens Settings to check.
//   · IT HOLDS ONLY WHAT MEANS SOMETHING ON A PHONE. The project sidebar and local file
//     links are desktop-only rows and do not render here; the SERVER values behind them are untouched,
//     so the desktop reads exactly what it did. Snooze length is here instead: it sets the preset the
//     board's swipe and the ⋯ sheet use, and the phone has no other place to choose it.
//
// Plain full-width rows under section labels — no grouped-inset cards, no iOS chrome.
//
// ADDED 2026-10-08 (maintainer, on #52): "Update Frizz", as a row beside the `Frizz {version}` footer.
// The phone had no way to update at all; #52 proposed bringing back a ⋯ sheet on the board to hold it,
// and the maintainer kept the gear instead, with a dot on it when a new release line is out.

/** The live connection, in the words the board's ⋯ sheet used before this page took its reading over. */
const CONNECTION_WORD: Record<ConnectionState, { dot: string; word: string }> = {
  open: { dot: "bg-live", word: "Connected" },
  connecting: { dot: "bg-muted", word: "Connecting…" },
  closed: { dot: "bg-danger-fill", word: "Disconnected" },
}

const MOBILE_ROW = "flex min-h-[52px] items-center gap-3 border-b border-border/70 px-[18px] text-[15.5px] text-fg"

function MobileSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="m-0 px-[18px] pb-1.5 pt-[18px] text-[12.5px] font-semibold leading-[17px] text-muted">{label}</h2>
      <div className="border-t border-border/70">{children}</div>
    </section>
  )
}

/**
 * A row whose value opens the phone's own picker: the row shows the value and a chevron, and an
 * invisible native `<select>` covers the whole row, so a tap anywhere on it raises the platform's
 * wheel or list — the control a phone already knows how to drive.
 */
function MobilePickerRow<V extends string>({
  label,
  value,
  options,
  onChange,
  data,
}: {
  label: string
  value: V
  options: readonly { value: V; label: string }[]
  onChange: (value: V) => void
  data: string
}) {
  const shown = options.find((o) => o.value === value)?.label ?? value
  return (
    <label data-mobile-setting={data} className={`${MOBILE_ROW} relative`}>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="flex shrink-0 items-center gap-1 text-[14px] text-muted">
        {shown}
        {/* Ink, not box: the chevron paints 6 of its 15 box px, centred. -mr-[5px] lands its ink on the
            row's 18px inset, the same right edge the theme segments and the switch draw to, and
            -ml-[3px] leaves ~6px of ink after the value (measured 9.6 → 6.6 and 23.6 → 18.6 from the
            row's edge, sans, 2026-09-30). */}
        <ChevronRight size={15} aria-hidden className="-ml-[3px] -mr-[5px]" />
      </span>
      <select
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value as V)}
        className="absolute inset-0 cursor-pointer appearance-none opacity-0"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  )
}

/** Theme as three joined segments. Each segment is 30px of ink with a 44px hit area around it. */
function MobileThemeSegments() {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeSnapshot)
  const options: { value: ThemePreference; label: string }[] = [
    { value: "system", label: "System" },
    { value: "dark", label: "Dark" },
    { value: "light", label: "Light" },
  ]
  return (
    <div role="radiogroup" aria-label="Theme" className="flex shrink-0 rounded-[9px] border border-border-strong">
      {options.map((o, i) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={theme.preference === o.value}
          onClick={() => setThemePreference(o.value)}
          className={`relative h-[30px] px-[11px] text-[13px] after:absolute after:inset-x-0 after:-inset-y-[7px] after:content-[''] ${
            i > 0 ? "border-l border-border-strong" : ""
          } ${i === 0 ? "rounded-l-[8px]" : ""} ${i === options.length - 1 ? "rounded-r-[8px]" : ""} ${
            theme.preference === o.value ? "bg-fg text-bg" : "text-muted"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** On/off as a switch: 40×24 of ink, the row's full height to hit. */
function MobileSwitch({ checked, disabled, label, onChange }: { checked: boolean; disabled?: boolean; label: string; onChange: (on: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-10 shrink-0 rounded-full after:absolute after:-inset-x-2 after:-inset-y-[10px] after:content-[''] disabled:opacity-45 ${checked ? "bg-fg" : "bg-border-strong"}`}
    >
      <span className={`absolute top-[3px] size-[18px] rounded-full ${checked ? "right-[3px] bg-bg" : "left-[3px] bg-muted"}`} />
    </button>
  )
}

function MobileSettingsPage({
  shown,
  onClose,
  saveState,
  notifications,
  onNotifications,
  perm,
  offerUpdate,
}: {
  shown: boolean
  onClose: () => void
  saveState: SaveState
  /** Null while the server settings are still loading — the switch waits rather than guessing. */
  notifications: boolean | null
  onNotifications: (on: boolean) => void
  perm: NotifPerm
  offerUpdate: boolean
}) {
  const { connection } = useSnapshot(store)
  const { queueOrder, snoozePreset } = useSnapshot(prefs)
  const conn = CONNECTION_WORD[connection]
  const supervisor = useSupervisorStatus()
  const version = supervisor.data?.version
  return (
    <ModalSurface
      data-mobile-settings-page
      // A modal dialog in Radix's layer stack for the same reasons as the desktop sheet (see
      // SettingsDrawer). On the phone it matters more: a thread drawer there is a MODAL Radix layer, so a
      // page outside that stack would draw over it and take no tap.
      label="Settings"
      className={`fixed inset-0 ${Z_MODAL} flex flex-col bg-bg text-sm pt-[env(safe-area-inset-top)] transition-transform duration-200 ease-out motion-reduce:transition-none ${
        shown ? "translate-x-0" : "translate-x-full"
      }`}
    >
      <header className="flex h-[56px] shrink-0 items-center gap-0.5 border-b border-border/70 pl-0.5 pr-[18px]">
        <button
          aria-label="Back"
          onClick={onClose}
          className="flex size-[44px] shrink-0 items-center justify-center rounded-full text-fg/85 active:bg-hover-strong"
        >
          <ArrowLeft size={21} strokeWidth={2.1} />
        </button>
        <h1 className="m-0 min-w-0 flex-1 truncate pl-0.5 text-[16.5px] font-semibold tracking-[-0.01em] text-fg">Settings</h1>
        <SaveStatus state={saveState} />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
        <div data-mobile-connection className="flex items-center gap-2 px-[18px] pb-1 pt-[14px] text-[14px] leading-[20px] text-fg">
          <span aria-hidden className={`size-2 shrink-0 rounded-full ${conn.dot}`} />
          <span className="min-w-0 truncate">
            {conn.word}
            {connection === "open" ? ` · ${location.host}` : null}
          </span>
        </div>
        <div className="px-[18px] pb-1 pt-2.5">
          <QuotaMeters />
        </div>

        <MobileSection label="Appearance">
          <div className={MOBILE_ROW}>
            <span className="min-w-0 flex-1 truncate">Theme</span>
            <MobileThemeSegments />
          </div>
        </MobileSection>

        <MobileSection label="Queue">
          <MobilePickerRow
            data="queue-order"
            label="Order"
            value={queueOrder}
            options={[
              { value: "fifo", label: "Oldest first" },
              { value: "lifo", label: "Newest first" },
            ]}
            onChange={(v) => (prefs.queueOrder = v)}
          />
          <MobilePickerRow
            data="snooze-length"
            label="Snooze length"
            value={snoozePreset}
            options={SNOOZE_PRESETS.map((p) => ({ value: p.value, label: p.kind === "calendar" ? `Until ${p.label}, ${p.detail}` : p.label }))}
            onChange={(v) => {
              if (isSnoozePreset(v)) prefs.snoozePreset = v
            }}
          />
          <div className={MOBILE_ROW}>
            <span className="min-w-0 flex-1 truncate">Notifications</span>
            <MobileSwitch
              label="Notifications"
              checked={notifications === true}
              disabled={notifications === null}
              onChange={onNotifications}
            />
          </div>
          {notifications ? (
            <div className="border-b border-border/70 px-[18px] py-2.5">
              <PermHint perm={perm} />
            </div>
          ) : null}
        </MobileSection>

        {/* THIS DEVICE — only on a tab that holds a remote session. The row itself renders nothing on the
            operator's own loopback tab, so the heading has to follow the same rule or it would label an
            empty section. Not a MobileSection: the row draws its own top and bottom rules. */}
        {isRemoteSession(supervisor.data) ? (
          <section>
            <h2 className="m-0 px-[18px] pb-1.5 pt-[18px] text-[12.5px] font-semibold leading-[17px] text-muted">This device</h2>
            <SignOutThisDeviceRow />
          </section>
        ) : null}

        {offerUpdate ? <MobileUpdateRow /> : null}

        {version ? (
          <div data-mobile-version className="px-[18px] py-[14px] text-[12.5px] text-faint">Frizz {version}</div>
        ) : null}
      </div>
    </ModalSurface>
  )
}

/**
 * The phone's update verb: the desktop status row's button as a Settings row (same hook, same request,
 * same blocking overlay). The label says what a tap does, the right column names the step it installs
 * (`0.13.8 → 0.14.0`, the desktop popover's line), and a dot rides the label whenever a newer version
 * has been OBSERVED — a patch included, unlike the board gear's dot, which the desktop badge rule keeps
 * to a new release line (`isBadgeRelease`). Inside Settings the dot only says which row is the news.
 * frizz-dev rebuilds from source and names no version, so its row is live but undotted.
 *
 * Up to date, it stays as a muted, inert "Frizz is up to date", the desktop's grey state; the version
 * itself is the footer under it. A rejected request leaves its failure card inline under the row,
 * dismissible, rather than anchored to a button the phone does not have.
 */
export function MobileUpdateRow() {
  const control = useUpdateRestart()
  if (!control.visible) return null
  const label = control.busy
    ? control.update ? "Updating…" : "Restarting…"
    : control.current ? "Frizz is up to date" : control.update ? "Update Frizz" : "Restart Frizz"
  const newer = control.update ? control.updateVersion : undefined
  return (
    <div data-mobile-update>
      <MobileSection label="Version">
        <button
          type="button"
          data-mobile-update-row
          disabled={control.busy || control.current}
          aria-busy={control.busy || undefined}
          onClick={() => void control.run()}
          // Muted, not faded, when inert: opacity would fade the row's rule with its words.
          className={`${MOBILE_ROW} w-full text-left active:bg-hover disabled:text-muted`}
        >
          <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
            <span className="truncate">{label}</span>
            {newer && !control.busy ? (
              <span data-mobile-update-row-notification aria-hidden className={UPDATE_DOT} />
            ) : null}
          </span>
          {newer && control.version ? (
            <span data-mobile-update-step className="shrink-0 text-[14px] tabular-nums text-muted">
              {control.version} → {newer}
            </span>
          ) : null}
        </button>
      </MobileSection>
      {control.shownError ? (
        <RestartFailureNotice mobile update={control.update} message={control.shownError} outcome={control.outcome} onDismiss={control.dismiss} />
      ) : null}
    </div>
  )
}

// The row's dot: the board gear's 5px dot (MobileBoard.tsx GEAR_DOT), so the two read as one mark.
// It sits on the label's CAP BAND, not its line box: an empty flex item's baseline is its bottom edge,
// so `self-baseline` puts that edge on the text baseline, and the translate lifts the dot by half the
// resolved cap height less its own radius — centred on the capitals in any font, at any size. The
// 6px box gap draws ~6.8px of ink after the label's last letter (sans, 15.5px, 2026-10-08).
const UPDATE_DOT = "size-[5px] shrink-0 self-baseline translate-y-[calc(2.5px_-_0.5cap)] rounded-full bg-accent"

function AppearanceControl() {
  const theme = useSyncExternalStore(subscribeTheme, getThemeSnapshot, getThemeSnapshot)
  return (
    <Select
      variant="bordered"
      value={theme.preference}
      onValueChange={(value) => setThemePreference(value as ThemePreference)}
      options={[{ value: "system", label: "System" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
      indicatorPosition="right"
      ariaLabel="Appearance"
    />
  )
}

// The ONE boolean control shape for the whole form: a segmented Off|On pair, Off always on the LEFT
// (switch convention — right = on). Active segments use the primary button treatment.
function OnOffToggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  const opts: { v: boolean; label: string }[] = [
    { v: false, label: "Off" },
    { v: true, label: "On" },
  ]
  return (
    <div className="inline-flex w-fit rounded-md border border-border bg-bg p-0.5">
      {opts.map((o) => (
        <button
          key={o.label}
          onClick={() => onChange(o.v)}
          aria-pressed={value === o.v}
          className={`rounded px-3 py-1 text-[12px] transition-colors ${
            value === o.v ? "bg-fg text-bg" : "text-muted hover:text-fg"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// The prompt box's microphone: client-only (localStorage prefs proxy), applies live — every composer on
// the page drops or regains its button the instant it flips (lib/dictation.ts reads it as `enabled`).
function DictationToggle() {
  const { dictation } = useSnapshot(prefs)
  return <OnOffToggle value={dictation} onChange={(on) => (prefs.dictation = on)} />
}

// Long lines of code: client-only (localStorage prefs proxy), applies live — lib/codeWrap.ts mirrors it
// onto <html>, and the stylesheet re-flows every code block and Edit diff already on the page.
function WrapCodeToggle() {
  const { wrapCode } = useSnapshot(prefs)
  return <OnOffToggle value={wrapCode} onChange={(on) => (prefs.wrapCode = on)} />
}

// Quiet, small permission-state line under the notifications toggle. Everything is muted (the old
// loud-red denied line read as an error); the denied state additionally offers a recovery assist,
// since a page can't re-prompt once denied.
function PermHint({ perm }: { perm: NotifPerm }) {
  if (perm === "denied") return <NotifDeniedHelp />
  const text: Record<Exclude<NotifPerm, "denied">, string> = {
    granted: "Browser permission granted — notifications fire when the window is hidden.",
    default: "Browser permission not yet granted — notifications won't fire until you allow them.",
    unsupported: "This browser does not support desktop notifications.",
  }
  return <span className="text-[11px] text-muted-70">{text[perm]}</span>
}

type Browser = "chrome" | "edge" | "safari" | "firefox" | "other"
function detectBrowser(): Browser {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : ""
  if (/Firefox\//.test(ua)) return "firefox"
  if (/Edg\//.test(ua)) return "edge"
  if (/OPR\/|Brave\//.test(ua)) return "other"
  if (/Chrome\//.test(ua)) return "chrome"
  if (/Safari\//.test(ua)) return "safari"
  return "other"
}

// Once a site's notification permission is DENIED, the page can no longer meaningfully re-invoke
// requestPermission, and chrome://about: URLs can't be opened from a web page — so no real deep link
// exists. Best UX: browser-specific one-line instructions, plus (Chromium) the exact site-settings
// address as selectable + copyable mono text. Muted + small; only shown in the denied state.
function NotifDeniedHelp() {
  const browser = useMemo(detectBrowser, [])
  const origin = typeof location !== "undefined" ? location.origin : ""
  const chromiumUrl = `${browser === "edge" ? "edge" : "chrome"}://settings/content/siteDetails?site=${encodeURIComponent(origin)}`

  return (
    <div className="flex flex-col gap-1 text-[11px] text-muted-70">
      <span>Notifications are blocked for this site. Re-enable them in your browser, then reload.</span>
      {browser === "chrome" || browser === "edge" ? (
        <CopyableAddress url={chromiumUrl} hint="Paste this into a new tab, set Notifications → Allow:" />
      ) : browser === "safari" ? (
        <span>Safari → Settings → Websites → Notifications → allow {hostOf(origin)}, then reload.</span>
      ) : browser === "firefox" ? (
        <span>Firefox → Settings → Privacy &amp; Security → Permissions → Notifications → Settings → allow this site.</span>
      ) : (
        <span>Open this site's notification permission in your browser's settings and set it to Allow.</span>
      )}
    </div>
  )
}

function hostOf(origin: string) {
  try {
    return new URL(origin).host
  } catch {
    return origin
  }
}

function CopyableAddress({ url, hint }: { url: string; hint: string }) {
  const [copied, setCopied] = useState(false)
  async function copy() {
    try {
      await copyTextToClipboard(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    } catch {
      /* clipboard blocked — the address is still selectable inline */
    }
  }
  return (
    <span className="flex w-full flex-col gap-1">
      <span>{hint}</span>
      <span className="flex min-w-0 items-center gap-1.5">
        <code className="min-w-0 flex-1 font-mono-keep select-all rounded border border-border bg-bg px-1.5 py-0.5 text-[10.5px] text-fg/90 break-all">
          {url}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy address"
          className="shrink-0 rounded border border-border p-1 text-muted hover:bg-panel-2 hover:text-fg transition-colors"
        >
          {copied ? <Check size={11} className="text-live" /> : <Copy size={11} />}
        </button>
      </span>
    </span>
  )
}
