#!/usr/bin/env bash
# Tear down the local integration stack started by integration-up.sh.
set -euo pipefail

cd "$(dirname "$0")/.."

docker compose -f integration/docker-compose.yml down --volumes --remove-orphans
