#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/webpanel"
npm install
npm run build
echo "Build gotowy. Wdróż folder webpanel jako nowy runtime Next.js zgodnie z hostingiem."
