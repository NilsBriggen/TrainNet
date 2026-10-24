// Pure timetable math shared by browser and tests. Times are seconds from the service day's base.

/**
 * Expected times after applying sparse realtime updates [[stopPos, arrDelay, depDelay, skipped], ...].
 * A delay carries forward to later stops until the next update (GTFS-RT semantics).
 * Returns flat [station, arr, dep, ...] like the input, plus per-stop delay and skipped flags.
 */
export function applyDelays(stops, updates = []) {
  const n = stops.length / 3, out = stops.slice(), delay = new Array(n).fill(0), skipped = new Array(n).fill(false);
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
    d = depD;
  }
  return { stops: out, delay, skipped };
}

/**
 * Where a trip is at time t: null if not running, else { a, b, f, at }
 * a/b = stop positions (equal while standing at a stop), f = 0..1 between them.
 */
export function locate(stops, t) {
  const n = stops.length / 3;
  if (t < stops[2] || t > stops[(n - 1) * 3 + 1]) return null;
  let lo = 0, hi = n - 1; // last stop whose arrival <= t
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    stops[mid * 3 + 1] <= t ? (lo = mid) : (hi = mid - 1);
  }
  if (t <= stops[lo * 3 + 2] || lo === n - 1) return { a: lo, b: lo, f: 0, at: true };
  const dep = stops[lo * 3 + 2], arr = stops[(lo + 1) * 3 + 1];
  return { a: lo, b: lo + 1, f: arr > dep ? (t - dep) / (arr - dep) : 1, at: false };
}

/**
 * Share of a segment covered at time share f (0..1) of its running time `dur` (s): accelerate, cruise, brake.
 * Trains visibly slow into stations and pull away instead of gliding at one speed. Acceleration takes
 * ~45 s (at most 30 % of the segment each way), the same for every train: a look, not physics.
 */
export function motion(f, dur) {
  const a = Math.min(0.3, 45 / Math.max(dur, 1)), v = 1 / (1 - a); // cruise speed so the whole segment takes exactly dur
  if (f <= 0) return 0;
  if (f >= 1) return 1;
  if (f < a) return (0.5 * v * f * f) / a;
  if (f > 1 - a) return 1 - (0.5 * v * (1 - f) * (1 - f)) / a;
  return v * (f - a / 2);
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
