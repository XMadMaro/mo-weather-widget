<?php
/**
 * PoC dekodera klatek radaru w czystym PHP (kandydat na src/radar-lib.php).
 *
 * Czyta COG OPERA CIRRUS DBZH (plik lokalny albo URL przez HTTP Range), sprawdza format,
 * pobiera tylko kafle pokrywające okno mapy, przelicza piksele przez LUT (Web Mercator -> LAEA)
 * i zapisuje PNG z paletą 704x676 w EPSG:3857. Wymaga tylko PHP 8.1+ z curl i zlib.
 *
 *   php render-frame.php --src=PLIK_LUB_URL --out=frame.png [--lut-dir=KATALOG]
 *   php render-frame.php --latest --out=frame.png      (najnowsza klatka z S3 OPERA)
 *   php render-frame.php --selftest                    (punkty referencyjne LAEA z pyproj)
 */
declare(strict_types=1);

const RADAR_S3 = 'https://s3.waw3-1.cloudferro.com/openradar-24h';
const RADAR_KEY_RE = '~^\d{4}/\d{2}/\d{2}/OPERA/COMP/OPERA@(\d{8}T\d{4})@0@DBZH\.tiff$~';
const RADAR_UA = 'mo-weather-widget-radar/0.1 (+https://github.com/XMadMaro/mo-weather-widget)';
const RADAR_BBOX_LL = [16.8, 48.9, 21.2, 51.6];   // lon/lat: zachód, południe, wschód, północ
const RADAR_SIZE = [704, 676];
const RADAR_LAEA = ['lat0' => 55.0, 'lon0' => 10.0, 'x0' => 1950000.0, 'y0' => -2100000.0];
const MERC_R = 6378137.0;
const MAX_TILE_BYTES = 4 * 1024 * 1024;

/** Paleta: 0 przezroczysty, 1 brak danych, 2..12 klasy co 5 dBZ od 10, 13 = 65+ dBZ. */
const RADAR_PALETTE = [
    [0, 0, 0, 0], [128, 128, 128, 60],
    [160, 220, 255, 150], [90, 175, 255, 190], [35, 120, 245, 215], [25, 185, 70, 225],
    [15, 135, 40, 235], [250, 225, 0, 240], [255, 165, 0, 245], [255, 85, 0, 250],
    [225, 0, 0, 255], [160, 0, 50, 255], [225, 0, 225, 255], [255, 255, 255, 255],
];

final class RadarFormatException extends RuntimeException
{
}

/** Odczyt fragmentów pliku: lokalnie przez fseek, zdalnie przez HTTP Range. */
final class RangeSource
{
    /** @var resource|null */
    private $fh = null;
    private string $url = '';
    public int $requests = 0;
    public int $bytes = 0;
    public ?int $size = null;

    public function __construct(string $src)
    {
        if (preg_match('~^https://~', $src)) {
            $this->url = $src;
            return;
        }
        $fh = @fopen($src, 'rb');
        if ($fh === false) {
            throw new RuntimeException("cannot open $src");
        }
        $this->fh = $fh;
        $this->size = (int)filesize($src);
    }

    public function read(int $offset, int $length): string
    {
        if ($this->size !== null) {
            $length = max(0, min($length, $this->size - $offset));
        }
        $this->requests++;
        if ($this->fh !== null) {
            fseek($this->fh, $offset);
            $data = $length > 0 ? (string)fread($this->fh, $length) : '';
        } else {
            $data = http_range($this->url, $offset, $length);
        }
        $this->bytes += strlen($data);
        if (strlen($data) !== $length) {
            throw new RuntimeException("short read at $offset (" . strlen($data) . "/$length)");
        }
        return $data;
    }
}

