<?php
declare(strict_types=1);

/**
 * MO Weather Widget — proxy backend z cache (PHP 8.1+)
 * Wersja: 2.0.0 (Media Operator)
 *
 * Architektura v2.0:
 *  - 14 miast z allowlisty w src/cities.php (Katowice, Gliwice, Sosnowiec, Bytom, Zabrze, Tychy,
 *    Dąbrowa Górnicza, Chorzów, Świętochłowice, Ruda Śląska, Piekary Śląskie, Tarnowskie Góry, Knurów, Będzin).
 *  - Obsługa modułów: type=current (domyślny), type=air, type=daily7, type=nowcast, type=health.
 *  - Migracja z darmowego Open-Meteo na MET Norway locationforecast 2.0 (CC BY 4.0, w pełni legalny komercyjnie).
 *  - Moduł powietrza: pomiar GIOŚ (6 stacji, PM2,5 wyłącznie Katowice) + prognoza 3-dniowa IOŚ-PIB (8 miast).
 *  - Single-flight mutex (flock) chroniący przed thundering herd przy zimnym cache.
 *  - Rate limiter liczący WYŁĄCZNIE cache-missy (cache-hit bezpłatny).
 *  - ETag stabilny liczony z body (czas serwera w nagłówku Server-Time).
 *  - Graceful degradation: circuit breaker per miasto i typ, serwowanie stale cache przy awarii upstreamu.
 */

error_reporting(E_ALL);
ini_set('display_errors', '0');
ini_set('log_errors', '1');

/* ---------- KONFIGURACJA ---------- */

const MO_ALLOWED_ORIGINS = [
    'slazag.pl',
    'mediaoperator.pl',
    '24kato.pl',
    'bytomski.pl',
    'glivice.pl',
    'chorzowski.pl',
    'tarnowskiegory.info',
    'piekary.info',
    'ngs24.pl',
    'rudzianin.pl',
    'zabrze-news.pl',
    'nowinytyskie.pl',
    '24zaglebie.pl',
];

$MO_CITIES = require __DIR__ . '/cities.php';

// Czasy świeżości cache (w sekundach)
const MO_TTL_CURRENT = 1800; // 30 min (MET Norway)
const MO_TTL_DAILY7  = 1800; // 30 min (MET Norway)
const MO_TTL_NOWCAST = 300;  // 5 min (P0.4: nowcast TTL = 300 s)
const MO_TTL_AIR     = 5400; // 90 min (GIOŚ publikuje godzinowo)
const MO_BACKOFF_TTL = 60;   // Cooldown circuit breakera: 60 s po awarii API
const MO_HTTP_MAXAGE = 60;   // P1.6: Cache-Control public, max-age=60 dla CDN i przeglądarki
const MO_RATE_MAX    = 30;   // Max cache-missów na okno
const MO_RATE_WINDOW = 60;   // Okno rate limitera (sekundy)
const MO_API_TIMEOUT = 8;    // Timeout zapytań HTTP (sekundy)
const MO_API_CONNECT = 3;    // Timeout połączenia (sekundy)

/* ---------- HELPERS ---------- */

function mo_json(mixed $data, int $code = 200): never {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function mo_cache_dir(): string {
    $envDir = getenv('MO_CACHE_DIR');
    if ($envDir !== false && $envDir !== '') {
        if (!is_dir($envDir)) @mkdir($envDir, 0775, true);
        if (is_dir($envDir) && is_writable($envDir)) return rtrim($envDir, '/');
    }

    // Jeśli środowisko Railway lub system z ograniczonym zapisem poza /tmp
    if (getenv('RAILWAY_ENVIRONMENT') || getenv('RAILWAY_STATIC_URL') || !is_writable(dirname(__DIR__))) {
        $tmpDir = sys_get_temp_dir() . '/mo-cache';
        if (!is_dir($tmpDir)) @mkdir($tmpDir, 0775, true);
        if (is_dir($tmpDir) && is_writable($tmpDir)) return $tmpDir;
    }

    $dir = dirname(__DIR__) . '/var/cache';
    if (!is_dir($dir) && !@mkdir($dir, 0775, true)) {
        $dir = __DIR__ . '/.cache';
        if (!is_dir($dir)) @mkdir($dir, 0775, true);
    }
    if (!is_dir($dir) || !is_writable($dir)) {
        $dir = sys_get_temp_dir() . '/mo-cache';
        if (!is_dir($dir)) @mkdir($dir, 0775, true);
    }
    if (!is_file($dir . '/.htaccess')) @file_put_contents($dir . '/.htaccess', "Require all denied\n");
    return $dir;
}

function mo_cors(): void {
    header('Vary: Origin');
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin === '') return;
    $host = parse_url($origin, PHP_URL_HOST);
    if (!is_string($host)) mo_json(['error' => 'bad origin'], 403);
    $host = strtolower($host);

    $allowed = MO_ALLOWED_ORIGINS;
    $allowed = array_merge($allowed, [
        'up.railway.app',
        'railway.app',
    ]);
    if (getenv('APP_ENV') === 'development' || ($_SERVER['APP_ENV'] ?? '') === 'development' || getenv('RAILWAY_ENVIRONMENT')) {
        $allowed = array_merge($allowed, ['localhost', '127.0.0.1']);
    }

    foreach ($allowed as $d) {
        if ($host === $d || str_ends_with($host, '.' . $d)) {
            header('Access-Control-Allow-Origin: ' . $origin);
            header('Access-Control-Allow-Methods: GET, HEAD, OPTIONS');
            header('Access-Control-Max-Age: 600');
            return;
        }
    }
    mo_json(['error' => 'origin not allowed'], 403);
}

