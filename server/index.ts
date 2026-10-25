import { loadDay, type Day } from "./gtfs";
import { alertsBody, classify, live, resetRealtime, startRealtime } from "./realtime";
import { details, loadOccupancy, occupancyDate } from "./details";
import { serviceBase, zurichDate } from "./time";
import { loadGraph, type Graph } from "./paths";
import { buildRail } from "../scripts/rail";
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { DATA_DIR } from "./gtfs";
import { db, flushAll, initRecord, maintain, reclassifyAlerts, startDay } from "./record";
import { importRecentDays } from "./history";
import { crawlFleet } from "./fleet";
import { buildInfra, buildSections, junctionsBody, lineKmBody, loadSbbData, platformEdge, platformEnds, sectionsBody, stationPax, useRegisterNames, usePlatformEdges, usePlatformEnds } from "./sbbdata";
import * as stats from "./stats";
import { reopenTiles, tileOf } from "./tiles";

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
reclassifyAlerts((h, d, cause) => classify(h, d, cause).kind);
useRegisterNames();
usePlatformEnds();
usePlatformEdges();
buildInfra(); // from what stats.db has; refreshed with the weekly SBB load

const RAIL = `${DATA_DIR}/rail.json`;
async function loadRail() {
  if (!(await Bun.file(RAIL).exists())) await buildRail(RAIL).catch((e) => console.error(`[rail] ${e.message}; using straight lines until next start`));
  graph = await loadGraph(RAIL).catch((e) => {
    console.error(`[rail] ${RAIL} unreadable (${e.message}): rebuilt with the next timetable load, straight lines until then`);
    rmSync(RAIL, { force: true });
    return null;
  });
}

// OSM's tracks change (stations rebuilt, new lines opened): once a week, late in the evening, the track graph and tiles are
// rebuilt into data/next/ and swapped in with the next day's timetable, so the drawn tracks and the trains' paths change together
const NEXT = `${DATA_DIR}/next`, TILES = `${DATA_DIR}/rail.mbtiles`;
let rebuilding = false;
async function run(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" }); // its own process: a 60 MB Overpass answer never sits in the server's heap
  if ((await p.exited) !== 0) throw new Error(`${cmd[0]} ${cmd[1]} exited with ${p.exitCode}`);
}
async function rebuildRail() {
  const hour = (Date.now() - serviceBase(zurichDate(new Date()))) / 3600_000;
  if (LIVE_FROM || rebuilding || hour < 23 || existsSync(`${NEXT}/rail.mbtiles`) || !existsSync(RAIL) || Date.now() - statSync(RAIL).mtimeMs < 6.5 * 86400_000) return;
  rebuilding = true;
  try {
    mkdirSync(NEXT, { recursive: true });
    await run(["bun", new URL("../scripts/rail.ts", import.meta.url).pathname, "--tiles", "--out", `${NEXT}/rail.json`]); // rail.mbtiles comes last
    if (Bun.file(`${NEXT}/rail.json`).size < 0.9 * Bun.file(RAIL).size) throw new Error("the new track graph is under 90 % of the current one: kept the current");
    console.log("[rail] rebuilt from OSM, swapped in with the next timetable day");
  } catch (e: any) {
    console.error(`[rail] weekly rebuild: ${e.message}; tried again at the next check`);
    for (const f of ["rail.json", "rail.mbtiles"]) rmSync(`${NEXT}/${f}`, { force: true });
  } finally {
    rebuilding = false;
  }
}
function swapRail() {
  renameSync(`${NEXT}/rail.json`, RAIL);
  renameSync(`${NEXT}/rail.mbtiles`, TILES);
  reopenTiles();
  graph = null; // loaded again below; paths.json sees another graph and routes every leg anew (~12 s)
}

