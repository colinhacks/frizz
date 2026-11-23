# Why the `frizz` shell keeps shipping

Investigation, 2026-11-22. Nothing here is built yet.

The October move of launch routing into the server worked: the shell then went 24 days without a release. Since 2026-11-05 it has shipped in 12 of 19 releases, and remote access is the main reason.

| Period | `frizz-server` releases | `frizz` shell releases |
| --- | --- | --- |
| 2026-10-12 to 2026-11-05 | 20 (0.15.25 to 0.15.44) | 0 |
| 2026-11-05 to 2026-11-21 | 19 (0.15.44 to 0.15.62) | 12 (0.13.14 to 0.13.25) |

Each shell release costs users something a server release doesn't:

- Every running board tells its owner to stop Frizz and run `npx frizz` again (the launcher notice since 0.13.18).
- Three releases in four days raised `frizzServer.minimum` (0.13.15 to 0.13.17), so every older machine replaced its server at its next start, with no click on Update.

## What changed in each release

Each row comes from diffing a release's published `dist/frizz.js` against the one before it, one source section at a time (esbuild's `// path` comments), and reading the commits behind each section.

| Shell | What changed in the bundle | Kind |
| --- | --- | --- |
| 0.13.14 | Updates under a `min-release-age`; R menu wording | updater, remote setup |
| 0.13.15 | A relayed request always counts as remote (a sign-in bypass) | relay, session gate |
| 0.13.16 | The device access row; daily frizz.sh name renewal | remote setup |
| 0.13.17 | Sign out devices; the menu at 80x24; the launcher answers uploads | remote setup, public listener |
| 0.13.18 | Rollback of a crashing update; old releases removed; no dependencies; confirm before going public | updater, remote setup |
| 0.13.19 | The R menu's device list | remote setup |
| 0.13.20 | The registrar's new claim protocol; custom names; sessions bound to their name | remote setup, session gate |
| 0.13.21 | A Claude Code retention warning in the launch readout | readout notice |
| 0.13.22 | Runtime downloads before a restart; the boot checklist pages | updater |
| 0.13.23 | Relay reconnects | relay |
| 0.13.24 | The R menu's Access section; supervisor pages at phone sizes | remote setup, supervisor pages |
| 0.13.25 | A copy of `project-root.ts` (the home project) | none |

## Causes

Five things, most of them small.

1. **Remote-access setup lives in the shell.** The claim flow, the registrar client, the device list, the access level and every R menu screen are in `src/remote-pane.ts`, `src/cloud.ts`, `src/registrar-client.ts` and `src/github-claim-identity.ts`: about 1,600 lines. By the October plan's own test they are rules, not mechanism. They changed in 7 of the 12 releases. In 0.13.20 the registrar changed its claim protocol, and from then on no shell at 0.13.19 or older could claim a name.
2. **The readout's notices are written in the shell.** 0.13.21 was one warning line. The launch route already answers with a `notice` that the shell prints ([`launch-routing.ts`](../packages/server/src/launch-routing.ts)), so the server could have sent that line.
3. **The preflight counts any edit under `src/`.** That's `launcherFiles` in [`release-preflight.mjs`](../scripts/release-preflight.mjs). `src/worker-plugin-closure.ts` and `src/artifacts.ts` are dev-time modules the bundle doesn't include, and 0.13.25 was cut for the first of them: its notes name a worker file that ships in `frizz-server`. The check also misses server files bundled into the shell, such as `supervisor-pages.ts` in 0.13.22 and 0.13.24.
4. **Half the shell is code it never runs.** `@frizz/shared` exports only its barrel. The shell imports `DEFAULT_PORT` and the claim helpers through it, and with them gets zod, yaml and every schema: 658 KB of the 1.28 MB bundle, nearly all of it unused. The barrel changed in 10 of the 12 ranges, so the shell's bytes change with nearly every release, and diffing the bundle can't say whether the shell changed.
5. **Only a shell release moves the bootstrap pin.** A machine with no server installs `frizzServer.version`. While the shell was quiet, new machines started on 0.15.23 with 0.15.44 out (0.13.14's notes). Fewer shell releases means a staler first boot unless the first boot stops depending on the pin.

## Proposed changes

Items 1, 2 and 4 are release hygiene. Item 5 is the structural one.

| # | Change | Ships in | Would have avoided |
| --- | --- | --- | --- |
| 1 | The preflight diffs the built shell against the published one, section by section | repo tooling | 0.13.25 |
| 2 | The shell imports `@frizz/shared` through subpaths, so the barrel, zod and yaml leave the bundle | shell | (makes item 1 exact) |
| 3 | The launch route answers `notices: string[]`, and readout notices are written in the server | server, then one shell release | 0.13.21 |
| 4 | A first boot installs the newest compatible `frizz-server`, with the pin as the fallback | shell | a stale first boot between shell releases |
| 5 | Remote-access setup moves into the server, and the R menu becomes a client of it | server, then one shell release | 0.13.16, 0.13.19, 0.13.24, most of 0.13.20 |

With all five, 6 of the 12 releases would have been server-only or not needed at all. The other 6 changed the relay, the session gate, the public listener or the updater, which is the mechanism the shell is there for.

### First boot onto the newest server

Update already installs `frizz-server@latest` under whichever shell is running, checked against protocol and data epoch (`planRegistryUpdate` in [`production.ts`](../src/production.ts), `ServerReleaseStore` in [`server-release.ts`](../src/server-release.ts)). A first boot that does the same allows no pairing the Update button doesn't already allow. The pin stays as the fallback, for when the registry can't be read or `latest` is incompatible.

### Remote-access setup in the server

The R menu is already "a small state machine over a handful of screens, rendered whole on every change", fed raw keys by the pane host. That's the seam:

```
shell                                         server child
R pressed  ── POST /_frizz/control/pane ──▶   state machine, claim, registrar client,
key        ── { key } ──────────────────▶     device list, access level
paint      ◀── { lines, cursor } ─────────    writes the remote config
relay      ◀── reads the config ──────────
```

The route is gated by the owner token, as `/_frizz/control/launch` is. A server that predates it gets today's menu, frozen and never edited again, the same fallback launch routing uses. The shell keeps the relay transport (`relay-connection.ts`, `relay-agent.ts`), the public listener and its session check, and applying a config to the running board.

Those stay because a phone away from the machine has to reach a broken server through them. A full-control session can restart or update a wedged board from the supervisor's page ([`restart-supervisor.ts`](../packages/server/src/restart-supervisor.ts)). The launcher rolls back a crashing update while that phone stays connected. With the relay in the server, a broken server would cut off the only way back in.

Setup can move because nothing it does matters while the server is down. It runs at launch, on a keypress, or once a day to renew the name. The relay reconnects with the name and key already on disk. Signing devices out goes through the supervisor's own sessions route, which `frizz --sign-out` already uses.

One property changes. Today only the R menu and the saved setup can change what a relayed session may do (`setRelayAccess`), and no route reaches it. After the move, the owner-token route can change it too. That route is loopback-only, like `/_frizz/control/launch`.

## Not doing

- **Running the whole launcher from the server package.** §9 of [`server-side-launch-routing.md`](server-side-launch-routing.md) still holds. A fix like 0.13.15's sign-in bypass would then wait for each user's Update click.
- **A release schedule for the shell.** Holding launcher changes back for a weekly cut delays the fixes users need without making the shell any thinner.
