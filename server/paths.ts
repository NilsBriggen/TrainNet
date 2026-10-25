// Routes platform-to-platform legs along the OSM rail graph (data/rail.json) with A*. Both ends are snapped onto a track
// edge (a train stands on the track, not on the station's map point). Results are cached in data/paths.json keyed by
// "uic:platform" pairs, so timetable updates only cost new legs.
import { existsSync, renameSync } from "node:fs";

/** Write via a temp file and rename, so a crash mid-write never leaves a truncated file behind. */
export async function writeAtomic(file: string, data: string) {
  await Bun.write(`${file}.tmp`, data);
  renameSync(`${file}.tmp`, file);
}

export type Graph = {
  nodes: Float64Array; adj: Int32Array[]; len: Float32Array[]; grid: Map<number, number[]>; comp: Int32Array;
  kind: Uint8Array[]; name: Int32Array[]; names: string[]; // per adjacency entry: 1 tunnel, 2 bridge; tunnel name index
  speed: Uint16Array[]; // per adjacency entry: OSM maxspeed, km/h, 0 = unknown
  svc: Uint8Array[]; ref: Int32Array[]; refs: string[]; // per adjacency entry: 0 main, 1 siding/yard/spur, 2 crossover; track number index
  gauge: Uint8Array[]; // per adjacency entry: 0 standard, 1 narrow; a route stays on one
  edges: Map<number, number[]>; // grid cell -> flat [u, j, ...]: every edge in every cell it passes (a 3 km straight has nodes only at its ends)
};
/** Routing cost per metre by track kind: a yard is never a shortcut, but still connects where it's the only track. */
const COST = [1, 8, 1.5];
export type Path = number[]; // flat [lon, lat, ...]
/** Tunnels and bridges along a path: [fromShare, toShare, kind (1 tunnel, 2 bridge), name] with shares of its length, 0..1. */
export type Structs = [number, number, number, string][];
/** Line speed along a path: [fromShare, toShare, km/h], untagged stretches left out. */
export type Speeds = [number, number, number][];

/** The number a track or platform is known by: "7" for "7", "7a", "7;8" or "7A-D"; "" for "Ost". OSM and GTFS meet on it. */
export const trackNo = (ref?: string) => ref?.match(/^\d+/)?.[0] ?? "";

const R = 6371000;
export const dist = (lon1: number, lat1: number, lon2: number, lat2: number) => {
  const x = ((lon2 - lon1) * Math.PI / 180) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180), y = (lat2 - lat1) * Math.PI / 180;
  return Math.sqrt(x * x + y * y) * R; // equirectangular: plenty for < 100 km
};
const cell = (lon: number, lat: number) => Math.round(lon * 100) * 100000 + Math.round(lat * 100);

