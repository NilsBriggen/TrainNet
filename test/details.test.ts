import { expect, test } from "bun:test";
import { details } from "../server/details";

let calls = 0;
globalThis.fetch = (async () => {
  calls++;
  return Response.json({ formations: [{ formationVehicles: [{ position: 1, number: 1, vehicleIdentifier: { evn: "94 85 2 502 229-9" }, vehicleProperties: { number2class: 80, length: 25 } }] }] });
}) as any;
Object.assign(process.env, { FORMATION_SERVICE_TOKEN: "x", FORMATION_SERVICE_per_Minute: "50" });

const base = Date.now() - 12 * 3600_000; // "now" is 12 h into the service day
const trip = (num: string, depH: number, arrH: number): any => ({ id: num, date: "2026-10-23", agency: "11", num, stops: [0, depH * 3600, depH * 3600, 1, arrH * 3600, arrH * 3600] });

test("a train that finished hours ago is answered from cache only: no upstream call", async () => {
  const r = await details(trip("700", 2, 5), base);
  expect(r.formation).toBeNull();
  expect(calls).toBe(0);
});

test("a train running now is fetched once, then cached", async () => {
  const r = await details(trip("701", 11, 13), base);
  expect(r.units[0]).toMatchObject({ id: "502-229", type: "FV-Dosto" });
  await details(trip("701", 11, 13), base);
  expect(calls).toBe(1);
});