function mo_rate_limit(string $dir): void {
    $now = time();

    // Probabilistyczne czyszczenie starych plików rate limitera (1% szansy, pliki >24h)
    if (random_int(1, 100) === 1) {
        $cutoff = $now - 86400;
        $files = glob($dir . '/rl_*.json');
        if (is_array($files)) {
            foreach ($files as $f) {
                if (@filemtime($f) < $cutoff) @unlink($f);
            }
        }
    }

    $ip = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    if (str_contains($ip, ',')) {
        $ip = trim(explode(',', $ip)[0]);
    }
    $salt = date('Ymd'); // rotowana sól dzienna
    $file = $dir . '/rl_' . substr(hash('sha256', $ip . '|' . $salt . '|mo-weather'), 0, 16) . '.json';
    $fh = @fopen($file, 'c+');
    if (!$fh) return;
    flock($fh, LOCK_EX);
    $state = json_decode((string) stream_get_contents($fh), true);
    if (!is_array($state) || ($state['start'] ?? 0) + MO_RATE_WINDOW <= $now) {
        $state = ['start' => $now, 'count' => 0];
    }
    $state['count']++;
    $over = $state['count'] > MO_RATE_MAX;
    ftruncate($fh, 0); rewind($fh); fwrite($fh, json_encode($state)); fflush($fh);
    flock($fh, LOCK_UN); fclose($fh);
    if ($over) {
        $retry = max(1, $state['start'] + MO_RATE_WINDOW - $now);
        header('Retry-After: ' . $retry);
        mo_json(['error' => 'rate limited', 'retry_after_seconds' => $retry], 429);
    }
}

function mo_read_cache(string $path): ?array {
    if (!is_file($path)) return null;
    $fh = @fopen($path, 'rb');
    if (!$fh) return null;
    flock($fh, LOCK_SH);
    $raw = stream_get_contents($fh);
    flock($fh, LOCK_UN); fclose($fh);
    $data = json_decode((string) $raw, true);
    return is_array($data) && isset($data['fetched_at']) ? $data : null;
}

function mo_write_cache(string $path, array $data): void {
    $tmp = $path . '.' . getmypid() . '.' . bin2hex(random_bytes(4)) . '.tmp';
    if (@file_put_contents($tmp, json_encode($data, JSON_UNESCAPED_UNICODE)) !== false) {
        rename($tmp, $path);
    }
}

function mo_is_in_backoff(string $backoffFile): bool {
    if (!is_file($backoffFile)) return false;
    $raw = @file_get_contents($backoffFile);
    if (!$raw) return false;
    $state = json_decode($raw, true);
    return is_array($state) && isset($state['failed_at']) && (time() - (int) $state['failed_at']) < MO_BACKOFF_TTL;
}

function mo_set_backoff(string $backoffFile): void {
    @file_put_contents($backoffFile, json_encode(['failed_at' => time()]));
}

function mo_clear_backoff(string $backoffFile): void {
    if (is_file($backoffFile)) @unlink($backoffFile);
}

/**
 * Klient HTTP z guardem ext-curl i fallbackiem na stream context.
 */
function mo_http_get(string $url, array $headers = []): ?string {
    $defaultHeaders = [
        'User-Agent: mo-weather-widget/2.0 (+https://media-operator.pl; kontakt: redakcja@media-operator.pl)',
        'Accept: application/ld+json, application/json, */*',
    ];
    $mergedHeaders = array_merge($defaultHeaders, $headers);

    // IOŚ-PIB używa certyfikatu wewnętrznego administracji publicznej
    $isIos = str_contains($url, 'api.prognozy.ios.edu.pl');
    $verifySsl = !$isIos;

    if (function_exists('curl_init')) {
        $ch = curl_init($url);
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => MO_API_TIMEOUT,
            CURLOPT_CONNECTTIMEOUT => MO_API_CONNECT,
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_SSL_VERIFYPEER => $verifySsl,
            CURLOPT_SSL_VERIFYHOST => $verifySsl ? 2 : 0,
            CURLOPT_HTTPHEADER     => $mergedHeaders,
        ]);
        $raw  = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        if (!is_string($raw) || $code < 200 || $code >= 300) return null;
        return $raw;
    }

    // Fallback dla środowisk bez ext-curl
    $ctx = stream_context_create([
        'http' => [
            'method'        => 'GET',
            'timeout'       => MO_API_TIMEOUT,
            'header'        => implode("\r\n", $mergedHeaders),
            'follow_location' => 1,
            'ignore_errors' => true,
        ],
        'ssl' => [
            'verify_peer'      => $verifySsl,
            'verify_peer_name' => $verifySsl,
        ],
    ]);
    $raw = @file_get_contents($url, false, $ctx);
    if (!is_string($raw)) return null;
    if (isset($http_response_header) && is_array($http_response_header)) {
        if (preg_match('{HTTP/\S*\s+(\d{3})}', $http_response_header[0] ?? '', $m)) {
            $code = (int) $m[1];
            if ($code < 200 || $code >= 300) return null;
        }
    }
    return $raw;
}

