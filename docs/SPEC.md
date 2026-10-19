# MO Weather Widget — Specyfikacja Techniczna v2.0.0

## 1. Architektura Systemu

### 1.1 Diagram przepływu danych
```
┌────────────────────────────────────────────────────────┐
│             Przeglądarka / Czytelnik                   │
│   <mo-weather city-id="katowice"                       │
│               modules="current,air,daily7,nowcast">    │
└───────────────────────────┬────────────────────────────┘
                            │ GET /weather-api.php?city=katowice&type={module}
                            ▼
┌────────────────────────────────────────────────────────┐
│                  Backend Proxy (PHP 8.1+)              │
│  ┌──────────────────────────────────────────────────┐  │
│  │ 1. Walidacja CORS (allowlist z granicą kropki)   │  │
│  │ 2. Walidacja miasta z src/cities.php (14 miast)  │  │
│  │ 3. Cache check (per type: current/air/daily7/...)│  │
│  │ 4. Single-flight flock (.lock) na miss           │  │
│  │ 5. Rate limit (30 req/min) — TYLKO cache misses! │  │
│  └──────────────────────────────────────────────────┘  │
└──────────────┬──────────────────┬──────────────────┬───┘
               │                  │                  │
    (current, daily7, nowcast)  (air: stacje 6)   (air: brak stacji 8)
               ▼                  ▼                  ▼
      ┌─────────────────┐ ┌───────────────┐ ┌────────────────┐
      │   MET Norway    │ │  GIOŚ PJP API │ │   IOŚ-PIB API  │
      │ locationforecast│ │ data/getData  │ │ PM10 forecast  │
      │  (CC BY 4.0)    │ │ aqindex/Index │ │ (3 dni TERYT)  │
      └────────┬────────┘ └───────┬───────┘ └────────┬───────┘
               │                  │                  │
               └──────────────────┼──────────────────┘
                                  ▼
                    ┌───────────────────────────┐
                    │ Atomowy zapis cache JSON  │
                    │   ../var/cache/{type}_*   │
                    └─────────────┬─────────────┘
                                  │
                                  ▼
      ┌────────────────────────────────────────────────────────┐
      │ Odpowiedź JSON z ETag (bez server_time w body)         │
      │ Nagłówki: X-Content-Type-Options: nosniff, Server-Time │
      └───────────────────────────┬────────────────────────────┘
                                  │
                                  ▼
      ┌────────────────────────────────────────────────────────┐
      │             Frontend Web Component (Shadow DOM)        │
      │ - Izolacja stylów CSS, motywowanie przez zmienne CSS   │
      │ - Zero innerHTML dla danych dynamicznych (textContent) │
      │ - Zero Layout Shift (CLS = 0, stałe wysokości)         │
      │ - Trzywarstwowy fallback (API → proxy cache → storage) │
      └────────────────────────────────────────────────────────┘
```

---

## 2. Źródła Danych i Licencjonowanie

Wszystkie używane API są w 100% legalne komercyjnie i bezpłatne (0 zł kosztów subskrypcji):

