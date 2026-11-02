import * as RadixDialog from "@radix-ui/react-dialog"
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useIsMutating, useMutation, useQuery } from "@tanstack/react-query"
import { acpModelSlug, type AccountBackend, type DispatchInput, type McpTarget } from "@frizz/shared"
import { rpc, rpcFor } from "../api/rpc.ts"
import { showToast, store } from "../store.ts"
import { Composer } from "./Composer.tsx"
import { McpPlug } from "./McpPlug.tsx"
import { GithubTrigger, useGithubTriggerVisible } from "./GithubTrigger.tsx"
import { ProfileGridSelector } from "./ProfileGridSelector.tsx"
import { SETTINGS_WRITE_KEY } from "../hooks/useSettingsAutosave.tsx"
import { AcpModelSelect } from "./AcpModelSelect.tsx"
import { LogoutConfirmModal, SignInModal } from "./SignInModal.tsx"
import { dispatchProfileGroups } from "../lib/dispatchPreferences.ts"
import { useDispatchProfile } from "../hooks/useDispatchProfile.ts"
import { handleDialogEscape } from "../lib/selectOverlay.ts"
import { draftKey, draftStore, useDraft, useProjectDir } from "../lib/drafts.ts"
import { parseAccountAlias } from "../lib/signIn.ts"
import { PROMPT_CONTROL_TYPOGRAPHY_CLASS } from "../lib/promptControlTypography.ts"
import { useIsMobile } from "../lib/mobile.ts"
import { useBoard } from "../hooks.ts"
import { projectIdentity } from "./Sidebar.tsx"
import { X } from "lucide-react"
import { isConsolePath } from "../lib/base-path.ts"
import { ProjectScope, useProjectScope } from "../lib/projectScope.tsx"
import { beginDispatch, dispatchAnswered, dispatchFailed } from "../lib/pendingDispatch.ts"
import { useConsoleDispatchTarget } from "./ConsoleProjectChip.tsx"
import { Z_DIALOG, Z_MODAL } from "../lib/layers.ts"

