import { useEffect, useRef } from "react"
import { useQuery } from "@tanstack/react-query"
import { useSnapshot } from "valtio"
import type { RuntimeDownloadChip } from "@frizz/shared"
import { rpc } from "../api/rpc.ts"
import { store } from "../store.ts"

// A RUNTIME STILL DOWNLOADING AFTER THE BOARD OPENED WITHOUT IT (2026-11-15). "Open Frizz now" on the
// restart screen starts the server without a runtime whose download is slow, and the server keeps
// downloading it (runtime-deferral.ts). This chip in the status row is how that download stays visible:
// the runtime's name, a ring filling with it, and a short reading ("64% · 3m"), the full line on hover.
// A new thread on that runtime waits for it, which the composer's own toast says when one is sent.
//
// It asks once as the board loads — the board a tab lands on after opening early is a fresh load — and
// again whenever a restart this tab rode out ends; then once a second only while a download is out.
// Nothing polls while there is nothing to show.

const POLL_MS = 1_000

export function RuntimeDownloadChips() {
  const snap = useSnapshot(store)
  const downloads = useQuery({
    queryKey: ["runtimeDownloadChips"],
    queryFn: () => rpc.runtimeDownloadChips(),
    refetchInterval: (query) => (query.state.data?.length ? POLL_MS : false),
    staleTime: (query) => (query.state.data?.length ? POLL_MS : Number.POSITIVE_INFINITY),
    retry: false,
  })
  // A restart that brought the same build back reloads no tab (PageFrame), so the load-time read above
  // would never see what the new server is still downloading. Ask again as each one ends.
  const restarting = snap.controlPlaneState === "restarting"
  const wasRestarting = useRef(restarting)
  const { refetch } = downloads
  useEffect(() => {
    if (wasRestarting.current && !restarting) void refetch()
    wasRestarting.current = restarting
  }, [restarting, refetch])
  const chips = downloads.data ?? []
  if (chips.length === 0) return null
  return (
    <>
      {chips.map((chip) => (
        <span
          key={chip.backend}
          data-runtime-download={chip.backend}
          data-state={chip.state}
          title={chip.detail}
          aria-label={chip.detail}
          className="inline-flex h-[22px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border border-border bg-panel pl-[7px] pr-[9px] text-[11.5px] text-fg/85"
        >
          <MiniRing chip={chip} />
          {chip.name}
          <span className="font-mono text-[10.5px] tabular-nums text-muted">{chip.reading}</span>
        </span>
      ))}
    </>
  )
}

const RADIUS = 4.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/** 12px: the ring fills with the download, turns as a quarter arc before its size is known, and greys while stalled. */
function MiniRing({ chip }: { chip: RuntimeDownloadChip }) {
  const known = typeof chip.fraction === "number"
  const filled = known ? Math.max(0.04, Math.min(1, chip.fraction!)) : 0.25
  return (
    <svg aria-hidden="true" viewBox="0 0 12 12" className={`h-3 w-3 shrink-0 -rotate-90${known || chip.state === "stalled" ? "" : " animate-spin"}`}>
      <circle cx="6" cy="6" r={RADIUS} fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="1.75" />
      <circle
        cx="6"
        cy="6"
        r={RADIUS}
        fill="none"
        className={chip.state === "stalled" ? "stroke-muted" : "stroke-accent"}
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - filled)}
      />
    </svg>
  )
}
