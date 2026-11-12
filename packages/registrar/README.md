# Registrar

The Worker that hands out `<name>.frizz.sh`. It records who owns a name; the [relay](../relay) serves
it. One wildcard DNS record covers every name, so a claim creates no infrastructure at all — which is
what removed the 200-name ceiling the original tunnel design could never get past.

It runs during signup and never again. **It is not on the data plane** — a board that is already
running keeps working whether or not this Worker is up, and nothing in Frizz has to reach it to stay
reachable. Protect that property above anything else here.

## How a name is owned

A name belongs to whoever holds an Ed25519 private key, kept at `identity.key` under Frizz's state root (`~/.frizz/` on an install that has that directory, the platform's state directory otherwise) on the
claiming machine. Every claim is signed; the signature covers the public key, so a request cannot be
re-attributed by swapping it. Ownership moves between machines the way an SSH key does: copy the file.

**Claiming a custom name also needs a GitHub account, and that is the only thing standing between this and a squatter.** The CLI sends the user token of Frizz's own GitHub sign-in (the Frizz Agent Console App the board already holds for its GitHub reads, read-only by its permissions) with the first claim. The registrar spends it on `api.github.com/user`, keeps the numeric id and drops the token, which it never stores or logs. The name must be the account's own username, in any case (`Ada-Lovelace` claims `ada-lovelace`), so one account has one name, and an account younger than 30 days cannot claim. Nothing afterwards touches GitHub — the keypair alone renews the lease, so a name keeps working whether or not GitHub does. Set `REQUIRE_GITHUB=0` to lift the gate on a test deployment; never on the one anybody can reach.

**Only Frizz's own sign-in is accepted.** The verifier (`githubVerifier` in [`worker.ts`](src/worker.ts)) refuses, as `github-token-foreign`, any token GitHub's `/user` answer does not report in `X-OAuth-Client-Id` as issued to the Frizz Agent Console App: a `gh` CLI token (what a Frizz from before 2026-10-08 sends, and what a compromised build of this Worker collected), a personal access token, or another app's token. So a token some other app collected cannot claim in its owner's name. Until 2026-11-07 only a zero-scope OAuth token was accepted; the maintainer dropped that rule because this Worker deploys from the same workflow, token and approval as the relay, and a hijacked relay already has full control of every board serving through it. First claims of custom names from one network address get 10 GitHub lookups an hour. This Worker holds no GitHub credential.

**A custom name follows its account.** A sign-in token can leak, and a phished one is easy to get: the App's device flow needs no secret. Whoever holds one can claim the account's username under a key of their own. So the account proving itself again, with a fresh token from Frizz's own sign-in, takes its name back onto the key that proves it, live lease or not. Only a token for the same numeric account id does: a username that changed hands on GitHub does not evict anyone. The board that loses the name is told to revoke Frizz's access on GitHub if that was not its operator, because a stolen refresh token keeps working until then. What a stranger's interim hold collects opens nothing afterwards:

- the board taking the name back is answered `renewed: false` and signs out every session issued under it;
- the relay closes the stranger's socket on the next request;
- nothing the stranger's board served is used from a browser's cache without the new board's say ([relay README](../relay/README.md#when-a-name-changes-hands)).

**Nobody chooses a random name.** The 20-character shape skips GitHub, so a chosen one would be a vanity name with no account behind it (`githubsupportfrizz22`). Each key has 64 random names of its own, derived from a SHA-256 over the key (`deriveAnonymousClaimName` in [`claim.ts`](../shared/src/claim.ts)), and a new random claim must be one of them. A launcher older than 2026-11-12 sends a name it drew itself and is answered `bad-version`, which tells it to update. Names claimed before keep renewing by their key.

A name is a **30-day lease**, renewed on every launch and once a day while the board runs. An unrenewed name is released: on demand when
someone else asks for it, and by a daily sweep for names nobody wants.

**A random name is never handed to another key.** Phones stay pointed at a name after its board has left
it, and send it their session cookies. So when a random name lapses or is swept, the registrar keeps
`retired:<name>` holding the key that had it, and refuses that name to any other key for good; its own
key can still have it back. There are 32²⁰ random names, so none needs reusing. A custom name returns to
the pool, but only its own GitHub account can claim it.

## Deploying

