<?php
declare(strict_types=1);

/**
 * MO Weather Widget — testy radaru burzowego (offline, bez sieci)
 *
 *   php tests/radar.test.php
 *
 * Fixture tests/fixtures/radar-mini.tiff ma budowę jak plik OPERA (sterownik COG z GDAL, LAEA,
 * 2 pasma Float32, kafel 512, DEFLATE). Wynik wzorcowy w radar-mini.json policzono dokładnie przez PROJ
 * dla każdego piksela mapy (tests/fixtures/make-radar-fixture.py), więc test sprawdza cały tor:
 * nagłówek -> LUT -> kafle -> klasy palety -> PNG.
 */

require __DIR__ . '/../src/radar-lib.php';

$passed = 0;
$failed = 0;
function check(bool $ok, string $msg): void
{
    global $passed, $failed;
    if ($ok) {
        $passed++;
        return;
    }
    $failed++;
    fwrite(STDERR, "    FAIL: $msg\n");
}

function expect_exception(callable $fn, string $class, string $needle, string $msg): void
{
    try {
        $fn();
        check(false, "$msg (brak wyjątku)");
    } catch (Throwable $e) {
        check($e instanceof $class && str_contains($e->getMessage(), $needle),
            "$msg (" . get_class($e) . ': ' . $e->getMessage() . ')');
    }
}

function rrmdir(string $dir): void
{
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS),
        RecursiveIteratorIterator::CHILD_FIRST);
    foreach ($it as $f) {
        $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
    }
    @rmdir($dir);
}

/** Podmienia wartość SHORT/LONG (count 1) wpisu IFD w kopii pliku TIFF. */
function patch_tag(string $tiff, int $tag, int $value): string
{
    $ifd = unpack('V', $tiff, 4)[1];
    $n = unpack('v', $tiff, $ifd)[1];
    for ($i = 0; $i < $n; $i++) {
        $at = $ifd + 2 + $i * 12;
        $e = unpack('vtag/vtype', $tiff, $at);
        if ($e['tag'] === $tag) {
            $bin = $e['type'] === 3 ? pack('v', $value) . "\0\0" : pack('V', $value);
            return substr_replace($tiff, $bin, $at + 8, 4);
        }
    }
    throw new LogicException("tag $tag not found");
}

/** Podmienia wartość klucza w GeoKeyDirectory (tag 34735). */
function patch_geokey(string $tiff, int $key, int $value): string
{
    $ifd = unpack('V', $tiff, 4)[1];
    $n = unpack('v', $tiff, $ifd)[1];
    for ($i = 0; $i < $n; $i++) {
        $e = unpack('vtag/vtype/Vcount/Voff', $tiff, $ifd + 2 + $i * 12);
        if ($e['tag'] === 34735) {
            for ($k = 4; $k < $e['count']; $k += 4) {
                if (unpack('v', $tiff, $e['off'] + $k * 2)[1] === $key) {
                    return substr_replace($tiff, pack('v', $value), $e['off'] + ($k + 3) * 2, 2);
                }
            }
        }
    }
    throw new LogicException("geokey $key not found");
}

$tmp = sys_get_temp_dir() . '/mo-radar-test-' . getmypid() . '-' . bin2hex(random_bytes(3));
mkdir($tmp, 0775, true);
$fixture = __DIR__ . '/fixtures/radar-mini.tiff';
$expected = json_decode((string) file_get_contents(__DIR__ . '/fixtures/radar-mini.json'), true);
$tiffBytes = (string) file_get_contents($fixture);

echo "==> Running Radar Tests (src/radar-lib.php)...\n";

// 1. Projekcja LAEA (Snyder) zgodna z PROJ
echo "  [1/10] LAEA vs PROJ reference points...\n";
$p = mo_radar_laea_setup();
$ref = [
    ['Katowice', 19.0238, 50.2649, 2591975.329, -2585988.798],
    ['Warszawa', 21.0122, 52.2297, 2699195.953, -2349780.895],
    ['Origin', 10.0, 55.0, 1950000.000, -2100000.000],
    ['SW', 16.8, 48.9, 2448376.851, -2754694.707],
    ['NE', 21.2, 51.6, 2722709.697, -2417070.674],
    ['Gdansk', 18.6466, 54.352, 2510619.942, -2137561.979],
];
foreach ($ref as [$name, $lon, $lat, $ex, $ey]) {
    [$x, $y] = mo_radar_laea_fwd($p, $lon, $lat);
    check(abs($x - $ex) <= 0.2 && abs($y - $ey) <= 0.2, sprintf('LAEA %s: %.3f, %.3f vs %.3f, %.3f', $name, $x, $y, $ex, $ey));
}

