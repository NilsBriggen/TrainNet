import { expect, test } from "bun:test";
import { applyDelays, distanceAt, ease, frontEnd, locate, matchTrain, motion, timeTable } from "../public/position.js";

// station, arr, dep: A 10:00 dep, B 10:10-10:12, C 10:20
const T = [0, 36000, 36000, 1, 36600, 36720, 2, 37200, 37200];

test("not running before first departure or after last arrival", () => {
  expect(locate(T, 35999)).toBeNull();
  expect(locate(T, 37201)).toBeNull();
});

test("interpolates between stops and dwells at stops", () => {
  expect(locate(T, 36300)).toEqual({ a: 0, b: 1, f: 0.5, at: false });
  expect(locate(T, 36650)).toEqual({ a: 1, b: 1, f: 0, at: true });
  expect(locate(T, 37200)).toEqual({ a: 2, b: 2, f: 0, at: true });
});

test("times past midnight (>24:00) work like any other", () => {
  const night = [0, 86000, 86000, 1, 87000, 87000];
  expect(locate(night, 86500).f).toBe(0.5);
});

test("delay carries forward until the next update", () => {
  const { stops, delay } = applyDelays(T, [[1, 300, 240]]);
  expect(delay).toEqual([0, 300, 240]);
  expect(stops.slice(3)).toEqual([1, 36900, 36960, 2, 37440, 37440]);
});

test("departure never before arrival, missing side falls back", () => {
  const { stops } = applyDelays(T, [[1, 600, null], [2, null, 0]]);
  expect(stops[4]).toBe(37200); // arr B +600
  expect(stops[5]).toBe(37320); // dep B uses arr delay
  expect(stops[7]).toBe(37200); // C back on time
});

test("skipped stops are flagged", () => {
  expect(applyDelays(T, [[1, 0, 0, 1]]).skipped).toEqual([false, true, false]);
});

import { along, unpackPath } from "../public/position.js";

// L-shaped path: 1 km east, then 2 km north (at lat 47, 1 km ≈ 0.01317° lon, ≈ 0.00905° lat)
const L = unpackPath([850000, 4700000, 1317, 0, 0, 1810]);

test("along moves at constant speed by distance, not by vertex", () => {
  expect(L.cum[2]).toBeCloseTo(3000, -2);
  const p = along(L, 1 / 3); // 1 km in = the corner
  expect(p.lon).toBeCloseTo(8.51317, 4);
  expect(p.lat).toBeCloseTo(47, 4);
  expect(along(L, 2 / 3).lat).toBeCloseTo(47.00905, 4);
});

test("bearing follows the track, reversed when travelling backwards", () => {
  expect(along(L, 0.1).bearing).toBeCloseTo(90, 0);
  expect(along(L, 0.6).bearing).toBeCloseTo(0, 0);
  expect(along(L, 0.1, true).bearing).toBeCloseTo(180, 0); // 10% from the far end, heading south
  expect(along(L, 0.9, true).bearing).toBeCloseTo(270, 0);
});

import { cut, cumStops, atDistance, slice, cars, metres } from "../public/position.js";
test("cut splits at the position, oriented in travel direction", () => {
  const c = cut(L, 0.2); // 600 m in, before the corner
  expect(c.behind.length).toBe(4); // start + cut point
  expect(c.ahead[0]).toBeCloseTo(8.5079, 3); expect(c.ahead.length).toBe(6);
  const r = cut(L, 1 / 3, true); // travelling from the north end, 1 km in
  expect(r.behind[0]).toBeCloseTo(8.51317, 4); expect(r.behind[1]).toBeCloseTo(47.0181, 3);
  expect(r.ahead.at(-2)).toBeCloseTo(8.5, 4);
});

test("distance model walks a two-segment trip on track", () => {
  const route = [{ path: L, reverse: false }, { path: L, reverse: true }]; // out and back
  const cum = cumStops(route);
  expect(cum[1]).toBeCloseTo(3000, -2); expect(cum[2]).toBeCloseTo(6000, -2);
  expect(atDistance(route, cum, 1000).lon).toBeCloseTo(8.51317, 4); // the corner
  expect(atDistance(route, cum, 3000).lat).toBeCloseTo(47.0181, 3); // far end
  expect(atDistance(route, cum, 5000).bearing).toBeCloseTo(180, 0); // heading back south
});

