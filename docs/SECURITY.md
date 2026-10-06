# Security Policy: MO Weather Widget

## 1. Security Architecture & Threat Model

The `mo-weather-widget` is designed to be hosted in high-traffic, sensitive editorial environments. It enforces strict boundary defenses at both frontend and backend layers:

### Open Relay Mitigation
- The proxy accepts **only** predefined city identifiers from a strict allowlist (`katowice`, `gliwice`, `sosnowiec`, `bytom`, `zabrze`).
- Arbitrary latitude/longitude parameters or external API endpoints are rejected with `400 Bad Request`.

### Cross-Origin Resource Sharing (CORS)
- Origin validation performs strict dot-boundary matching against `MO_ALLOWED_ORIGINS` (`slazag.pl`, `mediaoperator.pl`).
- Partial domain suffix spoofing (e.g. `zlyslazag.pl`) is unconditionally rejected (`403 Forbidden`).
- Development origin matching (`localhost`, `127.0.0.1`) requires explicit `APP_ENV=development`.

### Abuse, DoS & Thundering Herd Protection
- **Token Bucket Rate Limiting:** Per SHA-256 hashed client IP (`30 requests / 60 seconds`). Rate-limited requests return `429 Too Many Requests` with a compliant `Retry-After` header.
- **Probabilistic Inode Garbage Collection:** A 1% probabilistic sweep runs during requests to purge `rl_*.json` files older than 24 hours, preventing inode exhaustion attacks and filesystem degradation.
- **Circuit Breaker (Negative Caching):** When upstream Open-Meteo calls fail or timeout (8s limit), a negative cache marker (`backoff_{city}.json`) is activated for 60 seconds. High concurrent volumes (thundering herds) are served stale cache immediately without tieing up PHP-FPM execution slots.
- **Concurrency & Race Conditions:** Atomic file locking (`flock(LOCK_EX)`) and temporary file renaming prevent corruption during concurrent writes.

### HTTP Header Defenses
- `X-Content-Type-Options: nosniff` is attached to every response, preventing browsers from MIME-sniffing away from the declared `application/json` format.

### Cross-Site Scripting (XSS) Prevention
- Zero dynamic evaluation: all values retrieved from the API are injected into the DOM exclusively using `Element.textContent`.
- Weather icons are hardcoded, immutable inline SVG nodes rather than arbitrary markup parsed from the upstream payload.

### Cache Directory Isolation
- Cache storage is placed outside the webroot (`../var/cache`) by default.
- Every cache directory automatically receives a `.htaccess` file denying all direct HTTP requests (`Require all denied`).

---

## 2. Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.1   | :white_check_mark: |
| 1.0.0   | :white_check_mark: |
| < 1.0   | :x:                |

---

## 3. Reporting a Vulnerability

If you discover a security vulnerability within `mo-weather-widget`, please report it responsibly:

1. **Email:** Send details to `security@mediaoperator.pl`.
2. **Subject:** `[VULNERABILITY] mo-weather-widget - <Brief Description>`.
3. Please include reproduction steps, affected versions, and potential exploit impact.
4. Do not disclose vulnerabilities publicly in GitHub Issues until a fix has been released.

We commit to acknowledging your report within 48 hours and providing a remediation timeline within 5 business days.
