// Pure timetable math shared by browser and tests. Times are seconds from the service day's base.

/**
 * Expected times after applying sparse realtime updates [[stopPos, arrDelay, depDelay, skipped], ...].
 * A delay carries forward to later stops until the next update (GTFS-RT semantics).
 * Returns flat [station, arr, dep, ...] like the input, plus per-stop delay and skipped flags.
 */
export function applyDelays(stops, updates = []) {
  const n = stops.length / 3, out = stops.slice(), delay = new Array(n).fill(0), dep = new Array(n).fill(0), skipped = new Array(n).fill(false);
  let d = 0, u = 0;
  for (let i = 0; i < n; i++) {
    let arrD = d, depD = d;
    while (u < updates.length && updates[u][0] < i) u++;
    if (u < updates.length && updates[u][0] === i) {
      const [, a, dp, s] = updates[u];
      arrD = a ?? dp ?? d;
      depD = dp ?? a ?? d;
      skipped[i] = !!s;
    }
    out[i * 3 + 1] = stops[i * 3 + 1] + arrD;
    out[i * 3 + 2] = Math.max(stops[i * 3 + 2] + depD, out[i * 3 + 1]);
    delay[i] = arrD;
    dep[i] = depD;
    d = depD;
  }
  return { stops: out, delay, dep, skipped };
}

const NO_OFF = () => 0;
/**
 * When the train rolls away from stop k: its expected departure plus off(k), the seconds a train really takes to
 * leave after the feed's departure (never past a third of the run to the next stop, so a tight leg stays runnable).
 */
export function departure(stops, k, off = NO_OFF) {
  const d = stops[k * 3 + 2], a = stops[k * 3 + 4];
  return a === undefined ? d : d + Math.min(off(k), Math.max(0, (a - d) / 3));
}

/**
 * Where a trip is at time t: null if not running, else { a, b, f, at }
 * a/b = stop positions (equal while standing at a stop), f = 0..1 between them. off(k): see departure().
 */
export function locate(stops, t, off = NO_OFF) {
  const n = stops.length / 3;
  if (t < departure(stops, 0, off) || t > stops[(n - 1) * 3 + 1]) return null;
  let lo = 0, hi = n - 1; // last stop whose arrival <= t
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    stops[mid * 3 + 1] <= t ? (lo = mid) : (hi = mid - 1);
  }
  if (lo === n - 1) return { a: lo, b: lo, f: 0, at: true };
  const dep = departure(stops, lo, off), arr = stops[(lo + 1) * 3 + 1];
  if (t <= dep) return { a: lo, b: lo, f: 0, at: true };
  return { a: lo, b: lo + 1, f: arr > dep ? (t - dep) / (arr - dep) : 1, at: false };
}

/**
 * Speed profile of one train over one stretch, { s, t, v } on a 25 m grid (metres, seconds from departure, m/s):
 * the fastest physical run under the line speeds (tractive effort constant to 40 km/h then constant power, so a(v) =
 * a0·min(1, 11.1/v); service braking b; top speed vmax), fitted to the T seconds the feed gives the run. Slack goes
 * into running under the line speed (the caps scaled down until the time fits, as ADL-driven trains do), never into
 * softer acceleration or braking. speeds: [{ d0, d1, v }] km/h in travel order, untagged track at `untagged` km/h.
 * tr: { a0, b, vmax } from traction().
 */
