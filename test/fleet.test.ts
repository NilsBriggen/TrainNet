import { expect, test } from "bun:test";
import { unitOf } from "../server/details";
import { dueTrips, unitSpan } from "../server/fleet";

test("EVN -> trainset / locomotive identity", () => {
  expect(unitOf("94 85 2 502 229-9")).toEqual({ id: "502-229", cls: "502", type: "FV-Dosto" }); // car 2 of FV-Dosto 502 229
  expect(unitOf("94 85 8 502 229-6")?.id).toBe("502-229"); // another car, same unit
  expect(unitOf("91 85 4 460 001-9")).toEqual({ id: "460-001", cls: "460", type: "Re 460" });
  expect(unitOf("94 85 0 599 001-1")?.type).toBe("Class 599");
  expect(unitOf("50 85 26-94 912-3")).toBeNull(); // a loose coach is not a unit
  expect(unitOf("")).toBeNull();
});

test("a unit that leaves the train early only gets its own part of the trip", () => {
  // St. Gallen → Zürich → Genève → Genève-Aéroport; one unit stops at Genève
  const trip: any = { stops: [0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0], km: [0, 80, 360, 366] };
  const uics = ["8506302", "8503000", "8501008", "8501026"];
  expect(unitSpan(trip, (s) => uics[s], { from: "8506302", to: "8501008" })).toEqual([0, 2]);
  expect(unitSpan(trip, (s) => uics[s], { from: "8506302", to: "8501026" })).toEqual([0, 3]);
  expect(unitSpan(trip, (s) => uics[s], { from: "", to: "" })).toEqual([0, 3]); // unknown: whole trip
});

test("formations are due from 90 min before a train starts until it arrives, soonest first, operators in the service only", () => {
  const trip = (num: string, dep: number, arr: number, agency = "11", date = "2026-11-02"): any => ({ num, agency, date, stops: [0, dep, dep, 1, arr, arr] });
  const trips = [trip("late", 20_000, 21_000), trip("soon", 10_000, 12_000), trip("running", 8_000, 11_000), trip("done", 1_000, 2_000),
    trip("ab", 9_000, 10_000, "999"), trip("yesterday", 9_000, 30_000, "11", "2026-11-01")];
  expect(dueTrips(trips, "2026-11-02", 9_500).map((t) => t.num)).toEqual(["running", "soon"]); // 20 000 is 3 h away; Appenzeller Bahnen aren't in the service
  expect(dueTrips(trips, "2026-11-02", 10_000 - 90 * 60).map((t) => t.num)).toEqual(["running", "soon"]); // exactly 90 min ahead
});