/* ---------- INTEGRACJE ZEWNĘTRZNE ---------- */

/**
 * MET Norway — locationforecast 2.0 compact
 */
function mo_fetch_met_norway(float $lat, float $lon): ?array {
    $url = 'https://api.met.no/weatherapi/locationforecast/2.0/compact?' . http_build_query([
        'lat' => number_format($lat, 4, '.', ''),
        'lon' => number_format($lon, 4, '.', ''),
    ]);
    $raw = mo_http_get($url);
    if ($raw === null) return null;
    $data = json_decode($raw, true);
    return (is_array($data) && isset($data['properties']['timeseries'])) ? $data : null;
}

/**
 * Mapowanie symbolu MET Norway na kod WMO, opis PL i nazwę ikony.
 */
function mo_met_symbol_to_wmo(string $symbol): array {
    $clean = preg_replace('/_(day|night|polartwilight)$/', '', $symbol) ?? $symbol;
    return match ($clean) {
        'clearsky' => ['code' => 0, 'text' => 'Bezchmurnie', 'icon' => 'sun'],
        'fair' => ['code' => 1, 'text' => 'Pogodnie', 'icon' => 'sun'],
        'partlycloudy' => ['code' => 2, 'text' => 'Częściowe zachmurzenie', 'icon' => 'partly'],
        'cloudy' => ['code' => 3, 'text' => 'Pochmurno', 'icon' => 'cloud'],
        'fog' => ['code' => 45, 'text' => 'Mgła', 'icon' => 'fog'],
        'lightrainshowers', 'lightrain' => ['code' => 61, 'text' => 'Lekki deszcz', 'icon' => 'rain'],
        'rainshowers', 'rain' => ['code' => 63, 'text' => 'Deszcz', 'icon' => 'rain'],
        'heavyrainshowers', 'heavyrain' => ['code' => 65, 'text' => 'Ulewa', 'icon' => 'rain'],
        'lightsleetshowers', 'lightsleet', 'sleet' => ['code' => 68, 'text' => 'Deszcz ze śniegiem', 'icon' => 'rain'],
        'lightsnowshowers', 'lightsnow', 'snowshowers', 'snow' => ['code' => 71, 'text' => 'Śnieg', 'icon' => 'snow'],
        'heavysnowshowers', 'heavysnow' => ['code' => 75, 'text' => 'Mocny śnieg', 'icon' => 'snow'],
        'lightrainshowersandthunder', 'rainandthunder', 'heavyrainandthunder' => ['code' => 95, 'text' => 'Burza', 'icon' => 'storm'],
        default => ['code' => 3, 'text' => 'Pochmurno', 'icon' => 'cloud'],
    };
}

/**
 * GIOŚ — pobranie danych z sensora
 */
function mo_fetch_gios_data(int $sensorId): ?array {
    $url = 'https://api.gios.gov.pl/pjp-api/v1/rest/data/getData/' . $sensorId;
    $raw = mo_http_get($url);
    if ($raw === null) return null;
    $data = json_decode($raw, true);
    return is_array($data) ? $data : null;
}

/**
 * GIOŚ — indeks stacji
 */
function mo_fetch_gios_index(int $stationId): ?array {
    $url = 'https://api.gios.gov.pl/pjp-api/v1/rest/aqindex/getIndex/' . $stationId;
    $raw = mo_http_get($url);
    if ($raw === null) return null;
    $data = json_decode($raw, true);
    return is_array($data) ? $data : null;
}

/**
 * IOŚ-PIB — prognoza 3-dniowa PM10 per TERYT (wymaga ukośnika na końcu)
 */
function mo_fetch_ios_forecast(string $teryt): ?array {
    $url = 'https://api.prognozy.ios.edu.pl/v1/PM10/' . $teryt . '/';
    $raw = mo_http_get($url);
    if ($raw === null) return null;
    $data = json_decode($raw, true);
    return is_array($data) ? $data : null;
}

/**
 * Zdrowotna porada na podstawie indeksu jakości powietrza (1-6).
 */
function mo_air_advice(int $catIndex): string {
    return match ($catIndex) {
        1, 2 => 'Jakość powietrza dobra. Można przebywać na zewnątrz.',
        3, 4 => 'Osoby wrażliwe powinny ograniczyć wysiłek na zewnątrz.',
        5    => 'Osoby z chorobami serca i płuc, dzieci i seniorzy powinni zostać w domu.',
        6    => 'Unikaj przebywania na zewnątrz. Zamknij okna.',
        default => 'Osoby wrażliwe powinny ograniczyć wysiłek na zewnątrz.',
    };
}

/* ---------- BUILDERY DLA MODUŁÓW ---------- */

/**
 * Moduł CURRENT z MET Norway
 */
