# MO Weather Widget (v1.0.1)

> Samowystarczalny, lekki komponent pogodowy Web Component (`<mo-weather>`) z bezpiecznym proxy backendowym w PHP dla portali redakcyjnych i regionalnych.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PHP: 8.1+](https://img.shields.io/badge/PHP-8.1%2B-blue.svg)](src/weather-api.php)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![Data: CC--BY_4.0](https://img.shields.io/badge/Data-Open--Meteo%20(CC--BY%204.0)-orange.svg)](https://open-meteo.com/)

---

## Główne Cechy

- **Zero zewnętrznych zależności** — czysty Vanilla JavaScript (Shadow DOM v1) i PHP 8.1+ (brak bibliotek npm i composera w runtime).
- **100% izolacja stylów (Shadow DOM)** — style widgetu nie wchodzą w kolizje z motywem portalu; pełny theming przez zmienne CSS (`--mo-*`).
- **Zero Layout Shift (CLS = 0)** — wbudowany skeleton o stałej wysokości 170px rezerwuje pełną przestrzeń karty przed załadowaniem danych.
- **Odporność na awarie (Circuit Breaker & Fallback)** — negative cache (60s backoff) chroni przed thundering herd → stary cache proxy (`is_stale: true`) → mirror w `localStorage` przeglądarki.
- **Bezpieczeństwo & RODO-free** — brak ciasteczek, brak śledzenia, sanitizacja danych wyłącznie przez `textContent`, CORS z dopasowaniem po granicy kropki, rate limit 30 req/min z probabilistycznym GC (ochrona inodów), `X-Content-Type-Options: nosniff`.
- **Dostępność (WCAG AA)** — kontrast stopki atrybucji ≥ 4.5:1 (7.15:1), karuzela agregatora oznaczona `role="region"`.
- **Uniwersalność** — działa z każdym CMS: WordPress, Drupal, Craft CMS, Next.js, Hugo, Jekyll, Astro i czysty HTML.

---

## Szybki Start

### 1. Backend (PHP Proxy)
Umieść `dist/weather-api.php` na swoim serwerze webowym (np. w `public_html/api/weather-api.php`).
Domyślny katalog cache (`../var/cache`) utworzy się automatycznie poza webrootem z regułą `.htaccess: Require all denied`.

### 2. Frontend (HTML Embed)
Wklej w szablonie strony lub bloku HTML:

```html
<!-- Skrypt widgetu (CDN lub własny serwer) -->
<script src="https://cdn.TWOJA-DOMENA/weather-widget.min.js?v=1.0.1" defer></script>

<!-- Tryb pojedynczego miasta -->
<mo-weather mode="single" city-id="katowice"
            api-url="https://api.TWOJA-DOMENA/weather-api.php"></mo-weather>

<!-- Tryb agregatora (karuzela mobile-first) -->
<mo-weather mode="aggregator" cities="katowice,gliwice,sosnowiec,bytom"
            api-url="https://api.TWOJA-DOMENA/weather-api.php"></mo-weather>
```

---

## Struktura Repozytorium

```
mo-weather-widget/
├── src/
│   ├── weather-api.php          # Kod źródłowy proxy backendu PHP
│   └── weather-widget.js        # Kod źródłowy Web Componentu (ES6+)
├── dist/
│   ├── weather-widget.min.js    # Zminifikowany skrypt produkcyjny
│   ├── weather-widget.js        # Niezminifikowany skrypt deweloperski
│   └── weather-api.php          # Gotowe proxy do wdrożenia
├── examples/
│   ├── wordpress.html           # Przykład integracji z WordPressem (Gutenberg)
│   ├── drupal.html              # Przykład integracji z Drupalem (Full HTML)
│   ├── static.html              # Przykład dla stron statycznych (Hugo/Jekyll/Astro)
│   └── demo.html                # Interaktywne środowisko testowe (?mock=1)
├── docs/
│   ├── SPEC.md                  # Pełna specyfikacja techniczna i kontrakt API
│   ├── INTEGRATION.md           # Instrukcje wdrożenia dla różnych systemów CMS
│   ├── SECURITY.md              # Model zagrożeń, CORS i polityka bezpieczeństwa
│   └── MAINTENANCE.md           # Monitoring, rotacja cache i disaster recovery
├── scripts/
│   ├── build.sh                 # Skrypt minifikacji Terser i budowy katalogu dist
│   └── test-api.sh              # Testy integracyjne PHP i weryfikacja logiki CORS
├── .github/workflows/
│   └── release.yml              # Automatyczny build i GitHub Release przy tagu v*.*.*
├── CHANGELOG.md                 # Historia zmian zgodna z Keep a Changelog
├── CONTRIBUTING.md              # Zasady rozwijania projektu open-source
├── LICENSE                      # Licencja MIT + CC-BY 4.0
└── package.json                 # Metadane i skrypty npm
```

---

## Theming (Zmienne CSS)

Wygląd karty można w pełni dostosować z poziomu arkusza stylów portalu:

```css
mo-weather {
  --mo-card: #ffffff;      /* Kolor tła karty */
  --mo-text: #1a1a1a;      /* Główny kolor tekstu */
  --mo-muted: #666666;     /* Opisy i metadane */
  --mo-border: #e5e5e5;    /* Obramowanie karty */
  --mo-accent: #0b63ce;    /* Kolor ikon pogodowych SVG */
  --mo-radius: 12px;       /* Zaokrąglenie narożników */
  --mo-font: inherit;      /* Dziedziczenie typografii portalu */
}
```

---

## Dokumentacja Szczegółowa

- 📄 [Specyfikacja Techniczna (SPEC.md)](docs/SPEC.md)
- 🔌 [Przewodnik Integracji CMS (INTEGRATION.md)](docs/INTEGRATION.md)
- 🛡️ [Polityka Bezpieczeństwa (SECURITY.md)](docs/SECURITY.md)
- 🔧 [Utrzymanie i Monitoring (MAINTENANCE.md)](docs/MAINTENANCE.md)

---

## Licencja i Źródła Danych

- **Kod widgetu:** Licencja [MIT](LICENSE). Swobodne wykorzystanie komercyjne i redakcyjne.
- **Dane pogodowe:** [Open-Meteo.com](https://open-meteo.com/) na licencji [Creative Commons Attribution 4.0 (CC-BY 4.0)](https://creativecommons.org/licenses/by/4.0/). Atrybucja jest wbudowana w stopkę widgetu i nie może być usuwana.
