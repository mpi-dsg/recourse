#!/usr/bin/env bash
# Build a source-complete, checksummed reproducibility snapshot.
set -euo pipefail

PROTOTYPE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(git -C "$PROTOTYPE_DIR" rev-parse --show-toplevel)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="${1:-$PROTOTYPE_DIR/artifacts/recourse-snapshot-${STAMP}.tar.gz}"
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/recourse-snapshot.XXXXXX")"
SNAPSHOT_ROOT="$WORKDIR/recourse"

cleanup() {
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

DIRTY=false
if [[ -n "$(git -C "$REPO_ROOT" status --porcelain --untracked-files=all)" ]]; then
  DIRTY=true
fi
if [[ "$DIRTY" == true && "${RECOURSE_ALLOW_DIRTY_SNAPSHOT:-0}" != "1" ]]; then
  echo "refusing to snapshot a dirty tree" >&2
  echo "commit/stash changes or set RECOURSE_ALLOW_DIRTY_SNAPSHOT=1 for a diagnostic snapshot" >&2
  exit 1
fi

mkdir -p "$SNAPSHOT_ROOT" "$(dirname "$OUT")"

if [[ "$DIRTY" == false ]]; then
  git -C "$REPO_ROOT" archive --format=tar HEAD | tar -xf - -C "$SNAPSHOT_ROOT"
else
  # Diagnostic mode preserves current tracked and untracked source while
  # excluding credentials, build products, bulk local results, and VCS state.
  tar -C "$REPO_ROOT" \
    --exclude=.git \
    --exclude='.env' \
    --exclude='.env.*' \
    --exclude='*.key' \
    --exclude='*.pem' \
    --exclude='prototype/contracts/out' \
    --exclude='prototype/contracts/cache' \
    --exclude='prototype/contracts/broadcast' \
    --exclude='node_modules' \
    --exclude='.venv' \
    --exclude='__pycache__' \
    --exclude='.pytest_cache' \
    --exclude='.ruff_cache' \
    --exclude='.mypy_cache' \
    --exclude='prototype/results' \
    --exclude='prototype/artifacts' \
    --exclude='trash' \
    -cf - . | tar -xf - -C "$SNAPSHOT_ROOT"
fi

# git archive stores only submodule gitlinks. Include the exact checked-out
# submodule contents so the snapshot does not need network access to compile.
while read -r SUBMODULE_PATH; do
  [[ -n "$SUBMODULE_PATH" ]] || continue
  mkdir -p "$SNAPSHOT_ROOT/$SUBMODULE_PATH"
  git -C "$REPO_ROOT/$SUBMODULE_PATH" archive --format=tar HEAD \
    | tar -xf - -C "$SNAPSHOT_ROOT/$SUBMODULE_PATH"
done < <(
  git -C "$REPO_ROOT" submodule status --recursive \
    | awk '{print $2}'
)

if [[ -n "${RECOURSE_PAPER_DIR:-}" ]]; then
  PAPER_DIR="$(cd -- "$RECOURSE_PAPER_DIR" && pwd)"
  mkdir -p "$SNAPSHOT_ROOT/paper"
  git -C "$PAPER_DIR" archive --format=tar HEAD | tar -xf - -C "$SNAPSHOT_ROOT/paper"
fi

GIT_COMMIT="$(git -C "$REPO_ROOT" rev-parse HEAD)"
SUBMODULES="$(
  git -C "$REPO_ROOT" submodule status --recursive \
    | sed -E 's/^[-+ ]?([0-9a-f]+) ([^ ]+).*/\2=\1/' \
    | paste -sd, -
)"

cat >"$SNAPSHOT_ROOT/manifest.json" <<EOF
{
  "schemaVersion": 2,
  "createdAt": "${STAMP}",
  "gitCommit": "${GIT_COMMIT}",
  "gitDirty": ${DIRTY},
  "submodules": "${SUBMODULES}",
  "toolVersions": {
    "forge": "$(forge --version | head -n1 | sed 's/"/\\"/g')",
    "bun": "$(bun --version)",
    "uv": "$(uv --version | awk '{print $2}')",
    "python": "$(python3 --version | awk '{print $2}')"
  },
  "includesPaper": $(if [[ -n "${RECOURSE_PAPER_DIR:-}" ]]; then echo true; else echo false; fi)
}
EOF

(
  cd "$SNAPSHOT_ROOT"
  checksum_tmp="$(mktemp "${TMPDIR:-/tmp}/recourse-snapshot-checksums.XXXXXX")"
  find . -type f ! -name checksums.sha256 -exec shasum -a 256 {} + \
    | LC_ALL=C sort -k2 >"$checksum_tmp"
  mv "$checksum_tmp" checksums.sha256
)

tar -C "$WORKDIR" -czf "$OUT" recourse
echo "wrote $OUT"
