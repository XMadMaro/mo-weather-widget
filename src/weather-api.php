<?php
declare(strict_types=1);

/**
 * MO Weather Widget — proxy backend z cache (PHP 8.1+)
 * Wersja: 1.0.0
 *
 * Decyzje architektoniczne (po audycie bezpieczeństwa):
 *  - przyjmuje WYŁĄCZNIE id miasta z allowlisty (brak dowolnych lat/lon => brak open-relay),
 *  - cache per miasto, zapis atomowy (tmp+rename) + flock => brak uszkodzonych odczytów,
 *  - cache POZA webrootem (../var/cache) + .htaccess "Require all denied",
 *  - CORS z dopasowaniem po granicy kropki (zlyslazag.pl NIE przejdzie jako slazag.pl),
 *  - rate limiting per hash IP (stałe okno 60 s, fail-open przy błędzie FS),
 *  - graceful degradation: API pada => stary cache z is_stale=true, nigdy exception w UI.
 */

error_reporting(E_ALL);
ini_set('display_errors', '0');   // zero wycieku szczegółów do klienta
ini_set('log_errors', '1');

/* ---------- KONFIGURACJA ---------- */

const MO_ALLOWED_ORIGINS = ['slazag.pl', 'mediaoperator.pl'];

const MO_CITIES = [
    'katowice'  => ['lat' => 50.2649, 'lon' => 19.0238, 'label' => 'Katowice'],
    'gliwice'   => ['lat' => 50.2945, 'lon' => 18.6714, 'label' => 'Gliwice'],
    'sosnowiec' => ['lat' => 50.2862, 'lon' => 19.1041, 'label' => 'Sosnowiec'],
    'bytom'     => ['lat' => 50.3484, 'lon' => 18.9158, 'label' => 'Bytom'],
    'zabrze'    => ['lat' => 50.3249, 'lon' => 18.7856, 'label' => 'Zabrze'],
];

const MO_CACHE_TTL   = 3600;  // świeżość cache: 60 min
const MO_HTTP_MAXAGE = 300;   // Cache-Control dla przeglądarki/CDN
const MO_RATE_MAX    = 30;    // requestów na okno
const MO_RATE_WINDOW = 60;    // sekund
const MO_API_TIMEOUT = 8;     // timeout curl (s)
const MO_API_CONNECT = 3;     // timeout połączenia (s)

/* ---------- HELPERS ---------- */

