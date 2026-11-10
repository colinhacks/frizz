// The suite's own completeness guard — scripts/run-tests.mjs and friends. It is the thing that makes
// a green run mean something, so it gets tested at both levels: the reconciliation rules on their
// own, and one real end-to-end run proving a file's own tally and the parent's reporter agree.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { reconcile } from "./lib/test-guard-reconcile.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);

const file = (name, pass, extra = {}) => ({ file: name, pass, fail: 0, capable: true, ...extra });

test("a run whose tallies agree raises nothing", () => {
  const problems = reconcile({
    emitted: [file("a.test.ts", 12), file("b.test.ts", 30)],
    received: [
      ["a.test.ts", 12],
      ["b.test.ts", 30],
    ],
    runnerSaidGreen: true,
  });
  assert.deepEqual(problems, []);
});

test("a file whose verdicts did not all reach the reporter is named, with the shortfall", () => {
  const problems = reconcile({
    emitted: [file("a.test.ts", 12), file("delivery-ledger.test.ts", 70)],
    received: [
      ["a.test.ts", 12],
      ["delivery-ledger.test.ts", 39],
    ],
    runnerSaidGreen: true,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /delivery-ledger\.test\.ts: ran 70 tests but only 39 reached the reporter — 31 lost/);
});

test("a file that reported results without recording its own tally is caught", () => {
  const problems = reconcile({
    emitted: [file("a.test.ts", 12)],
    received: [
      ["a.test.ts", 12],
      ["b.test.ts", 4],
    ],
    runnerSaidGreen: true,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /b\.test\.ts: reported results but never recorded its own tally/);
});

test("losing the whole ledger fails the run rather than passing it quietly", () => {
  const problems = reconcile({ emitted: [], received: [["a.test.ts", 12]], runnerSaidGreen: true });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /did not load, so nothing about this run is verified/);
});

test("a child that cannot make its report pipe blocking says so", () => {
  const problems = reconcile({
    emitted: [file("a.test.ts", 12, { capable: false })],
    received: [["a.test.ts", 12]],
    runnerSaidGreen: true,
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /cannot put the report pipe in blocking mode/);
});

test("an already-red run is not also accused of being unverifiable", () => {
  // The runner's own failure is the headline; a second complaint about bookkeeping would bury it.
  const problems = reconcile({ emitted: [], received: [["a.test.ts", 12]], runnerSaidGreen: false });
  assert.deepEqual(problems, ["a.test.ts: reported results but never recorded its own tally"]);
});

test("the same file under two path spellings is one file, not two", () => {
  const problems = reconcile({
    emitted: [file("/private/tmp/a.test.mjs", 3)],
    received: [["/private/tmp/a.test.mjs", 3]],
    runnerSaidGreen: true,
  });
  assert.deepEqual(problems, []);
});

test("a file ended because it would not exit is one failure, not also a miscount", () => {
  // The preload ends it with exit 1 after every test passed, and the parent fails the file for that:
  // one verdict more than the file emitted, which is the verdict wanted.
  const held = ["a server still listening"];
  assert.deepEqual(reconcile({ emitted: [file("leaky.test.ts", 3, { held })], received: [["leaky.test.ts", 4]], runnerSaidGreen: false }), []);
  // The allowance is that one verdict and nothing wider.
  assert.match(reconcile({ emitted: [file("leaky.test.ts", 3, { held })], received: [["leaky.test.ts", 5]], runnerSaidGreen: false })[0], /reporter counted 5 tests but the file only emitted 3/);
  assert.match(reconcile({ emitted: [file("leaky.test.ts", 3, { held })], received: [["leaky.test.ts", 2]], runnerSaidGreen: false })[0], /ran 3 tests but only 2 reached the reporter/);
  assert.match(reconcile({ emitted: [file("fine.test.ts", 3)], received: [["fine.test.ts", 4]], runnerSaidGreen: false })[0], /reporter counted 4 tests but the file only emitted 3/);
});

// The suite ran under `--test-force-exit` until 2026-11-10, which ended every file the moment its
// tests were done and so never showed one that could not end. These two runs are the preload doing
// that job by name instead: a real runner, a real file, a real server left listening.
const guardedRun = (source, extraEnv = {}) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "frizz-test-guard-exit-"));
  try {
    const fixture = path.join(scratch, "fixture.test.mjs");
    fs.writeFileSync(fixture, source.join("\n"));
    const env = { ...process.env, FRIZZ_TEST_EXIT_GRACE_MS: "1500", ...extraEnv };
    delete env.NODE_TEST_CONTEXT;
    delete env.FRIZZ_TEST_LEDGER;
    delete env.FRIZZ_TEST_GUARD_NO_BLOCKING;
    const startedAt = Date.now();
    const result = spawnSync(process.execPath, [path.join(here, "run-tests.mjs"), fixture], { cwd: root, encoding: "utf8", env, timeout: 120_000 });
    return { ...result, ms: Date.now() - startedAt, output: `${result.stdout}\n${result.stderr}` };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
};

const LEAKY = [
  'import test from "node:test";',
  'import { createServer } from "node:http";',
  'test("leaves a server listening and a timer armed", async () => {',
  "  const server = createServer(() => {});",
  '  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));',
  "  setInterval(function leftRunning() {}, 1000);",
  "});",
];

