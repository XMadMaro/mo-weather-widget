<?php
declare(strict_types=1);

/**
 * MO Weather Widget — endpoint radaru burzowego /api/radar (PHP 8.1+)
 *
 *   GET /api/radar?manifest               -> JSON: status, lista klatek, bbox (Cache-Control 60 s, ETag)
 *   GET /api/radar?frame=YYYYMMDDTHHMM    -> PNG 704×676 w EPSG:3857 (immutable, 24 h)
 *
 * Endpoint tylko serwuje pliki przygotowane przez scripts/radar-worker.php (MO_RADAR_MODE=producer).
 * Nie przyjmuje współrzędnych ani adresów od klienta: klatka to wyłącznie znacznik czasu,
 * sprawdzany wyrażeniem regularnym i poprawnością daty, a plik musi leżeć w katalogu radaru.
 * CORS, nagłówki bezpieczeństwa i katalog cache są wspólne z weather-api.php.
 */

if (!defined('MO_LIB_ONLY')) {
    define('MO_LIB_ONLY', true);
}
require_once __DIR__ . '/weather-api.php';
require_once __DIR__ . '/radar-lib.php';

function mo_radar_api_main(): never
{
    mo_cors();
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method === 'OPTIONS') {
        header('X-Content-Type-Options: nosniff');
        http_response_code(204);
        exit;
    }
    if (!in_array($method, ['GET', 'HEAD'], true)) {
        mo_json(['error' => 'method not allowed'], 405);
    }
    if (mo_radar_mode() !== 'producer') {
        mo_json(['status' => 'off', 'error' => 'radar disabled'], 404);
    }
    $dir = mo_radar_dir(mo_cache_dir());

    if (isset($_GET['frame'])) {
        $t = (string) $_GET['frame'];
        $file = $dir . '/radar_' . $t . '.png';
        if (!mo_radar_valid_t($t) || !is_file($file)) {
            mo_json(['error' => 'unknown frame'], 404);
        }
        $size = (int) filesize($file);
        $etag = '"' . $t . '-' . $size . '"';
        header('X-Content-Type-Options: nosniff');
        header('Content-Type: image/png');
        header('Cache-Control: public, max-age=86400, immutable');
        header('ETag: ' . $etag);
        if (trim($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
            http_response_code(304);
            exit;
        }
        header('Content-Length: ' . $size);
        if ($method !== 'HEAD') {
            readfile($file);
        }
        exit;
    }

    $payload = mo_radar_public_manifest(mo_radar_read_manifest($dir), time());
    $body = (string) json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    $etag = '"' . md5($body) . '"';
    header('X-Content-Type-Options: nosniff');
    header('Referrer-Policy: strict-origin-when-cross-origin');
    header('Server-Time: ' . time());
    header('Cache-Control: public, max-age=60');
    header('ETag: ' . $etag);
    if (trim($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) {
        http_response_code(304);
        exit;
    }
    header('Content-Type: application/json; charset=utf-8');
    if ($method !== 'HEAD') {
        echo $body;
    }
    exit;
}

if (defined('MO_UNIT_TEST')) {
    return;
}

mo_radar_api_main();
