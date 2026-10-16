#!/usr/bin/env python3
"""Syntetyczne klatki o budowie identycznej z OPERA CIRRUS DBZH COG.

Służy do testu dekodera (render-frame.php). To NIE są prawdziwe dane radarowe.

Budowa jak w nagłówku prawdziwego pliku (RADAR-PLAN.md C.2):
- 3800x4400 px, piksel 1000 m, projekcja LAEA;
- 2 pasma Float32 przeplatane, kafle 512, DEFLATE bez predyktora;
- nodata -9999000, undetect -8888000, overviews liczone metodą CUBIC.

Pliki zapisuje sterownik COG z GDAL (przez rasterio), jak w OPERA.

    python make-synthetic.py KATALOG [--frames 13] [--end YYYYMMDDTHHMM]
"""
import argparse
import datetime as dt
import os

import numpy as np
import rasterio
from pyproj import Transformer
from rasterio.crs import CRS
from rasterio.io import MemoryFile
from rasterio.shutil import copy as rio_copy
from rasterio.transform import Affine

LAEA = "+proj=laea +lat_0=55 +lon_0=10 +x_0=1950000 +y_0=-2100000 +ellps=WGS84 +units=m +no_defs"
W, H = 3800, 4400
NODATA, UNDETECT = -9999000.0, -8888000.0
# Obszar, w którym rysujemy echa (kolumny/wiersze siatki OPERA); okno mapy to ok. 2420-2769 x 2417-2755.
R0, C0, SIZE = 2200, 2200, 800
RADARS = {  # przybliżone położenia radarów w okolicy (pokrycie 250 km)
    "plleg": (20.9611, 52.4053), "plram": (18.7251, 50.1513), "plpas": (16.0395, 50.8925),
    "plrze": (22.0370, 50.1141), "plpoz": (16.7970, 52.4133), "plswi": (15.8368, 53.7958),
    "plbrz": (20.0832, 50.3942), "pluzr": (21.4121, 53.8565), "plgsa": (18.1532, 50.4639),
    "plgdy": (18.2718, 54.5009), "czbrd": (13.818, 49.658), "czska": (16.789, 49.501),
    "skjav": (17.153, 48.256), "skkoj": (20.987, 48.783), "skkub": (19.249, 49.272),
    "sklaz": (19.258, 48.583), "dedrs": (13.769, 51.125), "depro": (13.858, 52.648),
    "deeis": (12.403, 49.541), "atrau": (16.537, 48.074), "hunap": (21.89, 47.96),
    "huhar": (17.80, 47.18),
}
TO_LAEA = Transformer.from_crs("EPSG:4326", LAEA, always_xy=True)


def grid_rc(lon, lat):
    x, y = TO_LAEA.transform(lon, lat)
    return -y / 1000.0, x / 1000.0  # (wiersz, kolumna) przy początku siatki (0, 0)


def smooth_noise(shape, sigma, rng):
    n = rng.standard_normal(shape)
    fy = np.fft.fftfreq(shape[0])[:, None]
    fx = np.fft.rfftfreq(shape[1])[None, :]
    g = np.exp(-2 * (np.pi * sigma) ** 2 * (fx ** 2 + fy ** 2))
    out = np.fft.irfft2(np.fft.rfft2(n) * g, s=shape)
    return (out - out.mean()) / out.std()


def coverage_mask():
    rows = np.arange(H, dtype=np.float32)[:, None]
    cols = np.arange(W, dtype=np.float32)[None, :]
    mask = np.zeros((H, W), dtype=bool)
    for lon, lat in RADARS.values():
        r, c = grid_rc(lon, lat)
        mask |= (rows - r) ** 2 + (cols - c) ** 2 <= 250.0 ** 2
    return mask


