# MO Weather Widget (v2.0.0)

> Lekki, modułowy komponent pogodowy Web Component (`<mo-weather>`) z bezpiecznym proxy backendowym w PHP 8.1+ dla grupy 12 portali regionalnych Media Operator (m.in. slazag.pl, 24kato.pl, bytomski.pl, glivice.pl, chorzowski.pl, tarnowskiegory.info, piekary.info, ngs24.pl, rudzianin.pl, zabrze-news, nowinytyskie.pl, 24zaglebie.pl).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![PHP: 8.1+](https://img.shields.io/badge/PHP-8.1%2B-blue.svg)](src/weather-api.php)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![Data: MET Norway](https://img.shields.io/badge/Data-MET%20Norway%20(CC%20BY%204.0)-brightgreen.svg)](https://api.met.no/)
[![Air: GIOŚ + IOŚ-PIB](https://img.shields.io/badge/Air-GIOŚ%20%2B%20IOŚ--PIB-blue.svg)](https://powietrze.gios.gov.pl/)

---

## Główne Cechy v2.0

- **100% Legalne Komercyjnie i Darmowe (0 zł opłat API)** — pełna migracja z Open-Meteo na **MET Norway** (`locationforecast/2.0/compact`, licencja CC BY 4.0).
- **Zasięg 14 Miast Aglomeracji Śląsko-Zagłębiowskiej** — Katowice, Gliwice, Sosnowiec, Zabrze, Tychy, Dąbrowa Górnicza, Bytom, Chorzów, Świętochłowice, Ruda Śląska, Piekary Śląskie, Tarnowskie Góry, Knurów, Będzin.
- **Jakość Powietrza (GIOŚ + IOŚ-PIB)**:
  - 6 miast z aktywnymi automatycznymi stacjami GIOŚ: pobieranie stężeń PM10 (oraz PM2,5 w Katowicach) i indeksu AQI.
  - 8 miast bez stacji GIOŚ: 3-dniowa prognoza stężeń PM10 z modelu IOŚ-PIB z jednoznaczną etykietą źródła.
- **Modułowa Architektura Frontendowa** — atrybut `modules="current,air,daily7,nowcast"`. Brak atrybutu zachowuje 100% kompatybilność wsteczną (tylko moduł bieżący `current`).
- **Alert Deszczowy Nowcast** — informacja o spodziewanych opadach deszczu na najbliższe godziny z MET Norway (`role="status"`, `aria-live="polite"`).
- **Zero Zewnętrznych Zależności Runtime** — czysty Vanilla JavaScript (Shadow DOM v1) i natywny PHP 8.1+ (brak npm i composera na serwerze produkcyjnym).
- **Izolacja CSS i Dostępność (WCAG 2.1 AA)** — Shadow DOM zapobiega konfliktom ze stylami portali; kontrast tekstów i stopki ≥ 4.5:1.
- **Single-Flight Cache & Thundering Herd Protection** — współbieżne żądania nie odpytują równolegle dostawców API dzięki blokadom `flock`.
- **Zrównoważony Rate Limiting** — 30 req/minutę liczone **wyłącznie przy cache-miss**. Odpowiedzi z pamięci podręcznej są darmowe.

---

## Tabela Miast i Źródeł

| Miasto | TERYT | Poziom | Moduł powietrza | Stacja GIOŚ / Model | Sensory |
|---|---|---|---|---|---|
| Katowice | 2469 | Miasto | Pomiar GIOŚ | 17318 (Dudy-Gracza) | PM10 (28758), PM2,5 (28759) |
| Gliwice | 2466 | Miasto | Pomiar GIOŚ | 809 (Mewy) | PM10 (5312) |
| Sosnowiec | 2475 | Miasto | Pomiar GIOŚ | 837 (Kombajnistów) | PM10 (5480) |
| Zabrze | 2478 | Miasto | Pomiar GIOŚ | 17880 (Curie-Skłodowskiej)| PM10 (29671) |
| Tychy | 2477 | Miasto | Pomiar GIOŚ | 841 (Tołstoja) | PM10 (5505) |
| Dąbrowa Górnicza | 2465 | Miasto | Pomiar GIOŚ | 805 (1000-lecia) | PM10 (5286) |
| Bytom | 2462 | Miasto | Prognoza IOŚ-PIB | Model 3-dniowy | PM10 (gmina) |
| Chorzów | 2463 | Miasto | Prognoza IOŚ-PIB | Model 3-dniowy | PM10 (gmina) |
| Świętochłowice | 2476 | Miasto | Prognoza IOŚ-PIB | Model 3-dniowy | PM10 (gmina) |
| Ruda Śląska | 2472 | Miasto | Prognoza IOŚ-PIB | Model 3-dniowy | PM10 (gmina) |
| Piekary Śląskie | 2471 | Miasto | Prognoza IOŚ-PIB | Model 3-dniowy | PM10 (gmina) |
| Tarnowskie Góry | 2413 | Powiat | Prognoza IOŚ-PIB | Model 3-dniowy | PM10 (powiat) |
| Knurów | 2405 | Powiat | Prognoza IOŚ-PIB | Model 3-dniowy | PM10 (powiat gliwicki) |
| Będzin | 2401 | Powiat | Prognoza IOŚ-PIB | Model 3-dniowy | PM10 (powiat będziński) |

---

## Szybki Start

### 1. Wdrożenie Backend Proxy
Skopiuj pliki z katalogu `dist/` do katalogu dostępnego dla PHP na serwerze:
- `dist/weather-api.php`
- `dist/cities.php`

Upewnij się, że katalog `../var/cache` ma uprawnienia do zapisu dla procesu serwera webowego (`chmod 775 var/cache`).

### 2. Osadzenie Widgetu na Stronie

```html
<!-- Skrypt widgetu (CDN lub lokalny) -->
<script src="https://cdn.twojadomena.pl/weather-widget.min.js?v=2.0.0" defer></script>

<!-- Wariant 1: Bieżąca pogoda (zgodność wsteczna z v1.0.1) -->
<mo-weather mode="single" city-id="katowice" api-url="https://api.twojadomena.pl/weather-api.php"></mo-weather>

<!-- Wariant 2: Wszystkie moduły (pogoda, jakość powietrza, 7 dni, alert opadów) -->
<mo-weather mode="single" city-id="katowice"
            modules="current,air,daily7,nowcast"
            api-url="https://api.twojadomena.pl/weather-api.php"></mo-weather>

<!-- Wariant 3: Karuzela agregatora wielu miast -->
<mo-weather mode="aggregator"
            cities="katowice,gliwice,sosnowiec,bytom,zabrze"
            modules="current,air"
            api-url="https://api.twojadomena.pl/weather-api.php"></mo-weather>
```

---

## Diagnostyka i Narzędzia Monitoringu

W repozytorium znajduje się dedykowane narzędzie diagnostyczne `scripts/check-cities.php` do weryfikacji dostępności stacji i dostawców danych:

```bash
# Weryfikacja konfiguracji miast i sensorów (tryb offline)
php scripts/check-cities.php --self-test

# Test parserów na zapisanych odpowiedziach fixture
php scripts/check-cities.php --fixtures

# Sprawdzenie dostępności API na żywo dla wszystkich 14 miast
php scripts/check-cities.php

# Sprawdzenie pojedynczego miasta w formacie JSON
php scripts/check-cities.php --city=katowice --format=json

# Wykonanie pełnego zestawu testów
npm test
```

Zalecane uruchomienie w cronie produkcyjnym:
```cron
0 6 * * * php /sciezka/do/scripts/check-cities.php --format=json --quiet >> /var/log/check-cities.log 2>&1
```

---

## Dostosowanie Wyglądu (Zmienne CSS)

Wygląd widgetu dopasowuje się za pomocą zmiennych CSS definiowanych w stylach portalu:

```css
mo-weather {
  --mo-card: #ffffff;      /* Tło karty */
  --mo-text: #1a1a1a;      /* Główny kolor tekstu */
  --mo-muted: #666666;     /* Tekst pomocniczy */
  --mo-border: #e5e5e5;    /* Obramowanie */
  --mo-accent: #0b63ce;    /* Kolor ikon i akcentów */
  --mo-radius: 12px;       /* Zaokrąglenie narożników */
  --mo-font: inherit;      /* Czcionka portalu */
}

/* Tryb ciemny */
.dark mo-weather,
mo-weather.dark {
  --mo-card: #17181c;
  --mo-text: #f4f4f5;
  --mo-muted: #9ca3af;
  --mo-border: #2b2d33;
  --mo-accent: #6ab0ff;
}
```

---

## Licencje i Podstawa Prawna

- **Kod komponentu:** [MIT License](LICENSE) (swobodne użycie komercyjne).
- **Prognoza pogody:** [MET Norway](https://api.met.no/) na licencji [Creative Commons Attribution 4.0 International (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/).
- **Pomiary i indeksy jakości powietrza:** [Główny Inspektorat Ochrony Środowiska (GIOŚ)](https://powietrze.gios.gov.pl/) — otwarte dane publiczne Państwowego Monitoringu Środowiska.
- **Prognoza jakości powietrza:** [Instytut Ochrony Środowiska – Państwowy Instytut Badawczy (IOŚ-PIB)](https://prognozy.ios.edu.pl/) — otwarte dane publiczne.
