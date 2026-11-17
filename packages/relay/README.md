# Relay

One wildcard hostname in front of every board. `*.frizz.sh` resolves here; a board dials in over a
WebSocket and holds it open, and a visitor's request for that board's hostname is routed to the
Durable Object holding that socket and framed down it.

**A claim creates no infrastructure**, which is the whole point: no DNS record per name and no tunnel
per name, so the 200-record ceiling that bounded the original design is gone. The [registrar](../registrar)
records who owns a name; this serves it.

**This IS on the data path**, unlike the registrar, and that is the trade the design makes deliberately: unlimited names cost us the traffic. A visitor still meets Frizz's own single-use access gate on the far side, but the credential that gate checks crosses this hop, so the relay is trusted with it. Every byte passes through in plaintext: the access code as it is redeemed, the session cookie on every later request, and everything the board shows that session. **Whoever can deploy this Worker can act as any device signed in behind it.** That happened between 2026-09-21 and 2026-10-08: a stolen Cloudflare token was used to deploy a build that copied all of it out and drove a board with a copied cookie. That is why deploys go through CI only (below), and [`plans/blind-relay.md`](../../plans/blind-relay.md) is the design that takes the plaintext away from this hop.

## What a remote session may do

The owner of a board chooses one of two levels for a session that arrives through the relay, in the terminal's **R** menu. Only that menu can change it, and the Worker has no way to ask.

**Full control** is the default, and it is what a tab on the machine can do. **A hostile build of this Worker holding a real cookie can therefore run anything on that machine**, because it can start a worker. Minting sign-in links, listing and signing out devices, and changing the level stay on the machine at this level too.

**Read and answer** is reading the board and picking listed options on question cards. The board refuses the rest:

- starting or steering a thread, and any change to its settings or permissions;
- typing an answer, answering a secret or danger card, and answering an approval card;
- restarts, updates and minting sign-in links;
- reading a file outside a registered project and a thread's scratch and attachment directories, or a secret-looking file inside one.

The rule lives on the board, in one table (`REMOTE_ACCESS` in [`remote-gate.ts`](../server/src/remote-gate.ts)), so at this level a hostile build holding a real cookie gets no more than that. It still reads what the session reads and can rewrite what the visitor sees, which only the blind relay removes.

A frame can't claim to be local. The board's relay agent dials a loopback listener of its own on which every request counts as public, whatever the frame's headers say.

## What it carries

A board is mostly a live surface, so a plain request/response proxy would be useless for it. The
protocol in [`@frizz/shared/relay-protocol.ts`](../shared/src/relay-protocol.ts) frames three things:

- **a unary request**, answered in one frame;
- **a streamed response**, because the board's event feed is SSE and never ends — the head and the body
  are separate frames for exactly that reason;
- **a nested WebSocket**, because the board's live feed is a WebSocket. The Durable Object asks the
  board to open its local end and links the two, and refuses the visitor's upgrade outright when it
  cannot: a feed that opens and stays silent is far harder to diagnose than one that fails.

A frame body caps at 512 KiB. A Cloudflare WebSocket message caps at 1 MiB and base64 costs a third on
top, so anything larger takes the streaming path rather than being dropped.

A visitor's request body caps at 26 MB, a little over the largest a board accepts (an attachment), and is refused with a 413 before the Durable Object reads it. Without the cap anyone who knew a name could have the object, and then the board, hold a body of any size.

## How a board proves itself

The same Ed25519 identity that claimed the name, signing a handshake that rides in the connect URL —
before the upgrade, so an unproven socket never occupies the name's Durable Object at all. The relay
verifies it against the public key the registrar recorded, holds no secret of its own, and stops
believing a handshake older than five minutes.

- **A handshake is spent on use.** The Durable Object keeps the newest one it accepted from each key and takes only a strictly newer one. Until 2026-11-12 one connect URL, seen by a TLS-inspecting proxy or a log of request URLs, could reconnect as the board for five minutes, replacing it each time and reading its visitors' cookies. The board signs a fresh handshake for every connect.
- **The key is checked on every request, not only on connect.** The Worker reads the owner for every visitor request and hands it to the Durable Object, which closes the attached board (code 4003) when its key is no longer the owner. The board tells its operator, and so it does when another connection with its own key replaces it.

## When a board's socket drops

Cloudflare cuts a board's socket now and then, usually without a close frame, and the board dials back in within a second or two. On 2026-11-16 one board's socket was replaced 131 times in a day. A visitor should never see that, so the relay hides it:

- **A request that is safe to repeat waits for the board.** A GET, HEAD or OPTIONS that was in flight when the socket went, or that arrives while the board is away, goes down the next socket the board opens. The relay waits up to 10 seconds for it, and only for a board it saw in the last minute, including one whose socket's close is what woke the Durable Object. Each request is sent at most three times, inside the 30-second deadline it was given when it was first sent. A POST caught by a drop still fails, because whether the board saw it can't be known, and so does a GET carrying a sign-in link's `frizz_code`, which the board redeems.
- **A request only ever goes to a board of the key it was made for.** Its validators were filtered for that key and its answer is tagged with it ([below](#when-a-name-changes-hands)), so a board of another key dialling in fails it instead. The owner is checked again after the wait, because KV is eventually consistent and can let the previous key's board back in.
- **A body cut short fails.** A drop in the middle of a streamed answer, or the board's own response breaking off, errors the visitor's response. A short body ended cleanly would read as whole, since `content-length` doesn't cross the relay, and a browser would cache it with its ETag.
- **A page load the relay can't serve gets a page that loads the board again by itself**, on a backoff and whenever it comes back into view, instead of a line of text. A board opened from a phone's home screen has no reload button.
- **Only the current board socket is heard.** A socket the relay replaced stays open until its far end answers the close, which a previous holder of the name need never do.
- **A woken Durable Object takes the newest open board socket.** `getWebSockets` still lists a socket the relay closed when its far end never answered the close, and every reconnect leaves one. Until 2026-11-16 a wake attached each listed board socket in turn, and when a stale one came last it closed the live board as "replaced by a newer connection". The visitor whose request woke it got "The board did not answer" instead of the board.
- **The board pings every 20 seconds and gives each ping 5 seconds** ([`src/relay-connection.ts`](../../src/relay-connection.ts)), so a socket cut without a word is noticed within 25 seconds, inside a visitor's deadline. The 5 seconds start once the ping can have left: behind a large answer on a slow uplink it waits its turn, and anything arriving from the relay counts as the answer.

## When a name changes hands

A phone keeps everything it holds for `ada.frizz.sh` whoever's board serves it: cached files, validators, cookies. A name can move to another key (a custom name taken back by its account, or claimed again after a lapse), so whatever one holder's board gave a browser must not work for it under the next. The second security review ran the attack in a headless browser: a holder served `/assets/index-<hash>.js` with its own script and a year's `immutable`, the name moved, and the next board's page ran the cached copy beside a live session. The file name and its ETag are public, so a revalidation alone would have been answered 304. The relay sees every answer, so it applies these rules for every board ([`visitor-headers.ts`](src/visitor-headers.ts)):

| What a board sends | What the visitor gets |
|---|---|
| Any `Cache-Control` but `no-store` | `no-cache`: stored, revalidated before every use |
| `ETag: "abc"` | `ETag: "<key tag>.abc"`, tagged by the serving board's key |
| `Last-Modified`, `Expires` | dropped |
| `Set-Cookie` with `Domain` | the same cookie without it |
| `Clear-Site-Data: "cookies"` or `"*"` | dropped, since it clears every board's sessions |
| `Service-Worker-Allowed` | dropped |

On the way in, an `If-None-Match` reaches the board only for its own key's tags, and date conditionals never do. A copy cached from another key is therefore answered in full and replaced. A request for a service worker script is refused outright. The cost is one 304 per asset on a reload, through the relay.

Two of these exist because `frizz.sh` is not on the Public Suffix List, so every board is one site to a browser. A `Domain=frizz.sh` cookie rode to every board, and six large ones locked a visitor out of all of them with 431s.

## Deploying

Only GitHub Actions deploys this Worker, never a laptop. Dispatch [`workers-deploy.yml`](../../.github/workflows/workers-deploy.yml) from `main`; it typechecks, runs the unit tests below and deploys:

```sh
keyward --reason "deploy the frizz.sh Workers" -- gh workflow run workers-deploy.yml --ref main -f target=both
```

**The Cloudflare token exists only around a deploy, and it is the one approval a deploy takes.** Sign in for the sitting with [`scripts/cloudflare-oauth.mjs`](../../scripts/cloudflare-oauth.mjs), an Authorize click on Cloudflare's consent screen, then mint it just before dispatching with [`scripts/cloudflare-tokens.mjs`](../../scripts/cloudflare-tokens.mjs) `--only=deploy`, which gives it one hour, and revoke it afterwards with `--revoke-deploy`; that file's header has the commands and the reason. With the secret empty, a dispatched run fails at Deploy having changed nothing.

`target` takes `relay`, `registrar` or `both`. Each deploy is stamped `ci:<sha> run:<run id>`, and [`workers-drift.yml`](../../.github/workflows/workers-drift.yml) checks every 30 minutes that everything this Worker runs carries a stamp from a finished, successful run of that workflow, and that the rest of the account matches a baseline. Anything else fails the check, and GitHub emails the failure. A deploy from a laptop, the dashboard or `wrangler rollback` therefore raises the alarm by design: from 2026-09-21 to 2026-10-08 an attacker holding a Cloudflare token ran backdoored builds of this Worker, and those uploads looked exactly like a laptop deploy. An upload by an account member's own token fails however it is stamped. A tail fails too, because it streams the cookies and access codes this Worker carries and leaves no other trace; so does any other change in the audit log that CI would not make, until it is two hours old. A deploy's own tokens are not such a change: `scripts/cloudflare-tokens.mjs` records each one it mints in the repository variable `WORKERS_MINTED_TOKENS`, and their create and revoke pass. To recover from a bad deploy, revert it on `main` and dispatch the workflow again. The rules the check applies are in [`scripts/workers-drift.mjs`](../../scripts/workers-drift.mjs).

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
nub --test packages/relay/src/          # the Durable Object's state machine, the Worker, the header rules
nub scripts/verify-relay-e2e.mjs        # the frames, on real workerd
nub scripts/verify-relay-gate.mjs       # a relayed terminal against the REAL access gate
nub scripts/verify-relay-live.mjs       # the DEPLOYED relay, from outside — after every deploy
```

The unit tests drive the Durable Object's state machine against fakes, which proves each half and
nothing about the seam between them — and there are three seams here that all have to hold at once. So
the e2e harness runs the real Worker under `wrangler dev`, a real board on loopback, and a real agent
connecting them, including a terminal typed through both runtimes.

Run it after any change to `worker.ts`, however small. workerd reads every export of the Worker's main module as an entry point and refuses to start when one is a constant. An exported body cap did exactly that on 2026-11-12, with every unit test green, and this harness failed at once. A unit test now fails on such an export too.

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
