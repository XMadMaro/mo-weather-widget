<?php
/**
 * PoC: renderuje wszystkie klatki OPERA@*.tiff z katalogu przez render-frame.php i zapisuje frames.json.
 *
 *   php render-batch.php KATALOG_COG KATALOG_WYJŚCIOWY
 */
declare(strict_types=1);

require __DIR__ . '/render-frame.php';

[, $inDir, $outDir] = $argv + [null, null, null];
if (!$inDir || !$outDir) {
    fwrite(STDERR, "usage: php render-batch.php COG_DIR OUT_DIR\n");
    exit(2);
}
@mkdir($outDir, 0775, true);
$files = glob(rtrim($inDir, '/') . '/OPERA@*@0@DBZH.tiff') ?: [];
sort($files);
$frames = [];
foreach ($files as $file) {
    preg_match('~OPERA@(\d{8}T\d{4})@~', $file, $m);
    $t0 = microtime(true);
    $src = new RangeSource($file);
    $cog = cog_open($src);
    $lut = radar_lut($cog, sys_get_temp_dir());
    [$pix, $stats] = radar_render($src, $cog, $lut);
    $png = png_indexed(RADAR_SIZE[0], RADAR_SIZE[1], $pix, RADAR_PALETTE);
    file_put_contents("$outDir/radar_{$m[1]}.png", $png);
    $frames[] = ['t' => $m[1], 'file' => "radar_{$m[1]}.png", 'png_bytes' => strlen($png),
        'ms' => (int)round((microtime(true) - $t0) * 1000), 'max_dbz' => $stats['max_dbz'],
        'echo_pct' => $stats['echo_pct'], 'nodata_pct' => $stats['nodata_pct']];
    fwrite(STDERR, "{$m[1]}: " . strlen($png) . " B, {$frames[count($frames) - 1]['ms']} ms\n");
}
file_put_contents("$outDir/frames.json", json_encode([
    'synthetic' => true,
    'note' => 'Dane syntetyczne o budowie identycznej z OPERA CIRRUS DBZH COG (test dekodera).',
    'bbox_ll' => RADAR_BBOX_LL,
    'size' => RADAR_SIZE,
    'frames' => $frames,
], JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
echo count($frames), " frames\n";
