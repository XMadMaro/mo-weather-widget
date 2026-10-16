#!/usr/bin/env bash
# PoC: czy obraz produkcyjny (php:8.2-cli + gdal-bin) uruchomi workera radaru w PHP.
# Kod jednorazowy, nie produkcja.
set -u
OUT="${1:-docs/radar-poc}"
IMG=mo-radar-poc
mkdir -p "$OUT"

docker pull -q php:8.2-cli >/dev/null
printf '%s\n' \
  'FROM php:8.2-cli' \
  'RUN apt-get update && apt-get install -y --no-install-recommends gdal-bin \' \
  ' && rm -rf /var/lib/apt/lists/*' | docker build -q -t "$IMG" - >/dev/null

BASE_SIZE=$(docker image inspect php:8.2-cli --format '{{.Size}}')
GDAL_SIZE=$(docker image inspect "$IMG" --format '{{.Size}}')
OS_NAME=$(docker run --rm "$IMG" sh -c '. /etc/os-release && echo "$PRETTY_NAME"')
GDAL_VER=$(docker run --rm "$IMG" gdalinfo --version)
PHP_VER=$(docker run --rm "$IMG" php -r 'echo PHP_VERSION;')
PHP_EXT=$(docker run --rm "$IMG" php -m | tr '\n' ' ')
FORMATS=$(docker run --rm "$IMG" sh -c 'gdalinfo --formats | grep -E -i "^ *(GTiff|HDF5|PNG|VRT) " | sed -E "s/^ +//" | paste -sd ";" -')
MAXECHO_END=$(cat "$OUT/maxecho_end.txt" 2>/dev/null || true)
export BASE_SIZE GDAL_SIZE OS_NAME GDAL_VER PHP_VER PHP_EXT FORMATS MAXECHO_END

run_worker() {
  local sub="$1"; shift
  mkdir -p "$OUT/$sub"
  docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD:/app" -w /app "$IMG" \
    php scripts/radar-poc/worker-poc.php --out="$OUT/$sub" --frames=13 "$@" \
    > "$OUT/$sub/worker-summary.json" 2> "$OUT/$sub/worker-stderr.log"
  echo $?
}
RC_LATEST=$(run_worker worker-latest)
RC_MAXECHO=""
if [ -n "$MAXECHO_END" ]; then
  RC_MAXECHO=$(run_worker worker-maxecho --end="$MAXECHO_END")
fi
export RC_LATEST RC_MAXECHO

python3 - "$OUT/docker.json" <<'PY'
import json, os, sys
e = os.environ
base, gd = int(e.get("BASE_SIZE") or 0), int(e.get("GDAL_SIZE") or 0)
json.dump({
    "base_image": "php:8.2-cli",
    "os": e.get("OS_NAME"),
    "php": e.get("PHP_VER"),
    "php_modules": e.get("PHP_EXT"),
    "gdal": e.get("GDAL_VER"),
    "gdal_formats": e.get("FORMATS"),
    "base_size_mb": round(base / 1e6, 1),
    "with_gdal_size_mb": round(gd / 1e6, 1),
    "gdal_added_mb": round((gd - base) / 1e6, 1),
    "worker_latest_rc": e.get("RC_LATEST"),
    "worker_maxecho_rc": e.get("RC_MAXECHO"),
    "maxecho_end": e.get("MAXECHO_END"),
}, open(sys.argv[1], "w"), indent=2, ensure_ascii=False)
PY
cat "$OUT/docker.json"
