# frizz.sh incident — open to-dos (2026-10-08)

What is still owed after the 2026-09-21..10-08 compromise of the frizz.sh Workers. The account of what happened is in [`packages/relay/README.md`](../packages/relay/README.md); the machine-local evidence and reports are in the maintainer's `.frizz/threads/d178f311-c9a3-4816-85e9-f595219a1f92/` (gitignored). Nothing here is urgent in the sense of an open hole that is known: the backdoored Workers were replaced with clean builds on 2026-10-08, the implant and the `~/.zshrc` dead-drop on the maintainer's Mac are removed, and every board session is signed out. Each item below is hardening or follow-through.

## Already done (checked 2026-10-08 20:50 PDT)

- `frizz@0.13.8` and `frizz-server@0.15.17` are on npm, published from `46ab24bb`. They carry the 30-day session lifetime and the session epoch that signs out every older remote device once, and the zero-scope GitHub device flow.
- Every `@nubjs/*@0.9.4` package is deprecated (`@nubjs/types@0.9.4` is gone from npm).
- The implant's kill-switch file `$TMPDIR/log_de-0.log` exists.
- The maintainer's own board rotated its `session-key` at 2026-10-08 17:01, and it serves a private name (`kpfhl7cbp5qf4olyh2t7.frizz.sh`), not a custom one.
- Custom frizz.sh names (the GitHub-backed claim) are withdrawn from every menu and doc behind `CUSTOM_NAMES_OFFERED` in [`src/cloud.ts`](../src/cloud.ts). A name already claimed keeps renewing, because a renewal is signed by the board's keypair and never touches GitHub.
- The live Workers were read and compared with source on 2026-11-05: both active versions rebuild from `2c8820df`'s tree, apart from compiler output. Routes, domains, crons, DNS and members match the baseline, neither Worker holds a secret, and the token stolen in September no longer exists. `scripts/cloudflare-tokens.mjs --audit --out=<dir>` takes that snapshot.

## 1. Deploy the Workers from CI — one sitting per deploy

The workflows exist ([`workers-deploy.yml`](../.github/workflows/workers-deploy.yml), [`workers-drift.yml`](../.github/workflows/workers-drift.yml)), and the `workers-deploy` environment waits for a maintainer's approval. It holds no token, on purpose: a deploy token exists only for the hour around a deploy ([`scripts/cloudflare-tokens.mjs`](../scripts/cloudflare-tokens.mjs) says why). `workers-drift` is disabled until its read token exists. The live registrar is older than `main` and lacks the refusal of any GitHub token that carries a scope (`6acda883`), which matters because Frizz before 0.13.8 still sends `gh auth token` on a custom-name claim.

The commands are in that script's header. In order:

