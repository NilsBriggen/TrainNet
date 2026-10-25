// Fetch the rail network from OpenStreetMap (Overpass) and write data/rail.json as a graph.
// nodes: flat [lon, lat, ...]; edges: flat [a, b, ...] (indexes into nodes); svc: per edge 0 main track, 1 siding / yard /
// spur (and the links healing OSM gaps), 2 crossover. Service track is kept because main lines are sometimes only
// connected through it at junctions; routing makes it costly.
// kind: per edge 0 open track, 1 tunnel, 2 bridge; name: per edge index into names (tunnel names), -1 = none.
// speed: per edge the OSM maxspeed in km/h, 0 = not tagged (94 % of Swiss main-line ways are).
// ref: per edge index into refs (railway:track_ref, its number: "7" for "7a"), -1 = none: puts a train on its platform's track.
// gauge: per edge 0 standard, 1 narrow (metre gauge): a route stays on one, even where OSM joins the networks (dual-gauge track).
// Street tracks (railway=tram) are in, costly like sidings: Appenzeller Bahnen trains run through St. Gallen on them.
// With --ways it also writes rail-ways.geojson next to it, the source of the map's track tiles:
//   ogr2ogr -f MBTiles data/rail.mbtiles data/rail-ways.geojson -dsco MINZOOM=10 -dsco MAXZOOM=15
import { mkdirSync } from "node:fs";
import { dist, trackNo, writeAtomic } from "../server/paths";

const SVC = (service?: string) => (!service ? 0 : service === "crossover" ? 2 : 1);
const GAUGE = (t: any) => (t.railway === "narrow_gauge" || t.railway === "tram" || parseInt(t.gauge ?? "1435", 10) < 1400 ? 1 : 0);

/**
 * OSM ways that end a few metres from another track without sharing a node (tunnel portals, bridges, station heads)
 * leave gaps the router can't cross. Links a dead end to the nearest node of another way within `max` metres that lies
 * straight ahead of it (within 20°): two ways meeting end to end, or a junction node missing. Not to a track beside it:
 * buffer stops of parallel stub tracks (a terminus, a yard) end side by side, and a link would let trains jump across.
 * Returns the extra edges [a, b, ...]. `way` = way id per node (a node shared by ways keeps the first one).
 */
export function healGaps(nodes: number[], edges: number[], way: Int32Array, max = 12): number[] {
  const n = nodes.length / 2, deg = new Int32Array(n), from = new Int32Array(n).fill(-1), grid = new Map<number, number[]>();
  for (let e = 0; e < edges.length; e += 2) deg[edges[e]]++, deg[edges[e + 1]]++, (from[edges[e]] = edges[e + 1]), (from[edges[e + 1]] = edges[e]);
  const kx = Math.cos((47 * Math.PI) / 180);
  const ahead = (i: number, j: number) => { // is j straight on from i, coming from its only neighbour?
    const p = from[i], ax = (nodes[i * 2] - nodes[p * 2]) * kx, ay = nodes[i * 2 + 1] - nodes[p * 2 + 1], bx = (nodes[j * 2] - nodes[i * 2]) * kx, by = nodes[j * 2 + 1] - nodes[i * 2 + 1];
    const c = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
    return c > Math.cos((20 * Math.PI) / 180);
  };
  const cell = (i: number) => Math.round(nodes[i * 2] * 2000) * 1e7 + Math.round(nodes[i * 2 + 1] * 2000); // ~40 m cells
  for (let i = 0; i < n; i++) (grid.get(cell(i)) ?? grid.set(cell(i), []).get(cell(i))!).push(i);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    if (deg[i] !== 1) continue;
    let best = -1, bd = max;
    const c = cell(i);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of grid.get(c + dx * 1e7 + dy) ?? []) {
      if (j === i || way[j] === way[i]) continue;
      const d = dist(nodes[i * 2], nodes[i * 2 + 1], nodes[j * 2], nodes[j * 2 + 1]);
      if (d < bd && (d < 2 || ahead(i, j))) (bd = d), (best = j); // under 2 m the direction is noise
    }
    if (best >= 0) out.push(i, best);
  }
  return out;
}

const OUT = `${process.env.DATA_DIR ?? "data"}/rail.json`;
const BBOX = "45.6,5.7,48.0,10.8"; // Switzerland plus ~80 km margin for cross-border legs
// tracks under construction come too: drawn (dashed), never routed on
const QUERY = `[out:json][timeout:600];(way["railway"~"^(rail|narrow_gauge|light_rail|tram)$"](${BBOX});way["railway"="construction"]["construction"~"^(rail|narrow_gauge|light_rail)$"](${BBOX}););out geom;`;

