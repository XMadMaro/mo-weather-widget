# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Automated unit test workflow for release pipelines.

## [1.0.0] - 2026-10-05

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
