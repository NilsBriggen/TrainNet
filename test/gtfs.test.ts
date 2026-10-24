import { expect, test } from "bun:test";
import { dayFromCache, dayToCache, serviceDays, throughRunning, type Day } from "../server/gtfs";

// calendar.txt: service_id, mon … sun, start_date, end_date
const cal = (id: string, week: string, start = "20251214", end = "20261212") => [id, ...week.split(""), start, end];

test("weekly calendar picks the right weekday, within its date range", () => {
  // 2026-10-24 is a Saturday, 2026-10-23 the Friday before (trains still running past midnight)
  const { running, calendar } = serviceDays(["2026-10-24", "2026-10-23"]);
  calendar(cal("WEEKEND", "0000011"));
  calendar(cal("WEEKDAYS", "1111100"));
  calendar(cal("EXPIRED", "1111111", "20251214", "20261001"));
  expect([...running[0]]).toEqual(["WEEKEND"]);
  expect([...running[1]]).toEqual(["WEEKDAYS"]);
});

test("date exceptions add and remove services on top of the calendar", () => {
  const { running, calendar, exception } = serviceDays(["2026-10-24", "2026-10-23"]);
  calendar(cal("WEEKEND", "0000011"));
  exception(["WEEKEND", "20261024", "2"]); // removed this Saturday
  exception(["EXTRA", "20261024", "1"]); // added this Saturday
  exception(["EXTRA", "20261030", "1"]); // another day: ignored
  expect([...running[0]]).toEqual(["EXTRA"]);
  expect([...running[1]]).toEqual([]);
});

test("through-running links today's instances, on the link's own service days", () => {
  const { running, calendar } = serviceDays(["2026-10-24", "2026-10-23"]);
  calendar(cal("SAT", "0000010"));
  const tripIndex = new Map([["IR2536|20261024", 0], ["IR2537|20261024", 1], ["IC5|20261023", 2], ["IC6|20261023", 3]]);
  const t = throughRunning(["2026-10-24", "2026-10-23"], running, tripIndex);
  const row = (from: string, to: string, type: string, svc: string) => ["8503000", "8503000", "", "", from, to, type, "", svc];
  t.row(row("IR2536", "IR2537", "4", "SAT")); // runs Saturdays: linked for the 24th
  t.row(row("IC5", "IC6", "4", "SAT")); // the 23rd is a Friday: not linked
  t.row(row("IR2536", "IR2537", "2", "")); // a minimum transfer time, not a through train
  expect(t.pairs).toEqual([0, 1]);
});

test("a day survives the trip through its cache: indexes rebuilt, nothing lost", () => {
  const trip = { id: "t1", date: "2026-10-24", route: 0, agency: "11", head: "Bern", num: "700", stops: [0, 100, 100, 1, 200, 200], seq: [1, 2], plat: [0, 1], km: [0, 95.3], hints: "NF" };
  const day: Day = {
    date: "2026-10-24", base: 1, version: "2026-10-24_x.zip_f5", stations: [["Zürich HB", 8.5, 47.4, "8503000", 1], ["Bern", 7.4, 46.9, "8507000", 1]],
    routes: [["IC1", "IC", "11"]], agencies: { "11": "SBB" }, platforms: ["", "7"], trips: [trip], segments: [0, 1], paths: [[8.5, 47.4, 7.4, 46.9]],
    tripIndex: new Map([["t1|20261024", 0]]), routeIndex: new Map([["r-ic1", 0]]), stationOfStop: () => undefined, track: () => null, json: new Uint8Array([1, 2, 3]),
  };
  const back = dayFromCache(JSON.parse(JSON.stringify(dayToCache(day, ["r-ic1"], [["8503000:0:7", 0], ["8507000", 1]]))), day.json, null);
  expect(back.trips).toEqual(day.trips);
  expect(back.version).toBe(day.version);
  expect(back.tripIndex.get("t1|20261024")).toBe(0);
  expect(back.routeIndex.get("r-ic1")).toBe(0);
  expect(back.stationOfStop("8503000:0:7")).toBe(0);
  expect(back.stationOfStop("nope")).toBeUndefined();
  expect(back.track(0, 1)).toBeNull(); // no graph
  expect(back.json).toBe(day.json);
});
