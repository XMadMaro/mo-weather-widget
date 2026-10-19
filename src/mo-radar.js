/*
 * MO Weather Widget: okno radaru burzowego (moduł ładowany dopiero po kliknięciu „Radar burzowy”).
 * scripts/build.sh skleja go z podkładem src/mo-radar-basemap.js i matematyką src/mo-radar-map.js
 * do dist/mo-radar(.min).js. Udostępnia window.MoWeatherRadar.open({root, url, city, cityName, trigger}).
 *
 * Mapa: kafelki Web Mercator (OSM / CARTO) + klatka radaru w tej samej projekcji — radar leży
 * na mapie co do piksela. Dwa widoki: „Województwo” (cały obszar Śląska) i „Miasto” (miasto
 * przypisane do portalu, np. Bytom na bytomski.pl). Bez kafelków (brak sieci) działa podkład
 * wektorowy z granicami powiatów.
 *
 * Animacja: klatki OPERA co 5 min są interpolowane do kroku 1 min (mieszanie z kompensacją
 * ruchu wyliczoną z korelacji kolejnych klatek), a po ostatniej klatce działa ekstrapolacja
 * ruchu chmur na 30 min w przód (osobno oznaczona jako PROGNOZA).
 *
 * Bezpieczeństwo: tekst wyłącznie przez textContent, SVG przez createElementNS (zero parsowania HTML).
 * Dane: /api/radar?manifest (lista klatek) i /api/radar?frame=T (PNG w EPSG:3857, bbox jak podkład).
 */
