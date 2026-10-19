#!/usr/bin/env bash
set -euo pipefail

echo "==> Building mo-weather-widget v2.0.0 (reproducible build)..."
mkdir -p dist

# Audit #10: Reproducible build z przypiętą wersją terser 5.39.0
TERSER_BIN="./node_modules/.bin/terser"
terser_run() {
  if [ -x "$TERSER_BIN" ]; then
    "$TERSER_BIN" "$@"
  elif command -v terser >/dev/null 2>&1; then
    terser "$@"
  elif command -v npx >/dev/null 2>&1; then
    npx -y terser@5.39.0 "$@"
  else
    echo "Error: neither local terser nor npx found." >&2
    exit 1
  fi
}

terser_run src/weather-widget.js --compress --mangle --comments '/^!/' --output dist/weather-widget.min.js

# Radar burzowy: moduł ładowany dopiero po kliknięciu = podkład mapy + matematyka mapy + okno radaru.
# Podkład (src/mo-radar-basemap.js) generuje scripts/gen-basemap.mjs --js.
{
  echo '/*! MO Weather Widget v2.0.0: radar burzowy. Radar: EUMETNET OPERA (CC BY 4.0), granice: PRG/GUGiK (ppatrzyk/polska-geojson, MIT), mapa: © OpenStreetMap contributors © CARTO */'
  echo '(function () {'
  cat src/mo-radar-basemap.js
  cat src/mo-radar-map.js
  cat src/mo-radar.js
  echo '})();'
} > dist/mo-radar.js
terser_run dist/mo-radar.js --compress --mangle --comments '/^!/' --output dist/mo-radar.min.js

cp src/weather-widget.js dist/weather-widget.js
cp src/weather-api.php dist/weather-api.php
cp src/radar-api.php dist/radar-api.php
cp src/radar-lib.php dist/radar-lib.php
cp src/cities.php dist/cities.php

# Kopiowanie zasobów do katalogu publicznego (Railway & Landing Page)
mkdir -p public/assets public/api
cp dist/weather-widget.min.js public/assets/weather-widget.min.js
cp dist/weather-widget.js public/assets/weather-widget.js
cp dist/mo-radar.min.js public/assets/mo-radar.min.js
cp dist/mo-radar.js public/assets/mo-radar.js
cp src/weather-api.php public/api/weather-api.php
cp src/radar-api.php public/api/radar-api.php
cp src/radar-lib.php public/api/radar-lib.php
cp src/cities.php public/api/cities.php

echo "✓ Build complete: dist/ and public/assets/"
ls -lh dist/ public/assets/