function mo_build_current(array $met, array $cityConfig): ?array {
    $ts = $met['properties']['timeseries'] ?? [];
    if (empty($ts)) return null;

    $first = $ts[0];
    $details = $first['data']['instant']['details'] ?? [];
    $temp = isset($details['air_temperature']) ? (int) round((float) $details['air_temperature']) : null;
    $windMs = (float) ($details['wind_speed'] ?? 0.0);
    $windSpeed = (int) round($windMs * 3.6); // przeliczenie m/s -> km/h

    $symbol = $first['data']['next_1_hours']['summary']['symbol_code']
        ?? $first['data']['next_6_hours']['summary']['symbol_code']
        ?? 'cloudy';

    $mapped = mo_met_symbol_to_wmo($symbol);

    // Wyznaczenie temp_max i temp_min dla dzisiejszego dnia w strefie Warszawa
    $today = (new DateTimeImmutable('now', new DateTimeZone('Europe/Warsaw')))->format('Y-m-d');
    $todayTemps = [];
    foreach ($ts as $pt) {
        $tStr = $pt['time'] ?? '';
        $dt = new DateTimeImmutable($tStr);
        $dtWarsaw = $dt->setTimezone(new DateTimeZone('Europe/Warsaw'));
        if ($dtWarsaw->format('Y-m-d') === $today) {
            if (isset($pt['data']['instant']['details']['air_temperature'])) {
                $todayTemps[] = (float) $pt['data']['instant']['details']['air_temperature'];
            }
        }
    }

    $tempMax = !empty($todayTemps) ? (int) round(max($todayTemps)) : $temp;
    $tempMin = !empty($todayTemps) ? (int) round(min($todayTemps)) : $temp;

    return [
        'city'         => $cityConfig['slug'],
        'label'        => $cityConfig['label'],
        'temperature'  => $temp,
        'weather_code' => $mapped['code'],
        'symbol_code'  => $symbol,
        'wind_speed'   => $windSpeed,
        'temp_max'     => $tempMax,
        'temp_min'     => $tempMin,
        'source'       => 'MET Norway locationforecast 2.0',
        'attribution'  => 'Dane: MET Norway (CC BY 4.0)',
    ];
}

/**
 * Moduł DAILY7 z MET Norway (agregacja na 7 dni)
 */
function mo_build_daily7(array $met, array $cityConfig): ?array {
    $ts = $met['properties']['timeseries'] ?? [];
    if (empty($ts)) return null;

    $daysMap = [];
    $tzWarsaw = new DateTimeZone('Europe/Warsaw');
    $dayLabels = [
        1 => 'pn', 2 => 'wt', 3 => 'śr', 4 => 'cz', 5 => 'pt', 6 => 'so', 7 => 'nd'
    ];

    foreach ($ts as $pt) {
        $tStr = $pt['time'] ?? '';
        if (!$tStr) continue;
        $dt = (new DateTimeImmutable($tStr))->setTimezone($tzWarsaw);
        $dayKey = $dt->format('Y-m-d');

        if (!isset($daysMap[$dayKey])) {
            $daysMap[$dayKey] = [
                'date'          => $dayKey,
                'weekday_label' => $dayLabels[(int) $dt->format('N')],
                'temps'         => [],
                'precip'        => 0.0,
                'winds'         => [],
                'symbols'       => [],
            ];
        }

        $inst = $pt['data']['instant']['details'] ?? [];
        if (isset($inst['air_temperature'])) {
            $daysMap[$dayKey]['temps'][] = (float) $inst['air_temperature'];
        }
        if (isset($inst['wind_speed'])) {
            $daysMap[$dayKey]['winds'][] = (float) $inst['wind_speed'];
        }

        $p = $pt['data']['next_1_hours']['details']['precipitation_amount']
            ?? $pt['data']['next_6_hours']['details']['precipitation_amount']
            ?? 0.0;
        $daysMap[$dayKey]['precip'] += (float) $p;

        $s = $pt['data']['next_1_hours']['summary']['symbol_code']
            ?? $pt['data']['next_6_hours']['summary']['symbol_code']
            ?? null;
        if ($s) {
            $hour = (int) $dt->format('H');
            $daysMap[$dayKey]['symbols'][$hour] = $s;
        }
    }

    $outDays = [];
    $count = 0;
    foreach ($daysMap as $d) {
        if ($count >= 7) break;
        if (empty($d['temps'])) continue;

        $tMax = (int) round(max($d['temps']));
        $tMin = (int) round(min($d['temps']));
        $wMax = !empty($d['winds']) ? (int) round(max($d['winds']) * 3.6) : 0;
        $precip = round($d['precip'], 1);

        // Reprezentatywny symbol około południa (12-14) lub pierwszy dostępny
        $sym = $d['symbols'][12] ?? $d['symbols'][13] ?? $d['symbols'][11] ?? reset($d['symbols']) ?: 'cloudy';
        $mapped = mo_met_symbol_to_wmo($sym);

        $outDays[] = [
            'date'             => $d['date'],
            'weekday_label'    => $d['weekday_label'],
            'temp_max'         => $tMax,
            'temp_min'         => $tMin,
            'precipitation_mm' => $precip,
            'wind_speed_max'   => $wMax,
            'symbol_code'      => $sym,
            'weather_code'     => $mapped['code'],
            'label_text'       => $mapped['text'],
        ];
        $count++;
    }

    return [
        'city'        => $cityConfig['slug'],
        'label'       => $cityConfig['label'],
        'days'        => $outDays,
        'source'      => 'MET Norway locationforecast 2.0',
        'attribution' => 'Dane: MET Norway (CC BY 4.0)',
    ];
}

