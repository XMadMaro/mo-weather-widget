# MO Weather Widget — Specyfikacja Techniczna v1.0.1

## 1. Architektura

### Diagram przepływu danych
```
┌─────────────┐
│  Czytelnik  │
│ (przegląd.) │
└──────┬──────┘
       │ GET /weather-api.php?city=katowice
       ▼
┌─────────────────────────────────────┐
│         Backend Proxy (PHP)         │
│  ┌───────────────────────────────┐  │
│  │ 1. CORS check (allowlist)     │  │
│  │ 2. Rate limit + GC (30/min)   │  │
│  │ 3. Cache check (60 min TTL)   │  │
│  │ 4. Circuit Breaker (backoff)  │  │
│  └───────────────────────────────┘  │
└──────┬──────────────────┬───────────┘
       │                  │
       ▼                  ▼
┌──────────────┐    ┌──────────────┐
│ Cache świeży │    │ Open-Meteo   │
│ (< 60 min)   │    │ API (cURL/ctx)│
└──────┬───────┘    └──────┬───────┘
       │                   │
       │                   ▼
       │            ┌──────────────┐
       │            │ Zapis atom.  │
       │            │ do cache     │
       │            └──────┬───────┘
       ▼                   ▼
┌─────────────────────────────────────┐
│  JSON response (ETag + Server-Time) │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│   Frontend Web Component            │
│  ┌───────────────────────────────┐  │
│  │ 1. Fetch data                 │  │
│  │ 2. Render Shadow DOM (CLS=0)  │  │
│  │ 3. Fallback: localStorage     │  │
│  └───────────────────────────────┘  │
└──────┬──────────────────────────────┘
       │
       ▼
┌─────────────┐
│   Widget    │
│  (karta)    │
└─────────────┘
```

### Komponenty

#### Backend (`weather-api.php`)
- **Rola:** Proxy + cache + rate limiting + circuit breaker
- **Język:** PHP 8.1+ (strict_types)
- **Zależności:** Brak (funkcje wbudowane: curl z fallbackiem na stream context, json, flock)
- **Cache:** Plikowy (`../var/cache/city_{id}.json`), poza webrootem
- **Circuit Breaker:** Marker `backoff_{city}.json` (60s negative cache) zapobiega thundering herd przy awariach upstream
- **Rate limiting:** File-based token bucket, 30 req/60s per hash IP z probabilistycznym GC (1% szans na cleanup plików starszych niż 24h)
- **Nagłówki bezpieczeństwa:** `X-Content-Type-Options: nosniff`

#### Frontend (`weather-widget.js`)
- **Rola:** Web Component `<mo-weather>`
- **Język:** Vanilla JS (ES6+, zero transpilacji)
- **Zależności:** Brak (zero npm packages)
- **Izolacja:** Shadow DOM (style nie kolidują z portalem)
- **Layout Shift:** Stała rezerwacja wysokości 170px (`min-height: 170px`) na kontenerze i skeletonie (CLS = 0)
- **Dostępność (a11y):** Kontrast stopki zgodny z WCAG AA (≥ 4.5:1), karuzela agregatora z `role="region"` i `aria-label`
- **Fallback:** 3 warstwy (API → cache backend → localStorage)

---

## 2. Kontrakt API

### Request
```http
GET /weather-api.php?city={city_id} HTTP/1.1
Host: api.example.com
Origin: https://portal.example.com
```

**Parametry:**
| Nazwa  | Typ    | Wymagany | Opis                                      |
|--------|--------|----------|-------------------------------------------|
| `city` | string | TAK      | ID miasta z allowlisty: `katowice`, `gliwice`, `sosnowiec`, `bytom`, `zabrze` |

### Response (200 OK)
```http
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
X-Content-Type-Options: nosniff
ETag: "9f83c1b..."
Server-Time: 1728003600
Access-Control-Allow-Origin: https://portal.example.com
```
```json
{
  "city": "katowice",
  "label": "Katowice",
  "temperature": 12,
  "weather_code": 61,
  "wind_speed": 14,
  "temp_max": 15,
  "temp_min": 7,
  "fetched_at": 1728000000,
  "last_updated_timestamp": 1728000000,
  "source": "open-meteo icon_seamless",
  "attribution": "Dane pogodowe: Open-Meteo.com (CC-BY 4.0)",
  "is_stale": false,
  "cache": "live"
}
```

