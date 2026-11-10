// Loaded with --import into every process node's test runner starts; see scripts/run-tests.mjs.
// Everything here runs in the per-file CHILD process (the parent leaves NODE_TEST_CONTEXT unset).
//
// THREE JOBS. The first two are about a child that exits with verdicts still queued on the ASYNC pipe
// carrying them to the parent: whatever is queued is thrown away, the parent counts only what
// arrived, reports `fail 0` / `cancelled 0`, and exits 0. Measured here 2026-08-16, when the suite ran
// under `--test-force-exit` and every child exited that way: one run of four dropped the last 31 of
// delivery-ledger.test.ts's 70 tests and still looked green. Upstream is nodejs/node#64833, still open.
// The flag is gone (job 3 is what replaced it), and these two stay as the tripwire: a child still
// calls process.exit() when a test does, and when job 3 ends a file that will not end by itself.
//
//  1. Put the report pipe in BLOCKING mode, so those writes complete before the process exits. This
//     is the same remedy as the upstream fix; we apply it from here because upstream has not landed.
//  2. Tally the verdicts this child EMITS and write that tally synchronously from an `exit` handler,
//     which survives the same process.exit() that truncates the pipe. run-tests.mjs reconciles the
//     tally against what the parent actually received, so a drop from any cause — this one or the
//     next one — fails the run loudly instead of passing quietly.
//  3. NAME WHAT KEEPS A FINISHED FILE ALIVE. A file whose tests have all reported, and whose process
//     is still running, left something holding the event loop: a server it never closed, a timer, a
//     child. The suite ran under `--test-force-exit` from 2026-07-24 to 2026-11-10 because one file did
//     that and hung the run forever (claude-agent-broker.test.ts; the leak was a six-hour timer armed
//     after shutdown, a product bug, fixed in b89f6146c). The flag hid every later leak the same way,
//     and with it the errors a test's leftovers raise after the test has ended. So the flag is not
//     passed any more, and this is what stands where it stood: once the file's tests and its
//     `after` hooks are done, an unref'd timer gives the process EXIT_GRACE_MS to end by itself. A
//     process that ends never sees the timer. One that does not gets a list of what holds it and
//     exits 1, which fails the file in ten seconds with a name instead of hanging the run with none.

import async_hooks, { AsyncResource } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";

const ledgerPath = process.env.FRIZZ_TEST_LEDGER;
const entry = process.argv[1] ?? "";

