#!/usr/bin/env bash
# Bring up the local integration stack (Postgres, later Gitea + LocalStack + Anvil).
# Exits non-zero if any service does not become healthy within the deadline.
set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE_FILE="integration/docker-compose.yml"
DEADLINE_SECONDS="${RECOURSE_INTEGRATION_DEADLINE:-60}"

docker compose -f "$COMPOSE_FILE" up -d

deadline=$(( $(date +%s) + DEADLINE_SECONDS ))
while (( $(date +%s) < deadline )); do
  unhealthy=$(docker compose -f "$COMPOSE_FILE" ps --format json \
    | python3 -c '
import json, sys
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    obj = json.loads(line)
    health = obj.get("Health", "")
    if health and health != "healthy":
        print(obj.get("Service", obj.get("Name", "")))
' || true)
  if [ -z "$unhealthy" ]; then
    echo "All integration services healthy."
    exit 0
  fi
  sleep 1
done

echo "Integration services did not become healthy within ${DEADLINE_SECONDS}s." >&2
docker compose -f "$COMPOSE_FILE" ps >&2 || true
exit 1