| Moduł | Upstream / Dostawca | Koszt | Licencja | Limity / Wymagania |
|---|---|---|---|---|
| `current`, `daily7`, `nowcast` | **MET Norway** `locationforecast/2.0/compact` | 0 zł | Creative Commons Attribution 4.0 (CC BY 4.0) | 20 req/s, unikalny User-Agent kontaktowy, współrzędne zaokrąglone do max 4 miejsc po przecinku. |
| `air` (pomiary) | **GIOŚ PJP API** `api.gios.gov.pl/pjp-api/v1/rest/` | 0 zł | Otwarte dane publiczne RP | 1500 req/min dla `data/getData` oraz `aqindex/getIndex`. Odpytywanie `station/sensors` zabronione w runtime (konfiguracja statyczna w `src/cities.php`). |
| `air` (prognoza) | **IOŚ-PIB** `api.prognozy.ios.edu.pl/v1/PM10/{TERYT}/` | 0 zł | Otwarte dane publiczne RP | Prognoza 3-dniowa stężenia PM10 dla jednostek TERYT (gminy/powiaty). |
| radar burzowy (atrybut `radar`) | **EUMETNET OPERA** CIRRUS DBZH, publiczny S3 `s3.waw3-1.cloudferro.com/openradar-24h` | 0 zł | CC BY 4.0, atrybucja „EUMETNET OPERA (CC BY 4.0), dane przetworzone” | Pobiera wyłącznie producent (`scripts/radar-worker.php`, co minutę; nowa klatka co 5 min). Z pliku 3,4 MB czyta tylko nagłówek i 4 kafle przez HTTP Range. Zapytania czytelników nie trafiają do źródła. |
| podkład mapy radaru | **PRG (GUGiK)** przez `ppatrzyk/polska-geojson` | 0 zł | dane publiczne PRG, repozytorium MIT | Zaszyty w `dist/mo-radar.min.js` (generator `scripts/gen-basemap.mjs`). |

---

## 3. Lista 14 Miast Aglomeracji (Źródło: `src/cities.php`)

| Slug | Nazwa | TERYT | Poziom | Źródło powietrza | Stacja GIOŚ | PM10 Sensor | PM2,5 Sensor |
|---|---|---|---|---|---|---|---|
| `katowice` | Katowice | 2469 | Miasto | GIOŚ pomiar | 17318 (Dudy-Gracza) | 28758 | 28759 |
| `gliwice` | Gliwice | 2466 | Miasto | GIOŚ pomiar | 809 (Mewy) | 5312 | brak (5314 manualny pominięty) |
| `sosnowiec` | Sosnowiec | 2475 | Miasto | GIOŚ pomiar | 837 (Kombajnistów) | 5480 | brak |
| `zabrze` | Zabrze | 2478 | Miasto | GIOŚ pomiar | 17880 (Curie-Skłodowskiej)| 29671 | brak (29679 manualny pominięty) |
| `tychy` | Tychy | 2477 | Miasto | GIOŚ pomiar | 841 (Tołstoja) | 5505 | brak |
| `dabrowa-gornicza`| Dąbrowa Górnicza| 2465 | Miasto | GIOŚ pomiar | 805 (1000-lecia) | 5286 | brak (5287 manualny pominięty) |
| `bytom` | Bytom | 2462 | Miasto | IOŚ prognoza | — | — | — |
| `chorzow` | Chorzów | 2463 | Miasto | IOŚ prognoza | — | — | — |
| `swietochlowice` | Świętochłowice| 2476 | Miasto | IOŚ prognoza | — | — | — |
| `ruda-slaska` | Ruda Śląska | 2472 | Miasto | IOŚ prognoza | — | — | — |
| `piekary-slaskie`| Piekary Śląskie| 2471 | Miasto | IOŚ prognoza | — | — | — |
| `tarnowskie-gory`| Tarnowskie Góry| 2413 | Powiat | IOŚ prognoza | — (stacja 839 nie raportuje) | — | — |
| `knurow` | Knurów | 2405 | Powiat | IOŚ prognoza | — (stacja 818 nie raportuje) | — | — |
| `bedzin` | Będzin | 2401 | Powiat | IOŚ prognoza | — | — | — |

---

## 4. Kontrakt API Backend Proxy (`weather-api.php`)

### 4.1 Zapytanie HTTP
```http
GET /weather-api.php?city={slug}&type={type} HTTP/1.1
Host: api.twojadomena.pl
Origin: https://slazag.pl
```

Parametry:
- `city` (string, opcjonalny tylko dla `type=health`): slug miasta z allowlisty 14 miast.
- `type` (string, opcjonalny): jeden z `current` (domyślny), `air`, `daily7`, `nowcast`, `health`.

---

