# Security review 2: frizz.sh claims, relay and sessions

> [!NOTE] What landed after this review (2026-11-12)
> The registrar, the relay and the launcher were hardened before custom names were offered. The table says what happened to each finding; the review follows unchanged. [`frizz-sh-incident-todo.md`](frizz-sh-incident-todo.md) § 2 has the deploy.

| # | Outcome |
|---|---|
| 1 | Fixed in part. Claims must be JSON; budgets are spent in one SQL statement and cannot overspend; a ceiling of 300 new random names an hour covers every network; the namespace holds a million and keeps its count. Someone with many networks can still use up the hour's random names for as long as they keep claiming. Names are not yet tied to being served |
| 2a | Fixed. The relay checks the owner on every request and closes a board whose key lost the name |
| 2b | Fixed. The relay revalidates every answer, tags ETags with the serving key, drops date validators and refuses service worker scripts. No `Clear-Site-Data` on the code exchange: the relay's rules leave nothing cached for it to clear |
| 2c | Fixed. A session works only on the host it was issued under, and a board answered `renewed: false` signs out every session under that host |
| 3 | Fixed in part. A fresh token for the same account id takes the name back, and the board that loses it says to revoke Frizz on GitHub. No delay or cancel: both sides hold a token for the same account (`claim-handler.ts` says why) |
| 4 | Fixed. A handshake is accepted only if newer than the last one from its key |
| 5 | Fixed in the relay, which drops a cookie's `Domain` and `Clear-Site-Data` for cookies. `frizz.sh` was not submitted to the Public Suffix List |
| 6 | Fixed. Sessions and sign-in codes are bound to the host they were issued under |
| 7 | Fixed. A new random name must be one of the 64 derived from the claiming key |
| 8 | Fixed. From Frizz's registrar the hostname must be the name asked for under `frizz.sh`, and a run token is ignored |
| 9 | Fixed. Every claim runs behind one lock row in D1 |
| 10 | Fixed. A visitor's body caps at 26 MB before the Durable Object reads it |
| 11 | Fixed. The sweep reads lapsed names in one query, oldest first, 100 a run |
| 12 | Fixed. A request naming the public host on the main port gets no more than the relay gives |
| 13 | Fixed. A key has one accepted spelling |
| 14 | Fixed. A lapsed row is released only after every check that can refuse the claim |
| 15 | Not fixed. A replayed renewal needs the request body, so a TLS break |
| 16 | Not fixed |
| 17 | Fixed. Control characters are stripped from a refusal before it is printed |
| 18 | Reserved names extended, the relay's logging pinned off, and a displaced board says so. The device list still has no last-seen |

Read-only review of `main` at `cb458e215`, 2026-11-11. Line numbers are for that tree. Nothing in the repository was changed, and nothing was sent to `registrar.frizz.sh` or any `*.frizz.sh` name.

Every proof of concept is in `~/Documents/scratch/claim-review-2/` and runs locally: the real `handleClaim` and registrar Worker entry over an in-memory KV, the real relay Worker and Durable Object on local workerd (`wrangler dev`), the real `RestartSupervisorProxy` and relay agent, and puppeteer's headless shell through `launchHeadless()`. Baseline on this tree: `verify-claim-e2e.mjs` 23/23, claim-handler 37/37, registrar worker 21/21, relay worker 6/6, board-socket 28/28.

Status words: **RUN** means the exploit was run (CONFIRMED-by-running), **CODE** means confirmed by reading (CONFIRMED-by-code), **PLAUSIBLE** means it depends on something not run here, usually a platform limit or a browser other than the headless shell.

## Findings, most severe first

| # | Severity | Status | Finding |
|---|---|---|---|
| 1 | High (availability) | RUN | The per-network budget does not bound new names: one address mints 200 in a burst, and the namespace then stays full for years |
| 2 | High once take-back ships, medium today | RUN | A name that changes key keeps the previous holder's reach: its relay socket, and script cached in visitors' browsers |
| 3 | Medium-high | RUN | A phished or leaked Frizz-App token takes the account's only possible name for good (L4, now worse) |
| 4 | Medium | RUN | A relay handshake is a five-minute bearer credential: one captured connect URL takes the name's traffic |
| 5 | Medium | RUN | `frizz.sh` is not on the Public Suffix List: a page on any name signs a visitor out of every board, or locks them out |
| 6 | Medium | RUN | Sessions and sign-in codes are honoured under any hostname the board serves (open, as described, plus codes) |
| 7 | Medium | RUN | A "random" name is whatever the client sends, including a GitHub username of that shape (M4, open) |
| 8 | Medium-low | RUN | The launcher saves and dials whatever hostname the registrar answers, and runs a tunnel token it is handed |
| 9 | Medium-low | RUN | The one-per limits race, and two keys can both be told they hold one name (M1, narrowed) |
| 10 | Low-medium | RUN (local) | The relay reads any stranger's whole request body into the name's Durable Object, and hands it to the board in one frame |
| 11 | Low-medium | PLAUSIBLE | The daily sweep reads every row: past about 1,000 names it cannot finish |
| 12 | Low | RUN | "Read and answer" belongs to the relay listener, not the session |
| 13 | Low | RUN | One key has four accepted spellings |
| 14 | Low | RUN | A lapsed custom name's row is deleted by anyone, before any GitHub check |
| 15 | Low | RUN | A replayed renewal moves the key's index back; one custom name per key is one hop wide |
| 16 | Low | CODE | A custom name outlives the GitHub username it was claimed for |
| 17 | Low | RUN | A registrar's refusal text reaches the terminal with its escape sequences |
| 18 | Low | CODE | Hardening: reserved names, the relay's logging pin, a displaced board says nothing, the device list has no last-seen |

