#!/usr/bin/env node
/**
 * Dev-only preview server (bez PHP) — NARZĘDZIE POMOCNICZE, NIE CZĘŚĆ PRODUKTU.
 *
 * Serwuje `public/` (makieta portalu + generator snippetu) i podstawia
 * ZAMOCKOWANE /api/weather dla 4 modułów, aby móc obejrzeć widget bez PHP.
 *
 * Uruchomienie:
 *   node tools/dev-preview.mjs            # http://localhost:8080
 *   PORT=9000 node tools/dev-preview.mjs
 *
 * Tryby symulacji awarii (do testów degradacji):
 *   /api/weather?city=katowice&type=current&simulate=stale
 *   /api/weather?city=katowice&type=current&simulate=error
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 8080);

const CITIES = [
  ['katowice', 'Katowice', 15, 2469, true],
  ['gliwice', 'Gliwice', 15, 2466, true],
  ['sosnowiec', 'Sosnowiec', 14, 2475, true],
  ['zabrze', 'Zabrze', 14, 2478, true],
  ['tychy', 'Tychy', 14, 2477, true],
  ['dabrowa-gornicza', 'Dąbrowa Górnicza', 14, 2465, true],
  ['bytom', 'Bytom', 14, 2462, false],
  ['chorzow', 'Chorzów', 15, 2463, false],
  ['swietochlowice', 'Świętochłowice', 15, 2476, false],
  ['ruda-slaska', 'Ruda Śląska', 14, 2472, false],
  ['piekary-slaskie', 'Piekary Śląskie', 14, 2471, false],
  ['tarnowskie-gory', 'Tarnowskie Góry', 13, 2413, false],
  ['knurow', 'Knurów', 14, 2405, false],
  ['bedzin', 'Będzin', 15, 2401, false],
].map(([slug, label, temp, teryt, hasGios]) => ({ slug, label, temp, teryt, hasGios }));

const WEEKDAYS = ['nd', 'pn', 'wt', 'śr', 'cz', 'pt', 'so'];
const WMO = [
  [0, 'Bezchmurnie'],
  [2, 'Częściowe zachmurzenie'],
  [3, 'Pochmurno'],
  [45, 'Mgła'],
  [61, 'Lekki deszcz'],
  [63, 'Deszcz'],
  [71, 'Śnieg'],
  [80, 'Deszcz przelotny'],
  [95, 'Burza'],
];

const BASE = Math.floor(Date.now() / 1000);

function payload(city, type, nowSec) {
  const conf = CITIES.find((c) => c.slug === city);
  if (!conf) return null;
  const common = {
    city: conf.slug,
    label: conf.label,
    fetched_at: nowSec - 120,
    is_stale: false,
    cache: 'fresh',
    last_updated_timestamp: nowSec - 120,
  };

  if (type === 'current') {
    const code = [0, 2, 3, 61][new Date().getHours() % 4];
    return {
      ...common,
      temperature: conf.temp,
      weather_code: code,
      symbol_code: 'partlycloudy_day',
      wind_speed: 11 + (conf.temp % 7),
      temp_max: conf.temp + 3,
      temp_min: conf.temp - 6,
      source: 'MET Norway locationforecast 2.0 (MOCK)',
      attribution: 'Dane: MET Norway (CC BY 4.0)',
    };
  }

  if (type === 'daily7') {
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date((nowSec + i * 86400) * 1000);
      days.push({
        date: d.toISOString().slice(0, 10),
        weekday_label: WEEKDAYS[d.getDay()],
        temp_max: conf.temp + 3 - (i % 3),
        temp_min: conf.temp - 5 - (i % 2),
        precipitation_mm: 0.4 * (i % 4),
        wind_speed_max: 18 + i,
        weather_code: WMO[i % WMO.length][0],
        label_text: WMO[i % WMO.length][1],
      });
    }
    return { ...common, days, source: 'MET Norway locationforecast 2.0 (MOCK)' };
  }

  if (type === 'nowcast') {
    const raining = conf.slug.length % 2 === 0;
    return {
      ...common,
      alert: raining
        ? { active: true, kind: 'starting', eta_iso: null, eta_local: '18:00', minutes: 47, text: 'Opady możliwe między 18:00 a 19:00' }
        : { active: false, kind: 'none', eta_iso: null, eta_local: null, minutes: null, text: 'Brak opadów w najbliższych 2 h' },
      series: [],
      source: 'MET Norway (MOCK)',
      label_type: 'informacja o opadach',
    };
  }

  if (type === 'air') {
    const pm10 = 18 + (conf.teryt % 40);
    const idx = pm10 <= 20 ? 1 : pm10 <= 50 ? 2 : pm10 <= 80 ? 3 : 4;
    const cat = { 1: 'Bardzo dobry', 2: 'Dobry', 3: 'Umiarkowany', 4: 'Dostateczny' }[idx];
    const measurement = conf.hasGios
      ? {
          available: true,
          source: 'gios',
          station_id: 17318,
          station_name: conf.slug === 'katowice' ? 'Katowice, ul. Dudy-Gracza' : conf.label,
          measured_at: new Date(nowSec * 1000).toISOString(),
          category: cat,
          category_index: idx,
          advice: 'Osoby wrażliwe powinny ograniczyć wysiłek na zewnątrz.',
          label: 'Pomiar ze stacji GIOŚ, 08:00',
          pollutants: {
            pm10: { value: pm10, unit: 'µg/m³', index: idx, code: 'MOCK-PM10' },
            pm25: { value: conf.slug === 'katowice' ? Math.round(pm10 * 0.6) : null, unit: 'µg/m³', index: idx, code: null },
            no2: { value: null, unit: 'µg/m³', index: null },
          },
        }
      : {
          available: false,
          source: null,
          station_id: null,
          station_name: null,
          measured_at: null,
          category: null,
          category_index: null,
          advice: null,
          label: 'Prognoza jakości powietrza IOŚ-PIB',
          note: 'Brak aktywnej stacji GIOŚ — prezentowana prognoza jakości powietrza IOŚ-PIB',
          pollutants: { pm10: { value: null, unit: 'µg/m³', index: null }, pm25: { value: null, unit: 'µg/m³', index: null } },
        };

    const days = [];
    for (let i = 0; i < 3; i++) {
      days.push({ date: new Date((nowSec + i * 86400) * 1000).toISOString().slice(0, 10), pm10: Math.round(pm10 - 6 + i * 4) });
    }
    const fIdx = 2;
    return {
      ...common,
      measurement,
      forecast: {
        source: 'ios',
        teryt: String(conf.teryt),
        teryt_level: 'city',
        teryt_name: conf.label,
        label: 'Prognoza IOŚ-PIB dla miasta ' + conf.label,
        category: conf.hasGios ? null : 'Dobry',
        category_index: conf.hasGios ? null : fIdx,
        advice: conf.hasGios ? null : 'Osoby wrażliwe powinny ograniczyć wysiłek na zewnątrz.',
        days,
      },
      attribution: ['GIOŚ / Państwowy Monitoring Środowiska', 'IOŚ-PIB'],
    };
  }

  return null;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const send = (code, body, type = 'application/json; charset=utf-8', extra = {}) => {
    res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
    res.end(body);
  };

  if (url.pathname === '/api/weather' || url.pathname === '/api/weather.php' || url.pathname === '/api/') {
    const nowSec = Math.floor(Date.now() / 1000);
    const type = (url.searchParams.get('type') || 'current').toLowerCase();
    const simulate = url.searchParams.get('simulate') || '';

    if (simulate === 'error') {
      return send(503, JSON.stringify({ error: 'service temporarily unavailable (MOCK)', retry_after_seconds: 300 }));
    }

    if (type === 'health') {
      return send(200, JSON.stringify({ ok: true, version: '2.1.0 (MOCK)', modules: { current: 'fresh', air: 'fresh', daily7: 'fresh', nowcast: 'fresh' }, cities_count: CITIES.length }));
    }

    const city = (url.searchParams.get('city') || '').toLowerCase();
    const data = payload(city, type, nowSec);
    if (!data) {
      return send(400, JSON.stringify({ error: 'unknown city', available: CITIES.map((c) => c.slug) }));
    }
    if (simulate === 'stale') {
      data.is_stale = true;
      data.cache = 'stale';
      data.fetched_at = nowSec - 5400;
      data.last_updated_timestamp = nowSec - 5400;
    }
    return send(200, JSON.stringify(data), 'application/json; charset=utf-8', { 'X-Mock': 'dev-preview' });
  }

  // Statyki z public/
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(PUBLIC, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(404, 'Not found', 'text/plain; charset=utf-8');
  }
  send(200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[dev-preview] http://0.0.0.0:${PORT} — mock API: /api/weather?city=katowice&type=current`);
  console.log('[dev-preview] symulacje: &simulate=stale  |  &simulate=error');
});