/**
 * Moduł NOWCAST (Alert opadów, wariant B darmowy MET Norway)
 */
function mo_build_nowcast(array $met, array $cityConfig): ?array {
    $ts = $met['properties']['timeseries'] ?? [];
    if (empty($ts)) return null;

    $tzWarsaw = new DateTimeZone('Europe/Warsaw');
    $series = [];
    $rainStartDt = null;
    $currentlyRaining = false;

    // Przeglądamy pierwsze 4 godziny
    for ($i = 0; $i < min(4, count($ts)); $i++) {
        $pt = $ts[$i];
        $tStr = $pt['time'] ?? '';
        $dt = (new DateTimeImmutable($tStr))->setTimezone($tzWarsaw);
        $p = (float) ($pt['data']['next_1_hours']['details']['precipitation_amount'] ?? 0.0);

        $series[] = [
            't'  => $dt->format(DateTimeInterface::RFC3339),
            'mm' => $p,
        ];

        if ($p >= 0.1) {
            if ($i === 0) {
                $currentlyRaining = true;
            } elseif ($rainStartDt === null && !$currentlyRaining) {
                $rainStartDt = $dt;
            }
        }
    }

    $now = new DateTimeImmutable('now', $tzWarsaw);
    if ($currentlyRaining) {
        $alert = [
            'active'    => true,
            'kind'      => 'ongoing',
            'eta_iso'   => $now->format(DateTimeInterface::RFC3339),
            'eta_local' => $now->format('H:00'),
            'minutes'   => 0,
            'text'      => 'Pada deszcz',
        ];
    } elseif ($rainStartDt !== null) {
        $hStart = $rainStartDt->format('H:00');
        $hEnd = $rainStartDt->modify('+1 hour')->format('H:00');
        $diffMin = max(0, (int) round(($rainStartDt->getTimestamp() - $now->getTimestamp()) / 60));
        $alert = [
            'active'    => true,
            'kind'      => 'starting',
            'eta_iso'   => $rainStartDt->format(DateTimeInterface::RFC3339),
            'eta_local' => $hStart,
            'minutes'   => $diffMin,
            'text'      => 'Opady możliwe między ' . $hStart . ' a ' . $hEnd,
        ];
    } else {
        $alert = [
            'active'    => false,
            'kind'      => 'none',
            'eta_iso'   => null,
            'eta_local' => null,
            'minutes'   => null,
            'text'      => 'Brak opadów w najbliższych 2 h',
        ];
    }

    return [
        'city'        => $cityConfig['slug'],
        'label'       => $cityConfig['label'],
        'alert'       => $alert,
        'series'      => $series,
        'source'      => 'MET Norway',
        'label_type'  => 'informacja o opadach',
        'attribution' => 'Dane: MET Norway (CC BY 4.0)',
    ];
}

/**
 * Moduł AIR: pomiary GIOŚ + prognoza IOŚ-PIB
 */
