/* Homeward — a single, unbroken fall from orbit to the ground beneath your feet. */

const maplibregl = window.maplibregl;
const $ = (id) => document.getElementById(id);
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const IMPERIAL = /^en-(US|LR|MM)\b/i.test(navigator.language || '');
const LANG = (navigator.language || 'en').split('-')[0];

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';
const IMAGERY = `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`;
const PLACES = `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`;
const ATTRIB = 'Imagery © <a href="https://www.esri.com">Esri</a>, Maxar, Earthstar Geographics · Places © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const EARTH_C = 40075016.686;      // equatorial circumference, metres
const ORBIT_ZOOM = innerWidth < 720 ? 0.9 : 1.7;
const MERC_MAX = 85.051129;
const NIGHT_MAX = 0.66;   // darkest the night side gets
const NIGHT_CORNERS = [[-180, MERC_MAX], [180, MERC_MAX], [180, -MERC_MAX], [-180, -MERC_MAX]];
const BASE_TILE_MAX = 19;          // Esri World Imagery is global to tile z19
const isPhone = () => innerWidth < 720;
/** Keep the beacon in the open part of the screen, clear of the landing card. */
const landingPadding = () => isPhone() ? { top: 60, bottom: 200, left: 0, right: 0 } : { top: 0, bottom: 60, left: 0, right: Math.min(440, innerWidth * 0.35) };
const NO_PADDING = { top: 0, bottom: 0, left: 0, right: 0 };

/**
 * How much do we actually know? Everything downstream (names, camera, beacon,
 * card) stops at this level, so an approximate fix never pretends to be an address.
 *   spot    – a specific place (device fix or shared pin)
 *   city    – IP geolocation, or a coarse device fix
 *   region  – province/state level
 *   country – country only
 *   world   – nothing but the clock's time zone
 */
const LEVELS = ['world', 'country', 'region', 'city', 'spot'];
function precisionOf(loc) {
  if (!loc) return 'world';
  if (loc.source === 'tz') return 'world';
  const a = loc.accuracy ?? Infinity;
  if (a <= 300) return 'spot';
  if (a <= 40_000) return 'city';
  if (a <= 300_000) return 'region';
  if (a <= 1_500_000) return 'country';
  return 'world';
}
const knows = (loc, level) => LEVELS.indexOf(precisionOf(loc)) >= LEVELS.indexOf(level);

/** Only the names the precision can vouch for. */
function knownPlace(p = {}, loc = state.home) {
  return {
    continent: p.continent,
    country: knows(loc, 'country') ? p.country : undefined,
    region: knows(loc, 'region') ? p.region : undefined,
    city: knows(loc, 'city') ? p.city : undefined,
    hood: knows(loc, 'spot') ? p.hood : undefined,
    ocean: knows(loc, 'spot') ? p.ocean : undefined,
  };
}
const tzPlace = () => (Intl.DateTimeFormat().resolvedOptions().timeZone || '').split('/').pop().replace(/_/g, ' ');

const state = {
  home: null,          // { lat, lon, accuracy, source: 'gps'|'ip'|'tz'|'shared' }
  place: {},           // reverse-geocoded names
  phase: 'intro',      // intro | flying | landed | orbit | away
  flight: 0,           // flight token; bumping it cancels a pending choreography
  finalZoom: 18,
  gpsDenied: false,
  shared: null,
  marker: null,
  drift: true,
  lastAlt: Infinity,
  titleStage: -1,
};

/* ------------------------------------------------------------------ */
/* Starfield                                                           */
/* ------------------------------------------------------------------ */
const stars = (() => {
  const cv = $('stars'), cx = cv.getContext('2d');
  let list = [], w = 0, h = 0, dpr = 1, offset = 0, on = true;
  function seed() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = cv.width = innerWidth * dpr; h = cv.height = innerHeight * dpr;
    const n = Math.round((innerWidth * innerHeight) / 1600);
    list = [];
    for (let i = 0; i < n; i++) {
      // a third of the stars crowd into a soft diagonal band: a hint of the Milky Way
      let x = Math.random(), y = Math.random();
      if (i % 3 === 0) { const t = Math.random(); x = t; y = 0.15 + t * 0.7 + (Math.random() - 0.5) * 0.18 * Math.random(); }
      const big = Math.random() < 0.025;
      list.push({ x, y, r: (big ? 1.4 + Math.random() : 0.35 + Math.random() * 0.8) * dpr,
        a: 0.25 + Math.random() * 0.75, tw: Math.random() * Math.PI * 2, sp: 0.4 + Math.random() * 1.6,
        hue: Math.random() < 0.15 ? (Math.random() < 0.5 ? '200,220,255' : '255,225,190') : '255,255,255' });
    }
  }
  function frame(t) {
    if (on) {
      cx.clearRect(0, 0, w, h);
      const band = cx.createLinearGradient(0, h * 0.1, w, h * 0.9);
      band.addColorStop(0, 'rgba(60,80,140,0)'); band.addColorStop(0.5, 'rgba(90,100,160,0.07)'); band.addColorStop(1, 'rgba(60,80,140,0)');
      cx.fillStyle = band; cx.fillRect(0, 0, w, h);
      for (const s of list) {
        const x = ((s.x * w + offset * dpr) % w + w) % w;
        const a = s.a * (0.65 + 0.35 * Math.sin(t / 1000 * s.sp + s.tw));
        cx.beginPath(); cx.arc(x, s.y * h, s.r, 0, 6.283);
        cx.fillStyle = `rgba(${s.hue},${a})`; cx.fill();
      }
    }
    requestAnimationFrame(frame);
  }
  addEventListener('resize', seed);
  seed(); requestAnimationFrame(frame);
  return {
    pan(lng) { offset = -lng * 3; },
    show(v) { if (v !== on) { on = v; cv.style.opacity = v ? 1 : 0; } },
  };
})();

/* ------------------------------------------------------------------ */
/* The map                                                             */
/* ------------------------------------------------------------------ */
const tzGuess = (() => {
  // Before any network call, the clock already tells us roughly which meridian you live near.
  const lon = Math.max(-170, Math.min(170, -new Date().getTimezoneOffset() / 60 * 15));
  return { lat: 25, lon };
})();

