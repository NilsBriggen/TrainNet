import { applyDelays, atDistance, cumStops, locate, motion, slice, unpackPath } from "./position.js";
import { routeStyle } from "./colors.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const hhmm = (t) => new Date(day.base + t * 1000).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich" });
const SEV = { 1: "#5a6b8c", 2: "#ffb547", 3: "#ff4d4d" };
const STANDING = "#ff9f5a"; // inferred "probably standing": a quiet outline, never a blink (it's a guess, not a report)
const SEV_NAME = { 1: "Planned", 2: "Limited service", 3: "Interrupted" };
const KIND = { person: "Person on the track / accident", signal: "Signal or points fault", power: "Overhead line fault", train: "Train fault", infra: "Infrastructure fault", weather: "Weather", police: "Police / emergency services", other: "Disruption" };
const CALM = matchMedia("(prefers-reduced-motion: reduce)").matches; // no blinking or ripples
const TRAIL_O = [0.7, 0.45, 0.25, 0.1]; // trail pieces, nearest the train first
const clock = (sec) => new Date(sec * 1000).toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Zurich" });
const dayOf = (sec) => new Date(sec * 1000).toLocaleDateString("de-CH", { timeZone: "Europe/Zurich" });
/** HH:MM, with the date when it isn't today (works lasting days, weeks). */
const dateClock = (sec) => (dayOf(sec) === dayOf(Date.now() / 1000) ? clock(sec) : `${new Date(sec * 1000).toLocaleDateString("de-CH", { day: "numeric", month: "short", timeZone: "Europe/Zurich" })} ${clock(sec)}`);
const ICON = {
  bike: `<svg viewBox="0 0 20 20"><circle cx="5" cy="14" r="3.2"/><circle cx="15" cy="14" r="3.2"/><path d="M5 14l3-7h4l3 7M8 7h5M10 14l2-7"/></svg>`,
  wc: `<svg viewBox="0 0 20 20"><circle cx="9" cy="4" r="1.6"/><path d="M9 7v5h4l2 5M9 9h3M6 11a4 4 0 1 0 6 4"/></svg>`,
  wr: `<svg viewBox="0 0 20 20"><path d="M6 3v6a2 2 0 0 0 4 0V3M8 9v8M14 3c-2 1-2 5-2 7h2v7"/></svg>`,
};


let day, live = { delays: {}, alerts: [], stats: [] }, styles = [], byStation = [], paths = [], segIndex = new Map();
const expCache = new Map(), routeCache = new Map(), shown = new Map(); // trip -> expected times / track model / eased distance
let selected = null; // { type: "train" | "station" | "alert" | "issues", idx, tab? }
let incidentTrains = new Map(), rippleAlerts = []; // trip -> its sudden alert; where sudden things happened
let follow = false, zen = false, lastFocus = null;
const hidden = new Set(); // chip keys switched off
try { for (const k of JSON.parse(localStorage.getItem("trainnet.hidden") ?? "[]")) hidden.add(k); } catch {}

let clockSkew = 0; // server minus this device, from the Date header: a phone minutes off would shift every train
const now = () => (Date.now() + clockSkew - day.base) / 1000;
function expected(i) {
  let e = expCache.get(i);
  if (!e) expCache.set(i, (e = applyDelays(day.trips[i][3], live.delays[i]?.u)));
  return e;
}
const segKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);
const straight = (a, b) => unpackPath([Math.round(a[1] * 1e5), Math.round(a[2] * 1e5), Math.round((b[1] - a[1]) * 1e5), Math.round((b[2] - a[2]) * 1e5)]);
/** Track model of a trip: segments in travel order plus metres at each stop. */
function tripRoute(i) {
  let r = routeCache.get(i);
  if (!r) {
    const s = day.trips[i][3], route = [];
    for (let k = 3; k < s.length; k += 3) route.push({ path: paths[segIndex.get(segKey(s[k - 3], s[k]))], reverse: s[k - 3] > s[k] });
    routeCache.set(i, (r = { route, cum: cumStops(route) }));
  }
  return r;
}
const platform = (i, k) => { const p = day.trips[i][4]; return p ? day.platforms[p[k]] : ""; };
let uicMap = null;
const uicIndex = () => (uicMap?.day === day ? uicMap.m : (uicMap = { day, m: new Map(day.stations.map((s, i) => [s[3], i])) }).m);

// ---------- data ----------
async function fetchDay() {
  for (;;) {
    const r = await fetch("/api/day").catch(() => null);
    if (r?.ok) return r.json();
    $("loading").lastElementChild.textContent = !r ? "Can't reach the server. Retrying…" : r.status === 503 ? "The server is loading today's timetable (about half a minute)…" : `The server answered ${r.status}. Retrying…`;
    await new Promise((res) => setTimeout(res, r ? 10000 : 5000));
  }
}

function indexDay() {
  styles = day.routes.map((r) => routeStyle(...r));
  byStation = day.stations.map(() => []);
  day.trips.forEach((t, i) => {
    for (let p = 0; p < t[3].length / 3; p++) byStation[t[3][p * 3]].push([i, p]);
  });
  segIndex.clear();
  paths = day.paths.map((p, k) => {
    const a = day.segments[k * 2], b = day.segments[k * 2 + 1];
    segIndex.set(segKey(a, b), k);
    return p ? unpackPath(p) : straight(day.stations[a], day.stations[b]);
  });
  for (const m of [expCache, routeCache, shown, details]) m.clear(); // trip indexes changed
}

let polling = false, alertsV = "";
async function pollLive() {
  if (polling || document.hidden) return; // a background tab doesn't need trains; the next visible tick catches up
  polling = true;
  try {
    const r = await fetch("/api/live").catch(() => null), j = await r?.json().catch(() => null);
    if (!j?.v) return;
    const server = Date.parse(r.headers.get("date") ?? "");
    if (server) { const skew = server - Date.now(); clockSkew = Math.abs(skew) > 3000 ? skew : 0; }
    if (j.v !== day.v) { // a new service day: every trip index changed, so whatever was open means something else now
      closePanel();
      results = [];
      hideResults();
      day = await fetchDay();
      indexDay();
      setStatic();
    }
    // alerts (geometry, texts) change rarely: fetched only when their version moves, from a URL that caches for good
    if (j.av !== alertsV) {
      const a = await fetch(`/api/alerts?v=${encodeURIComponent(j.av)}`).then((x) => x.json()).catch(() => null);
      if (a) { live.alerts = a; alertsV = j.av; }
    }
    live = { ...j, alerts: live.alerts };
    expCache.clear();
    setAlerts();
    drawSpark();
    renderPanel();
  } finally {
    polling = false;
  }
}
document.addEventListener("visibilitychange", () => !document.hidden && day && pollLive());

// ---------- map ----------
const dayPromise = fetchDay(); // in parallel with the map style and relief tiles, not after them
let map;
try {
  map = new maplibregl.Map({
  container: "map",
  bounds: [[5.9, 45.8], [10.5, 47.85]],
  fitBoundsOptions: { padding: { top: 80, left: 40, right: 40, bottom: 60 } },
  maxBounds: [[3.5, 44.8], [12.9, 48.9]],
  attributionControl: false,
  style: { version: 8, glyphs: `${location.origin}/glyphs/{fontstack}/{range}.pbf`, sources: {}, layers: [{ id: "bg", type: "background", paint: { "background-color": "#040a18" } }] },
  });
} catch (e) {
  $("loading").lastElementChild.textContent = "This browser can't draw the map (WebGL is off or unsupported). The stats pages still work: /stats";
  throw e;
}
// north stays up: no rotation or tilt by mouse, touch or keyboard
map.dragRotate.disable();
map.touchZoomRotate.disableRotation();
map.touchPitch.disable();
map.keyboard.disableRotation();

const fc = (features) => ({ type: "FeatureCollection", features });
const point = (c, props, id) => ({ type: "Feature", id, geometry: { type: "Point", coordinates: c }, properties: props });
const line = (flat, props = {}) => {
  const coords = [];
  for (let i = 0; i < flat.length; i += 2) coords.push([flat[i], flat[i + 1]]);
  return { type: "Feature", properties: props, geometry: { type: "LineString", coordinates: coords } };
};

