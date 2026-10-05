/*!
 * MO Weather Widget v1.0.0 — Web Component <mo-weather>
 * Shadow DOM (izolacja CSS), inline SVG (zero requestów), theming przez CSS vars.
 * Bezpieczeństwo: dane z API wstrzykane WYŁĄCZNIE przez textContent (zero innerHTML z payloadu).
 * Fallbacki: backend stale => badge; backend martwy => mirror z localStorage; brak danych => dyskretny komunikat.
 */
(function () {
  'use strict';

  var REFRESH_MS = 15 * 60 * 1000; // odświeżanie co 15 min
  var LS_PREFIX  = 'mo-weather:v1:';
  var instances  = [];

  /* Ikony: statyczne SVG (bezpieczne do innerHTML — nie pochodzą z API) */
  var ICONS = {
    sun:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    partly: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 2v1.5M2 8h1.5M3.8 3.8l1 1M12.2 3.8l-1 1"/><path d="M17 18a4 4 0 0 0 0-8 5.5 5.5 0 0 0-10.6 1.6A3.5 3.5 0 0 0 7 18z"/></svg>',
    cloud:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.5 19a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.7A4 4 0 0 0 6.5 19z"/></svg>',
    fog:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.5 15a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.7A4 4 0 0 0 6.5 15z"/><path d="M4 19h16M6 22h12"/></svg>',
    rain:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.5 15a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.7A4 4 0 0 0 6.5 15z"/><path d="M8 18v2M12 18v3M16 18v2"/></svg>',
    snow:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.5 15a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.7A4 4 0 0 0 6.5 15z"/><path d="M8 19h.01M12 21h.01M16 19h.01M10 22h.01M14 17h.01"/></svg>',
    storm:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.5 13a4.5 4.5 0 0 0 0-9 6 6 0 0 0-11.6 1.7A4 4 0 0 0 6.5 13z"/><path d="M13 14l-3 5h4l-3 5"/></svg>'
  };

  /* Mapowanie kodów WMO (Open-Meteo) na ikony i polskie etykiety */
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
    '.wrap{min-height:96px;}',
    '.row{display:flex;gap:12px;overflow-x:auto;scroll-snap-type:x mandatory;-webkit-overflow-scrolling:touch;padding:2px;}',
    '.card{flex:0 0 auto;scroll-snap-align:start;min-width:150px;background:var(--mo-card,#fff);color:var(--mo-text,#1a1a1a);',
    'border:1px solid var(--mo-border,#e5e5e5);border-radius:var(--mo-radius,12px);padding:12px 14px;box-sizing:border-box;}',
    '.city{font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--mo-muted,#666);margin:0 0 6px;}',
    '.main{display:flex;align-items:center;gap:10px;}',
    '.ico{width:36px;height:36px;color:var(--mo-accent,#0b63ce);flex:0 0 auto;}',
    '.ico svg{width:100%;height:100%;display:block;}',
    '.temp{font-size:28px;font-weight:700;line-height:1;margin:0;}',
    '.desc{font-size:13px;color:var(--mo-muted,#666);margin:6px 0 0;}',
    '.meta{font-size:12px;color:var(--mo-muted,#666);margin:6px 0 0;}',
    '.stale{display:inline-block;margin-top:8px;font-size:11px;color:#8a5a00;background:#fff4d6;border:1px solid #f0d896;',
    'border-radius:999px;padding:2px 8px;}',
    '.foot{margin:8px 2px 0;font-size:10px;color:var(--mo-muted,#999);}',
    '.foot a{color:inherit;}',
    '.skel{height:96px;border-radius:var(--mo-radius,12px);background:linear-gradient(90deg,#eee 25%,#f7f7f7 50%,#eee 75%);',
    'background-size:200% 100%;animation:mo-sh 1.2s infinite;}',
    '@keyframes mo-sh{to{background-position:-200% 0;}}',
    '@media (prefers-reduced-motion:reduce){.skel{animation:none;}}',
    '.err{font-size:13px;color:var(--mo-muted,#666);padding:12px;}'
  ].join('\n');

  class MoWeather extends HTMLElement {
    static get observedAttributes() { return ['mode', 'city-id', 'cities', 'api-url']; }

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

    refresh() {
      var self = this;
      var api = this.getAttribute('api-url');
      this._root.textContent = '';
      if (!api) { this._root.appendChild(el('div', 'err', 'mo-weather: brak atrybutu api-url.')); return; }
      this._root.appendChild(el('div', 'skel')); // skeleton => zero CLS

      var cities = this._cities();
      Promise.allSettled(cities.map(function (c) { return self._fetchCity(api, c); }))
        .then(function (results) { self._render(cities, results); });
    }

    _fetchCity(api, city) {
      var ctrl = new AbortController();
      var t = setTimeout(function () { ctrl.abort(); }, 10000);
      return fetch(api + '?city=' + encodeURIComponent(city), { signal: ctrl.signal })
        .then(function (r) {
          clearTimeout(t);
          if (!r.ok) throw new Error('http ' + r.status);
          return r.json();
        })
        .then(function (data) { lsSet(city, data); return data; })
        .catch(function () {
          clearTimeout(t);
          var cached = lsGet(city); // drugi poziom cache: backend martwy => localStorage
          if (cached) { cached.is_stale = true; cached.cache = 'local'; return cached; }
          throw new Error('no-data:' + city);
        });
    }

    _render(cities, results) {
      var self = this;
      if (this._ticker) {
        clearInterval(this._ticker);
        this._ticker = null;
      }
      this._root.textContent = '';
      var row = el('div', 'row');
      var any = false;

      results.forEach(function (res, i) {
        if (res.status !== 'fulfilled') {
          var e = el('div', 'card'); e.appendChild(el('p', 'err', 'Pogoda chwilowo niedostępna'));
          row.appendChild(e); return;
        }
        any = true;
        row.appendChild(self._card(res.value));
      });

      this._root.appendChild(row);
      var foot = el('p', 'foot');
      foot.appendChild(document.createTextNode('Dane: '));
      var a = el('a', null, 'Open-Meteo.com'); // atrybucja CC-BY 4.0 — wymóg licencji
      a.href = 'https://open-meteo.com/'; a.target = '_blank'; a.rel = 'noopener noreferrer';
      foot.appendChild(a);
      this._root.appendChild(foot);

      if (any) {
        this._ticker = setInterval(function () { self._tick(); }, 60000);
        this._tick();
      }
    }

    _card(d) {
      var m = wmo(d.weather_code || 0);
      var card = el('article', 'card');
      card.setAttribute('role', 'group');
      card.setAttribute('aria-label', 'Pogoda: ' + (d.label || d.city));

      card.appendChild(el('h3', 'city', d.label || d.city));

      var main = el('div', 'main');
      var ico = el('span', 'ico');
      ico.innerHTML = ICONS[m[0]]; // statyczne SVG, nie dane z API => bezpieczne
      ico.setAttribute('role', 'img');
      ico.setAttribute('aria-label', m[1]);
      main.appendChild(ico);
      main.appendChild(el('p', 'temp', (d.temperature != null ? d.temperature + '°C' : '—')));
      card.appendChild(main);

      card.appendChild(el('p', 'desc', m[1]));
      card.appendChild(el('p', 'meta',
        '↑ ' + (d.temp_max != null ? d.temp_max + '°' : '—') +
        ' ↓ ' + (d.temp_min != null ? d.temp_min + '°' : '—') +
        ' · wiatr ' + (d.wind_speed != null ? d.wind_speed + ' km/h' : '—')));

      if (d.is_stale && d.last_updated_timestamp) {
        var b = el('span', 'stale');
        b.dataset.ts = String(d.last_updated_timestamp);
        b.textContent = 'Ostatnia aktualizacja: ' + relTime(d.last_updated_timestamp);
        card.appendChild(b);
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
