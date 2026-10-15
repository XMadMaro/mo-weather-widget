<?php
/**
 * PoC producenta klatek radaru dla <mo-weather>. Kod jednorazowy, NIE produkcja.
 *
 * Cykl: listing S3 OPERA (curl + SimpleXML) -> 3 komendy GDAL (/vsicurl/, odczyt Range)
 *       -> PNG 704x676 w EPSG:3857 -> manifest.json.
 *
 *   php worker-poc.php --out=KATALOG [--frames=13] [--end=YYYYMMDDTHHMM] [--palette=PLIK]
 */
declare(strict_types=1);

const S3_BASE = 'https://s3.waw3-1.cloudferro.com/openradar-24h';
const KEY_RE = '~^\d{4}/\d{2}/\d{2}/OPERA/COMP/OPERA@(\d{8}T\d{4})@0@DBZH\.tiff$~';
const BBOX_LL = ['16.8', '48.9', '21.2', '51.6'];
const BBOX_3857 = [1870167, 6257910, 2359973, 6728121];
const SIZE = [704, 676];

$t0 = microtime(true);
$opt = getopt('', ['out:', 'frames::', 'end::', 'palette::']);
$out = isset($opt['out']) ? rtrim((string)$opt['out'], '/') : '';
if ($out === '') {
    fwrite(STDERR, "usage: php worker-poc.php --out=DIR [--frames=13] [--end=YYYYMMDDTHHMM]\n");
    exit(2);
}
$want = max(1, min(48, (int)($opt['frames'] ?? 13)));
$end = isset($opt['end']) ? (string)$opt['end'] : null;
if ($end !== null && !preg_match('~^\d{8}T\d{4}$~', $end)) {
    fwrite(STDERR, "bad --end, expected YYYYMMDDTHHMM\n");
    exit(2);
}
$palette = (string)($opt['palette'] ?? __DIR__ . '/radar-palette.txt');
if (!is_dir($out) && !mkdir($out, 0775, true)) {
    fwrite(STDERR, "cannot create $out\n");
    exit(1);
}

foreach ([
    'GDAL_DISABLE_READDIR_ON_OPEN' => 'EMPTY_DIR',
    'CPL_VSIL_CURL_ALLOWED_EXTENSIONS' => '.tiff',
    'GDAL_HTTP_TIMEOUT' => '20',
    'GDAL_HTTP_MAX_RETRY' => '3',
    'GDAL_HTTP_RETRY_DELAY' => '2',
    'GDAL_CACHEMAX' => '64',
    'GDAL_PAM_ENABLED' => 'NO',
    'CPL_DEBUG' => 'ON', // tylko PoC: z logu liczymy pobrane zakresy Range
] as $k => $v) {
    putenv("$k=$v");
}

function http_get(string $url): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_USERAGENT => 'mo-weather-widget-radar-poc/0.1',
    ]);
    $body = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    return [$code, is_string($body) ? $body : ''];
}

/** @return array<string, array{key: string, size: int, last_modified: string}> */
function list_hour(int $ts): array
{
    $prefix = gmdate('Y/m/d', $ts) . '/OPERA/COMP/OPERA@' . gmdate('Ymd\TH', $ts);
    [$code, $xml] = http_get(S3_BASE . '/?prefix=' . rawurlencode($prefix));
    if ($code !== 200 || $xml === '') {
        throw new RuntimeException("S3 listing HTTP $code for $prefix");
    }
    $doc = @simplexml_load_string($xml);
    if ($doc === false) {
        throw new RuntimeException('S3 listing: invalid XML');
    }
    $found = [];
    foreach ($doc->children() as $node) {
        if ($node->getName() !== 'Contents') {
            continue;
        }
        $key = (string)$node->Key;
        if (preg_match(KEY_RE, $key, $m)) {
            $found[$m[1]] = ['key' => $key, 'size' => (int)$node->Size, 'last_modified' => (string)$node->LastModified];
        }
    }
    return $found;
}

function run(string $cmd, string &$log): bool
{
    $lines = [];
    $code = 0;
    exec($cmd . ' 2>&1', $lines, $code);
    $log .= '$ ' . $cmd . "\n" . implode("\n", $lines) . "\n[exit $code]\n";
    return $code === 0;
}

function range_bytes(string $log): array
{
    $sum = 0;
    $n = 0;
    if (preg_match_all('~Downloading (\d+)-(\d+)~', $log, $m, PREG_SET_ORDER)) {
        foreach ($m as $r) {
            $sum += (int)$r[2] - (int)$r[1] + 1;
            $n++;
        }
    }
    return [$sum, $n];
}

function stats(array $xs): ?array
{
    if (!$xs) {
        return null;
    }
    sort($xs);
    $n = count($xs);
    return ['n' => $n, 'min' => $xs[0], 'median' => $xs[intdiv($n, 2)], 'max' => $xs[$n - 1]];
}

