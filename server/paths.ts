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
  const grid = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const c = cell(nodes[i * 2], nodes[i * 2 + 1]);
    grid.has(c) ? grid.get(c)!.push(i) : grid.set(c, [i]);
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
    svc: svcL.map((x) => Uint8Array.from(x)), ref: refL.map((x) => Int32Array.from(x)), refs, gauge: gaugeL.map((x) => Uint8Array.from(x)),
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
 * whose track number matches within 400 m wins, and sidings aren't penalised (some stations map platform tracks as sidings).
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
// shortcut: only edges with an end node in the 3×3 grid cells around the point (~2 km) are seen; fine for OSM station tracks,
// which have nodes every few dozen metres; a stop on an edge longer than that (a base tunnel's) would snap past it
export function nearEdges(g: Graph, lon: number, lat: number, platform?: string, max = 500, tol = platform === undefined ? 25 : 3) {
  const all = new Map<number, (Snap & { score: number })[]>(), c = cell(lon, lat), kx = Math.cos((lat * Math.PI) / 180), N = g.nodes;
  const want = platform ? g.refs.indexOf(platform) : -1;
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const u of g.grid.get(c + dx * 100000 + dy) ?? []) {
    for (let j = 0; j < g.adj[u].length; j++) {
      const v = g.adj[u][j];
      const ax = (N[u * 2] - lon) * kx, ay = N[u * 2 + 1] - lat, bx = (N[v * 2] - lon) * kx, by = N[v * 2 + 1] - lat;
      const ex = bx - ax, ey = by - ay, L2 = ex * ex + ey * ey, t = L2 ? Math.max(0, Math.min(1, -(ax * ex + ay * ey) / L2)) : 0;
      const plon = N[u * 2] + t * (N[v * 2] - N[u * 2]), plat = N[u * 2 + 1] + t * (N[v * 2 + 1] - N[u * 2 + 1]), d = dist(lon, lat, plon, plat);
      if (d > max) continue;
      const score = want >= 0 && g.ref[u][j] === want && d <= 400 ? d - 1000 : d + (platform === undefined && g.svc[u][j] === 1 ? 30 : 0);
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
function routeOnce(g: Graph, a: [number, number], b: [number, number], platforms: { a?: string; b?: string } = {}): { p: Path; t: Structs; s: Speeds; y: number } | { why: string } {
  const As = nearEdges(g, a[0], a[1], platforms.a), Bs = nearEdges(g, b[0], b[1], platforms.b);
  if (!As.size || !Bs.size) return { why: `no track within 500 m of ${As.size ? "the second" : "the first"} stop` };
  // the network and gauge both stops are nearest to first (a stop beside a tram terminus is still an S-Bahn stop)
  const near = (c: number) => As.get(c)![0].score + Bs.get(c)![0].score;
  const comps = [...As.keys()].filter((c) => Bs.has(c)).sort((x, y) => near(x) - near(y));
  if (!comps.length) return { why: "the stops are on different networks (gauge, or a network split in OSM)" };
  const N = g.nodes, nd = (i: number) => [N[i * 2], N[i * 2 + 1]] as const;
  // the bit of a snapped edge from its point to u (toV false) or v: length and routing cost; a candidate further than
  // the nearest pays its extra distance, so with equal routes the nearest track wins
  const ends = (xs: (Snap & { score: number })[]) => {
    const m = new Map<number, { cost: number; d: number; s: Snap }>();
    for (const s of xs) for (const toV of [false, true]) {
      const u = s.u, v = g.adj[u][s.j], node = toV ? v : u, full = dist(...nd(u), ...nd(v)), d = full * (toV ? 1 - s.t : s.t);
      const cost = (full ? (g.len[u][s.j] * d) / full : 0) + (s.score - xs[0].score);
      if (cost < (m.get(node)?.cost ?? Infinity)) m.set(node, { cost, d, s });
    }
    return m;
  };
  const sameEdge = (x: Snap, y: Snap) => { const xv = g.adj[x.u][x.j], yv = g.adj[y.u][y.j]; return (x.u === y.u && xv === yv) || (x.u === yv && xv === y.u); };
  let why = "no connection between them in the OSM graph";
  for (const comp of comps) {
    const ca = As.get(comp)!, cb = Bs.get(comp)!;
    let legs: Leg[], p: Path, A: Snap, B: Snap;
    const direct = ca.flatMap((x) => cb.filter((y) => sameEdge(x, y)).map((y) => [x, y] as const))[0]; // both on one edge
    if (direct) {
      [A, B] = direct;
      p = [A.lon, A.lat, B.lon, B.lat];
      legs = [legOf(g, A.u, A.j, dist(A.lon, A.lat, B.lon, B.lat))];
    } else {
      const from = ends(ca), to = ends(cb), target = cb[0];
      const nodes = astarMulti(g, [...from].map(([n, x]) => [n, x.cost]), new Map([...to].map(([n, x]) => [n, x.cost])), target.lon, target.lat, 150_000, comp % 2);
      if (!nodes) continue;
      const s0 = from.get(nodes[0])!, s1 = to.get(nodes.at(-1)!)!;
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
    return { p: simplify(p).map((x) => +x.toFixed(5)), t: structsOf(legs, len || 1), s: speedsOf(legs, len || 1), y: +y.toFixed(3) };
  }
  return { why };
}

const CACHE_V = 6; // 2: tunnels and bridges, 3: line speeds, 4: ends snapped onto track edges, 5: a stop may sit on any nearby track, 6: one gauge, main tracks over spurs. Another version (or a rebuilt rail graph) starts over.

/**
 * Paths for all segments, from cache + routing. Returns paths and their tunnels/bridges aligned with `segments`
 * (null = draw a straight line) and writes the cache back.
 */
export async function segmentPaths(g: Graph | null, segments: number[], stations: { uic: string; lon: number; lat: number; platform?: string }[], cacheFile: string) {
  const file = existsSync(cacheFile) ? await Bun.file(cacheFile).json().catch(() => null) : null; // unreadable: route again
  const graphId = g ? `${g.nodes.length}:${g.names.length}:${g.refs.length}:${g.gauge.length}` : "";
  const same = file?.v === CACHE_V && file.graph === graphId;
  const cache: Record<string, [Path, Structs, Speeds, number] | null> = same ? file.segs : {}, fails: Record<string, string> = same ? file.fails ?? {} : {};
  let computed = 0, matched = 0;
  const t0 = Date.now();
  const paths: (Path | null)[] = [], structs: (Structs | null)[] = [], speeds: (Speeds | null)[] = [];
  for (let k = 0; k < segments.length; k += 2) {
    const A = stations[segments[k]], B = stations[segments[k + 1]], key = `${A.uic}|${B.uic}`;
    if (!(key in cache) && g) {
      const r = routeTry(g, [A.lon, A.lat], [B.lon, B.lat], { a: A.platform, b: B.platform });
      cache[key] = "why" in r ? null : [r.p, r.t, r.s, r.y];
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
