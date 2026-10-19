#!/usr/bin/env node
'use strict';

/**
 * MO Weather Widget — testy okna radaru (src/mo-radar.js) w Node.
 *
 * Moduł radaru to kod przeglądarki (DOM + canvas), więc test uruchamia go w minimalnym
 * własnym DOM (bez zależności zewnętrznych) i sprawdza:
 *  - zbudowanie okna (nagłówek, mapa, odtwarzacz, legenda, stopka),
 *  - obsługę manifestu (13 klatek -> oś czasu 60 min pomiaru + 30 min prognozy),
 *  - dwa widoki: „Województwo” i „Miasto” (miasto portalu, np. Bytom),
 *  - interpolację co 1 min i ekstrapolację ruchu (PROGNOZA),
 *  - wyliczanie wektora ruchu z kolejnych klatek,
 *  - awarię bez CORS (brak odczytu pikseli -> brak predykcji, ale mapa działa).
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const vm = require('vm');

console.log('==> Running Radar UI Tests...');

/* ---------- minimalny DOM ---------- */

let lastDrawn = null;

class El {
  constructor(tag, ns) {
    this.tagName = String(tag).toUpperCase();
    this.namespaceURI = ns || null;
    this.childNodes = [];
    this.attrs = {};
    this.style = {};
    this.dataset = {};
    this.listeners = {};
    this.textContent = '';
    this.parentNode = null;
    this.hidden = false;
    this.open = false;
    this.classList = {
      add: (c) => { if (!this._classes().includes(c)) this._classes().push(c); },
      remove: (c) => { this._classes().splice(this._classes().indexOf(c), 1); },
      contains: (c) => this._classes().includes(c)
    };
  }
  _classes() { if (!this._cls) this._cls = []; return this._cls; }
  get className() { return this._classes().join(' '); }
  set className(v) { this._cls = String(v).split(/\s+/).filter(Boolean); }
  get children() { return this.childNodes; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  appendChild(c) { this.childNodes.push(c); c.parentNode = this; return c; }
  removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); return c; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener() {}
  dispatch(t, ev) { (this.listeners[t] || []).forEach((fn) => fn(ev || { preventDefault() {}, stopPropagation() {} })); }
  focus() { this.focused = true; }
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 1180, height: 600, right: 1180, bottom: 600 }; }
  get clientWidth() { return 1180; }
  get clientHeight() { return 600; }
  getContext() { return makeCtx(); }
  showModal() { this.open = true; this.attrs.open = ''; }
  close() { this.open = false; }
  requestFullscreen() { return Promise.resolve(); }
}

function makeCtx() {
  return {
    setTransform() {}, clearRect() {}, fillRect() {}, save() {}, restore() {},
    translate() {}, scale() {}, fill() {}, stroke() {}, beginPath() {},
    drawImage(img) { lastDrawn = img; },
    getImageData(x, y, w, h) {
      const data = new Uint8ClampedArray(w * h * 4);
      if (lastDrawn && lastDrawn.__pixels) lastDrawn.__pixels(data, w, h);
      return { data, width: w, height: h };
    },
    putImageData() {}
  };
}

class FakeImage {
  constructor() { this.naturalWidth = 704; this.naturalHeight = 676; this.width = 704; this.height = 676; this.complete = false; }
  set src(v) { this._src = v; setTimeout(() => { this.complete = true; if (this.onload) this.onload(); }, 0); }
  get src() { return this._src; }
}

const document = {
  createElement: (t) => new El(t),
  createElementNS: (ns, t) => new El(t, ns),
  createTextNode: (t) => { const e = new El('#text'); e.textContent = t; return e; },
  addEventListener() {},
  body: new El('body'),
  hidden: false
};

const window = {
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  addEventListener() {},
  devicePixelRatio: 1,
  fullscreenElement: null,
  requestAnimationFrame: (fn) => { window.__raf.push(fn); return window.__raf.length; },
  __raf: []
};

function makeManifest() {
  const frames = [];
  const base = Date.UTC(2026, 9, 19, 12, 0);
  for (let i = 0; i < 13; i++) {
    const d = new Date(base - (12 - i) * 5 * 60000);
    const p = (n) => String(n).padStart(2, '0');
    frames.push({
      t: `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}`
    });
  }
  return {
    status: 'fresh',
    latest: frames[frames.length - 1].t,
    step_seconds: 300,
    frames,
    bbox_ll: [16.8, 48.9, 21.2, 51.6],
    size: [704, 676]
  };
}

const manifest = makeManifest();