(function () {
  'use strict';
  if (window.MoWeatherRadar) return;

  var M = typeof MO_RADAR_MAP !== 'undefined' ? MO_RADAR_MAP : null;
  var BASE = typeof MO_RADAR_BASEMAP !== 'undefined' ? MO_RADAR_BASEMAP : null;
  var NS = 'http://www.w3.org/2000/svg';
  var MIN_ZOOM = 4.5, MAX_ZOOM = 17;
  var TILE_MIN_Z = 5, TILE_MAX_Z = 17;
  var FORECAST_MIN = 30;      // horyzont prognozy ruchu chmur (min)
  var TICK_MS = 110;          // 1 minuta radaru na klatkę animacji
  var FIELD_DIV = 4;          // skala pola ruchu (1/4 rozmiaru klatki)
  var MOTION_MAX = 4;         // maks. przesunięcie w polu (piksele pola)
  var CITY_ZOOM = 12;         // poziom powiększenia dla widoku „Miasto” (~17 km szerokości)
  var POLL_MS = 120000;
  var MAX_TILES = 240;
  var PROVIDERS = [
    { url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png', sub: ['a', 'b', 'c', 'd'], attribution: '© OpenStreetMap contributors © CARTO' },
    { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', sub: [''], attribution: '© OpenStreetMap contributors' }
  ];
  var LEGEND = [
    ['słaby', '10–25 dBZ', '#a0dcff,#5aafff,#2378f5'],
    ['umiarkowany', '25–35 dBZ', '#19b946,#0f8728'],
    ['silny', '35–45 dBZ', '#fae100,#ffa500'],
    ['bardzo silny / burza', '45–55 dBZ', '#ff5500,#e10000'],
    ['możliwy grad', '55+ dBZ', '#a00032,#e100e1,#fff'],
    ['brak pokrycia', 'obszar poza zasięgiem radarów', 'rgba(128,128,128,.35),rgba(128,128,128,.35)']
  ];
  var LINKS = [
    ['Radar: ', 'EUMETNET OPERA', 'https://www.eumetnet.eu/observations/weather-radar-network/'],
    [' (', 'CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/deed.pl'],
    ['), dane przetworzone · Granice: ', 'PRG/GUGiK', 'https://www.geoportal.gov.pl/']
  ];
  var ICON_PLAY = 'M8 5v14l11-7z', ICON_PAUSE = 'M7 5h4v14H7zM13 5h4v14h-4z';

  var CSS = [
    '.rd{width:min(1180px,calc(100vw - 16px));max-width:100vw;height:min(88vh,860px);max-height:calc(100vh - 16px);',
    'padding:0;border:0;border-radius:var(--mo-radius,14px);background:var(--mo-card,#fff);color:var(--mo-text,#1a1a1a);',
    'box-shadow:0 20px 60px rgba(0,0,0,.35);font:inherit;font-size:14px;overflow:hidden;}',
    '.rd[open]{display:flex;flex-direction:column;}',
    '.rd::backdrop{background:rgba(17,24,39,.55);}',
    '.rd:focus{outline:none;}',
    '.rd-head{display:flex;align-items:center;gap:8px 10px;flex-wrap:wrap;padding:10px 12px;flex:0 0 auto;}',
    '.rd-title{margin:0;font-size:17px;}',
    '.rd-badge{font-size:12px;font-weight:600;border-radius:999px;padding:2px 9px;background:#fff4d6;color:#7a4b00;border:1px solid #f0d896;}',
    '.rd-views{margin-left:auto;display:inline-flex;background:var(--mo-bg-sub,#f1f3f5);border-radius:999px;padding:2px;}',
    ':where(.rd) button{font:inherit;cursor:pointer;color:inherit;}',
    '.rd-views button{border:0;background:transparent;border-radius:999px;padding:5px 11px;font-size:13px;}',
    '.rd-views button[aria-pressed="true"]{background:var(--mo-text,#1a1a1a);color:var(--mo-card,#fff);}',
    '.rd-tools{display:inline-flex;gap:4px;}',
    '.rd-tools button{border:1px solid var(--mo-border,#e5e5e5);background:var(--mo-card,#fff);border-radius:8px;width:30px;height:30px;',
    'display:inline-flex;align-items:center;justify-content:center;font-size:15px;line-height:1;padding:0;}',
    '.rd-tools button:hover{border-color:var(--mo-accent,#0b63ce);}',
    '.rd-close{border:0;background:transparent;font-size:24px;line-height:1;padding:2px 8px;border-radius:6px;}',
    '.rd button:focus-visible,.rd input:focus-visible,.rd a:focus-visible,.rd-map:focus-visible{outline:2px solid var(--mo-accent,#0b63ce);outline-offset:2px;}',
    '.rd-map{position:relative;flex:1 1 auto;min-height:240px;background:#e7eaee;overflow:hidden;touch-action:none;cursor:grab;}',
    '.rd-map.dragging{cursor:grabbing;}',
    '.rd-map canvas,.rd-map svg{position:absolute;left:0;top:0;width:100%;height:100%;display:block;}',
    '.rd-vector{pointer-events:none;}',
    '.rd-hint{position:absolute;left:8px;bottom:8px;margin:0;font-size:11px;color:#334155;background:rgba(255,255,255,.82);',
    'border-radius:6px;padding:2px 7px;pointer-events:none;}',
    '.rd-msg{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);margin:0;max-width:80%;text-align:center;',
    'background:rgba(255,255,255,.94);color:#1a1a1a;border-radius:10px;padding:10px 14px;box-shadow:0 2px 10px rgba(0,0,0,.15);z-index:3;}',
    '.rd-msg:empty{display:none;}',
    '.rd-retry{display:block;margin:8px auto 0;border:1px solid #c9ced6;background:#fff;border-radius:999px;padding:4px 12px;}',
    '.rd-player{display:flex;align-items:center;gap:12px;padding:10px 12px 4px;flex:0 0 auto;}',
    '.rd-play{flex:0 0 auto;width:36px;height:36px;border-radius:50%;border:0;background:var(--mo-text,#1a1a1a);color:var(--mo-card,#fff);display:flex;align-items:center;justify-content:center;padding:0;}',
    '.rd-play svg{width:18px;height:18px;fill:currentColor;}',
    '.rd-play:disabled,.rd-range:disabled{opacity:.45;cursor:default;}',
    '.rd-track{flex:1;min-width:80px;display:flex;flex-direction:column;gap:3px;}',
    '.rd-range{width:100%;margin:0;accent-color:var(--mo-accent,#0b63ce);}',
    '.rd-split{display:flex;height:4px;border-radius:2px;overflow:hidden;background:var(--mo-bg-sub,#f1f3f5);}',
    '.rd-split i{display:block;height:100%;}',
    '.rd-split .obs{background:var(--mo-accent,#0b63ce);}',
    '.rd-split .fc{background:repeating-linear-gradient(90deg,#f59e0b 0 5px,transparent 5px 8px);}',
    '.rd-time{min-width:150px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums;}',
    '.rd-fc{display:none;font-size:11px;font-weight:700;color:#92400e;background:#fef3c7;border:1px solid #fcd34d;border-radius:999px;padding:1px 8px;}',
    '.rd-fc.on{display:inline-block;}',
    '.rd-legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin:0;padding:6px 12px;list-style:none;font-size:12.5px;flex:0 0 auto;}',
    '.rd-legend i{display:inline-block;width:22px;height:11px;border-radius:3px;margin-right:5px;vertical-align:-1px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.12);}',
    '.rd-foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 10px;margin:0;padding:4px 12px 12px;font-size:11.5px;color:var(--mo-foot,#595959);flex:0 0 auto;}',
    '.rd-foot a{color:inherit;}',
    '@media (max-width:560px){.rd{width:100vw;height:100vh;max-height:100vh;border-radius:0;}.rd-time{min-width:0;}.rd-hint{display:none;}}'
  ].join('\n');

  var fmtTime = new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', hour: '2-digit', minute: '2-digit' });
  var store = new WeakMap();
  var seq = 0;

  function tDate(t) {
    return new Date(Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(9, 11), +t.slice(11, 13)));
  }
  function minutesAgo(t) { return Math.max(0, Math.round((Date.now() - tDate(t).getTime()) / 60000)); }
  function reducedMotion() { return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); }

  function h(tag, cls, text, parent) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    if (parent) parent.appendChild(n);
    return n;
  }
  function s(tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  function btn(cls, text, parent) {
    var b = h('button', cls, text, parent);
    b.type = 'button';
    return b;
  }

  function Radar(root) {
    var self = this;
    this.frames = [];
    this.frameTimes = [];
    this.motion = {};
    this.fields = {};
    this.masked = {};
    this.maskedOrder = [];
    this.minute = 0;
    this.total = 0;
    this.spanMin = 0;
    this.t0 = 0;
    this.viewKey = '';
    this.baseKey = '';
    this.vectorKey = '';
    this.tileVersion = 0;
    this.mapMode = 'tiles';
    this.timer = null;
    this.poll = null;
    this.mode = 'region';
    this.view = { cx: 0, cy: 0, zoom: 7 };
    this.tiles = {};
    this.tileOrder = [];
    this.tileLoading = 0;
    this.tileQueue = [];
    this.tileErrors = 0;
    this.tilesOk = true;
    this.provider = 0;
    this.dpr = 1;
    this.vw = 0;
    this.vh = 0;
    this.bbox = [16.8, 48.9, 21.2, 51.6];
    this.bboxMerc = null;
    this.pointers = {};
    this.id = 'mo-radar-' + (++seq);

    var style = h('style');
    style.textContent = CSS;
    root.appendChild(style);

    var d = this.dialog = h('dialog', 'rd');
    d.setAttribute('aria-labelledby', this.id + '-t');
    d.tabIndex = -1; // fokus na samym oknie (czytnik ekranu odczyta tytuł), bez ramki na pierwszym przycisku
    var head = h('div', 'rd-head', null, d);
    h('h2', 'rd-title', 'Radar burzowy', head).id = this.id + '-t';
    this.badge = h('span', 'rd-badge', null, head);
    this.badge.hidden = true;
    var views = h('div', 'rd-views', null, head);
    views.setAttribute('role', 'group');
    views.setAttribute('aria-label', 'Widok mapy');
    this.btnRegion = btn('', 'Województwo', views);
    this.btnCity = btn('', '', views);
    this.btnRegion.addEventListener('click', function () { self.setView('region'); });
    this.btnCity.addEventListener('click', function () { self.setView('city'); });
    this.btnRegion.setAttribute('aria-pressed', 'true');
    this.btnCity.setAttribute('aria-pressed', 'false');
    var tools = h('div', 'rd-tools', null, head);
    tools.setAttribute('role', 'group');
    tools.setAttribute('aria-label', 'Sterowanie mapą');
    this.btnZoomIn = btn('', '+', tools);
    this.btnZoomIn.setAttribute('aria-label', 'Przybliż');
    this.btnZoomOut = btn('', '–', tools);
    this.btnZoomOut.setAttribute('aria-label', 'Oddal');
    this.btnReset = btn('', '⟲', tools);
    this.btnReset.setAttribute('aria-label', 'Przywróć widok całego województwa');
    this.btnFull = btn('', '⛶', tools);
    this.btnFull.setAttribute('aria-label', 'Pełny ekran');
    this.btnZoomIn.addEventListener('click', function () { self.zoomBy(1); });
    this.btnZoomOut.addEventListener('click', function () { self.zoomBy(-1); });
    this.btnReset.addEventListener('click', function () { self.setView(self.mode, true); });
    this.btnFull.addEventListener('click', function () { self.toggleFullscreen(); });
    var close = btn('rd-close', '×', head);
    close.setAttribute('aria-label', 'Zamknij radar');
    close.addEventListener('click', function () { d.close(); });

    var map = this.map = h('div', 'rd-map', null, d);
    map.setAttribute('tabindex', '0');
    map.setAttribute('role', 'application');
    map.setAttribute('aria-label', 'Mapa radaru opadów. Klawisze: strzałki przesuwają mapę, plus i minus zmieniają powiększenie.');
    this.base = h('canvas', 'rd-base', null, map);
    this.overlay = h('canvas', 'rd-overlay', null, map);
    this.svg = s('svg', { class: 'rd-vector', preserveAspectRatio: 'none', 'aria-hidden': 'true' }, map);
    this.hint = h('p', 'rd-hint', 'Przeciągnij mapę · kółko myszy = przybliżenie', map);
    this.msgEl = h('p', 'rd-msg', null, map);
    this.msgEl.setAttribute('role', 'status');

    var player = h('div', 'rd-player', null, d);
    this.btnPlay = btn('rd-play', null, player);
    this.playIcon = s('path', { d: ICON_PLAY }, s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' }, this.btnPlay));
    var track = h('div', 'rd-track', null, player);
    this.range = h('input', 'rd-range', null, track);
    this.range.type = 'range';
    this.range.min = '0';
    this.range.step = '1';
    this.range.setAttribute('aria-label', 'Czas klatki radaru (pomiar i prognoza ruchu)');
    var split = h('div', 'rd-split', null, track);
    h('i', 'obs', null, split);
    h('i', 'fc', null, split);
    this.splitObs = split.firstChild;
    this.splitFc = split.lastChild;
    this.timeEl = h('span', 'rd-time', '–', player);
    this.fcBadge = h('span', 'rd-fc', 'PROGNOZA', player);
    this.btnPlay.addEventListener('click', function () { self.play(!self.timer); });
    this.play(false);
    this.range.addEventListener('input', function () { self.play(false); self.showMinute(+self.range.value); });

    var legend = h('ul', 'rd-legend', null, d);
    legend.setAttribute('aria-label', 'Legenda: natężenie opadu');
    LEGEND.forEach(function (item) {
      var li = h('li', null, null, legend);
      li.title = item[1];
      var sw = h('i', null, null, li);
      sw.style.background = 'linear-gradient(90deg,' + item[2] + ')';
      li.appendChild(document.createTextNode(item[0]));
    });
    var foot = h('p', 'rd-foot', null, d);
    h('span', null, 'Radar opóźniony o ok. 5–10 min · pomarańczowa kreska osi = prognoza ruchu chmur', foot);
    var attr = h('span', null, null, foot);
    LINKS.forEach(function (l) {
      if (l[0]) attr.appendChild(document.createTextNode(l[0]));
      var a = h('a', null, l[1], attr);
      a.href = l[2];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    });
    this.mapAttr = h('span', null, '', foot);

    this.bindMap();
    d.addEventListener('close', function () {
      self.play(false);
      clearInterval(self.poll);
      self.poll = null;
      if (self.trigger && self.trigger.isConnected) self.trigger.focus();
    });
    // Kliknięcie w tło zamyka okno (współrzędne poza oknem, więc nie reaguje na pasek przewijania okna).
    d.addEventListener('click', function (e) {
      if (e.target !== d) return;
      var r = d.getBoundingClientRect();
      if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) d.close();
    });
    document.addEventListener('visibilitychange', function () { if (document.hidden) self.play(false); });
    window.addEventListener('resize', function () {
      if (!d.open) return;
      cancelAnimationFrame(self.rz);
      self.rz = requestAnimationFrame(function () { self.render(); });
    });
    root.appendChild(d);
  }

  /* ---------- gesty: zoom, przesuwanie, dwa palce ---------- */

  Radar.prototype.bindMap = function () {
    var self = this, map = this.map;
    map.addEventListener('wheel', function (e) {
      e.preventDefault();
      var r = map.getBoundingClientRect();
      var unit = e.deltaMode === 1 ? 16 : (e.deltaMode === 2 ? 400 : 1);
      self.zoomBy(-e.deltaY * unit / 400, e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    map.addEventListener('pointerdown', function (e) {
      map.setPointerCapture(e.pointerId);
      self.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      self.dragStart = null;
      if (Object.keys(self.pointers).length === 1) {
        self.dragStart = { x: e.clientX, y: e.clientY, cx: self.view.cx, cy: self.view.cy };
        map.classList.add('dragging');
      } else {
        self.dragStart = null;
        self.pinch = self.pinchState();
      }
    });
    map.addEventListener('pointermove', function (e) {
      if (!self.pointers[e.pointerId]) return;
      self.pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
      var ids = Object.keys(self.pointers);
      if (ids.length >= 2 && self.pinch) {
        var now = self.pinchState();
        if (now && self.pinch.dist > 0) {
          var r = map.getBoundingClientRect();
          self.zoomBy(Math.log2(now.dist / self.pinch.dist), now.cx - r.left, now.cy - r.top);
          self.pinch = now;
        }
        return;
      }
      if (!self.dragStart) return;
      var k = M.scaleAt(self.view.zoom);
      self.view.cx = self.dragStart.cx - (e.clientX - self.dragStart.x) / k;
      self.view.cy = self.dragStart.cy + (e.clientY - self.dragStart.y) / k;
      self.render();
    });
    var up = function (e) {
      delete self.pointers[e.pointerId];
      if (Object.keys(self.pointers).length < 2) self.pinch = null;
      if (!Object.keys(self.pointers).length) {
        self.dragStart = null;
        map.classList.remove('dragging');
      }
    };
    map.addEventListener('pointerup', up);
    map.addEventListener('pointercancel', up);
    map.addEventListener('keydown', function (e) {
      var step = e.shiftKey ? 120 : 40;
      var k = M.scaleAt(self.view.zoom);
      var handled = true;
      if (e.key === 'ArrowLeft') self.view.cx -= step / k;
      else if (e.key === 'ArrowRight') self.view.cx += step / k;
      else if (e.key === 'ArrowUp') self.view.cy += step / k;
      else if (e.key === 'ArrowDown') self.view.cy -= step / k;
      else if (e.key === '+' || e.key === '=') self.zoomBy(1);
      else if (e.key === '-' || e.key === '_') self.zoomBy(-1);
      else handled = false;
      if (handled) { e.preventDefault(); self.render(); }
    });
  };

  Radar.prototype.pinchState = function () {
    var pts = this.pointers, ids = Object.keys(pts);
    if (ids.length < 2) return null;
    var a = pts[ids[0]], b = pts[ids[1]];
    return {
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2
    };
  };

  Radar.prototype.zoomBy = function (delta, ax, ay) {
    var v = this.view;
    var z0 = v.zoom;
    var z1 = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z0 + delta));
    if (z1 === z0) return;
    if (ax == null) { ax = this.vw / 2; ay = this.vh / 2; }
    var before = M.unproject(ax, ay, v, this.vw, this.vh);
    v.zoom = z1;
    var after = M.unproject(ax, ay, v, this.vw, this.vh);
    v.cx += before.x - after.x;
    v.cy += before.y - after.y;
    this.render();
  };

  Radar.prototype.toggleFullscreen = function () {
    var d = this.dialog;
    if (document.fullscreenElement) {
      if (document.exitFullscreen) document.exitFullscreen();
      return;
    }
    if (d.requestFullscreen) {
      var self = this;
      d.requestFullscreen().then(function () { self.render(); }, function () { /* odrzucone przez przeglądarkę */ });
    }
  };

  /* ---------- widoki: województwo / miasto portalu ---------- */

  Radar.prototype.cityInfo = function () {
    if (!this.city) return null;
    var c = this.city;
    var ll = this.manifestCities && this.manifestCities[c.slug];
    var lon = ll ? ll.lon : null, lat = ll ? ll.lat : null;
    if (lon == null && c.x != null && this.bboxMerc) {
      var ax = (this.bboxMerc.x1 - this.bboxMerc.x0) / 704;
      var ay = (this.bboxMerc.y1 - this.bboxMerc.y0) / 676;
      lon = M.lonOf(this.bboxMerc.x0 + c.x * ax);
      lat = M.latOf(this.bboxMerc.y1 - c.y * ay);
    }
    if (lon == null) return null;
    return { slug: c.slug, name: c.name, lon: lon, lat: lat };
  };

  Radar.prototype.setView = function (v, instant) {
    var self = this;
    var city = this.cityInfo();
    if (v === 'city' && !city) v = 'region';
    this.mode = v;
    this.btnRegion.setAttribute('aria-pressed', String(v === 'region'));
    this.btnCity.setAttribute('aria-pressed', String(v === 'city'));
    this.map.setAttribute('aria-label', 'Mapa radaru opadów: ' + (v === 'city' ? city.name + ' i okolice' : 'województwo śląskie i okolice')
      + '. Klawisze: strzałki przesuwają mapę, plus i minus zmieniają powiększenie.');
    var target;
    if (v === 'city') {
      target = { cx: M.mercX(city.lon), cy: M.mercY(city.lat), zoom: CITY_ZOOM };
    } else {
      target = M.fitBounds(this.bbox, Math.max(1, this.vw), Math.max(1, this.vh), 6);
    }
    var from = { cx: this.view.cx, cy: this.view.cy, zoom: this.view.zoom };
    var t0 = 0, dur = (instant || reducedMotion()) ? 0 : 320;
    cancelAnimationFrame(this.anim);
    var tick = function (now) {
      if (!t0) t0 = now;
      var k = dur ? Math.min(1, (now - t0) / dur) : 1;
      var e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      self.view.cx = from.cx + (target.cx - from.cx) * e;
      self.view.cy = from.cy + (target.cy - from.cy) * e;
      self.view.zoom = from.zoom + (target.zoom - from.zoom) * e;
      self.render();
      if (k < 1) self.anim = requestAnimationFrame(tick);
    };
    if (dur) this.anim = requestAnimationFrame(tick);
    else tick(1);
  };

  /* ---------- dane: manifest i klatki ---------- */

  Radar.prototype.msg = function (text, retry) {
    var self = this, m = this.msgEl;
    m.textContent = text || '';
    if (retry) {
      btn('rd-retry', 'Spróbuj ponownie', m).addEventListener('click', function () { self.load(); });
    }
  };

  Radar.prototype.load = function () {
    var self = this, url = this.url, sep = url.indexOf('?') === -1 ? '?' : '&';
    var ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    var to = setTimeout(function () { if (ctrl) ctrl.abort(); }, 10000);
    if (!this.frames.length) this.msg('Ładowanie radaru…');
    return fetch(url + sep + 'manifest', ctrl ? { signal: ctrl.signal } : {})
      .then(function (r) {
        clearTimeout(to);
        if (!r.ok && r.status !== 404) throw new Error('http ' + r.status);
        return r.json();
      })
      .then(function (m) { self.apply(m || {}, url + sep + 'frame='); })
      .catch(function () {
        clearTimeout(to);
        if (!self.frames.length) self.unavailable('Nie udało się pobrać radaru.');
      });
  };

  Radar.prototype.unavailable = function (text) {
    this.play(false);
    this.frames = [];
    this.frameTimes = [];
    this.range.disabled = this.btnPlay.disabled = true;
    this.timeEl.textContent = '–';
    this.badge.hidden = true;
    this.fcBadge.classList.remove('on');
    this.msg(text, true);
  };

  Radar.prototype.apply = function (m, frameBase) {
    var self = this, list = Array.isArray(m.frames) ? m.frames : [];
    if (m.status === 'down' || m.status === 'off' || !list.length) {
      this.unavailable('Radar jest chwilowo niedostępny. Spróbuj ponownie za kilka minut.');
      return;
    }
    var latest = list[list.length - 1].t;
    if (this.frames.length && this.frames[this.frames.length - 1].t === latest && this.status === m.status) return;
    this.status = m.status;
    if (Array.isArray(m.bbox_ll) && m.bbox_ll.length === 4) this.bbox = m.bbox_ll;
    this.bboxMerc = M.bboxMerc(this.bbox);
    this.manifestCities = (m.cities && typeof m.cities === 'object') ? m.cities : null;
    var badge = m.status === 'stale' ? 'Dane sprzed ' + minutesAgo(latest) + ' min'
      : m.status === 'degraded' ? 'Część radarów bez danych' : '';
    this.badge.textContent = badge;
    this.badge.hidden = !badge;
    var wasLast = !this.frames.length || this.minute >= this.spanMin;
    var old = {};
    this.frames.forEach(function (f) { old[f.t] = f; });
    this.frames = list.filter(function (f) { return /^\d{8}T\d{4}$/.test(f.t); }).map(function (f) {
      if (old[f.t]) return old[f.t];
      var fr = { t: f.t, ts: tDate(f.t).getTime(), src: frameBase + encodeURIComponent(f.t), ready: false, im: null, tried: 0 };
      this.loadFrame(fr);
      return fr;
    }, this);
    this.frameTimes = this.frames.map(function (f) { return { ts: f.ts }; });
    // Indeksy klatek mogą się przesunąć (okno przesuwa się o 5 min), więc cache ruchu i pól resetujemy.
    this.motion = {};
    this.fields = {};
    this.masked = {};
    this.maskedOrder = [];
    this.t0 = this.frameTimes.length ? this.frameTimes[0].ts : 0;
    this.spanMin = this.frameTimes.length > 1
      ? Math.round((this.frameTimes[this.frameTimes.length - 1].ts - this.t0) / 60000) : 0;
    this.total = this.spanMin + FORECAST_MIN;
    this.range.max = String(this.total);
    this.range.disabled = this.btnPlay.disabled = this.frames.length < 2;
    this.splitObs.style.flex = '0 0 ' + (this.spanMin / Math.max(1, this.total) * 100) + '%';
    this.splitFc.style.flex = '1 1 auto';
    this.msg('');
    this.showMinute(wasLast ? this.spanMin : Math.min(this.minute, this.total));
  };

  /** Wczytanie klatki; przy braku CORS ponawiamy bez atrybutu crossOrigin (obraz, ale bez odczytu pikseli). */
  Radar.prototype.loadFrame = function (fr) {
    var self = this;
    var im = new Image();
    im.decoding = 'async';
    if (fr.tried === 0) im.crossOrigin = 'anonymous';
    fr.im = im;
    im.onload = function () {
      fr.ready = true;
      self.render();
    };
    im.onerror = function () {
      if (fr.tried === 0) {
        fr.tried = 1;
        self.loadFrame(fr);
        return;
      }
      fr.ready = false;
    };
    im.src = fr.src;
  };

  /* ---------- oś czasu i odtwarzanie ---------- */

  Radar.prototype.showMinute = function (m) {
    m = Math.max(0, Math.min(this.total, Math.round(m)));
    this.minute = m;
    this.range.value = String(m);
    var ts = this.t0 + m * 60000;
    var forecast = m > this.spanMin;
    if (forecast) {
      this.fcBadge.classList.add('on');
      this.timeEl.textContent = fmtTime.format(new Date(ts)) + ' · +' + (m - this.spanMin) + ' min';
      this.range.setAttribute('aria-valuetext', 'Prognoza ruchu chmur, ' + (m - this.spanMin) + ' minut do przodu');
    } else {
      this.fcBadge.classList.remove('on');
      var label = fmtTime.format(new Date(ts));
      var last = m >= this.spanMin;
      var newest = this.frames[this.frames.length - 1];
      this.timeEl.textContent = label + (last && newest ? ' · ' + minutesAgo(newest.t) + ' min temu' : '');
      this.range.setAttribute('aria-valuetext', label + (last ? ', najnowsza klatka' : ''));
    }
    this.drawRadar();
  };

  Radar.prototype.play = function (on) {
    var self = this;
    clearTimeout(this.timer);
    this.timer = null;
    on = on && this.frames.length > 1;
    this.playIcon.setAttribute('d', on ? ICON_PAUSE : ICON_PLAY);
    this.btnPlay.setAttribute('aria-label', on ? 'Zatrzymaj animację' : 'Odtwórz animację');
    if (!on) return;
    var step = function () {
      var next = self.minute + 1;
      if (next > self.total) next = 0;
      self.showMinute(next);
      self.timer = setTimeout(step, TICK_MS);
    };
    this.timer = setTimeout(step, TICK_MS);
  };

  /* ---------- rysowanie ---------- */

  Radar.prototype.layout = function () {
    var w = this.map.clientWidth, hgt = this.map.clientHeight;
    if (!w || !hgt) return false;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    if (this.vw === w && this.vh === hgt && this.dpr === dpr) return true;
    this.vw = w; this.vh = hgt; this.dpr = dpr;
    [this.base, this.overlay].forEach(function (c) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(hgt * dpr);
    });
    return true;
  };

  Radar.prototype.render = function () {
    if (!this.layout()) return;
    var vk = this.view.cx.toFixed(2) + ',' + this.view.cy.toFixed(2) + ',' + this.view.zoom.toFixed(3);
    if (vk !== this.viewKey) { this.viewKey = vk; this.baseKey = ''; }
    var bk = this.viewKey + '#' + this.tileVersion;
    if (bk !== this.baseKey) { this.baseKey = bk; this.drawBase(); }
    this.drawRadar();
    if (this.vectorKey !== this.viewKey) { this.vectorKey = this.viewKey; this.updateVector(); }
  };

  /** Podkład: kafelki mapy; gdy brak sieci — granice wektorowe (nasz własny podkład). */
  Radar.prototype.drawBase = function () {
    var ctx = this.base.getContext('2d');
    var w = this.vw, h = this.vh;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#e7eaee';
    ctx.fillRect(0, 0, w, h);
    var drew = 0;
    if (this.tilesOk && this.mapMode !== 'vector') {
      drew = this.drawTiles(ctx);
    }
    if (!drew) {
      this.mapAttr.textContent = 'Mapa: granice PRG/GUGiK (podkład własny)';
      this.drawVectorBase(ctx);
    }
  };

  Radar.prototype.drawTiles = function (ctx) {
    var self = this;
    var z = Math.max(TILE_MIN_Z, Math.min(TILE_MAX_Z, Math.round(this.view.zoom)));
    var range = M.tileRange(this.view, this.vw, this.vh, z);
    var k = M.scaleAt(this.view.zoom);
    var originX = (-M.R - this.view.cx) * k + this.vw / 2;
    var originY = (this.view.cy - M.R) * k + this.vh / 2;
    var size = M.TILE * Math.pow(2, this.view.zoom - z);
    var drew = 0;
    for (var ty = range.y0; ty <= range.y1; ty++) {
      for (var tx = range.x0; tx <= range.x1; tx++) {
        var img = this.tiles[z + '/' + tx + '/' + ty];
        if (img && img.complete && img.naturalWidth) {
          ctx.drawImage(img, originX + tx * size, originY + ty * size, size + 1, size + 1);
          drew++;
        } else {
          this.loadTile(z, tx, ty);
        }
      }
    }
    this.mapAttr.textContent = this.tilesOk
      ? 'Mapa: ' + PROVIDERS[this.provider].attribution
      : 'Mapa: granice PRG/GUGiK (podkład własny)';
    return drew;
  };

  Radar.prototype.loadTile = function (z, x, y) {
    var self = this;
    var key = z + '/' + x + '/' + y;
    if (this.tiles[key] || this.tileLoading >= 8) {
      if (!this.tiles[key]) this.tileQueue.push([z, x, y]);
      return;
    }
    var p = PROVIDERS[this.provider];
    var sub = p.sub.length ? p.sub[(x + y) % p.sub.length] : '';
    var img = new Image();
    this.tiles[key] = img;
    this.tileOrder.push(key);
    this.tileLoading++;
    img.onload = function () {
      self.tileLoading--;
      self.tileVersion++;
      self.render();
      self.drainQueue();
    };
    img.onerror = function () {
      self.tileLoading--;
      delete self.tiles[key];
      self.tileOrder = self.tileOrder.filter(function (k) { return k !== key; });
      self.tileErrors++;
      // Jedna usługa może być zablokowana (adblock, sieć portalu) — próbujemy następnej.
      if (self.provider < PROVIDERS.length - 1 && self.tileErrors >= 4) {
        self.provider++;
        self.tiles = {};
        self.tileOrder = [];
        self.tileErrors = 0;
      } else if (self.tileErrors >= 12) {
        self.tilesOk = false;
      }
      self.drainQueue();
      self.render();
    };
    img.src = p.url.replace('{s}', sub).replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
    while (this.tileOrder.length > MAX_TILES) {
      var old = this.tileOrder.shift();
      if (this.tiles[old] && !this.tiles[old].complete) continue;
      delete this.tiles[old];
    }
  };

  Radar.prototype.drainQueue = function () {
    while (this.tileLoading < 8 && this.tileQueue.length) {
      var t = this.tileQueue.shift();
      this.loadTile(t[0], t[1], t[2]);
    }
  };

  /** Podkład wektorowy (bez kafelków): granice powiatów i województwa. */
  Radar.prototype.drawVectorBase = function (ctx) {
    if (!BASE || !this.bboxMerc) return;
    var b = this.bboxMerc;
    var ax = (b.x1 - b.x0) / 704, ay = (b.y1 - b.y0) / 676;
    var k = M.scaleAt(this.view.zoom);
    ctx.save();
    ctx.setTransform(this.dpr * ax * k, 0, 0, this.dpr * ay * k,
      this.dpr * ((b.x0 - this.view.cx) * k + this.vw / 2),
      this.dpr * ((this.view.cy - b.y1) * k + this.vh / 2));
    var g = BASE.geometry;
    if (g.neighbors) { ctx.fillStyle = '#f3f1eb'; ctx.fill(new Path2D(g.neighbors)); }
    if (g.powiaty) { ctx.fillStyle = '#fffdf8'; ctx.fill(new Path2D(g.powiaty)); }
    ctx.restore();
  };

  /** Warstwa wektorowa: granice, etykiety miast i znacznik „moje miasto”. */
  Radar.prototype.updateVector = function () {
    var svg = this.svg;
    var k = M.scaleAt(this.view.zoom);
    var w = this.vw, h = this.vh;
    var x0 = this.view.cx - (w / 2) / k, x1 = this.view.cx + (w / 2) / k;
    var y0 = -(this.view.cy + (h / 2) / k), y1 = -(this.view.cy - (h / 2) / k);
    svg.setAttribute('viewBox', x0 + ' ' + y0 + ' ' + (x1 - x0) + ' ' + (y1 - y0));
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    if (!BASE || !this.bboxMerc) return;
    var b = this.bboxMerc;
    var ax = (b.x1 - b.x0) / 704, ay = (b.y1 - b.y0) / 676;
    var lines = s('g', {
      transform: 'translate(' + b.x0 + ' ' + (-b.y1) + ') scale(' + ax + ' ' + ay + ')',
      fill: 'none', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke'
    }, svg);
    var g = BASE.geometry;
    if (g.neighbors) s('path', { d: g.neighbors, stroke: '#8f887a', 'stroke-width': 0.8, opacity: 0.75 }, lines);
    if (g.powiaty && this.view.zoom < 12) s('path', { d: g.powiaty, stroke: '#8f887a', 'stroke-width': 0.5, opacity: 0.5 }, lines);
    if (g.slaskie) s('path', { d: g.slaskie, stroke: '#3f3a32', 'stroke-width': 1.8, opacity: 0.9 }, lines);

    var labels = s('g', { 'aria-hidden': 'true' }, svg);
    var city = this.cityInfo();
    var zoomed = this.view.zoom > 10.5;
    var placed = [];
    var self = this;
    // Nazwy województw sąsiednich tylko w widoku regionalnym.
    if (!zoomed && BASE.regions) {
      BASE.regions.forEach(function (r) {
        var mx = b.x0 + r.x * ax, my = b.y1 - r.y * ay;
        s('text', {
          x: mx, y: -my, 'text-anchor': 'middle', 'font-size': 11 / k, 'letter-spacing': 1.2 / k,
          fill: '#6b6459', 'font-family': 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif'
        }, labels).textContent = r.t;
      });
    }
    var list = (BASE.cities || []).filter(function (c) { return zoomed ? c.rank === 1 || (city && c.slug === city.slug) : true; });
    list.forEach(function (c) {
      var mx = b.x0 + c.x * ax, my = b.y1 - c.y * ay;
      var me = city && c.slug === city.slug;
      if (mx < x0 - 4000 || mx > x1 + 4000 || -my < y0 - 4000 || -my > y1 + 4000) return;
      s('circle', {
        cx: mx, cy: -my, r: (me ? 5 : 2.8) / k, fill: me ? '#d6336c' : '#1f2937',
        stroke: '#fff', 'stroke-width': 1.3 / k
      }, labels);
      var fs = (me ? 13 : 11.5) / k;
      var wpx = c.name.length * fs * 0.56;
      var box = [mx + 7 / k, -my - fs * 0.6, mx + 7 / k + wpx, -my + fs * 0.6];
      if (placed.some(function (p) { return box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1]; })) return;
      placed.push(box);
      s('text', {
        x: mx + 7 / k, y: -my + fs * 0.35, 'font-size': fs, 'font-weight': me ? 700 : 500,
        fill: '#111827', stroke: '#fff', 'stroke-width': 3 / k, 'paint-order': 'stroke',
        'font-family': 'system-ui,-apple-system,Segoe UI,Roboto,sans-serif'
      }, labels).textContent = c.name;
    });
  };

  /** Klatka radaru z interpolacją (krok 1 min) i ekstrapolacją ruchu (prognoza). */
  Radar.prototype.drawRadar = function () {
    var ctx = this.overlay.getContext('2d');
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.vw, this.vh);
    if (!this.frames.length || !this.bboxMerc) return;
    var ts = this.t0 + this.minute * 60000;
    var br = M.bracket(this.frameTimes, ts);
    var f0 = this.maskedFrame(br.i);
    var f1 = this.maskedFrame(br.j);
    if (!f0 && !f1) return;
    var rect = this.frameRect();
    var iw = (f1 || f0).width, ih = (f1 || f0).height;
    var sx = rect.w / iw, sy = rect.h / ih;
    if (br.extra > 0) {
      // Prognoza ruchu: ostatnia klatka przesunięta o wektor z ostatnich 5 minut.
      var vf = this.motionBetween(br.i) || { dx: 0, dy: 0 };
      var kf = br.extra / (this.frameTimes.length > 1
        ? (this.frameTimes[1].ts - this.frameTimes[0].ts) : 300000);
      ctx.globalAlpha = M.decayAlpha(br.extra / 60000, FORECAST_MIN);
      ctx.drawImage(f1 || f0, rect.x + vf.dx * sx * kf, rect.y + vf.dy * sy * kf, rect.w, rect.h);
      ctx.globalAlpha = 1;
      return;
    }
    if (br.f <= 0 || !f1) {
      ctx.drawImage(f0, rect.x, rect.y, rect.w, rect.h);
      return;
    }
    var v = this.motionBetween(br.i) || { dx: 0, dy: 0 };
    var f = br.f;
    ctx.globalAlpha = 1 - f;
    ctx.drawImage(f0, rect.x + v.dx * sx * f, rect.y + v.dy * sy * f, rect.w, rect.h);
    ctx.globalAlpha = f;
    ctx.drawImage(f1, rect.x - v.dx * sx * (1 - f), rect.y - v.dy * sy * (1 - f), rect.w, rect.h);
    ctx.globalAlpha = 1;
  };

  Radar.prototype.frameRect = function () {
    var b = this.bboxMerc;
    var p0 = M.project(b.x0, b.y1, this.view, this.vw, this.vh);
    var p1 = M.project(b.x1, b.y0, this.view, this.vw, this.vh);
    return { x: p0.x, y: p0.y, w: p1.x - p0.x, h: p1.y - p0.y };
  };

  /** Klatka bez szarej plamy „brak danych” (przezroczyste) — tylko gdy pozwala na to CORS. */
  Radar.prototype.maskedFrame = function (i) {
    if (this.masked[i]) return this.masked[i];
    var f = this.frames[i];
    if (!f || !f.ready || !f.im) return null;
    var cv = document.createElement('canvas');
    cv.width = f.im.naturalWidth || f.im.width;
    cv.height = f.im.naturalHeight || f.im.height;
    var ctx = cv.getContext('2d');
    try {
      ctx.drawImage(f.im, 0, 0);
      var data = ctx.getImageData(0, 0, cv.width, cv.height);
      var px = data.data;
      for (var p = 0; p < px.length; p += 4) {
        if (px[p] === 128 && px[p + 1] === 128 && px[p + 2] === 128) px[p + 3] = 0;
      }
      ctx.putImageData(data, 0, 0);
    } catch (e) { /* brak CORS: zostaje oryginalna klatka */ }
    this.masked[i] = cv;
    this.maskedOrder.push(i);
    while (this.maskedOrder.length > 4) {
      var old = this.maskedOrder.shift();
      delete this.masked[old];
    }
    return cv;
  };

  /** Pole natężenia echa (1/8 rozmiaru) dla klatki. */
  Radar.prototype.fieldOf = function (i) {
    if (this.fields[i] !== undefined) return this.fields[i];
    var f = this.frames[i];
    if (!f || !f.ready || !f.im) { this.fields[i] = null; return null; }
    var w = Math.max(8, Math.ceil((f.im.naturalWidth || 704) / FIELD_DIV));
    var hgt = Math.max(8, Math.ceil((f.im.naturalHeight || 676) / FIELD_DIV));
    var cv = document.createElement('canvas');
    cv.width = w; cv.height = hgt;
    var ctx = cv.getContext('2d');
    try {
      ctx.drawImage(f.im, 0, 0, w, hgt);
      this.fields[i] = M.fieldFromRGBA(ctx.getImageData(0, 0, w, hgt).data, w, hgt);
    } catch (e) {
      this.fields[i] = null;
    }
    return this.fields[i];
  };

  /** Wektor przesunięcia echa między klatkami i oraz i+1 (w pikselach klatki). */
  Radar.prototype.motionBetween = function (i) {
    if (this.motion[i] !== undefined) return this.motion[i];
    var a = this.fieldOf(i), b = this.fieldOf(i + 1);
    if (!a || !b) { this.motion[i] = null; return null; }
    var r = M.motionFromField(a, b, MOTION_MAX);
    this.motion[i] = r.dx === null ? null : { dx: r.dx * FIELD_DIV, dy: r.dy * FIELD_DIV };
    return this.motion[i];
  };

  /* ---------- otwieranie okna ---------- */

  Radar.prototype.show = function (o) {
    var self = this, d = this.dialog;
    this.url = o.url;
    this.trigger = o.trigger || null;
    this.mapMode = o.map || 'tiles';
    var c = null;
    if (BASE && o.city) {
      BASE.cities.forEach(function (x) { if (x.slug === o.city) c = x; });
    }
    this.city = c ? { slug: c.slug, x: c.x, y: c.y, name: o.cityName || c.name } : null;
    this.btnCity.textContent = this.city ? this.city.name : '';
    this.btnCity.hidden = !this.city;
    if (!d.open) {
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
      d.focus();
    }
    this.layout();
    this.load().then(function () {
      if (d.open) {
        self.setView('region', true);
        if (!reducedMotion()) self.play(true);
      }
    });
    clearInterval(this.poll);
    this.poll = setInterval(function () { if (!document.hidden && d.open) self.load(); }, POLL_MS);
  };

  window.MoWeatherRadar = {
    version: '2.0.0',
    util: M,
    open: function (o) {
      var root = (o && o.root) || document.body;
      var inst = store.get(root);
      if (!inst) {
        inst = new Radar(root);
        store.set(root, inst);
      }
      inst.show(o || {});
      return inst;
    }
  };
})();
