# Instrukcja Integracji: MO Weather Widget (v2.0)

Komponent `<mo-weather>` jest w 100% samowystarczalny (Vanilla Web Component z Shadow DOM) i integruje się z dowolnym systemem CMS lub generatorem stron statycznych bez konfliktów stylów CSS.

W wersji 2.0 widget obsługuje modułową architekturę za pomocą atrybutu `modules`:
- `current` — bieżąca pogoda (domyślny moduł)
- `air` — jakość powietrza (pomiary GIOŚ lub prognozy IOŚ-PIB)
- `daily7` — prognoza na 7 dni (MET Norway)
- `nowcast` — alert opadów deszczu na najbliższe godziny

Gdy atrybut `modules` nie zostanie podany, widget działa w trybie **zgodności wstecznej** (renderuje wyłącznie moduł `current`).

---

## 1. WordPress (Gutenberg / Klasyczny Edytor)

W edytorze blokowym (Gutenberg):
1. Dodaj blok **Własny HTML** (Custom HTML) w wybranym miejscu strony lub szablonu (np. sidebar, header).
2. Wklej poniższy kod:

```html
<!-- MO Weather Widget v2.0 -->
<script src="https://cdn.twojadomena.pl/weather-widget.min.js?v=2.0.0" defer></script>

<!-- Podstawowa karta pogody (kompatybilność wsteczna) -->
<mo-weather mode="single" city-id="katowice" api-url="https://api.twojadomena.pl/weather-api.php"></mo-weather>

<!-- Pełny zestaw modułów (pogoda, jakość powietrza, 7 dni, alert deszczu) -->
<mo-weather mode="single" city-id="katowice"
            modules="current,air,daily7,nowcast"
            api-url="https://api.twojadomena.pl/weather-api.php"></mo-weather>
```

3. Opcjonalnie: aby załadować skrypt globalnie dla całego motywu, dodaj do `functions.php`:
```php
function mo_weather_enqueue() {
    wp_enqueue_script('mo-weather-widget', 'https://cdn.twojadomena.pl/weather-widget.min.js', [], '2.0.0', true);
}
add_action('wp_enqueue_scripts', 'mo_weather_enqueue');
```

---

## 2. Drupal (8 / 9 / 10 / 11)

1. Przejdź do **Struktura > Układ bloków** (Structure > Block layout).
2. Dodaj **Własny blok** (Custom block).
3. W polu formatu tekstu ustaw **Full HTML** (brak filtrów wycinających custom elements i tagi `<script>`).
4. Wklej:
```html
<script src="https://cdn.twojadomena.pl/weather-widget.min.js?v=2.0.0" defer></script>

<!-- Karuzela agregatora z modułem jakości powietrza -->
<mo-weather mode="aggregator"
            cities="katowice,gliwice,sosnowiec,bytom,zabrze"
            modules="current,air"
            api-url="https://api.twojadomena.pl/weather-api.php"></mo-weather>
```

---

## 3. Craft CMS (Twig)

W szablonie `.twig` (np. `_includes/header.twig`):
```twig
{% block weather_widget %}
  {# W standardowym szablonie Craft CMS używamy aliasu @web lub zmiennej środowiskowej z app.yaml #}
  <script src="{{ alias('@web') }}/assets/weather-widget.min.js?v=2.0.0" defer></script>
  
  <mo-weather mode="single"
              city-id="katowice"
              modules="current,air,daily7,nowcast"
              api-url="{{ alias('@web') }}/api/weather-api.php"></mo-weather>
{% endblock %}
```
> **Uwaga:** Nie należy używać nieistniejących kluczy konfiguracyjnych w rodzaju `craft.app.config.general.cdnUrl`. Zalecany jest natywny `alias('@web')` lub jawny parametr z konfiguracji środowiskowej.

---

## 4. Next.js / React (App Router & Pages Router)

Dzięki Shadow DOM widget nie wchodzi w kolizje z Tailwindem, styled-components ani CSS Modules.
W komponencie klienta (`'use client'`):
```tsx
'use client';
import Script from 'next/script';

export default function WeatherSection() {
  return (
    <>
      <Script
        src="https://cdn.twojadomena.pl/weather-widget.min.js?v=2.0.0"
        strategy="lazyOnload"
      />
      {/* @ts-ignore - deklaracja custom elementu w JSX */}
      <mo-weather
        mode="single"
        city-id="katowice"
        modules="current,air,daily7,nowcast"
        api-url="https://api.twojadomena.pl/weather-api.php"
      />
    </>
  );
}
```

---

## 5. Generator Stron Statycznych (Hugo / Jekyll / Astro)

W pliku partiala (np. `layouts/partials/weather.html`):
```html
<script src="https://cdn.twojadomena.pl/weather-widget.min.js?v=2.0.0" defer></script>
<mo-weather mode="single" city-id="katowice" modules="current,air,daily7,nowcast" api-url="https://api.twojadomena.pl/weather-api.php"></mo-weather>
```

---

## 6. Personalizacja i Motywy CSS

Stylizowanie komponentu odbywa się za pomocą zmiennych CSS ustawianych na tagu `<mo-weather>` lub dowolnym elemencie nadrzędnym:

```css
/* Przykładowy motyw dopasowany do barw portalu */
mo-weather {
  --mo-card: #ffffff;      /* Kolor tła karty */
  --mo-text: #1a1a1a;      /* Główny kolor tekstu */
  --mo-muted: #666666;     /* Tekst poboczny i metadane */
  --mo-border: #e5e5e5;    /* Ramka karty */
  --mo-accent: #0b63ce;    /* Kolor ikon wektorowych SVG */
  --mo-radius: 12px;       /* Zaokrąglenie rogów */
  --mo-font: 'Inter', system-ui, sans-serif;
}

/* Wariant ciemny */
.dark mo-weather,
mo-weather.dark {
  --mo-card: #17181c;
  --mo-text: #f4f4f5;
  --mo-muted: #9ca3af;
  --mo-border: #2b2d33;
  --mo-accent: #6ab0ff;
}
```
