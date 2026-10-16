#!/usr/bin/env node
/**
 * Generator podkładu mapy radaru (bez zależności).
 *
 * Z granic PRG (ppatrzyk/polska-geojson, MIT) robi SVG w Web Mercatorze na dokładnie tym samym bbox
 * co klatki radaru (16,8–21,2°E, 48,9–51,6°N, 704×676 px). Dzięki temu klatka PNG leży na podkładzie 1:1.
 * Miasta z src/cities.php + kilka miejscowości orientacyjnych trafiają do JSON (etykiety rysuje DOM).
 *
 *   curl -sLO https://raw.githubusercontent.com/ppatrzyk/polska-geojson/master/powiaty/powiaty-medium.geojson
 *   curl -sLO https://raw.githubusercontent.com/ppatrzyk/polska-geojson/master/wojewodztwa/wojewodztwa-medium.geojson
 *   node scripts/gen-basemap.mjs --powiaty powiaty-medium.geojson --woj wojewodztwa-medium.geojson --out DIR
 *   node scripts/gen-basemap.mjs --powiaty … --woj … --js src/mo-radar-basemap.js   # dane dla mo-radar.js
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BBOX_LL = [16.8, 48.9, 21.2, 51.6];
const W = 704;
const H = 676;
const R = 6378137;
const TOLERANCE = 0.6; // px, upraszczanie linii (0,6 px: ok. 40 KB podkładu w mo-radar.min.js)

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
if (!args.powiaty || !args.woj || (!args.out && !args.js)) {
  console.error('usage: node scripts/gen-basemap.mjs --powiaty FILE --woj FILE [--out DIR] [--js FILE]');
  process.exit(2);
}

const mx = (lon) => R * (lon * Math.PI / 180);
const my = (lat) => R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI / 180) / 2));
const X0 = mx(BBOX_LL[0]);
const X1 = mx(BBOX_LL[2]);
const Y0 = my(BBOX_LL[1]);
const Y1 = my(BBOX_LL[3]);
const px = ([lon, lat]) => [(mx(lon) - X0) / (X1 - X0) * W, (Y1 - my(lat)) / (Y1 - Y0) * H];

function simplify(pts, tol) { // Douglas–Peucker, iteracyjnie
  if (pts.length < 4) return pts;
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len = Math.hypot(dx, dy);
    let best = -1;
    let dmax = tol;
    for (let i = a + 1; i < b; i++) {
      // Pierścień zamknięty: a == b, więc mierzymy odległość od punktu, a nie od odcinka.
      const d = len < 1e-9
        ? Math.hypot(pts[i][0] - ax, pts[i][1] - ay)
        : Math.abs(dy * pts[i][0] - dx * pts[i][1] + bx * ay - by * ax) / len;
      if (d > dmax) { dmax = d; best = i; }
    }
    if (best > 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

function clip(pts, x0, y0, x1, y1) { // Sutherland–Hodgman do prostokąta kadru (z marginesem)
  const edges = [
    [(p) => p[0] >= x0, (a, b) => [x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0])]],
    [(p) => p[0] <= x1, (a, b) => [x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0])]],
    [(p) => p[1] >= y0, (a, b) => [a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0]],
    [(p) => p[1] <= y1, (a, b) => [a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1]],
  ];
  let out = pts;
  for (const [ins, cut] of edges) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const cur = src[i];
      const prev = src[(i + src.length - 1) % src.length];
      if (ins(cur)) {
        if (!ins(prev)) out.push(cut(prev, cur));
        out.push(cur);
      } else if (ins(prev)) {
        out.push(cut(prev, cur));
      }
    }
    if (!out.length) break;
  }
  return out;
}

const rings = (geom) => (geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates).flat();
const visible = (r) => r.some(([x, y]) => x > -40 && x < W + 40 && y > -40 && y < H + 40);
const f1 = (v) => Math.round(v * 10) / 10;

function pathOf(geoms, tol = TOLERANCE) {
  let d = '';
  for (const g of geoms) {
    for (const ring of rings(g)) {
      const p = simplify(clip(ring.map(px), -4, -4, W + 4, H + 4), tol);
      if (p.length < 3 || !visible(p)) continue;
      // Współrzędne względne w dziesiątych częściach piksela: krótszy zapis niż bezwzględne.
      let [qx, qy] = [Math.round(p[0][0] * 10), Math.round(p[0][1] * 10)];
      d += `M${qx / 10} ${qy / 10}l`;
      const parts = [];
      for (let i = 1; i < p.length; i++) {
        const nx = Math.round(p[i][0] * 10);
        const ny = Math.round(p[i][1] * 10);
        if (nx === qx && ny === qy) continue;
        parts.push(`${(nx - qx) / 10} ${(ny - qy) / 10}`);
        qx = nx;
        qy = ny;
      }
      d += parts.join(' ').replace(/ -/g, '-').replace(/(^|[ l-])0\./g, '$1.') + 'z';
    }
  }
  return d;
}

function inside([x, y], polyRings) { // even-odd
  let c = false;
  for (const r of polyRings) {
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i];
      const [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c;
    }
  }
  return c;
}

function centroid(geom) {
  const ring = rings(geom).sort((a, b) => b.length - a.length)[0];
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    a += f;
    cx += (ring[j][0] + ring[i][0]) * f;
    cy += (ring[j][1] + ring[i][1]) * f;
  }
  return [cx / (3 * a), cy / (3 * a)];
}

const woj = JSON.parse(readFileSync(args.woj, 'utf8')).features;
const pow = JSON.parse(readFileSync(args.powiaty, 'utf8')).features;
const slask = woj.find((f) => f.properties.nazwa === 'śląskie');
const slaskRings = rings(slask.geometry);
const slaskPow = pow.filter((f) => inside(centroid(f.geometry), slaskRings));
const others = woj.filter((f) => f !== slask);

const regionLabels = [
  ['CZECHY', 17.55, 49.72], ['SŁOWACJA', 19.75, 49.12], ['OPOLSKIE', 17.75, 50.72],
  ['ŁÓDZKIE', 19.35, 51.42], ['MAŁOPOLSKIE', 20.25, 49.78], ['ŚWIĘTOKRZYSKIE', 20.7, 50.85],
  ['DOLNOŚLĄSKIE', 17.05, 51.25],
].map(([t, lon, lat]) => {
  const [x, y] = px([lon, lat]);
  return { t, x: f1(x), y: f1(y) };
});
// Geometria raz; frontend buduje z niej SVG przez DOM API: tło -> klatka radaru -> granice -> etykiety.
const geometry = {
  neighbors: pathOf(others.map((f) => f.geometry), 1.0),
  powiaty: pathOf(slaskPow.map((f) => f.geometry)),
  slaskie: pathOf([slask.geometry]),
};
const svg = [ // samodzielny podgląd (bez radaru), np. do dokumentacji
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`,
  `<defs><path id="n" d="${geometry.neighbors}"/><path id="p" d="${geometry.powiaty}"/><path id="s" d="${geometry.slaskie}"/></defs>`,
  `<rect width="${W}" height="${H}" fill="#e7eaee"/><use href="#n" fill="#f3f1eb"/><use href="#p" fill="#fffdf8"/>`,
  '<use href="#n" fill="none" stroke="#9c9586" stroke-width=".8" stroke-linejoin="round"/>',
  '<use href="#p" fill="none" stroke="#b9b1a0" stroke-width=".5" stroke-linejoin="round"/>',
  '<use href="#s" fill="none" stroke="#4b453b" stroke-width="1.6" stroke-linejoin="round"/>',
  '<g font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-size="10" fill="#8d877b" letter-spacing="1" text-anchor="middle">',
  ...regionLabels.map(({ t, x, y }) => `<text x="${x}" y="${y}">${t}</text>`),
  '</g></svg>',
].join('');

// Miasta: 14 z cities.php (rank 2 poza Katowicami i Gliwicami) + orientacyjne.
const here = dirname(fileURLToPath(import.meta.url));
const citiesPhp = readFileSync(join(here, '..', 'src', 'cities.php'), 'utf8');
const re = /'slug'\s*=>\s*'([^']+)'[\s\S]*?'label'\s*=>\s*'([^']+)'[\s\S]*?'lat'\s*=>\s*([\d.]+)[\s\S]*?'lon'\s*=>\s*([\d.]+)/g;
const cities = [];
for (const m of citiesPhp.matchAll(re)) {
  const [x, y] = px([Number(m[4]), Number(m[3])]);
  cities.push({ slug: m[1], name: m[2], x: f1(x), y: f1(y), rank: ['katowice', 'gliwice'].includes(m[1]) ? 1 : 2 });
}
const extra = [
  ['czestochowa', 'Częstochowa', 19.1203, 50.8118, 1], ['bielsko-biala', 'Bielsko-Biała', 19.0447, 49.8224, 1],
  ['rybnik', 'Rybnik', 18.5418, 50.0971, 1], ['opole', 'Opole', 17.9213, 50.6751, 1],
  ['krakow', 'Kraków', 19.945, 50.0647, 1], ['raciborz', 'Racibórz', 18.2193, 50.0919, 2],
  ['cieszyn', 'Cieszyn', 18.6328, 49.7496, 2], ['zywiec', 'Żywiec', 19.1925, 49.6856, 2],
  ['lubliniec', 'Lubliniec', 18.6847, 50.6684, 2], ['zawiercie', 'Zawiercie', 19.4176, 50.4875, 2],
  ['ostrava', 'Ostrava', 18.2625, 49.8209, 1],
];
for (const [slug, name, lon, lat, rank] of extra) {
  const [x, y] = px([lon, lat]);
  cities.push({ slug, name, x: f1(x), y: f1(y), rank, extra: true });
}

const json = JSON.stringify({ bbox_ll: BBOX_LL, size: [W, H], geometry, regions: regionLabels, cities });
if (args.out) {
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, 'radar-basemap.json'), json);
  writeFileSync(join(args.out, 'radar-basemap.svg'), svg);
  console.log(`radar-basemap.json: ${json.length} B, radar-basemap.svg: ${svg.length} B (powiaty śląskie: ${slaskPow.length}), miasta: ${cities.length}`);
}
if (args.js) { // wklejane przez scripts/build.sh do dist/mo-radar.js (wspólny zakres IIFE)
  const js = '/* Wygenerowane przez scripts/gen-basemap.mjs, nie edytować ręcznie.\n'
    + ' * Granice: PRG (GUGiK) przez ppatrzyk/polska-geojson (MIT). Web Mercator, ' + W + 'x' + H + ' px, bbox jak klatki radaru. */\n'
    + 'var MO_RADAR_BASEMAP = ' + json + ';\n';
  mkdirSync(dirname(args.js), { recursive: true });
  writeFileSync(args.js, js);
  console.log(`${args.js}: ${js.length} B (powiaty śląskie: ${slaskPow.length}), miasta: ${cities.length}`);
}
