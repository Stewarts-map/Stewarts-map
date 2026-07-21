#!/bin/bash
set -e
echo "── Bathroom Report: weekly bake ──"

# Sync with GitHub first so we never diverge
echo "Pulling latest from GitHub…"
git pull --no-rebase

# Bake current overrides (read-only; writes to ./baked/)
node fetch-and-bake.js

# Copy baked files in (only if any were produced)
if ls baked/*-locations.js >/dev/null 2>&1; then
  cp baked/*-locations.js .
else
  echo "Nothing baked. Done."; exit 0
fi

# Only stage location files — never functions/config/app files
git add ./*-locations.js
if git diff --cached --quiet; then
  echo "No location changes to commit. Done."; exit 0
fi

# Guard: never commit secrets
if git status --porcelain | grep -qi "serviceAccountKey\|overrides.json"; then
  echo ""; echo "🛑 STOP: a secret file is staged. Not committing."; exit 1
fi

git commit -m "Weekly bake of location overrides"
git push
echo ""
echo "✅ Baked, committed, pushed."
echo "   Next: confirm on the live app, then delete the baked overrides"
echo "   by hand in Firebase Console → Firestore → overrides."
