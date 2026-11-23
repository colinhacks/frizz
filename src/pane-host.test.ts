import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { installPaneHost, raiseInterrupt } from "./pane-host.ts";

function fakeTty() {
  const stream = new EventEmitter() as EventEmitter & {
    isTTY: boolean; raw: boolean | undefined; paused: boolean;
    setRawMode(on: boolean): void; resume(): void; pause(): void; setEncoding(): void;
  };
  stream.isTTY = true;
  stream.raw = undefined;
  stream.paused = false;
  stream.setRawMode = (on) => { stream.raw = on; };
  stream.resume = () => { stream.paused = false; };
  stream.pause = () => { stream.paused = true; };
  stream.setEncoding = () => {};
  return stream;
}

// ^C in raw mode reaches the launcher's own SIGINT listener — the graceful stop — instead of a
// self-signal, which on Windows is a hard kill that skips every listener (Windows audit 2026-09-11).
test("^C is dispatched to the process's SIGINT listeners, and raw mode is restored first", () => {
  const input = fakeTty();
  const output = { isTTY: true } as NodeJS.WriteStream;
  const seen: string[] = [];
  const listener = () => seen.push(`raw=${input.raw}`);
  process.on("SIGINT", listener);
  try {
    const host = installPaneHost({ bindings: {}, input: input as never, output });
    assert.ok(host);
    assert.equal(input.raw, true);
    input.emit("data", "\x03");
    assert.deepEqual(seen, ["raw=false"]);
    assert.equal(input.paused, true);
  } finally {
    process.off("SIGINT", listener);
  }
});

// An exiting control-plane child resets the shared terminal to what it saw at its own fork — cooked,
// for the first one. libuv skips a switch to the mode it believes is current, so only a write through
// cooked puts raw back.
test("reclaim rewrites raw mode through cooked, and stops once the host is disposed", () => {
  const input = fakeTty();
  const writes: boolean[] = [];
  const setRawMode = input.setRawMode;
  input.setRawMode = (on) => { writes.push(on); setRawMode(on); };
  const host = installPaneHost({ bindings: {}, input: input as never, output: { isTTY: true } as NodeJS.WriteStream });
  assert.ok(host);
  host.reclaim();
  assert.deepEqual(writes, [true, false, true]);
  assert.equal(input.raw, true);
  host.dispose();
  host.reclaim();
  assert.deepEqual(writes, [true, false, true, false], "a disposed host leaves the shell cooked");
});

// The launchers hold the readout's notices on onOpen and print them on onClose, so the order against the
// pane's own writes is the whole contract: held before the pane's first screen, released after its last.
test("onOpen comes before the pane draws and onClose after it has restored the terminal, however it closes", () => {
  const input = fakeTty();
  const seen: string[] = [];
  let handle: { close(): void } | undefined;
  const pane = {
    open: (h?: { close(): void }) => { handle = h; seen.push("pane open"); return true; },
    key: (key: string) => { seen.push(`key ${key}`); return key === "q" ? "close" as const : "keep" as const; },
    close: () => { seen.push("pane close"); },
  };
  const refusing = { open: () => { seen.push("refused"); return false; }, key: () => "keep" as const, close: () => {} };
  const host = installPaneHost({
    bindings: { r: pane, x: refusing },
    input: input as never,
    output: { isTTY: true } as NodeJS.WriteStream,
    onOpen: () => seen.push("hold"),
    onClose: () => seen.push("release"),
  });
  assert.ok(host);
  input.emit("data", "r");
  input.emit("data", "a");
  input.emit("data", "q");
  input.emit("data", "r");
  handle?.close();
  input.emit("data", "x");
  input.emit("data", "r");
  host.dispose();
  assert.deepEqual(seen, [
    "hold", "pane open", "key a", "key q", "pane close", "release",
    "hold", "pane open", "pane close", "release",
    "hold", "refused", "release",
    "hold", "pane open", "pane close", "release",
  ]);
});

test("with no SIGINT listener the interrupt falls through to a real signal", () => {
  const listeners = process.listeners("SIGINT");
  for (const listener of listeners) process.off("SIGINT", listener as never);
  const original = process.kill;
  const calls: Array<[number, string | number | undefined]> = [];
  process.kill = ((pid: number, signal?: string | number) => { calls.push([pid, signal]); return true; }) as typeof process.kill;
  try {
    raiseInterrupt();
    assert.deepEqual(calls, [[process.pid, "SIGINT"]]);
  } finally {
    process.kill = original;
    for (const listener of listeners) process.on("SIGINT", listener as never);
  }
});
