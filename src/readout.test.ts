import assert from "node:assert/strict";
import { test } from "node:test";
import { Readout, clockTime, formatDuration, noticeOnlyReadout, renderSupervisorActivity, tildePath, visibleLength } from "./readout.ts";

class Capture {
  chunks: string[] = [];
  constructor(
    readonly isTTY: boolean,
    readonly columns = 100
  ) {}
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  get raw(): string {
    return this.chunks.join("");
  }
  /** What the terminal would actually show: replay the erase-region sequences onto a line buffer. */
  get rendered(): string {
    const lines: string[] = [];
    let line = "";
    for (const chunk of this.chunks) {
      let index = 0;
      while (index < chunk.length) {
        const escape = /^\x1b\[([0-9;?]*)([a-zA-Z])/.exec(chunk.slice(index));
        if (escape) {
          index += escape[0].length;
          const [, params, final] = escape;
          if (final === "A") {
            // Rewind N rows: drop them from the buffer.
            const count = Number(params || "1");
            for (let step = 0; step < count; step++) lines.pop();
          } else if (final === "J") {
            line = "";
          }
          continue;
        }
        const char = chunk[index++]!;
        if (char === "\n") {
          lines.push(line);
          line = "";
        } else if (char === "\r") {
          line = "";
        } else {
          line += char;
        }
      }
    }
    if (line) lines.push(line);
    return lines.join("\n");
  }
}

test("formatDuration reads naturally at every magnitude", () => {
  assert.equal(formatDuration(412), "412ms");
  assert.equal(formatDuration(1_240), "1.2s");
  assert.equal(formatDuration(34_300), "34s");
});

test("paths under home are shortened so the block stays narrow", () => {
  assert.equal(tildePath("/Users/x/code/frizz", "/Users/x"), "~/code/frizz");
  assert.equal(tildePath("/Users/x", "/Users/x"), "~");
  // The remainder opens with `\` on Windows; that collapses too (Windows audit 2026-09-11, finding 14).
  assert.equal(tildePath("C:\\Users\\x\\code\\frizz", "C:\\Users\\x"), "~\\code\\frizz");
  assert.equal(tildePath("C:\\Users\\x", "C:\\Users\\x"), "~");
  assert.equal(tildePath("C:\\Users\\xavier\\code", "C:\\Users\\x"), "C:\\Users\\xavier\\code");
  assert.equal(tildePath("/opt/other", "/Users/x"), "/opt/other");
  assert.equal(tildePath("/Users/xanadu/thing", "/Users/x"), "/Users/xanadu/thing");
});

test("a TTY boot repaints one region rather than accumulating rows", () => {
  const out = new Capture(true);
  const readout = new Readout({ output: out, color: false, version: "0.1.2", tickMs: 60_000 });
  readout.plan([
    { key: "workspace", label: "Workspace" },
    { key: "server", label: "Server" },
  ]);
  readout.begin("workspace");
  readout.settle("workspace", "done", "frizz");
  readout.begin("server", "starting");

  const shown = out.rendered;
  // Each step appears EXACTLY once on screen despite many repaints — that is the whole point.
  assert.equal(shown.match(/Workspace/g)?.length, 1, shown);
  assert.equal(shown.match(/Server/g)?.length, 1, shown);
  assert.match(shown, /✓ {2}Workspace\s+frizz/);
  assert.match(shown, /Server\s+starting/);
  // The repaint really is a rewind, not just newlines.
  assert.match(out.raw, /\x1b\[\d+A/);
});

test("the repaint is wrapped in synchronized output so a frame cannot be caught half-drawn", () => {
  const out = new Capture(true);
  const readout = new Readout({ output: out, color: false, tickMs: 60_000 });
  readout.plan([{ key: "server", label: "Server" }]);
  assert.match(out.raw, /\x1b\[\?2026h/);
  assert.match(out.raw, /\x1b\[\?2026l/);
  readout.stop();
});

test("rows are truncated to the terminal width so a wrap can never desynchronize the region", () => {
  const out = new Capture(true, 40);
  const readout = new Readout({ output: out, color: false, tickMs: 60_000 });
  readout.plan([{ key: "artifact", label: "Artifact" }]);
  readout.begin("artifact", "x".repeat(300));
  for (const line of out.rendered.split("\n")) {
    assert.equal(visibleLength(line) <= 39, true, `row exceeded the width: ${line.length}`);
  }
  readout.stop();
});

test("the ready block names one address, and it is the one to open", () => {
  const out = new Capture(true);
  const readout = new Readout({ output: out, color: false, version: "0.1.2", tickMs: 60_000 });
  readout.plan([{ key: "server", label: "Server" }]);
  readout.begin("server");
  readout.ready(
    [
      { label: "Local", value: "http://127.0.0.1:4923/", accent: true },
      { label: "Project", value: "frizz — ~/code/frizz" },
      { label: "Logs", value: "~/.frizz/projects/abc/logs/frizz-1.log" },
    ],
    "press ctrl-c to stop"
  );
  const shown = out.rendered;
  assert.match(shown, /FRIZZ v0\.1\.2\s+ready in/);
  assert.match(shown, /➜ {2}Local:\s+http:\/\/127\.0\.0\.1:4923\//);
  assert.match(shown, /➜ {2}Logs:\s+~\/\.frizz/);
  assert.match(shown, /press ctrl-c to stop/);
  // Exactly one address — the child's private port must never appear beside it.
  assert.equal(shown.match(/http:\/\//g)?.length, 1, shown);
  // The boot steps are replaced by the block, not left above it.
  assert.equal(shown.includes("Server"), false, shown);
});

test("reopening an already-running server reports what it found, not a boot time", () => {
  const tty = new Capture(true);
  const readout = new Readout({ output: tty, color: false, version: "0.1.2", tickMs: 60_000 });
  readout.plan([{ key: "server", label: "Server" }]);
  readout.begin("server");
  readout.ready(
    [{ label: "Local", value: "http://127.0.0.1:4923/", accent: true }],
    "reopened the server already running for this project · run frizz-dev --stop to stop it",
    { status: "already running on port 4923" }
  );
  const shown = tty.rendered;
  assert.match(shown, /FRIZZ v0\.1\.2\s+already running on port 4923/);
  // "ready in 0ms" beside a reused server reads as an implausibly fast cold boot.
  assert.equal(/ready in/.test(shown), false, shown);
  // Ctrl-C would not stop a server this launch does not own.
  assert.equal(shown.includes("press ctrl-c"), false, shown);
  assert.match(shown, /reopened the server already running for this project/);
  assert.match(shown, /run frizz-dev --stop to stop it/);

  // The piped/non-TTY records carry the same distinction.
  const piped = new Capture(false);
  const plain = new Readout({ output: piped, color: false, tickMs: 60_000 });
  plain.ready([{ label: "Local", value: "http://127.0.0.1:4923/" }], undefined, {
    status: "already running on port 4923",
  });
  assert.match(piped.rendered, /frizz: already running on port 4923/);
  assert.equal(/frizz: ready in/.test(piped.rendered), false, piped.rendered);
});

test("labels in the ready block align on one column regardless of length", () => {
  const out = new Capture(true);
  const readout = new Readout({ output: out, color: false, tickMs: 60_000 });
  readout.ready([
    { label: "Local", value: "A" },
    { label: "Project", value: "B" },
  ]);
  const rows = out.rendered.split("\n").filter((line) => line.includes("➜"));
  assert.equal(rows.length, 2);
  const columns = rows.map((row) => row.indexOf(row.trimEnd().slice(-1)));
  assert.equal(columns[0], columns[1], `values must start at the same column:\n${rows.join("\n")}`);
});

test("a failure names the step it died in and where to read the whole story", () => {
  const out = new Capture(true);
  const readout = new Readout({ output: out, color: false, tickMs: 60_000 });
  readout.plan([{ key: "server", label: "Server" }]);
  readout.begin("server");
  assert.equal(readout.activeStep()?.key, "server");
  readout.fail("server: port 4923 is already in use", "/tmp/logs/frizz-1.log");
  const shown = out.rendered;
  assert.match(shown, /✗ {2}Frizz could not start/);
  assert.match(shown, /port 4923 is already in use/);
  assert.match(shown, /Full log: \/tmp\/logs\/frizz-1\.log/);
});

test("a note scrolls above the region instead of landing inside it", () => {
  const out = new Capture(true);
  const readout = new Readout({ output: out, color: false, tickMs: 60_000 });
  readout.plan([{ key: "server", label: "Server" }]);
  readout.begin("server");
  readout.note("warning: port 9494 is in use");
  const lines = out.rendered.split("\n");
  const noteRow = lines.findIndex((line) => line.includes("warning: port 9494 is in use"));
  const stepRow = lines.findIndex((line) => line.includes("Server"));
  assert.notEqual(noteRow, -1);
  assert.equal(noteRow < stepRow, true, `the note must stay above the region:\n${out.rendered}`);
  readout.stop();
});

test("a pipe gets newline-delimited records and never an escape sequence", () => {
  const out = new Capture(false);
  const readout = new Readout({ output: out, color: false, version: "0.1.2", tickMs: 60_000 });
  readout.plan([{ key: "server", label: "Server" }]);
  readout.begin("server", "starting");
  readout.settle("server", "done");
  readout.ready([{ label: "Local", value: "http://127.0.0.1:4923/" }]);
  const raw = out.raw;
  assert.equal(raw.includes("\x1b"), false, "a pipe must never receive terminal control codes");
  assert.match(raw, /frizz: ··· server — starting\n/);
  assert.match(raw, /frizz: done server\n/);
  assert.match(raw, /frizz: ready in /);
  assert.match(raw, /frizz: local: http:\/\/127\.0\.0\.1:4923\/\n/);
});

test("--debug streams records, suppresses the repaint, and does not duplicate the feed", () => {
  const out = new Capture(true);
  const readout = new Readout({ output: out, color: false, debug: true, tickMs: 60_000 });
  readout.plan([{ key: "server", label: "Server" }]);
  readout.begin("server", "starting");
  readout.note("12:00:00 INFO  supervisor   starting Frizz");
  assert.equal(out.raw.includes("\x1b["), false, "debug mode must not repaint");
  assert.match(out.raw, /12:00:00 INFO {2}supervisor {3}starting Frizz/);
  // The log feed is the authoritative account under --debug; the step rows would restate it in a
  // second format right beside it.
  assert.equal(out.raw.includes("frizz: ··· server"), false, out.raw);
  // The final summary still prints — it carries the URL, which the feed does not present as such.
  readout.ready([{ label: "Local", value: "http://127.0.0.1:4923/" }]);
  assert.match(out.raw, /frizz: local: http:\/\/127\.0\.0\.1:4923\//);
});

test("colour is suppressed when asked, and emitted when not", () => {
  const plain = new Capture(true);
  new Readout({ output: plain, color: false, tickMs: 60_000 }).plan([{ key: "a", label: "A" }]);
  assert.equal(/\x1b\[3\dm/.test(plain.raw), false);

  const colored = new Capture(true);
  new Readout({ output: colored, color: true, tickMs: 60_000 }).plan([{ key: "a", label: "A" }]);
  assert.equal(/\x1b\[3\dm/.test(colored.raw), true);
});

test("a lifecycle notice prints under the ready block without disturbing it", () => {
  const out = new Capture(true);
  const at = Date.UTC(2026, 0, 2, 3, 4, 5);
  const readout = new Readout({ output: out, color: false, now: () => at + new Date(at).getTimezoneOffset() * 60_000 });
  readout.plan([{ key: "server", label: "Server" }]);
  readout.begin("server");
  readout.ready([{ label: "Local", value: "http://127.0.0.1:3939" }], "press ctrl-c to stop");
  const before = out.rendered;
  readout.notice("progress", "Restarting", "Restart Frizz requested from browser");
  readout.notice("done", "Restarted", "in 1.2s");
  const rendered = out.rendered;
  assert.ok(rendered.startsWith(before), "the ready block stays exactly as it was printed");
  const added = rendered.slice(before.length).split("\n").filter((line) => line.trim());
  assert.deepEqual(added, [
    "  ↻  03:04:05  Restarting  Restart Frizz requested from browser",
    "  ✓  03:04:05  Restarted   in 1.2s",
  ]);
});

test("a notice while a pane has the screen waits for it to close, and keeps the time it was noticed", () => {
  const out = new Capture(true);
  const start = Date.UTC(2026, 0, 2, 3, 4, 5) + new Date(Date.UTC(2026, 0, 2)).getTimezoneOffset() * 60_000;
  let at = start;
  const readout = new Readout({ output: out, color: false, now: () => at });
  readout.plan([{ key: "server", label: "Server" }]);
  readout.begin("server");
  readout.ready([{ label: "Local", value: "http://127.0.0.1:3939" }], "press ctrl-c to stop");
  const before = out.raw;
  readout.hold();
  readout.notice("progress", "Restarting", "Restart Frizz requested from browser");
  at += 4_000;
  readout.notice("done", "Restarted", "in 4.0s");
  readout.note("a warning");
  assert.equal(out.raw, before, "nothing reaches the screen the pane is drawing on");
  at += 60_000;
  readout.release();
  const added = out.raw.slice(before.length).split("\n").filter((line) => line.trim());
  assert.deepEqual(added, [
    "  ↻  03:04:05  Restarting  Restart Frizz requested from browser",
    "  ✓  03:04:09  Restarted   in 4.0s",
    "a warning",
  ]);
  readout.notice("done", "Remote", "localhost only");
  assert.match(out.raw, /03:05:09  Remote\s+localhost only\n$/, "and once released, a notice prints straight away");
});

test("a notice still reaches a pipe, where there is no cursor to move", () => {
  const out = new Capture(false);
  const readout = new Readout({ output: out, color: false });
  readout.notice("failed", "Failed", "control plane stopped (signal SIGKILL)");
  assert.equal(out.raw, "frizz: failed — control plane stopped (signal SIGKILL)\n");
});

test("supervisor beats map onto the terminal's own vocabulary", () => {
  const out = new Capture(true);
  const readout = noticeOnlyReadout({ output: out, color: false, now: () => 0 });
  for (const event of [
    { kind: "restarting" as const, message: "unexpected control-plane exit" },
    { kind: "updating" as const, message: "preparing the new build" },
    { kind: "ready" as const, message: "control plane ready", ms: 1_240 },
    { kind: "failed" as const, message: "the update could not be prepared" },
  ]) renderSupervisorActivity(readout, event);
  const rows = out.rendered.split("\n").filter((line) => line.trim()).map((line) => line.replace(/\d\d:\d\d:\d\d/, "TIME"));
  assert.deepEqual(rows, [
    "  ↻  TIME  Restarting  unexpected control-plane exit",
    "  ↻  TIME  Updating    preparing the new build",
    "  ✓  TIME  Restarted   in 1.2s",
    "  ✗  TIME  Failed      the update could not be prepared",
  ]);
});

test("a notice-only readout never paints a boot region over the terminal it inherited", async () => {
  const out = new Capture(true);
  const readout = noticeOnlyReadout({ output: out, color: false, tickMs: 1 });
  await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  assert.equal(out.raw, "", "nothing at all until there is a beat to report");
  readout.notice("done", "Updated", "now serving abc123");
  assert.match(out.raw, /Updated\s+now serving abc123/);
});

test("the clock stamp is what a person reads off a scrolled-back terminal", () => {
  const noon = new Date(2026, 5, 1, 9, 7, 3).getTime();
  assert.equal(clockTime(noon), "09:07:03");
});