function http_range(string $url, int $offset, int $length): string
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 20,
        CURLOPT_RANGE => $offset . '-' . ($offset + $length - 1),
        CURLOPT_USERAGENT => RADAR_UA,
    ]);
    $body = curl_exec($ch);
    $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if (!is_string($body) || $code !== 206) {
        throw new RuntimeException("HTTP $code for range $offset+$length");
    }
    return $body;
}

/** @return list<int|float|string> */
function tiff_values(array $tag): array
{
    return match ($tag['type']) {
        1, 7 => array_values(unpack('C*', $tag['data'])),
        2 => [rtrim($tag['data'], "\0")],
        3 => array_values(unpack('v*', $tag['data'])),
        4 => array_values(unpack('V*', $tag['data'])),
        12 => array_values(unpack('e*', $tag['data'])),
        default => throw new RadarFormatException('unsupported TIFF field type ' . $tag['type']),
    };
}

/** @return array<int, array{type: int, count: int, data: string}> */
function tiff_read_ifd(RangeSource $src, string $head, int $ifdOffset): array
{
    $get = static fn (int $off, int $len): string =>
        $off + $len <= strlen($head) ? substr($head, $off, $len) : $src->read($off, $len);
    $sizes = [1 => 1, 2 => 1, 3 => 2, 4 => 4, 5 => 8, 6 => 1, 7 => 1, 8 => 2, 9 => 4, 10 => 8, 11 => 4, 12 => 8];
    $n = unpack('v', $get($ifdOffset, 2))[1];
    if ($n < 1 || $n > 200) {
        throw new RadarFormatException("implausible IFD entry count $n");
    }
    $raw = $get($ifdOffset + 2, $n * 12);
    $tags = [];
    for ($i = 0; $i < $n; $i++) {
        $e = unpack('vtag/vtype/Vcount/Vvalue', $raw, $i * 12);
        $size = ($sizes[$e['type']] ?? 0) * $e['count'];
        if ($size === 0 || $size > 1048576) {
            continue;
        }
        $data = $size <= 4 ? substr($raw, $i * 12 + 8, $size) : $get($e['value'], $size);
        $tags[$e['tag']] = ['type' => $e['type'], 'count' => $e['count'], 'data' => $data];
    }
    return $tags;
}

/** GeoKeyDirectory -> [klucz => wartość]. */
function geokeys(array $tags): array
{
    if (!isset($tags[34735])) {
        return [];
    }
    $dir = tiff_values($tags[34735]);
    $dbl = isset($tags[34736]) ? tiff_values($tags[34736]) : [];
    $out = [];
    for ($k = 0, $n = (int)$dir[3]; $k < $n; $k++) {
        [$id, $loc, $cnt, $val] = array_slice($dir, 4 + $k * 4, 4);
        if ($loc === 0) {
            $out[$id] = $val;
        } elseif ($loc === 34736 && isset($dbl[$val])) {
            $out[$id] = $dbl[$val];
        }
    }
    return $out;
}

/**
 * Otwiera COG i sprawdza, czy ma znaną budowę (RADAR-PLAN.md C.2/C.3).
 * Każda niezgodność to RadarFormatException, a nie „jakoś narysowany” obraz.
 */
