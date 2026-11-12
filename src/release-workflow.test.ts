import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";

const repo = join(import.meta.dirname, "..");
const workflow = readFileSync(join(repo, ".github", "workflows", "release.yml"), "utf8");

function step(name: string): string {
  const start = workflow.indexOf(`      - name: ${name}\n`);
  assert.notEqual(start, -1, `missing release step: ${name}`);
  const end = workflow.indexOf("\n      - name:", start + 1);
  return workflow.slice(start, end === -1 ? undefined : end);
}

// GitHub refuses the workflow's own token a tag whose commit carries a different workflow file than
// the run's checkout (frizz 0.13.13, 2026-10-12), so the releaser tags from its own `gh` session and
// the job keeps read-only access to the repository.
test("the workflow neither tags nor creates GitHub releases, and cannot write to the repository", () => {
  const code = workflow.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(code, /git tag|git push|gh release|GH_TOKEN/);
  assert.match(workflow, /\n      contents: read\b/);
  assert.doesNotMatch(workflow, /contents: write/);
});

const NOTES = "## Fixed\n\n- Question options are lettered again ([`cd83c22`](https://github.com/acme/frizz/commit/cd83c229))\n\n**Full changelog**: [frizz@1.2.2...frizz@1.2.3](https://github.com/acme/frizz/compare/aaa...bbb)";

function tagRelease(t: TestContext, existing: { ref?: string; release?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-tag-release-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const log = join(dir, "gh.log");
  const notes = join(dir, "notes.md");
  writeFileSync(notes, `${NOTES}\n`);
  // A `gh` that records every call, keeps whatever a release create or edit is handed on stdin, and
  // answers the few calls the script reads.
  writeFileSync(join(dir, "gh"), `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case "$*" in
  "api repos/acme/frizz/git/ref/tags/"*) ${existing.ref ? `echo "${existing.ref}"` : "exit 1"} ;;
  "api repos/acme/frizz/git/tags/tagobj"*) echo "${"a".repeat(40)}" ;;
  "api -X POST repos/acme/frizz/git/tags"*) cat > "${dir}/tag.json"; echo tagobj ;;
  "api -X POST repos/acme/frizz/git/refs"*) cat > "${dir}/ref.json"; echo refs/tags/v1.2.3 ;;
  "release view"*) ${existing.release ? "exit 0" : "exit 1"} ;;
  "release create"*|"release edit"*) cat > "${dir}/body.md" ;;
esac
`, { mode: 0o755 });
  const server = createServer((request, response) => {
    const served = /^\/(frizz|frizz-server)\/1\.2\.3$/.exec(request.url ?? "");
    if (served) response.end(JSON.stringify({ name: served[1], version: "1.2.3", gitHead: "a".repeat(40) }));
    else { response.statusCode = 404; response.end(); }
  });
  return { dir, log, notes, server, run: async (...args: string[]) => {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    t.after(() => server.close());
    const { port } = server.address() as { port: number };
    // Asynchronously: this process serves the registry the script reads, so it must not block.
    const child = spawn(process.execPath, [join(repo, "scripts", "tag-release.mjs"), ...args], {
      // GH_TOKEN keeps scripts/lib/gh-command.mjs on the stub `gh`, never the real Keyward.
      env: { ...process.env, GH_TOKEN: "stub", PATH: `${dir}:${process.env.PATH}`, FRIZZ_RELEASE_REPO: "acme/frizz", FRIZZ_NPM_REGISTRY: `http://127.0.0.1:${port}/` },
    });
    let stderr = "";
    child.stderr.on("data", (bytes) => { stderr += bytes; });
    const [status] = await once(child, "exit") as [number | null];
    return { status, stderr };
  } };
}

test("tag-release.mjs tags npm's gitHead and creates the release with its notes, once", async (t) => {
  const fresh = tagRelease(t);
  const made = await fresh.run("1.2.3", "--notes-file", fresh.notes);
  assert.equal(made.status, 0, made.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(fresh.dir, "tag.json"), "utf8")), { tag: "v1.2.3", message: "frizz v1.2.3", object: "a".repeat(40), type: "commit" });
  assert.deepEqual(JSON.parse(readFileSync(join(fresh.dir, "ref.json"), "utf8")), { ref: "refs/tags/v1.2.3", sha: "tagobj" });
  assert.match(readFileSync(fresh.log, "utf8"), /release create v1\.2\.3 --repo acme\/frizz --title frizz v1\.2\.3 --notes-file - --latest=true --verify-tag/);
  assert.equal(readFileSync(join(fresh.dir, "body.md"), "utf8"), `${NOTES}\n\nPublished to npm: https://www.npmjs.com/package/frizz/v/1.2.3\n`);

  const done = tagRelease(t, { ref: "tagobj tag", release: true });
  const rerun = await done.run("1.2.3");
  assert.equal(rerun.status, 0, rerun.stderr);
  assert.doesNotMatch(readFileSync(done.log, "utf8"), /POST|release create|release edit/, "a re-run with no notes creates nothing");

  const moved = tagRelease(t, { ref: `${"b".repeat(40)} commit` });
  const refused = await moved.run("1.2.3", "--notes-file", moved.notes);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /never moved/);
  assert.doesNotMatch(readFileSync(moved.log, "utf8"), /POST/);
});

