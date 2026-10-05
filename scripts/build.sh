#!/usr/bin/env bash
set -euo pipefail

echo "==> Building mo-weather-widget..."
mkdir -p dist

if command -v terser >/dev/null 2>&1; then
  terser src/weather-widget.js --compress --mangle --output dist/weather-widget.min.js
elif command -v npx >/dev/null 2>&1; then
  npx -y terser src/weather-widget.js --compress --mangle --output dist/weather-widget.min.js
else
  echo "Error: neither terser nor npx found." >&2
  exit 1
fi

cp src/weather-widget.js dist/weather-widget.js
cp src/weather-api.php dist/weather-api.php

echo "✓ Build complete: dist/"
ls -lh dist/
