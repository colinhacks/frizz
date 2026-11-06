#!/usr/bin/env bash
# Refuse to stage <name>@<version> past a version npm does not serve yet.
#
# npm holds every new version in automated review and does not release them in the order they
# arrived. On 2026-10-10 frizz 0.13.10 was accepted at 21:40 UTC and held for 14h 56m; the run
# waiting on it hit its deadline, the queued run behind it published 0.13.11, and npm served 0.13.11
# eighteen minutes BEFORE 0.13.10. `latest` stayed on the higher version, so nobody installed the
# wrong one, but the older shell was the newest publish and 0.13.12 was cut only to put that right.
#
# The registry does not say what it is holding, so this reads the gap instead. The version about to
# be staged must be the IMMEDIATE successor of the highest one npm serves: the next patch, or the
# first release of the next minor or major. Anything further ahead means a version in between was
# either accepted and is still in review, or was never published at all (a number skipped because
# its run was cancelled, as frizz-server 0.15.21 was). Only a person can tell those apart: wait for
# the first, and say so for the second by dispatching with `-f allow_version_gap=true`, which
# release.yml hands down as ALLOW_VERSION_GAP.
#
# A re-run for a version npm already holds passes: nothing higher is served, so it is still the
# immediate successor, and npm-stage-publish.sh tolerates the refusal npm then gives it.
set -euo pipefail
name="${1:?usage: npm-refuse-overtake.sh <name> <version>}"
version="${2:?usage: npm-refuse-overtake.sh <name> <version>}"

# Fail closed: a version whose order cannot be checked is the one this exists to stop.
if ! packument="$(curl -sf "https://registry.npmjs.org/$name")"; then
  echo "::error::could not read $name from the npm registry, so the order of this release cannot be checked. Re-run this job."
  exit 1
fi

verdict="$(printf '%s' "$packument" | node -e '
  const parse = (v) => /^(\d+)\.(\d+)\.(\d+)$/.exec(v)?.slice(1).map(Number);
  const target = parse(process.argv[1]);
  // A prerelease or build-tagged version has no single predecessor to wait for.
  if (!target) { console.log("unordered"); process.exit(0); }
  let input = "";
  process.stdin.on("data", (chunk) => { input += chunk; }).on("end", () => {
    const served = Object.keys(JSON.parse(input).versions ?? {}).map(parse).filter(Boolean)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    const highest = served.at(-1);
    if (!highest) { console.log("first"); return; }
    const [major, minor, patch] = highest;
    const successors = [[major, minor, patch + 1], [major, minor + 1, 0], [major + 1, 0, 0]];
    const next = successors.some((candidate) => candidate.every((part, index) => part === target[index]));
    console.log(`${next ? "next" : "gap"} ${highest.join(".")}`);
  });
' "$version")"

case "$verdict" in
  unordered) echo "✓ $name@$version is not a plain release version — no order to check"; exit 0 ;;
  first) echo "✓ npm serves no version of $name yet"; exit 0 ;;
  next\ *) echo "✓ $name@$version follows ${verdict#next }, the highest version npm serves"; exit 0 ;;
  gap\ *) highest="${verdict#gap }" ;;
  *) echo "::error::could not compare $name@$version with the versions npm serves"; exit 1 ;;
esac

if [ "${ALLOW_VERSION_GAP:-false}" = "true" ]; then
  echo "✓ staging $name@$version past $highest, the highest version npm serves — allow_version_gap was set"
  exit 0
fi
echo "::error::npm serves $name up to $highest, and this run would stage $version. If a version in between was published and npm still holds it in review, wait until npm serves it and re-run this job: publishing past it lets npm serve the two out of order. If that number was never published, dispatch again with \`gh workflow run release.yml --ref release -f allow_version_gap=true\`."
exit 1
