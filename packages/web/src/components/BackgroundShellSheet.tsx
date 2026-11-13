import { useEffect, useRef, useState, type ReactNode } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { Copy, Radio, RefreshCw, TerminalSquare } from "lucide-react"
import { showToast } from "../store.ts"
import { rpc } from "../api/rpc.ts"
import { useBackgroundShellOutput, useMonitorOutput } from "../hooks.ts"
import { copyTextToClipboard } from "../lib/clipboard.ts"
import { elapsedSince, formatAgo } from "../lib/durationLabels.ts"
import { Sheet } from "./ui/Sheet.tsx"
import { SheetHeader } from "./ui/SheetHeader.tsx"
import { BLOCK_RADIUS } from "./TranscriptCard.tsx"
import { CodeBody } from "./CodeBody.tsx"
import { DrawerStopCheck } from "./DrawerStopCheck.tsx"
import { LiveDot } from "./LiveDot.tsx"

// Shared by the command block and its no-command fallback so the two cannot drift apart.
const commandBlockClass = `font-mono-keep overflow-x-auto whitespace-pre-wrap break-words ${BLOCK_RADIUS} border border-border bg-bg/75 px-4 py-2.5 text-[12px] leading-relaxed text-fg/85`

export function BackgroundShellSheet({
  id,
  slug,
  shellId,
  label,
  startedAt,
  depth,
  widthDepth,
}: {
  id: number
  slug: string
  shellId: string
  label: string
  startedAt?: string
  depth: number
  widthDepth: number
}) {
  const query = useBackgroundShellOutput(slug, shellId)
  const state = query.data?.state
  const [stopping, setStopping] = useState(false)
  const qc = useQueryClient()

  const age = elapsedSince(startedAt)
  const stateLabel = state === "running" ? `running${age ? ` ${age}` : ""}` : state === "done" ? "finished" : state === "gone" ? "unavailable" : ""
  const unavailable = query.isError || state === "gone"

  // KILL THE SHELL FROM THE DRAWER — the surface where a wedged watcher is actually diagnosed. The ops
  // strip's × does the same thing in one click, but you only know a shell is stuck AFTER reading its
  // output, and having to close the drawer to act on what you just read is the gap this closes.
  //
  // `subAgentStop`, not `stopBackgroundOp`: the drawer must not force-retire the row it is rendering.
  // The provider's own terminal task event clears it moments later (measured in
  // server/backend/_live_shell_stop.mts), so the state readout in this header updates on its own.
  function stop() {
    if (stopping) return
    setStopping(true)
    rpc.subAgentStop({ slug, id: shellId })
      .then(({ note }) => {
        // A shell has no subtree, so `note` can only carry the one failure that is specific to it: the
        // process is dead but the WORKER could not be told, and is still waiting on it.
        if (note) showToast(`Background shell stopped. ${note}`, { duration: 7000 })
        else showToast("Background shell stopped — the worker was told")
        void qc.invalidateQueries({ queryKey: ["backgroundShellOutput", slug, shellId] })
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Could not stop this background shell")
      })
      .finally(() => setStopping(false))
  }

  return (
    <OutputSheet
      id={id}
      depth={depth}
      widthDepth={widthDepth}
      kind="background-shell"
      title={label}
      icon={<TerminalSquare aria-hidden size={14} className="shrink-0 text-muted-60" />}
      stateLabel={stateLabel}
      command={query.data?.command}
      output={query.data?.output ?? ""}
      truncated={query.data?.truncated === true}
      running={state === "running"}
      loading={query.isLoading}
      unavailable={unavailable}
      unavailableText="Background shell output is no longer available."
      noCommandText="Command unavailable for this background operation."
      emptyText={state === "done" ? "No output was captured." : "No output yet."}
      stop={!unavailable && query.data?.stoppable ? { label: "Stop shell", stopping, onStop: stop } : undefined}
      // A RUNNING shell frizz cannot reach states why where nothing offers to stop it, because "no
      // control and no explanation" is what sent the maintainer looking for a stop in the first place.
      // A finished shell needs neither (its state readout already says "finished").
      footer={!unavailable && !query.data?.stoppable && state === "running" ? query.data?.stopNote ?? undefined : undefined}
    />
  )
}

/**
 * A MONITOR's drawer (2026-11-03): the same sheet as a background shell's, because a monitor IS a shell
 * the server runs — its row opens onto the script and everything it printed, stdout and stderr together,
 * the lines that woke the worker and the ones that did not. The server keeps that log (command-watch.ts,
 * monitorOutputSink); this reads it, polling while the script runs.
 *
 * Its stop is the HUMAN's, and unlike the worker's own drop it wakes the worker with why: the monitor
 * ended under a thread that may be resting on it.
 *
 * A CHECK (`frizzctl monitor add --every`) opens it too, since 2026-11-12 — its row opened nothing until
 * then, and the one place to read why it had not passed was a tooltip. The server keeps no log of a check,
 * only what its LAST run printed, so that is the output, under a heading that says so. It has no stop:
 * nothing would tell its worker it was stopped.
 */