// Every release carries notes, server-only ones included (maintainer 2026-10-16).
test("tag-release.mjs never creates a release without notes, and tags the server as not-latest", async (t) => {
  const bare = tagRelease(t);
  const refused = await bare.run("frizz-server", "1.2.3");
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /never created without notes/);
  assert.doesNotMatch(readFileSync(bare.log, "utf8"), /POST|release create/, "a refused run leaves no bare tag behind");

  const server = tagRelease(t);
  const made = await server.run("frizz-server", "1.2.3", "--notes-file", server.notes);
  assert.equal(made.status, 0, made.stderr);
  assert.equal(JSON.parse(readFileSync(join(server.dir, "tag.json"), "utf8")).tag, "frizz-server-v1.2.3");
  assert.match(readFileSync(server.log, "utf8"), /release create frizz-server-v1\.2\.3 --repo acme\/frizz --title frizz-server v1\.2\.3 --notes-file - --latest=false --verify-tag/);
  assert.match(readFileSync(join(server.dir, "body.md"), "utf8"), /Published to npm: https:\/\/www\.npmjs\.com\/package\/frizz-server\/v\/1\.2\.3\n$/);

  // Notes that are still a draft, or that link nothing, are refused before anything is written
  // (maintainer 2026-10-16: "They don't link to the relevant commits or PRs, do they?").
  for (const [body, fault] of [
    [`<!-- DRAFT: rewrite -->\n${NOTES}`, /DRAFT line/],
    ["- Question options are lettered again.\n\n**Full changelog**: https://github.com/acme/frizz/compare/aaa...bbb", /links no commit or pull request/],
    ["- Lettered again ([`cd83c22`](https://github.com/acme/frizz/commit/cd83c229))", /no compare link/],
  ] as const) {
    const unfinished = tagRelease(t);
    writeFileSync(unfinished.notes, body);
    const refusal = await unfinished.run("frizz-server", "1.2.3", "--notes-file", unfinished.notes);
    assert.notEqual(refusal.status, 0);
    assert.match(refusal.stderr, fault);
    assert.ok(!existsSync(unfinished.log) || !/POST|release (create|edit)/.test(readFileSync(unfinished.log, "utf8")), "a refused run writes nothing");
  }

  // Notes handed to a release that already exists replace its notes: a re-run is how they are fixed.
  const fix = tagRelease(t, { ref: "tagobj tag", release: true });
  const edited = await fix.run("frizz-server", "1.2.3", "--notes-file", fix.notes);
  assert.equal(edited.status, 0, edited.stderr);
  assert.match(readFileSync(fix.log, "utf8"), /release edit frizz-server-v1\.2\.3 --repo acme\/frizz --notes-file -/);
  assert.doesNotMatch(readFileSync(fix.log, "utf8"), /POST|release create/);
});