// 2. bbox klatki w Web Mercatorze = bbox podkładu mapy w widgecie
echo "  [2/10] Web Mercator bbox...\n";
$bb = mo_radar_merc_bbox();
foreach ([1870167.445, 6257910.489, 2359973.205, 6728120.968] as $i => $v) {
    check(abs($bb[$i] - $v) < 0.01, "merc bbox[$i] = {$bb[$i]}, expected $v");
}

// 3. Nagłówek COG
echo "  [3/10] COG header parsing...\n";
$src = new MoRadarSource($fixture);
$cog = mo_radar_cog_open($src);
check($cog['w'] === 512 && $cog['h'] === 512 && $cog['spp'] === 2, 'size 512x512, 2 bands');
check($cog['tw'] === 512 && $cog['th'] === 512 && $cog['across'] === 1, 'tile 512, 1 across');
check($cog['compression'] === 8 && $cog['predictor'] === 1, 'deflate, no predictor');
check(abs($cog['x0'] - 2400000) < 1e-6 && abs($cog['y0'] + 2400000) < 1e-6, "origin {$cog['x0']}, {$cog['y0']}");
check($cog['sx'] === 1000.0 && $cog['sy'] === 1000.0, 'pixel 1000 m');
check($cog['nodata'] === -9999000.0, 'GDAL_NODATA -9999000');

// 4. LUT: okno mapy w siatce radaru, cache na dysku
echo "  [4/10] LUT window and cache...\n";
$lut = mo_radar_lut($cog, null);
check([$lut['cmin'], $lut['cmax']] === $expected['window']['cols'], "LUT cols {$lut['cmin']}-{$lut['cmax']}");
check([$lut['rmin'], $lut['rmax']] === $expected['window']['rows'], "LUT rows {$lut['rmin']}-{$lut['rmax']}");
check(count($lut['idx']) === 704 * 676, 'LUT size 704x676');
$lut1 = mo_radar_lut($cog, $tmp);
$lut2 = mo_radar_lut($cog, $tmp);
check($lut1['cached'] === false && $lut2['cached'] === true, 'second LUT comes from cache');
check($lut2['idx'] === $lut['idx'] && $lut2['rmax'] === $lut['rmax'], 'cached LUT identical');

// 5. Render: każdy piksel jak w wzorcu z PROJ
echo "  [5/10] Render vs PROJ-exact reference (md5 of class grid)...\n";
[$pix, $st] = mo_radar_render($src, $cog, $lut);
check(md5($pix) === $expected['classes_md5'], 'class grid md5 ' . md5($pix) . ' vs ' . $expected['classes_md5']);
$hist = array_fill(0, 14, 0);
foreach (count_chars($pix, 1) as $byte => $cnt) {
    $hist[$byte] = $cnt;
}
check($hist === $expected['histogram'], 'histogram ' . json_encode($hist));
check($st['tiles'] === [0], 'only tile 0 read');
check($st['nodata_pct'] === round(100 * $expected['histogram'][1] / (704 * 676), 2), "nodata_pct {$st['nodata_pct']}");
check($st['max_dbz'] !== null && $st['max_dbz'] >= 69.0 && $st['max_dbz'] <= 70.0, "max_dbz {$st['max_dbz']}");
[$kx, $ky] = $expected['katowice_pixel'];
check(ord($pix[$ky * 704 + $kx]) === $expected['katowice_class'], 'Katowice pixel class');
check(mo_radar_class(NAN, -9999000.0) === 0 && mo_radar_class(-8888000.0, -9999000.0) === 0, 'NaN and undetect transparent');
check(mo_radar_class(-9999000.0, -9999000.0) === 1 && mo_radar_class(9.99, -9999000.0) === 0, 'nodata grey, <10 dBZ transparent');
check(mo_radar_class(10.0, -9999000.0) === 2 && mo_radar_class(64.99, -9999000.0) === 12 && mo_radar_class(65.0, -9999000.0) === 13, 'class edges');

