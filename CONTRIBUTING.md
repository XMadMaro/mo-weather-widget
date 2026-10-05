# Contributing to mo-weather-widget

Thank you for your interest in contributing to `mo-weather-widget`! This project provides an ultra-lightweight, zero-dependency weather Web Component and PHP proxy for regional news portals.

## Guiding Principles

1. **Zero External Runtime Dependencies**: Both frontend and backend must run purely on standard Web APIs and PHP 8.1+ built-in modules.
2. **Zero Layout Shift (CLS = 0)**: Any visual modification must preserve strict dimension stability.
3. **Defense in Depth**: No user or external API string may ever reach `innerHTML`. Always use `textContent`.
4. **Graceful Degradation**: If an upstream service or network connection fails, the widget must never break layout or throw unhandled exceptions.

## Development Workflow

1. Clone repository:
   ```bash
   git clone https://github.com/mediaoperator/mo-weather-widget.git
   cd mo-weather-widget
   ```
2. Install build tooling:
   ```bash
   npm install
   ```
3. Run local development server:
   ```bash
   APP_ENV=development php -S 127.0.0.1:8080 -t src/
   ```
4. Build distribution bundle:
   ```bash
   npm run build
   ```
5. Run automated verification:
   ```bash
   npm test
   bash scripts/test-api.sh
   ```

## Pull Request Guidelines

- Ensure `scripts/build.sh` runs cleanly and updates `dist/`.
- Update `CHANGELOG.md` under the `[Unreleased]` section.
- Verify that `SPEC.md` constraints remain intact.
