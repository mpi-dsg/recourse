#!/usr/bin/env bash
# Fail when a locked runtime dependency has a published vulnerability.
set -euo pipefail

PROTOTYPE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
PIP_AUDIT_VERSION=2.10.1

check_bun() {
  local audit_output
  audit_output="$(cd "$PROTOTYPE_DIR/runtime-ts" && bun audit --json)"
  AUDIT_OUTPUT="$audit_output" python3 - <<'PY'
import json
import os
import re

raw = re.sub(r"\x1b\[[0-9;]*m", "", os.environ["AUDIT_OUTPUT"])
payload = json.loads(raw.strip().splitlines()[-1])
if payload:
    raise SystemExit(f"bun audit reported vulnerabilities: {json.dumps(payload, sort_keys=True)}")
PY
}

check_python_project() {
  local project="$1"
  local requirements
  requirements="$(mktemp "${TMPDIR:-/tmp}/recourse-${project}-requirements.XXXXXX")"
  trap 'rm -f "$requirements"' RETURN
  (
    cd "$PROTOTYPE_DIR/$project"
    uv export \
      --frozen \
      --all-extras \
      --quiet \
      --no-emit-local \
      --no-emit-project \
      --format requirements-txt \
      --output-file "$requirements" \
      >/dev/null
  )
  uvx "pip-audit==${PIP_AUDIT_VERSION}" \
    --requirement "$requirements" \
    --no-deps \
    --disable-pip
  rm -f "$requirements"
  trap - RETURN
}

check_bun
check_python_project classifier
check_python_project harness
echo "dependency audit ok"