const map = new maplibregl.Map({
  container: 'map',
  center: [tzGuess.lon - 70, 18],
  zoom: ORBIT_ZOOM,
  maxZoom: 21.5,
  maxPitch: 70,
  attributionControl: false,
  canvasContextAttributes: { antialias: true },
  style: {
    version: 8,
    projection: { type: 'globe' },
    sky: {
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 5, 1, 8, 0],
      'sky-color': '#0b1d3f', 'horizon-color': '#a9d8ff', 'fog-color': '#cfe6ff',
      'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.2,
    },
    light: { anchor: 'viewport', position: [1.5, 0, 0] },   // neutral: real day and night come from the terminator layer
    sources: {
      sat: { type: 'raster', tiles: [IMAGERY], tileSize: 256, maxzoom: BASE_TILE_MAX, attribution: ATTRIB },
      places: { type: 'raster', tiles: [PLACES], tileSize: 256, maxzoom: 19 },
      night: { type: 'image', url: nightImage(new Date()), coordinates: NIGHT_CORNERS },
      caps: { type: 'geojson', data: polarCaps(new Date()) },
      accuracy: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
    },
    layers: [
      { id: 'sat', type: 'raster', source: 'sat', paint: { 'raster-fade-duration': 250, 'raster-saturation': 0.08, 'raster-contrast': 0.06 } },
      // Imagery (like any Web Mercator source) stops at ±85°; without this the globe smears the last pixel row into a striped disc at each pole.
      { id: 'caps', type: 'fill', source: 'caps', paint: { 'fill-color': ['get', 'color'], 'fill-antialias': false } },
      { id: 'caps-night', type: 'fill', source: 'caps', maxzoom: 7,
        paint: { 'fill-color': '#020611', 'fill-antialias': false,   // same fade curve as the night raster
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 0, ['get', 'shade'], 3, ['*', ['get', 'shade'], 0.85], 5.5, ['*', ['get', 'shade'], 0.35], 7, 0] } },
      { id: 'night', type: 'raster', source: 'night', maxzoom: 7,
        paint: { 'raster-fade-duration': 0, 'raster-resampling': 'linear',
          'raster-opacity': ['interpolate', ['linear'], ['zoom'], 0, 1, 3, 0.85, 5.5, 0.35, 7, 0] } },
      { id: 'places', type: 'raster', source: 'places', layout: { visibility: 'none' }, paint: { 'raster-opacity': 0.92 } },
      { id: 'acc-fill', type: 'fill', source: 'accuracy', paint: { 'fill-color': '#ffcf8a', 'fill-opacity': 0.08 } },
      { id: 'acc-line', type: 'line', source: 'accuracy', paint: { 'line-color': '#ffcf8a', 'line-opacity': 0.7, 'line-width': 1.5, 'line-dasharray': [2, 2] } },
    ],
  },
});
map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right');
map.on('move', onMove);
setInterval(() => {
  const now = new Date();
  map.getSource('night')?.updateImage({ url: nightImage(now), coordinates: NIGHT_CORNERS });
  map.getSource('caps')?.setData(polarCaps(now));
}, 60_000);

/**
 * Night as a smooth shadow: every pixel's darkness follows the Sun's elevation there,
 * fading from just above the horizon down through astronomical twilight. Drawn in Web
 * Mercator rows so the image lines up exactly with the map; there are no edges to see.
 */
/** Sun-elevation → shadow strength (0 day … 1 deep night), shared by the night image and the caps. */
function nightAlpha(elevDeg) {
  const t = Math.min(1, Math.max(0, (2 - elevDeg) / 16));   // 0 at +2°, 1 at −14°
  return t * t * (3 - 2 * t);
}

/** Solid caps over both poles, coloured like the surrounding imagery and shaded for day or night. */
function polarCaps(date) {
  const { lat: dec } = subsolarPoint(date);
  const cap = (edge, pole, rgb, elev) => {
    const ring = [];
    for (let lon = -180; lon <= 180; lon += 5) ring.push([lon, edge]);
    ring.push([180, pole], [-180, pole], ring[0]);
    return { type: 'Feature', properties: { color: `rgb(${rgb.join(',')})`, shade: nightAlpha(elev) * NIGHT_MAX }, geometry: { type: 'Polygon', coordinates: [ring] } };
  };
  return { type: 'FeatureCollection', features: [
    cap(MERC_MAX - 0.02, 89.9, [10, 74, 96], dec),         // Arctic Ocean
    cap(-(MERC_MAX - 0.02), -89.9, [222, 230, 236], -dec), // Antarctic ice sheet
  ] };
}

function nightImage(date) {
  const W = 1024, H = 1024, r = Math.PI / 180;
  const { lat: dec, lon: sLon } = subsolarPoint(date);
  const sd = Math.sin(dec * r), cd = Math.cos(dec * r);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const cx = cv.getContext('2d'), img = cx.createImageData(W, H), d = img.data;
  const cosH = new Float32Array(W);
  for (let x = 0; x < W; x++) cosH[x] = Math.cos(((x + 0.5) / W * 360 - 180 - sLon) * r);
  const MAX = NIGHT_MAX * 255;
  for (let y = 0; y < H; y++) {
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (y + 0.5) / H)));
    const a = Math.sin(lat) * sd, b = Math.cos(lat) * cd;
    for (let x = 0; x < W; x++) {
      const elev = Math.asin(Math.max(-1, Math.min(1, a + b * cosH[x]))) / r;   // degrees
      const i = (y * W + x) * 4;
      d[i] = 2; d[i + 1] = 6; d[i + 2] = 17; d[i + 3] = nightAlpha(elev) * MAX;
    }
  }
  cx.putImageData(img, 0, 0);
  return cv.toDataURL('image/png');
}
function subsolarPoint(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const N = (date - start) / 864e5;                       // fractional day of year
  const B = 2 * Math.PI * (N - 81) / 364;
  const eot = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B); // minutes
  const dec = 23.44 * Math.sin(2 * Math.PI * (284 + N) / 365);
  const utcH = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const lon = ((-15 * (utcH - 12 + eot / 60)) + 540) % 360 - 180;
  return { lat: dec, lon };
}

