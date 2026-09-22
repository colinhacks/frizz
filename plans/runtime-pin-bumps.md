# Keeping the bundled Claude Code and Codex current

Frizz provisions its own Claude Code and its own Codex — one pin per backend, declared in [`packages/server/src/runtimes.ts`](../packages/server/src/runtimes.ts) and fetched from the vendor's own npm package on first boot. The design is in [provisioned-runtimes.md](provisioned-runtimes.md); this file is the operational half: how the pins are watched, what moving one costs, and what has to be re-proven afterwards.

**A stale pin is a broken worker, not a cautious one.** Both vendors enforce minimums server-side, so lag shows up as a hard failure rather than as missing polish. The first provisioned Claude Code refused the default model outright — `400 Claude Code 2.1.207 does not support this model; version 2.1.251 or newer is required` — and the 0.146 Codex pin could never offer `gpt-6-astra`, because the catalogue server omits a model from any client below its `minimal_client_version`. Both vendors ship every couple of days, so the pins need a standing watch rather than a bump when someone notices.

## The daily check

```
nub scripts/check-runtime-pins.mjs          # a verdict
nub scripts/check-runtime-pins.mjs --json   # the same thing for a script
```

It reads the pins from `runtimes.ts` itself, asks the registry what each vendor has published, and answers the only question that matters: **may this pin move today?** Exit `0` both current · `10` at least one behind · `1` the check itself failed.

Three things have to hold before a bump is ready, and the script reports each:

- **Behind.** The vendor has published something newer.
- **NOT "past the age floor" — bump the newest, the day it ships.** `nub` refuses any version under 24 hours old (`minimumReleaseAge=1440`, its own default), and this procedure used to treat that as a gate. It does not converge: Anthropic shipped 0.3.263 through 0.3.267 in two days, so every candidate was superseded before it aged in, and the pin was not a day behind but permanently behind (maintainer, 2026-09-09: *"I think we should ship these things as quickly as possible"*). The floor also bought no safety this procedure does not already provide — every move is verified against the real binary, which is a stronger check on a first-party runtime than waiting to see whether anyone else complains. So the Claude install passes `--minimum-release-age-exclude "@anthropic-ai/*"`, the gate stays on for the rest of the tree, and Codex was never gated at all because Frizz's own provisioner fetches it rather than the package manager.
- **Every platform tarball published.** Provisioning fetches a per-platform package, and the version tag and the platform tarballs do not land at the same instant. Bumping to a version whose tarball is missing breaks every machine that boots before it appears.

## Moving the Claude pin

The SDK version is the pin; the Claude Code build is whatever that SDK names in its own manifest. Neither is chooseable alone.

1. `packages/claude-agent-sdk-runtime/package.json` — the `@anthropic-ai/claude-agent-sdk` dependency.
2. `runtimes.ts` — `CLAUDE_AGENT_SDK_VERSION`, then `CLAUDE_CODE_VERSION` to the SDK's own `claudeCodeVersion`. Never guess the second: `runtimes.test.ts` reads it out of the installed SDK's manifest and fails on a mismatch.
3. Update the lockfile with **pnpm, not `nub install`** — `CI=true nubx -y pnpm@10 install --no-frozen-lockfile`. **Then READ THE DIFF, because pnpm is the safer tool and not a safe one.** Editing the manifest bypasses pnpm's prefer-frozen path, so it re-resolves the whole graph at `resolution-mode=highest` and every TRANSITIVE range that now admits something newer moves with your pin. Measured on 0.3.270 (2026-09-12): 210 lines rather than the usual 74, carrying oxc-parser 0.146.0 -> 0.148.0, oxlint 1.79.0 -> 1.81.0 and react-doctor 0.9.13 -> 0.9.14 — none of them declared in any manifest, all of them transitive under `packages/web`. The sweep cannot be split from the pin (with the manifest unedited pnpm goes headless and moves nothing), so the rule is to NAME it in the commit rather than to pretend it did not happen, and to rebuild the server package as the workflow does before believing the artifact is unaffected. Expect ~74 lines on a quiet day; anything larger is a finding to report, not noise to wave through. Both flags are load-bearing: `CI=true` lets pnpm purge a `node_modules` that nub built without a TTY to confirm on, and it ALSO flips pnpm's default to frozen, so without `--no-frozen-lockfile` the install refuses with "specifiers in the lockfile don't match" the moment the manifest has moved (hit on 0.3.268). Both tools leave a working tree; only one leaves a reviewable diff. `nub install` re-resolves every caret range in the workspace to its newest satisfying version, so this one-line pin arrived as a **2984-line** lockfile that also carried puppeteer 25.3.0 → 25.10.0, `@parcel/watcher`, `ws` and `@types/node` (measured 2026-09-09). pnpm reuses the existing resolutions and moves only what the manifest changed: **326 lines**, all of them the SDK and its eight platform packages. A runtime pin release must not smuggle a dependency sweep past its own review. If you do reach for nub here, it needs `--minimum-release-age-exclude "@anthropic-ai/*"` to install an SDK published today; pnpm has no age floor configured in this repo. Either way the runtime package's own `node_modules` has to end up on the new SDK, because that manifest is what the test reads.

