#!/usr/bin/env node
'use strict';

/**
 * MO Weather Widget — Frontend Unit Tests (v1.0.1)
 * Weryfikacja reguł: CLS (170px), WCAG AA kontrast, a11y role="region", XSS security, WMO mapping.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

console.log('==> Running Frontend Widget Unit Tests (v1.0.1)...');

const srcJsPath = path.resolve(__dirname, '../src/weather-widget.js');
const distJsPath = path.resolve(__dirname, '../dist/weather-widget.js');
const distMinJsPath = path.resolve(__dirname, '../dist/weather-widget.min.js');

const srcJs = fs.readFileSync(srcJsPath, 'utf8');
const distJs = fs.readFileSync(distJsPath, 'utf8');
const distMinJs = fs.readFileSync(distMinJsPath, 'utf8');

// Test 1: Wersja 2.0.0 w nagłówkach
console.log('  [1/7] Checking version tags...');
assert(srcJs.includes('v2.0.0'), 'src/weather-widget.js must declare v2.0.0');
assert(distJs.includes('v2.0.0'), 'dist/weather-widget.js must declare v2.0.0');
assert(distMinJs.includes('v2.0.0'), 'dist/weather-widget.min.js must preserve v2.0.0 header');

// Test 2: CLS Fix (Audit #3: min-height i skel 170px)
console.log('  [2/7] Checking CLS fixes (height: 170px, min-height: 170px)...');
assert(srcJs.includes('.wrap{min-height:170px;}'), 'wrap must have min-height: 170px');
assert(srcJs.includes('.skel{height:170px;'), 'skel must have height: 170px');
assert(!srcJs.includes('.wrap{min-height:96px;}'), 'old 96px wrap must be gone');
assert(!srcJs.includes('.skel{height:96px;'), 'old 96px skel must be gone');

// Test 3: WCAG AA Kontrast atrybucji (Audit #8: >= 4.5:1)
console.log('  [3/7] Checking WCAG AA attribution contrast color (#595959)...');
assert(srcJs.includes('--mo-foot,#595959'), 'foot must use accessible color #595959 (contrast > 7:1 on #fff)');
assert(!srcJs.includes('.foot{margin:8px 2px 0;font-size:10px;color:var(--mo-muted,#999);}'), 'old #999 foot must be replaced');
assert(srcJs.includes('.foot a{color:inherit;text-decoration:underline;}'), 'foot link must have underline for a11y');

// Test 4: role="region" dla karuzeli aggregator (Audit #9)
console.log('  [4/7] Checking accessibility role="region" on aggregator carousel...');
assert(srcJs.includes("row.setAttribute('role', 'region')"), 'aggregator row must have role="region"');
assert(srcJs.includes("row.setAttribute('aria-label', 'Prognoza pogody dla wybranych miast')"), 'aggregator row must have aria-label');
assert(srcJs.includes("row.setAttribute('tabindex', '0')"), 'aggregator row must be keyboard focusable (tabindex=0)');

// Test 5: Bezpieczeństwo XSS (tylko textContent dla danych z API)
console.log('  [5/7] Checking XSS prevention invariants...');
assert(srcJs.includes('if (text !== undefined) n.textContent = text;'), 'DOM text injection must use textContent');
assert(!srcJs.includes('innerHTML = d.'), 'Never inject API payload data into innerHTML');

// Test 6: WMO mapowanie kodów pogodowych
console.log('  [6/7] Checking WMO code mappings...');
assert(srcJs.includes("if (code === 0)  return ['sun', 'Bezchmurnie'];"), 'WMO code 0 mapping exists');
assert(srcJs.includes("if (code <= 48)  return ['fog', 'Mgła'];"), 'WMO code fog mapping exists');
assert(srcJs.includes("if (code <= 67)  return ['rain', 'Deszcz'];"), 'WMO code rain mapping exists');
assert(srcJs.includes("if (code <= 77)  return ['snow', 'Śnieg'];"), 'WMO code snow mapping exists');

// Test 7: Minifikacja i rozmiar bundle
console.log('  [7/18] Checking minified artifact integrity...');
assert(distMinJs.length > 2000 && distMinJs.length < 25000, `Minified JS size within budget: ${distMinJs.length} bytes`);
assert(distMinJs.startsWith('/*!'), 'Minified bundle must preserve leading license comment /*!');

// Test 8: P1.8 - Czyszczenie starych kluczy localStorage v1
console.log('  [8/15] Checking localStorage v1 cleanup logic (P1.8)...');
assert(srcJs.includes("indexOf('mo-weather:v1:') === 0"), 'Widget must clean legacy mo-weather:v1:* keys on init');

// Test 9: P1.9 - Zgodność wsteczna: domyślne modules="current"
console.log('  [9/15] Checking backward compatibility default modules="current" (P1.9)...');
assert(srcJs.includes("if (!m) return ['current'];"), 'Widget must default to modules=["current"] when attribute omitted');

// Test 10: P1.10 - Dynamiczna atrybucja per aktywny moduł
console.log('  [10/15] Checking dynamic module attribution in footer (P1.10)...');
assert(srcJs.includes("var hasMet = modules.indexOf('current') !== -1 || modules.indexOf('daily7') !== -1 || modules.indexOf('nowcast') !== -1;"), 'Footer checks for MET Norway modules');
assert(srcJs.includes("var hasAir = modules.indexOf('air') !== -1;"), 'Footer checks for air module');

// Test 11: E1 DoD #1 — Katowice: PM2,5 + PM10, godzina pomiaru i stacja GIOŚ
console.log('  [11/15] Checking E1 DoD #1 (Katowice: PM2,5 + PM10 measurement formatting)...');
assert(srcJs.includes("stats.appendChild(el('span', null, 'PM2,5: ' + p25Val));"), 'Katowice air card includes PM2.5');
assert(srcJs.includes("stats.appendChild(el('span', null, 'PM10: ' + p10Val));"), 'Katowice air card includes PM10');
assert(srcJs.includes("bundle.city === 'katowice' && isMeas"), 'Katowice is explicitly distinguished for PM2.5 measurement');

// Test 12: E1 DoD #2 — Bytom: prognoza IOŚ-PIB dla miast bez stacji GIOŚ
console.log('  [12/15] Checking E1 DoD #2 (Bytom: IOŚ-PIB forecast formatting)...');
assert(srcJs.includes("fcast.days[0].pm10 + ' µg/m³ (prognoza)'"), 'Cities without GIOŚ display (prognoza) label on PM10');
assert(srcJs.includes("badgeText = 'Prognoza: ' + fcast.category.toLowerCase()"), 'Forecast badge indicates Prognoza: category');

// Test 13: E1 DoD #3 — Gliwice: PM10 aktywne, PM2,5 oznaczone jako niedostępny
console.log('  [13/15] Checking E1 DoD #3 (Gliwice: PM10 measurement + PM2,5 marked as niedostępny)...');
assert(srcJs.includes("p25Val = 'niedostępny';"), 'Cities without PM2.5 sensor explicitly show niedostępny');
assert(!srcJs.includes("p25Val = '0';"), 'Never output 0 for missing pollutant data');

// Test 14: E1 DoD #4 — Degradacja: obsługa chwilowej niedostępności stacji GIOŚ
console.log('  [14/15] Checking E1 DoD #4 (Degradation fallback & label)...');
assert(srcJs.includes("var sourceLabel = meas.label ||"), 'Air card renders sourceLabel from measurement.label or forecast.label');
assert(srcJs.includes('.air-sub{font-size:11px;color:var(--mo-muted,#666);margin:4px 0 0;}'), 'Air sublabel styling present');

// Test 15: E1 DoD #5 — Europejski AQI (EEA) oraz dedykowany blok porady zdrowotnej
console.log('  [15/18] Checking E1 DoD #5 (EEA AQI styling & health advice block)...');
assert(srcJs.includes('.air-advice{font-size:11px;'), 'air-advice CSS class defined for health recommendations');
assert(srcJs.includes("var adviceBox = el('p', 'air-advice', adviceText);"), 'air-advice DOM node created with textContent');
assert(srcJs.includes("case 1: return { bg: '#e6f4ea', text: '#137333', label: 'Bardzo dobry' };"), 'EEA AQI Level 1 color defined');
assert(srcJs.includes("case 6: return { bg: '#f3e8fd', text: '#7627bb', label: 'Bardzo zły' };"), 'EEA AQI Level 6 color defined');

// Test 16: Tryb sidebar (kompaktowy pion <= 320px + sticky)
console.log('  [16/18] Checking mode="sidebar" styling and sticky support...');
assert(srcJs.includes(':host([mode="sidebar"])'), 'Widget must define :host([mode="sidebar"]) style');
assert(srcJs.includes('.card-sidebar'), 'Widget must define .card-sidebar class for compact vertical layout');
assert(srcJs.includes(':host([mode="sidebar"][sticky])'), 'Widget must support sticky attribute for sidebar');

// Test 17: Tryb floating (launcher bubble + a11y panel dialog)
console.log('  [17/18] Checking mode="floating" launcher and a11y dialog...');
assert(srcJs.includes("btn.setAttribute('aria-label', 'Pogoda — otwórz panel')"), 'Launcher button must have a11y aria-label');
assert(srcJs.includes("btn.setAttribute('aria-controls', 'mo-float-panel')"), 'Launcher button must have aria-controls targeting panel');
assert(srcJs.includes("lsGet('floating-open')"), 'Floating panel must restore state from localStorage');
assert(srcJs.includes("e.key === 'Escape'"), 'Escape key must close floating panel and restore focus');

// Test 18: Kompatybilność wsteczna - brak mode defaults to single
console.log('  [18/18] Checking backward compatibility: mode omitted defaults to single...');
assert(srcJs.includes("var mode = this.getAttribute('mode') || 'single';"), 'Omitted mode must default to single');

console.log('✓ All Frontend Widget Unit Tests (18/18) passed successfully!\n');
