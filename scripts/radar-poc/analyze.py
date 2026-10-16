#!/usr/bin/env python3
"""Radar PoC: sprawdzenie źródeł danych dla radaru w <mo-weather>.

Uruchamiane w GitHub Actions (ubuntu-24.04 + gdal-bin + python3-gdal + numpy).
Wyniki trafiają do katalogu z argv[1] (domyślnie docs/radar-poc).
Kod jednorazowy (PoC), nie produkcja.
"""
import datetime as dt
import json
import math
import os
import re
import subprocess
import sys
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

import numpy as np
from osgeo import gdal, ogr, osr

gdal.UseExceptions()
ogr.UseExceptions()
osr.UseExceptions()

CONFIG = {
    "GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR",
    "CPL_VSIL_CURL_ALLOWED_EXTENSIONS": ".tiff",
    "GDAL_HTTP_TIMEOUT": "30",
    "GDAL_HTTP_MAX_RETRY": "3",
    "GDAL_HTTP_RETRY_DELAY": "2",
    "GDAL_PAM_ENABLED": "NO",
}
for _k, _v in CONFIG.items():
    gdal.SetConfigOption(_k, _v)
    os.environ[_k] = _v

OUT = sys.argv[1] if len(sys.argv) > 1 else "docs/radar-poc"
CACHE = "/tmp/opera"
os.makedirs(OUT, exist_ok=True)
os.makedirs(CACHE, exist_ok=True)
HERE = os.path.dirname(os.path.abspath(__file__))
PALETTE = os.path.join(HERE, "radar-palette.txt")
S3 = "https://s3.waw3-1.cloudferro.com/openradar-24h"
EUMV = "https://view.eumetsat.int/geoserver"
UA = "mo-weather-widget-radar-poc/0.1 (+https://github.com/XMadMaro/mo-weather-widget)"
KEY_RE = re.compile(r"^\d{4}/\d{2}/\d{2}/OPERA/COMP/OPERA@(\d{8}T\d{4})@0@DBZH\.tiff$")
RENDER_BBOX = (16.8, 48.9, 21.2, 51.6)  # okno klatki widgetu (lon/lat)
POLAND_BBOX = (13.8, 48.8, 24.4, 55.0)
WOJ_URL = ("https://raw.githubusercontent.com/ppatrzyk/polska-geojson/master/"
           "wojewodztwa/wojewodztwa-medium.geojson")
# OPERA_RADARS.csv: kod ODIM -> (nazwa, lat, lon, status w OPERA)
RADARS = {
    "plleg": ("Legionowo", 52.4053, 20.9611, 1),
    "plram": ("Ramża", 50.1513, 18.7251, 1),
    "plpas": ("Pastewnik", 50.8925, 16.0395, 1),
    "plrze": ("Rzeszów", 50.1141, 22.0370, 1),
    "plpoz": ("Poznań", 52.4133, 16.7970, 1),
    "plswi": ("Świdwin", 53.7958, 15.8368, 1),
    "plbrz": ("Brzuchania", 50.3942, 20.0832, 1),
    "pluzr": ("Uzranki", 53.8565, 21.4121, 1),
    "plgda": ("Gdańsk", 54.3843, 18.4563, 0),
    "plgsa": ("Góra Św. Anny", 50.4639, 18.1532, 0),
    "plgdy": ("Gdynia-Szemud", 54.5009, 18.2718, 0),
}
CLASS_NAMES = ["nodata", "undetect", "lt10", "10_20", "20_35", "35_45", "ge45", "nan"]

R = {
    "generated_utc": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "errors": [],
    "timings_s": {},
}
CTX = {}


def save():
    with open(os.path.join(OUT, "poc-results.json"), "w") as f:
        json.dump(R, f, indent=2, ensure_ascii=False, default=str)


