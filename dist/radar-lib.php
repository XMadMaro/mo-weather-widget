<?php
declare(strict_types=1);

/**
 * MO Weather Widget — biblioteka radaru burzowego (PHP 8.1+, tylko curl, zlib i SimpleXML)
 *
 * Źródło: EUMETNET OPERA CIRRUS DBZH (kompozyt maksymalnej odbiciowości, CC BY 4.0),
 * pliki COG w publicznym S3 (CloudFerro, Warszawa), nowa klatka co 5 min.
 *
 * Producent (scripts/radar-worker.php) co minutę:
 *  1. listuje S3 i wybiera brakujące klatki z ostatniej godziny,
 *  2. czyta z każdej tylko 4 kafle przez HTTP Range (nagłówek + kafle okna Śląska),
 *  3. przelicza piksele przez stałą tablicę LUT (Web Mercator -> LAEA) i zapisuje PNG z paletą
 *     704×676 px w EPSG:3857 (ten sam bbox co podkład mapy w widgecie),
 *  4. aktualizuje manifest.json i kasuje klatki starsze niż 2 h.
 * Endpoint src/radar-api.php tylko serwuje gotowe pliki (zapytania czytelników nie przetwarzają danych).
 *
 * Budowa pliku COG jest sprawdzana przy każdej klatce: nieznany format to wyjątek i status „down”,
 * a nie źle narysowany obraz. Szczegóły i weryfikacja: docs/RADAR-PLAN.md (C.2, C.3, C.10).
 */

const MO_RADAR_S3 = 'https://s3.waw3-1.cloudferro.com/openradar-24h';
const MO_RADAR_KEY_RE = '~^\d{4}/\d{2}/\d{2}/OPERA/COMP/OPERA@(\d{8}T\d{4})@0@DBZH\.tiff$~';
const MO_RADAR_UA = 'mo-weather-widget-radar/2.0 (+https://media-operator.pl; kontakt: redakcja@media-operator.pl)';
const MO_RADAR_BBOX_LL = [16.8, 48.9, 21.2, 51.6]; // lon/lat: zachód, południe, wschód, północ
const MO_RADAR_SIZE = [704, 676];
const MO_RADAR_LAEA = ['lat0' => 55.0, 'lon0' => 10.0, 'x0' => 1950000.0, 'y0' => -2100000.0];
const MO_RADAR_FRAMES = 13;           // 1 h animacji co 5 min
const MO_RADAR_STEP = 300;            // odstęp klatek OPERA (s)
const MO_RADAR_PUBLISH_DELAY = 240;   // OPERA publikuje ok. 4 min po czasie nominalnym (zmierzone)
const MO_RADAR_RETENTION = 7200;      // klatki na dysku: 2 h
const MO_RADAR_FRESH_MIN = 15;        // ostatnia klatka nie starsza niż 15 min -> fresh
const MO_RADAR_STALE_MIN = 60;        // do 60 min -> stale, starsza -> down
const MO_RADAR_DEGRADED_NODATA = 20.0; // > 20% pikseli bez pokrycia -> degraded
const MO_RADAR_MAX_TILE_BYTES = 4194304;
const MO_RADAR_MERC_R = 6378137.0;
const MO_RADAR_ATTRIBUTION = 'Radar: EUMETNET OPERA (CC BY 4.0), dane przetworzone';

/** Paleta PNG: 0 przezroczysty, 1 brak danych, 2..12 klasy co 5 dBZ od 10, 13 = 65+ dBZ (RGBA). */
const MO_RADAR_PALETTE = [
    [0, 0, 0, 0], [128, 128, 128, 60],
    [160, 220, 255, 150], [90, 175, 255, 190], [35, 120, 245, 215], [25, 185, 70, 225],
    [15, 135, 40, 235], [250, 225, 0, 240], [255, 165, 0, 245], [255, 85, 0, 250],
    [225, 0, 0, 255], [160, 0, 50, 255], [225, 0, 225, 255], [255, 255, 255, 255],
];

final class MoRadarFormatException extends RuntimeException
{
}

/** Odczyt fragmentów pliku: lokalnie przez fseek, zdalnie przez HTTP Range (jedno połączenie na plik). */
final class MoRadarSource
{
    /** @var resource|null */
    private $fh = null;
    /** @var \CurlHandle|null */
    private $ch = null;
    private string $url = '';
    public int $requests = 0;
    public int $bytes = 0;
    public ?int $size = null;