export function makeGraph(nodes: number[], edges: number[], svc: number[] = [], kind: number[] = [], name: number[] = [], names: string[] = [], speed: number[] = [],
  ref: number[] = [], refs: string[] = [], gauge: number[] = []): Graph {
  const n = nodes.length / 2, L = () => Array.from({ length: n }, (): number[] => []);
  const adjL = L(), lenL = L(), kindL = L(), nameL = L(), speedL = L(), svcL = L(), refL = L(), gaugeL = L();
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e], b = edges[e + 1], x = e / 2, sv = svc[x] ?? 0;
    const d = dist(nodes[a * 2], nodes[a * 2 + 1], nodes[b * 2], nodes[b * 2 + 1]) * (COST[sv] ?? 1);
    for (const [u, v] of [[a, b], [b, a]]) {
      adjL[u].push(v), lenL[u].push(d), kindL[u].push(kind[x] ?? 0), nameL[u].push(name[x] ?? -1), speedL[u].push(speed[x] ?? 0), svcL[u].push(sv), refL[u].push(ref[x] ?? -1), gaugeL[u].push(gauge[x] ?? 0);
    }
  }
  const grid = new Map<number, number[]>(), edgeGrid = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const c = cell(nodes[i * 2], nodes[i * 2 + 1]);
    grid.has(c) ? grid.get(c)!.push(i) : grid.set(c, [i]);
  }
  for (let u = 0; u < n; u++) for (let j = 0; j < adjL[u].length; j++) {
    const v = adjL[u][j];
    if (v < u) continue; // each edge once
    const x0 = nodes[u * 2], y0 = nodes[u * 2 + 1], x1 = nodes[v * 2], y1 = nodes[v * 2 + 1];
    const steps = Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) / 0.004), seen = new Set<number>(); // samples under half a cell apart
    for (let k = 0; k <= steps; k++) {
      const c = cell(x0 + ((x1 - x0) * k) / (steps || 1), y0 + ((y1 - y0) * k) / (steps || 1));
      if (!seen.has(c)) seen.add(c), (edgeGrid.get(c) ?? edgeGrid.set(c, []).get(c)!).push(u, j);
    }
  }
  // connected component per node: standard and narrow gauge networks are separate graphs
  const comp = new Int32Array(n).fill(-1);
  for (let s = 0, c = 0; s < n; s++) {
    if (comp[s] >= 0) continue;
    const stack = [s];
    comp[s] = c;
    while (stack.length) for (const w of adjL[stack.pop()!]) if (comp[w] < 0) (comp[w] = c), stack.push(w);
    c++;
  }
  return {
    nodes: Float64Array.from(nodes), adj: adjL.map((a) => Int32Array.from(a)), len: lenL.map((l) => Float32Array.from(l)), grid, comp,
    kind: kindL.map((k) => Uint8Array.from(k)), name: nameL.map((x) => Int32Array.from(x)), names, speed: speedL.map((x) => Uint16Array.from(x)),
    svc: svcL.map((x) => Uint8Array.from(x)), ref: refL.map((x) => Int32Array.from(x)), refs, gauge: gaugeL.map((x) => Uint8Array.from(x)), edges: edgeGrid,
  };
}

/** Nearest graph node per component within `max` metres, nearest first (a station can sit on two networks). */
export function snapAll(g: Graph, lon: number, lat: number, max = 500): { node: number; d: number }[] {
  const best = new Map<number, { node: number; d: number }>();
  const c = cell(lon, lat);
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    for (const i of g.grid.get(c + dx * 100000 + dy) ?? []) {
      const d = dist(lon, lat, g.nodes[i * 2], g.nodes[i * 2 + 1]);
      if (d < max && d < (best.get(g.comp[i])?.d ?? Infinity)) best.set(g.comp[i], { node: i, d });
    }
  }
  return [...best.values()].sort((a, b) => a.d - b.d);
}
/** Nearest graph node within `max` metres, or -1. */
export const snap = (g: Graph, lon: number, lat: number, max = 500) => snapAll(g, lon, lat, max)[0]?.node ?? -1;

/** A point on a track edge: u → adjacency j (v = g.adj[u][j]), share t along it, the point, and its distance from where we asked. */
export type Snap = { u: number; j: number; t: number; lon: number; lat: number; d: number };
/**
 * Nearest track edge per component within `max` metres (projection, not the nearest node: station tracks often have nodes
 * only at the switches). `platform`: the stop's platform is known ("7", or "" when its code has no number). Then an edge
 * whose track number matches within 30 m wins, and sidings aren't penalised (some stations map platform tracks as sidings).
 * Unknown platform (a station's map point): sidings, yards and spurs count 30 m further, so the train stands on a main track.
 */
export function snapEdge(g: Graph, lon: number, lat: number, platform?: string, max = 500): Snap[] {
  return [...nearEdges(g, lon, lat, platform, max).values()].map((x) => x[0]).sort((a, b) => a.score - b.score).map(({ score, ...s }) => s);
}
/**
 * Like snapEdge, but every edge per component scoring within `tol` metres of that component's best, best first. A stop
 * mustn't pin one track: on a double-track line the station point is nearest one of the two, the train may come on the
 * other, and pinning it would send the route on to the next crossover and back. Default tolerance: 25 m for a station
 * point (the tracks beside each other), 3 m for a known platform (its own track; a matching track number stays exact).
 */
