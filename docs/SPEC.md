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
  "cities_count": 14
}
```

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
6. **Polityka Dostępności (WCAG 2.1 AA):**
   - Kontrast tekstów i atrybucji wynosi co najmniej 4.5:1.
   - Alerty nowcast mają semantykę `role="status"` i `aria-live="polite"`.
   - Zastosowanie `@media (prefers-reduced-motion: reduce)` dla wszystkich animacji.
