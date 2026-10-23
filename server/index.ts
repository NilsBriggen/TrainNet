import { loadDay, type Day } from "./gtfs";
import { alertsBody, live, resetRealtime, startRealtime } from "./realtime";
import { details, loadOccupancy } from "./details";
import { zurichDate } from "./time";
import { loadGraph, type Graph } from "./paths";
import { buildRail } from "../scripts/rail";
import { DATA_DIR } from "./gtfs";
import { flushAll, initRecord, maintain, startDay } from "./record";
import { crawlFleet } from "./fleet";
import * as stats from "./stats";

// dev: borrow production's realtime and train details instead of polling with the API tokens it shares
const LIVE_FROM = process.env.LIVE_FROM;
const borrow = async (path: string) => {
  const r = await fetch(LIVE_FROM + path);
  return new Response(await r.arrayBuffer(), { status: r.status, headers: { "Content-Type": "application/json" } });
};

let day: Day | undefined;
let loading = false;
let graph: Graph | null = null;
initRecord(`${DATA_DIR}/stats.db`);

const RAIL = `${DATA_DIR}/rail.json`;
async function loadRail() {
  if (!(await Bun.file(RAIL).exists())) await buildRail(RAIL).catch((e) => console.error(`[rail] ${e.message}; using straight lines until next start`));
  graph = await loadGraph(RAIL);
}

// checked every 10 min so the new service day is picked up shortly after midnight
async function refresh() {
  const date = zurichDate(new Date());
  try { maintain(); } catch (e: any) { console.error(`[record] ${e.message}`); }
  if (loading || day?.date === date) return;
  loading = true;
  try {
    if (!graph) await loadRail();
    day = await loadDay(date, graph);
    startDay(day); // stores the previous day's remaining finished trips first
    resetRealtime(day);
    await loadOccupancy(date).catch((e) => console.error(`[details] occupancy: ${e.message}`));
    if (!LIVE_FROM) crawlFleet(day).catch((e) => console.error(`[fleet] ${e.message}`)); // runs in the background for about an hour
  } catch (e: any) {
    console.error(`[gtfs] ${e.message}`); // keep serving the previous day, retry next check
  } finally {
    loading = false;
  }
}
refresh();
setInterval(refresh, 10 * 60_000);
// docker stop: store trips that finished within the grace period, they'd be lost otherwise
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { try { flushAll(); } finally { process.exit(0); } });
if (!LIVE_FROM) startRealtime(() => day);

const PUBLIC = new URL("../public/", import.meta.url).pathname;
const gz = { "Content-Type": "application/json", "Content-Encoding": "gzip" };
/** Stats JSON, gzipped when the client accepts it; 503 until the timetable is loaded, 404 for unknown keys.
 * Each URL's body is kept 20 s, so a burst of visitors costs one computation. */
const memo = new Map<string, { t: number; body: Uint8Array | null }>();
function statsJson(req: Request, fn: (d: Day) => unknown) {
  if (!day) return new Response("loading timetable", { status: 503, headers: { "Retry-After": "20" } });
  const url = new URL(req.url), key = url.pathname + url.search;
  let m = memo.get(key);
  if (!m || Date.now() - m.t > 20_000) {
    const data = fn(day);
    memo.set(key, (m = { t: Date.now(), body: data === null ? null : Bun.gzipSync(JSON.stringify(data)) }));
    if (memo.size > 300) memo.delete(memo.keys().next().value!);
  }
  if (!m.body) return new Response("not found", { status: 404 });
  const headers = { "Content-Type": "application/json", "Cache-Control": "public, max-age=20" };
  return /gzip/.test(req.headers.get("accept-encoding") ?? "") ? new Response(m.body, { headers: { ...headers, "Content-Encoding": "gzip" } }) : new Response(Bun.gunzipSync(m.body), { headers });
}

const server = Bun.serve({
  port: Number(process.env.PORT) || 3000,
  idleTimeout: 120, // a formation lookup can wait up to a minute for a free upstream slot
  routes: {
    "/api/day": (req) => {
      if (!day) return new Response("loading timetable", { status: 503, headers: { "Retry-After": "20" } });
      const etag = `"${day.version}"`;
      if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304 });
      return new Response(day.json, { headers: { ...gz, ETag: etag, "Cache-Control": "no-cache" } });
    },
    "/api/live": () => LIVE_FROM ? borrow("/api/live") : new Response(live, { headers: { ...gz, "Cache-Control": "public, max-age=14" } }),
    // full alerts (track geometry, descriptions): the URL carries their version from /api/live, so it caches for good
    "/api/alerts": () => LIVE_FROM ? borrow("/api/alerts") : new Response(alertsBody(), { headers: { ...gz, "Cache-Control": "public, max-age=86400" } }),
    "/api/stats/overview": (req) => statsJson(req, stats.overview),
    "/api/stats/fleet": (req) => statsJson(req, stats.fleet),
    "/api/stats/incidents": (req) => statsJson(req, stats.incidents),
    "/api/stats/search": (req) => statsJson(req, (d) => stats.search(d, new URL(req.url).searchParams.get("q") ?? "")),
    "/api/stats/train/:num": (req) => statsJson(req, (d) => stats.train(d, req.params.num)),
    "/api/stats/vehicle/:unit": (req) => statsJson(req, (d) => stats.vehicle(d, req.params.unit)),
    "/api/stats/station/:uic": (req) => statsJson(req, (d) => stats.stationStats(d, req.params.uic)),
    "/api/stats/line/:name": (req) => statsJson(req, (d) => stats.lineStats(d, decodeURIComponent(req.params.name))),
    "/stats": () => new Response(Bun.file(PUBLIC + "stats.html")),
    "/api/train/:idx": async (req) => {
      if (LIVE_FROM) return borrow(`/api/train/${req.params.idx}`);
      const trip = day?.trips[Number(req.params.idx)];
      if (!trip) return new Response("unknown train", { status: 404 });
      const r = await details(trip, day!.base), final = ["ok", "none", "unsupported"].includes(r.formationStatus);
      return Response.json(r, { headers: { "Cache-Control": final ? "public, max-age=300" : "no-store" } }); // the URL carries the day version
    },
  },
  async fetch(req) {
    let path: string;
    try { path = decodeURIComponent(new URL(req.url).pathname); } catch { return new Response("not found", { status: 404 }); }
    const file = Bun.file(PUBLIC + (path === "/" ? "index.html" : path.slice(1)));
    if (path.includes("..") || !(await file.exists())) return new Response("not found", { status: 404 });
    return new Response(file);
  },
});
console.log(`TrainNet on http://localhost:${server.port}`);
