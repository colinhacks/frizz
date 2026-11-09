# Security review: custom-name claims (c502fae0, 5fb2a0f6, 1e5f64b3)

> [!NOTE] What landed after this review
> M2 (the random name is now stepped off and kept by its key until it lapses, never released at once), L1 (a release clears only the indexes that still point at it), L2 (moot with M2), L3 (no readable creation date is no account), L5 (the launcher never renews the token), L6 (the token is sent only after `github-required`), the streamed body cap in (c), IPv6 budgets by /64 from M3, a renewal 5xx no longer stopping a relay board's launch, and `[observability] enabled = false` in the registrar's `wrangler.toml`. Later the same day the maintainer made a custom name the account's own username only, and random names are never handed to another key, which leaves M5 for custom names alone. M1, the rest of M3, M4, M5 and L4 are open: [`frizz-sh-incident-todo.md`](frizz-sh-incident-todo.md) § 2. L7 and L8 were left as they are.

Read-only review against the tree at 1e5f64b3. Line numbers are for that tree. PoCs are in
`~/Documents/scratch/claim-review/poc.ts` and `poc2.ts`. They drive the real `handleClaim` with an
in-memory store that has 5 ms of latency. Tests pass on this tree: registrar worker 18/18, claim-handler
33/33, github-credential 27/27, registrar-client 9/9, and `verify-claim-e2e.mjs` 23/23.

## Items (a) to (e) in 1e5f64b3

- **(a) Confirmed sound.** `worker.ts:77` requires an exact `x-oauth-client-id`, so a missing header
  fails closed. That refuses fine-grained PATs, `gh` tokens and other apps' tokens. It is not a limit on
  identity: anyone can mint a Frizz-App `ghu_` token for their own account by device flow, because the
  client id is public. So it stops the registrar *receiving* write-capable tokens. It does not ration
  accounts.
- **(b) Confirmed.** `githubClaimToken` handles only the App credential and ignores
  `FRIZZ_GITHUB_TOKEN`. One minor inconsistency: with `FRIZZ_GITHUB_TOKEN` set,
  `githubCredentialStatus().source === "env"`. The pane then offers no login, yet a claim would still
  send the stored App token. This is harmless.
- **(c) Mostly sound.** The cap is checked through `content-length` (`worker.ts:314`). A chunked request
  has no content-length, and `request.text()` (`:317`) reads the whole body before the length check. It
  is bounded only by the platform's body and memory limits. Rated LOW: stream the body with a byte
  counter and abort at 8 KiB.
- **(d) Present, but keyed on the full address.** See M3: IPv6 rotation defeats it.
- **(e) Confirmed sound.** `carriesSecretsSafely` takes `https:` or `http:` to `127.0.0.1`, `[::1]` or
  `localhost`. Node's `URL.hostname` keeps the brackets, so `[::1]` matches. `redirect: "manual"` is set
  on both fetches, and a 3xx then fails `!response.ok`.

---

## HIGH / MEDIUM

### M1 (medium-high, CONFIRMED): one GitHub account claims any number of custom names by racing
- **Where:** `claim-handler.ts:216-224` reads `gh:<id>`, and `create()` writes it later. KV has no
  compare-and-set, and reads can be served from an edge cache for up to 60 s.
- **Exploit:** take one GitHub account older than 30 days and N fresh keys. Send N claims for N names
  in parallel; all N read `gh:<id>` as null and all succeed. In `poc.ts` case 1, 10 concurrent claims
  gave 10×200, all bound to github id 42.
  - The race window is not milliseconds: KV propagation and edge caching widen it to about 60 s across
    PoPs.
  - The per-address budget of 10/h does not help, because the burst fits inside it. With IPv6 rotation
    (M3) there is no budget at all.
- **Same race elsewhere:**
  - Two keys claiming the same free name both get 200. Last write wins, the loser's `owner:` index
    points at a name it doesn't own, and its board is then refused by the relay.
  - Two concurrent give-way claims from one key both succeed, so the key holds 2 custom names
    (`poc.ts` case 3).
- **Fix:** serialize claim mutations through one Durable Object, since claim volume is tiny, or move to
  D1 with UNIQUE(github_id) and UNIQUE(name). KV can't enforce any of the "one per" limits under
  concurrency.

### M2 (medium, CONFIRMED by code): give-way frees the old random name at once, so devices' sessions can be harvested and replayed against the new name
- **Where:** `claim-handler.ts:258-262` releases the random name R to the pool the moment custom name
  C is created.
- **Why the sessions are reusable:**
  - Sessions are not bound to a host. `access-codes.ts:326` `verifySession` checks only the HMAC,
    expiry and directory, not the origin.
  - They survive an origin change, as `restart-supervisor.ts:382` says ("Sessions survive the change").
  - They last 30 days (`DEFAULT_SESSION_TTL_MS`).