### 4.2 Odpowiedź `type=current` (domyślna, kompatybilna wstecz)
```json
{
  "city": "katowice",
  "label": "Katowice",
  "temperature": 14,
  "weather_code": 2,
  "symbol_code": "partlycloudy_day",
  "wind_speed": 11,
  "temp_max": 16,
  "temp_min": 7,
  "fetched_at": 1728291600,
  "last_updated_timestamp": 1728291600,
  "source": "MET Norway locationforecast 2.0",
  "attribution": "Dane: MET Norway (CC BY 4.0)",
  "is_stale": false,
  "cache": "fresh"
}
```

---

### 4.3 Odpowiedź `type=air`
Dla miasta ze stacją GIOŚ (np. Katowice):
```json
{
  "city": "katowice",
  "label": "Katowice",
  "measurement": {
    "available": true,
    "source": "gios",
    "station_id": 17318,
    "station_name": "Katowice, ul. Kossutha",
    "measured_at": "2026-10-07 07:00:00",
    "category": "Dobry",
    "category_index": 1,
    "pollutants": {
      "pm10": {
        "value": 24.3,
        "unit": "µg/m³",
        "index": 1,
        "code": "SlKatowKossu-PM10-1g"
      },
      "pm25": {
        "value": 14.1,
        "unit": "µg/m³",
        "index": 1,
        "code": "SlKatowKossu-PM2.5-1g"
      },
      "no2": {
        "value": null,
        "unit": "µg/m³",
        "index": null
      }
    }
  },
  "forecast": {
    "source": "ios",
    "teryt": "2469",
    "label": "dla miasta Katowice",
    "days": [
      {"date": "2026-10-07", "pm10": 25.1},
      {"date": "2026-10-08", "pm10": 28.4},
      {"date": "2026-10-09", "pm10": 21.0}
    ]
  },
  "attribution": ["GIOŚ / Państwowy Monitoring Środowiska", "IOŚ-PIB"],
  "is_stale": false,
  "cache": "fresh"
}
```

Dla miasta bez stacji GIOŚ (np. Bytom):
```json
{
  "city": "bytom",
  "label": "Bytom",
  "measurement": {
    "available": false,
    "source": "ios",
    "note": "Brak aktywnej stacji GIOŚ — prezentowana prognoza IOŚ-PIB"
  },
  "forecast": {
    "source": "ios",
    "teryt": "2462",
    "label": "dla miasta Bytom",
    "days": [
      {"date": "2026-10-07", "pm10": 28.5},
      {"date": "2026-10-08", "pm10": 31.2},
      {"date": "2026-10-09", "pm10": 24.0}
    ]
  },
  "attribution": ["Prognoza jakości powietrza: IOŚ-PIB"],
  "is_stale": false,
  "cache": "fresh"
}
```

---

### 4.4 Odpowiedź `type=daily7`
```json
{
  "city": "katowice",
  "days": [
    {
      "date": "2026-10-07",
      "weekday_label": "Śr",
      "temp_max": 16,
      "temp_min": 8,
      "precipitation_mm": 0.2,
      "wind_speed_max": 14,
      "symbol_code": "partlycloudy_day",
      "weather_code": 2,
      "label_text": "Częściowe zachmurzenie"
    },
    {
      "date": "2026-10-08",
      "weekday_label": "Cz",
      "temp_max": 15,
      "temp_min": 7,
      "precipitation_mm": 1.4,
      "wind_speed_max": 18,
      "symbol_code": "rain",
      "weather_code": 61,
      "label_text": "Deszcz"
    }
  ],
  "attribution": "Dane: MET Norway (CC BY 4.0)",
  "is_stale": false,
  "cache": "fresh"
}
```

---

### 4.5 Odpowiedź `type=nowcast` (Alert opadowy)
```json
{
  "city": "katowice",
  "alert": {
    "active": true,
    "kind": "starting",
    "eta_iso": "2026-10-07T14:00:00Z",
    "eta_local": "16:00",
    "minutes": 45,
    "text": "Deszcz spodziewany około 16:00"
  },
  "series": [
    {"t": "2026-10-07T14:00:00Z", "mm": 0.4}
  ],
  "source": "MET Norway",
  "disclaimer": "Informacja o opadach, nie oficjalne ostrzeżenie meteorologiczne",
  "is_stale": false,
  "cache": "fresh"
}
```

