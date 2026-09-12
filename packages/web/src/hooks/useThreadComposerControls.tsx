import { useMutation, useQuery } from "@tanstack/react-query"
import type { ReactNode } from "react"
import { useSnapshot } from "valtio"
import type { PermissionMode } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { threadFollowUpBlocked, threadComposerStatus, threadPermissionBlockedReason, threadPermissionEffectMessage } from "../lib/threadPermissions.ts"
import { showToast, store } from "../store.ts"
import { ProfileGridSelector } from "../components/ProfileGridSelector.tsx"
import { Select } from "../components/ui/Select.tsx"
import { CLAUDE_DISPATCH_PERMISSION_OPTIONS, claudePermValue } from "../lib/options.ts"
import { threadProfileControlState } from "../lib/threadProfile.ts"

// One control strip for every place a registered thread can be steered: the model/effort selector, and
// — for a Claude thread — the Auto/Bypass permission picker beside it. This lives outside the component
// module so exporting the hook does not invalidate Vite Fast Refresh for ThreadActionBar.
//
// THE PERMISSION PICKER CAME BACK, NARROWED. Every per-thread permission/sandbox control was removed
// from this strip on 2026-07-23, and the reason was sound for the controls that existed: they offered
// the RESTRICTIVE modes, and a headless worker narrowed to `default` or `acceptEdits` or a codex
// `read-only` just wedges on an approval nobody is watching. What the maintainer asked for on
// 2026-08-13 is the other half of that axis — "for Claude Code specifically, I'm curious if there's a
// way for us to switch between Auto mode and Bypass Permissions mode" — and neither of those two can
// wedge anything: `auto` is what dispatch already launches with, and bypass is strictly more permissive
// still. So the options here are exactly the two Settings offers for a NEW worker
// (CLAUDE_DISPATCH_PERMISSION_OPTIONS), which is also what keeps the launch default and the per-thread
// override speaking one vocabulary.
//
// CODEX IS DELIBERATELY LEFT OUT. Its axis is a sandbox rather than a permission mode, its restrictive
// end is the one that caused the 2026-07-23 removal, and the ask was Claude-specific.
export function useThreadComposerControls(slug: string): { busy: boolean; footer: ReactNode; status: ReactNode } {
  const snap = useSnapshot(store)
  const thread = snap.board?.threads.find((candidate) => candidate.id === slug)
  const profiles = useQuery({
    queryKey: ["threadProfileOptions", slug],
    queryFn: () => rpc.threadProfileOptions({ slug }),
    enabled: Boolean(thread && !thread.foreign && thread.kind === "session"),
    staleTime: 5_000,
  })
  const profile = useMutation({
    mutationFn: (target: { model: string; effort: string }) => rpc.setThreadProfile({ slug, ...target }),
  })
  const permission = useMutation({
    mutationFn: (permissionMode: PermissionMode) => rpc.setThreadPermission({ slug, permissionMode }),
  })
  const localBusy = profile.isPending || permission.isPending

  // Legacy/rowless and foreign transcripts have no Frizz-owned runtime profile to mutate. Keep their
  // existing composer behavior, but never render a misleading disabled control.
  if (!thread || thread.foreign || thread.kind !== "session") return { busy: localBusy, footer: null, status: null }

  // The board's pending bit is authoritative across every mounted surface (queue + drawer + another
  // tab). A local React mutation alone cannot prevent a second composer from steering the pane during
  // the backend handoff.
  const busy = localBusy || threadFollowUpBlocked(thread)

  const model = thread.model?.trim()
  const effort = thread.effort?.trim()
  const backend = thread.backend === "codex" ? "codex" : "claude"
  // OPTIMISTIC PENDING. The profile control is backed by a runtime handoff that can take a half-second
  // or more, and the board's own pending bit only appears once the server has claimed the row — so
  // picking a model used to produce NO visible response at all until it landed, which reads as a dropped
  // click and invites a second one. The in-flight mutation variables give us the exact target
  // immediately, expressed in the SAME "→ … pending" affordance the server's bit drives, so the local
  // hint and the authoritative one are indistinguishable and hand over without a flicker. Deliberately
  // NOT rendered as the applied value: the server may still answer "next-resume", and a control that
  // claims a live change it did not make is worse than a slow one.
  const optimisticProfile = profile.isPending ? profile.variables : undefined
  const pendingModel = thread.profilePendingModel ?? optimisticProfile?.model
  const pendingEffort = thread.profilePendingEffort ?? optimisticProfile?.effort
  const profileOptions = profiles.data?.options ?? []
  const { modelSelectable } = threadProfileControlState(profileOptions, model, effort, thread.runtime === "exited")
  const catalogLoaded = profiles.data !== undefined
  const profileGroups = [{
    id: backend,
    label: backend === "codex" ? "Codex" : "Claude Code",
    options: profileOptions,
  }]
  const composerStatus = threadComposerStatus(profiles.isError ? (profiles.error as Error).message : undefined)

  // WHAT THE OPERATOR IS LOOKING AT, and it is deliberately not `thread.permissionMode` raw: a thread
  // whose stored mode is one of the restrictive ones (an adopted foreign session, or a row left over
  // from before this control narrowed to two) has no option to select, and a Select with a value that
  // matches nothing renders empty. `claudePermValue` folds the one such mode Claude can carry back onto
  // `auto`; anything else unrecognised does the same here, so the readout always names a real row.
  const storedPermission = thread.permissionMode ? claudePermValue(thread.permissionMode) : "auto"
  const permissionValue = CLAUDE_DISPATCH_PERMISSION_OPTIONS.some((o) => o.value === storedPermission) ? storedPermission : "auto"
  // OPTIMISTIC, exactly like the profile control above: the write is a round trip, and a picker that
  // snaps back to the old value for its duration reads as a dropped click.
  const shownPermission = permission.isPending ? (permission.variables as PermissionMode) : permissionValue
  const permissionBlocked = threadPermissionBlockedReason(thread)

  function changePermission(next: PermissionMode) {
    if (next === permissionValue) return
    permission.mutate(next, {
      onSuccess: (result) => showToast(threadPermissionEffectMessage(result.effect, "claude")),
      onError: (e) => showToast(`Permission change failed: ${(e as Error).message.slice(0, 120)}`),
    })
  }

  function changeProfile(target: { model: string; effort: string }) {
    profile.mutate(target, {
      onSuccess: (result) => showToast(result.effect === "next-resume"
        ? "Model and effort saved for the next resume"
        : "Model and effort applied"),
      onError: (e) => showToast(`Profile change failed: ${(e as Error).message.slice(0, 120)}`),
    })
  }

  return {
    busy,
    footer: (
      <div
        data-thread-composer-controls
        // gap-x-1.5, MEASURED. The row held one pill and a quiet text readout on `gap-x-1`; a SECOND
        // bordered pill beside the first turned that 4px box gap into 3.69px of ink between two
        // borders, and two pills that close read as one segmented control rather than as two
        // independent choices. 6px of box is 5.7px of ink, which separates them without letting the
        // pair drift apart from each other.
        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 gap-y-0.5"
      >
        <ProfileGridSelector
          groups={profileGroups}
          value={{ provider: backend, model, effort }}
          pending={pendingModel || pendingEffort
            ? { provider: backend, model: pendingModel, effort: pendingEffort }
            : undefined}
          onValueChange={({ model: nextModel, effort: nextEffort }) => changeProfile({ model: nextModel, effort: nextEffort })}
          placeholder={profiles.isPending ? "Profile loading…" : "Profile unknown"}
          ariaLabel="Thread model and effort"
          menuAriaLabel={`Choose ${backend === "codex" ? "Codex" : "Claude Code"} model and effort`}
          title={modelSelectable
            ? thread.runtime === "exited"
              ? "Saved per thread and applied when this conversation resumes"
              : "Change this idle conversation's model and reasoning effort"
            : "The current live backend profile is unavailable; controls fail closed"}
          disabled={busy || !catalogLoaded || !modelSelectable || profiles.isError}
          compact
          side="top"
          className="min-w-0 max-w-[min(72%,20rem)] px-1.5 py-0.5"
        />
        {backend === "claude" && (
          <Select
            variant="readout"
            side="top"
            value={shownPermission}
            onValueChange={(v) => changePermission(v as PermissionMode)}
            options={CLAUDE_DISPATCH_PERMISSION_OPTIONS}
            ariaLabel="Thread permission mode"
            // The title carries the COST, because this control's cost is the one thing the two words in
            // the trigger cannot say: a Claude permission mode is a launch flag, so changing it retires
            // the worker process and the next turn resumes the same conversation in a new one. An
            // operator who expected a live retune would otherwise discover the restart by watching it.
            title={permissionBlocked
              ? `${permissionBlocked} — changing permissions restarts this thread's worker process`
              : shownPermission === "bypassPermissions"
                ? "Bypass: the worker never asks for approval. Changing this restarts the worker process; the conversation resumes from disk on the next turn."
                : "Auto: risky actions raise an approval card here. Changing this restarts the worker process; the conversation resumes from disk on the next turn."}
            disabled={busy || permissionBlocked !== null}
            // NO padding override: the readout variant's own box (4px/8px, 12px type) already matches
            // the profile pill beside it exactly — measured, both 26px tall — and passing one would only
            // look like it was doing something. `shrink-0` keeps the two words whole when the profile
            // pill beside it takes its 20rem.
            className="shrink-0"
          />
        )}
        {pendingModel && pendingEffort && (
          <span className="min-w-0 truncate text-[9px] text-muted-50">
            → {pendingModel} · {pendingEffort} pending
          </span>
        )}
      </div>
    ),
    status: composerStatus ? (
          <div
            data-thread-control-error=""
            className="px-1 pt-1 text-[9.5px] leading-tight text-muted-65"
          >
            {composerStatus.message}
          </div>
        ) : null,
  }
}