// 6. PNG z paletą
echo "  [6/10] Paletted PNG structure...\n";
$png = mo_radar_png(704, 676, $pix);
check(strlen($png) <= 50 * 1024, 'frame PNG <= 50 KB (' . strlen($png) . ' B)');
check(substr($png, 0, 8) === "\x89PNG\r\n\x1a\n", 'PNG signature');
$pos = 8;
$chunks = [];
$idat = '';
while ($pos < strlen($png)) {
    $len = unpack('N', $png, $pos)[1];
    $type = substr($png, $pos + 4, 4);
    $data = substr($png, $pos + 8, $len);
    $crc = unpack('N', $png, $pos + 8 + $len)[1];
    check($crc === crc32($type . $data), "CRC of $type");
    $chunks[] = $type;
    if ($type === 'IHDR') {
        $ihdr = unpack('Nw/Nh/Cdepth/Ctype', $data);
        check($ihdr['w'] === 704 && $ihdr['h'] === 676 && $ihdr['depth'] === 8 && $ihdr['type'] === 3, 'IHDR 704x676, 8-bit palette');
    }
    if ($type === 'PLTE' || $type === 'tRNS') {
        check(strlen($data) === ($type === 'PLTE' ? 3 : 1) * count(MO_RADAR_PALETTE), "$type size");
    }
    if ($type === 'IDAT') {
        $idat .= $data;
    }
    $pos += 12 + $len;
}
check($chunks === ['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'], 'chunk order ' . implode(',', $chunks));
$raw = (string) gzuncompress($idat);
$rows = '';
for ($y = 0; $y < 676; $y++) {
    check($raw[$y * 705] === "\0", "filter byte row $y");
    $rows .= substr($raw, $y * 705 + 1, 704);
}
check($rows === $pix, 'IDAT round-trip');

// 7. Ochrona przed zmianą formatu: wyjątek zamiast złego obrazu
echo "  [7/10] Format change detection...\n";
$bad = static function (string $bytes) use ($tmp): MoRadarSource {
    $f = $tmp . '/bad-' . bin2hex(random_bytes(3)) . '.tiff';
    file_put_contents($f, $bytes);
    return new MoRadarSource($f);
};
expect_exception(fn () => mo_radar_cog_open($bad(patch_tag($tiffBytes, 317, 3))), MoRadarFormatException::class, 'predictor 3', 'predictor 3 rejected');
expect_exception(fn () => mo_radar_cog_open($bad(patch_tag($tiffBytes, 259, 5))), MoRadarFormatException::class, 'compression 5', 'LZW rejected');
expect_exception(fn () => mo_radar_cog_open($bad(patch_tag($tiffBytes, 284, 2))), MoRadarFormatException::class, 'planar 2', 'planar separate rejected');
expect_exception(fn () => mo_radar_cog_open($bad(patch_tag($tiffBytes, 322, 256))), MoRadarFormatException::class, 'tiles 256x512', 'tile size change rejected');
expect_exception(fn () => mo_radar_cog_open($bad(patch_geokey($tiffBytes, 3075, 11))), MoRadarFormatException::class, 'LAEA', 'other projection rejected');
expect_exception(fn () => mo_radar_cog_open($bad('MM' . substr($tiffBytes, 2))), MoRadarFormatException::class, 'little-endian', 'big-endian rejected');
$offs = $cog['offsets'][0];
$corrupt = substr_replace($tiffBytes, str_repeat("\xAA", 64), $offs + 100, 64);
expect_exception(function () use ($bad, $corrupt) {
    $s = $bad($corrupt);
    $c = mo_radar_cog_open($s);
    mo_radar_render($s, $c, mo_radar_lut($c, null));
}, MoRadarFormatException::class, 'does not decompress', 'corrupt tile rejected');
// Predyktor 2 (różnicowanie poziome) odwracany poprawnie
$words = [1, 5, 2, 7, 10, 20, 30, 40, 0xFFFFFFFF, 3, 1, 1, 9, 9, 9, 9];
$diff = $words;
for ($r = 0; $r < 2; $r++) {
    for ($i = 7; $i >= 2; $i--) {
        $diff[$r * 8 + $i] = ($words[$r * 8 + $i] - $words[$r * 8 + $i - 2]) & 0xFFFFFFFF;
    }
}
check(array_values(unpack('V*', mo_radar_undo_predictor2(pack('V*', ...$diff), 4, 2, 2))) === $words, 'predictor 2 undo');

