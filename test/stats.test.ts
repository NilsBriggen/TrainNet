// Smoke test: every stats endpoint's function runs against a small recorded day and a day of history, so SQL and
// schema mistakes show up here instead of as a 500 on the site.
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { aggregate, db, flush, initRecord, recordTrips, startDay } from "../server/record";
import { importDay } from "../server/history";
import * as stats from "../server/stats";

const base = Date.parse("2026-10-22T22:00:00Z"); // 2026-10-23 00:00 CEST
const trip = (id: string, num: string, route = 0) => ({ id, date: "2026-10-23", route, agency: "11", head: "C", num, stops: [0, 36000, 36000, 1, 37800, 37860, 2, 39600, 39600], seq: [1, 2, 3], plat: [1, 1, 1], km: [0, 50, 100], hints: "" });
const day: any = {
  date: "2026-10-23", base, version: "test", agencies: { "11": "SBB" }, platforms: ["", "7A-D"],
  stations: [["A", 8, 47, "8500001", 2], ["B", 8.1, 47, "8500002", 2], ["C", 8.2, 47, "8500003", 2]],
  routes: [["IC1", "IC", "11"], ["S1", "S", "11"]], trips: [trip("t1", "700"), trip("t2", "702"), trip("t3", "18001", 1)],
};
const at = (hhmm: string) => base / 1000 + +hhmm.slice(0, 2) * 3600 + +hhmm.slice(2) * 60;
const H = "BETRIEBSTAG;FAHRT_BEZEICHNER;BETREIBER_ID;BETREIBER_ABK;BETREIBER_NAME;PRODUKT_ID;LINIEN_ID;LINIEN_TEXT;UMLAUF_ID;VERKEHRSMITTEL_TEXT;ZUSATZFAHRT_TF;FAELLT_AUS_TF;BPUIC;HALTESTELLEN_NAME;ANKUNFTSZEIT;AN_PROGNOSE;AN_PROGNOSE_STATUS;ABFAHRTSZEIT;AB_PROGNOSE;AB_PROGNOSE_STATUS;DURCHFAHRT_TF";
const csv = [H, "22.10.2026;h1;85:11;SBB;SBB;Zug;700;IC1;;IC;false;false;8500001;A;;;REAL;22.10.2026 10:00;22.10.2026 10:01:00;REAL;false",
  "22.10.2026;h1;85:11;SBB;SBB;Zug;700;IC1;;IC;false;false;8500003;C;22.10.2026 11:00;22.10.2026 11:02:00;REAL;;;REAL;false"].join("\n");

test("every stats function answers on a small database", async () => {
  initRecord(":memory:");
  startDay(day, at("0900"));
  recordTrips(day, { 0: { u: [[1, 240, 240, 0], [2, 120, null, 0]] }, 2: { c: 1 } }, at("1000"), [2, 0, 1, 0, 1]);
  flush(day, at("1200"), 0);
  db.exec(`INSERT INTO vehicle_run VALUES ('2026-10-23', '502-206', '502', 'FV-Dosto', '700', 't1', 0, '8500001', '8500003', 0, 0, 100, 200, 100, 400, 0)`);
  aggregate("2026-10-23");
  await importDay(db, new Blob([csv]).stream());
  db.exec(`INSERT INTO station_hour VALUES ('8500001', 0, NULL, 2025), ('8500001', 7, 7.5, 2025)`); // SBB leaves some hours empty
  // two alerts naming line "IC1": one at a station of this line, one at a station of a namesake elsewhere
  db.exec(`INSERT INTO alert_log VALUES ('on', 1, 2, NULL, 3, 0, 'signal', '', '', 'h', '', '["8500002"]', '["IC1"]'), ('off', 1, 2, NULL, 3, 0, 'signal', '', '', 'h', '', '["9999999"]', '["IC1"]')`);
  const key = stats.lineLabels(day) && db.query("SELECT line FROM trip_day WHERE trip = 't1'").get() as { line: string };
  const out = {
    overview: stats.overview(day), fleet: stats.fleet(day), incidents: stats.incidents(day), search: stats.search(day, "a"),
    train: stats.train(day, "700"), vehicle: stats.vehicle(day, "502-206"), station: stats.stationStats(day, "8500001"),
    line: stats.lineStats(day, key.line), lineByName: stats.lineStats(day, "IC1"), types: stats.types(day), type: stats.trainType(day, "502"),
    history: stats.longHistory(), labels: stats.lineLabels(day), segments: stats.segments(), records: stats.records(day),
    commute: stats.commute(day, "8500001", "8500003"),
  };
  for (const [k, v] of Object.entries(out)) expect([k, v]).not.toEqual([k, null]);
  expect(out.lineByName!.line).toBe(key.line);
  expect(out.line!.incidents.map((i: any) => i.id)).toEqual(["on"]); // the namesake line's alert stays away
  expect(out.station!.busy).toEqual([{ hour: 7, pct: 7.5, year: 2025 }]);
  expect(out.station!.platforms).toEqual([{ p: "7", n: 3 }]); // sector codes count as their platform
  expect(out.commute).toMatchObject({ runs: 1, pct: 100, median: 120 });
  expect(out.type!.punctuality).toBeNull(); // one run: below the minimum
  expect(stats.commute(day, "8500001", "8500001")).toBeNull();
  expect(stats.stationStats(day, "9999999")).toBeNull();
});