/* ------------------------------------------------------------------ */
/* Altitude, altimeter and the story told on the way down              */
/* ------------------------------------------------------------------ */
function altitudeMeters() {
  const lat = map.getCenter().lat;
  const mpp = EARTH_C * Math.cos(lat * Math.PI / 180) / (512 * 2 ** map.getZoom());
  let fov = map.transform?.fov ?? 36.87;
  if (!(fov > 3)) fov = 36.87;                      // guard against API differences (radians/undefined)
  fov *= Math.PI / 180;
  return mpp * (map.getCanvas().clientHeight / 2) / Math.tan(fov / 2);
}
function fmtAlt(m) {
  if (IMPERIAL) {
    const ft = m * 3.28084, mi = m / 1609.344;
    return mi >= 10 ? `${Math.round(mi).toLocaleString()} mi` : mi >= 1 ? `${mi.toFixed(1)} mi` : `${Math.round(ft).toLocaleString()} ft`;
  }
  return m >= 10_000 ? `${Math.round(m / 1000).toLocaleString()} km` : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

const ALT_TOP = 40_000_000, ALT_BOTTOM = 40;
const altPos = (m) => Math.min(1, Math.max(0, (Math.log10(ALT_TOP) - Math.log10(Math.max(m, 1))) / (Math.log10(ALT_TOP) - Math.log10(ALT_BOTTOM))));
const MILESTONES = [
  { alt: 35_786_000, label: 'Geostationary', text: 'Passing the ring of geostationary satellites, 35,786 km up' },
  { alt: 408_000, label: 'ISS', text: 'Passing the orbit of the International Space Station' },
  { alt: 100_000, label: 'Kármán line', text: 'Crossing the Kármán line. Welcome back to the atmosphere' },
  { alt: 11_000, label: 'Airliners', text: 'Dropping below the cruising height of airliners' },
  { alt: 8_849, label: 'Everest', tick: false, text: 'Lower than the summit of Everest now' },
  { alt: 2_000, label: 'Clouds', text: 'Through the clouds' },
  { alt: 828, label: 'Burj Khalifa', text: 'Level with the top of the world’s tallest building' },
  { alt: 120, label: 'Treetops', text: 'Nearly there' },
];
(function buildAltimeter() {
  const box = $('alt-marks');
  for (const m of MILESTONES) {
    const el = document.createElement('div');
    if (m.tick === false) el.hidden = true;   // too close to its neighbour on the scale; it still gets a caption
    el.className = 'alt-mark'; el.textContent = m.label; el.style.top = `${altPos(m.alt) * 100}%`;
    m.el = el; box.appendChild(el);
  }
})();

function onMove() {
  const c = map.getCenter(), z = map.getZoom(), alt = altitudeMeters();
  stars.pan(c.lng); stars.show(z < 6.5);
  $('alt-value').textContent = fmtAlt(alt);
  $('alt-needle').style.top = `${altPos(alt) * 100}%`;
  $('coords').textContent = `${fmtLat(c.lat)} · ${fmtLon(c.lng)}`;
  sound.altitude(alt);

  if (state.phase === 'flying') {
    for (const m of MILESTONES) {
      if (state.lastAlt > m.alt && alt <= m.alt) milestone(m.text);
      m.el.classList.toggle('passed', alt <= m.alt);
    }
    storyTitles(alt);
  }
  state.lastAlt = alt;
}
const fmtLat = (v) => `${Math.abs(v).toFixed(5)}° ${v >= 0 ? 'N' : 'S'}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(5)}° ${v >= 0 ? 'E' : 'W'}`;

let milestoneTimer;
function milestone(text) {
  const el = $('milestone');
  el.textContent = text; el.classList.add('show');
  clearTimeout(milestoneTimer);
  milestoneTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

let titleTimer;
function titleCard(kicker, main, hold = 3600) {
  const card = $('title-card');
  card.classList.remove('show');
  clearTimeout(titleTimer);
  setTimeout(() => {
    $('title-kicker').textContent = kicker || '';
    $('title-main').textContent = main || '';
    card.classList.add('show');
    titleTimer = setTimeout(() => card.classList.remove('show'), hold);
  }, 450);
}

/** As we fall, name each layer of "where": planet, country, region, city, neighbourhood. */
const shownTitles = new Set();
function storyTitles(alt) {
  const p = knownPlace(state.place);
  const stages = [
    { alt: 9_000_000, kicker: 'The third planet from the Sun', main: 'Earth' },
    { alt: 4_500_000, kicker: p.continent, main: p.country || p.ocean },
    { alt: 450_000, kicker: p.country, main: p.region },
    { alt: 40_000, kicker: p.region || p.country, main: p.city },
    { alt: 2_500, kicker: p.city, main: p.hood },
  ];
  let idx = -1;
  stages.forEach((s, i) => { if (alt <= s.alt) idx = i; });
  if (idx <= state.titleStage) return;
  state.titleStage = idx;
  const s = stages[idx];
  if (!s.main || shownTitles.has(s.main)) return;   // a city-state can be its own country, region and city
  shownTitles.add(s.main);
  titleCard(s.kicker && s.kicker !== s.main ? s.kicker : '', s.main);
}

/* ------------------------------------------------------------------ */
/* Finding you                                                         */
/* ------------------------------------------------------------------ */
function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}
async function getJSON(url, ms = 6000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctl.signal });
    if (!r.ok) throw new Error(r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

async function ipLocate() {
  const providers = [
    getJSON('https://ipwho.is/').then((j) => {
      if (!j.success) throw new Error('ipwho');
      return { lat: j.latitude, lon: j.longitude, city: j.city, region: j.region, country: j.country, continent: j.continent };
    }),
    getJSON('https://get.geojs.io/v1/ip/geo.json').then((j) => ({
      lat: +j.latitude, lon: +j.longitude, city: j.city, region: j.region, country: j.country,
    })),
  ];
  const r = await Promise.any(providers);
  if (!isFinite(r.lat) || !isFinite(r.lon)) throw new Error('bad ip fix');
  // IP geolocation has no error bars; size the uncertainty by the finest name it resolved.
  const accuracy = r.city ? 25_000 : r.region ? 200_000 : r.country ? 800_000 : 2_000_000;
  return { ...r, accuracy, source: 'ip' };
}

let watchId = null;
function gpsWatch(onFix, onDenied) {
  if (!('geolocation' in navigator)) { onDenied?.('unsupported'); return; }
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  let best = Infinity;
  const stopAt = setTimeout(() => { if (watchId !== null) navigator.geolocation.clearWatch(watchId); watchId = null; }, 45_000);
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const { latitude: lat, longitude: lon, accuracy } = pos.coords;
      if (accuracy >= best) return;            // only ever improve
      best = accuracy;
      onFix({ lat, lon, accuracy, source: 'gps' });
      if (accuracy <= 15) { navigator.geolocation.clearWatch(watchId); watchId = null; clearTimeout(stopAt); }
    },
    (err) => { if (err.code === err.PERMISSION_DENIED) { state.gpsDenied = true; onDenied?.('denied'); } },
    { enableHighAccuracy: true, maximumAge: 0, timeout: 30_000 },
  );
}

