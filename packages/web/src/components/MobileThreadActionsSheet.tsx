import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useSnapshot } from "valtio"
import { AlarmClock, Check, ChevronLeft, ChevronRight, Copy, ExternalLink, FileText, Loader2, Pencil, RefreshCw, RotateCcw, RotateCw } from "lucide-react"
import { SNOOZE_PROMPT_MAX, type ThreadLinkView, type ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { showToast, store, threadBySlug } from "../store.ts"
import type { BoardSnapshot } from "@frizz/shared"
import { displayTitle, futureSnoozedUntil, offersRetry } from "../groups.ts"
import { prefs } from "../lib/prefs.ts"
import {
  SNOOZE_PRESETS,
  formatSnoozeWake,
  localDateTimeInputValue,
  parseLocalSnooze,
  snoozePresetInstant,
  snoozePresetLabel,
  type SnoozePreset,
} from "../lib/snooze.ts"
import { threadLifecycleAvailability } from "../lib/threadLifecycle.ts"
import { aiRenameAvailability, manualThreadTitleSeed, THREAD_TITLE_MAX_LENGTH, threadTitleToCommit } from "../lib/threadTitle.ts"
import { copyTextToClipboard } from "../lib/clipboard.ts"
import { queueDestination } from "../lib/router.ts"
import { openLocalPath } from "../lib/local-file-links.ts"
import { retrySession } from "../lib/retrySession.ts"
import { restartWorker } from "../lib/restartWorker.ts"
import { useDevFrizzBuild } from "../lib/devBuild.ts"
import { offersRestartWorker } from "../lib/threadMaintenance.ts"
import { profileGridDisplayParts } from "../lib/profileGrid.ts"
import { contextLine, displayUrl, effortWord, isLoopbackUrl } from "../lib/mobileThread.ts"
import { useBackDismiss } from "../lib/backDismiss.ts"
import { MobileBottomSheet } from "./MobileBottomSheet.tsx"
import { GoalMark, PromptPanel } from "./RecurringPromptControl.tsx"
import { StateButton } from "./ThreadLifecycle.tsx"
import { useRemoteHost } from "../api/supervisorStatus.ts"

// THE PHONE'S ⋯ SHEET — everything a thread can do that is not the bottom bar's one verb.
//
// What the desktop keeps in two places — the header (its icon strip, the context reading, snooze and mark
// as done) and the prompt box's rail (the Goal) — is ONE list here (mockup v2 §4): Snooze, Goal, Files and links, a rule, then Rename, Copy link and the conditional
// recovery verbs. A row that does not apply to this thread is not drawn, rather than drawn disabled: a
// phone list has no room for things you cannot do.
//
// It is built to be opened from TWO places, which is why it takes a slug rather than a thread and owns
// its whole lifecycle: the thread page's ⋯ (MobileThreadHeader) today, and a long-press on a board row
// later. Neither caller needs a drawer underneath it.
//
//   <ThreadActionsSheet slug={t.id} onClose={() => setOpen(false)} />
//
// MOUNTED MEANS OPEN. The caller renders it while it wants the sheet and drops it in `onClose`. That is
// the shape the app's other phone sheets have, and it is what lets the sheet take its own history entry
// on mount (lib/backDismiss) — so a phone's Back closes the sheet before it closes anything else.
//
// Sub-views (the snooze presets, the Goal editor, the file list, rename) swap in place inside the one
// sheet, each with a ‹ back to the list. They are not separate history entries: Back from anywhere in
// the sheet closes the sheet.
export type ThreadActionsView = "actions" | "snooze" | "snooze-custom" | "goal" | "files" | "rename"

export interface ThreadActionsSheetProps {
  /** The thread the sheet acts on. */
  slug: string
  /** The sheet has closed — by Back, a scrim tap, Escape, or an action that finishes it. Unmount it. */
  onClose: () => void
  /** Mark as done landed. The thread page closes itself here; a board caller can leave it out. Runs
   *  after `onClose` and after the sheet's history entry is gone, so a navigation it starts replaces
   *  the right entry. */
  onArchived?: () => void
  /** Where the sheet opens. The board's long-press opens the list; a caller that wants one sub-view
   *  straight away (a "files" affordance, say) can name it. */
  initialView?: ThreadActionsView
}

export function ThreadActionsSheet({ slug, onClose, onArchived, initialView = "actions" }: ThreadActionsSheetProps) {
  const snap = useSnapshot(store)
  const thread = threadBySlug(snap.board as BoardSnapshot | null, slug)
  const [view, setView] = useState<ThreadActionsView>(initialView)
  const dismiss = useBackDismiss(onClose)
  // A thread that leaves the board while its sheet is up (archived elsewhere, another tab) has nothing
  // left to act on.
  useEffect(() => {
    if (snap.board && !thread) dismiss()
  }, [snap.board, thread, dismiss])
  if (!thread) return null
  const title = displayTitle(thread)
  return (
    <MobileBottomSheet title={`Thread actions: ${title}`} onRequestClose={() => dismiss()} dataAttr="data-thread-actions-sheet">
      {view === "actions" ? (
        <ActionsList thread={thread} title={title} setView={setView} dismiss={dismiss} onArchived={onArchived} />
      ) : view === "snooze" ? (
        <SnoozeView thread={thread} back={() => setView("actions")} custom={() => setView("snooze-custom")} dismiss={dismiss} />
      ) : view === "snooze-custom" ? (
        <CustomSnoozeView thread={thread} back={() => setView("snooze")} dismiss={dismiss} />
      ) : view === "goal" ? (
        <GoalView thread={thread} back={() => setView("actions")} />
      ) : view === "files" ? (
        <FilesView thread={thread} back={initialView === "files" ? undefined : () => setView("actions")} dismiss={dismiss} />
      ) : (
        <RenameView thread={thread} back={() => setView("actions")} dismiss={dismiss} />
      )}
    </MobileBottomSheet>
  )
}

// ── the list ──────────────────────────────────────────────────────────────────────────────────────

function ActionsList({ thread, title, setView, dismiss, onArchived }: {
  thread: ThreadView
  title: string
  setView: (view: ThreadActionsView) => void
  dismiss: (then?: () => void) => void
  onArchived?: () => void
}) {
  const queryClient = useQueryClient()
  const devBuild = useDevFrizzBuild()
  const snoozePreset = useSnapshot(prefs).snoozePreset
  const lifecycle = threadLifecycleAvailability(thread)
  const owned = thread.kind === "session" && thread.foreign !== true
  const snoozedUntil = futureSnoozedUntil(thread)
  const goalOn = thread.recurringPrompt?.stopHook === true || thread.recurringPrompt?.heartbeat === true || thread.recurringPrompt?.postCompaction === true
  const links = thread.links ?? []
  const running = thread.runtime === "running" || thread.runtime === "spawning"
  const retry = owned && offersRetry(thread)
  const restart = offersRestartWorker(thread, devBuild)
  const modelEffort = useModelEffortLabel(thread)
  const context = contextLine(thread.context)
  const foot = [context, modelEffort].filter(Boolean).join(" · ")

  const copyLink = () => {
    const href = new URL(queueDestination(`/thread/${encodeURIComponent(thread.id)}`), location.origin).href
    dismiss(() => {
      copyTextToClipboard(href)
        .then(() => showToast("Link copied"))
        .catch((error) => showToast(`Couldn’t copy: ${(error as Error).message.slice(0, 80)}`))
    })
  }

  return (
    <div data-thread-actions-list>
      <SheetTitle>{title}</SheetTitle>
      {lifecycle.snooze && (
        <ActionRow
          data="snooze"
          icon={<AlarmClock size={19} />}
          label="Snooze"
          value={snoozedUntil ? formatSnoozeWake(snoozedUntil) : snoozePresetLabel(snoozePreset)}
          chevron
          onClick={() => setView("snooze")}
        />
      )}
      {owned && (
        <ActionRow
          data="goal"
          icon={<GoalMark size={19} className={goalOn ? "text-attention-90" : undefined} />}
          label="Goal"
          value={goalOn ? "on" : "off"}
          chevron
          onClick={() => setView("goal")}
        />
      )}
      {links.length > 0 && (
        <ActionRow data="files" icon={<FileText size={19} />} label="Files and links" value={String(links.length)} chevron onClick={() => setView("files")} />
      )}
      {/* A RUNNING thread's Done lives here, not in the bottom bar: finishing a turn in flight is a
          decision with a dialog behind it (mockup v2, "Working"). Same button, same confirmation path
          as the desktop header's check — only the chrome is a row. */}
      {running && lifecycle.archive && (
        <StateButton
          thread={thread}
          iconSize={19}
          iconClassName="shrink-0 text-muted"
          onArchived={() => dismiss(onArchived)}
          className={`${ROW_CLASS} !gap-[14px] !font-normal`}
        />
      )}
      <div className="my-1 h-px bg-border" />
      {owned && <ActionRow data="rename" icon={<Pencil size={19} />} label="Rename" onClick={() => setView("rename")} />}
      <ActionRow data="copy-link" icon={<Copy size={19} />} label="Copy link" onClick={copyLink} />
      {retry && (
        <ActionRow data="retry" icon={<RotateCcw size={19} />} label="Retry" onClick={() => dismiss(() => void retrySession(queryClient, thread.id))} />
      )}
      {restart && (
        <ActionRow data="restart-worker" icon={<RefreshCw size={19} />} label="Restart worker" onClick={() => dismiss(() => void restartWorker(queryClient, thread.id))} />
      )}
      {foot && <div data-thread-actions-foot className="px-[18px] pt-2.5 text-[12.5px] leading-[17px] text-muted">{foot}</div>}
    </div>
  )
}

// ── snooze ────────────────────────────────────────────────────────────────────────────────────────

// The desktop header's snooze menu, as a list: the same presets, the same `setThreadSnooze` and the same
// toasts. Unlike that menu it keeps the phone's "Snooze length" preference: the preset picked here
// becomes the default the board's swipe uses, which is the one gesture with no menu to choose from.
function useSnoozeApply(thread: ThreadView, dismiss: (then?: () => void) => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  async function apply(until: string | null, prompt: string | null = null): Promise<void> {
    setBusy(true)
    setError("")
    try {
      await rpc.setThreadSnooze({ slug: thread.id, sessionId: thread.sessionId ?? "", until, prompt: until ? prompt : null })
      dismiss(() => showToast(until ? `${prompt ? "Bump scheduled" : "Snoozed"} · ${formatSnoozeWake(until)}` : "Snooze cleared"))
    } catch (err) {
      const message = err instanceof Error ? err.message : "Snooze failed"
      showToast(message.slice(0, 100))
      setError(message)
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, setError, apply }
}

function SnoozeView({ thread, back, custom, dismiss }: { thread: ThreadView; back: () => void; custom: () => void; dismiss: (then?: () => void) => void }) {
  const selected = useSnapshot(prefs).snoozePreset
  const snoozedUntil = futureSnoozedUntil(thread)
  const { busy, apply } = useSnoozeApply(thread, dismiss)
  const pick = (preset: SnoozePreset) => {
    prefs.snoozePreset = preset
    void apply(snoozePresetInstant(preset))
  }
  return (
    <div data-thread-actions-snooze>
      <SubTitle back={back}>Snooze</SubTitle>
      {snoozedUntil && <p className="px-[18px] pb-2 text-[13px] text-muted">Snoozed until {formatSnoozeWake(snoozedUntil).replace(/^(Today|Tomorrow)/, (d) => d.toLowerCase())}</p>}
      {SNOOZE_PRESETS.map((preset) => (
        <ActionRow
          key={preset.value}
          data={`snooze-${preset.value}`}
          disabled={busy}
          icon={<AlarmClock size={19} />}
          label={preset.label}
          value={preset.detail}
          trailing={preset.value === selected ? <Check size={16} className="text-fg/80" /> : <span className="w-4" />}
          onClick={() => pick(preset.value)}
        />
      ))}
      <div className="my-1 h-px bg-border" />
      <ActionRow data="snooze-custom" disabled={busy} icon={<Pencil size={19} />} label="Custom time & prompt…" chevron onClick={custom} />
      {snoozedUntil && <ActionRow data="snooze-wake" disabled={busy} icon={<RotateCcw size={19} />} label="Wake now" onClick={() => void apply(null)} />}
    </div>
  )
}

function CustomSnoozeView({ thread, back, dismiss }: { thread: ThreadView; back: () => void; dismiss: (then?: () => void) => void }) {
  const selected = useSnapshot(prefs).snoozePreset
  const snoozedUntil = futureSnoozedUntil(thread)
  const { busy, error, setError, apply } = useSnoozeApply(thread, dismiss)
  // Opens on the snooze already set, else on the selected preset — the desktop dialog's seed.
  const [value, setValue] = useState(() => localDateTimeInputValue(new Date(snoozedUntil ?? snoozePresetInstant(selected))))
  const [prompt, setPrompt] = useState(thread.snoozePrompt ?? "")
  const min = useMemo(() => localDateTimeInputValue(new Date(Date.now() + 60_000)), [])
  const timeId = useId()
  const promptId = useId()
  const submit = () => {
    const parsed = parseLocalSnooze(value)
    if (!parsed.ok) return setError(parsed.message)
    const text = prompt.trim()
    if (text.length > SNOOZE_PROMPT_MAX) return setError(`Prompt is too long (${text.length}/${SNOOZE_PROMPT_MAX})`)
    void apply(parsed.until, text || null)
  }
  return (
    <form data-thread-actions-snooze-custom className="flex flex-col" onSubmit={(event) => { event.preventDefault(); submit() }}>
      <SubTitle back={back}>Custom snooze</SubTitle>
      <div className="flex flex-col gap-2 px-[18px]">
        <label htmlFor={timeId} className="text-[13px] font-medium text-muted">Wake at this local time</label>
        {/* 16px: iOS zooms the page into any field set smaller. */}
        <input
          id={timeId}
          type="datetime-local"
          required
          min={min}
          value={value}
          onChange={(event) => { setValue(event.target.value); setError("") }}
          className="h-11 w-full rounded-lg border border-border bg-bg px-3 text-[16px] text-fg outline-none focus:border-border-strong"
        />
        <label htmlFor={promptId} className="mt-2 text-[13px] font-medium text-muted">
          Then send this prompt <span className="font-normal text-muted-70">(optional)</span>
        </label>
        <textarea
          id={promptId}
          data-1p-ignore
          rows={3}
          maxLength={SNOOZE_PROMPT_MAX}
          placeholder="e.g. Check whether CI went green and land it if so."
          value={prompt}
          onChange={(event) => { setPrompt(event.target.value); setError("") }}
          className="w-full resize-none rounded-lg border border-border bg-bg px-3 py-2 text-[16px] leading-[22px] text-fg outline-none placeholder:text-muted-50 focus:border-border-strong"
        />
        <p className="text-[12.5px] text-muted">
          {prompt.trim() ? "Frizz will resume this thread with the prompt at the wake time." : "Leave it empty to just bring the thread back to your queue."}
        </p>
        {error && <p role="alert" className="text-[13px] text-danger">{error}</p>}
        <button
          type="submit"
          disabled={busy}
          className="mt-1 flex h-[46px] items-center justify-center gap-2 rounded-xl bg-fg text-[15.5px] font-semibold text-bg outline-none disabled:opacity-45"
        >
          {busy && <Loader2 size={16} className="animate-spin" />}
          {prompt.trim() ? "Snooze and bump" : "Snooze"}
        </button>
      </div>
    </form>
  )
}

// ── goal ──────────────────────────────────────────────────────────────────────────────────────────

// The desktop's Goal panel, full width. Leaving this view — ‹, the scrim, Back — unmounts the panel,
// and the unmount is its save, exactly as dismissing the desktop popover is.
function GoalView({ thread, back }: { thread: ThreadView; back: () => void }) {
  return (
    <div data-thread-actions-goal>
      <SubTitle back={back}>Goal</SubTitle>
      {/* The panel is drawn at the desktop popover's 11–12px scale; the phone reads at 13–16. The fields go
          to 16px because iOS zooms the whole page into any field set smaller. */}
      <div className="px-[18px] text-[13.5px] leading-relaxed text-fg [&_input]:!text-[16px] [&_textarea]:!min-h-[6rem] [&_textarea]:!text-[16px] [&_textarea]:!leading-[22px]">
        <PromptPanel thread={thread} armed={thread.recurringPrompt} close={back} heading={false} />
      </div>
    </div>
  )
}

// ── files and links ───────────────────────────────────────────────────────────────────────────────

// Everything the worker registered for this thread (the rows ThreadLinks draws in the desktop's
// Files and Links panels, over the composer), newest first. A file opens in the reader; a link opens in a new tab — except a link to
// the machine Frizz runs on, which from a phone is the phone itself: it says so and opens nothing.
function FilesView({ thread, back, dismiss }: { thread: ThreadView; back?: () => void; dismiss: (then?: () => void) => void }) {
  const links = [...(thread.links ?? [])].reverse()
  return (
    <div data-thread-actions-files>
      {back ? (
        <SubTitle back={back} count={links.length}>Files and links</SubTitle>
      ) : (
        <SheetTitle count={links.length}>Files and links</SheetTitle>
      )}
      {links.length === 0 && <p className="px-[18px] pb-2 text-[14px] text-muted">Nothing registered yet.</p>}
      {links.map((link) => <LinkRow key={link.id} link={link} dismiss={dismiss} />)}
    </div>
  )
}

function LinkRow({ link, dismiss }: { link: ThreadLinkView; dismiss: (then?: () => void) => void }) {
  const isUrl = link.kind === "link"
  const loopback = isUrl && isLoopbackUrl(link.target)
  const projectDir = useSnapshot(store).board?.projectDir
  const second = isUrl ? (loopback ? `${displayUrl(link.target)} — not reachable from this phone` : displayUrl(link.target)) : displayPath(link.target, projectDir)
  const body = (
    <>
      <span className="flex h-[21px] w-[19px] shrink-0 items-center justify-center text-muted">
        {isUrl ? <ExternalLink size={19} /> : <FileText size={19} />}
      </span>
      <span className="min-w-0 flex-1">
        <span data-link-label className="block truncate text-[15.5px] leading-[21px] text-fg">{link.label}</span>
        <span data-link-destination className="block truncate text-[12.5px] leading-[17px] text-muted">{second}</span>
      </span>
      {!loopback && <ChevronRight size={15} className="shrink-0 self-center text-muted-70" />}
    </>
  )
  const cls = "flex min-h-[56px] w-full items-start gap-[14px] px-[18px] py-[9px] text-left outline-none focus-visible:bg-hover"
  if (loopback) return <div data-thread-link={link.id} data-link-unreachable title={link.target} className={cls}>{body}</div>
  if (isUrl) {
    return (
      <a data-thread-link={link.id} title={link.target} href={link.target} target="_blank" rel="noopener noreferrer" className={`${cls} active:bg-hover`} onClick={() => dismiss()}>
        {body}
      </a>
    )
  }
  return (
    <button type="button" data-thread-link={link.id} title={link.target} className={`${cls} active:bg-hover`} onClick={() => dismiss(() => openLocalPath(link.target))}>
      {body}
    </button>
  )
}

/** A registered file's second line: relative to the project when it is inside it (`plans/x.md`), else the
 *  last two segments (`…/scratch/notes.md`) — an absolute path truncated at the end loses exactly the
 *  file name, which is the part a reader identifies it by. The full path is the row's title. */
function displayPath(path: string, projectDir: string | undefined): string {
  if (projectDir && path.startsWith(`${projectDir.replace(/\/+$/, "")}/`)) return path.slice(projectDir.replace(/\/+$/, "").length + 1)
  const parts = path.split("/").filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : path
}

// ── rename ────────────────────────────────────────────────────────────────────────────────────────

// The header's click-to-type rename (ThreadTitle), as a field: the same seed, the same no-op rules for
// an empty or unchanged name, the same RPC and toasts. Claude's rename rides along where the header
// offers it on hover — a phone has no hover, so here it is a row.
function RenameView({ thread, back, dismiss }: { thread: ThreadView; back: () => void; dismiss: (then?: () => void) => void }) {
  const shown = displayTitle(thread)
  const [draft, setDraft] = useState(() => manualThreadTitleSeed(shown, thread.id))
  const input = useRef<HTMLInputElement>(null)
  const rename = useMutation({ mutationFn: (title: string) => rpc.renameThread({ slug: thread.id, title }) })
  const aiRename = useMutation({ mutationFn: () => rpc.aiRenameThread({ slug: thread.id }) })
  const ai = aiRenameAvailability(thread)
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.select()
    })
    return () => cancelAnimationFrame(frame)
  }, [])
  const commit = () => {
    const title = threadTitleToCommit(draft, shown)
    if (!title) return back()
    rename.mutate(title, {
      onSuccess: () => dismiss(() => showToast("Thread renamed")),
      onError: (error) => showToast(error instanceof Error ? error.message : "Could not rename thread"),
    })
  }
  return (
    <form data-thread-actions-rename onSubmit={(event) => { event.preventDefault(); commit() }}>
      <SubTitle back={back}>Rename</SubTitle>
      <div className="flex flex-col gap-3 px-[18px]">
        <input
          ref={input}
          aria-label="Thread title"
          value={draft}
          maxLength={THREAD_TITLE_MAX_LENGTH}
          onChange={(event) => setDraft(event.target.value)}
          // The sheet, not the drawer under it, owns this Escape (see ThreadSheet's data-claims-escape).
          data-claims-escape
          className="h-11 w-full rounded-lg border border-border bg-bg px-3 text-[16px] text-fg outline-none focus:border-border-strong"
        />
        <button
          type="submit"
          disabled={rename.isPending}
          className="flex h-[46px] items-center justify-center gap-2 rounded-xl bg-fg text-[15.5px] font-semibold text-bg outline-none disabled:opacity-45"
        >
          {rename.isPending && <Loader2 size={16} className="animate-spin" />}
          Save
        </button>
      </div>
      {ai.show && (
        <>
          <div className="mt-3 mb-1 h-px bg-border" />
          <ActionRow
            data="ai-rename"
            disabled={aiRename.isPending}
            icon={aiRename.isPending ? <Loader2 size={19} className="animate-spin" /> : <RotateCw size={19} />}
            label={aiRename.isPending ? "Claude is naming it…" : "Rename with Claude"}
            onClick={() => {
              if (!ai.enabled) return showToast(ai.label)
              aiRename.mutate(undefined, {
                onSuccess: ({ title }) => dismiss(() => showToast(`Renamed to “${title}”`)),
                onError: (error) => showToast(error instanceof Error ? error.message : "Could not rename with Claude", { duration: 7000 }),
              })
            }}
          />
        </>
      )}
    </form>
  )
}

