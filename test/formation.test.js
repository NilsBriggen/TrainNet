import { expect, test } from "bun:test";
import { sideView } from "../public/formation.js";

const drawn = (svg) => [...svg.matchAll(/data-w="([\d.]+)" data-h="(\d+)"/g)].map((m) => ({ w: +m[1], h: +m[2] }));

test("side view: units to scale by length, double deckers taller, unknown series as a plain unit", () => {
  const units = [{ id: "g", cls: "501", type: "Giruno", cars: 11, length: 202 }, { id: "d", cls: "502", type: "FV-Dosto", cars: 4, length: 101 }, { id: "x", cls: "X9", type: "?", cars: 2, length: 50.5 }];
  const strip = (id, n) => Array.from({ length: n }, () => ({ unit: id, c: "2" }));
  const svg = sideView([...strip("g", 11), ...strip("d", 4), ...strip("x", 2)], units, "#ff3d5a");
  const [g, d, x] = drawn(svg);
  expect(g.w / d.w).toBeCloseTo(2, 2); // 202 m against 101 m
  expect(d.w / x.w).toBeCloseTo(2, 2);
  expect(d.h).toBeGreaterThan(g.h); // double deck
  expect(x.h).toBe(g.h);
  expect((svg.match(/class="sv-body"/g) ?? []).length).toBe(17); // one shape per car
  expect(sideView([], [], "#fff")).toBe("");
});

test("side view of a loco-hauled train: the locomotive and every coach, not the locomotive stretched over the width", () => {
  const coaches = [{ unit: "460-113", c: "" }, ...Array.from({ length: 9 }, (_, k) => ({ unit: null, c: k < 3 ? "1" : "2" })), { unit: null, c: "2", wr: true }];
  const svg = sideView(coaches, [{ id: "460-113", cls: "460", type: "Re 460", cars: 1, length: 19 }], "#ff3d5a");
  const d = drawn(svg);
  expect(d.length).toBe(11); // loco + 10 coaches
  expect(d[1].w / d[0].w).toBeCloseTo(26.5 / 19, 2);
  expect(svg).toContain("restaurant coach");
});