Only GitHub Actions deploys this Worker, never a laptop. Dispatch [`workers-deploy.yml`](../../.github/workflows/workers-deploy.yml) from `main`; it typechecks, runs the unit tests below and deploys. Its Cloudflare token lasts an hour and exists only during a deploy sitting, so the maintainer's Authorize click on that sitting is a deploy's one approval ([relay README](../relay/README.md#deploying)).

```sh
keyward --reason "deploy the frizz.sh Workers" -- gh workflow run workers-deploy.yml --ref main -f target=both
```

`target` takes `relay`, `registrar` or `both`. [`workers-drift.yml`](../../.github/workflows/workers-drift.yml) checks every 30 minutes that everything this Worker runs came from a real run of that workflow, and a failed check is the alarm, emailed by GitHub. From 2026-09-21 to 2026-10-08 an attacker holding a Cloudflare token ran a build of this Worker that copied the GitHub token every named claim sends, and those uploads looked exactly like a laptop deploy. See the [relay README](../relay/README.md#deploying) for how the check works.

**A secret change raises the alarm too.** `wrangler secret put` and `wrangler secret delete` each create a version and a deployment that CI did not make, and the check cannot tell the maintainer's from an attacker's. After changing a secret, dispatch the deploy workflow; the alarm clears once the CI deployment is active and the secret change is more than two hours old. Relay mode, the default, reads no secrets, so the check's `BASELINE` expects none and a secret left in place keeps it red: the ones in `wrangler.toml` are read only when `CLOUD_MODE=tunnel` puts the old per-name tunnel path back.

**The registry is a D1 database, `frizz-registrar-claims`, bound as `CLAIMS_DB`.** Every claim and the daily sweep run one at a time behind a lock row in it ([`claim-db.ts`](src/claim-db.ts)). Until 2026-11-12 the registry was KV alone, which has no compare-and-set and serves reads up to a minute stale. So every "one per" rule could be beaten by sending claims together: ten from one account won ten names, and two keys both won one name. D1 has one primary, and its conditional UPDATE is atomic, which the lock rests on. A Durable Object would be the natural lock, but a new class needs a migration, and `wrangler versions upload` refuses to apply one.

- **The relay still reads KV.** Each `claim:<name>` row is copied to the `CLAIMS` namespace after D1 is written, and removed there with it. The relay has no D1 binding.
- **KV was imported once.** The first claim after the database appeared copied every `claim:`, `owner:`, `gh:` and `retired:` row into D1, under the lock, and set a flag so it never runs again.
- **Without the binding the registrar takes no claims.** It answers `registrar-busy` rather than racing in KV.
- **Creating it** is the deploy sitting's `registrar-db` verb ([`cloudflare-sitting.sh`](../../scripts/cloudflare-sitting.sh)), which prints the database id for `wrangler.toml` and for `BASELINE` in [`workers-drift.mjs`](../../scripts/workers-drift.mjs).

On the maintainer's Mac wrangler is never signed in: it runs as `keyward --reason "<the task>" -- wrangler …` from a frizz checkout, with the token Keyward holds for this repository, and the `cloudflare` skill has the details. That token can read this Worker, but Cloudflare refuses it an upload, a secret change or a KV write, so the `wrangler secret` and `wrangler kv` commands above take the dashboard or a one-day token. This Worker deploys only through the workflow, and an upload from anywhere else raises the alarm.

Three things that will waste your time otherwise:

- **A WORKERS ROUTE BEATS A CUSTOM DOMAIN.** The relay owns `*.frizz.sh/*`, which swallowed
  `registrar.frizz.sh` the day it shipped and took signup down — the wildcard answered "No Frizz board
  has claimed this name." to every claim. `wrangler.toml` therefore declares BOTH the custom domain and
  a more specific `registrar.frizz.sh/*` route; the route is what wins. Do not remove either.
- **Routes and crons do not ship with a deploy.** The workflow uses `wrangler versions`, which leaves
  them alone, so its token needs no route permission. A plain `wrangler deploy` deletes and recreates each
  route on every run, and exits 1 after uploading if the token cannot read them. Changing a route or cron
  in `wrangler.toml` is a deliberate `wrangler triggers deploy`, plus the same change to `BASELINE` in
  [`scripts/workers-drift.mjs`](../../scripts/workers-drift.mjs).
- **Deleting a secret needs `--name`.** Plain `wrangler secret delete X --force` prints usage and
  silently does nothing, so a temporary override outlives the test that set it. Use
  `wrangler secret delete X --name frizz-registrar`, then `wrangler secret list --name frizz-registrar`
  to confirm.

Then point the CLI at it. The default is `https://registrar.frizz.sh`; override with `FRIZZ_REGISTRAR`
to test against a deployment before it takes that name.

```sh
FRIZZ_REGISTRAR=https://frizz-registrar.<subdomain>.workers.dev frizz --cloud
```

## The limits that shape this

A relay-served name costs one D1 row and its KV copy. What bounds the namespace is what a claim costs:

| Limit | Value | Applies to |
|---|---|---|
| A body sent as anything but `application/json` | refused with 415 | every claim, so no web page can send one from a visitor's browser |
| New random names per network per hour | 10 (an IPv6 address counts by its /64) | a new random name |
| GitHub lookups per network per hour | 10 | a claim carrying a GitHub token |
| New random names per hour, across every network | 300, `NEW_NAMES_PER_HOUR` overrides | a new random name; never a renewal or a custom name |
| Names in all | 1,000,000 (`MAX_NAMES_RELAY`), `MAX_NAMES` overrides | a new name |

Each budget is spent in one SQL statement that adds one only while the hour has room, so a burst cannot overspend it. A claim's signature and its GitHub lookup are checked before it takes the lock, so junk and a slow GitHub hold up nobody else. Someone with many networks can still use up the hour's 300 new random names for as long as they keep claiming. Renewals and custom names are unaffected, and the namespace fills no faster than that.

That is the whole point of the relay, and it is worth knowing what it replaced. A name used to cost one
DNS record and one tunnel, and both are capped — 200 records on a free zone created after 2024-09-01,
3,500 on Pro, 1,000 tunnels per account. `CLOUD_MODE=tunnel` still walks that path, and everything in
`claim-handler.ts` that looks like fussy cleanup is from it: with a per-name tunnel, a leak on a failed
claim or a name that is never released is a countdown to new signups stopping for a reason nothing
points at.

## Verifying

The decision logic takes its side effects by injection, so it runs against fakes:

```sh
nub --test packages/registrar/src/          # the handler, the Worker, the D1 store, the Cloudflare client
nub scripts/verify-claim-e2e.mjs            # CLI client → real socket → real handler
```

The Worker tests run the registry on Node's own SQLite through [`fake-d1.ts`](src/fake-d1.ts), with a delay on every call so concurrent claims interleave as they would over the network. The test of one key claiming two names at once runs the same claims through KV alone as its negative control, and there both win.

`cloudflare.ts` was exercised against the live API on 2026-08-24, before the relay made it optional.
Two of its shapes came back different from the documentation, and both are commented where they bite:
a tunnel delete needs `?cascade=true` (`cloudflare.ts`), and an orphaned tunnel makes a name
permanently unclaimable with error 1013 unless `create()` reclaims it first (`claim-handler.ts`).
