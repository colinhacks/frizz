import { useCallback, useState } from "react"
import { useQuery } from "@tanstack/react-query"
import type { AntigravityModels } from "@frizz/shared"
import { rpcFor } from "../api/rpc.ts"
import { scopedKey } from "../lib/projectScope.tsx"

// Whether `agy` is on the server's PATH, asked of `project`. The answer starts nothing, so every model
// menu may ask it; it decides whether the menu has an Antigravity group at all. A server too old to
// answer reads as not installed.
export function useAntigravityInstalled(project: string | undefined): { installed: boolean; settled: boolean } {
  const query = useQuery({
    queryKey: scopedKey(["antigravityInstalled"], project),
    queryFn: () => rpcFor(project).antigravityModels({ installedOnly: true }),
    staleTime: 60_000,
    retry: false,
  })
  return { installed: query.data?.available === true, settled: query.isSuccess || query.isError }
}

// Antigravity's model list, asked of `project`. Reading it starts `agy` and opens a throwaway session on
// the person's account (cached 10m server-side, zero tokens), so it runs when `wanted` (agy is installed
// on this machine and the picker can show its Gemini grid, or the thread runs on Antigravity) or when
// requested on menu open.
export function useAntigravityModels(project: string | undefined, wanted: boolean): {
  models: AntigravityModels | undefined
  loading: boolean
  request: () => void
} {
  const [requested, setRequested] = useState(false)
  const enabled = wanted || requested
  const query = useQuery({
    queryKey: scopedKey(["antigravityModels"], project),
    queryFn: () => rpcFor(project).antigravityModels(),
    staleTime: 60_000,
    enabled,
  })
  const request = useCallback(() => setRequested(true), [])
  return { models: query.data, loading: enabled && query.isPending, request }
}