## Moving the Codex pin

The Codex coordinate is an AUDITED one and lives in [`codex-app-server.ts`](../packages/server/src/backend/codex-app-server.ts), not in `runtimes.ts`, which imports it. A bump is a re-audit:

1. Take the release's immutable source coordinates. The tag is `rust-v<version>`; dereference the annotated tag to its commit rather than recording the tag object's own sha — `gh api repos/openai/codex/git/ref/tags/rust-v<version> --jq .object.sha`, then `gh api repos/openai/codex/git/tags/<that sha> --jq .object.sha`. Checked against the recorded `rust-v0.153.2` → `657a993c`, which is what that two-step yields.
2. Update `CODEX_APP_SERVER_SUPPORTED_VERSION` and all three fields of `CODEX_APP_SERVER_PROTOCOL_REVISION`, plus the version literal in `runtimes.test.ts`'s coordinates.
3. Provision the new binary and run the wire-contract gate against it unskipped — `nub run test packages/server/src/backend/codex-protocol-conformance.test.ts`. It asks the binary for its own generated schema and checks every param Frizz sends still exists. It SKIPS when the installed codex is not the pin, and a skip is not a pass.
4. **On a MINOR bump, diff the server→client direction as well.** The gate above and the schema differ both read `ClientRequest` — what Frizz SENDS. `ServerNotification`, `ServerRequest` and `ClientNotification` are what Frizz READS, and a request-only audit would pass a break shaped like 0.153's. Compare each file's variant method set and per-variant field keys between the two generated schema directories, and treat a REMOVED method or field as the finding; additions are ordinarily harmless. On 0.153.4 → 0.154.0 all three were byte-for-byte identical in shape (81, 11 and 1 variants, nothing added or removed), while `ClientRequest` went 155 → 159.

Note the asymmetry that is deliberate: the version gate REFUSES an older codex and only WARNS on a newer one, because unknown fields are silently ignored and "newer" is overwhelmingly compatible. The conformance test, not a string compare, is what fails when the protocol actually moves.

## Then re-prove the log format — this is the step that gets skipped

A version gate proves Frizz is talking to the right binary. It says nothing about whether that binary still WRITES the transcript Frizz reads, and that is the failure this system has actually suffered. Codex 0.153 respelled its rollout: every semantic event moved onto one `event_msg/item_completed` envelope carrying a typed `item`, and the flat payloads Frizz read stopped being written. Nothing threw. The fold returned empty — no assistant text, no user turns, no sub-agents — while the turn brackets, which had not moved, kept working, so threads went in-flight and came to rest perfectly with nothing on the board.

[`log-format-conformance.test.ts`](../packages/server/src/backend/log-format-conformance.test.ts) is the detector. It finds the newest substantial session on this machine written by the PINNED build — both vendors stamp their own build into the transcript, Codex in `session_meta.payload.cli_version` and Claude on every record's `version` — folds it through the production path, and asserts the things that went to zero are not zero.

**It SKIPS when nothing on the machine was written by the new pin, which is the state every bump leaves behind.** A skip is not a pass; it means the format is unproven. So after bumping:

1. Restart the server so workers pick up the new pin, and run one real thread on each backend you moved.
2. `nub run test packages/server/src/backend/log-format-conformance.test.ts` and confirm it reports `pass`, not `skipped`.

