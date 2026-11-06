import { useMemo } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { AcpAgent, ClaudeModel, CodexModel, SetDispatchPreferenceInput } from "@frizz/shared"
import { rpc, rpcFor } from "../api/rpc.ts"
import { useRemoteHost } from "../api/supervisorStatus.ts"
import { showToast } from "../store.ts"
import { scopedKey, useProjectScope } from "../lib/projectScope.tsx"
import {
  applyDispatchPreferenceUpdate,
  resolveDispatchPreferences,
  type ResolvedDispatchPreferences,
} from "../lib/dispatchPreferences.ts"

// THE durable new-thread profile (backend + model + effort), shared by every surface that starts a
// thread from the prompt box: the dispatch composer and the GitHub batch picker. Both read the same
// preference row and write it through the same scoped mutation, so a selection made in either is the
// profile the other dispatches with — there is no second, surface-local copy to drift.
export function useDispatchProfile(): {
  // Undefined until BOTH durable intent and the Codex catalogue have landed. Rendering a profile
  // before then can classify a saved Codex model as Claude merely because the catalogue is cold.
  resolved: ResolvedDispatchPreferences | undefined
  codexList: readonly CodexModel[]
  // The Claude aliases with the edition the pinned runtime resolves each to ("Opus 5.5") — labels
  // only. Empty while the runtime answers or on a server too old to ask, which is why readiness never
  // waits on it: the rows fall back to their family words, and the profile itself is keyed on the alias.
  claudeList: readonly ClaudeModel[]
  // The ACP agents the server knows, `available` for the ones on its PATH. Empty on a server too old
  // to answer, which is why neither readiness nor `loadError` waits on this query.
  acpList: readonly AcpAgent[]
  loadError: boolean
  saveProfile: (update: SetDispatchPreferenceInput) => void
} {
  const queryClient = useQueryClient()
  const preferences = useQuery({ queryKey: ["dispatchPreferencesGet"], queryFn: () => rpc.dispatchPreferencesGet() })
  // The codex model catalogue + per-model effort options, from the authoritative ~/.codex cache (never a
  // hand-maintained list).
  const codexModels = useQuery({ queryKey: ["codexModels"], queryFn: () => rpc.codexModels() })
  const codexList = codexModels.data ?? []
  // These two are answered by a PROJECT (its runtime, its PATH), so on the Console they are asked of the
  // project the prompt box is pointed at (lib/projectScope.tsx).
  const project = useProjectScope()
  const api = rpcFor(project)
  const remoteHost = useRemoteHost()
  const claudeModels = useQuery({ queryKey: scopedKey(["claudeModels"], project), queryFn: () => api.claudeModels(), retry: false, enabled: !remoteHost })
  const claudeList = claudeModels.data ?? []
  const acpAgents = useQuery({ queryKey: scopedKey(["acpAgents"], project), queryFn: () => api.acpAgents() })
  const acpList = acpAgents.data ?? []

  const preference = useMutation({
    mutationFn: (update: SetDispatchPreferenceInput) => rpc.dispatchPreferenceSet(update),
    // TanStack serializes mutations sharing this scope. This prevents a fast pair of selections from
    // reaching SQLite out of order while optimistic query data keeps every mounted composer in sync.
    scope: { id: "dispatch-preferences" },
    onMutate: (update) => {
      const current = queryClient.getQueryData<Awaited<ReturnType<typeof rpc.dispatchPreferencesGet>>>(["dispatchPreferencesGet"])
      if (current) queryClient.setQueryData(["dispatchPreferencesGet"], applyDispatchPreferenceUpdate(current, update))
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: ["dispatchPreferencesGet"] })
      showToast(`Could not save new-thread preference: ${(error as Error).message.slice(0, 80)}`)
    },
  })

  // The ACP catalogue counts once it has SETTLED either way: a saved ACP profile must not read as
  // unavailable merely because the list is cold, and an older server that lacks the RPC must not block
  // the composer forever.
  const controlsReady = !!preferences.data && !!codexModels.data && (acpAgents.isSuccess || acpAgents.isError)
  const resolved = useMemo(
    () => controlsReady ? resolveDispatchPreferences(preferences.data!, codexList, acpList) : undefined,
    [controlsReady, preferences.data, codexList, acpList],
  )

  return {
    resolved,
    codexList,
    claudeList,
    acpList,
    loadError: preferences.isError || codexModels.isError,
    saveProfile: preference.mutate,
  }
}
