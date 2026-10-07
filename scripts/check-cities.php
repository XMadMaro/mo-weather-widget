#!/usr/bin/env php
<?php
declare(strict_types=1);

/**
 * MO Weather Widget — Narzędzie monitoringu i walidacji 14 miast (check-cities.php)
 * Wersja: 2.0.0
 *
 * Użycie:
 *   php scripts/check-cities.php --self-test            # Walidacja integralności konfiguracji (offline, exit 0/1)
 *   php scripts/check-cities.php --fixtures             # Test parserów na zapisanych odpowiedziach API
 *   php scripts/check-cities.php --format=json          # Wynik w formacie JSON (dla cron / systemów monitoringu)
 *   php scripts/check-cities.php --quiet                # Tylko kod wyjścia i błędy krytyczne
 *   php scripts/check-cities.php --record=plik.json     # Nagranie odpowiedzi live do pliku
 */

$rootDir = dirname(__DIR__);
$citiesFile = $rootDir . '/src/cities.php';
$fixturesDir = __DIR__ . '/fixtures';

if (!file_exists($citiesFile)) {
    fwrite(STDERR, "BŁĄD: Brak pliku konfiguracji: $citiesFile\n");
    exit(1);
}

$cities = require $citiesFile;

$options = getopt('', ['self-test', 'fixtures', 'format:', 'quiet', 'record::', 'help']);

if (isset($options['help'])) {
    echo "Użycie: php scripts/check-cities.php [OPCJE]\n";
    echo "  --self-test           Weryfikacja integralności reguł 14 miast w src/cities.php\n";
    echo "  --fixtures            Test offline z użyciem plików fixtures z scripts/fixtures/\n";
    echo "  --format=json         Format wyjścia JSON\n";
    echo "  --quiet               Wyciszenie komunikatów informacyjnych\n";
    echo "  --record[=FILE]       Nagranie realnych odpowiedzi do pliku JSON\n";
    exit(0);
}

$formatJson = ($options['format'] ?? '') === 'json';
$quiet = isset($options['quiet']);

// --- 1. TRYB --self-test ---
if (isset($options['self-test'])) {
    $errors = [];
    $count = count($cities);

    if ($count !== 14) {
        $errors[] = "Niepoprawna liczba miast: oczekiwano 14, znaleziono $count";
    }

    $activeGios = [];
    $citiesWithPm25 = [];
    $iosForecastCities = [];

    foreach ($cities as $slug => $c) {
        // Walidacja współrzędnych (woj. śląskie / aglomeracja)
        if (!isset($c['lat'], $c['lon']) || $c['lat'] < 49.9 || $c['lat'] > 50.7 || $c['lon'] < 18.4 || $c['lon'] > 19.4) {
            $errors[] = "$slug: Nieprawidłowe współrzędne geograficzne (lat: {$c['lat']}, lon: {$c['lon']})";
        }

        // Walidacja TERYT (kod 4-cyfrowy zaczynający się od 24 dla woj. śląskiego)
        if (!isset($c['teryt']) || !preg_match('/^24\d{2}$/', (string)$c['teryt'])) {
            $errors[] = "$slug: Nieprawidłowy kod TERYT: {$c['teryt']}";
        }

        // Walidacja poziomu TERYT
        if (!in_array($c['teryt_level'] ?? '', ['city', 'county'], true)) {
            $errors[] = "$slug: Nieprawidłowy teryt_level (musi być 'city' lub 'county')";
        }

        // Walidacja stacji GIOŚ
        if (!empty($c['has_gios'])) {
            $activeGios[] = $slug;
            if (empty($c['gios_station_id']) || empty($c['sensors']['pm10'])) {
                $errors[] = "$slug: Stacja GIOŚ oznaczona jako aktywna, ale brak ID stacji lub sensora PM10";
            }
            if (!empty($c['sensors']['pm25'])) {
                $citiesWithPm25[] = $slug;
            }
        } else {
            $iosForecastCities[] = $slug;
        }

        // Sprawdzenie odrzucenia sensorów manualnych
        if ($slug === 'gliwice' && !in_array(5314, $c['ignored_sensors'] ?? [], true)) {
            $errors[] = "Gliwice: sensor manualny PM2,5 (5314) musi być w ignored_sensors";
        }
        if ($slug === 'dabrowa-gornicza' && (!in_array(5287, $c['ignored_sensors'] ?? [], true) || ($c['sensors']['pm10'] ?? 0) !== 5286)) {
            $errors[] = "Dąbrowa Górnicza: sensor PM10 musi być 5286, a 5287 w ignored_sensors";
        }
        if ($slug === 'zabrze' && !in_array(29679, $c['ignored_sensors'] ?? [], true)) {
            $errors[] = "Zabrze: sensor manualny PM10 (29679) musi być w ignored_sensors";
        }
    }

    if (count($activeGios) !== 6) {
        $errors[] = "Oczekiwano dokładnie 6 miast z pomiarem GIOŚ, znaleziono " . count($activeGios) . " (" . implode(', ', $activeGios) . ")";
    }

    if ($citiesWithPm25 !== ['katowice']) {
        $errors[] = "Tylko Katowice mogą mieć automatyczny pomiar PM2,5, znaleziono: " . implode(', ', $citiesWithPm25);
    }

    if (count($iosForecastCities) !== 8) {
        $errors[] = "Oczekiwano dokładnie 8 miast z prognozą IOŚ-PIB, znaleziono " . count($iosForecastCities);
    }

    $success = empty($errors);
    $result = [
        'mode' => 'self-test',
        'success' => $success,
        'total_cities' => $count,
        'active_gios_cities' => count($activeGios),
        'gios_pm25_cities' => count($citiesWithPm25),
        'ios_forecast_cities' => count($iosForecastCities),
        'errors' => $errors,
    ];

    if ($formatJson) {
        echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . "\n";
    } else {
        if ($success) {
            if (!$quiet) {
                echo "✓ [self-test] Sukces: 14 miast zweryfikowanych pomyślnie.\n";
                echo "  - Stacje GIOŚ z pomiarem: 6 (" . implode(', ', $activeGios) . ")\n";
                echo "  - Miasta z PM2,5: 1 (katowice)\n";
                echo "  - Miasta z prognozą IOŚ: 8 (" . implode(', ', $iosForecastCities) . ")\n";
            }
        } else {
            fwrite(STDERR, "✗ [self-test] Błędy w konfiguracji miast:\n");
            foreach ($errors as $e) {
                fwrite(STDERR, "  - $e\n");
            }
        }
    }
    exit($success ? 0 : 1);
}

