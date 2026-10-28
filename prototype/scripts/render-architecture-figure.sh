#!/usr/bin/env bash
# Render the editable architecture source into the paper's PNG figure.
set -euo pipefail

PROTOTYPE_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd -- "$PROTOTYPE_DIR/.." && pwd)"
SOURCE="$REPO_ROOT/docs/recourse-architecture.html"
CHROME="${RECOURSE_CHROME_BIN:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
OUTPUT="${1:-${RECOURSE_PAPER_DIR:-}/figures/figure_architecture.png}"

if [[ ! -f "$SOURCE" ]]; then
  echo "missing architecture source: $SOURCE" >&2
  exit 1
fi
if [[ ! -x "$CHROME" ]]; then
  echo "missing Chrome executable; set RECOURSE_CHROME_BIN" >&2
  exit 1
fi
if [[ -z "$OUTPUT" || "$OUTPUT" == /figures/figure_architecture.png ]]; then
  echo "usage: $0 OUTPUT.png (or set RECOURSE_PAPER_DIR)" >&2
  exit 2
fi

mkdir -p "$(dirname "$OUTPUT")"
CHROME_PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/recourse-chrome.XXXXXX")"
trap 'rm -rf "$CHROME_PROFILE"' EXIT
rm -f "$OUTPUT"
"$CHROME" \
  --headless \
  --disable-gpu \
  --no-first-run \
  --no-default-browser-check \
  --hide-scrollbars \
  --user-data-dir="$CHROME_PROFILE" \
  --force-device-scale-factor=2 \
  --window-size=1760,1040 \
  --screenshot="$OUTPUT" \
  "file://$SOURCE?paper=1" \
  >/dev/null 2>&1 &
CHROME_PID=$!

# Chrome 150 on macOS can leave its headless browser process alive after the
# screenshot is written. Treat the non-empty output as completion, then reap
# the isolated process instead of hanging the reproduction workflow.
for _ in $(seq 1 200); do
  [[ -s "$OUTPUT" ]] && break
  if ! kill -0 "$CHROME_PID" 2>/dev/null; then
    wait "$CHROME_PID"
    break
  fi
  sleep 0.1
done
if [[ ! -s "$OUTPUT" ]]; then
  kill "$CHROME_PID" 2>/dev/null || true
  sleep 0.2
  kill -KILL "$CHROME_PID" 2>/dev/null || true
  wait "$CHROME_PID" 2>/dev/null || true
  echo "Chrome did not render $OUTPUT" >&2
  exit 1
fi
kill "$CHROME_PID" 2>/dev/null || true
sleep 0.2
kill -KILL "$CHROME_PID" 2>/dev/null || true
wait "$CHROME_PID" 2>/dev/null || true

echo "wrote $OUTPUT"
