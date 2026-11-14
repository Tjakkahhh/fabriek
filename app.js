(() => {
'use strict';

const $ = s => document.querySelector(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* opslag vol of geblokkeerd */ } }
};
const BELGIUM = L.latLngBounds([49.45, 2.5], [51.55, 6.45]);

/* ---------- Kaart ---------- */
const map = L.map('map', {
  zoomControl: false, minZoom: 7, maxZoom: 19,
  maxBounds: BELGIUM.pad(0.35), maxBoundsViscosity: 0.8
});
const view = store.get('view');
if (view) map.setView(view.c, view.z); else map.fitBounds(BELGIUM);
map.on('moveend', () => store.set('view', { c: [map.getCenter().lat, map.getCenter().lng], z: map.getZoom() }));

const bases = {
  osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, crossOrigin: true, attribution: '© OpenStreetMap' }),
  ngi: L.tileLayer('https://cartoweb.wmts.ngi.be/1.0.0/topo/default/3857/{z}/{y}/{x}.png', {
    maxNativeZoom: 17, maxZoom: 19, attribution: '© NGI/IGN België' }),
  otm: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxNativeZoom: 17, maxZoom: 19, crossOrigin: true, attribution: '© OpenTopoMap, © OpenStreetMap' })
};
const trails = L.tileLayer('https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png', {
  maxZoom: 19, crossOrigin: true, opacity: 0.85, attribution: '© Waymarked Trails' });

let baseName = store.get('base', 'osm');
if (!bases[baseName]) baseName = 'osm';
bases[baseName].addTo(map);
if (store.get('trails', true)) trails.addTo(map);

/* ---------- Route-toestand ---------- */
let pts = [];            // [{lat, lng}]
let segs = [];           // per stuk tussen twee punten: {coords: [[lat, lng, hoogte?]], straight?}
let ver = 0;
let speed = store.get('speed', 4.5);
const history = [];
const segCache = new Map();
const routeLayer = L.layerGroup().addTo(map);
const markerLayer = L.layerGroup().addTo(map);
let scrubDot = null;

const rad = d => d * Math.PI / 180;
function dist(a, b) { // km
  const dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
function dest(p, bearing, km) {
  const d = km / 6371, b = rad(bearing), la = rad(p.lat), lo = rad(p.lng);
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return { lat: la2 * 180 / Math.PI, lng: lo2 * 180 / Math.PI };
}
const same = (a, b) => Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lng - b.lng) < 1e-6;