test("slice follows the track across a station, without duplicate points", () => {
  const route = [{ path: L, reverse: false }, { path: L, reverse: true }]; // out to the far end and back
  const cum = cumStops(route);
  const a = slice(route, cum, 500, 1500); // east leg → corner → north leg
  expect(a.length).toBe(6);
  expect(a[2]).toBeCloseTo(8.51317, 4); expect(a[3]).toBeCloseTo(47, 4);
  const b = slice(route, cum, 2500, 3500); // through the turnaround station at 3000 m
  expect(b.length).toBe(6);
  expect(b[3]).toBeCloseTo(47.0181, 3); // the station point appears once
  expect(b[1]).toBeCloseTo(b[5], 4); // 500 m before and after the far end, on the same leg
  expect(slice(route, cum, -100, 0)).toEqual([]); // nothing behind the start
});

test("a train body lies on its track: every point of every car on the rail, the front at the train's position", () => {
  const route = [{ path: L, reverse: false }, { path: L, reverse: true }], cum = cumStops(route);
  const off = (lon, lat) => { // metres from the track polyline
    let best = Infinity;
    for (let i = 0; i + 3 < L.pts.length; i += 2) {
      const [x0, y0, x1, y1] = [L.pts[i], L.pts[i + 1], L.pts[i + 2], L.pts[i + 3]], kx = Math.cos((y0 * Math.PI) / 180);
      const dx = (x1 - x0) * kx, dy = y1 - y0, t = Math.max(0, Math.min(1, (((lon - x0) * kx) * dx + (lat - y0) * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, metres(lon, lat, x0 + t * (x1 - x0), y0 + t * dy));
    }
    return best;
  };
  for (const dist of [1200, 3150]) { // across the corner, and through the turnaround station
    const body = cars(route, cum, dist, Array(16).fill(25));
    expect(body.length).toBe(16);
    for (const car of body) for (let i = 0; i < car.length; i += 2) expect(off(car[i], car[i + 1])).toBeLessThan(0.01);
    const front = atDistance(route, cum, dist);
    expect(metres(body[0].at(-2), body[0].at(-1), front.lon, front.lat)).toBeLessThan(0.01); // each car runs back → front
  }
  // on the straight north leg, so along the track equals as the crow flies
  const sixteen = Array(16).fill(25), body = cars(route, cum, 2900, sixteen), gaps = body.slice(1).map((car, k) => metres(body[k][0], body[k][1], car.at(-2), car.at(-1))); // rear of one car to the front of the next
  expect(gaps.length).toBe(15);
  for (const g of gaps) expect(g).toBeCloseTo(1.5, 1);
  expect(cars(route, cum, 50, sixteen).length).toBe(2); // the rest would be behind the start
  // a locomotive and two coaches with room for both cab ends: car lengths as given, less half a gap at each joint
  const len = (car) => car.reduce((a, _, i) => (i >= 2 && i % 2 === 0 ? a + metres(car[i - 2], car[i - 1], car[i], car[i + 1]) : a), 0);
  const [loco, c1, c2] = cars(route, cum, 2900, [19, 26.5, 26.5], 1.5, 4, 3);
  expect(len(loco)).toBeCloseTo(19 - 4 - 0.75, 0); // metres() vs the track's own distances: ~1 % apart
  expect(len(c1)).toBeCloseTo(26.5 - 1.5, 0);
  expect(len(c2)).toBeCloseTo(26.5 - 0.75 - 3, 0);
  const front = atDistance(route, cum, 2900 - 4);
  expect(metres(loco.at(-2), loco.at(-1), front.lon, front.lat)).toBeLessThan(0.01); // the cab end starts where the car stops
});

test("motion: starts and ends at the stations, never runs backwards, slow at both ends", () => {
  for (const dur of [60, 120, 600, 3600]) {
    let prev = 0;
    for (let f = 0; f <= 1.0001; f += 0.01) { const x = motion(f, dur); expect(x).toBeGreaterThanOrEqual(prev - 1e-12); prev = x; }
    expect(motion(0, dur)).toBe(0);
    expect(motion(1, dur)).toBe(1);
    expect(motion(0.5, dur)).toBeCloseTo(0.5, 10); // symmetric
    expect(motion(0.05, dur)).toBeLessThan(0.05); // still accelerating
  }
  expect(motion(0.1, 3600)).toBeCloseTo(0.1 / (1 - 45 / 3600) - (45 / 3600 / 2) / (1 - 45 / 3600), 6); // long segment: cruising at 10 %
});

test("front of the train: the platform end toward the next station, on the side of the strip where that sector is", () => {
  const bern = [7.4391, 46.949], west = [7.3, 46.95], east = [7.6, 46.95];
  const ends = [7.437, 46.9488, 7.441, 46.9492]; // sector A at the west end, the last sector at the east end
  expect(frontEnd(bern, west, ends, "A", "F")).toBe("left"); // westbound: A leads, and A is drawn on the left
  expect(frontEnd(bern, east, ends, "A", "F")).toBe("right");
  expect(frontEnd(bern, west, ends, "F", "A")).toBe("right"); // the strip starts with sector F
  expect(frontEnd(bern, west, null, "A", "F")).toBeNull(); // no sector signs known
  expect(frontEnd(bern, west, ends, "C", "C")).toBeNull(); // the whole train in one sector: can't tell
});

test("on a train: the one whose position follows the phone's wins; two trains side by side are no answer", () => {
  // trains moving east along latitude 47 at 30 m/s from different starts; train 2 runs west
  const at = (lon0, dir) => (t) => [lon0 + (dir * 30 * t) / (111_320 * Math.cos((47 * Math.PI) / 180)), 47];
  const pos = { 0: at(8.0, 1), 1: at(8.01, 1), 2: at(8.02, -1) }; // train 1: ~760 m ahead
  const phone = [0, 10, 20, 30].map((t) => ({ t, lon: pos[0](t)[0] + 0.0003, lat: 47.0002 })); // ~30 m off train 0
  expect(matchTrain(phone, [0, 1, 2], (i, t) => pos[i](t))).toBe(0);
  const twins = { 0: pos[0], 1: (t) => [pos[0](t)[0] + 0.0001, 47] };
  expect(matchTrain(phone, [0, 1], (i, t) => twins[i](t))).toBeNull();
  expect(matchTrain(phone, [1, 2], (i, t) => pos[i](t))).toBeNull(); // nothing close enough
});

test("a new forecast is rolled into, not jumped to (IR35 2389 was 700 m off, S1 11182 2 km)", () => {
  const dt = 50, own = 2; // a 50 ms frame of a train doing 40 m/s
  expect(ease(10_000, 12_000, own, dt)).toBeLessThanOrEqual(10_000 + own + 25 * (dt / 1000)); // behind by 2 km: catch-up ≤ 25 m/s
  expect(ease(10_000, 12_000, own, dt)).toBeGreaterThan(10_000 + own);
  expect(ease(10_700, 10_000, own, dt)).toBeCloseTo(10_700 + 0.3 * own); // ahead: creeps on, never back, never dead still
  expect(ease(10_000, 16_000, own, dt)).toBe(16_000); // over 5 km off: snaps
  expect(ease(undefined, 3_000, 0, dt)).toBe(3_000); // first frame
  expect(ease(9_999, 10_000, own, dt)).toBe(10_000); // its own motion never carries it past the forecast
});

test("line speed: a train crawls through a slow station area and makes up for it on the open line", () => {
  // 10 km: the first km at 40 km/h (the station throat), the rest at 160: the first km takes 0.025 h of 0.08125 h
  const tt = timeTable(10_000, [{ d0: 0, d1: 1000, v: 40 }, { d0: 1000, d1: 10_000, v: 160 }]);
  expect(distanceAt(tt, 0.025 / 0.08125)).toBeCloseTo(1000, 0);
  expect(distanceAt(tt, 0.5)).toBeCloseTo(1000 + ((0.5 - 0.025 / 0.08125) / (0.05625 / 0.08125)) * 9000, 0);
  expect([distanceAt(tt, 0), distanceAt(tt, 1)]).toEqual([0, 10_000]);
  // no speeds: the same as a steady speed; an untagged gap counts as 80 km/h
  expect(distanceAt(timeTable(5000), 0.3)).toBeCloseTo(1500, 6);
  const gap = timeTable(3000, [{ d0: 1000, d1: 3000, v: 160 }]); // 1 km untagged (80), 2 km at 160: equal times
  expect(distanceAt(gap, 0.5)).toBeCloseTo(1000, 0);
});

test("line km: nearest marker, interpolated along its line; nothing far from any line", async () => {
  const { kmIndex, kmAt } = await import("../public/position.js");
  // line 290 runs east along a parallel: a marker every 0.002° (~150 m), km 10.0, 10.2, 10.4
  const idx = kmIndex({ 290: { n: "Bern - Thun", p: [7.400, 46.9, 10.0, 7.402, 46.9, 10.2, 7.404, 46.9, 10.4] } });
  expect(kmAt(idx, 7.401, 46.9)).toEqual({ line: "290", name: "Bern - Thun", km: 10.1 });
  expect(kmAt(idx, 7.4026, 46.90005).km).toBe(10.3); // 30 % of the way from the 2nd to the 3rd marker, a few metres off the line
  expect(kmAt(idx, 7.402, 46.91)).toBeNull(); // 1 km north
});

import { rigidCars } from "../public/position.js";
test("rigid cars: straight through bogies on the track, the links bend at a corner", () => {
  const route = [{ path: L, reverse: false }], cum = cumStops(route), corner = atDistance(route, cum, L.cum[1]);
  const { pieces, outline, front, rear } = rigidCars(route, cum, L.cum[1] + 60, [25, 25, 25, 25], 1.5, 4, 3); // the third car straddles the corner
  expect(pieces.length).toBe(4);
  for (const p of pieces) expect(p.length).toBe(4); // one straight piece per car
  const len = (p) => metres(p[0], p[1], p[2], p[3]);
  expect(len(pieces[1])).toBeCloseTo(25 - 1.5, 0); // metres() vs the track's own distances: ~1 % apart
  expect(len(pieces[0])).toBeCloseTo(25 - 0.75 - 4, 0);
  expect(len(pieces[3])).toBeCloseTo(25 - 0.75 - 3, 0);
  // the straddling car's bogies (3.75 m in from its ends) lie on the track, on either leg; the car between them cuts the corner
  const r2 = L.cum[1] + 60 - 75, bogies = [atDistance(route, cum, r2 + 3.75), atDistance(route, cum, r2 + 25 - 3.75)];
  const [x0, y0, x1, y1] = pieces[2], kx = Math.cos((47 * Math.PI) / 180);
  for (const b of bogies) { // distance from the bogie to the car's line, m
    const dx = (x1 - x0) * kx, dy = y1 - y0, ex = (b.lon - x0) * kx, ey = b.lat - y0;
    expect((Math.abs(dx * ey - dy * ex) / Math.hypot(dx, dy)) * 111320).toBeLessThan(0.05);
  }
  const mid = [(x0 + x1) / 2, (y0 + y1) / 2];
  expect(mid[0]).toBeLessThan(corner.lon - 0.3 / (111320 * kx)); // inside the corner, off both legs
  expect(mid[1]).toBeGreaterThan(corner.lat + 0.3 / 111320);
  // the front cab end: the first car's end on the straight north leg, heading north; the outline runs rear → front
  const tip = atDistance(route, cum, L.cum[1] + 60);
  expect(metres(front.lon, front.lat, tip.lon, tip.lat)).toBeLessThan(0.05);
  expect(front.bearing).toBeCloseTo(0, 0);
  expect(rear.bearing).toBeCloseTo(90, 0); // the rear car is still on the east leg
  expect(metres(outline.at(-2), outline.at(-1), pieces[0][2], pieces[0][3])).toBeLessThan(0.01);
  expect(metres(outline[0], outline[1], pieces[3][0], pieces[3][1])).toBeLessThan(0.01);
  expect(rigidCars(route, cum, 50, [25, 25, 25, 25]).rear).toBeNull(); // reaches back past the start: no rear cab
});
