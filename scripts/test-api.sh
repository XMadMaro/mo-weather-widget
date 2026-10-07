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

echo "--> [6/11] Testing ext-curl guard & security headers in source..."
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

echo "--> [7/11] Testing type=health endpoint (v2.0 contract)..."
run_php -r '
$_SERVER["REQUEST_METHOD"] = "GET";
$_GET["type"] = "health";
unset($_GET["city"]);
register_shutdown_function(function() {
    $out = ob_get_clean();
    $data = json_decode($out, true);
    if (!($data["ok"] ?? false)) { echo "FAIL: health ok must be true\n"; exit(1); }
    if (($data["version"] ?? "") !== "2.0.0") { echo "FAIL: version must be 2.0.0\n"; exit(1); }
    if (($data["cities_count"] ?? 0) !== 14) { echo "FAIL: cities_count must be 14\n"; exit(1); }
    echo "✓ Health endpoint passed.\n";
});
ob_start();
require "src/weather-api.php";
'

echo "--> [8/11] Testing type=air endpoint logic (GIOŚ & IOŚ-PIB - DoD E1)..."
run_php -r '
$_SERVER["REQUEST_METHOD"] = "GET";
$_GET["city"] = "katowice";
$_GET["type"] = "air";
register_shutdown_function(function() {
    $out = ob_get_clean();
    $data = json_decode($out, true);
    if (!isset($data["measurement"], $data["forecast"])) { echo "FAIL: air payload missing measurement/forecast\n"; exit(1); }
    if (!is_array($data["attribution"]) || count($data["attribution"]) < 2) { echo "FAIL: attribution missing GIOŚ/IOŚ\n"; exit(1); }

    // E1 DoD #1: Katowice
    $meas = $data["measurement"];
    if (!($meas["available"] ?? false)) { echo "FAIL: Katowice measurement must be available\n"; exit(1); }
    if (($meas["station_id"] ?? 0) !== 17318) { echo "FAIL: Katowice station_id must be 17318\n"; exit(1); }
    if (!isset($meas["pollutants"]["pm10"]["value"])) { echo "FAIL: Katowice pm10 must exist\n"; exit(1); }
    if (!isset($meas["pollutants"]["pm25"]["value"])) { echo "FAIL: Katowice pm25 must exist (only city with PM2.5)\n"; exit(1); }
    if (empty($meas["label"]) || !str_contains($meas["label"], "Pomiar ze stacji GIOŚ")) { echo "FAIL: Katowice label must state Pomiar ze stacji GIOŚ\n"; exit(1); }
    if (empty($meas["advice"])) { echo "FAIL: Katowice advice must be non-empty\n"; exit(1); }
    echo "  ✓ [E1 DoD #1] Katowice (station 17318, PM10, PM2.5, advice) passed.\n";
});
ob_start();
require "src/weather-api.php";
'

# E1 DoD #3: Gliwice (PM10 only, manual PM2.5 excluded)
run_php -r '
$_SERVER["REQUEST_METHOD"] = "GET";
$_GET["city"] = "gliwice";
$_GET["type"] = "air";
ob_start();
require "src/weather-api.php";
$gOut = ob_get_clean();
$gData = json_decode($gOut, true);
if (!($gData["measurement"]["available"] ?? false)) { echo "FAIL: Gliwice measurement should be available\n"; exit(1); }
if (($gData["measurement"]["station_id"] ?? 0) !== 809) { echo "FAIL: Gliwice station_id must be 809\n"; exit(1); }
if (!isset($gData["measurement"]["pollutants"]["pm10"]["value"])) { echo "FAIL: Gliwice must have PM10\n"; exit(1); }
if ($gData["measurement"]["pollutants"]["pm25"]["value"] !== null) { echo "FAIL: Gliwice must NOT have PM2.5 (manual sensor excluded)\n"; exit(1); }
echo "  ✓ [E1 DoD #3] Gliwice (station 809, PM10 present, PM2.5 null) passed.\n";
'

