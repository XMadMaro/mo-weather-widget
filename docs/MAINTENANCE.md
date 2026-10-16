# Przewodnik Utrzymania i Monitoringu: MO Weather Widget

## 1. Monitorowanie Backend Proxy

### Logi Serwera
Backend proxy loguje błędy przez standardowy mechanizm PHP (`ini_set('log_errors', '1')`).
Należy monitorować występowanie:
- `CURL error` — awaria połączenia z `api.open-meteo.com` (timeout powyżej 8 s lub błąd DNS).
- `Retry-After / 429` — przekroczenie limitu 30 req / 60 s (możliwy atak lub błędna pętla odświeżania na portalu).
- `403 origin not allowed` — odrzucenie zapytania z niezarejestrowanej domeny lub brak konfiguracji `MO_ALLOWED_ORIGINS`.

### Rotacja i Czyszczenie Cache
- Pliki cache miast (`city_{slug}.json`) nadpisują się automatycznie atomowym rename co 60 minut.
- Pliki rate limitera (`rl_{hash}.json`) mogą być usuwane okresowo (np. raz na dobę z crona):
```bash
# Czyszczenie wpisów rate limitera starszych niż 24h
find /sciezka/do/var/cache/ -name "rl_*.json" -mtime +1 -delete
```

---

## 2. Aktualizacje Komponentu (SemVer)

Projekt przestrzega zasad Semantic Versioning:
- **Patch (v1.0.x):** Poprawki błędów, optymalizacje CSS/SVG, brak zmian w interfejsie.
- **Minor (v1.x.0):** Nowe atrybuty widgetu (np. dodatkowe wskaźniki ciśnienia), nowe miasta w allowliście API.
- **Major (v2.0.0):** Zmiana kontraktu JSON lub minimalnych wymagań przeglądarek.

### Cache Busting na CDN
W szablonie CMS skrypt widgetu powinien posiadać wersjonowanie w query stringu:
```html
<script src="https://cdn.TWOJA-DOMENA/weather-widget.min.js?v=1.0.0" defer></script>
```
Przy publikacji nowej wersji należy podbić parametr `?v=1.0.1`, co natychmiast wymusza odświeżenie w przeglądarkach czytelników.

---

## 3. Procedura Awaryjna (Disaster Recovery)

Gdy API Open-Meteo jest trwale niedostępne lub wyczerpał się limit:
1. Proxy automatycznie przechodzi w tryb **Graceful Degradation** — serwuje ostatni znany stan z flagą `is_stale: true`.
2. Widget na portalu wyświetla badge *„Ostatnia aktualizacja: X min temu”*, zachowując integralność wizualną.
3. W razie potrzeby ręcznego wymuszenia danych można wgrać gotowy JSON do `var/cache/city_katowice.json`.

---

## 4. Radar burzowy (EUMETNET OPERA)

### Jak to działa
- Na Railway przy `MO_RADAR_MODE=producer` w tym samym kontenerze co API działa pętla producenta (`Dockerfile`):
  ```
  while true; do php scripts/radar-worker.php; sleep 60; done
  ```
- **Jeden przebieg producenta:**
  1. sprawdza, czy według harmonogramu OPERA powinna już być nowa klatka (publikacja ok. 4 min po czasie nominalnym);
  2. jeśli tak, listuje S3 i dorysowuje brakujące klatki z ostatniej godziny;
  3. zapisuje `manifest.json`;
  4. kasuje klatki starsze niż 2 h.
- **Pliki** leżą w `<katalog cache>/radar/` (na Railway `/tmp/mo-cache/radar/`):
  - 13–24 pliki `radar_YYYYMMDDTHHMM.png` po ok. 2–30 KB;
  - `manifest.json`;
  - `lut-*.bin` (1,9 MB, tablica przeliczeń liczona raz);
  - `worker.lock`.
- **Po deployu** dysk jest pusty: pierwsze 13 klatek powstaje w ciągu ok. 10–20 s.
- **Log:** każdy przebieg wypisuje jedną linię `[radar] …` w logach Railway, np.:
  ```
  [radar] 2026-10-16T12:11Z +20261016T1205(480 ms, 310 KB read, 28 KB png) frames=13 latest=20261016T1205 status=fresh
  ```
  Błędy idą na stderr jako `[radar] ERROR …`.

### Monitoring
`GET /api/weather?type=health` ma sekcję `radar` (opis pól: `docs/SPEC.md` §4.6).

| `status` / `error` | Co znaczy | Co zrobić |
|---|---|---|
| `fresh` | Wszystko działa. | Nic. |
| `stale` | Ostatnia klatka ma 15–60 min. Zwykle chwilowy problem z S3 albo opóźnienie OPERA. Czytelnik widzi plakietkę „Dane sprzed X min”. | Poczekać. Jeśli trwa ponad godzinę, przejść do `down`. |
| `degraded` | Ponad 20% obszaru bez pokrycia (awaria części radarów). Mapa pokazuje szare pola „brak danych”. | Nic. To stan sieci radarowej, nie błąd u nas. |
| `down` | Brak klatek albo ostatnia starsza niż 60 min. Okno pokazuje „Radar jest chwilowo niedostępny”. | Sprawdzić logi `[radar]`. Ręczny test: `php scripts/radar-worker.php` w konsoli Railway. |
| `error: upstream` | Ostatnie listowanie albo pobranie z S3 się nie udało (sieć, S3). | Zwykle mija samo. Producent ponawia co minutę. |
| `error: format_changed` | EUMETNET zmienił budowę pliku (np. kompresję albo siatkę). Producent celowo przestaje rysować, zamiast pokazywać zły obraz. | Komunikat błędu jest w `manifest.json` (`format_error`). Plan B z GDAL: `docs/RADAR-PLAN.md` C.7. |

### Wyłączenie
- **Szybko, dla czytelników:** usunąć atrybut `radar` z szablonów portali (przycisk znika).
- **Na serwerze:** usunąć `MO_RADAR_MODE` albo ustawić `off` i zrobić redeploy. `/api/radar` zwraca wtedy 404, a health `radar.status: off`.

### Test bez dostępu do S3
- Producent umie czytać pliki OPERA z dysku: `MO_CACHE_DIR=/tmp/test php scripts/radar-worker.php --src-dir=KATALOG_Z_PLIKAMI_TIFF`.
- Pliki syntetyczne o identycznej budowie generuje `scripts/radar-poc/make-synthetic.py`.
- Testy jednostkowe radaru (bez sieci): `npm run test:radar`.