// THE dispatch prompt box — composer + quiet selects row — shared by every surface that can start a
// thread: the queue's inline section and the anywhere-modal. There is no title field — the server
// derives a fallback and Claude names the session itself (ai-title), which the UI prefers for display.
//
// The form's STATE and its dispatch live in useDispatchForm, so the phone's full-screen new-thread page
// (PhoneNewThreadPage, below) runs the identical drafts, profile, sign-in gate, errors and pending
// preview — only the layout around them differs.
function useDispatchForm(onDispatched?: () => void, projectPicker?: ReactNode) {
  // The one durable new-thread profile, shared with the GitHub picker's own selector.
  const { resolved, codexList, claudeList, acpList, loadError: profileLoadError, saveProfile } = useDispatchProfile()
  // A settings write still in flight — a compaction window picked in the model picker a moment ago —
  // must land before a dispatch that would read it.
  const savingSettings = useIsMutating({ mutationKey: [...SETTINGS_WRITE_KEY] }) > 0
  // Gate the leftAction slot itself, not just the icon: Composer reserves rail space whenever the
  // prop is set, so a hidden GithubTrigger must mean NO prop — not a null-rendering element.
  const githubTriggerVisible = useGithubTriggerVisible()
  // On the Console the prompt box is pointed at a project by its chip (ConsoleSidebar.tsx), and the
  // dispatch goes to that project. Its draft is the Console's own: the words stay put while the chip moves.
  const project = useProjectScope()
  const projectDir = useProjectDir()
  const promptKey = draftKey.dispatch(isConsolePath() ? "@console" : projectDir)
  // Queue and modal are the same semantic new-thread composer.
  const [prompt, setPrompt, clearPrompt] = useDraft(promptKey)
  const submittedDraftRef = useRef("")
  const [pendingDispatch, setPendingDispatch] = useState<string | null>(null)

  // Per-provider LOCAL credential presence, polled so the submit gate has a fresh value without a
  // round-trip on every keystroke. The gate blocks ONLY on a positive "signed-out" (fails open on
  // "unknown"/loading/error), so a stale or missing snapshot can never trap a logged-in user.
  const authStatus = useQuery({ queryKey: ["authStatus"], queryFn: () => rpc.authStatus(), staleTime: 30_000 })
  // When submit is gated, the built dispatch is stashed here and the sign-in modal opens for this
  // backend; a successful re-check runs the stashed dispatch unchanged.
  const [signInFor, setSignInFor] = useState<AccountBackend | null>(null)
  const [logoutFor, setLogoutFor] = useState<AccountBackend | null>(null)
  const gatedInputRef = useRef<DispatchInput | null>(null)

  // Dispatch does NOT navigate anywhere: you stay on the queue, the new thread appears in the
  // sidebar, and the toast walks through the lifecycle — an immediate spinner while the server
  // waits out session startup, then a link that opens the thread in the side drawer.
  const dispatch = useMutation({
    mutationFn: (input: DispatchInput) => rpcFor(project).dispatch(input),
    onMutate: (input) => {
      showToast("Starting thread…", { spinner: true, sticky: true })
      // Told to the rail too, which draws the thread as the Running row it is about to become
      // (lib/pendingDispatch). The board's ids are read as they stand at the click, not subscribed to.
      return { pendingKey: beginDispatch({ project, backend: input.backend ?? "claude", model: input.model ?? "" }, new Set((store.board?.threads ?? []).map((t) => t.id))) }
    },
    onSuccess: (res, _input, context) => {
      if (context) dispatchAnswered(context.pendingKey, res.slug)
      // The board stream now owns the durable thread row. Drop our local bridge as soon as the
      // server acknowledges it, preventing an optimistic card + server card duplicate.
      setPendingDispatch(null)
      onDispatched?.()
      showToast("Thread started", { link: { label: "Open thread", slug: res.slug } })
    },
    onError: (e, input, context) => {
      if (context) dispatchFailed(context.pendingKey)
      // A submit clears before the RPC starts. Restore only into a still-empty field so retry is
      // effortless without overwriting text typed during the failed request.
      if (!draftStore.get(promptKey)) setPrompt(submittedDraftRef.current || input.prompt)
      setPendingDispatch(null)
      // Server-side auth preflight rejection (the client gate can miss on a stale snapshot): open the
      // same sign-in modal with the dispatch stashed, instead of a dead-end failure toast. The server
      // created no thread state, and the draft was restored above.
      const auth = /^AUTH_REQUIRED:(claude|codex)$/.exec((e as Error).message)
      if (auth) {
        gatedInputRef.current = input
        setSignInFor(auth[1] as AccountBackend)
        showToast(`Signed out of ${auth[1] === "claude" ? "Claude" : "Codex"}`, { duration: 3000 })
        return
      }
      showToast(`Dispatch failed: ${(e as Error).message.slice(0, 80)}`)
    },
  })

  // Fire the dispatch and do the one-shot UI bookkeeping (optimistic toast + prompt clear). Called both
  // on a clean submit and after the sign-in gate is cleared, so the prompt is only cleared once the
  // thread is actually being started — a gated submit leaves the draft intact.
  function runDispatch(input: DispatchInput) {
    submittedDraftRef.current = prompt
    clearPrompt()
    setPendingDispatch(input.prompt)
    dispatch.mutate(input)
  }

  function submit() {
    if (!prompt.trim() || !resolved || savingSettings) return
    // `/login` and `/logout` are frizz-owned aliases for the typed provider account actions — they
    // invoke the sign-in / sign-out flow for the SELECTED backend and never become prompt text.
    const alias = parseAccountAlias(prompt)
    if (alias) {
      clearPrompt()
      if (resolved.backend === "acp") {
        showToast("An ACP agent signs in through its own CLI — Frizz holds no account for it")
        return
      }
      if (alias === "login") {
        gatedInputRef.current = null // nothing to dispatch after sign-in — this is a pure account action
        setSignInFor(resolved.backend)
      } else {
        setLogoutFor(resolved.backend)
      }
      return
    }
    if (!resolved.modelAvailable) {
      showToast("Saved model is unavailable — choose a model before starting the thread")
      return
    }
    if (!resolved.effortAvailable) {
      showToast("Saved reasoning level is unavailable for this model — choose another level")
      return
    }
    const input: DispatchInput = {
      prompt: prompt.trim(),
      // No permissionMode: the server stamps every created worker itself (workerDispatchPermission —
      // the non-interactive floor, raised to bypass only when Settings asks). Dispatch offers no
      // per-thread permission choice; the "Permissions" control behind the Claude Code gear in the model
      // picker (AgentSettingsPopover) owns the default.
      model: resolved.model,
      backend: resolved.backend,
      // An ACP profile resolves to effort "" (no effort axis); the RPC's enum takes that as ABSENT.
      // Sending "" failed every ACP dispatch from the composer with "Invalid enum value" (2026-09-16).
      effort: (resolved.effort || undefined) as DispatchInput["effort"],
    }
    // Auth gate: block ONLY on a positive "signed-out" for this dispatch's backend. Loading/unknown/
    // authed all fall through (fail open) so a flaky or slow read never blocks a logged-in user. An ACP
    // agent has no account here at all — its own CLI reports a missing login on the first prompt.
    if (resolved.backend !== "acp" && authStatus.data?.[resolved.backend] === "signed-out") {
      gatedInputRef.current = input
      setSignInFor(resolved.backend)
      return
    }
    runDispatch(input)
  }

  // The profile readout lives INSIDE the box, along its bottom edge — petite caps, very quiet.
  // Not a dropdown at rest: a plain value; hover materializes the border, click opens the menu.
  // There is no permission control: dispatch permission is fixed server-side.
  //
  // useMemo (measured in the render-perf profile): the footer used to be rebuilt inline on every
  // render, so each prompt KEYSTROKE re-rendered every picker tree — ~222 component renders per
  // keystroke. A keystroke only changes `prompt`; keeping the footer element's identity stable lets
  // React bail out of the whole control subtree, and the
  // element is rebuilt exactly when durable preference data or the model catalogue changes.
  const footer = useMemo(() => {
    if (!resolved) {
      return (
        <ProfileGridSelector
          groups={[]}
          value={undefined}
          onValueChange={() => {}}
          placeholder={profileLoadError ? "Profile unavailable" : "Profile loading…"}
          ariaLabel="Model and effort loading"
          disabled
        />
      )
    }
    const profileGroups = dispatchProfileGroups(codexList, acpList, claudeList)
    const acpAgent = resolved.acpAgentId ? acpList.find((agent) => agent.id === resolved.acpAgentId) : undefined
    return (
      // gap-x-1.5 between the two pills, the same measured gap the thread composer's strip uses
      // (useThreadComposerControls): two bordered pills on `gap-x-1` read as one segmented control.
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5">
        {projectPicker}
        <ProfileGridSelector
          groups={profileGroups}
          agentSettings
          // `pickerModel`, not `model`: an ACP row is keyed on the bare agent slug; the model inside
          // the agent is the dropdown's, below.
          value={{ provider: resolved.backend, model: resolved.pickerModel, effort: resolved.effort }}
          onValueChange={(selection) => saveProfile({
            field: "profile",
            backend: selection.provider as typeof resolved.backend,
            model: selection.model,
            // An ACP row has no effort cell, so its selection carries "" — stored as absent.
            effort: (selection.effort || undefined) as DispatchInput["effort"],
          })}
          ariaLabel="Model and effort"
          title={resolved.modelAvailable && resolved.effortAvailable
            ? "Model and reasoning effort"
            : "Saved model or reasoning effort unavailable — choose a supported pair"}
          className="max-w-[min(21rem,72vw)]"
        />
        {acpAgent && (
          <AcpModelSelect
            agentId={acpAgent.id}
            agentLabel={acpAgent.label}
            modelId={resolved.acpModelId}
            // The pick becomes the profile's model slug (`acp:<agent>@<model>`); "" (the agent's own
            // default) drops the tail.
            onValueChange={(modelId) => saveProfile({ field: "model", backend: "acp", value: acpModelSlug(acpAgent.id, modelId) })}
            className="max-w-[min(14rem,40vw)] px-2 py-1"
          />
        )}
      </div>
    )
  }, [resolved, codexList, claudeList, acpList, profileLoadError, saveProfile, projectPicker])

  const accountModals = (
    <>
      {signInFor && (
        <SignInModal
          backend={signInFor}
          onClose={() => setSignInFor(null)}
          onAuthed={() => {
            const input = gatedInputRef.current
            gatedInputRef.current = null
            setSignInFor(null)
            if (input) runDispatch(input)
          }}
        />
      )}
      {logoutFor && <LogoutConfirmModal backend={logoutFor} onClose={() => setLogoutFor(null)} />}
    </>
  )

  // What the MCP plug asks about: the agent the model chip picks, since there is no thread yet. Undefined
  // while the profile is still loading, so the plug never reads one agent's servers under another's chip.
  const mcpTarget: McpTarget | undefined = resolved
    ? { backend: resolved.backend, ...(resolved.backend === "acp" ? { model: resolved.model } : {}) }
    : undefined

  return {
    prompt,
    setPrompt,
    submit,
    busy: dispatch.isPending || savingSettings,
    footer,
    githubTriggerVisible,
    mcpTarget,
    error: dispatch.isError ? (dispatch.error as Error).message : null,
    pendingDispatch,
    accountModals,
  }
}

