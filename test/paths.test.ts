import { expect, test } from "bun:test";
import { astar, makeGraph, route, routeTry, routeWith, simplify, snap, snapEdge } from "../server/paths";

// 0 -(east)- 1 -(curving north-east)- 2, and a longer way round 0 - 3 - 2 (bends no sharper than real track at a node)
const nodes = [8.5, 47.0, 8.51, 47.0, 8.52, 47.004, 8.51, 47.006];
const edges = [0, 1, 1, 2, 0, 3, 3, 2];
const g = makeGraph(nodes, edges);

test("snap finds nearest node within range, -1 beyond", () => {
  expect(snap(g, 8.5001, 47.0001)).toBe(0);
  expect(snap(g, 8.6, 47.0)).toBe(-1);
});

test("astar takes the shorter way round", () => { // plain A*, no turn rules
  expect(astar(g, 0, 2)).toEqual([0, 1, 2]);
  expect(astar(g, 0, 99 as any)).toBeNull();
});

test("route runs on the track, from beside the first station to beside the second; null when unsnappable", () => {
  const p = route(g, [8.503, 47.0002], [8.5201, 47.0041])!;
  expect([p[0], p[1]]).toEqual([8.503, 47]); // on the track, not at the station's point 22 m away
  expect([p.at(-2), p.at(-1)]).toEqual([8.52, 47.004]); // past the end of the track: its end
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

test("tunnels and bridges come out as shares of the path, OSM pieces of one tunnel merged", () => {
  // 5 nodes due east, ~760 m apart: open, tunnel "T" (two OSM ways), bridge
  const nodes = [8.5, 47, 8.51, 47, 8.52, 47, 8.53, 47, 8.54, 47];
  const gg = makeGraph(nodes, [0, 1, 1, 2, 2, 3, 3, 4], [], [0, 1, 1, 2], [-1, 0, 0, -1], ["T"]);
  const r = routeWith(gg, [8.5, 47], [8.54, 47])!;
  expect(r.t.map(([, , kind, name]) => [kind, name])).toEqual([[1, "T"], [2, ""]]);
  expect(r.t[0][0]).toBeCloseTo(0.25, 2);
  expect(r.t[0][1]).toBeCloseTo(0.75, 2);
  expect(r.t[1][1]).toBeCloseTo(1, 2);
});

test("line speeds come out as shares of the path, equal neighbours merged, untagged left out", () => {
  // 5 nodes due east, ~760 m apart: 160, 160, untagged, 80
  const nodes = [8.5, 47, 8.51, 47, 8.52, 47, 8.53, 47, 8.54, 47];
  const gg = makeGraph(nodes, [0, 1, 1, 2, 2, 3, 3, 4], [], [], [], [], [160, 160, 0, 80]);
  const r = routeWith(gg, [8.5, 47], [8.54, 47])!;
  expect(r.s.map(([, , v]) => v)).toEqual([160, 80]);
  expect(r.s[0][1]).toBeCloseTo(0.5, 2);
  expect(r.s[1][0]).toBeCloseTo(0.75, 2);
});

// a straight 1.5 km track due east at latitude 47 (nodes only at its ends, like a station track between two switches)
const E = (lon: number) => [lon, 47];
const line = (ns: number[][]) => ns.flat();

test("a point beside a long track snaps onto it, not to its far end node", () => {
  const gg = makeGraph(line([E(8.5), E(8.52)]), [0, 1]);
  const [s] = snapEdge(gg, 8.51, 47.0002);
  expect(s).toMatchObject({ lon: 8.51, lat: 47 });
  expect(s.d).toBeCloseTo(22, 0);
});

test("two stops on one track: a two-point path along it", () => {
  const gg = makeGraph(line([E(8.5), E(8.53)]), [0, 1]);
  expect(routeWith(gg, [8.505, 47.0001], [8.525, 46.9999])!.p).toEqual([8.505, 47, 8.525, 47]);
});

test("a stop inside a tunnel: the partial end edge keeps the tunnel and its line speed", () => {
  // open 0-1, tunnel 1-2 (1.5 km at 160); the train stops in the middle of the tunnel edge
  const gg = makeGraph(line([E(8.48), E(8.5), E(8.52)]), [0, 1, 1, 2], [], [0, 1], [-1, 0], ["T"], [100, 160]);
  const r = routeWith(gg, [8.485, 47], [8.51, 47])!;
  expect(r.t).toEqual([[expect.closeTo(0.6, 2), 1, 1, "T"]]);
  expect(r.s.at(-1)![2]).toBe(160);
});

test("platform 7 snaps to the track numbered 7, even when the quay is a little nearer track 8", () => {
  // tracks 7 and 8, 5 m apart (8 to the north), quay 3.5 m north of 7 = 1.5 m from 8
  const off = 5 / 111_320;
  const gg = makeGraph([8.5, 47, 8.52, 47, 8.5, 47 + off, 8.52, 47 + off], [0, 1, 2, 3], [], [], [], [], [], [0, 1], ["7", "8"]);
  expect(snapEdge(gg, 8.51, 47 + 3.5 / 111_320, "7")[0].lat).toBe(47);
  expect(snapEdge(gg, 8.51, 47 + 3.5 / 111_320, "12")[0].lat).toBeCloseTo(47 + off, 7); // no track 12: the nearest
});

test("yards: no shortcut through them, but used when they're the only way; a station point lands on the main track", () => {
  // main line 0-1-2 with a bend north (longer), yard track 0-2 straight (shorter)
  const nodes = line([E(8.5), [8.51, 47.002], E(8.52)]);
  const gg = makeGraph(nodes, [0, 1, 1, 2, 0, 2], [0, 0, 1]);
  const viaMain = routeWith(gg, [8.5, 47], [8.52, 47])!.p;
  expect(viaMain.some((x) => x === 47.002)).toBe(true);
  const yardOnly = makeGraph(nodes, [0, 2], [1]);
  expect(routeWith(yardOnly, [8.5, 47], [8.52, 47])).not.toBeNull();
  // a station point 10 m from the yard and 30 m from the main track (in another component-free layout): main wins
  const off = (m: number) => 47 + m / 111_320;
  const st = makeGraph([8.5, off(-10), 8.52, off(-10), 8.5, off(30), 8.52, off(30)], [0, 1, 2, 3], [1, 0]);
  expect(snapEdge(st, 8.51, 47)[0].lat).toBeCloseTo(off(30), 7);
  expect(snapEdge(st, 8.51, 47, "")[0].lat).toBeCloseTo(off(-10), 7); // a known platform: its own track, siding or not
});

test("double track: a station point nearer the other track doesn't send the route to the next crossover and back", () => {
  // two parallel tracks 4.5 m apart, joined by a crossover only 3 km east; a train on the south track stops at a
  // station whose point is 1 m from the north track
  const n = (m: number) => 47 + m / 111_320, x = (km: number) => 8.5 + km / 76;
  const nodes = [x(0), 47, x(2), 47, x(0), n(4.5), x(2), n(4.5), x(5), 47, x(5), n(4.5)];
  const gg = makeGraph(nodes, [0, 1, 2, 3, 1, 4, 3, 5, 4, 5], [0, 0, 0, 0, 2]);
  const r = routeWith(gg, [x(0.1), 46.99999], [x(1.5), n(5.5)])!;
  expect(r).not.toBeNull();
  expect(Math.max(...r.p.filter((_, i) => i % 2 === 0))).toBeLessThan(x(2)); // never past km 2
});

test("gauges: a metre-gauge train whose platform lies nearer a standard-gauge track still stays on its own", () => {
  // standard track (south) and metre-gauge track 10 m north, joined far east by dual-gauge track (as OSM does at Domodossola)
  const n = (m: number) => 47 + m / 111_320, x = (km: number) => 8.5 + km / 76;
  const nodes = [x(0), 47, x(30), 47, x(-3), n(10), x(30), n(10), x(0), n(10)];
  const gg = makeGraph(nodes, [0, 1, 2, 4, 4, 3, 1, 3], [], [], [], [], [], [], [], [0, 1, 1, 0]);
  const r = routeWith(gg, [x(-2), n(10)], [x(0.5), n(2)], { a: "", b: "" })!; // the platform 2 m from the standard track
  expect(r.p.at(-1)).toBeCloseTo(n(10), 5); // ends on the metre-gauge track (paths keep 5 decimals)
  expect(Math.max(...r.p.filter((_, i) => i % 2 === 0))).toBeLessThan(x(1)); // not round by the far junction
});

test("a platform point nearest a freight spur beside the line still puts the train on the main track", () => {
  // main track and a parallel spur 6 m north, joined only at the ends; both platforms' points lie 2 m from the spur
  const n = (m: number) => 47 + m / 111_320, x = (km: number) => 8.5 + km / 76;
  const nodes = [x(0), 47, x(1), 47, x(2), 47, x(0), n(6), x(1), n(6), x(2), n(6)];
  const gg = makeGraph(nodes, [0, 1, 1, 2, 3, 4, 4, 5, 0, 3, 2, 5], [0, 0, 1, 1, 1, 1]);
  const r = routeWith(gg, [x(0.2), n(4)], [x(1.8), n(4)], { a: "1", b: "1" })!;
  expect(r.p[1]).toBe(47); // starts on the main track
});

test("a stop beside the middle of a long straight (nodes only 10 km apart) still snaps onto it", () => {
  const gg = makeGraph([8.4, 47, 8.53, 47], [0, 1]); // ~10 km due east, one edge
  const [s] = snapEdge(gg, 8.465, 47.0001);
  expect(s).toMatchObject({ lon: 8.465, lat: 47 });
  expect(s.d).toBeCloseTo(11, 0);
});

test("no turning back at a switch: a proper way in wins even when longer; with no other way it turns back, and says so", () => {
  // switch S: trunk west, two branches east (north-east, south-east). From one branch to the other through S is a turn back.
  const x = (m: number) => 8.5 + m / 76_000, y = (m: number) => 47 + m / 111_320;
  const nodes = [x(0), y(0), x(-1000), y(0), x(1000), y(50), x(1000), y(-50)];
  const only = routeTry(makeGraph(nodes, [0, 1, 0, 2, 0, 3]), [x(800), y(40)], [x(800), y(-40)], { a: "", b: "" }) as any;
  expect(only.back).toBe(1); // nothing else in the data: it turns back (railcheck lists it) rather than vanish into a detour
  // a return loop joins the two branch ends further east (a semicircle, 22.5° a node): longer, still cheaper than turning back
  const loop = [...nodes], edges = [0, 1, 0, 2, 0, 3];
  let prev = 2;
  for (let k = 0; k <= 8; k++) {
    const th = Math.PI / 2 - (k * Math.PI) / 8, id = loop.push(x(2000 + 50 * Math.cos(th)), y(50 * Math.sin(th))) / 2 - 1;
    edges.push(prev, id);
    prev = id;
  }
  edges.push(prev, 3);
  const r = routeTry(makeGraph(loop, edges), [x(800), y(40)], [x(800), y(-40)], { a: "", b: "" }) as any;
  expect(r.back).toBe(0);
  expect(Math.max(...r.p.filter((_: number, i: number) => i % 2 === 0))).toBeCloseTo(x(2050), 4);
});

test("profileOf: heights every ~100 m, gaps bridged, a single wrong match smoothed away; too little known gives null", async () => {
  const { profileOf } = await import("../server/paths");
  // 1 km east (11 points ~100 m apart), climbing 500 → 600 m; one point unknown, one a 40 m spike (the line below a bridge)
  const pts: number[] = [], hs: number[] = [];
  for (let i = 0; i <= 10; i++) pts.push(7.4 + (i * 0.0131) / 10, 46.9), hs.push(500 + i * 10);
  hs[3] = NaN, hs[6] = 520;
  const h = profileOf(pts, hs)!;
  expect(h.length).toBe(11);
  expect(h[0]).toBe(500);
  expect(h[10]).toBe(600);
  expect(h[3]).toBe(530);
  expect(Math.abs(h[6] - 560)).toBeLessThanOrEqual(10); // the spike is gone
  expect(profileOf(pts, hs.map((x, i) => (i < 8 ? NaN : x)))).toBeNull();
});

test("keeping left: each direction of a double-track line takes its own track", async () => {
  const { trackSides } = await import("../scripts/rail");
  const { makeGraph, routeWith } = await import("../server/paths");
  // two tracks 4.4 m apart running east (south: nodes 1-3, north: 4-6), joined at a (0) in the west and b (7) in the east
  const S = 46.9, Nn = 46.90004;
  const nodes = [7.395, 46.90002, 7.4, S, 7.405, S, 7.41, S, 7.4, Nn, 7.405, Nn, 7.41, Nn, 7.415, 46.90002];
  const edges = [0, 1, 1, 2, 2, 3, 3, 7, 0, 4, 4, 5, 5, 6, 6, 7], svc = edges.map(() => 0).slice(0, edges.length / 2);
  const side = trackSides(nodes, edges, svc, () => true);
  expect(side[1]).toBe(1); // south track, seen eastward: the other track is on the left
  expect(side[5]).toBe(-1); // north track, seen eastward: the other one is on the right
  expect(side[3]).toBe(0); // the joining pieces have no parallel
  const g = makeGraph(nodes, edges, svc, [], [], [], [], [], [], [], Array.from(side));
  const lat = (p: number[]) => p.filter((_, k) => k % 2 === 1 && Math.abs(p[k - 1] - 7.405) < 0.004);
  expect(lat(routeWith(g, [7.395, 46.90002], [7.415, 46.90002])!.p).every((y) => y > 46.90003)).toBe(true); // eastbound: north = its left
  expect(lat(routeWith(g, [7.415, 46.90002], [7.395, 46.90002])!.p).every((y) => y < 46.90001)).toBe(true); // westbound: south
});