export function MonitorSheet({
  id,
  slug,
  monitorId,
  label,
  depth,
  widthDepth,
}: {
  id: number
  slug: string
  monitorId: string
  label: string
  depth: number
  widthDepth: number
}) {
  const query = useMonitorOutput(slug, monitorId)
  const data = query.data
  const [stopping, setStopping] = useState(false)
  const qc = useQueryClient()

  const check = data?.check ?? null
  const events = data ? `${data.events} event${data.events === 1 ? "" : "s"}` : ""
  const runs = check ? `${check.runs} check${check.runs === 1 ? "" : "s"}` : ""
  const age = elapsedSince(data?.startedAt ?? undefined)
  const stateLabel = check
    ? data?.state === "running" ? [`every ${check.every}`, runs].join(" · ") : [data?.ended ?? "ended", runs].join(" · ")
    : data?.state === "running"
      ? [`running${age ? ` ${age}` : ""}`, events].join(" · ")
      : data?.state === "ended"
        ? [data.ended ?? "ended", events].join(" · ")
        : data?.state === "gone" ? "unavailable" : ""
  const unavailable = query.isError || data?.state === "gone"
  const lastRun = check?.lastRun ?? null

  function stop() {
    if (stopping) return
    setStopping(true)
    rpc.stopMonitor({ slug, id: monitorId })
      .then(({ stopped }) => {
        showToast(stopped ? "Monitor stopped — the worker was told" : "This monitor had already ended")
        void qc.invalidateQueries({ queryKey: ["monitorOutput", slug, monitorId] })
      })
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : "Could not stop this monitor")
      })
      .finally(() => setStopping(false))
  }

  return (
    <OutputSheet
      id={id}
      depth={depth}
      widthDepth={widthDepth}
      kind="monitor"
      title={data?.description || label}
      icon={check
        ? <RefreshCw aria-hidden size={14} className="shrink-0 text-muted-60" />
        : <Radio aria-hidden size={14} className="shrink-0 text-muted-60" />}
      stateLabel={stateLabel}
      command={data?.command}
      output={data?.output ?? ""}
      truncated={data?.truncated === true}
      running={!check && data?.state === "running"}
      loading={query.isLoading}
      unavailable={unavailable}
      unavailableText="This monitor is no longer available."
      noCommandText="Script unavailable for this monitor."
      emptyText={check
        ? lastRun ? "It printed nothing." : "No check has finished yet."
        : data?.state === "ended" ? "It printed nothing." : "Nothing printed yet."}
      // A check's heading names WHICH run the output is, and how it ended: it is the last of many, and
      // the next one replaces it.
      outputHeading={check ? "Last check" : undefined}
      outputNote={lastRun ? `${checkRunClause(lastRun)} · ${formatAgo(lastRun.at)}` : undefined}
      stop={!unavailable && data?.stoppable ? { label: "Stop monitor", stopping, onStop: stop } : undefined}
    />
  )
}

/** "exited 1", "timed out", … — how one check ended, as the awaiting card's tooltip says it. */
function checkRunClause(run: { outcome: "exit" | "timeout" | "signal" | "error"; exitCode: number | null }): string {
  if (run.outcome === "exit") return run.exitCode === 0 ? "passed" : `exited ${run.exitCode}`
  if (run.outcome === "timeout") return "timed out"
  if (run.outcome === "signal") return "killed by a signal"
  return "could not start"
}

