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

---

## 7. Tryby Osadzenia (v2.1+)

Komponent `<mo-weather>` oferuje trzy zoptymalizowane tryby prezentacji za pomocą atrybutu `mode`:

### A. Sidebar (kolumna boczna listy artykułów / widoku newsa)
Kompaktowy pion (szerokość maks. 320 px) ze scroll-snapem na prognozę 7 dni:
```html
<script src="https://api.mediaoperator.pl/assets/weather-widget.min.js" defer></script>
<mo-weather mode="sidebar" city-id="katowice" modules="current,air,daily7,nowcast" api-url="https://api.mediaoperator.pl/api/weather"></mo-weather>
```
*Opcjonalny atrybut `sticky` sprawia, że widget pozostaje przyklejony do górnej krawędzi ekranu podczas przewijania długiego artykułu:*
```html
<mo-weather mode="sidebar" sticky city-id="katowice" api-url="https://api.mediaoperator.pl/api/weather"></mo-weather>
```

### B. Floating (pływający launcher bubble w rogu ekranu)
Dyskretny przycisk (56 px) w prawym dolnym rogu (lub lewym przy `position="bottom-left"`). Po kliknięciu rozwija panel a11y z obsługą klawisza Esc. Wystarczy jedna instancja przed zamykającym tagiem `</body>` w layoucie globalnym:
```html
<mo-weather mode="floating" city-id="katowice" position="bottom-right" api-url="https://api.mediaoperator.pl/api/weather"></mo-weather>
```

### C. Wdrożenie produkcyjne na slazag.pl (Craft CMS / Twig)
Na portalach grupy Media Operator (np. slazag.pl) plik JS hostujemy bezpośrednio w zasobach portalu, a proxy PHP jako skrypt lokalny (ten sam origin → zero zapytań CORS):

W szablonie Twig (`templates/_layout.twig` lub `templates/news/_entry.twig`):
```twig
{# 1. Załadowanie skryptu w sekcji <head> lub na końcu <body> #}
<script src="/assets/js/weather-widget.min.js?v=2.1.0" defer></script>

{# 2. Osadzenie w kolumnie bocznej artykułu #}
<mo-weather mode="sidebar"
            city-id="katowice"
            modules="current,air,daily7,nowcast"
            api-url="/weather-api.php"></mo-weather>
```
> **Nota architektoniczna**: Taki sposób wdrożenia eliminuje zależność od zewnętrznych CDN-ów, zapewnia zerowy czas oczekiwania na połączenie TLS i 100% zgodność z polityką Content Security Policy (CSP).
