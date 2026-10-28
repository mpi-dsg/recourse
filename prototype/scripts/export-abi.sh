#!/usr/bin/env bash
# Export or check ABI snapshots for contracts that form the public deployment surface.
set -euo pipefail

cd "$(dirname "$0")/../contracts"

mode="${1:-write}"
out_dir="../deployments/base-sepolia/abi"

contracts=(
  RecourseRegistry
  BondVault
  ClaimRegistry
  OptimisticPath
  ArbitrablePath
)

case "$mode" in
  write)
    mkdir -p "$out_dir"
    for contract in "${contracts[@]}"; do
      forge inspect "src/${contract}.sol:${contract}" abi --json > "${out_dir}/${contract}.json"
    done
    echo "wrote ABI snapshots to ${out_dir}"
    ;;
  --check)
    tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/recourse-abi.XXXXXX")"
    trap 'rm -rf "$tmp_dir"' EXIT
    for contract in "${contracts[@]}"; do
      current="${out_dir}/${contract}.json"
      expected="${tmp_dir}/${contract}.json"
      forge inspect "src/${contract}.sol:${contract}" abi --json > "$expected"
      if [[ ! -f "$current" ]]; then
        echo "missing ABI snapshot: ${current}" >&2
        exit 1
      fi
      if ! diff -u "$current" "$expected"; then
        echo "ABI snapshot out of date: ${current}" >&2
        exit 1
      fi
    done
    echo "ABI snapshots are current"
    ;;
  *)
    echo "usage: $0 [--check]" >&2
    exit 2
    ;;
esac
