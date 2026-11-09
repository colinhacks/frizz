import { log as frizzLog } from "./logging.ts"

// ONE PERIODIC JOB PER TURN OF THE EVENT LOOP.
//
// Every open project runs its own tailer tick and its own scheduler tick on its own timer, and Node runs every
// timer that is due before it looks at a socket again. So with 21 projects, ticks that cost 50ms each join up into
// a stretch of a second or more with no request answered, though none of them is slow on its own: 15s of every 5
// minutes on the live server went to long stretches of timers (profiled 2026-11-06).
//
// A job handed here runs now if nothing is ahead of it. Otherwise it waits for the next check phase, which comes
// after the loop has polled for I/O. It delays a tick by one pass of the loop, not by a period.

const waiting: Array<() => void> = []
let busy = false

function runNext(): void {
  const job = waiting.shift()
  if (!job) {
    busy = false
    return
  }
  try {
    job()
  } catch (error) {
    frizzLog.error("server", `periodic job threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  }
  setImmediate(runNext)
}

export function takeLoopTurn(job: () => void): void {
  waiting.push(job)
  if (busy) return
  busy = true
  runNext()
}