// ── shared pieces ─────────────────────────────────────────────────────────────────────────────────

/** `Opus 5 · high` — the composer chip's reading, in running text. Reads the composer's own cached
 *  profile query, so it names the same edition the chip does (a running thread's actual model, via
 *  `runningModelLabel`, not whatever its family resolves to now). */
export function useModelEffortLabel(thread: ThreadView | undefined): string | null {
  const owned = Boolean(thread && !thread.foreign && thread.kind === "session")
  const remoteHost = useRemoteHost()
  const profiles = useQuery({
    queryKey: ["threadProfileOptions", thread?.id ?? ""],
    queryFn: () => rpc.threadProfileOptions({ slug: thread!.id }),
    enabled: owned && !remoteHost,
    staleTime: 5_000,
  })
  if (!thread) return null
  const model = thread.model?.trim()
  const effort = thread.effort?.trim()
  if (!model && !effort && !thread.runningModelLabel) return null
  const groups = [{ id: thread.backend ?? "claude", label: "", options: profiles.data?.options ?? [] }]
  const parts = profileGridDisplayParts(groups, { model, effort }, "", thread.runningModelLabel)
  const name = [parts.name, parts.edition].filter(Boolean).join(" ")
  return [name || null, effortWord(parts.effort)].filter(Boolean).join(" · ") || null
}