If it fails, the vendor moved the format and the parser — `parseCodexLine` in [`codex.ts`](../packages/server/src/backend/codex.ts), `applyRecord` in [`tailer.ts`](../packages/server/src/tailer.ts) — is what has to change. Capture a redacted rollout into `codex.fixtures/` alongside the existing ones as the regression pin, the way `multi-agent-0153.jsonl` records the last such move.

## Then cut a release — a pin nobody can install is not a bump

The point of a pin is the binary a user runs. The selected `frizz-server` generation owns the provider pins; updating that server brings the new private runtimes without changing the stable launcher or global provider installations. A pin that lands on `main` alone remains unpublished. Finish the authorized release job (maintainer, 2026-09-07: *"once you bump these versions and test them end to end, you should cut a new release as well"*).

### Releases publish from the `release` branch, not from main

Main answers "has this landed?". [`release`](../.github/workflows/release.yml) answers "has this been VERIFIED and chosen to ship?" — and only the second one publishes. The split exists because main moves under you: several agents land on it continuously, so the commit you verified and the commit that would publish are routinely not the same one, and a release from main carries whatever arrived in between (maintainer, 2026-09-08: *"you can bump these versions and do your own testing independent of whatever's landed on `main`"*).

**`release` is a fast-forward pointer into main, never a fork.** It holds no commits of its own. You pick the main commit you actually tested and move the branch to it, which keeps the published tree a real snapshot of main — nothing to cherry-pick, nothing to merge back — while leaving later, unverified commits behind. If it ever needs a non-fast-forward push, stop and look rather than forcing it.

### The sequence

1. **Cut the server version on main.** Raise `version` in [`packages/server-release/package.json`](../packages/server-release/package.json) and commit as `chore(release): frizz-server X.Y.Z`. Provider pins, frontend and server changes ship together there. Leave the root shell version alone unless its launcher changes; a new shell's `frizzServer.version` names its exact bootstrap server. Patch bumps remain the default.
2. **Look at what ships with you.** `git log release..HEAD` is the exact set. Anything there you have not verified either gets verified now or gets left behind by pointing `release` at an earlier commit — that choice is the whole reason the branch exists.
3. **Verify the commit you are about to publish, not "the tree".** `nub run test` and `nub run typecheck` against that sha. Typecheck is the workflow's own gate, deliberately not the full suite, because the suite drives real provider CLIs and has never run on a CI box.
4. **Push main, then fast-forward and push `release`.** `git push origin main`, then `git branch -f release <sha> && git push origin release`. The push to `release` is what publishes.
5. **Watch the run, then approve the staged version.** The workflow stages `frizz-server` rather than publishing it, so the version is reserved but not installable until a maintainer approves it with 2FA — `npm stage list frizz-server` for the stage id, then `npm stage approve <id>`, or `pnpm stage approve`. The run holds open until the registry serves the version, which also absorbs npm's publish queue (6m 40s for 0.13.5 on 2026-09-14), and goes green only after that.

The workflow stages `frizz-server` before `frizz`, checking each version independently in npm. Tags and GitHub releases belong to the shell; a server-only release does not retag it. Retries reconcile missing shell metadata against npm's recorded `gitHead`. The trigger deliberately has no path filter: a fast-forward can carry the version bump in the middle of its range.

**`pnpm install --frozen-lockfile` is the first gate the workflow hits, and it is the one that actually fails.** This repo's toolchain is `nub` but CI installs with pnpm, and the two disagree about how to record a specifier the root `pnpm.overrides` rewrites — nub writes what the manifest literally declares, pnpm writes what the override resolves to. That flipped `packages/web`'s react lines back and forth three times and broke a release each time, until the manifest was changed to declare the override's own version so both agree. If a release dies at the install step, check for that class first: reproduce it exactly with `git worktree add /tmp/check <sha>` and `pnpm install --frozen-lockfile` there, rather than trusting a local `nub install`.

**A version bump on main is inert.** Pushing main publishes nothing. On a runtime-watch wake, compare `packages/server-release/package.json` against `npm view frizz-server version`, and root `package.json` against `npm view frizz version`; checking only the shell misses an unpublished provider pin.