/** What the map styles a way by: k 0 track trains use (main, and sidings: OSM tags many platform tracks service=siding,
 * 41 of Bern's), 1 yard or spur (the shunting tracks, drawn faint), 2 crossover, 3 under construction (o: its opening
 * date, as mapped); g narrow gauge, t tunnel, b bridge, v maxspeed. */
export function wayProps(t: any) {
  const tunnel = t.tunnel && t.tunnel !== "no", v = parseInt(t.maxspeed ?? "", 10), building = t.railway === "construction";
  return { k: building ? 3 : t.service === "yard" || t.service === "spur" ? 1 : t.service === "crossover" ? 2 : 0, g: t.railway === "narrow_gauge" || t.construction === "narrow_gauge" ? 1 : 0,
    t: tunnel ? 1 : 0, b: !tunnel && t.bridge && t.bridge !== "no" ? 1 : 0, v: v > 0 && v <= 300 ? v : 0, ...(building && { o: /^\d{4}/.test(t.opening_date ?? "") ? t.opening_date : "" }) };
}
// The lakes for the tiles (k 4): swissTLM3D's lake polygons over 0.2 km², border lakes whole, both halves of its west/east
// split joined, simplified to 3 m (© swisstopo). The shore a lakeside line runs along, unlike the coarse lakes.geojson.
//   ogr2ogr -f GPKG -append -nln w -dim XY -dialect SQLite -sql "SELECT geometry FROM swissTLM3D_TLM_BODENBEDECKUNG_WEST WHERE OBJEKTART = 'Stehende Gewaesser' AND ST_Area(geometry) > 200000" lakes.gpkg /vsizip//vsicurl/<swisstlm3d shp.zip>/TLM_BB/swissTLM3D_TLM_BODENBEDECKUNG_WEST.shp   (and _OST)
//   ogr2ogr -f GeoJSON -s_srs EPSG:2056 -t_srs EPSG:4326 -lco COORDINATE_PRECISION=5 -explodecollections -dialect SQLite -sql "SELECT ST_Simplify(ST_Union(ST_Buffer(GEOMETRY, 0.01)), 3) AS geometry FROM w" scripts/lakes.geojson lakes.gpkg
const LAKES = new URL("lakes.geojson", import.meta.url).pathname;
/** Every way as a GeoJSON line, and the lakes: the input for the track tiles (ogr2ogr -f MBTiles). City trams aren't railway track to draw. */
async function writeWays(ways: any[], file: string) {
  const features: any[] = ways.filter((w) => w.tags?.railway !== "tram").map((w) => ({ type: "Feature", properties: wayProps(w.tags ?? {}),
    geometry: { type: "LineString", coordinates: w.geometry.map((p: any) => [+p.lon.toFixed(6), +p.lat.toFixed(6)]) } }));
  for (const f of (await Bun.file(LAKES).json()).features) features.push({ type: "Feature", properties: { k: 4 }, geometry: f.geometry });
  await writeAtomic(file, JSON.stringify({ type: "FeatureCollection", features }));
  console.log(`[rail] ${features.length} ways written to ${file}`);
}