export function DispatchForm({
  autoFocus,
  onDispatched,
  projectPicker,
  pendingCard = true,
}: {
  autoFocus?: boolean
  onDispatched?: () => void
  /** The Console's project chip, first in the footer. The dispatch goes to the enclosing ProjectScope. */
  projectPicker?: ReactNode
  /** Draw the "Starting thread…" card under the box while the dispatch call runs. Off (`false`) where the
   *  surface shows the pending thread itself: a project's sidebar and the Console's draw it as a Running
   *  row (lib/pendingDispatch). `"float"` draws it OUT OF FLOW, hung under the form: for a form that is
   *  centred in its page, where a card in flow would lift everything above it by half its own height. */
  pendingCard?: boolean | "float"
}) {
  const form = useDispatchForm(onDispatched, projectPicker)
  return (
    <div className={`w-full flex flex-col gap-3 ${pendingCard === "float" ? "relative" : ""}`}>
      <Composer
        surface="newComposer"
        autoFocus={autoFocus}
        value={form.prompt}
        onChange={form.setPrompt}
        onSubmit={form.submit}
        placeholder="Describe the task…"
        minHeight={96}
        maxHeight={340}
        busy={form.busy}
        footer={form.footer}
        leftAction={form.githubTriggerVisible ? <GithubTrigger /> : undefined}
        railMcp={form.mcpTarget ? <McpPlug target={form.mcpTarget} /> : undefined}
      />
      {form.error && (
        <span className="px-0.5 text-[11px] text-danger truncate">{form.error}</span>
      )}
      {pendingCard && form.pendingDispatch && (
        // `top-full mt-3` is the place the card takes in flow (the column's own 12px gap), so it reads
        // the same; an absolutely placed child of a flex column takes no gap and no height.
        <PendingDispatch prompt={form.pendingDispatch} className={pendingCard === "float" ? "absolute inset-x-0 top-full mt-3" : ""} />
      )}
      {form.accountModals}
    </div>
  )
}

