#!/usr/bin/env bash
# Freeze the exact evidence used by the paper into a source-controlled bundle.
set -euo pipefail

PROTOTYPE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
RESULTS_ROOT="${RECOURSE_RESULTS_ROOT:-$PROTOTYPE_DIR/results}"
FREEZE_ROOT="${RECOURSE_FROZEN_ARTIFACTS_DIR:-$PROTOTYPE_DIR/reproducibility/paper-v1}"
ARCHITECTURE_PNG="${RECOURSE_ARCHITECTURE_PNG:-$RESULTS_ROOT/figure_architecture.png}"

case "$RESULTS_ROOT" in
  /*) ;;
  *) RESULTS_ROOT="$PROTOTYPE_DIR/$RESULTS_ROOT" ;;
esac
case "$FREEZE_ROOT" in
  /*) ;;
  *) FREEZE_ROOT="$PROTOTYPE_DIR/$FREEZE_ROOT" ;;
esac

SOURCE_ROOT="$(git -C "$PROTOTYPE_DIR" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$PROTOTYPE_DIR")"
source_tree_digest="$(
  python3 - "$SOURCE_ROOT" "$FREEZE_ROOT" <<'PY'
import hashlib
import subprocess
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
freeze = Path(sys.argv[2]).resolve()
listing = subprocess.run(
    ["git", "-C", str(root), "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    check=True,
    capture_output=True,
).stdout
digest = hashlib.sha256()
for raw in sorted(item for item in listing.split(b"\0") if item):
    path = root / raw.decode()
    try:
        path.resolve().relative_to(freeze)
    except ValueError:
        pass
    else:
        continue
    if not path.is_file():
        continue
    digest.update(raw)
    digest.update(b"\0")
    digest.update(hashlib.sha256(path.read_bytes()).digest())
print(digest.hexdigest())
PY
)"

if [[ -e "$FREEZE_ROOT" ]]; then
  if [[ "${RECOURSE_REPLACE_FROZEN:-0}" != "1" ]]; then
    echo "refusing to replace frozen evidence: $FREEZE_ROOT" >&2
    echo "set RECOURSE_REPLACE_FROZEN=1 for an intentional, reviewable replacement" >&2
    exit 1
  fi
  trash "$FREEZE_ROOT"
fi

copy_one() {
  local source=$1
  local relative=$2
  if [[ ! -f "$source" ]]; then
    echo "missing required paper artifact: $source" >&2
    exit 1
  fi
  mkdir -p "$FREEZE_ROOT/$(dirname "$relative")"
  cp "$source" "$FREEZE_ROOT/$relative"
}

for rq in rq1 rq2 rq2-reasons rq3 rq4 rq5 rq5-adv rq8 rq9 rq10; do
  copy_one "$RESULTS_ROOT/$rq/metrics.parquet" "results/$rq/metrics.parquet"
  copy_one "$RESULTS_ROOT/$rq/manifest.json" "results/$rq/manifest.json"
  for artifact in "$RESULTS_ROOT/$rq"/table_*.tex "$RESULTS_ROOT/$rq"/figure_*.pdf "$RESULTS_ROOT/$rq"/figure_*.svg; do
    [[ -e "$artifact" ]] || continue
    copy_one "$artifact" "results/$rq/$(basename "$artifact")"
  done
done

while read -r rq ci_table; do
  ci_dir="$rq-ci"
  copy_one "$RESULTS_ROOT/$ci_dir/metrics.parquet" "results/$ci_dir/metrics.parquet"
  copy_one "$RESULTS_ROOT/$ci_dir/multi_seed_manifest.json" \
    "results/$ci_dir/multi_seed_manifest.json"
  copy_one "$RESULTS_ROOT/$ci_dir/$ci_table" "results/$ci_dir/$ci_table"
done <<'EOF'
rq1 table_rq1_baselines_ci.tex
rq4 table_rq4_ablation_ci.tex
rq5-adv table_rq5_adv_ci.tex
rq8 table_rq8_bondsens_ci.tex
rq10 table_rq10_correlated_ci.tex
EOF
copy_one "$RESULTS_ROOT/multi-seed/report.md" "results/multi-seed/report.md"

for provider in postgres git cloud; do
  provider_dir="rq-provider-$provider"
  copy_one "$RESULTS_ROOT/$provider_dir/cells.json" "results/$provider_dir/cells.json"
  copy_one "$RESULTS_ROOT/$provider_dir/metrics.parquet" \
    "results/$provider_dir/metrics.parquet"
  copy_one "$RESULTS_ROOT/$provider_dir/manifest.json" "results/$provider_dir/manifest.json"
  copy_one "$RESULTS_ROOT/$provider_dir/table_provider_${provider}.tex" \
    "results/$provider_dir/table_provider_${provider}.tex"
done

for artifact in registration.json table_k_catalogue.tex snippet.tex; do
  copy_one "$RESULTS_ROOT/k-contracts/$artifact" "results/k-contracts/$artifact"
done

for group in anvil-e2e fuzzing; do
  if [[ ! -d "$RESULTS_ROOT/$group" ]]; then
    echo "missing required paper artifact group: $RESULTS_ROOT/$group" >&2
    exit 1
  fi
  while IFS= read -r -d '' artifact; do
    copy_one "$artifact" "results/$group/$(basename "$artifact")"
  done < <(find "$RESULTS_ROOT/$group" -maxdepth 1 -type f -print0)
done

copy_one "$ARCHITECTURE_PNG" "figures/figure_architecture.png"

git_commit="$(git -C "$PROTOTYPE_DIR" rev-parse HEAD 2>/dev/null || printf unknown)"
git_dirty=false
if [[ -n "$(git -C "$PROTOTYPE_DIR" status --porcelain --untracked-files=all)" ]]; then
  git_dirty=true
fi
python3 - "$FREEZE_ROOT/provenance.json" "$git_commit" "$git_dirty" "$source_tree_digest" "$RESULTS_ROOT" <<'PY'
import json
import sys
from pathlib import Path

target, commit, dirty, tree_digest, results = sys.argv[1:]
document = {
    "schemaVersion": 1,
    "sourceCommit": commit,
    "sourceTreeDirtyAtFreeze": dirty == "true",
    "sourceTreeSha256": tree_digest,
    "resultsSource": results,
    "notes": [
        "Synthetic metrics are deterministic outputs of the pinned harness configuration.",
        "Provider timings are retained as raw local-sandbox observations but excluded from paper-facing tables because they vary across machines.",
        "The checksum file binds every frozen byte used to rebuild the paper.",
    ],
}
Path(target).write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")
PY

(
  cd "$FREEZE_ROOT"
  checksum_tmp="$(mktemp "${TMPDIR:-/tmp}/recourse-paper-checksums.XXXXXX")"
  find . -type f ! -name CHECKSUMS.sha256 -print \
    | LC_ALL=C sort \
    | while IFS= read -r artifact; do
        shasum -a 256 "$artifact"
      done >"$checksum_tmp"
  mv "$checksum_tmp" CHECKSUMS.sha256
)

echo "frozen paper evidence: $FREEZE_ROOT"