function cog_open(RangeSource $src): array
{
    $head = $src->read(0, 65536);
    if (substr($head, 0, 4) !== "II*\0") {
        throw new RadarFormatException('not a little-endian classic TIFF');
    }
    $tags = tiff_read_ifd($src, $head, unpack('V', $head, 4)[1]);
    $one = static fn (int $id, int|float|null $default = null) => isset($tags[$id]) ? tiff_values($tags[$id])[0] : $default;

    $w = (int)$one(256, 0);
    $h = (int)$one(257, 0);
    $spp = (int)$one(277, 1);
    $comp = (int)$one(259, 1);
    $pred = (int)$one(317, 1);
    $planar = (int)$one(284, 1);
    $tw = (int)$one(322, 0);
    $th = (int)$one(323, 0);
    $bps = isset($tags[258]) ? array_unique(tiff_values($tags[258])) : [];
    $fmt = isset($tags[339]) ? array_unique(tiff_values($tags[339])) : [1];

    $problems = [];
    if ($w < 1 || $h < 1) {
        $problems[] = "size {$w}x{$h}";
    }
    if (!in_array($comp, [1, 8, 32946], true)) {
        $problems[] = "compression $comp";
    }
    if (!in_array($pred, [1, 2], true)) {
        $problems[] = "predictor $pred";
    }
    if ($planar !== 1) {
        $problems[] = "planar $planar";
    }
    if ($bps !== [32] || $fmt !== [3]) {
        $problems[] = 'samples not Float32';
    }
    if ($tw !== 512 || $th !== 512) {
        $problems[] = "tiles {$tw}x{$th}";
    }
    $across = intdiv($w + $tw - 1, max(1, $tw));
    $down = intdiv($h + $th - 1, max(1, $th));
    $offsets = isset($tags[324]) ? tiff_values($tags[324]) : [];
    $counts = isset($tags[325]) ? tiff_values($tags[325]) : [];
    if (count($offsets) !== $across * $down || count($counts) !== count($offsets)) {
        $problems[] = 'tile index size';
    }
    $scale = isset($tags[33550]) ? tiff_values($tags[33550]) : [];
    $tie = isset($tags[33922]) ? tiff_values($tags[33922]) : [];
    if (count($scale) < 2 || count($tie) < 6) {
        $problems[] = 'missing georeference';
    }
    $gk = geokeys($tags);
    $lat0 = $gk[3089] ?? $gk[3081] ?? null;
    $lon0 = $gk[3088] ?? $gk[3080] ?? null;
    if (($gk[3075] ?? null) !== 10
        || abs((float)$lat0 - RADAR_LAEA['lat0']) > 1e-6 || abs((float)$lon0 - RADAR_LAEA['lon0']) > 1e-6
        || abs((float)($gk[3082] ?? 0) - RADAR_LAEA['x0']) > 0.01 || abs((float)($gk[3083] ?? 0) - RADAR_LAEA['y0']) > 0.01) {
        $problems[] = 'projection is not the expected LAEA';
    }
    if ($problems) {
        throw new RadarFormatException('unexpected COG layout: ' . implode(', ', $problems));
    }
    // GTRasterTypeGeoKey: 1 = PixelIsArea (narożnik piksela), 2 = PixelIsPoint (środek piksela).
    $half = (($gk[1025] ?? 1) === 2) ? 0.5 : 0.0;
    $sx = (float)$scale[0];
    $sy = (float)$scale[1];
    return [
        'w' => $w, 'h' => $h, 'spp' => $spp, 'tw' => $tw, 'th' => $th, 'across' => $across,
        'compression' => $comp, 'predictor' => $pred, 'offsets' => $offsets, 'counts' => $counts,
        'sx' => $sx, 'sy' => $sy,
        'x0' => (float)$tie[3] - ((float)$tie[0] + $half) * $sx,
        'y0' => (float)$tie[4] + ((float)$tie[1] + $half) * $sy,
        'nodata' => isset($tags[42113]) ? (float)tiff_values($tags[42113])[0] : -9999000.0,
    ];
}

function laea_setup(): array
{
    $a = MERC_R;
    $f = 1 / 298.257223563;
    $e2 = $f * (2 - $f);
    $e = sqrt($e2);
    $q = static function (float $phi) use ($e, $e2): float {
        $s = sin($phi);
        return (1 - $e2) * ($s / (1 - $e2 * $s * $s) - (1 / (2 * $e)) * log((1 - $e * $s) / (1 + $e * $s)));
    };
    $qp = $q(M_PI / 2);
    $phi1 = deg2rad(RADAR_LAEA['lat0']);
    $b1 = asin($q($phi1) / $qp);
    $rq = $a * sqrt($qp / 2);
    $d = $a * (cos($phi1) / sqrt(1 - $e2 * sin($phi1) ** 2)) / ($rq * cos($b1));
    return ['q' => $q, 'qp' => $qp, 'rq' => $rq, 'd' => $d, 'sb1' => sin($b1), 'cb1' => cos($b1),
        'lam0' => deg2rad(RADAR_LAEA['lon0']), 'x0' => RADAR_LAEA['x0'], 'y0' => RADAR_LAEA['y0']];
}