// Only ever act in a test-runner child running one of our own test files. NODE_TEST_CONTEXT is
// inherited by anything a test spawns, so the entry-file check keeps a test's own subprocess from
// writing a bogus ledger line if it ever loads this module.
if (process.env.NODE_TEST_CONTEXT && ledgerPath && /\.test\.(mjs|ts)$/.test(entry)) {
  // `capable` says the remedy is available at all — setBlocking is private API, so a future node
  // could take it away, and run-tests.mjs turns that into a loud failure rather than a quiet return
  // to dropped tests. FRIZZ_TEST_GUARD_NO_BLOCKING=1 leaves it capable but unapplied, which is the
  // negative control: it truncates on purpose so the reconciliation can be shown to go red.
  const handle = process.stdout._handle;
  const capable = typeof handle?.setBlocking === "function";
  const applied = capable && process.env.FRIZZ_TEST_GUARD_NO_BLOCKING !== "1";
  if (applied) handle.setBlocking(true);

  // A verdict crosses the pipe as a v8-serialized event whose `type` is the string "test:pass" or
  // "test:fail". Match the serializer's one-byte-string tag (0x22) and length as well as the text, so
  // a test NAME that happens to contain "test:pass" cannot inflate the count — its own length prefix
  // differs.
  const event = (type) => Buffer.concat([Buffer.from([0x22, type.length]), Buffer.from(type)]);
  const PASS = event("test:pass");
  const FAIL = event("test:fail");
  // Job 3 reads two more: a test is RUNNING between its dequeue and its complete.
  const DEQUEUE = event("test:dequeue");
  const COMPLETE = event("test:complete");
  const LONGEST = Math.max(PASS.length, FAIL.length, DEQUEUE.length, COMPLETE.length);

  let pass = 0;
  let fail = 0;
  let dequeued = 0;
  let completed = 0;
  // A pattern can straddle two writes, so the tail of each chunk is scanned again with the next one.
  // Only a match that ENDS in the new bytes is counted, so nothing is counted twice whatever its
  // length.
  let carry = Buffer.alloc(0);

  const occurrences = (haystack, needle, seen) => {
    let n = 0;
    for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
      if (at + needle.length > seen) n++;
    }
    return n;
  };

  const scan = (chunk, encoding) => {
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(String(chunk), typeof encoding === "string" ? encoding : "utf8");
    const hay = carry.length ? Buffer.concat([carry, buf]) : buf;
    pass += occurrences(hay, PASS, carry.length);
    fail += occurrences(hay, FAIL, carry.length);
    dequeued += occurrences(hay, DEQUEUE, carry.length);
    completed += occurrences(hay, COMPLETE, carry.length);
    carry = Buffer.from(hay.subarray(Math.max(0, hay.length - (LONGEST - 1))));
  };

  // ── Job 3: what keeps a finished file alive ──────────────────────────────────────────────────────
  //
  // WHEN IS A FILE FINISHED? Not when it writes its summary: node writes that from `beforeExit`, which
  // a held process never reaches, so a file that will not exit writes nothing at all after its last
  // verdict (measured, node 26.11). And not when its tests are done: its own `after` hooks run next,
  // and a hook closing a browser takes seconds. So the clock starts when the file's LAST root `after`
  // hook has run. Ours is registered first, from here, before the file has loaded; when it runs it
  // registers a second one on the root, and node runs the hooks down a live list, so that one runs
  // after every hook the file registered (`lastHook` below).
  //
  // Two things keep that honest:
  //
  // - A file whose hooks never finish hangs a run just as silently. It gets HOOK_GRACE_MS from the end
  //   of its tests, and is told that instead. A node that stops running the late hook lands here too,
  //   which is slower and still ends the file; test-guard.test.mjs fails on it.
  // - A file can start more tests after node has run its hooks (a top-level await between two tests
  //   does it). The clock is pushed back by every report write, and it never ends a file while a test
  //   is between its dequeue and its complete.
  const EXIT_GRACE_MS = Number(process.env.FRIZZ_TEST_EXIT_GRACE_MS) || 10_000;
  const HOOK_GRACE_MS = Number(process.env.FRIZZ_TEST_HOOK_GRACE_MS) || 120_000;
  // WHERE each holder was created costs a stack per timer and socket, and switches every promise in
  // the file onto the slow path, so it is asked for by name on the one file that failed.
  const TRACE = process.env.FRIZZ_TEST_EXIT_TRACE === "1";
  const TRACED = new Set(["Timeout", "Immediate", "TCPSERVERWRAP", "PIPESERVERWRAP", "TCPWRAP", "PIPEWRAP", "PROCESSWRAP", "FSEVENTWRAP", "STATWATCHER", "UDPWRAP", "SIGNALWRAP", "WORKER", "MESSAGEPORT", "TLSWRAP", "HTTPCLIENTREQUEST"]);
  const born = new Map();
  if (TRACE) {
    async_hooks
      .createHook({
        init(id, type, _trigger, resource) {
          if (!TRACED.has(type)) return;
          // Only frames outside node say anything: `setInterval (node:timers:169:19)` is every timer.
          const frames = (new Error().stack ?? "")
            .split("\n")
            .slice(2)
            .map((line) => line.trim().replace(/^at /, ""))
            .filter((line) => !/\(?node:/.test(line) && !line.includes("test-guard-preload"));
          // Nothing of the file's own on the stack: the runner's pipes, or something node armed for itself.
          if (frames.length === 0) return;
          born.set(id, { type, frames: frames.slice(0, 4), resource: new WeakRef(resource) });
        },
        destroy(id) {
          born.delete(id);
        },
      })
      .enable();
  }

  const describeHandle = (handle) => {
    const kind = handle?.constructor?.name ?? "handle";
    try {
      if (kind === "ChildProcess") return `a child process still running: pid ${handle.pid}, ${[handle.spawnfile, ...(handle.spawnargs ?? []).slice(1, 4)].join(" ").slice(0, 160)}`;
      if (kind === "Server") return `a server still listening: ${JSON.stringify(handle.address?.() ?? null)}`;
      if (kind === "Socket") {
        // The runner's own pipes to the parent are always open; they hold nothing.
        if (handle === process.stdout || handle === process.stderr || handle === process.stdin) return null;
        const where = handle.remoteAddress ? `${handle.remoteAddress}:${handle.remotePort}` : handle.path ?? `fd ${handle._handle?.fd ?? "?"}`;
        return `a socket still open: ${where}`;
      }
      if (kind === "FSWatcher" || kind === "StatWatcher") return "a file watcher still open";
      if (kind === "Timeout" || kind === "Timer") return null; // counted from the resource list below
    } catch {
      // Describing a handle must not be what breaks the report.
    }
    return `a ${kind} still open`;
  };

  let held = null;
  const reportHeld = () => {
    const lines = [];
    try {
      for (const handle of process._getActiveHandles?.() ?? []) {
        const line = describeHandle(handle);
        if (line) lines.push(line);
      }
      const resources = process.getActiveResourcesInfo?.() ?? [];
      const timers = resources.filter((kind) => kind === "Timeout").length;
      if (timers > 0) lines.push(`${timers} timer${timers === 1 ? "" : "s"} still armed`);
      const requests = resources.filter((kind) => /ReqWrap|REQ/i.test(kind));
      if (requests.length > 0) lines.push(`${requests.length} request${requests.length === 1 ? "" : "s"} still in flight: ${[...new Set(requests)].join(", ")}`);
      if (lines.length === 0 && resources.length > 0) lines.push(`still active: ${[...new Set(resources)].join(", ")}`);
      for (const { type, frames, resource } of born.values()) {
        const live = resource.deref();
        if (!live) continue;
        if (typeof live.hasRef === "function" && !live.hasRef()) continue;
        if (type === "Timeout" && live._destroyed) continue;
        const detail = type === "Timeout" ? ` (${live._idleTimeout}ms${live._repeat ? ", repeating" : ""})` : "";
        lines.push(`${type}${detail} created at ${frames[0]}${frames.slice(1).map((frame) => `\n      ${frame}`).join("")}`);
      }
    } catch {
      // Fall through with whatever was gathered.
    }
    held = lines.length > 0 ? lines : ["nothing this probe can name"];
    const inRepo = path.relative(process.cwd(), entry);
    const name = inRepo.startsWith("..") ? entry : inRepo;
    const ago = `${Math.round((Date.now() - testsDoneAt) / 1000)}s ago`;
    const text = [
      "",
      hooksDone
        ? `✖ ${name} did not exit. Its tests finished ${ago} and its process is still running, held open by:`
        : `✖ ${name} did not finish. Its tests ended ${ago} and its \`after\` hooks have still not all returned. Its process holds:`,
      ...held.map((line) => `    ${line}`),
      "  Close each of these in the test that opened it, or unref it in the code under test.",
      ...(TRACE ? [] : [`  To see where each was created: FRIZZ_TEST_EXIT_TRACE=1 nub run test ${name}`]),
      "",
    ].join("\n");
    try {
      process.stderr._handle?.setBlocking?.(true);
      process.stderr.write(text);
    } catch {
      // The ledger line below still names the file.
    }
    process.exit(1);
  };

  let grace = null;
  let testsDoneAt = 0;
  let hooksDone = false;
  const giveItUntil = (ms) => {
    if (grace) clearTimeout(grace);
    grace = setTimeout(() => {
      // A test is running: this file is not finished, whatever its hooks said.
      if (dequeued > completed) return void grace.refresh();
      reportHeld();
    }, ms);
    grace.unref();
  };
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, encoding, callback) => {
    try {
      scan(chunk, encoding);
    } catch {
      // Counting must never be the thing that breaks a test run; a miscount surfaces as a loud
      // reconciliation failure, which is the safe direction.
    }
    grace?.refresh();
    return write(chunk, encoding, callback);
  };

  const { after } = await import("node:test");
  // Captured here, outside any test: a hook registered from inside a hook belongs to THAT hook and
  // runs the moment it ends. Registered through this, it belongs to the file's root.
  const root = new AsyncResource("frizz-test-guard");
  const lastHook = () => {
    hooksDone = true;
    giveItUntil(EXIT_GRACE_MS);
  };
  after(() => {
    testsDoneAt = Date.now();
    giveItUntil(HOOK_GRACE_MS);
    root.runInAsyncScope(() => after(lastHook));
  });

  process.on("exit", () => {
    try {
      fs.appendFileSync(ledgerPath, `${JSON.stringify({ file: entry, pass, fail, capable, ...(held ? { held } : {}) })}\n`);
    } catch {
      // A missing line reads as a missing file to run-tests.mjs, which fails the run.
    }
  });
}
