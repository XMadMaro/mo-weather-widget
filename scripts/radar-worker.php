<?php
declare(strict_types=1);

/**
 * MO Weather Widget — producent klatek radaru (EUMETNET OPERA -> PNG + manifest.json dla /api/radar).
 *
 * Na Railway uruchamia go Dockerfile w pętli, gdy MO_RADAR_MODE=producer:
 *   while true; do php scripts/radar-worker.php; sleep 60; done
 *
 * Jeden przebieg = jeden cykl (blokada flock: drugi równoległy przebieg od razu się kończy).
 * Opcja --src-dir=KATALOG czyta pliki OPERA@*.tiff z dysku zamiast z S3 (testy, praca offline).
 * Kod wyjścia: 0 = OK, 1 = błąd w cyklu (szczegóły na stderr; poprzednie klatki zostają).
 */

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}

define('MO_LIB_ONLY', true);
require __DIR__ . '/../src/weather-api.php';
require __DIR__ . '/../src/radar-lib.php';

$opt = getopt('', ['src-dir:', 'once']);
$cycleOpt = [];
if (isset($opt['src-dir'])) {
    $srcDir = rtrim((string) $opt['src-dir'], '/');
    $cycleOpt['list'] = static fn (int $now): array => mo_radar_list_dir($srcDir);
    $cycleOpt['open'] = static fn (string $key): MoRadarSource => new MoRadarSource($srcDir . '/' . basename($key));
}

$result = mo_radar_cycle(mo_cache_dir(), time(), $cycleOpt);

$line = '[radar] ' . gmdate('Y-m-d\TH:i\Z');
if (isset($result['skipped'])) {
    echo $line, ' skipped (', $result['skipped'], ")\n";
    exit(0);
}
foreach ($result['rendered'] as $r) {
    $line .= sprintf(' +%s(%d ms, %d KB read, %d KB png)', $r['t'], $r['ms'], $r['kb_read'], intdiv($r['bytes'], 1024));
}
echo $line, ' frames=', $result['frames'], ' latest=', $result['latest'] ?? '-', ' status=', $result['status'], "\n";
foreach ($result['errors'] as $err) {
    fwrite(STDERR, "[radar] ERROR $err\n");
}
exit($result['errors'] ? 1 : 0);