function parseShared() {
  const m = location.hash.match(/^#@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,~(\d+))?/);
  if (!m) return null;
  const lat = +m[1], lon = +m[2];
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon, accuracy: m[3] ? Math.min(+m[3], 2_000_000) : 10, source: 'shared' };
}

async function begin() {
  idleSpin(true);
  const introStarted = performance.now();
  const minIntro = REDUCED ? 600 : 3200;
  const status = (t) => { $('intro-status').textContent = t; };

  state.shared = parseShared();
  if (state.shared) {
    status('Someone saved a place for you…');
    await sleep(minIntro);
    return descend(state.shared);
  }

  let gps = null, ip = null, launched = false;
  const launch = (loc) => {
    if (launched) return;
    launched = true;
    descend(loc);
  };
  const tryLaunch = () => {
    if (launched || performance.now() - introStarted < minIntro) return;
    if (gps) launch(gps); else if (ip) launch(ip);
  };

  gpsWatch((fix) => {
    gps = fix;
    signal(fix);
    if (launched) retarget(fix); else tryLaunch();
  }, () => { if (!launched) status('Using your connection to find you…'); refreshPrecision(); });

  ipLocate().then((fix) => {
    ip = fix;
    if (!gps) { signal(fix); status(`Signal found near ${fix.city || fix.country || 'you'}…`); }
    tryLaunch();
  }).catch(() => {});

  await sleep(minIntro);
  tryLaunch();
  // No signal at all after a while: land where the clock suggests and keep listening.
  await sleep(6000);
  if (!launched) launch({ ...tzGuess, accuracy: 2_000_000, source: 'tz' });
}

function signal(fix) {
  const el = $('signal');
  el.classList.toggle('precise', fix.source === 'gps' || fix.source === 'shared');
  $('signal-text').textContent =
    fix.source === 'gps' ? `Device location · ±${fmtDist(fix.accuracy)}` :
    fix.source === 'ip' ? 'Network location · approximate' :
    fix.source === 'shared' ? 'Shared place' : 'Time-zone guess';
}
const fmtDist = (m) => IMPERIAL ? (m > 1609 ? `${(m / 1609.344).toFixed(1)} mi` : `${Math.round(m * 3.28084)} ft`) : (m > 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

/* ------------------------------------------------------------------ */
/* Choreography                                                        */
/* ------------------------------------------------------------------ */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let spinRaf = null;
function idleSpin(on) {
  cancelAnimationFrame(spinRaf); spinRaf = null;
  if (!on || REDUCED) return;
  let last = performance.now();
  const step = (t) => {
    const dt = t - last; last = t;
    if (!map.isMoving()) {
      const c = map.getCenter();
      map.jumpTo({ center: [c.lng + Math.min(64, dt) * 0.004, c.lat] });
    }
    spinRaf = requestAnimationFrame(step);
  };
  spinRaf = requestAnimationFrame(step);
}

let driftRaf = null;
function drift(on) {
  state.drift = on;
  $('btn-spin').setAttribute('aria-pressed', String(on));
  cancelAnimationFrame(driftRaf); driftRaf = null;
  if (!on || REDUCED) return;
  let last = performance.now();
  const step = (t) => {
    const dt = Math.min(64, t - last); last = t;
    if (!map.isMoving()) map.setBearing(map.getBearing() + dt * 0.0022);
    driftRaf = requestAnimationFrame(step);
  };
  driftRaf = requestAnimationFrame(step);
}

/** Wrap a camera move in a promise that resolves when it ends (or is superseded). */
function camera(method, opts) {
  return new Promise((resolve) => {
    const token = state.flight;
    map.stop();
    map.once('moveend', () => resolve(token === state.flight));
    map[method]({ ...opts, essential: true });
  });
}

/** Deepest Esri tile level with real imagery above a point (contiguous from z12). */
async function deepestTile(lat, lon) {
  const tile = (z) => {
    const n = 2 ** z, r = Math.max(-85, Math.min(85, lat)) * Math.PI / 180;
    return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.asinh(Math.tan(r)) / Math.PI) / 2 * n)];
  };
  const levels = Array.from({ length: 12 }, (_, i) => 12 + i);   // 12..23
  const has = await Promise.all(levels.map(async (z) => {
    const [x, y] = tile(z);
    try {
      const j = await getJSON(`${ESRI}/World_Imagery/MapServer/tilemap/${z}/${y}/${x}/1/1`, 4000);
      return j?.data?.[0] === 1;
    } catch { return z <= BASE_TILE_MAX; }      // offline probe: trust the global coverage
  }));
  let best = 12;
  for (let i = 0; i < levels.length && has[i]; i++) best = levels[i];
  return best;
}

function useDeepImagery(maxTile) {
  if (map.getLayer('sat-deep')) map.removeLayer('sat-deep');
  if (map.getSource('sat-deep')) map.removeSource('sat-deep');
  if (maxTile <= BASE_TILE_MAX) return;
  map.addSource('sat-deep', { type: 'raster', tiles: [IMAGERY], tileSize: 256, minzoom: BASE_TILE_MAX + 1, maxzoom: maxTile });
  map.addLayer({ id: 'sat-deep', type: 'raster', source: 'sat-deep', minzoom: BASE_TILE_MAX - 0.4, paint: { 'raster-fade-duration': 300 } }, 'night');
}

/** Zoom at which a circle of the fix's accuracy fills the open part of the screen. */
function zoomToFit(loc) {
  const pad = landingPadding(), cv = map.getCanvas();
  const w = cv.clientWidth - pad.left - pad.right, h = cv.clientHeight - pad.top - pad.bottom;
  const span = 2 * Math.max(loc.accuracy || 0, 1) * 1.35;          // diameter plus a margin
  const mpp = span / Math.max(120, Math.min(w, h));
  return Math.log2(EARTH_C * Math.cos(loc.lat * Math.PI / 180) / (512 * mpp));
}
function landingCamera(loc, maxTile) {
  const deep = Math.max(11, Math.min(21, maxTile - 1 + 0.15));
  const spot = precisionOf(loc) === 'spot';
  const zoom = Math.max(ORBIT_ZOOM + 0.6, Math.min(deep, zoomToFit(loc)));
  return { center: [loc.lon, loc.lat], zoom, pitch: spot ? 48 : 0, bearing: spot ? -18 : 0, padding: landingPadding() };
}

