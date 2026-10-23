import { beforeEach, expect, test } from "bun:test";
import { aggregate, db, flush, initRecord, recordAlerts, recordTrips, startDay } from "../server/record";

// two stations, one IC: A 10:00 → B 10:30 → C 11:00; base = 2026-10-23 00:00 CEST
const base = Date.parse("2026-10-22T22:00:00Z");
const trip = (id: string, num: string) => ({ id, date: "2026-10-23", route: 0, agency: "11", head: "C", num, stops: [0, 36000, 36000, 1, 37800, 37860, 2, 39600, 39600], seq: [1, 2, 3], plat: [0, 0, 0], km: [0, 50, 100] });
const day: any = {
  date: "2026-10-23", base,
  stations: [["A", 8, 47, "8500001", 2], ["B", 8.1, 47, "8500002", 2], ["C", 8.2, 47, "8500003", 2]],
  routes: [["IC1", "IC", "11"]],
  trips: [trip("t1", "700"), trip("t2", "702")],
};
const at = (hhmm: string) => base / 1000 + +hhmm.slice(0, 2) * 3600 + +hhmm.slice(2) * 60;

beforeEach(() => {
  initRecord(":memory:");
  startDay(day, at("0900"));
});

test("a finished trip is stored with final delay, punctuality and km", () => {
  // t1: +4 min at B, +2 min at C (punctual at the end); t2 never in the feed
  recordTrips(day, { 0: { u: [[1, 240, 240, 0], [2, 120, null, 0]] } }, at("1000"), [2, 0, 0, 0]);
  flush(day, at("1130"), 20 * 60);
  const t1: any = db.query("SELECT * FROM trip_day WHERE trip = 't1'").get();
  expect(t1).toMatchObject({ observed: 1, final_delay: 120, max_delay: 240, stops: 2, stops_ok: 1, km: 100, line: "IC1", origin: "A", dest: "C" });
  const t2: any = db.query("SELECT * FROM trip_day WHERE trip = 't2'").get();
  expect(t2).toMatchObject({ observed: 0, final_delay: null });
  expect(db.query("SELECT count(*) n FROM stop_obs WHERE trip = 't2'").get()).toEqual({ n: 0 }); // no delays, no per-stop rows
  const stops = db.query("SELECT idx, arr_delay, dep_delay FROM stop_obs WHERE trip = 't1' ORDER BY idx").all();
  expect(stops).toEqual([{ idx: 0, arr_delay: null, dep_delay: 0 }, { idx: 1, arr_delay: 240, dep_delay: 240 }, { idx: 2, arr_delay: 120, dep_delay: null }]);
});

test("running trips are not written; the grace period is respected", () => {
  recordTrips(day, { 0: { u: [[2, 600, null, 0]] } }, at("1000"), [2, 1, 0, 0]);
  flush(day, at("1115"), 20 * 60); // arrives 11:10 with +10 → 11:10 + 20 min grace not yet over
  expect(db.query("SELECT count(*) n FROM trip_day WHERE trip = 't1'").get()).toEqual({ n: 0 });
});

test("a restart does not overwrite stored trips with empty state", () => {
  recordTrips(day, { 0: { u: [[2, 300, null, 0]] } }, at("1000"), [2, 1, 0, 0]);
  flush(day, at("1200"), 0);
  startDay({ ...day }, at("1201")); // new process, same timetable
  flush(day, at("1202"), 0);
  expect((db.query("SELECT final_delay f FROM trip_day WHERE trip = 't1'").get() as any).f).toBe(300);
});

test("daily aggregates: punctuality counts only observed, uncancelled trips", () => {
  recordTrips(day, { 0: { u: [[2, 600, null, 0]] }, 1: { c: 1 } }, at("1000"), [2, 1, 1, 0]);
  flush(day, at("1200"), 0);
  aggregate("2026-10-23");
  expect(db.query("SELECT trips, observed, punctual, cancelled, km FROM agg_net_day").get()).toEqual({ trips: 2, observed: 2, punctual: 0, cancelled: 1, km: 200 });
  expect(db.query("SELECT train_no, punctual, avg_delay FROM agg_train_day WHERE train_no = '700'").get()).toEqual({ train_no: "700", punctual: 0, avg_delay: 600 });
});

test("alerts are upserted: first_seen stays, last_seen and severity move", () => {
  const a = { id: "x1", h: "Interrupted", d: "", sev: 2, kind: "signal", cause: "TECHNICAL_PROBLEM", why: "signal fault", from: at("0950"), s: [0, 1], r: [0] };
  recordAlerts(day, [a], at("1000"));
  recordAlerts(day, [{ ...a, sev: 3, sudden: 1, d: "The restriction lasts until approx. 19:00." }], at("1010")); // SBB moved the ETA
  expect(db.query("SELECT first_seen, last_seen, sev_max, sudden, d, stations, lines FROM alert_log").all()).toEqual([{
    first_seen: at("1000"), last_seen: at("1010"), sev_max: 3, sudden: 1, d: "The restriction lasts until approx. 19:00.", stations: '["8500001","8500002"]', lines: '["IC1"]',
  }]);
});
