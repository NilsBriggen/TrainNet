// Routes station-to-station segments along the OSM rail graph (data/rail.json) with A*.
// Results are cached in data/paths.json keyed by station UICs, so timetable updates only cost new pairs.
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
};
export type Path = number[]; // flat [lon, lat, ...]
/** Tunnels and bridges along a path: [fromShare, toShare, kind (1 tunnel, 2 bridge), name] with shares of its length, 0..1. */
export type Structs = [number, number, number, string][];
/** Line speed along a path: [fromShare, toShare, km/h], untagged stretches left out. */
export type Speeds = [number, number, number][];

const R = 6371000;
export const dist = (lon1: number, lat1: number, lon2: number, lat2: number) => {
  const x = ((lon2 - lon1) * Math.PI / 180) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180), y = (lat2 - lat1) * Math.PI / 180;
  return Math.sqrt(x * x + y * y) * R; // equirectangular: plenty for < 100 km
};
const cell = (lon: number, lat: number) => Math.round(lon * 100) * 100000 + Math.round(lat * 100);

export function makeGraph(nodes: number[], edges: number[], svc: number[] = [], kind: number[] = [], name: number[] = [], names: string[] = [], speed: number[] = []): Graph {
  const n = nodes.length / 2, adjL: number[][] = Array.from({ length: n }, () => []), lenL: number[][] = Array.from({ length: n }, () => []);
  const kindL: number[][] = Array.from({ length: n }, () => []), nameL: number[][] = Array.from({ length: n }, () => []), speedL: number[][] = Array.from({ length: n }, () => []);
  for (let e = 0; e < edges.length; e += 2) {
    const a = edges[e], b = edges[e + 1], k = kind[e / 2] ?? 0, nm = name[e / 2] ?? -1, v = speed[e / 2] ?? 0;
    speedL[a].push(v), speedL[b].push(v);
    // service track (sidings, crossovers) costs 3x so A* only uses it to bridge junction gaps
    const d = dist(nodes[a * 2], nodes[a * 2 + 1], nodes[b * 2], nodes[b * 2 + 1]) * (svc[e / 2] ? 3 : 1);
    adjL[a].push(b), lenL[a].push(d), adjL[b].push(a), lenL[b].push(d);
    kindL[a].push(k), nameL[a].push(nm), kindL[b].push(k), nameL[b].push(nm);
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

/** A* between two graph nodes; node index list or null. Gives up past `limit` metres of search radius. */
export function astar(g: Graph, from: number, to: number, limit = 150_000): number[] | null {
  const N = g.nodes, tx = N[to * 2], ty = N[to * 2 + 1];
  const h = (i: number) => dist(N[i * 2], N[i * 2 + 1], tx, ty);
  if (h(from) > limit) return null;
  const gs = new Map<number, number>([[from, 0]]), prev = new Map<number, number>(), done = new Set<number>();
  const open = new Heap();
  open.push(h(from), from);
  while (open.size) {
    const u = open.pop();
    if (u === to) {
      const path = [u];
      for (let v = u; prev.has(v);) path.push((v = prev.get(v)!));
      return path.reverse();
    }
    if (done.has(u)) continue;
    done.add(u);
    const gu = gs.get(u)!;
    if (gu > limit * 2) return null;
    for (let k = 0; k < g.adj[u].length; k++) {
      const v = g.adj[u][k], nv = gu + g.len[u][k];
      if (nv < (gs.get(v) ?? Infinity)) gs.set(v, nv), prev.set(v, u), open.push(nv + h(v), v);
    }
  }
  return null;
}

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
  const { nodes, edges, svc, kind, name, names, speed } = await Bun.file(file).json();
  return makeGraph(nodes, edges, svc, kind, name, names, speed);
}

/**
 * Tunnels and bridges along a node path, as shares of its length (measured before simplify, which keeps the length).
 * Consecutive pieces of the same structure merge, across gaps under 30 m (OSM splits a tunnel into several ways).
 */
export function structsOf(g: Graph, a: [number, number], nodes: number[], total: number): Structs {
  const out: Structs = [];
  let at = dist(a[0], a[1], g.nodes[nodes[0] * 2], g.nodes[nodes[0] * 2 + 1]);
  for (let k = 1; k < nodes.length; k++) {
    const u = nodes[k - 1], v = nodes[k], j = g.adj[u].indexOf(v), d = dist(g.nodes[u * 2], g.nodes[u * 2 + 1], g.nodes[v * 2], g.nodes[v * 2 + 1]);
    const kind = g.kind[u][j] ?? 0, name = g.name[u][j] >= 0 ? g.names[g.name[u][j]] : "", last = out.at(-1);
    if (kind && last && last[2] === kind && last[3] === name && at - last[1] * total < 30) last[1] = (at + d) / total;
    else if (kind) out.push([at / total, (at + d) / total, kind, name]);
    at += d;
  }
  return out.filter((x) => (x[1] - x[0]) * total >= 40).map((x) => [+x[0].toFixed(5), +x[1].toFixed(5), x[2], x[3]]); // short culverts and level bridges are noise at this scale
}

/** Track path between two stations, or null if either can't be snapped / routed. */
export function route(g: Graph, a: [number, number], b: [number, number]): Path | null {
  return routeWith(g, a, b)?.p ?? null;
}
/** Line speed intervals along a routed node list: equal neighbours merged, untagged edges and stretches under 300 m left out. */
export function speedsOf(g: Graph, a: [number, number], nodes: number[], total: number): Speeds {
  const out: Speeds = [];
  let at = dist(a[0], a[1], g.nodes[nodes[0] * 2], g.nodes[nodes[0] * 2 + 1]);
  for (let k = 1; k < nodes.length; k++) {
    const u = nodes[k - 1], v = nodes[k], j = g.adj[u].indexOf(v), d = dist(g.nodes[u * 2], g.nodes[u * 2 + 1], g.nodes[v * 2], g.nodes[v * 2 + 1]);
    const kmh = g.speed[u]?.[j] ?? 0, last = out.at(-1);
    if (kmh && last && last[2] === kmh && at - last[1] * total < 30) last[1] = (at + d) / total;
    else if (kmh) out.push([at / total, (at + d) / total, kmh]);
    at += d;
  }
  return out.filter((x) => (x[1] - x[0]) * total >= 300).map((x) => [+x[0].toFixed(5), +x[1].toFixed(5), x[2]]);
}

export function routeWith(g: Graph, a: [number, number], b: [number, number]): { p: Path; t: Structs; s: Speeds } | null {
  let nodes: number[] | null = null;
  for (const A of snapAll(g, a[0], a[1])) {
    const B = snapAll(g, b[0], b[1]).find((x) => g.comp[x.node] === g.comp[A.node]);
    if (B && (nodes = astar(g, A.node, B.node))) break;
  }
  if (!nodes) return null;
  const p: Path = [a[0], a[1]];
  for (const i of nodes) p.push(g.nodes[i * 2], g.nodes[i * 2 + 1]);
  p.push(b[0], b[1]);
  // a gap in OSM makes A* take the long way round (Interlaken Ost–West came back as 187 km); a straight line is better than that
  let len = 0;
  for (let i = 2; i < p.length; i += 2) len += dist(p[i - 2], p[i - 1], p[i], p[i + 1]);
  if (len > 2.5 * dist(a[0], a[1], b[0], b[1]) + 3000) return null;
  return { p: simplify(p).map((x) => +x.toFixed(5)), t: structsOf(g, a, nodes, len), s: speedsOf(g, a, nodes, len) };
}

const CACHE_V = 3; // 2: tunnels and bridges per path, 3: line speeds. Another version (or a rebuilt rail graph) starts the cache over.

/**
 * Paths for all segments, from cache + routing. Returns paths and their tunnels/bridges aligned with `segments`
 * (null = draw a straight line) and writes the cache back.
 */
export async function segmentPaths(g: Graph | null, segments: number[], stations: { uic: string; lon: number; lat: number }[], cacheFile: string) {
  const file = existsSync(cacheFile) ? await Bun.file(cacheFile).json().catch(() => null) : null; // unreadable: route again
  const graphId = g ? `${g.nodes.length}:${g.names.length}` : "";
  const cache: Record<string, [Path, Structs, Speeds] | null> = file?.v === CACHE_V && file.graph === graphId ? file.segs : {};
  let computed = 0, matched = 0;
  const t0 = Date.now();
  const paths: (Path | null)[] = [], structs: (Structs | null)[] = [], speeds: (Speeds | null)[] = [];
  for (let k = 0; k < segments.length; k += 2) {
    const A = stations[segments[k]], B = stations[segments[k + 1]], key = `${A.uic}|${B.uic}`;
    if (!(key in cache) && g) {
      const r = routeWith(g, [A.lon, A.lat], [B.lon, B.lat]);
      cache[key] = r && [r.p, r.t, r.s];
      computed++;
    }
    const c = cache[key] ?? null;
    if (c) matched++;
    paths.push(c?.[0] ?? null);
    structs.push(c?.[1].length ? c[1] : null);
    speeds.push(c?.[2]?.length ? c[2] : null);
  }
  if (computed && g) await writeAtomic(cacheFile, JSON.stringify({ v: CACHE_V, graph: graphId, segs: cache }));
  console.log(`[paths] ${matched}/${segments.length / 2} segments on track (${computed} newly routed, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  return { paths, structs, speeds };
}
