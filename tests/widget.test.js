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
console.log('  [7/10] Checking minified artifact integrity...');
assert(distMinJs.length > 2000 && distMinJs.length < 15000, `Minified JS size within budget: ${distMinJs.length} bytes`);
assert(distMinJs.startsWith('/*!'), 'Minified bundle must preserve leading license comment /*!');

// Test 8: P1.8 - Czyszczenie starych kluczy localStorage v1
console.log('  [8/10] Checking localStorage v1 cleanup logic (P1.8)...');
assert(srcJs.includes("indexOf('mo-weather:v1:') === 0"), 'Widget must clean legacy mo-weather:v1:* keys on init');

// Test 9: P1.9 - Zgodność wsteczna: domyślne modules="current"
console.log('  [9/10] Checking backward compatibility default modules="current" (P1.9)...');
assert(srcJs.includes("if (!m) return ['current'];"), 'Widget must default to modules=["current"] when attribute omitted');

// Test 10: P1.10 - Dynamiczna atrybucja per aktywny moduł
console.log('  [10/10] Checking dynamic module attribution in footer (P1.10)...');
assert(srcJs.includes("var hasMet = modules.indexOf('current') !== -1 || modules.indexOf('daily7') !== -1 || modules.indexOf('nowcast') !== -1;"), 'Footer checks for MET Norway modules');
assert(srcJs.includes("var hasAir = modules.indexOf('air') !== -1;"), 'Footer checks for air module');

console.log('✓ All Frontend Widget Unit Tests passed successfully!\n');
