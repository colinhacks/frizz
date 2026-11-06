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
| Environment name | `npm-publish` (GitHub lets only the `release` branch deploy to it; see the header of `release.yml`) |
| Allowed actions | `npm stage publish` only |

The workflow file is `.github/workflows/release.yml` and already grants `id-token: write`. npm requires the filename only, not its path. Keep the publisher stage-only: `npm publish` unticked is what makes a maintainer's 2FA approval the only way a version reaches the registry, so no stolen credential ships a package. A publisher that doesn't allow `npm stage publish` rejects the workflow with `E403 OIDC permission denied for this action`. The first publish of a new package is the manual one above, because a trusted publisher can't be configured on a package that doesn't exist.

The npm organization `frizzsh` does not change these fields: they identify the GitHub repository, and the package is the unscoped `frizz-server` selected for this release.

## Automated releases

The server package must exist before `release.yml` can publish a shell version that bootstraps it. After the first package and trusted publisher are configured, move the verified commit to the `release` branch and dispatch the workflow against it (`gh workflow run release.yml --ref release`); moving the branch alone starts nothing. The workflow stages `frizz-server`, then `frizz`, and uses npm registry checks to make retries idempotent. A maintainer approves both with one 2FA code, in the order they were staged, because a shell must not go live before the server it boots.

Server/frontend/provider changes normally bump only `packages/server-release/package.json`. A shell release separately bumps root `package.json`; its `frizzServer.version` is the exact default for a machine without a selected generation, not a dependency range. Compatible server updates are selected independently after bootstrap.

Before introducing data an older server cannot safely read, bump the server and shell data epochs together, including the constants in `src/server-release.ts`, and select an exact compatible bootstrap release. The old shell refuses such an in-app update. After an explicit stop/new-shell launch, the new shell records the higher epoch before the candidate can write; a failed candidate does not authorize a lower-epoch rollback. Protocol changes need a separate migration design. Never delete the compatibility marker to force a downgrade.

Reference: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

## Recovery after publication

The workflow stages each version and waits for npm to serve it; it does not tag. Tags, GitHub releases and their release notes are made by the releaser after a green run, from its own `gh` session, for every release (the server's tagged `frizz-server-vX.Y.Z`): `nub scripts/tag-release.mjs [frizz-server] --notes-file <file>`. The script refuses to create a release without notes, waits up to 30s for the exact version's registry metadata, fails closed on a missing or invalid `gitHead`, tags that commit and never a checkout, never moves an existing tag, and creates only what is missing.

The workflow tagged the shell itself until 2026-10-12. GitHub rejects a tag from the workflow's own token when that commit's workflow differs from the current run's, because the token may not introduce that workflow revision, and a later run reconciling an earlier shell is exactly that case (frizz 0.13.13).
