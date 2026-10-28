#!/usr/bin/env bash
# Bootstraps every toolchain the prototype needs. Idempotent.
set -euo pipefail

cd "$(dirname "$0")/.."

require() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing: $1 ($2)" >&2
    return 1
  }
}

require forge "install foundry: https://book.getfoundry.sh/getting-started/installation"
require bun "install bun: https://bun.sh"
require uv "install uv: https://docs.astral.sh/uv/getting-started/installation/"

require_version() {
  local tool="$1"
  local actual="$2"
  local expected="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "unsupported $tool version: expected $expected, found $actual" >&2
    echo "use the pinned Dockerfile or install the exact version" >&2
    return 1
  fi
}

require_version forge "$(forge --version | head -n1 | sed -E 's/^forge Version: ([^ -]+).*/\1/')" "1.3.5"
require_version bun "$(bun --version)" "1.3.5"
require_version uv "$(uv --version | awk '{print $2}')" "0.11.28"

require_foundry_dep() {
  local submodule="$1"
  local expected_path="$2"
  if [[ -d "$expected_path" ]]; then
    echo "foundry dependency present: $submodule"
    return 0
  fi
  git submodule update --init --recursive "$submodule"
  [[ -d "$expected_path" ]] || {
    echo "missing pinned Foundry dependency after submodule initialization: $submodule" >&2
    return 1
  }
}

# Solidity deps. Git submodule gitlinks are the version authority.
require_foundry_dep contracts/lib/forge-std contracts/lib/forge-std/src
require_foundry_dep contracts/lib/openzeppelin-contracts contracts/lib/openzeppelin-contracts/contracts

# TS deps
( cd runtime-ts && bun install --frozen-lockfile )

# Python deps
( cd classifier && uv sync --extra dev )
( cd harness && uv sync --extra dev )

echo "bootstrap ok"