// Rows are the mockup's `.act`: 50px tall (a 44px target with air), an 18px inset, a 19px muted icon in
// a fixed column so every label starts on one line, the label at 15.5px, the value muted at the far end.
const ROW_CLASS = "flex min-h-[50px] w-full items-center gap-[14px] px-[18px] text-left text-[15.5px] leading-[21px] text-fg outline-none transition-colors active:bg-hover focus-visible:bg-hover disabled:opacity-45"

function ActionRow({ icon, label, value, chevron, trailing, onClick, disabled, data }: {
  icon: ReactNode
  label: string
  value?: string
  chevron?: boolean
  trailing?: ReactNode
  onClick: () => void
  disabled?: boolean
  data: string
}) {
  return (
    <button type="button" data-thread-action={data} disabled={disabled} onClick={onClick} className={ROW_CLASS}>
      <span aria-hidden className="flex w-[19px] shrink-0 items-center justify-center text-muted">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {(value || chevron || trailing) && (
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[14px] text-muted">
          {value}
          {chevron && <ChevronRight size={15} className="text-muted-70" />}
          {trailing}
        </span>
      )}
    </button>
  )
}

function SheetTitle({ children, count }: { children: ReactNode; count?: number }) {
  return (
    <div className="flex items-baseline gap-2 px-[18px] pb-2.5 pt-1">
      <span data-thread-actions-title className="min-w-0 flex-1 truncate text-[16px] font-semibold leading-[22px]">{children}</span>
      {count !== undefined && <span className="shrink-0 text-[12.5px] text-muted">{count}</span>}
    </div>
  )
}

function SubTitle({ children, back, count }: { children: ReactNode; back: () => void; count?: number }) {
  return (
    <div className="flex items-center gap-0.5 pb-1 pl-[6px] pr-[18px]">
      <button type="button" aria-label="Back" onClick={back} className="flex size-11 shrink-0 items-center justify-center rounded-full text-fg/85 outline-none active:bg-hover focus-visible:bg-hover">
        <ChevronLeft size={21} />
      </button>
      <span data-thread-actions-title className="min-w-0 flex-1 truncate text-[16px] font-semibold leading-[22px]">{children}</span>
      {count !== undefined && <span className="shrink-0 text-[12.5px] text-muted">{count}</span>}
    </div>
  )
}
