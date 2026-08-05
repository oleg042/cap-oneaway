#!/usr/bin/env bash
#
# Move storage from local MinIO to Cloudflare R2, atomically and reversibly.
#
#   R2_ACCOUNT_ID=... R2_ACCESS_KEY=... R2_SECRET_KEY=... ./cutover-to-r2.sh
#
# Copies objects, flips the config, restarts, then proves the new path works by
# uploading and reading back real bytes. If that proof fails, the previous .env
# is restored and the stack is brought back up on MinIO before exiting.
#
# The rollback exists because this failure is silent: point Cap at an empty
# bucket and the containers stay healthy, the dashboard still lists every
# recording, and each share page still renders. Only the video is gone. Without
# an automatic revert, the window between a bad cutover and noticing it is
# however long until a client clicks a link.
#
# MinIO is deliberately left running and untouched. It is the rollback.

set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO"

: "${R2_ACCESS_KEY:?set R2_ACCESS_KEY}"
: "${R2_SECRET_KEY:?set R2_SECRET_KEY}"
# R2_ACCOUNT_ID is only needed to derive the endpoint; R2_ENDPOINT may supply it
# directly, which is how the cutover gets rehearsed before touching real data.
[ -n "${R2_ENDPOINT:-}" ] || : "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID (or R2_ENDPOINT)}"
BUCKET="${R2_BUCKET:-cap}"

[ -f .env ] || { echo "no .env in $REPO" >&2; exit 1; }

# The migration step needs the MinIO credentials to read the source bucket, and
# they only exist in .env. Without this the cutover dies at step 1 with an
# unset-variable error that looks like a bug in the migration script.
set -a
# shellcheck disable=SC1091
. ./.env
set +a
BACKUP=".env.pre-r2.$(date +%Y%m%d-%H%M%S)"
cp .env "$BACKUP"
echo "==> Saved current config to $BACKUP"

restore() {
  echo
  echo "==> Rolling back to MinIO"
  cp "$BACKUP" .env
  docker compose up -d >/dev/null 2>&1
  echo "    restored from $BACKUP; storage is on MinIO again"
}

ENDPOINT="${R2_ENDPOINT:-https://${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID (or R2_ENDPOINT)}.r2.cloudflarestorage.com}"

echo "==> 1/5 Copying objects to R2"
R2_ENDPOINT="$ENDPOINT" R2_ACCESS_KEY="$R2_ACCESS_KEY" \
R2_SECRET_KEY="$R2_SECRET_KEY" R2_BUCKET="$BUCKET" \
  ./.oneaway/scripts/migrate-minio-to-r2.sh || {
    echo "object copy failed; config untouched, still on MinIO" >&2; exit 1; }

echo "==> 2/5 Rewriting storage config"
python3 - "$ENDPOINT" "$R2_ACCESS_KEY" "$R2_SECRET_KEY" "$BUCKET" <<'PY'
import re, sys
endpoint, access, secret, bucket = sys.argv[1:5]
settings = {
    "CAP_AWS_ACCESS_KEY": access,
    "CAP_AWS_SECRET_KEY": secret,
    "CAP_AWS_BUCKET": bucket,
    "CAP_AWS_REGION": "auto",
    "S3_INTERNAL_ENDPOINT": endpoint,
    "S3_PUBLIC_ENDPOINT": endpoint,
    "S3_PATH_STYLE": "true",
}
text = open(".env").read()
for key, value in settings.items():
    line = f"{key}={value}"
    if re.search(rf"(?m)^{key}=", text):
        text = re.sub(rf"(?m)^{key}=.*$", line, text)
    else:
        text += ("" if text.endswith("\n") else "\n") + line + "\n"
open(".env", "w").write(text)
print(f"    endpoint -> {endpoint}")
PY

echo "==> 3/5 Restarting"
docker compose up -d >/dev/null 2>&1
for _ in $(seq 1 60); do
  curl -sf -o /dev/null http://localhost:"${CAP_PORT:-3900}"/ && break
  sleep 2
done

echo "==> 4/5 Proving the new path with real bytes"
SMOKE_LOG="$(mktemp -t capsmokelog)"
if ! ./.oneaway/scripts/smoke-test.sh 2>&1 | tee "$SMOKE_LOG"; then
  echo "SMOKE TEST FAILED against R2" >&2
  rm -f "$SMOKE_LOG"
  restore
  exit 1
fi

# A passing smoke test only proves *some* storage works. It passed against MinIO
# once while the config claimed R2, because the base compose file hardcodes the
# storage settings and silently ignored .env. The host the app signs its URLs
# for is the only thing that distinguishes a real cutover from a convincing
# one — and the smoke test deletes its own object, so counting objects in the
# bucket afterwards proves nothing either.
echo "==> 5/5 Confirming the app is actually signing against R2"
EXPECTED_HOST=$(printf '%s' "$ENDPOINT" | cut -d/ -f3)
SIGNED_HOST=$(grep -m1 "signed for" "$SMOKE_LOG" | sed 's|.*signed for ||' | cut -d/ -f3)
rm -f "$SMOKE_LOG"
echo "    expected: $EXPECTED_HOST"
echo "    actual:   $SIGNED_HOST"
if [ "$SIGNED_HOST" != "$EXPECTED_HOST" ]; then
  echo "THE APP IS NOT USING R2 — it signed against $SIGNED_HOST." >&2
  echo "The config says R2 but the container is still talking to something else." >&2
  restore
  exit 1
fi

cat <<DONE

CUTOVER COMPLETE — storage is on R2.

Rollback if anything looks wrong:
  cp $BACKUP .env && docker compose up -d

Keep MinIO running until an existing recording has been opened and played by a
real person. Only then consider retiring it.

Still outstanding before client-facing use, per spec section 12.3:
  - database backups with point-in-time restore (share links live in MySQL,
    not in R2 — losing that database orphans every link)
  - a real domain and TLS
  - Google SSO
DONE