def section(fn):
    name = fn.__name__

    def run(*a, **k):
        t0 = time.time()
        try:
            return fn(*a, **k)
        except Exception as e:  # PoC: zapisujemy błąd i idziemy dalej
            R["errors"].append({"section": name, "error": repr(e), "trace": traceback.format_exc()[-3000:]})
            print(f"[{name}] ERROR: {e!r}", file=sys.stderr, flush=True)
            return None
        finally:
            R["timings_s"][name] = round(time.time() - t0, 2)
            print(f"[{name}] {R['timings_s'][name]} s", flush=True)
            save()

    return run


def http(url, timeout=30, headers=None):
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()


def stats(xs):
    a = np.asarray(xs, dtype=float).ravel()
    if a.size == 0:
        return None
    return {"n": int(a.size), "min": round(float(a.min()), 2), "median": round(float(np.median(a)), 2),
            "p90": round(float(np.percentile(a, 90)), 2), "max": round(float(a.max()), 2)}


def parse_t(t):
    return dt.datetime.strptime(t, "%Y%m%dT%H%M").replace(tzinfo=dt.timezone.utc)


def ll_srs():
    s = osr.SpatialReference()
    s.ImportFromEPSG(4326)
    s.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    return s


def srs_of(ds):
    s = ds.GetSpatialRef().Clone()
    s.SetAxisMappingStrategy(osr.OAMS_TRADITIONAL_GIS_ORDER)
    return s


def merc(lon, lat):
    r = 6378137.0
    return r * math.radians(lon), r * math.log(math.tan(math.pi / 4 + math.radians(lat) / 2))


def run_cmd(args):
    p = subprocess.run(args, capture_output=True, text=True, timeout=180)
    if p.returncode != 0:
        raise RuntimeError(f"{args[0]} exit {p.returncode}: {p.stderr[-1500:]}")
    return p.stdout


# ---------------------------------------------------------------- OPERA: listing S3


def parse_listing(body):
    root = ET.fromstring(body)
    out = []
    for el in root.iter():
        if el.tag.rsplit("}", 1)[-1] == "Contents":
            out.append({c.tag.rsplit("}", 1)[-1]: (c.text or "") for c in el})
    return out


@section
def s3_listing():
    now = dt.datetime.now(dt.timezone.utc)
    frames, other = {}, 0
    for h in range(0, 26):
        t = now - dt.timedelta(hours=h)
        prefix = t.strftime("%Y/%m/%d/OPERA/COMP/OPERA@%Y%m%dT%H")
        _, _, body = http(f"{S3}/?prefix={urllib.parse.quote(prefix)}")
        for it in parse_listing(body):
            m = KEY_RE.match(it.get("Key", ""))
            if m:
                frames[m.group(1)] = {"key": it["Key"], "t": m.group(1), "size": int(it.get("Size") or 0),
                                      "last_modified": it.get("LastModified", "")}
            else:
                other += 1
    ts = sorted(frames)
    delays = []
    for t in ts:
        try:
            lm = dt.datetime.fromisoformat(frames[t]["last_modified"].replace("Z", "+00:00"))
            delays.append((lm - parse_t(t)).total_seconds() / 60)
        except ValueError:
            pass
    gaps = []
    for a, b in zip(ts, ts[1:]):
        d = (parse_t(b) - parse_t(a)).total_seconds() / 60
        if d > 5:
            gaps.append({"after": a, "minutes": d})
    R["s3"] = {
        "frames_found": len(ts),
        "first": ts[0] if ts else None,
        "last": ts[-1] if ts else None,
        "age_of_last_min_at_check": round((now - parse_t(ts[-1])).total_seconds() / 60, 1) if ts else None,
        "other_objects_in_prefixes": other,
        "publish_delay_min": stats(delays),
        "file_size_bytes": stats([frames[t]["size"] for t in ts]),
        "gaps_over_5min": gaps[:60],
    }
    return frames


def download(frame):
    path = os.path.join(CACHE, frame["t"] + ".tiff")
    if not os.path.exists(path):
        req = urllib.request.Request(f"{S3}/{frame['key']}", headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=90) as r, open(path + ".part", "wb") as f:
            f.write(r.read())
        os.replace(path + ".part", path)
    return path