// The generator's whole contract on a real git history: the range is npm's (previous served version's
// gitHead to this one's), each change links its commit, a squashed or merged PR links the PR and credits a
// contributor, internal commits ride only in the full list, and a compare link closes the notes.
test("release-notes.mjs drafts linked notes over npm's range, crediting pull requests", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "frizz-release-notes-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const work = join(dir, "repo");
  mkdirSync(work);
  const git = (...a: string[]) => spawnSync("git", ["-C", work, ...a], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).stdout.trim();
  const commit = (message: string) => { writeFileSync(join(work, "f"), message); git("add", "f"); git("-c", "commit.gpgsign=false", "commit", "-q", "-m", message); return git("rev-parse", "HEAD"); };
  git("init", "-q", "-b", "main");
  const previous = commit("chore(release): frizz-server 1.2.2");
  commit("feat(web): a copy button on every blockquote");
  commit("fix(pr-watch): wake when a PR leaves the merge queue (#61)");
  commit("test(web): pin the copy button");
  git("checkout", "-q", "-b", "side");
  commit("fix(rail): the spinner wears the question mark");
  git("checkout", "-q", "main");
  git("-c", "commit.gpgsign=false", "merge", "-q", "--no-ff", "side", "-m", "Merge pull request #55 from someone/side");
  const head = commit("chore(release): frizz-server 1.2.3");

  writeFileSync(join(dir, "gh"), `#!/bin/sh
case "$*" in
  "api repos/acme/frizz/pulls/61"*) echo octocat ;;
  "api repos/acme/frizz/pulls/55"*) echo acme ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });
  const server = createServer((request, response) => {
    const meta = (version: string, gitHead: string) => ({ name: "frizz-server", version, gitHead });
    if (request.url === "/frizz-server") response.end(JSON.stringify({ versions: { "1.2.1": meta("1.2.1", "c".repeat(40)), "1.2.2": meta("1.2.2", previous), "1.2.3": meta("1.2.3", head) } }));
    else if (request.url === "/frizz-server/1.2.3") response.end(JSON.stringify(meta("1.2.3", head)));
    else { response.statusCode = 404; response.end(); }
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  t.after(() => server.close());
  const { port } = server.address() as { port: number };
  const child = spawn(process.execPath, [join(repo, "scripts", "release-notes.mjs"), "frizz-server", "1.2.3"], {
    // GH_TOKEN keeps scripts/lib/gh-command.mjs on the stub `gh`: this `gh` answers "signed out", and on
    // a machine with Keyward installed the script would otherwise ask the real Keyward for a Touch ID.
    env: { ...process.env, GH_TOKEN: "stub", PATH: `${dir}:${process.env.PATH}`, FRIZZ_RELEASE_REPO: "acme/frizz", FRIZZ_RELEASE_GIT_DIR: work, FRIZZ_NPM_REGISTRY: `http://127.0.0.1:${port}/` },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", (bytes) => { stdout += bytes; });
  child.stderr.on("data", (bytes) => { stderr += bytes; });
  const [status] = await once(child, "exit") as [number | null];
  assert.equal(status, 0, stderr);

  const sha = (subject: string) => git("log", "--format=%H", "--grep", subject, "--fixed-strings").split("\n")[0];
  const link = (subject: string) => `[\`${sha(subject).slice(0, 7)}\`](https://github.com/acme/frizz/commit/${sha(subject)})`;
  assert.ok(stdout.startsWith("<!-- DRAFT"), "the draft says it is one, so tag-release refuses it unedited");
  assert.match(stdout, /## Added\n\n- A copy button on every blockquote \(/);
  assert.ok(stdout.includes(`- A copy button on every blockquote (${link("copy button on every")})`));
  assert.ok(stdout.includes(`- Wake when a PR leaves the merge queue in [#61](https://github.com/acme/frizz/pull/61) by @octocat (${link("merge queue")})`), "a squashed PR is linked and its author credited");
  assert.ok(stdout.includes(`- The spinner wears the question mark in [#55](https://github.com/acme/frizz/pull/55) (${link("spinner wears")})`), "a merged PR's branch commit links the PR; the owner is not credited");
  assert.match(stdout, /## Contributors\n\n- @octocat \(\[#61\]/);
  const added = stdout.slice(0, stdout.indexOf("<details>"));
  assert.doesNotMatch(added, /pin the copy button|chore\(release\)|1\.2\.1/, "tests and release bumps stay out of the drafted sections");
  assert.match(stdout, /<summary>All 4 commits<\/summary>/, "the full list carries every non-merge commit but the release bump");
  assert.ok(stdout.includes(`**Full changelog**: [frizz-server@1.2.2...frizz-server@1.2.3](https://github.com/acme/frizz/compare/${previous}...${head})`));
});

test("the release stages the server, then the shell, and ends there", () => {
  const server = step("Build and stage frizz-server on npm");
  const shell = step("Stage the frizz shell on npm");

  // A direct `npm publish` would need the trusted publisher to allow one, and would put a version on
  // the registry with no 2FA approval. The bootstrap of a new package stays a manual, local publish.
  const code = workflow.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  assert.doesNotMatch(code, /npm publish|npm-publish\.sh/, "the release path can only stage");
  assert.match(server, /npm-stage-publish\.sh \.\/packages\/server-release --ignore-scripts/);
  assert.match(shell, /npm-stage-publish\.sh \.$/m);
  assert.match(shell, /frizzServer\.version/, "the shell refuses a pinned server this run does not stage and npm does not serve");

  // stager approves a release's packages in the order they were staged, and a shell fetches its
  // pinned server from the registry on first boot, so the server has to be staged first.
  assert.ok(workflow.indexOf("- name: Build and stage frizz-server on npm") < workflow.indexOf("- name: Stage the frizz shell on npm"), "server before shell");
});

// The helpers run against fake `npm` and `curl` on PATH, so these exercise the real scripts without
// touching the registry. The fake `curl` answers the two URLs the scripts read: `<name>/<version>`
// says whether npm serves that version, and the bare `<name>` packument lists every served one.
interface FakeRegistry {
  served: boolean;
  npmOut?: string;
  npmExit?: number;
  /** The version in the package being published; 9.9.9 unless a test is about the number itself. */
  version?: string;
  /** Every version the packument lists; `null` is a registry that cannot be read. */
  versions?: string[] | null;
  allowGap?: boolean;
}

function runScript(script: string, args: string[], fake: FakeRegistry) {
  const dir = mkdtempSync(join(tmpdir(), "frizz-release-script-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const versions = fake.versions === undefined ? ["9.9.8"] : fake.versions;
  const packument = versions ? JSON.stringify({ versions: Object.fromEntries(versions.map((version) => [version, {}])) }) : "";
  writeFileSync(join(dir, "packument.json"), packument);
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh\nfor url; do :; done\ncase "\${url##*/}" in\n  [0-9]*) exit ${fake.served ? 0 : 22} ;;\n  *) ${versions ? `cat "${join(dir, "packument.json")}"; exit 0` : "exit 22"} ;;\nesac\n`,
    { mode: 0o755 }
  );
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh\necho "$@" >> "${join(dir, "npm-calls")}"\nprintf '%s\\n' "$FAKE_NPM_OUT"\nexit ${fake.npmExit ?? 0}\n`,
    { mode: 0o755 }
  );
  const pkg = join(dir, "pkg");
  mkdirSync(pkg);
  writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "frizz-server", version: fake.version ?? "9.9.9" }));
  const result = spawnSync("bash", [join(repo, ".github", "scripts", script), ...args.map((a) => (a === "<pkg>" ? pkg : a))], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_NPM_OUT: fake.npmOut ?? "",
      ALLOW_VERSION_GAP: fake.allowGap ? "true" : "false",
    },
  });
  const calls = existsSync(join(dir, "npm-calls")) ? readFileSync(join(dir, "npm-calls"), "utf8") : "";
  rmSync(dir, { recursive: true, force: true });
  return { status: result.status, out: result.stdout + result.stderr, calls };
}