    public function __construct(string $src)
    {
        if (str_starts_with($src, 'https://')) {
            $this->url = $src;
            return;
        }
        $fh = @fopen($src, 'rb');
        if ($fh === false) {
            throw new RuntimeException('cannot open ' . basename($src));
        }
        $this->fh = $fh;
        $this->size = (int) filesize($src);
    }

    public function __destruct()
    {
        if ($this->fh !== null) {
            fclose($this->fh);
        }
        if ($this->ch !== null) {
            curl_close($this->ch);
        }
    }

    public function read(int $offset, int $length): string
    {
        if ($length < 0 || $length > MO_RADAR_MAX_TILE_BYTES) {
            throw new MoRadarFormatException("implausible read length $length");
        }
        if ($this->size !== null) {
            $length = max(0, min($length, $this->size - $offset));
        }
        $this->requests++;
        if ($this->fh !== null) {
            fseek($this->fh, $offset);
            $data = $length > 0 ? (string) fread($this->fh, $length) : '';
        } else {
            $data = $this->httpRange($offset, $length);
        }
        $this->bytes += strlen($data);
        if (strlen($data) !== $length) {
            throw new RuntimeException("short read at $offset (" . strlen($data) . "/$length)");
        }
        return $data;
    }

    private function httpRange(int $offset, int $length): string
    {
        if ($this->ch === null) {
            $this->ch = curl_init($this->url);
        }
        curl_setopt_array($this->ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => 20,
            CURLOPT_RANGE => $offset . '-' . ($offset + $length - 1),
            CURLOPT_USERAGENT => MO_RADAR_UA,
            CURLOPT_FOLLOWLOCATION => false,
        ]);
        $body = curl_exec($this->ch);
        $code = (int) curl_getinfo($this->ch, CURLINFO_RESPONSE_CODE);
        if (!is_string($body) || $code !== 206) {
            throw new RuntimeException("HTTP $code for range $offset+$length");
        }
        return $body;
    }
}

/* ---------- TIFF / COG ---------- */

/** @return list<int|float|string> */
function mo_radar_tiff_values(array $tag): array
{
    return match ($tag['type']) {
        1, 7 => array_values(unpack('C*', $tag['data'])),
        2 => [rtrim($tag['data'], "\0")],
        3 => array_values(unpack('v*', $tag['data'])),
        4 => array_values(unpack('V*', $tag['data'])),
        12 => array_values(unpack('e*', $tag['data'])),
        default => throw new MoRadarFormatException('unsupported TIFF field type ' . $tag['type']),
    };
}