function mo_build_air(array $cityConfig, ?array $cached = null): ?array {
    $hasGios = !empty($cityConfig['has_gios']) && !empty($cityConfig['gios_station_id']);
    $stationId = $cityConfig['gios_station_id'] ?? null;
    $measurement = [
        'available'      => false,
        'source'         => null,
        'station_id'     => null,
        'station_name'   => null,
        'measured_at'    => null,
        'category'       => null,
        'category_index' => null,
        'advice'         => null,
        'label'          => null,
        'pollutants'     => [
            'pm10' => ['value' => null, 'unit' => 'µg/m³', 'index' => null, 'code' => null],
            'pm25' => ['value' => null, 'unit' => 'µg/m³', 'index' => null, 'code' => null],
            'no2'  => ['value' => null, 'unit' => 'µg/m³', 'index' => null],
        ],
    ];

    $giosSuccess = false;

    if ($hasGios && $stationId !== null) {
        $idxData = mo_fetch_gios_index((int) $stationId);
        $pm10Sensor = $cityConfig['sensors']['pm10'] ?? null;
        $pm25Sensor = $cityConfig['sensors']['pm25'] ?? null;

        $pm10Val = null;
        $pm10Date = null;
        $pm10Code = null;
        if ($pm10Sensor) {
            $pData = mo_fetch_gios_data((int) $pm10Sensor);
            if (is_array($pData)) {
                $rows = $pData['Lista danych pomiarowych'] ?? $pData['values'] ?? [];
                if (is_array($rows)) {
                    foreach ($rows as $row) {
                        $c = $row['Kod stanowiska'] ?? $row['code'] ?? null;
                        if ($c && !$pm10Code) $pm10Code = $c;
                        $v = $row['Wartość'] ?? $row['wartosc'] ?? $row['value'] ?? null;
                        if ($v !== null && $pm10Val === null) {
                            $pm10Val = round((float) $v, 2);
                            $pm10Date = (string) ($row['Data'] ?? $row['data'] ?? $row['date'] ?? '');
                            break;
                        }
                    }
                }
                if (!$pm10Code && isset($pData['key'])) $pm10Code = $pData['key'];

                // Pułapka 14: Weryfikacja kodu stanowiska — upewnij się, że kod odpowiada PM10
                if ($pm10Code !== null && stripos($pm10Code, 'PM10') === false) {
                    error_log("[WARN] Mismatch kodu stanowiska dla PM10 na stacji $stationId: $pm10Code");
                    $pm10Val = null;
                }
            }
        }

        $pm25Val = null;
        $pm25Date = null;
        $pm25Code = null;
        if ($pm25Sensor) {
            $pData = mo_fetch_gios_data((int) $pm25Sensor);
            if (is_array($pData)) {
                $rows = $pData['Lista danych pomiarowych'] ?? $pData['values'] ?? [];
                if (is_array($rows)) {
                    foreach ($rows as $row) {
                        $c = $row['Kod stanowiska'] ?? $row['code'] ?? null;
                        if ($c && !$pm25Code) $pm25Code = $c;
                        $v = $row['Wartość'] ?? $row['wartosc'] ?? $row['value'] ?? null;
                        if ($v !== null && $pm25Val === null) {
                            $pm25Val = round((float) $v, 2);
                            $pm25Date = (string) ($row['Data'] ?? $row['data'] ?? $row['date'] ?? '');
                            break;
                        }
                    }
                }
                if (!$pm25Code && isset($pData['key'])) $pm25Code = $pData['key'];

                // Pułapka 14: Weryfikacja kodu stanowiska — upewnij się, że kod odpowiada PM2.5 / PM25
                if ($pm25Code !== null && (stripos($pm25Code, 'PM25') === false && stripos($pm25Code, 'PM2.5') === false && stripos($pm25Code, 'PM2_5') === false)) {
                    error_log("[WARN] Mismatch kodu stanowiska dla PM2.5 na stacji $stationId: $pm25Code");
                    $pm25Val = null;
                }
            }
        }

        $aq = $idxData['AqIndex'] ?? $idxData;
        $catName = $aq['Nazwa kategorii indeksu'] ?? ($aq['stIndexLevel']['indexLevelName'] ?? null);
        $catIdx  = isset($aq['Wartość indeksu']) ? (int) $aq['Wartość indeksu'] : (isset($aq['stIndexLevel']['id']) ? (int) $aq['stIndexLevel']['id'] : null);
        $pm10Idx = isset($aq['Wartość indeksu dla wskaźnika PM10']) ? (int) $aq['Wartość indeksu dla wskaźnika PM10'] : (isset($aq['pm10IndexLevel']['id']) ? (int) $aq['pm10IndexLevel']['id'] : null);
        $pm25Idx = isset($aq['Wartość indeksu dla wskaźnika PM2.5']) ? (int) $aq['Wartość indeksu dla wskaźnika PM2.5'] : (isset($aq['pm25IndexLevel']['id']) ? (int) $aq['pm25IndexLevel']['id'] : null);
        $measuredAt = $pm10Date ?: $pm25Date ?: ($aq['Data danych źródłowych, z których policzono wartość indeksu dla wskaźnika st'] ?? ($aq['stSourceDataDate'] ?? null));

        if ($pm10Val !== null || $pm25Val !== null || $catName !== null) {
            $giosSuccess = true;
            $measuredHour = null;
            if ($measuredAt && preg_match('/(\d{2}:\d{2})/', $measuredAt, $mh)) {
                $measuredHour = $mh[1];
            }
            $stationLabel = $measuredHour ? "Pomiar ze stacji GIOŚ, $measuredHour" : "Pomiar ze stacji GIOŚ";

            $measurement = [
                'available'      => true,
                'source'         => 'gios',
                'station_id'     => $stationId,
                'station_name'   => $cityConfig['station_name'] ?? 'Stacja GIOŚ',
                'measured_at'    => $measuredAt,
                'category'       => $catName ?: 'Brak indeksu',
                'category_index' => $catIdx,
                'advice'         => $catIdx ? mo_air_advice($catIdx) : 'Pomiar ze stacji GIOŚ.',
                'label'          => $stationLabel,
                'pollutants'     => [
                    'pm10' => [
                        'value' => $pm10Val,
                        'unit'  => 'µg/m³',
                        'index' => $pm10Idx,
                        'code'  => $pm10Code,
                    ],
                    'pm25' => [
                        'value' => $pm25Val,
                        'unit'  => 'µg/m³',
                        'index' => $pm25Idx,
                        'code'  => $pm25Code,
                    ],
                    'no2' => [
                        'value' => null,
                        'unit'  => 'µg/m³',
                        'index' => null,
                    ],
                ],
            ];
        }
    }

    // Degradacja P0.3: jeśli stacja GIOŚ była skonfigurowana, ale zapytanie nie powiodło się
    if ($hasGios && !$giosSuccess) {
        // Krok 1: sprawdź stale cache (do 90 min)
        if ($cached !== null && !empty($cached['measurement']['available']) && (time() - (int)($cached['fetched_at'] ?? 0)) <= 5400) {
            $measurement = $cached['measurement'];
            $measurement['is_stale'] = true;
            $measurement['note'] = 'Dane ze stacji GIOŚ (ostatni znany odczyt)';
            $measurement['label'] = 'Pomiar ze stacji GIOŚ (ostatni odczyt)';
        } else {
            // Krok 2: stacja niedostępna -> oznacz brak pomiaru i przejdź do prognozy IOŚ-PIB
            $degradationMsg = 'Stacja pomiarowa GIOŚ chwilowo niedostępna — prezentowana prognoza jakości powietrza IOŚ-PIB';
            $measurement['available'] = false;
            $measurement['source'] = 'gios';
            $measurement['station_id'] = $stationId;
            $measurement['station_name'] = $cityConfig['station_name'] ?? 'Stacja GIOŚ';
            $measurement['note'] = $degradationMsg;
            $measurement['label'] = $degradationMsg;
        }
    }

    // Jeśli miasto nie ma stacji GIOŚ
    if (!$hasGios) {
        $noStationMsg = 'Brak aktywnej stacji GIOŚ — prezentowana prognoza jakości powietrza IOŚ-PIB';
        $measurement['available'] = false;
        $measurement['source'] = null;
        $measurement['station_id'] = null;
        $measurement['station_name'] = null;
        $measurement['note'] = $noStationMsg;
        $measurement['label'] = 'Prognoza jakości powietrza IOŚ-PIB';
    }

    // Prognoza IOŚ-PIB
    $teryt = (string) ($cityConfig['teryt'] ?? '');
    $iosRaw = $teryt ? mo_fetch_ios_forecast($teryt) : null;
    $forecastDays = [];

    if (is_array($iosRaw)) {
        foreach ($iosRaw as $k => $v) {
            if (is_array($v)) {
                $d = (string) ($v['data'] ?? $v['date'] ?? '');
                $val = (float) ($v['wartosc'] ?? $v['pm10'] ?? $v['value'] ?? 0.0);
                if ($d) $forecastDays[] = ['date' => $d, 'pm10' => round($val, 2)];
            } elseif (preg_match('/^(\d{4})(\d{2})(\d{2})$/', (string) $k, $m)) {
                $formattedDate = $m[1] . '-' . $m[2] . '-' . $m[3];
                $forecastDays[] = ['date' => $formattedDate, 'pm10' => round((float) $v, 2)];
            }
        }
    }

    $terytLevel = $cityConfig['teryt_level'] ?? 'city';
    $terytName  = $cityConfig['teryt_name'] ?? $cityConfig['label'];
    $forecastLabel = ($terytLevel === 'county')
        ? 'Prognoza IOŚ-PIB dla ' . $terytName
        : 'Prognoza IOŚ-PIB dla miasta ' . $terytName;

    // Jeśli pomiar jest niedostępny, ale mamy prognozę IOŚ-PIB, wyznacz kategorię i poradę z prognozy
    $forecastCat = null;
    $forecastCatIdx = null;
    $forecastAdvice = null;
    if (!$measurement['available'] && !empty($forecastDays)) {
        $p10Est = (float) $forecastDays[0]['pm10'];
        if ($p10Est <= 20) {
            $forecastCat = 'Bardzo dobry'; $forecastCatIdx = 1;
        } elseif ($p10Est <= 50) {
            $forecastCat = 'Dobry'; $forecastCatIdx = 2;
        } elseif ($p10Est <= 80) {
            $forecastCat = 'Umiarkowany'; $forecastCatIdx = 3;
        } elseif ($p10Est <= 110) {
            $forecastCat = 'Dostateczny'; $forecastCatIdx = 4;
        } elseif ($p10Est <= 150) {
            $forecastCat = 'Zły'; $forecastCatIdx = 5;
        } else {
            $forecastCat = 'Bardzo zły'; $forecastCatIdx = 6;
        }
        $forecastAdvice = mo_air_advice($forecastCatIdx);
    }

    return [
        'city'        => $cityConfig['slug'],
        'label'       => $cityConfig['label'],
        'measurement' => $measurement,
        'forecast'    => [
            'source'         => 'ios',
            'teryt'          => $teryt,
            'teryt_level'    => $terytLevel,
            'teryt_name'     => $terytName,
            'label'          => $forecastLabel,
            'category'       => $forecastCat,
            'category_index' => $forecastCatIdx,
            'advice'         => $forecastAdvice,
            'days'           => $forecastDays,
        ],
        'attribution' => ['GIOŚ / Państwowy Monitoring Środowiska', 'IOŚ-PIB'],
    ];
}

