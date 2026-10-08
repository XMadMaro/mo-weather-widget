# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.1.0] - 2026-10-08

### Added
- **Tryby osadzenia widgetu (`mode="sidebar"` i `mode="floating"`)**:
  - `mode="sidebar"`: kompaktowy układ pionowy (max-width: 320 px) zoptymalizowany dla kolumny bocznej portali (np. slazag.pl), scroll-snap prognozy 7 dni i opcjonalny atrybut `sticky` (`position: sticky; top: 12px`).
  - `mode="floating"`: pływający przycisk (bubble 56 px) w rogu ekranu (`position="bottom-right"` lub `"bottom-left"`), rozwijający pełny modal 360 px, zapamiętujący stan w `localStorage` (`mo-weather:v2:floating-open`), pełne wsparcie a11y (`role="dialog"`, `aria-controls`, `aria-expanded`, zamknięcie klawiszem `Esc` z przywróceniem fokusu na przycisk) oraz zerowy CLS.
  - Kompatybilność wsteczna: brak atrybutu `mode` lub `mode="single"` zachowuje dotychczasowy układ inline.
- **Makieta portalu w stylu slazag.pl w `public/index.html`**:
  - Wierna makieta układu portalu regionalnego (ciemny nagłówek z żółtym akcentem, nawigacja, leady artykułów, sidebar 300 px) z żywym komponentem `<mo-weather>`.
  - Dynamiczny przełącznik trybów nad makietą (`Sidebar` / `Inline` / `Floating`) natychmiastowo przełączający tryb widgetu.
- **Generator kodu osadzenia**:
  - Interaktywny konfigurator z wyborem trybu (`Inline`, `Sidebar`, `Floating`), miasta (14 miast z `src/cities.php`) oraz bazowego adresu API (autouzupełniany z `location.origin`).
  - Jednoklikowe kopiowanie snippetu do schowka (`navigator.clipboard` z fallbackiem).
- **Konteneryzacja i konfiguracja Railway**:
  - Dedykowany `Dockerfile` oparty o `php:8.2-cli` uruchamiający wbudowany serwer `php -S 0.0.0.0:$PORT -t public router.php` bez konieczności instalowania Node/Composer w środowisku produkcyjnym.
  - Zaktualizowano `railway.json` do buildera `DOCKERFILE`.
- **Dokumentacja i testy**:
  - Rozszerzono `docs/INTEGRATION.md` o sekcję 7 ze szczegółowym przewodnikiem wdrożenia w Craft CMS / Twig na portalu slazag.pl (skrypt na własnej domenie, zero CORS).
  - Dodano testy jednostkowe 16, 17, 18 w `tests/widget.test.js` pokrywające `mode="sidebar"`, `mode="floating"` i kompatybilność wsteczną.

## [2.0.0] - 2026-10-07

### Added
- **MET Norway Migration**: Fully migrated weather forecast provider from Open-Meteo to MET Norway `locationforecast/2.0/compact` under Creative Commons Attribution 4.0 (CC BY 4.0), providing 100% commercially legal and free coverage (0 PLN API fees).
- **Expanded Coverage (14 Cities)**: Full metropolis support configured in `src/cities.php`: Katowice, Gliwice, Sosnowiec, Zabrze, Tychy, Dąbrowa Górnicza, Bytom, Chorzów, Świętochłowice, Ruda Śląska, Piekary Śląskie, Tarnowskie Góry, Knurów, and Będzin.
- **Air Quality Module (`type=air`)**:
  - Live sensor measurements via GIOŚ PJP API for 6 cities (PM10 across all 6; PM2,5 verified exclusively in Katowice; AQI index categories).
  - Automatic fallback to 3-day PM10 forecast from IOŚ-PIB API for 8 cities lacking active GIOŚ stations.
  - Clear source attribution badges distinguishing GIOŚ station measurements from IOŚ-PIB municipal/county forecasts.
  - Exclusion of manual non-automated GIOŚ stations (Dąbrowa Górnicza sensor 5287, Zabrze 29679, Gliwice 5314) and silent fallback when PM2,5 is unavailable (renders "b.d." instead of false "0").
- **7-Day Forecast Module (`type=daily7`)**: Localized 7-day outlook aggregated from MET Norway hourly timeseries with daily temperature ranges, rainfall sums, and WMO/MET weather symbols.
- **Rain Nowcast Module (`type=nowcast`)**: Real-time precipitation information for the upcoming hour based on MET Norway precipitation data (`role="status"`, `aria-live="polite"`), labeled strictly as informational (respecting IMGW warning authority).
- **Health Check Endpoint (`type=health`)**: Status inspection endpoint reporting module health and city inventory for automated monitoring.
- **Diagnostics & Monitoring Tools**:
  - `scripts/check-cities.php` CLI utility supporting `--self-test`, `--fixtures`, `--city`, `--format=json`, and `--record`.
  - `scripts/check-cities-test.mjs` running 21 offline regression and validation assertions.
  - GitHub Actions CI workflow in `.github/workflows/ci.yml` validating PHP linting, tests, build, and dist synchronization.
