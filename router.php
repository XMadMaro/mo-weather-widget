<?php
declare(strict_types=1);

/**
 * MO Weather Widget — router dla serwera wbudowanego PHP (PHP CLI / Railway)
 * Obsługuje żądania /api/weather bez wymogu mod_rewrite lub Nginx.
 */

$uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';

// 0. Opcjonalne zabezpieczenie Basic Auth (env: MO_DEMO_AUTH="user:pass")
// Wykluczenie: /api/weather?type=health pozostaje publiczne dla healthchecków (np. Railway)
$authEnv = getenv('MO_DEMO_AUTH');
$isHealthCheck = in_array($uri, ['/api/weather', '/api/weather.php', '/api', '/api/'], true)
    && (($_GET['type'] ?? '') === 'health');

if (!empty($authEnv) && !$isHealthCheck) {
    $expected = explode(':', (string)$authEnv, 2);
    $authUser = $_SERVER['PHP_AUTH_USER'] ?? '';
    $authPass = $_SERVER['PHP_AUTH_PW'] ?? '';

    if (count($expected) !== 2 || $authUser !== $expected[0] || $authPass !== $expected[1]) {
        header('WWW-Authenticate: Basic realm="MO Weather Widget Demo"');
        header('HTTP/1.0 401 Unauthorized');
        header('Content-Type: text/plain; charset=utf-8');
        echo "401 Unauthorized: Wymagana autoryzacja do wersji demonstracyjnej.\n";
        exit;
    }
}

// 1. Endpoint API pogody: /api/weather, /api/weather.php, /api/
if ($uri === '/api/weather' || $uri === '/api/weather.php' || $uri === '/api' || $uri === '/api/') {
    require __DIR__ . '/src/weather-api.php';
    return true;
}

// 2. Obsługa plików statycznych w public/ (np. /assets/weather-widget.min.js, ikony, grafiki)
$publicPath = __DIR__ . '/public' . $uri;
if ($uri !== '/' && is_file($publicPath)) {
    return false; // PHP built-in server sam serwuje plik statyczny
}

// 3. Strona główna oraz odpowiedzi HTML — ochrona przed indeksowaniem przez roboty
if ($uri === '/' || is_file(__DIR__ . '/public/index.html')) {
    header('X-Robots-Tag: noindex, nofollow, noarchive');
    require __DIR__ . '/public/index.html';
    return true;
}

return false;