export function nearEdges(g: Graph, lon: number, lat: number, platform?: string, max = 500, tol = platform === undefined ? 25 : 3) {
  const all = new Map<number, (Snap & { score: number })[]>(), c = cell(lon, lat), kx = Math.cos((lat * Math.PI) / 180), N = g.nodes;
  const want = platform ? g.refs.indexOf(platform) : -1;
  const seen = new Set<number>();
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const list = g.edges.get(c + dx * 100000 + dy) ?? [];
    for (let e = 0; e < list.length; e += 2) {
      const u = list[e], j = list[e + 1], v = g.adj[u][j];
      if (seen.has(u * 1024 + j)) continue; // an edge crossing several of these cells
      seen.add(u * 1024 + j);
      const ax = (N[u * 2] - lon) * kx, ay = N[u * 2 + 1] - lat, bx = (N[v * 2] - lon) * kx, by = N[v * 2 + 1] - lat;
      const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey, t = L2 ? Math.max(0, Math.min(1, -(ax * ex + ay * ey) / L2)) : 0;
      const plon = N[u * 2] + t * (N[v * 2] - N[u * 2]), plat = N[u * 2 + 1] + t * (N[v * 2 + 1] - N[u * 2 + 1]), d = dist(lon, lat, plon, plat);
      if (d > max) continue;
      // a matching track number only right at the platform: 400 m away it was another station's (or a siding's) track 1
      const score = want >= 0 && g.ref[u][j] === want && d <= 30 ? d - 1000 : d + (platform === undefined && g.svc[u][j] === 1 ? 30 : 0);
      const key = g.comp[u] * 2 + (g.gauge[u]?.[j] ?? 0); // per network and gauge: a train only matches tracks of its own gauge
      (all.get(key) ?? all.set(key, []).get(key)!).push({ u, j, t, lon: plon, lat: plat, d, score });
    }
  }
  for (const [comp, xs] of all) {
    xs.sort((a, b) => a.score - b.score);
    all.set(comp, xs.filter((x) => x.score <= xs[0].score + (xs[0].score < -500 ? 0 : tol))); // a matching track number: just that track
  }
  return all;
}

// binary heap keyed on f-score
class Heap {
  keys: number[] = []; vals: number[] = [];
  push(k: number, v: number) {
    let i = this.keys.push(k) - 1; this.vals.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      [this.keys[p], this.keys[i]] = [this.keys[i], this.keys[p]]; [this.vals[p], this.vals[i]] = [this.vals[i], this.vals[p]]; i = p;
    }
  }
  pop(): number {
    const top = this.vals[0], k = this.keys.pop()!, v = this.vals.pop()!;
    if (this.keys.length) {
      this.keys[0] = k; this.vals[0] = v;
      let i = 0;
      for (;;) {
        let m = i; const l = 2 * i + 1, r = l + 1;
        if (l < this.keys.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.keys.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        [this.keys[m], this.keys[i]] = [this.keys[i], this.keys[m]]; [this.vals[m], this.vals[i]] = [this.vals[i], this.vals[m]]; i = m;
      }
    }
    return top;
  }
  get size() { return this.keys.length; }
}

/**
 * A* from several start nodes (each with a cost already paid) to several goal nodes (each with a cost still to pay),
 * toward the point (tx, ty): the node list of the cheapest way, or null. Gives up past `limit` metres of search radius.
 */
export function astarMulti(g: Graph, starts: [number, number][], goals: Map<number, number>, tx: number, ty: number, limit = 150_000, gauge = -1): number[] | null {
  const N = g.nodes, h = (i: number) => dist(N[i * 2], N[i * 2 + 1], tx, ty), END = -1;
  const gs = new Map<number, number>(), prev = new Map<number, number>(), done = new Set<number>(), open = new Heap();
  for (const [s, c] of starts) if (h(s) <= limit && c < (gs.get(s) ?? Infinity)) gs.set(s, c), open.push(c + h(s), s);
  let last = -1, total = Infinity;
  while (open.size) {
    const u = open.pop();
    if (u === END) break; // the cheapest way through a goal, tail included
    if (done.has(u)) continue;
    done.add(u);
    const gu = gs.get(u)!;
    if (gu > limit * 2) return null;
    const tail = goals.get(u);
    if (tail !== undefined && gu + tail < total) (total = gu + tail), (last = u), open.push(total, END);
    for (let k = 0; k < g.adj[u].length; k++) {
      if (gauge >= 0 && g.gauge[u][k] !== gauge) continue; // stays on its gauge
      const v = g.adj[u][k], nv = gu + g.len[u][k];
      if (nv < (gs.get(v) ?? Infinity)) gs.set(v, nv), prev.set(v, u), open.push(nv + h(v), v);
    }
  }
  if (last < 0) return null;
  const path = [last];
  for (let v = last; prev.has(v);) path.push((v = prev.get(v)!));
  return path.reverse();
}
/**
 * A* over directed track pieces, so a route doesn't turn back at a switch (out on one branch, back on the other) or turn
 * onto a crossing line: a turn of 70° or more at a node costs as much as 3 km of track. Trains change direction at stops,
 * the ends of a leg. Not forbidden outright: where OSM lacks the real connection (a platform track mapped as a dead end,
 * a kinked switch) a ban sent legs on 50-140 km detours; this way they turn back there, and railcheck lists them. starts: [from, to, cost to reach `to`, free]; goals: node -> [next node, cost to finish along that edge, free].
 * `free`: the stop is right at that node, so leaving it (a start) or ending there (a goal) takes no turn.
 * Returns the nodes (each start's `to` first), the start used (its `from`) and the goal edge's next node; or null.
 */