function PendingDispatch({ prompt, className = "" }: { prompt: string; className?: string }) {
  return (
    <div data-pending-dispatch role="status" className={`rounded-lg border border-border bg-panel-2 px-3 py-2.5 ${className}`}>
      <div className="flex items-center gap-2 text-[11px] text-muted">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
        <span>Starting thread…</span>
      </div>
      <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[12px] leading-relaxed text-fg">{prompt}</p>
    </div>
  )
}

// THE PHONE'S NEW-THREAD PAGE (approved phone design, 2026-09-30, "New thread"). Full screen, because a
// new-thread screen never appears without the keyboard, and a card at the top of a blurred board left
// the prompt a third of the screen. × closes; "Start" in the header sends, disabled until there is text;
// the prompt fills the page at 17px; the tool row — attach, the model chip, the GitHub picker — rides
// on the keyboard. Start returns to the board when the server has the thread, as the dialog does.
function PhoneNewThreadPage({ onDispatched, projectPicker, project }: { onDispatched: () => void; projectPicker?: ReactNode; project?: string }) {
  const form = useDispatchForm(onDispatched, projectPicker)
  const board = useBoard()
  const identity = projectIdentity(board)
  // On the Console the board is every project's, so the subtitle names the one the chip points at.
  const projectName = project ?? (identity.state === "verified" ? identity.repo : identity.state === "local" ? identity.name : "")
  const [uploading, setUploading] = useState(false)
  const canStart = form.prompt.trim().length > 0 && !form.busy && !uploading
  return (
    <div data-phone-new-thread className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-[56px] shrink-0 items-center gap-0.5 border-b border-border py-1 pl-1 pr-2">
        <RadixDialog.Close asChild>
          <button
            type="button"
            aria-label="Close"
            data-phone-new-thread-close
            className="flex size-[44px] shrink-0 items-center justify-center rounded-full text-fg/90 active:bg-hover"
          >
            <X size={21} strokeWidth={2.1} />
          </button>
        </RadixDialog.Close>
        <div className="min-w-0 flex-1 pl-0.5 leading-[1.25]">
          <RadixDialog.Title className="truncate text-[16.5px] font-semibold tracking-[-0.01em] text-fg">New thread</RadixDialog.Title>
          {projectName && <div className="truncate text-[13px] text-muted">{projectName}</div>}
        </div>
        <button
          type="button"
          data-phone-start
          // Keep the caret in the prompt: a failed start restores the draft into a field still focused.
          onMouseDown={(e) => e.preventDefault()}
          onClick={form.submit}
          disabled={!canStart}
          className="relative flex h-[36px] shrink-0 items-center rounded-full bg-fg px-4 text-[15px] font-semibold text-bg after:absolute after:inset-x-0 after:-inset-y-[4px] after:content-[''] disabled:opacity-35"
        >
          Start
        </button>
      </header>
      {form.error && <div className="shrink-0 px-[18px] pt-2 text-[13px] text-danger">{form.error}</div>}
      {form.pendingDispatch && <PendingDispatch prompt={form.pendingDispatch} className="mx-3 mt-3 shrink-0" />}
      <Composer
        surface="newComposer"
        autoFocus
        value={form.prompt}
        onChange={form.setPrompt}
        onSubmit={form.submit}
        placeholder="Describe the task…"
        minHeight={120}
        maxHeight={100_000}
        busy={form.busy}
        onUploadingChange={setUploading}
        phone={{
          layout: "page",
          // `[&>*]:flex-initial`: the shared footer strip is `flex-1` for the desktop box, which here
          // would shove "Issue or PR" to the far edge instead of beside the model chip.
          tools: (
            <div className="flex min-w-0 items-center gap-2 [&>*]:flex-initial">
              {form.footer}
              {form.githubTriggerVisible && <GithubTrigger variant="phoneChip" />}
            </div>
          ),
        }}
      />
      {form.accountModals}
    </div>
  )
}