- **Exploit:**
  1. The victim moves from R to C in the R pane.
  2. Anyone who knows R (the QR or link, browser history, a screenshot; R is a moat, not a secret)
     claims R with a fresh key. That costs only the anonymous budget.
  3. The attacker connects R to the relay. Phones and PWAs still bookmarked on R send
     `__Host-frizz_session` to the attacker's board.
  4. The attacker replays that cookie to C and gets a valid session on the victim's board, with
     whatever relay access the victim granted (`full` by default).
- **Before 5fb2a0f6:** an R only freed after a 30-day lapse, by which point sessions had mostly expired.
  Give-way removes that buffer.
- **Fix, any of:**
  - (i) Don't return R to the pool on give-way. Tombstone it under the same pubkey until
    `renewedAt + lease`: not served by the relay, not counted for one-per-key, refused to other keys.
  - (ii) Bind sessions to the origin that minted them: put the host in the signed payload and check
    `Host`.
  - (iii) Rotate the session key or sign devices out when a give-way releases a name.

  (ii) also covers the general lapsed-name takeover.

### M3 (medium, CONFIRMED by code): both per-address budgets fall to IPv6 rotation
- **Where:** `worker.ts:327` keys `anonrl:` and the new `ghrl:` on the raw `cf-connecting-ip`.
- **Exploit:** any VPS or residential IPv6 user has a /64, which is 2^64 budget keys.
  - **Anonymous names:** mint them until `MAX_NAMES_RELAY` (100,000), at which point every signup,
    custom names included, answers `namespace-full` for at least 30 days.
  - **Cost of each new claim:** it runs `store.list()` over the whole namespace (`claim-handler.ts:231`),
    which is 1 KV list per 1,000 names. Long before 100k names, claims become slow and expensive. They
    hit the per-invocation KV operation limit, and on a free plan the daily list and write quotas
    (PLAUSIBLE, depending on the plan).
  - **KV write quota:** each budget check is also a KV write, so the quota can be drained at will. A
    drained write quota makes renewals 500. `remote-controller.ts:113` awaits `resolveRunToken`, which
    rethrows anything but `unreachable`. So a relay board **fails to start serving at launch** when the
    registrar errors (PLAUSIBLE; depends on the KV plan). That contradicts "not on the data plane".
- **Fix:**
  - Key IPv6 by /64 (or /56).
  - Add a global hourly ceiling on new anonymous names.
  - Keep a namespace counter instead of listing on every claim.
  - Treat a renewal's 5xx like `unreachable` at launch.

### M4 (medium, CONFIRMED): a readable 20-character name bypasses the GitHub gate entirely
- **Where:** `shared/src/claim.ts:95` treats any 20-character `[a-z2-7]` string as anonymous;
  `claim-handler.ts:203` and `cloud.ts:370` take that path.
- **Exploit:** `colinhacksfrizzboard`, `githubsupportteamxyz` and `vercelsupportdesk234` all claim with
  no token, no GitHub lookup and no account limit (`poc2.ts`: 3×200, 0 lookups). The cost is only the
  anonymous budget, so cheap squatting and phishing of readable names stays open.
- **Fix:** make anonymous names unchoosable. For example, require
  `name == base32(SHA-256(pubkey))[0..20]` for new anonymous claims (grinding a readable one costs about
  2^100), or have the registrar mint the name. Grandfather existing records, whose renewals don't hit
  this path.

### M5 (medium, PLAUSIBLE, a policy issue): a login name is first-come, while the pane implies it is yours
- **Where:** `remote-pane.ts:104-110` and `:366` offer `<login>.frizz.sh`. The registrar doesn't check
  that a custom name relates to the claimant.
- **Exploit:** any GitHub account older than 30 days claims `colinhacks.frizz.sh`, or a teammate's
  login. Visitors reasonably read it as that person's board. The real owner's suggested name answers
  `name-taken`. Combined with M1, one account can take many logins in a single burst.
- **Fix:** a custom name that equals an existing GitHub login is claimable only by that account. Either
  the name must equal `who.login` lowercased, or `GET /users/<name>`'s id must equal `who.id`. Or,
  simplest while custom names are new, allow only the claimant's own login.

---

## LOW

### L1 (low-medium, CONFIRMED by PoC): a release deletes other names' limit indexes
- **Where:**
  - `releaseQuietly` at `claim-handler.ts:391-396` and `:404-408`, reached from a lapsed-name takeover
    at `:191`.
  - `release` at `:466-468`, reached from the sweep.
- **The bug:** both delete `owner:<pubkey>` and `gh:<githubId>` unconditionally, even when the index
  now points at a different live name.
- **Exploit (`poc.ts` case 2):**
  1. Account G's name X lapses.
  2. G claims Z, which repoints `gh:G` to Z.
  3. The sweep, or anyone taking X, deletes `gh:G`.
  4. G claims W and now holds Z and W.

  Repeat once per lapse.
- **Fix:** compare before deleting. Remove `gh:<id>` only if it equals `name`, and `owner:<pubkey>`
  only if it equals `name`.