// checked every 10 min so the new service day is picked up shortly after midnight
async function refresh() {
  const date = zurichDate(new Date());
  try { maintain(); } catch (e: any) { console.error(`[record] ${e.message}`); }
  // yesterday's official actual data, published next morning (hourly at most; the dev instance leaves it to production)
  if (!LIVE_FROM) importRecentDays(db).catch((e) => console.error(`[history] ${e.message}`));
  if (!LIVE_FROM && day) crawlFleet(day).catch((e) => console.error(`[fleet] ${e.message}`)); // hourly; it skips what's known
  if (day?.date === date && occupancyDate() !== date) await loadOccupancy(date).catch((e) => console.error(`[details] occupancy: ${e.message}`)); // retried hourly
  rebuildRail();
  if (loading || day?.date === date) return;
  loading = true;
  try {
    if (day && existsSync(`${NEXT}/rail.mbtiles`)) swapRail(); // only at a day change: a restart's day comes from the day cache, routed on the current graph
    if (!graph) await loadRail();
    const next = await loadDay(date, graph);
    startDay(next); // stores the previous day's remaining finished trips first
    resetRealtime(next);
    day = next; // only now: if setting it up threw, the next check tries again
    await loadOccupancy(date).catch((e) => console.error(`[details] occupancy: ${e.message}`));
    await loadSbbData().catch((e) => console.error(`[sbbdata] ${e.message}`)); // weekly; before the crawl, which names unit types
    await buildSections(graph, `${DATA_DIR}/paths.json`).catch((e) => console.error(`[sbbdata] sections: ${e.message}`)); // routed once, then cached
    if (!LIVE_FROM) crawlFleet(day).catch((e) => console.error(`[fleet] ${e.message}`)); // the new day's first pass, right away
  } catch (e: any) {
    console.error(`[gtfs] ${e.message}`); // keep serving the previous day, retry next check
  } finally {
    loading = false;
  }
}
refresh();
setInterval(refresh, 10 * 60_000);
setInterval(() => day && day.date !== zurichDate(new Date()) && refresh(), 60_000); // the new day within a minute of midnight
// docker stop: store trips that finished within the grace period, they'd be lost otherwise
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { try { flushAll(); } finally { process.exit(0); } });
if (!LIVE_FROM) startRealtime(() => day);

const PUBLIC = new URL("../public/", import.meta.url).pathname;
const gz = { "Content-Type": "application/json", "Content-Encoding": "gzip" };
/** Stats JSON, gzipped when the client accepts it; 503 until the timetable is loaded, 404 for unknown keys.
 * Each URL's body is kept 20 s, so a burst of visitors costs one computation. */
const memo = new Map<string, { t: number; body: Uint8Array | null }>();
const notFound = () => new Response("not found", { status: 404 });
function statsJson(req: Request, fn: (d: Day) => unknown) {
  if (!day) return new Response("loading timetable", { status: 503, headers: { "Retry-After": "20" } });
  const url = new URL(req.url), key = url.pathname + url.search;
  let m = memo.get(key);
  if (!m || Date.now() - m.t > 20_000) {
    const data = fn(day);
    if (data === null) return notFound(); // unknown keys aren't kept: they'd push out real pages
    memo.set(key, (m = { t: Date.now(), body: Bun.gzipSync(JSON.stringify(data)) }));
    if (memo.size > 300) memo.delete(memo.keys().next().value!);
  }
  if (!m.body) return notFound();
  const headers = { "Content-Type": "application/json", "Cache-Control": "public, max-age=20" };
  return /gzip/.test(req.headers.get("accept-encoding") ?? "") ? new Response(m.body, { headers: { ...headers, "Content-Encoding": "gzip" } }) : new Response(Bun.gunzipSync(m.body), { headers });
}

// route params, checked before any work: anything else is a 404 (Bun has already decoded them)
const PARAM = { num: /^[\w-]{1,12}$/, unit: /^[\w-]{1,20}$/, uic: /^\d{7}$/, cls: /^[\w-]{1,12}$/, name: /^.{1,40}$/ };
const param = (req: Request & { params: Record<string, string> }, k: keyof typeof PARAM) => (PARAM[k].test(req.params[k]) ? req.params[k] : null);
const withParam = (k: keyof typeof PARAM, fn: (d: Day, v: string) => unknown) => (req: any) => {
  const v = param(req, k);
  return v === null ? notFound() : statsJson(req, (d) => fn(d, v));
};

// formation lookups that cost an upstream call, per visitor and 10 min: one scraper must not take every slot
const lookups = new Map<string, number>();
setInterval(() => lookups.clear(), 10 * 60_000);
const LOOKUPS = 30;

