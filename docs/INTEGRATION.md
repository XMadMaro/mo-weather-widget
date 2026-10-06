# Instrukcja Integracji: MO Weather Widget

Komponent `<mo-weather>` jest w 100% samowystarczalny (Vanilla Web Component z Shadow DOM) i integruje się z dowolnym systemem CMS lub generatorem stron statycznych bez konfliktów styli CSS.

---

## 1. WordPress

W edytorze blokowym (Gutenberg):
1. Dodaj blok **Własny HTML** (Custom HTML) w wybranym miejscu strony lub szablonu (np. sidebar, header).
2. Wklej poniższy kod:
```html
<!-- MO Weather Widget -->
<script src="https://cdn.TWOJA-DOMENA/weather-widget.min.js?v=1.0.1" defer></script>
<mo-weather mode="single" city-id="katowice" api-url="https://api.TWOJA-DOMENA/weather-api.php"></mo-weather>
```
3. Opcjonalnie: aby załadować skrypt globalnie raz dla całego motywu, dodaj do `functions.php`:
```php
function mo_weather_enqueue() {
    wp_enqueue_script('mo-weather-widget', 'https://cdn.TWOJA-DOMENA/weather-widget.min.js', [], '1.0.1', true);
}
add_action('wp_enqueue_scripts', 'mo_weather_enqueue');
```

---

## 2. Drupal (8 / 9 / 10)

1. Przejdź do **Struktura > Układ bloków** (Structure > Block layout).
2. Dodaj **Własny blok** (Custom block).
3. W polu formatu tekstu ustaw **Full HTML** (brak filtrów wycinających custom elements i tagi `<script>`).
4. Wklej:
```html
<script src="https://cdn.TWOJA-DOMENA/weather-widget.min.js?v=1.0.1" defer></script>
<mo-weather mode="aggregator" cities="katowice,gliwice,sosnowiec,bytom" api-url="https://api.TWOJA-DOMENA/weather-api.php"></mo-weather>
```

---

## 3. Craft CMS (Twig)

W szablonie `.twig` (np. `_includes/header.twig`):
```twig
{% block weather_widget %}
  {# W standardowym szablonie Craft CMS użyj aliasu @web lub zmiennej środowiskowej #}
  <script src="{{ alias('@web') }}/assets/weather-widget.min.js?v=1.0.1" defer></script>
  <mo-weather mode="single" city-id="katowice"
              api-url="{{ alias('@web') }}/weather-api.php"></mo-weather>
{% endblock %}
```

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
        src="https://cdn.TWOJA-DOMENA/weather-widget.min.js?v=1.0.1"
        strategy="lazyOnload"
      />
      {/* @ts-ignore - deklaracja custom elementu w JSX */}
      <mo-weather mode="single" city-id="katowice" api-url="https://api.TWOJA-DOMENA/weather-api.php" />
    </>
  );
}
```

---

## 5. Generator Stron Statycznych (Hugo / Jekyll / Astro)

W pliku partiala (np. `layouts/partials/weather.html`):
```html
<script src="https://cdn.TWOJA-DOMENA/weather-widget.min.js?v=1.0.1" defer></script>
<mo-weather mode="single" city-id="katowice" api-url="https://api.TWOJA-DOMENA/weather-api.php"></mo-weather>
```

---

## 6. Personalizacja i Theming

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
