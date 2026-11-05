# frizz.sh

The one-page site at [frizz.sh](https://frizz.sh). Static: no framework, no build step.

| Path | What it is |
| --- | --- |
| `index.html` | The page. The cursive `fff` mark is inlined twice (the hero tile and the closing slab) as a simplified copy of `assets/logo-concepts/final/fff.svg`'s path, so the stroke can draw itself. Image URLs carry `?v=<first 8 hex of the file's sha1>`; change the file, change the hash. |
| `site.css` | Warm paper, near-black ink and the brand gold. Inter for all prose, Geist Mono only where something is literally code. The homepage (`body.home`) and the guides (`.doc`) share its tokens, nav and footer. |
| `img/` | Screenshots of the real app, served as WebP (`cwebp -q 86 -m 6`). `board.webp` is the hero and `f-*.webp` are the feature tiles. See [Regenerating the screenshots](#regenerating-the-screenshots). |
| `og.html` | Source for `img/og.png`, the 1200×630 social card. Not deployed (`.vercelignore`). |
| `fonts/` | Inter and Geist Mono, Latin-subset variable woff2 from Google Fonts, under the OFL in `fonts/OFL.txt`. |
| `docs/` | The remote-access guides, at `/docs`. They mirror [`docs/remote-access.md`](../docs/remote-access.md), which `src/cloud.ts` names in its error messages — change one and change the other. One file per route, sharing `site.css` and the same `.doc` column as the homepage. |

## Why `/docs` and not `docs.frizz.sh`

The relay Worker owns `*.frizz.sh/*`, and a workers route beats a custom domain — a subdomain here is
answered by the relay with *No Frizz board has claimed this name*, which is exactly how `registrar.frizz.sh`
went down the day the relay shipped. A path on the apex is not covered by that wildcard. A subdomain would
work only with its own more-specific route, the way the registrar has one.

## Deploying

The Vercel project is `frizz` under the `colinhacks-projects` scope, deployed from this directory with the CLI:

```sh
vercel --cwd site --prod
```

## Regenerating the screenshots

Every shot is the real app in a real browser, on a disposable stack with made-up projects and simulated workers. The GitHub picker's rows are stubbed, because a sandbox has no GitHub sign-in.

```sh
# Boot, in its own background shell. --prime and the five projects under <home>/work are what the rail shows.
nub scripts/adhoc-stack.mjs --port=47931 --prime --home=<home> --project=<home>/work/acme-api \
  --also-project=<home>/work/acme-web --also-project=<home>/work/design-system \
  --also-project=<home>/work/mobile-app --also-project=<home>/work/docs > stack.log 2>&1

nub scripts/seed-site-scene.mjs --stack=stack.log               # the hero's threads, then wait a few seconds
nub scripts/shoot-site.mjs --stack=stack.log --out=shots --set=hero
nub scripts/seed-site-scene.mjs --stack=stack.log --features    # one thread per feature, then wait again
nub scripts/shoot-site.mjs --stack=stack.log --out=shots --set=features
```

Shoot the hero set first: `--features` adds threads to `mobile-app`, and its badge would show on the hero's rail. Each project folder needs a `public/icon.svg`, a `package.json`, and a git repo with a GitHub remote. A new image gets a new `?v=` in `index.html`, the first 8 characters of its SHA-1.

## Regenerating the social card

```sh
python3 -m http.server 8765 --directory site   # in one shell
node scripts/shot.mjs http://127.0.0.1:8765/og.html site/img/og.png "" --w=1200 --h=630 --dsf=1 --wait=1500
```