// 1. Listing S3: bieżąca i poprzednie godziny.
$endTs = time();
if ($end !== null) {
    $d = DateTimeImmutable::createFromFormat('!Ymd\THi', $end, new DateTimeZone('UTC'));
    $endTs = $d ? $d->getTimestamp() : $endTs;
}
$frames = [];
$listingErrors = [];
$hours = (int)ceil($want * 5 / 60) + 1;
for ($h = 0; $h <= $hours; $h++) {
    try {
        $frames += list_hour($endTs - $h * 3600);
    } catch (Throwable $e) {
        $listingErrors[] = $e->getMessage();
    }
}
ksort($frames, SORT_STRING);
if ($end !== null) {
    $frames = array_filter($frames, static fn ($t) => strcmp((string)$t, $end) <= 0, ARRAY_FILTER_USE_KEY);
}
$frames = array_slice($frames, -$want, null, true);

// 2. Render każdej klatki przez GDAL.
$manifest = [
    'generated_utc' => gmdate('Y-m-d\TH:i:s\Z'),
    'source' => 'EUMETNET OPERA, CC BY 4.0',
    'bbox_ll' => array_map('floatval', BBOX_LL),
    'bbox_3857' => BBOX_3857,
    'size' => SIZE,
    'frames' => [],
];
$tmp = sys_get_temp_dir() . '/mo-radar-poc-' . getmypid();
@mkdir($tmp, 0700, true);
$errors = [];
$times = $pngBytes = $rangeBytes = [];
foreach ($frames as $t => $f) {
    $t = (string)$t;
    $url = S3_BASE . '/' . $f['key'];
    $part = "$out/.tmp-$t.png";
    $final = "$out/radar_$t.png";
    $log = '';
    $s = microtime(true);
    $ok = run('timeout 60 gdal_translate -q -of VRT -b 1 ' . escapeshellarg("/vsicurl/$url") . ' ' . escapeshellarg("$tmp/dbzh.vrt"), $log)
        && run('timeout 60 gdalwarp -q -overwrite -te ' . implode(' ', BBOX_LL) . ' -te_srs EPSG:4326 -t_srs EPSG:3857 -ts '
            . SIZE[0] . ' ' . SIZE[1] . ' -r near ' . escapeshellarg("$tmp/dbzh.vrt") . ' ' . escapeshellarg("$tmp/w.tif"), $log)
        && run('timeout 60 gdaldem color-relief -q -of PNG -alpha -nearest_color_entry ' . escapeshellarg("$tmp/w.tif") . ' '
            . escapeshellarg($palette) . ' ' . escapeshellarg($part), $log);
    $dt = round(microtime(true) - $s, 2);
    [$rb, $rn] = range_bytes($log);
    if ($ok && is_file($part) && rename($part, $final)) {
        $bytes = (int)filesize($final);
        $manifest['frames'][] = [
            't' => $t,
            'file' => basename($final),
            'png_bytes' => $bytes,
            'render_s' => $dt,
            'range_requests' => $rn,
            'range_bytes' => $rb,
            'source_bytes' => $f['size'],
            'source_last_modified' => $f['last_modified'],
        ];
        $times[] = $dt;
        $pngBytes[] = $bytes;
        $rangeBytes[] = $rb;
    } else {
        @unlink($part);
        $errors[] = ['t' => $t, 'log_tail' => substr($log, -3000)];
    }
}
@array_map('unlink', glob("$tmp/*") ?: []);
@rmdir($tmp);

file_put_contents("$out/.manifest.tmp", json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
rename("$out/.manifest.tmp", "$out/manifest.json");

$peak = null;
foreach (['/sys/fs/cgroup/memory.peak', '/sys/fs/cgroup/memory/memory.max_usage_in_bytes'] as $p) {
    if (is_readable($p)) {
        $peak = round(((int)trim((string)file_get_contents($p))) / 1048576, 1);
        break;
    }
}
echo json_encode([
    'end' => $end,
    'frames_listed' => count($frames),
    'frames_ok' => count($manifest['frames']),
    'listing_errors' => $listingErrors,
    'render_errors' => $errors,
    'wall_s' => round(microtime(true) - $t0, 2),
    'render_s' => stats($times),
    'png_bytes' => stats($pngBytes),
    'range_bytes' => stats($rangeBytes),
    'php_peak_mb' => round(memory_get_peak_usage(true) / 1048576, 1),
    'container_memory_peak_mb' => $peak,
    'gdal' => trim((string)shell_exec('gdalinfo --version')),
    'php' => PHP_VERSION,
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
exit(count($manifest['frames']) > 0 ? 0 : 1);