export function profile(len, speeds, tr, T, untagged = 80) {
  if (!(len > 0) || !(T > 0)) return { s: [0, Math.max(0, len)], t: [0, 0], v: [0, 0] };
  const n = Math.max(2, Math.ceil(len / 25)), h = len / n, s = new Float64Array(n + 1), lim = new Float64Array(n + 1);
  for (let i = 1; i < n; i++) {
    s[i] = i * h;
    lim[i] = Math.min(tr.vmax, speeds.find((x) => s[i] >= x.d0 && s[i] <= x.d1)?.v ?? untagged) / 3.6;
  }
  s[n] = len;
  const acc = (v) => tr.a0 * Math.min(1, 11.1 / Math.max(v, 0.1));
  const run = (k) => {
    const v = new Float64Array(n + 1), t = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) v[i + 1] = Math.min(k * lim[i + 1], Math.sqrt(v[i] * v[i] + 2 * acc(v[i]) * h));
    for (let i = n; i > 0; i--) v[i - 1] = Math.min(v[i - 1], Math.sqrt(v[i] * v[i] + 2 * tr.b * h));
    for (let i = 0; i < n; i++) t[i + 1] = t[i] + (2 * h) / (v[i] + v[i + 1]);
    return { v, t };
  };
  let best = run(1);
  if (best.t[n] < T) { // slack: cruise slower, found by bisection on the cap factor
    let lo = 0, hi = 1;
    for (let r = 0; r < 14; r++) { const k = (lo + hi) / 2, p = run(k); p.t[n] > T ? (lo = k) : ((hi = k), (best = p)); }
  }
  // the last metres of fit, and a run the feed gives less time than physics allows (a late departure with an unchanged
  // arrival, or untagged track that is really faster than 80): the same run on a faster clock
  const f = T / best.t[n];
  return { s, t: best.t.map((x) => x * f), v: best.v.map((x) => x / f) };
}
const slot = ({ t }, tau) => { // last grid point reached at tau seconds
  let lo = 0, hi = t.length - 2;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; t[mid] <= tau ? (lo = mid) : (hi = mid - 1); }
  return lo;
};
const share = ({ t }, k, tau) => (t[k + 1] > t[k] ? Math.min(1, Math.max(0, (tau - t[k]) / (t[k + 1] - t[k]))) : 1);
/** Metres along the stretch tau seconds after departure, by profile(). */
export function distanceAt(p, tau) {
  const k = slot(p, tau);
  return p.s[k] + share(p, k, tau) * (p.s[k + 1] - p.s[k]);
}
/** Speed (m/s) tau seconds after departure, by profile(). */
export function speedAt(p, tau) {
  const k = slot(p, tau), u = share(p, k, tau);
  return p.v[k] + u * (p.v[k + 1] - p.v[k]);
}

/**
 * The drawn distance along a trip for this frame: d = drawn last frame, target = where the forecast puts it now,
 * own = how far the forecast moved it since the last frame (its own speed), dt = ms. A new forecast is rolled into,
 * never jumped to: behind, it catches up at most 25 m/s; ahead (a later forecast), it creeps at 30 % of its speed
 * until the forecast catches up, so it neither rolls back nor stops dead mid-line. Over 5 km off it snaps.
 */
export function ease(d, target, own, dt) {
  if (d === undefined || Math.abs(d - target) > 5000) return target;
  if (d > target) return d + 0.3 * Math.max(0, own);
  d = Math.min(target, d + Math.max(0, own));
  return d + Math.min((target - d) * (1 - Math.exp(-dt / 4000)), (dt / 1000) * 25);
}

/**
 * Which end of a drawn formation is the front of the train: "left", "right" or null (unknown).
 * from → to: [lon, lat] of this stop and the next (at a terminus: the previous stop and this one).
 * ends: [lon, lat] of the platform's first sector and of its last ([lonA, latA, lonZ, latZ]).
 * first / last: sector letter of the strip's first (left) and last (right) coach.
 */
export function frontEnd(from, to, ends, first, last) {
  if (!ends || !first || !last || first === last) return null;
  const kx = Math.cos((from[1] * Math.PI) / 180), dx = (to[0] - from[0]) * kx, dy = to[1] - from[1];
  const along = (lon, lat) => (lon - from[0]) * kx * dx + (lat - from[1]) * dy;
  const firstSectorAhead = along(ends[0], ends[1]) > along(ends[2], ends[3]), firstSectorLeft = first < last;
  return firstSectorAhead === firstSectorLeft ? "left" : "right";
}

