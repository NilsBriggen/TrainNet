// One-off: fetch the rail network from OpenStreetMap (Overpass) and write data/rail.json as a graph.
// nodes: flat [lon, lat, ...]; edges: flat [a, b, ...] (indexes into nodes); svc: 1 per edge on service track
// (sidings, crossovers). Those are kept because main lines are sometimes only connected through them at junctions.
// kind: per edge 0 open track, 1 tunnel, 2 bridge; name: per edge index into names (tunnel names), -1 = none.
import { mkdirSync } from "node:fs";

const OUT = `${process.env.DATA_DIR ?? "data"}/rail.json`;
const BBOX = "45.6,5.7,48.0,10.8"; // Switzerland plus ~80 km margin for cross-border legs
const QUERY = `[out:json][timeout:600];way["railway"~"^(rail|narrow_gauge|light_rail)$"](${BBOX});out geom;`;

export async function buildRail(out = OUT) {
  const t0 = Date.now();
  console.log("[rail] fetching OSM rail network…");
  const res = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "User-Agent": "TrainNet/0.1 (live Swiss train map)" },
    body: QUERY,
  });
  if (!res.ok) throw new Error(`overpass HTTP ${res.status}`);
  const ways: any[] = (await res.json()).elements;

  const index = new Map<number, number>(), nodes: number[] = [], edges: number[] = [], svc: number[] = [], kind: number[] = [], name: number[] = [];
  const names: string[] = [], nameIdx = new Map<string, number>();
  const idx = (n: { id: number; lon: number; lat: number }) => {
    let i = index.get(n.id);
    if (i === undefined) index.set(n.id, (i = nodes.push(n.lon, n.lat) / 2 - 1));
    return i;
  };
  for (const w of ways) {
    const t = w.tags ?? {}, tunnel = t.tunnel && t.tunnel !== "no", bridge = !tunnel && t.bridge && t.bridge !== "no";
    const n = tunnel ? t["tunnel:name"] ?? t.name : undefined;
    const ni = n ? nameIdx.get(n) ?? (nameIdx.set(n, names.push(n) - 1), names.length - 1) : -1;
    for (let k = 1; k < w.nodes.length; k++) {
      const a = idx({ id: w.nodes[k - 1], ...w.geometry[k - 1] }), b = idx({ id: w.nodes[k], ...w.geometry[k] });
      edges.push(a, b);
      svc.push(t.service ? 1 : 0);
      kind.push(tunnel ? 1 : bridge ? 2 : 0);
      name.push(ni);
    }
  }
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
  const remap = new Int32Array(adj.length).fill(-1), outNodes: number[] = [], outEdges: number[] = [], outSvc: number[] = [], outKind: number[] = [], outName: number[] = [];
  for (let i = 0; i < adj.length; i++) if (keep(i)) remap[i] = outNodes.push(nodes[i * 2], nodes[i * 2 + 1]) / 2 - 1;
  for (let e = 0; e < edges.length; e += 2) if (keep(edges[e])) outEdges.push(remap[edges[e]], remap[edges[e + 1]]), outSvc.push(svc[e / 2]), outKind.push(kind[e / 2]), outName.push(name[e / 2]);

  mkdirSync(out.slice(0, out.lastIndexOf("/")), { recursive: true });
  await Bun.write(out, JSON.stringify({ nodes: outNodes.map((x) => +x.toFixed(6)), edges: outEdges, svc: outSvc, kind: outKind, name: outName, names }));
  console.log(`[rail] ${ways.length} ways → ${outNodes.length / 2} nodes, ${outEdges.length / 2} edges, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}

if (import.meta.main) await buildRail();
