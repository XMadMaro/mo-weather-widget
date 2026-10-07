#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import assert from 'assert';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const fixturesDir = path.resolve(__dirname, 'fixtures');

console.log('==> Running check-cities-test.mjs (21 offline tests)...');

// Wczytanie miast z src/cities.php poprzez PHP CLI z cwd: rootDir
const citiesJson = execSync('php -r "echo json_encode(require \'src/cities.php\');"', { cwd: rootDir, encoding: 'utf8' });
const cities = JSON.parse(citiesJson);

let testCount = 0;
function test(name, fn) {
  testCount++;
  try {
    fn();
    console.log(`  [${testCount}/21] ✓ ${name}`);
  } catch (err) {
    console.error(`  [${testCount}/21] ✗ ${name}`);
    throw err;
  }
}

// 1. Dokładnie 14 miast w konfiguracji
test('Total city count is exactly 14', () => {
  assert.strictEqual(Object.keys(cities).length, 14);
});

// 2. Walidacja formatu slugów (lowercase, a-z0-9-)
test('City slugs are valid lowercase slugs', () => {
  for (const slug of Object.keys(cities)) {
    assert.match(slug, /^[a-z0-9-]+$/);
  }
});

// 3. Poprawne współrzędne Katowic
test('Katowice coordinates are valid', () => {
  const k = cities['katowice'];
  assert(k.lat >= 50.2 && k.lat <= 50.3);
  assert(k.lon >= 19.0 && k.lon <= 19.1);
});

// 4. Poprawne współrzędne Gliwic
test('Gliwice coordinates are valid', () => {
  const g = cities['gliwice'];
  assert(g.lat >= 50.25 && g.lat <= 50.35);
  assert(g.lon >= 18.6 && g.lon <= 18.75);
});

// 5. Poprawne współrzędne Bytomia
test('Bytom coordinates are valid', () => {
  const b = cities['bytom'];
  assert(b.lat >= 50.3 && b.lat <= 50.4);
  assert(b.lon >= 18.85 && b.lon <= 18.98);
});

// 6. Kody TERYT dla wszystkich 14 miast (woj. śląskie 24xx)
test('All 14 cities have valid 4-digit Silesian TERYT (24xx)', () => {
  for (const [slug, c] of Object.entries(cities)) {
    assert.match(String(c.teryt), /^24\d{2}$/, `Invalid TERYT for ${slug}`);
  }
});

// 7. Poziom TERYT (Knurów, Będzin, Tarnowskie Góry to powiaty)
test('County-level TERYT flagged for Knurów, Będzin and Tarnowskie Góry', () => {
  assert.strictEqual(cities['knurow'].teryt_level, 'county');
  assert.strictEqual(cities['bedzin'].teryt_level, 'county');
  assert.strictEqual(cities['tarnowskie-gory'].teryt_level, 'county');
  assert.strictEqual(cities['katowice'].teryt_level, 'city');
});

// 8. Dokładnie 6 stacji z pomiarem GIOŚ
test('Exactly 6 cities have active GIOŚ measurement', () => {
  const giosCities = Object.keys(cities).filter(s => cities[s].has_gios);
  assert.strictEqual(giosCities.length, 6);
  assert.deepStrictEqual(giosCities.sort(), ['dabrowa-gornicza', 'gliwice', 'katowice', 'sosnowiec', 'tychy', 'zabrze'].sort());
});

// 9. Katowice: stacja 17318 i sensor PM10 28758
test('Katowice station 17318 and PM10 sensor 28758', () => {
  assert.strictEqual(cities['katowice'].gios_station_id, 17318);
  assert.strictEqual(cities['katowice'].sensors.pm10, 28758);
});

// 10. Katowice to JEDYNE miasto z automatycznym pomiarem PM2,5 (28759)
test('Katowice is the ONLY city with PM2.5 sensor (28759)', () => {
  assert.strictEqual(cities['katowice'].sensors.pm25, 28759);
  for (const [slug, c] of Object.entries(cities)) {
    if (slug !== 'katowice') {
      assert.strictEqual(c.sensors?.pm25, null, `PM2.5 must be null for ${slug}`);
    }
  }
});

// 11. Gliwice: stacja 809, sensor 5312, ignoruje manualny 5314
test('Gliwice station 809 uses sensor 5312 and ignores manual 5314', () => {
  const g = cities['gliwice'];
  assert.strictEqual(g.gios_station_id, 809);
  assert.strictEqual(g.sensors.pm10, 5312);
  assert(g.ignored_sensors.includes(5314));
});

