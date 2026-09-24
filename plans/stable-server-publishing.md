# Initial `frizz-server` publication

The initial `frizz-server@0.13.0` publication completed on 2026-09-11. Trusted publishing subsequently published `frizz-server@0.13.1` and `frizz@0.13.0`; see the [release verification](server-patch-release-verification-2026-09-11.md). The bootstrap procedure below is retained as a record. This document authorizes no publish by itself.

## Preconditions

- The approved commit contains `frizz-server@0.13.0` in `packages/server-release/package.json`.
- The root shell has been packed and verified against the same commit.
- The server tarball has been inspected. It must contain `dist/dev-child.js`, detached daemon siblings, `web-dist/index.html`, and the `runtime/board` plus `runtime/cc-worker` closure.
- The command runs from a clean checkout at the approved commit. Do not publish an artifact built from a later working tree.

## Tarball

Build the staging once, then create the server tarball without a package-directory lifecycle:

```sh
nub scripts/prepare-package.mjs --server
nub scripts/build-package.mjs --server
npm pack --json --ignore-scripts ./packages/server-release
```

Read the JSON result and inspect the named tarball before publishing. After release authorization, the first publication command is:

```sh
npm login
npm publish --access public /absolute/path/to/frizz-server-0.13.0.tgz
```

The explicit tarball path prevents a later build or current working directory from changing the published bytes. The command is intentionally manual for the first package only.

## Trusted publishing

After the manual bootstrap, configure a trusted publisher for `frizz-server` on npm. Use the GitHub Actions values below:

| Field | Value |
| --- | --- |
| Organization or user | `colinhacks` |
| Repository | `frizz` |
| Workflow filename | `release.yml` |
| Environment name | leave blank |
| Allowed actions | allow `npm stage publish` only |

The workflow file is `.github/workflows/release.yml` and already grants `id-token: write`. npm requires the filename only, not its path. Trusted-publisher configurations created after 2026-09-03 are stage-only by default, and that is the setting this repo wants: the workflow reserves a version with `npm stage publish` and a maintainer approves it with 2FA. Direct `npm publish` stays disabled, so even a run that a stolen credential somehow started could fill a queue and ship nothing. Since 2026-09-23 it cannot start one either: the workflow is `workflow_dispatch`-only, and a push credential cannot dispatch.

The npm organization `frizzsh` does not change these fields: they identify the GitHub repository, and the package is the unscoped `frizz-server` selected for this release.

## Automated releases

The server package must exist before `release.yml` can publish a shell version that bootstraps it. After the first package and trusted publisher are configured, move the verified commit to the `release` branch and dispatch the workflow against it (`gh workflow run release.yml --ref release`); moving the branch alone starts nothing. The workflow stages `frizz-server` before `frizz`, waits for the maintainer to approve both, and uses npm registry checks to make retries idempotent. Approve `frizz-server` first: staging puts both versions in the queue at once, so the approvals, not the workflow, order the two releases.

Server/frontend/provider changes normally bump only `packages/server-release/package.json`. A shell release separately bumps root `package.json`; its `frizzServer.version` is the exact default for a machine without a selected generation, not a dependency range. Compatible server updates are selected independently after bootstrap.

Before introducing data an older server cannot safely read, bump the server and shell data epochs together, including the constants in `src/server-release.ts`, and select an exact compatible bootstrap release. The old shell refuses such an in-app update. After an explicit stop/new-shell launch, the new shell records the higher epoch before the candidate can write; a failed candidate does not authorize a lower-epoch rollback. Protocol changes need a separate migration design. Never delete the compatibility marker to force a downgrade.

Reference: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Recovery after publication

The workflow waits up to 2m for the exact shell version's registry metadata before tagging. npm can acknowledge a publication before its read replicas expose it. A missing or invalid `gitHead` still fails closed; the workflow never substitutes its current checkout.

GitHub can reject a historical tag when that commit's workflow differs from the current run: its workflow token does not have permission to introduce that workflow revision. No additional CI credential is needed. After confirming the release is authorized, create the tag from a maintainer checkout with workflow permission, then rerun the failed workflow:

```sh
VERSION=0.13.0 # the shell version being reconciled
GIT_HEAD=$(nub scripts/published-git-head.mjs frizz "$VERSION")
git cat-file -e "$GIT_HEAD^{commit}"
git tag -a "v$VERSION" "$GIT_HEAD" -m "frizz v$VERSION"
git push origin "v$VERSION"
gh workflow run release.yml --ref release
```

This procedure applies when the tag is absent. Never overwrite an existing tag or move it to the newer workflow commit. The rerun skips published versions and creates missing GitHub release metadata.
