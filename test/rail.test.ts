import { expect, test } from "bun:test";
import { healGaps } from "../scripts/rail";
import { trackNo } from "../server/paths";

test("OSM gaps: a dead end 8 m from another way is linked, one 30 m away isn't, nor ends of the same way", () => {
  const m = (x: number) => 8.5 + x / 76_000; // metres east at latitude 47 (~76 km per degree)
  // way 0: nodes 0-1; way 1 starts 8 m after it (nodes 2-3); way 2 starts 30 m after way 1 (nodes 4-5)
  const nodes = [m(0), 47, m(100), 47, m(108), 47, m(200), 47, m(230), 47, m(300), 47];
  const edges = [0, 1, 2, 3, 4, 5];
  expect(healGaps(nodes, edges, Int32Array.from([0, 0, 1, 1, 2, 2]))).toEqual([1, 2, 2, 1]); // facing each other: linked from both
});

test("track numbers: the number at the start of railway:track_ref", () => {
  expect([trackNo("7"), trackNo("12a"), trackNo("7;8"), trackNo("Ost"), trackNo(undefined)]).toEqual(["7", "12", "7", "", ""]);
});

test("buffer stops side by side aren't linked; a way ending just short of a track ahead is", () => {
  const m = (x: number) => 8.5 + x / 76_000, n = (y: number) => 47 + y / 111_320;
  // two parallel stub tracks (a terminus) ending at buffer stops 4.5 m apart: both dead ends, but beside each other
  const side = [m(0), 47, m(200), 47, m(0), n(4.5), m(200), n(4.5)];
  expect(healGaps(side, [0, 1, 2, 3], Int32Array.from([0, 0, 1, 1]))).toEqual([]);
  // way 1 now heads east toward node 0 of way 0 and stops 6 m short of it (node 0 has another neighbour: not a dead end)
  const tee = [m(100), 47, m(200), 47, m(0), 47, m(94), 47, m(100), n(-50)];
  expect(healGaps(tee, [0, 1, 0, 4, 2, 3], Int32Array.from([0, 0, 1, 1, 0]))).toContain(3);
});

test("way properties: yards faint-coded, construction kept apart with its opening date", async () => {
  const { wayProps } = await import("../scripts/rail");
  expect(wayProps({ railway: "rail", service: "yard" }).k).toBe(1);
  expect(wayProps({ railway: "rail", service: "siding", maxspeed: "40" })).toEqual({ k: 0, g: 0, t: 0, b: 0, v: 40 });
  expect(wayProps({ railway: "construction", construction: "narrow_gauge", opening_date: "2031" })).toMatchObject({ k: 3, g: 1, o: "2031" });
});

test("node heights: nearest 3D line, interpolated; a bridge track takes the bridge, not the line below", async () => {
  const { nodeHeights } = await import("../scripts/rail");
  // a line running east at 500→510 m, and a bridge crossing it north–south at 520 m
  const lines = [{ c: [[7.40, 46.90, 500], [7.41, 46.90, 510]], k: 0 }, { c: [[7.405, 46.899, 520], [7.405, 46.901, 520]], k: 2 }];
  // node 0 on the line, a quarter of the way; nodes 1–2 at the crossing: 1 on a bridge edge (1–2), 3 is far from both
  const nodes = [7.4025, 46.90001, 7.405, 46.9, 7.405, 46.9005, 7.5, 47.0], edges = [1, 2], kind = [2];
  const h = nodeHeights(nodes, edges, kind, lines);
  expect(h[0]).toBeCloseTo(502.5, 1);
  expect(h[1]).toBe(520); // on the bridge edge: the bridge, although the line below is just as near
  expect(Number.isNaN(h[3])).toBe(true);
});
