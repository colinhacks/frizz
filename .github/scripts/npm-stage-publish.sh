#!/usr/bin/env bash
# Stage one package directory on npm: `npm stage publish` through OIDC trusted publishing.
#
# CI can only STAGE. The trusted publisher on `frizz` and on `frizz-server` is stage-only, so a
# staged version is not installable until the maintainer approves it with 2FA (`pnpm stage
# approve`, or the Staged Packages tab on npmjs.com). A stolen credential that moves the `release`
# branch then fills a queue and ships nothing — which is the shape of the 2026-09-21 nubjs/nub
# compromise, where a stolen push credential cut a tag and 18 packages published unattended.
#
# Idempotent, because a run that dies after staging is finished by re-running it. A version the
# registry already serves is skipped. A version already sitting in the staged queue makes `npm
# stage publish` refuse — npm reserves the version number while it is staged — and that refusal is
# success here: the approval wait downstream still gates on the registry actually serving it. The
# refusal's exact wording is matched loosely because the first stage-only release is where it gets
# observed; anything else stays fatal.
set -euo pipefail
dir="${1:?usage: npm-stage-publish.sh <package-dir> [npm flags...]}"
shift
name="$(node -p "require(require('node:path').resolve('$dir', 'package.json')).name")"
version="$(node -p "require(require('node:path').resolve('$dir', 'package.json')).version")"

if [ "$(npm view "$name@$version" version 2>/dev/null)" = "$version" ]; then
  echo "✓ $name@$version is already published — skipping"
  exit 0
fi

echo "→ staging $name@$version"
out="$(mktemp)"
if npm stage publish "$dir" "$@" >"$out" 2>&1; then
  cat "$out"
  rm -f "$out"
  exit 0
fi
cat "$out"
if grep -qiE 'already (been )?staged|staged version|E409|EPUBLISHCONFLICT|previously published' "$out"; then
  echo "✓ $name@$version is already staged — the approval wait decides the rest"
  rm -f "$out"
  exit 0
fi
rm -f "$out"
echo "::error::staging $name@$version failed"
exit 1