const server = Bun.serve({
  port: Number(process.env.PORT) || 3000,
  development: false, // no error page with stack traces and paths
  error(e) {
    console.error(`[http] ${e.stack ?? e.message}`);
    return new Response("server error", { status: 500 });
  },
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
    "/api/stats/train/:num": withParam("num", stats.train),
    "/api/stats/vehicle/:unit": withParam("unit", stats.vehicle),
    "/api/stats/station/:uic": withParam("uic", stats.stationStats),
    "/api/stats/line/:name": withParam("name", stats.lineStats),
    "/stats": () => new Response(Bun.file(PUBLIC + "stats.html")),
    "/api/pax": () => Response.json(Object.fromEntries(stationPax().map((r) => [r.uic, [r.daily, r.year]])), { headers: { "Cache-Control": "public, max-age=86400" } }),
    "/api/stats/types": (req) => statsJson(req, stats.types),
    "/api/stats/history": (req) => statsJson(req, stats.longHistory),
    "/api/stats/lines": (req) => statsJson(req, stats.lineLabels),
    "/api/stats/segments": (req) => statsJson(req, stats.segments),
    "/api/stats/records": (req) => statsJson(req, stats.records),
    "/api/stats/network": (req) => statsJson(req, stats.network),
    // the track network's vector tiles (see server/tiles.ts); empty tiles are 204, as MapLibre expects
    "/tiles/rail/:z/:x/:y": (req) => {
      const [z, x, y] = [req.params.z, req.params.x, req.params.y].map(Number);
      if (![z, x, y].every(Number.isInteger) || z < 0 || z > 15 || x < 0 || y < 0 || x >= 1 << z || y >= 1 << z) return notFound();
      const t = tileOf(TILES, z, x, y);
      // shortcut: a day's caching, so after the weekly swap a browser may show its cached old tiles until tomorrow; a build stamp in the tile URL would fix it
      return t ? new Response(t, { headers: { "Content-Type": "application/x-protobuf", "Content-Encoding": "gzip", "Cache-Control": "public, max-age=86400" } }) : new Response(null, { status: 204 });
    },
    "/api/junctions": () => { const b = junctionsBody(); return b ? new Response(b, { headers: { ...gz, "Cache-Control": "public, max-age=86400" } }) : new Response("not loaded yet", { status: 503, headers: { "Retry-After": "60" } }); },
    "/api/linekm": () => { const b = lineKmBody(); return b ? new Response(b, { headers: { ...gz, "Cache-Control": "public, max-age=86400" } }) : new Response("not loaded yet", { status: 503, headers: { "Retry-After": "60" } }); },
    "/api/sections": () => { const b = sectionsBody(); return b ? new Response(b, { headers: { ...gz, "Cache-Control": "public, max-age=86400" } }) : new Response("not loaded yet", { status: 503, headers: { "Retry-After": "60" } }); },
    "/api/stats/commute/:a/:b": (req) => (/^\d{7}$/.test(req.params.a) && /^\d{7}$/.test(req.params.b) ? statsJson(req, (d) => stats.commute(d, req.params.a, req.params.b)) : notFound()),
    "/api/stats/type/:cls": withParam("cls", stats.trainType),
    "/api/train/:idx": async (req) => {
      const v = new URL(req.url).searchParams.get("v");
      if (LIVE_FROM) return borrow(`/api/train/${req.params.idx}${v ? `?v=${encodeURIComponent(v)}` : ""}`);
      // indexes are per day version: an old tab asking with yesterday's index would get another train
      if (day && v && v !== day.version) return new Response("timetable changed", { status: 409 });
      const trip = day?.trips[Number(req.params.idx)];
      if (!trip) return new Response("unknown train", { status: 404 });
      const ip = req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim() || server.requestIP(req)?.address || "";
      const allow = () => { const n = (lookups.get(ip) ?? 0) + 1; lookups.set(ip, n); return n <= LOOKUPS; };
      const r = await details(trip, day!.base, allow), final = ["ok", "unsupported", "past"].includes(r.formationStatus);
      // where each stop's platform has its first and last sector: with the direction of travel, that's the front of the train
      for (const s of r.stops as any[]) { s.ends = platformEnds(s.uic, s.track); s.edge = platformEdge(s.uic, s.track); } // length and height of that platform
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
