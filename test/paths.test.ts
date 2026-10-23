import { expect, test } from "bun:test";
import { astar, makeGraph, route, simplify, snap } from "../server/paths";

// square-ish graph: 0 -(east)- 1 -(north)- 2, and a direct diagonal 0 - 3 - 2 that is longer via a detour
const nodes = [8.5, 47.0, 8.51, 47.0, 8.51, 47.01, 8.49, 47.02];
const edges = [0, 1, 1, 2, 0, 3, 3, 2];
const g = makeGraph(nodes, edges);

test("snap finds nearest node within range, -1 beyond", () => {
  expect(snap(g, 8.5001, 47.0001)).toBe(0);
  expect(snap(g, 8.6, 47.0)).toBe(-1);
});

test("astar takes the shorter way round", () => {
  expect(astar(g, 0, 2)).toEqual([0, 1, 2]);
  expect(astar(g, 0, 99 as any)).toBeNull();
});

test("route returns station-to-station track, null when unsnappable", () => {
  const p = route(g, [8.5001, 47.0001], [8.5101, 47.0101]);
  expect(p![0]).toBeCloseTo(8.5001, 4); // starts at the station itself
  expect(p!.length / 2).toBeGreaterThanOrEqual(3);
  expect(route(g, [8.9, 47], [8.5, 47])).toBeNull();
});

test("simplify drops collinear points but keeps corners", () => {
  const line = [8.5, 47, 8.501, 47, 8.502, 47, 8.502, 47.001];
  expect(simplify(line, 4)).toEqual([8.5, 47, 8.502, 47, 8.502, 47.001]);
});

test("route rejects absurd detours caused by gaps in the data", () => {
  // 0 and 2 are 1.5 km apart as the crow flies, but the only track between them is a 60 km loop
  const nodes = [8.5, 47.0, 8.5, 47.5, 8.51, 47.01], edges = [0, 1, 1, 2];
  const gg = makeGraph(nodes, edges);
  expect(route(gg, [8.5, 47.0], [8.51, 47.01])).toBeNull();
});
