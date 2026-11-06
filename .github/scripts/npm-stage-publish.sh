#!/usr/bin/env bash
# Stage one package directory on npm: `npm stage publish` through OIDC trusted publishing, which
# attaches provenance on its own.
#
# CI can only STAGE. The trusted publishers on `frizz` and `frizz-server` are stage-only, so a staged
# version is not installable until the maintainer approves it with 2FA. release.yml's header says why.
#
# Idempotent, because a run that dies after staging is finished by re-running it. A version the
# registry already serves is skipped. A version already in the staged queue makes `npm stage publish`
# refuse — npm reserves the number while it is staged, `E409 Cannot publish over previously staged
# version` — and that refusal is success here: the `finish` job still gates on the registry actually
# serving the version. The wording is matched loosely; anything else stays fatal.
#
# E403 is checked FIRST, is always fatal, and names the fix: it is what npm returns when the trusted
# publisher's allowed actions do not include `npm stage publish`.
set -euo pipefail
dir="${1:?usage: npm-stage-publish.sh <package-dir> [npm flags...]}"
shift
name="$(node -p "require(require('node:path').resolve('$dir', 'package.json')).name")"
version="$(node -p "require(require('node:path').resolve('$dir', 'package.json')).version")"

# The registry URL, not `npm view`: see npm-wait-served.sh.
if curl -sf "https://registry.npmjs.org/$name/$version" > /dev/null; then
  echo "✓ $name@$version is already published — skipping"
  exit 0
fi

# Never past a version npm has not served yet: see npm-refuse-overtake.sh.
bash "$(dirname "${BASH_SOURCE[0]}")/npm-refuse-overtake.sh" "$name" "$version"

echo "→ staging $name@$version"
out="$(mktemp)"
if npm stage publish "$dir" "$@" >"$out" 2>&1; then
  cat "$out"
  rm -f "$out"
  exit 0
fi
cat "$out"
if grep -q 'E403' "$out"; then
  rm -f "$out"
  echo "::error::npm refused to stage $name@$version (E403). If the log says OIDC permission denied, the trusted publisher for $name on npmjs.com does not allow \`npm stage publish\` from release.yml. Allow it there, then re-run this job."
  exit 1
fi
if grep -qiE 'already (been )?staged|staged version|E409|EPUBLISHCONFLICT|previously published' "$out"; then
  echo "✓ $name@$version is already staged or published — the finish job decides the rest"
  rm -f "$out"
  exit 0
fi
rm -f "$out"
echo "::error::staging $name@$version failed"
exit 1