async function descend(loc, { quick = false } = {}) {
  const token = ++state.flight;
  state.home = loc;
  state.phase = 'flying';
  state.titleStage = -1;
  shownTitles.clear();
  MILESTONES.forEach((m) => m.el.classList.remove('passed'));
  state.lastAlt = altitudeMeters();
  document.body.classList.add('flying');
  document.body.classList.remove('landed');
  $('intro').classList.add('gone');
  $('card').hidden = true; $('dock').hidden = true;
  idleSpin(false); drift(false);
  signal(loc);
  setAccuracy(loc);
  placeBeacon(loc, false);

  const spot = precisionOf(loc) === 'spot';
  const depth = spot ? deepestTile(loc.lat, loc.lon) : Promise.resolve(BASE_TILE_MAX);
  geocode(loc).then((p) => {
    if (token !== state.flight) return;
    state.place = p;
    if (state.phase === 'landed') fillCard();
  });

  // 1. turn the planet to face you
  if (!quick && map.getZoom() < 4) {
    const ok = await camera('easeTo', { center: [loc.lon, loc.lat], zoom: Math.max(ORBIT_ZOOM, 1.9), pitch: 0, bearing: 0, padding: NO_PADDING, duration: REDUCED ? 800 : 4200, easing: easeInOut });
    if (!ok) return;
  }
  // 2. the long fall
  const ok2 = await camera('flyTo', { center: [loc.lon, loc.lat], zoom: Math.min(16.4, landingCamera(loc, BASE_TILE_MAX).zoom), pitch: 0, bearing: 0, padding: spot ? NO_PADDING : landingPadding(), duration: REDUCED ? 2000 : quick ? 6000 : 15000, curve: 1.2, easing: easeInOutSoft });
  if (!ok2) return;
  // 3. touch down: as deep as the imagery goes for a real spot, or framing the whole area we know
  const maxTile = await depth;
  if (token !== state.flight) return;
  useDeepImagery(spot ? maxTile : BASE_TILE_MAX);
  const cam = landingCamera(loc, maxTile);
  state.finalZoom = cam.zoom;
  const ok3 = await camera('easeTo', { ...cam, duration: REDUCED ? 800 : 5200, easing: easeOutQuint });
  if (!ok3) return;
  land();
}

function land() {
  state.phase = 'landed';
  document.body.classList.remove('flying');
  document.body.classList.add('landed');
  placeBeacon(state.home, precisionOf(state.home) === 'spot');
  sound.chime();
  const [kicker, main] = landingTitle();
  titleCard(kicker, main, 4200);
  fillCard();
  $('card').hidden = false; $('dock').hidden = false;
  $('card').classList.toggle('collapsed', isPhone());
  $('card-toggle').setAttribute('aria-expanded', String(!isPhone()));
  drift(true);
}

function landingTitle() {
  const loc = state.home, p = knownPlace(state.place);
  if (loc.source === 'shared' && state.shared) return ['Someone wanted you to see this', precisionOf(loc) === 'spot' ? 'Here.' : (p.city || p.region || p.country || 'Around here.')];
  switch (precisionOf(loc)) {
    case 'spot': return [p.city || p.country || '', 'You are here.'];
    case 'city': return ['You are somewhere in', p.city || p.region || p.country || 'this area'];
    case 'region': return ['You are somewhere in', p.region || p.country || 'this region'];
    case 'country': return ['You are somewhere in', p.country || 'this country'];
    default: return ['Somewhere in the time zone of', tzPlace() || 'this part of the world'];
  }
}

/** A better fix arrived after we set off. */
function retarget(fix) {
  const prev = state.home;
  if (state.shared && prev?.source === 'shared') return;   // never yank a shared view away
  const moved = prev ? haversine(prev, fix) : Infinity;
  const sharper = !prev || LEVELS.indexOf(precisionOf(fix)) > LEVELS.indexOf(precisionOf(prev));
  const better = !prev || fix.accuracy < prev.accuracy / 1.5;
  if (prev && prev.source !== 'gps') toast(precisionOf(fix) === 'spot' ? `Precise fix acquired · ±${fmtDist(fix.accuracy)}` : `Device location · ±${fmtDist(fix.accuracy)}`);
  state.home = fix;
  setAccuracy(fix);
  refreshPrecision();
  if (state.phase === 'flying' && (moved > 25 || sharper)) return descend(fix, { quick: true });
  if (state.phase === 'landed' && (moved > 8 || sharper || better)) {
    const token = state.flight;
    placeBeacon(fix, precisionOf(fix) === 'spot');
    poem(fix);
    geocode(fix).then((p) => { if (token === state.flight) { state.place = p; fillCard(); } });
    const depth = precisionOf(fix) === 'spot' ? deepestTile(fix.lat, fix.lon) : Promise.resolve(BASE_TILE_MAX);
    depth.then((t) => {
      if (token !== state.flight) return;
      useDeepImagery(precisionOf(fix) === 'spot' ? t : BASE_TILE_MAX);
      const cam = landingCamera(fix, t);
      state.finalZoom = cam.zoom;
      map.easeTo({ ...cam, duration: 3200, essential: true });
    });
  }
}

function toOrbit() {
  if (!state.home || state.phase === 'intro') return;
  state.flight++;
  state.phase = 'orbit';
  drift(false);
  document.body.classList.remove('landed', 'flying');
  $('title-card').classList.remove('show');
  const c = state.home || tzGuess;
  map.flyTo({ center: [c.lon, Math.max(-50, Math.min(50, c.lat))], zoom: ORBIT_ZOOM, pitch: 0, bearing: 0, padding: NO_PADDING, duration: REDUCED ? 1000 : 7000, curve: 1.3, essential: true });
  map.once('moveend', () => { if (state.phase === 'orbit') { idleSpin(true); $('dock').hidden = false; } });
}

