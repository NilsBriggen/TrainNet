import { expect, test } from "bun:test";
import { db, initRecord } from "../server/record";
import { importSbb, importSectors, platformEnds, usePlatformEnds } from "../server/sbbdata";

test("passengers: latest year per station; register: trainsets under our unit ids, loose coaches skipped", () => {
  initRecord(":memory:");
  const n = importSbb(
    [
      { uic: 8502113.0, jahr_annee_anno: "2018", dtv_tjm_tgm: 37900, dwv_tmjo_tfm: 44800 },
      { uic: 8502113.0, jahr_annee_anno: "2023", dtv_tjm_tgm: 37700, dwv_tmjo_tfm: 43400 },
    ],
    [
      { fahrzeug_nr_uic: "94 85 0 502 206-1", fahrzeug_typ: "RABe 502 IR200", baudatum_fahrzeug: "2019-10-18", sitzpl_1_kl_nr_r_total: 181, sitzpl_2_kl_nr_r_total: 501, lange_uber_zug: 200600, platze_rollstuhle_pro_zug: 3 },
      { fahrzeug_nr_uic: "50 85 26-94 912-3", fahrzeug_typ: "B EWIV", baudatum_fahrzeug: "1990-01-01" },
    ],
  );
  expect(n).toEqual({ stations: 1, units: 1 });
  expect(db.query("SELECT * FROM station_pax").get()).toEqual({ uic: "8502113", year: 2023, daily: 37700, weekday: 43400 });
  expect(db.query("SELECT * FROM rolling_stock").get()).toEqual({ unit: "502-206", cls: "502", subtype: "RABe 502 IR200", built: "2019-10-18", seats1: 181, seats2: 501, length_m: 200.6, wheelchair: 3 });
});

test("platform ends: the first and the last sector of a platform, from the signs standing in them", () => {
  initRecord(":memory:");
  importSectors([
    { bpuic: "8507000", kundengleisnummer: "6", sektor_vorderseite: "-", sektor_ruckseiter: "A", geopos: { lon: 7.43, lat: 46.95 } },
    { bpuic: "8507000", kundengleisnummer: "6", sektor_vorderseite: "A", sektor_ruckseiter: "B", geopos: { lon: 7.432, lat: 46.95 } },
    { bpuic: "8507000", kundengleisnummer: "6", sektor_vorderseite: "D", sektor_ruckseiter: "-", geopos: { lon: 7.44, lat: 46.95 } },
    { bpuic: "1234567", kundengleisnummer: "1", sektor_vorderseite: "A", geopos: { lon: 0, lat: 0 } }, // not Swiss: skipped
  ]);
  usePlatformEnds();
  expect(platformEnds("8507000", "6")).toEqual([7.431, 46.95, 7.44, 46.95]); // A is the mean of its two signs, D the last sector
  expect(platformEnds("8507000", "6A-C")).toEqual([7.431, 46.95, 7.44, 46.95]); // a split track name falls back to its number
  expect(platformEnds("8507000", "7")).toBeNull();
});