// 8. Walidacja znacznika klatki (jedyny parametr endpointu klatek)
echo "  [8/10] Frame id validation...\n";
check(mo_radar_valid_t('20261016T0125'), 'valid t');
foreach (['20261316T0125', '20260230T0000', '20261016T2460', '20261016T012', '20261016T0125x', '../../etc/passwd', '', '2026-10-16T01:25'] as $t) {
    check(!mo_radar_valid_t($t), "invalid t '$t'");
}
check(mo_radar_t_to_ts('20261016T0125') === gmmktime(1, 25, 0, 10, 16, 2026), 't -> timestamp (UTC)');

// 9. Status: fresh / degraded / stale / down
echo "  [9/10] Status thresholds...\n";
$t0 = gmmktime(12, 0, 0, 10, 16, 2026);
$m = ['latest' => '20261016T1200', 'frames' => [['t' => '20261016T1200', 'nodata_pct' => 3.2]]];
check(mo_radar_status($m, $t0 + 600) === 'fresh', 'fresh at 10 min');
check(mo_radar_status($m, $t0 + 15 * 60 + 59) === 'fresh', 'fresh at 15 min');
check(mo_radar_status($m, $t0 + 16 * 60) === 'stale', 'stale at 16 min');
check(mo_radar_status($m, $t0 + 60 * 60 + 59) === 'stale', 'stale at 60 min');
check(mo_radar_status($m, $t0 + 61 * 60) === 'down', 'down at 61 min');
$m['frames'][0]['nodata_pct'] = 25.0;
check(mo_radar_status($m, $t0 + 600) === 'degraded', 'degraded when nodata > 20%');
check(mo_radar_status(null, $t0) === 'down' && mo_radar_status(['frames' => []], $t0) === 'down', 'down without frames');
$pub = mo_radar_public_manifest(null, $t0);
check($pub['status'] === 'down' && $pub['frames'] === [] && !isset($pub['last_error']), 'public manifest without data');
$pub = mo_radar_public_manifest($m + ['last_error' => ['message' => 'secret']], $t0 + 600);
check($pub['frames'] === [['t' => '20261016T1200']] && !isset($pub['last_error']) && $pub['size'] === [704, 676], 'public manifest hides internals');