def echo_field(k, rng_seed=7):
    """Pole dBZ dla obszaru SIZE x SIZE w klatce k (ruch na północny wschód)."""
    rng = np.random.default_rng(rng_seed)
    big = SIZE + 120
    strat = 0.7 * smooth_noise((big, big), 40, rng) + 0.25 * smooth_noise((big, big), 8, rng) \
        + 0.05 * smooth_noise((big, big), 2, rng)
    dx, dy = 2.6 * k, -1.8 * k  # px na klatkę: ok. 3 km / 5 min na NE
    oy, ox = int(round(60 - dy)), int(round(60 - dx))
    rr, cc = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32)
    # Pas opadów wokół linii szkwałowej (SW -> NE), przesuwany razem z komórkami.
    (ra, ca), (rb, cb) = grid_rc(17.9, 49.65), grid_rc(19.9, 51.0)
    ra, ca, rb, cb = ra - R0 + dy, ca - C0 + dx, rb - R0 + dy, cb - C0 + dx
    dist = np.abs((rb - ra) * (cc - ca) - (cb - ca) * (rr - ra)) / np.hypot(rb - ra, cb - ca)
    band = np.exp(-(dist / 30.0) ** 2)
    dbz = -3 + 15 * strat[oy:oy + SIZE, ox:ox + SIZE] + 16 * band
    cells = [  # (lon, lat, szczyt dBZ, sigma km): linia szkwałowa SW -> NE przez Śląsk
        (18.05, 49.78, 54, 4.5), (18.40, 49.98, 49, 5.0), (18.70, 50.20, 58, 4.0),
        (18.98, 50.32, 52, 5.5), (19.25, 50.45, 56, 4.0), (19.48, 50.63, 47, 6.0),
        (19.15, 50.86, 51, 4.5), (17.80, 50.15, 45, 6.5), (20.05, 50.20, 50, 5.0),
    ]
    for n, (lon, lat, peak, sig) in enumerate(cells):
        r, c = grid_rc(lon, lat)
        r, c = r - R0 + dy, c - C0 + dx
        life = peak + 4 * np.sin(k / 3.0 + n)  # cele rosną i słabną
        cell = life - 4.343 * ((rr - r) ** 2 + (cc - c) ** 2) / (2 * sig ** 2)
        dbz = np.maximum(dbz, cell)
    dbz = dbz + rng.normal(0, 1.2, dbz.shape)
    return dbz.astype(np.float32)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out")
    ap.add_argument("--frames", type=int, default=13)
    ap.add_argument("--end", default=None)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    if a.end:
        end = dt.datetime.strptime(a.end, "%Y%m%dT%H%M")
    else:
        now = dt.datetime.now(dt.timezone.utc).replace(tzinfo=None) - dt.timedelta(minutes=5)
        end = now.replace(minute=now.minute - now.minute % 5, second=0, microsecond=0)
    cov = coverage_mask()
    base1 = np.where(cov, UNDETECT, NODATA).astype(np.float32)
    rows = np.arange(H, dtype=np.float32)[:, None]
    cols = np.arange(W, dtype=np.float32)[None, :]
    dist = np.full((H, W), 1e9, dtype=np.float32)
    for lon, lat in RADARS.values():
        r, c = grid_rc(lon, lat)
        dist = np.minimum(dist, np.sqrt((rows - r) ** 2 + (cols - c) ** 2))
    base2 = np.where(cov, np.clip(1 - dist / 300.0, 0, 1), NODATA).astype(np.float32)
    rng = np.random.default_rng(1)
    for k in range(a.frames):
        t = end - dt.timedelta(minutes=5 * (a.frames - 1 - k))
        b1 = base1.copy()
        sub = echo_field(k)
        region = b1[R0:R0 + SIZE, C0:C0 + SIZE]
        covered = region != NODATA
        region[covered & (sub >= 8)] = sub[covered & (sub >= 8)]
        nan_r = rng.integers(0, SIZE, 300)
        nan_c = rng.integers(0, SIZE, 300)
        sel = region[nan_r, nan_c] == UNDETECT
        region[nan_r[sel], nan_c[sel]] = np.nan  # test ścieżki NaN
        profile = dict(driver="GTiff", width=W, height=H, count=2, dtype="float32", crs=CRS.from_proj4(LAEA),
                       transform=Affine(1000, 0, 0, 0, -1000, 0), nodata=NODATA, tiled=True,
                       blockxsize=512, blockysize=512, compress="deflate", interleave="pixel")
        name = f"OPERA@{t:%Y%m%dT%H%M}@0@DBZH.tiff"
        with MemoryFile() as mem:
            with mem.open(**profile) as ds:
                ds.write(b1, 1)
                ds.write(base2, 2)
                ds.set_band_description(1, "DBZH")
                ds.set_band_description(2, "quality1")
                ds.update_tags(synthetic="yes, NOT real radar data",
                               license="https://creativecommons.org/licenses/by/4.0/ (CC BY 4.0)")
            with mem.open() as src:
                rio_copy(src, os.path.join(a.out, name), driver="COG", COMPRESS="DEFLATE", PREDICTOR="NO",
                         BLOCKSIZE=512, OVERVIEWS="AUTO", RESAMPLING="CUBIC", BIGTIFF="NO")
        print(name, os.path.getsize(os.path.join(a.out, name)), "B", flush=True)


if __name__ == "__main__":
    main()