### L2 (low, CONFIRMED by code): a give-way ignores whether the release worked
- **Where:** `claim-handler.ts:261` discards `releaseQuietly`'s boolean. In tunnel mode a failed
  `deleteTunnel` leaves R live, and in relay mode `allSettled` swallows a failed KV delete.
- **Effect:** in both cases `writeOwner(pubkey, C)` still runs, and the key keeps renewing R and C,
  because `renew` doesn't consult the owner index.
- **Fix:** check the result before writing the owner index, or make a renewal verify
  `owner:<pubkey> === name`.

### L3 (low, CONFIRMED by code): the account-age gate fails open
- **Where:** `worker.ts:80-81`. A missing or unparseable `created_at` becomes `createdAt: 0`, which
  passes the 30-day check.
- **Fix:** return `null` (rejected) when `created_at` doesn't parse.

### L4 (low, PLAUSIBLE): one leaked token squats the account for good, with no recovery
- **Where:** the App's 8-hour access token is plain text in `worker-gh/hosts.yml`
  (`github-credential.ts:524`), which every agent's `gh` reads (`gh auth token`).
- **Exploit:** the token leaks once, through a prompt-injected agent, a transcript, or a copied claim
  body. Within 8 hours the holder claims a name bound to the operator's GitHub id, under the holder's
  key, and renews it forever.
  - The operator then gets `one-name-per-account`, with no way to evict the squatter.
  - The holder can also claim the operator's `<login>` name.
  - Before c502fae0 this token proved nothing to frizz.sh. An agent on the machine can already read
    `identity.key`, but a leak outside the machine is the new durable harm.
- **Fix:** add an account-level "release my binding" path, authenticated by a fresh App token for the
  same id, that frees the name without handing it over. Or have a claim show the operator which name
  their account is bound to.

### L5 (low, CONFIRMED by code): a refresh race with the keeper can wedge the server's GitHub sign-in until restart
- **Where:** `githubClaimToken` refreshes at `github-credential.ts:260` when under 2 minutes remain.
- **The race:** under 2 minutes means the keeper has been failing for about 8 minutes, during a GitHub
  outage for example. Then both processes can spend the single-use refresh token at once.
- **If the server loses:** it sets `memo.problem` (`:359`). `current()` (`:181`) never re-reads the
  disk while `memo.credential` is set, so the server stays signed out and `hosts.yml` is removed for
  workers, until a restart or a new sign-in, even though the disk holds the winner's fresh credential.
- **Fix:** on a refused refresh, retry `adoptNewerFromDisk` after a short delay. Or let `current()`
  re-read when `problem` is set and the file's mtime changed. Or have the launcher never refresh and
  tell the person to start the board.

### L6 (low, CONFIRMED by code): the token is sent even when the registrar doesn't need it
- **Where:** `establishCloudConfig` (`cloud.ts:385`) authorizes and sends the token for every custom
  answer. That includes re-entering a name the key already holds, where the registrar takes the renewal
  path and never reads the token. It also includes `reconcileCloudConfig` at launch for a legacy
  in-zone tunnel config, which sends it with no interactive ask (gated on `customNamesOffered`).
- **Fix:** claim without a token first, and attach it only on `github-required`. Renewals then never
  carry it.

### L7 (low): `GET /claim/<name>` is public and unthrottled, and returns `renewedAt`
- **Where:** `worker.ts:300-305`.
- **Effect:** it shows a board's daily liveness, and lets a sniper time a lapsed-name grab to the
  millisecond (which feeds M2 and L1). It is also a free source of KV-read amplification.
- **Fix:** return the pubkey only, or a day-granular date, and rate-limit it.

### L8 (low): a captured claim body is a live token
- Replaying a claim is harmless: inside the 5-minute window a replay is an idempotent renewal.
- The body itself carries the `ghu_` token in plain text, so leaking one is an 8-hour read token for
  the installation's repos.
- **Verified, nothing logs a body or a token:**
  - No `[observability]` block in `packages/registrar/wrangler.toml`.
  - No `console.*` on the claim path. The scheduled handler logs counts and names only.
  - Invocation logs and `wrangler tail` don't include bodies.
  - Client `ClaimError` text is built from the code, the registrar's message and the origin, never the
    request.
- **Recommendation:** pin `[observability] enabled = false`, or document that bodies must never be
  logged, so that a dashboard toggle can't change this.

### Checked, nothing found
- Signing input: fixed order, and the token field is always present, so with and without a token can't
  collide.
- Names: they must arrive already normalized, and the punycode form is refused.
- The signature is verified before any GitHub, budget or KV work.
- Give-way can't release a name the attacker doesn't own: it requires `other.pubkey === pubkey` and a
  signature by that key.
- Renewal requires the record's pubkey to match.
- No keychain write from the launcher: `githubClaimToken` reads with `create=false`. A refresh write
  reuses the held key. With no `login.keychain-db`, as under a sandbox HOME, the file key is used and
  `security` never runs. One remaining case: a LOCKED login keychain can show an unlock prompt on the
  launcher's read, which happens when the R pane calls `frizzGithubLogin`. That is not "Keychain Not
  Found", and the server already does the same read.
