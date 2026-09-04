# Provisioned runtimes — Frizz should own a pinned Claude Code and Codex

Written 2026-09-04, as the answer to one question from the maintainer: should Frizz provision its own copy of Claude Code and Codex instead of driving whichever version is on the user's PATH? The answer is yes, and the shape matters more than the yes. Nothing here is built. It is a record at a point in time, read [`plans/README.md`](README.md) first.

Every claim below was read off the checkout on the day it was written — the versions, the sizes, the resolution paths — not from memory.

## What Frizz does today

Frizz drives two runtimes, and it pins them asymmetrically.

**Claude.** A Claude thread is driven through `@anthropic-ai/claude-agent-sdk`, pinned at `0.3.207` in [`packages/claude-agent-sdk-runtime/package.json`](../packages/claude-agent-sdk-runtime/package.json) and bundled into the published artifact. That SDK is built against Claude Code `2.1.207` (its `package.json` carries `claudeCodeVersion`, and its `manifest.json` lists a per-platform sha256 for that build). Anthropic ships the matched binary as an optional platform package — `@anthropic-ai/claude-agent-sdk-darwin-arm64@0.3.207`, ~198 MB — and the SDK's own default lookup, when handed no executable path, resolves exactly that package from `node_modules`. That package is installed in this checkout.

Frizz does not use it. [`context.ts`](../packages/server/src/context.ts) hands the broker bridge `executablePath: opts.claudeBin ?? "claude"`, and [`claude-broker-host.ts`](../packages/server/src/backend/claude-broker-host.ts) resolves that bare name on PATH to an absolute path because the SDK demands one. On the machine this was written on, PATH's `claude` is `2.1.260` — fifty-three releases ahead of the SDK that drives it. The SDK-to-CLI stream is a private protocol; nothing in Frizz audits that gap, and nothing gates it. So Frizz already pins half of the Claude pair and lets the other half float, which is the worst of both arrangements: a fixed client speaking to an unfixed server.

**Codex.** A Codex thread is driven through `codex app-server --stdio`, spawned from PATH by [`codex-app-server-daemon.ts`](../packages/server/src/backend/codex-app-server-daemon.ts). Here Frizz has a real pin: `CODEX_APP_SERVER_SUPPORTED_VERSION = "0.153.2"` in [`codex-app-server.ts`](../packages/server/src/backend/codex-app-server.ts), audited against a generated protocol schema at an immutable Rust tag. The gate refuses an older binary and runs a newer one with a latched warning. The re-pin to `0.153.2` on 2026-09-04 shows the coupling that matters: `gpt-6-astra` only exists in the catalogue of a Codex at or above `0.153.0`, so a new model already forces a Frizz release. `codex-protocol-conformance.test.ts` checks Frizz's parameters against the binary's own schema, but it SKIPS whenever the machine's Codex is not the pinned version — so on a dev machine that has moved on, the audit silently stops running.

**Both vendors already install versioned, side-by-side copies.** The native Claude installer keeps `~/.local/share/claude/versions/2.1.2xx` and the Codex CLI keeps `~/.codex/packages/standalone/releases/0.153.2-aarch64-apple-darwin` (220 MB binary plus a 63 MB `codex-code-mode-host`). Both are published to npm as per-platform packages: `@anthropic-ai/claude-agent-sdk-<platform>-<arch>` at the SDK's version, and `@openai/codex@<version>-<platform>-<arch>` behind `@openai/codex`'s optional dependencies.

## Why provisioning is the right pattern

1. **For Claude it is the vendor's own shape.** The SDK expects to find its matched binary beside itself; PATH resolution is Frizz's deviation, not the default. Pinning the CLI to the SDK collapses two coordinates into one: bumping the SDK is how Claude Code is bumped, and the pair is matched by construction.
2. **For Codex the pin already exists; only the binary is missing.** With a provisioned binary the gate becomes exact, the "newer than audited, running anyway" branch and its latched warning disappear, and the conformance test runs against the shipped binary in CI instead of skipping on whichever machine happens to have drifted.
3. **PATH resolution is where the platform bugs live.** Both Windows fixes to the broker's resolver — `0f8c88f8` (follow npm's `.cmd` shim to the real `claude.exe`, because the extensionless file is a POSIX shell script) and `517e9c8e` (Windows spells the search path `Path`, and a copied environment has no `PATH` key at all, which refused to boot the whole server) — are bugs in finding a binary someone else installed. A native binary at a path Frizz chose has neither problem.
4. **Nothing the user cares about lives in the binary.** Credentials (`~/.claude`, the keychain, `~/.codex/auth.json`), settings, skills, plugins, hooks and `.mcp.json` are all read from HOME. A Frizz-owned binary reads the same ones. The README's promise — *your subscription, your rate limits, your settings* — survives intact.

## Why NOT as npm optional dependencies

The published `frizz` package is ~10 MB unpacked and carries three runtime dependencies; the SDK is bundled into `dist`, so the platform package is not pulled today. Adding both runtimes as optional dependencies would make every `npx frizz` pull ~430 MB into the npx cache (5.5 GB on this machine already), with no lazy fetch and no offline fallback. The simplicity is real — the SDK would resolve its own binary with no Frizz code at all — but the install cost lands on every first run of every project.