async function replay() {
  if (!state.home) return;
  if (state.shared && state.home.source !== 'shared') state.shared = null;
  const token = ++state.flight;
  drift(false);
  $('card').hidden = true;
  document.body.classList.remove('landed');
  state.phase = 'rewind';
  if (map.getZoom() > ORBIT_ZOOM + 0.5) {
    await camera('flyTo', { center: [state.home.lon - 40, Math.max(-40, Math.min(40, state.home.lat))], zoom: ORBIT_ZOOM, pitch: 0, bearing: 0, padding: NO_PADDING, duration: REDUCED ? 800 : 5000, curve: 1.3 });
  }
  if (token !== state.flight) return;
  descend(state.home);
}

const easeInOut = (t) => t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
const easeInOutSoft = (t) => 0.5 - Math.cos(Math.PI * t) / 2;
const easeOutQuint = (t) => 1 - (1 - t) ** 5;

function haversine(a, b) {
  const r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.sqrt(h));
}

/* ------------------------------------------------------------------ */
/* Marker & accuracy                                                   */
/* ------------------------------------------------------------------ */
function placeBeacon(loc, visible) {
  if (!state.marker) {
    const el = document.createElement('div');
    el.className = 'beacon';
    // the map positions the outer element with a transform, so animate an inner one
    el.innerHTML = '<div class="beacon-inner"><div class="ring"></div><div class="ring"></div><div class="ring"></div><div class="core"></div></div>';
    state.marker = new maplibregl.Marker({ element: el, pitchAlignment: 'map', rotationAlignment: 'map' });
  }
  state.marker.setLngLat([loc.lon, loc.lat]);
  const el = state.marker.getElement().firstElementChild;
  if (visible) {
    state.marker.addTo(map);
    el.classList.remove('arrive'); void el.offsetWidth; el.classList.add('arrive');
  } else state.marker.remove();
}

function setAccuracy(loc) {
  const src = map.getSource('accuracy');
  if (!src) return;
  if (!loc || loc.accuracy < 20 || loc.source === 'tz') {
    src.setData({ type: 'FeatureCollection', features: [] }); return;
  }
  const pts = [], R = 6_371_008.8, d = loc.accuracy / R, r = Math.PI / 180;
  const la = loc.lat * r, lo = loc.lon * r;
  for (let i = 0; i <= 96; i++) {
    const b = (i / 96) * 2 * Math.PI;
    const lat2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(b));
    const lon2 = lo + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(lat2));
    pts.push([lon2 / r, lat2 / r]);
  }
  src.setData({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [pts] } });
}

/* ------------------------------------------------------------------ */
/* Names, weather, ground                                              */
/* ------------------------------------------------------------------ */
async function geocode(loc) {
  const coarse = precisionOf(loc) !== 'spot';
  const [osm, bdc] = await Promise.allSettled([
    coarse ? Promise.reject(new Error('skip')) : getJSON(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${loc.lat}&lon=${loc.lon}&zoom=18&addressdetails=1&accept-language=${LANG}`, 7000),
    getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${loc.lat}&longitude=${loc.lon}&localityLanguage=${LANG}`, 7000),
  ]);
  if (precisionOf(loc) !== 'spot') {
    // An approximate fix: the coordinate is a centroid, not where anyone stands. Use the names
    // the locator itself reported, and only borrow coarser names from a reverse lookup.
    const b = bdc.value || {};
    return {
      continent: b.continent || loc.continent,
      country: loc.country || b.countryName,
      region: loc.region || (loc.source === 'ip' && loc.city ? undefined : b.principalSubdivision),
      city: loc.city || (loc.source === 'ip' ? undefined : b.city || b.locality),
    };
  }
  const a = osm.value?.address || {}, b = bdc.value || {};
  const ocean = (b.localityInfo?.informative || []).find((x) => /ocean|sea|gulf|bay/i.test(x.name || ''))?.name;
  const city = a.city || a.town || a.village || a.hamlet || a.municipality || b.city || b.locality || loc.city;
  let hood = a.neighbourhood || a.suburb || a.quarter || a.city_district || a.road;
  if (hood === city) hood = a.road;
  return {
    continent: b.continent || loc.continent,
    country: a.country || b.countryName || loc.country,
    region: a.state || a.province || a.region || b.principalSubdivision || loc.region,
    city,
    hood,
    road: a.road,
    ocean,
  };
}

const WMO = {
  0: ['Clear sky', '☀️', '🌙'], 1: ['Mostly clear', '🌤️', '🌙'], 2: ['Partly cloudy', '⛅', '☁️'], 3: ['Overcast', '☁️', '☁️'],
  45: ['Fog', '🌫️'], 48: ['Freezing fog', '🌫️'], 51: ['Light drizzle', '🌦️'], 53: ['Drizzle', '🌦️'], 55: ['Heavy drizzle', '🌧️'],
  56: ['Freezing drizzle', '🌧️'], 57: ['Freezing drizzle', '🌧️'], 61: ['Light rain', '🌦️'], 63: ['Rain', '🌧️'], 65: ['Heavy rain', '🌧️'],
  66: ['Freezing rain', '🌧️'], 67: ['Freezing rain', '🌧️'], 71: ['Light snow', '🌨️'], 73: ['Snow', '🌨️'], 75: ['Heavy snow', '❄️'],
  77: ['Snow grains', '🌨️'], 80: ['Showers', '🌦️'], 81: ['Showers', '🌧️'], 82: ['Violent showers', '⛈️'],
  85: ['Snow showers', '🌨️'], 86: ['Snow showers', '❄️'], 95: ['Thunderstorm', '⛈️'], 96: ['Thunderstorm, hail', '⛈️'], 99: ['Thunderstorm, hail', '⛈️'],
};

