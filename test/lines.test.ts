import { expect, test } from "bun:test";
import { ambiguousLabels, lineKeys, lineName } from "../server/lines";

test("trains of one name sharing a station are one line, keyed by its busiest station; category names are no line", () => {
  const pax = (u: string) => ({ A: 50, X: 900 })[u] ?? 0;
  const keys = lineKeys([
    { name: "S1", cat: "S", uics: ["A", "B"] }, { name: "S1", cat: "S", uics: ["B", "C"] }, // linked through B
    { name: "S1", cat: "S", uics: ["X", "Y"] }, // elsewhere
    { name: "EC", cat: "EC", uics: ["A"] }, { name: "", cat: "ICE", uics: ["A"] },
  ], pax);
  expect(keys).toEqual(["S1|A", "S1|A", "S1|X", "EC|", "ICE|"]);
  expect(lineName("S1|A")).toBe("S1");
  expect(ambiguousLabels([...keys, "IR15|Z"], (u) => ({ A: "Basel SBB", X: "Bern" })[u])).toEqual({ "S1|A": "S1 · Basel SBB", "S1|X": "S1 · Bern" });
});
