import { beforeEach, expect, test } from "bun:test";
import { details, formationFor, parseFormation } from "../server/details";
import { initRecord } from "../server/record";
import { addDays, zurichDate } from "../server/time";

// trimmed real v2 response (IC 704, 2026-10-24): two coaches, two stops
const V2 = {
  formations: [{ formationVehicles: [
    { position: 1, number: 18, vehicleIdentifier: { evn: "94 85 2 502 229-9", typeCodeName: "B" },
      vehicleProperties: { number2class: 80, length: 25, pictoProperties: { familyZonePicto: true }, accessibilityProperties: { numberWheelchairSpaces: 2, wheelchairToilet: true } },
      formationVehicleAtScheduledStops: [{ stopPoint: { uic: 8503000 }, sectors: "D,C" }, { stopPoint: { uic: 8507000 }, sectors: "G" }] },
    { position: 2, number: 0, vehicleIdentifier: { evn: "94 85 8 502 229-6" },
      vehicleProperties: { number1class: 40, length: 25, trolleyStatus: "Deklassiert" },
      formationVehicleAtScheduledStops: [{ stopPoint: { uic: 8503000 }, sectors: "N/A" }] },
  ] }],
  formationsAtScheduledStops: [
    { scheduledStop: { stopPoint: { uic: 8503000 }, track: "13", stopModifications: 128 },
      formationShort: { vehicleGoals: [{ fromVehicleAtPosition: 1, toVehicleAtPosition: 2, destinationStopPoint: { uic: 8501026 } }] } },
    { scheduledStop: { stopPoint: { uic: 8507000 }, track: "5", stopModifications: 0 } },
  ],
};

let calls = 0, status = 200;
globalThis.fetch = (async () => { calls++; return status === 200 ? Response.json(V2) : Response.json({ error: "no formation data" }, { status }); }) as any;
Object.assign(process.env, { FORMATION_SERVICE_TOKEN: "x", FORMATION_SERVICE_per_Minute: "50" });
beforeEach(() => { initRecord(":memory:"); calls = 0; status = 200; });

const base = Date.now() - 12 * 3600_000; // "now" is 12 h into the service day
const today = zurichDate(new Date());
const trip = (num: string, depH: number, arrH: number, agency = "11", date = today): any => ({ id: num, date, agency, num, stops: [0, depH * 3600, depH * 3600, 1, arrH * 3600, arrH * 3600] });

test("v2: units, coaches with sectors per stop, platforms, platform change, split destinations", () => {
  const f = parseFormation(V2)!;
  expect(f.units[0]).toMatchObject({ id: "502-229", type: "FV-Dosto", cars: 2, seats1: 40, seats2: 80 });
  expect(f.coaches[0]).toMatchObject({ n: 18, c: "2", wc: true, wct: 1, fam: 1, sec: ["DC", "G"] });
  expect(f.coaches[1]).toMatchObject({ n: null, c: "1", st: "open to all classes", sec: ["", ""] });
  expect(f.stops).toEqual([{ uic: "8503000", track: "13", moved: true }, { uic: "8507000", track: "5", moved: false }]);
  expect(f.goals).toEqual([[1, 2, "8501026"]]);
});

test("a train that finished hours ago is answered from cache only: no upstream call", async () => {
  const r = await details(trip("700", 2, 5), base);
  expect(r).toMatchObject({ formation: null, formationStatus: "window" });
  expect(calls).toBe(0);
});

test("a train running now is fetched once, then cached (also across a restart: the cache is in the database)", async () => {
  const r = await details(trip("701", 11, 13), base);
  expect(r).toMatchObject({ formationStatus: "ok", units: [{ id: "502-229" }] });
  await details(trip("701", 11, 13), base);
  expect(calls).toBe(1);
});

test("'not published' is remembered for the day; unknown operators are never asked", async () => {
  status = 400;
  expect((await details(trip("702", 11, 13), base)).formationStatus).toBe("none");
  expect((await details(trip("702", 11, 13), base)).formationStatus).toBe("none");
  expect(calls).toBe(1);
  expect((await formationFor(trip("703", 11, 13, "87_LEX"))).status).toBe("unsupported");
  expect(calls).toBe(1);
});

test("yesterday's run is not asked: the service only answers for today", async () => {
  expect((await details(trip("705", 11, 13, "11", addDays(today, -1)), base)).formationStatus).toBe("past");
  expect(calls).toBe(0);
});

test("an upstream failure is retried later, not cached as 'none'", async () => {
  status = 500;
  expect((await details(trip("704", 11, 13), base)).formationStatus).toBe("error");
});

test("a 403 is the token, not 'not published': an error, retried later", async () => {
  status = 403;
  expect((await details(trip("706", 11, 13), base)).formationStatus).toBe("error");
});

test("a visitor over their lookup share hears 'busy' without an upstream call; cached answers stay free", async () => {
  await details(trip("707", 11, 13), base);
  const r = await details(trip("708", 11, 13), base, () => false);
  expect(r).toMatchObject({ formationStatus: "busy", retryAfter: 120 });
  expect((await details(trip("707", 11, 13), base, () => false)).formationStatus).toBe("ok");
  expect(calls).toBe(1);
});

test("vehicle numbers in parts (TPF) and RhB's own numbering: locomotives and units by number, coaches not units", async () => {
  const { evnOf, unitOf, rhbUnitOf } = await import("../server/details");
  expect(unitOf(evnOf({ evn: null, buildTypeCode: "94", countryCode: "85", vehicleNumber: "2527195", checkNumber: "3" }))?.id).toBe("527-195");
  expect(rhbUnitOf("808500310459")?.id).toBe("ABe416-3145"); // Capricorn car, whole evn padded with zeros
  expect(rhbUnitOf(evnOf({ buildTypeCode: "80", countryCode: "85", vehicleNumber: "35106", checkNumber: "5" }))?.id).toBe("ABe812-3506");
  expect(rhbUnitOf("808500006420")).toMatchObject({ id: "Ge443-642", cls: "Ge443" });
  expect(rhbUnitOf("918500578045")).toBeNull(); // an Albula coach
});
