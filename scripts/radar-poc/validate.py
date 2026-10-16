#!/usr/bin/env python3
"""Porównanie klatki z render-frame.php (czyste PHP) z dwoma wzorcami.

Wzorce:
1. dokładne przeliczenie każdego piksela przez PROJ (pyproj) — tu oczekujemy 100%;
2. GDAL warp (nearest) z domyślnym, przybliżonym transformerem (błąd do 0,125 px) — tu ok. 99%.

Obie strony klasyfikujemy tą samą paletą. Przy okazji zapisuje wzorzec GDAL jako PNG.

    python validate.py PLIK_COG KLATKA_PHP.png [wzorzec_gdal.png]
"""
import json
import math
import sys

import numpy as np
import rasterio
from PIL import Image
from pyproj import Transformer
from rasterio.transform import from_bounds
from rasterio.warp import Resampling, reproject

W, H = 704, 676
R = 6378137.0
LL = (16.8, 48.9, 21.2, 51.6)
PALETTE = [(0, 0, 0, 0), (128, 128, 128, 60), (160, 220, 255, 150), (90, 175, 255, 190), (35, 120, 245, 215),
           (25, 185, 70, 225), (15, 135, 40, 235), (250, 225, 0, 240), (255, 165, 0, 245), (255, 85, 0, 250),
           (225, 0, 0, 255), (160, 0, 50, 255), (225, 0, 225, 255), (255, 255, 255, 255)]


def merc(lon, lat):
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def classify(a):
    c = np.zeros(a.shape, np.uint8)
    nan = np.isnan(a)
    v = np.where(nan, 0, a)
    c[(v <= -9.4e6) & ~nan] = 1
    ok = (v >= 10) & ~nan
    c[ok] = np.clip(2 + np.floor((v[ok] - 10) / 5), 2, 13).astype(np.uint8)
    return c


def main():
    cog, php_png = sys.argv[1], sys.argv[2]
    ref_png = sys.argv[3] if len(sys.argv) > 3 else None
    x0, y0 = merc(LL[0], LL[1])
    x1, y1 = merc(LL[2], LL[3])
    dst = np.full((H, W), -1.0, np.float32)
    with rasterio.open(cog) as src:
        band = src.read(1)
        tf, crs = src.transform, src.crs
    reproject(band, dst, src_transform=tf, src_crs=crs,
              dst_transform=from_bounds(x0, y0, x1, y1, W, H), dst_crs="EPSG:3857",
              resampling=Resampling.nearest, src_nodata=None, dst_nodata=None)
    ref = classify(dst)
    # Dokładny wzorzec: środek każdego piksela wyjściowego przeliczony osobno przez PROJ.
    to_src = Transformer.from_crs("EPSG:3857", crs.to_proj4(), always_xy=True)
    gx, gy = np.meshgrid(x0 + (np.arange(W) + 0.5) * (x1 - x0) / W, y1 - (np.arange(H) + 0.5) * (y1 - y0) / H)
    sx, sy = to_src.transform(gx, gy)
    col = np.floor((sx - tf.c) / tf.a).astype(int)
    row = np.floor((sy - tf.f) / tf.e).astype(int)
    exact = classify(band[row, col])
    php = np.array(Image.open(php_png))
    same = ref == php
    out = {
        "pixels": int(ref.size),
        "vs_proj_exact_identical_pct": round(100.0 * float((exact == php).mean()), 4),
        "vs_proj_exact_different_pixels": int((exact != php).sum()),
        "vs_gdal_default_identical_pct": round(100.0 * float(same.mean()), 4),
        "vs_gdal_default_different_pixels": int((~same).sum()),
    }
    print(json.dumps(out, indent=1))
    if ref_png:
        img = Image.fromarray(ref, mode="P")
        img.putpalette([v for p in PALETTE for v in p[:3]])
        img.info["transparency"] = bytes(p[3] for p in PALETTE)
        img.save(ref_png, transparency=bytes(p[3] for p in PALETTE))


if __name__ == "__main__":
    main()