/* ---------- FLOW GLOWNY ---------- */

if (defined('MO_UNIT_TEST')) {
    return;
}

mo_cors();
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') {
    header('X-Content-Type-Options: nosniff');
    http_response_code(204);
    exit;
}
if (!in_array($method, ['GET', 'HEAD'], true)) mo_json(['error' => 'method not allowed'], 405);

$type = strtolower(trim((string) ($_GET['type'] ?? 'current')));
$validTypes = ['current', 'air', 'daily7', 'nowcast', 'health'];
if (!in_array($type, $validTypes, true)) {
    mo_json(['error' => 'unknown type', 'available' => $validTypes], 400);
}

// 1. Obsługa endpointu HEALTH
if ($type === 'health') {
    mo_json([
        'ok'           => true,
        'version'      => '2.0.0',
        'modules'      => [
            'current' => 'fresh',
            'air'     => 'fresh',
            'daily7'  => 'fresh',
            'nowcast' => 'fresh',
        ],
        'cities_count' => count($MO_CITIES),
    ]);
}

$city = strtolower(trim((string) ($_GET['city'] ?? '')));
if (!preg_match('/^[a-z0-9-]{2,32}$/', $city) || !isset($MO_CITIES[$city])) {
    mo_json(['error' => 'unknown city', 'available' => array_keys($MO_CITIES)], 400);
}