let clockTimer;
async function fillCard() {
  const loc = state.home, p = knownPlace(state.place), level = precisionOf(loc);
  const isShared = loc.source === 'shared';
  const main = p.hood || p.city || p.region || p.country || p.ocean ||
    (level === 'world' ? `${tzPlace() || 'Your'} time zone` : 'Somewhere on Earth');
  $('place-main').textContent = main;
  $('place-sub').textContent = [p.city, p.region, p.country].filter((x, i, arr) => x && x !== main && arr.indexOf(x) === i).join(', ') ||
    (level === 'spot' ? `${fmtLat(loc.lat)}, ${fmtLon(loc.lon)}` : `Within about ${fmtDist(loc.accuracy)}`);
  document.querySelector('.card-kicker').textContent = isShared ? (level === 'spot' ? 'A shared place' : 'A shared area') : (level === 'spot' ? 'You are here' : 'You are somewhere in');
  refreshPrecision();
  poem(loc);

  const unitT = IMPERIAL ? '&temperature_unit=fahrenheit' : '';
  getJSON(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code,is_day&daily=sunrise,sunset&timezone=auto&forecast_days=1${unitT}`)
    .then((w) => {
      const [label, day, night] = WMO[w.current.weather_code] || ['—', ''];
      const icon = w.current.is_day ? day : (night || day);
      $('f-weather').textContent = `${icon} ${Math.round(w.current.temperature_2m)}°${IMPERIAL ? 'F' : 'C'} · ${label}`;
      const hm = (s) => s?.slice(11, 16);
      $('f-sun').textContent = `${hm(w.daily.sunrise[0])} – ${hm(w.daily.sunset[0])}`;
      startClock(w.timezone);
    })
    .catch(() => { $('f-weather').textContent = '—'; startClock(Intl.DateTimeFormat().resolvedOptions().timeZone); });

  // Elevation of a centroid is meaningless; for an area show how wide the area is instead.
  if (level !== 'spot') {
    $('f-elev-k').textContent = 'Known to within';
    $('f-elev').textContent = `±${fmtDist(loc.accuracy)}`;
  } else getJSON(`https://api.open-meteo.com/v1/elevation?latitude=${loc.lat}&longitude=${loc.lon}`)
    .then((e) => {
      $('f-elev-k').textContent = 'Elevation';
      const m = e.elevation?.[0];
      if (m == null) return;
      $('f-elev').textContent = IMPERIAL ? `${Math.round(m * 3.28084).toLocaleString()} ft` : `${Math.round(m).toLocaleString()} m`;
    }).catch(() => {});

  antipode(loc);
}

function startClock(tz) {
  clearInterval(clockTimer);
  const fmt = (() => {
    try { return new Intl.DateTimeFormat(undefined, { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }); }
    catch { return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }); }
  })();
  const tick = () => { $('f-time').textContent = fmt.format(new Date()); };
  tick(); clockTimer = setInterval(tick, 1000);
}

function poem(loc) {
  const spin = 1674.4 * Math.cos(loc.lat * Math.PI / 180);
  const toPole = haversine(loc, { lat: loc.lat >= 0 ? 90 : -90, lon: 0 });
  const unit = (km) => IMPERIAL ? `${Math.round(km / 1.609).toLocaleString()} mph` : `${Math.round(km).toLocaleString()} km/h`;
  const dist = (m) => IMPERIAL ? `${Math.round(m / 1609.344).toLocaleString()} mi` : `${Math.round(m / 1000).toLocaleString()} km`;
  const who = loc.source === 'shared' ? (precisionOf(loc) === 'spot' ? 'this spot' : 'this area') : 'you';
  $('poem').innerHTML =
    `The ground under ${who} is turning at <b>${unit(spin)}</b> and racing around the Sun at <b>${unit(107_200)}</b>. ` +
    `It's <b>${dist(toPole)}</b> to the ${loc.lat >= 0 ? 'North' : 'South'} Pole. You'd never know any of it from down here.`;
}

function refreshPrecision() {
  const box = $('precision'), loc = state.home;
  if (!loc) return;
  const btn = $('btn-precise');
  box.hidden = false; btn.hidden = false;
  if (loc.source === 'shared') {
    $('precision-title').textContent = 'Not where you are';
    $('precision-body').textContent = 'This is a place someone shared with you.';
    btn.textContent = 'Find me instead';
  } else if (loc.source === 'gps') {
    if (loc.accuracy <= 100) { box.hidden = true; return; }
    const spot = precisionOf(loc) === 'spot';
    $('precision-title').textContent = spot ? `Landed within ±${fmtDist(loc.accuracy)}` : `Your device is unsure · ±${fmtDist(loc.accuracy)}`;
    $('precision-body').textContent = spot ? 'Your device is still sharpening its fix. Stepping outside helps.'
      : 'Rather than guess a street, we are showing the whole area it could be. This sharpens as your device gets a better fix.';
    btn.hidden = true;
  } else if (state.gpsDenied) {
    $('precision-title').textContent = 'Showing your area, not your street';
    $('precision-body').textContent = 'Location access is turned off for this site, so we stop at what your connection reveals. Allow it in your browser settings to land on your exact spot.';
    btn.textContent = 'Try again';
  } else {
    $('precision-title').textContent = 'Showing your area, not your street';
    $('precision-body').textContent = loc.source === 'tz'
      ? 'All we know so far is your time zone, so that is as close as we go.'
      : 'Your internet connection only reveals roughly where you are, so we stop at that instead of guessing a street.';
    btn.textContent = 'Land precisely';
  }
}

