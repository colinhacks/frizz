#!/bin/bash
# Holds the credential for one Cloudflare sitting: in this shell's memory, and in the environment of each
# command it starts, never in a file, an argv or a transcript. A sitting needs it several times with a
# person's judgment in between (read the audit, then mint, then revoke once the deploy is done), and an
# agent's shell calls keep no state between them.
#
# Writing a verb to <dir>/verbs runs it, and <dir>/replies answers once it is done. Only the verbs below
# exist, so whatever else can reach the FIFO can't use the credential for anything else. `exit`, or the
# caller's own timeout, ends the shell and the credential with it.
#
#   cloudflare-oauth.mjs <dir>                    the usual way in: an Authorize click, then this
#   cloudflare-sitting.sh <secret pipe> <dir>     a token the maintainer pasted on a secret card
#   printf audit > <dir>/verbs; cat <dir>/replies
#
# `-` for the pipe reads the credential from stdin, which is how cloudflare-oauth.mjs passes it.
set -u
PIPE=$1
DIR=$2
KIND=${3:-}
EXPIRES=${4:-}
SCOPES=${5:-}
SCRIPT=$(cd "$(dirname "$0")" && pwd)/cloudflare-tokens.mjs
umask 077
cd "$(dirname "$SCRIPT")/.." || exit 2
mkdir -p "$DIR"
mkfifo "$DIR/verbs" "$DIR/replies" || exit 2
if [ "$PIPE" = "-" ]; then IFS= read -r T; else T=$(cat "$PIPE"); fi
[ -n "$T" ] || { echo "no credential arrived"; exit 2; }
echo "holding a credential of ${#T} characters; verbs: audit plan drift deploy registrar-db revoke exit"

run() { CLOUDFLARE_FRIZZ_MINTER="$T" CLOUDFLARE_FRIZZ_MINTER_KIND="$KIND" CLOUDFLARE_FRIZZ_MINTER_EXPIRES="$EXPIRES" CLOUDFLARE_FRIZZ_MINTER_SCOPES="$SCOPES" env -u NODE_COMPAT nub "$SCRIPT" "$@"; }

while true; do
  IFS= read -r verb < "$DIR/verbs" || continue
  case "$verb" in
    audit) run --audit "--out=$DIR/snapshot" > "$DIR/audit.txt" 2>&1 ;;
    plan) run --dry-run > "$DIR/plan.txt" 2>&1 ;;
    drift) run --only=drift > "$DIR/drift.txt" 2>&1 ;;
    deploy) run --only=deploy > "$DIR/deploy.txt" 2>&1 ;;
    registrar-db) run --registrar-db > "$DIR/registrar-db.txt" 2>&1 ;;
    revoke) run --revoke-deploy > "$DIR/revoke.txt" 2>&1 ;;
    exit)
      unset T
      echo "exit 0" > "$DIR/replies"
      rm -f "$DIR/verbs" "$DIR/replies"
      exit 0
      ;;
    *) echo "unknown verb: $verb" > "$DIR/replies"; continue ;;
  esac
  echo "$verb exit $?" > "$DIR/replies"
done
