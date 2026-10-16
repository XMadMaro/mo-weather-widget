#!/usr/bin/env python3
"""Generuje tests/fixtures/radar-mini.tiff i radar-mini.json dla tests/radar.test.php.

Mini-COG o budowie jak OPERA CIRRUS DBZH (sterownik COG z GDAL, LAEA, 2 pasma Float32
przeplatane, kafel 512, DEFLATE bez predyktora, nodata -9999000), ale tylko 512x512 px
z początkiem w (2400 km, -2400 km), żeby jeden kafel pokrywał całe okno mapy widgetu.

W JSON zapisujemy wynik wzorcowy policzony DOKŁADNIE przez PROJ (pyproj) dla każdego
z 704x676 pikseli wyjściowych: md5 siatki klas i histogram. Test w PHP musi dać identyczny wynik.

Uruchomienie (tylko przy zmianie fixture; wymaga rasterio, pyproj, numpy):
    python tests/fixtures/make-radar-fixture.py
"""
import hashlib
import json
import math
import os

import numpy as np
from pyproj import Transformer
from rasterio.crs import CRS
from rasterio.io import MemoryFile
from rasterio.shutil import copy as rio_copy
from rasterio.transform import Affine

HERE = os.path.dirname(os.path.abspath(__file__))
LAEA = "+proj=laea +lat_0=55 +lon_0=10 +x_0=1950000 +y_0=-2100000 +ellps=WGS84 +units=m +no_defs"
N, X0, Y0 = 512, 2400000.0, -2400000.0
NODATA, UNDETECT = -9999000.0, -8888000.0
W, H, R = 704, 676, 6378137.0
LL = (16.8, 48.9, 21.2, 51.6)


def merc(lon, lat):
    return R * math.radians(lon), R * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def classify(v):
    c = np.zeros(v.shape, np.uint8)
    nan = np.isnan(v)
    x = np.where(nan, 0, v)
    c[(x <= -9.4e6) & ~nan] = 1
    ok = (x >= 10) & ~nan
    c[ok] = np.clip(2 + np.floor((x[ok] - 10) / 5), 2, 13).astype(np.uint8)
    return c


def main():
    kx, ky = Transformer.from_crs("EPSG:4326", LAEA, always_xy=True).transform(19.0238, 50.2649)  # Katowice
    rows, cols = np.mgrid[0:N, 0:N].astype(np.float64)
    px = X0 + (cols + 0.5) * 1000.0
    py = Y0 - (rows + 0.5) * 1000.0
    dist = np.hypot(px - kx, py - ky) / 1000.0
    # Opad 70 dBZ w Katowicach malejący do 10 dBZ na 120 km (wszystkie klasy palety), dalej „undetect”.
    band1 = np.where(dist <= 120, np.round((70 - 0.5 * dist) * 2) / 2, UNDETECT).astype(np.float32)
    band1[0:60, :] = NODATA          # pas bez pokrycia (szary „brak danych”)
    band1[180:183, 300:303] = np.nan  # kilka pikseli NaN (mają być przezroczyste)
    band2 = np.full((N, N), 0.9, np.float32)
    profile = dict(driver="GTiff", width=N, height=N, count=2, dtype="float32", crs=CRS.from_proj4(LAEA),
                   transform=Affine(1000, 0, X0, 0, -1000, Y0), nodata=NODATA, tiled=True,
                   blockxsize=512, blockysize=512, compress="deflate", interleave="pixel")
    tiff = os.path.join(HERE, "radar-mini.tiff")
    with MemoryFile() as mem:
        with mem.open(**profile) as ds:
            ds.write(band1, 1)
            ds.write(band2, 2)
        with mem.open() as src:
            rio_copy(src, tiff, driver="COG", COMPRESS="DEFLATE", PREDICTOR="NO", BLOCKSIZE=512,
                     OVERVIEWS="NONE", BIGTIFF="NO")

    # Wzorzec: środek każdego piksela wyjściowego przeliczony osobno przez PROJ.
    x0, y0 = merc(LL[0], LL[1])
    x1, y1 = merc(LL[2], LL[3])
    gx, gy = np.meshgrid(x0 + (np.arange(W) + 0.5) * (x1 - x0) / W, y1 - (np.arange(H) + 0.5) * (y1 - y0) / H)
    sx, sy = Transformer.from_crs("EPSG:3857", LAEA, always_xy=True).transform(gx, gy)
    col = np.floor((sx - X0) / 1000.0).astype(int)
    row = np.floor((Y0 - sy) / 1000.0).astype(int)
    assert col.min() >= 0 and row.min() >= 0 and col.max() < N and row.max() < N
    cls = classify(band1[row, col])
    hist = np.bincount(cls.ravel(), minlength=14).tolist()
    meta = {
        "tiff": "radar-mini.tiff",
        "tiff_bytes": os.path.getsize(tiff),
        "classes_md5": hashlib.md5(cls.tobytes()).hexdigest(),
        "histogram": hist,
        "window": {"cols": [int(col.min()), int(col.max())], "rows": [int(row.min()), int(row.max())]},
        "katowice_pixel": [int(round((merc(19.0238, 50.2649)[0] - x0) / (x1 - x0) * W - 0.5)),
                           int(round((y1 - merc(19.0238, 50.2649)[1]) / (y1 - y0) * H - 0.5))],
        "katowice_class": 13,
        "note": "Wzorzec z pyproj (dokładne przeliczenie każdego piksela). Nie edytować ręcznie.",
    }
    kxp, kyp = meta["katowice_pixel"]
    meta["katowice_class"] = int(cls[kyp, kxp])
    with open(os.path.join(HERE, "radar-mini.json"), "w") as f:
        json.dump(meta, f, indent=1)
    print(json.dumps(meta, indent=1))


if __name__ == "__main__":
    main()
