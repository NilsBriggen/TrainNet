import { beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { importDay, initHistory, listArchive } from "../server/history";

const H = "BETRIEBSTAG;FAHRT_BEZEICHNER;BETREIBER_ID;BETREIBER_ABK;BETREIBER_NAME;PRODUKT_ID;LINIEN_ID;LINIEN_TEXT;UMLAUF_ID;VERKEHRSMITTEL_TEXT;ZUSATZFAHRT_TF;FAELLT_AUS_TF;BPUIC;HALTESTELLEN_NAME;ANKUNFTSZEIT;AN_PROGNOSE;AN_PROGNOSE_STATUS;ABFAHRTSZEIT;AB_PROGNOSE;AB_PROGNOSE_STATUS;DURCHFAHRT_TF";
// [trip, line, cat, no, extra, cancelled, uic, arr, arrAct, dep, depAct, pass]
const rows: string[][] = [
  // IC5 1001: Zürich → Bern, 2 min late at the end: punctual. Departed Zürich 1 min late.
  ["t1", "IC5", "IC", "1001", "false", "false", "8503000", "", "", "01.09.2026 08:00", "01.09.2026 08:01:00", "false"],
  ["t1", "IC5", "IC", "1001", "false", "false", "8507000", "01.09.2026 09:00", "01.09.2026 09:02:00", "", "", "false"],
  // IC5 1003: 5 min late at Bern: not punctual; passes Olten without stopping (no stop stats)
  ["t2", "IC5", "IC", "1003", "false", "false", "8503000", "", "", "01.09.2026 09:00", "01.09.2026 09:00:30", "false"],
  ["t2", "IC5", "IC", "1003", "false", "false", "8500218", "", "", "01.09.2026 09:30", "01.09.2026 09:33:00", "true"],
  ["t2", "IC5", "IC", "1003", "false", "false", "8507000", "01.09.2026 10:00", "01.09.2026 10:05:00", "", "", "false"],
  // S3 2001: cancelled at every stop
  ["t3", "S3", "S", "2001", "false", "true", "8503000", "", "", "01.09.2026 10:00", "", "false"],
  ["t3", "S3", "S", "2001", "false", "true", "8503006", "01.09.2026 10:10", "", "", "", "false"],
  // extra train, no actual times: counted, not observed
  ["t4", "EXT", "EXT", "3001", "true", "false", "8503000", "", "", "01.09.2026 11:00", "", "false"],
  ["t4", "EXT", "EXT", "3001", "true", "false", "8507000", "01.09.2026 12:00", "", "", "", "false"],
  // a foreign stop of a cross-border train: ignored; its Swiss stop counts
  ["t5", "EC", "EC", "4001", "false", "false", "8300046", "", "", "01.09.2026 06:00", "01.09.2026 06:00:00", "false"],
  ["t5", "EC", "EC", "4001", "false", "false", "8505000", "01.09.2026 08:00", "01.09.2026 07:59:00", "", "", "false"],
];
const csv = (r = rows) => [H, ...r.map(([trip, line, cat, no, extra, canc, uic, arr, arrAct, dep, depAct, pass]) =>
  ["01.09.2026", trip, "85:11", "SBB", "SBB", "Zug", no, line, "", cat, extra, canc, uic, "X", arr, arrAct, "REAL", dep, depAct, "REAL", pass].join(";")),
  "01.09.2026;bus1;85:801;PAG;PostAuto;Bus;101;101;;B;false;false;8503000;X;;;;01.09.2026 08:00;01.09.2026 08:09:00;REAL;false"].join("\r\n");
const stream = (s: string) => new Blob([s]).stream();

let db: Database;
beforeEach(() => { db = new Database(":memory:"); initHistory(db); });

test("a day's trains: punctual at the last Swiss stop, cancelled, extra, buses and foreign stops left out", async () => {
  const r = await importDay(db, stream(csv()), "2026-09-01");
  expect(r).toMatchObject({ date: "2026-09-01", skipped: false });
  expect(db.query("SELECT trips, observed, punctual, cancelled, extra, stop_obs, stop_ok, sum_final_delay FROM hist_net_day").get())
    .toEqual({ trips: 5, observed: 3, punctual: 2, cancelled: 1, extra: 1, stop_obs: 2, stop_ok: 2, sum_final_delay: 120 + 300 - 60 });
  expect(db.query("SELECT line, trips, observed, punctual, sum_final_delay FROM hist_line_month WHERE line = 'IC5'").get())
    .toEqual({ line: "IC5", trips: 2, observed: 2, punctual: 1, sum_final_delay: 420 });
  expect(db.query("SELECT deps, dep_obs, dep_ok, sum_dep_delay FROM hist_station_month WHERE uic = '8503000'").get()).toEqual({ deps: 3, dep_obs: 2, dep_ok: 2, sum_dep_delay: 90 }); // the cancelled S3 never left
  expect(db.query("SELECT count(*) n FROM hist_station_month WHERE uic = '8500218'").get()).toEqual({ n: 0 }); // passed through
  expect(db.query("SELECT max_delay FROM hist_train_month WHERE train_no = '1003'").get()).toEqual({ max_delay: 300 });
  expect(db.query("SELECT dow, hour, n FROM hist_hour_month ORDER BY hour").all()).toEqual([{ dow: 1, hour: 8, n: 1 }, { dow: 1, hour: 9, n: 1 }]); // a Tuesday
});

test("importing a day twice adds nothing; a file for another day is refused", async () => {
  await importDay(db, stream(csv()));
  const again = await importDay(db, stream(csv()));
  expect(again.skipped).toBe(true);
  expect(db.query("SELECT trips FROM hist_net_day").get()).toEqual({ trips: 5 });
  expect(importDay(db, stream(csv()), "2026-09-02")).rejects.toThrow("expected 2026-09-02");
});

test("the archive list: one zip per month, the v2 file when a month has both, no partial 2016/17", async () => {
  const html = `<a href="istdaten/2016+2017/16+17-unvollstaendig.zip">x</a> <a href="istdaten/2018/18_01.zip">x</a>
    <a href="istdaten/2025/ist-daten-2025-12.zip">x</a> <a href="istdaten/2025/ist-daten-v2-2025-12.zip">x</a> <a href="istdaten/2022/ist-daten-2022-01.zip">x</a>`;
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(html)) as any;
  try {
    expect((await listArchive()).map((x) => `${x.month} ${x.url.split("/").pop()}`)).toEqual(["2018-01 18_01.zip", "2022-01 ist-daten-2022-01.zip", "2025-12 ist-daten-v2-2025-12.zip"]);
  } finally { globalThis.fetch = real; }
});
