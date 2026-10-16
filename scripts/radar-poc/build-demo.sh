#!/usr/bin/env bash
# Odtwarza PoC: 13 syntetycznych klatek -> dekoder PHP -> walidacja -> mapa SVG -> prototyp w KATALOG.
# Wymaga: Python z rasterio, pyproj, numpy, pillow; Node; PHP 8.1+ (albo PHP="npx -y @php-wasm/cli@latest").
# Granice PRG: pliki powiaty-medium.geojson i wojewodztwa-medium.geojson z ppatrzyk/polska-geojson w GEO_DIR.
set -euo pipefail
OUT="${1:-/tmp/radar-poc-demo}"
GEO_DIR="${GEO_DIR:-/tmp/geo}"
PHP="${PHP:-php}"
PY="${PY:-python3}"
HERE="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$OUT/cog" "$OUT/demo"
"$PY" "$HERE/make-synthetic.py" "$OUT/cog" --frames 13
$PHP "$HERE/render-batch.php" "$OUT/cog" "$OUT/demo"
for f in "$OUT"/cog/OPERA@*@0@DBZH.tiff; do
  t=$(basename "$f" | cut -d@ -f2)
  "$PY" "$HERE/validate.py" "$f" "$OUT/demo/radar_$t.png" | tr -d '\n '; echo " $t"
done
node "$HERE/../gen-basemap.mjs" --powiaty "$GEO_DIR/powiaty-medium.geojson" --woj "$GEO_DIR/wojewodztwa-medium.geojson" --out "$OUT/demo"
cp "$HERE/demo/index.html" "$OUT/demo/"
echo "Gotowe. Podgląd: python3 -m http.server 8080 --directory $OUT/demo"