/** lon/lat w stopniach -> LAEA [x, y] w metrach (Snyder, elipsoida WGS84). */
function laea_fwd(array $p, float $lon, float $lat): array
{
    $beta = asin(max(-1.0, min(1.0, ($p['q'])(deg2rad($lat)) / $p['qp'])));
    $dl = deg2rad($lon) - $p['lam0'];
    $b = $p['rq'] * sqrt(2 / (1 + $p['sb1'] * sin($beta) + $p['cb1'] * cos($beta) * cos($dl)));
    return [
        $b * $p['d'] * cos($beta) * sin($dl) + $p['x0'],
        ($b / $p['d']) * ($p['cb1'] * sin($beta) - $p['sb1'] * cos($beta) * cos($dl)) + $p['y0'],
    ];
}

function merc_bbox(): array
{
    [$w, $s, $e, $n] = RADAR_BBOX_LL;
    $y = static fn (float $lat): float => MERC_R * log(tan(M_PI / 4 + deg2rad($lat) / 2));
    return [MERC_R * deg2rad($w), $y($s), MERC_R * deg2rad($e), $y($n)];
}

/**
 * LUT: dla każdego piksela wyjściowego globalny indeks piksela OPERA (row * w + col) albo -1.
 * Mercator jest rozdzielny (lon zależy tylko od kolumny, lat tylko od wiersza), więc
 * trygonometrię liczymy osobno dla kolumn i wierszy.
 */
function radar_lut(array $cog, ?string $cacheDir): array
{
    [$W, $H] = RADAR_SIZE;
    $key = md5(json_encode([RADAR_BBOX_LL, RADAR_SIZE, RADAR_LAEA, $cog['w'], $cog['h'], $cog['x0'], $cog['y0'], $cog['sx'], $cog['sy']]));
    $file = $cacheDir !== null ? rtrim($cacheDir, '/') . "/radar-lut-$key.bin" : null;
    if ($file !== null && is_file($file)) {
        $raw = (string)file_get_contents($file);
        $meta = unpack('l4', $raw);
        return ['idx' => array_values(unpack('l*', substr($raw, 16))), 'cmin' => $meta[1], 'cmax' => $meta[2],
            'rmin' => $meta[3], 'rmax' => $meta[4], 'cached' => true];
    }
    $p = laea_setup();
    [$mx0, $my0, $mx1, $my1] = merc_bbox();
    $cosdl = $sindl = [];
    for ($i = 0; $i < $W; $i++) {
        $lon = rad2deg(($mx0 + ($i + 0.5) * ($mx1 - $mx0) / $W) / MERC_R);
        $dl = deg2rad($lon) - $p['lam0'];
        $cosdl[$i] = cos($dl);
        $sindl[$i] = sin($dl);
    }
    $idx = [];
    $cmin = $rmin = PHP_INT_MAX;
    $cmax = $rmax = -1;
    for ($j = 0; $j < $H; $j++) {
        $y = $my1 - ($j + 0.5) * ($my1 - $my0) / $H;
        $lat = rad2deg(M_PI / 2 - 2 * atan(exp(-$y / MERC_R)));
        $beta = asin(max(-1.0, min(1.0, ($p['q'])(deg2rad($lat)) / $p['qp'])));
        $sb = sin($beta);
        $cb = cos($beta);
        for ($i = 0; $i < $W; $i++) {
            $b = $p['rq'] * sqrt(2 / (1 + $p['sb1'] * $sb + $p['cb1'] * $cb * $cosdl[$i]));
            $x = $b * $p['d'] * $cb * $sindl[$i] + $p['x0'];
            $yy = ($b / $p['d']) * ($p['cb1'] * $sb - $p['sb1'] * $cb * $cosdl[$i]) + $p['y0'];
            $col = (int)floor(($x - $cog['x0']) / $cog['sx']);
            $row = (int)floor(($cog['y0'] - $yy) / $cog['sy']);
            if ($col < 0 || $row < 0 || $col >= $cog['w'] || $row >= $cog['h']) {
                $idx[] = -1;
                continue;
            }
            $idx[] = $row * $cog['w'] + $col;
            $cmin = min($cmin, $col);
            $cmax = max($cmax, $col);
            $rmin = min($rmin, $row);
            $rmax = max($rmax, $row);
        }
    }
    if ($file !== null) {
        @mkdir(dirname($file), 0775, true);
        file_put_contents("$file.tmp", pack('l4', $cmin, $cmax, $rmin, $rmax) . pack('l*', ...$idx));
        rename("$file.tmp", $file);
    }
    return ['idx' => $idx, 'cmin' => $cmin, 'cmax' => $cmax, 'rmin' => $rmin, 'rmax' => $rmax, 'cached' => false];
}

