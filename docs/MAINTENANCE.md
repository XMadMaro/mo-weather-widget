# Przewodnik Utrzymania i Monitoringu: MO Weather Widget

## 1. Monitorowanie Backend Proxy

### Logi Serwera
Backend proxy loguje błędy przez standardowy mechanizm PHP (`ini_set('log_errors', '1')`).
Należy monitorować występowanie:
- `CURL error` — awaria połączenia z `api.open-meteo.com` (timeout powyżej 8 s lub błąd DNS).
- `Retry-After / 429` — przekroczenie limitu 30 req / 60 s (możliwy atak lub błędna pętla odświeżania na portalu).
- `403 origin not allowed` — odrzucenie zapytania z niezarejestrowanej domeny lub brak konfiguracji `MO_ALLOWED_ORIGINS`.

### Rotacja i Czyszczenie Cache
- Pliki cache miast (`city_{slug}.json`) nadpisują się automatycznie atomowym rename co 60 minut.
- Pliki rate limitera (`rl_{hash}.json`) mogą być usuwane okresowo (np. raz na dobę z crona):
```bash
# Czyszczenie wpisów rate limitera starszych niż 24h
find /sciezka/do/var/cache/ -name "rl_*.json" -mtime +1 -delete
```

---

## 2. Aktualizacje Komponentu (SemVer)

Projekt przestrzega zasad Semantic Versioning:
- **Patch (v1.0.x):** Poprawki błędów, optymalizacje CSS/SVG, brak zmian w interfejsie.
- **Minor (v1.x.0):** Nowe atrybuty widgetu (np. dodatkowe wskaźniki ciśnienia), nowe miasta w allowliście API.
- **Major (v2.0.0):** Zmiana kontraktu JSON lub minimalnych wymagań przeglądarek.

### Cache Busting na CDN
W szablonie CMS skrypt widgetu powinien posiadać wersjonowanie w query stringu:
```html
<script src="https://cdn.TWOJA-DOMENA/weather-widget.min.js?v=1.0.0" defer></script>
```
Przy publikacji nowej wersji należy podbić parametr `?v=1.0.1`, co natychmiast wymusza odświeżenie w przeglądarkach czytelników.

---

## 3. Procedura Awaryjna (Disaster Recovery)

Gdy API Open-Meteo jest trwale niedostępne lub wyczerpał się limit:
1. Proxy automatycznie przechodzi w tryb **Graceful Degradation** — serwuje ostatni znany stan z flagą `is_stale: true`.
2. Widget na portalu wyświetla badge *„Ostatnia aktualizacja: X min temu”*, zachowując integralność wizualną.
3. W razie potrzeby ręcznego wymuszenia danych można wgrać gotowy JSON do `var/cache/city_katowice.json`.
