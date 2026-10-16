#!/usr/bin/env node
/**
 * Statyczny podgląd okna radaru (te same warstwy co prototyp): tło -> radar -> granice -> etykiety.
 * Narzędzie do dokumentacji PoC. Wymaga @resvg/resvg-js poza repo:
 *   npm i --no-save --prefix /tmp/node-tools @resvg/resvg-js@2
 *   node scripts/radar-poc/compose-preview.mjs KATALOG_DEMO radar_T.png out.png [region|city] [slug] [syntetyczne|prawdziwe]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(`${process.env.RESVG_PREFIX || '/tmp/node-tools'}/`);
const { Resvg } = require('@resvg/resvg-js');
const [,, demoDir, frameFile, outFile, mode = 'region', city = 'katowice', kind = 'syntetyczne'] = process.argv;
const b = JSON.parse(readFileSync(`${demoDir}/radar-basemap.json`, 'utf8'));
const frame = readFileSync(`${demoDir}/${frameFile}`).toString('base64');
const W = 704, H = 676, HEAD = 46, FOOT = 92, ZOOM = 2.6;
const c0 = b.cities.find((c) => c.slug === city);
const vb = mode === 'city'
  ? [Math.min(Math.max(c0.x - W / ZOOM / 2, 0), W - W / ZOOM), Math.min(Math.max(c0.y - H / ZOOM / 2, 0), H - H / ZOOM), W / ZOOM, H / ZOOM]
  : [0, 0, W, H];
const z = W / vb[2];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const placed = [];
let labels = '';
const list = b.cities.filter((c) => z > 1.5 || c.rank === 1 || c.slug === city)
  .sort((a, c) => (c.slug === city) - (a.slug === city) || a.rank - c.rank);
for (const c of list) {
  const me = c.slug === city;
  labels += `<circle cx="${c.x}" cy="${c.y}" r="${(me ? 4.2 : 2.6) / z}" fill="${me ? '#d6336c' : '#1f2937'}" stroke="#fff" stroke-width="${1.2 / z}"/>`;
  const w = c.name.length * 6.9 / z * (me ? 1.08 : 1), h = 13 / z;
  for (const side of [1, -1]) {
    const x = side > 0 ? c.x + 6 / z : c.x - 6 / z - w;
    const box = [x, c.y - h / 2, x + w, c.y + h / 2];
    if (placed.some((p) => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) continue;
    placed.push(box);
    labels += `<text x="${side > 0 ? c.x + 6 / z : c.x - 6 / z}" y="${c.y + 4 / z}" text-anchor="${side > 0 ? 'start' : 'end'}" font-size="${(me ? 13 : 11.5) / z}" font-weight="${me ? 700 : 500}" fill="#111827" stroke="#fff" stroke-width="${3 / z}" paint-order="stroke">${esc(c.name)}</text>`;
    break;
  }
}
const sw = (v) => v / z; // resvg: odpowiednik vector-effect non-scaling-stroke
const map = `<svg x="0" y="${HEAD}" width="${W}" height="${H}" viewBox="${vb.join(' ')}" preserveAspectRatio="none">
<defs><path id="n" d="${b.geometry.neighbors}"/><path id="p" d="${b.geometry.powiaty}"/><path id="s" d="${b.geometry.slaskie}"/></defs>
<rect width="${W}" height="${H}" fill="#e7eaee"/><use href="#n" fill="#f3f1eb"/><use href="#p" fill="#fffdf8"/>
<image href="data:image/png;base64,${frame}" width="${W}" height="${H}" preserveAspectRatio="none"/>
<use href="#n" fill="none" stroke="#8f887a" stroke-width="${sw(.8)}" stroke-linejoin="round" opacity=".8"/>
<use href="#p" fill="none" stroke="#8f887a" stroke-width="${sw(.5)}" stroke-linejoin="round" opacity=".55"/>
<use href="#s" fill="none" stroke="#3f3a32" stroke-width="${sw(1.8)}" stroke-linejoin="round"/>
<g font-size="${10 / z}" fill="#8d877b" letter-spacing="${1 / z}" text-anchor="middle">${b.regions.map((r) => `<text x="${r.x}" y="${r.y}">${r.t}</text>`).join('')}</g>
${labels}</svg>`;
const legend = [['słaby', '#a0dcff'], ['umiarkowany', '#19b946'], ['silny', '#fae100'], ['bardzo silny / burza', '#ff5500'], ['możliwy grad', '#e100e1'], ['brak danych', '#c8c8c8']];
let lx = 16;
const legendSvg = legend.map(([t, c]) => { const s = `<rect x="${lx}" y="${HEAD + H + 52}" width="13" height="13" rx="3" fill="${c}"/><text x="${lx + 18}" y="${HEAD + H + 63}" font-size="11.5" fill="#374151">${t}</text>`; lx += 28 + t.length * 6.3; return s; }).join('');
const t = frameFile.match(/(\d{8})T(\d\d)(\d\d)/);
const local = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' })
  .format(new Date(Date.UTC(+t[1].slice(0, 4), +t[1].slice(4, 6) - 1, +t[1].slice(6, 8), +t[2], +t[3])));
const cityName = c0.name;
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${HEAD + H + FOOT}" font-family="DejaVu Sans">
<rect width="100%" height="100%" fill="#fff"/>
<text x="16" y="30" font-size="18" font-weight="700" fill="#111827">Radar burzowy</text>
${kind === 'prawdziwe' ? '<rect x="178" y="13" width="168" height="22" rx="11" fill="#dcfce7"/><text x="190" y="28.5" font-size="11.5" font-weight="700" fill="#166534">PRAWDZIWE DANE OPERA</text>' : '<rect x="178" y="13" width="152" height="22" rx="11" fill="#fde2e1"/><text x="190" y="28.5" font-size="11.5" font-weight="700" fill="#b42318">DANE SYNTETYCZNE</text>'}
<rect x="${W - 238}" y="10" width="222" height="28" rx="14" fill="#f3f4f6"/>
<rect x="${mode === 'region' ? W - 236 : W - 128}" y="12" width="${mode === 'region' ? 106 : 110}" height="24" rx="12" fill="#111827"/>
<text x="${W - 183}" y="28.5" font-size="12" text-anchor="middle" fill="${mode === 'region' ? '#fff' : '#374151'}">Województwo</text>
<text x="${W - 73}" y="28.5" font-size="12" text-anchor="middle" fill="${mode === 'city' ? '#fff' : '#374151'}">${esc(cityName)}</text>
${map}
<circle cx="32" cy="${HEAD + H + 26}" r="15" fill="#111827"/><rect x="26" y="${HEAD + H + 19}" width="4" height="14" fill="#fff"/><rect x="34" y="${HEAD + H + 19}" width="4" height="14" fill="#fff"/>
<rect x="58" y="${HEAD + H + 23}" width="456" height="6" rx="3" fill="#111827"/><circle cx="514" cy="${HEAD + H + 26}" r="8" fill="#111827"/>
<text x="${W - 16}" y="${HEAD + H + 31}" font-size="13" text-anchor="end" fill="#111827" font-weight="700">${local}</text>
${legendSvg}
<text x="16" y="${HEAD + H + 84}" font-size="10.5" fill="#6b7280">Opóźnienie radaru ok. 5–10 min</text>
<text x="${W - 16}" y="${HEAD + H + 84}" font-size="10.5" text-anchor="end" fill="#6b7280">Radar: EUMETNET OPERA (CC BY 4.0) · Granice: PRG/GUGiK</text>
</svg>`;
writeFileSync(outFile, new Resvg(svg, { font: { loadSystemFonts: true, defaultFontFamily: 'DejaVu Sans' } }).render().asPng());
console.log('wrote', outFile);