---

### 4.6 Odpowiedź `type=health`
```json
{
  "ok": true,
  "version": "2.0.0",
  "modules": {
    "current": "fresh",
    "air": "fresh",
    "daily7": "fresh",
    "nowcast": "fresh"
  },
  "cities_count": 14,
  "radar": {
    "mode": "producer",
    "status": "fresh",
    "latest": "20261016T1205",
    "age_min": 7,
    "frames": 13,
    "nodata_pct": 0,
    "error": null
  }
}
```

**Sekcja `radar`:**
- Bez `MO_RADAR_MODE=producer` albo bez pliku `src/radar-lib.php` (portale z lokalną kopią proxy) zawiera tylko `{"mode": "off", "status": "off"}`.
- `status` liczony jest z wieku ostatniej klatki:
  - `fresh`: do 15 min;
  - `stale`: do 60 min;
  - `down`: starsza albo brak klatek;
  - `degraded`: świeża, ale ponad 20% obszaru bez pokrycia radarów.
- `error` przyjmuje wartości:
  - `null`;
  - `upstream`: ostatnie listowanie albo pobranie z S3 się nie udało;
  - `format_changed`: plik OPERA ma inną budowę niż obsługiwana. Klatki nie powstają, stare zostają do wygaśnięcia.

### 4.7 Endpoint radaru `/api/radar` (`src/radar-api.php`)

Endpoint tylko serwuje pliki przygotowane przez producenta, więc zapytania czytelników nie trafiają do źródła danych. Gdy `MO_RADAR_MODE` nie jest ustawione na `producer`, endpoint zwraca `404 {"status": "off"}`.

**`GET /api/radar?manifest`**
- Nagłówki:
  - `Cache-Control: public, max-age=60`;
  - `ETag` (md5 treści), obsługa `304`;
  - `Server-Time`.
- Treść:
```json
{
  "status": "fresh",
  "latest": "20261016T1205",
  "generated": "2026-10-16T12:11:02Z",
  "step_seconds": 300,
  "frames": [{"t": "20261016T1105"}, {"t": "20261016T1110"}, {"t": "20261016T1205"}],
  "bbox_ll": [16.8, 48.9, 21.2, 51.6],
  "size": [704, 676],
  "nodata_pct": 0,
  "attribution": "Radar: EUMETNET OPERA (CC BY 4.0), dane przetworzone"
}
```
- Pola:
  - `frames`: od najstarszej do najnowszej, maksymalnie 13 (1 h co 5 min);
  - `t`: czas nominalny klatki w UTC;
  - `status`: jak w §4.6.
- Brak manifestu daje odpowiedź `200` ze `status: "down"` i pustą listą.

**`GET /api/radar?frame=YYYYMMDDTHHMM`**
- Odpowiedź: PNG z paletą, 704×676 px, EPSG:3857, bbox identyczny z podkładem mapy.
- Nagłówki: `Cache-Control: public, max-age=86400, immutable`, `ETag`, `304`; dla `HEAD` bez treści.
- Warunki: `t` musi pasować do `^\d{8}T\d{4}$`, być prawdziwą datą i mieć plik w katalogu radaru. W przeciwnym razie `404`.
- Paleta PNG:
  - 0: przezroczysty (brak echa, < 10 dBZ);
  - 1: szary półprzezroczysty (poza zasięgiem radarów);
  - 2–12: klasy co 5 dBZ od 10 dBZ;
  - 13: ≥ 65 dBZ.

Metody: `GET`, `HEAD`, `OPTIONS` (204). CORS z tej samej allowlisty co `weather-api.php`.

**Okno radaru po stronie przeglądarki (`src/mo-radar.js` + `src/mo-radar-map.js`)**