# ---------------------------------------------------------------- OPERA: budowa pliku


@section
def cog_info(frame):
    url = f"/vsicurl/{S3}/{frame['key']}"
    txt = gdal.Info(url)
    with open(os.path.join(OUT, "gdalinfo_latest.txt"), "w") as f:
        f.write(f"# {frame['key']}\n{txt}")
    js = gdal.Info(url, format="json")
    wkt = (js.get("coordinateSystem") or {}).get("wkt")
    proj4 = None
    if wkt:
        s = osr.SpatialReference()
        s.ImportFromWkt(wkt)
        proj4 = s.ExportToProj4()
    R["cog"] = {
        "key": frame["key"],
        "size_px": js.get("size"),
        "geoTransform": js.get("geoTransform"),
        "proj4": proj4,
        "image_structure": (js.get("metadata") or {}).get("IMAGE_STRUCTURE"),
        "bands": [{"band": b.get("band"), "type": b.get("type"), "block": b.get("block"),
                   "noDataValue": b.get("noDataValue"), "description": b.get("description"),
                   "overviews": len(b.get("overviews", []))} for b in js.get("bands", [])],
    }


@section
def tiff_tags(path):
    p = subprocess.run(["tiffinfo", path], capture_output=True, text=True, timeout=60)
    txt = p.stdout
    with open(os.path.join(OUT, "tiffinfo_latest.txt"), "w") as f:
        f.write(txt[:15000])
    first = txt.split("TIFF Directory at offset")
    first = first[1] if len(first) > 1 else txt

    def tag(name):
        m = re.search(name + r":\s*([^\n]+)", first)
        return m.group(1).strip() if m else None

    R.setdefault("cog", {})["tiff_first_ifd"] = {
        "Compression": tag("Compression Scheme"),
        "Predictor": tag("Predictor") or "brak tagu (= 1, bez predyktora)",
        "Planar": tag("Planar Configuration"),
        "SampleFormat": tag("Sample Format"),
        "BitsPerSample": tag("Bits/Sample"),
        "SamplesPerPixel": tag("Samples/Pixel"),
        "Tile": tag("Tile Width"),
        "ByteOrder": "little-endian" if "little-endian" in txt else ("big-endian" if "big-endian" in txt else None),
    }


# ---------------------------------------------------------------- geometria


def load_polygons():
    path = "/tmp/woj.geojson"
    if not os.path.exists(path):
        _, _, body = http(WOJ_URL, timeout=60)
        with open(path, "wb") as f:
            f.write(body)
    src = ogr.Open(path)
    lyr = src.GetLayer(0)
    slask, allg = None, []
    for feat in lyr:
        g = feat.GetGeometryRef().Clone()
        allg.append(g)
        if (feat.GetField("nazwa") or "").strip().lower() == "śląskie":
            slask = g
    if slask is None:
        raise RuntimeError("brak województwa śląskiego w GeoJSON")
    return slask, allg


def window_for(ds, bbox, densify=40):
    gt = ds.GetGeoTransform()
    ct = osr.CoordinateTransformation(ll_srs(), srs_of(ds))
    x0, y0, x1, y1 = bbox
    pts = []
    for i in range(densify + 1):
        f = i / densify
        pts += [(x0 + f * (x1 - x0), y0), (x0 + f * (x1 - x0), y1), (x0, y0 + f * (y1 - y0)), (x1, y0 + f * (y1 - y0))]
    xy = [ct.TransformPoint(lon, lat)[:2] for lon, lat in pts]
    xs = [p[0] for p in xy]
    ys = [p[1] for p in xy]
    c0 = max(0, math.floor((min(xs) - gt[0]) / gt[1]))
    c1 = min(ds.RasterXSize, math.ceil((max(xs) - gt[0]) / gt[1]))
    r0 = max(0, math.floor((max(ys) - gt[3]) / gt[5]))
    r1 = min(ds.RasterYSize, math.ceil((min(ys) - gt[3]) / gt[5]))
    return (int(c0), int(r0), int(c1 - c0), int(r1 - r0))


