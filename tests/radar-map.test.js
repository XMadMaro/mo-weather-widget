#!/usr/bin/env node
'use strict';

/**
 * MO Weather Widget — testy matematyki mapy radaru (src/mo-radar-map.js)
 *
 * Moduł jest czystą biblioteką (bez DOM), więc testujemy go w Node przez vm:
 *  - projekcja Web Mercator (round-trip lon/lat),
 *  - dopasowanie widoku do bbox i odwrotność project/unproject,
 *  - zakres kafelków mapy,
 *  - pole natężenia echa i wyliczanie wektora ruchu (interpolacja co 1 min),
 *  - klamka czasu (pomiar vs prognoza ruchu) i slabnięcie natężenia.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

console.log('==> Running Radar Map Math Tests...');

const srcPath = path.resolve(__dirname, '../src/mo-radar-map.js');
const code = fs.readFileSync(srcPath, 'utf8');
const sandbox = { Math, Float32Array, Uint8Array, console };
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const M = sandbox.MO_RADAR_MAP;
assert(M, 'src/mo-radar-map.js must export MO_RADAR_MAP');

const near = (a, b, tol, msg) => assert(Math.abs(a - b) <= tol, `${msg} (${a} vs ${b}, tol ${tol})`);

// 1. Web Mercator: round-trip
console.log('  [1/7] Checking Web Mercator round-trip...');
near(M.lonOf(M.mercX(19.0238)), 19.0238, 1e-9, 'Katowice lon must round-trip');
near(M.latOf(M.mercY(50.2649)), 50.2649, 1e-9, 'Katowice lat must round-trip');
near(M.mercX(0), 0, 1e-6, 'meridian must be x=0');
assert(M.mercY(50) > 0, 'north must have positive y');
near(M.mercY(0), 0, 1e-6, 'equator must be y=0');

// 2. bbox radaru (16.8–21.2°E, 48.9–51.6°N) w metrach Web Mercator
console.log('  [2/7] Checking radar bbox in meters...');
const b = M.bboxMerc([16.8, 48.9, 21.2, 51.6]);
const kmW = (b.x1 - b.x0) / 1000, kmH = (b.y1 - b.y0) / 1000;
assert(kmW > 470 && kmW < 500, `bbox width must be ~490 km of Mercator (got ${kmW.toFixed(1)})`);
assert(kmH > 450 && kmH < 490, `bbox height must be ~470 km of Mercator (got ${kmH.toFixed(1)})`);
// Klatka 704×676 px pokrywa ten prostokąt: ~696 m na piksel w obu osiach (kwadratowe piksele).
const pxMercX = (b.x1 - b.x0) / 704, pxMercY = (b.y1 - b.y0) / 676;
assert(pxMercX > 600 && pxMercX < 800, `frame resolution must be ~700 m/px (got ${pxMercX.toFixed(0)})`);
near(pxMercX, pxMercY, 5, 'frame pixels must be square in Mercator');

// 3. fitBounds: cały bbox mieści się w kadrze
console.log('  [3/7] Checking fitBounds...');
const view = M.fitBounds([16.8, 48.9, 21.2, 51.6], 800, 600, 6);
const tl = M.project(b.x0, b.y1, view, 800, 600);
const br = M.project(b.x1, b.y0, view, 800, 600);
assert(tl.x >= -0.5 && tl.y >= -0.5, 'top-left corner must be inside the viewport');
assert(br.x <= 800.5 && br.y <= 600.5, 'bottom-right corner must be inside the viewport');
assert(br.y - tl.y > 580, 'bbox must fill the viewport height (padding 6 px)');
assert(br.x - tl.x > 600, 'bbox must fill most of the viewport width');

// 4. project/unproject — odwrotność
console.log('  [4/7] Checking project/unproject inverse...');
const p = M.project(M.mercX(19.0238), M.mercY(50.2649), view, 800, 600);
const back = M.unproject(p.x, p.y, view, 800, 600);
near(back.x, M.mercX(19.0238), 1, 'unproject must invert project (x)');
near(back.y, M.mercY(50.2649), 1, 'unproject must invert project (y)');

// 5. Zakres kafelków
console.log('  [5/7] Checking tile range...');
const tr = M.tileRange(view, 800, 600, 9);
assert(tr.x0 >= 0 && tr.y0 >= 0 && tr.x1 <= 511 && tr.y1 <= 511, 'tile range must stay inside the world');
assert(tr.x1 >= tr.x0 && tr.y1 >= tr.y0, 'tile range must be non-empty');
const trCity = M.tileRange({ cx: M.mercX(19.0238), cy: M.mercY(50.2649), zoom: 12 }, 800, 600, 12);
assert(trCity.x1 - trCity.x0 <= 8 && trCity.y1 - trCity.y0 <= 8, 'city view must need few tiles (<= 8x8)');

// 6. Pole echa i wektor ruchu
console.log('  [6/7] Checking echo field and motion vector...');
const W = 40, H = 30;
function makeField(dx, dy) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const p = (j * W + i) * 4;
      // Kwadrat 6x6 przesunięty o (dx, dy); reszta = „brak danych” (alfa 60).
      const inEcho = i - dx >= 8 && i - dx < 14 && j - dy >= 6 && j - dy < 12;
      data[p] = inEcho ? 250 : 128;
      data[p + 1] = inEcho ? 30 : 128;
      data[p + 2] = inEcho ? 0 : 128;
      data[p + 3] = inEcho ? 255 : 60;
    }
  }
  return data;
}
const fa = M.fieldFromRGBA(makeField(0, 0), W, H);
const fb = M.fieldFromRGBA(makeField(3, -2), W, H);
assert(fa.m.reduce((a, b) => a + b, 0) === 36, 'field must contain 36 echo cells (no-data ignored)');
const mv = M.motionFromField(fa, fb, 6);
assert(mv.dx !== null && Math.abs(mv.dx - 3) < 0.25 && Math.abs(mv.dy + 2) < 0.25,
  `motion must be (3,-2), got (${mv.dx},${mv.dy})`);

// 6b. Sub-pikselowość: gładkie pole przesunięte o 1,5 px (tyle realnie przesuwa się front)
const SW = 60, SH = 50;
function smoothField(dx, dy) {
  const data = new Uint8ClampedArray(SW * SH * 4);
  for (let j = 0; j < SH; j++) {
    for (let i = 0; i < SW; i++) {
      const p = (j * SW + i) * 4;
      const r2 = (i - 20 - dx) ** 2 + (j - 25 - dy) ** 2;
      const val = Math.exp(-r2 / 18) * 255;
      data[p] = val; data[p + 1] = val; data[p + 2] = val; data[p + 3] = 255;
    }
  }
  return data;
}
const sa = M.fieldFromRGBA(smoothField(0, 0), SW, SH);
const sb = M.fieldFromRGBA(smoothField(1.5, -0.5), SW, SH);
const sub = M.motionFromField(sa, sb, 4);
assert(sub.dx !== null && Math.abs(sub.dx - 1.5) < 0.35 && Math.abs(sub.dy + 0.5) < 0.35,
  `sub-pixel motion must be (1.5,-0.5), got (${sub.dx},${sub.dy})`);

// 7. Klamka czasu: pomiar w środku i prognoza za ostatnią klatką
console.log('  [7/7] Checking time bracket and forecast decay...');
const frames = [
  { ts: 1000 * 60 * 0 }, { ts: 1000 * 60 * 5 }, { ts: 1000 * 60 * 10 }
];
const mid = M.bracket(frames, 1000 * 60 * 2.5);
assert(mid.i === 0 && mid.j === 1, 'bracket must span frames 0..1');
near(mid.f, 0.5, 1e-9, 'bracket fraction must be 0.5');
const after = M.bracket(frames, 1000 * 60 * 10 + 1000 * 60 * 15);
assert(after.extra === 1000 * 60 * 15, 'bracket must report the time beyond the last frame');
assert(after.f === 1, 'bracket after the last frame must be pinned to the last frame');
const before = M.bracket(frames, 0);
assert(before.i === 0 && before.f === 0 && before.extra === 0, 'bracket before the first frame must clamp');
near(M.decayAlpha(0, 30), 1, 1e-9, 'decay at 0 min must be 1');
assert(M.decayAlpha(30, 30) < 1 && M.decayAlpha(30, 30) > 0.5, 'forecast must fade the echo');
assert(M.decayAlpha(120, 30) >= 0.25, 'decay must have a floor');

console.log('✓ All Radar Map Math Tests passed successfully!\n');