const TURN = Math.cos((70 * Math.PI) / 180), TURN_BACK = 3000;
export function astarTurns(g: Graph, starts: [number, number, number, boolean][], goals: Map<number, [number, number, boolean][]>, tx: number, ty: number, limit = 150_000, gauge = -1) {
  const N = g.nodes, kx = Math.cos((ty * Math.PI) / 180), h = (i: number) => dist(N[i * 2], N[i * 2 + 1], tx, ty);
  const straightOn = (a: number, b: number, c: number) => {
    const ux = (N[b * 2] - N[a * 2]) * kx, uy = N[b * 2 + 1] - N[a * 2 + 1], vx = (N[c * 2] - N[b * 2]) * kx, vy = N[c * 2 + 1] - N[b * 2 + 1], L = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    return !L || (ux * vx + uy * vy) / L > TURN;
  };
  const key = (from: number, j: number) => from * 1024 + j; // a directed piece: from a node along its j-th edge
  const gs = new Map<number, number>(), prev = new Map<number, number>(), done = new Set<number>(), open = new Heap(), END = -1, free = new Set<number>();
  for (const [f, t, c, fr] of starts) {
    const k = key(f, g.adj[f].indexOf(t));
    if (fr) free.add(k);
    if (h(t) <= limit && c < (gs.get(k) ?? Infinity)) gs.set(k, c), open.push(c + h(t), k);
  }
  let best = -1, next = -1, total = Infinity;
  while (open.size) {
    const k = open.pop();
    if (k === END) break; // the cheapest way onto a goal edge, its last bit included
    if (done.has(k)) continue;
    done.add(k);
    const f = Math.floor(k / 1024), x = g.adj[f][k % 1024], gx = gs.get(k)!;
    if (gx > limit * 2) return null;
    for (const [y, tail, fr] of goals.get(x) ?? []) {
      const t = gx + tail + (fr || straightOn(f, x, y) ? 0 : TURN_BACK);
      if (t < total) (total = t), (best = k), (next = y), open.push(total, END);
    }
    for (let m = 0; m < g.adj[x].length; m++) {
      const y = g.adj[x][m];
      if (y === f || (gauge >= 0 && g.gauge[x][m] !== gauge)) continue;
      const nk = key(x, m), nv = gx + g.len[x][m] + (free.has(k) || straightOn(f, x, y) ? 0 : TURN_BACK);
      if (nv < (gs.get(nk) ?? Infinity)) gs.set(nk, nv), prev.set(nk, k), open.push(nv + h(y), nk);
    }
  }
  if (best < 0) return null;
  const states: number[] = [];
  for (let k: number | undefined = best; k !== undefined; k = prev.get(k)) states.push(k);
  states.reverse();
  const nodes = states.map((k) => g.adj[Math.floor(k / 1024)][k % 1024]), from = Math.floor(states[0] / 1024);
  let back = 0; // turns back taken anyway (no other way in OSM), for railcheck
  [from, ...nodes, next].forEach((x, k, a) => { if (k >= 1 && k < a.length - 1 && !straightOn(a[k - 1], x, a[k + 1])) back++; });
  return { nodes, from, next, back };
}

