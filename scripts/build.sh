#!/usr/bin/env bash
set -euo pipefail

echo "==> Building mo-weather-widget v1.0.1 (reproducible build)..."
mkdir -p dist

# Audit #10: Reproducible build z przypiętą wersją terser 5.39.0
TERSER_BIN="./node_modules/.bin/terser"
if [ -x "$TERSER_BIN" ]; then
  "$TERSER_BIN" src/weather-widget.js --compress --mangle --comments '/^!/' --output dist/weather-widget.min.js
elif command -v terser >/dev/null 2>&1; then
  terser src/weather-widget.js --compress --mangle --comments '/^!/' --output dist/weather-widget.min.js
elif command -v npx >/dev/null 2>&1; then
  npx -y terser@5.39.0 src/weather-widget.js --compress --mangle --comments '/^!/' --output dist/weather-widget.min.js
else
  echo "Error: neither local terser nor npx found." >&2
  exit 1
fi

cp src/weather-widget.js dist/weather-widget.js
cp src/weather-api.php dist/weather-api.php

echo "✓ Build complete: dist/"
ls -lh dist/

