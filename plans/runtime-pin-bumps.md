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
- **Past the age floor.** `nub install` refuses any version younger than 24 hours (`minimumReleaseAge=1440`, `minimumReleaseAgeStrict=true` — nub's own default). Do not reach for `--minimum-release-age=0`: the window exists so a compromised publish is caught before it reaches a machine, and Frizz provisions these binaries onto every user's. Waiting a day costs nothing. Codex arrives through Frizz's own provisioner rather than through pnpm, so nothing mechanically enforces the floor there — hold it to the same day anyway, because which package manager fetched a binary is not a security argument.
- **Every platform tarball published.** Provisioning fetches a per-platform package, and the version tag and the platform tarballs do not land at the same instant. Bumping to a version whose tarball is missing breaks every machine that boots before it appears.

## Moving the Claude pin

The SDK version is the pin; the Claude Code build is whatever that SDK names in its own manifest. Neither is chooseable alone.

1. `packages/claude-agent-sdk-runtime/package.json` — the `@anthropic-ai/claude-agent-sdk` dependency.
2. `runtimes.ts` — `CLAUDE_AGENT_SDK_VERSION`, then `CLAUDE_CODE_VERSION` to the SDK's own `claudeCodeVersion`. Never guess the second: `runtimes.test.ts` reads it out of the installed SDK's manifest and fails on a mismatch.
3. `nub install`, so the lockfile and the runtime package's own `node_modules` move with it — that manifest is what the test reads.

## Moving the Codex pin

The Codex coordinate is an AUDITED one and lives in [`codex-app-server.ts`](../packages/server/src/backend/codex-app-server.ts), not in `runtimes.ts`, which imports it. A bump is a re-audit:

1. Take the release's immutable source coordinates. The tag is `rust-v<version>`; dereference the annotated tag to its commit rather than recording the tag object's own sha — `gh api repos/openai/codex/git/ref/tags/rust-v<version> --jq .object.sha`, then `gh api repos/openai/codex/git/tags/<that sha> --jq .object.sha`. Checked against the recorded `rust-v0.153.2` → `657a993c`, which is what that two-step yields.
2. Update `CODEX_APP_SERVER_SUPPORTED_VERSION` and all three fields of `CODEX_APP_SERVER_PROTOCOL_REVISION`, plus the version literal in `runtimes.test.ts`'s coordinates.
3. Provision the new binary and run the wire-contract gate against it unskipped — `nub run test packages/server/src/backend/codex-protocol-conformance.test.ts`. It asks the binary for its own generated schema and checks every param Frizz sends still exists. It SKIPS when the installed codex is not the pin, and a skip is not a pass.

Note the asymmetry that is deliberate: the version gate REFUSES an older codex and only WARNS on a newer one, because unknown fields are silently ignored and "newer" is overwhelmingly compatible. The conformance test, not a string compare, is what fails when the protocol actually moves.

## Then re-prove the log format — this is the step that gets skipped

A version gate proves Frizz is talking to the right binary. It says nothing about whether that binary still WRITES the transcript Frizz reads, and that is the failure this system has actually suffered. Codex 0.153 respelled its rollout: every semantic event moved onto one `event_msg/item_completed` envelope carrying a typed `item`, and the flat payloads Frizz read stopped being written. Nothing threw. The fold returned empty — no assistant text, no user turns, no sub-agents — while the turn brackets, which had not moved, kept working, so threads went in-flight and came to rest perfectly with nothing on the board.

[`log-format-conformance.test.ts`](../packages/server/src/backend/log-format-conformance.test.ts) is the detector. It finds the newest substantial session on this machine written by the PINNED build — both vendors stamp their own build into the transcript, Codex in `session_meta.payload.cli_version` and Claude on every record's `version` — folds it through the production path, and asserts the things that went to zero are not zero.

**It SKIPS when nothing on the machine was written by the new pin, which is the state every bump leaves behind.** A skip is not a pass; it means the format is unproven. So after bumping:

1. Restart the server so workers pick up the new pin, and run one real thread on each backend you moved.
2. `nub run test packages/server/src/backend/log-format-conformance.test.ts` and confirm it reports `pass`, not `skipped`.

If it fails, the vendor moved the format and the parser — `parseCodexLine` in [`codex.ts`](../packages/server/src/backend/codex.ts), `applyRecord` in [`tailer.ts`](../packages/server/src/tailer.ts) — is what has to change. Capture a redacted rollout into `codex.fixtures/` alongside the existing ones as the regression pin, the way `multi-agent-0153.jsonl` records the last such move.
