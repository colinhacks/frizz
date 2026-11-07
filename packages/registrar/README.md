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

**Claiming a custom name also needs a GitHub account, and that is the only thing standing between this and a squatter.** The CLI sends the user token of Frizz's own GitHub sign-in (the Frizz Agent Console App the board already holds for its GitHub reads, read-only by its permissions) with the first claim. The registrar spends it on `api.github.com/user`, keeps the numeric id and drops the token, which it never stores or logs. One name per account, and an account younger than 30 days cannot claim. Nothing afterwards touches GitHub — the keypair alone renews the lease, so a name keeps working whether or not GitHub does. Set `REQUIRE_GITHUB=0` to lift the gate on a test deployment; never on the one anybody can reach.

**A token with OAuth scopes is refused.** Until 2026-10-08 the CLI sent its `gh auth token`, which can push to every repository its owner can, and a compromised build of this Worker collected those tokens. The verifier (`githubVerifier` in [`worker.ts`](src/worker.ts)) refuses, as `github-token-scoped`, any token whose `X-OAuth-Scopes` header lists a scope, which is what an old CLI sends. Until 2026-11-07 it accepted only a zero-scope OAuth token; the maintainer dropped that rule because this Worker deploys from the same workflow, token and approval as the relay, and a hijacked relay already has full control of every board serving through it. This Worker holds no GitHub credential.

A name is a **30-day lease**, renewed on every launch. An unrenewed name is released — on demand when
someone else asks for it, and by a daily sweep for names nobody wants.

## Deploying

Only GitHub Actions deploys this Worker, never a laptop. Dispatch [`workers-deploy.yml`](../../.github/workflows/workers-deploy.yml) from `main`; it waits for a maintainer's approval on the `workers-deploy` environment, typechecks, runs the unit tests below and deploys:

```sh
keyward --reason "deploy the frizz.sh Workers" -- gh workflow run workers-deploy.yml --ref main -f target=both
```

`target` takes `relay`, `registrar` or `both`. [`workers-drift.yml`](../../.github/workflows/workers-drift.yml) checks every 30 minutes that everything this Worker runs came from a real run of that workflow, and a failed check is the alarm, emailed by GitHub. From 2026-09-21 to 2026-10-08 an attacker holding a Cloudflare token ran a build of this Worker that copied the GitHub token every named claim sends, and those uploads looked exactly like a laptop deploy. See the [relay README](../relay/README.md#deploying) for how the check works.

**A secret change raises the alarm too.** `wrangler secret put` and `wrangler secret delete` each create a version and a deployment that CI did not make, and the check cannot tell the maintainer's from an attacker's. After changing a secret, dispatch the deploy workflow; the alarm clears once the CI deployment is active and the secret change is more than two hours old. Relay mode, the default, reads no secrets, so the check's `BASELINE` expects none and a secret left in place keeps it red: the ones in `wrangler.toml` are read only when `CLOUD_MODE=tunnel` puts the old per-name tunnel path back.

The registry is one KV namespace, created once and already in `wrangler.toml`. To recreate it, run `wrangler kv namespace create CLAIMS`, paste the new id into both this package's and the relay's `wrangler.toml`, and deploy through the workflow.

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

A relay-served name costs one KV row and nothing else, so the ceiling is nominal: `MAX_NAMES_RELAY` is
100,000, and `MAX_NAMES` overrides it without a deploy.

That is the whole point of the relay, and it is worth knowing what it replaced. A name used to cost one
DNS record and one tunnel, and both are capped — 200 records on a free zone created after 2024-09-01,
3,500 on Pro, 1,000 tunnels per account. `CLOUD_MODE=tunnel` still walks that path, and everything in
`claim-handler.ts` that looks like fussy cleanup is from it: with a per-name tunnel, a leak on a failed
claim or a name that is never released is a countdown to new signups stopping for a reason nothing
points at.

## Verifying

The decision logic takes its side effects by injection, so it runs against fakes:

```sh
nub --test packages/registrar/src/          # the handler, the Worker, the Cloudflare client
nub scripts/verify-claim-e2e.mjs            # CLI client → real socket → real handler
```

`cloudflare.ts` was exercised against the live API on 2026-08-24, before the relay made it optional.
Two of its shapes came back different from the documentation, and both are commented where they bite:
a tunnel delete needs `?cascade=true` (`cloudflare.ts`), and an orphaned tunnel makes a name
permanently unclaimable with error 1013 unless `create()` reclaims it first (`claim-handler.ts`).
