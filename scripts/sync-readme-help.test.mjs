import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { helpBlock, launcherHelp, README, withHelpBlock } from "./sync-readme-help.mjs";

test("the README's help block is what the launcher prints", async () => {
  const readme = readFileSync(README, "utf8");
  const help = await launcherHelp();
  // The real output, so a block of anything would not pass as it.
  assert.match(help, /^Frizz production launcher\n/);
  assert.match(help, /-h, --help\s+show this help/);
  assert.equal(
    withHelpBlock(readme, help),
    readme,
    "README.md prints a --help the launcher no longer prints. Run: nub scripts/sync-readme-help.mjs",
  );
});

test("the block is replaced between its markers and nothing around it moves", () => {
  const before = `intro\n\n${helpBlock("old help\n  --gone   an option that left")}\n\noutro\n`;
  const after = withHelpBlock(before, "new help\n  --here   an option that arrived");
  assert.equal(after, `intro\n\n${helpBlock("new help\n  --here   an option that arrived")}\n\noutro\n`);
  assert.doesNotMatch(after, /--gone/);
  // A second pass changes nothing.
  assert.equal(withHelpBlock(after, "new help\n  --here   an option that arrived"), after);
});

test("a README that lost its markers is reported, not written over", () => {
  assert.equal(withHelpBlock("no markers here\n", "help"), null);
  assert.equal(withHelpBlock("<!-- help:end -->\nonly the end\n", "help"), null);
});