function undo_predictor2(string $raw, int $tw, int $th, int $spp): string
{
    $words = array_values(unpack('V*', $raw));
    $rowLen = $tw * $spp;
    for ($r = 0; $r < $th; $r++) {
        $base = $r * $rowLen;
        for ($i = $spp; $i < $rowLen; $i++) {
            $words[$base + $i] = ($words[$base + $i] + $words[$base + $i - $spp]) & 0xFFFFFFFF;
        }
    }
    return pack('V*', ...$words);
}

function radar_class(float $v, float $nodata): int
{
    if (is_nan($v)) {
        return 0;
    }
    if ($v === $nodata || $v <= -9.4e6) {
        return 1;
    }
    if ($v < 10.0) {
        return 0;                 // także undetect (-8888000)
    }
    if ($v >= 65.0) {
        return 13;
    }
    return 2 + (int)floor(($v - 10.0) / 5.0);
}

/** Pobiera potrzebne kafle i maluje klatkę. Zwraca [piksele (string, 1 bajt = indeks palety), statystyki]. */
function radar_render(RangeSource $src, array $cog, array $lut): array
{
    $tiles = [];
    $tileBytes = $cog['tw'] * $cog['th'] * $cog['spp'] * 4;
    for ($tr = intdiv($lut['rmin'], $cog['th']); $tr <= intdiv($lut['rmax'], $cog['th']); $tr++) {
        for ($tc = intdiv($lut['cmin'], $cog['tw']); $tc <= intdiv($lut['cmax'], $cog['tw']); $tc++) {
            $t = $tr * $cog['across'] + $tc;
            $len = (int)$cog['counts'][$t];
            if ($len < 1 || $len > MAX_TILE_BYTES) {
                throw new RadarFormatException("tile $t has implausible size $len");
            }
            $data = $src->read((int)$cog['offsets'][$t], $len);
            $raw = $cog['compression'] === 1 ? $data : @gzuncompress($data, $tileBytes + 1);
            if (!is_string($raw) || strlen($raw) !== $tileBytes) {
                throw new RadarFormatException("tile $t does not decompress to $tileBytes bytes");
            }
            $tiles[$t] = $cog['predictor'] === 2 ? undo_predictor2($raw, $cog['tw'], $cog['th'], $cog['spp']) : $raw;
        }
    }
    [$W, $H] = RADAR_SIZE;
    $pix = str_repeat("\0", $W * $H);
    $cache = [];
    $hist = array_fill(0, count(RADAR_PALETTE), 0);
    $maxDbz = null;
    $nan = 0;
    $w = $cog['w'];
    foreach ($lut['idx'] as $p => $g) {
        if ($g < 0) {
            $c = 1;
        } elseif (isset($cache[$g])) {
            $c = $cache[$g];
        } else {
            $row = intdiv($g, $w);
            $col = $g - $row * $w;
            $t = intdiv($row, $cog['th']) * $cog['across'] + intdiv($col, $cog['tw']);
            $off = ((($row % $cog['th']) * $cog['tw'] + ($col % $cog['tw'])) * $cog['spp']) * 4;
            $v = unpack('g', $tiles[$t], $off)[1];
            if (is_nan($v)) {
                $nan++;
            } elseif ($v > -1000 && ($maxDbz === null || $v > $maxDbz)) {
                $maxDbz = $v;
            }
            $c = $cache[$g] = radar_class($v, $cog['nodata']);
        }
        $hist[$c]++;
        if ($c !== 0) {
            $pix[$p] = chr($c);
        }
    }
    return [$pix, [
        'tiles' => array_keys($tiles),
        'source_pixels' => count($cache),
        'nodata_pct' => round(100 * $hist[1] / ($W * $H), 2),
        'echo_pct' => round(100 * array_sum(array_slice($hist, 2)) / ($W * $H), 2),
        'max_dbz' => $maxDbz === null ? null : round($maxDbz, 1),
        'nan_source_pixels' => $nan,
        'histogram' => $hist,
    ]];
}

