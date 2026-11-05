# Did a relayed request or terminal ever pass the access gate? (2026-11-05)

Answers section 3 of [`frizz-sh-incident-todo.md`](frizz-sh-incident-todo.md). Investigated read-only, with tests against old builds in throwaway copies on no real state.

## Answer

**No stranger could reach a board's pages, RPC or terminals through `*.frizz.sh` in any published version.** So `colin.frizz.sh` is not supported as the first-theft route. The route that took the SSH key and the Cloudflare token is still unknown.

| Question | Answer | Status |
|---|---|---|
| Did the relayed terminal ever open without a session? | No. Between `c9b5557c` and `e48047e9` it was refused for everybody, and no release carries that code | VERIFIED BY TEST |
| Did a relayed HTTP request ever reach the child without a session? | No, in every build tested from the first relay commit that can run to `main` | VERIFIED BY TEST |
| What could a stranger do? | Read `/_frizz/control/status`, `POST` restart and `POST` update-restart, on frizz 0.4.0 to 0.13.5. Fixed in 0.13.6 by `ad780770` | VERIFIED BY TEST |
| Was there a version with no gate at all? | Yes, before the relay: `--public-origin` on frizz 0.1.0 to 0.3.0. See "The gap that was real" | VERIFIED BY TEST |
| Did the production gate hold? | One sample: an unauthenticated `GET https://colin.frizz.sh/` answered 401 on 2026-09-20 13:52:24Z | From the thread `8cce0695` transcript |

## Three corrections to the record

1. **The board was public far earlier than 2026-09-19.** The launcher logs show `colin.frizz.sh` through the relay from 2026-08-26 11:19 PDT. The 09-19 date is only the last launcher start before the theft.
2. **`/term` was not a full terminal.** Since `ed3b5dab` (2026-08-02) it served only a provider sign-in pty, for a slug with a sign-in in progress. What a stranger would have wanted is `/ws` and RPC, which sit behind the same gate.
3. **Deleting the CNAME on 2026-09-21T22:09:21Z did not move the name onto the Worker.** The Worker already held it. See below.

## Which path served the name

| Period | What served `colin.frizz.sh` | Evidence |
|---|---|---|
| 2026-08-15 15:34Z to 08-25 16:25Z | Tunnel `colin` (`0ed3f50d…`), a proxied CNAME, `frizz.yml` ingress to `127.0.0.1:9494`, when a connector ran | Cloudflare audit log; sweep prong quoting `frizz.yml` |
| 08-25 16:25Z to 16:28Z | `*.frizz.sh` route, root path only | Audit log |
| 08-25 16:28:59Z onward | `*.frizz.sh/*` Worker route, with the proxied CNAME still present until 09-21 | Audit log, and the proof below |

**Proof the Worker won over the CNAME.** On 2026-09-20 a phone rendered raw brotli from `colin.frizz.sh`. The cause was the Worker compressing a second time. Thread `8cce0695` ran `wrangler deploy` at 14:11Z, changing nothing but the Worker, and the same URL then decoded correctly (verified by it at 14:12Z). The CNAME was still in place for another 32 hours. `packages/relay/README.md` records the same precedence for `registrar.frizz.sh`. A cloudflared connector had no traffic after 08-25, including the one the launcher ran from 08-25 16:03 PDT to 08-26 11:03 PDT.

So the tunnel was not serving the name from 09-19 to 09-21. Why the attacker deleted the record is unexplained. It did not change routing.

## Which build held the gate

The gate and the relay agent live in the launcher, `frizz`. Reading the published tarballs: `frizz@0.13.1` carries `arrivedPublicly` and `headers.host = publicUrl.host`, `frizz-server@0.14.1` carries neither. So the launcher version decides this and the `frizz-server` version does not.

| Started (PDT) | Launcher, port | Transport |
|---|---|---|
| 08-25 16:03 | `frizz-dev`, 9494 | Tunnel, already behind the Worker route |
| 08-26 11:19 to 09-04 15:57 | `frizz-dev` builds of the working tree, 9494 | Relay. Uncommitted source can't be retested |
| 09-11 11:15 | `frizz` 0.12.11, 9393 | Relay |
| 09-14 14:19 | `frizz` 0.13.0, 9393 | Relay |
| 09-19 11:20, 11:21, 13:18 | `frizz` 0.13.1, 9393, server child 0.14.1 per the 10-08 sweep | Relay, until 09-25 |
| 09-25 13:01 and 16:00 | 0.13.1, then 0.13.5 | None: the claim failed once `gh` was signed out |
| 09-26 12:31 | 0.13.5 | Relay, as `kpfhl7cbp5qf4olyh2t7.frizz.sh` |

The board at the moment of the first attacker push (2026-09-21T11:01:56Z) and the first stolen-token action (16:15:58Z) was launcher 0.13.1, started 09-19 13:18 PDT.

Logs: `frizz-projects.zip` on the `FreshArchive` drive, `projects/029a30af…/logs` and `projects/b47f4055…/logs`.

## The windows

