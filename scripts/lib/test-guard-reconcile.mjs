// The completeness check behind `nub run test` — see scripts/run-tests.mjs for why it exists.
//
// Pure on purpose: run-tests.mjs does the file reading and the process handling, this decides
// whether a run proved anything. Every problem it returns is a reason the run must NOT be green.

// `emitted` — what each test file tallied for itself, from scripts/test-guard-preload.mjs, with
//   `held` on a file that was still running after its tests and had to be ended.
// `received` — what reached the parent's reporter, from scripts/test-guard-reporter.mjs.
// `runnerSaidGreen` gates the checks that ask whether the run was VERIFIABLE at all: when the runner
// has already failed, the run is red anyway and a second complaint about missing bookkeeping would
// only bury the real failure.
export function reconcile({ emitted, received, runnerSaidGreen, describe = (file) => file }) {
  const problems = [];

  for (const entry of emitted) {
    if (!entry.capable) {
      problems.push(`${describe(entry.file)}: cannot put the report pipe in blocking mode — the guard against dropped results is not in force`);
    }
  }

  const emittedByFile = tally(emitted.map((entry) => [entry.file, entry.pass + entry.fail]));
  const receivedByFile = tally(received);

  // An empty ledger next to a reporter full of verdicts means the per-file bookkeeping never ran —
  // the exact shape of "green but unproven" this guard exists to refuse.
  if (runnerSaidGreen && receivedByFile.size > 0 && emittedByFile.size === 0) {
    problems.push("no test file recorded its own tally — scripts/test-guard-preload.mjs did not load, so nothing about this run is verified");
    return problems;
  }

  // A file the preload ended because it would not end by itself (`held`) exits 1 with every test
  // passed, and the parent then fails the FILE: one verdict the child never emitted, and the one it
  // is there to produce.
  const endedByThePreload = new Set(emitted.filter((entry) => Array.isArray(entry.held)).map((entry) => entry.file));

  for (const [file, emittedCount] of emittedByFile) {
    const got = receivedByFile.get(file) ?? 0;
    const count = emittedCount + (endedByThePreload.has(file) && got === emittedCount + 1 ? 1 : 0);
    if (got < count) problems.push(`${describe(file)}: ran ${count} tests but only ${got} reached the reporter — ${count - got} lost`);
    else if (got > count) problems.push(`${describe(file)}: reporter counted ${got} tests but the file only emitted ${count}`);
  }
  for (const file of receivedByFile.keys()) {
    if (!emittedByFile.has(file)) problems.push(`${describe(file)}: reported results but never recorded its own tally`);
  }

  return problems;
}

function tally(pairs) {
  const totals = new Map();
  for (const [file, count] of pairs) totals.set(file, (totals.get(file) ?? 0) + count);
  return totals;
}