---

### 1. The per-network budget does not bound new names (high, availability, RUN)

**Where**
- `packages/registrar/src/worker.ts:186-197` (`kvHourlyBudget` reads the counter, then writes it), `:131-139` (`budgetAddress`, a /64), `:350-386` (the `fetch` handler takes any content type from any origin), `:224` (`MAX_NAMES_RELAY = 100_000`).
- `packages/registrar/src/claim-handler.ts:225-228` (the budget is the only cost of a random name), `:256-259` (capacity is a full `list()` per new claim), `:298-311` (a renewal is free, unbudgeted and never checks the lease), `:455-482` (the sweep releases 50 names per daily run).

**What is wrong.** Four separate things, each enough alone:
- **A burst passes whole.** Every claim in a burst reads the counter before any of them writes it. 200 parallel claims from one address minted 200 names, and the counter row read `1` afterwards. The comment at `worker.ts:182` expects "one slips past".
- **A /48 is 65,536 budgets.** A free tunnelbroker allocation, or most hosting plans, give one. 300 of its /64s minted 3,000 names in one hour, sequentially.
- **Any web page can spend a visitor's budget.** The handler checks neither `content-type` nor `Origin`, so a claim is a "simple" cross-site POST. A page sends ten claims signed by its own keys from each visitor's browser and address. That visitor is then answered `too-many-claims` for an hour.
- **What is minted stays.** A renewal costs nothing, so a squatter keeps every name with one request a month each. Abandoned names lapse after 30 days and are then released 50 a day: 3,001 abandoned names take 60 more days to clear, 100,000 take five and a half years.

**Exploit.** A stranger with no account generates keys, signs claims for random names, and sends them in parallel (or across a /48, or through a busy web page). At `MAX_NAMES_RELAY` every new claim, random or custom, is answered `namespace-full`. Boards already serving keep renewing, so nothing alerts anyone but new users.

**PoC.** `poc-registrar.ts` A and B, `poc-registrar-crosssite.ts`.

**Fix.** See "The overall hourly ceiling" and "One Durable Object" below. In short: count and budget inside the Durable Object, require `content-type: application/json` on `POST /claim`, and make a name earn its 30 days by being served.

---

### 2. A name that changes key keeps the previous holder's reach (high once take-back ships, medium today, RUN)

