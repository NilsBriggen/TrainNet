import { expect, test } from "bun:test";
import { applyDelays, locate } from "../public/position.js";

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

import { cut, cumStops, atDistance, slice } from "../public/position.js";
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
