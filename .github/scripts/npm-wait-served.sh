#!/usr/bin/env bash
# Wait until the npm registry serves <name>@<version>, or fail at $RELEASE_DEADLINE (epoch seconds).
#
# An approval is not the end of it: the registry can take a while to serve an approved version, and
# npm's automated review has held new versions for 6m 40s (frizz 0.13.5, 2026-09-14) and 3.5, ~54 and
# 236 minutes (pullfrog). None of those is an upper bound, so release.yml sets the deadline as late as
# its six-hour job cap allows, and an expiry here means nobody approved it, or something is wrong.
#
# It reads the registry URL directly rather than through `npm view`, which revalidates a cached
# packument and can report a live version as missing for minutes (pullfrog, diagnosing its 0.1.66
# and 0.1.72 releases).
set -euo pipefail
name="${1:?usage: npm-wait-served.sh <name> <version>}"
version="${2:?usage: npm-wait-served.sh <name> <version>}"
deadline="${RELEASE_DEADLINE:?RELEASE_DEADLINE (epoch seconds) must be set}"
url="https://registry.npmjs.org/$name/$version"
start="$(date +%s)"

until curl -sf "$url" > /dev/null; do
  now="$(date +%s)"
  if [ "$now" -ge "$deadline" ]; then
    echo "::error::npm still does not serve $name@$version after $(( (now - start) / 60 )) minutes. If it was never approved, approve it with stager, then re-run this job: a served version is skipped, and the run resumes from the first one npm does not serve."
    exit 1
  fi
  echo "… npm does not serve $name@$version yet (not approved, or in review) — $(date -u +%H:%M:%SZ)"
  sleep 60
done
echo "✓ npm serves $name@$version"
