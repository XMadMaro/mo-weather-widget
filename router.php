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

// 2. Obsługa plików statycznych w public/ (np. /assets/weather-widget.min.js, ikony, grafiki)
$publicPath = __DIR__ . '/public' . $uri;
if ($uri !== '/' && is_file($publicPath)) {
    return false; // PHP built-in server sam serwuje plik statyczny
}

// 3. Strona główna oraz fallback
if ($uri === '/' || is_file(__DIR__ . '/public/index.html')) {
    require __DIR__ . '/public/index.html';
    return true;
}

return false;
