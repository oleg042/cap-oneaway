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

: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID}"
: "${R2_ACCESS_KEY:?set R2_ACCESS_KEY}"
: "${R2_SECRET_KEY:?set R2_SECRET_KEY}"
BUCKET="${R2_BUCKET:-cap}"

[ -f .env ] || { echo "no .env in $REPO" >&2; exit 1; }
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

echo "==> 1/5 Copying objects to R2"
R2_ACCOUNT_ID="$R2_ACCOUNT_ID" R2_ACCESS_KEY="$R2_ACCESS_KEY" \
R2_SECRET_KEY="$R2_SECRET_KEY" CAP_AWS_BUCKET="$BUCKET" \
  ./.oneaway/scripts/migrate-minio-to-r2.sh || {
    echo "object copy failed; config untouched, still on MinIO" >&2; exit 1; }

echo "==> 2/5 Rewriting storage config"
ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
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
if ! ./.oneaway/scripts/smoke-test.sh; then
  echo "SMOKE TEST FAILED against R2" >&2
  restore
  exit 1
fi

echo "==> 5/5 Confirming the bytes actually landed in R2, not MinIO"
COUNT=$(docker run --rm --entrypoint sh minio/mc:latest -c \
  "mc alias set r2 $ENDPOINT '$R2_ACCESS_KEY' '$R2_SECRET_KEY' >/dev/null && mc ls --recursive r2/$BUCKET | wc -l" 2>/dev/null | tr -d ' ')
echo "    $COUNT object(s) in R2"

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
