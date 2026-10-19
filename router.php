<?php
declare(strict_types=1);

/**
 * MO Weather Widget — router dla serwera wbudowanego PHP (PHP CLI / Railway)
 * Obsługuje żądania /api/weather bez wymogu mod_rewrite lub Nginx.
 */

$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

// 1. Endpoint API pogody: /api/weather, /api/weather.php, /api/
if ($uri === '/api/weather' || $uri === '/api/weather.php' || $uri === '/api' || $uri === '/api/') {
    require __DIR__ . '/src/weather-api.php';
    return true;
}

// 1b. Radar burzowy: /api/radar (manifest i klatki PNG przygotowane przez scripts/radar-worker.php)
if ($uri === '/api/radar' || $uri === '/api/radar.php') {
    require __DIR__ . '/src/radar-api.php';
    return true;
}

// 2. Obsługa plików statycznych w public/ (np. /assets/weather-widget.min.js, ikony, grafiki)
$publicPath = __DIR__ . '/public' . $uri;
if ($uri !== '/' && $uri !== '/index.html' && is_file($publicPath)) {
    return false; // PHP built-in server sam serwuje plik statyczny
}

// 3. Strona główna oraz odpowiedzi HTML — opcjonalny Basic Auth (env: MO_DEMO_AUTH="user:pass") + noindex
if ($uri === '/' || $uri === '/index.html' || is_file(__DIR__ . '/public/index.html')) {
    $authEnv = getenv('MO_DEMO_AUTH');
    if (!empty($authEnv)) {
        $expected = explode(':', (string) $authEnv, 2);
        $authUser = $_SERVER['PHP_AUTH_USER'] ?? '';
        $authPass = $_SERVER['PHP_AUTH_PW'] ?? '';

        if (count($expected) !== 2 || !hash_equals($expected[0], $authUser) || !hash_equals($expected[1], $authPass)) {
            header('WWW-Authenticate: Basic realm="MO Weather Widget Demo"');
            header('HTTP/1.0 401 Unauthorized');
            header('Content-Type: text/plain; charset=utf-8');
            echo "401 Unauthorized: Wymagana autoryzacja do wersji demonstracyjnej.\n";
            exit;
        }
    }
    header('X-Robots-Tag: noindex, nofollow, noarchive');
    require __DIR__ . '/public/index.html';
    return true;
}

return false;
