/*!
 * MO Weather Widget v2.0.0 — Web Component <mo-weather>
 * Shadow DOM (izolacja CSS), inline SVG (zero requestów), theming przez CSS vars.
 * Bezpieczeństwo: dane z API wstrzykane WYŁĄCZNIE przez textContent (zero innerHTML z payloadu).
 * Dostępność (a11y): WCAG AA kontrast atrybucji (>= 4.5:1), role="region" w karuzeli aggregator, role="group" per karta.
 * Wydajność: skeleton 170px i min-height: 170px eliminują Cumulative Layout Shift (CLS = 0).
 * Moduły: current (domyślny), air (GIOŚ/IOŚ), daily7 (prognoza 7 dni), nowcast (alert opadów MET Norway).
 * Fallbacki: backend stale => badge; backend martwy => mirror z localStorage; brak danych => dyskretny komunikat.
 */
(function () {
  'use strict';

  var REFRESH_MS = 15 * 60 * 1000; // odświeżanie co 15 min
  var LS_PREFIX  = 'mo-weather:v2:';
  var instances  = [];

  // P1.8: Migracja kluczy localStorage v1 -> v2 (usunięcie pozostałości mo-weather:v1:*)
  try {
    for (var lsi = localStorage.length - 1; lsi >= 0; lsi--) {
      var lsk = localStorage.key(lsi);
      if (lsk && lsk.indexOf('mo-weather:v1:') === 0) {
        localStorage.removeItem(lsk);
      }
    }
  } catch (e) {}

  /* Ikony: statyczne SVG (bezpieczne do innerHTML — nie pochodzą z API) */
  var ICONS = {
    sun:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    partly:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 2v1.5M2 8h1.5M3.8 3.8l1 1M12.2 3.8l-1 1"/><path d="M17 18a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.6 1.6A3.5 3.5 0 0 0 7 18z"/></svg>',
    cloud:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.7A4 4 0 0 0 6.5 19z"/></svg>',
    fog:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.5 15a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.7A4 4 0 0 0 6.5 15z"/><path d="M4 19h16M6 22h12"/></svg>',
    rain:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.5 15a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.7A4 4 0 0 0 6.5 15z"/><path d="M8 18v2M12 18v3M16 18v2"/></svg>',
    snow:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.5 15a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.7A4 4 0 0 0 6.5 15z"/><path d="M8 19h.01M12 21h.01M16 19h.01M10 22h.01M14 17h.01"/></svg>',
    storm:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.5 13a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.7A4 4 0 0 0 6.5 13z"/><path d="M13 14l-3 5h4l-3 5"/></svg>',
    drop:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/></svg>',
    leaf:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/></svg>'
  };

  /* Mapowanie kodów WMO na ikony i polskie etykiety */
  function wmo(code) {
    if (code === 0)  return ['sun', 'Bezchmurnie'];
    if (code <= 2)   return ['partly', 'Częściowe zachmurzenie'];
    if (code === 3)  return ['cloud', 'Pochmurno'];
    if (code <= 48)  return ['fog', 'Mgła'];
    if (code <= 57)  return ['rain', 'Mżawka'];
    if (code <= 67)  return ['rain', 'Deszcz'];
    if (code <= 77)  return ['snow', 'Śnieg'];
    if (code <= 82)  return ['rain', 'Deszcz przelotny'];
    if (code <= 86)  return ['snow', 'Śnieg przelotny'];
    return ['storm', 'Burza'];
  }

  /* Kolory i kategorie indeksu jakości powietrza (WCAG AA kontrast >= 4.5:1) */
  function aqiStyle(idx) {
    switch (idx) {
      case 1: return { bg: '#e6f4ea', text: '#137333', label: 'Bardzo dobry' };
      case 2: return { bg: '#edf7ed', text: '#1e4620', label: 'Dobry' };
      case 3: return { bg: '#fef7e0', text: '#7a5200', label: 'Umiarkowany' };
      case 4: return { bg: '#feefe3', text: '#a53b00', label: 'Dostateczny' };
      case 5: return { bg: '#fce8e6', text: '#c5221f', label: 'Zły' };
      case 6: return { bg: '#f3e8fd', text: '#7627bb', label: 'Bardzo zły' };
      default: return { bg: '#f1f3f4', text: '#3c4043', label: 'Brak danych' };
    }
  }

  function relTime(ts) {
    var min = Math.max(0, Math.round((Date.now() - ts * 1000) / 60000));
    if (min < 1)   return 'przed chwilą';
    if (min < 60)  return min + ' min temu';
    return Math.round(min / 60) + ' godz. temu';
  }

  function lsGet(key) { try { return JSON.parse(localStorage.getItem(LS_PREFIX + key)); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(LS_PREFIX + key, JSON.stringify(val)); } catch (e) {} }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text; // BEZPIECZEŃSTWO: tylko textContent dla danych
    return n;
  }

  var CSS = [
    ':host{display:block;contain:content;font-family:var(--mo-font,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);}',
    '.wrap{min-height:170px;}',
    '.row{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;padding:2px;}',
    '.card{flex:0 0 auto;scroll-snap-align:start;min-width:170px;background:var(--mo-card,#fff);color:var(--mo-text,#1a1a1a);',
    'border:1px solid var(--mo-border,#e5e5e5);border-radius:var(--mo-radius,12px);padding:14px;box-sizing:border-box;}',
    '.city{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--mo-muted,#666);margin:0 0 6px;}',
    '.main{display:flex;align-items:center;gap:10px;}',
    '.ico{width:36px;height:36px;color:var(--mo-accent,#0b63ce);flex:0 0 auto;}',
    '.ico svg{width:100%;height:100%;display:block;}',
    '.temp{font-size:28px;font-weight:700;line-height:1;margin:0;}',
    '.desc{font-size:13px;color:var(--mo-muted,#666);margin:6px 0 0;}',
    '.meta{font-size:12px;color:var(--mo-muted,#666);margin:6px 0 0;}',
    '.stale{display:inline-block;margin-top:8px;font-size:11px;color:var(--mo-stale-text,#8a5a00);background:var(--mo-stale-bg,#fff4d6);border:1px solid var(--mo-stale-border,#f0d896);',
    'border-radius:999px;padding:2px 8px;}',
    
    '/* Sekcja alertu opadów nowcast */',
    '.nowcast{margin:8px 0 0;padding:6px 10px;border-radius:8px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:6px;}',
    '.nowcast-active{background:var(--mo-nowcast-active-bg,#e8f0fe);color:var(--mo-nowcast-active-text,#174ea6);border:1px solid var(--mo-nowcast-active-border,#d2e3fc);}',
    '.nowcast-none{background:var(--mo-bg-sub,#f8f9fa);color:var(--mo-muted,#5f6368);border:1px solid var(--mo-border,#e8eaed);}',
    '.nowcast .ico-s{width:16px;height:16px;flex:0 0 auto;}',
    '.nowcast .ico-s svg{width:100%;height:100%;display:block;}',

    '/* Sekcja jakości powietrza */',
    '.air-box{margin-top:10px;padding-top:8px;border-top:1px solid var(--mo-border,#eee);font-size:12px;}',
    '.air-badge{display:inline-block;padding:3px 8px;border-radius:6px;font-weight:600;font-size:11px;letter-spacing:.02em;}',
    '.air-badge-1{background:var(--mo-aqi1-bg,#e6f4ea)!important;color:var(--mo-aqi1-text,#137333)!important;}',
    '.air-badge-2{background:var(--mo-aqi2-bg,#edf7ed)!important;color:var(--mo-aqi2-text,#1e4620)!important;}',
    '.air-badge-3{background:var(--mo-aqi3-bg,#fef7e0)!important;color:var(--mo-aqi3-text,#b06000)!important;}',
    '.air-badge-4{background:var(--mo-aqi4-bg,#feefe3)!important;color:var(--mo-aqi4-text,#a53b00)!important;}',
    '.air-badge-5{background:var(--mo-aqi5-bg,#fce8e6)!important;color:var(--mo-aqi5-text,#c5221f)!important;}',
    '.air-badge-6{background:var(--mo-aqi6-bg,#f3e8fd)!important;color:var(--mo-aqi6-text,#7627bb)!important;}',
    '.air-badge-0{background:var(--mo-aqi0-bg,#f1f3f4)!important;color:var(--mo-aqi0-text,#3c4043)!important;}',
    '.air-stats{margin:6px 0 0;color:var(--mo-text,#1a1a1a);font-size:12px;display:flex;align-items:center;flex-wrap:wrap;gap:4px;}',
    '.air-sub{font-size:11px;color:var(--mo-muted,#666);margin:4px 0 0;}',
    '.air-advice{font-size:11px;line-height:1.35;color:var(--mo-text,#1a1a1a);margin:6px 0 0;padding:6px 8px;background:var(--mo-bg-sub,#f9f9f9);border-radius:6px;border-left:3px solid var(--mo-accent,#0b63ce);}',

    '/* Sekcja prognozy 7 dni */',
    '.daily-wrap{margin-top:12px;padding-top:10px;border-top:1px solid var(--mo-border,#eee);}',
    '.daily-title{font-size:11px;font-weight:600;text-transform:uppercase;color:var(--mo-muted,#666);margin:0 0 6px;}',
    '.daily-grid{display:flex;gap:8px;overflow-x:auto;-webkit-overflow-scrolling:touch;}',
    '.daily-col{flex:1 0 42px;text-align:center;font-size:11px;padding:4px 2px;background:var(--mo-bg-sub,#f9f9f9);border-radius:6px;}',
    '.daily-day{font-weight:600;color:var(--mo-text,#1a1a1a);}',
    '.daily-ico{width:20px;height:20px;margin:2px auto;color:var(--mo-accent,#0b63ce);}',
    '.daily-ico svg{width:100%;height:100%;display:block;}',
    '.daily-temp{font-size:11px;color:var(--mo-text,#1a1a1a);}',
    '.daily-min{color:var(--mo-muted,#666);font-size:10px;}',

    '.foot{margin:8px 2px 0;font-size:11px;color:var(--mo-foot,#595959);}',
    '.foot a{color:inherit;text-decoration:underline;}',
    '.skel{height:170px;border-radius:var(--mo-radius,12px);background:linear-gradient(90deg,#eee 25%,#f7f7f7 50%,#eee 75%);',
    'background-size:200% 100%;animation:mo-sh 1.2s infinite;}',
    '@keyframes mo-sh{to{background-position:-200% 0;}}',
    '@media (prefers-reduced-motion:reduce){.skel{animation:none;} .nowcast{animation:none;}}',
    '.err{font-size:13px;color:var(--mo-muted,#666);padding:12px;}'
  ].join('\n');

  class MoWeather extends HTMLElement {
    static get observedAttributes() { return ['mode', 'city-id', 'cities', 'api-url', 'modules']; }

    connectedCallback() {
      if (!this.shadowRoot) {
        this.attachShadow({ mode: 'open' });
        var s = document.createElement('style'); s.textContent = CSS;
        this.shadowRoot.appendChild(s);
        this._root = el('div', 'wrap');
        this.shadowRoot.appendChild(this._root);
      }
      instances.push(this);
      this.refresh();
    }
    disconnectedCallback() {
      if (this._ticker) {
        clearInterval(this._ticker);
        this._ticker = null;
      }
      instances = instances.filter(function (i) { return i !== this; }, this);
    }
    attributeChangedCallback() { if (this.shadowRoot) this.refresh(); }

    _cities() {
      if ((this.getAttribute('mode') || 'single') === 'aggregator') {
        var list = (this.getAttribute('cities') || this.getAttribute('city-id') || '')
          .split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
        return list.length ? list : ['katowice'];
      }
      return [this.getAttribute('city-id') || 'katowice'];
    }

    _modules() {
      var m = this.getAttribute('modules');
      if (!m) return ['current'];
      var parts = m.split(',').map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
      return parts.length ? parts : ['current'];
    }

    refresh() {
      var self = this;
      var api = this.getAttribute('api-url');
      this._root.textContent = '';
      if (!api) { this._root.appendChild(el('div', 'err', 'mo-weather: brak atrybutu api-url.')); return; }
      this._root.appendChild(el('div', 'skel')); // skeleton => zero CLS

      var cities = this._cities();
      var modules = this._modules();

      Promise.allSettled(cities.map(function (c) { return self._fetchCityModules(api, c, modules); }))
        .then(function (results) { self._render(cities, modules, results); });
    }

    _fetchCityModules(api, city, modules) {
      var self = this;
      var tasks = modules.map(function (mod) {
        return self._fetchEndpoint(api, city, mod);
      });
      return Promise.allSettled(tasks).then(function (res) {
        var bundle = { city: city };
        modules.forEach(function (mod, idx) {
          if (res[idx].status === 'fulfilled') {
            bundle[mod] = res[idx].value;
          } else {
            bundle[mod] = null;
          }
        });
        return bundle;
      });
    }

    _fetchEndpoint(api, city, type) {
      var ctrl = new AbortController();
      var t = setTimeout(function () { ctrl.abort(); }, 10000);
      var key = city + ':' + type;
      return fetch(api + '?city=' + encodeURIComponent(city) + '&type=' + encodeURIComponent(type), { signal: ctrl.signal })
        .then(function (r) {
          clearTimeout(t);
          if (!r.ok) throw new Error('http ' + r.status);
          return r.json();
        })
        .then(function (data) { lsSet(key, data); return data; })
        .catch(function () {
          clearTimeout(t);
          var cached = lsGet(key);
          if (cached) { cached.is_stale = true; cached.cache = 'local'; return cached; }
          throw new Error('no-data:' + key);
        });
    }

    _render(cities, modules, results) {
      var self = this;
      if (this._ticker) {
        clearInterval(this._ticker);
        this._ticker = null;
      }
      this._root.textContent = '';
      var row = el('div', 'row');
      if ((this.getAttribute('mode') || 'single') === 'aggregator') {
        row.setAttribute('role', 'region');
        row.setAttribute('aria-label', 'Prognoza pogody dla wybranych miast');
        row.setAttribute('tabindex', '0');
      }
      var any = false;

      results.forEach(function (res) {
        if (res.status !== 'fulfilled' || !res.value) {
          var e = el('div', 'card'); e.appendChild(el('p', 'err', 'Pogoda chwilowo niedostępna'));
          row.appendChild(e); return;
        }
        any = true;
        row.appendChild(self._card(res.value, modules));
      });

      this._root.appendChild(row);

      // Stopka z atrybucją (WCAG AA kontrast >= 4.5:1, dynamiczna per aktywne moduły - P1.10)
      var foot = el('p', 'foot');
      foot.appendChild(document.createTextNode('Dane: '));
      var hasMet = modules.indexOf('current') !== -1 || modules.indexOf('daily7') !== -1 || modules.indexOf('nowcast') !== -1;
      var hasAir = modules.indexOf('air') !== -1;
      var added = false;

      if (hasMet) {
        var aMet = el('a', null, 'MET Norway');
        aMet.href = 'https://www.met.no/'; aMet.target = '_blank'; aMet.rel = 'noopener noreferrer';
        foot.appendChild(aMet);
        added = true;
      }

      if (hasAir) {
        if (added) foot.appendChild(document.createTextNode(' · '));
        var aGios = el('a', null, 'GIOŚ');
        aGios.href = 'https://powietrze.gios.gov.pl/'; aGios.target = '_blank'; aGios.rel = 'noopener noreferrer';
        foot.appendChild(aGios);
        foot.appendChild(document.createTextNode(' / '));
        var aIos = el('a', null, 'IOŚ-PIB');
        aIos.href = 'https://ios.edu.pl/'; aIos.target = '_blank'; aIos.rel = 'noopener noreferrer';
        foot.appendChild(aIos);
      }

      this._root.appendChild(foot);

      if (any) {
        this._ticker = setInterval(function () { self._tick(); }, 60000);
        this._tick();
      }
    }

    _card(bundle, modules) {
      var d = bundle.current || bundle.daily7 || bundle.air || bundle.nowcast || {};
      var cityName = d.label || bundle.city;

      var card = el('article', 'card');
      card.setAttribute('role', 'group');
      card.setAttribute('aria-label', 'Pogoda: ' + cityName);

      card.appendChild(el('h3', 'city', cityName));

      // 1. Moduł Alert opadów (nowcast)
      if (bundle.nowcast && bundle.nowcast.alert) {
        var al = bundle.nowcast.alert;
        var nowcastBox = el('div', 'nowcast ' + (al.active ? 'nowcast-active' : 'nowcast-none'));
        nowcastBox.setAttribute('role', 'status');
        nowcastBox.setAttribute('aria-live', 'polite');
        var dropIco = el('span', 'ico-s');
        dropIco.innerHTML = ICONS.drop;
        nowcastBox.appendChild(dropIco);
        nowcastBox.appendChild(el('span', null, al.text));
        card.appendChild(nowcastBox);
      }

      // 2. Moduł Pogoda bieżąca (current)
      if (bundle.current) {
        var cur = bundle.current;
        var m = wmo(cur.weather_code || 0);
        var main = el('div', 'main');
        var ico = el('span', 'ico');
        ico.innerHTML = ICONS[m[0]] || ICONS.cloud;
        ico.setAttribute('role', 'img');
        ico.setAttribute('aria-label', m[1]);
        main.appendChild(ico);
        main.appendChild(el('p', 'temp', (cur.temperature != null ? cur.temperature + '°C' : '—')));
        card.appendChild(main);

        card.appendChild(el('p', 'desc', m[1]));
        card.appendChild(el('p', 'meta',
          '↑ ' + (cur.temp_max != null ? cur.temp_max + '°' : '—') +
          ' ↓ ' + (cur.temp_min != null ? cur.temp_min + '°' : '—') +
          ' · wiatr ' + (cur.wind_speed != null ? cur.wind_speed + ' km/h' : '—')));

        if (cur.is_stale && cur.last_updated_timestamp) {
          var b = el('span', 'stale');
          b.dataset.ts = String(cur.last_updated_timestamp);
          b.textContent = 'Ostatnia aktualizacja: ' + relTime(cur.last_updated_timestamp);
          card.appendChild(b);
        }
      }

      // 3. Moduł Jakość powietrza (air)
      if (bundle.air) {
        var air = bundle.air;
        var airBox = el('div', 'air-box');
        var meas = air.measurement || {};
        var fcast = air.forecast || {};

        var isMeas = Boolean(meas.available);
        var catIdx = isMeas ? (meas.category_index || 0) : (fcast.category_index || 0);
        var catName = isMeas ? (meas.category || 'Brak') : (fcast.category || 'Prognoza');
        var style = aqiStyle(catIdx);

        // Badge EEA: np. "Powietrze umiarkowane (AQI 2)" lub "Prognoza: umiarkowane (AQI 2)"
        var badgeText = '';
        if (isMeas && catName && catName !== 'Brak indeksu' && catName !== 'Brak') {
          badgeText = 'Powietrze ' + catName.toLowerCase() + (catIdx ? ' (AQI ' + catIdx + ')' : '');
        } else if (!isMeas && fcast.category) {
          badgeText = 'Prognoza: ' + fcast.category.toLowerCase() + (catIdx ? ' (AQI ' + catIdx + ')' : '');
        } else {
          badgeText = catName;
        }

        var badge = el('span', 'air-badge air-badge-' + catIdx, badgeText);
        badge.style.backgroundColor = style.bg;
        badge.style.color = style.text;
        airBox.appendChild(badge);

        // Zanieczyszczenia: PM10 oraz PM2,5
        var p10Val = (isMeas && meas.pollutants && meas.pollutants.pm10 && meas.pollutants.pm10.value != null)
          ? meas.pollutants.pm10.value + ' µg/m³'
          : (!isMeas && fcast.days && fcast.days[0] && fcast.days[0].pm10 != null
              ? fcast.days[0].pm10 + ' µg/m³ (prognoza)'
              : 'b.d.');

        // PM2,5: Katowice to jedyna stacja z PM2,5 w sieci; dla pozostałych miast: "niedostępny"
        var p25Val;
        if (isMeas && meas.pollutants && meas.pollutants.pm25 && meas.pollutants.pm25.value != null) {
          p25Val = meas.pollutants.pm25.value + ' µg/m³';
        } else if (bundle.city === 'katowice' && isMeas) {
          p25Val = 'b.d.';
        } else {
          p25Val = 'niedostępny';
        }

        var stats = el('div', 'air-stats');
        if (p25Val !== 'niedostępny') {
          stats.appendChild(el('span', null, 'PM2,5: ' + p25Val));
          stats.appendChild(document.createTextNode(' · '));
          stats.appendChild(el('span', null, 'PM10: ' + p10Val));
        } else {
          stats.appendChild(el('span', null, 'PM10: ' + p10Val));
          stats.appendChild(document.createTextNode(' · '));
          stats.appendChild(el('span', null, 'PM2,5: ' + p25Val));
        }
        airBox.appendChild(stats);

        // Etykieta źródła / statusu degradacji
        var sourceLabel = meas.label || (isMeas ? ('Pomiar ze stacji GIOŚ' + (meas.station_name ? ' (' + meas.station_name + ')' : '')) : (fcast.label || 'Prognoza jakości powietrza IOŚ-PIB'));
        airBox.appendChild(el('p', 'air-sub', sourceLabel));

        // Zdrowotna porada EEA
        var adviceText = isMeas ? meas.advice : fcast.advice;
        if (adviceText) {
          var adviceBox = el('p', 'air-advice', adviceText);
          airBox.appendChild(adviceBox);
        }

        card.appendChild(airBox);
      }

      // 4. Moduł Prognoza 7 dni (daily7)
      if (bundle.daily7 && bundle.daily7.days && bundle.daily7.days.length) {
        var dWrap = el('div', 'daily-wrap');
        dWrap.appendChild(el('p', 'daily-title', 'Prognoza 7 dni'));
        var grid = el('div', 'daily-grid');

        bundle.daily7.days.forEach(function (day) {
          var col = el('div', 'daily-col');
          col.appendChild(el('div', 'daily-day', day.weekday_label));
          var dIcon = el('div', 'daily-ico');
          var dM = wmo(day.weather_code || 0);
          dIcon.innerHTML = ICONS[dM[0]] || ICONS.cloud;
          col.appendChild(dIcon);
          col.appendChild(el('div', 'daily-temp', day.temp_max + '°'));
          col.appendChild(el('div', 'daily-min', day.temp_min + '°'));
          grid.appendChild(col);
        });

        dWrap.appendChild(grid);
        card.appendChild(dWrap);
      }

      return card;
    }

    _tick() {
      var badges = this.shadowRoot.querySelectorAll('.stale[data-ts]');
      badges.forEach(function (b) {
        b.textContent = 'Ostatnia aktualizacja: ' + relTime(parseInt(b.dataset.ts, 10));
      });
    }
  }

  customElements.define('mo-weather', MoWeather);

  /* Odświeżanie globalne: co 15 min + przy powrocie do karty (visibilitychange) */
  function refreshAll() { instances.forEach(function (i) { i.refresh(); }); }
  setInterval(refreshAll, REFRESH_MS);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) refreshAll();
  });
})();