export async function buildRail(out = OUT, ways_ = false) {
  const t0 = Date.now();
  console.log("[rail] fetching OSM rail network…");
  const cached = process.env.RAIL_OSM && (await Bun.file(process.env.RAIL_OSM).exists()) ? Bun.file(process.env.RAIL_OSM) : null;
  const res = cached ? new Response(cached) : await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "User-Agent": "TrainNet/0.1 (live Swiss train map)" },
    body: QUERY,
    signal: AbortSignal.timeout(15 * 60_000), // the query itself may take 10 min
  });
  if (!res.ok) throw new Error(`overpass HTTP ${res.status}`);
  const json = await res.json();
  if (json.remark) throw new Error(`overpass: ${json.remark}`); // a timeout mid-query still answers 200, with part of the ways
  const all: any[] = json.elements, ways = all.filter((w) => w.tags?.railway !== "construction"); // routing: built track only
  if (process.env.RAIL_OSM && !cached) await Bun.write(process.env.RAIL_OSM, JSON.stringify({ elements: all })); // to rebuild without asking Overpass again

  const index = new Map<number, number>(), nodes: number[] = [], edges: number[] = [], svc: number[] = [], kind: number[] = [], name: number[] = [], speed: number[] = [], ref: number[] = [], gauge: number[] = [];
  const names: string[] = [], nameIdx = new Map<string, number>(), refs: string[] = [], refIdx = new Map<string, number>(), wayOf: number[] = [];
  const idx = (n: { id: number; lon: number; lat: number }, w: number) => {
    let i = index.get(n.id);
    if (i === undefined) index.set(n.id, (i = nodes.push(n.lon, n.lat) / 2 - 1)), wayOf.push(w);
    return i;
  };
  for (const [wi, w] of ways.entries()) {
    const t = w.tags ?? {}, tunnel = t.tunnel && t.tunnel !== "no", bridge = !tunnel && t.bridge && t.bridge !== "no";
    const n = tunnel ? t["tunnel:name"] ?? t.name : undefined;
    const ni = n ? nameIdx.get(n) ?? (nameIdx.set(n, names.push(n) - 1), names.length - 1) : -1;
    const v = parseInt(t.maxspeed ?? "", 10); // "160", "160;80" (the first is the line speed), "none"
    const tr = trackNo(t["railway:track_ref"]), ri = tr ? refIdx.get(tr) ?? (refIdx.set(tr, refs.push(tr) - 1), refs.length - 1) : -1;
    for (let k = 1; k < w.nodes.length; k++) {
      const a = idx({ id: w.nodes[k - 1], ...w.geometry[k - 1] }, wi), b = idx({ id: w.nodes[k], ...w.geometry[k] }, wi);
      edges.push(a, b);
      svc.push(t.railway === "tram" ? 1 : SVC(t.service));
      ref.push(ri);
      gauge.push(GAUGE(t));
      kind.push(tunnel ? 1 : bridge ? 2 : 0);
      name.push(ni);
      speed.push(v > 0 && v <= 300 ? v : 0);
    }
  }
  const heal = healGaps(nodes, edges, Int32Array.from(wayOf));
  const gaugeAt = new Map<number, number>(); // a gap link takes the gauge of the way it continues
  for (let e = 0; e < edges.length; e += 2) gaugeAt.set(edges[e], gauge[e / 2]), gaugeAt.set(edges[e + 1], gauge[e / 2]);
  for (let k = 0; k < heal.length; k += 2) edges.push(heal[k], heal[k + 1]), svc.push(1), kind.push(0), name.push(-1), speed.push(0), ref.push(-1), gauge.push(gaugeAt.get(heal[k]) ?? 0);
  console.log(`[rail] ${heal.length / 2} gaps of up to 12 m linked`);
  // drop tiny disconnected fragments (sidings in the data, broken ways)
  const adj: number[][] = Array.from({ length: nodes.length / 2 }, () => []);
  for (let e = 0; e < edges.length; e += 2) adj[edges[e]].push(edges[e + 1]), adj[edges[e + 1]].push(edges[e]);
  const comp = new Int32Array(adj.length).fill(-1), size: number[] = [];
  for (let s = 0; s < adj.length; s++) {
    if (comp[s] >= 0) continue;
    const c = size.length, stack = [s];
    comp[s] = c;
    let n = 0;
    while (stack.length) {
      const v = stack.pop()!;
      n++;
      for (const w of adj[v]) if (comp[w] < 0) (comp[w] = c), stack.push(w);
    }
    size.push(n);
  }
  const keep = (i: number) => size[comp[i]] >= 50;
  const remap = new Int32Array(adj.length).fill(-1), outNodes: number[] = [], outEdges: number[] = [], outSvc: number[] = [], outKind: number[] = [], outName: number[] = [], outSpeed: number[] = [], outRef: number[] = [], outGauge: number[] = [];
  for (let i = 0; i < adj.length; i++) if (keep(i)) remap[i] = outNodes.push(nodes[i * 2], nodes[i * 2 + 1]) / 2 - 1;
  for (let e = 0; e < edges.length; e += 2) if (keep(edges[e])) outEdges.push(remap[edges[e]], remap[edges[e + 1]]), outSvc.push(svc[e / 2]), outKind.push(kind[e / 2]), outName.push(name[e / 2]), outSpeed.push(speed[e / 2]), outRef.push(ref[e / 2]), outGauge.push(gauge[e / 2]);

  mkdirSync(out.slice(0, out.lastIndexOf("/")), { recursive: true });
  await writeAtomic(out, JSON.stringify({ nodes: outNodes.map((x) => +x.toFixed(6)), edges: outEdges, svc: outSvc, kind: outKind, name: outName, names, speed: outSpeed, ref: outRef, refs, gauge: outGauge, built: Date.now() }));
  if (ways_) await writeWays(all, `${out.slice(0, out.lastIndexOf("/"))}/rail-ways.geojson`);
  console.log(`[rail] ${ways.length} ways → ${outNodes.length / 2} nodes, ${outEdges.length / 2} edges, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

// bun scripts/rail.ts [--ways] [--out file]   (the server's weekly rebuild writes rail.json.new, then swaps it in)
if (import.meta.main) await buildRail(process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : OUT, process.argv.includes("--ways"));