**Pola:**
| Pole                     | Typ    | Opis                                                                 |
|--------------------------|--------|----------------------------------------------------------------------|
| `city`                   | string | ID miasta (slug)                                                     |
| `label`                  | string | Nazwa miasta (do wyświetlenia)                                       |
| `temperature`            | int    | Aktualna temperatura (°C, zaokrąglona)                               |
| `weather_code`           | int    | Kod pogody WMO (0-99)                                                |
| `wind_speed`             | int    | Prędkość wiatru (km/h, zaokrąglona)                                  |
| `temp_max`               | int    | Maksymalna temperatura dnia (°C)                                     |
| `temp_min`               | int    | Minimalna temperatura dnia (°C)                                      |
| `fetched_at`             | int    | Timestamp (Unix) pobrania danych z Open-Meteo                        |
| `last_updated_timestamp` | int    | Timestamp ostatniej aktualizacji (alias `fetched_at`)                |
| `source`                 | string | Źródło danych (np. "open-meteo icon_seamless")                       |
| `attribution`            | string | Atrybucja licencyjna (wymóg CC-BY 4.0)                               |
| `is_stale`               | bool   | `true` jeśli dane z cache >60 min (API padło), `false` jeśli świeże  |
| `cache`                  | string | Stan cache: `fresh` (<60 min), `live` (odświeżony), `stale` (awaria) |

> **Uwaga dot. ETag i `server_time`**: Dynamiczny `server_time` serwowany jest w nagłówku HTTP `Server-Time`, a nie w ciele JSON. Dzięki temu treść JSON jest w 100% deterministyczna, a nagłówek `ETag` pozwala na poprawne zwracanie odpowiedzi `304 Not Modified`.

### Response (400 Bad Request)
```json
{
  "error": "unknown city",
  "available": ["katowice", "gliwice", "sosnowiec", "bytom", "zabrze"]
}
```

### Response (403 Forbidden)
```json
{
  "error": "origin not allowed"
}
```

### Response (429 Too Many Requests)
```json
{
  "error": "rate limited",
  "retry_after_seconds": 45
}
```
**Nagłówek:** `Retry-After: 45`

### Response (503 Service Unavailable)
```json
{
  "error": "weather unavailable",
  "retry_after_seconds": 300
}
```
**Nagłówek:** `Retry-After: 300`

---

## 3. Model bezpieczeństwa

### CORS (Cross-Origin Resource Sharing)
- **Allowlist:** Tylko domeny z `MO_ALLOWED_ORIGINS` (dopasowanie po granicy kropki)
- **Środowisko developerskie:** Dopuszczenie `localhost` i `127.0.0.1` przy `APP_ENV=development`
- **Nagłówki:** `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods: GET, HEAD, OPTIONS`
- **Preflight:** `OPTIONS` zwraca `204 No Content`

### Rate limiting
- **Limit:** 30 requestów na 60 sekund per hash IP
- **Implementacja:** File-based token bucket (`../var/cache/rl_{hash}.json`)
- **Garbage Collection (GC):** Probabilistyczne czyszczenie (1% requestów) usuwa pliki `rl_*.json` starsze niż 24h, zapobiegając wyczerpaniu inodów na dysku
- **Fail-open:** Błąd FS nie blokuje requestu (log warning)

### Circuit Breaker & Thundering Herd
- **Problem:** Awaria API Open-Meteo blokuje procesy PHP na czas timeoutu (8s). Przy setkach jednoczesnych żądań powoduje to wyczerpanie workerów PHP-FPM.
- **Rozwiązanie:** Marker `../var/cache/backoff_{city}.json` z 60-sekundowym TTL (negative cache). Przy awarii kolejne requesty natychmiast serwują stary cache bez odpytywania zewnętrznego API.

### Sanitization (Frontend)
- **Zasada:** Dane z API wstrzykiwane **wyłącznie przez `textContent`** (zero `innerHTML` z payloadu)
- **Ikony SVG:** Statyczne, hardcoded (nie pochodzą z API)

### Cache security
- **Lokalizacja:** `../var/cache` (poza webrootem)
- **Ochrona:** `.htaccess: Require all denied` (Apache) / `deny all` (nginx)
- **Zapis atomowy:** `tmp` + `rename()` (brak uszkodzonych odczytów)
- **Nagłówek:** `X-Content-Type-Options: nosniff`

---

## 4. Wymagania techniczne

### Backend
- **PHP:** 8.1+ (strict_types, str_ends_with)
- **Rozszerzenia:** `json` (wymagane), `curl` (zalecane, z automatycznym fallbackiem na `file_get_contents` ze stream context i timeoutem 8s przy braku `ext-curl`)
- **Uprawnienia FS:** write do `../var/cache` (lub fallback `.cache`)
- **Web server:** Apache (z .htaccess) / nginx (z location block)