- Klatki PNG są w Web Mercatorze (EPSG:3857) na tym samym bbox co kafelki mapy, więc warstwa opadów nakłada się na mapę co do piksela — bez przeliczania w przeglądarce.
- Oś czasu: pomiar wstecz (`spanMin` = 60 min) + prognoza ruchu (`FORECAST_MIN` = 30 min), krok **1 min**; klatki 5-minutowe są interpolowane (mieszanie z kompensacją ruchu wyliczoną przez korelację kolejnych klatek, z doprecyzowaniem sub-pikselowym).
- Prognoza: ostatnia klatka przesunięta o wektor ruchu z ostatnich 5 min, z natężeniem gasnącym wg `decayAlpha()`; w UI oznaczona plakietką „PROGNOZA” i przerywaną częścią osi czasu.
- Dwa widoki: „Województwo” (cały bbox pokrycia) oraz „Miasto” — centrum na mieście z atrybutu `city-id` (pozycja z `src/cities.php`), zoom 12.
- Podkład: kafelki CARTO Voyager → OSM (fallback) → własny podkład wektorowy (granice powiatów z PRG/GUGiK), gdy sieć na kafelki jest zablokowana.
- Bez dostępu do pikseli klatki (brak CORS) mapa i animacja działają, ale prognoza ruchu i „wyczyszczenie” szarego obszaru bez pokrycia są wyłączone.

---

## 5. Standardy Bezpieczeństwa i Ochrony Wydajności

1. **Izolacja DOM i XSS Protection:**
   - Wszystkie wartości pochodzące z API są przypisywane wyłącznie przez `element.textContent = ...`.
   - Wstrzykiwanie przez `innerHTML` dozwolone jest wyłącznie dla statycznych, hardcodowanych szablonów SVG.
2. **Deterministic ETag:**
   - Timestamp serwera wysyłany jest w nagłówku `Server-Time`, dzięki czemu ciało JSON jest deterministyczne. Odpowiedzi obsługują `If-None-Match` i kod `304 Not Modified`.
3. **Single-flight i blokowanie flock:**
   - Współbieżne żądania nie odpytują równolegle zewnętrznych API. Pierwszy wątek blokuje plik `.lock`, pozostałe czekają i natychmiast czytają świeżo wygenerowany cache.
4. **Rate Limiting chroniący przed atakami:**
   - Licznik 30 req/minutę nalicza wyłącznie **cache-missy**. Zapytania trafiające w świeży cache (`cache: fresh`) nie obciążają limitu użytkownika.
   - Probabilistyczne Garbage Collection (1% szans) oczyszcza pliki śledzące IP starsze niż 24h.
5. **Circuit Breaker:**
   - Błąd zewnętrznego upstreamu generuje 60-sekundowy plik markera `backoff_{city}_{type}.json`. W czasie awarii proxy natychmiast serwuje stary cache (`is_stale: true`) bez czekania na timeout.
6. **Radar (`/api/radar`):**
   - Klient przekazuje wyłącznie znacznik czasu klatki, walidowany wyrażeniem i poprawnością daty. Plik musi istnieć w katalogu radaru, więc ścieżek nie da się podstawić.
   - Bez rate limitu: odpowiedzi to statyczne pliki z dysku (jedno otwarcie mapy to 14 zapytań), a źródło odpytuje tylko producent.
   - Producent łączy się wyłącznie ze stałym adresem S3 po HTTPS, bez przekierowań. Pilnuje limitu rozmiaru kafla (4 MB) i sprawdza budowę pliku przy każdej klatce: nieznany format to błąd `format_changed`, a nie źle narysowany obraz.
   - Okno radaru (`mo-radar.js`) buduje DOM przez `textContent` i `createElementNS`, bez parsowania HTML.
7. **Polityka Dostępności (WCAG 2.1 AA):**
   - Kontrast tekstów i atrybucji wynosi co najmniej 4.5:1.
   - Alerty nowcast mają semantykę `role="status"` i `aria-live="polite"`.
   - Zastosowanie `@media (prefers-reduced-motion: reduce)` dla wszystkich animacji.
