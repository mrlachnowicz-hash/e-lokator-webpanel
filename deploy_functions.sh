#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
cp -n .firebaserc.example .firebaserc 2>/dev/null || true
echo "Ustaw project ID w .firebaserc, potem uruchom ponownie jeśli trzeba."
cd functions
npm install
cd ..
firebase deploy --only functions