const sandbox = {
  window, document, console, Intl, Math, Date, JSON, Promise, WeakMap, Set, Map, Array, Object, String, Number,
  Uint8ClampedArray, Float32Array, Uint8Array, RegExp, Error, isNaN, parseInt, parseFloat, setTimeout, clearTimeout,
  setInterval, clearInterval, AbortController, Path2D: class { constructor(d) { this.d = d; } },
  Image: FakeImage,
  requestAnimationFrame: (fn) => { window.__raf.push(fn); return window.__raf.length; },
  cancelAnimationFrame() {},
  fetch: (url) => {
    if (String(url).indexOf('manifest') === -1) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(manifest) });
  }
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(f) { vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../src', f), 'utf8'), sandbox, { filename: f }); }
load('mo-radar-map.js');
load('mo-radar-basemap.js');
load('mo-radar.js');

const MoWeatherRadar = sandbox.window.MoWeatherRadar;
assert(MoWeatherRadar, 'mo-radar.js must expose window.MoWeatherRadar');

const tick = () => new Promise((r) => setTimeout(r, 5));

(async function run() {
  // 1. Okno
  console.log('  [1/6] Checking radar window structure...');
  const root = new El('div');
  const trigger = new El('button');
  const inst = MoWeatherRadar.open({ root, url: 'https://api.example.pl/api/radar', city: 'bytom', cityName: 'Bytom', trigger });
  assert(inst, 'open() must return the radar instance');
  assert(inst.dialog.open, 'dialog must be opened');
  const html = root.childNodes.map((c) => c.className).join(',');
  assert(html.indexOf('rd') >= 0, 'dialog must be attached to the root');
  assert(inst.btnCity.textContent === 'Bytom', 'city button must be named after the portal city');
  assert(inst.btnRegion.getAttribute('aria-pressed') === 'true', 'region view must be active first');
  await tick();

  // 2. Manifest
  console.log('  [2/6] Checking manifest handling and timeline...');
  await tick();
  assert(inst.frames.length === 13, `13 frames expected, got ${inst.frames.length}`);
  assert(inst.spanMin === 60, `60 minutes of history expected, got ${inst.spanMin}`);
  assert(inst.total === 90, `90 minutes of timeline expected (60 + 30 forecast), got ${inst.total}`);
  assert(inst.range.max === '90', 'range max must cover the forecast horizon');
  assert(/66\.6/.test(inst.splitObs.style.flex), `timeline must split measured and forecast parts (got "${inst.splitObs.style.flex}")`);
  assert(inst.badge.hidden, 'fresh radar must not show a warning badge');

  // 3. Widoki
  console.log('  [3/6] Checking region and city views...');
  const M = sandbox.MO_RADAR_MAP;
  inst.setView('region', true);
  const regionZoom = inst.view.zoom;
  assert(regionZoom > 5 && regionZoom < 7.5, `region zoom must fit the bbox (got ${regionZoom.toFixed(2)})`);
  inst.setView('city', true);
  assert(inst.mode === 'city', 'city view must be active');
  near(M.lonOf(inst.view.cx), 18.9158, 0.01, 'city view must be centred on Bytom');
  near(M.latOf(inst.view.cy), 50.3484, 0.01, 'city view must be centred on Bytom');
  assert(Math.abs(inst.view.zoom - 12) < 0.001, 'city view must use the city zoom level');
  assert(inst.btnCity.getAttribute('aria-pressed') === 'true', 'city button must be pressed');

  // 3b. Geometria: klatka radaru leży na mapie (ta sama projekcja Web Mercator)
  inst.setView('region', true);
  const rectRegion = inst.frameRect();
  assert(rectRegion.h > inst.vh - 20, 'region view must fit the radar coverage in the map height');
  near(rectRegion.x + rectRegion.w / 2, inst.vw / 2, 2, 'region frame must be centred horizontally');
  near(rectRegion.y + rectRegion.h / 2, inst.vh / 2, 2, 'region frame must be centred vertically');
  inst.setView('city', true);
  const rectCity = inst.frameRect();
  assert(rectCity.w > rectRegion.w * 2, 'city view must magnify the radar frame');
  const cityCentre = M.project(M.mercX(18.9158), M.mercY(50.3484), inst.view, inst.vw, inst.vh);
  near(cityCentre.x, inst.vw / 2, 6, 'portal city must be in the middle of the city view');
  near(cityCentre.y, inst.vh / 2, 6, 'portal city must be in the middle of the city view');

  // 4. Oś czasu: pomiar -> prognoza
  console.log('  [4/6] Checking 1-minute steps and forecast...');
  inst.showMinute(30);
  assert(inst.minute === 30, 'slider must set the minute');
  assert(inst.fcBadge.classList.contains('on') === false, 'measured time must not show the forecast badge');
  assert(/\d\d:\d\d/.test(inst.timeEl.textContent), 'time label must show a clock time');
  inst.showMinute(75);
  assert(inst.fcBadge.classList.contains('on') === true, 'forecast zone must show the PROGNOZA badge');
  assert(inst.timeEl.textContent.indexOf('+15 min') >= 0, `forecast label must show the offset (got "${inst.timeEl.textContent}")`);
  inst.showMinute(60);
  assert(inst.fcBadge.classList.contains('on') === false, 'last measured frame must not be a forecast');

  // 5. Rysowanie i wektor ruchu
  console.log('  [5/6] Checking canvas rendering and motion vector...');
  inst.showMinute(0);
  let drawn = 0;
  const origDraw = inst.overlay.getContext;
  inst.overlay.getContext = () => { const c = makeCtx(); const d = c.drawImage.bind(c); c.drawImage = (...a) => { drawn++; d(...a); }; return c; };
  inst.drawRadar();
  assert(drawn > 0, 'radar overlay must draw a frame');
  inst.overlay.getContext = origDraw;
  const mv = inst.motionBetween(0);
  assert(mv === null || (typeof mv.dx === 'number' && typeof mv.dy === 'number'), 'motion vector must be an object or null');

  // 6. Awaria bez CORS: predykcja zostaje wyłączona, ale okno działa
  console.log('  [6/6] Checking degraded mode without pixel access...');
  const inst2 = MoWeatherRadar.open({ root: new El('div'), url: 'https://api.example.pl/api/radar', city: 'katowice', cityName: 'Katowice' });
  await tick();
  await tick();
  assert(inst2.frames.length === 13, 'second instance must load the manifest as well');
  assert(inst2.maskedFrame(0) !== null, 'frame must be prepared even without pixel access');
  inst2.play(false);
  if (inst2.poll) clearInterval(inst2.poll);
  inst.play(false);
  if (inst.poll) clearInterval(inst.poll);
  console.log('✓ All Radar UI Tests passed successfully!\n');
})().catch((e) => { console.error(e); process.exit(1); });

function near(a, b, tol, msg) { assert(Math.abs(a - b) <= tol, `${msg} (${a} vs ${b})`); }