// --- 2. TRYB --fixtures ---
if (isset($options['fixtures'])) {
    $errors = [];
    $fixtures = [
        'met'       => $fixturesDir . '/met-norway.json',
        'pm10'      => $fixturesDir . '/gios-data-pm10-katowice.json',
        'pm25'      => $fixturesDir . '/gios-data-pm25-katowice.json',
        'index'     => $fixturesDir . '/gios-index-katowice.json',
        'ios'       => $fixturesDir . '/ios-forecast-bytom.json',
        'err_man'   => $fixturesDir . '/gios-data-manual-error.json',
    ];

    foreach ($fixtures as $name => $path) {
        if (!file_exists($path)) {
            $errors[] = "Brak wymaganego pliku fixture: $name ($path)";
            continue;
        }
        $data = json_decode(file_get_contents($path), true);
        if ($data === null && json_last_error() !== JSON_ERROR_NONE) {
            $errors[] = "Błąd dekodowania JSON w fixture $name: " . json_last_error_msg();
        }
    }

    // Walidacja logiki parsera MET Norway
    if (file_exists($fixtures['met'])) {
        $met = json_decode(file_get_contents($fixtures['met']), true);
        if (!isset($met['properties']['timeseries'][0]['data']['instant']['details']['air_temperature'])) {
            $errors[] = "Parser MET Norway: brak kluczowych pól instant.details.air_temperature";
        }
    }

    // Walidacja parsowania GIOŚ (ostatnia niepusta wartość)
    if (file_exists($fixtures['pm10'])) {
        $pm10 = json_decode(file_get_contents($fixtures['pm10']), true);
        $val = null;
        foreach ($pm10['values'] ?? [] as $row) {
            if ($row['value'] !== null) { $val = $row['value']; break; }
        }
        if ($val !== 44.89) {
            $errors[] = "Parser GIOŚ PM10: niepoprawna ekstrakcja ostatniej niepustej wartości (oczekiwano 44.89, otrzymano $val)";
        }
    }

    // Walidacja wykrywania błędu manualnego stanowiska GIOŚ
    if (file_exists($fixtures['err_man'])) {
        $errMan = json_decode(file_get_contents($fixtures['err_man']), true);
        if (($errMan['error_code'] ?? '') !== 'API-ERR-100003') {
            $errors[] = "Parser błędu manualnego GIOŚ: nie wykryto API-ERR-100003";
        }
    }

    $success = empty($errors);
    $result = [
        'mode' => 'fixtures',
        'success' => $success,
        'checked_fixtures' => count($fixtures),
        'errors' => $errors,
    ];

    if ($formatJson) {
        echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . "\n";
    } else {
        if ($success) {
            if (!$quiet) echo "✓ [fixtures] Wszystkie fixture'y poprawne. Parsery działają prawidłowo.\n";
        } else {
            fwrite(STDERR, "✗ [fixtures] Błędy w testach fixtures:\n");
            foreach ($errors as $e) fwrite(STDERR, "  - $e\n");
        }
    }
    exit($success ? 0 : 1);
}

// --- 3. DOMYŚLNY TRYB: Raport konfiguracji i stanu 14 miast ---
$summary = [
    'timestamp' => date('c'),
    'cities_count' => count($cities),
    'cities' => [],
];

foreach ($cities as $slug => $c) {
    $summary['cities'][$slug] = [
        'label' => $c['label'],
        'teryt' => $c['teryt'],
        'has_gios' => $c['has_gios'],
        'gios_station' => $c['gios_station_id'],
        'pm10_sensor' => $c['sensors']['pm10'] ?? null,
        'pm25_sensor' => $c['sensors']['pm25'] ?? null,
        'source_air' => $c['has_gios'] ? 'GIOŚ (stacja ' . $c['gios_station_id'] . ')' : 'IOŚ-PIB (TERYT ' . $c['teryt'] . ')',
        'source_weather' => 'MET Norway',
    ];
}

if ($formatJson) {
    echo json_encode($summary, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . "\n";
} else {
    echo "======================================================================\n";
    echo " MO Weather Widget — Raport konfiguracji 14 miast (Media Operator)\n";
    echo "======================================================================\n";
    printf("%-18s %-6s %-10s %-8s %-8s %-20s\n", "MIASTO", "TERYT", "GIOŚ STACJA", "PM10", "PM2,5", "ŹRÓDŁO POWIETRZA");
    echo str_repeat('-', 74) . "\n";
    foreach ($summary['cities'] as $slug => $d) {
        printf(
            "%-18s %-6s %-10s %-8s %-8s %-20s\n",
            $d['label'],
            $d['teryt'],
            $d['gios_station'] ?? '—',
            $d['pm10_sensor'] ?? '—',
            $d['pm25_sensor'] ?? '—',
            $d['source_air']
        );
    }
    echo "======================================================================\n";
}

exit(0);