/** A* between two graph nodes; node index list or null. */
export const astar = (g: Graph, from: number, to: number, limit = 150_000) =>
  astarMulti(g, [[from, 0]], new Map([[to, 0]]), g.nodes[to * 2], g.nodes[to * 2 + 1], limit);

/** Douglas-Peucker on a flat [lon,lat,...] path, tolerance in metres. */
export function simplify(p: Path, tol = 4): Path {
  const n = p.length / 2;
  if (n < 3) return p;
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const stack: [number, number][] = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0, idx = -1;
    const ax = p[a * 2], ay = p[a * 2 + 1], bx = p[b * 2], by = p[b * 2 + 1];
    const kx = Math.cos(((ay + by) / 2) * Math.PI / 180), dx = (bx - ax) * kx, dy = by - ay, L2 = dx * dx + dy * dy;
    for (let i = a + 1; i < b; i++) {
      const px = (p[i * 2] - ax) * kx, py = p[i * 2 + 1] - ay;
      const t = L2 ? Math.max(0, Math.min(1, (px * dx + py * dy) / L2)) : 0;
      const ex = px - t * dx, ey = py - t * dy, d = Math.sqrt(ex * ex + ey * ey) * (Math.PI / 180) * R;
      if (d > maxD) (maxD = d), (idx = i);
    }
    if (maxD > tol) keep[idx] = 1, stack.push([a, idx], [idx, b]);
  }
  const out: Path = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[i * 2], p[i * 2 + 1]);
  return out;
}

export async function loadGraph(file: string): Promise<Graph | null> {
  if (!existsSync(file)) return null;
  const { nodes, edges, svc, kind, name, names, speed, ref, refs, gauge } = await Bun.file(file).json();
  return makeGraph(nodes, edges, svc, kind, name, names, speed, ref, refs, gauge);
}

/** A routed path as pieces of track: length (m) with the edge's tunnel/bridge, tunnel name, line speed and service kind. */
type Leg = { d: number; kind: number; name: string; kmh: number; svc: number };
const legOf = (g: Graph, u: number, j: number, d: number): Leg => ({ d, kind: g.kind[u][j] ?? 0, name: g.name[u][j] >= 0 ? g.names[g.name[u][j]] : "", kmh: g.speed[u]?.[j] ?? 0, svc: g.svc[u]?.[j] ?? 0 });

/** Intervals of equal `key` along the legs, as shares of the length; equal neighbours merge across gaps under 30 m. */
function intervals<T>(legs: Leg[], total: number, key: (l: Leg) => T | null, same: (a: T, b: T) => boolean, minLen: number): [number, number, T][] {
  const out: [number, number, T][] = [];
  let at = 0;
  for (const l of legs) {
    const k = key(l), last = out.at(-1);
    if (k !== null && last && same(last[2], k) && at - last[1] * total < 30) last[1] = (at + l.d) / total;
    else if (k !== null) out.push([at / total, (at + l.d) / total, k]);
    at += l.d;
  }
  return out.filter((x) => (x[1] - x[0]) * total >= minLen).map((x) => [+x[0].toFixed(5), +x[1].toFixed(5), x[2]]);
}
/** Tunnels and bridges as shares of the path (OSM splits a tunnel into several ways; short culverts and level bridges are noise). */
const structsOf = (legs: Leg[], total: number): Structs =>
  intervals(legs, total, (l) => (l.kind ? [l.kind, l.name] as const : null), (a, b) => a[0] === b[0] && a[1] === b[1], 40).map(([f, t, [k, n]]) => [f, t, k, n]);
/** Line speed intervals; untagged edges and stretches under 300 m left out. */
const speedsOf = (legs: Leg[], total: number): Speeds => intervals(legs, total, (l) => l.kmh || null, (a, b) => a === b, 300);

/** Track path between two points, or null if either can't be snapped / routed. */
export function route(g: Graph, a: [number, number], b: [number, number]): Path | null {
  return routeWith(g, a, b)?.p ?? null;
}

/**
 * Route between two stops. Each end is snapped onto a track edge (see snapEdge; `platforms` says which ends are a known
 * platform and its number) and the path starts and ends on the track: never at the given points, which are often a
 * station building. A* runs from both ends of the start edge to both ends of the goal edge, partial edges included.
 */
