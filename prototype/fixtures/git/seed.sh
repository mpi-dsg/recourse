#!/usr/bin/env bash
# Reproducible fixture for the Git workload.
# Creates a bare repo at $RECOURSE_GIT_BARE with three deterministic commits on
# refs/heads/main. Idempotent: re-runs replace any existing repo state.

set -euo pipefail

BARE="${RECOURSE_GIT_BARE:-./var/git/demo.git}"
WORK="${RECOURSE_GIT_WORK:-./var/git/demo-work}"

mkdir -p "$(dirname "$BARE")"
rm -rf "$BARE" "$WORK"

git init --bare --initial-branch=main "$BARE" >/dev/null
git clone "$BARE" "$WORK" >/dev/null 2>&1

cd "$WORK"
git config user.email "test@example.com"
git config user.name "Recourse Test"
git config commit.gpgsign false
# Deterministic committer time so SHAs are stable across reruns.
export GIT_AUTHOR_DATE="2026-05-09T00:00:00+0000"
export GIT_COMMITTER_DATE="2026-05-09T00:00:00+0000"

echo "first" > README.md
git add README.md
git commit -m "first" --allow-empty-message >/dev/null
git push -q origin main

export GIT_AUTHOR_DATE="2026-05-09T00:00:01+0000"
export GIT_COMMITTER_DATE="2026-05-09T00:00:01+0000"
echo "second" > two.md
git add two.md
git commit -m "second" >/dev/null
git push -q origin main

export GIT_AUTHOR_DATE="2026-05-09T00:00:02+0000"
export GIT_COMMITTER_DATE="2026-05-09T00:00:02+0000"
echo "third" > three.md
git add three.md
git commit -m "third" >/dev/null
git push -q origin main

cd - >/dev/null
echo "git fixture seeded: bare=$BARE work=$WORK"
git --git-dir="$BARE" log --oneline refs/heads/main
