import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const workflow = readFileSync(
  join(import.meta.dirname, "..", ".github", "workflows", "release.yml"),
  "utf8"
);

function step(name: string): string {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `missing release step: ${name}`);
  const end = workflow.indexOf("\n      - name:", start + 1);
  return workflow.slice(start, end === -1 ? undefined : end);
}

test("a release retry reconciles shell tags and GitHub metadata after npm succeeds", () => {
  const tag = step("Tag the released shell commit");
  const release = step("Create the GitHub shell release");

  assert.doesNotMatch(tag, /\n\s+if:/, "tagging must run when publish_shell is false on a retry");
  assert.doesNotMatch(release, /\n\s+if:/, "GitHub release creation must run when publish_shell is false on a retry");
  assert.match(tag, /node scripts\/published-git-head.mjs frizz "\$VERSION"/);
  assert.match(tag, /git fetch --no-tags --depth=1 origin "\$GIT_HEAD"/);
  assert.match(tag, /git cat-file -e "\$GIT_HEAD\^\{commit\}"/);
  assert.match(tag, /git tag -a "v\$VERSION" "\$GIT_HEAD" -m "frizz v\$VERSION"/);
  assert.match(tag, /git ls-remote --exit-code --tags origin "v\$VERSION"/);
  assert.match(release, /gh release view "v\$VERSION"/);
});

test("the release path can only stage, and holds every downstream step behind the approval", () => {
  const server = step("Build and stage frizz-server on npm");
  const shell = step("Stage the frizz shell on npm");
  const wait = step("Wait for the maintainer to approve the staged versions");

  // A direct publish is the thing staging exists to prevent: the trusted publisher is stage-only,
  // so this is what a re-introduced `npm publish` would look like before npm rejected it.
  assert.ok(!/\bnpm publish\b/.test(workflow), "the release path must stage, never publish");
  assert.match(server, /npm-stage-publish\.sh \.\/packages\/server-release --ignore-scripts/);
  assert.match(shell, /npm-stage-publish\.sh \.$/m);
  assert.doesNotMatch(wait, /\n\s+if:/, "the wait must run on a retry, when both versions are already staged");
  assert.match(workflow, /^ {4}timeout-minutes: 360$/m, "the approval wait needs the job's full six hours");
  // The tag and the GitHub release describe a published version, so they must follow the wait.
  assert.ok(
    workflow.indexOf("- name: Wait for the maintainer") < workflow.indexOf("- name: Tag the released shell commit"),
    "the tag and the GitHub release must come after the approval wait"
  );
});
