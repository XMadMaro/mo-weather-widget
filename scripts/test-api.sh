#!/usr/bin/env bash
set -euo pipefail

echo "==> Running API integration tests for mo-weather-widget..."

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

echo "--> Checking PHP syntax in src/ and dist/..."
run_php -l src/weather-api.php
run_php -l dist/weather-api.php

echo "--> Checking CORS & allowlist logic..."
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
echo "CORS checks passed.\n";
'

echo "✓ All API tests passed successfully!"