/** @return array<int, array{type: int, count: int, data: string}> */
function mo_radar_tiff_ifd(MoRadarSource $src, string $head, int $ifdOffset): array
{
    $get = static fn (int $off, int $len): string =>
        $off + $len <= strlen($head) ? substr($head, $off, $len) : $src->read($off, $len);
    $sizes = [1 => 1, 2 => 1, 3 => 2, 4 => 4, 5 => 8, 6 => 1, 7 => 1, 8 => 2, 9 => 4, 10 => 8, 11 => 4, 12 => 8];
    $n = unpack('v', $get($ifdOffset, 2))[1];
    if ($n < 1 || $n > 200) {
        throw new MoRadarFormatException("implausible IFD entry count $n");
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
function mo_radar_geokeys(array $tags): array
{
    if (!isset($tags[34735])) {
        return [];
    }
    $dir = mo_radar_tiff_values($tags[34735]);
    $dbl = isset($tags[34736]) ? mo_radar_tiff_values($tags[34736]) : [];
    $out = [];
    for ($k = 0, $n = (int) ($dir[3] ?? 0); $k < $n; $k++) {
        [$id, $loc, , $val] = array_slice($dir, 4 + $k * 4, 4) + [0, 0, 0, 0];
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
 * Każda niezgodność to MoRadarFormatException, a nie „jakoś narysowany” obraz.
 */
function mo_radar_cog_open(MoRadarSource $src): array
{
    $head = $src->read(0, 65536);
    if (substr($head, 0, 4) !== "II*\0") {
        throw new MoRadarFormatException('not a little-endian classic TIFF');
    }
    $tags = mo_radar_tiff_ifd($src, $head, unpack('V', $head, 4)[1]);
    $one = static fn (int $id, int|float|null $default = null) =>
        isset($tags[$id]) ? mo_radar_tiff_values($tags[$id])[0] : $default;

    $w = (int) $one(256, 0);
    $h = (int) $one(257, 0);
    $spp = (int) $one(277, 1);
    $comp = (int) $one(259, 1);
    $pred = (int) $one(317, 1);
    $planar = (int) $one(284, 1);
    $tw = (int) $one(322, 0);
    $th = (int) $one(323, 0);
    $bps = isset($tags[258]) ? array_values(array_unique(mo_radar_tiff_values($tags[258]))) : [];
    $fmt = isset($tags[339]) ? array_values(array_unique(mo_radar_tiff_values($tags[339]))) : [1];

    $problems = [];
    if ($w < 1 || $h < 1 || $spp < 1 || $spp > 8) {
        $problems[] = "size {$w}x{$h}x{$spp}";
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
    $across = intdiv($w + max(1, $tw) - 1, max(1, $tw));
    $down = intdiv($h + max(1, $th) - 1, max(1, $th));
    $offsets = isset($tags[324]) ? mo_radar_tiff_values($tags[324]) : [];
    $counts = isset($tags[325]) ? mo_radar_tiff_values($tags[325]) : [];
    if (count($offsets) !== $across * $down || count($counts) !== count($offsets)) {
        $problems[] = 'tile index size';
    }
    $scale = isset($tags[33550]) ? mo_radar_tiff_values($tags[33550]) : [];
    $tie = isset($tags[33922]) ? mo_radar_tiff_values($tags[33922]) : [];
    if (count($scale) < 2 || count($tie) < 6 || (float) $scale[0] <= 0 || (float) $scale[1] <= 0) {
        $problems[] = 'missing georeference';
    }
    $gk = mo_radar_geokeys($tags);
    $lat0 = $gk[3089] ?? $gk[3081] ?? null;
    $lon0 = $gk[3088] ?? $gk[3080] ?? null;
    if (($gk[3075] ?? null) !== 10
        || abs((float) $lat0 - MO_RADAR_LAEA['lat0']) > 1e-6 || abs((float) $lon0 - MO_RADAR_LAEA['lon0']) > 1e-6
        || abs((float) ($gk[3082] ?? 0) - MO_RADAR_LAEA['x0']) > 0.01
        || abs((float) ($gk[3083] ?? 0) - MO_RADAR_LAEA['y0']) > 0.01) {
        $problems[] = 'projection is not the expected LAEA';
    }
    if ($problems) {
        throw new MoRadarFormatException('unexpected COG layout: ' . implode(', ', $problems));
    }
    // GTRasterTypeGeoKey: 1 = PixelIsArea (narożnik piksela), 2 = PixelIsPoint (środek piksela).
    $half = (($gk[1025] ?? 1) === 2) ? 0.5 : 0.0;
    $sx = (float) $scale[0];
    $sy = (float) $scale[1];
    return [
        'w' => $w, 'h' => $h, 'spp' => $spp, 'tw' => $tw, 'th' => $th, 'across' => $across,
        'compression' => $comp, 'predictor' => $pred, 'offsets' => $offsets, 'counts' => $counts,
        'sx' => $sx, 'sy' => $sy,
        'x0' => (float) $tie[3] - ((float) $tie[0] + $half) * $sx,
        'y0' => (float) $tie[4] + ((float) $tie[1] + $half) * $sy,
        'nodata' => isset($tags[42113]) ? (float) mo_radar_tiff_values($tags[42113])[0] : -9999000.0,
    ];
}

/* ---------- Projekcje i LUT ---------- */

function mo_radar_laea_setup(): array
{
    $a = MO_RADAR_MERC_R;
    $f = 1 / 298.257223563;
    $e2 = $f * (2 - $f);
    $e = sqrt($e2);
    $q = static function (float $phi) use ($e, $e2): float {
        $s = sin($phi);
        return (1 - $e2) * ($s / (1 - $e2 * $s * $s) - (1 / (2 * $e)) * log((1 - $e * $s) / (1 + $e * $s)));
    };
    $qp = $q(M_PI / 2);
    $phi1 = deg2rad(MO_RADAR_LAEA['lat0']);
    $b1 = asin($q($phi1) / $qp);
    $rq = $a * sqrt($qp / 2);
    $d = $a * (cos($phi1) / sqrt(1 - $e2 * sin($phi1) ** 2)) / ($rq * cos($b1));
    return ['q' => $q, 'qp' => $qp, 'rq' => $rq, 'd' => $d, 'sb1' => sin($b1), 'cb1' => cos($b1),
        'lam0' => deg2rad(MO_RADAR_LAEA['lon0']), 'x0' => MO_RADAR_LAEA['x0'], 'y0' => MO_RADAR_LAEA['y0']];
}

/** lon/lat w stopniach -> LAEA [x, y] w metrach (Snyder, elipsoida WGS84). */
function mo_radar_laea_fwd(array $p, float $lon, float $lat): array
{
    $beta = asin(max(-1.0, min(1.0, ($p['q'])(deg2rad($lat)) / $p['qp'])));
    $dl = deg2rad($lon) - $p['lam0'];
    $b = $p['rq'] * sqrt(2 / (1 + $p['sb1'] * sin($beta) + $p['cb1'] * cos($beta) * cos($dl)));
    return [
        $b * $p['d'] * cos($beta) * sin($dl) + $p['x0'],
        ($b / $p['d']) * ($p['cb1'] * sin($beta) - $p['sb1'] * cos($beta) * cos($dl)) + $p['y0'],
    ];
}

/** bbox klatki w EPSG:3857 [x0, y0, x1, y1] (m). */
function mo_radar_merc_bbox(): array
{
    [$w, $s, $e, $n] = MO_RADAR_BBOX_LL;
    $y = static fn (float $lat): float => MO_RADAR_MERC_R * log(tan(M_PI / 4 + deg2rad($lat) / 2));
    return [MO_RADAR_MERC_R * deg2rad($w), $y($s), MO_RADAR_MERC_R * deg2rad($e), $y($n)];
}

/**
 * LUT: dla każdego piksela wyjściowego globalny indeks piksela OPERA (row * w + col) albo -1.
 * Mercator jest rozdzielny (lon zależy tylko od kolumny, lat tylko od wiersza), więc trygonometria
 * jest liczona osobno dla kolumn i wierszy. Wynik trafia do cache (ok. 1,9 MB) z kluczem z parametrów siatki.
 */
function mo_radar_lut(array $cog, ?string $cacheDir): array
{
    [$W, $H] = MO_RADAR_SIZE;
    $key = md5((string) json_encode([MO_RADAR_BBOX_LL, MO_RADAR_SIZE, MO_RADAR_LAEA,
        $cog['w'], $cog['h'], $cog['x0'], $cog['y0'], $cog['sx'], $cog['sy']]));
    $file = $cacheDir !== null ? rtrim($cacheDir, '/') . "/lut-$key.bin" : null;
    if ($file !== null && is_file($file)) {
        $raw = (string) @file_get_contents($file);
        if (strlen($raw) === 16 + 4 * $W * $H) {
            $meta = unpack('l4', $raw);
            return ['idx' => array_values(unpack('l*', substr($raw, 16))), 'cmin' => $meta[1], 'cmax' => $meta[2],
                'rmin' => $meta[3], 'rmax' => $meta[4], 'cached' => true];
        }
    }
    $p = mo_radar_laea_setup();
    [$mx0, $my0, $mx1, $my1] = mo_radar_merc_bbox();
    $cosdl = $sindl = [];
    for ($i = 0; $i < $W; $i++) {
        $dl = ($mx0 + ($i + 0.5) * ($mx1 - $mx0) / $W) / MO_RADAR_MERC_R - $p['lam0'];
        $cosdl[$i] = cos($dl);
        $sindl[$i] = sin($dl);
    }
    $idx = [];
    $cmin = $rmin = PHP_INT_MAX;
    $cmax = $rmax = -1;
    for ($j = 0; $j < $H; $j++) {
        $y = $my1 - ($j + 0.5) * ($my1 - $my0) / $H;
        $lat = M_PI / 2 - 2 * atan(exp(-$y / MO_RADAR_MERC_R));
        $beta = asin(max(-1.0, min(1.0, ($p['q'])($lat) / $p['qp'])));
        $sb = sin($beta);
        $cb = cos($beta);
        for ($i = 0; $i < $W; $i++) {
            $b = $p['rq'] * sqrt(2 / (1 + $p['sb1'] * $sb + $p['cb1'] * $cb * $cosdl[$i]));
            $x = $b * $p['d'] * $cb * $sindl[$i] + $p['x0'];
            $yy = ($b / $p['d']) * ($p['cb1'] * $sb - $p['sb1'] * $cb * $cosdl[$i]) + $p['y0'];
            $col = (int) floor(($x - $cog['x0']) / $cog['sx']);
            $row = (int) floor(($cog['y0'] - $yy) / $cog['sy']);
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
    if ($cmax < 0) {
        throw new MoRadarFormatException('map window is outside the radar grid');
    }
    if ($file !== null) {
        $tmp = $file . '.' . getmypid() . '.tmp';
        if (@file_put_contents($tmp, pack('l4', $cmin, $cmax, $rmin, $rmax) . pack('l*', ...$idx)) !== false) {
            @rename($tmp, $file);
        }
    }
    return ['idx' => $idx, 'cmin' => $cmin, 'cmax' => $cmax, 'rmin' => $rmin, 'rmax' => $rmax, 'cached' => false];
}

/* ---------- Render ---------- */

function mo_radar_undo_predictor2(string $raw, int $tw, int $th, int $spp): string
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

/** Wartość dBZ -> indeks palety. NaN i „undetect” (-8888000) to brak echa, -9999000 to brak pokrycia. */
function mo_radar_class(float $v, float $nodata): int
{
    if (is_nan($v)) {
        return 0;
    }
    if ($v === $nodata || $v <= -9.4e6) {
        return 1;
    }
    if ($v < 10.0) {
        return 0;
    }
    if ($v >= 65.0) {
        return 13;
    }
    return 2 + (int) floor(($v - 10.0) / 5.0);
}

/** Pobiera kafle okna i maluje klatkę. Zwraca [piksele: 1 bajt = indeks palety, statystyki]. */
function mo_radar_render(MoRadarSource $src, array $cog, array $lut): array
{
    $tiles = [];
    $tileBytes = $cog['tw'] * $cog['th'] * $cog['spp'] * 4;
    for ($tr = intdiv($lut['rmin'], $cog['th']); $tr <= intdiv($lut['rmax'], $cog['th']); $tr++) {
        for ($tc = intdiv($lut['cmin'], $cog['tw']); $tc <= intdiv($lut['cmax'], $cog['tw']); $tc++) {
            $t = $tr * $cog['across'] + $tc;
            $len = (int) ($cog['counts'][$t] ?? 0);
            if ($len < 1 || $len > MO_RADAR_MAX_TILE_BYTES) {
                throw new MoRadarFormatException("tile $t has implausible size $len");
            }
            $data = $src->read((int) $cog['offsets'][$t], $len);
            $raw = $cog['compression'] === 1 ? $data : @gzuncompress($data, $tileBytes + 1);
            if (!is_string($raw) || strlen($raw) !== $tileBytes) {
                throw new MoRadarFormatException("tile $t does not decompress to $tileBytes bytes");
            }
            $tiles[$t] = $cog['predictor'] === 2 ? mo_radar_undo_predictor2($raw, $cog['tw'], $cog['th'], $cog['spp']) : $raw;
        }
    }
    [$W, $H] = MO_RADAR_SIZE;
    $pix = str_repeat("\0", $W * $H);
    $cache = [];
    $hist = array_fill(0, count(MO_RADAR_PALETTE), 0);
    $maxDbz = null;
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
            if (!is_nan($v) && $v > -1000 && ($maxDbz === null || $v > $maxDbz)) {
                $maxDbz = $v;
            }
            $c = $cache[$g] = mo_radar_class($v, $cog['nodata']);
        }
        $hist[$c]++;
        if ($c !== 0) {
            $pix[$p] = chr($c);
        }
    }
    return [$pix, [
        'tiles' => array_keys($tiles),
        'nodata_pct' => round(100 * $hist[1] / ($W * $H), 2),
        'echo_pct' => round(100 * array_sum(array_slice($hist, 2)) / ($W * $H), 2),
        'max_dbz' => $maxDbz === null ? null : round($maxDbz, 1),
    ]];
}

/** PNG z paletą (typ koloru 3) i przezroczystością w chunku tRNS. */
function mo_radar_png(int $w, int $h, string $pixels, array $palette = MO_RADAR_PALETTE): string
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
        . $chunk('IDAT', (string) gzcompress($raw, 9))
        . $chunk('IEND', '');
}

/* ---------- Źródła klatek ---------- */

/** Klatki DBZH z S3 OPERA z godzin obejmujących ostatnie 70 min: [t => klucz]. */
function mo_radar_list_s3(int $now): array
{
    $frames = [];
    $errors = 0;
    for ($h = intdiv($now - 4200, 3600); $h <= intdiv($now, 3600); $h++) {
        $ts = $h * 3600;
        $prefix = gmdate('Y/m/d', $ts) . '/OPERA/COMP/OPERA@' . gmdate('Ymd\TH', $ts);
        $ch = curl_init(MO_RADAR_S3 . '/?prefix=' . rawurlencode($prefix));
        curl_setopt_array($ch, [
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => 10,
            CURLOPT_USERAGENT => MO_RADAR_UA,
            CURLOPT_FOLLOWLOCATION => false,
        ]);
        $xml = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        $doc = (is_string($xml) && $code === 200)
            ? @simplexml_load_string($xml, 'SimpleXMLElement', LIBXML_NONET) : false;
        if ($doc === false) {
            $errors++;
            continue;
        }
        foreach ($doc->Contents as $c) {
            $key = (string) $c->Key;
            if (preg_match(MO_RADAR_KEY_RE, $key, $m)) {
                $frames[$m[1]] = $key;
            }
        }
    }
    if (!$frames && $errors > 0) {
        throw new RuntimeException('S3 listing failed');
    }
    return $frames;
}

/** Klatki z lokalnego katalogu (tryb testowy workera): [t => nazwa pliku]. */
function mo_radar_list_dir(string $dir): array
{
    $frames = [];
    foreach (glob(rtrim($dir, '/') . '/OPERA@*@0@DBZH.tiff') ?: [] as $file) {
        if (preg_match('~^OPERA@(\d{8}T\d{4})@0@DBZH\.tiff$~', basename($file), $m)) {
            $frames[$m[1]] = basename($file);
        }
    }
    return $frames;
}

/* ---------- Manifest, status, cykl producenta ---------- */

function mo_radar_mode(): string
{
    $mode = strtolower(trim((string) getenv('MO_RADAR_MODE')));
    return in_array($mode, ['producer', 'off'], true) ? $mode : 'off';
}

function mo_radar_dir(string $cacheDir): string
{
    $dir = rtrim($cacheDir, '/') . '/radar';
    if (!is_dir($dir)) {
        @mkdir($dir, 0775, true);
    }
    return $dir;
}

/** Znacznik klatki: YYYYMMDDTHHMM, prawdziwa data UTC. */
function mo_radar_valid_t(string $t): bool
{
    if (!preg_match('/^\d{8}T\d{4}$/', $t)) {
        return false;
    }
    $d = DateTimeImmutable::createFromFormat('!Ymd\THi', $t, new DateTimeZone('UTC'));
    return $d !== false && $d->format('Ymd\THi') === $t;
}

function mo_radar_t_to_ts(string $t): int
{
    $d = DateTimeImmutable::createFromFormat('!Ymd\THi', $t, new DateTimeZone('UTC'));
    return $d === false ? 0 : $d->getTimestamp();
}

function mo_radar_read_manifest(string $dir): ?array
{
    $raw = @file_get_contents($dir . '/manifest.json');
    $m = is_string($raw) ? json_decode($raw, true) : null;
    return is_array($m) && isset($m['frames']) && is_array($m['frames']) ? $m : null;
}

/**
 * Status dla API i health: fresh | degraded | stale | down.
 * Liczony z wieku ostatniej klatki, więc działa też wtedy, gdy worker przestał pracować.
 */
function mo_radar_status(?array $m, int $now): string
{
    $latest = (string) ($m['latest'] ?? '');
    $frames = is_array($m['frames'] ?? null) ? $m['frames'] : [];
    if (!$frames || !mo_radar_valid_t($latest)) {
        return 'down';
    }
    $age = intdiv($now - mo_radar_t_to_ts($latest), 60);
    if ($age > MO_RADAR_STALE_MIN) {
        return 'down';
    }
    if ($age > MO_RADAR_FRESH_MIN) {
        return 'stale';
    }
    $last = end($frames);
    return (is_array($last) && (float) ($last['nodata_pct'] ?? 0) > MO_RADAR_DEGRADED_NODATA) ? 'degraded' : 'fresh';
}

/** Publiczny manifest dla przeglądarki (bez wewnętrznych komunikatów błędów). */
function mo_radar_public_manifest(?array $m, int $now): array
{
    $frames = [];
    foreach (($m['frames'] ?? []) as $f) {
        if (is_array($f) && mo_radar_valid_t((string) ($f['t'] ?? ''))) {
            $frames[] = ['t' => (string) $f['t']];
        }
    }
    $all = is_array($m['frames'] ?? null) ? $m['frames'] : [];
    $last = $all ? end($all) : null;
    return [
        'status' => mo_radar_status($m, $now),
        'latest' => $m['latest'] ?? null,
        'generated' => $m['generated'] ?? null,
        'step_seconds' => MO_RADAR_STEP,
        'frames' => $frames,
        'bbox_ll' => MO_RADAR_BBOX_LL,
        'size' => MO_RADAR_SIZE,
        'nodata_pct' => is_array($last) ? ($last['nodata_pct'] ?? null) : null,
        'attribution' => MO_RADAR_ATTRIBUTION,
    ];
}

/** Sekcja `radar` dla type=health. */
function mo_radar_health(string $cacheDir, int $now): array
{
    $m = mo_radar_read_manifest(mo_radar_dir($cacheDir));
    $latest = (string) ($m['latest'] ?? '');
    return [
        'mode' => mo_radar_mode(),
        'status' => mo_radar_status($m, $now),
        'latest' => $latest !== '' ? $latest : null,
        'age_min' => mo_radar_valid_t($latest) ? intdiv($now - mo_radar_t_to_ts($latest), 60) : null,
        'frames' => count($m['frames'] ?? []),
        'nodata_pct' => mo_radar_public_manifest($m, $now)['nodata_pct'],
        'error' => !empty($m['format_error']) ? 'format_changed' : (!empty($m['last_error']) ? 'upstream' : null),
    ];
}

function mo_radar_write_atomic(string $path, string $data): bool
{
    $tmp = $path . '.' . getmypid() . '.' . bin2hex(random_bytes(4)) . '.tmp';
    if (@file_put_contents($tmp, $data) === false) {
        return false;
    }
    return @rename($tmp, $path);
}

/**
 * Jeden cykl producenta. Opcje (do testów): 'list' => fn(int $now): array [t => klucz],
 * 'open' => fn(string $klucz): MoRadarSource. Domyślnie S3 OPERA.
 */
function mo_radar_cycle(string $cacheDir, int $now, array $opt = []): array
{
    $dir = mo_radar_dir($cacheDir);
    $lock = @fopen($dir . '/worker.lock', 'c');
    if ($lock === false || !flock($lock, LOCK_EX | LOCK_NB)) {
        return ['skipped' => 'locked'];
    }
    $list = $opt['list'] ?? 'mo_radar_list_s3';
    $open = $opt['open'] ?? static fn (string $key): MoRadarSource => new MoRadarSource(MO_RADAR_S3 . '/' . $key);
    $prev = mo_radar_read_manifest($dir) ?? [];
    $stats = [];
    foreach ($prev['frames'] ?? [] as $f) {
        if (is_array($f) && isset($f['t'])) {
            $stats[(string) $f['t']] = $f;
        }
    }
    $onDisk = [];
    foreach (glob($dir . '/radar_*.png') ?: [] as $file) {
        if (preg_match('/^radar_(\d{8}T\d{4})\.png$/', basename($file), $m)) {
            $onDisk[$m[1]] = $file;
        }
    }
    ksort($onDisk);
    $result = ['rendered' => [], 'errors' => []];
    $lastError = $prev['last_error'] ?? null;
    $formatError = $prev['format_error'] ?? null;

    // Nowej klatki szukamy tylko wtedy, gdy według harmonogramu publikacji powinna już być.
    $expected = gmdate('Ymd\THi', intdiv($now - MO_RADAR_PUBLISH_DELAY, MO_RADAR_STEP) * MO_RADAR_STEP);
    $newest = $onDisk ? array_key_last($onDisk) : '';
    if ($newest === '' || strcmp($newest, $expected) < 0 || count($onDisk) < MO_RADAR_FRAMES) {
        try {
            $listed = $list($now);
            $lastError = null;
        } catch (Throwable $e) {
            $listed = [];
            $lastError = ['at' => $now, 'message' => substr($e->getMessage(), 0, 200)];
            $result['errors'][] = 'list: ' . $e->getMessage();
        }
        ksort($listed);
        $window = array_filter($listed, static fn ($t) => mo_radar_valid_t((string) $t)
            && mo_radar_t_to_ts((string) $t) > $now - (MO_RADAR_FRAMES * MO_RADAR_STEP + MO_RADAR_PUBLISH_DELAY + 120)
            && mo_radar_t_to_ts((string) $t) <= $now, ARRAY_FILTER_USE_KEY);
        foreach (array_slice($window, -MO_RADAR_FRAMES, null, true) as $t => $key) {
            $t = (string) $t;
            if (isset($onDisk[$t])) {
                continue;
            }
            $t0 = microtime(true);
            try {
                $src = $open((string) $key);
                $cog = mo_radar_cog_open($src);
                $lut = mo_radar_lut($cog, $dir);
                [$pix, $st] = mo_radar_render($src, $cog, $lut);
                $png = mo_radar_png(MO_RADAR_SIZE[0], MO_RADAR_SIZE[1], $pix);
                if (!mo_radar_write_atomic($dir . "/radar_$t.png", $png)) {
                    throw new RuntimeException('cannot write frame');
                }
                $onDisk[$t] = $dir . "/radar_$t.png";
                $stats[$t] = ['t' => $t, 'bytes' => strlen($png), 'nodata_pct' => $st['nodata_pct'],
                    'echo_pct' => $st['echo_pct'], 'max_dbz' => $st['max_dbz']];
                $result['rendered'][] = ['t' => $t, 'ms' => (int) round((microtime(true) - $t0) * 1000),
                    'bytes' => strlen($png), 'kb_read' => (int) round($src->bytes / 1024)];
                $formatError = null;
            } catch (MoRadarFormatException $e) {
                $formatError = ['at' => $now, 'message' => substr($e->getMessage(), 0, 200), 't' => $t];
                $result['errors'][] = "format $t: " . $e->getMessage();
                break; // ten sam format będzie w kolejnych plikach, nie ma sensu próbować dalej
            } catch (Throwable $e) {
                $lastError = ['at' => $now, 'message' => substr($e->getMessage(), 0, 200), 't' => $t];
                $result['errors'][] = "frame $t: " . $e->getMessage();
            }
        }
    }

    // Retencja: klatki starsze niż 2 h znikają z dysku.
    foreach ($onDisk as $t => $file) {
        if (mo_radar_t_to_ts((string) $t) < $now - MO_RADAR_RETENTION) {
            @unlink($file);
            unset($onDisk[$t]);
        }
    }
    foreach (glob($dir . '/*.tmp') ?: [] as $tmp) {
        if (@filemtime($tmp) < $now - 600) {
            @unlink($tmp);
        }
    }

    ksort($onDisk);
    $frames = [];
    foreach (array_slice(array_keys($onDisk), -MO_RADAR_FRAMES) as $t) {
        $frames[] = $stats[(string) $t] ?? ['t' => (string) $t, 'bytes' => (int) @filesize($onDisk[$t])];
    }
    $manifest = [
        'version' => 1,
        'generated' => gmdate('Y-m-d\TH:i:s\Z', $now),
        'generated_ts' => $now,
        'latest' => $frames ? end($frames)['t'] : null,
        'frames' => $frames,
        'source' => 'EUMETNET OPERA CIRRUS DBZH (maximum reflectivity composite)',
        'attribution' => MO_RADAR_ATTRIBUTION,
        'bbox_ll' => MO_RADAR_BBOX_LL,
        'size' => MO_RADAR_SIZE,
        'last_error' => $lastError,
        'format_error' => $formatError,
    ];
    mo_radar_write_atomic($dir . '/manifest.json', (string) json_encode($manifest, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
    flock($lock, LOCK_UN);
    fclose($lock);
    $result['frames'] = count($frames);
    $result['latest'] = $manifest['latest'];
    $result['status'] = mo_radar_status($manifest, $now);
    return $result;
}
