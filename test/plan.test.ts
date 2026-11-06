import { expect, test } from "bun:test";
import { catchRate, expectedArrival, network, plan, scan } from "../server/plan";
import { initRecord } from "../server/record";

// stations A=0, B=1, C=2; times in seconds from the day's base; platforms: index 1 = "1", 2 = "2"
const trip = (route: number, num: string, stops: number[], plat: number[]) => ({ id: num, date: "2026-11-06", route, agency: "11", head: "C", num, stops, seq: [], plat, km: [], hints: "" });
const day = (trips: any[], extra: any = {}): any => ({
  date: "2026-11-06", base: 0, version: "t", stations: [["A", 7, 46, "8500001", 1], ["B", 7.1, 46, "8500002", 1], ["C", 7.2, 46, "8500003", 1]],
  routes: [["IC1", "IC", "11"], ["S1", "S", "11"]], platforms: ["", "1", "2"], through: [], transfers: {}, trips, ...extra,
});
const names = (d: any, j: any[] | null) => j?.map((l) => d.trips[l.trip].num + (l.through ? "*" : ""));

test("the direct train and a faster journey with a change both come back, each for its number of legs", () => {
  const d = day([trip(0, "direct", [0, 0, 0, 2, 3600, 3600], [1, 1]), trip(1, "s1", [0, 0, 0, 1, 1000, 1000], [1, 1]), trip(1, "s2", [1, 1300, 1300, 2, 2000, 2000], [1, 1])]);
  const r = scan(d, network(d, {}), 0, 2, 0);
  expect(names(d, r[1])).toEqual(["direct"]);
  expect(names(d, r[2])).toEqual(["s1", "s2"]);
  expect(r[3]).toBeNull(); // a third leg makes nothing faster
});

test("a change shorter than the minimum is refused: the station's default and a platform-to-platform rule", () => {
  const short = day([trip(1, "s1", [0, 0, 0, 1, 1000, 1000], [1, 1]), trip(1, "s2", [1, 1100, 1100, 2, 2000, 2000], [1, 1])]);
  expect(scan(short, network(short, {}), 0, 2, 0)[2]).toBeNull(); // 100 s < 180 s
  const ruled = day([trip(1, "s1", [0, 0, 0, 1, 1000, 1000], [1, 1]), trip(1, "s2", [1, 1300, 1300, 2, 2000, 2000], [2, 2])], { transfers: { "1:1:2": 600 } });
  expect(scan(ruled, network(ruled, {}), 0, 2, 0)[2]).toBeNull(); // platform 1 → 2 takes 10 min here
  const ok = day(ruled.trips, { transfers: { "1:1:2": 240 } });
  expect(names(ok, scan(ok, network(ok, {}), 0, 2, 0)[2])).toEqual(["s1", "s2"]);
});

test("staying seated on a through-running train is no change; a cancelled train is gone", () => {
  const d = day([trip(1, "s1", [0, 0, 0, 1, 1000, 1000], [1, 1]), trip(1, "s2", [1, 1030, 1030, 2, 2000, 2000], [1, 1])], { through: [0, 1] });
  expect(names(d, scan(d, network(d, {}), 0, 2, 0)[1])).toEqual(["s1", "s2*"]); // one boarding, 30 s at B is fine
  expect(scan(d, network(d, { 1: { c: 1 } }), 0, 2, 0).every((j) => !j)).toBe(true);
});

test("a skipped stop can't be boarded or left there", () => {
  const d = day([trip(1, "s1", [0, 0, 0, 1, 1000, 1000, 2, 2000, 2000], [1, 1, 1])]);
  expect(names(d, scan(d, network(d, {}), 0, 1, 0)[1])).toEqual(["s1"]);
  expect(scan(d, network(d, { 0: { u: [[1, 0, 0, 1]] } }), 0, 1, 0).every((j) => !j)).toBe(true);
});

test("catch rate: every arrival against every departure, or the days both ran when there are enough", () => {
  expect(catchRate([0, 60, 120, 600], [0], 300, 180)).toMatchObject({ p: 0.75, basis: "trains" }); // only the 10-min-late arrival misses
  const waits = Array.from({ length: 10 }, (_, k) => [k * 120, k * 120] as [number, number]); // the departure waits for the late arrival
  expect(catchRate([600], [0], 300, 180, waits)).toMatchObject({ p: 1, basis: "pair", n: 10 });
  expect(catchRate([], [], 300, 180).p).toBe(1); // nothing recorded: the timetable's word
  expect(catchRate([], [], 0, 30, [], 30).p).toBe(1); // a 0-min change by timetable that today's times make (the arriving train is early)
});

test("ranking by expected arrival prefers the reliable journey over a minute-faster fragile one", () => {
  const fragile = expectedArrival(1000, [{ p: 0.5, backupArr: 2800 }]), direct = expectedArrival(1060, []);
  expect(fragile).toBe(1900);
  expect(direct).toBeLessThan(fragile);
});

test("arrive by: the last journeys that make it, also for a trip longer than three hours", () => {
  initRecord(":memory:");
  // A → C takes 4 h; departures every hour from 05:00 (18 000 s) to 12:00; arrive by 14:30
  const runs = Array.from({ length: 8 }, (_, k) => trip(0, `ic${k}`, [0, 18_000 + k * 3600, 18_000 + k * 3600, 2, 32_400 + k * 3600, 32_400 + k * 3600], [1, 1]));
  const d = day(runs), r = plan(d, {}, "8500001", "8500003", 52_200, true)!;
  expect(r.journeys.map((j) => j.legs[0].num)).toEqual(["ic0", "ic1", "ic2", "ic3", "ic4", "ic5"]); // ic5 arrives 14:00, ic6 15:00 is too late
  expect(plan(d, {}, "8500001", "8500003", 30_000, true)!.journeys).toEqual([]); // nothing arrives by 08:20
});