function png_indexed(int $w, int $h, string $pixels, array $palette): string
{
    $chunk = static fn (string $type, string $data): string =>
        pack('N', strlen($data)) . $type . $data . pack('N', crc32($type . $data));
    $plte = $trns = '';
    foreach ($palette as [$r, $g, $b, $a]) {
        $plte .= chr($r) . chr($g) . chr($b);
        $trns .= chr($a);
    }
    $raw = '';
    for ($y = 0; $y < $h; $y++) {
        $raw .= "\0" . substr($pixels, $y * $w, $w);
    }
    return "\x89PNG\r\n\x1a\n"
        . $chunk('IHDR', pack('NNCCCCC', $w, $h, 8, 3, 0, 0, 0))
        . $chunk('PLTE', $plte)
        . $chunk('tRNS', $trns)
        . $chunk('IDAT', (string)gzcompress($raw, 9))
        . $chunk('IEND', '');
}

function latest_opera_url(): string
{
    $keys = [];
    foreach ([0, 3600] as $back) {
        $ts = time() - $back;
        $prefix = gmdate('Y/m/d', $ts) . '/OPERA/COMP/OPERA@' . gmdate('Ymd\TH', $ts);
        $ch = curl_init(RADAR_S3 . '/?prefix=' . rawurlencode($prefix));
        curl_setopt_array($ch, [CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 20, CURLOPT_USERAGENT => RADAR_UA]);
        $xml = curl_exec($ch);
        curl_close($ch);
        $doc = is_string($xml) ? @simplexml_load_string($xml, 'SimpleXMLElement', LIBXML_NONET) : false;
        if ($doc === false) {
            continue;
        }
        foreach ($doc->Contents as $c) {
            $k = (string)$c->Key;
            if (preg_match(RADAR_KEY_RE, $k, $m)) {
                $keys[$m[1]] = $k;
            }
        }
    }
    if (!$keys) {
        throw new RuntimeException('no OPERA frames found in S3 listing');
    }
    ksort($keys);
    return RADAR_S3 . '/' . end($keys);
}

