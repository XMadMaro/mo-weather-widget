#!/usr/bin/env node
/**
 * Ręczny test przeglądarkowy okna radaru (nie jest częścią `npm test`).
 * Sprawdza kryteria z docs/RADAR-PLAN.md B.2:
 *  - przycisk tylko z atrybutem `radar`, leniwe ładowanie modułu;
 *  - animacja, widok miasta, Esc i powrót fokusu;
 *  - tryby floating i aggregator, `prefers-reduced-motion`;
 *  - stany błąd / down / stale;
 *  - telefon 390 px, axe-core (WCAG 2.1 AA), CLS.
 *
 * Wymaga działającego serwera z klatkami (np. `MO_RADAR_MODE=producer php -S 0.0.0.0:8090 -t public router.php`
 * plus `php scripts/radar-worker.php --src-dir=…` na danych z make-synthetic.py) oraz jednorazowo:
 *   npm i --no-save puppeteer-core @sparticuz/chromium axe-core
 * Uruchomienie: BASE_URL=http://127.0.0.1:8090/ node scripts/radar-poc/e2e-browser.mjs
 * (bez systemowych bibliotek Chrome dodać AWS_EXECUTION_ENV=AWS_Lambda_nodejs22.x, wtedy @sparticuz/chromium rozpakuje własne).
 * Zrzuty ekranu trafiają do OUT_DIR (domyślnie /tmp/e2e-shots).
 */
import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { readFileSync, mkdirSync } from 'node:fs';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:8090/';
const OUT = process.env.OUT_DIR || '/tmp/e2e-shots';
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await puppeteer.launch({ executablePath: await chromium.executablePath(), args: chromium.args, headless: true });
const results = [];
const ok = (cond, msg) => { results.push((cond ? 'PASS ' : 'FAIL ') + msg); };

async function newPage(viewport = { width: 1280, height: 900 }, reduced = false) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  if (reduced) await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  page.errors = [];
  page.reqs = [];
  page.on('console', (m) => { if (m.type() === 'error') page.errors.push('console: ' + m.text()); });
  page.on('pageerror', (e) => page.errors.push('pageerror: ' + e.message));
  page.on('request', (r) => page.reqs.push(r.url()));
  await page.evaluateOnNewDocument(() => {
    window.__cls = 0;
    new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__cls += e.value; })
      .observe({ type: 'layout-shift', buffered: true });
  });
  return page;
}
const inHost = (page, host, fn, ...args) => page.evaluate((host, fnSrc, ...a) => {
  const root = document.querySelector(host).shadowRoot;
  return new Function('root', '...a', fnSrc)(root, ...a);
}, host, fn, ...args);

// 1. Strona demo: przycisk tylko z atrybutem radar, moduł nie ładuje się przed kliknięciem
let page = await newPage();
await page.goto(BASE, { waitUntil: 'networkidle0' });
await sleep(800);
const counts = await page.evaluate(() => [...document.querySelectorAll('mo-weather')].map((w) => ({
  id: w.id, mode: w.getAttribute('mode'), radar: w.hasAttribute('radar'), buttons: w.shadowRoot.querySelectorAll('.radar-btn').length })));
console.log(JSON.stringify(counts));
ok(counts.every((c) => (c.radar ? c.buttons >= 1 : c.buttons === 0)), 'radar buttons only where the attribute is set');
ok(counts.find((c) => c.mode === 'aggregator').buttons === 6, 'aggregator: one radar button per city card');
ok(!page.reqs.some((u) => u.includes('mo-radar')), 'mo-radar.min.js not requested before click');
const clsBefore = await page.evaluate(() => window.__cls);

// 2. Klik w makiecie portalu -> okno
const H = '#mock-portal-weather';
await page.evaluate((h) => document.querySelector(h).scrollIntoView({ block: 'center' }), H);
await sleep(300);
const btn = await page.evaluateHandle((h) => document.querySelector(h).shadowRoot.querySelector('.radar-btn'), H);
await btn.click();
await page.waitForFunction((h) => document.querySelector(h).shadowRoot.querySelector('dialog.rd[open]'), { timeout: 10000 }, H);
ok(page.reqs.some((u) => u.includes('/assets/mo-radar.min.js')), 'mo-radar.min.js loaded on click (sibling of weather-widget.min.js)');
await page.waitForFunction(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('frame=')).length >= 13, { timeout: 20000 });
await sleep(1200);
const st = await inHost(page, H, `
  const d = root.querySelector('dialog.rd');
  return { msg: d.querySelector('.rd-msg').textContent, time: d.querySelector('.rd-time').textContent,
    href: d.querySelector('image').getAttribute('href'), max: d.querySelector('.rd-range').max,
    city: d.querySelectorAll('.rd-views button')[1].textContent, label: d.querySelector('svg').getAttribute('aria-label'),
    badgeHidden: d.querySelector('.rd-badge').hidden, playLabel: d.querySelector('.rd-play').getAttribute('aria-label') };`);