// 10. Cykl producenta na podstawionych plikach (bez sieci)
echo "  [10/10] Producer cycle (injected source)...\n";
$cache = $tmp . '/cache';
$now = gmmktime(12, 7, 0, 10, 16, 2026); // według harmonogramu powinna już być klatka 12:00
$keys = [];
for ($k = 0; $k <= 14; $k++) {
    $keys[gmdate('Ymd\THi', $now - 420 - $k * 300)] = 'k' . $k;
}
$openCount = 0;
$opt = [
    'list' => function (int $n) use (&$keys): array {
        return $keys;
    },
    'open' => function (string $key) use ($fixture, &$openCount): MoRadarSource {
        $openCount++;
        return new MoRadarSource($fixture);
    },
];
$r = mo_radar_cycle($cache, $now, $opt);
check(count($r['rendered']) === 13 && $r['errors'] === [], 'first cycle renders 13 frames (' . count($r['rendered']) . ')');
check($r['frames'] === 13 && $r['latest'] === '20261016T1200' && $r['status'] === 'fresh', "manifest latest {$r['latest']}, status {$r['status']}");
check(count(glob($cache . '/radar/radar_*.png')) === 13, '13 PNG files on disk');
check(md5_file($cache . '/radar/radar_20261016T1200.png') === md5($png), 'frame file identical to direct render');
$man = mo_radar_read_manifest($cache . '/radar');
check($man !== null && $man['frames'][12]['t'] === '20261016T1200' && $man['frames'][0]['t'] === '20261016T1100', 'manifest frame order');
$r = mo_radar_cycle($cache, $now + 60, $opt);
check($r['rendered'] === [] && $openCount === 13, 'second cycle does not re-render nor list (opened ' . $openCount . ')');
$keys[gmdate('Ymd\THi', $now - 120)] = 'k-new';
$r = mo_radar_cycle($cache, $now + 300, $opt);
check(count($r['rendered']) === 1 && $r['latest'] === '20261016T1205' && $r['frames'] === 13, 'new frame appended, window stays 13');
// Lock: drugi równoległy przebieg kończy się od razu
$lock = fopen($cache . '/radar/worker.lock', 'c');
$probe = fopen($cache . '/radar/worker.lock', 'c');
$flockWorks = flock($lock, LOCK_EX | LOCK_NB) && !flock($probe, LOCK_EX | LOCK_NB);
if ($flockWorks) {
    check((mo_radar_cycle($cache, $now + 360, $opt)['skipped'] ?? null) === 'locked', 'parallel cycle skipped');
} else {
    echo "        (flock not exclusive in this PHP build, lock test skipped)\n";
}
flock($lock, LOCK_UN);
fclose($lock);
fclose($probe);
// Health
putenv('MO_RADAR_MODE=producer');
$h = mo_radar_health($cache, $now + 300);
check($h['mode'] === 'producer' && $h['status'] === 'fresh' && $h['frames'] === 13 && $h['age_min'] === 7 && $h['error'] === null, 'health ' . json_encode($h));
putenv('MO_RADAR_MODE');
// Zmiana formatu: klatki nie powstają, health zgłasza format_changed, stare klatki zostają
$badFile = $tmp . '/pred3.tiff';
file_put_contents($badFile, patch_tag($tiffBytes, 317, 3));
$keys[gmdate('Ymd\THi', $now + 180)] = 'k-bad';
$optBad = ['list' => fn (int $n): array => $keys, 'open' => fn (string $key): MoRadarSource => new MoRadarSource($badFile)];
$r = mo_radar_cycle($cache, $now + 600, $optBad);
check($r['rendered'] === [] && count($r['errors']) === 1 && str_contains($r['errors'][0], 'format'), 'format error reported once');
check(mo_radar_health($cache, $now + 600)['error'] === 'format_changed' && $r['latest'] === '20261016T1205', 'health format_changed, old frames kept');
// Błąd listowania S3: zostają poprzednie klatki, status liczony z wieku
$r = mo_radar_cycle($cache, $now + 20 * 60, ['list' => function (int $n): array {
    throw new RuntimeException('S3 listing failed');
}, 'open' => $opt['open']]);
check($r['status'] === 'stale' && $r['frames'] === 13 && str_contains($r['errors'][0] ?? '', 'S3'), 'listing failure -> stale, frames kept');
// Retencja 2 h
$r = mo_radar_cycle($cache, $now + 3 * 3600, ['list' => fn (int $n): array => [], 'open' => $opt['open']]);
check($r['frames'] === 0 && $r['status'] === 'down' && glob($cache . '/radar/radar_*.png') === [], 'frames older than 2 h removed');
// Katalog lokalny (tryb --src-dir workera)
$srcDir = $tmp . '/src';
mkdir($srcDir);
touch($srcDir . '/OPERA@20261016T1200@0@DBZH.tiff');
touch($srcDir . '/OPERA@20261016T1200@0@TH.tiff');
touch($srcDir . '/junk.tiff');
check(mo_radar_list_dir($srcDir) === ['20261016T1200' => 'OPERA@20261016T1200@0@DBZH.tiff'], 'list_dir picks only DBZH frames');
check(preg_match(MO_RADAR_KEY_RE, '2026/10/16/OPERA/COMP/OPERA@20261016T1200@0@DBZH.tiff') === 1
    && preg_match(MO_RADAR_KEY_RE, '2026/10/16/OPERA/COMP/OPERA@20261016T1200@0@RATE.tiff') === 0, 'S3 key filter');

rrmdir($tmp);
echo "\n";
if ($failed > 0) {
    fwrite(STDERR, "Radar tests: $failed FAILED, $passed passed\n");
    exit(1);
}
echo "All radar tests passed ($passed assertions).\n";