/** The sheet both drawers draw: a header with the state and the stop, the command, and the output. */
function OutputSheet({
  id,
  depth,
  widthDepth,
  kind,
  title,
  icon,
  stateLabel,
  command,
  output,
  truncated,
  running,
  loading,
  unavailable,
  unavailableText,
  noCommandText,
  emptyText,
  outputHeading = "Output",
  outputNote,
  stop,
  footer,
}: {
  id: number
  depth: number
  widthDepth: number
  /** Names the data attributes (`data-background-shell-output`, `data-monitor-output`, …). */
  kind: "background-shell" | "monitor"
  title: string
  icon: ReactNode
  stateLabel: string
  command: string | null | undefined
  output: string
  truncated: boolean
  running: boolean
  loading: boolean
  unavailable: boolean
  unavailableText: string
  noCommandText: string
  emptyText: string
  /** The output section's heading, "Output" unless the drawer says which output it is ("Last check"). */
  outputHeading?: string
  /** A reading beside that heading — a check's "exited 1 · 3m ago". */
  outputNote?: string
  stop?: { label: string; stopping: boolean; onStop: () => void }
  footer?: string
}) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const attr = (part: string) => ({ [`data-${kind}-${part}`]: "" }) as Record<`data-${string}`, string>

  // Follow live output only while the reader remains close to the bottom; inspecting earlier lines
  // must not be interrupted by the next 1.5s poll.
  useEffect(() => {
    const element = scrollerRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    if (distance < 160) element.scrollTop = element.scrollHeight
  }, [output])

  async function copyCommand() {
    if (!command) return
    try {
      await copyTextToClipboard(command)
      showToast("Command copied")
    } catch {
      showToast("Could not copy command")
    }
  }

  return (
    <Sheet id={id} depth={depth} widthDepth={widthDepth}>
      {(close) => (
        <>
          <SheetHeader
            title={title}
            icon={icon}
            meta={stateLabel ? <span className="shrink-0 whitespace-nowrap text-[11.5px] text-muted-60">{stateLabel}</span> : undefined}
            // The stop, as the sub-agent drawer's: the header's far-right check (DrawerStopCheck), only
            // for an operation frizz can really end. `-mr-1` puts its ink 21px from the edge, where the
            // thread header's sits — this header's `px-4` is 4px wider than that one's `px-3`.
            actions={stop
              ? <span className="-mr-1 flex shrink-0"><DrawerStopCheck {...attr("stop")} {...(kind === "background-shell" ? { "data-stop-background-shell": "" } : {})} label={stop.label} stopping={stop.stopping} onStop={stop.onStop} /></span>
              : undefined}
            onClose={close}
          />

          <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
            {unavailable ? (
              <div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-muted">{unavailableText}</div>
            ) : (
              // The drawer body is NEVER gated behind a full-height spinner: a slow first fetch (HTTP pool
              // contention on a busy instance) then reads as "stuck rendering forever" behind a context-free
              // spinner, when the truth is simply "no output has arrived yet". Render the structure up front and
              // state the real situation in the output pane — the <pre> itself lays out a full 512 KB in <35ms,
              // so nothing here is slow to render; the wait is always for the data, and we say so.
              <div className="flex flex-col gap-5">
                <section>
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <h2 className="petite-caps text-[10px] text-muted-65">Command</h2>
                    {command && (
                      <button type="button" onClick={copyCommand} className="button-outline flex items-center gap-1 rounded px-1.5 py-1 text-[10.5px] text-muted outline-none transition-colors hover:bg-panel-2 hover:text-fg focus-visible:ring-1 focus-visible:ring-focus-ink-60">
                        <Copy aria-hidden size={11} /> Copy
                      </button>
                    )}
                  </div>
                  {/* Highlighted only when there IS a command: the fallbacks below are prose, and
                      painting "Command unavailable for this background operation." in shell grammar
                      would colour a sentence as though it were a script. */}
                  {command ? (
                    <CodeBody {...attr("command")} text={command} language="bash" className={commandBlockClass} />
                  ) : (
                    <pre {...attr("command")} className={commandBlockClass}>{loading ? "Loading…" : noCommandText}</pre>
                  )}
                </section>
                <section>
                  <div className="mb-2 flex items-center gap-2">
                    <h2 className="petite-caps text-[10px] text-muted-65">{outputHeading}</h2>
                    {running && <LiveDot aria-hidden hue="shell" data-running-indicator={kind === "monitor" ? "monitor-drawer" : "shell-drawer"} />}
                    {outputNote && <span {...attr("output-note")} className="text-[10.5px] text-muted-60">{outputNote}</span>}
                    {truncated && <span className="text-[10.5px] text-muted-50">Showing latest 512 KB</span>}
                  </div>
                  {output ? (
                    <pre {...attr("output")} className={`font-mono-keep min-h-40 whitespace-pre-wrap break-words ${BLOCK_RADIUS} border border-border bg-inset px-4 py-3 text-[12px] leading-relaxed text-fg/85`}>{output}</pre>
                  ) : (
                    <div {...attr("output")} className={`flex min-h-40 items-center justify-center ${BLOCK_RADIUS} border border-border bg-inset px-4 text-center text-[12px] text-muted-60`}>
                      {emptyText}
                    </div>
                  )}
                </section>
              </div>
            )}
          </div>

          {footer && (
            <footer
              {...attr("stop-note")}
              className="w-full shrink-0 border-t border-border/70 bg-panel/95 px-4 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] text-[11.5px] text-muted-70"
            >
              {footer}
            </footer>
          )}
        </>
      )}
    </Sheet>
  )
}
