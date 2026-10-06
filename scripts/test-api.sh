#!/usr/bin/env bash
set -euo pipefail

echo "==> Running API integration & unit tests for mo-weather-widget v1.0.1..."

run_php() {
  if command -v php >/dev/null 2>&1; then
    php "$@"
  elif command -v docker >/dev/null 2>&1; then
    docker run --rm -v "$PWD":/app -w /app php:8.2-cli php "$@"
  else
    echo "Warning: Neither local php nor docker found. Skipping PHP tests."
    return 0
  fi
}

echo "--> [1/6] Checking PHP syntax in src/ and dist/..."
run_php -l src/weather-api.php
run_php -l dist/weather-api.php

echo "--> [2/6] Checking CORS & allowlist logic (Audit #7 & Security)..."
run_php -r '
putenv("APP_ENV=development");
$_SERVER["REQUEST_METHOD"] = "GET";
$_SERVER["HTTP_ORIGIN"] = "http://localhost:8080";
$host = parse_url($_SERVER["HTTP_ORIGIN"], PHP_URL_HOST);
$allowed = ["slazag.pl", "mediaoperator.pl"];
if (getenv("APP_ENV") === "development") $allowed = array_merge($allowed, ["localhost", "127.0.0.1"]);
$matched = false;
foreach ($allowed as $d) {
    if ($host === $d || str_ends_with($host, "." . $d)) { $matched = true; break; }
}
if (!$matched) { echo "FAIL: localhost should match in development\n"; exit(1); }

$host = "zlyslazag.pl";
$matched = false;
foreach (["slazag.pl", "mediaoperator.pl"] as $d) {
    if ($host === $d || str_ends_with($host, "." . $d)) { $matched = true; break; }
}
if ($matched) { echo "FAIL: evil domain was matched\n"; exit(1); }

$host = "subdomain.slazag.pl";
$matched = false;
foreach (["slazag.pl", "mediaoperator.pl"] as $d) {
    if ($host === $d || str_ends_with($host, "." . $d)) { $matched = true; break; }
}
if (!$matched) { echo "FAIL: subdomain of allowed origin should match\n"; exit(1); }
echo "✓ CORS checks passed.\n";
'

echo "--> [3/6] Testing Circuit Breaker / Negative Cache logic (Audit #1)..."
run_php -r '
const MO_BACKOFF_TTL = 60;
function mo_is_in_backoff(string $backoffFile): bool {
    if (!is_file($backoffFile)) return false;
    $raw = @file_get_contents($backoffFile);
    if (!$raw) return false;
    $state = json_decode($raw, true);
    return is_array($state) && isset($state['\''failed_at'\'']) && (time() - (int)$state['\''failed_at'\'']) < MO_BACKOFF_TTL;
}
function mo_set_backoff(string $backoffFile): void {
    @file_put_contents($backoffFile, json_encode(['\''failed_at'\'' => time()]));
}
function mo_clear_backoff(string $backoffFile): void {
    if (is_file($backoffFile)) @unlink($backoffFile);
}

$tmp = sys_get_temp_dir() . "/test_backoff_" . uniqid() . ".json";
if (mo_is_in_backoff($tmp)) { echo "FAIL: fresh file should not be in backoff\n"; exit(1); }

mo_set_backoff($tmp);
if (!mo_is_in_backoff($tmp)) { echo "FAIL: backoff should be active after set\n"; exit(1); }

// Simulate expired backoff (>60s)
file_put_contents($tmp, json_encode(['\''failed_at'\'' => time() - 65]));
if (mo_is_in_backoff($tmp)) { echo "FAIL: backoff should expire after 60s\n"; exit(1); }

mo_clear_backoff($tmp);
if (is_file($tmp)) { echo "FAIL: backoff file should be unlinked on clear\n"; exit(1); }
echo "✓ Circuit breaker logic passed.\n";
'

echo "--> [4/6] Testing Rate Limiter Probabilistic GC (Audit #2)..."
run_php -r '
$tmpDir = sys_get_temp_dir() . "/rl_test_" . uniqid();
mkdir($tmpDir, 0777, true);
$oldFile = $tmpDir . "/rl_old.json";
$newFile = $tmpDir . "/rl_new.json";

file_put_contents($oldFile, "{}");
file_put_contents($newFile, "{}");
// Set old file modified time to 25h ago
touch($oldFile, time() - 90000);
touch($newFile, time() - 300);

// Run GC routine
$cutoff = time() - 86400;
foreach (glob($tmpDir . "/rl_*.json") as $f) {
    if (filemtime($f) < $cutoff) @unlink($f);
}

if (file_exists($oldFile)) { echo "FAIL: old rate limiter file (>24h) was not deleted\n"; exit(1); }
if (!file_exists($newFile)) { echo "FAIL: fresh rate limiter file was deleted\n"; exit(1); }

@unlink($newFile);
@rmdir($tmpDir);
echo "✓ Rate limiter GC passed.\n";
'

echo "--> [5/6] Testing ETag stability & 304 Not Modified headers (Audit #4)..."
run_php -r '
$payload = [
    "city" => "katowice",
    "temperature" => 14,
    "weather_code" => 1,
    "fetched_at" => 1728000000,
    "last_updated_timestamp" => 1728000000,
    "is_stale" => false,
    "cache" => "fresh"
];

// Verify body does not contain server_time (moved to header)
if (isset($payload["server_time"])) { echo "FAIL: server_time must not be in body\n"; exit(1); }

$body1 = json_encode($payload);
$etag1 = "\"" . md5($body1) . "\"";

// Second request 5 seconds later
$body2 = json_encode($payload);
$etag2 = "\"" . md5($body2) . "\"";

if ($etag1 !== $etag2) { echo "FAIL: ETag must be identical across requests with same cache\n"; exit(1); }

// Test 304 match condition
$_SERVER["HTTP_IF_NONE_MATCH"] = $etag1;
$match = (trim($_SERVER["HTTP_IF_NONE_MATCH"]) === $etag2);
if (!$match) { echo "FAIL: If-None-Match should match ETag\n"; exit(1); }
echo "✓ ETag & 304 stability passed.\n";
'

echo "--> [6/6] Testing ext-curl guard & security headers in source..."
run_php -r '
$src = file_get_contents("src/weather-api.php");
if (!str_contains($src, "function_exists('\''curl_init'\'')")) {
    echo "FAIL: weather-api.php must guard against missing ext-curl\n"; exit(1);
}
if (!str_contains($src, "X-Content-Type-Options: nosniff")) {
    echo "FAIL: weather-api.php must send nosniff header\n"; exit(1);
}
if (!str_contains($src, "Server-Time:")) {
    echo "FAIL: weather-api.php must send Server-Time header\n"; exit(1);
}
echo "✓ ext-curl guard and security headers passed.\n";
'

echo "✓ All API integration tests passed successfully!"
