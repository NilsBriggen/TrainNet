import { expect, test } from "bun:test";
import { unitOf } from "../server/details";
import { unitSpan } from "../server/fleet";

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
