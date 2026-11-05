# Relay

One wildcard hostname in front of every board. `*.frizz.sh` resolves here; a board dials in over a
WebSocket and holds it open, and a visitor's request for that board's hostname is routed to the
Durable Object holding that socket and framed down it.

**A claim creates no infrastructure**, which is the whole point: no DNS record per name and no tunnel
per name, so the 200-record ceiling that bounded the original design is gone. The [registrar](../registrar)
records who owns a name; this serves it.

**This IS on the data path**, unlike the registrar, and that is the trade the design makes deliberately: unlimited names cost us the traffic. A visitor still meets Frizz's own single-use access gate on the far side, but every byte passes through the relay in plaintext — the access code as it is redeemed, the session cookie on every later request, prompts, transcripts and terminal keystrokes. **Whoever can deploy this Worker controls every board behind it.** That happened between 2026-09-21 and 2026-10-08: a stolen Cloudflare token was used to deploy a build that copied all of it out and drove a board with a copied cookie. That is why deploys go through CI only (below), and [`plans/blind-relay.md`](../../plans/blind-relay.md) is the design that takes the plaintext away from this hop.

## What it carries

A board is mostly a live surface, so a plain request/response proxy would be useless for it. The
protocol in [`@frizz/shared/relay-protocol.ts`](../shared/src/relay-protocol.ts) frames three things:

- **a unary request**, answered in one frame;
- **a streamed response**, because the board's event feed is SSE and never ends — the head and the body
  are separate frames for exactly that reason;
- **a nested WebSocket**, because the board's terminals are WebSockets. The Durable Object asks the
  board to open its local end and links the two, and refuses the visitor's upgrade outright when it
  cannot: a pane that opens and stays silent is far harder to diagnose than one that fails.

A frame body caps at 512 KiB. A Cloudflare WebSocket message caps at 1 MiB and base64 costs a third on
top, so anything larger takes the streaming path rather than being dropped.

## How a board proves itself

The same Ed25519 identity that claimed the name, signing a handshake that rides in the connect URL —
before the upgrade, so an unproven socket never occupies the name's Durable Object at all. The relay
verifies it against the public key the registrar recorded, holds no secret of its own, and stops
believing a handshake older than five minutes.

## Deploying

Only GitHub Actions deploys this Worker, never a laptop. Dispatch [`workers-deploy.yml`](../../.github/workflows/workers-deploy.yml) from `main`; it waits for a maintainer's approval on the `workers-deploy` environment, typechecks, runs the unit tests below and deploys:

```sh
keyward --reason "deploy the frizz.sh Workers" -- gh workflow run workers-deploy.yml --ref main -f target=both
```

**The Cloudflare token exists only around a deploy.** Mint it just before dispatching with [`scripts/cloudflare-tokens.mjs`](../../scripts/cloudflare-tokens.mjs) `--only=deploy`, which gives it one hour, and revoke it afterwards with `--revoke-deploy`; that file's header has the commands and the reason. With the secret empty, a dispatched run fails at Deploy having changed nothing.

`target` takes `relay`, `registrar` or `both`. Each deploy is stamped `ci:<sha> run:<run id>`, and [`workers-drift.yml`](../../.github/workflows/workers-drift.yml) checks every 30 minutes that everything this Worker runs carries a stamp from a finished, approved run of that workflow, and that the rest of the account matches a baseline. Anything else fails the check, and GitHub emails the failure. A deploy from a laptop, the dashboard or `wrangler rollback` therefore raises the alarm by design: from 2026-09-21 to 2026-10-08 an attacker holding a Cloudflare token ran backdoored builds of this Worker, and those uploads looked exactly like a laptop deploy. To recover from a bad deploy, revert it on `main` and dispatch the workflow again. The rules the check applies are in [`scripts/workers-drift.mjs`](../../scripts/workers-drift.mjs).

**Then check the relay that is now serving.** A green run means the upload happened, and the drift check means CI made it; neither says a board loads through it.

```sh
nub scripts/verify-relay-live.mjs
```

[`verify-relay-live.mjs`](../../scripts/verify-relay-live.mjs) puts a toy board behind the real `*.frizz.sh` under a private name of its own and asks for everything the protocol carries, each request on a deadline. Nothing else looks at what the deployed Worker does: on 2026-10-05 the live relay lacked two fixes `main` had carried for five days, every revalidation came back as a 504, and a phone that had the board cached loaded a blank page while a fresh browser loaded fine ([#49](https://github.com/colinhacks/frizz/issues/49)).

Two things that will waste your time otherwise:

- **A route pattern without `/*` matches only the root path.** `*.frizz.sh` alone serves `/` and 522s
  everything else. The pattern is `*.frizz.sh/*`, and the trailing `/*` is not optional.
- **A workers route beats a custom domain.** This wildcard swallowed `registrar.frizz.sh` the day it
  shipped and took signup down. The registrar answers that with a more specific route of its own; do
  not remove it.

## Verifying

```sh
nub --test packages/relay/src/board-socket.test.ts packages/relay/src/worker.test.ts
nub scripts/verify-relay-e2e.mjs        # the frames, on real workerd
nub scripts/verify-relay-gate.mjs       # a relayed terminal against the REAL access gate
nub scripts/verify-relay-live.mjs       # the DEPLOYED relay, from outside — after every deploy
```

The unit tests drive the Durable Object's state machine against fakes, which proves each half and
nothing about the seam between them — and there are three seams here that all have to hold at once. So
the e2e harness runs the real Worker under `wrangler dev`, a real board on loopback, and a real agent
connecting them, including a terminal typed through both runtimes.

The two harnesses answer different questions, and the second exists because the first cannot.
A board in `verify-relay-e2e.mjs` is a toy that accepts every upgrade, so a relay forwarding NO visitor
identity passes there and would fail against the real thing. `verify-relay-gate.mjs` puts the real
`RestartSupervisorProxy` in the path: an unauthenticated terminal is REFUSED and never reaches the
 board, and a visitor holding a redeemed session gets through.

`verify-relay-live.mjs` is the only one that leaves the machine, and it is not the e2e harness aimed at
another host: the real edge re-compresses a body and weakens its ETag on the way out (`"v1"` arrives
as `W/"v1"`), so the validator a browser sends back is not the one the board minted, and it carries a
2 MiB frame through an edge where the message cap is enforced. It claims one private name from the
production registrar and keeps it, with its key, in Frizz's state root, so every later run renews that
name instead of leaving a new row behind. Held against the relay source from before `7264ab4c` on
local workerd it fails the 304, 204, empty-200, HEAD and redirect checks and passes the other twelve
(2026-10-11) — the same checks pass 20 of 20 against the relay deployed that day.

**Two measured facts worth not re-deriving.** `wrangler dev` does NOT enforce Cloudflare's 1 MiB
WebSocket message cap, so an UNCHUNKED build passes the end-to-end reassembly check — the assertion
that catches it is the unit test on serialized frame size. And a pipe delivers at most 64 KiB per read, so
a terminal alone can never approach that cap; the message that can is a board snapshot, which is why
`ws-msg` chunks at all.

The first harness uses `localhost` as the zone rather than `frizz.sh`, so `ada.localhost` is a valid board name and
resolves to loopback without touching DNS. Two traps it exists to remember: `wrangler dev` synthesizes
the request URL FROM THE ROUTE PATTERN, so the production config makes every request arrive as
`frizz.sh` — the harness writes a routeless config of its own. And `fetch` silently drops a `Host`
header, so a spoofed one proves nothing; use a real hostname.
