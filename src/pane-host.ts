/**
 * One owner for the launcher's keyboard.
 *
 * Raw mode is a global: whoever turns it on owns every keystroke and owes the shell a restore on
 * every exit path. Two panes each doing that would fight over stdin and race to restore it. So the
 * host holds raw mode alone, routes keys — to the open pane while one is open, otherwise to whatever
 * pane the key is bound to — and re-raises ^C by hand, because raw mode stops the TTY doing it.
 *
 * TTY only. Under a pipe, CI, or `--debug` there is no keyboard and no cursor addressing, so the host
 * does not install and the plain records path is untouched.
 */

export interface Pane {
  /**
   * Show the pane. False means there is nothing to show, and the host leaves the terminal alone. `handle`
   * closes the pane later, for one that learns it is done only after the key that did it has returned.
   */
  open(handle?: PaneHandle): boolean;
  /** A key while this pane is open. Return "close" to hand the terminal back. */
  key(key: string): "close" | "keep";
  /** Take the pane down — after "close", or at shutdown. Must be safe to call when not open. */
  close(): void;
}

export interface PaneHandle {
  /**
   * Hand the terminal back, as a key answered "close" would. The R menu needs it: the server decides what
   * a key does there, and its answer arrives after `key` has returned. A no-op once the pane is closed.
   */
  close(): void;
}

export interface PaneHost {
  /** Restore the terminal and stop listening. Safe to call more than once. */
  dispose(): void;
  /** Whether a pane currently has the screen. */
  isOpen(): boolean;
  /**
   * Put raw mode back after another process on this terminal took it away. Call it whenever a process
   * that inherited the terminal exits: Node restores every TTY on its stdio to the settings it saw when
   * IT started, so a control-plane child forked before raw mode was on hands the terminal back cooked
   * on its way out — R then echoes and waits for Enter, and never reaches the host. Safe at any time,
   * and a no-op once disposed.
   */
  reclaim(): void;
}

export interface PaneHostOptions {
  /** Key → pane. Bind both cases of a letter yourself; the host matches keys verbatim. */
  bindings: Record<string, Pane>;
  input?: NodeJS.ReadStream;
  output?: NodeJS.WriteStream;
  /** How ^C is re-raised. Injectable because signal delivery is async and therefore untestable inline. */
  onInterrupt?: () => void;
}

const CTRL_C = "\x03";

/**
 * Re-raise ^C as the SIGINT the raw-mode tty swallowed. Dispatched to this process's own listeners
 * rather than through `process.kill(process.pid, "SIGINT")`: on Windows libuv implements a SIGINT
 * sent to a pid as an unconditional TerminateProcess, so the launcher's graceful `stop` handler
 * never ran there — no drain, no "Frizz stopped" farewell, exit 1 (Windows audit 2026-09-11). With
 * no listener installed the kill is the right thing on every platform: Node's default action.
 */
export function raiseInterrupt(): void {
  if (process.listenerCount("SIGINT") > 0) {
    process.emit("SIGINT", "SIGINT");
    return;
  }
  process.kill(process.pid, "SIGINT");
}

export function installPaneHost(options: PaneHostOptions): PaneHost | null {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const onInterrupt = options.onInterrupt ?? raiseInterrupt;
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== "function") return null;

  let active: Pane | null = null;
  let disposed = false;

  const closeActive = () => {
    if (!active) return;
    const pane = active;
    active = null;
    pane.close();
  };

  const onKey = (chunk: Buffer | string) => {
    const key = chunk.toString();
    if (key.includes(CTRL_C)) {
      restore();
      onInterrupt();
      return;
    }
    if (active) {
      if (active.key(key) === "close") closeActive();
      return;
    }
    const pane = options.bindings[key];
    if (pane && pane.open({ close: () => { if (active === pane) closeActive(); } })) active = pane;
  };

  const restore = () => {
    if (disposed) return;
    disposed = true;
    closeActive();
    input.off("data", onKey);
    try {
      input.setRawMode?.(false);
    } catch {
      // The stream may already be torn down during shutdown; nothing left to restore.
    }
    input.pause();
    process.off("exit", restore);
  };

  const reclaim = () => {
    if (disposed) return;
    // Through cooked and back, because libuv skips a switch to the mode it believes is current: a bare
    // setRawMode(true) here writes nothing and the terminal stays cooked (measured on a real pty).
    try {
      input.setRawMode(false);
      input.setRawMode(true);
    } catch {
      // The terminal is gone (its window closed); there is nothing left to reclaim.
    }
  };

  input.setRawMode(true);
  input.resume();
  input.setEncoding("utf8");
  input.on("data", onKey);
  // Belt and braces: an unexpected exit must not leave the shell in raw mode.
  process.on("exit", restore);

  return { dispose: restore, isOpen: () => active !== null, reclaim };
}
