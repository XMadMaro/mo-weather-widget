# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.1] - 2026-10-06

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