test("a file still running after its tests is failed, and told what holds it open", () => {
  const run = guardedRun(LEAKY);
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /fixture\.test\.mjs did not exit\. Its tests finished [12]s ago and its process is still running, held open by:/);
  assert.match(run.output, /a server still listening: \{"address":"127\.0\.0\.1"/);
  assert.match(run.output, /1 timer still armed/);
  assert.match(run.output, /FRIZZ_TEST_EXIT_TRACE=1 nub run test /);
  assert.match(run.output, /✖ 1 test file did not exit after the tests in it finished:/, "and the run says so again at its end");
  assert.doesNotMatch(run.output, /INCOMPLETE TEST RUN/, "the file's one failure is not also reported as lost results");
  assert.match(run.output, /ℹ pass 1\b/, "its own test still counts as passed");
});

test("asked for a trace, it names the line that armed the timer", () => {
  const run = guardedRun(LEAKY, { FRIZZ_TEST_EXIT_TRACE: "1" });
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /Timeout \(1000ms, repeating\) created at .*fixture\.test\.mjs:6/);
  // The server's handle is made inside node, after a lookup, with none of the file's frames on the
  // stack. It is still named, by its address.
  assert.match(run.output, /a server still listening: \{"address":"127\.0\.0\.1"/);
});

test("a file that cleans up in a slow `after` hook is not mistaken for one that will not exit", () => {
  // The hook outlasts the grace. The grace runs from the file's last `after` hook, not from the end
  // of its tests, so the file ends by itself and nothing is said.
  const run = guardedRun([
    'import test, { after } from "node:test";',
    'import { createServer } from "node:http";',
    "let server;",
    'test("opens a server", async () => {',
    "  server = createServer(() => {});",
    '  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));',
    "  setTimeout(() => {}, 60_000).unref();",
    "});",
    "after(async () => {",
    "  await new Promise((resolve) => setTimeout(resolve, 2500));",
    "  await new Promise((resolve) => server.close(resolve));",
    "});",
  ]);
  assert.equal(run.status, 0, run.output);
  assert.doesNotMatch(run.output, /did not exit/);
  assert.ok(run.ms < 30_000, `it ended by itself: ${run.ms}ms`);
});

test("an `after` hook that never returns is ended too, and named as that", () => {
  const run = guardedRun(
    ['import test, { after } from "node:test";', 'test("passes", () => {});', "after(() => new Promise(() => { setInterval(() => {}, 1000); }));"],
    { FRIZZ_TEST_HOOK_GRACE_MS: "2000" },
  );
  assert.equal(run.status, 1, run.output);
  assert.match(run.output, /fixture\.test\.mjs did not finish\. Its tests ended 2s ago and its `after` hooks have still not all returned\./);
});

test("a file that starts more tests after its hooks have run is left to finish them", () => {
  // Node runs a file's `after` hooks as soon as nothing is running, and a top-level await between two
  // tests is such a moment. The second test here outlasts the grace twice over, with a timer held
  // through it, and the file must not be ended under it.
  const run = guardedRun([
    'import test, { after } from "node:test";',
    "after(() => {});",
    'test("first", () => {});',
    "await new Promise((resolve) => setTimeout(resolve, 300));",
    'test("second, long after the hooks ran", async () => { await new Promise((resolve) => setTimeout(resolve, 3500)); });',
  ]);
  assert.equal(run.status, 0, run.output);
  assert.doesNotMatch(run.output, /did not exit|did not finish/);
  assert.match(run.output, /ℹ pass 2\b/);
});

test("end to end, a real run's own tally matches what the parent received", () => {
  // The unit tests above pin the rules; this pins the two INSTRUMENTS that feed them — the preload's
  // count of verdicts a child emits, and the reporter's count of what arrived. A test name holding
  // the literal event type is in there on purpose: the preload matches the serializer's
  // length-prefixed form, so the name must not inflate the count.
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "frizz-test-guard-selftest-"));
  try {
    const fixture = path.join(scratch, "fixture.test.mjs");
    fs.writeFileSync(
      fixture,
      [
        'import test from "node:test";',
        'test("plain", () => {});',
        'test("a name that says test:pass in it", () => {});',
        'test("with a subtest", async (t) => { await t.test("nested", () => {}); });',
      ].join("\n"),
    );

    // NODE_TEST_CONTEXT and FRIZZ_TEST_LEDGER are set on us because we are ourselves a test-runner
    // child; leaving them set would make the inner runner think it too was a child and emit
    // serialized frames instead of the spec output this asserts on.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.FRIZZ_TEST_LEDGER;
    delete env.FRIZZ_TEST_GUARD_NO_BLOCKING;

    const result = spawnSync(process.execPath, [path.join(here, "run-tests.mjs"), fixture], {
      cwd: root,
      encoding: "utf8",
      env,
    });

    assert.equal(result.status, 0, `guarded run should pass:\n${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stderr, /INCOMPLETE TEST RUN/);
    // 3 top-level + 1 nested, all of which must reach the parent.
    assert.match(result.stdout, /ℹ tests 4\b/);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
