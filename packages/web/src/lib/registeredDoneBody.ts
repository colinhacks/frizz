import { useEffect, useRef } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { doneFenceBodyHead, type ThreadView } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"

// THE WHOLE BODY OF A REGISTERED DONE, for the card at the bottom of the thread (ChatView's
// "registered-done" rung).
//
// An ARCHIVED thread's board view carries only the head of its done fence's body (shared fence-head.ts),
// because no row draws more and the board read was spending a third of its bytes on it. The card is the
// one reader of the rest, so the thread's surface reads it per thread, as it reads its answered questions:
//
//   · the read starts when the surface mounts (ThreadSurface's useThreadMessages calls this), beside the
//     transcript's own, and is cached for the session;
//   · a surface that saw the body whole keeps it, so a thread archived while it is open — Mark as done in
//     the pane — goes on drawing the card it drew, with no read and no gap. What it kept is used only if
//     it is the body the board now cuts (same head, same length), and it seeds the cache for the next
//     surface to open the thread.
//
// Until the body is in hand the card waits rather than drawing the head as if it were the whole.

type Fence = ThreadView["lastFence"]

export const registeredDoneKey = (slug: string, fence: NonNullable<Fence>) => ["registeredDone", slug, fence.bodyElided ?? -1, fence.body] as const

/** Whether `fence` is a registered done whose body the board cut, so a reader of the body has to fetch it. */
export function needsRegisteredDoneBody(fence: Fence): fence is NonNullable<Fence> & { bodyElided: number } {
  return fence?.kind === "done" && fence.registered === true && fence.bodyElided !== undefined
}

/** Whether a body this surface saw whole is the one the board now carries the head of. */
export function isWholeOf(whole: string | undefined, fence: NonNullable<Fence>): whole is string {
  return whole !== undefined && whole.length === fence.bodyElided && doneFenceBodyHead(whole) === fence.body
}

/** The registered done's body, whole — undefined only while an archived thread's is still being read. */
export function useRegisteredDoneBody(thread: Pick<ThreadView, "id" | "lastFence"> | undefined): string | undefined {
  const fence = thread?.lastFence
  const slug = thread?.id ?? ""
  const seen = useRef<{ slug: string; body: string } | undefined>(undefined)
  if (fence?.kind === "done" && fence.bodyElided === undefined) seen.current = { slug, body: fence.body }
  const cut = needsRegisteredDoneBody(fence) ? fence : undefined
  const kept = cut && seen.current?.slug === slug && isWholeOf(seen.current.body, cut) ? seen.current.body : undefined
  const queryClient = useQueryClient()
  const query = useQuery({
    queryKey: cut ? registeredDoneKey(slug, cut) : ["registeredDone", "none"],
    queryFn: async () => (await rpc.threadRegisteredDone({ slug })).body,
    enabled: cut !== undefined && kept === undefined && slug !== "",
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  })
  useEffect(() => {
    if (cut && kept !== undefined && queryClient.getQueryData(registeredDoneKey(slug, cut)) === undefined) {
      queryClient.setQueryData(registeredDoneKey(slug, cut), kept)
    }
  }, [cut, kept, queryClient, slug])
  if (!fence) return undefined
  if (!cut) return fence.body
  if (kept !== undefined) return kept
  // A thread with no stored row any more (cleared under it), or a read that failed, has nothing whole to
  // show: the head is all there is, and it is what the board said.
  if (query.data === null || query.isError) return fence.body
  return query.data
}