def tiles_for(win, block):
    c0, r0, w, h = win
    cols = list(range(c0 // block[0], (c0 + w - 1) // block[0] + 1))
    rows = list(range(r0 // block[1], (r0 + h - 1) // block[1] + 1))
    return len(cols) * len(rows), cols, rows


def mask_for(geoms, ds, win):
    gt = ds.GetGeoTransform()
    c0, r0, w, h = win
    srs = srs_of(ds)
    m = gdal.GetDriverByName("MEM").Create("", w, h, 1, gdal.GDT_Byte)
    m.SetGeoTransform((gt[0] + c0 * gt[1], gt[1], 0.0, gt[3] + r0 * gt[5], 0.0, gt[5]))
    m.SetSpatialRef(srs)
    vds = ogr.GetDriverByName("Memory").CreateDataSource("m")
    lyr = vds.CreateLayer("m", srs=srs, geom_type=ogr.wkbMultiPolygon)
    ct = osr.CoordinateTransformation(ll_srs(), srs)
    for g in geoms:
        g2 = g.Clone()
        g2.Transform(ct)
        f = ogr.Feature(lyr.GetLayerDefn())
        f.SetGeometry(g2)
        lyr.CreateFeature(f)
    gdal.RasterizeLayer(m, [1], lyr, burn_values=[1])
    return m.ReadAsArray().astype(bool)


def classify(a):
    c = np.zeros(a.shape, np.uint8)  # 0 = nodata (brak pokrycia)
    isnan = np.isnan(a)
    a = np.where(isnan, -9.9e6, a)
    nod = (a <= -9.4e6) & ~isnan
    und = ~nod & (a <= -8.0e6)
    val = ~nod & ~und
    c[und] = 1
    c[val & (a < 10)] = 2
    c[val & (a >= 10) & (a < 20)] = 3
    c[val & (a >= 20) & (a < 35)] = 4
    c[val & (a >= 35) & (a < 45)] = 5
    c[val & (a >= 45)] = 6
    c[isnan] = 7  # NaN osobno: w metadanych COG jest "nan", trzeba ustalić, co oznacza
    return c


def counts(c, mask):
    sel = c[mask]
    n = int(sel.size)
    d = {"pixels_km2": n}
    for i, nm in enumerate(CLASS_NAMES):
        k = int((sel == i).sum())
        d[nm + "_pct"] = round(100.0 * k / n, 2) if n else None
    return d


def save_classes(cls, ds, win, path):
    gt = ds.GetGeoTransform()
    c0, r0, w, h = win
    o = gdal.GetDriverByName("GTiff").Create(path, w, h, 1, gdal.GDT_Byte,
                                             options=["COMPRESS=DEFLATE", "PREDICTOR=2"])
    o.SetGeoTransform((gt[0] + c0 * gt[1], gt[1], 0.0, gt[3] + r0 * gt[5], 0.0, gt[5]))
    o.SetSpatialRef(ds.GetSpatialRef())
    o.GetRasterBand(1).WriteArray(cls)
    o.GetRasterBand(1).SetDescription("0 nodata,1 undetect,2 <10,3 10-20,4 20-35,5 35-45,6 >=45 dBZ,7 NaN")
    o = None


def masks(ds):
    win = window_for(ds, POLAND_BBOX)
    key = (tuple(ds.GetGeoTransform()), win)
    if CTX.get("mask_key") != key:
        slask, allg = CTX["polys"]
        CTX["mask_key"] = key
        CTX["win"] = win
        CTX["m_sl"] = mask_for([slask], ds, win)
        CTX["m_pl"] = mask_for(allg, ds, win)
    return CTX["win"], CTX["m_sl"], CTX["m_pl"]


# ---------------------------------------------------------------- OPERA: pokrycie i echo


@section
def render_window(path):
    ds = gdal.Open(path)
    win = window_for(ds, RENDER_BBOX)
    block = ds.GetRasterBand(1).GetBlockSize()
    n, cols, rows = tiles_for(win, block)
    R["render_window"] = {"bbox_ll": RENDER_BBOX, "opera_window_px": win, "block": block,
                          "tiles_needed": n, "tile_cols": cols, "tile_rows": rows,
                          "bbox_3857": [round(v) for v in merc(RENDER_BBOX[0], RENDER_BBOX[1]) + merc(RENDER_BBOX[2], RENDER_BBOX[3])]}


@section
def coverage(path, label):
    ds = gdal.Open(path)
    win, m_sl, m_pl = masks(ds)
    b1 = ds.GetRasterBand(1).ReadAsArray(*win).astype(np.float64)
    cls = classify(b1)
    res = {"poland_window_px": win, "poland": counts(cls, m_pl), "slaskie": counts(cls, m_sl)}
    v = m_sl & (cls >= 2) & (cls <= 6)
    res["slaskie_max_dbz"] = round(float(b1[v].max()), 1) if v.any() else None
    if ds.RasterCount >= 2:
        q = ds.GetRasterBand(2).ReadAsArray(*win).astype(np.float64)[m_sl]
        q = q[np.isfinite(q) & (q > -1e6)]
        res["slaskie_quality_band"] = stats(q)
    gt = ds.GetGeoTransform()
    c0, r0, w, h = win
    xs = gt[0] + (np.arange(c0, c0 + w) + 0.5) * gt[1]
    ys = gt[3] + (np.arange(r0, r0 + h) + 0.5) * gt[5]
    X, Y = np.meshgrid(xs, ys)
    ct = osr.CoordinateTransformation(ll_srs(), srs_of(ds))
    per = {}
    for code, (name, lat, lon, status) in RADARS.items():
        x, y = ct.TransformPoint(lon, lat)[:2]
        ring = np.hypot(X - x, Y - y) <= 60000
        if ring.any():
            per[code] = {"name": name, "opera_status": status,
                         "covered_pct_60km": round(100.0 * float((cls[ring] != 0).mean()), 1),
                         "nan_pct_60km": round(100.0 * float((cls[ring] == 7).mean()), 1)}
    res["radars_60km"] = per
    save_classes(cls, ds, win, os.path.join(OUT, f"classes_{label}.tif"))
    R.setdefault("coverage", {})[label] = res


@section
def echo_search(frames):
    ts = sorted(frames)
    by_hour = {}
    for t in ts:
        by_hour.setdefault(t[:11], t)
    rows = []
    for t in [by_hour[h] for h in sorted(by_hour)]:
        try:
            ds = gdal.Open(download(frames[t]))
            win, m_sl, m_pl = masks(ds)
            cls = classify(ds.GetRasterBand(1).ReadAsArray(*win).astype(np.float64))
            rows.append({
                "t": t,
                "slaskie_ge20_km2": int(((cls >= 4) & (cls <= 6) & m_sl).sum()),
                "slaskie_ge35_km2": int(((cls >= 5) & (cls <= 6) & m_sl).sum()),
                "poland_ge20_km2": int(((cls >= 4) & (cls <= 6) & m_pl).sum()),
                "poland_ge35_km2": int(((cls >= 5) & (cls <= 6) & m_pl).sum()),
                "slaskie_nodata_pct": round(100.0 * float((cls[m_sl] == 0).mean()), 2),
                "poland_nodata_pct": round(100.0 * float((cls[m_pl] == 0).mean()), 2),
            })
        except Exception as e:  # pojedyncza klatka nie psuje całości
            rows.append({"t": t, "error": repr(e)})
    ok = [r for r in rows if "error" not in r]
    R["echo_24h"] = {"rows": rows}
    if not ok:
        return None
    best_sl = max(ok, key=lambda r: (r["slaskie_ge20_km2"], r["slaskie_ge35_km2"]))
    best_pl = max(ok, key=lambda r: (r["poland_ge20_km2"], r["poland_ge35_km2"]))
    best = best_sl if best_sl["slaskie_ge20_km2"] >= 300 else best_pl
    end_dt = min(parse_t(best["t"]) + dt.timedelta(minutes=30), parse_t(ts[-1]))
    end_t = [t for t in ts if parse_t(t) <= end_dt][-1]
    R["echo_24h"].update({"best_slaskie": best_sl, "best_poland": best_pl, "chosen": best["t"],
                          "chosen_reason": "slaskie" if best is best_sl else "poland",
                          "animation_end": end_t,
                          "nodata_pct_slaskie_all_hours": stats([r["slaskie_nodata_pct"] for r in ok]),
                          "nodata_pct_poland_all_hours": stats([r["poland_nodata_pct"] for r in ok])})
    with open(os.path.join(OUT, "maxecho_end.txt"), "w") as f:
        f.write(end_t)
    return best["t"]


@section
def europe_png(frame, label):
    url = f"/vsicurl/{S3}/{frame['key']}"
    base = f"/tmp/eu_{label}"
    run_cmd(["gdal_translate", "-q", "-of", "VRT", "-b", "1", url, base + ".vrt"])
    run_cmd(["gdalwarp", "-q", "-overwrite", "-ovr", "NONE", "-te", "-12", "34", "36", "68.5", "-te_srs", "EPSG:4326",
             "-t_srs", "EPSG:3857", "-ts", "900", "0", "-r", "near", base + ".vrt", base + ".tif"])
    run_cmd(["gdaldem", "color-relief", "-q", "-of", "PNG", "-alpha", "-nearest_color_entry", base + ".tif",
             PALETTE, os.path.join(OUT, f"europe_{label}.png")])
    R.setdefault("europe_png", {})[label] = {"t": frame["t"], "bytes": os.path.getsize(os.path.join(OUT, f"europe_{label}.png"))}


# ---------------------------------------------------------------- pozostałe źródła


def png_alpha_pixels(path):
    ds = gdal.Open(path)
    if ds.RasterCount in (2, 4):
        return int((ds.GetRasterBand(ds.RasterCount).ReadAsArray() > 0).sum())
    b = ds.GetRasterBand(1)
    arr = b.ReadAsArray()
    ct = b.GetColorTable()
    if ct is not None:
        alpha = np.array([ct.GetColorEntry(i)[3] for i in range(ct.GetCount())])
        return int((alpha[arr] > 0).sum())
    return int(arr.size)


@section
def lightning(extra_time=None):
    res = {}
    st, hd, body = http(f"{EUMV}/mtg_fd/li_afa/ows?service=WMS&version=1.3.0&request=GetCapabilities", timeout=60)
    txt = body.decode("utf-8", "replace")
    m = re.search(r"<Dimension[^>]*name=\"time\"[^>]*>([^<]+)</Dimension>", txt)
    dm = re.search(r"<Dimension[^>]*name=\"time\"[^>]*default=\"([^\"]+)\"", txt) or \
        re.search(r"<Dimension[^>]*default=\"([^\"]+)\"[^>]*name=\"time\"", txt)
    ext = m.group(1).strip() if m else None
    default = dm.group(1) if dm else None
    res["capabilities"] = {"status": st, "time_default": default,
                           "time_extent_tail": ext[-120:] if ext else None}
    last = default
    if not last and ext:
        tail = ext.split(",")[-1]
        last = tail.split("/")[1] if "/" in tail else tail
    if last:
        try:
            lt = dt.datetime.fromisoformat(last.replace("Z", "+00:00"))
            res["latency_min_at_check"] = round((dt.datetime.now(dt.timezone.utc) - lt).total_seconds() / 60, 1)
        except ValueError:
            pass

    def getmap(name, ll_bbox, w, t):
        x0, y0 = merc(ll_bbox[0], ll_bbox[1])
        x1, y1 = merc(ll_bbox[2], ll_bbox[3])
        h = int(round(w * (y1 - y0) / (x1 - x0)))
        q = {"service": "WMS", "version": "1.3.0", "request": "GetMap", "layers": "mtg_fd:li_afa", "styles": "",
             "crs": "EPSG:3857", "bbox": f"{x0:.0f},{y0:.0f},{x1:.0f},{y1:.0f}", "width": w, "height": h,
             "format": "image/png", "transparent": "true"}
        if t:
            q["time"] = t
        url = f"{EUMV}/ows?{urllib.parse.urlencode(q)}"
        try:
            st, hd, body = http(url, timeout=60)
        except urllib.error.HTTPError as e:
            return {"status": e.code, "error": e.read()[:300].decode("utf-8", "replace")}
        ctype = hd.get("content-type", "")
        out = {"status": st, "content_type": ctype, "bytes": len(body), "time": t, "size": [w, h],
               "cache_control": hd.get("cache-control")}
        if ctype.startswith("image/png"):
            path = os.path.join(OUT, f"{name}.png")
            with open(path, "wb") as f:
                f.write(body)
            out["nonzero_alpha_px"] = png_alpha_pixels(path)
        else:
            out["body_head"] = body[:400].decode("utf-8", "replace")
        return out

    res["silesia_latest"] = getmap("lightning_silesia_latest", RENDER_BBOX, 704, last)
    res["fulldisk_latest"] = getmap("lightning_fulldisk_latest", (-40, -40, 60, 66), 800, last)
    if extra_time:
        t = parse_t(extra_time).strftime("%Y-%m-%dT%H:%M:00.000Z")
        res["silesia_at_maxecho"] = getmap("lightning_silesia_maxecho", RENDER_BBOX, 704, t)
    R["lightning_eumetview"] = res


@section
def metno():
    url = "https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=50.2649&lon=19.0238"
    st, hd, body = http(url, timeout=30)
    js = json.loads(body)
    ts0 = js["properties"]["timeseries"][0]
    det = ts0["data"]["instant"]["details"]
    R["metno"] = {"status": st, "expires": hd.get("expires"), "last_modified": hd.get("last-modified"),
                  "first_time": ts0["time"], "wind_from_direction": det.get("wind_from_direction"),
                  "wind_speed_ms": det.get("wind_speed"), "instant_keys": sorted(det.keys())}


@section
def imgw_warnings():
    url = "https://danepubliczne.imgw.pl/api/data/warningsmeteo"
    try:
        st, hd, body = http(url, timeout=30)
    except urllib.error.HTTPError as e:
        R["imgw_warnings"] = {"status": e.code, "body": e.read()[:300].decode("utf-8", "replace")}
        return
    js = json.loads(body)
    sl = [w for w in js if any(str(t).startswith("24") for t in (w.get("teryt") or []))]
    R["imgw_warnings"] = {
        "status": st, "count": len(js), "slaskie_count": len(sl),
        "fields": sorted(js[0].keys()) if js else [],
        "slaskie_sample": [{k: w.get(k) for k in ("nazwa_zdarzenia", "stopien", "obowiazuje_od", "obowiazuje_do")}
                           for w in sl[:5]],
    }


# ---------------------------------------------------------------- main


def main():
    R["gdal_host"] = gdal.__version__
    frames = s3_listing()
    if frames:
        ts = sorted(frames)
        latest = frames[ts[-1]]
        cog_info(latest)
        try:
            path = download(latest)
        except Exception as e:
            R["errors"].append({"section": "download_latest", "error": repr(e)})
            path = None
        if path:
            tiff_tags(path)
            try:
                CTX["polys"] = load_polygons()
            except Exception as e:
                R["errors"].append({"section": "load_polygons", "error": repr(e)})
            render_window(path)
            if "polys" in CTX:
                coverage(path, "latest")
                best = echo_search(frames)
                if best:
                    coverage(download(frames[best]), "maxecho")
                    europe_png(frames[best], "maxecho")
                    CTX["best"] = best
            europe_png(latest, "latest")
    lightning(CTX.get("best"))
    metno()
    imgw_warnings()
    save()
    print(json.dumps({k: R.get(k) for k in ("s3", "cog", "render_window", "errors")}, indent=1, default=str)[:6000])


if __name__ == "__main__":
    main()