test("npm-stage-publish.sh skips a served version, tolerates a version already staged, and fails on E403", () => {
  const served = runScript("npm-stage-publish.sh", ["<pkg>"], { served: true });
  assert.equal(served.status, 0);
  assert.equal(served.calls, "", "a served version must not be staged again");

  const fresh = runScript("npm-stage-publish.sh", ["<pkg>", "--ignore-scripts"], { served: false });
  assert.equal(fresh.status, 0);
  assert.match(fresh.calls, /^stage publish .*\/pkg --ignore-scripts$/m, "`npm stage publish`, never a direct publish");

  const staged = runScript("npm-stage-publish.sh", ["<pkg>"], {
    served: false,
    npmExit: 1,
    npmOut: "npm error code E409\nnpm error 409 Conflict - Cannot publish over previously staged version",
  });
  assert.equal(staged.status, 0, staged.out);

  // A trusted publisher that doesn't allow staging refuses with E403; the step must fail at once and
  // say which npm setting to change.
  const denied = runScript("npm-stage-publish.sh", ["<pkg>"], {
    served: false,
    npmExit: 1,
    npmOut: "npm error code E403\nnpm error 403 Forbidden - OIDC permission denied for this action",
  });
  assert.equal(denied.status, 1, denied.out);
  assert.match(denied.out, /trusted publisher/);

  const other = runScript("npm-stage-publish.sh", ["<pkg>"], { served: false, npmExit: 1, npmOut: "npm error code E500" });
  assert.equal(other.status, 1, other.out);
});