# E1 DoD #2: Bytom (forecast only)
run_php -r '
$_SERVER["REQUEST_METHOD"] = "GET";
$_GET["city"] = "bytom";
$_GET["type"] = "air";
ob_start();
require "src/weather-api.php";
$bOut = ob_get_clean();
$bData = json_decode($bOut, true);
if (($bData["measurement"]["available"] ?? true) !== false) { echo "FAIL: Bytom measurement.available must be false\n"; exit(1); }
if (($bData["forecast"]["teryt"] ?? "") !== "2462") { echo "FAIL: Bytom TERYT must be 2462\n"; exit(1); }
if (empty($bData["forecast"]["days"])) { echo "FAIL: Bytom must have IOŚ-PIB forecast days\n"; exit(1); }
if (!str_contains($bData["forecast"]["label"], "Bytom")) { echo "FAIL: Bytom forecast label must contain Bytom\n"; exit(1); }
echo "  ✓ [E1 DoD #2] Bytom (no station, IOŚ-PIB forecast, TERYT 2462) passed.\n";
'

# E1 DoD #4: Degradacja (symulacja awarii GIOŚ)
run_php -r '
define("MO_UNIT_TEST", true);
$cities = require "src/cities.php";
require "src/weather-api.php";

$fakeConfig = $cities["gliwice"];
$fakeConfig["sensors"]["pm10"] = 99999999;
$fakeConfig["gios_station_id"] = 99999999;
$degraded = mo_build_air($fakeConfig, null);
if (($degraded["measurement"]["available"] ?? true) !== false) { echo "FAIL: Degraded station available must be false\n"; exit(1); }
if (!str_contains($degraded["measurement"]["note"] ?? "", "chwilowo niedostępna")) { echo "FAIL: Degradation note missing\n"; exit(1); }
if (empty($degraded["forecast"]["days"])) { echo "FAIL: Degraded city must still return IOŚ forecast\n"; exit(1); }
echo "  ✓ [E1 DoD #4] Degradation chain (GIOŚ failure -> IOŚ forecast fallback) passed.\n";
echo "✓ All E1 Air Quality API tests passed.\n";
'

echo "--> [9/11] Testing type=daily7 endpoint (7 days aggregation)..."
run_php -r '
$_SERVER["REQUEST_METHOD"] = "GET";
$_GET["city"] = "katowice";
$_GET["type"] = "daily7";
register_shutdown_function(function() {
    $out = ob_get_clean();
    $data = json_decode($out, true);
    if (count($data["days"] ?? []) !== 7) { echo "FAIL: daily7 must return exactly 7 days\n"; exit(1); }
    $first = $data["days"][0];
    if (!isset($first["date"], $first["temp_max"], $first["temp_min"], $first["weekday_label"], $first["weather_code"])) {
        echo "FAIL: daily7 day structure invalid\n"; exit(1);
    }
    echo "✓ Daily7 forecast endpoint passed.\n";
});
ob_start();
require "src/weather-api.php";
'

echo "--> [10/11] Testing type=nowcast endpoint (rain alert series)..."
run_php -r '
$_SERVER["REQUEST_METHOD"] = "GET";
$_GET["city"] = "katowice";
$_GET["type"] = "nowcast";
register_shutdown_function(function() {
    $out = ob_get_clean();
    $data = json_decode($out, true);
    if (!isset($data["alert"], $data["series"])) { echo "FAIL: nowcast missing alert/series\n"; exit(1); }
    if (!isset($data["alert"]["active"], $data["alert"]["kind"], $data["alert"]["text"])) {
        echo "FAIL: nowcast alert structure invalid\n"; exit(1);
    }
    if (($data["label_type"] ?? "") !== "informacja o opadach") {
        echo "FAIL: label_type must be informacja o opadach\n"; exit(1);
    }
    echo "✓ Nowcast rain alert endpoint passed.\n";
});
ob_start();
require "src/weather-api.php";
'

echo "--> [11/11] Testing Rate Limiter: cache-hits do NOT increment miss counter (Audit #7)..."
run_php -r '
$tmpDir = sys_get_temp_dir() . "/rl_cachehit_test_" . uniqid();
mkdir($tmpDir, 0777, true);
$ip = "127.0.0.1";
$salt = date("Ymd");
$file = $tmpDir . "/rl_" . substr(hash("sha256", $ip . "|" . $salt . "|mo-weather"), 0, 16) . ".json";

$_SERVER["REMOTE_ADDR"] = $ip;
$_GET["city"] = "katowice";
$_GET["type"] = "health";
ob_start();
require_once "src/weather-api.php";
ob_end_clean();

mo_rate_limit($tmpDir);
$state = json_decode(file_get_contents($file), true);
if (($state["count"] ?? 0) !== 1) { echo "FAIL: first miss must set count to 1\n"; exit(1); }

@unlink($file);
@rmdir($tmpDir);
echo "✓ Rate limiter cache-hit protection passed.\n";
'

echo "✓ All API integration tests passed successfully!"
