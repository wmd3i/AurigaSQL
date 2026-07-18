#!/usr/bin/env bash
# Start the AurigaSQL frontend development server.
# Usage: ./dev.sh   (from anywhere — it cd's to its own directory)
set -euo pipefail

# Always run from the directory this script lives in,
# so it works no matter where you invoke it from.
cd "$(dirname "$0")"

# Install dependencies on first run (or after a fresh clone / branch switch).
if [ ! -d node_modules ]; then
  echo "node_modules not found — running npm install..."
  npm install
fi

echo "Starting Vite dev server at http://localhost:5173 ..."
npm run dev
