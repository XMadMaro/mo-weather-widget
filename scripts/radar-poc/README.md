# Skrypty weryfikacyjne radaru (PoC)

Narzędzie diagnostyczne i plan B z `docs/RADAR-PLAN.md` (C.7, C.9). To **nie jest kod produkcyjny**: produkcyjny producent klatek ma być w czystym PHP.

| Plik | Co robi |
|---|---|
| `analyze.py` | Sprawdza źródła danych i zapisuje wyniki do `poc-results.json`:<br>• listing S3 OPERA (świeżość, opóźnienia, luki);<br>• budowa pliku COG;<br>• pokrycie Polski i Śląska, w tym udział `nodata` i NaN wokół polskich radarów;<br>• echo z ostatnich 24 h;<br>• warstwa piorunów EUMETView, wiatr z MET Norway, ostrzeżenia IMGW. |
| `worker-poc.php` | Cykl producenta z GDAL: listing S3, potem `gdal_translate`, `gdalwarp` i `gdaldem`, na końcu PNG i `manifest.json`. |
| `docker-check.sh` | Buduje obraz `php:8.2-cli` z `gdal-bin` i uruchamia w nim `worker-poc.php`. Zapisuje wersje, rozmiar obrazu i zużycie pamięci. |
| `radar-palette.txt` | Paleta dBZ dla `gdaldem color-relief`. Linia `nan 0 0 0 0` jest obowiązkowa (C.7). |
| `ci.sh`, `radar-poc.workflow.yml` | Uruchomienie w GitHub Actions; wyniki trafiają do `docs/radar-poc/`. |

## Uruchomienie

**GitHub Actions.** Skopiuj `radar-poc.workflow.yml` do `.github/workflows/radar-poc.yml` na gałęzi z tymi skryptami. Workflow uruchamia się przy każdej zmianie w `scripts/radar-poc/`.

**Lokalnie w Dockerze**, z katalogu repozytorium:

```bash
docker run --rm -v "$PWD:/w" -w /w ghcr.io/osgeo/gdal:ubuntu-full-latest \
  python3 scripts/radar-poc/analyze.py docs/radar-poc
bash scripts/radar-poc/docker-check.sh docs/radar-poc
```
