/*
 * MO Weather Widget: matematyka mapy radaru (czyste funkcje, bez DOM).
 *
 * Klatki radaru są rasterem w Web Mercatorze (EPSG:3857) na tym samym bbox co podkład,
 * a kafelki mapy (OSM/CARTO) też są w Web Mercatorze — dlatego radar kładzie się na mapę
 * co do piksela, bez żadnego przeliczania w przeglądarce.
 *
 * Moduł jest wklejany przez scripts/build.sh (basemap -> mapa -> okno radaru) w jednym IIFE,
 * a eksportowane funkcje są testowane w Node (tests/radar-map.test.js).
 */
var MO_RADAR_MAP = (function () {
  'use strict';

  var R = 6378137;      // promień kuli WGS84 (EPSG:3857)
  var TILE = 256;       // rozmiar kafelka w pikselach (schemat XYZ)
  var MAX_LAT = 85.05112878;

  /** lon (stopnie) -> metry Web Mercator. */
  function mercX(lon) { return R * (lon * Math.PI / 180); }

  /** lat (stopnie) -> metry Web Mercator. */
  function mercY(lat) {
    var p = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI / 180;
    return R * Math.log(Math.tan(Math.PI / 4 + p / 2));
  }

  /** metry Web Mercator -> lon/lat (stopnie). */
  function lonOf(x) { return (x / R) * 180 / Math.PI; }
  function latOf(y) { return (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * 180 / Math.PI; }

  /** [zachód, południe, wschód, północ] -> {x0,y0,x1,y1} w metrach. */
  function bboxMerc(bbox) {
    return {
      x0: mercX(bbox[0]), y0: mercY(bbox[1]),
      x1: mercX(bbox[2]), y1: mercY(bbox[3])
    };
  }

  /** Pixels per meter at given (fractional) zoom. */
  function scaleAt(zoom) { return TILE * Math.pow(2, zoom) / (2 * R); }

  /** Widok dopasowany do bbox (z marginesem w px). */
  function fitBounds(bbox, w, h, pad) {
    var b = bboxMerc(bbox);
    pad = pad || 0;
    var availW = Math.max(1, w - pad * 2);
    var availH = Math.max(1, h - pad * 2);
    var k = Math.min(availW / (b.x1 - b.x0), availH / (b.y1 - b.y0));
    return {
      cx: (b.x0 + b.x1) / 2,
      cy: (b.y0 + b.y1) / 2,
      zoom: Math.log2(k * 2 * R / TILE)
    };
  }

  /** Mercator -> ekran (px CSS w ramce o szerokości w i wysokości h). */
  function project(mx, my, view, w, h) {
    var k = scaleAt(view.zoom);
    return { x: (mx - view.cx) * k + w / 2, y: (view.cy - my) * k + h / 2 };
  }

  /** Ekran -> mercator. */
  function unproject(px, py, view, w, h) {
    var k = scaleAt(view.zoom);
    return { x: view.cx + (px - w / 2) / k, y: view.cy - (py - h / 2) / k };
  }

  /** Zakres kafelków widocznych przy zoomie całkowitym z. */
  function tileRange(view, w, h, z) {
    var n = TILE * Math.pow(2, z);
    var max = Math.pow(2, z) - 1;
    var tl = unproject(0, 0, view, w, h);
    var br = unproject(w, h, view, w, h);
    var x0 = Math.floor((tl.x + R) / (2 * R) * n);
    var x1 = Math.floor((br.x + R) / (2 * R) * n);
    var y0 = Math.floor((R - tl.y) / (2 * R) * n);
    var y1 = Math.floor((R - br.y) / (2 * R) * n);
    return {
      x0: Math.max(0, Math.min(max, x0)),
      x1: Math.max(0, Math.min(max, x1)),
      y0: Math.max(0, Math.min(max, y0)),
      y1: Math.max(0, Math.min(max, y1))
    };
  }

  /**
   * Pole natężenia echa z RGBA (RGBA z canvasa): wartość 0..255, maska (1 = echo)
   * i lista indeksów komórek z echem (szybsza korelacja).
   * „Brak danych” (szary, krycie < 100) i przezroczystość są pomijane — inaczej
   * rozległa szara plama zniekształcałaby korelację ruchu.
   */
  function fieldFromRGBA(rgba, w, h) {
    var v = new Float32Array(w * h);
    var m = new Uint8Array(w * h);
    var idx = [];
    for (var i = 0, p = 0; i < w * h; i++, p += 4) {
      var a = rgba[p + 3];
      if (a < 100) continue;
      v[i] = (rgba[p] + rgba[p + 1] + rgba[p + 2]) / 3;
      m[i] = 1;
      idx.push(i);
    }
    return { v: v, m: m, idx: idx, w: w, h: h };
  }

  /**
   * Globalne przesunięcie echa między dwoma polami (SSD na obszarze echo) z
   * doprecyzowaniem sub-pikselowym (dopasowanie paraboli wokół minimum).
   * Zwraca {dx, dy} w pikselach pola: cecha z a(i,j) pasuje do b(i+dx, j+dy).
   * Fronty przesuwają się o ułamki piksela na 5 min, więc samo minimum całkowite
   * dawałoby „brak ruchu” i prognoza nie miałaby sensu.
   */
  function motionFromField(a, b, maxShift) {
    var w = 2 * maxShift + 1;
    var scores = new Float64Array(w * w);
    var cells = a.idx || [];
    for (var jy = 0; jy < w; jy++) {
      var dy = jy - maxShift;
      for (var jx = 0; jx < w; jx++) {
        var dx = jx - maxShift;
        var s = 0, n = 0;
        for (var k = 0; k < cells.length; k++) {
          var p = cells[k];
          var i = p % a.w, j = (p - i) / a.w;
          var ii = i + dx, jj = j + dy;
          if (ii < 0 || ii >= b.w || jj < 0 || jj >= b.h) continue;
          var d = a.v[p] - b.v[jj * b.w + ii];
          s += d * d;
          n++;
        }
        scores[jy * w + jx] = n >= 20 ? s : Infinity; // za mało echa, by uznać przesunięcie
      }
    }
    var best = Infinity, bx = -1, by = -1;
    for (var i2 = 0; i2 < scores.length; i2++) {
      if (scores[i2] < best) { best = scores[i2]; bx = i2 % w; by = (i2 - (i2 % w)) / w; }
    }
    if (bx < 0) return { dx: null, dy: null, score: null };
    var subX = 0, subY = 0;
    var s0 = scores[by * w + bx];
    if (bx > 0 && bx < w - 1) {
      var den = scores[by * w + bx - 1] - 2 * s0 + scores[by * w + bx + 1];
      if (den > 0) subX = Math.max(-0.5, Math.min(0.5, 0.5 * (scores[by * w + bx - 1] - scores[by * w + bx + 1]) / den));
    }
    if (by > 0 && by < w - 1) {
      var denY = scores[(by - 1) * w + bx] - 2 * s0 + scores[(by + 1) * w + bx];
      if (denY > 0) subY = Math.max(-0.5, Math.min(0.5, 0.5 * (scores[(by - 1) * w + bx] - scores[(by + 1) * w + bx]) / denY));
    }
    return {
      dx: (bx - maxShift) + subX,
      dy: (by - maxShift) + subY,
      score: best
    };
  }

  /**
   * Klamka czasu: klatki (rosnące po ts) i żądany czas -> {i, j, f, extra}.
   * f = 0..1 między klatkami i oraz j; extra = ms poza ostatnią klatką (prognoza ruchu).
   */
  function bracket(frames, ts) {
    var n = frames.length;
    if (!n) return { i: 0, j: 0, f: 0, extra: 0 };
    if (n === 1) return { i: 0, j: 0, f: 0, extra: ts - frames[0].ts };
    if (ts <= frames[0].ts) return { i: 0, j: 0, f: 0, extra: 0 };
    var last = frames[n - 1];
    if (ts >= last.ts) return { i: n - 2, j: n - 1, f: 1, extra: ts - last.ts };
    for (var i = 0; i < n - 1; i++) {
      if (ts >= frames[i].ts && ts < frames[i + 1].ts) {
        var span = frames[i + 1].ts - frames[i].ts;
        return { i: i, j: i + 1, f: span > 0 ? (ts - frames[i].ts) / span : 0, extra: 0 };
      }
    }
    return { i: n - 2, j: n - 1, f: 1, extra: 0 };
  }

  /** Slabnięcie natężenia przy ekstrapolacji (prognoza ruchu chmur). */
  function decayAlpha(minutes, horizon) {
    if (minutes <= 0) return 1;
    horizon = horizon || 30;
    return Math.max(0.25, 1 - 0.4 * (minutes / horizon));
  }

  return {
    R: R, TILE: TILE,
    mercX: mercX, mercY: mercY, lonOf: lonOf, latOf: latOf,
    bboxMerc: bboxMerc, scaleAt: scaleAt, fitBounds: fitBounds,
    project: project, unproject: unproject, tileRange: tileRange,
    fieldFromRGBA: fieldFromRGBA, motionFromField: motionFromField,
    bracket: bracket, decayAlpha: decayAlpha
  };
})();