/** Decode a server path (delta-encoded ints at 1e-5°) into { pts: [lon,lat,...], cum: [0, m, ...] }. */
export function unpackPath(packed) {
  const pts = new Float64Array(packed.length), n = packed.length / 2, cum = new Float64Array(n);
  for (let i = 0; i < packed.length; i++) pts[i] = (packed[i] + (i < 2 ? 0 : pts[i - 2] * 1e5)) / 1e5;
  for (let i = 1; i < n; i++) {
    const dx = (pts[i * 2] - pts[i * 2 - 2]) * 111320 * Math.cos((pts[i * 2 + 1] * Math.PI) / 180), dy = (pts[i * 2 + 1] - pts[i * 2 - 1]) * 110540;
    cum[i] = cum[i - 1] + Math.hypot(dx, dy);
  }
  return { pts, cum };
}

/** Point and compass bearing at fraction f (0..1 of length) along a path; reverse=true walks it backwards. */
export function along({ pts, cum }, f, reverse = false) {
  const n = cum.length, total = cum[n - 1];
  if (reverse) f = 1 - f;
  const d = Math.max(0, Math.min(1, f)) * total;
  let lo = 0, hi = n - 1; // last vertex with cum <= d
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    cum[mid] <= d ? (lo = mid) : (hi = mid - 1);
  }
  const i = Math.min(lo, n - 2), seg = cum[i + 1] - cum[i], t = seg > 0 ? (d - cum[i]) / seg : 0;
  const x0 = pts[i * 2], y0 = pts[i * 2 + 1], x1 = pts[i * 2 + 2], y1 = pts[i * 2 + 3];
  let bearing = (Math.atan2((x1 - x0) * Math.cos((y0 * Math.PI) / 180), y1 - y0) * 180) / Math.PI;
  if (reverse) bearing += 180;
  return { lon: x0 + (x1 - x0) * t, lat: y0 + (y1 - y0) * t, bearing: (bearing + 360) % 360 };
}

/** Split a path at fraction f: { behind: [lon,lat,...], ahead: [...] } in travel direction. */
export function cut(path, f, reverse = false) {
  const { pts, cum } = path, n = cum.length, p = along(path, f, reverse);
  const d = (reverse ? 1 - f : f) * cum[n - 1];
  let k = 0;
  while (k < n - 1 && cum[k + 1] <= d) k++;
  const before = Array.from(pts.subarray(0, (k + 1) * 2)), after = Array.from(pts.subarray((k + 1) * 2));
  const cutPt = [p.lon, p.lat];
  // stored path runs min→max station; when travelling the other way, "behind" is the far end
  return reverse ? { behind: rev([...cutPt, ...after]), ahead: rev([...before, ...cutPt]) } : { behind: [...before, ...cutPt], ahead: [...cutPt, ...after] };
}
// reverse a flat [lon,lat,...] list pointwise
function rev(flat) {
  const out = [];
  for (let i = flat.length - 2; i >= 0; i -= 2) out.push(flat[i], flat[i + 1]);
  return out;
}

/**
 * Trip-level distance model: `route` = [{ path, reverse }] per segment in travel order.
 * cumStops(route) → metres at each stop; atDistance(route, cum, d) → { lon, lat, bearing } on the track.
 */
export function cumStops(route) {
  const out = [0];
  for (const r of route) out.push(out[out.length - 1] + r.path.cum[r.path.cum.length - 1]);
  return out;
}
/**
 * Per stop: does the train leave it back the way it came (the other end leads from here, as at Bern or Zürich HB)?
 * The track's direction 30 m before the stop against 30 m after, a turn of more than 120°.
 */
export function reversals(route, cum) {
  return cum.map((d, k) => {
    if (k === 0 || k === cum.length - 1) return false;
    const m = Math.min(30, (d - cum[k - 1]) / 2, (cum[k + 1] - d) / 2), a = atDistance(route, cum, d - m).bearing, b = atDistance(route, cum, d + m).bearing;
    return Math.abs(((b - a + 540) % 360) - 180) > 120;
  });
}
export function atDistance(route, cum, d) {
  const n = route.length;
  let k = 0;
  while (k < n - 1 && cum[k + 1] <= d) k++;
  const len = cum[k + 1] - cum[k];
  return along(route[k].path, len > 0 ? (d - cum[k]) / len : 0, route[k].reverse);
}