/** Signed-distance images: a tapered bean (nose to +x) and a diamond. MapLibre tints and halos SDFs per feature. */
function sdf(W, H, dist) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = dist(x + 0.5 - W / 2, y + 0.5 - H / 2); // positive outside
    data[(y * W + x) * 4 + 3] = Math.max(0, Math.min(255, Math.round(255 - 255 * (d / 8 + 0.25))));
  }
  return { width: W, height: H, data };
}
// train body: 36×18 px rounded car with a round cab at +x (drawn at pixelRatio 2 → 18×9 on screen at size 1)
const train = () => sdf(60, 40, (px, py) => {
  const rr = (cx, cy, hw, hh, r) => { const dx = Math.abs(px - cx) - hw + r, dy = Math.abs(py - cy) - hh + r; return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r; };
  return Math.min(rr(-5, 0, 13, 9, 3.5), Math.hypot(px - 9, py) - 9); // body from -18 to +8, cab circle to +18
});
const diamond = () => sdf(32, 32, (px, py) => Math.abs(px) + Math.abs(py) - 8);

function setStatic() {
  const st = day.stations, count = new Map();
  for (const t of day.trips) for (let p = 3; p < t[3].length; p += 3) {
    const k = segKey(t[3][p - 3], t[3][p]);
    count.set(k, (count.get(k) ?? 0) + 1);
  }
  map.getSource("rail").setData(fc(paths.map((p, k) => {
    const n = count.get(segKey(day.segments[k * 2], day.segments[k * 2 + 1])) ?? 0;
    return line(p.pts, { w: n >= 150 ? 2 : n >= 40 ? 1 : 0 });
  })));
  map.getSource("stations").setData(fc(st.map((s, i) => point(s.slice(1, 3), { i, name: s[0], n: s[4], hub: s[4] >= 400 ? 1 : 0 }, i))));
}

function setAlerts() {
  const alerts = live.alerts;
  map.getSource("alert-seg").setData(fc(alerts.flatMap((a) => (a.seg ?? []).map((p) => line(p, { sev: a.sev, id: a.id, sudden: a.sudden ? 1 : 0 })))));
  // alerts without a drawn span get a diamond at each named station (a line-only one: the stations of its line), at most 12; the worst one wins
  const pts = new Map();
  for (const a of alerts) if (!a.seg) for (const st of (a.s.length ? a.s : lineStations(a.r[0])).slice(0, 12)) if ((pts.get(st)?.sev ?? 0) < a.sev) pts.set(st, a);
  map.getSource("alert-pts").setData(fc([...pts].map(([i, a]) => point(day.stations[i].slice(1, 3), { sev: a.sev, c: a.sudden ? SEV[3] : SEV[a.sev], id: a.id, sudden: a.sudden ? 1 : 0 }))));
  incidentTrains = new Map();
  for (const a of alerts) if (trainScoped(a)) for (const i of a.t) incidentTrains.set(i, a);
  rippleAlerts = alerts.filter((a) => a.sudden && !trainScoped(a)).flatMap((a) => (a.seg ? [midpoint(a.seg[0])] : a.s.length === 1 ? [day.stations[a.s[0]].slice(1, 3)] : []));
  renderIssues();
}
const trainScoped = (a) => a.train === 1; // decided once on the server (markSudden)
/** Stops of a route's longest trip today (for alerts that only name a line). */
const lineStations = (route) => {
  if (route === undefined) return [];
  const longest = day.trips.filter((tr) => tr[0] === route).reduce((x, y) => (!x || y[3].length > x[3].length ? y : x), null);
  return longest ? Array.from({ length: longest[3].length / 3 }, (_, k) => longest[3][k * 3]) : [];
};
const standingTrains = () => Object.entries(live.delays).filter(([, v]) => v.x && !v.c).map(([i]) => +i);
const standing = (i) => !!live.delays[i]?.x && !live.delays[i]?.c;
const whyText = (a) => (a.why ? a.why[0].toUpperCase() + a.why.slice(1) : KIND[a.kind] ?? "Disruption");
const trainIssue = (i) => (incidentTrains.has(i) ? whyText(incidentTrains.get(i)) : "");

/** Point halfway along a flat [lon,lat,...] line. */
function midpoint(flat) {
  const seg = [];
  let total = 0;
  for (let i = 2; i < flat.length; i += 2) {
    const d = Math.hypot((flat[i] - flat[i - 2]) * Math.cos((flat[i + 1] * Math.PI) / 180), flat[i + 1] - flat[i - 1]);
    seg.push(d);
    total += d;
  }
  for (let k = 0, acc = 0; k < seg.length; acc += seg[k++]) {
    if (acc + seg[k] < total / 2) continue;
    const t = seg[k] ? (total / 2 - acc) / seg[k] : 0, i = k * 2;
    return [flat[i] + (flat[i + 2] - flat[i]) * t, flat[i + 1] + (flat[i + 3] - flat[i + 1]) * t];
  }
  return [flat[0], flat[1]];
}

function renderIssues() {
  const n = [0, 0, 0, 0];
  for (const a of live.alerts) n[a.sev]++;
  const now_ = live.alerts.filter((a) => a.sudden).length, st = standingTrains().length; // reported incidents only; standing is a guess
  $("issues").innerHTML = (now_ ? `<button class="pill alarm" data-issues="now" style="--c:${SEV[3]}">${now_} incident${now_ > 1 ? "s" : ""}</button>` : "")
    + [[3, "interrupted"], [2, "limited"], [1, "planned"]].filter(([s]) => n[s])
      .map(([s, w]) => `<button class="pill" data-issues="${s}" style="--c:${SEV[s]}">${n[s]} ${w}</button>`).join("")
    + (st ? `<button class="pill quiet" data-issues="standing" style="--c:${STANDING}" title="Delay rising while heading for the same stop: probably standing. An inference, not a report.">${st} standing</button>` : "");
  for (const b of $("issues").children) b.onclick = () => open("issues", b.dataset.issues);
}