## The shape to build

The Playwright model: pin in the package, fetch on first use, verify, fall back with a warning.

- **One pin per backend, declared in the package.** Claude: the SDK version, from which the CLI version follows (`claudeCodeVersion`). Codex: the existing audited coordinate. Bumping either is a normal Frizz release, exactly as the Codex re-pin already is.
- **Source: the vendors' own npm platform packages.** `@anthropic-ai/claude-agent-sdk-<platform>-<arch>@<sdk>` and `@openai/codex@<ver>-<platform>-<arch>`. The registry tarball carries an integrity hash, and the SDK's `manifest.json` carries a second sha256 for the Claude binary. Fetching from the registry avoids redistributing anything.
- **Destination: `~/.frizz/runtimes/<backend>/<version>/`**, one directory per pin, with a retention sweep that keeps the current pin and the previous one. A Claude pin is ~200 MB and a Codex pin ~280 MB, so a sweep is not optional.
- **Resolution order:** an explicit `--claude-bin` / `--codex-bin` (both flags exist) wins; then the Frizz pin; then PATH as a WARNED fallback when the fetch fails — an offline or firewalled machine must still dispatch, and the warning is what tells the operator the SDK-to-CLI gap is open again. Reuse the vendor's own versions directory when it already holds the exact pin, before downloading.
- **When to fetch:** at the first dispatch of that backend, with progress in the launcher readout — not at install, and not for a backend the machine never uses. A background prefetch at server boot is a reasonable refinement.
- **`DISABLE_AUTOUPDATER=1` in the worker environment**, or the provisioned Claude Code updates itself out from under the pin on its first idle moment.
- **The login utility runs the provisioned binary.** `claude auth login` and `codex login` in [`login-utility.ts`](../packages/server/src/login-utility.ts) should write credentials with the same build that will read them.
- **The Codex gate becomes exact**, and the conformance test points at the provisioned binary.

## Costs to accept, not to hide

- **Frizz lag becomes model lag.** Today a user gets a new Claude Code feature in their workers with `claude update`. Afterwards they get it when Frizz re-pins. The `--claude-bin` override is the escape hatch; the default stays pinned.
- **Two copies of each CLI on one machine.** The operator's terminal `claude` and the worker's `claude` differ. A terminal `claude -r` on a Frizz thread crosses versions; the on-disk transcript format has been forward-compatible so far, but it becomes a seam to watch. Remote control from claude.ai/code and the mobile app (`b0182978`) rides the CLI, so a feature there arrives on Frizz's cadence too.
- **Disk and time on first use.** ~480 MB across both backends, downloaded once per pin per machine.
- **Copy.** The README says "the CLIs you already have installed" in three places (the Requirements line, the feature bullet, and the FAQ). Those become "a Claude Code or Codex subscription, signed in" — the CLI is no longer the user's to install for Frizz's sake, though signing in still happens through one.

## Size of the work

A medium feature: a `runtimes.ts` provisioner (fetch, verify, extract, sweep), the resolution order wired into the two spawn paths and the login utility, launcher readout for the download, the Codex gate simplified to exact, the conformance test repointed, README copy, and a real-artifact verification on macOS, Linux and Windows — the Windows leg is the one that has bitten every time, and the `gcloud-vm` skill exists for it.

## Built 2026-09-04 — what landed, and where it departs from the shape above

Built the same day, on the `provisioned-runtimes` branch, and merged to `main`. `packages/server/src/runtimes.ts` is the module; `ARCHITECTURE.md` § Provisioned runtimes is the current description. Three departures from the shape above, each deliberate:

- **Fetched at BOOT, not at first dispatch.** Every consumer of the executable — the broker bridge, the app-server daemon, the auth probes, the login utility, the quota readers — takes it as a plain string out of the context, and the context is built once at boot. Resolving in a `runtimes` boot phase before the context reuses that plumbing untouched; a lazy first-dispatch fetch would have made every one of those sites async. The cost is one download of both pins on a machine's first boot (~530 MB here, well under a minute on a normal connection), reported through the launcher readout; every later boot is a marker read.
- **No reuse of the vendors' own versioned installs.** `~/.local/share/claude/versions/` and `~/.codex/packages/standalone/releases/` are pruned on their own schedules, and a pin that can vanish under a running server is worse than one download.
- **The sweep keeps only the current pin**, not the previous one too — the cache root is regenerable by definition, and a rollback re-downloads.

And one finding that changed the pin itself: **the SDK-matched Claude Code must be CURRENT, not merely matched.** The first end-to-end run provisioned 2.1.207 — the build the SDK Frizz had sat on since July was built against — and the very first worker failed with `API Error: 400 Claude Code 2.1.207 does not support this model; version 2.1.251 or newer is required`. A model's minimum CLI is enforced server-side, so a stale pin is a broken worker, not a conservative one. The SDK was bumped to 0.3.260 (Claude Code 2.1.260, the same build the maintainer's own terminal runs) as part of landing this, and `runtimes.test.ts` pins the pair to the SDK's manifest so the two cannot drift apart again. The lesson for every future bump: bump the SDK when a model lands, and treat "the worker refuses the default model" as the signal that the pin is overdue.
