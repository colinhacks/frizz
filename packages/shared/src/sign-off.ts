// WHAT A MESSAGE SAYS ABOUT THE THREAD'S SIGN-OFF, read off the message itself — the pieces the server's
// projection (server sign-offs.ts, which stamps `TranscriptMessage.signOff`) and the web's queue collapse
// (web lib/queueCollapse) must agree on, so each lives here once.

// A shell command that runs `frizzctl done`, at its start or after anything that begins a new command
// (a newline, `;`, `&&`, `||`, `|`, a subshell). The transcript projects every backend's shell call as
// `Bash`, so one pattern reads Claude, Codex and ACP alike. Not a parse and not meant to be: it answers
// "did this message sign off", where a false positive keeps one extra message unfolded.
const RUNS_FRIZZCTL_DONE = /(?:^|[\n;&|(])\s*frizzctl\s+done(?=\s|$)/

/** The structural minimum of a message's tool calls the check reads. Whole transcript messages satisfy
 *  it: `command` is a shell call's raw text when it ran long or over several lines, `detail` its one-line
 *  summary. */
export interface DoneRegistrationLike {
  tools?: readonly { name?: string; status?: string; detail?: string; command?: string }[]
}

// The message that REGISTERED the thread's completion — a successful `frizzctl done`, or, on a thread
// started before the command line (2026-10-11), a successful `mcp__frizz__done` tool call. Its prose
// IS the handoff: a worker writes the conclusive write-up and calls the verb in the same breath, so the
// projection coalesces both into one message. That message used to fold whenever ANY prose followed it,
// because the run's closing anchor is simply the last prose in the run — and workers routinely append a
// short pointer note after registering ("the report is in the message above…"), which stole the anchor
// and buried the write-up it points at (maintainer 2026-09-02, pullfrog `if-you-were-going-to-migrate`:
// a 340-char afterword anchored the run while the 2,329-char conclusion collapsed by default).
//
// Completed only. A REFUSED registration (`status: "failed"` — the command exits 2 when the gate holds,
// which a shell call reports as a failure) did not stand — the worker re-signs-off,
// and that later message is the one carrying the handoff. `ask`/`watch` deliberately do NOT
// count: neither ends the turn (a worker keeps working past both), and the ask already renders its own
// answerable card at the rest it was asked at (questionAnchors), so the prose around them is mid-run
// narration the fold is right to carry.
//
// The `includes` comes first because the server reads every tool call of a thread on each transcript read
// (server sign-offs.ts), and a shell call's text can be a long heredoc the pattern would scan position by
// position.
export function carriesDoneRegistration(m: DoneRegistrationLike): boolean {
  return (m.tools ?? []).some((t) => {
    if (t.status !== "completed") return false
    if (t.name === "mcp__frizz__done") return true
    if (t.name !== "Bash") return false
    const command = t.command ?? t.detail ?? ""
    return command.includes("frizzctl") && RUNS_FRIZZCTL_DONE.test(command)
  })
}
