#!/usr/bin/env bash
#
# Build the Chrome extension pointed at our instance and package it for the
# team.
#
#   ./package-extension.sh                              # localhost:3900
#   ./package-extension.sh https://video.oneaway.io     # production
#
# The server address is baked in at build time so installing is one step. A
# teammate who has to find the options page and paste a URL before their first
# recording is a teammate who goes back to Loom. It stays editable in Options.
#
# Output: .oneaway/dist/cap-oneaway-extension-<host>.zip
#
# Distribution: upload the zip to the Chrome Web Store as an UNLISTED item.
# Unlisted installs auto-update and survive Chrome's periodic purge of
# developer-mode extensions; "Load unpacked" does neither and silently
# disables itself on some managed profiles.

set -euo pipefail

TARGET="${1:-http://localhost:3900}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
EXT="$REPO/apps/chrome-extension"
OUT="$REPO/.oneaway/dist"

export PATH="/opt/homebrew/opt/node@24/bin:$PATH"

# Rejected early rather than after a full build: a trailing slash or a missing
# scheme produces an extension that fails only at the first upload.
python3 - "$TARGET" <<'PY'
import sys
from urllib.parse import urlparse
url = sys.argv[1]
parsed = urlparse(url)
if parsed.scheme not in ("http", "https"):
    sys.exit(f"target must start with http:// or https:// — got {url!r}")
if not parsed.netloc:
    sys.exit(f"target has no host — got {url!r}")
if url.endswith("/"):
    sys.exit(f"drop the trailing slash — got {url!r}")
PY

HOST=$(python3 -c "import sys;from urllib.parse import urlparse;print(urlparse(sys.argv[1]).netloc.replace(':','-'))" "$TARGET")

echo "==> Building against $TARGET"
cd "$EXT"
VITE_CAP_API_BASE_URL="$TARGET" pnpm build >/dev/null 2>&1 || {
  echo "build failed; re-run without the output filter to see why" >&2; exit 1; }

grep -q "$(python3 -c "import sys;from urllib.parse import urlparse;print(urlparse(sys.argv[1]).netloc)" "$TARGET")" \
  dist/assets/storage.js || { echo "target URL is not in the bundle — build did not pick up the env var" >&2; exit 1; }
echo "    baked in and verified"

mkdir -p "$OUT"
ZIP="$OUT/cap-oneaway-extension-$HOST.zip"
rm -f "$ZIP"
(cd dist && zip -qr "$ZIP" .)

echo "==> Packaged"
echo "    $ZIP ($(du -h "$ZIP" | cut -f1))"
cat <<DONE

Install for the team, in order of preference:

  1. Chrome Web Store, visibility UNLISTED. Auto-updates, survives profile
     policy, one link to share. Needs a one-time \$5 developer account.

  2. Load unpacked (fine for trying it out):
     chrome://extensions -> Developer mode -> Load unpacked -> $EXT/dist

Recording against: $TARGET
The address is editable per person in the extension's Options.
DONE