1. The maintainer makes a token on [`colin@pullfrog.com`'s API tokens page](https://dash.cloudflare.com/profile/api-tokens) from the **Create Additional Tokens** template, scoped to the Frizz account with a one-day expiry, and hands it over on a `kind: secret` card. It goes into the environment only.
2. `--audit --out=<dir>`: read what it saved, including the `CLAIMS` keys, against the previous snapshot. A finding stops here. `--dry-run` lists the account's Workers permission groups, in case the deploy token can be narrowed to the two scripts.
3. `--only=drift`, then `gh workflow enable workers-drift.yml`, push `main`, and dispatch it. This first run must fail, naming the 2026-10-08 versions, which is the proof it can.
4. `--only=deploy`, then dispatch `workers-deploy.yml` with target `both`. The maintainer approves it within the hour.
5. `--revoke-deploy`, then `nub scripts/verify-relay-live.mjs`.
6. Dispatch drift again. It fails with `WORKERS_CI_AUTHOR is not set` and prints the deploy token's author. Set that repository variable and dispatch until it is green. Three things can keep it red:
   - **The sitting's own changes.** Any change in the audit log that CI would not make fails the check until it is two hours old, including removing a member or turning on DNSSEC.
   - **Something CI's own run does.** The check has only read a real log of laptop deploys, so it may name an action `wrangler versions` also takes, such as `patch_settings`. Add it to `JUDGED_BY_VERSION` only if `checkAccount` already compares what that action can change.
   - **An account-owned token that reports a member's address.** Stop here if it does: the check then fails every CI deploy and cannot tell CI from a member's token, so it needs another way to tell them apart.

   Compare the author across deploys, because if each token uploads as itself, this variable changes per deploy.
7. The maintainer deletes the token from step 1.

## 2. Bring custom names back (optional)

Only when custom names are wanted again.

1. Open [new GitHub OAuth app](https://github.com/settings/applications/new). Application name `Frizz`, Homepage URL `https://frizz.sh`, description `Confirms which GitHub account claims a frizz.sh name. Requests no permissions.`, Authorization callback URL `https://frizz.sh`. Tick **Enable Device Flow**, click **Register application**, copy the **Client ID**. Do not generate a client secret.
2. Set `FRIZZ_GITHUB_CLIENT_ID` in [`src/github-device-flow.ts`](../src/github-device-flow.ts) to that id, and `CUSTOM_NAMES_OFFERED = true` in [`src/cloud.ts`](../src/cloud.ts). Run [`scripts/verify-claim-e2e.mjs`](../scripts/verify-claim-e2e.mjs) (its header gives the invocation) and claim one real name by hand from the R pane, then cut a shell release ([CLAUDE.md § Cutting a release](../CLAUDE.md)).

## 3. How the SSH key and the Cloudflare token left the Mac

Still unknown. The relay is not supported as the route: [`frizz-sh-relay-terminal-gate.md`](frizz-sh-relay-terminal-gate.md) (2026-11-05) found that a stranger holding only the subdomain could not get code execution in any published relay version. It also found that a hostile relay needs no visitor and no cookie: a frame carrying both `host` and `Host` makes a board judge the request as loopback.

## 4. Make the relay unable to read traffic

[`plans/blind-relay.md`](blind-relay.md) is the design: the relay carries ciphertext it cannot read or forge, so whoever can deploy the Worker no longer controls every board. Not started.

## 5. The maintainer's Mac

The implant gave the attacker an interactive shell as `colinmcd94` from 2026-09-28 to 2026-10-08. A sweep can find what is left; only an erase proves nothing is.

1. Quit and reopen Ghostty (**Cmd+Q**), Cursor, Zed and VS Code, if not done since 2026-10-08 — a shell started before the `~/.zshrc` cleanup still ran the dead-drop loop.
2. Optional, before or instead of the erase: run the exhaustive sweep prompt below in a fresh session.
3. Erase and reinstall. Copy out data only — not `~/Library`, dotfiles, `~/.ssh`, `~/.claude`, `~/.frizz`, apps or `node_modules`. Then open [Transfer or Reset](x-apple.systempreferences:com.apple.Transfer-Reset-Settings.extension) → **Erase All Content and Settings**, set the Mac up as new (no Time Machine or Migration Assistant restore), and rotate every credential from the clean Mac. Do not publish or deploy from this Mac until then.

```text
You are doing an exhaustive compromise sweep of this Mac (user colinmcd94) after a confirmed intrusion. Another session already removed the known footholds. Your job is to find anything that is left. Default to READ-ONLY: report first. Only an item that is clearly hostile may be neutralized, and then by MOVING it into /Users/colinmcd94/Documents/projects/frizz/.frizz/threads/d178f311-c9a3-4816-85e9-f595219a1f92/quarantine/ (chmod a-x), never by deleting. Never run a suspicious binary or script. Never contact attacker infrastructure. Never print a secret value. If you start Chrome, pass --use-mock-keychain.

Known facts (details: /Users/colinmcd94/Documents/projects/frizz/.frizz/threads/d178f311-c9a3-4816-85e9-f595219a1f92/incident.md, prong-*.md, implant-analysis.md):
- ~2026-09-21: a 2017 SSH key (~/.ssh/id_rsa.compromised-20260921) and a Cloudflare API token (~/.frizz-cf-token, path named in the public frizz .gitignore) left this disk; vector unknown. The GitHub pushes on 09-21 put an EtherHiding loader into zod, standard-schema and nub.
- 2026-09-28 05:08 PDT: a Frizz thread was dispatched to this board through the backdoored frizz.sh relay (Haiku, bypassPermissions) and ran uname/whoami/ps.
- 2026-09-28 06:26 PDT: implant "System Event.app" (Go, NPS-based RAT: shell, file read/write/timestomp, command exec, proxy, upload to Alibaba OSS) ran until 2026-10-08 11:53. The attacker had an interactive shell as this user for 10 days, so assume any file was read and anything could have been planted, with forged timestamps.
- 2026-09-28 07:45 PDT: a "SESSION_SYNC" command dead-drop went into ~/.zshrc (now removed).
IOCs to grep for everywhere (files, binaries, configs, git history): api.ubuntu-wiki.online, ubuntu-wiki, 0x8CD41b2bEc90b1799689850564658b0aa15b9A43, getDomains, t!JNxAbK7#0fo&I-, TsNFQr_LwqFj4rsw, log_de-, mix-interpreted-parliament-homes, trycloudflare.com, 64.176.203.80, 38.55.103.2, 2001:19f0:4000:2103, f272d9460b1df6bb, 0xe236330379d0c54aD5b2ef06aC714CEbdd4Ce523, 0x53ed5143, setupB64, payloadB64, __SETUP_DONE__, RUNTIME_DIR, SESSION_SYNC, /tmp/.auth, com.system.event, SystemEvent, sha256 036807450bca2dda3f2ef89bcbb907df6ef57fca9a6d57eb2d0ff8af3da37ba8 and 5ed518aaff5aebc729545b8eb223ec31927cd1bfa53169517f09cdbcc9fd5a0b.

Sweep, and record for each area: what you checked, the exact commands, and the findings.
A. Persistence: every LaunchAgent/LaunchDaemon (user and system, including hidden "." files), `launchctl print gui/$(id -u)` for jobs with no plist on disk, login items (`sudo sfltool dumpbtm`; ask the maintainer to approve sudo), cron, at, /etc/periodic and /usr/local/etc/periodic, `profiles list` (configuration profiles), system/kernel extensions (`systemextensionsctl list`), and every folder in ~/Library/Application Support, /Library/Application Support, ~/Library/Containers and ~/Applications that was created since 2026-09-20.
B. Shell and runtime hooks: every rc file for zsh/bash/fish in ~ and /etc; ~/.oh-my-zsh/custom/** and every plugin; direnv .envrc files; NODE_OPTIONS/--require; Python sitecustomize.py and *.pth in every site-packages; ~/.npmrc, ~/.yarnrc*, pnpm/bun/nub configs (registry, script-shell, ignore-scripts); PATH hijacks: list every executable in each PATH dir that comes before /usr/bin and flag any wrapper for git, gh, ssh, sudo, npm, node, claude, codex or wrangler.
C. Git: `git config --global --list` (core.hooksPath, aliases, include, credential helpers, url.insteadOf); every repo under ~/Documents/projects and ~/.cache/*worktrees*: non-sample files in .git/hooks, .git/config oddities, commits since 2026-09-21 authored as "colinhacks <colinhacks@users.noreply.github.com>" or unsigned in a way that does not match the maintainer's identity, and IOC strings in working trees.
D. AI-agent surfaces (the attacker targets agents): ~/.claude/settings.json and every project .claude/settings*.json (hooks, permissions, env), ~/.claude.json and every .mcp.json (MCP servers pointing at unexpected binaries or URLs), ~/.claude/CLAUDE.md, every CLAUDE.md/AGENTS.md/FRIZZ.md under ~/Documents/projects, every skill in ~/.agents/skills, ~/.claude/skills, ~/.codex and project .agents/skills: look for text that tells an agent to send data anywhere, run fetched code, disable checks, or that was modified since 2026-09-28 without a matching git commit. Also check ~/.codex/config.toml and Codex remote-control enrolment.
E. Editors: VS Code, Cursor and Zed extensions installed or updated since 2026-09-20, settings and tasks.json with "runOn": "folderOpen", and workspace trust settings.
F. Binaries and droppers: Mach-O files under ~ (outside node_modules, cargo/go caches and app bundles you can attribute) modified since 2026-09-27; ad-hoc-signed executables anywhere under ~ and /usr/local; executables in /tmp, /private/var/folders and ~/Library/Caches; any file whose sha256 matches the implant.
G. Network and trust: /etc/hosts, `scutil --proxy`, `networksetup -listallnetworkservices` with proxy/DNS settings per service, VPN configurations, `security find-certificate -a` in the login and System keychains for any root CA added since 2026-09-20 (a MITM root), `lsof -i -nP` for unexpected listeners or connections, running ssh -R/-L/-D tunnels, Remote Login and Screen Sharing state, ~/.ssh/authorized_keys and ~/.ssh/config (ProxyCommand, LocalCommand, Include).
H. TCC grants: read ~/Library/Application Support/com.apple.TCC/TCC.db (read-only sqlite) and list every app that holds Full Disk Access, Accessibility, Screen Recording, Input Monitoring or Automation; flag any not attributable to a known app.
I. Frizz itself: every project under ~/.frizz/projects: ui.db threads spawned since 2026-09-20 whose prompt the maintainer did not write (bypassPermissions, an unusual model, prompts that only run commands); claude-broker diagnostics logs; the board's remote sessions list (`/_frizz/control/sessions` on the supervisor's loopback port); and whether ~/.frizz/identity.key (the frizz.sh claim keypair) must be rotated and the name re-claimed. Report the steps; do not re-claim without asking.
J. Cloud and service accounts whose credentials were on this disk: list each credential file or keychain item (gcloud, aws, Vercel, Neon, Better Stack, Resend, Anthropic, OpenAI, Docker, 1Password CLI, Slack and Discord desktop sessions, Claude ~/.claude/.credentials.json, Codex auth.json), with a deep link to where the maintainer rotates each one. Read-only listings where a CLI is already signed in: e.g. `gcloud compute instances list` and project SSH keys in metadata, `vercel` projects and tokens, GitHub (`gh api user/keys`, `user/gpg_keys`, `user/installations`, deploy keys/webhooks/collaborators/secrets/environments of every repo the account admins), npm (`npm token list`; publishes since 2026-09-21 for every owned package via `npm view <pkg> time --json`), and Cloudflare (members, account and user tokens, workers, DNS records and their recent changes, Zero Trust tunnels, Pages, R2, email routing).
K. Persistence of access, not just code: any OAuth app or GitHub App authorized since 2026-09-21 (https://github.com/settings/applications), and active sessions on GitHub, Google, npm and Cloudflare that the maintainer should end.

Finish with: (1) a list of hostile findings and what you quarantined, (2) a list of suspicious items for the maintainer to decide, each with the evidence, (3) a rotation checklist where every item is a clickable link to the exact page plus the value or command needed, and (4) what you could not check and why. Keep the maintainer's working tree and running processes intact; never stop a process you cannot attribute to the attacker.
```
