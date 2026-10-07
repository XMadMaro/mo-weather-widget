# Narzędzie monitoringu miast — `scripts/check-cities.php`

Narzędzie weryfikacji i ciągłego monitoringu konfiguracji 14 miast aglomeracji górnośląsko-zagłębiowskiej dla widgetu pogodowego `mo-weather-widget` (Media Operator).

---

## 1. Przeznaczenie

1. **Walidacja integralności konfiguracji (`src/cities.php`)** w trybie CI/CD oraz przed każdym wydaniem.
2. **Weryfikacja reguł stacji pomiarowych GIOŚ i prognoz IOŚ-PIB**:
   - 14 miast w allowliście
   - dokładnie 6 miast z aktywnym pomiarem stacyjnym GIOŚ (Katowice, Gliwice, Sosnowiec, Zabrze, Tychy, Dąbrowa Górnicza)
   - Katowice (stacja 17318) jako jedyne miasto z automatycznym pomiarem PM2,5 (sensor 28759)
   - 8 miast kierowanych na 3-dniową prognozę IOŚ-PIB (Bytom, Chorzów, Świętochłowice, Ruda Śląska, Piekary Śląskie, Tarnowskie Góry, Knurów, Będzin)
   - poprawne etykietowanie jednostek TERYT na poziomie powiatu (Knurów, Będzin, Tarnowskie Góry)
3. **Testy regresji parserów na offline fixtures** bez odpytywania zewnętrznych sieci.
4. **Monitoring w cronie** generujący raport JSON.

---

## 2. Użycie w wierszu poleceń

```bash
# 1. Walidacja konfiguracji (self-test offline, exit 0/1)
php scripts/check-cities.php --self-test

# 2. Testy parserów na fixtures (offline)
php scripts/check-cities.php --fixtures

# 3. Testy automatyczne Node.js (21 testów)
node scripts/check-cities-test.mjs

# 4. Zbiorczy raport konfiguracji w formacie tekstowym
php scripts/check-cities.php

# 5. Raport maszynowy JSON
php scripts/check-cities.php --format=json

# 6. Nagranie realnych odpowiedzi z API zewnętrznych
php scripts/check-cities.php --record=scripts/fixtures/cities-live.json
```

---

## 3. Limity API i tempo zapytań (GIOŚ, IOŚ-PIB, MET Norway)

| Usługa | Endpoint | Limit zapytań | Uwagi |
|---|---|---|---|
| **GIOŚ** | `data/getData/{sensorId}` | **1500 / min** | Pobieranie wartości pomiaru (PM10, PM2,5) |
| **GIOŚ** | `aqindex/getIndex/{stationId}` | **1500 / min** | Indeks ogólny stacji |
| **GIOŚ** | `station/sensors/{stationId}` | **2 / min** | **ZAKAZ OD PYTYWANIA W RUNTIME**. Identyfikatory sensorów są na stałe w `src/cities.php` |
| **IOŚ-PIB** | `api.prognozy.ios.edu.pl/v1/PM10/{TERYT}` | Niepublikowany | Szanować interwały cache (90 min) |
| **MET Norway** | `locationforecast/2.0/compact` | **20 / s** | Wymagany unikalny nagłówek User-Agent z kontaktem |

---

## 4. Konfiguracja w Cronie na serwerze produkcyjnym (Alertowanie przy awarii)

Narzędzie zwraca kod wyjścia:
- `exit 0` — pełna integralność reguł i stacji,
- `exit ≠ 0` — wykryto defekt, wyłączenie stacji lub niespójność konfiguracji (**zdarzenie alertowalne**).

### 4.1 Przykład: Alert e-mail do zespołu operacyjnego
```cron
# Codziennie o 06:00 rano — walidacja konfiguracji i stacji z powiadomieniem e-mail przy błędzie
0 6 * * * cd /var/www/mo-weather && php scripts/check-cities.php --self-test --quiet || (echo "ALERT: Błąd weryfikacji stacji MO Weather Widget" | mail -s "[P0 ALERT] Awaria stacji pogodowych" redakcja@media-operator.pl devops@media-operator.pl)
```

### 4.2 Przykład: Alert na kanał Slack / Webhook
```cron
# Codziennie o 06:00 rano — wysyłka JSON payload do webhooka Slack/Teams przy kodzie wyjścia != 0
0 6 * * * cd /var/www/mo-weather && php scripts/check-cities.php --self-test --format=json > /tmp/check-cities.json || curl -X POST -H 'Content-type: application/json' --data '{"text":"🚨 *ALERT MO Weather Widget*: Wykryto problem ze stacjami GIOŚ/IOŚ! Sprawdź raport: check-cities.php"}' https://hooks.slack.com/services/TWOJ/WEBHOOK/SLACK
```
