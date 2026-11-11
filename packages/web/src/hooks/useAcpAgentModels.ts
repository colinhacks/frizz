import { useCallback, useMemo, useState } from "react"
import { useQueries } from "@tanstack/react-query"
import type { AcpAgentModels } from "@frizz/shared"
import { rpcFor } from "../api/rpc.ts"
import { scopedKey } from "../lib/projectScope.tsx"

export interface AcpAgentModelLists {
  models: Readonly<Record<string, AcpAgentModels | undefined>>
  loading: Readonly<Record<string, boolean>>
  request: (agentId: string) => void
}

// Each ACP agent's model list, asked of `project`. Reading one opens a throwaway session on that agent,
// starting its CLI, so a list is read only for the agent that is `chosen` or once someone opens its
// dropdown (`request`), never because a model menu merely opened. The server caches each probe for ten
// minutes; a minute here keeps a reopened menu from re-asking on every mount.
export function useAcpAgentModels(project: string | undefined, agentIds: readonly string[], chosen: string | undefined): AcpAgentModelLists {
  const [requested, setRequested] = useState<ReadonlySet<string>>(() => new Set())
  const lists = useQueries({
    queries: agentIds.map((agentId) => ({
      queryKey: scopedKey(["acpAgentModels", agentId], project),
      queryFn: () => rpcFor(project).acpAgentModels({ agentId }),
      staleTime: 60_000,
      enabled: agentId === chosen || requested.has(agentId),
    })),
  })
  const request = useCallback((agentId: string) => {
    setRequested((current) => current.has(agentId) ? current : new Set([...current, agentId]))
  }, [])
  // `useQueries` answers a new array each render; key the result on what it holds, so a menu built from it
  // is rebuilt only when a list or its loading state changes.
  const key = lists.map((list, index) => `${agentIds[index]}:${list.dataUpdatedAt}:${list.isPending}`).join("|")
  return useMemo(() => {
    const models: Record<string, AcpAgentModels | undefined> = {}
    const loading: Record<string, boolean> = {}
    agentIds.forEach((agentId, index) => {
      models[agentId] = lists[index]?.data
      loading[agentId] = (agentId === chosen || requested.has(agentId)) && Boolean(lists[index]?.isPending)
    })
    return { models, loading, request }
    // `lists` is read through `key`, which names everything of it the result depends on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, chosen, requested, request])
}