// The anywhere-modal behind the pill button: same form in a centered dialog. Esc closes (captured
// here BEFORE the composer's own Escape-blurs handler can swallow it).
//
// On the Console (⌘K → "New thread", and the phone's New thread button) the page names no project, so
// the form wears the same project chip as the sidebar's prompt box and runs inside that project's scope
// (ConsoleProjectChip.tsx) — without it the dispatch was refused and an attachment was uploaded to the
// LAUNCHING project first.
export function NewThreadDialog({ onClose }: { onClose: () => void }) {
  const isMobile = useIsMobile()
  const onConsole = isConsolePath()
  const target = useConsoleDispatchTarget(onConsole)
  const contentRef = useRef<HTMLDivElement>(null)
  // Frizz opens this dialog by writing store state, not through RadixDialog.Trigger. Capture the real
  // opener during the mount render so close can restore it explicitly.
  const openerRef = useRef<HTMLElement | null>(
    typeof document !== "undefined" && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  const form = isMobile ? (
    <PhoneNewThreadPage onDispatched={onClose} projectPicker={target.chip} project={target.project?.name} />
  ) : (
    <>
      <RadixDialog.Title className="mb-1 text-[14px] font-medium">New thread</RadixDialog.Title>
      {/* No "Starting thread…" card: the dialog is centred, so the card arriving in flow grew it by 74px
          and lifted its title and prompt box 37px for the length of the dispatch call, and then the
          dialog closed (2026-10-13, the call answering at +461ms). Floated, it would hang off the
          panel's edge. The rail behind the scrim draws the thread as the Running row it becomes
          (lib/pendingDispatch), and the toast and the Send spinner say it is starting. */}
      <DispatchForm autoFocus onDispatched={onClose} projectPicker={target.chip} pendingCard={false} />
    </>
  )
  useEffect(() => () => {
    const opener = openerRef.current
    window.setTimeout(() => {
      if (opener?.isConnected) opener.focus({ preventScroll: true })
    }, 0)
  }, [])
  return (
    <RadixDialog.Root open onOpenChange={(open) => { if (!open) onClose() }}>
      <RadixDialog.Portal>
        {/* Frosted glass: heavy blur + saturation over a light black wash, so the board reads as a
            texture behind the dialog rather than going fully dark. */}
        <RadixDialog.Overlay className={`fixed inset-0 ${Z_MODAL} bg-scrim-30 backdrop-blur-md backdrop-saturate-150`} />
        <RadixDialog.Content
          ref={contentRef}
          aria-modal="true"
          aria-describedby={undefined}
          onEscapeKeyDown={handleDialogEscape}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            const opener = openerRef.current
            if (opener?.isConnected) opener.focus({ preventScroll: true })
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            contentRef.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true })
          }}
          // A PAGE ON A PHONE: full screen, under the device's top inset (PhoneNewThreadPage). Above the
          // phone breakpoint nothing changes.
          className={isMobile
            ? `fixed inset-0 ${Z_MODAL} flex flex-col bg-bg pt-[env(safe-area-inset-top)] outline-none`
            : `fixed left-1/2 top-1/2 ${Z_MODAL} w-[640px] max-w-[86vw] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-border bg-panel p-5 shadow-2xl shadow-shadow-ink/50 outline-none max-[700px]:top-[calc(env(safe-area-inset-top)+56px)] max-[700px]:w-[calc(100vw-24px)] max-[700px]:max-w-none max-[700px]:translate-y-0`}
        >
          {onConsole ? <ProjectScope project={target.project?.slug}>{form}</ProjectScope> : form}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  )
}

export function Overlay({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    // Frosted glass: heavy blur + saturation over a light black wash, so the board reads as a
    // texture behind the dialog rather than going fully dark. The dialog layer (lib/layers.ts), the
    // shared Radix Dialog's, so the centered picker sits above every drawer and modal it can open from.
    <div
      className={`fixed inset-0 ${Z_DIALOG} flex items-center justify-center bg-scrim-30 backdrop-blur-md backdrop-saturate-150`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      {children}
    </div>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[11px] uppercase tracking-wide text-muted">{label}</span>
      {children}
    </label>
  )
}
