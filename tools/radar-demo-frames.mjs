#!/usr/bin/env node
/**
 * Dev-only: syntetyczne klatki radaru do podglądu (NARZĘDZIE POMOCNICZE, NIE CZĘŚĆ PRODUKTU).
 *
 * Generuje serię PNG-ów w identycznym formacie co produkcent na Railway (paleta + tRNS,
 * 704×676 w Web Mercatorze na bbox 16,8–21,2°E / 48,9–51,6°N) oraz manifest.json,
 * żeby dać się obejrzeć animację, interpolację co minutę i prognozę ruchu bez produkcyjnego API.
 *
 * Dane są sztuczne (linia szkwałowa przesuwająca się na wschód) — do oceny interfejsu, nie meteorologii.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const SIZE = [704, 676];
export const BBOX_LL = [16.8, 48.9, 21.2, 51.6];
export const STEP_MIN = 5;
export const FRAMES = 13;

/** Paleta jak w src/radar-lib.php: 0 przezroczysty, 1 brak danych, 2..13 klasy co 5 dBZ. */
const PALETTE = [
  [0, 0, 0, 0], [128, 128, 128, 60],
  [160, 220, 255, 150], [90, 175, 255, 190], [35, 120, 245, 215], [25, 185, 70, 225],
  [15, 135, 40, 235], [250, 225, 0, 240], [255, 165, 0, 245], [255, 85, 0, 250],
  [225, 0, 0, 255], [160, 0, 50, 255], [225, 0, 225, 255], [255, 255, 255, 255],
];

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(w, h, pixels) {
  const raw = Buffer.alloc(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    pixels.copy(raw, y * (w + 1) + 1, y * w, (y + 1) * w);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 3; // 8 bitów, paleta (typ 3)
  const plte = Buffer.alloc(PALETTE.length * 3);
  const trns = Buffer.alloc(PALETTE.length);
  PALETTE.forEach(([r, g, b, a], i) => {
    plte[i * 3] = r; plte[i * 3 + 1] = g; plte[i * 3 + 2] = b;
    trns[i] = a;
  });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('tRNS', trns),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Klasy dBZ z pola linii szkwałowej (przesuwającej się na wschód) plus komórki. */
function renderFrame(index) {
  const [W, H] = SIZE;
  const pixels = Buffer.alloc(W * H);
  const shift = index * 7.5;          // px na klatkę (≈5,2 km/5 min ≈ 63 km/h)
  const cells = [
    { x: 300 + shift, y: 300, r: 34, peak: 58 },  // główna komórka
    { x: 420 + shift, y: 250, r: 24, peak: 45 },
    { x: 180 + shift, y: 380, r: 20, peak: 40 },
  ];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      // Linia szkwałowa: obrócona o ~25°, przesuwająca się na wschód.
      const line = (x - shift) * 0.906 + (y - 330) * 0.423;
      let dbz = 0;
      const dist = Math.abs(line);
      if (dist < 46) dbz = Math.max(dbz, 52 - dist * 0.9);
      for (const c of cells) {
        const d = Math.hypot(x - c.x, y - c.y);
        if (d < c.r) dbz = Math.max(dbz, c.peak * (1 - (d / c.r) ** 2));
      }
      // Komórka nadciągająca od zachodu (mniej rozwinięta, przesuwa się szybciej).
      const back = Math.hypot(x - (90 + shift * 1.25), y - 430);
      if (back < 46) dbz = Math.max(dbz, 32 * (1 - (back / 46) ** 2));
      let idx = 1; // brak danych
      if (dbz >= 65) idx = 13;
      else if (dbz >= 10) idx = 2 + Math.floor((dbz - 10) / 5);
      pixels[y * W + x] = idx;
    }
  }
  return encodePng(W, H, pixels);
}

function stamp(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}T${p(date.getUTCHours())}${p(date.getUTCMinutes())}`;
}

/**
 * Generuje (lub odświeża) zestaw klatek w katalogu dir.
 * Zwraca { manifest, dir }.
 */
export function ensureFrames(dir, nowMs = Date.now()) {
  fs.mkdirSync(dir, { recursive: true });
  const slot = Math.floor(nowMs / (STEP_MIN * 60000)) * STEP_MIN * 60000;
  const frames = [];
  for (let i = 0; i < FRAMES; i++) {
    const t = new Date(slot - (FRAMES - 1 - i) * STEP_MIN * 60000);
    frames.push(stamp(t));
  }
  const manifest = {
    version: 1,
    generated: new Date(nowMs).toISOString().replace(/\.\d+Z$/, 'Z'),
    latest: frames[frames.length - 1],
    frames: frames.map((t) => ({ t })),
    source: 'DANE SYNTETYCZNE (podgląd deweloperski) — na produkcji: EUMETNET OPERA CIRRUS DBZH',
    attribution: 'Dane syntetyczne (dev-preview) — na produkcji: EUMETNET OPERA (CC BY 4.0)',
    bbox_ll: BBOX_LL,
    size: SIZE,
    step_seconds: STEP_MIN * 60,
    synthetic: true,
  };
  const marker = path.join(dir, '.stamp');
  const current = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
  if (current !== String(slot)) {
    frames.forEach((t, i) => fs.writeFileSync(path.join(dir, `radar_${t}.png`), renderFrame(i)));
    for (const f of fs.readdirSync(dir)) {
      if (/^radar_.*\.png$/.test(f) && !frames.some((t) => f === `radar_${t}.png`)) {
        fs.unlinkSync(path.join(dir, f));
      }
    }
    fs.writeFileSync(marker, String(slot));
  }
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return { manifest, dir };
}

if (process.argv[1] && process.argv[1].endsWith('radar-demo-frames.mjs')) {
  const dir = process.argv[2] || path.join(path.dirname(process.argv[1]), '.radar-demo');
  const { manifest } = ensureFrames(dir);
  console.log(`[radar-demo] ${dir}: ${manifest.frames.length} klatek, ostatnia ${manifest.latest}`);
}