function selftest(): int
{
    // Wartości z pyproj dla tego samego opisu projekcji (RADAR-PLAN.md C.3).
    $ref = [
        'Katowice' => [19.0238, 50.2649, 2591975.3, -2585988.8],
        'Czestochowa' => [19.1203, 50.8118, 2591217.7, -2524733.3],
        'Bielsko-Biala' => [19.0447, 49.8224, 2599506.1, -2634649.0],
        'bbox SW' => [16.8, 48.9, 2448376.9, -2754694.7],
        'bbox NE' => [21.2, 51.6, 2722709.7, -2417070.7],
    ];
    $p = laea_setup();
    $worst = 0.0;
    foreach ($ref as $name => [$lon, $lat, $ex, $ey]) {
        [$x, $y] = laea_fwd($p, $lon, $lat);
        $err = max(abs($x - $ex), abs($y - $ey));
        $worst = max($worst, $err);
        printf("%-14s x=%12.1f y=%13.1f  err=%.2f m\n", $name, $x, $y, $err);
    }
    [$x0, $y0, $x1, $y1] = merc_bbox();
    printf("merc bbox: %.1f %.1f %.1f %.1f\n", $x0, $y0, $x1, $y1);
    $ok = $worst < 0.2 && abs($x0 - 1870167) < 1 && abs($y1 - 6728121) < 1;
    echo $ok ? "SELFTEST OK\n" : "SELFTEST FAILED\n";
    return $ok ? 0 : 1;
}

// ------------------------------------------------------------------ CLI

if (PHP_SAPI === 'cli' && realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    $opt = getopt('', ['src:', 'out:', 'lut-dir:', 'latest', 'selftest']);
    if (isset($opt['selftest'])) {
        exit(selftest());
    }
    $out = (string)($opt['out'] ?? '');
    if ($out === '' || (!isset($opt['src']) && !isset($opt['latest']))) {
        fwrite(STDERR, "usage: php render-frame.php (--src=FILE_OR_URL | --latest) --out=frame.png [--lut-dir=DIR]\n");
        exit(2);
    }
    $t0 = microtime(true);
    try {
        $srcName = isset($opt['latest']) ? latest_opera_url() : (string)$opt['src'];
        $src = new RangeSource($srcName);
        $cog = cog_open($src);
        $t1 = microtime(true);
        $lut = radar_lut($cog, isset($opt['lut-dir']) ? (string)$opt['lut-dir'] : null);
        $t2 = microtime(true);
        [$pix, $stats] = radar_render($src, $cog, $lut);
        $t3 = microtime(true);
        $png = png_indexed(RADAR_SIZE[0], RADAR_SIZE[1], $pix, RADAR_PALETTE);
        file_put_contents("$out.tmp", $png);
        rename("$out.tmp", $out);
        $t4 = microtime(true);
        echo json_encode([
            'src' => $srcName,
            'cog' => ['size' => [$cog['w'], $cog['h']], 'bands' => $cog['spp'], 'compression' => $cog['compression'],
                'predictor' => $cog['predictor'], 'origin' => [$cog['x0'], $cog['y0']], 'pixel' => [$cog['sx'], $cog['sy']],
                'nodata' => $cog['nodata']],
            'window' => ['cols' => [$lut['cmin'], $lut['cmax']], 'rows' => [$lut['rmin'], $lut['rmax']], 'lut_cached' => $lut['cached']],
            'io' => ['requests' => $src->requests, 'bytes' => $src->bytes],
            'ms' => ['header' => round(($t1 - $t0) * 1000), 'lut' => round(($t2 - $t1) * 1000),
                'tiles_and_render' => round(($t3 - $t2) * 1000), 'png' => round(($t4 - $t3) * 1000), 'total' => round(($t4 - $t0) * 1000)],
            'png_bytes' => strlen($png),
            'php_peak_mb' => round(memory_get_peak_usage(true) / 1048576, 1),
        ] + $stats, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), "\n";
    } catch (RadarFormatException $e) {
        fwrite(STDERR, 'FORMAT CHANGED: ' . $e->getMessage() . "\n");
        exit(3);
    } catch (Throwable $e) {
        fwrite(STDERR, 'ERROR: ' . $e->getMessage() . "\n");
        exit(1);
    }
}