- **Single-Flight Cache Concurrency**: File-based `.lock` with `flock` preventing redundant upstream requests during cache misses under high traffic.

### Changed
- **Rate Limiting Model**: Rate limiter counts only upstream cache misses; cache hits are free and do not increment the token bucket counter.
- **Storage Isolation**: Client-side storage keys updated to `mo-weather:v2:{city}:{type}` to prevent cross-module key collisions.
- **Web Component Modules**: Added `modules` attribute (`modules="current,air,daily7,nowcast"`) with default fallback to `current` ensuring 100% backward compatibility with v1.0.x embeds.

### Fixed
- Handled recent null values in GIOŚ measurement streams by selecting the latest non-empty timestamp.
- Added automatic wind speed conversion from MET Norway m/s to km/h (`* 3.6`).
- Fixed IOŚ-PIB SSL verification for Polish public administration internal CA certificates.


### Fixed
- **Circuit Breaker (Negative Cache)**: Added 60s backoff file marker (`backoff_{city}.json`) upon upstream Open-Meteo failure. Prevents thundering herd stalls (8s timeouts) under high concurrent load by instantly serving stale cache without retrying dead upstream.
- **Rate Limiter GC**: Added probabilistic garbage collection (1% execution frequency per request) purging IP rate limit tracking files (`rl_*.json`) older than 24 hours to prevent inode exhaustion on shared hostings.
- **CLS (Cumulative Layout Shift)**: Adjusted skeleton `.skel` height and `.wrap` container min-height to `170px` (measured rendered card height), eliminating 45-75px content layout shifts during hydration.
- **Deterministic ETag & 304 Caching**: Extracted dynamic `server_time` from JSON body into dedicated `Server-Time` HTTP header. Allows upstream cache payloads to produce static MD5 ETags and restores operational `304 Not Modified` browser caching.
- **ext-curl Extension Guard**: Wrapped cURL calls with `function_exists('curl_init')` check and added fallback to `file_get_contents()` using stream context and 8-second timeout.
- **Documentation Parity**: Corrected Craft CMS integration snippets in `docs/INTEGRATION.md` to use valid `alias('@web')` syntax instead of deprecated config keys.
- **Security Headers**: Added `X-Content-Type-Options: nosniff` header to all API responses to prevent MIME-sniffing attacks.
- **WCAG AA Color Contrast**: Adjusted footer attribution text and link color (`--mo-foot`, `#595959`) to achieve 7.15:1 contrast ratio against white card background (exceeding WCAG AA 4.5:1 requirement). Added link text underline for accessibility.
- **Aggregator Carousel Accessibility**: Added `role="region"`, `aria-label="Prognoza pogody dla wybranych miast"`, and `tabindex="0"` to aggregator scroll container for keyboard and screen reader accessibility.
- **Reproducible Build Pipeline**: Pinned `terser` to exact version `5.39.0` with `--comments '/^!/'` banner preservation in `scripts/build.sh` and added automated test suite (`tests/widget.test.js`, `scripts/test-api.sh`).

### Added
- **Web Component `<mo-weather>`**:
  - Shadow DOM encapsulation for 100% CSS isolation.
  - Inline vector SVG weather icons (zero external HTTP icon requests).
  - Two display modes: `single` (single city card) and `aggregator` (touch-friendly scroll-snap carousel).
  - Theming system controlled by host CSS variables (`--mo-card`, `--mo-text`, `--mo-muted`, `--mo-border`, `--mo-accent`, `--mo-radius`, `--mo-font`).
  - Skeleton loading animation with fixed dimensions (96px height) ensuring Cumulative Layout Shift (CLS) is zero.
  - Three-tier offline fallback: live API -> stale backend cache -> `localStorage` mirror (`mo-weather:v1:*`).
  - Relative time ticker badge for stale data (`Ostatnia aktualizacja: X min temu`).
  - Strict XSS protection: API payloads injected solely via `textContent`.
  - Timer cleanup on disconnect to eliminate interval memory leaks.
- **Backend Proxy `weather-api.php`**:
  - PHP 8.1+ strict types implementation without third-party dependencies.
  - Hardened city routing allowlist (`katowice`, `gliwice`, `sosnowiec`, `bytom`, `zabrze`).
  - Multi-tier file cache with atomic write (PID temporary file + rename) and shared read flock outside webroot (`../var/cache`).
  - Granular dot-boundary CORS matching with conditional `APP_ENV=development` localhost/127.0.0.1 support.
  - IP-hashed token bucket rate limiting (30 requests per 60 seconds with `Retry-After` header).
  - Graceful degradation: serves stale cache on upstream Open-Meteo failure with `is_stale: true`.
  - HTTP ETag and 304 Not Modified header support.
- **Documentation & Examples**:
  - Technical specification (`docs/SPEC.md`).
  - CMS integration guides for WordPress, Drupal, Next.js, Hugo, Craft CMS (`docs/INTEGRATION.md`).
  - Security model and disclosure policy (`docs/SECURITY.md`).
  - Operations and maintenance guide (`docs/MAINTENANCE.md`).
  - Interactive multi-state test demo (`examples/demo.html`).
