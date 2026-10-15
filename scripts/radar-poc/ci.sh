#!/usr/bin/env bash
# Uruchamiane przez .github/workflows/radar-poc.yml (GitHub Actions). Kod jednorazowy (PoC).
# 1) analiza źródeł danych, 2) obraz php:8.2-cli + gdal-bin z workerem PHP, 3) commit wyników.
set -u
OUT=docs/radar-poc
mkdir -p "$OUT"

sudo apt-get update -q
sudo apt-get install -y -q --no-install-recommends gdal-bin python3-gdal python3-numpy libtiff-tools

python3 scripts/radar-poc/analyze.py "$OUT" 2>&1 | tee "$OUT/analyze.log"
bash scripts/radar-poc/docker-check.sh "$OUT" 2>&1 | tee "$OUT/docker-check.log"

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