/** Flat [lon,lat,...] along a trip's track between trip distances d0 < d1 (metres), crossing stations. */
export function slice(route, cum, d0, d1) {
  const total = cum[cum.length - 1];
  d0 = Math.max(0, d0);
  d1 = Math.min(total, d1);
  if (d1 <= d0) return [];
  const a = atDistance(route, cum, d0), out = [a.lon, a.lat];
  const push = (x, y) => { if (out[out.length - 2] !== x || out[out.length - 1] !== y) out.push(x, y); };
  let k = 0;
  while (k < route.length - 1 && cum[k + 1] <= d0) k++;
  for (; k < route.length && cum[k] < d1; k++) {
    const { path, reverse } = route[k], n = path.cum.length, len = path.cum[n - 1];
    for (let j = 0; j < n; j++) {
      const v = reverse ? n - 1 - j : j, dv = cum[k] + (reverse ? len - path.cum[v] : path.cum[v]);
      if (dv > d0 && dv < d1) push(path.pts[v * 2], path.pts[v * 2 + 1]);
    }
  }
  const b = atDistance(route, cum, d1);
  push(b.lon, b.lat);
  return out;
}

/**
 * A train whose front is at trip distance `dist`, as one [lon,lat,...] piece per car (`lens`: car lengths in metres, front
 * car first; `gap` m between cars), cut from the trip's own track with slice(): it lies on the rail by construction. The
 * front car stops `nose` m short of the front and the rear car starts `tail` m after the rear (room for the drawn cab ends).
 * Each car runs from its rear to its front; cars that would be behind the trip's start are left out.
 */
export function cars(route, cum, dist, lens, gap = 1.5, nose = 0, tail = 0) {
  const out = [];
  let front = dist;
  lens.forEach((len, k) => {
    const rear = front - len, piece = slice(route, cum, rear + (k === lens.length - 1 ? tail : gap / 2), front - (k ? gap / 2 : nose));
    if (piece.length >= 4) out.push(piece);
    front = rear;
  });
  return out;
}

/**
 * Rigid cars: like cars(), but each car is a straight piece through its two bogies, which run on the track 15 % of the car's
 * length in from its ends: cars don't bend, the links between them do. Returns { pieces (front car first, [lon,lat,lon,lat]),
 * outline (one line rear → front through every car's ends, for the casing), front, rear } with front/rear the train's
 * outer ends as { lon, lat, bearing } along their car (rear null when the train reaches back past the trip's start).
 */
export function rigidCars(route, cum, dist, lens, gap = 1.5, nose = 0, tail = 0) {
  const total = cum[cum.length - 1], pieces = [], ends = [];
  let front = Math.min(dist, total), first = null, last = null;
  lens.forEach((len, k) => {
    const r = Math.max(0, front - len), f = front;
    front -= len;
    if (f - r < 1) return;
    const ins = Math.min(0.15 * len, (f - r) / 3), A = atDistance(route, cum, r + ins), B = atDistance(route, cum, f - ins);
    const kx = 111320 * Math.cos((A.lat * Math.PI) / 180), ky = 111320;
    let ux = (B.lon - A.lon) * kx, uy = (B.lat - A.lat) * ky;
    const l = Math.hypot(ux, uy) || 1;
    ux /= l; uy /= l;
    const at = (P, m) => [P.lon + (ux * m) / kx, P.lat + (uy * m) / ky], bearing = (Math.atan2(ux, uy) * 180) / Math.PI;
    const outer = k === lens.length - 1 || front <= 0, back = outer ? (r > 0 ? tail : 0) : gap / 2; // cut off at the trip's start: no cab there
    const R = at(A, -ins), F = at(B, ins);
    pieces.push([...at(A, -ins + back), ...at(B, ins - (k ? gap / 2 : nose))]);
    ends.push([outer ? at(A, -ins + back) : R, k ? F : at(B, ins - nose)]);
    if (!k) first = { lon: F[0], lat: F[1], bearing };
    last = r > 0 && outer ? { lon: R[0], lat: R[1], bearing } : null;
  });
  return { pieces, outline: ends.reverse().flat(2), front: first, rear: last };
}

