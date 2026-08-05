#!/usr/bin/env bash
#
# Copy every object from the local MinIO bucket to Cloudflare R2.
#
# Storage config is env-only, so "switching to R2" is a one-line change — but
# switching without copying first leaves every existing recording pointing at
# an empty bucket. Share links already sitting in client inboxes 404, and the
# MySQL rows that map share IDs to object keys still look perfectly healthy,
# so nothing surfaces an error.
#
# Run this BEFORE swapping the endpoints in .env. It is idempotent and safe to
# re-run; the final pass is a verification diff, not a copy.

set -euo pipefail

: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID}"
: "${R2_ACCESS_KEY:?set R2_ACCESS_KEY}"
: "${R2_SECRET_KEY:?set R2_SECRET_KEY}"

BUCKET="${CAP_AWS_BUCKET:-cap}"
MINIO_PORT="${MINIO_PORT:-9900}"
MINIO_USER="${MINIO_ROOT_USER:-cap-admin}"
: "${MINIO_ROOT_PASSWORD:?set MINIO_ROOT_PASSWORD (see .env)}"

MC=(docker run --rm --network host --entrypoint sh minio/mc:latest -c)

echo "==> Registering endpoints"
"${MC[@]}" "
  mc alias set src http://localhost:${MINIO_PORT} '${MINIO_USER}' '${MINIO_ROOT_PASSWORD}' >/dev/null
  mc alias set dst https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com '${R2_ACCESS_KEY}' '${R2_SECRET_KEY}' >/dev/null
  mc mb --ignore-existing dst/${BUCKET} >/dev/null
  echo 'source objects:      '\$(mc ls --recursive src/${BUCKET} | wc -l)
  echo 'destination objects: '\$(mc ls --recursive dst/${BUCKET} | wc -l)
"

echo "==> Mirroring (resumable; re-run after a failure)"
"${MC[@]}" "
  mc alias set src http://localhost:${MINIO_PORT} '${MINIO_USER}' '${MINIO_ROOT_PASSWORD}' >/dev/null
  mc alias set dst https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com '${R2_ACCESS_KEY}' '${R2_SECRET_KEY}' >/dev/null
  mc mirror --overwrite --retry src/${BUCKET} dst/${BUCKET}
"

echo "==> Verifying (empty output below means every object matched)"
"${MC[@]}" "
  mc alias set src http://localhost:${MINIO_PORT} '${MINIO_USER}' '${MINIO_ROOT_PASSWORD}' >/dev/null
  mc alias set dst https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com '${R2_ACCESS_KEY}' '${R2_SECRET_KEY}' >/dev/null
  mc diff src/${BUCKET} dst/${BUCKET}
"

cat <<'DONE'

==> Copy complete.

Next:
  1. Apply .oneaway/r2.env.example into .env
  2. docker compose up -d
  3. Open an EXISTING recording and confirm it still plays. That is the only
     check that proves the key layout survived the move.

Keep MinIO running until step 3 passes. It is the rollback.
DONE