/* ---------- Routeberekening over wandelpaden ---------- */
async function getJson(url, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function viaBrouter(a, b) {
  const j = await getJson('https://brouter.de/brouter?lonlats=' + a.lng + ',' + a.lat + '|' + b.lng + ',' + b.lat +
    '&profile=hiking-mountain&alternativeidx=0&format=geojson');
  const c = j.features[0].geometry.coordinates;
  if (!c || c.length < 2) throw new Error('lege route');
  return { coords: c.map(p => p.length > 2 ? [p[1], p[0], p[2]] : [p[1], p[0]]) };
}
async function viaOsrm(a, b) {
  const j = await getJson('https://routing.openstreetmap.de/routed-foot/route/v1/foot/' + a.lng + ',' + a.lat + ';' +
    b.lng + ',' + b.lat + '?overview=full&geometries=geojson');
  const c = j.routes[0].geometry.coordinates;
  if (!c || c.length < 2) throw new Error('lege route');
  return { coords: c.map(p => [p[1], p[0]]) };
}
async function fetchSeg(a, b) {
  const key = [a.lat, a.lng, b.lat, b.lng].map(n => n.toFixed(5)).join(',');
  if (segCache.has(key)) return segCache.get(key);
  let seg;
  try { seg = await viaBrouter(a, b); }
  catch {
    try { seg = await viaOsrm(a, b); }
    catch { return { coords: [[a.lat, a.lng], [b.lat, b.lng]], straight: true }; } // niet onthouden: later opnieuw proberen
  }
  segCache.set(key, seg);
  return seg;
}

async function refresh() {
  const v = ++ver;
  drawMarkers();
  updateButtons();
  if (pts.length < 2) { segs = []; draw(); return; }
  $('#busy').hidden = false;
  const res = await Promise.all(pts.slice(0, -1).map((p, i) => fetchSeg(p, pts[i + 1])));
  if (v !== ver) return;
  segs = res;
  $('#busy').hidden = true;
  draw();
}

function allCoords() {
  const out = [];
  segs.forEach((s, i) => s.coords.forEach((c, j) => { if (i === 0 || j > 0) out.push(c); }));
  return out;
}
function stats() {
  const c = allCoords();
  let km = 0, up = 0, base = null, hasEle = c.length > 1 && c.every(p => p.length > 2);
  const cum = [0];
  for (let i = 1; i < c.length; i++) { km += dist(c[i - 1], c[i]); cum.push(km); }
  if (hasEle) { // kleine schommelingen in de hoogtedata niet meetellen
    base = c[0][2];
    for (const p of c) {
      if (p[2] - base >= 3) { up += p[2] - base; base = p[2]; }
      else if (p[2] < base) base = p[2];
    }
  }
  return { c, cum, km, up: hasEle ? Math.round(up) : null, hours: km / speed + (hasEle ? up / 600 : 0) };
}

function setPts(next, keepHistory = true) {
  if (keepHistory) { history.push(JSON.stringify(pts)); if (history.length > 60) history.shift(); }
  pts = next;
  store.set('draft', pts);
  return refresh();
}

/* ---------- Tekenen ---------- */
function ptIcon(i, last) {
  const cls = i === 0 ? 'pt start' : (i === last ? 'pt end' : 'pt');
  const txt = i === 0 ? 'S' : (i === last ? 'F' : i);
  return L.divIcon({ className: '', html: '<div class="' + cls + '">' + txt + '</div>', iconSize: [26, 26], iconAnchor: [13, 13] });
}
function drawMarkers() {
  markerLayer.clearLayers();
  const last = pts.length - 1;
  const closed = last > 1 && same(pts[0], pts[last]);
  pts.forEach((p, i) => {
    if (closed && i === last) return; // lus: eindpunt valt samen met de start
    const m = L.marker(p, { icon: ptIcon(i, closed ? -1 : last), draggable: true, autoPan: true }).addTo(markerLayer);
    m.on('dragend', () => {
      const ll = m.getLatLng(), next = pts.slice();
      next[i] = { lat: ll.lat, lng: ll.lng };
      if (closed && i === 0) next[last] = next[0];
      setPts(next);
    });
    const btn = document.createElement('button');
    btn.textContent = 'Punt verwijderen';
    btn.onclick = () => {
      map.closePopup();
      let next = pts.filter((_, k) => k !== i);
      if (closed && i === 0) next = next.slice(0, -1);
      setPts(next);
    };
    m.bindPopup(btn, { closeButton: false, offset: [0, -8] });
  });
}
function draw() {
  routeLayer.clearLayers();
  const s = stats();
  const has = s.c.length > 1;
  if (has) {
    const ll = s.c.map(p => [p[0], p[1]]);
    L.polyline(ll, { color: '#ffffff', weight: 9, opacity: 0.95, interactive: false }).addTo(routeLayer);
    L.polyline(ll, { color: '#d42027', weight: 5, interactive: false }).addTo(routeLayer);
  }
  $('#hint').hidden = pts.length > 0;
  $('#stats').hidden = pts.length === 0;
  $('#sKm').textContent = s.km.toFixed(s.km < 10 ? 2 : 1).replace('.', ',');
  const min = Math.round(s.hours * 60);
  $('#sTime').textContent = Math.floor(min / 60) + ':' + String(min % 60).padStart(2, '0');
  $('#sUp').textContent = s.up === null ? '–' : s.up;
  const straight = segs.filter(x => x.straight).length;
  $('#warn').hidden = !straight;
  if (straight) $('#warn').textContent = 'Voor ' + straight + (straight === 1 ? ' stuk' : ' stukken') +
    ' is geen pad gevonden (of er is geen verbinding). Dat deel is een rechte lijn.';
  drawProfile(s);
  updateButtons();
}
function updateButtons() {
  const n = pts.length, closed = n > 2 && same(pts[0], pts[n - 1]);
  $('#undoBtn').disabled = history.length === 0;
  $('#closeBtn').disabled = n < 2 || closed;
  $('#revBtn').disabled = n < 2;
  $('#saveBtn').disabled = n < 2;
  $('#gpxBtn').disabled = n < 2;
  $('#clearBtn').disabled = n === 0;
}

/* ---------- Hoogteprofiel ---------- */
let prof = null;
function drawProfile(s) {
  const cv = $('#profile');
  if (s.up === null) { cv.hidden = true; prof = null; return; }
  cv.hidden = false;
  const css = getComputedStyle(document.documentElement);
  const w = cv.clientWidth, h = 64, dpr = window.devicePixelRatio || 1;
  cv.width = w * dpr; cv.height = h * dpr;
  const g = cv.getContext('2d');
  g.scale(dpr, dpr);
  const el = s.c.map(p => p[2]);
  let lo = Math.min(...el), hi = Math.max(...el);
  if (hi - lo < 20) { const m = (hi + lo) / 2; lo = m - 10; hi = m + 10; }
  const x = i => s.cum[i] / s.km * w, y = e => h - 14 - (e - lo) / (hi - lo) * (h - 22);
  g.beginPath(); g.moveTo(0, h);
  el.forEach((e, i) => g.lineTo(x(i), y(e)));
  g.lineTo(w, h); g.closePath();
  g.globalAlpha = 0.18; g.fillStyle = css.getPropertyValue('--accent'); g.fill(); g.globalAlpha = 1;
  g.beginPath();
  el.forEach((e, i) => i ? g.lineTo(x(i), y(e)) : g.moveTo(x(i), y(e)));
  g.strokeStyle = css.getPropertyValue('--accent'); g.lineWidth = 2; g.stroke();
  g.fillStyle = css.getPropertyValue('--muted'); g.font = '11px ' + css.getPropertyValue('--font');
  g.textBaseline = 'bottom';
  g.textAlign = 'left'; g.fillText('laagste ' + Math.round(Math.min(...el)) + ' m', 0, h);
  g.textAlign = 'right'; g.fillText('hoogste ' + Math.round(Math.max(...el)) + ' m', w, h);
  prof = { s, w };
}
function scrub(e) {
  if (!prof) return;
  const r = $('#profile').getBoundingClientRect();
  const target = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * prof.s.km;
  let i = prof.s.cum.findIndex(d => d >= target);
  if (i < 0) i = prof.s.c.length - 1;
  const p = prof.s.c[i];
  if (!scrubDot) scrubDot = L.circleMarker([p[0], p[1]], { radius: 8, color: '#fff', weight: 3, fillColor: '#1f6b4a', fillOpacity: 1, interactive: false });
  scrubDot.setLatLng([p[0], p[1]]).addTo(map);
  toast(prof.s.cum[i].toFixed(1).replace('.', ',') + ' km · ' + Math.round(p[2]) + ' m hoogte', 1500);
}
$('#profile').addEventListener('pointerdown', scrub);
$('#profile').addEventListener('pointermove', e => { if (e.buttons || e.pointerType === 'touch') scrub(e); });
$('#profile').addEventListener('pointerup', () => setTimeout(() => scrubDot && scrubDot.remove(), 1500));

/* ---------- Bediening ---------- */
let drawing = true;
map.on('click', e => {
  $('#results').hidden = true;
  if (!drawing) return;
  if (!BELGIUM.pad(0.1).contains(e.latlng)) { toast('Dit punt ligt buiten België.'); return; }
  setPts(pts.concat({ lat: e.latlng.lat, lng: e.latlng.lng }));
});
$('#drawBtn').onclick = () => {
  drawing = !drawing;
  $('#drawBtn').setAttribute('aria-pressed', drawing);
  toast(drawing ? 'Tekenen aan: tik op de kaart om punten toe te voegen.' : 'Tekenen uit: je kunt de kaart vrij bekijken.');
};
$('#undoBtn').onclick = () => { if (history.length) setPts(JSON.parse(history.pop()), false); };
$('#closeBtn').onclick = () => setPts(pts.concat({ ...pts[0] }));
$('#revBtn').onclick = () => setPts(pts.slice().reverse());
let clearArmed = 0;
$('#clearBtn').onclick = () => {
  if (Date.now() - clearArmed < 3000) { clearArmed = 0; $('#clearBtn').textContent = 'Wissen'; setPts([]); return; }
  clearArmed = Date.now();
  $('#clearBtn').textContent = 'Zeker wissen?';
  setTimeout(() => { $('#clearBtn').textContent = 'Wissen'; }, 3000);
};

let toastTimer;
function toast(msg, ms = 3200) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

function openSheet(id) { $('#scrim').hidden = false; $(id).hidden = false; }
function closeSheets() { $('#scrim').hidden = true; document.querySelectorAll('.sheet').forEach(s => { s.hidden = true; }); }
$('#scrim').onclick = closeSheets;
document.querySelectorAll('.close-sheet').forEach(b => { b.onclick = closeSheets; });

/* ---------- Kaartlagen en tempo ---------- */
$('#layersBtn').onclick = () => {
  document.querySelector('input[name="base"][value="' + baseName + '"]').checked = true;
  $('#trails').checked = map.hasLayer(trails);
  $('#speed').value = speed;
  $('#speedVal').textContent = String(speed).replace('.', ',');
  openSheet('#layerSheet');
};
document.querySelectorAll('input[name="base"]').forEach(r => {
  r.onchange = () => {
    map.removeLayer(bases[baseName]);
    baseName = r.value;
    bases[baseName].addTo(map).bringToBack();
    store.set('base', baseName);
  };
});
$('#trails').onchange = e => {
  if (e.target.checked) trails.addTo(map); else map.removeLayer(trails);
  store.set('trails', e.target.checked);
};
$('#speed').oninput = e => {
  speed = +e.target.value;
  $('#speedVal').textContent = String(speed).replace('.', ',');
  store.set('speed', speed);
  draw();
};

/* ---------- Mijn locatie ---------- */
let meMarker = null, meCircle = null, watchId = null, lastFix = null, follow = false;
function onFix(pos) {
  lastFix = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  if (!meMarker) {
    meCircle = L.circle(lastFix, { radius: pos.coords.accuracy, color: '#1a73e8', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(map);
    meMarker = L.marker(lastFix, { icon: L.divIcon({ className: '', html: '<div class="me"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }), interactive: false, zIndexOffset: -100 }).addTo(map);
  }
  meMarker.setLatLng(lastFix);
  meCircle.setLatLng(lastFix).setRadius(pos.coords.accuracy);
  if (follow) map.setView(lastFix, Math.max(map.getZoom(), 15));
}
function startGps() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('geen gps'));
    if (lastFix) return resolve(lastFix);
    navigator.geolocation.getCurrentPosition(p => { onFix(p); resolve(lastFix); }, reject, { enableHighAccuracy: true, timeout: 15000 });
    if (watchId === null) watchId = navigator.geolocation.watchPosition(onFix, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
  });
}
const gpsError = () => toast('Locatie niet beschikbaar. Geef de app toegang via Instellingen > Privacy > Locatievoorzieningen.', 5000);
$('#locBtn').onclick = async () => {
  follow = !follow;
  $('#locBtn').setAttribute('aria-pressed', follow);
  if (!follow) return;
  try { const p = await startGps(); map.setView(p, Math.max(map.getZoom(), 15)); }
  catch { follow = false; $('#locBtn').setAttribute('aria-pressed', false); gpsError(); }
};
map.on('dragstart', () => { follow = false; $('#locBtn').setAttribute('aria-pressed', false); });

/* ---------- Zoeken ---------- */
let searchTimer, searchSeq = 0;
async function search(q) {
  const seq = ++searchSeq, ul = $('#results');
  try {
    const list = await getJson('https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=be&limit=6&accept-language=nl&q=' + encodeURIComponent(q));
    if (seq !== searchSeq) return;
    ul.innerHTML = '';
    if (!list.length) { const li = document.createElement('li'); li.textContent = 'Niets gevonden in België.'; ul.append(li); }
    list.forEach(r => {
      const li = document.createElement('li'), parts = r.display_name.split(', ');
      li.textContent = parts[0];
      const sm = document.createElement('small'); sm.textContent = parts.slice(1, 4).join(', ');
      li.append(sm);
      li.onclick = () => { ul.hidden = true; $('#q').blur(); map.setView([+r.lat, +r.lon], 15); };
      ul.append(li);
    });
    ul.hidden = false;
  } catch {
    if (seq === searchSeq) toast('Zoeken lukt nu niet. Controleer je internetverbinding.');
  }
}
$('#q').addEventListener('input', e => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (q.length < 3) { $('#results').hidden = true; return; }
  searchTimer = setTimeout(() => search(q), 450);
});
$('#q').addEventListener('keydown', e => { if (e.key === 'Enter' && e.target.value.trim()) { clearTimeout(searchTimer); search(e.target.value.trim()); } });

/* ---------- Rondwandeling voorstellen ---------- */
$('#loopBtn').onclick = () => {
  const first = document.querySelector('input[name="loopFrom"][value="first"]');
  first.disabled = pts.length === 0;
  if (pts.length) first.checked = true;
  else if (first.checked) document.querySelector('input[name="loopFrom"][value="center"]').checked = true;
  openSheet('#loopSheet');
};
$('#loopKm').oninput = e => { $('#loopKmVal').textContent = e.target.value; };
$('#loopGo').onclick = async () => {
  const km = +$('#loopKm').value;
  const from = document.querySelector('input[name="loopFrom"]:checked').value;
  let start;
  if (from === 'first' && pts.length) start = pts[0];
  else if (from === 'gps') { try { start = await startGps(); } catch { gpsError(); return; } }
  else { const c = map.getCenter(); start = { lat: c.lat, lng: c.lng }; }
  closeSheets();
  history.push(JSON.stringify(pts));
  const bearing = Math.random() * 360, dir = Math.random() < 0.5 ? 1 : -1;
  let r = km / (2 * Math.PI) / 1.25; // paden kronkelen: begin met een kleinere cirkel
  for (let attempt = 0; attempt < 3; attempt++) {
    const c = dest(start, bearing, r);
    const loop = [start];
    for (let k = 1; k <= 3; k++) loop.push(dest(c, bearing + 180 + dir * k * 90, r));
    loop.push({ ...start });
    const v = ver + 1;
    await setPts(loop, false);
    if (v !== ver) return; // gebruiker deed intussen iets anders
    const got = stats().km;
    if (!got || Math.abs(got - km) / km < 0.1 || segs.some(s => s.straight)) break;
    r *= km / got;
  }
  const c = allCoords();
  if (c.length > 1) map.fitBounds(L.latLngBounds(c.map(p => [p[0], p[1]])), { paddingTopLeft: [30, 90], paddingBottomRight: [30, $('#panel').offsetHeight + 20] });
  toast('Voorstel klaar. Versleep punten om bij te sturen, of vraag een nieuw voorstel.');
};

/* ---------- Bewaren en laden ---------- */
const savedList = () => store.get('routes', []);
$('#saveBtn').onclick = () => {
  $('#saveName').value = 'Wandeling ' + new Date().toLocaleDateString('nl-BE', { day: 'numeric', month: 'long' });
  openSheet('#saveSheet');
  $('#saveName').select();
};
$('#saveGo').onclick = () => {
  const s = stats(), list = savedList();
  list.unshift({ id: Date.now(), name: $('#saveName').value.trim() || 'Wandeling', date: new Date().toISOString(), km: s.km, up: s.up, pts, segs });
  store.set('routes', list);
  closeSheets();
  toast(savedList().length === list.length ? 'Bewaard in Mijn wandelingen.' : 'Bewaren mislukt: de opslag van je toestel is vol of geblokkeerd.');
};
function renderSaved() {
  const list = savedList(), ul = $('#saved');
  ul.innerHTML = '';
  $('#savedEmpty').hidden = list.length > 0;
  list.forEach(r => {
    const li = document.createElement('li');
    const open = document.createElement('button'); open.className = 'open';
    const b = document.createElement('b'); b.textContent = r.name;
    const sm = document.createElement('small');
    sm.textContent = r.km.toFixed(1).replace('.', ',') + ' km' + (r.up === null ? '' : ' · ' + r.up + ' m stijgen') + ' · ' +
      new Date(r.date).toLocaleDateString('nl-BE');
    open.append(b, sm);
    open.onclick = () => {
      closeSheets();
      history.push(JSON.stringify(pts));
      r.pts.slice(0, -1).forEach((p, i) => { // bewaarde lijnen hergebruiken, ook zonder internet
        if (r.segs && r.segs[i] && !r.segs[i].straight) segCache.set([p.lat, p.lng, r.pts[i + 1].lat, r.pts[i + 1].lng].map(n => n.toFixed(5)).join(','), r.segs[i]);
      });
      setPts(r.pts, false).then(() => {
        const c = allCoords();
        if (c.length > 1) map.fitBounds(L.latLngBounds(c.map(p => [p[0], p[1]])), { paddingTopLeft: [30, 90], paddingBottomRight: [30, $('#panel').offsetHeight + 20] });
      });
    };
    const del = document.createElement('button'); del.className = 'del'; del.textContent = 'Verwijder';
    del.onclick = () => {
      if (del.dataset.armed) { store.set('routes', savedList().filter(x => x.id !== r.id)); renderSaved(); }
      else { del.dataset.armed = '1'; del.textContent = 'Zeker?'; }
    };
    li.append(open, del);
    ul.append(li);
  });
}
$('#menuBtn').onclick = () => { renderSaved(); openSheet('#listSheet'); };

/* ---------- GPX ---------- */
function gpx(name) {
  const esc = t => t.replace(/[<>&"]/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[ch]));
  const trk = allCoords().map(p => '<trkpt lat="' + p[0].toFixed(6) + '" lon="' + p[1].toFixed(6) + '">' +
    (p.length > 2 ? '<ele>' + p[2].toFixed(1) + '</ele>' : '') + '</trkpt>').join('\n');
  return '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Wandelplanner België" xmlns="http://www.topografix.com/GPX/1/1">\n' +
    '<trk><name>' + esc(name) + '</name><trkseg>\n' + trk + '\n</trkseg></trk>\n</gpx>\n';
}
$('#gpxBtn').onclick = async () => {
  const name = 'Wandeling ' + stats().km.toFixed(1).replace('.', ',') + ' km';
  const file = new File([gpx(name)], 'wandeling.gpx', { type: 'application/gpx+xml' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: name }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file); a.download = 'wandeling.gpx';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

/* ---------- Start ---------- */
window.addEventListener('resize', () => draw());
const draft = store.get('draft', []);
if (Array.isArray(draft) && draft.length) setPts(draft, false); else refresh();

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
window.__wandel = { stats, gpx, get pts() { return pts; } }; // voor tests
})();
