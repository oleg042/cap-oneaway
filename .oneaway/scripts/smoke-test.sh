#!/usr/bin/env bash
#
# Prove the storage round-trip: log in, create a video, upload bytes through a
# presigned URL, then read them back through the playback path.
#
# Run it after any storage change — especially the MinIO -> R2 cutover, where
# the failure mode is silent. A misconfigured endpoint still returns healthy
# containers and a share page that renders; only fetching real bytes back
# proves the path works.
#
#   ./smoke-test.sh                       # against localhost:3900
#   BASE=https://video.oneaway.io ./smoke-test.sh
#
# Requires an EMAIL that can log in. With RESEND_API_KEY unset the login code
# is read from the container logs, so remote instances need OTP access instead.

set -euo pipefail

BASE="${BASE:-http://localhost:3900}"
EMAIL="${EMAIL:-oleg@oneaway.io}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
JAR="$(mktemp -t capjar)"
WORK="$(mktemp -d -t capsmoke)"
trap 'rm -rf "$JAR" "$WORK"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

echo "==> Authenticating as $EMAIL"
CSRF=$(curl -sf -c "$JAR" "$BASE/api/auth/csrf" | python3 -c 'import sys,json;print(json.load(sys.stdin)["csrfToken"])') \
  || fail "cannot reach $BASE"
curl -sf -b "$JAR" -c "$JAR" -o /dev/null -X POST "$BASE/api/auth/signin/email" \
  --data-urlencode "csrfToken=$CSRF" --data-urlencode "email=$EMAIL" \
  --data-urlencode "callbackUrl=$BASE/dashboard" || true

sleep 2
CODE=$(cd "$REPO" && docker compose logs cap-web --tail 60 2>&1 | grep "Code:" | tail -1 | grep -oE "[0-9]{6}") \
  || fail "no login code in logs (remote instance? set RESEND_API_KEY and use the emailed code)"
ENC_EMAIL=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1]))" "$EMAIL")
curl -sf -b "$JAR" -c "$JAR" -o /dev/null -L \
  "$BASE/api/auth/callback/email?token=$CODE&email=$ENC_EMAIL" || fail "login callback rejected"
curl -sf -b "$JAR" "$BASE/api/auth/session" | grep -q '"email"' || fail "no session established"
echo "    authenticated"

echo "==> Generating a 3s test video"
# colima does not mount /tmp into its VM, so build in a container and copy out
# rather than bind-mounting.
docker rm -f cap-smoke-ffmpeg >/dev/null 2>&1 || true
docker run --name cap-smoke-ffmpeg --entrypoint sh linuxserver/ffmpeg -c \
  "ffmpeg -f lavfi -i testsrc=size=640x360:rate=15 -t 3 -c:v libx264 -pix_fmt yuv420p -y /tmp/s.mp4" \
  >/dev/null 2>&1
docker cp cap-smoke-ffmpeg:/tmp/s.mp4 "$WORK/s.mp4" >/dev/null 2>&1
docker rm -f cap-smoke-ffmpeg >/dev/null 2>&1 || true
[ -s "$WORK/s.mp4" ] || fail "could not generate a test video"
SENT=$(wc -c < "$WORK/s.mp4" | tr -d ' ')
echo "    $SENT bytes"

echo "==> Creating the video record"
VIDEO_ID=$(curl -sf -b "$JAR" \
  "$BASE/api/desktop/video/create?recordingMode=desktopMP4&name=oneaway-smoke-test&durationInSecs=3&width=640&height=360&fps=15" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])') || fail "video create failed"
echo "    $VIDEO_ID"

echo "==> Uploading through a presigned URL"
PUT_URL=$(curl -sf -b "$JAR" -X POST "$BASE/api/upload/signed/batch" \
  -H "Content-Type: application/json" \
  -d "{\"videoId\":\"$VIDEO_ID\",\"subpaths\":[\"result.mp4\"]}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin)["urls"]["result.mp4"])') || fail "no presigned URL"
echo "    signed for $(echo "$PUT_URL" | cut -d/ -f1-3)"
curl -sf -o /dev/null -X PUT --data-binary "@$WORK/s.mp4" -H "Content-Type: video/mp4" "$PUT_URL" \
  || fail "upload rejected"

echo "==> Reading it back through the playback path"
MEDIA=$(curl -s -b "$JAR" -o /dev/null -w "%{redirect_url}" "$BASE/api/playlist?videoId=$VIDEO_ID&videoType=video")
[ -n "$MEDIA" ] || fail "playlist did not redirect to media"
GOT=$(curl -sf -o "$WORK/back.mp4" -w "%{size_download}" "$MEDIA") || fail "media fetch failed"
[ "$GOT" = "$SENT" ] || fail "size mismatch: sent $SENT, got $GOT"
cmp -s "$WORK/s.mp4" "$WORK/back.mp4" || fail "bytes differ from what was uploaded"
echo "    $GOT bytes, byte-identical"

echo "==> Cleaning up"
if curl -sf -b "$JAR" -o /dev/null -X DELETE "$BASE/api/video/delete?videoId=$VIDEO_ID" 2>/dev/null; then
  echo "    removed $VIDEO_ID"
else
  echo "    NOTE: could not delete $VIDEO_ID; remove it from the dashboard"
fi

echo
echo "PASS — storage round-trip is intact at $BASE"