test("staging is refused unless it directly follows the highest version npm serves", () => {
  const order = (version: string, versions: string[] | null, allowGap = false) =>
    runScript("npm-refuse-overtake.sh", ["frizz", version], { served: false, versions, allowGap });

  // The next patch, and the first release of the next minor or major, have nothing in between.
  for (const next of ["0.13.12", "0.14.0", "1.0.0"]) assert.equal(order(next, ["0.13.9", "0.13.11", "0.13.10"]).status, 0, next);
  assert.equal(order("0.1.0", []).status, 0, "a package npm serves no version of has no order yet");
  assert.equal(order("0.14.0-beta.1", ["0.13.11"]).status, 0, "a prerelease has no single predecessor");

  // 2026-10-10: 0.13.10 was accepted and still in review when the next run published 0.13.11, and
  // npm served them the other way round.
  const overtaking = order("0.13.11", ["0.13.8", "0.13.9"]);
  assert.equal(overtaking.status, 1, overtaking.out);
  assert.match(overtaking.out, /npm serves frizz up to 0\.13\.9, and this run would stage 0\.13\.11/);
  assert.match(overtaking.out, /allow_version_gap=true/, "the refusal names the way past a number that was never published");
  for (const gap of ["0.13.13", "0.14.1", "2.0.0", "0.13.10"]) assert.equal(order(gap, ["0.13.11"]).status, 1, gap);

  // A number skipped on purpose (frizz-server 0.15.21, whose run was cancelled before it published).
  assert.equal(order("0.15.22", ["0.15.20"], true).status, 0);
  // A registry that cannot be read proves nothing about order, so the publish does not go ahead.
  const unreadable = order("0.13.12", null);
  assert.equal(unreadable.status, 1, unreadable.out);
  assert.match(unreadable.out, /could not read frizz from the npm registry/);
});

test("both packages are checked for order before npm is asked to stage", () => {
  const refused = runScript("npm-stage-publish.sh", ["<pkg>"], { served: false, versions: ["9.9.7"] });
  assert.equal(refused.status, 1, refused.out);
  assert.equal(refused.calls, "", "a refused version never reaches npm");

  const allowed = runScript("npm-stage-publish.sh", ["<pkg>"], { served: false, versions: ["9.9.7"], allowGap: true });
  assert.equal(allowed.status, 0, allowed.out);
  assert.match(allowed.calls, /^stage publish /m);

  // A re-run for a version already in the queue is still the immediate successor, and the refusal npm
  // gives it stays tolerated.
  const rerun = runScript("npm-stage-publish.sh", ["<pkg>"], {
    served: false,
    npmExit: 1,
    npmOut: "npm error code E409\nnpm error 409 Conflict - Cannot publish over previously staged version",
  });
  assert.equal(rerun.status, 0, rerun.out);

  // The flag reaches the script only through the dispatch input, on both staging steps.
  assert.match(workflow, /^  workflow_dispatch:\n    inputs:\n(?:      #.*\n)*      allow_version_gap:\n/m);
  for (const name of ["Build and stage frizz-server on npm", "Stage the frizz shell on npm"])
    assert.match(step(name), /ALLOW_VERSION_GAP: \$\{\{ inputs\.allow_version_gap \}\}/, name);
});

// npm's trusted publishers for `frizz` and `frizz-server` name this environment, and GitHub admits
// only the `release` branch to it (2026-10-12). Dropping or renaming it here breaks every release.
test("the stage job runs in the npm-publish environment its trusted publishers name", () => {
  assert.match(workflow, /\n  stage:\n(?:    .*\n)*?    environment: npm-publish\n/);
});

// The approval is npm's and stager's, so no job waits for it: until 2026-11-12 a `finish` job held on a
// `release-approval` environment, and resuming it cost a Touch ID on every approval.
test("no job waits on release-approval after staging", () => {
  assert.doesNotMatch(workflow, /^ {2}finish:$/m);
  assert.doesNotMatch(workflow.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n"), /release-approval/);
});