A name moves from one key to another in two ways today (a custom name lapses and its username's account claims it under another key; two keys race), and take-back will add a third that is immediate. Three things survive the move.

#### 2a. The relay keeps the old board's socket

**Where.** `packages/relay/src/worker.ts:348-374` checks the owner's key only on `/_relay/connect`. `Board.fetch` (`:229-245`, `:271-324`) and `BoardSocket.attach` (`board-socket.ts:122-135`) never look at it again. `ownerPubkeyFor` (`:122-131`) reads KV with its default 60-second cache.

**Run on real workerd.** The registry row for `ada` was changed from the old key to a new one. A new connection signed by the old key got 401. Three seconds later a visitor carrying a session cookie was answered by the old holder's board, which received `__Host-frizz_session=THE-NEW-OWNERS-PHONE`. Its socket was never dropped.

**Reach today.** Narrow: the new owner's board displaces the old socket the moment it connects, and the old key cannot reconnect once KV agrees. What is left is the gap between claim and connect, a new owner who claims and does not serve, and the 60 seconds in which some PoP still accepts the old key. It becomes the main event with take-back: a squatter's board stays attached to the name it just lost.

**PoC.** `relay-poc/poc-relay.mjs` 1.

**Fix.** Put the key on the socket: `serializeAttachment({ role: "board", pubkey })`. The Worker already reads the owner on every visitor request; pass it to the Durable Object and close a board socket whose key is not the owner's before answering. Better, the registrar's Durable Object tells the name's Board object when a name changes key, so the kick does not wait for KV.

#### 2b. Script the previous holder cached runs under the next holder's session

**Where.** `packages/server/src/index.ts:466` and `:550` serve everything under `/assets/` as `public, max-age=31536000, immutable`. The built `index.html` names its entry chunk with no `integrity` attribute. The chunk's file name is fixed per release and public (it is in the npm tarball). The relay passes a board's response headers through as written (`relay/src/worker.ts:113-116`, `board-socket.ts:318-323`). Nothing sends `Clear-Site-Data`.

**Exploit.**
1. The attacker holds a name: its own username, or someone else's through finding 3.
2. Anyone who follows one link to that name gets a page from the attacker's board. It needs no sign-in, because it is the attacker's board. The page loads `/assets/index-<hash>.js` for each current release, served by the attacker with `immutable` and its own script. Or it caches `/` itself for a year.
3. The name moves to the victim's key (a lapse and re-claim today, a take-back tomorrow).
4. The victim signs that browser in with a real link. The real board's `index.html` asks for `/assets/index-<hash>.js`, the browser answers from its cache, and the attacker's script runs in the board's origin beside a live session. Under full control, which is the default, that is `dispatch`: code on the victim's Mac.

**Run in the headless shell.** One origin, two servers in turn. After the hand-over the page ran the first server's script and the second server was asked for its bundle 0 times.

**`Clear-Site-Data` did not fix it here.** With `Clear-Site-Data: "cache", "storage"` on the sign-in redirect, the attacker's script still ran. A control (`poc-csd-check.mjs`) shows the same browser clearing cookies for that header and leaving the cached script. Whether full Chrome and Safari evict it was not tested, since only the headless shell may be driven here. Do not make it the only defence.

**PoC.** `poc-origin-poison.mjs`, `poc-csd-check.mjs`.

**Fix.** The relay is the one place that sees every board's responses, so do it there:
- Cap `cache-control` max-age on every response the relay forwards (rewrite `immutable` and anything longer) to less than the shortest time in which a name can change key. Then the next holder's first load revalidates and gets its own bytes. Frizz's hashed assets cost one 304 each per load.
- Keep a name unserved for at least that long whenever its key changes.
- Refuse any request carrying `Service-Worker: script`. Frizz registers no service worker, and one registered by an interim holder would see the next holder's sign-in link before the board does.
- Still send `Clear-Site-Data: "cache", "storage"` on the code exchange, as a second layer.

#### 2c. Cookies the interim holder collected are good again when the name comes back

Sessions bound to a hostname (the planned fix) stop a cookie harvested on name A being replayed on name B. They do not stop this: the victim's board serves A, loses A to a squatter or a take-back by a phished token, phones bookmarked on A send their cookies to the interim holder, and the victim takes A back. The board's key and session directory never changed, so those cookies verify again on A.

**Fix.** Bind a session to the hostname and to the claim that hostname was held under. The registrar already says `renewed: false` for a fresh acquisition (`claim-handler.ts:344-347`): a board that receives it for a hostname revokes every session bound to that hostname. A `claimedAt` in the answer, stored on the session record, does the same without trusting the launcher's memory.

---

### 3. A phished or leaked Frizz-App token takes the account's only possible name (medium-high, RUN)

Previously L4, re-rated upwards for two reasons.

**It is the only name, and the refusal is `name-taken`.** Since the username-only rule, the squatter's claim takes the one name the account can ever hold. The owner, with their own key and a fresh token, was answered `409 name-taken`, and still was eleven months later while the squatter renewed by key alone (`claim-handler.ts:199-204`, `:210-218`). The to-do says the owner gets `one-name-per-account`; on this tree they get `name-taken`.

**The token does not have to leak. It can be asked for.** The App's client id is public (`shared/src/claim.ts:21`) and its device flow needs no secret (`server/src/github-credential.ts:344`, `:414-436`). Anyone can start a device sign-in for "Frizz Agent Console" and talk a GitHub user into typing the code at `github.com/login/device`, where the app shown is the real one. The result is an 8-hour token and a refresh token that rolls for six months.

**Exploit.** Phish or read one token. Claim `<victim>.frizz.sh` under your own key. Serve anything there: it reads as that person's board, on Frizz's domain. Renew monthly, forever. Finding 2b then turns a later hand-back into code on their machine.

**PoC.** `poc-registrar.ts` D.

**Fix.** See "Taking a username back" below.

---

### 4. A relay handshake is a five-minute bearer credential (medium, RUN)

**Where.** `src/relay-connection.ts:240-243` puts the signed handshake in the connect URL's query. `packages/relay/src/worker.ts:62-99` accepts any handshake for the name signed by the owner and dated within five minutes of now, either side. Nothing ties it to a connection, and the same one is accepted any number of times.

**Run on real workerd.** With the real board connected, a client holding one captured `h=` value and no key reconnected every 20 ms. Each connect replaced the real board's socket. Over 8 seconds it answered 74 of a signed-in phone's 75 requests and read the session cookie off each. The real board's backoff (0.25 to 30 s) loses every race.

**Reach.** The attacker needs one connect URL: a TLS-inspecting proxy on the board's network, or any log that records request URLs. Five minutes of traffic is enough, because the cookies last 30 days and are full control by default.

**PoC.** `relay-poc/poc-relay.mjs` 2.

**Fix.** The Board object keeps the last accepted `issuedAt` per name in its storage and accepts only a strictly newer one, so a handshake is spent on use. Or a challenge: accept the socket, send a nonce, and attach it as the board only after the nonce comes back signed. Either way, tell the operator when their board is replaced by another connection: the launcher logs only "the relay connection closed", and a replacement loop is what a copied `identity.key` looks like too.

---

### 5. `frizz.sh` is not on the Public Suffix List (medium, RUN)

**Where.** `publicsuffix.org/list/public_suffix_list.dat` fetched 2026-11-11 has no `frizz.sh` entry. So every board is the same site as every other, and as `registrar.frizz.sh`. The relay forwards a board's `Set-Cookie` and `Clear-Site-Data` as written.

**Exploit.** Anyone can hold a name with no account. A visitor who opens one page on it (in Chrome, an image embedded in any site is enough) gets either of these:
- **Signed out everywhere.** `Clear-Site-Data: "cookies"` clears the whole registrable domain. Run in the headless shell: the victim name's HttpOnly session cookie was gone on its next request.
- **Locked out.** Six 3.5 KB cookies with `Domain=frizz.sh` ride every request to every name. Node's 16 KB header limit answers 431 before any handler runs. Through the real relay agent and supervisor, a valid session got 431, and so did a fresh sign-in link from that browser. It lasts until the person clears site data, up to the cookies' 400-day cap.

`__Host-` does its job: a parent-domain cookie cannot replace the session cookie, and the supervisor reads only that name (`restart-supervisor.ts:218`).

**Also, PLAUSIBLE:** Safe Browsing and similar lists score a registrable domain. `*.frizz.sh` is free anonymous hosting behind a valid certificate (any socket that speaks the frame protocol is a "board"), and finding 7 lets the host pick a readable name. One phishing page can put a warning in front of every board.

**PoC.** `poc-sibling-site.mjs`, `poc-gate.mjs` 3, `relay-poc/poc-relay.mjs` 3.

**Fix.** Submit `frizz.sh` to the Public Suffix List's private section; it takes weeks to reach browsers. Until then, in the relay: drop the `Domain` attribute from every `Set-Cookie` a board sends (or the cookie), and drop `Clear-Site-Data` values that name `cookies` or `*`.

---

### 6. Sessions and sign-in codes are honoured under any hostname (medium, RUN)

Open exactly as the to-do describes, with one addition.

**Where.** `packages/server/src/access-codes.ts:341-360` verifies signature, expiry and directory record, nothing about the host. `restart-supervisor.ts:405-411` keeps sessions across `setPublicOrigin`. Codes are the addition: `issue()` (`access-codes.ts:248-258`) and `exchangeCode` (`restart-supervisor.ts:998-1036`) do not record or check the origin a code was minted for.

**Run.** A cookie issued at `oldname.frizz.sh` returned 200 with full control at `newname.frizz.sh`. A code minted for the old name was redeemed at the new one for a fresh session.

**PoC.** `poc-gate.mjs` 1.

**Fix.** See "Binding a session to its hostname" below.

---

### 7. A "random" name is whatever the client sends (medium, RUN)

M4, open as described: `colinhacksfrizzboard`, `frizzloginsupportweb` and `githubsecurityalerts` each claimed with 0 GitHub lookups (`shared/src/claim.ts:97-102`, `claim-handler.ts:194-197`, `:225-228`).

**New detail.** A GitHub username that is itself 20 characters of `a-z2-7` takes the random path, so anyone claims it with no account, and its owner cannot claim it as a custom name at all (`github-claim-identity.ts:68-72` returns null for it).

**PoC.** `poc-registrar.ts` C.

**Fix.** See "The registrar picks random names" below.

---

### 8. The launcher trusts the registrar's answer (medium-low, RUN)

**Where.** `src/registrar-client.ts:137-158` returns `hostname` and `token` as sent. `src/cloud.ts:439-444` saves that hostname in `cloud.json` and switches to tunnel mode if a token is present. `startRelay` (`cloud.ts:516-541`) dials `https://<that hostname>`. `resolveRunToken` (`:465-469`) writes a token from any renewal to disk.

**Run against a registrar on loopback.**
- An answer naming `relay.attacker.example` produced `{"hostname":"relay.attacker.example","claim":"…","serve":"relay"}`. The board would dial that host with a handshake good for five minutes on the real relay (finding 4), gate it as its public origin, and print sign-in links for it.
- An answer with a `token` produced `serve: "tunnel"` and a `tunnel-token` file. The launcher would run `cloudflared tunnel run --token <theirs>`: a remotely managed tunnel whose ingress the token's issuer writes, on a machine that has `cloudflared`.
- A renewal of a relay name answered with a token rewrote `tunnel-token`.

**Reach.** Only whoever answers as the registrar: a compromised deploy, or `FRIZZ_REGISTRAR` pointed elsewhere. A hijacked relay already reads traffic; this adds reach it does not have, past the session gate and past "read and answer". No redirect is followed, and the GitHub token goes only to https or loopback (both sound).

**PoC.** `poc-hostile-registrar.mjs`.

**Fix.** Accept an answer only when `hostname === <name>.frizz.sh` for the zone the client was built for. Ignore `token` unless the saved config is already tunnel mode. This becomes necessary, not optional, once the registrar picks the name.

---

### 9. The one-per limits race (medium-low, RUN)

M1, narrowed by the username-only rule: one account can no longer take N names, because only one name passes. Still open:
- **Two keys, one free name.** Both were told 200. The row belonged to the second, and both `owner:` indexes pointed at the name. The loser's board believes it holds the name until its next renewal answers `name-taken`.
- **The budgets**, which is finding 1.
- **KV is not read-your-writes across PoPs.** A random name's "never reused" check (`:194-197`) and every index read can see a minute-old world.

**PoC.** `poc-registrar.ts` F.

**Fix.** See "One Durable Object" below.

---

### 10. The relay buffers any stranger's request body (low-medium, RUN locally)

**Where.** `packages/relay/src/worker.ts:280` reads the whole body into the name's Durable Object. `board-socket.ts:240` base64-encodes it into one frame. The board's agent parses and decodes that frame (`src/relay-agent.ts:108-110`) before the supervisor is asked whether there is a session.

**Run on local workerd, no session.** A 32 MB POST reached the board as one frame in 1.9 s. A 96 MB POST held the object for 43 s and ended in "Network connection lost". Local workerd enforces neither the 128 MB object limit nor production's WebSocket message limit, so what production does was not measured.

**Effect.** Anyone who knows a name, and a custom name is a GitHub username, can make its Durable Object and the board's launcher process chew through bodies of their choosing. The launcher is the same process that serves the owner's own tab.

**PoC.** `relay-poc/poc-relay.mjs` 4.

**Fix.** Cap the visitor body in the Worker before the Durable Object sees it, by `content-length` and by a counted stream as the registrar does. A request body past about 780 KB cannot be framed under a 1 MiB message limit anyway. Have the agent refuse an oversized frame before decoding it.

---

### 11. The daily sweep reads every row (low-medium, PLAUSIBLE)

`sweepExpiredClaims` (`claim-handler.ts:455-482`) lists the namespace and reads each row, expired or not: 3,005 KV operations at 3,001 names with nothing expired (`poc-registrar.ts` B). Cloudflare documents 1,000 KV operations per Worker invocation, so past roughly 1,000 names the run would throw part-way, every day, and never reach names later in the listing. The read is not in a `try`, so the handler rejects and logs nothing. Not run against real KV.

**Fix.** Sweep from Durable Object storage on an alarm, ordered by lease expiry, with no listing.

---

### 12. "Read and answer" belongs to the relay listener, not the session (low, RUN)

`restart-supervisor.ts:910-913`: a request on the relay listener gets `relayAccess`; a request on the main port naming the public hostname gets `full`. The same cookie was stamped `read-and-answer` through the relay and `via=public, access=full` on the main port with `Host: newname.frizz.sh` (`poc-gate.mjs` 4). Reaching the main port from another machine takes `--host`, so this needs an exposed bind and a device that was signed in under "read and answer". Fix: record the access level on the session record when it is minted, and take the narrower of the record and the listener.

### 13. One key has four accepted spellings (low, RUN)

A 32-byte key is 43 base64url characters with two spare bits. `fromBase64Url` (`shared/src/claim.ts:172-183`) accepts all four values of them, and the registry compares strings. Four spellings of one key were accepted as four identities with four `owner:` rows (`poc-registrar.ts` G). Harmless today because keys are free. It matters the day a name or a limit is derived from the key. Fix: decode and re-encode in `verifyClaim`, and refuse a `pubkey` that does not round-trip.

### 14. A lapsed custom name's row is deleted by anyone (low, RUN)

`claim-handler.ts:199-209` releases a lapsed row before the identity checks at `:229`. A stranger with no token was answered `github-required`, and the row and its `gh:` index were gone. The holder's board, back after a month off, can no longer renew by key and must claim again with GitHub (`poc-registrar.ts` E). It is what the sweep would do the same night, but it runs on a stranger's request. Fix: move the release after every check that can still refuse the claim.

### 15. Replay and the one-custom-name rule (low, RUN)

- A renewal captured inside the five-minute window, replayed after the owner stepped off to a random name, renewed the old name and pointed the key's index back at it (`poc-registrar.ts` J). It takes the request body, so a TLS break. Fix, free with a Durable Object: store the last `issuedAt` per key and accept only a newer one.
- `one-name-per-key` refuses custom to custom, and custom to random to custom passes: one key held `carol`, a random name and `carol-work`, all live (`poc-registrar.ts` I). Each custom name still needs its own account, so nothing is gained. The comment at `:261` already calls it a speed bump.

### 16. A custom name outlives its username (low, CODE)

A renewal never asks GitHub (`:210-218`). An account that is renamed, deleted or suspended keeps serving its old username's name for as long as its board renews, and the username's next owner on GitHub is answered `name-taken`. The account-age gate (`:239`) reads the account's creation date, so an old account renamed onto a freed username passes at once. Fix: a custom name re-proves its account every N days (see take-back).

### 17. A refusal's text reaches the terminal as written (low, RUN)

`registrar-client.ts:143` uses the registrar's `message` for any code it does not know, and the R pane prints it (`remote-pane.ts:499`). An OSC title change, a screen clear and coloured text came through intact (`poc-hostile-registrar.mjs` 3). Hostile registrar only. Fix: strip C0 and C1 control characters.

### 18. Hardening (low, CODE)

- **Reserved names** (`shared/src/claim.ts:44-75`). GitHub usernames that read as infrastructure are claimable by their accounts: `auth`, `account`, `accounts`, `signin`, `sso`, `oauth`, `secure`, `security`, `verify`, `download`, `install`, `get`, `cdn-cgi`, `mta-sts`, `autodiscover`, `autoconfig`, `wpad`, `webmail`, `postmaster`, `abuse`. `colin` passes to GitHub user id 950 after 2026-12-07, as the to-do notes.
- **The relay's `wrangler.toml` has no `[observability] enabled = false`.** The registrar's has. The relay's URLs carry sign-in codes and handshakes. `workers-drift` does alarm on it for both.
- **A replaced board says nothing** (finding 4).
- **The device list shows when a device signed in, never when it was last used or from where**, so a copied cookie in use looks like the phone it was copied from.

---

## What each planned fix must cover

### One Durable Object for every claim

- **No external await inside the decision.** A Durable Object serialises events only across its own storage operations. `await fetch()` opens the input gate, so "read the account's index, ask GitHub, write" inside the object races exactly as it does today. Verify the signature and ask GitHub in the Worker, pass the object `{ id, login, createdAt }`, and do every read and write with nothing awaited between them but storage. `blockConcurrencyWhile` around the GitHub call would work and would queue every renewal behind GitHub's latency.
- **Storage is the truth; KV is a copy.** Reads that decide anything (the row, `owner:`, `gh:`, `retired:`, the counters) come from the object's storage. Write `claim:<name>` to KV afterwards for the relay, and retry a failed write from an alarm.
- **The relay lags.** Its KV read is cached for up to 60 seconds, so a key that lost a name still passes the handshake somewhere for a minute. For any change of key, tell the name's Board object directly (finding 2a).
- **Budgets and counters live in the object** (finding 1). A KV counter beside it keeps the race.
- **Cheap refusals stay in the Worker.** Body cap, JSON shape, signature, content type. One object is one queue, and a flood of unsigned junk should not reach it.
- **Replay closes for free.** Keep the last `issuedAt` per key and accept only a newer one.
- **Migration.** Import `claim:`, `owner:`, `gh:` and `retired:` in one step with writes refused meanwhile. Hand-written rows have no `owner:` index and may have no `githubId`.
- **Order of checks.** Release a lapsed row only after everything that can refuse the claim (finding 14).
- **Canonical keys.** Normalise `pubkey` before it is used as a storage key (finding 13).

### Binding a session to its hostname

- **Bind to hostname and claim, not hostname alone** (finding 2c). On `renewed: false`, revoke every session for that hostname.
- **Bind codes too** (finding 6). Clear outstanding codes when the origin changes.
- **Where to compare.** On the relay listener the supervisor forces `Host` to the current public origin (`restart-supervisor.ts:502-506`), so compare the session's host with the origin in force, not with a header. On the main port compare with the parsed `Host`.
- **Old sessions.** A record with no host cannot be bound after the fact. Raise `SESSION_EPOCH` so each device signs in once, rather than adopting old records onto whatever name is current.
- **The record is the place.** `sessions.json` can carry `host`, `claimedAt` and the access level (finding 12) with no change to the cookie's format.
- **It does not cover cached script** (finding 2b) or the relay's stale socket (2a). Those need the relay changes.

### Taking a username back

- **Who.** Only a token whose account id equals the row's `githubId`. Never `login == name` alone: a username that changed hands on GitHub would evict the previous holder's live board at once. A row with no `githubId` is not take-back-able and waits for its lapse.
- **Not on a token alone, not at once.** A token is phishable (finding 3). If a fresh token moves a live name, a phished one takes a running board's name and its phones' cookies, which is worse than today's squat. Make it a request that completes after a delay longer than the 8-hour token life, with a second fresh proof at the end. Tell the incumbent on its next renewal and over its relay socket, and let it cancel with a fresh token of its own. A squatter holding a refresh token can contest until the owner revokes Frizz's authorisation on GitHub, so the flow should say to do that first; after it, only the owner can prove anything.
- **A quieter alternative that needs no eviction.** A custom name carries a fresh GitHub proof every N days at renewal, and lapses without one. A squatter with a dead 8-hour token loses the name by itself, and finding 16 closes too. Take-back then only shortens the wait.
- **The hand-over.** Quarantine the name for the relay's cache cap (finding 2b), kick the old socket (2a), and have the new board treat the name as freshly claimed (2c).
- **It is also key rotation.** There is no other way to recover a custom name after `identity.key` is copied. Random names have none and are abandoned.

### The registrar picks random names

- **The client must check the answer** (finding 8): random shape, `hostname === <name>.frizz.sh`, no token.
- **A client-chosen name of the random shape** is then one of three things, and each needs a rule: a renewal of a row this key holds (allow), a return to a name retired to this key (allow, since `retired:<name>` equals the key), or a new name (refuse). Old launchers send their own name for a new claim and will be refused, so say "upgrade" by bumping the protocol version for creation and keeping v2 for renewal.
- **GitHub usernames of that shape** (finding 7) can then go through the custom path. Today they go to whoever asks first.
- **Retries.** A lost response and a retry mints two names. Deduplicate on `(pubkey, issuedAt)` in the object.
- **Generation.** `crypto.getRandomValues` with a 5-bit mask as `generateAnonymousClaimName` does, checked against live and retired rows inside the object.

### The overall hourly ceiling

- **Count in the object**, from a stored counter, not `list()`.
- **A ceiling is itself a switch a stranger can hold.** At N an hour, N claims an hour from N/10 addresses refuses every honest new user for as long as it is kept up. Exempt renewals, a key returning to a name it holds or had retired, and custom claims (GitHub is their cost). Give a board that is signed in to GitHub its own lane: a random claim carrying a valid App token is rate-limited per account id instead.
- **A ceiling bounds a rate, and renewals make it a total.** At 100 an hour a squatter who renews holds 100,000 names in six weeks. Bound what is kept: a name that has never had a board attach at the relay lapses in a day or two, and a renewal extends 30 days only if the relay saw it served since the last one. The to-do already words the lease as "30 days after it was last served"; the registrar measures 30 days after it was last asked.
- **Release faster than 50 a day** (finding 11), or a single burst under the ceiling still takes months to drain.
- **Close the browser route**: require `content-type: application/json`.
- **Alert** when the ceiling is hit.

---

## Previously open findings, re-rated

| Finding | Verdict on `cb458e215` |
|---|---|
| **M1**, the one-per limits race | **Open, narrower for accounts, wider for budgets.** One account can no longer take N custom names. Two keys still both win one name (finding 9), and the budget race is worse than recorded: the whole burst passes, not one claim (finding 1) |
| **M3**, no overall ceiling, a listing per claim | **Open, and worse.** /64 keying holds against one /64 only: a /48 is 65,536 budgets, a parallel burst needs one address, and any web page spends its visitors' budgets. The sweep's 50 a day and free renewals make a fill last years |
| **M4**, a random name can be chosen | **Open exactly as described**, plus GitHub usernames of that shape (finding 7) |
| **M5**, a login is first-come | **Fixed** by the username-only rule (`claim-handler.ts:238`). Residue: finding 16 |
| **L4**, a leaked token binds its account for good | **Open, and worse.** The refusal is now `name-taken` on the account's only possible name, and the token can be phished through the public device flow (finding 3) |
| **Sessions not tied to the name** (M2 option ii) | **Open as described.** Codes too (finding 6). Hostname alone will not be enough (2b, 2c) |
| **M2**, give-way frees the old name at once | **Fixed.** The old row keeps its key until it lapses, and a random name is retired to its key for good (`:194-197`, `:428-431`). `e93e0d08f` extends give-way to any name stepping to a random one without reopening it |
| **L1**, a release deletes other names' indexes | **Fixed** (`forgetIndexes`, `:438-441`). The compare and delete are still two KV calls |
| **L3**, **L5**, **L6** | **Fixed**, by reading |
| **L7**, `GET /claim/<name>` is public | **As it was** (`worker.ts:354-360`): unthrottled, returns `renewedAt` to the millisecond, which times finding 14 |
| **L8**, a claim body carries a live token | **As it was.** Observability is pinned off for the registrar |
| Review item (c), the body cap | **Fixed** (`readAtMost`, `worker.ts:97-125`) |

---

## Checked and found sound

- **Claim signing.** Fixed field order, the token field always present and last, a domain prefix distinct from the relay handshake's (`frizz-claim:v2` and `frizz-relay:v1`). The signature is verified before any GitHub, budget or storage work. The identity point as a public key with a constant signature was refused (`poc-registrar.ts` H, Node's WebCrypto; not tried on workerd).
- **Name normalisation.** A name must arrive already normalised. ASCII letters, digits and hyphens only, so no homoglyphs. The punycode form and trailing dots are refused, and reserved names are checked first.
- **GitHub verification.** The name must equal the token's own login, lowercased. The token must be one GitHub reports as issued to Frizz's App, which refuses `gh`, personal and other apps' tokens. The account id, not the login, is what is stored. No redirect is followed. A missing creation date is a refusal.
- **Routing in the relay.** One Durable Object per name, named from the request's hostname. A handshake for another name is refused, and an unproven socket never reaches the object. A visitor's socket cannot send board frames (roles ride on the socket's attachment). Request ids carry a random prefix per object instance.
- **The board's gate through the relay.** Everything on the relay listener is public whatever the frame says. `Host`, `x-frizz-caller` and forwarded headers in a frame are dropped. A POST and a WebSocket from another `frizz.sh` name carrying the victim's cookie were refused on `Origin` (`poc-gate.mjs` 2). Minting a link and the session directory stay the machine's. `SameSite=Lax` adds nothing between two `frizz.sh` names, which are one site, so the `Origin` check is the whole CSRF defence there, and it holds.
- **Sign-in codes.** 128 bits, single use, five minutes, redeemed atomically. The redirect after sign-in cannot leave the origin. The cookie is `__Host-`, `HttpOnly`, `Secure`.
- **Sessions.** A session needs a live directory record, so a forged long-lived cookie from a copied key does not verify. Signing one device out ends what it has open.
- **The R menu's device rows.** Labels are built from fixed words, never the raw user agent, so a device cannot write to the terminal.
- **The launcher's requests to the registrar.** `redirect: "manual"` on the claim, and a GitHub token only to https or loopback.

## Proofs of concept

| File | What it runs |
|---|---|
| `poc-registrar.ts` | The real `handleClaim`, `kvClaimStore`, `kvAnonymousBudget`, `budgetAddress`, `sweepExpiredClaims` over an in-memory KV with latency. Cases A to J |
| `poc-registrar-crosssite.ts` | The registrar Worker's own `fetch` entry, a cross-site `text/plain` POST |
| `relay-poc/poc-relay.mjs` | The real relay Worker and `Board` object under `wrangler dev`, the real `connectRelay`. `wrapper.ts` adds one hostname that edits the local KV |
| `poc-gate.mjs` | The real `RestartSupervisorProxy` and `serveRelayRequest` |
| `poc-hostile-registrar.mjs` | The real `establishCloudConfig` and `resolveRunToken` in a throwaway home |
| `poc-origin-poison.mjs`, `poc-csd-check.mjs`, `poc-sibling-site.mjs` | The headless shell through `launchHeadless()` |

Run any of them from the repository root with `env -u NODE_COMPAT nub <path>`.

## Not covered

- Production itself: KV's real consistency, the real per-invocation limits, the 128 MB object limit and the WebSocket message limit were reasoned about, not measured.
- Full Chrome and Safari: whether `Clear-Site-Data: "cache"` evicts a cached script there, and how each handles a service worker left by a previous holder.
- The application server's RPC table beyond what the earlier gate review covered. A full-control session is code on the machine by design, and this review took that as given.