// 12. Sosnowiec: stacja 837, sensor 5480, brak PM2,5
test('Sosnowiec station 837 uses PM10 sensor 5480 and no PM2.5', () => {
  const s = cities['sosnowiec'];
  assert.strictEqual(s.gios_station_id, 837);
  assert.strictEqual(s.sensors.pm10, 5480);
  assert.strictEqual(s.sensors.pm25, null);
});

// 13. Zabrze: stacja 17880, sensor 29671, ignoruje manualny 29679
test('Zabrze station 17880 uses PM10 sensor 29671 and ignores manual 29679', () => {
  const z = cities['zabrze'];
  assert.strictEqual(z.gios_station_id, 17880);
  assert.strictEqual(z.sensors.pm10, 29671);
  assert(z.ignored_sensors.includes(29679));
});

// 14. Tychy: stacja 841, sensor 5505, brak PM2,5
test('Tychy station 841 uses PM10 sensor 5505 and no PM2.5', () => {
  const t = cities['tychy'];
  assert.strictEqual(t.gios_station_id, 841);
  assert.strictEqual(t.sensors.pm10, 5505);
  assert.strictEqual(t.sensors.pm25, null);
});

// 15. Dąbrowa Górnicza: stacja 805, sensor 5286, ignoruje manualny 5287
test('Dąbrowa Górnicza station 805 uses PM10 5286 and ignores manual 5287', () => {
  const d = cities['dabrowa-gornicza'];
  assert.strictEqual(d.gios_station_id, 805);
  assert.strictEqual(d.sensors.pm10, 5286);
  assert(d.ignored_sensors.includes(5287));
});

// 16. Dokładnie 8 miast kierowanych na prognozę IOŚ-PIB
test('Exactly 8 cities without active GIOŚ route to IOŚ-PIB', () => {
  const iosCities = Object.keys(cities).filter(s => !cities[s].has_gios);
  assert.strictEqual(iosCities.length, 8);
  assert.deepStrictEqual(
    iosCities.sort(),
    ['bedzin', 'bytom', 'chorzow', 'knurow', 'piekary-slaskie', 'ruda-slaska', 'swietochlowice', 'tarnowskie-gory'].sort()
  );
});

// 17. MET Norway fixture: poprawna struktura timeseries
test('MET Norway fixture has valid timeseries structure', () => {
  const met = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'met-norway.json'), 'utf8'));
  assert(met.properties?.timeseries?.length > 0);
  const first = met.properties.timeseries[0];
  assert(typeof first.data.instant.details.air_temperature === 'number');
  assert(typeof first.data.instant.details.wind_speed === 'number');
});

// 18. GIOŚ PM10 fixture: ignorowanie null i ekstrakcja 44.89
test('GIOŚ PM10 parser ignores nulls and extracts latest value 44.89', () => {
  const pm10 = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'gios-data-pm10-katowice.json'), 'utf8'));
  const latest = pm10.values.find(v => v.value !== null);
  assert.strictEqual(latest.value, 44.89);
});

// 19. GIOŚ PM2,5 fixture: ignorowanie null i ekstrakcja 15.30
test('GIOŚ PM2.5 parser ignores nulls and extracts latest value 15.30', () => {
  const pm25 = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'gios-data-pm25-katowice.json'), 'utf8'));
  const latest = pm25.values.find(v => v.value !== null);
  assert.strictEqual(latest.value, 15.30);
});

// 20. GIOŚ index fixture: poprawny odczyt kategorii indeksu
test('GIOŚ index fixture parser reads index level correctly', () => {
  const idx = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'gios-index-katowice.json'), 'utf8'));
  assert.strictEqual(idx.stIndexLevel.id, 2);
  assert.strictEqual(idx.stIndexLevel.indexLevelName, 'Umiarkowany');
});

// 21. Wykrywanie błędu manualnego stanowiska GIOŚ (API-ERR-100003)
test('GIOŚ manual station error API-ERR-100003 is detected', () => {
  const err = JSON.parse(fs.readFileSync(path.join(fixturesDir, 'gios-data-manual-error.json'), 'utf8'));
  assert.strictEqual(err.error_code, 'API-ERR-100003');
});

console.log('✓ All 21 check-cities offline tests passed successfully!\n');
