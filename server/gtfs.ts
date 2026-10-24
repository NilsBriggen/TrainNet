// Daily: find the latest Swiss GTFS zip via CKAN, download it, keep today's rail trips.
import { accessSync, constants, mkdirSync, readdirSync, renameSync, rmSync, existsSync } from "node:fs";
import { upstream } from "./upstream";
import { addDays, serviceBase, timetableYear } from "./time";
import { dist, route, segmentPaths, type Graph, type Path } from "./paths";

export const DATA_DIR = process.env.DATA_DIR ?? "data";
mkdirSync(DATA_DIR, { recursive: true });
// Big re-downloadable zips; on the server an external CIFS disk. stats.db stays in DATA_DIR: SQLite locking is unreliable over CIFS.
export const ARCHIVE_DIR = (() => {
  const dir = process.env.ARCHIVE_DIR;
  if (!dir) return DATA_DIR;
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return dir;
  } catch (e: any) {
    console.error(`[gtfs] ARCHIVE_DIR ${dir} unusable (${e.message}), downloading to ${DATA_DIR}`);
    return DATA_DIR;
  }
})();

export type Trip = {
  id: string; date: string; route: number; agency: string; head: string; num: string;
  stops: number[]; // flat [station, arr, dep, ...], seconds from the day's base
  seq: number[]; // GTFS stop_sequence per stop, to match realtime updates
  plat: number[]; // index into Day.platforms per stop, 0 = unknown
  km: number[]; // cumulative track km at each stop (from our own geometry; straight line where unrouted)
  hints: string; // HRDF attribute codes from trips.txt, e.g. "2 NF VR WR" (2nd class only, low floor, bikes: reservation, restaurant)
};
export type Day = {
  date: string; base: number;
  stations: [name: string, lon: number, lat: number, uic: string, trips: number][];
  routes: [name: string, cat: string, agency: string][];
  agencies: Record<string, string>; // agency_id -> name
  platforms: string[]; // shared table, [0] = ""
  trips: Trip[];
  segments: number[]; // flat [a, b, ...] unique station pairs
  paths: (Path | null)[]; // track geometry per segment, null = straight
  tripIndex: Map<string, number>; // `${trip_id}|${YYYYMMDD}` -> index
  routeIndex: Map<string, number>;
  stationOfStop: (stopId: string) => number | undefined;
  track: (a: number, b: number) => Path | null; // track between two stations (for alert segments)
  json: Uint8Array; // gzipped client payload
  version: string; // changes whenever trip indexes may change
};

/** Latest resource of a CKAN package: { name, url }. */
export async function latestResource(pkg: string) {
  const res = await upstream("CKAN", `https://api.opentransportdata.swiss/ckan-api/package_show?id=${pkg}`);
  const list: any[] = (await res.json()).result.resources;
  const r = list.reduce((a, b) => (b.created > a.created ? b : a));
  return { url: r.url as string, name: r.url.split("/").pop() as string };
}

/** Download to ARCHIVE_DIR unless already there; removes older files with the same prefix. */
export async function download(url: string, name: string, prefix: string) {
  const path = `${ARCHIVE_DIR}/${name}`;
  if (existsSync(path)) return path;
  console.log(`[gtfs] downloading ${name}`);
  const res = await fetch(url, { signal: AbortSignal.timeout(20 * 60_000) }); // a stalled download must not block the day rollover forever
  if (!res.ok) throw new Error(`download ${name}: HTTP ${res.status}`);
  await Bun.write(`${path}.part`, res);
  renameSync(`${path}.part`, path);
  for (const f of readdirSync(ARCHIVE_DIR)) if (f.startsWith(prefix) && f !== name) rmSync(`${ARCHIVE_DIR}/${f}`);
  return path;
}