export function routeWith(g: Graph, a: [number, number], b: [number, number], platforms: { a?: string; b?: string } = {}) {
  const r = routeTry(g, a, b, platforms);
  return "why" in r ? null : r;
}
/** routeWith, or why there's no track path: for scripts/railcheck.ts. y = share of the length on sidings, yards, spurs. */
export function routeTry(g: Graph, a: [number, number], b: [number, number], platforms: { a?: string; b?: string } = {}) {
  const r = routeOnce(g, a, b, platforms);
  // a platform point nearest a siding beside the line (and track numbers that don't match, like BLS's 701/702 for
  // platforms 1/2) can put a whole leg on a freight spur: then try main tracks first, and keep that if it's clearly less yard
  if ("y" in r && r.y > 0.3 && (platforms.a !== undefined || platforms.b !== undefined)) {
    const alt = routeOnce(g, a, b);
    if ("y" in alt && alt.y < r.y - 0.2) return alt;
  }
  return r;
}
function routeOnce(g: Graph, a: [number, number], b: [number, number], platforms: { a?: string; b?: string } = {}): { p: Path; t: Structs; s: Speeds; y: number; back?: number } | { why: string } {
  const As = nearEdges(g, a[0], a[1], platforms.a), Bs = nearEdges(g, b[0], b[1], platforms.b);
  if (!As.size || !Bs.size) return { why: `no track within 500 m of ${As.size ? "the second" : "the first"} stop` };
  // the network and gauge both stops are nearest to first (a stop beside a tram terminus is still an S-Bahn stop)
  const near = (c: number) => As.get(c)![0].score + Bs.get(c)![0].score;
  const comps = [...As.keys()].filter((c) => Bs.has(c)).sort((x, y) => near(x) - near(y));
  if (!comps.length) return { why: "the stops are on different networks (gauge, or a network split in OSM)" };
  const N = g.nodes, nd = (i: number) => [N[i * 2], N[i * 2 + 1]] as const;
  // the bit of a snapped edge from its point to one of its nodes: length and routing cost; a candidate further than
  // the nearest pays its extra distance, so with equal routes the nearest track wins
  const part = (s: Snap & { score: number }, toV: boolean, best: number) => {
    const u = s.u, v = g.adj[u][s.j], full = dist(...nd(u), ...nd(v)), d = full * (toV ? 1 - s.t : s.t);
    return { node: toV ? v : u, other: toV ? u : v, d, cost: (full ? (g.len[u][s.j] * d) / full : 0) + (s.score - best), s };
  };
  const sameEdge = (x: Snap, y: Snap) => { const xv = g.adj[x.u][x.j], yv = g.adj[y.u][y.j]; return (x.u === y.u && xv === yv) || (x.u === yv && xv === y.u); };
  let why = "no connection between them in the OSM graph";
  for (const comp of comps) {
    const ca = As.get(comp)!, cb = Bs.get(comp)!;
    let legs: Leg[], p: Path, A: Snap, B: Snap, back = 0;
    const direct = ca.flatMap((x) => cb.filter((y) => sameEdge(x, y)).map((y) => [x, y] as const))[0]; // both on one edge
    if (direct) {
      [A, B] = direct;
      p = [A.lon, A.lat, B.lon, B.lat];
      legs = [legOf(g, A.u, A.j, dist(A.lon, A.lat, B.lon, B.lat))];
    } else {
      // leaving the start edge either way (a train may reverse at a stop); arriving onto the goal edge from either end
      const starts = ca.flatMap((s) => [part(s, true, ca[0].score), part(s, false, ca[0].score)]), goals = new Map<number, [number, number][]>(), goalInfo = new Map<string, ReturnType<typeof part>>();
      for (const s of cb) for (const toV of [false, true]) {
        const x = part(s, toV, cb[0].score); // reaching x.node, then along the edge (toward x.other) to the stop
        (goals.get(x.node) ?? goals.set(x.node, []).get(x.node)!).push([x.other, x.cost, x.d < 0.5]); // the stop right at the node: no turn to finish
        goalInfo.set(`${x.node}:${x.other}`, x);
      }
      const r = astarTurns(g, starts.map((x) => [x.other, x.node, x.cost, x.d < 0.5]), goals, cb[0].lon, cb[0].lat, 150_000, comp % 2); // right at a node: any way out
      if (!r) continue;
      back = r.back;
      const nodes = r.nodes, s0 = starts.find((x) => x.node === nodes[0] && x.other === r.from)!, s1 = goalInfo.get(`${nodes.at(-1)}:${r.next}`)!;
      (A = s0.s), (B = s1.s);
      p = [A.lon, A.lat];
      for (const i of nodes) p.push(...nd(i));
      p.push(B.lon, B.lat);
      legs = [legOf(g, A.u, A.j, s0.d)];
      for (let k = 1; k < nodes.length; k++) {
        const u = nodes[k - 1], v = nodes[k];
        legs.push(legOf(g, u, g.adj[u].indexOf(v), dist(...nd(u), ...nd(v))));
      }
      legs.push(legOf(g, B.u, B.j, s1.d));
    }
    const len = legs.reduce((x, l) => x + l.d, 0), crow = dist(A.lon, A.lat, B.lon, B.lat);
    // a gap in OSM makes A* take the long way round (Interlaken Ost–West came back as 187 km); a straight line is better than that
    if (len > 2.5 * crow + 3000) { why = `detour: ${(len / 1000).toFixed(1)} km of track for ${(crow / 1000).toFixed(1)} km`; continue; }
    const y = legs.reduce((x, l) => x + (l.svc === 1 ? l.d : 0), 0) / (len || 1);
    // within 1 m of the OSM track (its stored precision): zoomed in, a train and its route lie exactly on the drawn track
    return { p: simplify(p, 1).map((x) => +x.toFixed(5)), t: structsOf(legs, len || 1), s: speedsOf(legs, len || 1), y: +y.toFixed(3), back };
  }
  return { why };
}