console.log(JSON.stringify(st));
ok(st.msg === '' && st.max === '12' && /frame=\d{8}T\d{4}/.test(st.href), 'manifest loaded: 13 frames, no message');
ok(st.city === 'Katowice' && st.badgeHidden, 'city button = Katowice, no stale badge for fresh data');
ok(st.playLabel === 'Zatrzymaj animację', 'animation autoplays');
const t1 = await inHost(page, H, `return root.querySelector('.rd-time').textContent;`);
await sleep(1300);
const t2 = await inHost(page, H, `return root.querySelector('.rd-time').textContent;`);
ok(t1 !== t2, `animation advances (${t1} -> ${t2})`);
// pauza i ostatnia klatka do zrzutu
await inHost(page, H, `const d = root.querySelector('dialog.rd'); d.querySelector('.rd-play').click(); const r = d.querySelector('.rd-range'); r.value = r.max; r.dispatchEvent(new Event('input'));`);
await sleep(400);
const dlg = await page.evaluateHandle((h) => document.querySelector(h).shadowRoot.querySelector('dialog.rd'), H);
await dlg.screenshot({ path: `${OUT}/dialog-region.png` });
const lastTime = await inHost(page, H, `return root.querySelector('.rd-time').textContent;`);
ok(/^\d{2}:\d{2} · \d+ min temu$/.test(lastTime), `last frame shows Warsaw time + age (${lastTime})`);

// 3. Widok miasta
await inHost(page, H, `root.querySelectorAll('.rd-views button')[1].click();`);
await sleep(700);
const vb = await inHost(page, H, `return [root.querySelector('dialog.rd svg').getAttribute('viewBox'), root.querySelectorAll('.rd-views button')[1].getAttribute('aria-pressed')];`);
ok(vb[1] === 'true' && vb[0] !== '0 0 704 676', `city view zooms (viewBox ${vb[0]})`);
await dlg.screenshot({ path: `${OUT}/dialog-city.png` });

// 4. axe-core (WCAG 2 A/AA) z otwartym oknem
await page.addScriptTag({ content: readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8') });
const axeOpen = await page.evaluate(async () => {
  const r = await axe.run(document, { runOnly: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] });
  return r.violations.map((v) => ({ id: v.id, impact: v.impact, n: v.nodes.length, targets: v.nodes.slice(0, 3).map((n) => JSON.stringify(n.target)) }));
});
console.log('axe (dialog open):', JSON.stringify(axeOpen));
const radarViol = axeOpen.filter((v) => v.targets.some((t) => /\.rd\b|\.rd-|radar/.test(t)));
ok(radarViol.length === 0, 'axe: no WCAG violations inside radar dialog/button');

// 5. Escape zamyka, fokus wraca na przycisk
await page.keyboard.press('Escape');
await sleep(300);
const afterClose = await inHost(page, H, `return { open: root.querySelector('dialog.rd').open, focus: root.activeElement && root.activeElement.className };`);
ok(!afterClose.open && afterClose.focus === 'radar-btn', `Escape closes, focus back on button (${JSON.stringify(afterClose)})`);
const playingAfterClose = await inHost(page, H, `return root.querySelector('.rd-play').getAttribute('aria-label');`);
ok(playingAfterClose === 'Odtwórz animację', 'animation stopped after close');
const clsAfter = await page.evaluate(() => window.__cls);
ok(clsAfter - clsBefore < 0.001, `no layout shift from opening/closing (CLS delta ${(clsAfter - clsBefore).toFixed(4)}, page CLS ${clsAfter.toFixed(4)})`);
ok(page.errors.length === 0, 'no console errors: ' + JSON.stringify(page.errors));

// 6. Tryb floating: przycisk w panelu
await page.evaluate(() => document.querySelector('#floating-live').shadowRoot.querySelector('.float-btn').click());
await sleep(300);
await page.evaluate(() => document.querySelector('#floating-live').shadowRoot.querySelector('.float-panel .radar-btn').click());
await page.waitForFunction(() => document.querySelector('#floating-live').shadowRoot.querySelector('dialog.rd[open]'), { timeout: 10000 });
ok(true, 'floating mode: radar dialog opens from the panel');
await sleep(800);
await page.screenshot({ path: `${OUT}/page-floating-dialog.png` });
await page.keyboard.press('Escape');

// 7. Agregator: inne miasto
await page.evaluate(() => {
  const w = document.querySelector('mo-weather[mode="aggregator"]');
  w.scrollIntoView({ block: 'center' });
  w.shadowRoot.querySelectorAll('.radar-btn')[1].click();
});
await page.waitForFunction(() => document.querySelector('mo-weather[mode="aggregator"]').shadowRoot.querySelector('dialog.rd[open]'), { timeout: 10000 });
const aggCity = await page.evaluate(() => document.querySelector('mo-weather[mode="aggregator"]').shadowRoot.querySelectorAll('.rd-views button')[1].textContent);
ok(aggCity === 'Gliwice', `aggregator second card opens Gliwice (${aggCity})`);
await page.keyboard.press('Escape');
await page.close();

// 8. Reduced motion: brak autoodtwarzania
page = await newPage({ width: 1280, height: 900 }, true);
await page.goto(BASE, { waitUntil: 'networkidle0' });
await sleep(500);
await page.evaluate((h) => document.querySelector(h).shadowRoot.querySelector('.radar-btn').click(), H);
await page.waitForFunction((h) => document.querySelector(h).shadowRoot.querySelector('dialog.rd[open]'), {}, H);
await sleep(1500);
const rm1 = await inHost(page, H, `return root.querySelector('.rd-time').textContent + '|' + root.querySelector('.rd-play').getAttribute('aria-label');`);
await sleep(1200);
const rm2 = await inHost(page, H, `return root.querySelector('.rd-time').textContent + '|' + root.querySelector('.rd-play').getAttribute('aria-label');`);
ok(rm1 === rm2 && rm1.endsWith('Odtwórz animację'), `reduced motion: no autoplay (${rm1})`);
await page.close();

// 9. Stany: błąd sieci, down, stale (podmiana odpowiedzi)
for (const [name, respond] of [
  ['error', { status: 503, contentType: 'application/json', body: '{"error":"x"}' }],
  ['down', { status: 200, contentType: 'application/json', body: '{"status":"down","frames":[]}' }],
  ['stale', null],
]) {
  page = await newPage({ width: 390, height: 844 });
  await page.setRequestInterception(true);
  page.on('request', async (r) => {
    if (!r.url().includes('/api/radar') || !r.url().includes('manifest')) return r.continue();
    if (respond) return r.respond(respond);
    const real = await (await fetch(r.url())).json();
    real.status = 'stale';
    return r.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(real) });
  });
  await page.goto(BASE, { waitUntil: 'networkidle0' });
  await sleep(500);
  await page.evaluate((h) => { const w = document.querySelector(h); w.scrollIntoView(); w.shadowRoot.querySelector('.radar-btn').click(); }, H);
  await page.waitForFunction((h) => document.querySelector(h).shadowRoot.querySelector('dialog.rd[open]'), {}, H);
  await sleep(1500);
  const s = await inHost(page, H, `const d = root.querySelector('dialog.rd'); return { msg: d.querySelector('.rd-msg').textContent, retry: !!d.querySelector('.rd-retry'), badge: d.querySelector('.rd-badge').hidden ? '' : d.querySelector('.rd-badge').textContent, playDisabled: d.querySelector('.rd-play').disabled };`);
  console.log(name, JSON.stringify(s));
  if (name === 'error') ok(s.msg.startsWith('Nie udało się pobrać radaru.') && s.retry && s.playDisabled, 'error state: message + retry, player disabled');
  if (name === 'down') ok(s.msg.startsWith('Radar jest chwilowo niedostępny') && s.retry, 'down state: message + retry');
  if (name === 'stale') ok(/^Dane sprzed \d+ min$/.test(s.badge) && s.msg === '', `stale state: badge "${s.badge}"`);
  const d = await page.evaluateHandle((h) => document.querySelector(h).shadowRoot.querySelector('dialog.rd'), H);
  await d.screenshot({ path: `${OUT}/mobile-${name}.png` });
  await page.close();
}

