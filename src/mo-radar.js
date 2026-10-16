/*
 * MO Weather Widget: okno radaru burzowego (moduł ładowany dopiero po kliknięciu „Radar burzowy”).
 * scripts/build.sh skleja go z podkładem src/mo-radar-basemap.js do dist/mo-radar(.min).js.
 * Udostępnia window.MoWeatherRadar.open({root, url, city, cityName, trigger}).
 *
 * Bezpieczeństwo: tekst wyłącznie przez textContent, SVG przez createElementNS (zero parsowania HTML).
 * Dane: /api/radar?manifest (lista klatek) i /api/radar?frame=T (PNG w EPSG:3857, bbox jak podkład).
 */
(function () {
  'use strict';
  if (window.MoWeatherRadar) return;

  var BASE = typeof MO_RADAR_BASEMAP !== 'undefined' ? MO_RADAR_BASEMAP : null;
  var NS = 'http://www.w3.org/2000/svg';
  var W = 704, H = 676, ZOOM = 2.6;
  var STEP_MS = 500, HOLD_MS = 1500, POLL_MS = 120000;
  var LEGEND = [
    ['słaby', '10–25 dBZ', '#a0dcff,#5aafff,#2378f5'],
    ['umiarkowany', '25–35 dBZ', '#19b946,#0f8728'],
    ['silny', '35–45 dBZ', '#fae100,#ffa500'],
    ['bardzo silny / burza', '45–55 dBZ', '#ff5500,#e10000'],
    ['możliwy grad', '55+ dBZ', '#a00032,#e100e1,#fff'],
    ['brak danych', 'poza zasięgiem radarów', 'rgba(128,128,128,.35),rgba(128,128,128,.35)']
  ];
  var LINKS = [
    ['Radar: ', 'EUMETNET OPERA', 'https://www.eumetnet.eu/observations/weather-radar-network/'],
    [' (', 'CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/deed.pl'],
    ['), dane przetworzone · Granice: ', 'PRG/GUGiK', 'https://www.geoportal.gov.pl/']
  ];
  var ICON_PLAY = 'M8 5v14l11-7z', ICON_PAUSE = 'M7 5h4v14H7zM13 5h4v14h-4z';

  var CSS = [
    '.rd{width:min(760px,calc(100vw - 16px));max-width:100vw;max-height:calc(100vh - 16px);padding:0;border:0;border-radius:var(--mo-radius,14px);',
    'background:var(--mo-card,#fff);color:var(--mo-text,#1a1a1a);box-shadow:0 20px 60px rgba(0,0,0,.35);font:inherit;font-size:14px;overflow:auto;}',
    '.rd::backdrop{background:rgba(17,24,39,.55);}',
    '.rd:focus{outline:none;}',
    '.rd-head{display:flex;align-items:center;gap:8px 10px;flex-wrap:wrap;padding:10px 12px;}',
    '.rd-title{margin:0;font-size:17px;}',
    '.rd-badge{font-size:12px;font-weight:600;border-radius:999px;padding:2px 9px;background:#fff4d6;color:#7a4b00;border:1px solid #f0d896;}',
    '.rd-views{margin-left:auto;display:inline-flex;background:var(--mo-bg-sub,#f1f3f5);border-radius:999px;padding:2px;}',
    ':where(.rd) button{font:inherit;cursor:pointer;color:inherit;}',
    '.rd-views button{border:0;background:transparent;border-radius:999px;padding:5px 11px;font-size:13px;}',
    '.rd-views button[aria-pressed="true"]{background:var(--mo-text,#1a1a1a);color:var(--mo-card,#fff);}',
    '.rd-close{border:0;background:transparent;font-size:24px;line-height:1;padding:2px 8px;border-radius:6px;}',
    '.rd button:focus-visible,.rd input:focus-visible,.rd a:focus-visible{outline:2px solid var(--mo-accent,#0b63ce);outline-offset:2px;}',
    '.rd-map{position:relative;background:#e7eaee;overflow:hidden;}',
    '.rd-map svg{display:block;width:100%;height:auto;}',
    '.rd-msg{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);margin:0;max-width:80%;text-align:center;',
    'background:rgba(255,255,255,.94);color:#1a1a1a;border-radius:10px;padding:10px 14px;box-shadow:0 2px 10px rgba(0,0,0,.15);}',
    '.rd-msg:empty{display:none;}',
    '.rd-retry{display:block;margin:8px auto 0;border:1px solid #c9ced6;background:#fff;border-radius:999px;padding:4px 12px;}',
    '.rd-player{display:flex;align-items:center;gap:12px;padding:10px 12px 4px;}',
    '.rd-play{flex:0 0 auto;width:36px;height:36px;border-radius:50%;border:0;background:var(--mo-text,#1a1a1a);color:var(--mo-card,#fff);display:flex;align-items:center;justify-content:center;padding:0;}',
    '.rd-play svg{width:18px;height:18px;fill:currentColor;}',
    '.rd-play:disabled,.rd-range:disabled{opacity:.45;cursor:default;}',
    '.rd-range{flex:1;min-width:80px;accent-color:var(--mo-accent,#0b63ce);}',
    '.rd-time{min-width:132px;text-align:right;font-weight:700;font-variant-numeric:tabular-nums;}',
    '.rd-legend{display:flex;flex-wrap:wrap;gap:4px 14px;margin:0;padding:6px 12px;list-style:none;font-size:12.5px;}',
    '.rd-legend i{display:inline-block;width:22px;height:11px;border-radius:3px;margin-right:5px;vertical-align:-1px;box-shadow:inset 0 0 0 1px rgba(0,0,0,.12);}',
    '.rd-foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:4px 10px;margin:0;padding:4px 12px 12px;font-size:11.5px;color:var(--mo-foot,#595959);}',
    '.rd-foot a{color:inherit;}',
    '@media (max-width:560px){.rd{width:100vw;max-height:100vh;border-radius:0;}.rd-time{min-width:0;}}'
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
    this.idx = 0;
    this.timer = null;
    this.poll = null;
    this.view = 'region';
    this.vb = [0, 0, W, H];
    this.city = null;
    var id = 'mo-radar-' + (++seq);

    var style = h('style');
    style.textContent = CSS;
    root.appendChild(style);

    var d = this.dialog = h('dialog', 'rd');
    d.setAttribute('aria-labelledby', id + '-t');
    d.tabIndex = -1; // fokus na samym oknie (czytnik ekranu odczyta tytuł), bez ramki na pierwszym przycisku
    var head = h('div', 'rd-head', null, d);
    h('h2', 'rd-title', 'Radar burzowy', head).id = id + '-t';
    this.badge = h('span', 'rd-badge', null, head);
    this.badge.hidden = true;
    var views = h('div', 'rd-views', null, head);
    views.setAttribute('role', 'group');
    views.setAttribute('aria-label', 'Widok mapy');
    this.btnRegion = btn('', 'Województwo', views);
    this.btnCity = btn('', '', views);
    this.btnRegion.addEventListener('click', function () { self.setView('region'); });
    this.btnCity.addEventListener('click', function () { self.setView('city'); });
    var close = btn('rd-close', '×', head);
    close.setAttribute('aria-label', 'Zamknij radar');
    close.addEventListener('click', function () { d.close(); });

    var map = h('div', 'rd-map', null, d);
    this.svg = s('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', preserveAspectRatio: 'xMidYMid meet' }, map);
    this.msgEl = h('p', 'rd-msg', null, map);
    this.msgEl.setAttribute('role', 'status');
    this.buildMap();

    var player = h('div', 'rd-player', null, d);
    this.btnPlay = btn('rd-play', null, player);
    this.playIcon = s('path', { d: ICON_PLAY }, s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' }, this.btnPlay));
    this.range = h('input', 'rd-range', null, player);
    this.range.type = 'range';
    this.range.min = '0';
    this.range.setAttribute('aria-label', 'Godzina klatki radaru');
    this.timeEl = h('span', 'rd-time', '–', player);
    this.btnPlay.addEventListener('click', function () { self.play(!self.timer); });
    this.play(false); // ikona i etykieta przycisku od początku (także przy prefers-reduced-motion)
    this.range.addEventListener('input', function () { self.play(false); self.showFrame(+self.range.value); });

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
    h('span', null, 'Obraz radaru jest opóźniony o ok. 5–10 min.', foot);
    var attr = h('span', null, null, foot);
    LINKS.forEach(function (l) {
      if (l[0]) attr.appendChild(document.createTextNode(l[0]));
      var a = h('a', null, l[1], attr);
      a.href = l[2];
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    });

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
      self.rz = requestAnimationFrame(function () { self.drawLabels(); });
    });
    root.appendChild(d);
  }

  Radar.prototype.buildMap = function () {
    var svg = this.svg;
    s('rect', { width: W, height: H, fill: '#e7eaee' }, svg);
    if (BASE) {
      var g = BASE.geometry;
      s('path', { d: g.neighbors, fill: '#f3f1eb' }, svg);
      s('path', { d: g.powiaty, fill: '#fffdf8' }, svg);
    }
    this.img = s('image', { x: 0, y: 0, width: W, height: H, preserveAspectRatio: 'none' }, svg);
    if (BASE) {
      var line = { fill: 'none', 'stroke-linejoin': 'round', 'vector-effect': 'non-scaling-stroke' };
      var add = function (d, extra) {
        var a = { d: d };
        for (var k in line) a[k] = line[k];
        for (var j in extra) a[j] = extra[j];
        s('path', a, svg);
      };
      add(g.neighbors, { stroke: '#8f887a', 'stroke-width': 0.8, opacity: 0.8 });
      add(g.powiaty, { stroke: '#8f887a', 'stroke-width': 0.5, opacity: 0.55 });
      add(g.slaskie, { stroke: '#3f3a32', 'stroke-width': 1.8 });
    }
    this.regions = s('g', { fill: '#7a7468', 'text-anchor': 'middle', 'aria-hidden': 'true' }, svg);
    this.labels = s('g', { 'aria-hidden': 'true' }, svg);
  };

  Radar.prototype.drawLabels = function () {
    var g = this.labels, rg = this.regions, city = this.city ? this.city.slug : '';
    while (g.firstChild) g.removeChild(g.firstChild);
    while (rg.firstChild) rg.removeChild(rg.firstChild);
    if (!BASE) return;
    // z = piksele ekranu na jednostkę mapy: napisy mają stały rozmiar na ekranie (telefon, powiększenie).
    var vb = this.vb, width = this.svg.getBoundingClientRect().width;
    var z = (width || W) / vb[2], zoomed = W / vb[2] > 1.5, placed = [];
    if (z >= 0.75) { // nazwy regionów tylko tam, gdzie się mieszczą
      rg.setAttribute('font-size', 9.5 / z);
      rg.setAttribute('letter-spacing', 1 / z);
      BASE.regions.forEach(function (r) { s('text', { x: r.x, y: r.y }, rg).textContent = r.t; });
    }
    var list = BASE.cities.filter(function (c) { return zoomed || c.rank === 1 || c.slug === city; })
      .sort(function (a, b) { return (b.slug === city) - (a.slug === city) || a.rank - b.rank; });
    list.forEach(function (c) {
      var me = c.slug === city;
      s('circle', { cx: c.x, cy: c.y, r: (me ? 4.2 : 2.6) / z, fill: me ? '#d6336c' : '#1f2937', stroke: '#fff', 'stroke-width': 1.2 / z }, g);
      var w = c.name.length * 6.9 / z * (me ? 1.1 : 1), hh = 13 / z;
      for (var side = 1; side >= -1; side -= 2) {
        var x0 = side > 0 ? c.x + 6 / z : c.x - 6 / z - w;
        var box = [x0, c.y - hh / 2, x0 + w, c.y + hh / 2];
        if (box[0] < vb[0] || box[2] > vb[0] + vb[2]) continue;
        if (placed.some(function (p) { return box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1]; })) continue;
        placed.push(box);
        s('text', {
          x: side > 0 ? c.x + 6 / z : c.x - 6 / z, y: c.y + 4 / z, 'text-anchor': side > 0 ? 'start' : 'end',
          'font-size': (me ? 13 : 11.5) / z, 'font-weight': me ? 700 : 500, fill: '#111827', stroke: '#fff',
          'stroke-width': 3 / z, 'paint-order': 'stroke'
        }, g).textContent = c.name;
        break;
      }
    });
  };

  Radar.prototype.setView = function (v, instant) {
    var self = this, c = this.city;
    if (v === 'city' && !c) v = 'region';
    this.view = v;
    this.btnRegion.setAttribute('aria-pressed', String(v === 'region'));
    this.btnCity.setAttribute('aria-pressed', String(v === 'city'));
    this.svg.setAttribute('aria-label', 'Mapa radaru opadów: ' + (v === 'city' ? c.name + ' i okolice' : 'województwo śląskie i okolice'));
    var vw = W / ZOOM, vh = H / ZOOM;
    var target = v === 'city'
      ? [Math.min(Math.max(c.x - vw / 2, 0), W - vw), Math.min(Math.max(c.y - vh / 2, 0), H - vh), vw, vh]
      : [0, 0, W, H];
    var from = this.vb.slice(), t0 = 0, dur = (instant || reducedMotion()) ? 0 : 320;
    cancelAnimationFrame(this.anim);
    var tick = function (now) {
      if (!t0) t0 = now;
      var k = dur ? Math.min(1, (now - t0) / dur) : 1;
      var e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      self.vb = from.map(function (f, j) { return f + (target[j] - f) * e; });
      self.svg.setAttribute('viewBox', self.vb.join(' '));
      if (k < 1) self.anim = requestAnimationFrame(tick);
      else self.drawLabels();
    };
    if (dur) this.anim = requestAnimationFrame(tick);
    else tick(1);
  };

  Radar.prototype.msg = function (text, retry) {
    var self = this, m = this.msgEl;
    m.textContent = text || '';
    if (retry) {
      btn('rd-retry', 'Spróbuj ponownie', m).addEventListener('click', function () { self.load(); });
    }
  };

  Radar.prototype.showFrame = function (i) {
    var f = this.frames[i];
    if (!f) return;
    this.idx = i;
    this.img.setAttribute('href', f.src);
    this.range.value = String(i);
    var label = fmtTime.format(tDate(f.t));
    var last = i === this.frames.length - 1;
    var ago = minutesAgo(f.t);
    this.timeEl.textContent = label + (last ? ' · ' + ago + ' min temu' : '');
    this.range.setAttribute('aria-valuetext', label + (last ? ', najnowsza klatka, ' + ago + ' min temu' : ''));
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
      var n = self.frames.length, next = (self.idx + 1) % n;
      // Klatki, które jeszcze się ładują, przeskakujemy (bez mrugania pustą mapą).
      for (var k = 0; k < n && !self.frames[next].ready; k++) next = (next + 1) % n;
      if (self.frames[next].ready) self.showFrame(next);
      self.timer = setTimeout(step, self.idx === n - 1 ? HOLD_MS : STEP_MS);
    };
    this.timer = setTimeout(step, STEP_MS);
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
    this.img.removeAttribute('href');
    this.range.disabled = this.btnPlay.disabled = true;
    this.timeEl.textContent = '–';
    this.badge.hidden = true;
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
    var badge = m.status === 'stale' ? 'Dane sprzed ' + minutesAgo(latest) + ' min'
      : m.status === 'degraded' ? 'Część radarów bez danych' : '';
    this.badge.textContent = badge;
    this.badge.hidden = !badge;
    var wasLast = !this.frames.length || this.idx === this.frames.length - 1;
    var old = {};
    this.frames.forEach(function (f) { old[f.t] = f; });
    this.frames = list.filter(function (f) { return /^\d{8}T\d{4}$/.test(f.t); }).map(function (f) {
      if (old[f.t]) return old[f.t];
      var fr = { t: f.t, src: frameBase + encodeURIComponent(f.t), ready: false };
      var im = new Image();
      im.onload = function () { fr.ready = true; };
      im.src = fr.src;
      fr.im = im;
      return fr;
    });
    this.range.max = String(this.frames.length - 1);
    this.range.disabled = this.btnPlay.disabled = this.frames.length < 2;
    this.msg('');
    this.showFrame(wasLast ? this.frames.length - 1 : Math.min(this.idx, this.frames.length - 1));
  };

  Radar.prototype.show = function (o) {
    var self = this, d = this.dialog;
    this.url = o.url;
    this.trigger = o.trigger || null;
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
    // Start zawsze od całego województwa (burze nadciągają z daleka); miasto czytelnika jest wyróżnione.
    this.setView('region', true);
    this.load().then(function () {
      if (d.open && !reducedMotion()) self.play(true);
    });
    clearInterval(this.poll);
    this.poll = setInterval(function () { if (!document.hidden && d.open) self.load(); }, POLL_MS);
  };

  window.MoWeatherRadar = {
    version: '2.0.0',
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
