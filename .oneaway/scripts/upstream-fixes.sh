#!/usr/bin/env bash
#
# Report upstream bug fixes worth pulling into the fork.
#
# We deliberately do not track upstream wholesale — most of its ~600
# commits/month are features we did not ask for, and each merge risks the
# recording pipeline. But abandoning upstream entirely means keeping today's
# bugs forever.
#
# Conventional commits make the middle path cheap: filter to `fix:`, scope to
# the paths we actually depend on, and the volume drops to a handful a month.
#
#   ./upstream-fixes.sh              # since the last review marker, else 30 days
#   ./upstream-fixes.sh "2 weeks ago"
#   ./upstream-fixes.sh --all        # every area, not just our dependencies
#
# After reviewing, record the point you reached:
#   git tag -f oneaway/upstream-reviewed upstream/main

set -euo pipefail

cd "$(dirname "$0")/../.."

MARKER="oneaway/upstream-reviewed"
SCOPE_ALL=false
SINCE=""

for arg in "$@"; do
  case "$arg" in
    --all) SCOPE_ALL=true ;;
    *) SINCE="$arg" ;;
  esac
done

# Paths whose bugs actually reach us: the recording pipeline we hook, the local
# ASR engines, upload, and the chunk-scheduling logic our Rust port mirrors.
PATHS=(
  apps/desktop/src-tauri/src/recording.rs
  apps/desktop/src-tauri/src/captions.rs
  apps/desktop/src-tauri/src/upload.rs
  apps/desktop/src-tauri/src/audio.rs
  crates/recording
  crates/media
  crates/audio
  apps/web/lib/live-transcribe-core.ts
  apps/web/lib/segments-audio.ts
  apps/web/lib/edit-transcript.ts
  apps/web/lib/transcribe-utils.ts
)

# Applicability is probed with real cherry-picks, which would consume or
# destroy uncommitted work.
if ! git diff-index --quiet HEAD -- || [ -n "$(git ls-files --others --exclude-standard)" ]; then
  echo "Refusing to run: working tree is not clean." >&2
  echo "This script trial-applies commits and would clobber uncommitted work." >&2
  git status --short >&2
  exit 1
fi

echo "==> Fetching upstream"
git fetch upstream --quiet

if [ -n "$SINCE" ]; then
  RANGE_DESC="since $SINCE"
  RANGE_ARGS=(--since="$SINCE")
elif git rev-parse -q --verify "refs/tags/$MARKER" >/dev/null; then
  RANGE_DESC="since last review ($MARKER)"
  RANGE_ARGS=("$MARKER..upstream/main")
else
  RANGE_DESC="last 30 days (no $MARKER tag yet)"
  RANGE_ARGS=(--since="30 days ago")
fi

echo "==> Fixes $RANGE_DESC"
echo

if [ "$SCOPE_ALL" = true ]; then
  MATCHES=$(git log upstream/main "${RANGE_ARGS[@]}" --format='%h%x09%s' | grep -E '^[^	]+	(fix|perf)' || true)
  SCOPE_DESC="all paths"
else
  MATCHES=$(git log upstream/main "${RANGE_ARGS[@]}" --format='%h%x09%s' -- "${PATHS[@]}" | grep -E '^[^	]+	(fix|perf)' || true)
  SCOPE_DESC="paths the fork depends on"
fi

if [ -z "$MATCHES" ]; then
  echo "  none in $SCOPE_DESC — nothing to do"
  exit 0
fi

COUNT=$(printf '%s\n' "$MATCHES" | wc -l | tr -d ' ')
echo "  $COUNT candidate(s) in $SCOPE_DESC:"
echo

# Report whether each fix would land cleanly. A cherry-pick that no longer
# applies is the real cost of a frozen fork, and it is better to see that here
# than halfway through a merge.
while IFS=$'\t' read -r sha subject; do
  [ -z "$sha" ] && continue
  if git cherry-pick --no-commit --no-rerere-autoupdate "$sha" >/dev/null 2>&1; then
    status="clean   "
    git cherry-pick --abort >/dev/null 2>&1 || git reset --hard --quiet HEAD
  else
    status="CONFLICT"
    git cherry-pick --abort >/dev/null 2>&1 || git reset --hard --quiet HEAD
  fi
  printf '  [%s] %s  %s\n' "$status" "$sha" "$subject"
done <<< "$MATCHES"

cat <<DONE

Apply one:      git cherry-pick <sha>
Inspect one:    git show <sha>
Mark reviewed:  git tag -f $MARKER upstream/main
DONE
