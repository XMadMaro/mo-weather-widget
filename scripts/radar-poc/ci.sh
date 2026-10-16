#!/usr/bin/env bash
# Uruchamiane przez .github/workflows/radar-poc.yml (GitHub Actions). Kod jednorazowy (PoC).
# 1) dekoder w czystym PHP na PRAWDZIWEJ najnowszej klatce OPERA + porównanie z PROJ/GDAL + podgląd,
# 2) analiza źródeł danych, 3) plan B: obraz php:8.2-cli + gdal-bin, 4) commit wyników na tę gałąź.
set -u
OUT=docs/radar-poc
mkdir -p "$OUT/real"

sudo apt-get update -q
sudo apt-get install -y -q --no-install-recommends gdal-bin python3-gdal python3-numpy libtiff-tools python3-venv
python3 -m venv /tmp/venv && /tmp/venv/bin/pip install -q rasterio pyproj pillow numpy
npm i --no-save --silent --prefix /tmp/node-tools @resvg/resvg-js@2

# 1. Czyste PHP na prawdziwych danych.
php -v | head -1 | tee "$OUT/real/php-version.txt"
php scripts/radar-poc/render-frame.php --latest --out="$OUT/real/frame.png" --lut-dir=/tmp \
  > "$OUT/real/render.json" 2> "$OUT/real/render.err"
SRC=$(python3 -c "import json; print(json.load(open('$OUT/real/render.json'))['src'])" 2>/dev/null || true)
if [ -n "$SRC" ]; then
  curl -sS -o /tmp/real.tiff "$SRC"
  /tmp/venv/bin/python scripts/radar-poc/validate.py /tmp/real.tiff "$OUT/real/frame.png" "$OUT/real/gdal_reference.png" \
    > "$OUT/real/validate.json"
  curl -sSL -o /tmp/powiaty.geojson https://raw.githubusercontent.com/ppatrzyk/polska-geojson/master/powiaty/powiaty-medium.geojson
  curl -sSL -o /tmp/woj.geojson https://raw.githubusercontent.com/ppatrzyk/polska-geojson/master/wojewodztwa/wojewodztwa-medium.geojson
  node scripts/gen-basemap.mjs --powiaty /tmp/powiaty.geojson --woj /tmp/woj.geojson --out /tmp/demo
  T=$(basename "$SRC" | cut -d@ -f2)
  cp "$OUT/real/frame.png" "/tmp/demo/radar_$T.png"
  node scripts/radar-poc/compose-preview.mjs /tmp/demo "radar_$T.png" "$OUT/real/preview-region.png" region katowice prawdziwe
  node scripts/radar-poc/compose-preview.mjs /tmp/demo "radar_$T.png" "$OUT/real/preview-city.png" city katowice prawdziwe
fi

# 2. Analiza źródeł danych, 3. plan B (GDAL w obrazie produkcyjnym).
python3 scripts/radar-poc/analyze.py "$OUT" 2>&1 | tee "$OUT/analyze.log"
bash scripts/radar-poc/docker-check.sh "$OUT" 2>&1 | tee "$OUT/docker-check.log"

# 4. Commit wyników.
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git add -A "$OUT"
if git diff --cached --quiet; then
  echo "nothing to commit"
  exit 0
fi
git commit -q -m "chore(radar-poc): wyniki PoC $(date -u +%Y-%m-%dT%H:%MZ) [skip ci]"
for i in 1 2 3 4 5; do
  if git pull --rebase -q origin "$GITHUB_REF_NAME" && git push -q origin "HEAD:$GITHUB_REF_NAME"; then
    exit 0
  fi
  sleep 5
done
exit 1