| Window | Commits | Published in | What was open to a stranger |
|---|---|---|---|
| 2026-08-03 11:57 to 08-15 00:49 PDT | `ab88796f` to `ec6ecb1a` | frizz 0.1.0, 0.2.0, 0.3.0 | **Everything, when run with `--public-origin`:** pages, RPC, every upgrade, access-code, sessions |
| 2026-08-15 00:49 to 09-30 16:11 PDT | `ec6ecb1a` to `ad780770` | frizz 0.4.0 to 0.13.5. Relayed from 0.7.7 | `status`, restart, update-restart. Access-code was refused from 0.4.0 at the latest. Reads no file |
| 2026-08-25 10:01:39 to 10:11:57 PDT | `c9b5557c` to `e48047e9` | None. 0.7.5 predates it, 0.7.7 postdates it | Nothing. Every relayed terminal was refused, failing closed |

`frizz@0.0.1`'s `gitHead` isn't in this repository, so it isn't settled either way. `frizz-server` is unaffected in every version, since it has no public listener or gate of its own.

### The gap that was real

Frizz 0.1.0 to 0.3.0 with `--public-origin` had no secret at all. At `ab88796f` and `v0.3.0`, raw requests with the public `Host` returned 200 for RPC and 101 for `/_frizz/term/x` and `/ws`. It came before the relay, so it needed an operator running their own tunnel.

Colin's tunnel was created at 2026-08-15 15:34Z, 7h45m after `ec6ecb1a` closed this, and its ingress pointed at 9494, the dev launcher's port, whose builds came from the tree at or after that commit. The one way left is a published 0.3.0 started by hand on that port. Nothing suggests it, but the launcher logs for that span are gone. **What is not settled:** whether any board on this Mac was tunnelled under another hostname from 08-03 to 08-15. Claude transcripts from before 08-27 are gone. The Frizz account's audit log starts 08-15. The human shell history has no `cloudflared tunnel run` and no quick tunnel, but agents' commands are not in it. The Pullfrog Cloudflare account's audit log for 08-03 to 08-15 would settle it, for tunnel and DNS events. This matters because the theft date has only an upper bound: `~/.frizz-cf-token` dates from about 2026-08-04 (`7f6fe6a9`) and the key from 2015.

The maintainer should decide on an advisory for 0.1.0 to 0.3.0 with `--public-origin`, and whether to deprecate them. Who else used the flag in those twelve days can't be known from here.

## How it was tested

Each ref was exported with `git archive` into its own scratch folder and installed there. Harnesses: `~/Documents/scratch/redteam-gate-history/`.

- `redteam-gate.mjs`: the real `RestartSupervisorProxy` and real relay agent at that commit, a toy child counting everything that reaches it, and frames shaped as the Worker builds them.
- `redteam-tunnel.mjs`: raw HTTP and upgrades at the proxy with the public `Host` and Cloudflare's headers, as cloudflared delivers them.
- `redteam-workerd.mjs`: a stranger's raw socket through the real Worker and Durable Object on local workerd, real `connectRelay`, real proxy.
- `verify-relay-terminal.mjs` at `v0.13.1`: a real `/bin/sh` pty behind the real `terminal.ts`. Unauthenticated refused, redeemed session ran a command, 6/6.

| Ref | Pages, RPC, upgrades, no cookie | Session opens a terminal | Control plane, no cookie |
|---|---|---|---|
| `ab88796f`, `v0.3.0` (tunnel harness) | **Open** | n/a | Open |
| `ec6ecb1a`, `bc3d2e33`, `v0.4.0`, `v0.7.5` (tunnel harness) | Refused | n/a | status, restart, update-restart open |
| `c9b5557c` | Refused | **Refused**, confirming the commit message | status, restart, update-restart open |
| `e48047e9` | Refused | Yes | Same |
| `v0.7.7`, `v0.8.0`, `v0.12.11`, `v0.13.0`, `v0.13.1`, `v0.13.5` | Refused | Yes | Same |
| `v0.13.7`, `v0.13.8`, `main` at `42103d7f` | Refused | Yes | Refused |

`c9b5557c` and `e48047e9` needed one scratch-only line, the `@frizz/shared` root export that `c122ed72` added. `e3dd61ac` was not run: it has no `ws` dependency for the harness and predates any wiring into a launcher. Its `headers.host = publicUrl.host` was read.

The harness rows `L1` on builds before 0.13.8 mean only that `signOutAll` didn't exist yet. They are not findings.

## What this does not establish

- **Nobody can show who sent what.** Before the audit trail (`1f8d38be`, 2026-10-09), the board logged no visitor, session or RPC origin, and the Worker kept no logs. The launcher logs show two "requested from browser" restarts and two failed update-candidate lines in 08-26 to 09-24, none attributable. Restart or update can't read a file.
- **Update without a session was a real capability.** `update-restart` installs the npm `latest`. That is code execution only for someone who could also publish `frizz-server`. No update line lands in the theft window, and the frizz repository was not among those pushed on 09-21.
- **The `frizz-dev` builds of 08-26 to 09-04 ran the working tree.** The commits around them were tested, not those exact bytes.
- **The first theft.** The prior investigations (`thread-5c6eacc1-sweep.zip`, `investigate-vector-local.md`) concluded a silent file read by code running as the user. This report adds nothing against that and doesn't explain it.
