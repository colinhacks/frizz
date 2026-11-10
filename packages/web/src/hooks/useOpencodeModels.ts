import { useCallback, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { OpencodeModels } from "@frizz/shared"
import { rpcFor } from "../api/rpc.ts"
import { scopedKey } from "../lib/projectScope.tsx"

// OpenCode's model list, asked of `project`. Reading it starts the person's OpenCode service, so it is read
// only when it is `wanted` (OpenCode is the chosen profile, or the thread runs on OpenCode) or once someone
// opens the list (`request`), never because a model menu merely opened on a machine that has OpenCode.
export function useOpencodeModels(project: string | undefined, wanted: boolean): {
  models: OpencodeModels | undefined
  loading: boolean
  request: () => void
} {
  const [requested, setRequested] = useState(false)
  const enabled = wanted || requested
  const query = useQuery({
    queryKey: scopedKey(["opencodeModels"], project),
    queryFn: () => rpcFor(project).opencodeModels(),
    staleTime: 60_000,
    enabled,
  })
  const request = useCallback(() => setRequested(true), [])
  return { models: query.data, loading: enabled && query.isPending, request }
}