/** Calls fn with the columns of each data row of a quoted CSV inside a zip, streamed. */
export async function eachRow(zip: string, file: string, fn: (cols: string[], line: string) => void) {
  const p = Bun.spawn(["unzip", "-p", zip, file], { stdout: "pipe" });
  const dec = new TextDecoder();
  let buf = "", header = true;
  const row = (line: string) => {
    if (header) return void (header = false);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    // Swiss GTFS quotes every field and has no escaped quotes inside fields
    if (line) fn(line.slice(1, -1).split('","'), line);
  };
  for await (const chunk of p.stdout) {
    buf += dec.decode(chunk, { stream: true });
    let start = 0, i;
    while ((i = buf.indexOf("\n", start)) >= 0) { row(buf.slice(start, i)); start = i + 1; }
    buf = buf.slice(start);
  }
  row(buf);
  if ((await p.exited) !== 0) throw new Error(`unzip ${file} failed`);
}

const secs = (t: string) => {
  const [h, m, s] = t.split(":");
  return +h * 3600 + +m * 60 + +s;
};
const ymd = (date: string) => date.replaceAll("-", "");

/** Delta-encode a path to ints at 1e-5° (gzips ~3x better than floats). */
const packPath = (p: Path) => p.map((v, i) => Math.round(v * 1e5) - (i < 2 ? 0 : Math.round(p[i - 2] * 1e5)));

/**
 * Through-running ("stay seated", transfers.txt type 4): the train continues under another number.
 * Feed it transfers rows; `pairs` collects [from trip index, to trip index] for the instances running on `days`.
 */
export function throughRunning(days: string[], running: Set<string>[], tripIndex: Map<string, number>) {
  const pairs: number[] = [], keys = days.map(ymd);
  return {
    pairs,
    row: (c: string[]) => {
      if (c[6] !== "4") return;
      keys.forEach((k, i) => {
        if (c[8] && !running[i].has(c[8])) return; // the link has its own service days
        const a = tripIndex.get(`${c[4]}|${k}`), b = tripIndex.get(`${c[5]}|${k}`);
        if (a !== undefined && b !== undefined && a !== b) pairs.push(a, b);
      });
    },
  };
}

/** Service ids running on each of `days`, fed row by row (calendar_dates.txt is ~290 MB, so it stays streamed). */
export function serviceDays(days: string[]) {
  const keys = days.map(ymd), running = days.map(() => new Set<string>());
  const weekday = days.map((d) => (new Date(`${d}T12:00:00Z`).getUTCDay() + 6) % 7); // monday = 0
  return {
    running,
    calendar: (c: string[]) => keys.forEach((k, i) => { if (c[1 + weekday[i]] === "1" && c[8] <= k && k <= c[9]) running[i].add(c[0]); }),
    exception: ([svc, d, type]: string[]) => { const i = keys.indexOf(d); if (i >= 0) type === "1" ? running[i].add(svc) : running[i].delete(svc); },
  };
}

const FORMAT = "f5"; // payload shape, part of the version (the ETag): bump it when the payload changes

/** Everything a Day holds besides its client payload, as plain JSON. */
type DayCache = Omit<Day, "tripIndex" | "routeIndex" | "stationOfStop" | "track" | "json"> & { routeIds: string[]; stops: [string, number][] };
const CACHE = `${DATA_DIR}/day.json`, CACHE_PAYLOAD = `${DATA_DIR}/day.payload.gz`;

export function dayToCache(d: Day, routeIds: string[], stops: [string, number][]): DayCache {
  const { tripIndex, routeIndex, stationOfStop, track, json, ...plain } = d;
  return { ...plain, routeIds, stops };
}
/** A Day from its cache: the indexes are rebuilt, the track lookup gets today's graph. */
export function dayFromCache(c: DayCache, json: Uint8Array, graph: Graph | null): Day {
  const { routeIds, stops, ...plain } = c, stopStation = new Map(stops);
  return {
    ...plain, json, tripIndex: new Map(c.trips.map((t, i) => [`${t.id}|${ymd(t.date)}`, i])), routeIndex: new Map(routeIds.map((id, i) => [id, i])),
    stationOfStop: (id) => stopStation.get(id),
    track: (a, b) => graph && route(graph, [c.stations[a][1], c.stations[a][2]], [c.stations[b][1], c.stations[b][2]]),
  };
}