// 10. Telefon: czytelne napisy, fokus na oknie
page = await newPage({ width: 390, height: 844 });
await page.goto(BASE, { waitUntil: 'networkidle0' });
await sleep(500);
await page.evaluate((h) => { const w = document.querySelector(h); w.scrollIntoView(); w.shadowRoot.querySelector('.radar-btn').click(); }, H);
await page.waitForFunction((h) => document.querySelector(h).shadowRoot.querySelector('dialog.rd[open]'), {}, H);
await sleep(1500);
await inHost(page, H, `const d = root.querySelector('dialog.rd'); d.querySelector('.rd-play').click(); const r = d.querySelector('.rd-range'); r.value = r.max; r.dispatchEvent(new Event('input'));`);
await sleep(300);
const mob = await inHost(page, H, `const t = root.querySelector('dialog.rd g[aria-hidden] text:not([stroke=none])'); const lab = [...root.querySelectorAll('dialog.rd text')].filter((x) => x.getAttribute('font-weight')); return { focus: root.activeElement && root.activeElement.tagName, labelPx: lab.length ? Math.round(lab[0].getBoundingClientRect().height) : 0, labels: lab.length };`);
ok(mob.focus === 'DIALOG', 'initial focus on the dialog itself (' + mob.focus + ')');
ok(mob.labelPx >= 10, 'mobile: city labels readable (' + mob.labelPx + ' px, ' + mob.labels + ' labels)');
let md = await page.evaluateHandle((h) => document.querySelector(h).shadowRoot.querySelector('dialog.rd'), H);
await md.screenshot({ path: `${OUT}/mobile-region.png` });
await inHost(page, H, `root.querySelectorAll('.rd-views button')[1].click();`);
await sleep(700);
await md.screenshot({ path: `${OUT}/mobile-city.png` });
await page.close();

await browser.close();
console.log(results.join('\n'));
const failed = results.some((r) => r.startsWith('FAIL'));
console.log(failed ? 'E2E: FAILURES' : 'E2E: ALL PASS');
process.exit(failed ? 1 : 0);