function mo_json(mixed $data, int $code = 200): never {
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function mo_cache_dir(): string {
    // Poza webrootem: jeśli weather-api.php leży w public_html/, cache trafia do public_html/../var/cache
    $dir = dirname(__DIR__) . '/var/cache';
    if (!is_dir($dir) && !@mkdir($dir, 0775, true)) {
        $dir = __DIR__ . '/.cache'; // fallback + ochrona .htaccess
        if (!is_dir($dir)) @mkdir($dir, 0775, true);
    }
    if (!is_file($dir . '/.htaccess')) @file_put_contents($dir . '/.htaccess', "Require all denied\n");
    return $dir;
}

/** CORS: match po granicy kropki, case-insensitive. Zwraca false => 403. */
function mo_cors(): void {
    header('Vary: Origin');
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin === '') return; // curl / server-to-server: nagłówki CORS niepotrzebne
    $host = parse_url($origin, PHP_URL_HOST);
    if (!is_string($host)) mo_json(['error' => 'bad origin'], 403);
    $host = strtolower($host);

    $allowed = MO_ALLOWED_ORIGINS;
    if (getenv('APP_ENV') === 'development' || ($_SERVER['APP_ENV'] ?? '') === 'development') {
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

/** Rate limit: stałe okno, plik per hash IP, flock. Fail-open przy błędzie FS. */
function mo_rate_limit(string $dir): void {
    $ip   = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    $file = $dir . '/rl_' . substr(hash('sha256', $ip . '|mo-weather'), 0, 16) . '.json';
    $now  = time();
    $fh   = @fopen($file, 'c+');
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

/** Zapis atomowy: tmp + rename => czytelnik nigdy nie zobaczy połowy JSON-a. */
function mo_write_cache(string $path, array $data): void {
    $tmp = $path . '.' . getmypid() . '.tmp';
    if (@file_put_contents($tmp, json_encode($data, JSON_UNESCAPED_UNICODE)) !== false) {
        rename($tmp, $path);
    }
}

/** Open-Meteo, model icon_d2. Null przy jakimkolwiek błędzie (timeout/HTTP/JSON). */
function mo_fetch_meteo(float $lat, float $lon): ?array {
    $url = 'https://api.open-meteo.com/v1/forecast?' . http_build_query([
        'latitude'      => $lat,
        'longitude'     => $lon,
        'models'        => 'icon_seamless',
        'timezone'      => 'Europe/Warsaw',
        'forecast_days' => 1,
        'current'       => 'temperature_2m,weather_code,wind_speed_10m',
        'daily'         => 'temperature_2m_max,temperature_2m_min',
    ]);
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => MO_API_TIMEOUT,
        CURLOPT_CONNECTTIMEOUT => MO_API_CONNECT,
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_USERAGENT      => 'mo-weather-proxy/1.0',
    ]);
    $raw  = curl_exec($ch);
    $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if (!is_string($raw) || $code !== 200) return null;
    $j = json_decode($raw, true);
    if (!is_array($j) || !isset($j['current']['temperature_2m'])) return null;
    return [
        'temperature'  => (int) round((float) $j['current']['temperature_2m']),
        'weather_code' => (int) $j['current']['weather_code'],
        'wind_speed'   => (int) round((float) $j['current']['wind_speed_10m']),
        'temp_max'     => isset($j['daily']['temperature_2m_max'][0]) ? (int) round((float) $j['daily']['temperature_2m_max'][0]) : null,
        'temp_min'     => isset($j['daily']['temperature_2m_min'][0]) ? (int) round((float) $j['daily']['temperature_2m_min'][0]) : null,
    ];
}

/* ---------- FLOW ---------- */

mo_cors();
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
if ($method === 'OPTIONS') { http_response_code(204); exit; }
if (!in_array($method, ['GET', 'HEAD'], true)) mo_json(['error' => 'method not allowed'], 405);

$dir = mo_cache_dir();
mo_rate_limit($dir);

$city = strtolower(trim((string) ($_GET['city'] ?? '')));
if (!preg_match('/^[a-z0-9-]{2,32}$/', $city) || !isset(MO_CITIES[$city])) {
    mo_json(['error' => 'unknown city', 'available' => array_keys(MO_CITIES)], 400);
}

$cacheFile = $dir . '/city_' . $city . '.json';
$cached    = mo_read_cache($cacheFile);
$now       = time();

if ($cached !== null && ($now - (int) $cached['fetched_at']) < MO_CACHE_TTL) {
    // Świeży cache (< 60 min) — serwujemy bez dotykania API
    $payload         = $cached;
    $payload['is_stale'] = false;
    $payload['cache']    = 'fresh';
} else {
    $live = mo_fetch_meteo(MO_CITIES[$city]['lat'], MO_CITIES[$city]['lon']);
    if ($live !== null) {
        $payload = array_merge([
            'city'        => $city,
            'label'       => MO_CITIES[$city]['label'],
            'fetched_at'  => $now,
            'source'      => 'open-meteo icon_seamless',
            'attribution' => 'Dane pogodowe: Open-Meteo.com (CC-BY 4.0)',
        ], $live);
        $payload['is_stale'] = false;
        $payload['cache']    = 'live';
        mo_write_cache($cacheFile, $payload);
    } elseif ($cached !== null) {
        // GRACEFUL DEGRADATION: API padło => stary cache + flaga, zero błędu w UI
        $payload         = $cached;
        $payload['is_stale'] = true;
        $payload['cache']    = 'stale';
    } else {
        header('Retry-After: 300');
        mo_json(['error' => 'weather unavailable', 'retry_after_seconds' => 300], 503);
    }
}

$payload['last_updated_timestamp'] = (int) $payload['fetched_at'];
$payload['server_time']            = $now;

$body = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
$etag = '"' . md5($body) . '"';
header('Cache-Control: public, max-age=' . MO_HTTP_MAXAGE);
header('ETag: ' . $etag);
if (trim($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) { http_response_code(304); exit; }

header('Content-Type: application/json; charset=utf-8');
echo $body;