/** Metres between two points (equirectangular: plenty for a few km). */
export const metres = (lon1, lat1, lon2, lat2) => Math.hypot((lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180), lat2 - lat1) * 111_320;

/**
 * Which train a moving phone is on: the candidate whose position at each sample's time stays closest to it.
 * samples: [{ t, lon, lat }] (t on the trains' clock); positionAt(i, t) → [lon, lat] or null (not running).
 * Null when no train stays within `within` metres on average, or a second one fits nearly as well (two trains side by side).
 */
export function matchTrain(samples, candidates, positionAt, within = 300) {
  let best = null, second = Infinity;
  for (const i of candidates) {
    let sum = 0;
    for (const s of samples) {
      const p = positionAt(i, s.t);
      if (!p) { sum = Infinity; break; }
      sum += metres(s.lon, s.lat, p[0], p[1]);
    }
    const m = sum / samples.length;
    if (!best || m < best.m) { second = best?.m ?? Infinity; best = { i, m }; }
    else second = Math.min(second, m);
  }
  return best && best.m < within && second > 1.5 * best.m ? best.i : null;
}

/**
 * Line kilometres (SBB's km markers, every 100–300 m along each line) indexed for lookups by position.
 * lines: { "290": { n: "Bern - Thun", p: [lon, lat, km, ...] in km order } }.
 */
export function kmIndex(lines) {
  const cells = new Map();
  for (const [line, { p }] of Object.entries(lines))
    for (let i = 0; i < p.length; i += 3) {
      const k = `${Math.floor(p[i] / 0.004)}|${Math.floor(p[i + 1] / 0.003)}`; // ~300 m cells
      (cells.get(k) ?? cells.set(k, []).get(k)).push(line, i);
    }
  return { lines, cells };
}
/** { line, name, km } at a position: the nearest marker within `max` m, interpolated towards its neighbour on that line. */
export function kmAt({ lines, cells }, lon, lat, max = 80) {
  const cx = Math.floor(lon / 0.004), cy = Math.floor(lat / 0.003);
  let best = null;
  for (let x = cx - 1; x <= cx + 1; x++) for (let y = cy - 1; y <= cy + 1; y++) {
    const c = cells.get(`${x}|${y}`) ?? [];
    for (let j = 0; j < c.length; j += 2) {
      const p = lines[c[j]].p, i = c[j + 1], d = metres(lon, lat, p[i], p[i + 1]);
      if (d <= max && (!best || d < best.d)) best = { d, line: c[j], i };
    }
  }
  if (!best) return null;
  const p = lines[best.line].p, i = best.i;
  // the position projected onto the marker's segment towards the previous or the next marker, whichever it lies along
  let km = p[i + 2], off = Infinity;
  for (const j of [i - 3, i + 3]) {
    if (j < 0 || j >= p.length) continue;
    const kx = Math.cos((lat * Math.PI) / 180), ax = (p[j] - p[i]) * kx, ay = p[j + 1] - p[i + 1], bx = (lon - p[i]) * kx, by = lat - p[i + 1];
    const len2 = ax * ax + ay * ay, t = len2 ? (ax * bx + ay * by) / len2 : 0;
    if (t < 0 || t > 1) continue;
    const o = Math.abs(ax * by - ay * bx) / Math.sqrt(len2);
    if (o < off) { off = o; km = p[i + 2] + t * (p[j + 2] - p[i + 2]); }
  }
  return { line: best.line, name: lines[best.line].n, km: Math.round(km * 10) / 10 };
}