async function antipode(loc) {
  const a = { lat: -loc.lat, lon: loc.lon > 0 ? loc.lon - 180 : loc.lon + 180 };
  const box = $('antipode'), btn = $('btn-antipode');
  try {
    const b = await getJSON(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${a.lat}&longitude=${a.lon}&localityLanguage=${LANG}`, 6000);
    const ocean = (b.localityInfo?.informative || []).find((x) => /ocean|sea/i.test(x.name || ''))?.name;
    const land = [b.city || b.locality, b.countryName].filter(Boolean).join(', ');
    btn.textContent = `${b.countryName ? land : `the ${ocean || 'open ocean'}`} →`;
  } catch {
    btn.textContent = `${fmtLat(a.lat)}, ${fmtLon(a.lon)} →`;
  }
  btn.onclick = () => visit(a);
  box.hidden = false;
}

async function visit(a) {
  state.flight++;
  drift(false);
  state.phase = 'away';
  $('card').hidden = true;
  await camera('flyTo', { center: [a.lon, a.lat], zoom: 9, pitch: 30, bearing: 0, padding: NO_PADDING, duration: REDUCED ? 1500 : 9000, curve: 1.5 });
  const p = await geocode({ ...a });
  titleCard('The other side of the world', p.city || p.country || p.ocean || 'Open ocean', 4200);
  toast('Press Replay to fall home again');
}

/* ------------------------------------------------------------------ */
/* Sound: a slow pad in orbit, wind as the atmosphere thickens         */
/* ------------------------------------------------------------------ */
const sound = (() => {
  let ctx, master, wind, windFilter, on = false;
  function build() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
    const verb = ctx.createConvolver(); verb.buffer = impulse(3.5); verb.connect(master);
    const dry = ctx.createGain(); dry.gain.value = 0.5; dry.connect(master);
    // pad: an open fifth with a gently beating ninth
    const pad = ctx.createGain(); pad.gain.value = 0.05; pad.connect(verb); pad.connect(dry);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900; lp.connect(pad);
    [110, 164.81, 246.94, 220.6].forEach((f, i) => {
      const o = ctx.createOscillator(); o.type = i % 2 ? 'triangle' : 'sine'; o.frequency.value = f;
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.05 + i * 0.03;
      const lg = ctx.createGain(); lg.gain.value = 3; lfo.connect(lg); lg.connect(o.detune);
      o.connect(lp); o.start(); lfo.start();
    });
    // wind: brown noise through a moving band-pass
    const len = ctx.sampleRate * 4, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.5; }
    const src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    windFilter = ctx.createBiquadFilter(); windFilter.type = 'bandpass'; windFilter.Q.value = 0.8; windFilter.frequency.value = 400;
    wind = ctx.createGain(); wind.gain.value = 0;
    src.connect(windFilter); windFilter.connect(wind); wind.connect(verb); wind.connect(dry); src.start();
  }
  function impulse(sec) {
    const len = ctx.sampleRate * sec, b = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let c = 0; c < 2; c++) { const d = b.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** 3; }
    return b;
  }
  return {
    toggle() {
      on = !on;
      if (on && !ctx) build();
      ctx?.resume();
      master?.gain.setTargetAtTime(on ? 0.9 : 0, ctx.currentTime, 0.8);
      return on;
    },
    altitude(m) {
      if (!ctx || !on) return;
      // wind swells between the Kármán line and the clouds, then settles near the ground
      const p = altPos(m), atm = Math.max(0, Math.min(1, (p - 0.45) / 0.45));
      const g = state.phase === 'flying' ? Math.sin(atm * Math.PI) * 0.35 + 0.02 : 0.015;
      wind.gain.setTargetAtTime(g, ctx.currentTime, 0.4);
      windFilter.frequency.setTargetAtTime(250 + atm * 900, ctx.currentTime, 0.4);
    },
    chime() {
      if (!ctx || !on) return;
      const t = ctx.currentTime;
      [659.25, 987.77, 1318.5].forEach((f, i) => {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = f; o.type = 'sine';
        g.gain.setValueAtTime(0, t + i * 0.12); g.gain.linearRampToValueAtTime(0.08, t + i * 0.12 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.12 + 3.5);
        o.connect(g); g.connect(master); o.start(t + i * 0.12); o.stop(t + 4);
      });
    },
  };
})();

/* ------------------------------------------------------------------ */
/* UI wiring                                                           */
/* ------------------------------------------------------------------ */
let toastTimer;
function toast(text) {
  const el = $('toast');
  el.textContent = text; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

function toggleLabels() {
  const vis = map.getLayoutProperty('places', 'visibility') !== 'visible';
  map.setLayoutProperty('places', 'visibility', vis ? 'visible' : 'none');
  $('btn-labels').setAttribute('aria-pressed', String(vis));
}

function toggleSound() {
  const on = sound.toggle();
  $('btn-sound').setAttribute('aria-pressed', String(on));
  toast(on ? 'Sound on. Best with headphones' : 'Sound off');
}

async function share() {
  const loc = state.home; if (!loc) return;
  const spot = precisionOf(loc) === 'spot';
  // an approximate fix is shared as an area (and with fewer decimals): never as a fake exact pin
  const url = `${location.origin}${location.pathname}#@${loc.lat.toFixed(spot ? 6 : 3)},${loc.lon.toFixed(spot ? 6 : 3)}${spot ? '' : `,~${Math.round(loc.accuracy)}`}`;
  const kp = knownPlace(state.place);
  const name = kp.hood || kp.city || kp.region || kp.country || 'a place on Earth';
  try {
    if (navigator.share) { await navigator.share({ title: 'Homeward', text: `Fall from orbit to ${name}`, url }); return; }
    await navigator.clipboard.writeText(url);
    toast(spot ? 'Link copied. Whoever opens it will fall to this exact spot' : 'Link copied. It shares your area, not an exact spot');
  } catch (e) { if (e?.name !== 'AbortError') toast(url); }
}

function requestPrecise() {
  if (state.home?.source === 'shared') {
    state.shared = null;
    history.replaceState(null, '', location.pathname);
    toast('Finding you…');
    ipLocate().then((fix) => { if (state.home.source !== 'gps') { descend(fix, { quick: true }); } }).catch(() => {});
  } else {
    toast('Asking your device where it is…');
  }
  state.gpsDenied = false;
  gpsWatch((fix) => { signal(fix); retarget(fix); }, () => { refreshPrecision(); toast('Location access was declined'); });
}

$('btn-replay').onclick = replay;
$('btn-orbit').onclick = toOrbit;
$('btn-spin').onclick = () => drift(!state.drift);
$('btn-labels').onclick = toggleLabels;
$('btn-sound').onclick = toggleSound;
$('btn-share').onclick = share;
$('btn-info').onclick = () => $('about').showModal();
$('btn-precise').onclick = requestPrecise;
$('card-toggle').onclick = () => {
  const c = $('card').classList.toggle('collapsed');
  $('card-toggle').setAttribute('aria-expanded', String(!c));
};

// The person takes the controls: stop drifting, but let the ride finish if they only nudge it.
['mousedown', 'touchstart', 'wheel'].forEach((ev) =>
  map.getCanvas().addEventListener(ev, () => {
    if (state.phase === 'landed' && state.drift) drift(false);
    else if (state.phase === 'flying') { state.flight++; map.stop(); land(); drift(false); }
  }, { passive: true }));

addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, dialog[open]') || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'r') replay();
  else if (k === 'escape') toOrbit();
  else if (k === 'o') drift(!state.drift);
  else if (k === 'l') toggleLabels();
  else if (k === 's') toggleSound();
});

addEventListener('hashchange', () => { const s = parseShared(); if (s) { state.shared = s; descend(s, { quick: true }); } });

map.on('load', () => { onMove(); begin(); });