$dir = mo_cache_dir();
$cacheFile   = $dir . '/' . $type . '_' . $city . '.json';
$backoffFile = $dir . '/backoff_' . $type . '_' . $city . '.json';
$lockFile    = $dir . '/lock_' . $type . '_' . $city . '.lock';

$now = time();
$ttl = match ($type) {
    'air'     => MO_TTL_AIR,
    'daily7'  => MO_TTL_DAILY7,
    'nowcast' => MO_TTL_NOWCAST,
    default   => MO_TTL_CURRENT,
};

// Szybki odczyt cache
$cached = mo_read_cache($cacheFile);

if ($cached !== null && ($now - (int) $cached['fetched_at']) < $ttl) {
    // CACHE HIT — bezpłatny, nie obciąża rate limitera!
    $payload             = $cached;
    $payload['is_stale'] = false;
    $payload['cache']    = 'fresh';
} elseif (mo_is_in_backoff($backoffFile)) {
    // CIRCUIT BREAKER / NEGATIVE CACHE: Upstream niedawno padł -> natychmiast serve stale
    if ($cached !== null) {
        $payload             = $cached;
        $payload['is_stale'] = true;
        $payload['cache']    = 'stale';
    } else {
        header('Retry-After: ' . MO_BACKOFF_TTL);
        mo_json(['error' => 'upstream unavailable (circuit breaker active)', 'retry_after_seconds' => MO_BACKOFF_TTL], 503);
    }
} else {
    // CACHE MISS: Zliczamy do rate limitera
    mo_rate_limit($dir);

    // SINGLE-FLIGHT LOCK: Zapobiega thundering herd (P1.5: max-wait 2s, potem stale cache)
    $lockFh = @fopen($lockFile, 'c+');
    $gotLock = false;
    if ($lockFh) {
        $startTime = microtime(true);
        while ((microtime(true) - $startTime) < 2.0) {
            if (flock($lockFh, LOCK_EX | LOCK_NB)) {
                $gotLock = true;
                break;
            }
            usleep(100000); // 100 ms
        }

        if ($gotLock) {
            // Ponowne sprawdzenie cache po uzyskaniu blokady (być może inny proces właśnie zapisał)
            $cachedAgain = mo_read_cache($cacheFile);
            if ($cachedAgain !== null && (time() - (int) $cachedAgain['fetched_at']) < $ttl) {
                $payload             = $cachedAgain;
                $payload['is_stale'] = false;
                $payload['cache']    = 'fresh';
                flock($lockFh, LOCK_UN);
                fclose($lockFh);
                goto finalize_response;
            }
        } else {
            // Timeout 2 s oczekiwania na blokadę -> natychmiast stale cache jeśli dostępny
            fclose($lockFh);
            $lockFh = null;
            if ($cached !== null) {
                $payload             = $cached;
                $payload['is_stale'] = true;
                $payload['cache']    = 'stale';
                goto finalize_response;
            }
        }
    }

    // Pobranie danych w zależności od typu
    $cityConf = $MO_CITIES[$city];
    $liveData = null;

    if ($type === 'air') {
        $liveData = mo_build_air($cityConf, $cached);
    } else {
        $met = mo_fetch_met_norway((float) $cityConf['lat'], (float) $cityConf['lon']);
        if ($met !== null) {
            $liveData = match ($type) {
                'daily7'  => mo_build_daily7($met, $cityConf),
                'nowcast' => mo_build_nowcast($met, $cityConf),
                default   => mo_build_current($met, $cityConf),
            };
        }
    }

    if ($liveData !== null) {
        mo_clear_backoff($backoffFile);
        $payload = array_merge($liveData, [
            'fetched_at' => $now,
            'is_stale'   => false,
            'cache'      => 'live',
        ]);
        mo_write_cache($cacheFile, $payload);
    } else {
        // Awaria upstreamu: aktywacja circuit breakera (negative cache)
        mo_set_backoff($backoffFile);
        if ($cached !== null) {
            $payload             = $cached;
            $payload['is_stale'] = true;
            $payload['cache']    = 'stale';
        } else {
            if ($lockFh && $gotLock) { flock($lockFh, LOCK_UN); fclose($lockFh); }
            header('Retry-After: 300');
            mo_json(['error' => 'service temporarily unavailable', 'retry_after_seconds' => 300], 503);
        }
    }

    if ($lockFh && $gotLock) {
        flock($lockFh, LOCK_UN);
        fclose($lockFh);
    }
}

finalize_response:

$payload['last_updated_timestamp'] = (int) ($payload['fetched_at'] ?? $now);

// ETag bez dynamicznego server_time w ciele odpowiedzi
$body = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
$etag = '"' . md5($body) . '"';

header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: strict-origin-when-cross-origin');
header('Server-Time: ' . time());
header('Cache-Control: public, max-age=' . MO_HTTP_MAXAGE);
header('ETag: ' . $etag);

if (trim($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
    http_response_code(304);
    exit;
}

header('Content-Type: application/json; charset=utf-8');
echo $body;