function drawSpark() {
  const st = live.stats ?? [];
  if (st.length < 2) return;
  const W = 120, H = 26, x = (k) => (k / (st.length - 1)) * W;
  const maxRun = Math.max(...st.map((s) => s[1]), 1);
  const area = st.map((s, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${(H - (s[1] / maxRun) * (H - 4)).toFixed(1)}`).join("") + `L${W},${H}L0,${H}Z`;
  const pct = (s) => (s[5] ? 1 - s[2] / s[5] : 1); // late of the running trains with realtime
  const lo = Math.min(0.8, ...st.map(pct));
  const lineD = st.map((s, k) => `${k ? "L" : "M"}${x(k).toFixed(1)},${(2 + (1 - (pct(s) - lo) / (1 - lo)) * (H - 4)).toFixed(1)}`).join("");
  $("spark").querySelector(".area").setAttribute("d", area);
  $("spark").querySelector(".line").setAttribute("d", lineD);
  $("spark").setAttribute("aria-label", `Punctuality over the last two hours, now ${Math.round(pct(st[st.length - 1]) * 100)}%`);
}

/** Position of a trip eased along its own track (never across it) so delay corrections roll instead of jump. */
function positionOf(i, t, dt) {
  const e = expected(i), p = locate(e.stops, t);
  if (!p) return null;
  const { route, cum } = tripRoute(i);
  const target = cum[p.a] + (p.at ? 0 : motion(p.f, e.stops[p.b * 3 + 1] - e.stops[p.a * 3 + 2]) * (cum[p.b] - cum[p.a]));
  let d = shown.get(i);
  if (d === undefined || Math.abs(d - target) > 5000) d = target; // first frame or a big correction
  d += (target - d) * (1 - Math.exp(-dt / 1500));
  shown.set(i, d);
  return { p, e, q: atDistance(route, cum, d), dist: d };
}

const CHIP_DELAYS = () => !hidden.has("delays");
let lastStatus = 0;
function trainFeatures(dt, ts, withTrails) {
  const t = now(), feats = [], trails = [], alarms = [], z = map.getZoom();
  const L = Math.min(15000, Math.max(400, (48 * 107160) / 2 ** z)); // ~48 px of track behind each train
  const blinkOn = CALM || ts % 1000 < 550;
  let running = 0, observed = 0, late = 0;
  const dimOthers = selected?.type === "train";
  for (let i = 0; i < day.trips.length; i++) {
    const s = day.trips[i][3], style = styles[day.trips[i][0]];
    if (hidden.has(style.cat) || t < s[2] - 60 || t > s[s.length - 2] + 3 * 3600) continue; // cheap reject, allows 3 h delay
    const r = positionOf(i, t, dt);
    if (!r) continue;
    const { p, e, q, dist } = r;
    const cancelled = !!live.delays[i]?.c, d = e.delay[p.b], sel = dimOthers && selected.idx === i;
    const flagged = !cancelled && incidentTrains.has(i), still = !cancelled && !flagged && standing(i);
    if (!cancelled) running++;
    if (!cancelled && live.delays[i]?.u) { observed++; if (d >= 180) late++; } // same rule as the server: no realtime = unknown
    const o = cancelled ? 0.3 : dimOthers && !sel ? 0.4 : still ? 0.75 : 1, showDelay = CHIP_DELAYS() && !cancelled;
    if (flagged) alarms.push(point([q.lon, q.lat], {}));
    feats.push(point([q.lon, q.lat], {
      i, c: style.c, s: style.s, g: style.glow, r: q.bearing - 90,
      // a dark outline separates the body from track and trail; reported incidents blink red, inferred standing is a steady orange line
      h: sel ? "#ffffff" : flagged ? (blinkOn ? "#ff4d4d" : "#040a18") : still ? STANDING : showDelay && d >= 600 ? "#ff4d4d" : showDelay && d >= 180 ? "#ffd23f" : "#040a18",
      hw: sel ? 2.2 : flagged ? 2.4 : still ? 1.6 : showDelay && d >= 600 ? 1.8 : showDelay && d >= 180 ? 1.4 : 0.9,
      o, z: flagged ? 3 : style.glow ? 2 : style.s > 0.7 ? 1 : 0,
    }, i));
    if (withTrails && !cancelled && !p.at && (style.glow || z >= 8)) {
      const { route, cum } = tripRoute(i);
      for (let k = 0; k < 4; k++) {
        const piece = slice(route, cum, dist - (L * (k + 1)) / 4, dist - (L * k) / 4);
        if (piece.length >= 4) trails.push(line(piece, { c: style.c, o: TRAIL_O[k] * o }));
      }
    }
  }
  if (ts - lastStatus > 1000) {
    lastStatus = ts;
    const pct = observed ? Math.round((1 - late / observed) * 100) : 100;
    $("status-text").textContent = `${running.toLocaleString("de-CH")} trains · ${pct} % on time`;
  }
  return { trains: fc(feats), trails: withTrails ? fc(trails) : null, alarms };
}

let last = 0, lastFrame = 0, lastFollow = 0, lastRoute = 0, tick = 0, hadRipples = false;
function frame(ts) {
  try { tickFrame(ts); } finally { requestAnimationFrame(frame); } // one bad frame must not stop the map for good
}
function tickFrame(ts) {
  if (ts - last > 50) {
    const dt = Math.min(ts - lastFrame, 1000);
    last = lastFrame = ts;
    const { trains, trails, alarms } = trainFeatures(dt, ts, tick++ % 2 === 0); // trails at 10 fps are enough
    map.getSource("trains").setData(trains);
    if (trails) map.getSource("trails").setData(trails);
    const ripples = alarms.length + rippleAlerts.length > 0;
    if (ripples || hadRipples) map.getSource("ripples").setData(fc([...alarms, ...rippleAlerts.map((c) => point(c, {}))])); // nothing to clear: skip the upload
    hadRipples = ripples;
    const breath = 0.5 + 0.5 * Math.sin(ts / 480); // ~3 s period, never fully off
    const blinkOn = CALM || ts % 1000 < 550;
    map.setPaintProperty("alert-seg-3", "line-opacity", CALM ? 0.7 : 0.4 + 0.4 * breath);
    map.setPaintProperty("alert-seg-sudden", "line-opacity", blinkOn ? 0.95 : 0.2);
    map.setPaintProperty("alert-pts", "icon-opacity", ["case", ["==", ["get", "sudden"], 1], blinkOn ? 1 : 0.25, ["match", ["get", "sev"], 1, 0.45, 0.9]]);
    if (!CALM) {
      const ph = (ts % 1400) / 1400; // ripple: grows and fades
      map.setPaintProperty("ripples", "circle-radius", 6 + 20 * ph);
      map.setPaintProperty("ripples", "circle-stroke-opacity", 0.85 * (1 - ph));
    }
    updateTip();
    if (selected?.type === "train") {
      if (ts - lastRoute > 500) { lastRoute = ts; setRoute(selected.idx); } // the split point moves slowly: 2 Hz is plenty
      if (follow && ts - lastFollow > 1000 && !map.isMoving()) {
        lastFollow = ts;
        const f = trains.features.find((x) => x.properties.i === selected.idx);
        if (f) map.easeTo({ center: f.geometry.coordinates, duration: 950, easing: (x) => x, padding: camPad() }); // keeps the user's zoom
        else setFollow(false); // finished, or its category is switched off
      }
    }
  }
}

/** The selected train's whole route: travelled part bright, remaining part faint, split where the icon is drawn. */
function setRoute(i) {
  const { route, cum } = tripRoute(i), total = cum[cum.length - 1], s = expected(i).stops, t = now();
  const d = shown.get(i) ?? (t > s[2] ? total : 0); // not on the map: before departure or after arrival
  const c = styles[day.trips[i][0]].c, parts = [];
  if (d > 0) parts.push(line(slice(route, cum, 0, d), { c, part: "behind" }));
  if (d < total) parts.push(line(slice(route, cum, d, total), { c, part: "ahead" }));
  map.getSource("route").setData(fc(parts.filter((f) => f.geometry.coordinates.length > 1)));
}

map.on("load", async () => {
  map.addImage("train", train(), { sdf: true, pixelRatio: 2 });
  map.addImage("diamond", diamond(), { sdf: true, pixelRatio: 2 });
  // pre-rendered hillshade, not a DEM: browsers with anti-fingerprinting (Firefox resistFingerprinting, LibreWolf)
  // block reading canvas pixels, which MapLibre needs to decode elevation tiles; plain raster tiles are only drawn
  map.addSource("relief", { type: "raster", tiles: ["https://wmts.geo.admin.ch/1.0.0/ch.swisstopo.swissalti3d-reliefschattierung_monodirektional/default/current/3857/{z}/{x}/{y}.png"], tileSize: 256, maxzoom: 17 });
  map.addSource("neighbours", { type: "geojson", data: "neighbours.geojson" });
  map.addSource("ch", { type: "geojson", data: "switzerland.geojson" });
  map.addSource("lakes", { type: "geojson", data: "lakes.geojson" });
  for (const id of ["rail", "alert-seg", "alert-pts", "route", "trails", "stations", "trains", "ripples"]) map.addSource(id, { type: "geojson", data: fc([]) });

  // swissALTI3D hillshade (CH + LI only) is opaque grey: it sits first, under a translucent navy country fill that tints it, so shadows come out darker;
  // the opaque neighbour fill hides the bit of swisstopo coverage beyond the border
  map.addLayer({ id: "relief", type: "raster", source: "relief", paint: { "raster-saturation": -1, "raster-contrast": 0.25, "raster-brightness-max": 0.36, "raster-fade-duration": 0 } });
  map.addLayer({ id: "nb-fill", type: "fill", source: "neighbours", paint: { "fill-color": "#050b1a" } });
  map.addLayer({ id: "nb-line", type: "line", source: "neighbours", paint: { "line-color": "#152a52", "line-width": 0.6, "line-opacity": 0.8 } });
  map.addLayer({ id: "ch-glow", type: "line", source: "ch", paint: { "line-color": "#2a66ff", "line-width": 10, "line-blur": 10, "line-opacity": 0.18 } });
  map.addLayer({ id: "ch-fill", type: "fill", source: "ch", paint: { "fill-color": "#08214f", "fill-opacity": 0.7 } });
  map.addLayer({ id: "lakes", type: "fill", source: "lakes", paint: { "fill-color": "#02060f" } });
  map.addLayer({ id: "lakes-line", type: "line", source: "lakes", paint: { "line-color": "#17305e", "line-width": 0.6 } });
  map.addLayer({ id: "ch-line", type: "line", source: "ch", paint: { "line-color": "#3a6fd8", "line-width": 1.1, "line-opacity": 0.75 } });

  map.addLayer({ id: "rail-glow", type: "line", source: "rail", filter: ["==", ["get", "w"], 2], paint: { "line-color": "#2b56b0", "line-width": 4, "line-blur": 3, "line-opacity": 0.22 } });
  map.addLayer({
    id: "rail", type: "line", source: "rail",
    paint: {
      "line-color": ["match", ["get", "w"], 2, "#4a74c9", 1, "#34579d", "#294a82"],
      "line-width": ["interpolate", ["linear"], ["zoom"], 7, ["match", ["get", "w"], 2, 1.3, 1, 0.9, 0.5], 12, ["match", ["get", "w"], 2, 2.6, 1, 1.8, 1.2]],
      "line-opacity": ["match", ["get", "w"], 2, 0.95, 1, 0.85, 0.6],
    },
  });
  const calmSev = (n) => ["all", ["==", ["get", "sev"], n], ["==", ["get", "sudden"], 0]];
  map.addLayer({ id: "alert-seg-1", type: "line", source: "alert-seg", filter: calmSev(1), paint: { "line-color": SEV[1], "line-width": 1.4, "line-opacity": 0.4, "line-dasharray": [2, 2] } });
  map.addLayer({ id: "alert-seg-2", type: "line", source: "alert-seg", filter: calmSev(2), paint: { "line-color": SEV[2], "line-width": 2, "line-opacity": 0.7 } });
  map.addLayer({ id: "alert-seg-3", type: "line", source: "alert-seg", filter: calmSev(3), paint: { "line-color": SEV[3], "line-width": 2.6, "line-opacity": 0.6, "line-blur": 0.4 } });
  map.addLayer({ id: "alert-seg-sudden", type: "line", source: "alert-seg", filter: ["==", ["get", "sudden"], 1], layout: { "line-cap": "round" }, paint: { "line-color": SEV[3], "line-width": 3.4 } });
  map.addLayer({ id: "alert-hit", type: "line", source: "alert-seg", paint: { "line-color": "#000", "line-width": 18, "line-opacity": 0.01 } }); // wide invisible target for clicks
  map.addLayer({ id: "route-ahead", type: "line", source: "route", filter: ["==", ["get", "part"], "ahead"], paint: { "line-color": ["get", "c"], "line-width": 2, "line-opacity": 0.35 } });
  map.addLayer({ id: "route-behind", type: "line", source: "route", filter: ["==", ["get", "part"], "behind"], paint: { "line-color": ["get", "c"], "line-width": 2.2, "line-opacity": 0.85 } });

  map.addLayer({ id: "stations-minor", type: "circle", source: "stations", minzoom: 9.5, filter: ["<", ["get", "n"], 60], paint: { "circle-color": "#6e86b8", "circle-radius": ["interpolate", ["linear"], ["zoom"], 9.5, 1.2, 13, 3], "circle-opacity": 0.7 } });
  map.addLayer({ id: "stations-mid", type: "circle", source: "stations", filter: ["all", [">=", ["get", "n"], 60], ["==", ["get", "hub"], 0]], paint: { "circle-color": "#93aadb", "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 1.6, 10, 2.8, 13, 4.5], "circle-opacity": ["interpolate", ["linear"], ["zoom"], 7, 0.5, 9, 0.85], "circle-stroke-color": "#040a18", "circle-stroke-width": 1 } });
  map.addLayer({ id: "stations-hub", type: "circle", source: "stations", filter: ["==", ["get", "hub"], 1], paint: { "circle-color": "#040a18", "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 3.2, 10, 5, 13, 7], "circle-stroke-color": "#c7d6ff", "circle-stroke-width": 1.6 } });
  map.addLayer({ id: "stations-hub-dot", type: "circle", source: "stations", filter: ["==", ["get", "hub"], 1], paint: { "circle-color": "#c7d6ff", "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 1, 13, 2.2] } });
  map.addLayer({ id: "station-selected", type: "circle", source: "stations", filter: ["==", ["get", "i"], -1], paint: { "circle-color": "rgba(0,0,0,0)", "circle-radius": ["interpolate", ["linear"], ["zoom"], 7, 7, 13, 12], "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
  // labels sit under the trains: a train passing a station stays visible
  const text = (size, color, offset) => ({
    layout: { "text-field": ["get", "name"], "text-font": ["Open Sans Semibold"], "text-size": size, "text-offset": [0, offset], "text-anchor": "top", "symbol-sort-key": ["-", ["get", "n"]] },
    paint: { "text-color": color, "text-halo-color": "#040a18", "text-halo-width": 1.5 },
  });
  // minor → mid → hub order: later layers win collisions, so hubs are never hidden by villages
  map.addLayer({ id: "labels-minor", type: "symbol", source: "stations", minzoom: 12, filter: ["<", ["get", "n"], 60], ...text(10, "#7486a8", 0.7) });
  map.addLayer({ id: "labels-mid", type: "symbol", source: "stations", minzoom: 9.5, filter: ["all", [">=", ["get", "n"], 60], ["==", ["get", "hub"], 0]], ...text(11, "#93aadb", 0.8) });
  map.addLayer({ id: "labels-hub", type: "symbol", source: "stations", filter: ["==", ["get", "hub"], 1], ...text(["interpolate", ["linear"], ["zoom"], 7, 11, 12, 13], "#c7d6ff", 0.9) });
  map.addLayer({ id: "alert-pts", type: "symbol", source: "alert-pts", layout: { "icon-image": "diamond", "icon-size": ["interpolate", ["linear"], ["zoom"], 7, 0.55, 12, 0.9], "icon-allow-overlap": true, "icon-ignore-placement": true }, paint: { "icon-color": ["get", "c"], "icon-opacity": ["match", ["get", "sev"], 1, 0.45, 0.9], "icon-halo-color": "#040a18", "icon-halo-width": 1 } });

  map.addLayer({ id: "trails", type: "line", source: "trails", layout: { "line-cap": "butt", "line-join": "round" }, paint: { "line-color": ["get", "c"], "line-opacity": ["get", "o"], "line-width": ["interpolate", ["linear"], ["zoom"], 6, 1.4, 10, 2.6, 14, 4.5] } });
  map.addLayer({ id: "ripples", type: "circle", source: "ripples", layout: { visibility: CALM ? "none" : "visible" }, paint: { "circle-color": "rgba(0,0,0,0)", "circle-radius": 6, "circle-stroke-color": SEV[3], "circle-stroke-width": 2, "circle-stroke-opacity": 0.8 } });
  map.addLayer({ id: "train-glow", type: "circle", source: "trains", filter: ["==", ["get", "g"], 1], paint: { "circle-color": ["get", "c"], "circle-radius": ["interpolate", ["linear"], ["zoom"], 6, 6, 10, 10, 14, 18], "circle-blur": 1, "circle-opacity": ["*", 0.22, ["get", "o"]] } });
  const trainSize = ["interpolate", ["linear"], ["zoom"], 6, ["*", 0.34, ["get", "s"]], 8, ["*", 0.5, ["get", "s"]], 10, 0.8, 12, 1, 15, 1.5];
  map.addLayer({
    id: "trains", type: "symbol", source: "trains",
    layout: {
      "icon-image": "train", "icon-rotate": ["get", "r"], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true, "icon-padding": 0,
      "icon-size": trainSize, // regional trains shrink at country zoom (s < 1) so the long-distance network reads first
      "symbol-sort-key": ["get", "z"], "symbol-z-order": "source",
    },
    paint: { "icon-color": ["get", "c"], "icon-opacity": ["get", "o"], "icon-halo-color": ["get", "h"], "icon-halo-width": ["get", "hw"], "icon-halo-blur": 0 },
  });


  day = await dayPromise;
  indexDay();
  setStatic();
  await pollLive();
  $("loading").hidden = true;
  setInterval(pollLive, 15000);
  setInterval(() => $("live").classList.toggle("stale", !live.time || Date.now() / 1000 - live.time > 120), 5000);
  requestAnimationFrame(frame);
  openFromUrl();
});

const hoverable = !matchMedia("(hover: none)").matches;
let hoverPt = null, tipHtml = "";
map.on("mousemove", (e) => { if (hoverable) hoverPt = e.point; }); // touch screens send a mousemove after a tap: no hover state there
map.getCanvas().addEventListener("mouseleave", () => { hoverPt = null; updateTip(); });
/** What's under a screen point: trains first, then stations, then disruptions. */
function hitAt(pt) {
  const box = [[pt.x - 7, pt.y - 7], [pt.x + 7, pt.y + 7]];
  const t = map.queryRenderedFeatures(box, { layers: ["trains"] })[0];
  if (t) return { type: "train", idx: t.properties.i };
  const s = map.queryRenderedFeatures(box, { layers: ["stations-hub", "stations-mid", "stations-minor"] })[0];
  if (s) return { type: "station", idx: s.properties.i };
  const a = map.queryRenderedFeatures(box, { layers: ["alert-pts", "alert-hit"] })[0];
  return a ? { type: "alert", idx: a.properties.id } : null;
}
// re-checked every frame: trains drive away from a still cursor, which fires no mouse events
function updateTip() {
  const hit = hoverPt && !zen ? hitAt(hoverPt) : null;
  map.getCanvas().style.cursor = hit ? "pointer" : "";
  const html = !hit ? "" : hit.type === "train" ? trainTip(hit.idx) : hit.type === "alert" ? alertTip(hit.idx) : stationTip(hit.idx);
  if (!html) { $("tip").hidden = true; tipHtml = ""; return; }
  if (html !== tipHtml) $("tip").innerHTML = tipHtml = html;
  $("tip").hidden = false;
  // flip to the other side of the cursor near the right and bottom edges
  const w = $("tip").offsetWidth, h = $("tip").offsetHeight;
  const x = hoverPt.x + 14 + w > innerWidth - 8 ? hoverPt.x - 14 - w : hoverPt.x + 14, y = hoverPt.y + 14 + h > innerHeight - 8 ? hoverPt.y - 14 - h : hoverPt.y + 14;
  $("tip").style.transform = `translate(${x}px, ${y}px)`;
}
function stationTip(si) {
  const [name, , , , n] = day.stations[si];
  return `<span>${esc(name)}</span><span class="sub">${n} trains today</span>`;
}
function trainTip(i) {
  const [route, head, num] = day.trips[i];
  const ex = expected(i), p = locate(ex.stops, now()), d = p ? ex.delay[p.b] : 0, pl = p ? platform(i, p.b) : "", issue = trainIssue(i);
  return `${badge(route)} <span>${esc(num)}</span><span class="sub">→ ${esc(head)}</span>${pl ? `<span class="sub">Pl. ${esc(pl)}</span>` : ""}`
    + (live.delays[i]?.c ? `<span class="very-late">cancelled</span>` : delayText(d)) + (issue ? `<span class="very-late">${esc(issue)}</span>` : standing(i) ? `<span class="standing">probably standing</span>` : "");
}
function alertTip(id) {
  const a = live.alerts.find((x) => x.id === id);
  if (!a) return "";
  const names = a.s.map((s) => day.stations[s][0]), span = names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(" – ");
  return `<span class="sev-dot" style="--c:${a.sudden ? SEV[3] : SEV[a.sev]}"></span><span>${a.sudden ? "Just happened" : SEV_NAME[a.sev]}</span>${span ? `<span class="sub">${esc(span)}</span>` : ""}<span class="sub">· ${esc(whyText(a))}</span>`;
}
map.on("click", (e) => {
  if (zen) return showZenExit();
  const hit = hitAt(e.point);
  if (hit) open(hit.type, hit.idx, hit.type === "alert");
  else if (selected) closePanel(); // empty map: deselect, un-dim the other trains
});
map.on("dragstart", () => setFollow(false));

// ---------- chips ----------
for (const b of $("chips").querySelectorAll("button")) {
  b.classList.toggle("off", hidden.has(b.dataset.cat));
  b.setAttribute("aria-pressed", String(!hidden.has(b.dataset.cat)));
  b.onclick = () => {
    hidden.has(b.dataset.cat) ? hidden.delete(b.dataset.cat) : hidden.add(b.dataset.cat);
    b.classList.toggle("off", hidden.has(b.dataset.cat));
    b.setAttribute("aria-pressed", String(!hidden.has(b.dataset.cat)));
    try { localStorage.setItem("trainnet.hidden", JSON.stringify([...hidden])); } catch {}
  };
}

// ---------- clock, zen ----------
setInterval(() => ($("clock").textContent = new Date().toLocaleTimeString("de-CH", { timeZone: "Europe/Zurich" })), 1000);
let idleTimer;
function setZen(on) {
  zen = on;
  document.body.classList.toggle("zen", on);
  document.body.classList.remove("idle");
  $("zen").setAttribute("aria-pressed", String(on));
  const u = new URL(location.href);
  on ? u.searchParams.set("zen", "1") : u.searchParams.delete("zen");
  history.replaceState(null, "", u);
}
$("zen").onclick = () => setZen(!zen);
$("zen-exit").onclick = () => setZen(false);
let zenExitTimer;
/** In zen there's no bar: a tap shows a way out for a few seconds (touch screens have no Z key or Escape). */
function showZenExit() {
  $("zen-exit").hidden = false;
  clearTimeout(zenExitTimer);
  zenExitTimer = setTimeout(() => ($("zen-exit").hidden = true), 3000);
}
document.addEventListener("mousemove", () => {
  if (!zen) return;
  document.body.classList.remove("idle");
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => document.body.classList.add("idle"), 2000);
});
document.addEventListener("keydown", (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName);
  if (e.key === "Escape") { typing ? ($("q").blur(), hideResults()) : !$("key").hidden ? toggleKey(false) : zen ? setZen(false) : closePanel(); }
  else if ((e.metaKey || e.ctrlKey) && e.key === "k" || (!typing && e.key === "/")) { e.preventDefault(); $("q").focus(); $("q").select(); }
  else if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  else if (e.key === "z" || e.key === "Z") setZen(!zen);
  else if (e.key === "?") toggleKey();
});
if (!/Mac|iPhone|iPad/.test(navigator.platform)) document.querySelector(".search kbd").textContent = "Ctrl K";

// ---------- key (legend) ----------
function toggleKey(on = $("key").hidden) {
  $("key").hidden = !on;
  $("key-btn").setAttribute("aria-expanded", String(on));
  if (on) $("key").focus();
}
$("key-btn").onclick = () => toggleKey();
$("key").querySelector("[data-close]").onclick = () => toggleKey(false);

// ---------- search ----------
let results = [], cursor = -1;
const fold = (x) => x.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase(); // "zurich" finds Zürich, "geneve" Genève
let folded = []; // station names, folded once per day
function search(q) {
  q = fold(q.trim());
  if (!q || !day) return [];
  const t = now(), out = [];
  if (/^\d+$/.test(q)) {
    const cands = day.trips.map((tr, i) => [tr, i]).filter(([tr]) => tr[2] === q || tr[2].startsWith(q));
    cands.sort(([a], [b]) => (a[2] === q ? -1 : b[2] === q ? 1 : 0) || tripRank(a, t) - tripRank(b, t));
    for (const [tr, i] of cands.slice(0, 5)) out.push({ kind: "train", idx: i, main: `${lineName(tr[0])} ${tr[2]}`, sub: `${hhmm(tr[3][2])} ${day.stations[tr[3][0]][0]} → ${tr[1]}`, route: tr[0] });
  } else {
    // a line ("IC5", "s12"): its next train to leave, so Enter shows one on the map
    const routes = day.routes.map((r, k) => k).filter((k) => fold(lineName(k)) === q.replace(/\s+/g, ""));
    const next = routes.flatMap((k) => day.trips.map((tr, i) => [tr, i]).filter(([tr]) => tr[0] === k)).sort(([a], [b]) => tripRank(a, t) - tripRank(b, t))[0];
    if (next) out.push({ kind: "train", idx: next[1], main: `Line ${lineName(next[0][0])}`, sub: `next: ${next[0][2]} ${hhmm(next[0][3][2])} → ${next[0][1]}`, route: next[0][0] });
  }
  if (folded.length !== day.stations.length) folded = day.stations.map((s) => fold(s[0]));
  const st = day.stations.map((s, i) => [s, i]).filter(([s, i]) => s[4] && folded[i].includes(q));
  st.sort(([a, i], [b, j]) => +folded[j].startsWith(q) - +folded[i].startsWith(q) || b[4] - a[4]);
  for (const [s, i] of st.slice(0, 8 - out.length)) out.push({ kind: "station", idx: i, main: s[0], sub: `${s[4]} trains today` });
  return out;
}
const lineName = (route) => day.routes[route][0] || day.routes[route][1];
// running now first, then the next to depart, then the rest
const tripRank = (tr, t) => (t >= tr[3][2] && t <= tr[3][tr[3].length - 2] + 1800 ? 0 : tr[3][2] > t ? 1 + tr[3][2] / 1e6 : 2);
function showResults() {
  results = search($("q").value);
  cursor = results.length ? 0 : -1;
  $("results").innerHTML = results.map((r, k) => `<li role="option" id="r${k}" data-k="${k}" aria-selected="${k === cursor}">${r.kind === "train" ? badge(r.route) : `<span class="rkind">Station</span>`}<span>${esc(r.main)}<br><small>${esc(r.sub)}</small></span><span class="rkind">↵</span></li>`).join("");
  $("results").hidden = !results.length;
  $("q").setAttribute("aria-expanded", String(!!results.length));
  $("q").setAttribute("aria-activedescendant", cursor >= 0 ? `r${cursor}` : "");
  for (const li of $("results").children) li.onmousedown = (e) => { e.preventDefault(); pick(+li.dataset.k); };
}
const hideResults = () => { $("results").hidden = true; $("q").setAttribute("aria-expanded", "false"); };
function pick(k) {
  const r = results[k];
  if (!r) return;
  $("q").blur();
  hideResults();
  open(r.kind, r.idx, true);
}
$("q").oninput = showResults;
$("q").onfocus = showResults;
$("q").onblur = () => setTimeout(hideResults, 150);
$("q").onkeydown = (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    cursor = (cursor + (e.key === "ArrowDown" ? 1 : results.length - 1)) % results.length;
    [...$("results").children].forEach((li, k) => li.setAttribute("aria-selected", k === cursor));
    $("q").setAttribute("aria-activedescendant", `r${cursor}`);
  } else if (e.key === "Enter") pick(cursor);
};

// ---------- deep links ----------
function openFromUrl() {
  const u = new URL(location.href);
  if (u.searchParams.get("zen") === "1") setZen(true);
  const num = u.searchParams.get("train"), uic = u.searchParams.get("station"), aid = u.searchParams.get("alert");
  if (num) {
    const t = now(), cands = day.trips.map((tr, i) => [tr, i]).filter(([tr]) => tr[2] === num).sort(([a], [b]) => tripRank(a, t) - tripRank(b, t));
    if (cands.length) open("train", cands[0][1], true);
  } else if (uic) {
    const i = day.stations.findIndex((s) => s[3] === uic);
    if (i >= 0) open("station", i, true);
  } else if (aid && live.alerts.some((a) => a.id === aid)) open("alert", aid, true);
}
function setUrl() {
  const u = new URL(location.href);
  for (const k of ["train", "station", "alert"]) u.searchParams.delete(k);
  if (selected?.type === "train") u.searchParams.set("train", day.trips[selected.idx][2]);
  if (selected?.type === "station") u.searchParams.set("station", day.stations[selected.idx][3]);
  if (selected?.type === "alert") u.searchParams.set("alert", selected.idx);
  history.replaceState(null, "", u);
}

// ---------- panel ----------
const details = new Map(); // trip idx -> "loading" | { formation, formationStatus, occupancy, at }
const RETRY = { busy: 20_000, window: 120_000, error: 120_000, offline: 60_000, none: 4 * 3600_000 }; // statuses worth asking again, and when
function loadDetails(i) {
  const d = details.get(i);
  if (d === "loading" || (d && !(Date.now() - d.at > (RETRY[d.formationStatus] ?? Infinity)))) return;
  details.set(i, "loading");
  // the URL carries the day version: trip indexes change daily and the response is cached for minutes
  fetch(`/api/train/${i}?v=${encodeURIComponent(day.v)}`).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((x) => {
    const r = x ?? { formation: null, occupancy: null, formationStatus: "offline" };
    if (r.formationStatus === "busy") RETRY.busy = Math.max(5, r.retryAfter ?? 20) * 1000;
    details.set(i, { ...r, at: Date.now() });
    if (selected?.type === "train" && selected.idx === i) renderPanel();
  });
}

function open(type, idx, fly = false) {
  if (selected?.type !== "train" || selected.idx !== idx) setFollow(false);
  if (!selected) lastFocus = document.activeElement;
  selected = { type, idx, tab: "dep" };
  map.setFilter("station-selected", ["==", ["get", "i"], type === "station" ? idx : -1]);
  const a = type === "alert" ? live.alerts.find((x) => x.id === idx) : null;
  $("panel").hidden = false;
  $("panel").style.setProperty("--line", type === "train" ? styles[day.trips[idx][0]].c : a ? (a.sudden ? SEV[3] : SEV[a.sev]) : type === "issues" ? (idx === "standing" ? STANDING : SEV[idx === "now" ? 3 : idx]) : "#5cc8ff");
  if (type !== "train") map.getSource("route").setData(fc([]));
  setUrl();
  renderPanel();
  $("sr-status").textContent = `${$("panel-body").querySelector("h2")?.textContent ?? ""} opened`;
  if (lastFocus && lastFocus !== document.body && !$("map").contains(lastFocus)) $("close").focus({ preventScroll: true }); // keyboard users land in the panel
  if (!fly) return;
  if (a?.seg) {
    const b = new maplibregl.LngLatBounds();
    for (let k = 0; k < a.seg[0].length; k += 2) b.extend([a.seg[0][k], a.seg[0][k + 1]]);
    map.setPadding(NO_PAD); // fitBounds adds the camera's current padding to its own
    return map.fitBounds(b, { padding: camPad(40), maxZoom: 12, duration: 1200 });
  }
  const c = type === "station" ? day.stations[idx].slice(1, 3) : type === "train" ? trainPos(idx)
    : a?.s.length ? day.stations[a.s[0]].slice(1, 3) : a?.t.length ? trainPos(a.t[0]) : null;
  if (c) map.flyTo({ center: c, zoom: Math.max(map.getZoom(), type === "station" ? 11 : 10), duration: 1200, padding: camPad() });
}
const NO_PAD = { top: 0, bottom: 0, left: 0, right: 0 };
/** Where the panel covers the map: beside it on wide screens, the bottom sheet on phones. `extra` adds a margin all round. */
const camPad = (extra = 0) => {
  const sheet = innerWidth <= 760, h = sheet && !$("panel").hidden ? $("panel").offsetHeight || innerHeight * 0.58 : 0;
  return { top: 70 + extra, left: extra, right: (sheet || $("panel").hidden ? 0 : 430) + extra, bottom: h + extra };
};
const trainPos = (i) => { const r = positionOf(i, now(), 0); return r ? [r.q.lon, r.q.lat] : day.stations[day.trips[i][3][0]].slice(1, 3); };
function closePanel() {
  if (!selected) return;
  selected = null;
  $("panel").hidden = true;
  map.setFilter("station-selected", ["==", ["get", "i"], -1]);
  map.getSource("route").setData(fc([]));
  setFollow(false);
  setUrl();
  map.easeTo({ padding: NO_PAD, duration: 300 });
  lastFocus?.focus?.(); // back to where the keyboard was before the panel opened
  lastFocus = null;
}
$("close").onclick = closePanel;
// phones: swipe the bottom sheet down (from its top) to close it
let sheetY = null;
$("panel").addEventListener("touchstart", (e) => { sheetY = $("panel").scrollTop <= 0 ? e.touches[0].clientY : null; }, { passive: true });
$("panel").addEventListener("touchmove", (e) => { if (sheetY !== null && e.touches[0].clientY - sheetY > 90) { sheetY = null; closePanel(); } }, { passive: true });
function setFollow(on) {
  follow = on;
  $("panel").querySelector("[data-follow]")?.setAttribute("aria-pressed", String(on));
  if (on && selected?.type === "train") map.easeTo({ center: trainPos(selected.idx), zoom: Math.max(map.getZoom(), 10), duration: 800, padding: camPad() }); // zoom in once, then leave the zoom to the user
}

const delayText = (d) => (d >= 60 ? `<span class="${d >= 600 ? "very-late" : d >= 180 ? "late" : ""}">+${Math.round(d / 60)}′</span>` : "");
const alertHtml = (a) => `<div class="alert" style="--c:${a.sudden ? SEV[3] : SEV[a.sev]}"><span class="sev">${a.sudden ? "Just happened" : SEV_NAME[a.sev]} · ${esc(whyText(a))}</span><strong>${esc(a.h)}</strong>${a.d ? `<p>${esc(a.d)}</p>` : ""}<button class="more" data-alert="${a.id}">Details →</button></div>`;
const alertsHtml = (list) => {
  const liveOnes = list.filter((a) => a.sev > 1), planned = list.filter((a) => a.sev === 1);
  return liveOnes.map(alertHtml).join("") + (planned.length ? `<details class="planned"><summary>${planned.length} planned / notices</summary>${planned.map(alertHtml).join("")}</details>` : "");
};
const badge = (route) => `<span class="badge" style="background:${styles[route].c}">${esc(day.routes[route][0] || day.routes[route][1])}</span>`;
const LEVEL = ["", "low", "medium", "high"];
const meter = (o, cls) => (o ? `<span class="meter o${o}" title="${cls} class: ${LEVEL[o]} occupancy"><i></i><i></i><i></i></span>` : "");
/** Forecast occupancy, 1st and 2nd class, as two small bar meters. */
const meters = (o) => (o && (o[0] || o[1]) ? `<span class="meters">${meter(o[0], "1st")}${meter(o[1], "2nd")}</span>` : "<span></span>");

function renderPanel() {
  if (!selected || !day) return;
  const body = $("panel-body");
  const t = selected.type;
  // re-rendered every poll: keep what the user opened and where the keyboard is
  const opened = [...body.querySelectorAll("details")].map((d) => d.open), f = document.activeElement;
  const focusKey = body.contains(f) ? ["data-trip", "data-alert", "data-tab", "data-station", "data-follow", "data-share"].map((a) => f.hasAttribute(a) && `[${a}="${f.getAttribute(a)}"]`).find(Boolean) : null;
  body.innerHTML = t === "train" ? trainHtml(selected.idx) : t === "station" ? stationHtml(selected.idx) : t === "alert" ? alertPanelHtml(selected.idx) : issuesHtml(selected.idx);
  body.querySelectorAll("details").forEach((d, k) => opened[k] && (d.open = true));
  if (focusKey) body.querySelector(focusKey)?.focus({ preventScroll: true });
  for (const el of body.querySelectorAll("[data-station]")) el.onclick = () => open("station", +el.dataset.station, true);
  for (const el of body.querySelectorAll("[data-alert]")) {
    const go = () => open("alert", el.dataset.alert, true);
    el.onclick = go;
    el.onkeydown = (e) => e.key === "Enter" && go();
  }
  for (const li of body.querySelectorAll("[data-trip]")) {
    const go = () => open("train", +li.dataset.trip, true);
    li.onclick = go;
    li.onkeydown = (e) => e.key === "Enter" && go();
  }
  for (const b of body.querySelectorAll("[data-tab]")) b.onclick = () => { selected.tab = b.dataset.tab; renderPanel(); };
  body.querySelector("[data-follow]")?.addEventListener("click", () => setFollow(!follow));
  body.querySelector("[data-share]")?.addEventListener("click", (e) => {
    const btn = e.currentTarget, u = new URL(location.href); // currentTarget is gone by the time the promise settles
    u.searchParams.delete("zen");
    if (!navigator.clipboard) return void prompt("Link to this train", u.href); // http or old browsers
    navigator.clipboard.writeText(u.href).then(() => { btn.textContent = "Copied"; setTimeout(() => (btn.textContent = "Copy link"), 1200); }, () => prompt("Link to this train", u.href));
  });
}

function trainHtml(i) {
  const [route, head, num, sched] = day.trips[i];
  const e = expected(i), t = now(), cancelled = !!live.delays[i]?.c, p = locate(e.stops, t);
  const st = day.stations, n = sched.length / 3;
  loadDetails(i);
  const extra = details.get(i) === "loading" ? { formation: undefined, occupancy: null } : details.get(i);
  const d = p ? e.delay[p.b] : e.delay[n - 1];
  const chip = cancelled ? `<span class="chip off">Cancelled</span>` : d >= 60 ? `<span class="chip ${d >= 600 ? "very-late" : d >= 180 ? "late" : ""}">+${Math.round(d / 60)} min</span>` : `<span class="chip">On time</span>`;
  // before departure / after arrival by the *expected* times: a train delayed at its origin hasn't "arrived"
  const status = cancelled ? "" : p ? `${p.at ? "At" : "Next:"} ${esc(st[e.stops[p.b * 3]][0])}${platform(i, p.b) ? ` · Pl. ${esc(platform(i, p.b))}` : ""}` : t < e.stops[2] ? `Departs ${hhmm(e.stops[2])}` : "Arrived";
  const prog = !p ? (t < e.stops[2] ? 0 : 1) : (p.a + (p.b - p.a) * p.f) / (n - 1);
  const age = live.time ? Math.max(0, Math.round(Date.now() / 1000 + clockSkew / 1000 - live.time)) : null;
  const inc = incidentTrains.get(i), stuckSince = !cancelled && standing(i) && live.delays[i].x;
  const banner = inc ? `<button class="banner" data-alert="${inc.id}"><strong>${esc(whyText(inc))}</strong><span>${esc(inc.h)} · Details →</span></button>`
    : stuckSince ? `<div class="banner quiet"><strong>Probably standing</strong><span>Its expected delay at the next stop has been rising since ${clock(stuckSince)}. That's our inference from the forecasts, not a report.</span></div>` : "";
  let formation = "";
  const why = FORMATION_WHY[extra.formationStatus];
  if (extra.formation === undefined) formation = `<h3>Formation</h3><div class="sub">Loading…</div>`;
  else if (!extra.formation && why) formation = `<h3>Formation</h3><div class="sub">${why(extra)}</div>`;
  else if (extra.formation) {
    const f = extra.formation, units = extra.units ?? [], fs = extra.stops ?? [], facts = [];
    // the stop the passenger cares about: the next one (the origin before departure); its platform and the sector of each coach
    const nextUic = st[sched[(p ? p.b : 0) * 3]][3], si = fs.findIndex((x) => x.uic === nextUic), at = fs[si];
    const count = (k) => f.filter((c) => c.c.includes(k)).length, seats = units.reduce((a, u) => a + u.seats1 + u.seats2, 0), len = units.reduce((a, u) => a + u.length, 0);
    if (count("1")) facts.push(`<span>${count("1")}× 1st</span>`);
    if (count("2")) facts.push(`<span>${count("2")}× 2nd</span>`);
    if (seats) facts.push(`<span>${seats.toLocaleString("de-CH")} seats</span>`);
    if (len) facts.push(`<span>${Math.round(len)} m</span>`);
    if (f.some((c) => c.wr)) facts.push(`<span>${ICON.wr} Restaurant</span>`);
    if (f.some((c) => c.bike)) facts.push(`<span>${ICON.bike} Bikes</span>`);
    if (f.some((c) => c.wc)) facts.push(`<span>${ICON.wc} Wheelchair${f.some((c) => c.wct) ? " + toilet" : ""}</span>`);
    if (f.some((c) => c.fam)) facts.push(`<span>Family zone</span>`);
    if (f.some((c) => c.low)) facts.push(`<span>Low floor</span>`);
    let lastSec = "";
    const strip = f.map((c) => {
      const cls = c.wr ? "wr" : !c.c ? "loco" : c.c === "12" ? "c12" : c.c.includes("1") ? "c1" : "";
      const title = [c.n ? `Coach ${c.n}` : "", c.wr ? "restaurant" : !c.c ? "locomotive / driving car" : `${c.c.split("").join("/")}. class`, c.bike && "bikes", c.wc && "wheelchair spaces",
        c.wct && "wheelchair toilet", c.fam && "family zone", c.biz && "business zone", c.low && "low floor", c.st, c.closed && "closed", at && c.sec?.[si] && `sector ${c.sec[si]}`].filter(Boolean).join(", ");
      const sec = at && c.sec?.[si] && c.sec[si] !== lastSec ? c.sec[si] : "";
      if (at && c.sec?.[si]) lastSec = c.sec[si];
      return `<span class="car"><span class="coach ${cls}${c.closed ? " closed" : ""}${c.st ? " odd" : ""}" title="${esc(title)}">${c.wr ? "WR" : c.n ? c.n : esc(c.c) || "·"}</span><i>${esc(sec)}</i></span>`;
    }).join("");
    const where = at ? `${esc(st[sched[(p ? p.b : 0) * 3]][0])}${at.track ? ` · Pl. ${esc(at.track)}` : ""}${at.moved ? ` <span class="moved">platform changed</span>` : ""}` : "";
    const nameOf = (uic) => day.stations[uicIndex().get(uic)]?.[0] ?? uic;
    const dests = [...new Set((extra.goals ?? []).map((g) => g[2]))];
    const split = dests.length > 1 ? `<div class="sub">Splits: ${extra.goals.map(([a, b, uic]) => `cars ${a}–${b} → ${esc(nameOf(uic))}`).join(" · ")}</div>` : "";
    const first = st[sched[0]][3], lastUic = st[sched[(n - 1) * 3]][3];
    const partial = units.filter((u) => (u.from && u.from !== first) || (u.to && u.to !== lastUic));
    formation = `<h3>Formation${where ? ` <small>at ${where}</small>` : ""}</h3><div class="formation" aria-label="Coach formation, coach numbers${at ? " and platform sectors" : ""}">${strip}</div>${split}<div class="facts">${facts.join("")}</div>`
      + (units.length ? `<div class="unit-row">${units.map((u) => `<a href="/stats#/vehicle/${encodeURIComponent(u.id)}" title="This trainset's day and history">${esc(u.type)} <b>${esc(u.id)}</b></a>`).join("")}</div>` : "")
      + (partial.length ? `<div class="sub">${partial.map((u) => `${esc(u.type)} ${esc(u.id)} only ${esc(nameOf(u.from || first))} → ${esc(nameOf(u.to || lastUic))}`).join(" · ")}</div>` : "");
  }
  const occ = extra.occupancy;
  const stops = Array.from({ length: n }, (_, k) => {
    const s = st[sched[k * 3]], pl = k === 0 ? sched[2] : sched[k * 3 + 1];
    const ex = k === 0 ? e.stops[2] : e.stops[k * 3 + 1];
    const past = (k === 0 ? e.stops[2] : e.stops[k * 3 + 2]) < t, pf = platform(i, k), dwell = k && k < n - 1 ? sched[k * 3 + 2] - sched[k * 3 + 1] : 0;
    return `<li class="${past ? "past" : ""}${e.skipped[k] ? " skipped" : ""}">
      <span>${hhmm(pl)}</span><span class="exp">${ex - pl >= 60 ? delayText(ex - pl) : ""}</span>
      <span class="name" title="${esc(s[0])}">${esc(s[0])}${dwell >= 180 ? ` <small>dep. ${hhmm(sched[k * 3 + 2])}</small>` : ""}</span><span class="pl">${pf ? `Pl. ${esc(pf)}` : ""}</span>${meters(occ?.[s[3]])}</li>`;
  }).join("");
  return `<h2>${badge(route)} <span>${esc(num)}</span> ${chip}</h2>
    <div class="sub">${esc(st[sched[0]][0])} → ${esc(head || st[sched[(n - 1) * 3]][0])}${status ? ` · ${status}` : ""}${age !== null && live.delays[i] ? ` · <span class="age">live data ${age < 90 ? `${age} s` : `${Math.round(age / 60)} min`} old</span>` : ""}</div>
    <div class="progress"><i style="--p:${prog.toFixed(4)}"></i></div>
    ${banner}<div class="actions"><button data-follow aria-pressed="${follow}"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="10" cy="10" r="1.8" fill="currentColor"/></svg>Follow</button><button data-share>Copy link</button><a href="/stats#/train/${encodeURIComponent(num)}">Stats ↗</a></div>
    ${alertsHtml(live.alerts.filter((a) => a.t.includes(i) || a.r.includes(route)))}${formation}
    <h3>Stops</h3><ol class="stops stem" style="--p:${prog.toFixed(4)}">${p && !cancelled ? `<span class="pos"></span>` : ""}${stops}</ol>`;
}

const FORMATION_WHY = {
  none: () => "Not published for this train (or not yet: asked again in a few hours).",
  past: () => "Only available for today's trains; this run started yesterday.",
  unsupported: () => "This operator doesn't publish coach formations.",
  window: () => "Looked up from an hour before departure until two hours after arrival.",
  busy: (x) => `Lookups are busy right now (shared request quota). Retrying in ${Math.max(5, x.retryAfter ?? 20)} s…`,
  budget: () => "Today's formation lookups are used up (daily request quota). They reset at midnight.",
  error: () => "The formation service didn't answer. Trying again in a couple of minutes.",
  offline: () => "Couldn't reach the server. Trying again in a minute.",
};

function stationHtml(si) {
  const [name] = day.stations[si], t = now(), arr = selected.tab === "arr";
  const rows = byStation[si].flatMap(([i, p]) => {
    const s = day.trips[i][3], last = p === s.length / 3 - 1;
    if (arr ? p === 0 : last) return []; // starts / terminates here
    const e = expected(i), sched = arr ? s[p * 3 + 1] : s[p * 3 + 2], ex = arr ? e.stops[p * 3 + 1] : e.stops[p * 3 + 2];
    if (e.skipped[p]) return []; // doesn't stop here today
    return ex >= t - 60 && sched <= t + 5400 ? [[ex, sched, i, p]] : [];
  }).sort((a, b) => a[0] - b[0]).slice(0, 30).map(([ex, sched, i, p]) => {
    const [route, head, , s] = day.trips[i], pf = platform(i, p);
    const state = live.delays[i]?.c ? `<span class="very-late">cancelled</span>` : delayText(ex - sched);
    const where = arr ? `from ${esc(day.stations[s[0]][0])}` : esc(head);
    return `<li data-trip="${i}" tabindex="0"><span>${hhmm(sched)}</span>${badge(route)}<span>${where}</span><span class="pl">${pf ? `Pl. ${esc(pf)}` : ""}</span><span>${state}</span></li>`;
  }).join("");
  return `<h2>${esc(name)}</h2><div class="sub">${byStation[si].length} trains today · <a class="inline" href="/stats#/station/${encodeURIComponent(day.stations[si][3])}">Stats ↗</a></div>
    ${alertsHtml(live.alerts.filter((a) => a.s.includes(si)))}
    <div class="tabs" role="tablist"><button role="tab" data-tab="dep" aria-selected="${!arr}">Departures</button><button role="tab" data-tab="arr" aria-selected="${arr}">Arrivals</button></div>
    <ol class="stops deps">${rows || `<li class="empty">Nothing in the next 90 minutes</li>`}</ol>`;
}

/** One clickable train row: time, line, destination, platform, state. */
function tripRow(i, sched, ex, where, pf = "") {
  const issue = trainIssue(i);
  const state = live.delays[i]?.c ? `<span class="very-late">cancelled</span>` : issue ? `<span class="very-late">${esc(issue)}</span>` : delayText(ex - sched) + (standing(i) ? ` <span class="standing" title="Probably standing (inferred)">●</span>` : "");
  return `<li data-trip="${i}" tabindex="0"><span>${hhmm(sched)}</span>${badge(day.trips[i][0])}<span>${where}</span><span class="pl">${pf ? `Pl. ${esc(pf)}` : ""}</span><span>${state}</span></li>`;
}
/** Trains of these trips/lines that are running right now, with their current delay. */
function runningRows(trips) {
  const t = now();
  return trips.flatMap((i) => {
    const e = expected(i), p = locate(e.stops, t);
    if (!p) return [];
    const s = day.trips[i][3];
    return [tripRow(i, s[p.b * 3 + 1], e.stops[p.b * 3 + 1], `→ ${esc(day.trips[i][1])}`)];
  });
}

function alertPanelHtml(id) {
  const a = live.alerts.find((x) => x.id === id);
  if (!a) return `<h2>Disruption</h2><div class="sub">This disruption is no longer reported.</div>`;
  const c = a.sudden ? SEV[3] : SEV[a.sev], ago = a.from ? Math.round((Date.now() / 1000 - a.from) / 60) : null;
  const when = [a.from ? `since ${dateClock(a.from)}` : "", a.to ? `until ≈ ${dateClock(a.to)}` : "",
    ago !== null ? `started ${ago < 60 ? `${ago} min` : ago < 1440 ? `${Math.floor(ago / 60)} h ${ago % 60} min` : `${Math.floor(ago / 1440)} days`} ago` : ""].filter(Boolean).join(" · ");
  const span = a.s.map((s) => `<button class="stn" data-station="${s}">${esc(day.stations[s][0])}</button>`).join(`<span class="arrow">${a.s.length === 2 ? "↔" : "·"}</span>`);
  const lines = [...new Set(a.r)].map(badge).join("");
  const t = now();
  const onLines = a.t.length ? a.t : day.trips.map((_, i) => i).filter((i) => a.r.includes(day.trips[i][0]) && locate(expected(i).stops, t));
  const rows = runningRows(onLines.slice(0, 40)).slice(0, 15).join("");
  return `<span class="sev-tag" style="--c:${c}">${a.sudden ? "Just happened" : SEV_NAME[a.sev]}</span>
    <div class="kind-title">${esc(whyText(a))}</div>
    <div class="sub">${when}</div>
    <p class="headline">${esc(a.h)}</p>${a.d ? `<p class="desc">${esc(a.d)}</p>` : ""}
    ${a.u ? `<a class="ticker" href="${esc(a.u)}" target="_blank" rel="noopener">Live ticker ↗</a>` : ""}
    ${span ? `<h3>Where</h3><div class="span">${span}</div>` : ""}
    ${lines ? `<h3>Lines</h3><div class="lines">${lines}</div>` : ""}
    <h3>Affected trains now</h3><ol class="stops deps">${rows || `<li class="empty">No affected train is running right now</li>`}</ol>
    <p class="sub"><a class="inline" href="/stats#/incidents">All disruptions of the last 30 days ↗</a></p>`;
}

function issuesHtml(which) {
  if (which === "standing") {
    const rows = runningRows(standingTrains()).join("");
    return `<h2>Probably standing</h2><div class="sub">Trains whose expected delay at their next stop keeps rising. An inference from the forecasts, not a reported incident: often a short wait for a connection or a slot.</div>
      ${rows ? `<ol class="stops deps">${rows}</ol>` : `<div class="empty">None right now.</div>`}`;
  }
  const list = which === "now" ? live.alerts.filter((a) => a.sudden) : live.alerts.filter((a) => a.sev === +which);
  const items = list.map((a) => `<li data-alert="${a.id}" tabindex="0" style="--c:${a.sudden ? SEV[3] : SEV[a.sev]}"><span class="sev-dot"></span>
    <div><strong>${esc(a.h)}</strong><small>${esc(whyText(a))}${a.from ? ` · since ${clock(a.from)}` : ""}</small></div></li>`).join("");
  const title = which === "now" ? "Incidents right now" : SEV_NAME[which];
  return `<h2>${title}</h2><div class="sub">${list.length} disruption${list.length === 1 ? "" : "s"}</div>
    ${items ? `<ol class="issues">${items}</ol>` : `<div class="empty">Nothing right now.</div>`}`;
}