export async function loadDay(date: string, graph: Graph | null): Promise<Day> {
  const t0 = Date.now();
  // shortcut: on the December change Sunday the new year's zip doesn't know Saturday's services, so trains still running
  // after midnight from the old timetable are missing for those few hours; reading both zips that day would fix it
  const { url, name } = await latestResource(`timetable-${timetableYear(date)}-gtfs2020`);
  const version = `${date}_${name}_${FORMAT}`; // deterministic per zip + date
  // a restart on the same day and zip reads the parsed day back in a second or two instead of re-reading the 290 MB zip
  try {
    const c = existsSync(CACHE) && existsSync(CACHE_PAYLOAD) ? ((await Bun.file(CACHE).json()) as DayCache) : null;
    if (c?.version === version) {
      const d = dayFromCache(c, new Uint8Array(await Bun.file(CACHE_PAYLOAD).arrayBuffer()), graph);
      console.log(`[gtfs] ${date}: ${d.trips.length} trips from the day cache, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
      return d;
    }
  } catch (e: any) {
    console.error(`[gtfs] day cache unreadable (${e.message}), parsing the zip`);
  }
  const zip = await download(url, name, "gtfs_");

  const agencies: Record<string, string> = {};
  await eachRow(zip, "agency.txt", ([id, name]) => (agencies[id] = name));
  // rail = GTFS extended route types 100-117
  const routes: Day["routes"] = [], routeIndex = new Map<string, number>();
  await eachRow(zip, "routes.txt", ([id, agency, short, , desc, type]) => {
    if (+type >= 100 && +type <= 117) routeIndex.set(id, routes.push([short, desc, agency]) - 1);
  });

  // which services run on `date` and the day before (for trains still running after midnight)
  const days = [date, addDays(date, -1)], { running, calendar, exception } = serviceDays(days);
  await eachRow(zip, "calendar.txt", calendar);
  await eachRow(zip, "calendar_dates.txt", exception); // after the weekly calendar: exceptions override it

  const shift = [0, (serviceBase(days[1]) - serviceBase(date)) / 1000];
  const trips: Trip[] = [], wanted = new Map<string, number[]>();
  await eachRow(zip, "trips.txt", ([routeId, svc, id, head, num, , , , hints]) => {
    const route = routeIndex.get(routeId);
    if (route === undefined) return;
    running.forEach((set, i) => {
      if (!set.has(svc)) return;
      const idx = trips.push({ id, date: days[i], route, agency: routes[route][2], head, num, stops: [], seq: [], plat: [], km: [], hints: hints ?? "" }) - 1;
      wanted.set(id, [...(wanted.get(id) ?? []), idx]);
    });
  });

  // stops: platform -> parent station
  const stops = new Map<string, { name: string; lat: string; lon: string; parent: string; uic: string; plat: number }>();
  const platforms = [""], platIdx = new Map<string, number>([["", 0]]);
  await eachRow(zip, "stops.txt", ([id, name, lat, lon, , parent, code, , uic]) => {
    let plat = platIdx.get(code);
    if (plat === undefined) platIdx.set(code, (plat = platforms.push(code) - 1));
    stops.set(id, { name, lat, lon, parent, uic, plat });
  });
  const stations: Day["stations"] = [], stationIdx = new Map<string, number>();
  const stationOf = (stopId: string, create: boolean) => {
    const s = stops.get(stopId);
    if (!s) return undefined;
    const key = s.parent || stopId;
    let i = stationIdx.get(key);
    if (i === undefined && create) {
      const p = stops.get(key) ?? s;
      i = stations.push([p.name, +(+p.lon).toFixed(5), +(+p.lat).toFixed(5), s.uic, 0]) - 1;
      stationIdx.set(key, i);
    }
    return i;
  };

  console.log(`[gtfs] ${trips.length} rail trips, streaming stop_times…`);
  const rows = new Map<number, number[][]>();
  await eachRow(zip, "stop_times.txt", (_, line) => {
    const tripId = line.slice(1, line.indexOf('"', 1)); // cheap check before splitting 40M lines
    const inst = wanted.get(tripId);
    if (!inst) return;
    const [, arr, dep, stopId, seq] = line.replace(/\r$/, "").slice(1, -1).split('","');
    const st = stationOf(stopId, true);
    if (st === undefined) return;
    for (const i of inst) {
      const s = shift[days.indexOf(trips[i].date)];
      let r = rows.get(i);
      if (!r) rows.set(i, (r = []));
      r.push([+seq, st, secs(arr || dep) + s, secs(dep || arr) + s, stops.get(stopId)!.plat]);
    }
  });

  const kept: Trip[] = [], tripIndex = new Map<string, number>(), seg = new Set<number>();
  trips.forEach((t, i) => {
    const r = rows.get(i)?.sort((a, b) => a[0] - b[0]);
    if (!r || r.length < 2 || r[r.length - 1][2] < 0) return; // yesterday's trips that ended before today
    // the Swiss feed also carries trips that never stop in Switzerland (French TER, German RE …): not ours to count or draw
    if (!r.some((x) => stations[x[1]][3].startsWith("85"))) return;
    t.seq = r.map((x) => x[0]);
    t.stops = r.flatMap((x) => x.slice(1, 4));
    t.plat = r.map((x) => x[4]);
    r.forEach((x, j) => {
      stations[x[1]][4]++;
      if (j) seg.add(Math.min(x[1], r[j - 1][1]) * 100000 + Math.max(x[1], r[j - 1][1]));
    });
    tripIndex.set(`${t.id}|${ymd(t.date)}`, kept.push(t) - 1);
  });
  const segments = [...seg].flatMap((k) => [Math.floor(k / 100000), k % 100000]);
  const through = throughRunning(days, running, tripIndex);
  await eachRow(zip, "transfers.txt", through.row);
  const { paths, structs } = await segmentPaths(graph, segments, stations.map((s) => ({ uic: s[3], lon: s[1], lat: s[2] })), `${DATA_DIR}/paths.json`);
  const segKm = new Map<number, number>();
  paths.forEach((p, k) => {
    const a = segments[k * 2], b = segments[k * 2 + 1], pts = p ?? [stations[a][1], stations[a][2], stations[b][1], stations[b][2]];
    let m = 0;
    for (let i = 2; i < pts.length; i += 2) m += dist(pts[i - 2], pts[i - 1], pts[i], pts[i + 1]);
    segKm.set(a * 100000 + b, m / 1000);
  });
  for (const t of kept) {
    t.km = [0];
    for (let k = 3; k < t.stops.length; k += 3) {
      const a = t.stops[k - 3], b = t.stops[k];
      t.km.push(t.km[t.km.length - 1] + (segKm.get(Math.min(a, b) * 100000 + Math.max(a, b)) ?? 0));
    }
  }

  const hintSets = [""], hintIdx = new Map([["", 0]]);
  const hintSet = (h: string) => hintIdx.get(h) ?? (hintIdx.set(h, hintSets.push(h) - 1), hintSets.length - 1);
  const base = serviceBase(date);
  const json = Bun.gzipSync(JSON.stringify({
    v: version, date, base, stations, routes, platforms, segments, paths: paths.map((p) => p && packPath(p)), structs, // tunnels and bridges per path
    trips: kept.map((t) => [t.route, t.head, t.num, t.stops, t.plat.some(Boolean) ? t.plat : 0, hintSet(t.hints)]),
    hints: hintSets, through: through.pairs, // hint code sets (trips point into it), through-running [from, to, …]
  }));
  console.log(`[gtfs] ${date}: ${kept.length} trips, ${stations.length} stations, ${(json.length / 1e6).toFixed(1)} MB gz, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  const day: Day = { date, base, stations, routes, agencies, platforms, trips: kept, segments, paths, tripIndex, routeIndex, stationOfStop: (id) => stationOf(id, false), json, version,
    track: (a, b) => graph && route(graph, [stations[a][1], stations[a][2]], [stations[b][1], stations[b][2]]) };
  // payload first, cache last: a cache file whose version matches always has its payload next to it
  const stopStation = [...stops.keys()].flatMap((id): [string, number][] => { const i = stationOf(id, false); return i === undefined ? [] : [[id, i]]; });
  await Bun.write(CACHE_PAYLOAD, json);
  await Bun.write(CACHE, JSON.stringify(dayToCache(day, [...routeIndex.keys()], stopStation)));
  return day;
}
