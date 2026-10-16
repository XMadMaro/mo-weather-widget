# Skrypty weryfikacyjne radaru (PoC)

PoC i narzędzia diagnostyczne z `docs/RADAR-PLAN.md` (C.7, C.9, C.10). **Kod produkcyjny jest już w `src/radar-lib.php`, `src/radar-api.php` i `scripts/radar-worker.php`.** Te skrypty zostają do diagnostyki (np. `render-frame.php --latest` na prawdziwej klatce) i danych testowych (`make-synthetic.py`).

**PoC w czystym PHP**

| Plik | Co robi |
|---|---|
| `render-frame.php` | Dekoder w czystym PHP, kandydat na `src/radar-lib.php`:<br>• czyta COG OPERA z pliku albo z URL przez HTTP Range;<br>• sprawdza format i pobiera tylko 4 kafle;<br>• przelicza piksele przez LUT (Web Mercator → LAEA);<br>• zapisuje PNG z paletą.<br>Wywołania: `--latest` bierze najnowszą klatkę z S3, `--selftest` sprawdza punkty referencyjne. |
| `render-batch.php` | Renderuje wszystkie klatki z katalogu i zapisuje `frames.json`. |
| `make-synthetic.py` | Syntetyczne klatki o budowie identycznej z OPERA (sterownik COG z GDAL). Służą do testu dekodera, **to nie są prawdziwe dane**. |
| `validate.py` | Porównuje klatkę z PHP z dokładnym przeliczeniem PROJ i z GDAL warp. |
| `e2e-browser.mjs` | Ręczny test okna radaru w Chrome: leniwe ładowanie, animacja, widoki, Esc i fokus, stany błędów, telefon, axe-core, CLS. Instrukcja w nagłówku pliku. |
| `demo/index.html` | Klikalny prototyp okna radaru: przycisk, dialog, widoki, odtwarzacz, legenda. Mapę buduje z JSON przez DOM API. |
| `compose-preview.mjs` | Statyczny podgląd okna radaru do dokumentacji (wymaga `@resvg/resvg-js` poza repo). |
| `build-demo.sh` | Odtwarza cały PoC w podanym katalogu. |
| `../gen-basemap.mjs` | Generator podkładu z granic PRG (bez zależności). Ten skrypt zostaje w produkcji. |

**Diagnostyka i plan B (GDAL)**

| Plik | Co robi |
|---|---|
| `analyze.py` | Sprawdza źródła danych i zapisuje wyniki do `poc-results.json`:<br>• listing S3 OPERA (świeżość, opóźnienia, luki);<br>• budowa pliku COG;<br>• pokrycie Polski i Śląska, w tym udział `nodata` i NaN wokół polskich radarów;<br>• echo z ostatnich 24 h;<br>• warstwa piorunów EUMETView, wiatr z MET Norway, ostrzeżenia IMGW. |
| `worker-poc.php` | Cykl producenta z GDAL: listing S3, potem `gdal_translate`, `gdalwarp` i `gdaldem`, na końcu PNG i `manifest.json`. |
| `docker-check.sh` | Buduje obraz `php:8.2-cli` z `gdal-bin` i uruchamia w nim `worker-poc.php`. Zapisuje wersje, rozmiar obrazu i zużycie pamięci. |
| `radar-palette.txt` | Paleta dBZ dla `gdaldem color-relief`. Linia `nan 0 0 0 0` jest obowiązkowa (C.7). |
| `ci.sh`, `radar-poc.workflow.yml` | Uruchomienie w GitHub Actions. Najpierw dekoder w czystym PHP przetwarza **prawdziwą** najnowszą klatkę OPERA; wynik jest porównywany z PROJ/GDAL i zapisywany jako podgląd. Potem idzie analiza źródeł i plan B. Wyniki trafiają do `docs/radar-poc/`. |

## Uruchomienie

**GitHub Actions.** Skopiuj `radar-poc.workflow.yml` do `.github/workflows/radar-poc.yml` na gałęzi z tymi skryptami. Workflow uruchamia się przy każdej zmianie w `scripts/radar-poc/`.

**Prawdziwa klatka przez dekoder w PHP** (wystarczy PHP 8.1+ z curl i zlib):

```bash
php scripts/radar-poc/render-frame.php --latest --out=frame.png
```

**PoC na danych syntetycznych:** `bash scripts/radar-poc/build-demo.sh /tmp/radar-poc-demo` (wymagania w nagłówku skryptu).

**Diagnostyka GDAL lokalnie w Dockerze**, z katalogu repozytorium:

```bash
docker run --rm -v "$PWD:/w" -w /w ghcr.io/osgeo/gdal:ubuntu-full-latest \
  python3 scripts/radar-poc/analyze.py docs/radar-poc
bash scripts/radar-poc/docker-check.sh docs/radar-poc
```