const CACHE_V = 10; // 2: tunnels and bridges, 3: line speeds, 4: ends snapped onto track edges, 5: a stop may sit on any nearby track, 6: one gauge, main tracks over spurs, 7: no turning back at switches; long edges found, 8: paths within 1 m of the track, 9: track numbers only right at the platform, 10: turning back costs 3 km. Another version (or a rebuilt rail graph) starts over.

/**
 * Paths for all segments, from cache + routing. Returns paths and their tunnels/bridges aligned with `segments`
 * (null = draw a straight line) and writes the cache back.
 */
export async function segmentPaths(g: Graph | null, segments: number[], stations: { uic: string; lon: number; lat: number; platform?: string }[], cacheFile: string) {
  const file = existsSync(cacheFile) ? await Bun.file(cacheFile).json().catch(() => null) : null; // unreadable: route again
  const graphId = g ? `${g.nodes.length}:${g.names.length}:${g.refs.length}:${g.gauge.length}` : "";
  const same = file?.v === CACHE_V && file.graph === graphId;
  const cache: Record<string, [Path, Structs, Speeds, number, number] | null> = same ? file.segs : {}, fails: Record<string, string> = same ? file.fails ?? {} : {};
  let computed = 0, matched = 0;
  const t0 = Date.now();
  const paths: (Path | null)[] = [], structs: (Structs | null)[] = [], speeds: (Speeds | null)[] = [];
  for (let k = 0; k < segments.length; k += 2) {
    const A = stations[segments[k]], B = stations[segments[k + 1]], key = `${A.uic}|${B.uic}`;
    if (!(key in cache) && g) {
      const r = routeTry(g, [A.lon, A.lat], [B.lon, B.lat], { a: A.platform, b: B.platform });
      cache[key] = "why" in r ? null : [r.p, r.t, r.s, r.y, r.back ?? 0];
      if ("why" in r) fails[key] = r.why;
      computed++;
    }
    const c = cache[key] ?? null;
    if (c) matched++;
    paths.push(c?.[0] ?? null);
    structs.push(c?.[1].length ? c[1] : null);
    speeds.push(c?.[2]?.length ? c[2] : null);
  }
  if (computed && g) await writeAtomic(cacheFile, JSON.stringify({ v: CACHE_V, graph: graphId, segs: cache, fails }));
  console.log(`[paths] ${matched}/${segments.length / 2} segments on track (${computed} newly routed, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return { paths, structs, speeds };
}