### Frontend
- **Przeglądarka:** Chrome 67+, Firefox 63+, Safari 11+, Edge 79+ (Custom Elements v1)
- **JavaScript:** ES6+ (brak transpilacji, działa natywnie)
- **localStorage:** wymagany dla fallbacku (graceful degradation bez niego)

### Sieć
- **CSP (Content Security Policy):**
  ```
  connect-src https://api.TWOJA-DOMENA;
  script-src https://cdn.TWOJA-DOMENA;
  ```
- **Brak wymogu:** `img-src` (ikony to inline SVG), `unsafe-inline`

---

## 5. Wdrożenie

### Krok 1: Backend
1. Skopiuj `dist/weather-api.php` do webroota (np. `public_html/weather-api.php`)
2. Utwórz katalog cache: `mkdir -p ../var/cache && chmod 775 ../var/cache`
3. Uzupełnij `MO_ALLOWED_ORIGINS` o domeny produkcyjne
4. Test: `curl -i "https://api.TWOJA-DOMENA/weather-api.php?city=katowice"`

### Krok 2: Frontend
1. Hostuj `dist/weather-widget.min.js` na CDN (własny / jsDelivr / unpkg)
2. Wklej w szablonie portalu:
   ```html
   <script src="https://cdn.TWOJA-DOMENA/weather-widget.min.js?v=1.0.1" defer></script>
   <mo-weather mode="single" city-id="katowice"
               api-url="https://api.TWOJA-DOMENA/weather-api.php"></mo-weather>
   ```
3. Theming przez CSS variables (opcjonalne):
   ```css
   mo-weather {
     --mo-card: #ffffff;
     --mo-text: #1a1a1a;
     --mo-accent: #0b63ce;
   }
   ```

---

## 6. Testy

### Backend (curl)
```bash
# Świeże dane
curl -i "https://api.example.com/weather-api.php?city=katowice"
# Oczekiwane: 200 OK, is_stale: false

# Nieznane miasto
curl -i "https://api.example.com/weather-api.php?city=warszawa"
# Oczekiwane: 400 Bad Request

# CORS (dozwolona domena)
curl -i -H "Origin: https://news.slazag.pl" "https://api.example.com/weather-api.php?city=katowice"
# Oczekiwane: 200 OK, nagłówek Access-Control-Allow-Origin

# CORS (niedozwolona domena)
curl -i -H "Origin: https://zlyslazag.pl" "https://api.example.com/weather-api.php?city=katowice"
# Oczekiwane: 403 Forbidden

# Rate limit (seria 35 requestów)
for i in {1..35}; do curl -s "https://api.example.com/weather-api.php?city=katowice"; done
# Oczekiwane: pierwsze 30 → 200, kolejne → 429 Too Many Requests
```

### Frontend (manualne)
1. Otwórz `examples/demo.html?mock=1` w przeglądarce
2. Przełącz stany: Świeże → Stale (badge) → Down (localStorage fallback)
3. Sprawdź responsywność (mobile-first, scroll-snap w aggregatorze)
4. Sprawdź theming (`.dark` class zmienia kolory przez CSS vars)
5. DevTools → Network: zero requestów poza `api-url`
6. DevTools → Console: zero błędów

### Lighthouse
- Uruchom Lighthouse mobile na stronie z widgetem
- **Kryterium:** CLS nie wzrasta po załadowaniu (skeleton zachowuje miejsce)

---

## 7. Maintenance

### Aktualizacje
- **Semver:** Zmiany API tylko additive (nowe pola, brak breaking changes)
- **Wersjonowanie plików:** Query string `?v=1.0.1` (cache busting)
- **Changelog:** Plik `CHANGELOG.md` w repo

### Monitoring
- **Backend:** Log PHP (błędy API, rate limit hits)
- **Frontend:** Brak telemetrii (privacy-first), błędy widoczne w konsoli DevTools

### Wsparcie
- **Issues:** GitHub Issues w repo
- **Security:** Responsible disclosure przez GitHub Security Advisories

---

## 8. Licencja

- **Kod widgetu:** MIT License (swobodne użycie komercyjne)
- **Dane pogodowe:** Open-Meteo CC-BY 4.0 (wymagana atrybucja w stopce widgetu)
- **Ikony SVG:** Public domain (inline, brak zewnętrznych zależności)
